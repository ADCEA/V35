// Prélèvements SEPA : mandats, préparation des lots, fichier pain.008, suivi jusqu'à l'encaissement.
//
// Cycle d'un lot :  prepared (fichier prêt)  →  sent (remis à la banque)  →  settled (encaissé)   ou  cancelled.
//   - À la création, tout est vérifié et FIGÉ (créancier, mandats, IBAN, montants) : le fichier se régénère à l'identique.
//   - Rien n'est enregistré comme payé tant que le lot n'est pas « encaissé » : à ce moment seulement, chaque facture reçoit
//     son règlement (mode « prélèvement », date = date de prélèvement). Tout ou rien : une facture en désaccord annule l'ensemble.
//   - Les prélèvements rejetés par la banque restent impayés (les relances s'appliquent) ; le mandat peut être révoqué.
//
// Un IBAN complet n'est jamais écrit dans le journal ni renvoyé par une liste : seul le fichier remis à la banque le contient.

const db = require('../db');
const engine = require('./engine');
const queries = require('./queries');
const R = require('./sddRules');
const { buildPain008 } = require('./sddXml');

const { BillingError } = engine;

const MAX_DEBITS = 500;              // prélèvements par lot
const MAX_INVOICES = 1000;
const MAX_AHEAD_DAYS = 90;           // date de prélèvement au plus tard dans 90 jours
const MAX_DEBIT_CENTS = 99999999999; // 999 999 999,99 € : plafond du format SEPA
const MANDATE_LIFETIME_MONTHS = 36;  // un mandat inutilisé pendant 36 mois est caduc
const SCHEMES = ['CORE', 'B2B'];
const OPEN_STATUSES = "('prepared','sent')";

const pad = (n, w) => String(n).padStart(w, '0');
const eur = (c) => `${(c / 100).toFixed(2).replace('.', ',')} €`;
const dFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ================= créancier (notre société) =================

