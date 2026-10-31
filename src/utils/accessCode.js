// Code d'accès d'un hôtel (espace client) : règle unique pour tous les endroits où un code est choisi.
//
// Règle actuelle : 6 à 10 chiffres, sans code trivial (tous identiques, suite 123456 / 654321, 121212…).
// Les codes déjà choisis (4 à 8 chiffres) restent valables tant que l'hôtel ne les change pas.
// CLIENT_CODE_POLICY=legacy rétablit l'ancienne règle (4 à 8 chiffres, tout accepté) — utile pour les tests, pas en production.

const legacy = () => String(process.env.CLIENT_CODE_POLICY || '').toLowerCase() === 'legacy';

const MIN = () => (legacy() ? 4 : 6);
const MAX = () => (legacy() ? 8 : 10);
const hint = () => `${MIN()} à ${MAX()} chiffres`;

function isTrivial(code) {
  if (/^(\d)\1+$/.test(code)) return true;                         // 000000, 111111…
  let up = true, down = true;
  for (let i = 1; i < code.length; i++) {
    const d = Number(code[i]) - Number(code[i - 1]);
    if (d !== 1 && !(d === -9 && code[i - 1] === '9')) up = false;   // 123456, 7890123
    if (d !== -1 && !(d === 9 && code[i - 1] === '0')) down = false; // 654321
  }
  if (up || down) return true;
  for (let p = 2; p <= 3; p++) if (code.length % p === 0 && code === code.slice(0, p).repeat(code.length / p)) return true; // 121212, 123123
  return false;
}

/** Renvoie null si le code convient, sinon le message d'erreur à afficher. */
function check(code, { who = 'code d\'accès' } = {}) {
  const c = String(code ?? '');
  if (!new RegExp(`^\\d{${MIN()},${MAX()}}$`).test(c)) return `Le ${who} doit contenir entre ${MIN()} et ${MAX()} chiffres.`;
  if (!legacy() && isTrivial(c)) return `Ce ${who} est trop facile à deviner (suite ou chiffres répétés). Choisissez-en un autre.`;
  return null;
}

/** Même contrôle, sans le message (pour les imports). */
const ok = (code) => check(code) === null;

module.exports = { check, ok, hint, MIN, MAX, isTrivial };
