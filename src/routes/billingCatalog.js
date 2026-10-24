// Routes « catalogue et tarifs » de la facturation : articles, fiches clients, tarifs par client.
// Montées par routes/billing.js APRÈS le verrou : tout ce qui est ici exige la Facturation
// déverrouillée. Les actes en masse ou irréversibles exigent en plus la ressaisie du code.

const express = require('express');
const engine = require('../billing/engine');
const catalog = require('../billing/catalog');
const lock = require('../billing/lock');
const { wrap } = require('../billing/http');

const router = express.Router();
const iso = (s) => (engine.isIsoDate(s) ? s : undefined);
const clientId = (req) => parseInt(req.params.id, 10);
const csvOf = (body) => {
  const csv = (body || {}).csv;
  if (typeof csv !== 'string' || !csv.trim()) throw new engine.BillingError('Fichier absent ou vide.');
  if (csv.length > 3_000_000) throw new engine.BillingError('Fichier trop volumineux (3 Mo maximum).');
  return csv;
};
// Ressaisie du code seulement quand l'opération écrit vraiment (l'aperçu reste libre).
const stepUpWhen = (pred, scopeOf) => (req, res, next) => (pred(req) ? lock.requireStepUp(scopeOf)(req, res, next) : next());
const applying = (req) => !!(req.body && req.body.apply);

// ---------- articles ----------

router.get('/catalog/articles', wrap((req, res) => res.json(catalog.listArticles())));
router.get('/catalog/articles/:id', wrap((req, res) => res.json({ article: catalog.getArticle(req.params.id) })));
router.post('/catalog/articles', wrap((req, res) => res.status(201).json({ article: catalog.createArticle(req.body) })));
router.put('/catalog/articles/:id', wrap((req, res) => res.json({ article: catalog.updateArticle(req.params.id, req.body) })));
router.delete('/catalog/articles/:id', lock.requireStepUp(req => `article-delete:${req.params.id}`),
  wrap((req, res) => res.json(catalog.deleteArticle(req.params.id))));
router.post('/catalog/articles/import', stepUpWhen(applying, 'articles-import'),
  wrap((req, res) => res.json(catalog.importArticles(csvOf(req.body), { apply: applying(req) }))));

// ---------- tarifs : grille, import, journal ----------

router.get('/catalog/prices/matrix', wrap((req, res) => res.json(catalog.priceMatrix())));
router.get('/catalog/prices/export.csv', wrap((req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="grille-tarifaire.csv"' });
  res.send(catalog.matrixCsv());
}));
router.post('/catalog/prices/import', stepUpWhen(applying, 'prices-import'), wrap((req, res) => {
  const b = req.body || {};
  res.json(catalog.importPrices(csvOf(b), { apply: applying(req), clientId: b.clientId ? Number(b.clientId) : null, defaultDate: iso(b.defaultDate) }));
}));
router.get('/catalog/prices/log', wrap((req, res) => {
  res.json(catalog.priceLog({ clientId: req.query.clientId ? Number(req.query.clientId) : undefined, articleId: req.query.articleId ? String(req.query.articleId) : undefined }));
}));

// ---------- hôtels ----------

router.get('/catalog/clients', wrap((req, res) => res.json(catalog.listClients())));
router.post('/catalog/clients/import', stepUpWhen(applying, 'clients-import'),
  wrap((req, res) => res.json(catalog.importClients(csvOf(req.body), { apply: applying(req) }))));
router.post('/catalog/clients', wrap((req, res) => res.status(201).json(catalog.createClient(req.body))));
router.get('/catalog/clients/:id', wrap((req, res) => res.json(catalog.getClient(clientId(req)))));
router.put('/catalog/clients/:id', wrap((req, res) => res.json(catalog.updateClient(clientId(req), req.body))));
router.delete('/catalog/clients/:id', lock.requireStepUp(req => `client-delete:${req.params.id}`),
  wrap((req, res) => res.json(catalog.deleteClient(clientId(req)))));
router.put('/catalog/clients/:id/access-code', lock.requireStepUp(req => `client-code:${req.params.id}`),
  wrap((req, res) => res.json(catalog.setAccessCode(clientId(req), (req.body || {}).code))));

// intégration de l'hôtel : jetons d'API et webhook
router.post('/catalog/clients/:id/tokens', wrap((req, res) => res.status(201).json({ token: catalog.createToken(clientId(req), (req.body || {}).label) })));
router.delete('/catalog/clients/:id/tokens/:tokenId', wrap((req, res) => res.json(catalog.revokeToken(clientId(req), parseInt(req.params.tokenId, 10)))));
router.put('/catalog/clients/:id/webhook',
  stepUpWhen(req => !!(req.body && req.body.regenerateSecret), req => `client-webhook:${req.params.id}`),
  wrap((req, res) => res.json(catalog.setWebhook(clientId(req), req.body || {}))));

// ---------- tarifs d'un hôtel ----------

router.put('/catalog/clients/:id/assignment', wrap((req, res) => res.json(catalog.setAssignment(clientId(req), (req.body || {}).articleIds))));
router.get('/catalog/clients/:id/prices', wrap((req, res) => res.json(catalog.priceGrid(clientId(req)))));
router.put('/catalog/clients/:id/prices/:articleId', wrap((req, res) => {
  const b = req.body || {};
  res.json(catalog.setClientPrice(clientId(req), req.params.articleId, b.price, b.dateDebut));
}));
router.delete('/catalog/clients/:id/prices/:articleId', wrap((req, res) => {
  res.json(catalog.removeClientPrice(clientId(req), req.params.articleId, iso(req.query.from)));
}));
router.post('/catalog/clients/:id/prices/bulk', stepUpWhen(applying, req => `prices-bulk:${req.params.id}`),
  wrap((req, res) => res.json(catalog.bulkPrices(clientId(req), req.body, { apply: applying(req) }))));
router.post('/catalog/clients/:id/reprice', stepUpWhen(applying, req => `reprice:${req.params.id}`), wrap((req, res) => {
  const b = req.body || {};
  res.json(catalog.repriceUnbilled(clientId(req), { from: iso(b.from), articleIds: b.articleIds }, { apply: applying(req) }));
}));

module.exports = router;
