// Statistiques jour par jour — partie EXPLOITATION (aucun montant) : commandes, pièces, poids, kilomètres…
// Les montants (livré valorisé, factures, encaissements) sont dans billing/daily.js, derrière le verrou de la Facturation.
//
// Dates :
//  - « reçue le »  = date de création de la commande, à l'heure de Paris ;
//  - « livrée le » = date de livraison de la commande (livraison prévue, à défaut date de création), la même
//    que celle des bons de livraison : un BL et la statistique du jour ne peuvent donc pas se contredire.

const db = require('../db');

const MAX_DAYS = 400;
const DELIVERY_DATE_SQL = "COALESCE(NULLIF(substr(o.livraison_prevue, 1, 10), ''), substr(o.created_at, 1, 10))";
const parisFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' });

const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayParis = () => parisFmt.format(new Date());

class StatsError extends Error { constructor(m, status = 400) { super(m); this.name = 'StatsError'; this.status = status; } }

/** Période demandée : 30 derniers jours par défaut ; au plus MAX_DAYS jours. */
function period(from, to) {
  const end = to || todayParis();
  const start = from || addDays(end, -29);
  if (!isIso(start) || !isIso(end)) throw new StatsError('Dates invalides (format AAAA-MM-JJ).');
  if (start > end) throw new StatsError('La date de début est postérieure à la date de fin.');
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_DAYS) throw new StatsError(`La période est limitée à ${MAX_DAYS} jours.`);
  return { from: start, to: end, days };
}

/** Date (heure de Paris) d'un horodatage stocké en UTC : « 2026-10-24T22:30:00.000Z » ou « 2026-10-24 22:30:00 ». */
function parisDate(ts) {
  const s = String(ts || '');
  if (!s) return null;
  const d = /Z$|[+-]\d\d:?\d\d$/.test(s) ? new Date(s) : new Date(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s.slice(0, 10) : parisFmt.format(d);
}

const round1 = (n) => Math.round(n * 10) / 10;
const emptyDay = (date) => ({
  date, ordersReceived: 0, piecesOrdered: 0,
  ordersDelivered: 0, piecesDelivered: 0, references: 0, hotelsServed: 0, drivers: 0,
  weightKg: 0, volumeL: 0, km: 0, piecesMissing: 0, piecesExtra: 0, ordersAdjusted: 0,
});

/** Une ligne par jour de la période (jours sans activité compris, à zéro), plus les totaux. */
function daily(from, to) {
  const p = period(from, to);
  const days = new Map();
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) days.set(d, emptyDay(d));

  // Commandes reçues : on lit large (jour avant/après, à cause du décalage UTC → Paris) puis on trie à l'heure de Paris.
  const received = db.prepare(`
    SELECT o.id, o.created_at AS ts, COALESCE(SUM(oi.qty), 0) AS pieces
    FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE substr(o.created_at, 1, 10) BETWEEN ? AND ?
    GROUP BY o.id
  `).all(addDays(p.from, -1), addDays(p.to, 1));
  for (const r of received) {
    const d = days.get(parisDate(r.ts));
    if (d) { d.ordersReceived += 1; d.piecesOrdered += r.pieces; }
  }

  // Commandes livrées : une ligne par article livré, regroupée par jour de livraison.
  const rows = db.prepare(`
    SELECT o.id AS orderId, o.client_id AS clientId, o.societe, o.driver_id AS driverId, o.distance_from_prev_km AS km,
           ${DELIVERY_DATE_SQL} AS date, oi.service_id AS serviceId, oi.qty, oi.delivered_qty AS delivered,
           COALESCE(a.weight_g, 0) AS weightG, COALESCE(a.volume_l, 0) AS volumeL
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN articles a ON a.id = oi.service_id
    WHERE o.status = 'livree' AND ${DELIVERY_DATE_SQL} BETWEEN ? AND ?
  `).all(p.from, p.to);
  const seen = new Map();   // date → { orders, refs, hotels, drivers, adjusted }
  for (const r of rows) {
    const d = days.get(r.date); if (!d) continue;
    const s = seen.get(r.date) || { orders: new Set(), refs: new Set(), hotels: new Set(), drivers: new Set(), adjusted: new Set() };
    seen.set(r.date, s);
    const qty = r.delivered ?? r.qty;
    if (!s.orders.has(r.orderId)) { s.orders.add(r.orderId); d.km += r.km || 0; if (r.driverId) s.drivers.add(r.driverId); }
    s.hotels.add(r.clientId ? `c${r.clientId}` : `s${String(r.societe).trim().toLowerCase()}`);
    if (qty > 0) s.refs.add(r.serviceId);
    d.piecesDelivered += qty; d.weightKg += (qty * r.weightG) / 1000; d.volumeL += qty * r.volumeL;
    if (qty < r.qty) d.piecesMissing += r.qty - qty;
    if (qty > r.qty) d.piecesExtra += qty - r.qty;
    if (qty !== r.qty) s.adjusted.add(r.orderId);
  }
  for (const [date, s] of seen) {
    const d = days.get(date);
    d.ordersDelivered = s.orders.size; d.references = s.refs.size; d.hotelsServed = s.hotels.size; d.drivers = s.drivers.size; d.ordersAdjusted = s.adjusted.size;
  }
  // Commandes livrées sans aucune ligne d'article : elles comptent quand même comme livrées.
  for (const r of db.prepare(`SELECT ${DELIVERY_DATE_SQL} AS date, COUNT(*) AS n FROM orders o WHERE o.status = 'livree' AND ${DELIVERY_DATE_SQL} BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id) GROUP BY date`).all(p.from, p.to)) {
    const d = days.get(r.date); if (d) d.ordersDelivered += r.n;
  }

  const list = [...days.values()].map(d => ({ ...d, weightKg: round1(d.weightKg), volumeL: round1(d.volumeL), km: round1(d.km) }));
  const sum = (k) => list.reduce((s, d) => s + d[k], 0);
  const active = list.filter(d => d.ordersReceived || d.ordersDelivered);
  const totals = {
    ordersReceived: sum('ordersReceived'), piecesOrdered: sum('piecesOrdered'), ordersDelivered: sum('ordersDelivered'), piecesDelivered: sum('piecesDelivered'),
    weightKg: round1(sum('weightKg')), volumeL: round1(sum('volumeL')), km: round1(sum('km')), piecesMissing: sum('piecesMissing'), piecesExtra: sum('piecesExtra'),
    activeDays: active.length, avgDeliveredPerActiveDay: active.length ? round1(sum('ordersDelivered') / active.length) : 0,
  };
  // État actuel des commandes (photo d'aujourd'hui, pas de la période)
  const now = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all().map(r => [r.status, r.n]));
  return { from: p.from, to: p.to, days: list, totals, current: now };
}

