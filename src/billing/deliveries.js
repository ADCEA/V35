// Bons de livraison (BL) : commandes livrées, consultables par période et par hôtel, avec leur état de facturation.
//
// Un BL est une commande au statut « livrée ». Sa date est la date de livraison (à défaut, celle de création) :
// c'est la même que celle utilisée pour facturer et pour appliquer le tarif en vigueur.
// Rien n'est écrit ici : ce module ne fait que lire.

const db = require('../db');
const engine = require('./engine');

const { BillingError, lineCents } = engine;

const STATUSES = ['to_invoice', 'draft', 'invoiced'];
// Paiement de la facture d'un BL facturé (mêmes états que la liste des factures) : à encaisser (rien reçu, pas échue),
// en retard (échue, reste à payer), partielle (règlement partiel, pas échue), payée.
const PAYMENTS = ['unpaid', 'overdue', 'partial', 'paid'];
const MAX_LIST = 1000;       // lignes renvoyées à l'écran (les totaux portent toujours sur l'ensemble)
const MAX_EXPORT = 500;      // BL dans un PDF groupé

const DATE_SQL = "COALESCE(NULLIF(substr(o.livraison_prevue, 1, 10), ''), substr(o.created_at, 1, 10))";

function parseFilters(f = {}) {
  const from = f.from || null; const to = f.to || null;
  if (from && !engine.isIsoDate(from)) throw new BillingError('Date de début invalide.');
  if (to && !engine.isIsoDate(to)) throw new BillingError('Date de fin invalide.');
  if (from && to && from > to) throw new BillingError('La date de début est postérieure à la date de fin.');
  const clientId = f.clientId ? Number(f.clientId) : null;
  if (f.clientId && !Number.isInteger(clientId)) throw new BillingError('Hôtel invalide.');
  const status = f.status || null;
  if (status && !STATUSES.includes(status)) throw new BillingError('Statut de facturation invalide.');
  const payment = (Array.isArray(f.payment) ? f.payment : String(f.payment || '').split(',')).map(x => String(x).trim()).filter(Boolean);
  if (payment.some(x => !PAYMENTS.includes(x))) throw new BillingError('Statut de paiement invalide.');
  const q = String(f.q || '').trim().slice(0, 80);
  return { from, to, clientId, status, payment: [...new Set(payment)], q };
}

