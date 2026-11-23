// Prévision de production : l'équipe saisit à l'avance les lots d'un jour à venir (type de linge, clients et commandes, poids
// estimé, laveuse et programme souhaités). Une prévision n'est pas un lot : elle n'occupe aucune machine et n'entre dans aucun chiffre.
// Le jour J, on la « lance » : un vrai lot est créé (lavage démarré) et la prévision est marquée « lancée ».
const db = require('../db');
const rh = require('./rh');
const P = require('./prodStore');
const W = require('./washPlan');

const MAX_AHEAD_DAYS = 60;
const MAX_PER_DAY = 80;
const { bad, clean, round1 } = P;
const MAX_LINES = 6;
const FAMILY_IDS = new Set(W.FAMILIES.map(f => f.id));

const today = (nowMs = Date.now()) => rh.parisDate(nowMs);

function readDay(v, nowMs) {
  const day = String(v || '');
  if (!rh.isDate(day)) throw bad('Jour invalide.', 'BAD_DAY');
  const t = today(nowMs);
  if (day < t) throw bad('On ne prévoit qu\'à partir d\'aujourd\'hui.', 'BAD_DAY');
  if ((Date.parse(day) - Date.parse(t)) / rh.DAY > MAX_AHEAD_DAYS) throw bad(`Prévision limitée à ${MAX_AHEAD_DAYS} jours.`, 'BAD_DAY');
  return day;
}

const optKg = (v, label) => (v === undefined || v === null || v === '' ? null : P.parseKg(v, label));

// ---------- répartition par type de pièce et machines par étape ----------
const loadFamilies = (id) => Object.fromEntries(db.prepare('SELECT family, weight_kg FROM lot_forecast_families WHERE forecast_id = ?').all(id).map(r => [r.family, r.weight_kg]));
const loadLines = (id) => db.prepare('SELECT * FROM lot_forecast_machines WHERE forecast_id = ? ORDER BY stage, position, id').all(id)
  .map(l => ({ stage: l.stage, machineId: l.machine_id, programId: l.program_id, weightKg: l.weight_kg }));

/** { grand_plat: 40, eponge: 12 } → kilos par type de pièce (les zéros et vides sont ignorés). null ou {} efface la répartition. */
function readFamilies(v) {
  if (v === null || v === undefined) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('Répartition par type de pièce invalide.', 'BAD_FAMILIES');
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!FAMILY_IDS.has(k)) throw bad(`Type de pièce inconnu : ${k}.`, 'BAD_FAMILIES');
    if (raw === '' || raw === null || raw === undefined || Number(String(raw).replace(',', '.')) === 0) continue;
    out[k] = P.parseKg(raw, `Le poids « ${W.FAMILIES.find(f => f.id === k).label} »`);
  }
  return out;
}

/** Poids total et répartition retenus : dès qu'il y a une répartition par type de pièce, sa somme fait le poids du lot (un poids saisi à côté doit lui correspondre). */
function resolveWeight(b, cur) {
  const famsGiven = b.families !== undefined;
  const families = famsGiven ? readFamilies(b.families) : (cur ? loadFamilies(cur.id) : {});
  const sum = round1(Object.values(families).reduce((a, x) => a + x, 0));
  const given = b.weightKg !== undefined ? optKg(b.weightKg, 'Le poids prévu') : undefined;
  let weightKg = given !== undefined ? given : (cur ? cur.weight_kg : null);
  if (sum > 0) {
    if (given != null && Math.abs(given - sum) > 0.15) throw bad(`Le poids total (${given} kg) ne correspond pas à la somme des types de pièces (${sum} kg).`, 'BAD_WEIGHT');
    weightKg = sum;
  }
  return { families, famsGiven, weightKg };
}

