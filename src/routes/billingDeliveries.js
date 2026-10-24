// Routes « bons de livraison » de la facturation : liste filtrée par date et par hôtel, détail, PDF, exports,
// et regroupement des BL dont le nom d'hôtel a été saisi librement.
// Montées par routes/billing.js APRÈS le verrou : la Facturation doit être déverrouillée.
// Seul le rattachement des BL à une fiche hôtel écrit, et il exige la ressaisie du code (après un aperçu libre).

const express = require('express');
const engine = require('../billing/engine');
const deliveries = require('../billing/deliveries');
const unlinked = require('../billing/unlinked');
const lock = require('../billing/lock');
const { buildDeliveryNotePdf } = require('../utils/pdf');
const { mergePdfs } = require('../utils/pdfMerge');
const { wrap } = require('../billing/http');

const router = express.Router();
const filtersOf = (q) => ({ from: q.from, to: q.to, clientId: q.clientId, status: q.status, q: q.q });
const safe = (s) => String(s).replace(/[^\w.-]+/g, '-');

router.get('/deliveries', wrap((req, res) => {
  // « unlinked » : commandes sans fiche hôtel (nom saisi librement), pour proposer le regroupement.
  res.json({ ...deliveries.listDeliveries(filtersOf(req.query)), unlinked: unlinked.count() });
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

// BL sans fiche hôtel (nom saisi librement) : groupes + hôtels proposés, puis rattachement.
router.get('/deliveries/unlinked', wrap((req, res) => {
  res.json({ ...unlinked.listGroups(), count: unlinked.count() });
}));

router.post('/deliveries/unlinked/link',
  (req, res, next) => (req.body && req.body.apply ? lock.requireStepUp('orders-link')(req, res, next) : next()),
  wrap((req, res) => {
    const { items, apply, reprice } = req.body || {};
    res.json(unlinked.link(items, { apply: !!apply, reprice: !!reprice }));
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