function creditor({ full = false } = {}) {
  const s = engine.getSettings();
  const problems = [];
  if (!R.sepaText(s.legal_name || '', 70)) problems.push('Raison sociale manquante (page Émetteur).');
  const ibanProblem = R.ibanError(s.iban);
  if (ibanProblem) problems.push(`Compte de la société : ${ibanProblem.replace(/\.$/, '')} (page Émetteur).`);
  const bicProblem = R.bicError(s.bic);
  if (bicProblem) problems.push(`Compte de la société : ${bicProblem.replace(/\.$/, '')} (page Émetteur).`);
  const icsProblem = R.icsError(s.sdd_ics);
  if (icsProblem) problems.push(!s.sdd_ics ? "Saisissez l'identifiant créancier (ICS) délivré par votre banque." : icsProblem);
  const out = {
    name: s.legal_name || '', bic: R.normBic(s.bic) || null, ics: R.normIcs(s.sdd_ics) || null,
    address: [s.address_line, [s.postal_code, s.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    noticeDays: s.sdd_notice_days || 14, problems, ready: problems.length === 0,
  };
  return full ? { ...out, iban: R.normIban(s.iban) } : { ...out, ibanMasked: s.iban ? R.maskIban(s.iban) : null };
}

function setCreditor(input) {
  const body = input || {};
  const sets = []; const vals = []; const detail = {};
  if (body.ics !== undefined) {
    const ics = R.normIcs(body.ics);
    const err = R.icsError(ics);
    if (err) throw new BillingError(err);
    sets.push('sdd_ics = ?'); vals.push(ics); detail.ics = ics;
  }
  if (body.noticeDays !== undefined) {
    const n = Number(body.noticeDays);
    if (!Number.isInteger(n) || n < 1 || n > 60) throw new BillingError('Le délai de préavis est un nombre de jours entre 1 et 60.');
    sets.push('sdd_notice_days = ?'); vals.push(n); detail.noticeDays = n;
  }
  if (!sets.length) throw new BillingError('Rien à enregistrer.');
  const run = db.transaction(() => {
    db.prepare(`UPDATE billing_settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
    engine.logEvent('sdd_creditor_set', null, detail);
  });
  run.immediate();
  return creditor();
}

// ================= mandats =================

const mandateById = (id) => db.prepare('SELECT m.*, c.societe AS client_name FROM sdd_mandates m JOIN clients c ON c.id = m.client_id WHERE m.id = ?').get(id);

function lastCollection(mandateId) {
  return db.prepare(`SELECT MAX(b.collection_date) AS d, COUNT(*) AS n FROM sdd_batch_items i JOIN sdd_batches b ON b.id = i.batch_id
    WHERE i.mandate_id = ? AND b.status IN ('sent','settled') AND i.status <> 'rejected'`).get(mandateId);
}

/** Date jusqu'à laquelle un mandat reste utilisable : 36 mois après le dernier prélèvement (ou la signature s'il n'a jamais servi). */
function mandateExpiry(m) {
  const last = lastCollection(m.id);
  return { lastCollectionDate: last.d || null, collections: last.n, expiresOn: R.addMonths(last.d || m.signed_on, MANDATE_LIFETIME_MONTHS) };
}

function presentMandate(m) {
  const x = mandateExpiry(m);
  return {
    id: m.id, clientId: m.client_id, clientName: m.client_name, umr: m.umr, scheme: m.scheme, debtorName: m.debtor_name,
    ibanMasked: R.maskIban(m.iban), bic: m.bic || null, signedOn: m.signed_on, status: m.status,
    revokedOn: m.revoked_on, revokedReason: m.revoked_reason, createdAt: m.created_at,
    lastCollectionDate: x.lastCollectionDate, collections: x.collections, expiresOn: m.status === 'active' ? x.expiresOn : null,
    expired: m.status === 'active' && x.expiresOn < engine.todayParis(),
  };
}

function listMandates({ status, clientId } = {}) {
  const where = []; const args = [];
  if (status === 'active' || status === 'revoked') { where.push('m.status = ?'); args.push(status); }
  if (clientId) { where.push('m.client_id = ?'); args.push(Number(clientId)); }
  const rows = db.prepare(`SELECT m.*, c.societe AS client_name FROM sdd_mandates m JOIN clients c ON c.id = m.client_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (m.status = 'active') DESC, c.societe COLLATE NOCASE, m.id DESC`).all(...args);
  return rows.map(presentMandate);
}

/** Référence proposée pour un nouveau mandat : CEZ-<hôtel>-<n°>, la première libre. */
function suggestUmr(clientId) {
  const id = Number(clientId);
  if (!Number.isInteger(id) || id <= 0) throw new BillingError('Hôtel invalide.');
  let n = db.prepare('SELECT COUNT(*) AS c FROM sdd_mandates WHERE client_id = ?').get(id).c + 1;
  for (;;) {
    const umr = `CEZ-${pad(id, 4)}-${pad(n, 2)}`;
    if (!db.prepare('SELECT 1 FROM sdd_mandates WHERE umr = ?').get(umr)) return umr;
    n++;
  }
}

function openBatchOfMandate(mandateId) {
  return db.prepare(`SELECT b.id, b.msg_id FROM sdd_batch_items i JOIN sdd_batches b ON b.id = i.batch_id
    WHERE i.mandate_id = ? AND b.status IN ${OPEN_STATUSES} LIMIT 1`).get(mandateId);
}

function revokeInternal(mandateId, reason) {
  const m = mandateById(mandateId);
  if (!m) throw new BillingError('Mandat introuvable.', 404);
  if (m.status !== 'active') throw new BillingError('Ce mandat est déjà révoqué.');
  const open = openBatchOfMandate(mandateId);
  if (open) throw new BillingError(`Ce mandat figure dans le lot ${open.msg_id} qui n'est pas terminé : annulez ou clôturez ce lot d'abord.`, 409);
  const today = engine.todayParis();
  db.prepare("UPDATE sdd_mandates SET status = 'revoked', revoked_on = ?, revoked_reason = ? WHERE id = ?").run(today, reason, mandateId);
  engine.logEvent('sdd_mandate_revoked', null, { mandateId, clientId: m.client_id, client: m.client_name, umr: m.umr, iban: R.maskIban(m.iban), reason });
}

function revokeMandate(id, { reason } = {}) {
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (why.length < 3) throw new BillingError('Indiquez le motif de la révocation (par exemple « changement de banque »).');
  const run = db.transaction(() => revokeInternal(Number(id), why));
  run.immediate();
  return presentMandate(mandateById(Number(id)));
}

function createMandate(input) {
  const b = input || {};
  const clientId = Number(b.clientId);
  const client = Number.isInteger(clientId) ? db.prepare('SELECT id, societe FROM clients WHERE id = ?').get(clientId) : null;
  if (!client) throw new BillingError('Hôtel introuvable.', 404);
  const iban = R.normIban(b.iban);
  const ibanProblem = R.ibanError(iban); if (ibanProblem) throw new BillingError(ibanProblem);
  const bic = R.normBic(b.bic) || null;
  const bicProblem = R.bicError(bic); if (bicProblem) throw new BillingError(bicProblem);
  const today = engine.todayParis();
  const signedOn = String(b.signedOn || '');
  if (!R.isIso(signedOn)) throw new BillingError('Date de signature invalide.');
  if (signedOn > today) throw new BillingError('La date de signature ne peut pas être dans le futur : enregistrez le mandat une fois signé.');
  if (signedOn < '2014-01-01') throw new BillingError('Date de signature invalide (le prélèvement SEPA date de 2014).');
  const scheme = b.scheme === undefined || b.scheme === '' ? 'CORE' : String(b.scheme);
  if (!SCHEMES.includes(scheme)) throw new BillingError('Type de mandat inconnu (CORE ou B2B).');
  const debtorName = String(b.debtorName || client.societe).replace(/\s+/g, ' ').trim().slice(0, 70);
  if (!R.sepaText(debtorName, 70)) throw new BillingError('Nom du titulaire du compte manquant.');

  const run = db.transaction(() => {
    const umr = b.umr ? String(b.umr).trim() : suggestUmr(clientId);
    const umrProblem = R.umrError(umr); if (umrProblem) throw new BillingError(umrProblem);
    if (db.prepare('SELECT 1 FROM sdd_mandates WHERE umr = ?').get(umr)) throw new BillingError(`La référence ${umr} est déjà utilisée par un autre mandat.`, 409);
    const active = db.prepare("SELECT id, umr FROM sdd_mandates WHERE client_id = ? AND status = 'active'").get(clientId);
    if (active && !b.replace) throw new BillingError(`Cet hôtel a déjà un mandat actif (${active.umr}). Pour changer de compte bancaire, remplacez-le.`, 409);
    if (active) revokeInternal(active.id, 'Remplacé par un nouveau mandat');
    const r = db.prepare('INSERT INTO sdd_mandates (client_id, umr, scheme, debtor_name, iban, bic, signed_on) VALUES (?,?,?,?,?,?,?)')
      .run(clientId, umr, scheme, debtorName, iban, bic, signedOn);
    engine.logEvent('sdd_mandate_created', null, { mandateId: Number(r.lastInsertRowid), clientId, client: client.societe, umr, scheme, iban: R.maskIban(iban), signedOn, replaced: active ? active.umr : null });
    return Number(r.lastInsertRowid);
  });
  return presentMandate(mandateById(run.immediate()));
}

// ================= préparation d'un lot =================

function dateBounds(today = engine.todayParis()) {
  return { min: R.addBusinessDays(today, 1), suggested: R.addBusinessDays(today, 3), max: R.addDays(today, MAX_AHEAD_DAYS) };
}

function checkCollectionDate(date, today = engine.todayParis()) {
  const bounds = dateBounds(today);
  if (!R.isIso(date)) return 'Date de prélèvement invalide.';
  if (!R.isBusinessDay(date)) return `Le ${dFr(date)} n'est pas un jour ouvré bancaire (week-end ou jour férié TARGET). Prochain jour ouvré : ${dFr(R.nextBusinessDay(date))}.`;
  if (date < bounds.min) return `Date trop proche : la banque doit recevoir le fichier avant. Premier jour possible : ${dFr(bounds.min)}.`;
  if (date > bounds.max) return `Date trop lointaine (${MAX_AHEAD_DAYS} jours au plus).`;
  return null;
}

/** Factures déjà engagées dans un lot non terminé : facture → { id, msg_id }. */
function invoicesInOpenBatches() {
  const map = new Map();
  for (const r of db.prepare(`SELECT ii.invoice_id, b.id, b.msg_id FROM sdd_item_invoices ii
    JOIN sdd_batch_items i ON i.id = ii.item_id JOIN sdd_batches b ON b.id = i.batch_id WHERE b.status IN ${OPEN_STATUSES}`).all()) map.set(r.invoice_id, { id: r.id, msgId: r.msg_id });
  return map;
}

const activeMandates = () => new Map(db.prepare("SELECT m.*, c.societe AS client_name FROM sdd_mandates m JOIN clients c ON c.id = m.client_id WHERE m.status = 'active'").all().map(m => [m.client_id, m]));

/** Avertissements (non bloquants) sur une facture prélevée à `date`. */
function adviceFor(inv, date, noticeDays) {
  const out = [];
  if (inv.dueDate && date < inv.dueDate) out.push(`Prélevée avant l'échéance (${dFr(inv.dueDate)}).`);
  if (inv.issueDate && daysBetween(inv.issueDate, date) < noticeDays) {
    out.push(`Préavis de ${noticeDays} jours non respecté (facture émise le ${dFr(inv.issueDate)}).`);
  }
  return out;
}

/** Ce qu'on peut prélever : factures ouvertes d'hôtels ayant un mandat, et celles qui ne le peuvent pas encore. */
function candidates({ collectionDate } = {}) {
  const today = engine.todayParis();
  const cr = creditor();
  const bounds = dateBounds(today);
  const date = collectionDate && R.isIso(collectionDate) ? collectionDate : bounds.suggested;
  const mandates = activeMandates();
  const inBatch = invoicesInOpenBatches();
  const expiry = new Map();
  const lines = []; const noMandate = new Map(); let engaged = 0;
  for (const inv of queries.listOpen(today)) {
    if (inBatch.has(inv.id)) { engaged++; continue; }
    const m = mandates.get(inv.clientId);
    if (!m) {
      const g = noMandate.get(inv.clientId) || { clientId: inv.clientId, clientName: inv.clientName, count: 0, balanceCents: 0 };
      g.count++; g.balanceCents += inv.balanceCents; noMandate.set(inv.clientId, g);
      continue;
    }
    if (!expiry.has(m.id)) expiry.set(m.id, mandateExpiry(m));
    const exp = expiry.get(m.id);
    const expired = exp.expiresOn < date;
    lines.push({
      invoiceId: inv.id, number: inv.number, clientId: inv.clientId, clientName: inv.clientName, issueDate: inv.issueDate, dueDate: inv.dueDate,
      overdueDays: inv.overdueDays, balanceCents: inv.balanceCents, mandateId: m.id, umr: m.umr, scheme: m.scheme, ibanMasked: R.maskIban(m.iban),
      firstCollection: exp.collections === 0,
      blocked: expired ? `Mandat caduc : aucun prélèvement depuis ${MANDATE_LIFETIME_MONTHS} mois (valable jusqu'au ${dFr(exp.expiresOn)}). Faites signer un nouveau mandat.` : null,
      warnings: adviceFor(inv, date, cr.noticeDays),
    });
  }
  lines.sort((a, b) => a.clientName.localeCompare(b.clientName, 'fr') || String(a.dueDate).localeCompare(String(b.dueDate)));
  const preparing = db.prepare("SELECT id, msg_id FROM sdd_batches WHERE status = 'prepared' ORDER BY id LIMIT 1").get();
  return {
    creditor: cr, collectionDate: date, bounds, dateProblem: checkCollectionDate(date, today),
    lines, noMandate: [...noMandate.values()].sort((a, b) => a.clientName.localeCompare(b.clientName, 'fr')),
    engagedInvoices: engaged, preparedBatch: preparing ? { id: preparing.id, msgId: preparing.msg_id } : null,
  };
}

const usedBefore = (mandateId) => !!db.prepare(`SELECT 1 FROM sdd_batch_items i JOIN sdd_batches b ON b.id = i.batch_id
  WHERE i.mandate_id = ? AND b.status IN ('sent','settled') AND i.status <> 'rejected' LIMIT 1`).get(mandateId);

function remittanceOf(numbers) {
  const head = numbers.length === 1 ? 'Facture ' : 'Factures ';
  let text = head + numbers[0];
  for (const n of numbers.slice(1)) { if ((text + ' ' + n).length > 140) break; text += ' ' + n; }
  return text;
}

/**
 * Plan d'un lot : un prélèvement par mandat (toutes les factures cochées d'un même hôtel sont réunies en un seul débit).
 * Aucune écriture. `problems` bloque la création ; `warnings` informe sans bloquer.
 */
function plan(input) {
  const body = input || {};
  const today = engine.todayParis();
  const problems = []; const warnings = [];
  const ids = [...new Set((Array.isArray(body.invoiceIds) ? body.invoiceIds : []).map(Number))];
  if (!ids.length) throw new BillingError('Cochez au moins une facture.');
  if (ids.length > MAX_INVOICES) throw new BillingError(`${MAX_INVOICES} factures au plus par lot.`);
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) throw new BillingError('Liste de factures invalide.');
  const date = String(body.collectionDate || '');

  const cr = creditor({ full: true });
  problems.push(...cr.problems);
  const dateProblem = checkCollectionDate(date, today);
  if (dateProblem) problems.push(dateProblem);
  const preparing = db.prepare("SELECT msg_id FROM sdd_batches WHERE status = 'prepared' LIMIT 1").get();
  if (preparing) problems.push(`Le lot ${preparing.msg_id} est déjà préparé : remettez-le à la banque (puis marquez-le « Envoyé ») ou annulez-le avant d'en préparer un autre.`);

  const open = new Map(queries.listOpen(today).map(d => [d.id, d]));
  const inBatch = invoicesInOpenBatches();
  const mandates = activeMandates();
  const byMandate = new Map();
  for (const id of ids) {
    const inv = open.get(id);
    if (!inv) { problems.push(`Facture #${id} : introuvable, non émise ou déjà soldée.`); continue; }
    const label = inv.number || `#${id}`;
    if (inBatch.has(id)) { problems.push(`${label} : déjà dans le lot ${inBatch.get(id).msgId}.`); continue; }
    const m = mandates.get(inv.clientId);
    if (!m) { problems.push(`${label} : ${inv.clientName} n'a pas de mandat actif.`); continue; }
    const exp = mandateExpiry(m);
    if (R.isIso(date) && exp.expiresOn < date) { problems.push(`${label} : mandat ${m.umr} caduc (aucun prélèvement depuis ${MANDATE_LIFETIME_MONTHS} mois).`); continue; }
    for (const w of adviceFor(inv, date, cr.noticeDays)) warnings.push(`${label} : ${w}`);
    const g = byMandate.get(m.id) || { mandate: m, invoices: [] };
    g.invoices.push(inv); byMandate.set(m.id, g);
  }

  const debits = [];
  for (const { mandate: m, invoices } of byMandate.values()) {
    invoices.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || a.id - b.id);
    const amountCents = invoices.reduce((s, i) => s + i.balanceCents, 0);
    if (amountCents > MAX_DEBIT_CENTS) { problems.push(`${m.client_name} : montant trop élevé pour un prélèvement SEPA.`); continue; }
    debits.push({
      mandateId: m.id, umr: m.umr, scheme: m.scheme, clientId: m.client_id, clientName: m.client_name, debtorName: m.debtor_name,
      iban: m.iban, ibanMasked: R.maskIban(m.iban), bic: m.bic || null, signedOn: m.signed_on,
      seqType: usedBefore(m.id) ? 'RCUR' : 'FRST', amountCents,
      remittance: remittanceOf(invoices.map(i => i.number)),
      invoices: invoices.map(i => ({ invoiceId: i.id, number: i.number, dueDate: i.dueDate, amountCents: i.balanceCents })),
    });
  }
  debits.sort((a, b) => a.clientName.localeCompare(b.clientName, 'fr') || a.mandateId - b.mandateId);
  if (debits.length > MAX_DEBITS) problems.push(`${MAX_DEBITS} prélèvements au plus par lot (${debits.length} demandés).`);
  return {
    collectionDate: date, creditor: cr, debits, problems, warnings,
    count: debits.length, invoiceCount: debits.reduce((s, d) => s + d.invoices.length, 0),
    totalCents: debits.reduce((s, d) => s + d.amountCents, 0),
    firstCount: debits.filter(d => d.seqType === 'FRST').length,
  };
}

/** Aperçu : le plan, sans IBAN complet, sans rien écrire. */
function preview(input) {
  const p = plan(input);
  const { creditor: cr, debits, ...rest } = p;
  return { ...rest, creditor: { name: cr.name, ics: cr.ics, ibanMasked: R.maskIban(cr.iban || ''), noticeDays: cr.noticeDays }, debits: debits.map(({ iban, bic, ...d }) => ({ ...d, ibanMasked: d.ibanMasked })) };
}

// ================= lots =================

function itemsOf(batchId) {
  const items = db.prepare(`SELECT i.*, m.client_id, m.status AS mandate_status, c.societe AS client_name FROM sdd_batch_items i
    JOIN sdd_mandates m ON m.id = i.mandate_id JOIN clients c ON c.id = m.client_id WHERE i.batch_id = ? ORDER BY i.id`).all(batchId);
  const inv = db.prepare(`SELECT ii.item_id, ii.invoice_id, ii.amount_cents, n.number, n.due_date FROM sdd_item_invoices ii
    JOIN native_invoices n ON n.id = ii.invoice_id WHERE ii.item_id IN (SELECT id FROM sdd_batch_items WHERE batch_id = ?) ORDER BY ii.rowid`).all(batchId);
  return items.map(i => ({
    id: i.id, mandateId: i.mandate_id, clientId: i.client_id, clientName: i.client_name, umr: i.umr, scheme: i.scheme, seqType: i.seq_type,
    debtorName: i.debtor_name, ibanMasked: R.maskIban(i.debtor_iban), amountCents: i.amount_cents, endToEndId: i.end_to_end_id,
    remittance: i.remittance, status: i.status, rejectReason: i.reject_reason, mandateActive: i.mandate_status === 'active',
    invoices: inv.filter(x => x.item_id === i.id).map(x => ({ invoiceId: x.invoice_id, number: x.number, dueDate: x.due_date, amountCents: x.amount_cents })),
  }));
}

function presentBatch(b, withItems = false) {
  const stats = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='collected' THEN amount_cents END),0) AS collected, COALESCE(SUM(CASE WHEN status='rejected' THEN amount_cents END),0) AS rejected,
    SUM(status='rejected') AS rejectedCount, SUM(seq_type='FRST') AS firstCount FROM sdd_batch_items WHERE batch_id = ?`).get(b.id);
  const out = {
    id: b.id, msgId: b.msg_id, status: b.status, collectionDate: b.collection_date, itemCount: b.item_count, totalCents: b.total_cents,
    createdAt: b.created_at, sentAt: b.sent_at, settledAt: b.settled_at, cancelledAt: b.cancelled_at, cancelReason: b.cancel_reason,
    collectedCents: stats.collected, rejectedCents: stats.rejected, rejectedCount: stats.rejectedCount || 0, firstCount: stats.firstCount || 0,
    creditor: { name: b.creditor_name, ics: b.creditor_ics, ibanMasked: R.maskIban(b.creditor_iban) },
  };
  if (withItems) out.items = itemsOf(b.id);
  return out;
}

function listBatches() {
  return db.prepare('SELECT * FROM sdd_batches ORDER BY id DESC').all().map(b => presentBatch(b));
}

function getBatch(id) {
  const b = db.prepare('SELECT * FROM sdd_batches WHERE id = ?').get(Number(id));
  if (!b) throw new BillingError('Lot introuvable.', 404);
  return presentBatch(b, true);
}

function createBatch(input) {
  const run = db.transaction(() => {
    const p = plan(input);
    if (p.problems.length) throw new BillingError(`Lot refusé, rien n'a été préparé : ${p.problems.slice(0, 3).join(' ')}${p.problems.length > 3 ? ` (et ${p.problems.length - 3} autre(s) point(s))` : ''}`);
    const id = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM sdd_batches').get().n;
    const createdAt = new Date().toISOString();
    const msgId = R.sepaId(`CEZ-SDD-${createdAt.slice(0, 19).replace(/[-:T]/g, '')}-${id}`);
    const cr = p.creditor;
    db.prepare(`INSERT INTO sdd_batches (id, msg_id, status, collection_date, creditor_name, creditor_iban, creditor_bic, creditor_ics, item_count, total_cents, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, msgId, 'prepared', p.collectionDate, cr.name, cr.iban, cr.bic, cr.ics, p.count, p.totalCents, createdAt);
    const insItem = db.prepare(`INSERT INTO sdd_batch_items (batch_id, mandate_id, seq_type, scheme, amount_cents, end_to_end_id, remittance, umr, signed_on, debtor_name, debtor_iban, debtor_bic)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insLink = db.prepare('INSERT INTO sdd_item_invoices (item_id, invoice_id, amount_cents) VALUES (?,?,?)');
    p.debits.forEach((d, idx) => {
      const endToEnd = d.invoices.length === 1 ? R.sepaId(d.invoices[0].number) : R.sepaId(`CEZ${id}-${idx + 1}`);
      const r = insItem.run(id, d.mandateId, d.seqType, d.scheme, d.amountCents, endToEnd, d.remittance, d.umr, d.signedOn, d.debtorName, d.iban, d.bic);
      for (const inv of d.invoices) insLink.run(Number(r.lastInsertRowid), inv.invoiceId, inv.amountCents);
    });
    engine.logEvent('sdd_batch_created', null, { batchId: id, msgId, collectionDate: p.collectionDate, debits: p.count, invoices: p.invoiceCount, totalCents: p.totalCents, first: p.firstCount });
    return id;
  });
  return getBatch(run.immediate());
}

