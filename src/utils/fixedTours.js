// Tournées fixes : à quel chauffeur, et dans quel ordre, doit partir la commande d'un hôtel.
// Une tournée = un chauffeur + des jours de la semaine (1 = lundi … 7 = dimanche) + des hôtels dans l'ordre de passage.
// Les commandes non livrées et sans chauffeur des hôtels rattachés sont affectées à la prochaine tournée qui roule.
// Une commande placée à la main par l'équipe (orders.tour_manual = 1) n'est jamais déplacée par l'automatisme.
const db = require('../db');
const { parisDay } = require('./orderDelivery');

const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());
/** Jour de la semaine (1 = lundi … 7 = dimanche) d'une date AAAA-MM-JJ, null si la date est invalide. */
function weekdayOf(dateStr) {
  if (!isDate(dateStr)) return null;
  const d = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const parseDays = (txt) => [...new Set(String(txt || '').split(',').map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7))].sort((a, b) => a - b);

const slotsStmt = () => db.prepare(`
  SELECT t.id, t.name, t.driver_id, t.weekdays, c.position
  FROM fixed_tour_clients c JOIN fixed_tours t ON t.id = c.tour_id
  WHERE c.client_id = ? AND t.active = 1 AND t.driver_id IS NOT NULL ORDER BY t.id
`);

/**
 * Prochaine tournée qui passe chez cet hôtel à partir de `fromDate` (comprise), sur 7 jours :
 * { tourId, name, driverId, sequence, date } ou null.
 */
function nextSlot(clientId, fromDate) {
  if (!clientId || !isDate(fromDate)) return null;
  const rows = slotsStmt().all(clientId).map(r => ({ ...r, days: parseDays(r.weekdays) })).filter(r => r.days.length);
  if (!rows.length) return null;
  for (let i = 0; i < 7; i += 1) {
    const date = addDays(fromDate, i);
    const wd = weekdayOf(date);
    const hit = rows.find(r => r.days.includes(wd));
    if (hit) return { tourId: hit.id, name: hit.name, driverId: hit.driver_id, sequence: hit.position + 1, date };
  }
  return null;
}

/**
 * Affecte à leur tournée fixe toutes les commandes non livrées, sans chauffeur et jamais placées à la main.
 * La date de référence est la livraison prévue si elle est à venir, sinon aujourd'hui (jour de Paris).
 * Renvoie le nombre de commandes affectées.
 */
function assignPending(today = parisDay()) {
  // Arrêts de collecte programmés : ils attendent leur jour (statut « reçue », donc invisibles du chauffeur et de l'atelier)
  // puis passent « prêts » le matin même, ce qui les met sur la page du chauffeur.
  db.prepare(`UPDATE orders SET status = 'prete' WHERE collect_only = 1 AND status = 'recue' AND livraison_prevue IS NOT NULL AND livraison_prevue <= ?`).run(today);
  const orders = db.prepare(`
    SELECT id, client_id, livraison_prevue FROM orders
    WHERE status IN ('recue', 'traitement', 'prete') AND driver_id IS NULL AND tour_manual = 0 AND client_id IS NOT NULL
    AND client_id IN (SELECT client_id FROM fixed_tour_clients)
  `).all();
  if (!orders.length) return 0;
  const set = db.prepare('UPDATE orders SET driver_id = ?, delivery_sequence = ?, tour_id = ? WHERE id = ? AND driver_id IS NULL AND tour_manual = 0');
  let n = 0;
  db.transaction(() => {
    for (const o of orders) {
      const ref = isDate(o.livraison_prevue) && o.livraison_prevue > today ? o.livraison_prevue : today;
      const slot = nextSlot(o.client_id, ref);
      if (slot && set.run(slot.driverId, slot.sequence, slot.tourId, o.id).changes) n += 1;
    }
  })();
  return n;
}

/** Retire des commandes les affectations faites par cette tournée (avant de la modifier ou de la supprimer). */
function releaseTour(tourId) {
  return db.prepare(`
    UPDATE orders SET driver_id = NULL, delivery_sequence = NULL, tour_id = NULL
    WHERE tour_id = ? AND tour_manual = 0 AND status IN ('recue', 'traitement', 'prete')
  `).run(tourId).changes;
}

/** Un hôtel ne peut pas être dans deux tournées actives qui roulent le même jour : renvoie le premier conflit, sinon null. */
function findConflict(tourId, weekdays, clientIds) {
  if (!weekdays.length || !clientIds.length) return null;
  const others = db.prepare('SELECT id, name, weekdays FROM fixed_tours WHERE active = 1 AND id != ?').all(tourId || 0);
  const marks = clientIds.map(() => '?').join(',');
  for (const o of others) {
    const common = parseDays(o.weekdays).filter(d => weekdays.includes(d));
    if (!common.length) continue;
    const hit = db.prepare(`SELECT c.client_id, cl.societe FROM fixed_tour_clients c JOIN clients cl ON cl.id = c.client_id WHERE c.tour_id = ? AND c.client_id IN (${marks}) LIMIT 1`).get(o.id, ...clientIds);
    if (hit) return { clientId: hit.client_id, societe: hit.societe, tour: o.name, days: common.map(d => DAY_NAMES[d - 1]) };
  }
  return null;
}

module.exports = { DAY_NAMES, isDate, weekdayOf, addDays, parseDays, nextSlot, assignPending, releaseTour, findConflict, parisDay };
