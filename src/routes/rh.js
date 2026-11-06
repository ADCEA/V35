// Administration RH : collaborateurs (rattachés à une BU et/ou une machine), machines, tablettes de badgeuse,
// présence en direct, pointages et heures. Réservé à l'administrateur.
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const rh = require('../utils/rh');
const store = require('../utils/rhStore');
const { buildHours } = require('../utils/rhHours');
const loginGuard = require('../utils/loginGuard');
const securityLog = require('../utils/securityLog');

const router = express.Router();
router.use(requireAdmin);

const MAX_SPAN_DAYS = 92;
const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const lockKey = (employeeId) => `badge:emp:${employeeId}`;

// ---------- présentation ----------
function employeeOut(r, openByEmp, machines, nowMs) {
  const open = openByEmp.get(r.id) || null;
  const m = r.machine_id ? machines.get(r.machine_id) : null;
  let present = null;
  if (open) {
    const pm = open.machine_id ? machines.get(open.machine_id) : null;
    present = { since: open.started_at, bu: open.bu, machineId: open.machine_id, machineName: pm ? pm.name : null, stale: store.isStale(open, nowMs) };
  }
  return {
    id: r.id, firstName: r.first_name, lastName: r.last_name, name: `${r.first_name} ${r.last_name}`.trim(),
    jobTitle: r.job_title, contract: r.contract, weeklyHours: r.weekly_hours,
    hourlyCost: r.hourly_cost_cents == null ? null : r.hourly_cost_cents / 100,
    bu: r.bu, machineId: r.machine_id, machineName: m ? m.name : null,
    hasPin: !!r.pin_hash, badgeHint: r.badge_uid_hash ? (r.badge_hint || '…') : null,
    active: !!r.active, notes: r.notes, createdAt: r.created_at,
    locked: loginGuard.status(lockKey(r.id)).locked,
    present,
  };
}
const machineOut = (m) => ({ id: m.id, name: m.name, bu: m.bu, capacityKg: m.capacity_kg, throughputKgh: m.throughput_kgh, active: !!m.active, sortOrder: m.sort_order });

function loadAll() {
  const nowMs = Date.now();
  const machineRows = db.prepare('SELECT * FROM machines ORDER BY active DESC, sort_order, name').all();
  const machines = new Map(machineRows.map(m => [m.id, m]));
  const openByEmp = new Map(store.allOpenEntries().map(e => [e.employee_id, e]));
  const employees = db.prepare('SELECT * FROM employees ORDER BY active DESC, first_name COLLATE NOCASE, last_name COLLATE NOCASE').all()
    .map(r => employeeOut(r, openByEmp, machines, nowMs));
  return { nowMs, machineRows, machines, employees };
}

function toFixCount(nowMs) {
  const forgotten = db.prepare(`SELECT COUNT(*) n FROM time_entries WHERE end_reason = 'oubli' AND edited_at IS NULL`).get().n;
  const stale = store.allOpenEntries().filter(e => store.isStale(e, nowMs)).length;
  return forgotten + stale;
}

// GET /api/admin/rh/overview — tout ce qu'il faut pour les écrans Présence, Collaborateurs et Machines.
router.get('/overview', (req, res) => {
  const { nowMs, machineRows, employees } = loadAll();
  res.json({
    now: new Date(nowMs).toISOString(), bus: rh.BUS, contracts: rh.CONTRACTS,
    machines: machineRows.map(machineOut), employees, toFix: toFixCount(nowMs),
  });
});

// ---------- machines ----------
function readMachine(body, current) {
  const name = clean(body.name !== undefined ? body.name : current && current.name, 60);
  if (!name) return { error: 'Donnez un nom à la machine.' };
  const bu = body.bu !== undefined ? body.bu : current && current.bu;
  if (!rh.BU_IDS.includes(bu)) return { error: 'Choisissez l\'unité (BU) de la machine.' };
  let cap = body.capacityKg !== undefined ? body.capacityKg : current && current.capacity_kg;
  if (cap === '' || cap == null) cap = null;
  else { cap = Number(String(cap).replace(',', '.')); if (!Number.isFinite(cap) || cap <= 0 || cap > 1000) return { error: 'Capacité en kg invalide.' }; }
  let tph = body.throughputKgh !== undefined ? body.throughputKgh : current && current.throughput_kgh;
  if (tph === '' || tph == null) tph = null;
  else { tph = Number(String(tph).replace(',', '.')); if (!Number.isFinite(tph) || tph <= 0 || tph > 5000) return { error: 'Cadence en kg/h invalide.' }; }
  const sort = body.sortOrder !== undefined ? Math.trunc(Number(body.sortOrder)) || 0 : (current ? current.sort_order : 0);
  const active = body.active !== undefined ? (body.active ? 1 : 0) : (current ? current.active : 1);
  return { name, bu, cap, tph, sort, active };
}

