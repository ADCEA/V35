const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { answerBusinessQuestion } = require('../utils/aiAgent');

const router = express.Router();
router.use(requireAdmin);

// GET /api/admin/stats?from=AAAA-MM-JJ&to=AAAA-MM-JJ — vue d'ensemble de l'activité sur la période demandée
// (la même que celle du tableau jour par jour : au plus 400 jours). Sans dates : toute l'activité depuis le début.
//  - commandes, articles, statuts, top hôtels et top articles : commandes REÇUES dans la période (date de création, heure de Paris) ;
//  - commandes livrées, poids et kilomètres : commandes LIVRÉES dans la période (même date que les bons de livraison).
const dailyStats = require('../utils/dailyStats');
const dailyFail = (res, e) => (e && e.name === 'StatsError' ? res.status(e.status).json({ error: e.message }) : (console.error('[stats]', e), res.status(500).json({ error: 'Erreur serveur.' })));

function overview(p) {
  // Commandes reçues dans la période (voir dailyStats.receivedIds).
  let received = '1=1'; const rArgs = [];
  if (p) {
    received = 'o.id IN (SELECT value FROM json_each(?))'; rArgs.push(JSON.stringify(dailyStats.receivedIds(p)));
  }
  const delivered = p ? `o.status = 'livree' AND ${dailyStats.DELIVERY_DATE_SQL} BETWEEN ? AND ?` : "o.status = 'livree'";
  const dArgs = p ? [p.from, p.to] : [];

  const totalOrders = db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${received}`).get(...rArgs).n;
  const byStatus = Object.fromEntries(db.prepare(`SELECT o.status, COUNT(*) AS n FROM orders o WHERE ${received} GROUP BY o.status`).all(...rArgs).map(r => [r.status, r.n]));
  const activeHotels = db.prepare(`SELECT COUNT(DISTINCT o.societe) AS n FROM orders o WHERE ${received}`).get(...rArgs).n;
  const topHotels = db.prepare(`
    SELECT o.societe AS societe, COUNT(DISTINCT o.id) AS orderCount, SUM(oi.qty) AS itemCount
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE ${received}
    GROUP BY o.societe ORDER BY orderCount DESC, o.societe LIMIT 10
  `).all(...rArgs);
  const topArticles = db.prepare(`
    SELECT oi.name AS name, oi.code AS code, SUM(oi.qty) AS totalQty
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE ${received}
    GROUP BY oi.name, oi.code ORDER BY totalQty DESC, oi.name LIMIT 10
  `).all(...rArgs);
  // Volume total des articles (pièces) = somme des quantités nettes des articles dont le net est positif : les parts du
  // top 10 se lisent donc par rapport à l'ensemble des articles de la période (les reprises ne gonflent pas le total).
  const articlesTotalQty = db.prepare(`
    SELECT SUM(t) AS n FROM (
      SELECT SUM(oi.qty) AS t FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${received} GROUP BY oi.name, oi.code
    ) WHERE t > 0
  `).get(...rArgs).n || 0;
  const totalItems = db.prepare(`SELECT SUM(oi.qty) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${received}`).get(...rArgs).n || 0;

  const deliveredOrders = db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${delivered}`).get(...dArgs).n;
  // Poids réellement livré, linge seul (hors poids des chariots qui le transportent — voir Logistique).
  const deliveredWeightKg = db.prepare(`
    SELECT SUM(COALESCE(oi.delivered_qty, oi.qty) * a.weight_g) / 1000.0 AS kg
    FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN articles a ON a.id = oi.service_id
    WHERE ${delivered}
  `).get(...dArgs).kg || 0;
  // Kilomètres cumulés sur les commandes livrées, tels que calculés lors des optimisations de tournée.
  const totalDistanceKm = db.prepare(`SELECT SUM(o.distance_from_prev_km) AS km FROM orders o WHERE ${delivered}`).get(...dArgs).km || 0;
  const last30Days = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at >= datetime('now', '-30 days')").get().n;

  return {
    period: p ? { from: p.from, to: p.to, days: p.days } : null,
    totalOrders, totalItems, articlesTotalQty, deliveredOrders, activeHotels, last30Days, byStatus, topHotels, topArticles,
    deliveredWeightKg: Math.round(deliveredWeightKg * 10) / 10,
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
  };
}

