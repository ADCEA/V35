// Protection de l'espace administration.
//
//  - en-têtes de sécurité (pas d'affichage de l'app dans le cadre d'un autre site, pas de devinette de type de fichier…) ;
//  - contrôle d'origine des requêtes qui modifient des données (défense contre les requêtes déclenchées depuis un autre site) ;
//  - limite d'essais sur le mot de passe administrateur : blocage par adresse après trop d'échecs, durée croissante,
//    et ralentissement général si le site est attaqué depuis beaucoup d'adresses (sans jamais bloquer le propriétaire) ;
//  - durée de la session administrateur : expiration après inactivité et durée maximale, fin immédiate de toutes les
//    sessions quand le mot de passe change.
//
// Réglages par variables d'environnement (valeurs par défaut entre parenthèses) :
//   ADMIN_IDLE_MINUTES (720 = 12 h d'inactivité), ADMIN_MAX_HOURS (168 = 7 jours depuis la connexion),
//   ADMIN_LOGIN_MAX_FAILS (5 échecs par fenêtre de 15 min), ADMIN_LOGIN_BLOCK_MINUTES (15, doublé à chaque récidive, 24 h au plus).

const crypto = require('crypto');
const db = require('../db');

const MIN = 60 * 1000;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const conf = () => ({
  idleMs: num(process.env.ADMIN_IDLE_MINUTES, 12 * 60) * MIN,
  maxAgeMs: num(process.env.ADMIN_MAX_HOURS, 7 * 24) * 60 * MIN,
  maxFails: Math.floor(num(process.env.ADMIN_LOGIN_MAX_FAILS, 5)),
  windowMs: 15 * MIN,
  blockMs: num(process.env.ADMIN_LOGIN_BLOCK_MINUTES, 15) * MIN,
});

// ---------- en-têtes ----------
// Politique de contenu des PAGES : aucun script ne peut venir d'ailleurs que de ce site (ni script en ligne, ni autre domaine),
// de sorte qu'un texte piégé qui passerait entre les mailles de l'échappement ne s'exécuterait pas. Les styles en ligne restent
// permis (l'interface en utilise beaucoup) ; polices de Google Fonts ; aperçus PDF dans des cadres du même site.
const CSP_PAGE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  const api = req.path.startsWith('/api/');
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    // Les réponses de l'API (JSON, PDF) ne portent que l'interdiction d'être affichées dans un autre site : une politique
    // complète sur un PDF empêcherait certains navigateurs de l'afficher.
    'Content-Security-Policy': api ? "frame-ancestors 'self'" : CSP_PAGE,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  });
  if (api) res.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
}

// ---------- contrôle d'origine ----------
// Un navigateur envoie toujours « Origin » avec une requête qui modifie des données. Si elle vient d'un AUTRE site que
// celui qui sert l'application, on la refuse. Sans en-tête (outil en ligne de commande, tests) : pas un navigateur, on laisse passer.
function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let host = null;
  try { host = new URL(origin).host; } catch { /* origine illisible : refusée plus bas */ }
  if (host && host === req.get('host')) return next();
  console.warn(`[sécurité] requête ${req.method} ${req.originalUrl} refusée : origine ${origin} ≠ ${req.get('host')}`);
  return res.status(403).json({ error: 'Requête refusée : elle ne vient pas de ce site.', code: 'BAD_ORIGIN' });
}

// ---------- essais de connexion ----------
const byIp = new Map();      // ip → { fails: [horodatages], blockedUntil, strikes, lastStrike }
const globalFails = [];      // horodatages de tous les échecs récents
const DAY = 24 * 60 * MIN;

function entry(ip) { let e = byIp.get(ip); if (!e) { e = { fails: [], blockedUntil: 0, strikes: 0, lastStrike: 0 }; byIp.set(ip, e); } return e; }

/**
 * Clé de comptage des essais. Derrière un relais d'hébergement, plusieurs visiteurs peuvent partager la même « adresse » :
 * pour qu'un inconnu qui rate 5 fois ne puisse pas enfermer le propriétaire dehors, un navigateur qui a déjà ouvert
 * l'administration avec succès (marque `deviceOk` dans sa session) a son PROPRE compteur, indépendant de l'adresse.
 */
function loginKey(req) {
  if (req.session && req.session.deviceOk && req.sessionID) return `dev:${req.sessionID}`;
  return `ip:${req.ip}`;
}

/** Cette clé est-elle bloquée ? → { blocked, retryAfterSec } */
function loginCheck(ip, now = Date.now()) {
  const e = byIp.get(ip);
  if (e && e.blockedUntil > now) return { blocked: true, retryAfterSec: Math.ceil((e.blockedUntil - now) / 1000) };
  return { blocked: false, retryAfterSec: 0 };
}

