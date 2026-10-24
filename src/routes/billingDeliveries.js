// Routes « bons de livraison » de la facturation : liste filtrée par date et par hôtel, détail, PDF, exports.
// Montées par routes/billing.js APRÈS le verrou : la Facturation doit être déverrouillée. Lecture seule.

const express = require('express');
const engine = require('../billing/engine');
const deliveries = require('../billing/deliveries');
const { buildDeliveryNotePdf } = require('../utils/pdf');
const { mergePdfs } = require('../utils/pdfMerge');
const { wrap } = require('../billing/http');

const router = express.Router();
const filtersOf = (q) => ({ from: q.from, to: q.to, clientId: q.clientId, status: q.status, q: q.q });
const safe = (s) => String(s).replace(/[^\w.-]+/g, '-');

router.get('/deliveries', wrap((req, res) => {
  res.json(deliveries.listDeliveries(filtersOf(req.query)));
}));

router.get('/deliveries/export.csv', wrap((req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bons-livraison-${engine.todayParis()}.csv"` });
  res.send(deliveries.deliveriesCsv(filtersOf(req.query)));
}));

// Un seul PDF : un BL par page (ou plus si le BL est long), du plus ancien au plus récent.
router.get('/deliveries/export.pdf', wrap(async (req, res) => {
  const orders = deliveries.exportSet(filtersOf(req.query));
  const buffers = [];
  for (const o of orders) buffers.push(await buildDeliveryNotePdf(o));
  const merged = await mergePdfs(buffers);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="bons-livraison-${engine.todayParis()}.pdf"`, 'X-Order-Count': String(orders.length) });
  res.send(merged);
}));

router.get('/deliveries/:id', wrap((req, res) => {
  const { order, items, ...d } = deliveries.getDelivery(parseInt(req.params.id, 10));
  res.json({ delivery: d });
}));

router.get('/deliveries/:id/pdf', wrap(async (req, res) => {
  const d = deliveries.getDelivery(parseInt(req.params.id, 10));
  const pdf = await buildDeliveryNotePdf({ ...d.order, items: d.items });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="bon-livraison-${safe(d.ticket)}.pdf"` });
  res.send(pdf);
}));

module.exports = router;
