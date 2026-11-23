// Itinéraires avec le trafic, construits depuis la BASE (dépôt, adresses des commandes) et jamais depuis des coordonnées envoyées par
// une page : utilisés par l'administration (routes/traffic.js) et par le lien du livreur (routes/driverPortal.js).
const db = require('../db');
const traffic = require('./traffic');
const { parisDay } = require('./orderDelivery');

const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lng - b.lng) < 1e-4;   // ≈ 10 m : même adresse
const min = (sec) => Math.round(sec / 60);
const km = (m) => Math.round(m / 100) / 10;
const GPS_FRESH_MS = 10 * 60 * 1000;
const MEMO_MS = 3 * 60 * 1000;

/**
 * start : { lat, lng } ; groups : arrêts dans l'ordre [{ lat, lng, items: [...] }] ; depot : retour éventuel ; departAt : Date ou null (= maintenant).
 * Renvoie les heures de passage, la durée de chaque trajet (avec et sans trafic) et les totaux.
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
  if (skipped) out.stops.push({ items: skipped.items, lat: skipped.lat, lng: skipped.lng, etaAt: origin.toISOString(), driveMin: 0, freeFlowMin: 0, delayMin: 0, km: 0 });
  if (!targets.length) return out;

  const r = await traffic.route([start, ...targets], { departAt });
  let clock = Date.parse(r.departAt) || origin.getTime();
  targets.forEach((t, i) => {
    const leg = r.legs[i];
    if (!leg) return;
    clock += leg.travelSec * 1000;
    const row = { lat: t.lat, lng: t.lng, etaAt: leg.arrivalAt || new Date(clock).toISOString(), driveMin: min(leg.travelSec), freeFlowMin: min(leg.noTrafficSec), delayMin: min(leg.delaySec), km: km(leg.lengthM) };
    if (t.kind === 'depot') out.backToDepot = row; else out.stops.push({ items: t.items, ...row });
  });
  out.departAt = r.departAt;
  out.totals = { driveMin: min(r.travelSec), freeFlowMin: min(r.noTrafficSec), delayMin: min(r.delaySec), km: km(r.lengthM) };
  return out;
}

const depotOf = () => {
  const a = db.prepare('SELECT depot_lat, depot_lng FROM admin WHERE id = 1').get() || {};
  return a.depot_lat != null && a.depot_lng != null ? { lat: a.depot_lat, lng: a.depot_lng } : null;
};

const memo = new Map();   // chauffeur -> { at, sig, out } : un même état de tournée n'est calculé qu'une fois toutes les 3 min

/**
 * Ce qu'il reste à faire à un chauffeur, avec le trafic du moment. Les arrêts suivent l'ordre où son lien les affiche.
 * null si le chauffeur n'existe pas ; lève TrafficError (no_start, ou une erreur TomTom) sinon.
 */
async function driverPlan(driverId) {
  const d = db.prepare('SELECT id, name, last_lat, last_lng, last_position_at FROM drivers WHERE id = ?').get(driverId);
  if (!d) return null;
  const depot = depotOf();
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const today = parisDay();
  const pendingAll = db.prepare(`SELECT id, ticket, societe, lat, lng FROM orders WHERE driver_id = ? AND status = 'prete' ORDER BY delivery_sequence ASC, created_at ASC`).all(d.id);
  const pending = pendingAll.filter(o => o.lat != null && o.lng != null);
  const noCoords = pendingAll.length - pending.length;
  const lastDone = db.prepare(`SELECT lat, lng, delivered_lat, delivered_lng, delivered_at FROM orders WHERE driver_id = ? AND status = 'livree' AND delivered_at IS NOT NULL AND delivered_at >= ? ORDER BY delivered_at DESC`)
    .all(d.id, since).find(o => parisDay(o.delivered_at) === today);

  // Point de départ : position partagée si elle est récente, sinon dernière livraison validée, sinon dépôt.
  let from = null, source = null;
  if (d.last_lat != null && d.last_position_at && Date.now() - Date.parse(d.last_position_at) <= GPS_FRESH_MS) { from = { lat: d.last_lat, lng: d.last_lng }; source = 'gps'; }
  else if (lastDone && (lastDone.delivered_lat ?? lastDone.lat) != null) { from = { lat: lastDone.delivered_lat ?? lastDone.lat, lng: lastDone.delivered_lng ?? lastDone.lng }; source = 'delivery'; }
  else if (depot) { from = depot; source = 'depot'; }

  const base = { driver: { id: d.id, name: d.name }, source, start: from, depot, missingAddresses: noCoords, remaining: pending.length };
  if (!pending.length) return { ...base, stops: [], backToDepot: null, totals: null, generatedAt: new Date().toISOString(), note: noCoords ? 'Les adresses restantes ne sont pas encore localisées.' : 'Plus aucun arrêt à faire.' };
  if (!from) throw new traffic.TrafficError('no_start', 'Position de départ inconnue : localisez le dépôt (carte des tournées) ou attendez la position du chauffeur.', 409);

  const sig = [Math.round(from.lat * 1000), Math.round(from.lng * 1000), ...pending.map(o => o.id)].join(',');   // départ au ~100 m près
  const hit = memo.get(d.id);
  if (hit && hit.sig === sig && Date.now() - hit.at < MEMO_MS) return hit.out;
  const groups = pending.map(o => ({ lat: o.lat, lng: o.lng, items: [{ orderId: o.id, ticket: o.ticket, societe: o.societe }] }));
  const out = { ...base, ...(await plan({ start: from, groups, depot, departAt: null })), generatedAt: new Date().toISOString() };
  memo.set(d.id, { at: Date.now(), sig, out });
  return out;
}

module.exports = { plan, depotOf, driverPlan, same };
