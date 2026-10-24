// Ventes jour par jour — MONTANTS (livré valorisé, factures, avoirs, encaissements).
// Derrière le verrou de la Facturation : les montants ne sont jamais visibles sans le code.
// La partie exploitation (commandes, pièces, poids, km) est dans utils/dailyStats.js.
//
//  - « livré » = valeur des bons de livraison, au prix figé sur chaque ligne, par date de livraison ;
//  - « facturé » = factures émises par date d'émission (avoirs à part) ;
//  - « encaissé » = règlements par date de règlement, par mode ; une annulation de règlement (montant négatif)
//    est comptée à part, pour que le total du jour reste égal à ce qui est réellement entré.

const db = require('../db');
const engine = require('./engine');
const stats = require('../utils/dailyStats');

const { lineCents } = engine;
const { DELIVERY_DATE_SQL } = stats;

const emptyDay = (date) => ({
  date, deliveredCount: 0, deliveredHtCents: 0,
  invoiceCount: 0, invoicedHtCents: 0, invoicedVatCents: 0, invoicedTtcCents: 0,
  creditCount: 0, creditedTtcCents: 0,
  paymentCount: 0, paidCents: 0, reversedCents: 0, discountCents: 0, paidByMethod: {},
});

function daily(from, to) {
  const p = stats.period(from, to);
  const days = new Map();
  for (let d = p.from; d <= p.to; d = stats.addDays(d, 1)) days.set(d, emptyDay(d));

  // Livré valorisé
  const lines = db.prepare(`
    SELECT o.id AS orderId, ${DELIVERY_DATE_SQL} AS date, oi.qty, oi.delivered_qty AS delivered, oi.price
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.status = 'livree' AND ${DELIVERY_DATE_SQL} BETWEEN ? AND ?
  `).all(p.from, p.to);
  for (const l of lines) {
    const d = days.get(l.date); if (!d) continue;
    d.deliveredHtCents += lineCents(l.delivered ?? l.qty, l.price);
  }
  // Nombre de BL du jour : toutes les commandes livrées, y compris celles sans ligne (valeur nulle).
  for (const r of db.prepare(`SELECT ${DELIVERY_DATE_SQL} AS date, COUNT(*) AS n FROM orders o WHERE o.status = 'livree' AND ${DELIVERY_DATE_SQL} BETWEEN ? AND ? GROUP BY date`).all(p.from, p.to)) {
    const d = days.get(r.date); if (d) d.deliveredCount = r.n;
  }

  // Factures et avoirs émis
  for (const r of db.prepare(`
    SELECT issue_date AS date, kind, COUNT(*) n, SUM(total_ht_cents) ht, SUM(total_vat_cents) vat, SUM(total_ttc_cents) ttc
    FROM native_invoices WHERE status = 'issued' AND kind IN ('invoice','credit_note') AND issue_date BETWEEN ? AND ? GROUP BY issue_date, kind
  `).all(p.from, p.to)) {
    const d = days.get(r.date); if (!d) continue;
    if (r.kind === 'invoice') { d.invoiceCount = r.n; d.invoicedHtCents = r.ht; d.invoicedVatCents = r.vat; d.invoicedTtcCents = r.ttc; }
    else { d.creditCount = r.n; d.creditedTtcCents = r.ttc; }
  }

  // Encaissements
  for (const r of db.prepare(`
    SELECT paid_on AS date, method, SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS received, SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS reversed, COUNT(*) AS n
    FROM native_payments WHERE paid_on BETWEEN ? AND ? AND method <> 'escompte' GROUP BY paid_on, method
  `).all(p.from, p.to)) {
    const d = days.get(r.date); if (!d) continue;
    d.paymentCount += r.n; d.paidCents += r.received - r.reversed; d.reversedCents += r.reversed;
    d.paidByMethod[r.method] = (d.paidByMethod[r.method] || 0) + (r.received - r.reversed);
  }

  // Escomptes accordés : ce n'est pas de l'argent reçu, mais ils soldent des factures.
  for (const r of db.prepare(`
    SELECT paid_on AS date, SUM(amount_cents) AS cents FROM native_payments WHERE method = 'escompte' AND paid_on BETWEEN ? AND ? GROUP BY paid_on
  `).all(p.from, p.to)) {
    const d = days.get(r.date); if (d) d.discountCents = r.cents;
  }

  const list = [...days.values()];
  const sum = (k) => list.reduce((s, d) => s + d[k], 0);
  const byMethod = {};
  for (const d of list) for (const [m, c] of Object.entries(d.paidByMethod)) byMethod[m] = (byMethod[m] || 0) + c;
  const open = db.prepare(`
    SELECT COALESCE(SUM(i.total_ttc_cents
      - COALESCE((SELECT SUM(total_ttc_cents) FROM native_invoices cn WHERE cn.credits_invoice_id = i.id AND cn.kind='credit_note' AND cn.status='issued'), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM native_payments p WHERE p.invoice_id = i.id), 0)), 0) AS due
    FROM native_invoices i WHERE i.kind = 'invoice' AND i.status = 'issued'
  `).get().due;
  const totals = {
    deliveredCount: sum('deliveredCount'), deliveredHtCents: sum('deliveredHtCents'),
    invoiceCount: sum('invoiceCount'), invoicedHtCents: sum('invoicedHtCents'), invoicedVatCents: sum('invoicedVatCents'), invoicedTtcCents: sum('invoicedTtcCents'),
    creditCount: sum('creditCount'), creditedTtcCents: sum('creditedTtcCents'),
    paymentCount: sum('paymentCount'), paidCents: sum('paidCents'), discountCents: sum('discountCents'), paidByMethod: byMethod,
  };
  return { from: p.from, to: p.to, days: list, totals, outstandingCents: Math.max(0, open) };
}

