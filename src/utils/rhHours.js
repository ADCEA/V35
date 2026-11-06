// Calcul des heures par collaborateur, unité (BU) et machine sur une période — partagé par l'administration RH et la Production.
const db = require('../db');
const rh = require('./rh');
const store = require('./rhStore');

function buildHours(from, to, nowMs) {
  const weekFrom = rh.weekStart(from);
  const weekTo = rh.addDays(rh.weekStart(to), 6);
  const fromIso = new Date(rh.parisMidnightMs(weekFrom)).toISOString();
  const toIso = new Date(rh.parisMidnightMs(rh.addDays(weekTo, 1))).toISOString();
  const raw = db.prepare('SELECT * FROM time_entries WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)').all(toIso, fromIso);
  const rows = rh.accumulate(store.effectiveEntries(raw, nowMs), weekFrom, weekTo, nowMs);
  const staleIds = new Set(raw.filter(e => store.isStale(e, nowMs)).map(e => e.employee_id));
  const liveIds = new Set(raw.filter(e => !e.ended_at && !store.isStale(e, nowMs)).map(e => e.employee_id));

  const machines = new Map(db.prepare('SELECT * FROM machines').all().map(m => [m.id, m]));
  const emps = db.prepare('SELECT * FROM employees').all();
  const empById = new Map(emps.map(e => [e.id, e]));
  const days = []; for (let d = from; d <= to; d = rh.addDays(d, 1)) days.push(d);
  const weeks = []; for (let w = weekFrom; w <= rh.weekStart(to); w = rh.addDays(w, 7)) weeks.push(w);

  const per = new Map();   // employeeId -> cumul
  const getP = (id) => {
    if (!per.has(id)) per.set(id, { days: {}, total: 0, weekMin: {}, byBu: {} });
    return per.get(id);
  };
  const byBu = new Map(), byMachine = new Map();
  let total = 0, totalCost = 0;
  for (const r of rows) {
    const p = getP(r.employeeId);
    const w = rh.weekStart(r.date);
    p.weekMin[w] = (p.weekMin[w] || 0) + r.min;
    if (r.date < from || r.date > to) continue;   // jours de semaines incomplètes : comptés pour la semaine seulement
    p.days[r.date] = (p.days[r.date] || 0) + r.min;
    p.total += r.min;
    p.byBu[r.bu] = (p.byBu[r.bu] || 0) + r.min;
    const emp = empById.get(r.employeeId);
    const cost = emp && emp.hourly_cost_cents != null ? Math.round(r.min * emp.hourly_cost_cents / 60) : 0;
    total += r.min; totalCost += cost;
    const b = byBu.get(r.bu) || { bu: r.bu, min: 0, costCents: 0 }; b.min += r.min; b.costCents += cost; byBu.set(r.bu, b);
    // Une ligne par machine ; les heures pointées sur une unité seule forment une ligne « unité entière ».
    const mk = r.machineId ? 'm:' + r.machineId : 'bu:' + r.bu;
    const mm = byMachine.get(mk) || { machineId: r.machineId, name: r.machineId ? ((machines.get(r.machineId) || {}).name || 'Machine retirée') : null, bu: r.bu, min: 0, costCents: 0 };
    mm.min += r.min; mm.costCents += cost; byMachine.set(mk, mm);
  }
  const employees = emps
    .filter(e => e.active || (per.get(e.id) && per.get(e.id).total))
    .map(e => {
      const p = per.get(e.id) || { days: {}, total: 0, weekMin: {}, byBu: {} };
      return {
        id: e.id, name: `${e.first_name} ${e.last_name}`.trim(), bu: e.bu, contract: e.contract, weeklyHours: e.weekly_hours, active: !!e.active,
        days: p.days, total: p.total, open: liveIds.has(e.id), forgotten: staleIds.has(e.id),
        weeks: weeks.map(w => ({ start: w, min: p.weekMin[w] || 0 })),
        costCents: e.hourly_cost_cents == null ? null : Math.round(p.total * e.hourly_cost_cents / 60),
      };
    });
  return {
    from, to, days, weeks, employees, total, costCents: totalCost,
    byBu: rh.BU_IDS.map(id => byBu.get(id) || { bu: id, min: 0, costCents: 0 }),
    byMachine: [...byMachine.values()].sort((a, b) => rh.BU_IDS.indexOf(a.bu) - rh.BU_IDS.indexOf(b.bu) || (a.name || '').localeCompare(b.name || '', 'fr')),
  };
}

module.exports = { buildHours };
