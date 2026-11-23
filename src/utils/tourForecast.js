// Prévision de charge des tournées fixes : le camion sera-t-il assez grand (poids, volume, chariots) ?
//
// Méthode : on REJOUE l'historique. Chaque commande livrée sur les 12 dernières semaines par les hôtels d'une tournée est rattachée au
// prochain passage de cette tournée (comme le fait l'affectation automatique), ce qui donne ce que la tournée aurait réellement
// transporté chaque jour de passage. Pour un jour de la semaine, on en tire une charge normale (moyenne), une charge forte (9 jours
// sur 10) et le pic observé. Ces charges sont comparées à la capacité du camion du chauffeur :
//   - poids : charge utile réglée dans Logistique (linge + chariots vides) ;
//   - volume : volume intérieur du type de camion rattaché au chauffeur ;
//   - chariots : combien de chariots tiennent debout sur le plancher du camion.
// Pour le prochain passage, les commandes déjà reçues sont aussi comptées. Rien n'est inventé : sans historique ou sans dimensions
// d'articles, on le dit.
const db = require('../db');
const ft = require('./fixedTours');
const { parisDay } = require('./orderDelivery');
const { recommendCarts, cartFloorFit } = require('./loadPlan');

const HISTORY_DAYS = 84;          // 12 semaines
const MIN_RUNS_WEEKDAY = 3;       // en dessous, on utilise tous les jours de passage de la tournée
const OK_RATIO = 0.85;            // au-delà de 85 % de la capacité en charge forte : « juste »
const RANK = { inconnu: 0, ok: 1, juste: 2, depasse: 3 };
const r1 = (x) => Math.round(x * 10) / 10;

function settings() {
  return db.prepare('SELECT truck_capacity_kg AS truckKg, cart_weight_kg AS cartKg, max_cart_weight_kg AS cartMaxKg FROM admin WHERE id = 1').get()
    || { truckKg: 1200, cartKg: 20, cartMaxKg: 120 };
}
const cartTypes = () => db.prepare('SELECT * FROM cart_types ORDER BY length_cm * width_cm * height_cm DESC').all()
  .map(c => ({ name: c.name, lengthCm: c.length_cm, widthCm: c.width_cm, heightCm: c.height_cm, volumeL: c.length_cm * c.width_cm * c.height_cm / 1000 }));
const truckOf = (t) => (t ? { id: t.id, name: t.name, lengthCm: t.length_cm, widthCm: t.width_cm, heightCm: t.height_cm, volumeL: t.length_cm * t.width_cm * t.height_cm / 1000 } : null);

/** Les chariots qui peuvent entrer dans ce camion (hauteur et plancher) ; tous si le camion est inconnu. */
const usableCarts = (types, truck) => (truck ? types.filter(c => cartFloorFit(c, truck) > 0) : types);

/** Chariots nécessaires pour ce linge : au moins ce que demande le volume, et au moins ce que permet le poids maximal par chariot. */
function cartsFor(volumeL, linenKg, st, types) {
  const list = recommendCarts(volumeL, types).map(c => ({ ...c }));
  let count = list.reduce((a, c) => a + c.count, 0);
  if (types.length && st.cartMaxKg > 0) {
    const need = Math.ceil(linenKg / st.cartMaxKg);
    if (need > count) {
      const small = types[types.length - 1];
      const e = list.find(c => c.name === small.name);
      if (e) e.count += need - count; else list.push({ name: small.name, count: need - count });
      count = need;
    }
  }
  return { list, count };
}

