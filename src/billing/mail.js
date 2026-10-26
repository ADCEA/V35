// Envoi des factures et relances par e-mail, avec historique.
//
// Les relances sont TOUJOURS déclenchées par une personne (jamais automatiques) :
// un rappel envoyé à tort à un bon client abîme la relation. Le logiciel propose
// (« à relancer », niveau conseillé, texte prêt), l'utilisateur décide.

const db = require('../db');
const engine = require('./engine');
const quotes = require('./quotes');
const docs = require('./documents');
const queries = require('./queries');
const mailer = require('../utils/mailer');
const outlook = require('./outlook');
const MailComposer = require('nodemailer/lib/mail-composer');
const { buildDeliveryNotePdf } = require('../utils/pdf');

const { BillingError } = engine;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

const eur = (c) => (c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, ' ') + ' €';
const dateFr = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '');

function parseRecipients(raw) {
  const list = String(raw || '').split(/[;,\s]+/).map(s => s.trim()).filter(Boolean);
  if (!list.length) throw new BillingError("Indiquez l'adresse e-mail du destinataire.");
  if (list.length > 5) throw new BillingError('Cinq destinataires au plus.');
  for (const a of list) if (!EMAIL_RE.test(a)) throw new BillingError(`Adresse e-mail invalide : ${a}`);
  return list;
}

function signature(settings) {
  return ['Cordialement,', settings.legal_name || 'Blanchisserie Cézanne', [settings.phone, settings.email].filter(Boolean).join(' — ')].filter(Boolean).join('\n');
}

/** Texte prêt à envoyer. kind : 'invoice' | 'reminder-1' | 'reminder-2' | 'reminder-3' */
// Rappel de l'escompte dans le message d'envoi, tant que la date limite n'est pas passée.
function escompteLine(inv, today) {
  const x = engine.escompteStatus(inv, today);
  if (!x || !x.open || !x.discountCents) return '';
  return `\nEscompte de ${String(x.ratePct).replace('.', ',')} % : si le règlement nous parvient au plus tard le ${dateFr(x.deadline)}, vous ne payez que ${eur(x.netCents)} TTC au lieu de ${eur(engine.balanceCents(inv))}.\n`;
}

function render(kind, inv, clientName, today = engine.todayParis()) {
  const s = engine.getSettings();
  const isCredit = inv.kind === 'credit_note';
  const balance = inv.kind === 'invoice' ? engine.balanceCents(inv) : 0;
  const late = inv.due_date && inv.due_date < today ? queries.daysBetween(inv.due_date, today) : 0;
  const ref = `${isCredit ? "l'avoir" : 'la facture'} ${inv.number}`;
  const pro = !(inv.buyer && inv.buyer.type === 'particulier');   // l'indemnité de 40 € n'existe qu'entre professionnels
  const bank = s.iban ? `\nPour régler par virement : IBAN ${s.iban}${s.bic ? ` — BIC ${s.bic}` : ''}, en rappelant le numéro de facture.\n` : '\n';
  let subject; let body;
  if (kind === 'invoice') {
    subject = `${isCredit ? 'Avoir' : 'Facture'} ${inv.number} — ${s.legal_name || 'Blanchisserie Cézanne'}`;
    body = isCredit
      ? `Bonjour,\n\nVeuillez trouver ci-joint l'avoir ${inv.number} du ${dateFr(inv.issue_date)}, d'un montant de ${eur(inv.total_ttc_cents)} TTC, qui vient en déduction de votre facture.\n\n${signature(s)}`
      : `Bonjour,\n\nVeuillez trouver ci-joint la facture ${inv.number} du ${dateFr(inv.issue_date)}, d'un montant de ${eur(inv.total_ttc_cents)} TTC, payable avant le ${dateFr(inv.due_date)}.\n${escompteLine(inv, today)}${bank}\n${signature(s)}`;
  } else if (kind === 'reminder-1') {
    subject = `Rappel — facture ${inv.number} échue le ${dateFr(inv.due_date)}`;
    body = `Bonjour,\n\nSauf erreur de notre part, ${ref} du ${dateFr(inv.issue_date)}, d'un montant restant dû de ${eur(balance)} TTC, est arrivée à échéance le ${dateFr(inv.due_date)} et ne nous est pas encore parvenue.\n\nSi votre règlement a été effectué entre-temps, merci de ne pas tenir compte de ce message. Dans le cas contraire, nous vous remercions de bien vouloir y procéder dès que possible.\n${bank}\nLa facture est jointe à ce message pour mémoire.\n\n${signature(s)}`;
  } else if (kind === 'reminder-2') {
    subject = `Relance — facture ${inv.number} impayée (${late} jours de retard)`;
    body = `Bonjour,\n\nMalgré notre précédent rappel, ${ref} du ${dateFr(inv.issue_date)} reste impayée à ce jour : ${eur(balance)} TTC, échue le ${dateFr(inv.due_date)} (${late} jours de retard).\n\nNous vous remercions de procéder au règlement sous huit jours. ${pro ? "Nous vous rappelons que tout retard de paiement entraîne de plein droit des pénalités de retard ainsi qu'une indemnité forfaitaire de 40 € pour frais de recouvrement (articles L441-10 et D441-5 du Code de commerce)." : 'Nous vous rappelons que tout retard de paiement peut entraîner des pénalités de retard, selon nos conditions de règlement.'}\n${bank}\nLa facture est jointe à ce message.\n\n${signature(s)}`;
  } else if (kind === 'reminder-3') {
    subject = `Dernier rappel avant recouvrement — facture ${inv.number}`;
    body = `Bonjour,\n\nNos précédentes relances étant restées sans effet, nous vous demandons de régler sous huit jours ${ref} du ${dateFr(inv.issue_date)}, soit ${eur(balance)} TTC échus depuis le ${dateFr(inv.due_date)} (${late} jours de retard).\n\nÀ défaut, nous serons contraints d'engager la procédure de recouvrement, avec application des pénalités de retard${pro ? " et de l'indemnité forfaitaire de 40 € pour frais de recouvrement" : ''}, à votre charge.\n${bank}\nSi un désaccord existe sur cette facture, contactez-nous sans délai afin que nous le traitions.\n\n${signature(s)}`;
  } else {
    throw new BillingError('Type de message inconnu.');
  }
  return { subject, body };
}

