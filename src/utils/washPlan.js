// Estimation de la durée d'un lot prévu : lavage, puis séchage, puis finition, avec plusieurs machines par étape.
//
// Chaque étape reçoit des lignes « machine + kilos » (kilos vides = part automatique du poids restant, répartie au prorata de la
// capacité des laveuses ou de la cadence des sécheuses et machines de finition). Les machines d'une même étape travaillent en même temps :
// l'étape dure autant que la ligne la plus longue. Les étapes s'enchaînent : durée totale = lavage + séchage + finition (le chevauchement
// d'un lot qui avance par charges n'est pas compté, l'estimation est donc prudente).
//   - lavage : nombre de passages = kilos ÷ capacité de la laveuse (arrondi au-dessus) × durée du programme choisi ;
//   - séchage et finition : kilos ÷ cadence de la machine (kg/h).
// Sans programme ou sans cadence renseignés, on prend ce que la machine a réellement fait ces 90 derniers jours (médiane de ses
// passages terminés, au moins 3) ; sinon la ligne est « à renseigner » et le total est signalé incomplet.
const db = require('../db');
const { FAMILIES } = require('./linenFamilies');

const STAGES = ['lavage', 'sechage', 'finition'];
const LABEL = { lavage: 'Lavage', sechage: 'Séchage', finition: 'Finition' };
const HIST_DAYS = 90;
const MIN_HIST = 3;
const round1 = (n) => Math.round(n * 10) / 10;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Ce que la machine a réellement fait sur cette étape ces derniers jours : durée médiane d'un passage et cadence médiane (kg/h), ou null. */
function history(machineId, stage, nowMs = Date.now()) {
  const since = new Date(nowMs - HIST_DAYS * 86400000).toISOString();
  const rows = db.prepare('SELECT weight_kg, started_at, ended_at FROM lot_steps WHERE machine_id = ? AND stage = ? AND ended_at IS NOT NULL AND started_at >= ?').all(machineId, stage, since)
    .map(r => ({ kg: r.weight_kg, min: (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60000 }))
    .filter(r => r.kg > 0 && r.min >= 5 && r.min <= 720);   // écarte les passages restés ouverts puis clôturés d'office
  if (rows.length < MIN_HIST) return null;
  return { n: rows.length, passMin: median(rows.map(r => r.min)), kgh: median(rows.map(r => r.kg / (r.min / 60))) };
}

/** Répartit `remainder` kg entre des lignes au prorata de leur poids relatif `f` ; arrondi à 0,1 kg, le total reste exact. */
function share(remainder, factors) {
  const tot = sum(factors);
  const out = factors.map(f => round1(remainder * (tot > 0 ? f / tot : 1 / factors.length)));
  if (out.length) out[out.length - 1] = Math.max(0, round1(remainder - sum(out.slice(0, -1))));
  return out;
}

/**
 * lines : [{ stage, machineId, programId, weightKg|null }] ; totalKg : poids du lot (null si inconnu).
 * Renvoie { weightKg, stages: { lavage|sechage|finition: { label, planned, kg, minutes, incomplete, lines[] } }, minutes: { lavage, sechage, finition, total }, incomplete, warnings[] }.
 */
function estimate({ totalKg, lines }, nowMs = Date.now()) {
  const warnings = [];
  const total = totalKg != null && totalKg > 0 ? totalKg : null;
  const machines = new Map(db.prepare('SELECT * FROM machines').all().map(m => [m.id, m]));
  const programs = new Map(db.prepare('SELECT * FROM wash_programs').all().map(p => [p.id, p]));
  const stages = {};
  const minutes = {};

  for (const stage of STAGES) {
    const mine = (lines || []).filter(l => l.stage === stage && machines.has(l.machineId));
    const explicit = mine.filter(l => l.weightKg != null);
    const auto = mine.filter(l => l.weightKg == null);
    const taken = round1(sum(explicit.map(l => l.weightKg)));
    const eff = (m) => {   // cadence utilisée pour répartir : celle de la fiche, sinon l'historique, sinon la capacité
      const h = history(m.id, stage, nowMs);
      return m.throughput_kgh || (h && h.kgh) || m.capacity_kg || 1;
    };
    let autoKg = [];
    if (auto.length) {
      if (total == null) autoKg = auto.map(() => null);
      else {
        const rest = round1(total - taken);
        if (rest < -0.05) { warnings.push(`${LABEL[stage]} : les kilos saisis (${taken} kg) dépassent le poids du lot (${total} kg).`); autoKg = auto.map(() => 0); }
        else autoKg = share(Math.max(0, rest), auto.map(l => { const m = machines.get(l.machineId); return stage === 'lavage' ? (m.capacity_kg || 1) : eff(m); }));
      }
    } else if (mine.length && total != null) {
      if (taken < total - 0.05) warnings.push(`${LABEL[stage]} : ${round1(total - taken)} kg du lot n'ont pas de machine.`);
      else if (taken > total + 0.05) warnings.push(`${LABEL[stage]} : les kilos saisis (${taken} kg) dépassent le poids du lot (${total} kg).`);
    }
    let a = 0;
    const noProgram = [], noRate = [];
    const out = mine.map(l => {
      const m = machines.get(l.machineId);
      const isAuto = l.weightKg == null;
      const kg = isAuto ? autoKg[a++] : l.weightKg;
      const r = { machineId: m.id, machineName: m.name, capacityKg: m.capacity_kg || null, programId: null, programName: null, weightKg: kg, auto: isAuto, passes: null, passMin: null, minutes: null, source: null };
      if (kg == null) { warnings.push(`${LABEL[stage]} · ${m.name} : indiquez le poids du lot pour répartir automatiquement.`); return r; }
      const h = history(m.id, stage, nowMs);
      if (stage === 'lavage') {
        const pr = l.programId ? programs.get(l.programId) : null;
        if (pr) { r.programId = pr.id; r.programName = pr.name; }
        r.passes = kg > 0 ? (m.capacity_kg ? Math.ceil(kg / m.capacity_kg - 1e-9) : 1) : 0;
        if (pr && pr.duration_min) { r.passMin = pr.duration_min; r.source = 'programme'; }
        else if (h) { r.passMin = Math.round(h.passMin); r.source = 'historique'; }
        if (r.passMin != null) r.minutes = Math.round(r.passes * r.passMin);
        else noProgram.push(m.name);
      } else {
        if (m.capacity_kg) r.passes = kg > 0 ? Math.ceil(kg / m.capacity_kg - 1e-9) : 0;
        const kgh = m.throughput_kgh || (h && h.kgh) || null;
        if (kgh) { r.minutes = Math.round(kg / kgh * 60); r.source = m.throughput_kgh ? 'cadence' : 'historique'; r.kgh = round1(kgh); }
        else noRate.push(m.name);
      }
      return r;
    });
    if (noProgram.length) warnings.push(`${LABEL[stage]} : choisissez un programme avec sa durée pour ${noProgram.join(', ')}.`);
    if (noRate.length) warnings.push(`${LABEL[stage]} : cadence (kg/h) non renseignée pour ${noRate.join(', ')} — à ajouter dans Équipe → Machines.`);
    const known = out.filter(r => r.minutes != null).map(r => r.minutes);
    const incomplete = out.some(r => r.minutes == null);
    stages[stage] = { label: LABEL[stage], planned: out.length > 0, kg: round1(sum(out.map(r => r.weightKg || 0))), minutes: known.length ? Math.max(...known) : null, incomplete, lines: out };
    minutes[stage] = stages[stage].minutes;
  }

  const planned = STAGES.filter(s => stages[s].planned);
  const incomplete = planned.some(s => stages[s].incomplete || stages[s].minutes == null);
  minutes.total = planned.length ? sum(planned.map(s => stages[s].minutes || 0)) : null;
  return {
    weightKg: total, stages, minutes: { ...minutes }, incomplete, missingStages: STAGES.filter(s => !stages[s].planned), warnings,
  };
}

const familyList = (fams) => {
  const total = sum(Object.values(fams || {}));
  return FAMILIES.map(f => ({ id: f.id, label: f.label, weightKg: (fams && fams[f.id]) || 0, pct: total > 0 ? Math.round(((fams[f.id] || 0) / total) * 100) : 0 }));
};

module.exports = { STAGES, LABEL, FAMILIES, estimate, history, familyList, share };