/** Charge d'un chargement : poids total (linge + chariots vides), volume, chariots et part de plancher occupée. */
function loadOf(volumeL, linenKg, st, types, truck) {
  const carts = cartsFor(volumeL, linenKg, st, types);
  let floorUse = null;
  if (truck) {
    floorUse = 0;
    for (const c of carts.list) {
      const fit = cartFloorFit(types.find(t => t.name === c.name), truck);
      floorUse += fit > 0 ? c.count / fit : Infinity;
    }
  }
  return { weightKg: linenKg + carts.count * st.cartKg, linenKg, volumeL, carts: carts.count, floorUse };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
function stat(runs, key) {
  const v = runs.map(r => r[key]).filter(x => x != null);
  if (!v.length) return { typical: null, high: null, max: null };
  return { typical: mean(v), high: pct(v, 0.9), max: Math.max(...v) };
}
const rnd = (x) => (x == null ? null : x === Infinity ? Infinity : r1(x));

/** Dimensions comparées à la capacité : { key, label, unit, capacity, typical, high, max, ratio: { typical, high, max } }. */
function dims(runs, cap, truck, types) {
  const out = [];
  const w = stat(runs, 'weightKg');
  if (cap.truckKg > 0) out.push({ key: 'weight', label: 'Poids', unit: 'kg', capacity: cap.truckKg, typical: rnd(w.typical), high: rnd(w.high), max: rnd(w.max), r: { typical: w.typical / cap.truckKg, high: w.high / cap.truckKg, max: w.max / cap.truckKg } });
  if (truck) {
    const v = stat(runs, 'volumeL');
    out.push({ key: 'volume', label: 'Volume', unit: 'm³', capacity: r1(truck.volumeL / 1000), typical: rnd(v.typical / 1000), high: rnd(v.high / 1000), max: rnd(v.max / 1000), r: { typical: v.typical / truck.volumeL, high: v.high / truck.volumeL, max: v.max / truck.volumeL } });
    if (types.length) {
      const f = stat(runs, 'floorUse'), c = stat(runs, 'carts');
      // places « équivalentes » : combien de chariots de ce mélange tiendraient sur le plancher
      const places = f.high && f.high !== Infinity ? Math.floor(c.high / f.high + 1e-9) : null;
      out.push({ key: 'carts', label: 'Chariots', unit: '', capacity: places, typical: rnd(c.typical), high: rnd(c.high), max: rnd(c.max), tooTall: f.high === Infinity || f.max === Infinity, r: { typical: f.typical, high: f.high, max: f.max } });
    }
  }
  return out;
}

function verdictOf(ds) {
  const at = (k) => Math.max(0, ...ds.map(d => d.r[k]).filter(x => x != null && !Number.isNaN(x)));
  const t = at('typical'), h = at('high'), m = at('max');
  const v = (t > 1 || h > 1) ? 'depasse' : (h > OK_RATIO || m > 1) ? 'juste' : 'ok';
  const limiting = ds.slice().sort((a, b) => (b.r.high ?? 0) - (a.r.high ?? 0))[0];
  return { verdict: v, ratio: Number.isFinite(h) ? Math.round(h * 100) / 100 : null, limiting: limiting ? limiting.key : null, peak: m > 1 && h <= 1 };
}

// ---------- historique ----------
function dateOf(o) {
  if (o.delivered_at) return parisDay(o.delivered_at);
  return (o.livraison_prevue || String(o.created_at || '').slice(0, 10) || '').slice(0, 10);
}

function ordersLoad(orderRows, items) {
  const by = new Map();
  for (const o of orderRows) by.set(o.id, { order: o, linenKg: 0, volumeL: 0, qty: 0, qtyW: 0, qtyV: 0 });
  for (const it of items) {
    const a = by.get(it.order_id); if (!a) continue;
    const q = it.delivered_qty != null ? it.delivered_qty : it.qty;
    if (!(q > 0)) continue;
    const vol = (it.fw || 0) * (it.fl || 0) * (it.fh || 0) / 1000;
    a.qty += q;
    if (it.wg > 0) { a.linenKg += q * it.wg / 1000; a.qtyW += q; }
    if (vol > 0) { a.volumeL += q * vol; a.qtyV += q; }
  }
  return [...by.values()];
}
const itemsSql = (marks) => `SELECT oi.order_id, oi.qty, oi.delivered_qty, a.weight_g AS wg, a.folded_width_cm AS fw, a.folded_length_cm AS fl, a.folded_height_cm AS fh
  FROM order_items oi LEFT JOIN articles a ON a.id = oi.service_id WHERE oi.order_id IN (${marks})`;

function nextRun(date, days) { for (let i = 0; i < 8; i += 1) { const d = ft.addDays(date, i); if (days.includes(ft.weekdayOf(d))) return d; } return null; }

function tourHistory(tour, clientIds, today, st, types, truck) {
  const empty = { orders: 0, runs: 0, weeks: 0, coverage: { weightPct: null, volumePct: null }, byWeekday: {}, all: [], clients: [] };
  if (!clientIds.length || !tour.weekdays.length) return empty;
  const since = ft.addDays(today, -HISTORY_DAYS);
  const marks = clientIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, client_id, delivered_at, livraison_prevue, created_at FROM orders
    WHERE status = 'livree' AND collect_only = 0 AND client_id IN (${marks}) AND COALESCE(delivered_at, livraison_prevue, created_at) >= ?`).all(...clientIds, ft.addDays(since, -1))
    .map(o => ({ ...o, day: dateOf(o) })).filter(o => ft.isDate(o.day) && o.day >= since && o.day < today);
  if (!rows.length) return { ...empty, clients: clientIds.map(id => ({ clientId: id, deliveries: 0 })) };
  const items = rows.length ? db.prepare(itemsSql(rows.map(() => '?').join(','))).all(...rows.map(o => o.id)) : [];
  const loads = ordersLoad(rows, items);

  const qty = loads.reduce((a, l) => a + l.qty, 0);
  const coverage = { weightPct: qty ? Math.round(100 * loads.reduce((a, l) => a + l.qtyW, 0) / qty) : null, volumePct: qty ? Math.round(100 * loads.reduce((a, l) => a + l.qtyV, 0) / qty) : null };

  // rejeu : chaque commande part au prochain passage de la tournée
  const start = rows.reduce((m, o) => (o.day < m ? o.day : m), today);
  const yesterday = ft.addDays(today, -1);
  const perRun = new Map();
  for (let d = start; d <= yesterday; d = ft.addDays(d, 1)) if (tour.weekdays.includes(ft.weekdayOf(d))) perRun.set(d, { linenKg: 0, volumeL: 0 });
  for (const l of loads) {
    const run = nextRun(l.order.day, tour.weekdays);
    const slot = run && perRun.get(run);
    if (slot) { slot.linenKg += l.linenKg; slot.volumeL += l.volumeL; }
  }
  const runs = [...perRun.entries()].map(([date, x]) => ({ date, weekday: ft.weekdayOf(date), ...loadOf(x.volumeL, x.linenKg, st, types, truck) }));
  const byWeekday = {};
  for (const wd of tour.weekdays) byWeekday[wd] = runs.filter(r => r.weekday === wd);

  const weeks = Math.max(1, Math.round((Date.parse(today) - Date.parse(start)) / (7 * 86400000)));
  const clients = clientIds.map(id => {
    const mine = loads.filter(l => l.order.client_id === id);
    return {
      clientId: id, deliveries: mine.length, perWeek: r1(mine.length / weeks),
      avgWeightKg: mine.length ? r1(mean(mine.map(l => l.linenKg))) : null, avgVolumeL: mine.length ? r1(mean(mine.map(l => l.volumeL))) : null,
    };
  });
  return { orders: rows.length, runs: runs.length, weeks, since: start, coverage, byWeekday, all: runs, clients };
}

/** Pour un jour de la semaine : les passages de ce jour s'ils sont assez nombreux, sinon tous les passages de la tournée. */
function profileFor(hist, wd, cap, truck, types) {
  const same = hist.byWeekday[wd] || [];
  const scope = same.length >= MIN_RUNS_WEEKDAY ? 'weekday' : 'all';
  const runs = scope === 'weekday' ? same : hist.all;
  if (!runs.length) return null;
  const ds = dims(runs, cap, truck, types);
  return { weekday: wd, scope, runs: runs.length, dims: ds, ...verdictOf(ds) };
}

/**
 * Commandes déjà reçues (pas encore livrées) qui partiront avec cette tournée, regroupées par date de passage :
 * celles déjà affectées à la tournée, et celles sans chauffeur dont la prochaine tournée est celle-ci (comme assignPending).
 */
function knownLoads(tour, clientIds, today, st, types, truck, cap) {
  const out = new Map();
  if (!clientIds.length || !tour.weekdays.length) return out;
  const marks = clientIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, client_id, driver_id, tour_id, livraison_prevue FROM orders
    WHERE status IN ('recue', 'traitement', 'prete') AND collect_only = 0 AND client_id IN (${marks})`).all(...clientIds);
  const byDate = new Map();
  for (const o of rows) {
    const ref = ft.isDate(o.livraison_prevue) && o.livraison_prevue > today ? o.livraison_prevue : today;
    let mine = false;
    if (o.tour_id === tour.id) mine = true;
    else if (o.driver_id == null && o.tour_id == null) { const slot = ft.nextSlot(o.client_id, ref); mine = !!slot && slot.tourId === tour.id; }
    if (!mine) continue;
    const date = nextRun(ref, tour.weekdays);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(o);
  }
  for (const [date, list] of byDate) {
    const items = db.prepare(itemsSql(list.map(() => '?').join(','))).all(...list.map(o => o.id));
    const loads = ordersLoad(list.map(o => ({ ...o, day: '' })), items.map(i => ({ ...i, delivered_qty: null })));
    const l = loadOf(loads.reduce((a, x) => a + x.volumeL, 0), loads.reduce((a, x) => a + x.linenKg, 0), st, types, truck);
    const ds = dims([l], cap, truck, types);
    out.set(date, { orders: list.length, weightKg: r1(l.weightKg), linenKg: r1(l.linenKg), volumeM3: r1(l.volumeL / 1000), carts: l.carts, ...verdictOf(ds), dims: ds });
  }
  return out;
}