router.post('/machines', (req, res) => {
  const v = readMachine(req.body || {}, null);
  if (v.error) return bad(res, v.error);
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 n FROM machines').get().n;
  const info = db.prepare('INSERT INTO machines (name, bu, capacity_kg, throughput_kgh, sort_order) VALUES (?, ?, ?, ?, ?)').run(v.name, v.bu, v.cap, v.tph, req.body.sortOrder !== undefined ? v.sort : next);
  res.status(201).json({ machine: machineOut(store.machineById.get(info.lastInsertRowid)) });
});

router.put('/machines/:id', (req, res) => {
  const cur = store.machineById.get(Number(req.params.id));
  if (!cur) return bad(res, 'Machine introuvable.', 404);
  const v = readMachine(req.body || {}, cur);
  if (v.error) return bad(res, v.error);
  db.transaction(() => {
    db.prepare('UPDATE machines SET name = ?, bu = ?, capacity_kg = ?, throughput_kgh = ?, sort_order = ?, active = ? WHERE id = ?').run(v.name, v.bu, v.cap, v.tph, v.sort, v.active, cur.id);
    // Les collaborateurs rattachés à la machine suivent son unité.
    if (v.bu !== cur.bu) db.prepare('UPDATE employees SET bu = ? WHERE machine_id = ?').run(v.bu, cur.id);
  })();
  res.json({ machine: machineOut(store.machineById.get(cur.id)) });
});

// Une machine déjà utilisée (collaborateur rattaché, pointage) est retirée sans effacer l'historique ; sinon elle est supprimée.
router.delete('/machines/:id', (req, res) => {
  const cur = store.machineById.get(Number(req.params.id));
  if (!cur) return bad(res, 'Machine introuvable.', 404);
  const used = db.prepare(`SELECT (SELECT COUNT(*) FROM employees WHERE machine_id = ?) + (SELECT COUNT(*) FROM time_entries WHERE machine_id = ?)
    + (SELECT COUNT(*) FROM lot_steps WHERE machine_id = ?) + (SELECT COUNT(*) FROM machine_incidents WHERE machine_id = ?) n`).get(cur.id, cur.id, cur.id, cur.id).n;
  if (used) {
    db.transaction(() => {
      db.prepare('UPDATE machines SET active = 0 WHERE id = ?').run(cur.id);
      db.prepare('UPDATE employees SET machine_id = NULL WHERE machine_id = ?').run(cur.id);
    })();
    return res.json({ ok: true, archived: true });
  }
  db.prepare('DELETE FROM machines WHERE id = ?').run(cur.id);
  res.json({ ok: true, archived: false });
});

// ---------- collaborateurs ----------
function readEmployee(body, current) {
  const has = (k) => body[k] !== undefined;
  const firstName = clean(has('firstName') ? body.firstName : current && current.first_name, 60);
  const lastName = clean(has('lastName') ? body.lastName : current && current.last_name, 60);
  if (!firstName) return { error: 'Indiquez au moins le prénom.' };
  const contract = has('contract') ? body.contract : (current ? current.contract : 'autre');
  if (!rh.CONTRACT_IDS.includes(contract)) return { error: 'Type de contrat inconnu.' };
  let weekly = has('weeklyHours') ? Number(String(body.weeklyHours).replace(',', '.')) : (current ? current.weekly_hours : 39);
  if (!Number.isFinite(weekly) || weekly <= 0 || weekly > 60) return { error: 'Durée hebdomadaire invalide (entre 1 et 60 h).' };
  let cost = has('hourlyCost') ? body.hourlyCost : (current && current.hourly_cost_cents != null ? current.hourly_cost_cents / 100 : null);
  if (cost === '' || cost == null) cost = null;
  else { cost = Number(String(cost).replace(',', '.')); if (!Number.isFinite(cost) || cost < 0 || cost > 500) return { error: 'Coût horaire invalide.' }; cost = Math.round(cost * 100); }
  // Rattachement : une machine (qui impose son unité) ou une unité seule.
  let bu = has('bu') ? body.bu : current && current.bu;
  let machineId = has('machineId') ? (body.machineId === '' ? null : body.machineId) : (current ? current.machine_id : null);
  if (machineId != null) {
    const m = store.machineById.get(Number(machineId));
    if (!m || !m.active) return { error: 'Machine inconnue ou retirée.' };
    machineId = m.id; bu = m.bu;
  }
  if (!rh.BU_IDS.includes(bu)) return { error: 'Rattachez le collaborateur à une unité (BU) ou à une machine.' };
  return {
    firstName, lastName, contract, weekly, cost, bu, machineId,
    jobTitle: clean(has('jobTitle') ? body.jobTitle : current && current.job_title, 80) || null,
    notes: clean(has('notes') ? body.notes : current && current.notes, 500) || null,
  };
}