/** Détail d'un jour : BL livrés, factures et avoirs émis, règlements reçus. */
function dayDetail(date) {
  if (!stats.isIso(date)) throw new stats.StatsError('Date invalide.');
  const deliveries = db.prepare(`
    SELECT o.id, o.ticket, COALESCE(c.societe, o.societe) AS clientName FROM orders o LEFT JOIN clients c ON c.id = o.client_id
    WHERE o.status = 'livree' AND ${DELIVERY_DATE_SQL} = ? ORDER BY o.id
  `).all(date);
  const amount = db.prepare('SELECT qty, delivered_qty AS d, price FROM order_items WHERE order_id = ?');
  for (const o of deliveries) o.htCents = amount.all(o.id).reduce((s, l) => s + lineCents(l.d ?? l.qty, l.price), 0);
  const invoices = db.prepare(`
    SELECT i.id, i.number, i.kind, i.total_ht_cents AS htCents, i.total_ttc_cents AS ttcCents, c.societe AS clientName
    FROM native_invoices i JOIN clients c ON c.id = i.client_id WHERE i.status = 'issued' AND i.kind IN ('invoice','credit_note') AND i.issue_date = ? ORDER BY i.chain_no
  `).all(date);
  const payments = db.prepare(`
    SELECT p.id, p.amount_cents AS amountCents, p.method, p.reference, i.id AS invoiceId, i.number, c.societe AS clientName
    FROM native_payments p JOIN native_invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id WHERE p.paid_on = ? AND p.method <> 'escompte' ORDER BY p.id
  `).all(date);
  const discounts = db.prepare(`
    SELECT p.id, p.amount_cents AS amountCents, i.id AS invoiceId, i.number, c.societe AS clientName
    FROM native_payments p JOIN native_invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id WHERE p.paid_on = ? AND p.method = 'escompte' ORDER BY p.id
  `).all(date);
  return { date, deliveries, invoices, payments, discounts };
}

module.exports = { daily, dayDetail };
