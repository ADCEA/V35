// Prélèvements SEPA — /api/admin/billing/sdd/*. Montées par routes/billing.js APRÈS le verrou de la Facturation.
// Aucune règle métier ici (voir billing/sdd.js) : validation d'entrée, ressaisie du code pour les actes sensibles, réponses.
//
// Actes sensibles (ressaisie du code, à usage unique) : changer l'ICS, créer/révoquer un mandat, préparer un lot,
// télécharger le fichier (il contient les IBAN), annuler ou clôturer un lot (la clôture enregistre des règlements).

const express = require('express');
const sdd = require('../billing/sdd');
const lock = require('../billing/lock');
const { buildMandateFormPdf } = require('../billing/sddPdf');
const { wrap } = require('../billing/http');

const router = express.Router();
const idOf = (req) => Number(req.params.id);

router.get('/sdd/overview', wrap((req, res) => { res.json(sdd.overview()); }));

router.put('/sdd/creditor', lock.requireStepUp('sdd-settings'), wrap((req, res) => {
  const { ics, noticeDays } = req.body || {};
  res.json({ creditor: sdd.setCreditor({ ics, noticeDays }) });
}));

// ---------- mandats ----------

router.get('/sdd/mandates', wrap((req, res) => {
  res.json({ mandates: sdd.listMandates({ status: req.query.status, clientId: req.query.clientId }) });
}));

router.get('/sdd/mandates/suggest', wrap((req, res) => {
  res.json({ umr: sdd.suggestUmr(req.query.clientId) });
}));

router.post('/sdd/mandates', lock.requireStepUp('sdd-mandate'), wrap((req, res) => {
  res.status(201).json({ mandate: sdd.createMandate(req.body) });
}));

router.post('/sdd/mandates/:id/revoke', lock.requireStepUp('sdd-mandate'), wrap((req, res) => {
  res.json({ mandate: sdd.revokeMandate(idOf(req), req.body) });
}));

function sendPdf(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
}

// Formulaire vierge à faire signer (référence proposée pour l'hôtel).
router.get('/sdd/mandate-form', wrap(async (req, res) => {
  const data = sdd.formData({ clientId: req.query.clientId, scheme: req.query.scheme, umr: req.query.umr });
  sendPdf(res, await buildMandateFormPdf(data), `mandat-sepa-${data.umr}.pdf`);
}));

// Copie d'un mandat enregistré : elle porte l'IBAN, donc ressaisie du code.
router.get('/sdd/mandates/:id/pdf', lock.requireStepUp((req) => `sdd-copy:${req.params.id}`), wrap(async (req, res) => {
  const data = sdd.formData({ mandateId: idOf(req) });
  sendPdf(res, await buildMandateFormPdf(data), `mandat-sepa-${data.umr}.pdf`);
}));

// ---------- lots ----------

router.get('/sdd/candidates', wrap((req, res) => {
  res.json(sdd.candidates({ collectionDate: req.query.collectionDate }));
}));

router.post('/sdd/batches/preview', wrap((req, res) => {
  const { invoiceIds, collectionDate } = req.body || {};
  res.json(sdd.preview({ invoiceIds, collectionDate }));
}));

router.post('/sdd/batches', lock.requireStepUp('sdd-batch'), wrap((req, res) => {
  const { invoiceIds, collectionDate } = req.body || {};
  res.status(201).json({ batch: sdd.createBatch({ invoiceIds, collectionDate }) });
}));

router.get('/sdd/batches', wrap((req, res) => { res.json({ batches: sdd.listBatches() }); }));

router.get('/sdd/batches/:id', wrap((req, res) => { res.json({ batch: sdd.getBatch(idOf(req)) }); }));

router.get('/sdd/batches/:id/file', lock.requireStepUp((req) => `sdd-file:${req.params.id}`), wrap((req, res) => {
  const { xml, filename } = sdd.batchXml(idOf(req));
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(xml);
}));

router.post('/sdd/batches/:id/sent', wrap((req, res) => { res.json({ batch: sdd.markSent(idOf(req)) }); }));

router.post('/sdd/batches/:id/cancel', lock.requireStepUp((req) => `sdd-cancel:${req.params.id}`), wrap((req, res) => {
  res.json({ batch: sdd.cancelBatch(idOf(req), req.body) });
}));

router.post('/sdd/batches/:id/settle', lock.requireStepUp((req) => `sdd-settle:${req.params.id}`), wrap((req, res) => {
  res.json(sdd.settle(idOf(req), req.body));
}));

module.exports = router;