/** Enregistre un échec ; renvoie { blocked, retryAfterSec, attemptsLeft }. */
function loginFail(ip, now = Date.now()) {
  const c = conf(); const e = entry(ip);
  e.fails = e.fails.filter(t => now - t < c.windowMs); e.fails.push(now);
  globalFails.push(now); while (globalFails.length && now - globalFails[0] > 60 * MIN) globalFails.shift();
  if (e.fails.length >= c.maxFails) {
    if (now - e.lastStrike > DAY) e.strikes = 0;
    e.strikes += 1; e.lastStrike = now; e.fails = [];
    e.blockedUntil = now + Math.min(DAY, c.blockMs * 2 ** (e.strikes - 1));
    console.warn(`[sécurité] connexion administrateur : ${ip} bloquée ${Math.round((e.blockedUntil - now) / MIN)} min (série n° ${e.strikes}).`);
    return { blocked: true, retryAfterSec: Math.ceil((e.blockedUntil - now) / 1000), attemptsLeft: 0 };
  }
  return { blocked: false, retryAfterSec: 0, attemptsLeft: c.maxFails - e.fails.length };
}

function loginSuccess(ip) { const e = byIp.get(ip); if (e) { e.fails = []; } }

/** Attaque répartie sur beaucoup d'adresses : chaque échec est ralenti (jamais de blocage global, qui permettrait de t'enfermer dehors). */
function extraDelayMs(now = Date.now()) {
  while (globalFails.length && now - globalFails[0] > 60 * MIN) globalFails.shift();
  return globalFails.length > 30 ? 1500 : 0;
}

// Nettoyage des adresses sans activité récente (la table ne grossit pas indéfiniment).
setInterval(() => { const now = Date.now(); for (const [ip, e] of byIp) if (e.blockedUntil < now && now - (e.fails[e.fails.length - 1] || 0) > DAY && now - e.lastStrike > DAY) byIp.delete(ip); }, 60 * MIN).unref();


// ---------- limiteur de débit (routes publiques) ----------
// Compte les appels par clé (adresse ou compte) sur une fenêtre glissante ; au-delà de `max` : 429 + Retry-After.
// Les plafonds sont volontairement larges : derrière un relais d'hébergement, des visiteurs différents peuvent partager une adresse.
function rateLimit({ name, windowMs, max, key = (req) => req.ip, message = 'Trop de demandes. Réessayez dans quelques minutes.', countOnly = null }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k); }, windowMs).unref();
  return function limiter(req, res, next) {
    if (countOnly && !countOnly(req)) return next();
    const k = String(key(req)); const now = Date.now();
    const list = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (list.length >= max) {
      const wait = Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
      console.warn(`[sécurité] ${name} : trop de demandes depuis ${k} (${list.length}/${max}).`);
      return res.set('Retry-After', String(wait)).status(429).json({ error: message, code: 'RATE_LIMITED', retryAfterSec: wait });
    }
    list.push(now); hits.set(k, list);
    next();
  };
}

/** Nouvel identifiant de session en gardant certaines clés (contre le vol d'une session préparée à l'avance). */
function regenerate(req, keep, done) {
  const carried = {};
  for (const k of keep || []) if (req.session && req.session[k] !== undefined) carried[k] = req.session[k];
  req.session.regenerate((err) => {
    if (err) return done(err);
    Object.assign(req.session, carried);
    done(null);
  });
}

// ---------- session administrateur ----------
const pwFingerprint = (hash) => crypto.createHash('sha256').update(String(hash || '')).digest('hex').slice(0, 24);
const currentFingerprint = () => { const r = db.prepare('SELECT password_hash FROM admin WHERE id = 1').get(); return r ? pwFingerprint(r.password_hash) : null; };

/** Ouvre une session administrateur (après vérification du mot de passe) : horodatages et empreinte du mot de passe. */
function openAdminSession(session, now = Date.now()) {
  session.isAdmin = true; session.adminSince = now; session.adminAt = now; session.adminPw = currentFingerprint();
  session.deviceOk = true;   // navigateur reconnu : compteur d'essais à part (voir loginKey)
}

function closeAdminSession(session) {
  delete session.isAdmin; delete session.adminSince; delete session.adminAt; delete session.adminPw;
  delete session.billing;   // le déverrouillage de la Facturation ne survit pas à la déconnexion
  // `deviceOk` reste : c'est la reconnaissance du navigateur, pas un droit d'accès.
}

/**
 * Cette session administrateur est-elle encore valable ? Sinon elle est fermée.
 * Une session ouverte avant l'introduction de ces contrôles (sans horodatage) est refusée : une reconnexion suffit.
 */
function adminActive(session, now = Date.now(), { touch = false } = {}) {
  if (!session || !session.isAdmin) return false;
  const c = conf();
  const ok = Number.isFinite(session.adminSince) && Number.isFinite(session.adminAt)
    && now - session.adminAt <= c.idleMs && now - session.adminSince <= c.maxAgeMs
    && session.adminPw && session.adminPw === currentFingerprint();
  if (!ok) { closeAdminSession(session); return false; }
  if (touch && now - session.adminAt > MIN) session.adminAt = now;   // inactivité glissante, sans écrire à chaque requête
  return true;
}

module.exports = {
  securityHeaders, sameOriginOnly,
  loginKey, loginCheck, loginFail, loginSuccess, extraDelayMs,
  openAdminSession, closeAdminSession, adminActive, pwFingerprint, rateLimit, regenerate,
};
