// Coûts de livraison sur une période (onglet Statistiques). Quatre postes :
//  - carburant, pneus, usure : kilomètres livrés × coût au km (réglage) ;
//  - chauffeur : temps de tournée × coût horaire chargé (réglage). Temps estimé comme sur le lien du livreur : kilomètres ÷ vitesse
//    moyenne + minutes par arrêt (réglages de la Logistique), par chauffeur et par jour de livraison ;
//  - entretien des véhicules : les dépenses saisies dans le Garage, à la date de l'entretien ;
//  - frais fixes (assurance, crédit ou location) : montant mensuel (réglage), au prorata des jours de la période.
// Un poste dont le réglage n'est pas rempli n'est pas compté : le total est alors « partiel » et le dit.
const db = require('../db');
const dailyStats = require('./dailyStats');

const KEYS = { perKm: 'delivery_cost_per_km_cents', driverHourly: 'delivery_driver_hourly_cents', fixedMonthly: 'delivery_fixed_monthly_cents' };
const MAX_EUROS = { perKm: 100, driverHourly: 500, fixedMonthly: 100000 };   // garde-fous contre une faute de frappe
const LABELS = { perKm: 'coût au km', driverHourly: 'coût horaire du chauffeur', fixedMonthly: 'frais fixes mensuels' };

class CostError extends Error { constructor(message, status = 400) { super(message); this.name = 'StatsError'; this.status = status; } }

/** Réglages en euros ; null = pas renseigné. */
function getSettings() {
  const rows = db.prepare(`SELECT key, value FROM prod_settings WHERE key IN (${Object.values(KEYS).map(() => '?').join(',')})`).all(...Object.values(KEYS));
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const out = {};
  for (const [name, key] of Object.entries(KEYS)) {
    const n = Number(byKey[key]);
    out[name] = byKey[key] !== undefined && byKey[key] !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) / 100 : null;
  }
  return out;
}

