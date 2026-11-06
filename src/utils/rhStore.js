// Accès aux données RH partagés par l'administration (routes/rh.js) et la badgeuse (routes/badgeuse.js).
const db = require('../db');
const rh = require('./rh');

const machineById = db.prepare('SELECT * FROM machines WHERE id = ?');
const openStmt = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1');
const allOpenStmt = db.prepare('SELECT * FROM time_entries WHERE ended_at IS NULL');
const insertEntry = db.prepare(`INSERT INTO time_entries (employee_id, started_at, ended_at, end_reason, bu, machine_id, source, terminal_id, note)
  VALUES (@employee_id, @started_at, @ended_at, @end_reason, @bu, @machine_id, @source, @terminal_id, @note)`);
const closeStmt = db.prepare('UPDATE time_entries SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL');

const STALE_HOURS = 16;

/** Un pointage resté ouvert depuis la veille (ou plus de 16 h) est un oubli de badge : il ne compte pas comme du temps de présence. */
function isStale(entry, nowMs) {
  if (!entry || entry.ended_at) return false;
  const s = Date.parse(entry.started_at);
  return rh.parisDate(s) < rh.parisDate(nowMs) || nowMs - s > STALE_HOURS * 3600e3;
}

/** Pointages prêts pour le calcul : un oubli encore ouvert est compté pour zéro (et signalé) au lieu de courir jusqu'à maintenant. */
function effectiveEntries(rows, nowMs) {
  return rows.map(e => (isStale(e, nowMs) ? { ...e, ended_at: e.started_at, _stale: true } : e));
}

const openEntry = (employeeId) => openStmt.get(employeeId) || null;
const allOpenEntries = () => allOpenStmt.all();

/** Valide un poste : une machine active (la BU en découle) ou une BU seule. */
function resolvePoste({ bu, machineId }) {
  if (machineId !== undefined && machineId !== null && machineId !== '') {
    const m = machineById.get(Number(machineId));
    if (!m || !m.active) return { error: 'Cette machine n\'existe plus ou a été retirée.' };
    return { bu: m.bu, machineId: m.id, machine: m };
  }
  if (!rh.BU_IDS.includes(bu)) return { error: 'Unité inconnue.' };
  return { bu, machineId: null, machine: null };
}

function posteLabel(bu, machineName) {
  return machineName ? `${machineName} · ${rh.buLabel(bu)}` : rh.buLabel(bu);
}

function startEntry({ employeeId, atMs, bu, machineId, source = 'badgeuse', terminalId = null, note = null, endedMs = null, endReason = null }) {
  const info = insertEntry.run({
    employee_id: employeeId, started_at: new Date(atMs).toISOString(), ended_at: endedMs == null ? null : new Date(endedMs).toISOString(),
    end_reason: endReason, bu, machine_id: machineId || null, source, terminal_id: terminalId, note,
  });
  return Number(info.lastInsertRowid);
}
const closeEntry = (id, atMs, reason) => closeStmt.run(new Date(atMs).toISOString(), reason, id).changes > 0;

/** Minutes pointées aujourd'hui (heure de Paris) par un collaborateur. */
function minutesToday(employeeId, nowMs) {
  const today = rh.parisDate(nowMs);
  const fromIso = new Date(rh.parisMidnightMs(today)).toISOString();
  const rows = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND (ended_at IS NULL OR ended_at > ?)').all(employeeId, fromIso);
  return rh.accumulate(effectiveEntries(rows, nowMs), today, today, nowMs).reduce((s, r) => s + r.min, 0);
}

module.exports = { machineById, STALE_HOURS, isStale, effectiveEntries, openEntry, allOpenEntries, resolvePoste, posteLabel, startEntry, closeEntry, minutesToday };
