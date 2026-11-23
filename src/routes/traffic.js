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
const { parisDay } = require('../utils/orderDelivery');

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
  const { style, z, x, y } = req.params;
  const ym = /^(\d{1,7})\.png$/.exec(y);
  if (!/^[a-z0-9-]{1,20}$/.test(style) || !/^\d{1,2}$/.test(z) || !/^\d{1,7}$/.test(x) || !ym) return res.status(400).json({ error: 'Tuile invalide.', code: 'bad_input' });
  try {
    const png = await traffic.tile({ style, z: Number(z), x: Number(x), y: Number(ym[1]) });
    // Les réponses d'API ne se mettent pas en cache d'ordinaire ; une tuile se garde une minute dans CE navigateur seulement
    // (jamais dans un cache partagé : elle est derrière la connexion administrateur).
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60', Vary: 'Cookie', 'Content-Length': String(png.length) });
    res.end(png);
  } catch (e) { sendError(res, e); }
});

router.get('/speed', dataLimit, async (req, res) => {
  try { res.json(await traffic.speedAt(req.query.lat, req.query.lng)); } catch (e) { sendError(res, e); }
});

// ---------- itinéraires ----------
const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lng - b.lng) < 1e-4;   // ≈ 10 m : même adresse
const min = (sec) => Math.round(sec / 60);

/**
 * start : { lat, lng } ; groups : arrêts dans l'ordre [{ lat, lng, items: [...] }] ; depot : retour éventuel ; departAt : Date ou null (= maintenant).
 * Renvoie les heures de passage et les totaux (durée avec trafic, sans trafic, retard dû au trafic).
 */
async function plan({ start, groups, depot, departAt }) {
  const targets = [];
  let skipped = null;
  for (const g of groups) {
    if (!targets.length && !skipped && same(start, g)) { skipped = g; continue; }   // déjà sur place : pas de trajet
    const prev = targets[targets.length - 1];
    if (prev && prev.kind === 'stop' && same(prev, g)) { prev.items.push(...g.items); continue; }   // même adresse que l'arrêt précédent
    targets.push({ kind: 'stop', lat: g.lat, lng: g.lng, items: [...g.items] });
  }
  const trimmed = targets.length > traffic.MAX_POINTS - 2;
  if (trimmed) targets.length = traffic.MAX_POINTS - 2;
  const last = targets.length ? targets[targets.length - 1] : start;
  if (depot && !same(last, depot) && targets.length) targets.push({ kind: 'depot', lat: depot.lat, lng: depot.lng, items: [] });
  const origin = departAt || new Date();
  const out = { departAt: origin.toISOString(), stops: [], backToDepot: null, totals: null, trimmed };
  if (skipped) out.stops.push({ items: skipped.items, etaAt: origin.toISOString(), driveMin: 0, delayMin: 0 });
  if (!targets.length) return out;

  const r = await traffic.route([start, ...targets], { departAt });
  let clock = Date.parse(r.departAt) || origin.getTime();
  targets.forEach((t, i) => {
    const leg = r.legs[i];
    if (!leg) return;
    clock += leg.travelSec * 1000;
    const row = { etaAt: leg.arrivalAt || new Date(clock).toISOString(), driveMin: min(leg.travelSec), delayMin: min(leg.delaySec) };
    if (t.kind === 'depot') out.backToDepot = row; else out.stops.push({ items: t.items, ...row });
  });
  out.departAt = r.departAt;
  out.totals = { driveMin: min(r.travelSec), freeFlowMin: min(r.noTrafficSec), delayMin: min(r.delaySec), km: Math.round(r.lengthM / 100) / 10 };
  return out;
}

const depotOf = () => {
  const a = db.prepare('SELECT depot_address, depot_lat, depot_lng FROM admin WHERE id = 1').get() || {};
  return a.depot_lat != null && a.depot_lng != null ? { lat: a.depot_lat, lng: a.depot_lng } : null;
};
const GPS_FRESH_MS = 10 * 60 * 1000;

router.get('/driver/:id/eta', dataLimit, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Chauffeur invalide.', code: 'bad_input' });
  try {
    const d = db.prepare('SELECT id, name, last_lat, last_lng, last_position_at FROM drivers WHERE id = ?').get(id);
    if (!d) return res.status(404).json({ error: 'Chauffeur introuvable.' });
    const depot = depotOf();
    const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
    const today = parisDay();
    const orders = db.prepare(`SELECT id, ticket, societe, status, lat, lng, delivered_lat, delivered_lng, delivered_at, delivery_sequence, created_at
      FROM orders WHERE driver_id = ? AND (status = 'prete' OR (status = 'livree' AND delivered_at IS NOT NULL AND delivered_at >= ?))`).all(id, since)
      .filter(o => o.status === 'prete' || parisDay(o.delivered_at) === today);
    const pending = orders.filter(o => o.status === 'prete' && o.lat != null && o.lng != null)
      .sort((a, b) => (a.delivery_sequence ?? 1e9) - (b.delivery_sequence ?? 1e9) || Date.parse(a.created_at) - Date.parse(b.created_at));
    const noCoords = orders.filter(o => o.status === 'prete' && (o.lat == null || o.lng == null)).length;

    // Point de départ : position partagée si elle est récente, sinon dernière livraison validée, sinon dépôt.
    const lastDone = orders.filter(o => o.status === 'livree').sort((a, b) => Date.parse(b.delivered_at) - Date.parse(a.delivered_at))[0];
    let from = null, source = null;
    if (d.last_lat != null && d.last_position_at && Date.now() - Date.parse(d.last_position_at) <= GPS_FRESH_MS) { from = { lat: d.last_lat, lng: d.last_lng }; source = 'gps'; }
    else if (lastDone && (lastDone.delivered_lat ?? lastDone.lat) != null) { from = { lat: lastDone.delivered_lat ?? lastDone.lat, lng: lastDone.delivered_lng ?? lastDone.lng }; source = 'delivery'; }
    else if (depot) { from = depot; source = 'depot'; }

    const base = { driver: { id: d.id, name: d.name }, source, missingAddresses: noCoords, remaining: pending.length };
    if (!pending.length) return res.json({ ...base, stops: [], backToDepot: null, totals: null, note: noCoords ? 'Les adresses restantes ne sont pas encore localisées.' : 'Plus aucun arrêt à faire.' });
    if (!from) return res.status(409).json({ error: 'Position de départ inconnue : localisez le dépôt (carte des tournées) ou attendez la position du chauffeur.', code: 'no_start' });

    const groups = pending.map(o => ({ lat: o.lat, lng: o.lng, items: [{ orderId: o.id, ticket: o.ticket, societe: o.societe }] }));
    res.json({ ...base, ...(await plan({ start: from, groups, depot, departAt: null })) });
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