/** Toutes les commandes d'un jour (reçues ce jour-là et livrées ce jour-là), pour le détail. */
function dayDetail(date) {
  if (!isIso(date)) throw new StatsError('Date invalide.');
  const base = `SELECT o.id, o.ticket, o.status, o.societe, o.client_id AS clientId, COALESCE(c.societe, o.societe) AS clientName, o.created_at AS createdAt,
      ${DELIVERY_DATE_SQL} AS deliveryDate, o.distance_from_prev_km AS km, d.name AS driver,
      COALESCE((SELECT SUM(qty) FROM order_items WHERE order_id = o.id), 0) AS pieces,
      COALESCE((SELECT SUM(COALESCE(delivered_qty, qty)) FROM order_items WHERE order_id = o.id), 0) AS piecesDelivered
    FROM orders o LEFT JOIN clients c ON c.id = o.client_id LEFT JOIN drivers d ON d.id = o.driver_id`;
  const received = db.prepare(`${base} WHERE substr(o.created_at, 1, 10) BETWEEN ? AND ? ORDER BY o.id`).all(addDays(date, -1), addDays(date, 1)).filter(o => parisDate(o.createdAt) === date);
  const delivered = db.prepare(`${base} WHERE o.status = 'livree' AND ${DELIVERY_DATE_SQL} = ? ORDER BY o.id`).all(date);
  const shape = (o) => ({ id: o.id, ticket: o.ticket, status: o.status, clientName: o.clientName, pieces: o.pieces, piecesDelivered: o.piecesDelivered, km: o.km || 0, driver: o.driver || null });
  return { date, received: received.map(shape), delivered: delivered.map(shape) };
}

module.exports = { daily, dayDetail, period, isIso, addDays, todayParis, parisDate, StatsError, MAX_DAYS, DELIVERY_DATE_SQL };
