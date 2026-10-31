// Limite les essais répétés (codes d'accès clients) : après MAX_FAILS échecs
// consécutifs sur une même clé, la clé est bloquée LOCK_MS. En mémoire : un
// redémarrage remet les compteurs à zéro, ce qui suffit pour freiner une
// attaque par énumération (4 chiffres = 10 000 combinaisons).
//
// La clé est l'adresse e-mail saisie (jamais l'IP : derrière le proxy de
// l'hébergeur, toutes les requêtes arrivent de la même adresse).

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_LOCK_MS = 24 * 60 * 60 * 1000;   // le blocage double à chaque récidive : 15 min, 30 min, 1 h … 24 h
const state = new Map(); // clé -> { fails, lockedUntil, last }

function sweep(now) {
  if (state.size < 500) return;
  for (const [k, v] of state) if (v.lockedUntil < now && now - v.last > MAX_LOCK_MS) state.delete(k);
}

/** Bloqué ? Renvoie { locked, retryAfterSec }. */
function status(key, now = Date.now()) {
  const s = state.get(key);
  if (s && s.lockedUntil > now) return { locked: true, retryAfterSec: Math.ceil((s.lockedUntil - now) / 1000) };
  return { locked: false, retryAfterSec: 0 };
}

/** Enregistre un échec. Renvoie l'état après cet échec. */
function fail(key, now = Date.now()) {
  sweep(now);
  const s = state.get(key) || { fails: 0, lockedUntil: 0, last: now, strikes: 0 };
  if (s.lockedUntil <= now && now - s.last > LOCK_MS) s.fails = 0; // anciens échecs oubliés
  if (s.lockedUntil <= now && s.strikes && now - s.last > MAX_LOCK_MS) s.strikes = 0; // récidive oubliée après 24 h calmes
  s.fails += 1; s.last = now;
  if (s.fails >= MAX_FAILS) { s.strikes += 1; s.lockedUntil = now + Math.min(MAX_LOCK_MS, LOCK_MS * 2 ** (s.strikes - 1)); s.fails = 0; }
  state.set(key, s);
  return status(key, now);
}

/** Succès : on oublie les échecs. */
function ok(key) { state.delete(key); }

/** Message pour l'utilisateur. */
function message(retryAfterSec) {
  const min = Math.max(1, Math.ceil(retryAfterSec / 60));
  if (min >= 120) return `Trop d'essais. Réessayez dans ${Math.ceil(min / 60)} heures, ou utilisez « Code oublié ? ».`;
  return `Trop d'essais. Réessayez dans ${min} minute${min > 1 ? 's' : ''}.`;
}

function reset() { state.clear(); }

module.exports = { status, fail, ok, message, reset, MAX_FAILS, LOCK_MS };