/** Fichier pain.008 d'un lot (régénéré à l'identique depuis les données figées). Un lot annulé n'a plus de fichier valable. */
function batchXml(id) {
  const b = db.prepare('SELECT * FROM sdd_batches WHERE id = ?').get(Number(id));
  if (!b) throw new BillingError('Lot introuvable.', 404);
  if (b.status === 'cancelled') throw new BillingError("Ce lot est annulé : son fichier n'est plus valable.", 409);
  const items = db.prepare('SELECT * FROM sdd_batch_items WHERE batch_id = ? ORDER BY id').all(b.id).map(i => ({
    scheme: i.scheme, seqType: i.seq_type, endToEndId: i.end_to_end_id, amountCents: i.amount_cents, umr: i.umr, signedOn: i.signed_on,
    debtorName: i.debtor_name, debtorIban: i.debtor_iban, debtorBic: i.debtor_bic, remittance: i.remittance,
  }));
  const xml = buildPain008({ msgId: b.msg_id, createdAt: b.created_at, collectionDate: b.collection_date, creditor: { name: b.creditor_name, iban: b.creditor_iban, bic: b.creditor_bic, ics: b.creditor_ics } }, items);
  engine.logEvent('sdd_batch_downloaded', null, { batchId: b.id, msgId: b.msg_id });
  return { xml, filename: `prelevements-sepa_${b.collection_date}_${b.msg_id}.xml` };
}

