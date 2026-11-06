// Production : lots de lavage, passages machine (lavage → séchage → finition), incidents, réglages, coûts et statistiques.
// Partagé par l'administration (routes/prod.js) et la tablette de l'atelier (routes/atelier.js).
const db = require('../db');
const rh = require('./rh');
const rhStore = require('./rhStore');
const { buildHours } = require('./rhHours');

const STAGES = { lavage: 'Lavage', sechage: 'Séchage', finition: 'Finition' };
const STAGE_BU = { lavage: 'lavage', sechage: 'sechage', finition: 'finition' };
const NOTE_KINDS = ['remarque', 'probleme', 'relavage'];
const STALE_STEP_HOURS = 14;
const MAX_KG = 2000;

class ProdError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}
const bad = (message, code, status) => new ProdError(message, code || 'BAD_REQUEST', status);
const iso = (ms) => new Date(ms).toISOString();
const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
const round1 = (x) => Math.round(x * 10) / 10;

function parseKg(v, label = 'Le poids') {
  const n = Number(String(v == null ? '' : v).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) throw bad(`${label} doit être supérieur à 0 kg.`, 'BAD_WEIGHT');
  if (n > MAX_KG) throw bad(`${label} dépasse ${MAX_KG} kg : vérifiez la saisie.`, 'BAD_WEIGHT');
  return round1(n);
}

// ---------- réglages ----------
function getSettings() {
  const r = Object.fromEntries(db.prepare('SELECT key, value FROM prod_settings').all().map(x => [x.key, x.value]));
  const num = (k) => (r[k] === undefined || r[k] === '' || !Number.isFinite(Number(r[k])) ? null : Number(r[k]));
  return {
    targetCentsPerKg: num('target_cost_cents_per_kg'), waterCentsPerM3: num('water_price_cents_per_m3'), energyCentsPerKwh: num('energy_price_cents_per_kwh'),
    openFrom: r.open_from || '05:00', openTo: r.open_to || '21:00', tolerancePct: num('weight_tolerance_pct') ?? 5,
  };
}
/** Réglages en euros côté interface (objectif €/kg, eau €/m³, énergie €/kWh) ; chaîne vide = non renseigné. */
function saveSettings(b) {
  const up = db.prepare('INSERT INTO prod_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const money = (v, key, label, max) => {
    if (v === undefined) return;
    if (v === '' || v === null) { db.prepare('DELETE FROM prod_settings WHERE key = ?').run(key); return; }
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > max) throw bad(`${label} invalide.`);
    up.run(key, String(Math.round(n * 10000) / 100));
  };
  money(b.targetCostPerKg, 'target_cost_cents_per_kg', 'Objectif de coût', 50);
  money(b.waterPrice, 'water_price_cents_per_m3', 'Prix de l\'eau', 100);
  money(b.energyPrice, 'energy_price_cents_per_kwh', 'Prix de l\'énergie', 5);
  if (b.openFrom !== undefined || b.openTo !== undefined) {
    const f = b.openFrom !== undefined ? b.openFrom : getSettings().openFrom, t = b.openTo !== undefined ? b.openTo : getSettings().openTo;
    if (!rh.isHhmm(f) || !rh.isHhmm(t) || f >= t) throw bad('Horaires d\'ouverture invalides (début avant fin, format HH:MM).');
    up.run('open_from', f); up.run('open_to', t);
  }
  if (b.tolerancePct !== undefined) {
    const n = Number(String(b.tolerancePct).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 50) throw bad('Tolérance de poids invalide (0 à 50 %).');
    up.run('weight_tolerance_pct', String(n));
  }
  return getSettings();
}

// ---------- affichage ----------
const stale = (s, nowMs) => !s.ended_at && (rh.parisDate(Date.parse(s.started_at)) < rh.parisDate(nowMs) || nowMs - Date.parse(s.started_at) > STALE_STEP_HOURS * 3600e3);

const STEP_SQL = `SELECT s.*, m.name AS machine_name, m.capacity_kg, m.throughput_kgh, p.name AS program_name, p.duration_min, p.water_l, p.energy_kwh, p.detergent_cents,
  e.first_name AS emp_first, e.last_name AS emp_last
  FROM lot_steps s LEFT JOIN machines m ON m.id = s.machine_id LEFT JOIN wash_programs p ON p.id = s.program_id LEFT JOIN employees e ON e.id = s.employee_id`;

function stepOut(s, nowMs) {
  const start = Date.parse(s.started_at);
  const isStale = stale(s, nowMs);
  const end = s.ended_at ? Date.parse(s.ended_at) : null;
  const planned = s.planned_end_at ? Date.parse(s.planned_end_at) : null;
  const effEnd = end != null ? end : (isStale ? (planned || start) : nowMs);
  let progress = null, remainingMin = null;
  if (!s.ended_at && planned && planned > start) {
    progress = Math.max(0, Math.min(1, (nowMs - start) / (planned - start)));
    remainingMin = Math.max(0, Math.ceil((planned - nowMs) / 60000));
  }
  return {
    id: s.id, lotId: s.lot_id, stage: s.stage, stageLabel: STAGES[s.stage] || s.stage, machineId: s.machine_id, machineName: s.machine_name,
    programId: s.program_id, programName: s.program_name, weightKg: s.weight_kg, startedAt: s.started_at, plannedEndAt: s.planned_end_at, endedAt: s.ended_at,
    open: !s.ended_at, stale: isStale, minutes: Math.max(0, Math.round((effEnd - start) / 60000)), progress, remainingMin,
    employee: s.emp_first ? `${s.emp_first} ${s.emp_last || ''}`.trim() : null, note: s.note,
  };
}

// ---------- coût estimé d'un passage de lavage (consommations moyennes du programme) ----------
function stepCost(s, settings) {
  if (s.stage !== 'lavage' || !s.program_id) return null;
  const water = s.water_l != null && settings.waterCentsPerM3 != null ? Math.round(s.water_l / 1000 * settings.waterCentsPerM3) : null;
  const energy = s.energy_kwh != null && settings.energyCentsPerKwh != null ? Math.round(s.energy_kwh * settings.energyCentsPerKwh) : null;
  const detergent = s.detergent_cents != null ? s.detergent_cents : null;
  const parts = [water, energy, detergent].filter(x => x != null);
  return { waterCents: water, energyCents: energy, detergentCents: detergent, totalCents: parts.reduce((a, b) => a + b, 0), complete: parts.length === 3 };
}