/** { lavage: [{machineId, programId, weightKg}], sechage: [...], finition: [...] } → lignes validées (kilos vides = part automatique). */
function readMachines(v, totalKg) {
  if (v === null || v === undefined) return [];
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('Machines invalides.', 'BAD_MACHINES');
  const out = [];
  for (const stage of Object.keys(v)) {
    if (!W.STAGES.includes(stage)) throw bad(`Étape inconnue : ${stage}.`, 'BAD_STAGE');
    const arr = v[stage];
    if (!Array.isArray(arr)) throw bad('Machines invalides.', 'BAD_MACHINES');
    if (arr.length > MAX_LINES) throw bad(`Au plus ${MAX_LINES} machines par étape.`, 'TOO_MANY');
    const seen = new Set();
    let given = 0;
    for (const l of arr) {
      const m = P.checkMachine(stage, (l || {}).machineId, 0);     // la capacité n'est pas un plafond ici : au-delà, la machine fait plusieurs passages
      if (seen.has(m.id)) throw bad(`${m.name} est déjà dans cette étape.`, 'DUPLICATE_MACHINE');
      seen.add(m.id);
      let programId = null;
      if (l.programId !== undefined && l.programId !== null && l.programId !== '') {
        if (stage !== 'lavage') throw bad('Un programme ne se choisit que pour le lavage.', 'BAD_PROGRAM');
        const pr = db.prepare('SELECT * FROM wash_programs WHERE id = ?').get(Number(l.programId));
        if (!pr || !pr.active) throw bad('Programme inconnu ou retiré.', 'BAD_PROGRAM');
        programId = pr.id;
      }
      const weightKg = l.weightKg === undefined || l.weightKg === null || l.weightKg === '' ? null : P.parseKg(l.weightKg, `Les kilos de ${m.name}`);
      if (weightKg != null) given += weightKg;
      out.push({ stage, machineId: m.id, programId, weightKg });
    }
    if (totalKg != null && given > totalKg + 0.05) throw bad(`Les kilos répartis en ${W.LABEL[stage].toLowerCase()} (${round1(given)} kg) dépassent le poids du lot (${totalKg} kg).`, 'BAD_WEIGHT');
  }
  return out;
}

function writeFamilies(id, families) {
  db.prepare('DELETE FROM lot_forecast_families WHERE forecast_id = ?').run(id);
  const ins = db.prepare('INSERT INTO lot_forecast_families (forecast_id, family, weight_kg) VALUES (?, ?, ?)');
  for (const [k, kg] of Object.entries(families)) ins.run(id, k, kg);
}
function writeLines(id, lines) {
  db.prepare('DELETE FROM lot_forecast_machines WHERE forecast_id = ?').run(id);
  const ins = db.prepare('INSERT INTO lot_forecast_machines (forecast_id, stage, position, machine_id, program_id, weight_kg) VALUES (?, ?, ?, ?, ?, ?)');
  const pos = {};
  for (const l of lines) { pos[l.stage] = (pos[l.stage] || 0) + 1; ins.run(id, l.stage, pos[l.stage], l.machineId, l.programId, l.weightKg); }
}

/** Lignes à estimer pour une prévision : celles saisies, sinon la laveuse prévue à l'ancienne (colonnes machine_id / program_id). */
function linesOf(f) {
  const lines = loadLines(f.id);
  if (!lines.some(l => l.stage === 'lavage') && f.machine_id) lines.unshift({ stage: 'lavage', machineId: f.machine_id, programId: f.program_id, weightKg: null });
  return lines;
}

/** Durée estimée d'un brouillon (formulaire en cours de saisie) : même calcul que celui d'une prévision enregistrée, rien n'est écrit. */
function estimateDraft(o) {
  const b = o || {};
  const w = resolveWeight(b, null);
  const lines = readMachines(b.machines, w.weightKg);
  return { ...planOut(w.weightKg, w.families, lines) };
}

function planOut(weightKg, families, lines) {
  const est = W.estimate({ totalKg: weightKg, lines });
  const famSum = round1(Object.values(families || {}).reduce((a, x) => a + x, 0));
  return { weightKg, families: famSum > 0 ? W.familyList(families) : [], ...est };
}

