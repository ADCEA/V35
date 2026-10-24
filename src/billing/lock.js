// Verrou de l'espace Facturation.
//
// Pourquoi un verrou en plus de la session administrateur : la session admin
// ouvre tout le logiciel (commandes, logistique…) et reste valable des jours.
// La facturation, elle, émet des documents légaux irréversibles et expose
// l'IBAN et les montants. Elle exige donc un second code, distinct du mot de
// passe administrateur, avec :
//   - un déverrouillage qui expire après une période d'inactivité ;
//   - une RESSAISIE du code avant les actes sensibles (émettre, créer un avoir,
//     exporter le FEC, modifier les réglages de l'émetteur, envoi en lot) ;
//   - une protection contre les essais répétés, conservée en base.
//
// Les autorisations de ressaisie (« grants ») sont à usage unique, liées à un
// acte précis (ex. « issue:42 ») et valables 90 secondes : un code saisi pour
// émettre la facture 42 ne permet pas d'émettre la 43.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const engine = require('./engine');

const IDLE_MS = Math.max(1, Number(process.env.BILLING_IDLE_MINUTES) || 10) * 60 * 1000;
const GRANT_MS = 90 * 1000;
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const CODE_MIN = 6;
const CODE_MAX = 64;

const row = () => db.prepare('SELECT * FROM billing_lock WHERE id = 1').get();
const isConfigured = () => Boolean(row().code_hash);

function validateNewCode(code) {
  if (typeof code !== 'string' || code.length < CODE_MIN) throw new engine.BillingError(`Le code doit contenir au moins ${CODE_MIN} caractères.`);
  if (code.length > CODE_MAX) throw new engine.BillingError(`Le code ne peut pas dépasser ${CODE_MAX} caractères.`);
  if (/^(.)\1+$/.test(code)) throw new engine.BillingError('Choisissez un code moins évident (même caractère répété).');
}

function setCode(code) {
  validateNewCode(code);
  db.prepare("UPDATE billing_lock SET code_hash = ?, failed_attempts = 0, locked_until = 0, updated_at = datetime('now') WHERE id = 1")
    .run(bcrypt.hashSync(code, 10));
}

/**
 * Vérifie un code. Ne lève pas : renvoie { ok } ou { ok:false, locked, retryAfterSec, attemptsLeft }.
 * Après MAX_FAILS échecs consécutifs, tout essai est refusé pendant LOCKOUT_MS,
 * même avec le bon code.
 */
function verifyCode(code, now = Date.now()) {
  const r = row();
  if (!r.code_hash) return { ok: false, notConfigured: true };
  if (r.locked_until > now) return { ok: false, locked: true, retryAfterSec: Math.ceil((r.locked_until - now) / 1000) };
  if (typeof code === 'string' && code.length <= CODE_MAX && bcrypt.compareSync(code, r.code_hash)) {
    if (r.failed_attempts) db.prepare('UPDATE billing_lock SET failed_attempts = 0 WHERE id = 1').run();
    return { ok: true };
  }
  const attempts = r.failed_attempts + 1;
  if (attempts >= MAX_FAILS) {
    db.prepare('UPDATE billing_lock SET failed_attempts = 0, locked_until = ? WHERE id = 1').run(now + LOCKOUT_MS);
    engine.logEvent('billing_lock_lockout', null, { minutes: LOCKOUT_MS / 60000 });
    return { ok: false, locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };
  }
  db.prepare('UPDATE billing_lock SET failed_attempts = ? WHERE id = 1').run(attempts);
  engine.logEvent('billing_lock_failed', null, { attempt: attempts });
  return { ok: false, attemptsLeft: MAX_FAILS - attempts };
}

// Code oublié : poser la variable d'environnement BILLING_LOCK_RESET=<valeur
// quelconque> sur l'hébergeur, puis redémarrer. Le code est effacé UNE fois par
// valeur distincte (laisser la variable en place ne ré-efface pas à chaque
// démarrage) ; un nouveau code est alors demandé à l'ouverture de la Facturation.
// Exige donc l'accès au tableau de bord de l'hébergeur, pas seulement une session admin.
function applyEnvReset() {
  const marker = process.env.BILLING_LOCK_RESET;
  if (!marker) return false;
  const r = row();
  if (r.reset_marker === marker) return false;
  db.prepare("UPDATE billing_lock SET code_hash = NULL, failed_attempts = 0, locked_until = 0, reset_marker = ?, updated_at = datetime('now') WHERE id = 1").run(marker);
  engine.logEvent('billing_lock_reset', null, { via: 'env' });
  console.warn('[billing] Code de la Facturation réinitialisé (BILLING_LOCK_RESET). Un nouveau code sera demandé.');
  return true;
}
applyEnvReset();

// ---------- état de session ----------

const sess = (req) => req.session.billing || null;

function isUnlocked(req, now = Date.now()) {
  const b = sess(req);
  return Boolean(b && b.lastActivity && now - b.lastActivity <= IDLE_MS);
}
function unlockSession(req, now = Date.now()) {
  req.session.billing = { unlockedAt: now, lastActivity: now, grants: {} };
}
function lockSession(req) { delete req.session.billing; }

function grant(req, scope, now = Date.now()) {
  const b = sess(req);
  if (!b) return;
  for (const [k, until] of Object.entries(b.grants || {})) if (until <= now) delete b.grants[k];
  b.grants = b.grants || {};
  b.grants[scope] = now + GRANT_MS;
}
function consumeGrant(req, scope, now = Date.now()) {
  const b = sess(req);
  const until = b && b.grants && b.grants[scope];
  if (!until || until <= now) return false;
  delete b.grants[scope];
  return true;
}