/** body : { perKm, driverHourly, fixedMonthly } en euros ; une clé absente est laissée telle quelle, null ou '' efface le réglage. */
function saveSettings(body) {
  const b = body && typeof body === 'object' ? body : {};
  const ops = [];
  for (const name of Object.keys(KEYS)) {
    if (!(name in b)) continue;
    const raw = b[name];
    if (raw === null || raw === '') { ops.push({ name, cents: null }); continue; }
    const euros = typeof raw === 'number' ? raw : Number(String(raw).replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(euros) || euros < 0) throw new CostError(`Valeur invalide pour « ${LABELS[name]} ».`);
    if (euros > MAX_EUROS[name]) throw new CostError(`« ${LABELS[name]} » ne peut pas dépasser ${MAX_EUROS[name].toLocaleString('fr-FR')} €.`);
    ops.push({ name, cents: Math.round(euros * 100) });
  }
  db.transaction(() => {
    for (const { name, cents } of ops) {
      if (cents == null) db.prepare('DELETE FROM prod_settings WHERE key = ?').run(KEYS[name]);
      else db.prepare('INSERT INTO prod_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEYS[name], String(cents));
    }
  })();
  return getSettings();
}

const round1 = (n) => Math.round(n * 10) / 10;

/** p : période validée (dailyStats.period). */
function compute(p) {
  const s = getSettings();
  const adm = db.prepare('SELECT avg_speed_kmh, minutes_per_stop FROM admin WHERE id = 1').get() || {};
  const speed = Number(adm.avg_speed_kmh) > 0 ? Number(adm.avg_speed_kmh) : 40;
  const perStop = Number(adm.minutes_per_stop) >= 0 && adm.minutes_per_stop != null ? Number(adm.minutes_per_stop) : 20;

  const rows = db.prepare(`
    SELECT o.id, o.driver_id AS driverId, COALESCE(d.name, 'Sans chauffeur') AS driver, ${dailyStats.DELIVERY_DATE_SQL} AS date, o.distance_from_prev_km AS km
    FROM orders o LEFT JOIN drivers d ON d.id = o.driver_id
    WHERE o.status = 'livree' AND ${dailyStats.DELIVERY_DATE_SQL} BETWEEN ? AND ?
  `).all(p.from, p.to);
  const weightKg = db.prepare(`
    SELECT SUM(COALESCE(oi.delivered_qty, oi.qty) * a.weight_g) / 1000.0 AS kg
    FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN articles a ON a.id = oi.service_id
    WHERE o.status = 'livree' AND ${dailyStats.DELIVERY_DATE_SQL} BETWEEN ? AND ?
  `).get(p.from, p.to).kg || 0;

  // une « tournée » = un chauffeur, un jour
  const tours = new Map();
  let withoutDistance = 0;
  for (const r of rows) {
    if (r.km == null) withoutDistance++;
    const key = `${r.driverId ?? 0}|${r.date}`;
    const t = tours.get(key) || { driverId: r.driverId, driver: r.driver, date: r.date, stops: 0, km: 0 };
    t.stops += 1; t.km += r.km || 0;
    tours.set(key, t);
  }
  const money = (km, hours) => ({ km: s.perKm == null ? null : km * s.perKm * 100, driver: s.driverHourly == null ? null : hours * s.driverHourly * 100 });
  const sum = (a, b) => (a == null && b == null ? null : (a || 0) + (b || 0));

  let km = 0, hours = 0;
  const byDriverMap = new Map(), byDayMap = new Map();
  for (const t of tours.values()) {
    const h = ((t.km / speed) * 60 + t.stops * perStop) / 60;
    const c = money(t.km, h);
    km += t.km; hours += h;
    const d = byDriverMap.get(t.driverId ?? 0) || { driver: t.driver, days: 0, stops: 0, km: 0, hours: 0, cents: null };
    d.days += 1; d.stops += t.stops; d.km += t.km; d.hours += h; d.cents = sum(d.cents, sum(c.km, c.driver));
    byDriverMap.set(t.driverId ?? 0, d);
    const day = byDayMap.get(t.date) || { date: t.date, stops: 0, km: 0, hours: 0, cents: null };
    day.stops += t.stops; day.km += t.km; day.hours += h; day.cents = sum(day.cents, sum(c.km, c.driver));
    byDayMap.set(t.date, day);
  }

  const maintenance = db.prepare(`SELECT SUM(cost) AS c, COUNT(cost) AS n FROM truck_maintenance WHERE substr(date, 1, 10) BETWEEN ? AND ? AND cost IS NOT NULL`).get(p.from, p.to);
  const maintenanceCents = Math.round((maintenance.c || 0) * 100);
  const c = money(km, hours);
  const components = {
    perKm: c.km == null ? null : Math.round(c.km),
    driver: c.driver == null ? null : Math.round(c.driver),
    maintenance: maintenanceCents,
    fixed: s.fixedMonthly == null ? null : Math.round(s.fixedMonthly * 100 * p.days / (365 / 12)),
  };
  const totalCents = Object.values(components).reduce((a, v) => a + (v || 0), 0);
  const missing = Object.keys(KEYS).filter(k => s[k] == null);
  const deliveries = rows.length;
  const ratio = (den) => (den > 0 && totalCents > 0 ? Math.round(totalCents / den) : null);
  const clean = (m) => [...m.values()].map(x => ({ ...x, km: round1(x.km), hours: round1(x.hours), cents: x.cents == null ? null : Math.round(x.cents) }));

  return {
    period: { from: p.from, to: p.to, days: p.days },
    settings: s, missing, partial: missing.length > 0,
    assumptions: { avgSpeedKmh: speed, minutesPerStop: perStop },
    deliveries, km: round1(km), hours: round1(hours), weightKg: round1(weightKg), withoutDistance, maintenanceEntries: maintenance.n,
    components, totalCents,
    perDeliveryCents: ratio(deliveries), perKmCents: ratio(km), perKgCents: ratio(weightKg),
    byDriver: clean(byDriverMap).sort((a, b) => b.km - a.km || a.driver.localeCompare(b.driver)),
    byDay: clean(byDayMap).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

module.exports = { compute, getSettings, saveSettings, CostError };