// ---------- lots ----------
function loadLots(where, args, nowMs) {
  const lots = db.prepare(`SELECT l.*, t.label AS linen_label, e.first_name AS by_first, e.last_name AS by_last FROM lots l
    LEFT JOIN linen_types t ON t.id = l.linen_type_id LEFT JOIN employees e ON e.id = l.created_by WHERE ${where} ORDER BY l.created_at DESC, l.id DESC`).all(...args);
  if (!lots.length) return [];
  const ids = lots.map(l => l.id), qs = ids.map(() => '?').join(',');
  const clients = db.prepare(`SELECT lc.*, o.ticket AS order_ticket FROM lot_clients lc LEFT JOIN orders o ON o.id = lc.order_id WHERE lc.lot_id IN (${qs}) ORDER BY lc.id`).all(...ids);
  const steps = db.prepare(`${STEP_SQL} WHERE s.lot_id IN (${qs}) ORDER BY s.started_at, s.id`).all(...ids);
  return lots.map(l => {
    const st = steps.filter(s => s.lot_id === l.id).map(s => stepOut(s, nowMs));
    const per = {};
    st.forEach(s => { per[s.stage] = per[s.stage] || []; per[s.stage].push(s); });
    st.forEach(s => { const g = per[s.stage]; s.pass = g.indexOf(s) + 1; s.passes = g.length; });
    const open = st.filter(s => s.open);
    const last = st.length ? st[st.length - 1] : null;
    const cur = open.length ? open[open.length - 1] : null;
    let stageLabel;
    if (l.status === 'annule') stageLabel = 'Annulé';
    else if (l.status === 'termine') stageLabel = 'Terminé';
    else if (cur) stageLabel = `${cur.stageLabel} · ${cur.machineName || '—'}${cur.stale ? ' (à clôturer)' : ''}`;
    else if (last) stageLabel = `${last.stageLabel} terminé`;
    else stageLabel = 'En attente';
    const lotKg = round1(st.filter(s => s.stage === 'lavage').reduce((a, s) => a + s.weightKg, 0));
    const cl = clients.filter(c => c.lot_id === l.id);
    const sole = cl.length === 1 && cl[0].weight_kg == null;   // un seul client sans poids saisi : tout le lot est à lui
    return {
      id: l.id, code: l.code, day: l.day, linenTypeId: l.linen_type_id, linenType: l.linen_label, status: l.status, note: l.note, createdAt: l.created_at, closedAt: l.closed_at,
      createdBy: l.by_first ? `${l.by_first} ${l.by_last || ''}`.trim() : null,
      clients: cl.map(c => ({ id: c.id, clientId: c.client_id, societe: c.societe, orderId: c.order_id, orderTicket: c.order_ticket, weightKg: sole ? lotKg : c.weight_kg, weightAuto: sole })),
      weightKg: lotKg,
      steps: st, current: cur, stageLabel, waiting: l.status === 'en_cours' && !cur && !!last,
      lastEndedAt: last && last.endedAt ? last.endedAt : null, lastStage: last ? last.stage : null,
    };
  });
}
const lotById = (id, nowMs = Date.now()) => loadLots('l.id = ?', [id], nowMs)[0] || null;

function nextCode(day) {
  const prefix = `L-${day.slice(5, 7)}${day.slice(8, 10)}-`;
  const max = db.prepare('SELECT code FROM lots WHERE code LIKE ?').all(prefix + '%').map(r => Number(r.code.slice(prefix.length))).filter(Number.isFinite);
  return prefix + String((max.length ? Math.max(...max) : 0) + 1).padStart(2, '0');
}

function resolveClients(list, lotKg) {
  if (!Array.isArray(list) || !list.length) throw bad('Choisissez au moins un client.', 'NO_CLIENT');
  if (list.length > 12) throw bad('Trop de clients dans un même lot.');
  const out = list.map(c => {
    let societe = clean(c.societe, 120), clientId = null;
    if (c.clientId !== undefined && c.clientId !== null && c.clientId !== '') {
      const row = db.prepare('SELECT id, societe FROM clients WHERE id = ?').get(Number(c.clientId));
      if (!row) throw bad('Client inconnu.', 'BAD_CLIENT');
      clientId = row.id; societe = row.societe;
    }
    if (!societe) throw bad('Indiquez le client.', 'NO_CLIENT');
    let orderId = null;
    if (c.orderId) {
      const o = db.prepare('SELECT id, client_id FROM orders WHERE id = ?').get(Number(c.orderId));
      if (!o) throw bad('Commande inconnue.', 'BAD_ORDER');
      if (clientId && o.client_id && o.client_id !== clientId) throw bad('Cette commande n\'est pas celle de ce client.', 'BAD_ORDER');
      orderId = o.id;
    }
    const w = c.weightKg === undefined || c.weightKg === null || c.weightKg === '' ? null : parseKg(c.weightKg, 'Le poids du client');
    return { clientId, societe, orderId, weightKg: w };
  });
  const given = out.filter(c => c.weightKg != null).reduce((a, c) => a + c.weightKg, 0);
  if (lotKg != null && given > lotKg + 0.05) throw bad(`Les poids par client (${round1(given)} kg) dépassent le poids du lot (${lotKg} kg).`, 'BAD_WEIGHT');
  return out;
}

// ---------- disponibilité d'une machine ----------
/** Passage ou incident qui empêche d'utiliser la machine sur [startMs, endMs[ (endMs nul = jusqu'à nouvel ordre). */
function machineConflict(machineId, startMs, endMs, ignoreStepId, nowMs) {
  const hi = endMs == null ? Infinity : endMs;
  for (const s of db.prepare("SELECT s.* FROM lot_steps s JOIN lots l ON l.id = s.lot_id WHERE s.machine_id = ? AND s.id != ? AND l.status != 'annule'").all(machineId, ignoreStepId || 0)) {
    const a = Date.parse(s.started_at);
    const b = s.ended_at ? Date.parse(s.ended_at) : (stale(s, nowMs) ? (s.planned_end_at ? Date.parse(s.planned_end_at) : a) : Infinity);
    if (b > a && startMs < b && hi > a) return { kind: 'step', step: s };
  }
  for (const i of db.prepare('SELECT * FROM machine_incidents WHERE machine_id = ?').all(machineId)) {
    const a = Date.parse(i.started_at), b = i.ended_at ? Date.parse(i.ended_at) : Infinity;
    if (startMs < b && hi > a) return { kind: 'incident', incident: i };
  }
  return null;
}

function checkMachine(stage, machineId, weightKg) {
  const m = rhStore.machineById.get(Number(machineId));
  if (!m || !m.active) throw bad('Machine inconnue ou retirée.', 'BAD_MACHINE');
  if (m.bu !== STAGE_BU[stage]) throw bad(`${m.name} n'est pas une machine de ${STAGES[stage].toLowerCase()}.`, 'WRONG_MACHINE');
  if (m.capacity_kg && weightKg > m.capacity_kg + 1e-9) throw bad(`${weightKg} kg dépassent la capacité de ${m.name} (${m.capacity_kg} kg).`, 'OVER_CAPACITY');
  return m;
}