/** Valide une saisie complète (création) ou partielle (modification, `cur` = prévision actuelle). */
function read(o, cur, nowMs) {
  const b = o || {};
  const has = (k) => b[k] !== undefined;
  const out = {};
  out.day = has('day') || !cur ? readDay(b.day, nowMs) : cur.day;

  const typeId = has('linenTypeId') || !cur ? Number(b.linenTypeId) : cur.linen_type_id;
  const type = db.prepare('SELECT * FROM linen_types WHERE id = ?').get(typeId);
  if (!type || (!type.active && !(cur && cur.linen_type_id === type.id))) throw bad('Choisissez le type de linge.', 'BAD_TYPE');
  out.linenTypeId = type.id;

  const w = resolveWeight(b, cur);
  out.weightKg = w.weightKg;
  out.families = w.families; out.famsGiven = w.famsGiven;

  // Machines prévues : `machines` (plusieurs par étape) ou, comme avant, une seule laveuse `machineId` / `programId`.
  out.lines = null;                                                  // null = inchangées
  if (has('machines')) out.lines = readMachines(b.machines, out.weightKg);
  else if (has('machineId') || has('programId')) {
    const keep = cur ? loadLines(cur.id).filter(l => l.stage !== 'lavage') : [];
    const machineId = has('machineId') ? (b.machineId === null || b.machineId === '' ? null : P.checkMachine('lavage', b.machineId, out.weightKg || 0).id) : (cur ? cur.machine_id : null);
    let programId = has('programId') ? null : (cur ? cur.program_id : null);
    if (has('programId') && b.programId !== null && b.programId !== '') {
      const pr = db.prepare('SELECT * FROM wash_programs WHERE id = ?').get(Number(b.programId));
      if (!pr || !pr.active) throw bad('Programme inconnu ou retiré.', 'BAD_PROGRAM');
      programId = pr.id;
    }
    out.lines = machineId ? [{ stage: 'lavage', machineId, programId, weightKg: null }, ...keep] : keep;
  }
  const first = out.lines ? out.lines.find(l => l.stage === 'lavage') : null;
  out.machineId = out.lines ? (first ? first.machineId : null) : (cur ? cur.machine_id : null);
  out.programId = out.lines ? (first ? first.programId : null) : (cur ? cur.program_id : null);

  out.note = has('note') ? (clean(b.note, 300) || null) : (cur ? cur.note : null);

  if (has('clients') || !cur) out.clients = P.resolveClients(b.clients, out.weightKg);
  return out;
}

function forecastOut(f, clients) {
  const type = f.linen_type_id ? db.prepare('SELECT label FROM linen_types WHERE id = ?').get(f.linen_type_id) : null;
  const m = f.machine_id ? db.prepare('SELECT name FROM machines WHERE id = ?').get(f.machine_id) : null;
  const pr = f.program_id ? db.prepare('SELECT name FROM wash_programs WHERE id = ?').get(f.program_id) : null;
  const lot = f.lot_id ? db.prepare('SELECT code, status FROM lots WHERE id = ?').get(f.lot_id) : null;
  const cl = (clients || db.prepare('SELECT * FROM lot_forecast_clients WHERE forecast_id = ? ORDER BY id').all(f.id)).map(c => ({
    clientId: c.client_id, societe: c.societe, orderId: c.order_id, weightKg: c.weight_kg,
    orderTicket: c.order_id ? (db.prepare('SELECT ticket FROM orders WHERE id = ?').get(c.order_id) || {}).ticket || null : null,
  }));
  const families = loadFamilies(f.id);
  const lines = linesOf(f);
  const plan = planOut(f.weight_kg, families, lines);
  // Premier passage à lancer : la première laveuse prévue, avec au plus sa capacité (les charges suivantes se lancent ensuite, passage par passage).
  const w1 = plan.stages.lavage.lines[0];
  const firstPass = w1 ? { machineId: w1.machineId, programId: w1.programId, weightKg: w1.weightKg != null ? (w1.capacityKg ? Math.min(w1.weightKg, w1.capacityKg) : w1.weightKg) : null, others: plan.stages.lavage.lines.slice(1).map(x => x.machineName) } : null;
  return {
    id: f.id, day: f.day, position: f.position, status: f.status, linenTypeId: f.linen_type_id, linenType: type ? type.label : null,
    weightKg: f.weight_kg, machineId: f.machine_id, machineName: m ? m.name : null, programId: f.program_id, programName: pr ? pr.name : null,
    note: f.note, lotId: f.lot_id, lotCode: lot ? lot.code : null, lotStatus: lot ? lot.status : null, clients: cl,
    families: plan.families, machines: lines, plan, firstPass,
  };
}