/** Code personnel et badge : champs facultatifs, appliqués s'ils sont fournis. Renvoie { error } ou les colonnes à écrire. */
function readSecrets(body, employeeId) {
  const out = {};
  if (body.pin !== undefined && body.pin !== '' && body.pin !== null) {
    const problem = rh.pinProblem(body.pin);
    if (problem) return { error: problem };
    out.pin_hash = rh.hashPin(String(body.pin));
  }
  if (body.badgeUid !== undefined) {
    if (body.badgeUid === '' || body.badgeUid === null) { out.badge_uid_hash = null; out.badge_hint = null; }
    else {
      const h = rh.uidHash(body.badgeUid);
      if (!h || rh.normUid(body.badgeUid).length < 4) return { error: 'Numéro de badge trop court : passez le badge devant le lecteur.' };
      const other = db.prepare('SELECT id, first_name FROM employees WHERE badge_uid_hash = ? AND id != ?').get(h, employeeId || 0);
      if (other) return { error: `Ce badge est déjà attribué à ${other.first_name}.` };
      out.badge_uid_hash = h; out.badge_hint = rh.uidHint(body.badgeUid);
    }
  }
  return out;
}

function oneEmployee(id) {
  const all = loadAll();
  return all.employees.find(e => e.id === id);
}