function plannedEnd(stage, startMs, weightKg, machine, program) {
  if (stage === 'lavage') return program && program.duration_min ? startMs + program.duration_min * 60000 : null;
  return machine.throughput_kgh ? startMs + Math.round(weightKg / machine.throughput_kgh * 3600e3) : null;
}

/** Referme un passage resté ouvert depuis la veille (fin non saisie) avant d'en lancer un nouveau sur la même machine. */
function closeStaleOnMachine(machineId, nowMs, employeeId) {
  for (const s of db.prepare('SELECT * FROM lot_steps WHERE machine_id = ? AND ended_at IS NULL').all(machineId)) {
    if (!stale(s, nowMs)) continue;
    const end = s.planned_end_at ? Date.parse(s.planned_end_at) : Date.parse(s.started_at);
    db.prepare('UPDATE lot_steps SET ended_at = ? WHERE id = ?').run(iso(Math.max(end, Date.parse(s.started_at))), s.id);
    db.prepare('INSERT INTO lot_notes (lot_id, at, kind, text, employee_id) VALUES (?, ?, ?, ?, ?)').run(s.lot_id, iso(nowMs), 'probleme',
      'Fin de passage non saisie : clôturé automatiquement au lancement suivant sur cette machine. Heure de fin à vérifier.', employeeId || null);
  }
}