const byId = (id) => db.prepare('SELECT * FROM lot_forecasts WHERE id = ?').get(Number(id));
const get = (id) => { const f = byId(id); return f ? forecastOut(f) : null; };
const list = (day) => db.prepare('SELECT * FROM lot_forecasts WHERE day = ? ORDER BY position, id').all(day).map(f => forecastOut(f));

/** Prévisions pas encore lancées dont le jour est arrivé (aujourd'hui ou un jour passé) : à lancer. */
const due = (nowMs = Date.now()) => db.prepare("SELECT * FROM lot_forecasts WHERE status = 'prevu' AND day <= ? ORDER BY day, position, id").all(today(nowMs)).map(f => forecastOut(f));

function totals(forecasts) {
  const live = forecasts.filter(f => f.status !== 'annule');
  return {
    count: live.length, pending: live.filter(f => f.status === 'prevu').length, launched: live.filter(f => f.status === 'lance').length,
    kg: round1(live.reduce((a, f) => a + (f.weightKg || 0), 0)), withoutWeight: live.filter(f => f.weightKg == null).length,
    clients: new Set(live.flatMap(f => f.clients.map(c => c.clientId || c.societe))).size,
  };
}

/** Une ligne par jour sur les `n` jours à partir de `from` : nombre de lots prévus et kilos. */
function upcoming(from, n = 7) {
  const days = Array.from({ length: n }, (_, i) => rh.addDays(from, i));
  const rows = db.prepare('SELECT day, COUNT(*) AS n, COALESCE(SUM(weight_kg), 0) AS kg FROM lot_forecasts WHERE day >= ? AND day <= ? GROUP BY day').all(days[0], days[n - 1]);
  return days.map(d => { const r = rows.find(x => x.day === d); return { day: d, count: r ? r.n : 0, kg: r ? round1(r.kg) : 0 }; });
}

/** Commandes reçues ou en traitement qui ne sont encore dans aucun lot ni aucune prévision, avec leur poids estimé (articles × poids catalogue). */
function pendingOrders() {
  const rows = db.prepare(`
    SELECT o.id, o.ticket, o.client_id, o.societe, o.livraison_prevue, o.status,
      COALESCE((SELECT SUM(oi.qty * a.weight_g) / 1000.0 FROM order_items oi JOIN articles a ON a.id = oi.service_id WHERE oi.order_id = o.id AND oi.qty > 0 AND a.weight_g > 0), 0) AS kg
    FROM orders o
    WHERE o.status IN ('recue', 'traitement') AND o.client_id IS NOT NULL
      AND o.id NOT IN (SELECT order_id FROM lot_clients WHERE order_id IS NOT NULL)
      AND o.id NOT IN (SELECT order_id FROM lot_forecast_clients WHERE order_id IS NOT NULL)
    ORDER BY (o.livraison_prevue IS NULL OR o.livraison_prevue = ''), o.livraison_prevue, o.id LIMIT 100`).all();
  return rows.map(r => ({ orderId: r.id, ticket: r.ticket, clientId: r.client_id, societe: r.societe, deliveryDate: r.livraison_prevue || null, status: r.status, estimatedKg: r.kg > 0 ? round1(r.kg) : null }));
}