function logMail(row) {
  db.prepare('INSERT INTO native_mail_log (invoice_id, quote_id, kind, channel, to_email, subject, status, error) VALUES (?,?,?,?,?,?,?,?)')
    .run(row.invoiceId ?? null, row.quoteId ?? null, row.kind, row.channel || 'email', row.to ?? null, row.subject ?? null, row.status, row.error ?? null);
}

/**
 * Envoi « via Outlook » : le serveur n'envoie rien, la personne relit et envoie elle-même.
 * - Outlook connecté : un BROUILLON est créé dans sa boîte, PDF déjà joint ; l'écran ouvre ce brouillon (webLink).
 * - Sinon, ou si Microsoft refuse : l'écran ouvre un message Outlook prérempli et télécharge le PDF (draftError dit pourquoi).
 * Dans les deux cas on garde la trace dans l'historique (et pour les relances : le niveau suivant en tient compte).
 * Le destinataire reste facultatif : on peut le saisir dans Outlook.
 */
// Message Outlook prêt à envoyer, sous forme de fichier .eml : « X-Unsent: 1 » indique à Outlook un brouillon non envoyé
// (il s'ouvre en fenêtre de rédaction, modifiable), avec le PDF en pièce jointe. Pas d'expéditeur : Outlook met le sien.
function buildEml({ to, subject, body, filename, buffer }) {
  return new Promise((resolve, reject) => {
    new MailComposer({
      to: to.join(', '), subject: String(subject).slice(0, 200), text: String(body),
      attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
      headers: { 'X-Unsent': '1' },
    }).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
}

/** Outlook installé sur l'ordinateur : renvoie le fichier message (base64) que le navigateur télécharge et qu'Outlook ouvre. */
async function viaOutlookFile({ to, subject, body, logBase, pdf }) {
  const raw = String(to || '').trim();
  const recipients = raw ? parseRecipients(raw) : [];
  if (!String(subject || '').trim() || !String(body || '').trim()) throw new BillingError("L'objet et le message ne peuvent pas être vides.");
  const { filename, buffer } = await pdf();
  const eml = await buildEml({ to: recipients, subject, body, filename, buffer });
  if (logBase) logMail({ ...logBase, channel: 'outlook-file', to: recipients.join(', ') || null, subject: String(subject).slice(0, 200), status: 'sent' });
  return { sent: false, outlook: true, file: true, to: recipients, eml: eml.toString('base64'), emlName: String(filename).replace(/\.pdf$/i, '') + '.eml' };
}

const isOutlook = (channel) => channel === 'outlook' || channel === 'outlook-file';
const outlookSend = (channel, args) => (channel === 'outlook-file' ? viaOutlookFile(args) : viaOutlook(args));

async function viaOutlook({ to, subject, body, logBase, pdf }) {
  const raw = String(to || '').trim();
  const recipients = raw ? parseRecipients(raw) : [];
  if (!String(subject || '').trim() || !String(body || '').trim()) throw new BillingError("L'objet et le message ne peuvent pas être vides.");
  let draft = null; let draftError = null; let draftCode = null;
  if (outlook.status().connected) {
    try {
      const { filename, buffer } = await pdf();
      draft = await outlook.createDraft({ to: recipients, subject, body, filename, buffer });
    } catch (e) { draftError = e.message; draftCode = e.code || null; }
  }
  if (logBase) logMail({ ...logBase, channel: draft ? 'outlook-draft' : 'outlook', to: recipients.join(', ') || null, subject: String(subject).slice(0, 200), status: 'sent' });
  return { sent: false, outlook: true, to: recipients, draft: !!draft, webLink: draft ? draft.webLink : null, draftError, draftCode };
}

async function deliver({ to, subject, body, filename, buffer, logBase }) {
  const recipients = parseRecipients(to);
  if (!mailer.isConfigured()) throw new BillingError("L'envoi d'e-mails n'est pas configuré sur le serveur (SMTP_HOST, SMTP_USER, SMTP_PASS).", 503);
  if (!String(subject || '').trim() || !String(body || '').trim()) throw new BillingError("L'objet et le message ne peuvent pas être vides.");
  try {
    await mailer.sendMail({ to: recipients.join(', '), subject: String(subject).slice(0, 200), text: String(body), attachments: [{ filename, content: buffer, contentType: 'application/pdf' }] });
  } catch (e) {
    logMail({ ...logBase, to: recipients.join(', '), subject, status: 'failed', error: String(e.message || e).slice(0, 300) });
    throw new BillingError(`Envoi impossible : ${e.message}`, 502);
  }
  logMail({ ...logBase, to: recipients.join(', '), subject, status: 'sent' });
  return { sent: true, to: recipients };
}

/** Envoie une facture ou un avoir ÉMIS au client. */
async function sendInvoice(invoiceId, { to, subject, body, channel }) {
  if (isOutlook(channel)) {
    const doc = engine.loadInvoice(invoiceId);
    if (!doc) throw new BillingError('Facture introuvable.', 404);
    if (doc.status !== 'issued') throw new BillingError("Seul un document émis peut être envoyé (un brouillon n'a pas de valeur).");
    return outlookSend(channel, { to, subject, body, logBase: { invoiceId, kind: 'invoice' }, pdf: () => docs.invoicePdf(invoiceId) });
  }
  const { buffer, inv, filename } = await docs.invoicePdf(invoiceId);
  if (inv.status !== 'issued') throw new BillingError("Seul un document émis peut être envoyé (un brouillon n'a pas de valeur).");
  return deliver({ to, subject, body, filename, buffer, logBase: { invoiceId, kind: 'invoice' } });
}

/** Relance (e-mail ou note manuelle) d'une facture impayée. */
async function sendReminder(invoiceId, { level, to, subject, body, channel = 'email' }) {
  const lvl = Number(level);
  if (![1, 2, 3].includes(lvl)) throw new BillingError('Niveau de relance invalide (1 à 3).');
  const inv = engine.loadInvoice(invoiceId);
  if (!inv) throw new BillingError('Facture introuvable.', 404);
  if (inv.status !== 'issued' || inv.kind !== 'invoice') throw new BillingError('On ne relance qu\'une facture émise.');
  if (engine.balanceCents(inv) <= 0) throw new BillingError('Cette facture est soldée : rien à relancer.');
  const kind = `reminder-${lvl}`;
  if (channel === 'manual') {
    logMail({ invoiceId, kind, channel: 'manual', status: 'logged', subject: subject ? String(subject).slice(0, 200) : 'Relance par téléphone / courrier' });
    return { sent: false, logged: true };
  }
  if (isOutlook(channel)) return outlookSend(channel, { to, subject, body, logBase: { invoiceId, kind }, pdf: () => docs.invoicePdf(invoiceId) });
  const { buffer, filename } = await docs.invoicePdf(invoiceId);
  return deliver({ to, subject, body, filename, buffer, logBase: { invoiceId, kind } });
}

async function sendQuote(quoteId, { to, subject, body, channel }) {
  if (isOutlook(channel)) {
    const q = quotes.loadQuote(quoteId);
    if (!q) throw new BillingError('Devis introuvable.', 404);
    if (q.status === 'draft') throw new BillingError('Finalisez le devis avant de l\'envoyer.');
    return outlookSend(channel, { to, subject, body, logBase: { quoteId, kind: 'quote' }, pdf: () => docs.quotePdf(quoteId) });
  }
  const { buffer, quote, filename } = await docs.quotePdf(quoteId);
  if (quote.status === 'draft') throw new BillingError('Finalisez le devis avant de l\'envoyer.');
  return deliver({ to, subject, body, filename, buffer, logBase: { quoteId, kind: 'quote' } });
}

// ---------- bon de livraison ----------

const orderItemsStmt = db.prepare('SELECT service_id AS id, name, code, sage_code AS sageCode, price, qty, delivered_qty AS deliveredQty FROM order_items WHERE order_id = ?');

/** Commande + articles, au format attendu par le PDF du bon de livraison. */
function loadDeliveryNote(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new BillingError('Commande introuvable.', 404);
  return { ...o, items: orderItemsStmt.all(orderId) };
}

function renderDeliveryNote(order) {
  const s = engine.getSettings();
  const day = /^\d{4}-\d{2}-\d{2}/.test(order.livraison_prevue || '') ? dateFr(order.livraison_prevue.slice(0, 10)) : '';
  return {
    subject: `Bon de livraison ${order.ticket} — ${s.legal_name || 'Blanchisserie Cézanne'}`,
    body: `Bonjour,\n\nVeuillez trouver ci-joint le bon de livraison ${order.ticket}${order.societe ? ` (${order.societe})` : ''}${day ? `, pour la livraison du ${day}` : ''}.\n\n${signature(s)}`,
  };
}

/** Bon de livraison par Outlook (en ligne ou installé), PDF joint. Pas d'historique d'envoi pour les bons. */
async function sendDeliveryNote(orderId, { to, subject, body, channel } = {}) {
  if (!isOutlook(channel)) throw new BillingError("Le bon de livraison s'envoie par Outlook (en ligne ou installé sur l'ordinateur).");
  const order = loadDeliveryNote(orderId);
  const filename = `bon-livraison-${String(order.ticket).replace(/[^\w.-]+/g, '-')}.pdf`;
  return outlookSend(channel, { to, subject, body, logBase: null, pdf: async () => ({ filename, buffer: await buildDeliveryNotePdf(order) }) });
}

const outlookState = () => { const s = outlook.status(); return { configured: s.configured, connected: s.connected, needsReconnect: s.needsReconnect, account: s.account && s.account.email }; };

function renderQuote(q) {
  const s = engine.getSettings();
  return {
    subject: `Devis ${q.number} — ${s.legal_name || 'Blanchisserie Cézanne'}`,
    body: `Bonjour,\n\nVeuillez trouver ci-joint notre devis ${q.number} du ${dateFr(q.issue_date)}, d'un montant de ${eur(q.total_ttc_cents)} TTC, valable jusqu'au ${dateFr(q.valid_until)}.\n\nPour l'accepter, retournez-nous le devis daté et signé avec la mention « Bon pour accord ».\n\n${signature(s)}`,
  };
}

/** Niveau de relance conseillé selon le retard et l'historique. */
function suggestLevel(d, today = engine.todayParis()) {
  const sinceLast = d.lastReminderAt ? queries.daysBetween(String(d.lastReminderAt).slice(0, 10), today) : null;
  if (d.reminderCount === 0) return d.overdueDays >= 1 ? 1 : null;
  if (d.reminderCount === 1) return d.overdueDays >= 15 && sinceLast >= 10 ? 2 : null;
  return d.overdueDays >= 30 && sinceLast >= 10 ? 3 : null;
}

/** Factures échues avec le niveau de relance conseillé (null = rien à faire pour l'instant). */
function remindersOverview(today = engine.todayParis()) {
  const { invoices } = queries.listInvoices({ tab: 'overdue', sort: 'due', dir: 'asc', limit: 500 }, today);
  const emails = new Map(db.prepare('SELECT id, email FROM clients').all().map(c => [c.id, c.email]));
  return invoices.map(d => ({
    ...d, email: emails.get(d.clientId) || '',
    suggestedLevel: suggestLevel(d, today),
    daysSinceLastReminder: d.lastReminderAt ? queries.daysBetween(String(d.lastReminderAt).slice(0, 10), today) : null,
  }));
}

module.exports = { render, renderQuote, renderDeliveryNote, loadDeliveryNote, sendDeliveryNote, outlookState, sendInvoice, sendReminder, sendQuote, remindersOverview, suggestLevel, parseRecipients };
