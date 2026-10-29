// Ventes jour par jour (montants) — montées par routes/billing.js APRÈS le verrou de la Facturation.
// Lecture seule. L'écran Statistiques fusionne ces montants avec les chiffres d'exploitation (utils/dailyStats.js).

const express = require('express');
const daily = require('../billing/daily');
const { wrap } = require('../billing/http');

const router = express.Router();

router.get('/stats/daily', wrap((req, res) => {
  res.json(daily.daily(req.query.from, req.query.to));
}));

// Prix unitaire moyen par article sur la période (page Statistiques, bloc « Articles les plus commandés »).
router.get('/stats/articles', wrap((req, res) => {
  res.json(daily.articlePrices(req.query.from, req.query.to));
}));

router.get('/stats/daily/:date', wrap((req, res) => {
  res.json(daily.dayDetail(req.params.date));
}));

module.exports = router;