function insertClients(forecastId, clients) {
  const ins = db.prepare('INSERT INTO lot_forecast_clients (forecast_id, client_id, societe, order_id, weight_kg) VALUES (?, ?, ?, ?, ?)');
  clients.forEach(c => ins.run(forecastId, c.clientId, c.societe, c.orderId, c.weightKg));
}
const nextPosition = (day) => (db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM lot_forecasts WHERE day = ?').get(day).m) + 1;

function create(o, nowMs = Date.now()) {
  const v = read(o, null, nowMs);
  if (db.prepare('SELECT COUNT(*) AS n FROM lot_forecasts WHERE day = ?').get(v.day).n >= MAX_PER_DAY) throw bad('Trop de lots prévus ce jour-là.', 'TOO_MANY');
  return db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO lot_forecasts (day, position, linen_type_id, weight_kg, machine_id, program_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(v.day, nextPosition(v.day), v.linenTypeId, v.weightKg, v.machineId, v.programId, v.note).lastInsertRowid);
    insertClients(id, v.clients);
    writeFamilies(id, v.families);
    if (v.lines) writeLines(id, v.lines);
    return id;
  })();
}

function requirePlanned(id) {
  const f = byId(id);
  if (!f) throw bad('Prévision introuvable.', 'NOT_FOUND', 404);
  if (f.status !== 'prevu') throw bad('Ce lot a déjà été lancé.', 'ALREADY_LAUNCHED', 409);
  return f;
}