router.post('/employees', (req, res) => {
  const body = req.body || {};
  const v = readEmployee(body, null);
  if (v.error) return bad(res, v.error);
  const sec = readSecrets(body, null);
  if (sec.error) return bad(res, sec.error);
  const info = db.prepare(`INSERT INTO employees (first_name, last_name, job_title, contract, weekly_hours, hourly_cost_cents, bu, machine_id, pin_hash, badge_uid_hash, badge_hint, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(v.firstName, v.lastName, v.jobTitle, v.contract, v.weekly, v.cost, v.bu, v.machineId, sec.pin_hash || null, sec.badge_uid_hash || null, sec.badge_hint || null, v.notes);
  res.status(201).json({ employee: oneEmployee(Number(info.lastInsertRowid)) });
});

router.put('/employees/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
  if (!cur) return bad(res, 'Collaborateur introuvable.', 404);
  const body = req.body || {};
  const v = readEmployee(body, cur);
  if (v.error) return bad(res, v.error);
  const sec = readSecrets(body, cur.id);
  if (sec.error) return bad(res, sec.error);
  const active = body.active !== undefined ? (body.active ? 1 : 0) : cur.active;
  const pin_hash = sec.pin_hash !== undefined ? sec.pin_hash : cur.pin_hash;
  const badge_uid_hash = sec.badge_uid_hash !== undefined ? sec.badge_uid_hash : cur.badge_uid_hash;
  const badge_hint = sec.badge_uid_hash !== undefined ? sec.badge_hint : cur.badge_hint;
  db.transaction(() => {
    db.prepare(`UPDATE employees SET first_name = ?, last_name = ?, job_title = ?, contract = ?, weekly_hours = ?, hourly_cost_cents = ?, bu = ?, machine_id = ?,
      pin_hash = ?, badge_uid_hash = ?, badge_hint = ?, notes = ?, active = ?, archived_at = ? WHERE id = ?`)
      .run(v.firstName, v.lastName, v.jobTitle, v.contract, v.weekly, v.cost, v.bu, v.machineId, pin_hash, badge_uid_hash, badge_hint, v.notes, active,
        active ? null : (cur.archived_at || new Date().toISOString()), cur.id);
    // Quelqu'un qui quitte l'équipe ne reste pas « présent ».
    if (!active && cur.active) {
      const open = store.openEntry(cur.id);
      if (open) store.closeEntry(open.id, Date.now(), 'archive');
    }
  })();
  if (sec.pin_hash) loginGuard.ok(lockKey(cur.id));
  res.json({ employee: oneEmployee(cur.id) });
});

// Un collaborateur n'est jamais effacé (ses heures font partie de l'historique) : il est archivé, et peut être réactivé.
router.delete('/employees/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(req.params.id));
  if (!cur) return bad(res, 'Collaborateur introuvable.', 404);
  db.transaction(() => {
    db.prepare('UPDATE employees SET active = 0, archived_at = COALESCE(archived_at, ?) WHERE id = ?').run(new Date().toISOString(), cur.id);
    const open = store.openEntry(cur.id);
    if (open) store.closeEntry(open.id, Date.now(), 'archive');
  })();
  res.json({ ok: true, employee: oneEmployee(cur.id) });
});

// Débloque un collaborateur dont le code a été saisi faux trop de fois à la badgeuse.
router.post('/employees/:id/unlock', (req, res) => {
  const cur = db.prepare('SELECT id FROM employees WHERE id = ?').get(Number(req.params.id));
  if (!cur) return bad(res, 'Collaborateur introuvable.', 404);
  loginGuard.ok(lockKey(cur.id));
  res.json({ ok: true });
});

// ---------- tablettes de badgeuse ----------
const terminalOut = (t) => ({ id: t.id, label: t.label, createdAt: t.created_at, lastSeenAt: t.last_seen_at, revoked: !!t.revoked_at });

router.get('/terminals', (req, res) => {
  res.json({ terminals: db.prepare('SELECT * FROM badge_terminals ORDER BY revoked_at IS NOT NULL, id DESC').all().map(terminalOut) });
});

// Le jeton n'est montré qu'ici, une seule fois : seule son empreinte est conservée.
router.post('/terminals', (req, res) => {
  const label = clean((req.body || {}).label, 60);
  if (!label) return bad(res, 'Donnez un nom à la tablette (ex. « Atelier — entrée »).');
  const token = rh.newToken();
  const info = db.prepare('INSERT INTO badge_terminals (label, token_hash) VALUES (?, ?)').run(label, rh.tokenHash(token));
  securityLog.record('badgeuse_terminal_created', req, label);
  res.status(201).json({ terminal: terminalOut(db.prepare('SELECT * FROM badge_terminals WHERE id = ?').get(info.lastInsertRowid)), token, path: `/badgeuse#${token}` });
});

router.delete('/terminals/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM badge_terminals WHERE id = ?').get(Number(req.params.id));
  if (!t) return bad(res, 'Tablette introuvable.', 404);
  db.prepare('UPDATE badge_terminals SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(new Date().toISOString(), t.id);
  securityLog.record('badgeuse_terminal_revoked', req, t.label);
  res.json({ ok: true });
});

// ---------- pointages ----------
function readRange(req) {
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!rh.isDate(from) || !rh.isDate(to)) return { error: 'Période invalide.' };
  if (to < from) return { error: 'La fin de période précède le début.' };
  if ((Date.parse(to) - Date.parse(from)) / rh.DAY > MAX_SPAN_DAYS) return { error: `Période trop longue (${MAX_SPAN_DAYS} jours au plus).` };
  return { from, to };
}

function entriesIn(from, to, employeeId) {
  const fromIso = new Date(rh.parisMidnightMs(from)).toISOString();
  const toIso = new Date(rh.parisMidnightMs(rh.addDays(to, 1))).toISOString();
  const args = [toIso, fromIso];
  let sql = `SELECT te.*, e.first_name, e.last_name, m.name AS machine_name FROM time_entries te
    JOIN employees e ON e.id = te.employee_id LEFT JOIN machines m ON m.id = te.machine_id
    WHERE te.started_at < ? AND (te.ended_at IS NULL OR te.ended_at > ?)`;
  if (employeeId) { sql += ' AND te.employee_id = ?'; args.push(employeeId); }
  return db.prepare(sql + ' ORDER BY te.started_at DESC, te.id DESC').all(...args);
}

