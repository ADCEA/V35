// Outils communs à la partie RH (équipe, postes, badgeuse) : unités, codes personnels, badges, calcul des durées.
const crypto = require('crypto');

// ---------- unités (BU) et contrats ----------
const BUS = [
  { id: 'lavage', label: 'Lavage' },
  { id: 'sechage', label: 'Séchage' },
  { id: 'finition', label: 'Finition' },
  { id: 'logistique', label: 'Logistique' },
  { id: 'admin', label: 'Administratif' },
];
const BU_IDS = BUS.map(b => b.id);
const buLabel = (id) => (BUS.find(b => b.id === id) || { label: id }).label;

const CONTRACTS = [
  { id: 'cdi', label: 'CDI' },
  { id: 'cdd', label: 'CDD' },
  { id: 'interim', label: 'Intérim' },
  { id: 'saisonnier', label: 'Saisonnier' },
  { id: 'apprenti', label: 'Apprentissage' },
  { id: 'autre', label: 'Autre' },
];
const CONTRACT_IDS = CONTRACTS.map(c => c.id);

// ---------- code personnel (PIN) ----------
// 4 à 6 chiffres, conservés uniquement sous forme d'empreinte salée (scrypt).
function pinProblem(pin) {
  const p = String(pin == null ? '' : pin);
  if (!/^\d{4,6}$/.test(p)) return 'Le code personnel doit comporter 4 à 6 chiffres.';
  if (/^(\d)\1+$/.test(p)) return 'Code trop simple (même chiffre répété) : choisissez-en un autre.';
  if ('0123456789012'.includes(p) || '9876543210987'.includes(p)) return 'Code trop simple (suite de chiffres) : choisissez-en un autre.';
  return null;
}
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPin(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const got = crypto.scryptSync(String(pin == null ? '' : pin), Buffer.from(parts[1], 'hex'), expected.length);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// ---------- badge (lecteur de proximité) ----------
// Les lecteurs USB « clavier » envoient le numéro du badge puis Entrée. On ne garde que son empreinte.
const normUid = (uid) => String(uid == null ? '' : uid).trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
function uidHash(uid) {
  const n = normUid(uid);
  return n ? crypto.createHash('sha256').update('badge:' + n).digest('hex') : null;
}
const uidHint = (uid) => { const n = normUid(uid); return n ? '…' + n.slice(-4) : null; };

// ---------- jetons de tablette ----------
const newToken = () => crypto.randomBytes(32).toString('hex');
const tokenHash = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');

// ---------- heure de Paris ----------
const TZ = 'Europe/Paris';
const DAY = 86400000;
const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' });
function offsetMs(ms) {
  const part = offsetFmt.formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName');
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part ? part.value : '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000;
}
/** Date (AAAA-MM-JJ) à Paris d'un instant. */
const parisDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
/** Instant du minuit parisien d'une date AAAA-MM-JJ. */
function parisMidnightMs(date) {
  const g = Date.parse(date + 'T00:00:00Z');
  return g - offsetMs(g);
}
/** Instant correspondant à « date, HH:MM » à Paris. */
function parisLocalMs(date, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const mid = parisMidnightMs(date);
  const guess = mid + (h * 60 + m) * 60000;
  return guess - (offsetMs(guess) - offsetMs(mid));
}
const hhmm = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const isHhmm = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
function addDays(date, n) { return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10); }
/** Lundi de la semaine d'une date. */
function weekStart(date) {
  const d = new Date(date + 'T00:00:00Z');
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}
/** Découpe un intervalle [a, b[ aux minuits parisiens : [{ date, ms }]. */
function splitByDay(a, b) {
  const out = [];
  let cur = a;
  while (cur < b) {
    const date = parisDate(cur);
    const next = Math.min(b, parisMidnightMs(addDays(date, 1)));
    out.push({ date, ms: next - cur });
    cur = next;
  }
  return out;
}

/**
 * Cumule les pointages sur une période.
 * `entries` : lignes time_entries (started_at, ended_at, employee_id, bu, machine_id). Un pointage sans fin court jusqu'à `nowMs`.
 * Les minutes sont arrondies par jour et par tronçon, ce qui rend tous les totaux additifs.
 */
function accumulate(entries, from, to, nowMs) {
  const fromMs = parisMidnightMs(from);
  const toMs = parisMidnightMs(addDays(to, 1));
  const rows = [];
  for (const e of entries) {
    const s = Date.parse(e.started_at);
    const rawEnd = e.ended_at ? Date.parse(e.ended_at) : nowMs;
    const a = Math.max(s, fromMs), b = Math.min(rawEnd, toMs);
    if (!(b > a)) continue;
    for (const part of splitByDay(a, b)) {
      const min = Math.round(part.ms / 60000);
      if (min > 0) rows.push({ employeeId: e.employee_id, date: part.date, min, bu: e.bu, machineId: e.machine_id, open: !e.ended_at });
    }
  }
  return rows;
}

module.exports = {
  BUS, BU_IDS, buLabel, CONTRACTS, CONTRACT_IDS,
  pinProblem, hashPin, checkPin, normUid, uidHash, uidHint, newToken, tokenHash,
  TZ, DAY, parisDate, parisMidnightMs, parisLocalMs, hhmm, isDate, isHhmm, addDays, weekStart, splitByDay, accumulate,
};