// ---------- middlewares ----------

function requireUnlocked(req, res, next) {
  if (!isConfigured()) return res.status(423).json({ error: 'Définissez d\'abord le code de la Facturation.', code: 'LOCK_SETUP_REQUIRED' });
  const now = Date.now();
  if (!isUnlocked(req, now)) {
    lockSession(req);
    return res.status(423).json({ error: 'Facturation verrouillée.', code: 'LOCKED' });
  }
  sess(req).lastActivity = now;
  next();
}

// scopeOf : chaîne, ou fonction (req) → chaîne. À placer APRÈS requireUnlocked.
function requireStepUp(scopeOf) {
  return (req, res, next) => {
    const scope = typeof scopeOf === 'function' ? scopeOf(req) : scopeOf;
    if (consumeGrant(req, scope)) return next();
    return res.status(403).json({ error: 'Confirmez cette action avec le code de la Facturation.', code: 'STEP_UP_REQUIRED', scope });
  };
}

// ---------- routes /lock/* ----------

const router = express.Router();

function badCode(res, v) {
  if (v.locked) return res.status(429).json({ error: `Trop d'essais. Réessayez dans ${Math.ceil(v.retryAfterSec / 60)} min.`, code: 'LOCKED_OUT', retryAfterSec: v.retryAfterSec });
  return res.status(401).json({ error: `Code incorrect (${v.attemptsLeft} essai${v.attemptsLeft > 1 ? 's' : ''} restant${v.attemptsLeft > 1 ? 's' : ''}).`, code: 'BAD_CODE', attemptsLeft: v.attemptsLeft });
}

router.get('/status', (req, res) => {
  const now = Date.now();
  const r = row();
  const unlocked = Boolean(r.code_hash) && isUnlocked(req, now);
  res.json({
    configured: Boolean(r.code_hash),
    unlocked,
    idleMs: IDLE_MS,
    remainingMs: unlocked ? Math.max(0, IDLE_MS - (now - sess(req).lastActivity)) : 0,
    retryAfterSec: r.locked_until > now ? Math.ceil((r.locked_until - now) / 1000) : 0,
  });
});

router.post('/setup', (req, res) => {
  if (isConfigured()) return res.status(409).json({ error: 'Un code existe déjà. Utilisez « Changer le code ».' });
  const { code, confirm } = req.body || {};
  if (code !== confirm) return res.status(400).json({ error: 'Les deux saisies du code ne correspondent pas.' });
  try { setCode(code); } catch (e) { return res.status(400).json({ error: e.message }); }
  engine.logEvent('billing_lock_setup', null, {});
  unlockSession(req);
  res.status(201).json({ ok: true, idleMs: IDLE_MS });
});

router.post('/unlock', (req, res) => {
  const v = verifyCode((req.body || {}).code);
  if (v.notConfigured) return res.status(423).json({ error: 'Définissez d\'abord le code de la Facturation.', code: 'LOCK_SETUP_REQUIRED' });
  if (!v.ok) return badCode(res, v);
  unlockSession(req);
  engine.logEvent('billing_unlocked', null, {});
  res.json({ ok: true, idleMs: IDLE_MS });
});

router.post('/lock', (req, res) => { lockSession(req); res.json({ ok: true }); });

// Maintient le déverrouillage tant que la personne travaille réellement sur l'écran
// (l'interface l'appelle au plus une fois par minute, sur activité).
router.post('/touch', (req, res) => {
  const now = Date.now();
  if (!isUnlocked(req, now)) { lockSession(req); return res.status(423).json({ error: 'Facturation verrouillée.', code: 'LOCKED' }); }
  sess(req).lastActivity = now;
  res.json({ ok: true });
});

// Ressaisie du code pour un acte précis. Renvoie un feu vert à usage unique (90 s).
router.post('/confirm', (req, res) => {
  const now = Date.now();
  if (!isUnlocked(req, now)) { lockSession(req); return res.status(423).json({ error: 'Facturation verrouillée.', code: 'LOCKED' }); }
  const { code, scope } = req.body || {};
  if (typeof scope !== 'string' || !/^[a-z-]+(:[\w-]+)?$/.test(scope)) return res.status(400).json({ error: 'Action inconnue.' });
  const v = verifyCode(code, now);
  if (!v.ok) return badCode(res, v);
  grant(req, scope, now);
  sess(req).lastActivity = now;
  engine.logEvent('step_up_granted', null, { scope });
  res.json({ ok: true, validForSec: GRANT_MS / 1000 });
});

router.post('/change', (req, res) => {
  const now = Date.now();
  if (!isUnlocked(req, now)) { lockSession(req); return res.status(423).json({ error: 'Facturation verrouillée.', code: 'LOCKED' }); }
  const { code, newCode, confirm } = req.body || {};
  if (newCode !== confirm) return res.status(400).json({ error: 'Les deux saisies du nouveau code ne correspondent pas.' });
  const v = verifyCode(code, now);
  if (!v.ok) return badCode(res, v);
  try { setCode(newCode); } catch (e) { return res.status(400).json({ error: e.message }); }
  engine.logEvent('billing_lock_changed', null, {});
  res.json({ ok: true });
});

module.exports = {
  router, requireUnlocked, requireStepUp,
  isConfigured, setCode, verifyCode, validateNewCode, applyEnvReset,
  isUnlocked, unlockSession, lockSession, grant, consumeGrant,
  IDLE_MS, GRANT_MS, MAX_FAILS, LOCKOUT_MS,
};