function markSent(id) {
  const run = db.transaction(() => {
    const b = db.prepare('SELECT * FROM sdd_batches WHERE id = ?').get(Number(id));
    if (!b) throw new BillingError('Lot introuvable.', 404);
    if (b.status !== 'prepared') throw new BillingError('Seul un lot préparé peut être marqué « Envoyé ».');
    if (b.collection_date <= engine.todayParis()) throw new BillingError(`La date de prélèvement (${dFr(b.collection_date)}) est atteinte : la banque ne peut plus traiter ce fichier. Annulez ce lot et préparez-en un nouveau.`);
    db.prepare("UPDATE sdd_batches SET status = 'sent', sent_at = ? WHERE id = ?").run(new Date().toISOString(), b.id);
    engine.logEvent('sdd_batch_sent', null, { batchId: b.id, msgId: b.msg_id, totalCents: b.total_cents });
  });
  run.immediate();
  return getBatch(id);
}

function cancelBatch(id, { reason } = {}) {
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (why.length < 3) throw new BillingError("Indiquez le motif de l'annulation.");
  const run = db.transaction(() => {
    const b = db.prepare('SELECT * FROM sdd_batches WHERE id = ?').get(Number(id));
    if (!b) throw new BillingError('Lot introuvable.', 404);
    if (!['prepared', 'sent'].includes(b.status)) throw new BillingError(b.status === 'settled' ? 'Ce lot est déjà encaissé : il ne peut plus être annulé.' : 'Ce lot est déjà annulé.');
    db.prepare("UPDATE sdd_batches SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?").run(new Date().toISOString(), why, b.id);
    engine.logEvent('sdd_batch_cancelled', null, { batchId: b.id, msgId: b.msg_id, wasSent: b.status === 'sent', reason: why });
  });
  run.immediate();
  return getBatch(id);
}