/** Clause WHERE commune aux requêtes (BL livrés, filtrés par date, hôtel et recherche). */
function where({ from, to, clientId, q }) {
  const sql = ["o.status = 'livree'"]; const args = [];
  if (from) { sql.push(`${DATE_SQL} >= ?`); args.push(from); }
  if (to) { sql.push(`${DATE_SQL} <= ?`); args.push(to); }
  if (clientId) { sql.push('o.client_id = ?'); args.push(clientId); }
  if (q) {
    sql.push(`(o.ticket LIKE ? ESCAPE '\\' OR o.societe LIKE ? ESCAPE '\\' OR o.adresse LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM clients cc WHERE cc.id = o.client_id AND cc.societe LIKE ? ESCAPE '\\'))`);
    const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`; args.push(like, like, like, like);
  }
  return { sql: sql.join(' AND '), args };
}

/** Facture « active » de chaque BL : une facture annulée par un avoir total remet le BL à facturer. */
const activeInvoiceSql = `
  SELECT no.order_id AS orderId, ni.id AS invoiceId, ni.status AS invoiceStatus, ni.number AS number, ni.issue_date AS issueDate,
         ni.due_date AS dueDate, ni.total_ttc_cents AS totalCents,
         COALESCE((SELECT SUM(p.amount_cents) FROM native_payments p WHERE p.invoice_id = ni.id), 0) AS paidCents,
         COALESCE((SELECT SUM(cn.total_ttc_cents) FROM native_invoices cn WHERE cn.credits_invoice_id = ni.id AND cn.kind = 'credit_note' AND cn.status = 'issued'), 0) AS creditedCents
  FROM native_invoice_orders no
  JOIN native_invoices ni ON ni.id = no.invoice_id
  WHERE ni.kind = 'invoice'
    AND NOT EXISTS (SELECT 1 FROM native_invoices cn WHERE cn.credits_invoice_id = ni.id AND cn.status = 'issued' AND cn.is_full_credit = 1)`;

/** Paiement de la facture, avec les règles de la liste des factures (l'échéance passée prime sur le règlement partiel). */
function paymentOf(inv, today) {
  const balance = inv.totalCents - inv.creditedCents - inv.paidCents;
  if (balance <= 0) return 'paid';
  if (inv.dueDate && inv.dueDate < today) return 'overdue';
  return inv.paidCents > 0 ? 'partial' : 'unpaid';
}

function billingOf(orderId, invoices, legacy, today = engine.todayParis()) {
  const inv = invoices.get(orderId);
  if (inv) {
    return inv.invoiceStatus === 'issued'
      ? { status: 'invoiced', invoiceId: inv.invoiceId, invoiceNumber: inv.number, invoiceDate: inv.issueDate, legacy: false, payment: paymentOf(inv, today), dueDate: inv.dueDate }
      : { status: 'draft', invoiceId: inv.invoiceId, invoiceNumber: null, invoiceDate: null, legacy: false, payment: null, dueDate: null };
  }
  // Facturé dans l'ancien circuit : le paiement n'y est pas suivi.
  if (legacy.has(orderId)) return { status: 'invoiced', invoiceId: null, invoiceNumber: null, invoiceDate: null, legacy: true, payment: null, dueDate: null };
  return { status: 'to_invoice', invoiceId: null, invoiceNumber: null, invoiceDate: null, legacy: false, payment: null, dueDate: null };
}

function loadBilling() {
  const invoices = new Map(db.prepare(activeInvoiceSql).all().map(r => [r.orderId, r]));
  const legacy = new Set(db.prepare('SELECT order_id FROM invoice_orders').all().map(r => r.order_id));
  return { invoices, legacy };
}

/** Liste des BL livrés, du plus récent au plus ancien, avec totaux sur l'ensemble des résultats. */
function listDeliveries(filters) {
  const f = parseFilters(filters);
  const w = where(f);
  const rows = db.prepare(`
    SELECT o.id, o.ticket, o.client_id AS clientId, COALESCE(c.societe, o.societe) AS clientName, o.adresse,
           ${DATE_SQL} AS date, o.created_at AS createdAt
    FROM orders o LEFT JOIN clients c ON c.id = o.client_id
    WHERE ${w.sql}
    ORDER BY date DESC, o.id DESC
  `).all(...w.args);

  const amounts = new Map();
  for (const it of db.prepare(`
    SELECT oi.order_id AS orderId, oi.qty, oi.delivered_qty AS d, oi.price
    FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${w.sql}
  `).all(...w.args)) {
    const a = amounts.get(it.orderId) || { refs: 0, pieces: 0, htCents: 0 };
    const qty = it.d ?? it.qty;
    a.refs += qty > 0 ? 1 : 0; a.pieces += qty; a.htCents += lineCents(qty, it.price);
    amounts.set(it.orderId, a);
  }

  const { invoices, legacy } = loadBilling();
  const today = engine.todayParis();
  const all = rows.map(r => ({ ...r, ...(amounts.get(r.id) || { refs: 0, pieces: 0, htCents: 0 }), billing: billingOf(r.id, invoices, legacy, today) }));
  const byStatus = (list) => (f.status ? list.filter(r => r.billing.status === f.status) : list);
  const byPayment = (list) => (f.payment.length ? list.filter(r => f.payment.includes(r.billing.payment)) : list);
  const kept = byPayment(byStatus(all));

  const totals = { count: kept.length, htCents: 0, byStatus: { to_invoice: { count: 0, htCents: 0 }, draft: { count: 0, htCents: 0 }, invoiced: { count: 0, htCents: 0 } } };
  for (const r of kept) {
    totals.htCents += r.htCents;
    totals.byStatus[r.billing.status].count += 1; totals.byStatus[r.billing.status].htCents += r.htCents;
  }
  // Les compteurs de chaque filtre ignorent ce filtre lui-même mais tiennent compte de l'autre : les puces restent cohérentes.
  const forTabs = byPayment(all); const forPayments = byStatus(all);
  const counts = { all: forTabs.length, to_invoice: 0, draft: 0, invoiced: 0, payments: Object.fromEntries(PAYMENTS.map(k => [k, 0])) };
  for (const r of forTabs) counts[r.billing.status] += 1;
  for (const r of forPayments) if (r.billing.payment) counts.payments[r.billing.payment] += 1;
  return { filters: f, deliveries: kept.slice(0, MAX_LIST), total: kept.length, truncated: kept.length > MAX_LIST, totals, counts };
}

/** Détail d'un BL : coordonnées, lignes (commandé / livré / prix figé) et état de facturation. */
function getDelivery(id) {
  const o = db.prepare(`
    SELECT o.*, COALESCE(c.societe, o.societe) AS clientName, ${DATE_SQL} AS date
    FROM orders o LEFT JOIN clients c ON c.id = o.client_id WHERE o.id = ? AND o.status = 'livree'
  `).get(id);
  if (!o) throw new BillingError('Bon de livraison introuvable (la commande n\'est pas livrée ou n\'existe plus).', 404);
  const items = db.prepare('SELECT service_id AS id, name, code, sage_code AS sageCode, price, qty, delivered_qty AS deliveredQty FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  const lines = items.map(it => {
    const qty = it.deliveredQty ?? it.qty;
    return { ...it, delivered: qty, htCents: lineCents(qty, it.price) };
  });
  const { invoices, legacy } = loadBilling();
  return {
    id: o.id, ticket: o.ticket, date: o.date, createdAt: o.created_at,
    client: { id: o.client_id, societe: o.clientName, contact: o.contact, tel: o.tel, adresse: o.adresse },
    notes: o.notes || '',
    lines, htCents: lines.reduce((s, l) => s + l.htCents, 0),
    adjusted: lines.some(l => l.deliveredQty != null && l.deliveredQty !== l.qty),
    billing: billingOf(o.id, invoices, legacy),
    order: o,       // ligne brute de la commande, pour le PDF du BL
    items,          // lignes au format attendu par le PDF du BL
  };
}

/** BL (lignes brutes + articles) correspondant aux filtres, du plus ancien au plus récent, pour un PDF groupé. */
function exportSet(filters) {
  const list = listDeliveries(filters);
  if (!list.total) throw new BillingError('Aucun bon de livraison ne correspond à ces filtres.', 404);
  if (list.total > MAX_EXPORT) throw new BillingError(`Trop de bons à la fois (${list.total}). Maximum ${MAX_EXPORT} : resserrez la période ou choisissez un hôtel.`);
  const orderStmt = db.prepare('SELECT * FROM orders WHERE id = ?');
  const itemsStmt = db.prepare('SELECT service_id AS id, name, code, sage_code AS sageCode, price, qty, delivered_qty AS deliveredQty FROM order_items WHERE order_id = ?');
  return [...list.deliveries].reverse().map(d => ({ ...orderStmt.get(d.id), items: itemsStmt.all(d.id) }));
}

const STATUS_LABEL = { to_invoice: 'À facturer', draft: 'Dans un brouillon', invoiced: 'Facturé' };
const PAYMENT_LABEL = { unpaid: 'À encaisser', overdue: 'En retard', partial: 'Partielle', paid: 'Payée' };
const csvCell = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const fr = (cents) => (cents / 100).toFixed(2).replace('.', ',');

/** Liste des BL filtrés en CSV (« ; », virgule décimale, BOM : s'ouvre directement dans Excel). */
function deliveriesCsv(filters) {
  const list = listDeliveries({ ...filters });
  const head = ['bl', 'date_livraison', 'hotel', 'references', 'pieces', 'montant_ht', 'facturation', 'facture', 'paiement'];
  const lines = [head.join(';')];
  for (const d of [...list.deliveries].reverse()) {
    const b = d.billing;
    lines.push([d.ticket, d.date, d.clientName, d.refs, d.pieces, fr(d.htCents),
      STATUS_LABEL[b.status] + (b.legacy ? ' (ancien circuit)' : ''), b.invoiceNumber || '', PAYMENT_LABEL[b.payment] || ''].map(csvCell).join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { listDeliveries, getDelivery, exportSet, deliveriesCsv, STATUSES, PAYMENTS, MAX_EXPORT, MAX_LIST };