function entryOut(r, nowMs) {
  const s = Date.parse(r.started_at);
  const stale = store.isStale(r, nowMs);
  const e = r.ended_at ? Date.parse(r.ended_at) : null;
  const effEnd = e != null ? e : (stale ? s : nowMs);
  return {
    id: r.id, employeeId: r.employee_id, name: `${r.first_name} ${r.last_name}`.trim(),
    date: rh.parisDate(s), start: rh.hhmm(s), end: e != null ? rh.hhmm(e) : null,
    endDate: e != null ? rh.parisDate(e) : null,
    startedAt: r.started_at, endedAt: r.ended_at, minutes: Math.max(0, Math.round((effEnd - s) / 60000)),
    open: !r.ended_at && !stale, stale: stale || (r.end_reason === 'oubli' && !r.edited_at),
    endReason: r.end_reason, bu: r.bu, machineId: r.machine_id, machineName: r.machine_name,
    poste: store.posteLabel(r.bu, r.machine_name), source: r.source, note: r.note, edited: !!r.edited_at,
  };
}

router.get('/entries', (req, res) => {
  const range = readRange(req);
  if (range.error) return bad(res, range.error);
  const nowMs = Date.now();
  const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;
  res.json({ ...range, entries: entriesIn(range.from, range.to, employeeId).map(r => entryOut(r, nowMs)) });
});

// Pointages à corriger : badge oublié (départ non enregistré) — à compléter avec la vraie heure de fin.
router.get('/entries/to-fix', (req, res) => {
  const nowMs = Date.now();
  const rows = db.prepare(`SELECT te.*, e.first_name, e.last_name, m.name AS machine_name FROM time_entries te
    JOIN employees e ON e.id = te.employee_id LEFT JOIN machines m ON m.id = te.machine_id
    WHERE (te.end_reason = 'oubli' AND te.edited_at IS NULL) OR te.ended_at IS NULL ORDER BY te.started_at DESC LIMIT 200`).all()
    .filter(r => r.ended_at || store.isStale(r, nowMs));
  res.json({ entries: rows.map(r => entryOut(r, nowMs)) });
});

/** Lit date + heures saisies (heure de Paris) et vérifie le poste. */
function readEntryBody(body, employeeId, ignoreId, nowMs) {
  const date = String(body.date || '');
  if (!rh.isDate(date)) return { error: 'Date invalide.' };
  if (!rh.isHhmm(body.start)) return { error: 'Heure d\'arrivée invalide (format HH:MM).' };
  const startMs = rh.parisLocalMs(date, body.start);
  let endMs = null;
  if (body.end !== undefined && body.end !== null && body.end !== '') {
    if (!rh.isHhmm(body.end)) return { error: 'Heure de départ invalide (format HH:MM).' };
    endMs = rh.parisLocalMs(date, body.end);
    if (endMs <= startMs) return { error: 'Le départ doit être après l\'arrivée.' };
  } else if (date !== rh.parisDate(nowMs)) {
    return { error: 'Indiquez l\'heure de départ (seul un pointage d\'aujourd\'hui peut rester en cours).' };
  }
  if (startMs > nowMs + 60000 || (endMs != null && endMs > nowMs + 60000)) return { error: 'Cette heure est dans le futur.' };
  const poste = store.resolvePoste({ bu: body.bu, machineId: body.machineId });
  if (poste.error) return { error: poste.error };
  const others = db.prepare('SELECT id, started_at, ended_at FROM time_entries WHERE employee_id = ? AND id != ?').all(employeeId, ignoreId || 0);
  for (const o of others) {
    const os = Date.parse(o.started_at);
    const oe = o.ended_at ? Date.parse(o.ended_at) : (store.isStale(o, nowMs) ? os : Infinity);
    if (oe <= os) continue;   // oubli : durée nulle
    if (startMs < oe && (endMs == null ? Infinity : endMs) > os) {
      return { error: `Chevauche un autre pointage de ce collaborateur (${rh.parisDate(os)} ${rh.hhmm(os)}${o.ended_at ? '–' + rh.hhmm(oe) : ', en cours'}).`, status: 409 };
    }
  }
  return { startMs, endMs, bu: poste.bu, machineId: poste.machineId, note: clean(body.note, 200) || null };
}

