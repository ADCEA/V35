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
function render(kind, inv, clientName, today = engine.todayParis()) {
  const s = engine.getSettings();
  const isCredit = inv.kind === 'credit_note';
  const balance = inv.kind === 'invoice' ? engine.balanceCents(inv) : 0;
  const late = inv.due_date && inv.due_date < today ? queries.daysBetween(inv.due_date, today) : 0;
  const ref = `${isCredit ? "l'avoir" : 'la facture'} ${inv.number}`;
  const bank = s.iban ? `\nPour régler par virement : IBAN ${s.iban}${s.bic ? ` — BIC ${s.bic}` : ''}, en rappelant le numéro de facture.\n` : '\n';
  let subject; let body;
  if (kind === 'invoice') {
    subject = `${isCredit ? 'Avoir' : 'Facture'} ${inv.number} — ${s.legal_name || 'Blanchisserie Cézanne'}`;
    body = isCredit
      ? `Bonjour,\n\nVeuillez trouver ci-joint l'avoir ${inv.number} du ${dateFr(inv.issue_date)}, d'un montant de ${eur(inv.total_ttc_cents)} TTC, qui vient en déduction de votre facture.\n\n${signature(s)}`
      : `Bonjour,\n\nVeuillez trouver ci-joint la facture ${inv.number} du ${dateFr(inv.issue_date)}, d'un montant de ${eur(inv.total_ttc_cents)} TTC, payable avant le ${dateFr(inv.due_date)}.\n${bank}\n${signature(s)}`;
  } else if (kind === 'reminder-1') {
    subject = `Rappel — facture ${inv.number} échue le ${dateFr(inv.due_date)}`;
    body = `Bonjour,\n\nSauf erreur de notre part, ${ref} du ${dateFr(inv.issue_date)}, d'un montant restant dû de ${eur(balance)} TTC, est arrivée à échéance le ${dateFr(inv.due_date)} et ne nous est pas encore parvenue.\n\nSi votre règlement a été effectué entre-temps, merci de ne pas tenir compte de ce message. Dans le cas contraire, nous vous remercions de bien vouloir y procéder dès que possible.\n${bank}\nLa facture est jointe à ce message pour mémoire.\n\n${signature(s)}`;
  } else if (kind === 'reminder-2') {
    subject = `Relance — facture ${inv.number} impayée (${late} jours de retard)`;
    body = `Bonjour,\n\nMalgré notre précédent rappel, ${ref} du ${dateFr(inv.issue_date)} reste impayée à ce jour : ${eur(balance)} TTC, échue le ${dateFr(inv.due_date)} (${late} jours de retard).\n\nNous vous remercions de procéder au règlement sous huit jours. Nous vous rappelons que tout retard de paiement entraîne de plein droit des pénalités de retard ainsi qu'une indemnité forfaitaire de 40 € pour frais de recouvrement (articles L441-10 et D441-5 du Code de commerce).\n${bank}\nLa facture est jointe à ce message.\n\n${signature(s)}`;
  } else if (kind === 'reminder-3') {
    subject = `Dernier rappel avant recouvrement — facture ${inv.number}`;
    body = `Bonjour,\n\nNos précédentes relances étant restées sans effet, nous vous demandons de régler sous huit jours ${ref} du ${dateFr(inv.issue_date)}, soit ${eur(balance)} TTC échus depuis le ${dateFr(inv.due_date)} (${late} jours de retard).\n\nÀ défaut, nous serons contraints d'engager la procédure de recouvrement, avec application des pénalités de retard et de l'indemnité forfaitaire de 40 € pour frais de recouvrement, à votre charge.\n${bank}\nSi un désaccord existe sur cette facture, contactez-nous sans délai afin que nous le traitions.\n\n${signature(s)}`;
  } else {
    throw new BillingError('Type de message inconnu.');
  }
  return { subject, body };
}

function logMail(row) {
  db.prepare('INSERT INTO native_mail_log (invoice_id, quote_id, kind, channel, to_email, subject, status, error) VALUES (?,?,?,?,?,?,?,?)')
    .run(row.invoiceId ?? null, row.quoteId ?? null, row.kind, row.channel || 'email', row.to ?? null, row.subject ?? null, row.status, row.error ?? null);
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
async function sendInvoice(invoiceId, { to, subject, body }) {
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
  const { buffer, filename } = await docs.invoicePdf(invoiceId);
  return deliver({ to, subject, body, filename, buffer, logBase: { invoiceId, kind } });
}

async function sendQuote(quoteId, { to, subject, body }) {
  const { buffer, quote, filename } = await docs.quotePdf(quoteId);
  if (quote.status === 'draft') throw new BillingError('Finalisez le devis avant de l\'envoyer.');
  return deliver({ to, subject, body, filename, buffer, logBase: { quoteId, kind: 'quote' } });
}

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

module.exports = { render, renderQuote, sendInvoice, sendReminder, sendQuote, remindersOverview, suggestLevel, parseRecipients };
