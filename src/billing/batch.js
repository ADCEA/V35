// Facturation du mois en lot : prépare un brouillon par hôtel pour tous les BL livrés
// non facturés, puis émet la sélection en une seule opération.

const db = require('../db');
const engine = require('./engine');
const { billingIssues } = require('./catalog');

const { BillingError } = engine;

/** Hôtels ayant des BL livrés à facturer, livrés jusqu'à `upTo` (AAAA-MM-JJ, inclus). */
function preview(upTo) {
  if (upTo && !engine.isIsoDate(upTo)) throw new BillingError('Date limite invalide.');
  const ids = db.prepare("SELECT DISTINCT client_id FROM orders WHERE status = 'livree' AND client_id IS NOT NULL").all().map(r => r.client_id);
  const out = [];
  for (const cid of ids) {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(cid);
    if (!client) continue;
    const orders = engine.listInvoiceableOrders(cid).filter(o => !upTo || !o.livraisonPrevue || String(o.livraisonPrevue).slice(0, 10) <= upTo);
    if (!orders.length) continue;
    out.push({
      clientId: cid, clientName: client.societe, orders,
      estimatedHtCents: engine.estimateOrdersHtCents(orders.map(o => o.id)),
      issues: billingIssues(client),
    });
  }
  return out.sort((a, b) => a.clientName.localeCompare(b.clientName, 'fr'));
}

/** Crée un brouillon par hôtel sélectionné. Une erreur sur un hôtel n'arrête pas les autres. */
function createDrafts({ clientIds, upTo }) {
  if (!Array.isArray(clientIds) || !clientIds.length) throw new BillingError('Sélectionnez au moins un hôtel.');
  const wanted = new Set(clientIds.map(Number));
  const results = [];
  for (const p of preview(upTo).filter(p => wanted.has(p.clientId))) {
    try {
      const inv = engine.createDraftFromOrders(p.clientId, p.orders.map(o => o.id));
      results.push({ clientId: p.clientId, clientName: p.clientName, ok: true, invoiceId: inv.id, totalTtcCents: inv.total_ttc_cents });
    } catch (e) {
      results.push({ clientId: p.clientId, clientName: p.clientName, ok: false, error: e.message });
    }
  }
  for (const id of wanted) if (!results.some(r => r.clientId === id)) results.push({ clientId: id, ok: false, error: 'Aucun BL à facturer pour cet hôtel.' });
  return results;
}

/** Émet une liste de brouillons dans l'ordre donné. Chaque émission est sa propre transaction. */
function issueMany({ invoiceIds, issueDate }) {
  if (!Array.isArray(invoiceIds) || !invoiceIds.length) throw new BillingError('Sélectionnez au moins un brouillon.');
  if (invoiceIds.length > 200) throw new BillingError('200 documents au plus par opération.');
  const results = [];
  for (const id of invoiceIds.map(Number)) {
    try {
      const inv = engine.issueInvoice(id, { issueDate: issueDate || undefined });
      results.push({ invoiceId: id, ok: true, number: inv.number, totalTtcCents: inv.total_ttc_cents });
    } catch (e) {
      if (!(e instanceof BillingError) && !/interdit/.test(e.message || '')) throw e;
      results.push({ invoiceId: id, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { preview, createDrafts, issueMany };