/**
 * Clôture d'un lot remis à la banque : chaque prélèvement non rejeté est enregistré comme règlement sur ses factures.
 * rejections : [{ itemId, reason, revokeMandate? }]. Tout ou rien.
 */
function settle(id, { rejections } = {}) {
  const list = Array.isArray(rejections) ? rejections : [];
  const run = db.transaction(() => {
    const b = db.prepare('SELECT * FROM sdd_batches WHERE id = ?').get(Number(id));
    if (!b) throw new BillingError('Lot introuvable.', 404);
    if (b.status !== 'sent') throw new BillingError(b.status === 'prepared' ? "Remettez d'abord le fichier à la banque et marquez le lot « Envoyé »." : 'Ce lot est déjà clôturé.');
    if (b.collection_date > engine.todayParis()) throw new BillingError(`Le prélèvement est prévu le ${dFr(b.collection_date)} : il n'a pas encore eu lieu. Revenez à cette date, relevé de compte en main.`);
    const items = db.prepare('SELECT * FROM sdd_batch_items WHERE batch_id = ? ORDER BY id').all(b.id);
    const byId = new Map(items.map(i => [i.id, i]));
    const rej = new Map();
    for (const r of list) {
      const itemId = Number(r && r.itemId);
      if (!byId.has(itemId)) throw new BillingError('Prélèvement rejeté inconnu dans ce lot.');
      if (rej.has(itemId)) throw new BillingError('Un prélèvement est indiqué deux fois comme rejeté.');
      const reason = String(r.reason || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (!reason) throw new BillingError(`Indiquez le motif du rejet pour ${byId.get(itemId).debtor_name}.`);
      rej.set(itemId, { reason, revoke: !!r.revokeMandate });
    }
    const links = db.prepare('SELECT ii.*, n.number FROM sdd_item_invoices ii JOIN native_invoices n ON n.id = ii.invoice_id WHERE ii.item_id = ?');
    let collectedCents = 0; let payments = 0;
    for (const it of items) {
      if (rej.has(it.id)) continue;
      for (const l of links.all(it.id)) {
        const inv = engine.loadInvoice(l.invoice_id);
        const balance = engine.balanceCents(inv);
        if (balance < l.amount_cents) {
          throw new BillingError(`${l.number} : le reste dû (${eur(balance)}) est inférieur au prélèvement (${eur(l.amount_cents)}). Un règlement a été enregistré depuis la préparation du lot : annulez-le sur la facture (écriture inverse) puis recommencez.`, 409);
        }
        engine.recordPayment(l.invoice_id, { paidOn: b.collection_date, amount: l.amount_cents / 100, method: 'prelevement', reference: `Prélèvement SEPA ${b.msg_id} ${it.umr}` });
        payments++;
      }
      collectedCents += it.amount_cents;
    }
    const upd = db.prepare('UPDATE sdd_batch_items SET status = ?, reject_reason = ? WHERE id = ?');
    for (const it of items) { const r = rej.get(it.id); upd.run(r ? 'rejected' : 'collected', r ? r.reason : null, it.id); }
    db.prepare("UPDATE sdd_batches SET status = 'settled', settled_at = ? WHERE id = ?").run(new Date().toISOString(), b.id);
    const revoked = [];
    for (const [itemId, r] of rej) {
      const it = byId.get(itemId);
      let mandateRevoked = false;
      if (r.revoke && db.prepare("SELECT 1 FROM sdd_mandates WHERE id = ? AND status = 'active'").get(it.mandate_id)) { revokeInternal(it.mandate_id, `Prélèvement rejeté : ${r.reason}`.slice(0, 140)); mandateRevoked = true; revoked.push(it.umr); }
      engine.logEvent('sdd_item_rejected', null, { batchId: b.id, msgId: b.msg_id, itemId, umr: it.umr, iban: R.maskIban(it.debtor_iban), amountCents: it.amount_cents, reason: r.reason, mandateRevoked });
    }
    engine.logEvent('sdd_batch_settled', null, { batchId: b.id, msgId: b.msg_id, collected: items.length - rej.size, rejected: rej.size, collectedCents, payments });
    return { collected: items.length - rej.size, rejected: rej.size, collectedCents, payments, revokedMandates: revoked };
  });
  const summary = run.immediate();
  return { ...summary, batch: getBatch(id) };
}

/** Données du formulaire PDF : mandat vierge pour un hôtel (référence proposée), ou copie d'un mandat enregistré. */
function formData({ clientId, mandateId, scheme, umr } = {}) {
  const cr = creditor();
  if (!cr.ics || R.icsError(cr.ics)) throw new BillingError("Saisissez d'abord l'identifiant créancier (ICS) de la société : il figure sur le mandat.");
  const m = mandateId ? mandateById(Number(mandateId)) : null;
  if (mandateId && !m) throw new BillingError('Mandat introuvable.', 404);
  const id = m ? m.client_id : Number(clientId);
  const client = Number.isInteger(id) ? db.prepare('SELECT * FROM clients WHERE id = ?').get(id) : null;
  if (!client) throw new BillingError('Hôtel introuvable.', 404);
  const sch = m ? m.scheme : (scheme === undefined || scheme === '' ? 'CORE' : String(scheme));
  if (!SCHEMES.includes(sch)) throw new BillingError('Type de mandat inconnu (CORE ou B2B).');
  const ref = m ? m.umr : (umr ? String(umr).trim() : suggestUmr(id));
  const umrProblem = R.umrError(ref); if (umrProblem) throw new BillingError(umrProblem);
  return {
    umr: ref, scheme: sch, creditor: { name: cr.name, address: cr.address, ics: cr.ics },
    debtor: { name: m ? m.debtor_name : client.societe, contact: client.contact || '', lines: [client.adresse_facturation || client.adresse, [client.code_postal, client.ville].filter(Boolean).join(' ')].filter(Boolean) },
    iban: m ? m.iban : null, bic: m ? m.bic : null, signedOn: m ? m.signed_on : null,
  };
}

/** Pour le badge du menu et l'en-tête de la page. */
function overview() {
  const cr = creditor();
  const c = db.prepare(`SELECT
      (SELECT COUNT(*) FROM sdd_mandates WHERE status = 'active') AS mandates,
      (SELECT COUNT(*) FROM sdd_batches WHERE status = 'prepared') AS prepared,
      (SELECT COUNT(*) FROM sdd_batches WHERE status = 'sent') AS sent,
      (SELECT COUNT(*) FROM sdd_batches WHERE status = 'sent' AND collection_date <= ?) AS toSettle`).get(engine.todayParis());
  return { creditor: cr, ...c };
}

module.exports = {
  creditor, setCreditor, listMandates, createMandate, revokeMandate, suggestUmr,
  formData, candidates, plan, preview, createBatch, listBatches, getBatch, batchXml, markSent, cancelBatch, settle, overview,
  checkCollectionDate, dateBounds, mandateExpiry, MAX_DEBITS, MANDATE_LIFETIME_MONTHS,
};
