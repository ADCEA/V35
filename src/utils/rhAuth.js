// Authentification des tablettes de l'atelier (badgeuse, écran Production) : jeton de tablette + code personnel ou badge du collaborateur.
// Les échecs sont comptés par collaborateur (code) ou par tablette (badge) : jamais par adresse, qui est partagée derrière le relais.
const db = require('../db');
const rh = require('./rh');
const loginGuard = require('./loginGuard');
const securityLog = require('./securityLog');

const SEEN_EVERY_MS = 60 * 1000;
const seenStmt = db.prepare('UPDATE badge_terminals SET last_seen_at = ? WHERE id = ?');
const fail = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) });

/** Middleware : la requête vient d'une tablette activée (en-tête x-terminal-token). */
function requireTerminal(req, res, next) {
  const raw = req.get('x-terminal-token');
  if (!raw || raw.length < 32 || raw.length > 128) return fail(res, 401, 'Tablette non activée.', { code: 'TERMINAL_UNKNOWN' });
  const t = db.prepare('SELECT * FROM badge_terminals WHERE token_hash = ?').get(rh.tokenHash(raw));
  if (!t) return fail(res, 401, 'Tablette non reconnue : demandez un nouveau lien d\'activation.', { code: 'TERMINAL_UNKNOWN' });
  if (t.revoked_at) return fail(res, 401, 'Cette tablette a été désactivée.', { code: 'TERMINAL_REVOKED' });
  const now = Date.now();
  if (!t.last_seen_at || now - Date.parse(t.last_seen_at) > SEEN_EVERY_MS) seenStmt.run(new Date(now).toISOString(), t.id);
  req.terminal = t;
  next();
}

/** Identifie le collaborateur (employeeId + pin, ou uid de badge). Renvoie la ligne employees, ou répond lui-même et renvoie null. */
function authenticate(req, res) {
  const body = req.body || {};
  if (body.uid !== undefined && body.uid !== null && body.uid !== '') {
    const h = rh.uidHash(body.uid);
    if (!h || rh.normUid(body.uid).length < 4) { fail(res, 400, 'Badge illisible : passez-le de nouveau.'); return null; }
    const key = `badge:uid:${req.terminal.id}`;
    const st = loginGuard.status(key);
    if (st.locked) { fail(res, 429, loginGuard.message(st.retryAfterSec), { code: 'LOCKED', retryAfterSec: st.retryAfterSec }); return null; }
    const e = db.prepare('SELECT * FROM employees WHERE badge_uid_hash = ? AND active = 1').get(h);
    if (!e) {
      const after = loginGuard.fail(key);
      if (after.locked) securityLog.record('badgeuse_blocked', req, `badges inconnus — tablette « ${req.terminal.label} »`);
      fail(res, 401, 'Badge inconnu. Utilisez votre code personnel.', { code: 'BAD_BADGE' });
      return null;
    }
    loginGuard.ok(key);
    return e;
  }
  const id = Number(body.employeeId);
  const pin = body.pin == null ? '' : String(body.pin);
  const e = Number.isInteger(id) ? db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(id) : null;
  if (!e) { fail(res, 401, 'Code incorrect.', { code: 'BAD_PIN' }); return null; }
  const key = `badge:emp:${e.id}`;
  const st = loginGuard.status(key);
  if (st.locked) { fail(res, 429, loginGuard.message(st.retryAfterSec), { code: 'LOCKED', retryAfterSec: st.retryAfterSec }); return null; }
  if (!e.pin_hash) { fail(res, 403, 'Aucun code personnel défini : voyez le responsable.', { code: 'NO_PIN' }); return null; }
  if (!/^\d{4,6}$/.test(pin) || !rh.checkPin(pin, e.pin_hash)) {
    const after = loginGuard.fail(key);
    if (after.locked) {
      securityLog.record('badgeuse_blocked', req, `code erroné — ${e.first_name} ${e.last_name}`.trim());
      fail(res, 429, loginGuard.message(after.retryAfterSec), { code: 'LOCKED', retryAfterSec: after.retryAfterSec });
    } else fail(res, 401, 'Code incorrect.', { code: 'BAD_PIN' });
    return null;
  }
  loginGuard.ok(key);
  return e;
}

module.exports = { requireTerminal, authenticate, fail };
