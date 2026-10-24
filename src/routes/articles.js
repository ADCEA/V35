// Réglages de logistique : capacité du camion, poids des chariots, types de chariots et de camions.
//
// Le CATALOGUE d'articles (création, modification, prix, import) et les tarifs par client ont été
// déplacés dans la partie protégée : voir routes/billingCatalog.js (/api/admin/billing/catalog/*).

const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// ---------- capacité camion + poids chariot (réglages simples) ----------

// GET /api/admin/articles/logistics-settings
router.get('/logistics-settings', (req, res) => {
  const row = db.prepare('SELECT truck_capacity_kg as truckCapacityKg, cart_weight_kg as cartWeightKg, avg_speed_kmh as avgSpeedKmh, minutes_per_stop as minutesPerStop, max_cart_weight_kg as maxCartWeightKg, prioritize_grouping as prioritizeGrouping FROM admin WHERE id = 1').get();
  res.json(row || { truckCapacityKg: 1200, cartWeightKg: 20, avgSpeedKmh: 40, minutesPerStop: 20, maxCartWeightKg: 120, prioritizeGrouping: 1 });
});

// PUT /api/admin/articles/logistics-settings
router.put('/logistics-settings', (req, res) => {
  const { truckCapacityKg, cartWeightKg, avgSpeedKmh, minutesPerStop, maxCartWeightKg, prioritizeGrouping } = req.body || {};
  const truck = parseFloat(truckCapacityKg);
  const cartWeight = parseFloat(cartWeightKg);
  const avgSpeed = parseFloat(avgSpeedKmh);
  const perStop = parseFloat(minutesPerStop);
  const maxCartWeight = parseFloat(maxCartWeightKg);
  if (!Number.isFinite(truck) || truck <= 0) return res.status(400).json({ error: 'Capacité de camion invalide.' });
  if (!Number.isFinite(cartWeight) || cartWeight < 0) return res.status(400).json({ error: 'Poids de chariot invalide.' });
  if (!Number.isFinite(avgSpeed) || avgSpeed <= 0) return res.status(400).json({ error: 'Vitesse moyenne invalide.' });
  if (!Number.isFinite(perStop) || perStop < 0) return res.status(400).json({ error: 'Temps par arrêt invalide.' });
  if (!Number.isFinite(maxCartWeight) || maxCartWeight <= 0) return res.status(400).json({ error: 'Poids maximum par chariot invalide.' });
  db.prepare('UPDATE admin SET truck_capacity_kg = ?, cart_weight_kg = ?, avg_speed_kmh = ?, minutes_per_stop = ?, max_cart_weight_kg = ?, prioritize_grouping = ? WHERE id = 1')
    .run(truck, cartWeight, avgSpeed, perStop, maxCartWeight, prioritizeGrouping ? 1 : 0);
  res.json({ ok: true });
});

// ---------- types de chariots ----------

function serializeCartType(row) {
  return {
    id: row.id,
    name: row.name,
    lengthCm: row.length_cm,
    widthCm: row.width_cm,
    heightCm: row.height_cm,
    volumeL: Math.round((row.length_cm * row.width_cm * row.height_cm / 1000) * 10) / 10,
  };
}

// GET /api/admin/articles/cart-types
router.get('/cart-types', (req, res) => {
  const rows = db.prepare('SELECT * FROM cart_types ORDER BY length_cm * width_cm * height_cm DESC').all();
  res.json({ cartTypes: rows.map(serializeCartType) });
});

// POST /api/admin/articles/cart-types
router.post('/cart-types', (req, res) => {
  const { name, lengthCm, widthCm, heightCm } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du chariot est requis.' });
  const l = parseFloat(lengthCm), w = parseFloat(widthCm), h = parseFloat(heightCm);
  if (![l, w, h].every(n => Number.isFinite(n) && n > 0)) {
    return res.status(400).json({ error: 'Longueur, largeur et hauteur doivent être des nombres positifs (en cm).' });
  }
  const info = db.prepare('INSERT INTO cart_types (name, length_cm, width_cm, height_cm) VALUES (?, ?, ?, ?)').run(name.trim(), l, w, h);
  const row = db.prepare('SELECT * FROM cart_types WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ cartType: serializeCartType(row) });
});

// DELETE /api/admin/articles/cart-types/:id
router.delete('/cart-types/:id', (req, res) => {
  db.prepare('DELETE FROM cart_types WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- types de camions ----------

function serializeTruckType(row) {
  return {
    id: row.id,
    name: row.name,
    lengthCm: row.length_cm,
    widthCm: row.width_cm,
    heightCm: row.height_cm,
    volumeL: Math.round((row.length_cm * row.width_cm * row.height_cm / 1000) * 10) / 10,
  };
}

// GET /api/admin/articles/truck-types
router.get('/truck-types', (req, res) => {
  const rows = db.prepare('SELECT * FROM truck_types ORDER BY length_cm * width_cm * height_cm DESC').all();
  res.json({ truckTypes: rows.map(serializeTruckType) });
});

// POST /api/admin/articles/truck-types
router.post('/truck-types', (req, res) => {
  const { name, lengthCm, widthCm, heightCm } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du véhicule est requis.' });
  const l = parseFloat(lengthCm), w = parseFloat(widthCm), h = parseFloat(heightCm);
  if (![l, w, h].every(n => Number.isFinite(n) && n > 0)) {
    return res.status(400).json({ error: 'Longueur, largeur et hauteur doivent être des nombres positifs (en cm).' });
  }
  const info = db.prepare('INSERT INTO truck_types (name, length_cm, width_cm, height_cm) VALUES (?, ?, ?, ?)').run(name.trim(), l, w, h);
  const row = db.prepare('SELECT * FROM truck_types WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ truckType: serializeTruckType(row) });
});

// DELETE /api/admin/articles/truck-types/:id
router.delete('/truck-types/:id', (req, res) => {
  db.prepare('DELETE FROM truck_types WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
