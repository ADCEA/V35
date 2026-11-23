const express = require('express');
const db = require('../db');
const { getDailyWeather } = require('../utils/weather');
const { geocodeAddress } = require('../utils/geocode');
const { buildDeliveryNotePdf } = require('../utils/pdf');
const security = require('../middleware/security');
const { markDelivered, parisDay, cleanCoords } = require('../utils/orderDelivery');

const router = express.Router();

// Conseils de conduite génériques, affichés dans le portail livreur.
// Statiques et volontairement courts — un rappel utile, pas un pavé
// réglementaire que personne ne lira.
const SAFETY_TIPS = [
  'Vérifiez l\'arrimage du chargement avant de démarrer.',
  'Téléphone en mode conduite, jamais en main.',
  'Adaptez votre vitesse à la charge transportée — un chariot plein allonge la distance de freinage.',
  'Pause recommandée toutes les 2 heures de conduite.',
  'Vérifiez vos angles morts avant chaque manœuvre, chargement chargé réduit la visibilité arrière.',
];

// GET /api/driver-portal/:token — pas de requireAdmin ici : l'accès se
// fait uniquement via la possession du jeton personnel du chauffeur
// (lien à usage interne, pas indexé, pas de données sensibles exposées
// au-delà de ce que le chauffeur a besoin de voir pour sa tournée).
router.get('/:token', async (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE access_token = ?').get(req.params.token);
  if (!driver) return res.status(404).json({ error: 'Lien invalide ou expiré.' });

  const orders = db.prepare(`
    SELECT * FROM orders WHERE driver_id = ? AND status = 'prete' ORDER BY delivery_sequence ASC, created_at ASC
  `).all(driver.id);

  const itemsStmt = db.prepare('SELECT name, qty FROM order_items WHERE order_id = ?');
  const stops = orders.map(o => ({
    orderId: o.id,
    ticket: o.ticket,
    societe: o.societe,
    adresse: o.adresse,
    tel: o.tel,
    sequence: o.delivery_sequence,
    distanceFromPrevKm: o.distance_from_prev_km,
    items: itemsStmt.all(o.id),
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.adresse)}`,
    deliveryNoteUrl: `/api/driver-portal/${req.params.token}/orders/${o.id}/delivery-note.pdf`,
  }));

  // Résumé de la tournée : distance cumulée (depuis le dépôt jusqu'au
  // dernier arrêt) et durée estimée = temps de conduite (distance /
  // vitesse moyenne) + un forfait fixe par arrêt (stationnement, portage,
  // remise du linge...). Absent si la tournée n'a jamais été optimisée
  // (distances jamais calculées) — on ne veut pas afficher un temps basé
  // sur des données inexistantes.
  const { avg_speed_kmh: avgSpeedKmh, minutes_per_stop: minutesPerStop } =
    db.prepare('SELECT avg_speed_kmh, minutes_per_stop FROM admin WHERE id = 1').get() || { avg_speed_kmh: 40, minutes_per_stop: 20 };
  const hasDistances = stops.length > 0 && stops.every(s => s.distanceFromPrevKm != null);
  let routeSummary = null;
  if (hasDistances) {
    const totalDistanceKm = stops.reduce((sum, s) => sum + s.distanceFromPrevKm, 0);
    const drivingMinutes = (totalDistanceKm / avgSpeedKmh) * 60;
    const stopsMinutes = stops.length * minutesPerStop;
    routeSummary = {
      totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
      estimatedMinutes: Math.round(drivingMinutes + stopsMinutes),
      drivingMinutes: Math.round(drivingMinutes),
      stopsMinutes: Math.round(stopsMinutes),
    };
  }

  // Météo du jour, sur la base du dépôt (approximation raisonnable pour
  // une tournée locale) — best-effort : une erreur ici n'empêche jamais
  // d'afficher la tournée elle-même.
  let weather = null;
  try {
    const admin = db.prepare('SELECT depot_address, depot_lat, depot_lng FROM admin WHERE id = 1').get();
    let { depot_lat: lat, depot_lng: lng } = admin || {};
    if ((lat == null || lng == null) && admin?.depot_address) {
      const coords = await geocodeAddress(admin.depot_address);
      if (coords) {
        lat = coords.lat; lng = coords.lng;
        db.prepare('UPDATE admin SET depot_lat = ?, depot_lng = ? WHERE id = 1').run(lat, lng);
      }
    }
    if (lat != null && lng != null) weather = await getDailyWeather(lat, lng);
  } catch (err) {
    weather = null;
  }

  // Livraisons déjà validées aujourd'hui (jour de Paris), dans l'ordre où elles ont été faites, avec le temps écoulé depuis
  // la précédente. Elles quittent la liste des arrêts restants mais restent visibles pour le livreur.
  const today = parisDay();
  const doneRows = db.prepare(`
    SELECT * FROM orders WHERE driver_id = ? AND status = 'livree' AND delivered_at IS NOT NULL AND delivered_at >= ?
    ORDER BY delivered_at ASC
  `).all(driver.id, new Date(Date.now() - 36 * 3600 * 1000).toISOString()).filter(o => parisDay(o.delivered_at) === today);
  const deliveredToday = doneRows.map((o, i) => ({
    orderId: o.id,
    ticket: o.ticket,
    societe: o.societe,
    adresse: o.adresse,
    deliveredAt: o.delivered_at,
    minutesSincePrev: i === 0 ? null : Math.round((Date.parse(o.delivered_at) - Date.parse(doneRows[i - 1].delivered_at)) / 60000),
    deliveryNoteUrl: `/api/driver-portal/${req.params.token}/orders/${o.id}/delivery-note.pdf`,
  }));

  res.json({
    driverName: driver.name,
    vehicle: driver.vehicle,
    date: new Date().toISOString().slice(0, 10),
    stops,
    deliveredToday,
    weather,
    safetyTips: SAFETY_TIPS,
    routeSummary,
  });
});

// GET /api/driver-portal/:token/orders/:orderId/delivery-note.pdf — sert
// le bon de livraison en PDF pour un arrêt de CE chauffeur uniquement
// (vérifié via driver_id, pas seulement via le numéro de commande) —
// utile sur place, pour montrer ou laisser le bon au client.
router.get('/:token/orders/:orderId/delivery-note.pdf', async (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE access_token = ?').get(req.params.token);
  if (!driver) return res.status(404).json({ error: 'Lien invalide ou expiré.' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND driver_id = ?').get(Number(req.params.orderId), driver.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable pour ce chauffeur.' });

  const items = db.prepare('SELECT service_id as id, name, code, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?').all(order.id);

  try {
    const pdfBuffer = await buildDeliveryNotePdf({ ...order, items });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bon-livraison-${order.ticket}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Échec génération BL portail livreur :', err.message);
    res.status(500).json({ error: 'Erreur de génération du bon de livraison.' });
  }
});

// POST /api/driver-portal/:token/orders/:orderId/comment — le chauffeur
// laisse un message sur une commande (info client, absence, remarque...),
// dans le même fil de discussion que l'équipe de production. L'auteur
// est automatiquement le nom du chauffeur, pas de saisie supplémentaire.
router.post('/:token/orders/:orderId/comment', (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE access_token = ?').get(req.params.token);
  if (!driver) return res.status(404).json({ error: 'Lien invalide ou expiré.' });

  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND driver_id = ?').get(Number(req.params.orderId), driver.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable pour ce chauffeur.' });

  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Le message ne peut pas être vide.' });

  db.prepare('INSERT INTO order_comments (order_id, author, text) VALUES (?, ?, ?)')
    .run(order.id, `${driver.name} (livreur)`, text.trim());
  res.status(201).json({ ok: true });
});

// ---------- validation d'une livraison et position du livreur ----------

const clearPosition = db.prepare('UPDATE drivers SET last_lat = NULL, last_lng = NULL, last_accuracy_m = NULL, last_position_at = NULL WHERE id = ?');
const savePosition = db.prepare('UPDATE drivers SET last_lat = ?, last_lng = ?, last_accuracy_m = ?, last_position_at = ? WHERE id = ?');
const accuracyOf = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n) : null; };

// POST /api/driver-portal/:token/orders/:orderId/deliver — le livreur valide la livraison d'un arrêt. L'heure est celle du
// serveur (rien n'est antidaté). Si le livreur partage sa position, le point de validation est conservé avec la livraison.
// Idempotent : un second appui ne change ni l'heure ni les notifications. body: { lat?, lng?, accuracy? }
router.post('/:token/orders/:orderId/deliver', (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE access_token = ?').get(req.params.token);
  if (!driver) return res.status(404).json({ error: 'Lien invalide ou expiré.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND driver_id = ?').get(Number(req.params.orderId), driver.id);
  if (!order) return res.status(404).json({ error: 'Commande introuvable pour ce chauffeur.' });
  if (order.status !== 'prete' && order.status !== 'livree') {
    return res.status(409).json({ error: "Cette commande n'est pas encore prête : elle ne peut pas être validée." });
  }

  const { lat, lng, accuracy } = req.body || {};
  const where = cleanCoords(lat, lng);
  const { order: done, already } = markDelivered(order, { lat, lng });
  if (where && !already) savePosition.run(where.lat, where.lng, accuracyOf(accuracy), new Date().toISOString(), driver.id);

  // Dernière livraison de la tournée : le partage de position s'arrête de lui-même, rien n'est conservé.
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE driver_id = ? AND status = 'prete'").get(driver.id).n;
  if (remaining === 0) clearPosition.run(driver.id);
  res.json({ ok: true, already, deliveredAt: done.delivered_at, remaining });
});

// POST /api/driver-portal/:token/position — position envoyée par le téléphone du livreur, UNIQUEMENT s'il a lancé le partage
// sur sa page. Une seule position est conservée (la dernière) ; aucun historique.  body: { lat, lng, accuracy? }
const positionLimit = security.rateLimit({ name: 'driver-position', windowMs: 60 * 1000, max: 40, key: (req) => `dp:${req.params.token}`, message: 'Trop de positions envoyées.' });
router.post('/:token/position', positionLimit, (req, res) => {
  const driver = db.prepare('SELECT * FROM drivers WHERE access_token = ?').get(req.params.token);
  if (!driver) return res.status(404).json({ error: 'Lien invalide ou expiré.' });
  const where = cleanCoords((req.body || {}).lat, (req.body || {}).lng);
  if (!where) return res.status(400).json({ error: 'Position invalide.' });
  if (driver.last_position_at && Date.now() - Date.parse(driver.last_position_at) < 4000) return res.json({ ok: true, skipped: true });
  savePosition.run(where.lat, where.lng, accuracyOf((req.body || {}).accuracy), new Date().toISOString(), driver.id);
  res.json({ ok: true });
});

// POST /api/driver-portal/:token/position/stop — le livreur arrête le partage : la position est effacée.
router.post('/:token/position/stop', positionLimit, (req, res) => {
  const driver = db.prepare('SELECT id FROM drivers WHERE access_token = ?').get(req.params.token);
  if (!driver) return res.status(404).json({ error: 'Lien invalide ou expiré.' });
  clearPosition.run(driver.id);
  res.json({ ok: true });
});

module.exports = router;
