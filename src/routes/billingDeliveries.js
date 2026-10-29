// Routes « bons de livraison » de la facturation : liste filtrée par date et par hôtel, détail, PDF, exports,
// correction des quantités livrées (tant que le bon n'est pas facturé) et regroupement des BL dont le nom d'hôtel a été saisi librement.
// Montées par routes/billing.js APRÈS le verrou : la Facturation doit être déverrouillée.
// Le rattachement des BL à une fiche hôtel exige la ressaisie du code (après un aperçu libre) ; la correction des quantités livrées est journalisée.

const express = require('express');
const engine = require('../billing/engine');
const deliveries = require('../billing/deliveries');
const deliveredQty = require('../billing/deliveredQty');
const unlinked = require('../billing/unlinked');
const lock = require('../billing/lock');
const { buildDeliveryNotePdf } = require('../utils/pdf');
const { mergePdfs } = require('../utils/pdfMerge');
const mail = require('../billing/mail');
const db = require('../db');
const { wrap } = require('../billing/http');

const router = express.Router();
const filtersOf = (q) => ({ from: q.from, to: q.to, clientId: q.clientId, status: q.status, payment: q.payment, q: q.q });
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

// Correction des quantités livrées d'un BL pas encore facturé : la facture suit ces quantités (refus 409 si le bon
// figure déjà dans une facture ou un brouillon). Chaque correction est inscrite au journal de facturation.
router.put('/deliveries/:id/quantities', wrap((req, res) => {
  const id = parseInt(req.params.id, 10);
  deliveries.getDelivery(id);   // 404 si la commande n'est pas livrée
  const changes = deliveredQty.setDelivered(id, (req.body || {}).items);
  const { order, items, ...d } = deliveries.getDelivery(id);
  res.json({ delivery: d, changes });
}));

// Envoi d'un bon par Outlook, PDF joint : même fenêtre d'envoi que les factures (destinataire = e-mail de l'hôtel).
router.get('/deliveries/:id/mail-preview', wrap((req, res) => {
  const d = deliveries.getDelivery(parseInt(req.params.id, 10));
  const client = d.client.id ? db.prepare('SELECT email FROM clients WHERE id = ?').get(d.client.id) : null;
  res.json({ ...mail.renderDeliveryNote(d.order), to: (client && client.email) || '', smtp: false, outlook: mail.outlookState() });
}));

router.post('/deliveries/:id/send', wrap(async (req, res) => {
  const d = deliveries.getDelivery(parseInt(req.params.id, 10));   // 404 si la commande n'est pas livrée
  const r = await mail.sendDeliveryNote(d.id, req.body || {});
  res.json({ ok: true, to: r.to, outlook: !!r.outlook, draft: !!r.draft, webLink: r.webLink || null, draftError: r.draftError || null, file: !!r.file, eml: r.eml || null, emlName: r.emlName || null });
}));

router.get('/deliveries/:id/pdf', wrap(async (req, res) => {
  const d = deliveries.getDelivery(parseInt(req.params.id, 10));
  const pdf = await buildDeliveryNotePdf({ ...d.order, items: d.items });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="bon-livraison-${safe(d.ticket)}.pdf"` });
  res.send(pdf);
}));

module.exports = router;