router.post('/entries', (req, res) => {
  const body = req.body || {};
  const emp = db.prepare('SELECT id FROM employees WHERE id = ?').get(Number(body.employeeId));
  if (!emp) return bad(res, 'Choisissez un collaborateur.');
  const nowMs = Date.now();
  const v = readEntryBody(body, emp.id, 0, nowMs);
  if (v.error) return bad(res, v.error, v.status || 400);
  const id = store.startEntry({ employeeId: emp.id, atMs: v.startMs, bu: v.bu, machineId: v.machineId, source: 'manuel', note: v.note, endedMs: v.endMs, endReason: v.endMs ? 'depart' : null });
  res.status(201).json({ entry: entryOut(db.prepare(`SELECT te.*, e.first_name, e.last_name, m.name AS machine_name FROM time_entries te JOIN employees e ON e.id = te.employee_id LEFT JOIN machines m ON m.id = te.machine_id WHERE te.id = ?`).get(id), nowMs) });
});

router.put('/entries/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(Number(req.params.id));
  if (!cur) return bad(res, 'Pointage introuvable.', 404);
  const nowMs = Date.now();
  const v = readEntryBody(req.body || {}, cur.employee_id, cur.id, nowMs);
  if (v.error) return bad(res, v.error, v.status || 400);
  db.prepare(`UPDATE time_entries SET started_at = ?, ended_at = ?, end_reason = ?, bu = ?, machine_id = ?, note = ?, edited_at = ? WHERE id = ?`)
    .run(new Date(v.startMs).toISOString(), v.endMs == null ? null : new Date(v.endMs).toISOString(), v.endMs == null ? null : (cur.end_reason === 'pause' ? 'pause' : 'depart'),
      v.bu, v.machineId, v.note, new Date(nowMs).toISOString(), cur.id);
  res.json({ entry: entryOut(db.prepare(`SELECT te.*, e.first_name, e.last_name, m.name AS machine_name FROM time_entries te JOIN employees e ON e.id = te.employee_id LEFT JOIN machines m ON m.id = te.machine_id WHERE te.id = ?`).get(cur.id), nowMs) });
});

router.delete('/entries/:id', (req, res) => {
  const cur = db.prepare('SELECT id FROM time_entries WHERE id = ?').get(Number(req.params.id));
  if (!cur) return bad(res, 'Pointage introuvable.', 404);
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(cur.id);
  res.json({ ok: true });
});

// ---------- heures ----------
router.get('/hours', (req, res) => {
  const range = readRange(req);
  if (range.error) return bad(res, range.error);
  res.json(buildHours(range.from, range.to, Date.now()));
});

// ---------- export CSV (Excel français : séparateur « ; », BOM, virgule décimale) ----------
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // pas de formule déclenchée à l'ouverture dans Excel
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const hours = (min) => (min / 60).toFixed(2).replace('.', ',');

router.get('/export.csv', (req, res) => {
  const range = readRange(req);
  if (range.error) return bad(res, range.error);
  const nowMs = Date.now();
  const lines = [];
  if (req.query.kind === 'summary') {
    const h = buildHours(range.from, range.to, nowMs);
    lines.push(['Collaborateur', 'Contrat', 'Unité', 'Heures prévues / semaine', 'Total période (h)', ...h.weeks.map(w => `Semaine du ${w} (h)`), 'Heures au-delà du contrat (h)'].map(cell).join(';'));
    for (const e of h.employees.filter(x => x.total || x.active)) {
      const over = e.weeks.reduce((s, w) => s + Math.max(0, w.min - Math.round(e.weeklyHours * 60)), 0);
      lines.push([e.name, (rh.CONTRACTS.find(c => c.id === e.contract) || {}).label || e.contract, rh.buLabel(e.bu), String(e.weeklyHours).replace('.', ','),
        hours(e.total), ...e.weeks.map(w => hours(w.min)), hours(over)].map(cell).join(';'));
    }
  } else {
    lines.push(['Date', 'Collaborateur', 'Unité', 'Machine', 'Arrivée', 'Départ', 'Durée (h)', 'Fin', 'Saisie'].map(cell).join(';'));
    const reasons = { depart: 'Départ', pause: 'Pause', poste: 'Changement de poste', oubli: 'Oubli', archive: 'Archivage' };
    for (const r of entriesIn(range.from, range.to, null).reverse()) {
      const o = entryOut(r, nowMs);
      lines.push([o.date, o.name, rh.buLabel(o.bu), o.machineName || '', o.start, o.end || (o.open ? 'en cours' : 'oubli'), hours(o.minutes),
        reasons[o.endReason] || '', o.source === 'manuel' ? 'Manuelle' : 'Badgeuse'].map(cell).join(';'));
    }
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${req.query.kind === 'summary' ? 'heures' : 'pointages'}-${range.from}_${range.to}.csv"`,
  });
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

module.exports = router;
