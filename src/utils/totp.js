// Code à usage unique à 6 chiffres (TOTP, RFC 6238) — compatible avec toutes les applications d'authentification
// (Google Authenticator, Microsoft Authenticator, Authy, 1Password, Mots de passe d'Apple…). Aucune bibliothèque externe.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_S = 30, DIGITS = 6;

function base32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

const newSecret = () => base32encode(crypto.randomBytes(20));   // 160 bits

function hotp(secretB32, counter) {
  const key = base32decode(secretB32);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

const stepOf = (now = Date.now()) => Math.floor(now / 1000 / STEP_S);

/**
 * Vérifie un code saisi. Tolère un pas de 30 s avant ou après (horloge du téléphone légèrement décalée).
 * Renvoie le numéro du pas accepté, ou null. `afterStep` : un pas déjà utilisé ne sert qu'une fois (pas de rejeu).
 */
function verify(secretB32, token, { now = Date.now(), afterStep = -1 } = {}) {
  const t = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return null;
  const cur = stepOf(now);
  let found = null;
  for (const s of [cur - 1, cur, cur + 1]) {
    const exp = Buffer.from(hotp(secretB32, s)); const got = Buffer.from(t);
    if (crypto.timingSafeEqual(exp, got) && s > afterStep) found = found === null ? s : Math.max(found, s);
  }
  return found;
}

function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
}

/** Codes de secours : 8 codes à usage unique, affichés une seule fois ; seule l'empreinte est conservée. */
function newRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) { const raw = base32encode(crypto.randomBytes(7)).slice(0, 10); codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`); }
  return codes;
}
const recoveryHash = (code) => crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z2-7]/g, '')).digest('hex');
const looksLikeRecovery = (s) => /^[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}$/.test(String(s || '').trim());

module.exports = { newSecret, hotp, verify, stepOf, otpauthUri, newRecoveryCodes, recoveryHash, looksLikeRecovery, base32encode, base32decode, STEP_S };
