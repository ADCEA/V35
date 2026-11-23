// Trafic en temps réel (administration seulement). Aucune de ces routes ne renvoie ni n'utilise de clé : le serveur parle à TomTom
// (src/utils/traffic.js), la page ne parle qu'à ces adresses.
//
// GET /api/admin/traffic/status                          réglage actif ? appels du jour / plafond (jamais la clé)
// GET /api/admin/traffic/tiles/:style/:z/:x/:y.png       tuile de la couche « Trafic » de la carte
// GET /api/admin/traffic/speed?lat=&lng=                 vitesse actuelle et vitesse habituelle à cet endroit
// GET /api/admin/traffic/driver/:id/eta                  ce qu'il reste à faire au chauffeur : heures de passage avec le trafic du moment
// GET /api/admin/traffic/tour/:id/eta?departAt=          une tournée fixe, du dépôt aux hôtels puis retour, avec le trafic (prévu si le départ est à venir)
//
// Les coordonnées de l'itinéraire viennent de la BASE (dépôt, adresses des commandes) : la page n'envoie jamais de point à TomTom,
// seulement un numéro de chauffeur ou de tournée.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const traffic = require('../utils/traffic');
const { plan, depotOf, driverPlan } = require('../utils/trafficPlan');

const router = express.Router();
router.use(requireAdmin);

// Cadences par session (clé = empreinte de l'identifiant de session : il ne doit jamais apparaître dans un journal).
const sessionKey = (req) => crypto.createHash('sha256').update(String(req.sessionID || req.ip)).digest('hex').slice(0, 12);
const tilesLimit = rateLimit({ name: 'trafic (tuiles)', windowMs: 60 * 1000, max: 900, key: sessionKey, message: 'Trop de tuiles demandées. Patientez une minute.' });
const dataLimit = rateLimit({ name: 'trafic', windowMs: 60 * 1000, max: 40, key: sessionKey, message: 'Trop de demandes de trafic. Patientez une minute.' });

function sendError(res, e) {
  if (e instanceof traffic.TrafficError) {
    if (e.code === 'budget') res.set('Retry-After', '3600');
    return res.status(e.http).json({ error: e.message, code: e.code });
  }
  console.error('[trafic]', traffic.scrub(e && e.stack ? e.stack : e));
  return res.status(500).json({ error: 'Erreur interne.' });
}

router.get('/status', (req, res) => res.json(traffic.status()));

router.get('/tiles/:style/:z/:x/:y', tilesLimit, async (req, res) => {
  try {
    const png = await traffic.tile(traffic.parseTileParams(req.params));
    // Les réponses d'API ne se mettent pas en cache d'ordinaire ; une tuile se garde une minute dans CE navigateur seulement
    // (jamais dans un cache partagé : elle est derrière la connexion administrateur).
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60', Vary: 'Cookie', 'Content-Length': String(png.length) });
    res.end(png);
  } catch (e) { sendError(res, e); }
});

router.get('/speed', dataLimit, async (req, res) => {
  try { res.json(await traffic.speedAt(req.query.lat, req.query.lng)); } catch (e) { sendError(res, e); }
});

// ---------- itinéraires (construits dans src/utils/trafficPlan.js, communs avec le lien du livreur) ----------
router.get('/driver/:id/eta', dataLimit, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Chauffeur invalide.', code: 'bad_input' });
  try {
    const out = await driverPlan(id);
    if (!out) return res.status(404).json({ error: 'Chauffeur introuvable.' });
    res.json(out);
  } catch (e) { sendError(res, e); }
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

router.get('/tour/:id/eta', dataLimit, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Tournée invalide.', code: 'bad_input' });
  let departAt = null;
  if (req.query.departAt !== undefined) {
    const raw = String(req.query.departAt);
    if (!ISO.test(raw) || !Number.isFinite(Date.parse(raw))) return res.status(400).json({ error: 'Heure de départ invalide.', code: 'bad_input' });
    departAt = new Date(raw);
  }
  try {
    const tour = db.prepare('SELECT id, name FROM fixed_tours WHERE id = ?').get(id);
    if (!tour) return res.status(404).json({ error: 'Tournée introuvable.' });
    const depot = depotOf();
    if (!depot) return res.status(409).json({ error: 'Le dépôt n\'est pas encore localisé : ouvrez une fois la carte des tournées.', code: 'no_start' });
    const clients = db.prepare(`SELECT cl.id, cl.societe FROM fixed_tour_clients c JOIN clients cl ON cl.id = c.client_id WHERE c.tour_id = ? ORDER BY c.position, cl.societe`).all(id);
    const lastPos = db.prepare('SELECT lat, lng FROM orders WHERE client_id = ? AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY id DESC LIMIT 1');
    const groups = [], missing = [];
    for (const c of clients) {
      const p = lastPos.get(c.id);
      if (p) groups.push({ lat: p.lat, lng: p.lng, items: [{ clientId: c.id, societe: c.societe }] });
      else missing.push({ clientId: c.id, societe: c.societe });
    }
    const base = { tour: { id: tour.id, name: tour.name }, missing };
    if (!groups.length) return res.json({ ...base, stops: [], backToDepot: null, totals: null, note: clients.length ? 'Aucune adresse d\'hôtel n\'est encore localisée (elles le sont à la première commande affichée sur la carte).' : 'Cette tournée n\'a aucun hôtel.' });
    res.json({ ...base, ...(await plan({ start: depot, groups, depot, departAt })), forecast: !!departAt && departAt.getTime() > Date.now() + 3 * 60 * 1000 });
  } catch (e) { sendError(res, e); }
});

module.exports = router;
