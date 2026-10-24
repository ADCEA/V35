// Règlements en lot : enregistre d'un coup le solde de plusieurs factures déjà encaissées
// (par exemple des prélèvements passés avant l'arrivée du module SEPA, ou un lot de chèques).
//
// Principe : on VOIT d'abord (aperçu, rien n'est écrit), puis on applique. L'application est
// atomique : si une seule facture est refusée (déjà soldée, avoir entre-temps…), RIEN n'est
// enregistré, pour ne jamais laisser un lot à moitié passé.

const db = require('../db');
const engine = require('./engine');
const bank = require('./bank');

const { BillingError } = engine;
const MAX = 200;

function clean(input) {
  const body = input || {};
  const ids = [...new Set((Array.isArray(body.invoiceIds) ? body.invoiceIds : []).map(Number))];
  if (!ids.length) throw new BillingError('Cochez au moins une facture.');
  if (ids.length > MAX) throw new BillingError(`${MAX} factures au plus par lot.`);
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) throw new BillingError('Liste de factures invalide.');
  const method = body.method === undefined || body.method === null || body.method === '' ? 'prelevement' : String(body.method);
  if (!bank.METHODS.includes(method)) throw new BillingError('Mode de règlement inconnu.');
  const today = engine.todayParis();
  const paidOn = body.paidOn || today;
  if (!engine.isIsoDate(paidOn)) throw new BillingError('Date de règlement invalide.');
  if (paidOn > today) throw new BillingError("La date d'encaissement ne peut pas être dans le futur : ce lot enregistre des règlements déjà reçus.");
  const reference = String(body.reference || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  return { ids, method, paidOn, reference };
}

/** Une ligne d'aperçu par facture : montant qui sera enregistré (tout le reste dû) ou motif de refus. */
function lines(ids) {
  return ids.map((id) => {
    const inv = engine.loadInvoice(id);
    if (!inv) return { invoiceId: id, ok: false, error: 'Facture introuvable.' };
    const client = db.prepare('SELECT societe FROM clients WHERE id = ?').get(inv.client_id);
    const base = { invoiceId: id, number: inv.number, clientName: client ? client.societe : '', dueDate: inv.due_date };
    if (inv.status !== 'issued' || inv.kind !== 'invoice') return { ...base, ok: false, error: 'Ce document n\'est pas une facture émise.' };
    const balance = engine.balanceCents(inv);
    if (balance <= 0) return { ...base, ok: false, balanceCents: 0, error: 'Déjà soldée.' };
    return { ...base, ok: true, balanceCents: balance, amountCents: balance };
  });
}

function preview(input) {
  const { ids, method, paidOn, reference } = clean(input);
  const rows = lines(ids);
  const good = rows.filter(r => r.ok);
  return {
    method, paidOn, reference, lines: rows,
    count: good.length, refused: rows.length - good.length,
    totalCents: good.reduce((s, r) => s + r.amountCents, 0),
  };
}

function apply(input) {
  const { ids, method, paidOn, reference } = clean(input);
  const rows = lines(ids);
  const bad = rows.filter(r => !r.ok);
  if (bad.length) throw new BillingError(`Lot refusé, rien n'a été enregistré : ${bad.slice(0, 3).map(b => `${b.number || '#' + b.invoiceId} — ${b.error}`).join(' ; ')}${bad.length > 3 ? ` (et ${bad.length - 3} autre(s))` : ''}.`);
  const run = db.transaction(() => {
    for (const r of rows) {
      // recordPayment recalcule le reste dû dans la transaction : si une facture a changé entre
      // l'aperçu et maintenant, l'exception annule le lot entier.
      engine.recordPayment(r.invoiceId, { paidOn, amount: r.amountCents / 100, method, reference: reference || 'Règlement enregistré en lot' });
    }
  });
  run.immediate();
  return { count: rows.length, totalCents: rows.reduce((s, r) => s + r.amountCents, 0), method, paidOn };
}

module.exports = { preview, apply, MAX };
