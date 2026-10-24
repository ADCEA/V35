// Règles du prélèvement SEPA, sans accès à la base : validation des identifiants (IBAN, BIC, ICS, RUM),
// calendrier des jours ouvrés TARGET2, et nettoyage des textes au jeu de caractères autorisé par SEPA.
// Tout ce qui est ici est testable seul.

// Longueur d'un IBAN par pays de la zone SEPA.
const IBAN_LENGTH = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GI: 23,
  GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28,
  PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

// Lettres → chiffres (A = 10 … Z = 35), puis reste modulo 97 calculé par blocs (pas de grand entier).
const digits = (s) => s.split('').map(c => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join('');
const mod97 = (s) => { let r = 0; for (const ch of s) r = (r * 10 + Number(ch)) % 97; return r; };

const normIban = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();
const normBic = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();

/** null si l'IBAN est valide (pays de la zone SEPA, longueur, clé de contrôle), sinon la raison du refus. */
function ibanError(raw) {
  const iban = normIban(raw);
  if (!iban) return 'IBAN manquant.';
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return 'IBAN invalide : deux lettres, deux chiffres, puis le numéro de compte.';
  const len = IBAN_LENGTH[iban.slice(0, 2)];
  if (!len) return `IBAN hors zone SEPA (pays ${iban.slice(0, 2)}).`;
  if (iban.length !== len) return `IBAN invalide : ${len} caractères attendus pour ${iban.slice(0, 2)}, ${iban.length} saisis.`;
  if (mod97(digits(iban.slice(4) + iban.slice(0, 4))) !== 1) return 'IBAN invalide : la clé de contrôle ne correspond pas (faute de frappe ?).';
  return null;
}

/** BIC facultatif : null s'il est vide ou valide. */
function bicError(raw) {
  const bic = normBic(raw);
  if (!bic) return null;
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic) ? null : 'BIC invalide (8 ou 11 caractères, ex. BNPAFRPP).';
}

// Un IBAN n'apparaît jamais en clair dans le journal ni dans les réponses de liste : pays, clé et 4 derniers caractères.
function maskIban(raw) {
  const iban = normIban(raw);
  return iban.length > 8 ? `${iban.slice(0, 4)} **** ${iban.slice(-4)}` : '****';
}

const ibanGroups = (raw) => normIban(raw).replace(/(.{4})/g, '$1 ').trim();

/**
 * Identifiant créancier SEPA (ICS). Format français : FR + clé (2 chiffres) + code d'activité (3, « ZZZ » en général)
 * + identifiant national (6). La clé est calculée sur l'identifiant national, sans le code d'activité (ISO 7064 mod 97-10).
 * null si valide.
 */
function icsError(raw) {
  const ics = String(raw == null ? '' : raw).replace(/\s+/g, '').toUpperCase();
  if (!ics) return 'Identifiant créancier (ICS) manquant.';
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{3}[A-Z0-9]{1,28}$/.test(ics)) return 'ICS invalide : attendu comme FR12ZZZ123456 (pays, clé, code d\'activité, identifiant national).';
  if (ics.startsWith('FR') && ics.length !== 13) return 'ICS français invalide : 13 caractères attendus (FR + clé + ZZZ + 6 caractères).';
  const key = String(98 - mod97(digits(ics.slice(7) + ics.slice(0, 2) + '00'))).padStart(2, '0');
  if (key !== ics.slice(2, 4)) return `ICS invalide : la clé de contrôle devrait être ${key} (faute de frappe ?).`;
  return null;
}
const normIcs = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();

/** Référence unique de mandat (RUM) : 35 caractères au plus, jeu de caractères restreint, pas de « / » en début, fin ou doublé. */
function umrError(raw) {
  const umr = String(raw == null ? '' : raw);
  if (!umr) return 'Référence du mandat manquante.';
  if (umr.length > 35) return 'Référence du mandat trop longue (35 caractères au plus).';
  if (!/^[A-Za-z0-9+?/:().,'-]+$/.test(umr)) return "Référence du mandat : lettres sans accent, chiffres et + ? / - : ( ) . , ' seulement (pas d'espace).";
  if (umr.startsWith('/') || umr.endsWith('/') || umr.includes('//')) return 'Référence du mandat : pas de « / » au début ou à la fin, ni doublé.';
  return null;
}

// ---------- calendrier TARGET2 ----------
// Jours non ouvrés : samedi, dimanche, 1er janvier, Vendredi saint, lundi de Pâques, 1er mai, 25 et 26 décembre.

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const dateOf = (iso) => new Date(`${iso}T00:00:00Z`);
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(dateOf(s)) === s;
const addDays = (iso, n) => { const d = dateOf(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };

/** Dimanche de Pâques (calendrier grégorien, algorithme de Meeus/Jones/Butcher). */
function easter(year) {
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30; const i = Math.floor(c / 4); const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const holidayCache = new Map();
function targetHolidays(year) {
  if (!holidayCache.has(year)) {
    const e = easter(year);
    holidayCache.set(year, new Set([`${year}-01-01`, addDays(e, -2), addDays(e, 1), `${year}-05-01`, `${year}-12-25`, `${year}-12-26`]));
  }
  return holidayCache.get(year);
}

function isBusinessDay(iso) {
  const wd = dateOf(iso).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !targetHolidays(Number(iso.slice(0, 4))).has(iso);
}

/** Premier jour ouvré à partir de la date incluse. */
function nextBusinessDay(iso) { let d = iso; while (!isBusinessDay(d)) d = addDays(d, 1); return d; }

/** Date atteinte après n jours ouvrés (n ≥ 0) ; la date de départ n'est pas comptée. */
function addBusinessDays(iso, n) {
  let d = iso; let left = n;
  while (left > 0) { d = addDays(d, 1); if (isBusinessDay(d)) left--; }
  return d;
}

const addMonths = (iso, n) => {
  const d = dateOf(iso); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return isoOf(d);
};

// ---------- jeu de caractères SEPA ----------
// Autorisés : a-z A-Z 0-9 / - ? : ( ) . , ' + et l'espace. Le reste est remplacé (accents retirés, « & » → « ET »).

const FOLD = { 'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE', 'ß': 'ss', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L', '&': ' ET ', '’': "'", '‘': "'", '–': '-', '—': '-' };

function sepaText(raw, max = 140) {
  const s = String(raw == null ? '' : raw).replace(/[œŒæÆßøØđĐłŁ&’‘–—]/g, (c) => FOLD[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, max).trim();
}

/** Identifiant technique (MsgId, EndToEndId…) : mêmes caractères, sans espace, jamais de « / » en début, fin ou doublé. */
function sepaId(raw, max = 35) {
  return sepaText(raw, 200).replace(/ /g, '-').replace(/\/+/g, '/').replace(/^\/|\/$/g, '').slice(0, max).replace(/\/$/, '');
}

/** Montant en euros avec deux décimales, calculé sur des centimes entiers (jamais de flottant). */
const amount = (cents) => `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, '0')}`;

module.exports = {
  IBAN_LENGTH, normIban, normBic, normIcs, ibanError, bicError, maskIban, ibanGroups, icsError, umrError,
  isIso, addDays, addMonths, easter, isBusinessDay, nextBusinessDay, addBusinessDays, sepaText, sepaId, amount,
};