/** Camions du parc qui feraient mieux que l'actuel pour cette charge (du plus petit au plus grand), 3 au plus. */
function suggestTrucks(profile, hist, cap, st, types, current) {
  if (!profile || profile.verdict === 'ok') return [];
  const source = profile.scope === 'weekday' ? (hist.byWeekday[profile.weekday] || []) : hist.all;
  const trucks = db.prepare('SELECT * FROM truck_types ORDER BY length_cm * width_cm * height_cm').all().map(truckOf);
  const out = [];
  for (const t of trucks) {
    if (current && t.id === current.id) continue;
    const ct = usableCarts(types, t);
    const rerun = source.map(r => loadOf(r.volumeL, r.linenKg, st, ct, t));
    const v = verdictOf(dims(rerun, cap, t, ct));
    if (RANK[v.verdict] < RANK[profile.verdict]) out.push({ name: t.name, verdict: v.verdict, volumeM3: r1(t.volumeL / 1000) });
    if (out.length >= 3) break;
  }
  return out;
}

/** Prévision de charge de toutes les tournées actives sur les `days` prochains jours. */
function forecast({ days = 28, today = parisDay() } = {}) {
  const st = settings(), allTypes = cartTypes();
  const cap = { truckKg: st.truckKg };
  const tours = db.prepare('SELECT * FROM fixed_tours WHERE active = 1 ORDER BY name COLLATE NOCASE, id').all()
    .map(t => ({ ...t, weekdays: ft.parseDays(t.weekdays) }));
  const drivers = Object.fromEntries(db.prepare(`SELECT d.id, d.name, d.vehicle, t.id AS tid, t.name AS tname, t.length_cm, t.width_cm, t.height_cm FROM drivers d LEFT JOIN truck_types t ON t.id = d.truck_type_id`).all().map(d => [d.id, d]));
  const outTours = []; const runs = [];

  for (const t of tours) {
    const d = t.driver_id ? drivers[t.driver_id] : null;
    const truck = d && d.tid ? truckOf({ id: d.tid, name: d.tname, length_cm: d.length_cm, width_cm: d.width_cm, height_cm: d.height_cm }) : null;
    const types = usableCarts(allTypes, truck);
    const clientIds = db.prepare('SELECT client_id FROM fixed_tour_clients WHERE tour_id = ? ORDER BY position').all(t.id).map(r => r.client_id);
    const names = Object.fromEntries(db.prepare(`SELECT id, societe FROM clients WHERE id IN (${clientIds.map(() => '?').join(',') || 'NULL'})`).all(...clientIds).map(c => [c.id, c.societe]));
    const hist = tourHistory(t, clientIds, today, st, types, truck);
    const profiles = {};
    for (const wd of t.weekdays) profiles[wd] = profileFor(hist, wd, cap, truck, types);
    const known = knownLoads(t, clientIds, today, st, types, truck, cap);

    const warnings = [];
    if (!clientIds.length) warnings.push('Aucun hôtel dans cette tournée.');
    else if (!t.weekdays.length) warnings.push('Aucun jour de passage.');
    else if (!hist.orders) warnings.push('Aucune livraison dans les 12 dernières semaines pour ces hôtels : pas d\'historique pour estimer la charge.');
    if (hist.orders && ((hist.coverage.weightPct != null && hist.coverage.weightPct < 90) || (hist.coverage.volumePct != null && hist.coverage.volumePct < 90))) {
      warnings.push(`Poids ou dimensions manquants sur une partie des articles livrés (poids connu sur ${hist.coverage.weightPct} % des pièces, volume sur ${hist.coverage.volumePct} %) : la charge est sous-estimée. À compléter dans Gestion des articles.`);
    }
    if (hist.orders && hist.orders < 8) warnings.push(`Historique court (${hist.orders} livraison${hist.orders > 1 ? 's' : ''}) : estimation à prendre avec prudence.`);
    if (!d) warnings.push('Aucun chauffeur : capacité du camion inconnue (seul le poids est comparé).');
    else if (!truck) warnings.push(`Aucun type de camion rattaché à ${d.name} : seul le poids est comparé (rattachez un camion dans Équipement).`);
    if (truck && !allTypes.length) warnings.push('Aucun type de chariot défini : le nombre de chariots n\'est pas comparé.');
    else if (truck && !types.length) warnings.push(`Aucun type de chariot ne rentre dans ${truck.name} (hauteur ${truck.heightCm} cm) : le nombre de chariots n'est pas comparé.`);
    for (const c of hist.clients) if (!c.deliveries && hist.orders) warnings.push(`${names[c.clientId] || 'Un hôtel'} : aucune livraison dans l'historique.`);

    const worst = Object.values(profiles).filter(Boolean).reduce((m, p) => (RANK[p.verdict] > RANK[m] ? p.verdict : m), 'inconnu');
    const firstProfile = Object.values(profiles).filter(Boolean).sort((a, b) => RANK[b.verdict] - RANK[a.verdict])[0] || null;
    outTours.push({
      id: t.id, name: t.name, weekdays: t.weekdays, driverId: t.driver_id, driverName: d ? d.name : null,
      truck: truck ? { name: truck.name, volumeM3: r1(truck.volumeL / 1000), lengthCm: truck.lengthCm, widthCm: truck.widthCm, heightCm: truck.heightCm } : null,
      capacity: { weightKg: cap.truckKg, volumeM3: truck ? r1(truck.volumeL / 1000) : null },
      history: { orders: hist.orders, runs: hist.runs, weeks: hist.weeks || 0, coverage: hist.coverage },
      clients: hist.clients.map(c => ({ ...c, societe: names[c.clientId] || '' })),
      profiles, verdict: worst, suggestions: suggestTrucks(firstProfile, hist, cap, st, allTypes, truck), warnings,
    });

    // prochains passages
    for (let i = 0; i < days; i += 1) {
      const date = ft.addDays(today, i); const wd = ft.weekdayOf(date);
      if (!t.weekdays.includes(wd)) continue;
      const p = profiles[wd];
      let verdict = p ? p.verdict : 'inconnu', ratio = p ? p.ratio : null, limiting = p ? p.limiting : null;
      const run = { date, weekday: wd, tourId: t.id, tourName: t.name, driverName: d ? d.name : null, clients: clientIds.length };
      const k = known.get(date);
      if (k) {
        run.known = k;
        if (RANK[k.verdict] > RANK[verdict]) { verdict = k.verdict; ratio = k.ratio; limiting = k.limiting; }
      }
      runs.push({ ...run, verdict, ratio, limiting });
    }
  }
  runs.sort((a, b) => a.date.localeCompare(b.date) || a.tourName.localeCompare(b.tourName));
  return { from: today, days, settings: { truckKg: st.truckKg, cartKg: st.cartKg, cartMaxKg: st.cartMaxKg, historyWeeks: HISTORY_DAYS / 7 }, tours: outTours, runs };
}

module.exports = { forecast, HISTORY_DAYS, OK_RATIO };