function update(id, o, nowMs = Date.now()) {
  const cur = requirePlanned(id);
  const v = read(o, cur, nowMs);
  db.transaction(() => {
    const position = v.day === cur.day ? cur.position : nextPosition(v.day);
    db.prepare("UPDATE lot_forecasts SET day = ?, position = ?, linen_type_id = ?, weight_kg = ?, machine_id = ?, program_id = ?, note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(v.day, position, v.linenTypeId, v.weightKg, v.machineId, v.programId, v.note, cur.id);
    if (v.clients) { db.prepare('DELETE FROM lot_forecast_clients WHERE forecast_id = ?').run(cur.id); insertClients(cur.id, v.clients); }
    if (v.famsGiven) writeFamilies(cur.id, v.families);
    if (v.lines) writeLines(cur.id, v.lines);
  })();
}

function remove(id) { requirePlanned(id); db.prepare('DELETE FROM lot_forecasts WHERE id = ?').run(Number(id)); }

/** Remonte ou descend une prévision dans l'ordre de passage du jour. */
function move(id, direction) {
  const f = byId(id);
  if (!f) throw bad('Prévision introuvable.', 'NOT_FOUND', 404);
  const ids = db.prepare('SELECT id FROM lot_forecasts WHERE day = ? ORDER BY position, id').all(f.day).map(r => r.id);
  const i = ids.indexOf(f.id), j = direction === 'up' ? i - 1 : direction === 'down' ? i + 1 : null;
  if (j === null) throw bad('Sens inconnu.');
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const set = db.prepare('UPDATE lot_forecasts SET position = ? WHERE id = ?');
  db.transaction(() => ids.forEach((x, k) => set.run(k, x)))();
}

/** Recopie les prévisions d'un jour sur un autre (sans les commandes liées, propres à chaque jour) : « même production que la semaine dernière ». */
function copyDay(from, to, nowMs = Date.now()) {
  if (!rh.isDate(String(from || ''))) throw bad('Jour d\'origine invalide.', 'BAD_DAY');
  const dest = readDay(to, nowMs);
  if (from === dest) throw bad('Choisissez un autre jour que celui d\'origine.', 'BAD_DAY');
  const src = db.prepare('SELECT * FROM lot_forecasts WHERE day = ? ORDER BY position, id').all(from);
  if (!src.length) throw bad('Aucun lot prévu ce jour-là.', 'EMPTY');
  if (db.prepare('SELECT COUNT(*) AS n FROM lot_forecasts WHERE day = ?').get(dest).n + src.length > MAX_PER_DAY) throw bad('Trop de lots prévus ce jour-là.', 'TOO_MANY');
  return db.transaction(() => {
    for (const f of src) {
      const id = Number(db.prepare('INSERT INTO lot_forecasts (day, position, linen_type_id, weight_kg, machine_id, program_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(dest, nextPosition(dest), f.linen_type_id, f.weight_kg, f.machine_id, f.program_id, f.note).lastInsertRowid);
      db.prepare('INSERT INTO lot_forecast_clients (forecast_id, client_id, societe, order_id, weight_kg) SELECT ?, client_id, societe, NULL, weight_kg FROM lot_forecast_clients WHERE forecast_id = ?').run(id, f.id);
      db.prepare('INSERT INTO lot_forecast_families (forecast_id, family, weight_kg) SELECT ?, family, weight_kg FROM lot_forecast_families WHERE forecast_id = ?').run(id, f.id);
      db.prepare('INSERT INTO lot_forecast_machines (forecast_id, stage, position, machine_id, program_id, weight_kg) SELECT ?, stage, position, machine_id, program_id, weight_kg FROM lot_forecast_machines WHERE forecast_id = ?').run(id, f.id);
    }
    return src.length;
  })();
}

/**
 * Lance la prévision : crée le vrai lot (lavage démarré) à partir de ce que l'équipe a confirmé (`o`, même forme qu'un nouveau lot) ;
 * ce qui n'est pas précisé reprend la prévision. Possible dès que le jour de la prévision est arrivé.
 */
function launch(id, o, nowMs = Date.now()) {
  return db.transaction(() => {
    const f = requirePlanned(id);
    if (f.day > today(nowMs)) throw bad('Ce lot est prévu plus tard : changez son jour pour le lancer maintenant.', 'TOO_EARLY', 409);
    const b = o || {};
    const pick = (k, dflt) => (b[k] === undefined || b[k] === null || b[k] === '' ? dflt : b[k]);
    const clients = Array.isArray(b.clients) && b.clients.length ? b.clients
      : db.prepare('SELECT * FROM lot_forecast_clients WHERE forecast_id = ? ORDER BY id').all(f.id).map(c => ({ clientId: c.client_id || undefined, societe: c.client_id ? undefined : c.societe, orderId: c.order_id || undefined, weightKg: c.weight_kg || undefined }));
    const first = forecastOut(f).firstPass;   // plusieurs laveuses prévues : on lance la première charge de la première, les autres suivent passage par passage
    const lotId = P.createLot({
      ...b, nowMs, linenTypeId: pick('linenTypeId', f.linen_type_id), weightKg: pick('weightKg', first && first.weightKg != null ? first.weightKg : f.weight_kg),
      machineId: pick('machineId', first ? first.machineId : f.machine_id), programId: pick('programId', first ? first.programId : f.program_id),
      note: pick('note', f.note), clients, totalKg: f.weight_kg,
    });
    db.prepare("UPDATE lot_forecasts SET status = 'lance', lot_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(lotId, f.id);
    return lotId;
  })();
}

/** Tout ce que l'écran de prévision d'un jour affiche. */
function dayPlan(day, nowMs = Date.now()) {
  if (!rh.isDate(String(day || ''))) throw bad('Jour invalide.', 'BAD_DAY');
  const t = today(nowMs);
  const forecasts = list(day);
  return { day, today: t, forecasts, totals: totals(forecasts), upcoming: upcoming(t < day ? t : day, 7), orders: pendingOrders() };
}

module.exports = { MAX_AHEAD_DAYS, estimateDraft, create, update, remove, move, copyDay, launch, get, list, due, dayPlan, totals, upcoming, pendingOrders };