function insertStep({ lotId, stage, machineId, programId, weightKg, employeeId, startMs, endMs, nowMs, note }) {
  const m = checkMachine(stage, machineId, weightKg);
  let program = null;
  if (programId !== undefined && programId !== null && programId !== '') {
    if (stage !== 'lavage') throw bad('Un programme ne se choisit que pour le lavage.', 'BAD_PROGRAM');
    program = db.prepare('SELECT * FROM wash_programs WHERE id = ?').get(Number(programId));
    if (!program || !program.active) throw bad('Programme inconnu ou retiré.', 'BAD_PROGRAM');
  }
  if (endMs == null) closeStaleOnMachine(m.id, nowMs, employeeId);
  const conflict = machineConflict(m.id, startMs, endMs, 0, nowMs);
  if (conflict) {
    if (conflict.kind === 'incident') throw bad(`${m.name} est à l'arrêt (${conflict.incident.reason}).`, 'MACHINE_DOWN', 409);
    throw bad(`${m.name} est déjà occupée${conflict.step.ended_at ? ' sur ce créneau' : ''}.`, 'MACHINE_BUSY', 409);
  }
  const planned = endMs == null ? plannedEnd(stage, startMs, weightKg, m, program) : null;
  const info = db.prepare(`INSERT INTO lot_steps (lot_id, stage, machine_id, program_id, weight_kg, started_at, planned_end_at, ended_at, employee_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(lotId, stage, m.id, program ? program.id : null, weightKg, iso(startMs), planned ? iso(planned) : null, endMs == null ? null : iso(endMs), employeeId || null, note || null);
  return Number(info.lastInsertRowid);
}

/** Nouveau lot : son premier passage est le lavage, sur une laveuse. */
function createLot(o) {
  const nowMs = o.nowMs || Date.now();
  const weightKg = parseKg(o.weightKg);
  const type = db.prepare('SELECT * FROM linen_types WHERE id = ?').get(Number(o.linenTypeId));
  if (!type || !type.active) throw bad('Choisissez le type de linge.', 'BAD_TYPE');
  const startMs = o.startMs || nowMs;
  if (startMs > nowMs + 60000 || (o.endMs && o.endMs > nowMs + 60000)) throw bad('Cette heure est dans le futur.');
  if (o.endMs && o.endMs <= startMs) throw bad('La fin doit être après le début.');
  return db.transaction(() => {
    const clients = resolveClients(o.clients, weightKg);
    const day = rh.parisDate(startMs);
    const lot = db.prepare('INSERT INTO lots (code, day, linen_type_id, note, created_by, terminal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(nextCode(day), day, type.id, clean(o.note, 300) || null, o.employeeId || null, o.terminalId || null, iso(nowMs));
    const lotId = Number(lot.lastInsertRowid);
    const ins = db.prepare('INSERT INTO lot_clients (lot_id, client_id, societe, order_id, weight_kg) VALUES (?, ?, ?, ?, ?)');
    clients.forEach(c => ins.run(lotId, c.clientId, c.societe, c.orderId, c.weightKg));
    insertStep({ lotId, stage: 'lavage', machineId: o.machineId, programId: o.programId, weightKg, employeeId: o.employeeId, startMs, endMs: o.endMs || null, nowMs });
    return lotId;
  })();
}

/** Passage suivant (ou autre laveuse) d'un lot existant. */
function startStep(o) {
  const nowMs = o.nowMs || Date.now();
  if (!STAGES[o.stage]) throw bad('Étape inconnue.', 'BAD_STAGE');
  const lot = db.prepare('SELECT * FROM lots WHERE id = ?').get(Number(o.lotId));
  if (!lot) throw bad('Lot introuvable.', 'NOT_FOUND', 404);
  if (lot.status !== 'en_cours') throw bad(lot.status === 'annule' ? 'Ce lot est annulé.' : 'Ce lot est terminé.', 'LOT_CLOSED', 409);
  const weightKg = parseKg(o.weightKg);
  const startMs = o.startMs || nowMs;
  if (startMs > nowMs + 60000 || (o.endMs && o.endMs > nowMs + 60000)) throw bad('Cette heure est dans le futur.');
  if (o.endMs && o.endMs <= startMs) throw bad('La fin doit être après le début.');
  return db.transaction(() => {
    if (o.stage !== 'lavage' && !db.prepare("SELECT 1 FROM lot_steps WHERE lot_id = ? AND stage = 'lavage'").get(lot.id)) throw bad('Ce lot n\'a pas encore été lavé.', 'NO_WASH');
    return insertStep({ lotId: lot.id, stage: o.stage, machineId: o.machineId, programId: o.programId, weightKg, employeeId: o.employeeId, startMs, endMs: o.endMs || null, nowMs, note: clean(o.note, 200) || null });
  })();
}

function finishStep(stepId, { nowMs = Date.now(), closeLot = false } = {}) {
  const s = db.prepare('SELECT * FROM lot_steps WHERE id = ?').get(Number(stepId));
  if (!s) throw bad('Passage introuvable.', 'NOT_FOUND', 404);
  if (s.ended_at) throw bad('Ce passage est déjà terminé.', 'ALREADY_DONE', 409);
  const end = Math.max(nowMs, Date.parse(s.started_at));
  db.transaction(() => {
    db.prepare('UPDATE lot_steps SET ended_at = ? WHERE id = ?').run(iso(end), s.id);
    if (closeLot) db.prepare("UPDATE lots SET status = 'termine', closed_at = ? WHERE id = ? AND status = 'en_cours'").run(iso(end), s.lot_id);
  })();
  return s.lot_id;
}

function closeLot(lotId, nowMs = Date.now()) {
  const l = db.prepare('SELECT * FROM lots WHERE id = ?').get(Number(lotId));
  if (!l) throw bad('Lot introuvable.', 'NOT_FOUND', 404);
  if (l.status !== 'en_cours') throw bad('Ce lot n\'est plus en cours.', 'LOT_CLOSED', 409);
  if (db.prepare('SELECT 1 FROM lot_steps WHERE lot_id = ? AND ended_at IS NULL').get(l.id)) throw bad('Terminez d\'abord le passage en cours.', 'STEP_OPEN', 409);
  db.prepare("UPDATE lots SET status = 'termine', closed_at = ? WHERE id = ?").run(iso(nowMs), l.id);
}

function addNote(lotId, kind, text, employeeId, nowMs = Date.now()) {
  if (!db.prepare('SELECT 1 FROM lots WHERE id = ?').get(Number(lotId))) throw bad('Lot introuvable.', 'NOT_FOUND', 404);
  if (!NOTE_KINDS.includes(kind)) throw bad('Type de remarque inconnu.');
  const t = clean(text, 400);
  if (!t) throw bad('Écrivez la remarque.');
  db.prepare('INSERT INTO lot_notes (lot_id, at, kind, text, employee_id) VALUES (?, ?, ?, ?, ?)').run(Number(lotId), iso(nowMs), kind, t, employeeId || null);
}

/** Correction d'un passage (poids, machine, programme, heures) — mêmes contrôles qu'à la création. */
function editStep(id, o, nowMs = Date.now()) {
  const s = db.prepare('SELECT * FROM lot_steps WHERE id = ?').get(Number(id));
  if (!s) throw bad('Passage introuvable.', 'NOT_FOUND', 404);
  const weightKg = o.weightKg !== undefined ? parseKg(o.weightKg) : s.weight_kg;
  const machineId = o.machineId !== undefined ? Number(o.machineId) : s.machine_id;
  const startMs = o.startMs !== undefined ? o.startMs : Date.parse(s.started_at);
  const endMs = o.endMs !== undefined ? o.endMs : (s.ended_at ? Date.parse(s.ended_at) : null);
  if (startMs > nowMs + 60000 || (endMs && endMs > nowMs + 60000)) throw bad('Cette heure est dans le futur.');
  if (endMs != null && endMs <= startMs) throw bad('La fin doit être après le début.');
  const m = checkMachine(s.stage, machineId, weightKg);
  let program = null;
  const programId = o.programId !== undefined ? o.programId : s.program_id;
  if (programId !== null && programId !== '' && programId !== undefined) {
    if (s.stage !== 'lavage') throw bad('Un programme ne se choisit que pour le lavage.', 'BAD_PROGRAM');
    program = db.prepare('SELECT * FROM wash_programs WHERE id = ?').get(Number(programId));
    if (!program) throw bad('Programme inconnu.', 'BAD_PROGRAM');
    if (!program.active && program.id !== s.program_id) throw bad('Programme retiré.', 'BAD_PROGRAM');
  }
  const conflict = machineConflict(m.id, startMs, endMs, s.id, nowMs);
  if (conflict) throw bad(conflict.kind === 'incident' ? `${m.name} est à l'arrêt sur ce créneau.` : `${m.name} est déjà occupée sur ce créneau.`, conflict.kind === 'incident' ? 'MACHINE_DOWN' : 'MACHINE_BUSY', 409);
  const planned = endMs == null ? plannedEnd(s.stage, startMs, weightKg, m, program) : null;
  db.prepare('UPDATE lot_steps SET machine_id = ?, program_id = ?, weight_kg = ?, started_at = ?, planned_end_at = ?, ended_at = ?, note = ? WHERE id = ?')
    .run(m.id, program ? program.id : null, weightKg, iso(startMs), planned ? iso(planned) : null, endMs == null ? null : iso(endMs), o.note !== undefined ? (clean(o.note, 200) || null) : s.note, s.id);
  return s.lot_id;
}

function deleteStep(id) {
  const s = db.prepare('SELECT * FROM lot_steps WHERE id = ?').get(Number(id));
  if (!s) throw bad('Passage introuvable.', 'NOT_FOUND', 404);
  if (db.prepare('SELECT COUNT(*) n FROM lot_steps WHERE lot_id = ?').get(s.lot_id).n <= 1) throw bad('C\'est le seul passage de ce lot : annulez le lot plutôt.', 'LAST_STEP', 409);
  if (s.stage === 'lavage' && db.prepare("SELECT COUNT(*) n FROM lot_steps WHERE lot_id = ? AND stage = 'lavage'").get(s.lot_id).n <= 1) throw bad('Un lot garde au moins un lavage.', 'LAST_WASH', 409);
  db.prepare('DELETE FROM lot_steps WHERE id = ?').run(s.id);
  return s.lot_id;
}

/** Type de linge, remarque et clients d'un lot (les clients sont remplacés par la liste fournie). */
function updateLot(id, o) {
  const l = db.prepare('SELECT * FROM lots WHERE id = ?').get(Number(id));
  if (!l) throw bad('Lot introuvable.', 'NOT_FOUND', 404);
  db.transaction(() => {
    if (o.linenTypeId !== undefined) {
      const t = db.prepare('SELECT * FROM linen_types WHERE id = ?').get(Number(o.linenTypeId));
      if (!t) throw bad('Type de linge inconnu.', 'BAD_TYPE');
      db.prepare('UPDATE lots SET linen_type_id = ? WHERE id = ?').run(t.id, l.id);
    }
    if (o.note !== undefined) db.prepare('UPDATE lots SET note = ? WHERE id = ?').run(clean(o.note, 300) || null, l.id);
    if (o.clients !== undefined) {
      const kg = db.prepare("SELECT COALESCE(SUM(weight_kg), 0) k FROM lot_steps WHERE lot_id = ? AND stage = 'lavage'").get(l.id).k;
      const clients = resolveClients(o.clients, kg);
      db.prepare('DELETE FROM lot_clients WHERE lot_id = ?').run(l.id);
      const ins = db.prepare('INSERT INTO lot_clients (lot_id, client_id, societe, order_id, weight_kg) VALUES (?, ?, ?, ?, ?)');
      clients.forEach(c => ins.run(l.id, c.clientId, c.societe, c.orderId, c.weightKg));
    }
  })();
}

/** Annule un lot (saisi par erreur) : ses passages en cours sont arrêtés, il disparaît des chiffres. */
function cancelLot(id, nowMs = Date.now()) {
  const l = db.prepare('SELECT * FROM lots WHERE id = ?').get(Number(id));
  if (!l) throw bad('Lot introuvable.', 'NOT_FOUND', 404);
  if (l.status === 'annule') throw bad('Ce lot est déjà annulé.', 'LOT_CLOSED', 409);
  db.transaction(() => {
    for (const s of db.prepare('SELECT * FROM lot_steps WHERE lot_id = ? AND ended_at IS NULL').all(l.id)) {
      db.prepare('UPDATE lot_steps SET ended_at = ? WHERE id = ?').run(iso(Math.max(nowMs, Date.parse(s.started_at))), s.id);
    }
    db.prepare("UPDATE lots SET status = 'annule', closed_at = ? WHERE id = ?").run(iso(nowMs), l.id);
  })();
}

/** Remet en cours un lot terminé trop vite. */
function reopenLot(id) {
  const l = db.prepare('SELECT * FROM lots WHERE id = ?').get(Number(id));
  if (!l) throw bad('Lot introuvable.', 'NOT_FOUND', 404);
  if (l.status !== 'termine') throw bad('Seul un lot terminé peut être rouvert.', 'LOT_CLOSED', 409);
  db.prepare("UPDATE lots SET status = 'en_cours', closed_at = NULL WHERE id = ?").run(l.id);
}

// ---------- incidents ----------
function openIncident({ machineId, reason, note, employeeId, nowMs = Date.now() }) {
  const m = rhStore.machineById.get(Number(machineId));
  if (!m || !m.active) throw bad('Machine inconnue ou retirée.', 'BAD_MACHINE');
  const r = clean(reason, 120);
  if (!r) throw bad('Indiquez la cause de l\'arrêt.');
  if (db.prepare('SELECT 1 FROM machine_incidents WHERE machine_id = ? AND ended_at IS NULL').get(m.id)) throw bad(`${m.name} est déjà signalée à l'arrêt.`, 'ALREADY_DOWN', 409);
  const info = db.prepare('INSERT INTO machine_incidents (machine_id, started_at, reason, note, employee_id) VALUES (?, ?, ?, ?, ?)').run(m.id, iso(nowMs), r, clean(note, 300) || null, employeeId || null);
  return Number(info.lastInsertRowid);
}
function resolveIncident(id, nowMs = Date.now()) {
  const i = db.prepare('SELECT * FROM machine_incidents WHERE id = ?').get(Number(id));
  if (!i) throw bad('Incident introuvable.', 'NOT_FOUND', 404);
  if (i.ended_at) throw bad('Cet incident est déjà clos.', 'ALREADY_DONE', 409);
  db.prepare('UPDATE machine_incidents SET ended_at = ? WHERE id = ?').run(iso(Math.max(nowMs, Date.parse(i.started_at))), i.id);
}
const incidentOut = (i, nowMs) => ({
  id: i.id, machineId: i.machine_id, machineName: i.machine_name, startedAt: i.started_at, endedAt: i.ended_at, reason: i.reason, note: i.note, open: !i.ended_at,
  minutes: Math.max(0, Math.round(((i.ended_at ? Date.parse(i.ended_at) : nowMs) - Date.parse(i.started_at)) / 60000)),
});

/** Enveloppe de route : une erreur métier (ProdError) devient une réponse JSON claire, le reste remonte au gestionnaire d'erreurs. */
const route = (fn) => (req, res, next) => {
  try { fn(req, res); } catch (err) {
    if (err instanceof ProdError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
};

// ---------- listes de référence ----------
const programOut = (p) => ({
  id: p.id, name: p.name, tempC: p.temp_c, durationMin: p.duration_min, waterL: p.water_l, energyKwh: p.energy_kwh,
  detergentCost: p.detergent_cents == null ? null : p.detergent_cents / 100, active: !!p.active, sortOrder: p.sort_order,
});
const linenTypeOut = (t) => ({ id: t.id, label: t.label, active: !!t.active, sortOrder: t.sort_order });
const programs = () => db.prepare('SELECT * FROM wash_programs ORDER BY active DESC, sort_order, name COLLATE NOCASE').all().map(programOut);
const linenTypes = () => db.prepare('SELECT * FROM linen_types ORDER BY active DESC, sort_order, label COLLATE NOCASE').all().map(linenTypeOut);

function numOrNull(v, label, { min = 0, max = 1e6 } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} invalide.`);
  return n;
}
function readProgram(b, cur) {
  const has = (k) => b[k] !== undefined;
  const name = clean(has('name') ? b.name : cur && cur.name, 60);
  if (!name) throw bad('Donnez un nom au programme.');
  const detergent = has('detergentCost') ? numOrNull(b.detergentCost, 'Coût de lessive', { max: 100 }) : (cur && cur.detergent_cents != null ? cur.detergent_cents / 100 : null);
  const duration = has('durationMin') ? numOrNull(b.durationMin, 'Durée', { min: 1, max: 600 }) : (cur ? cur.duration_min : null);
  return {
    name, tempC: has('tempC') ? numOrNull(b.tempC, 'Température', { max: 120 }) : (cur ? cur.temp_c : null), duration: duration == null ? null : Math.round(duration),
    water: has('waterL') ? numOrNull(b.waterL, 'Volume d\'eau', { max: 5000 }) : (cur ? cur.water_l : null),
    energy: has('energyKwh') ? numOrNull(b.energyKwh, 'Énergie', { max: 500 }) : (cur ? cur.energy_kwh : null),
    detergentCents: detergent == null ? null : Math.round(detergent * 100),
    active: has('active') ? (b.active ? 1 : 0) : (cur ? cur.active : 1), sort: has('sortOrder') ? Math.trunc(Number(b.sortOrder)) || 0 : (cur ? cur.sort_order : null),
  };
}
function saveProgram(id, b) {
  const cur = id ? db.prepare('SELECT * FROM wash_programs WHERE id = ?').get(Number(id)) : null;
  if (id && !cur) throw bad('Programme introuvable.', 'NOT_FOUND', 404);
  const v = readProgram(b, cur);
  if (cur) {
    db.prepare('UPDATE wash_programs SET name = ?, temp_c = ?, duration_min = ?, water_l = ?, energy_kwh = ?, detergent_cents = ?, active = ?, sort_order = ? WHERE id = ?')
      .run(v.name, v.tempC, v.duration, v.water, v.energy, v.detergentCents, v.active, v.sort == null ? cur.sort_order : v.sort, cur.id);
    return cur.id;
  }
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 n FROM wash_programs').get().n;
  return Number(db.prepare('INSERT INTO wash_programs (name, temp_c, duration_min, water_l, energy_kwh, detergent_cents, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(v.name, v.tempC, v.duration, v.water, v.energy, v.detergentCents, v.active, v.sort == null ? next : v.sort).lastInsertRowid);
}
function deleteProgram(id) {
  const cur = db.prepare('SELECT * FROM wash_programs WHERE id = ?').get(Number(id));
  if (!cur) throw bad('Programme introuvable.', 'NOT_FOUND', 404);
  if (db.prepare('SELECT 1 FROM lot_steps WHERE program_id = ?').get(cur.id)) { db.prepare('UPDATE wash_programs SET active = 0 WHERE id = ?').run(cur.id); return { archived: true }; }
  db.prepare('DELETE FROM wash_programs WHERE id = ?').run(cur.id);
  return { archived: false };
}
function saveLinenType(id, b) {
  const cur = id ? db.prepare('SELECT * FROM linen_types WHERE id = ?').get(Number(id)) : null;
  if (id && !cur) throw bad('Type de linge introuvable.', 'NOT_FOUND', 404);
  const label = clean(b.label !== undefined ? b.label : cur && cur.label, 40);
  if (!label) throw bad('Donnez un nom au type de linge.');
  const dup = db.prepare('SELECT id FROM linen_types WHERE label = ? COLLATE NOCASE AND id != ?').get(label, cur ? cur.id : 0);
  if (dup) throw bad('Ce type de linge existe déjà.', 'DUPLICATE', 409);
  const active = b.active !== undefined ? (b.active ? 1 : 0) : (cur ? cur.active : 1);
  if (cur) { db.prepare('UPDATE linen_types SET label = ?, active = ?, sort_order = ? WHERE id = ?').run(label, active, b.sortOrder !== undefined ? Math.trunc(Number(b.sortOrder)) || 0 : cur.sort_order, cur.id); return cur.id; }
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 n FROM linen_types').get().n;
  return Number(db.prepare('INSERT INTO linen_types (label, sort_order, active) VALUES (?, ?, ?)').run(label, next, active).lastInsertRowid);
}
function deleteLinenType(id) {
  const cur = db.prepare('SELECT * FROM linen_types WHERE id = ?').get(Number(id));
  if (!cur) throw bad('Type de linge introuvable.', 'NOT_FOUND', 404);
  if (db.prepare('SELECT 1 FROM lots WHERE linen_type_id = ?').get(cur.id)) { db.prepare('UPDATE linen_types SET active = 0 WHERE id = ?').run(cur.id); return { archived: true }; }
  db.prepare('DELETE FROM linen_types WHERE id = ?').run(cur.id);
  return { archived: false };
}

/** Clients proposés dans le formulaire d'un lot, avec leurs commandes encore à traiter. */
function clientChoices() {
  const clients = db.prepare('SELECT id, societe FROM clients ORDER BY societe COLLATE NOCASE').all();
  const orders = db.prepare("SELECT id, ticket, client_id, livraison_prevue, status FROM orders WHERE status IN ('recue','traitement') ORDER BY id DESC LIMIT 400").all();
  return clients.map(c => ({ id: c.id, societe: c.societe, orders: orders.filter(o => o.client_id === c.id).slice(0, 6).map(o => ({ id: o.id, ticket: o.ticket, deliveryDate: o.livraison_prevue })) }));
}

/** Heures pointées par unité et par machine, rapprochées des kilos traités : kilos par heure et coût de main-d'œuvre. */
function hoursView(from, to, nowMs = Date.now()) {
  if (!rh.isDate(from) || !rh.isDate(to)) throw bad('Période invalide.');
  if (to < from) throw bad('La fin de période précède le début.');
  if ((Date.parse(to) - Date.parse(from)) / rh.DAY > MAX_SPAN_DAYS) throw bad(`Période trop longue (${MAX_SPAN_DAYS} jours au plus).`);
  const h = buildHours(from, to, nowMs);
  const fromIso = iso(rh.parisMidnightMs(from)), toIso = iso(rh.parisMidnightMs(rh.addDays(to, 1)));
  const steps = db.prepare(`SELECT s.machine_id, s.stage, s.weight_kg FROM lot_steps s JOIN lots l ON l.id = s.lot_id WHERE s.started_at >= ? AND s.started_at < ? AND l.status != 'annule'`).all(fromIso, toIso);
  const kgBy = (f) => round1(steps.filter(f).reduce((a, s) => a + s.weight_kg, 0));
  const withKpi = (row, kg) => ({ ...row, kg, kgPerHour: row.min > 0 && kg > 0 ? round1(kg / (row.min / 60)) : null, costPerKgCents: row.costCents > 0 && kg > 0 ? Math.round(row.costCents / kg) : null });
  const production = ['lavage', 'sechage', 'finition'];
  return {
    from, to, totalMin: h.total, costCents: h.costCents,
    byBu: h.byBu.map(b => withKpi(b, production.includes(b.bu) ? kgBy(s => s.stage === b.bu) : 0)),
    byMachine: h.byMachine.map(m => withKpi(m, m.machineId ? kgBy(s => s.machine_id === m.machineId) : 0)),
  };
}

// ---------- tableau des machines (état à l'instant) ----------
function board(nowMs = Date.now()) {
  const day = rh.parisDate(nowMs);
  const dayStart = iso(rh.parisMidnightMs(day));
  const machines = db.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY sort_order, name').all();
  const openSteps = db.prepare(`${STEP_SQL} WHERE s.ended_at IS NULL`).all().map(s => stepOut(s, nowMs));
  const lotIds = [...new Set(openSteps.map(s => s.lotId))];
  const lots = new Map(lotIds.length ? loadLots(`l.id IN (${lotIds.map(() => '?').join(',')})`, lotIds, nowMs).map(l => [l.id, l]) : []);
  const incidents = db.prepare('SELECT i.*, m.name AS machine_name FROM machine_incidents i JOIN machines m ON m.id = i.machine_id WHERE i.ended_at IS NULL').all();
  const todays = db.prepare(`${STEP_SQL} WHERE s.started_at >= ? OR s.ended_at >= ?`).all(dayStart, dayStart).map(s => stepOut(s, nowMs));
  return machines.map(m => {
    const open = openSteps.filter(s => s.machineId === m.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null;
    const inc = incidents.find(i => i.machine_id === m.id) || null;
    const mine = todays.filter(s => s.machineId === m.id && s.startedAt >= dayStart);
    const lastEnd = todays.filter(s => s.machineId === m.id && s.endedAt).map(s => s.endedAt).sort().pop() || null;
    const lot = open ? lots.get(open.lotId) : null;
    return {
      id: m.id, name: m.name, bu: m.bu, capacityKg: m.capacity_kg, throughputKgh: m.throughput_kgh,
      state: inc ? 'down' : open ? 'running' : 'free',
      step: open ? { ...open, lotCode: lot ? lot.code : null, linenType: lot ? lot.linenType : null, clients: lot ? lot.clients.map(c => c.societe) : [] } : null,
      incident: inc ? incidentOut(inc, nowMs) : null, lastEndedAt: lastEnd, todayKg: round1(mine.reduce((a, s) => a + s.weightKg, 0)), todayCount: mine.length,
    };
  });
}

/** Lots en cours dont aucun passage n'est ouvert : candidats pour séchage / finition. */
function waitingLots(nowMs = Date.now()) {
  const since = rh.parisDate(nowMs - 3 * 86400000);
  return loadLots(`l.status = 'en_cours' AND l.day >= ?`, [since], nowMs).filter(l => l.waiting)
    .map(l => ({ id: l.id, code: l.code, linenType: l.linenType, weightKg: l.weightKg, clients: l.clients.map(c => c.societe), lastStage: l.lastStage, lastEndedAt: l.lastEndedAt, stageLabel: l.stageLabel }));
}

// ---------- contenu théorique d'un lot (commandes liées × poids catalogue) ----------
function lotContent(lot, settings) {
  const orders = [...new Set(lot.clients.map(c => c.orderId).filter(Boolean))];
  const content = orders.map(id => {
    const o = db.prepare('SELECT id, ticket, livraison_prevue FROM orders WHERE id = ?').get(id);
    const items = db.prepare(`SELECT oi.name, oi.qty, COALESCE(a.weight_g, 0) AS wg FROM order_items oi LEFT JOIN articles a ON a.id = oi.service_id WHERE oi.order_id = ? AND oi.qty > 0 ORDER BY oi.id`).all(id)
      .map(i => ({ name: i.name, qty: i.qty, unitKg: i.wg ? Math.round(i.wg) / 1000 : null, totalKg: i.wg ? round1(i.qty * i.wg / 1000) : null }));
    return { orderId: o.id, ticket: o.ticket, deliveryDate: o.livraison_prevue, items, theoreticalKg: round1(items.reduce((a, i) => a + (i.totalKg || 0), 0)) };
  });
  const theoretical = round1(content.reduce((a, c) => a + c.theoreticalKg, 0));
  let gap = null;
  if (theoretical > 0 && lot.weightKg > 0) {
    const pct = Math.round((lot.weightKg - theoretical) / theoretical * 100);
    gap = { pct, withinTolerance: Math.abs(pct) <= settings.tolerancePct, tolerancePct: settings.tolerancePct };
  }
  return { orders: content, theoreticalKg: theoretical, gap };
}

function lotDetail(id, nowMs = Date.now()) {
  const lot = lotById(id, nowMs);
  if (!lot) return null;
  const settings = getSettings();
  const notes = db.prepare(`SELECT n.*, e.first_name, e.last_name FROM lot_notes n LEFT JOIN employees e ON e.id = n.employee_id WHERE n.lot_id = ? ORDER BY n.at, n.id`).all(lot.id)
    .map(n => ({ id: n.id, at: n.at, kind: n.kind, text: n.text, who: n.first_name ? `${n.first_name} ${n.last_name || ''}`.trim() : null }));
  const raw = db.prepare(`${STEP_SQL} WHERE s.lot_id = ?`).all(lot.id);
  const costs = raw.map(s => stepCost(s, settings)).filter(Boolean);
  const sum = (k) => costs.some(c => c[k] != null) ? costs.reduce((a, c) => a + (c[k] || 0), 0) : null;
  const cost = {
    waterCents: sum('waterCents'), energyCents: sum('energyCents'), detergentCents: sum('detergentCents'),
    totalCents: costs.reduce((a, c) => a + c.totalCents, 0), complete: costs.length > 0 && costs.every(c => c.complete),
    perKgCents: lot.weightKg > 0 && costs.length ? Math.round(costs.reduce((a, c) => a + c.totalCents, 0) / lot.weightKg) : null,
  };
  return { ...lot, notes, content: lotContent(lot, settings), cost };
}

function dayView(day, nowMs = Date.now()) {
  const lots = loadLots('l.day = ?', [day], nowMs);
  const live = lots.filter(l => l.status !== 'annule');
  const steps = live.flatMap(l => l.steps.map(s => ({ ...s, lotCode: l.code, linenType: l.linenType })));
  const sumKg = (stage) => round1(steps.filter(s => s.stage === stage).reduce((a, s) => a + s.weightKg, 0));
  return { day, lots, totals: { lots: live.length, kgLavage: sumKg('lavage'), kgSechage: sumKg('sechage'), kgFinition: sumKg('finition') }, steps };
}

// ---------- tableau de bord (période) ----------
const MAX_SPAN_DAYS = 92;
function hhmmToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

/** Chiffres de la période : kilos par étape et par jour, utilisation et cadence des machines, arrêts, heures et coût de main-d'œuvre par kilo. */
function stats(from, to, nowMs = Date.now()) {
  if (!rh.isDate(from) || !rh.isDate(to)) throw bad('Période invalide.');
  if (to < from) throw bad('La fin de période précède le début.');
  if ((Date.parse(to) - Date.parse(from)) / rh.DAY > MAX_SPAN_DAYS) throw bad(`Période trop longue (${MAX_SPAN_DAYS} jours au plus).`);
  const settings = getSettings();
  const fromIso = iso(rh.parisMidnightMs(from)), toIso = iso(rh.parisMidnightMs(rh.addDays(to, 1)));
  const rows = db.prepare(`${STEP_SQL} JOIN lots l ON l.id = s.lot_id WHERE s.started_at >= ? AND s.started_at < ? AND l.status != 'annule'`).all(fromIso, toIso);
  const steps = rows.map(s => ({ raw: s, ...stepOut(s, nowMs) }));
  const days = []; for (let d = from; d <= to; d = rh.addDays(d, 1)) days.push(d);
  const dayOf = (s) => rh.parisDate(Date.parse(s.startedAt));

  const daily = days.map(d => {
    const st = steps.filter(s => dayOf(s) === d);
    const kg = (stage) => round1(st.filter(s => s.stage === stage).reduce((a, s) => a + s.weightKg, 0));
    return { day: d, lots: new Set(st.filter(s => s.stage === 'lavage').map(s => s.lotId)).size, kgLavage: kg('lavage'), kgSechage: kg('sechage'), kgFinition: kg('finition') };
  });
  const kg = { lavage: round1(daily.reduce((a, d) => a + d.kgLavage, 0)), sechage: round1(daily.reduce((a, d) => a + d.kgSechage, 0)), finition: round1(daily.reduce((a, d) => a + d.kgFinition, 0)) };
  const activeDays = new Set(steps.map(dayOf)).size;
  const windowMin = hhmmToMin(settings.openTo) - hhmmToMin(settings.openFrom);

  // Machines : kilos, passages, durée de marche, utilisation sur les jours d'activité, cadence réelle (passages terminés), arrêts.
  const machines = db.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY sort_order, name').all().map(m => {
    const mine = steps.filter(s => s.machineId === m.id);
    const busy = mine.reduce((a, s) => a + s.minutes, 0);
    const done = mine.filter(s => s.endedAt && s.minutes > 0);
    const doneMin = done.reduce((a, s) => a + s.minutes, 0);
    const inc = db.prepare('SELECT * FROM machine_incidents WHERE machine_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)').all(m.id, toIso, fromIso);
    const downMin = inc.reduce((a, i) => {
      const a0 = Math.max(Date.parse(i.started_at), Date.parse(fromIso)), b0 = Math.min(i.ended_at ? Date.parse(i.ended_at) : nowMs, Date.parse(toIso));
      return a + Math.max(0, Math.round((b0 - a0) / 60000));
    }, 0);
    return {
      id: m.id, name: m.name, bu: m.bu, capacityKg: m.capacity_kg, passes: mine.length, kg: round1(mine.reduce((a, s) => a + s.weightKg, 0)), busyMin: busy,
      utilization: activeDays && windowMin > 0 ? Math.min(1, busy / (windowMin * activeDays)) : null,
      avgLoadPct: m.capacity_kg && mine.length ? Math.round(mine.reduce((a, s) => a + s.weightKg, 0) / mine.length / m.capacity_kg * 100) : null,
      realKgh: doneMin > 0 ? round1(done.reduce((a, s) => a + s.weightKg, 0) / (doneMin / 60)) : null,
      incidents: inc.length, downMin,
    };
  });

  // Coût de l'eau, de l'énergie et de la lessive (consommations moyennes des programmes × prix saisis).
  const costs = steps.map(s => stepCost(s.raw, settings)).filter(Boolean);
  const pick = (k) => costs.some(c => c[k] != null) ? costs.reduce((a, c) => a + (c[k] || 0), 0) : null;
  const consumables = { waterCents: pick('waterCents'), energyCents: pick('energyCents'), detergentCents: pick('detergentCents'), washPasses: costs.length, completePasses: costs.filter(c => c.complete).length,
    totalCents: costs.reduce((a, c) => a + c.totalCents, 0) };

  // Heures et coût de main-d'œuvre des trois unités de production, rapportés aux kilos de l'étape.
  const hours = buildHours(from, to, nowMs);
  const labour = ['lavage', 'sechage', 'finition'].map(bu => {
    const b = hours.byBu.find(x => x.bu === bu) || { min: 0, costCents: 0 };
    const k = kg[bu];
    return { bu, minutes: b.min, costCents: b.costCents, kg: k, kgPerHour: b.min > 0 && k > 0 ? round1(k / (b.min / 60)) : null, costPerKgCents: b.costCents > 0 && k > 0 ? Math.round(b.costCents / k) : null };
  });
  const labourCents = labour.reduce((a, l) => a + l.costCents, 0);
  const costPerKgCents = kg.lavage > 0 && labourCents > 0 ? Math.round(labourCents / kg.lavage) : null;
  const consumablesPerKgCents = kg.lavage > 0 && consumables.totalCents > 0 ? Math.round(consumables.totalCents / kg.lavage) : null;
  const unpriced = db.prepare(`SELECT COUNT(DISTINCT te.employee_id) n FROM time_entries te JOIN employees e ON e.id = te.employee_id
    WHERE te.bu IN ('lavage','sechage','finition') AND te.started_at >= ? AND te.started_at < ? AND e.hourly_cost_cents IS NULL`).get(fromIso, toIso).n;

  // Répartition par type de linge et par client (lavage).
  const lots = loadLots(`l.day >= ? AND l.day <= ? AND l.status != 'annule'`, [from, to], nowMs);
  const byType = new Map(), byClient = new Map();
  let unassigned = 0;
  for (const l of lots) {
    const k = l.linenType || 'Non précisé';
    byType.set(k, round1((byType.get(k) || 0) + l.weightKg));
    const given = l.clients.reduce((a, c) => a + (c.weightKg || 0), 0);
    for (const c of l.clients) if (c.weightKg) byClient.set(c.societe, round1((byClient.get(c.societe) || 0) + c.weightKg));
    unassigned += Math.max(0, l.weightKg - given);
  }
  const notes = db.prepare(`SELECT n.kind, COUNT(*) c FROM lot_notes n JOIN lots l ON l.id = n.lot_id WHERE l.day >= ? AND l.day <= ? AND l.status != 'annule' GROUP BY n.kind`).all(from, to);
  const noteCount = (k) => (notes.find(n => n.kind === k) || { c: 0 }).c;

  return {
    from, to, days: days.length, activeDays, kg, lots: lots.length, daily, machines, consumables, labour, labourCents, costPerKgCents, consumablesPerKgCents,
    targetCentsPerKg: settings.targetCentsPerKg, unpricedEmployees: unpriced, hoursTotalMin: hours.total,
    byType: [...byType].map(([label, kgv]) => ({ label, kg: kgv })).sort((a, b) => b.kg - a.kg),
    byClient: [...byClient].map(([label, kgv]) => ({ label, kg: kgv })).sort((a, b) => b.kg - a.kg).slice(0, 12), unassignedKg: round1(unassigned),
    rewashes: noteCount('relavage'), problems: noteCount('probleme'), remarks: noteCount('remarque'),
    note: 'Le coût par kilo compte la main-d\'œuvre pointée et, quand les prix sont saisis, l\'eau, l\'énergie et la lessive des lavages. Les consommations des séchoirs et des calandres ne sont pas incluses.',
  };
}

module.exports = {
  STAGES, STAGE_BU, ProdError, bad, parseKg, getSettings, saveSettings, loadLots, lotById, lotDetail, dayView, stepOut, stepCost, stale,
  route, programs, linenTypes, programOut, saveProgram, deleteProgram, saveLinenType, deleteLinenType, clientChoices, hoursView, stats, editStep, deleteStep, updateLot, cancelLot, reopenLot, createLot, startStep, finishStep, closeLot, addNote, openIncident, resolveIncident, incidentOut, board, waitingLots, machineConflict, checkMachine, round1, iso, clean,
};