router.get('/', (req, res) => {
  try {
    const p = (req.query.from || req.query.to) ? dailyStats.period(req.query.from, req.query.to) : null;
    res.json(overview(p));
  } catch (e) { dailyFail(res, e); }
});

// GET /api/admin/stats/daily?from=AAAA-MM-JJ&to=AAAA-MM-JJ — exploitation jour par jour (sans montants :
// ceux-ci sont dans /api/admin/billing/stats/daily, derrière le verrou de la Facturation).
router.get('/daily', (req, res) => {
  try { res.json(dailyStats.daily(req.query.from, req.query.to)); } catch (e) { dailyFail(res, e); }
});
router.get('/daily/:date', (req, res) => {
  try { res.json(dailyStats.dayDetail(req.params.date)); } catch (e) { dailyFail(res, e); }
});

// GET /api/admin/stats/nps?from=…&to=… — NPS (promoteurs 9-10, passifs 7-8, détracteurs 0-6 ; NPS = % promoteurs −
// % détracteurs, de -100 à +100). Avec des dates : réponses de la période, d'abord en une seule valeur (`period`), puis
// mois par mois. Sans dates : les 12 derniers mois. Un mois sans réponse n'apparaît simplement pas.
const npsOf = (r) => ({
  responses: r.responses, promoters: r.promoters || 0, passives: r.passives || 0, detractors: r.detractors || 0,
  nps: r.responses ? Math.round((((r.promoters || 0) / r.responses) - ((r.detractors || 0) / r.responses)) * 100) : 0,
});
const NPS_COLS = `COUNT(*) AS responses,
  SUM(CASE WHEN score >= 9 THEN 1 ELSE 0 END) AS promoters,
  SUM(CASE WHEN score BETWEEN 7 AND 8 THEN 1 ELSE 0 END) AS passives,
  SUM(CASE WHEN score <= 6 THEN 1 ELSE 0 END) AS detractors`;
router.get('/nps', (req, res) => {
  let p = null;
  try { if (req.query.from || req.query.to) p = dailyStats.period(req.query.from, req.query.to); } catch (e) { return dailyFail(res, e); }
  const where = p ? 'WHERE substr(created_at, 1, 10) BETWEEN ? AND ?' : '';
  const args = p ? [p.from, p.to] : [];

  const months = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, ${NPS_COLS}
    FROM nps_responses ${where} GROUP BY month ORDER BY month DESC LIMIT 24
  `).all(...args).map(r => ({ month: r.month, ...npsOf(r) }));

  const recentComments = db.prepare(`
    SELECT n.score, n.comment, n.created_at AS createdAt, c.societe
    FROM nps_responses n JOIN clients c ON c.id = n.client_id
    WHERE n.comment IS NOT NULL AND n.comment != '' ${p ? 'AND substr(n.created_at, 1, 10) BETWEEN ? AND ?' : ''}
    ORDER BY n.created_at DESC LIMIT 15
  `).all(...args);

  const agg = p ? db.prepare(`SELECT ${NPS_COLS} FROM nps_responses ${where}`).get(...args) : null;
  res.json({
    months, currentMonth: months[0] || null, recentComments,
    period: p ? { from: p.from, to: p.to, ...(agg && agg.responses ? npsOf(agg) : { responses: 0, promoters: 0, passives: 0, detractors: 0, nps: null }) } : null,
  });
});

// POST /api/admin/stats/ai-report — pose une question en langage naturel
// sur les données de l'entreprise ; l'agent interroge la base en lecture
// SEULE (voir utils/aiAgent.js) pour répondre avec de vrais chiffres.
router.post('/ai-report', async (req, res) => {
  const { question } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question manquante.' });
  }
  try {
    const answer = await answerBusinessQuestion(question.trim());
    res.json({ answer });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
