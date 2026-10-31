// Accès Claude — jetons en LECTURE SEULE pour que Claude consulte les données sans jamais pouvoir les modifier.
//
// Garanties (voir aussi routes/claudeApi.js) :
//  - le jeton n'est montré qu'une fois ; seule son empreinte sha256 est conservée (comme le jeton de copie du soir) ;
//  - il ne marche que sur /api/claude/v1, en GET : aucune écriture, aucune administration, aucun PDF, aucun code d'accès ;
//  - il donne accès à des périmètres choisis (exploitation, hôtels, finance) et expire (30 jours au plus) ;
//  - chaque lecture est inscrite au journal ; « tout révoquer » coupe tous les accès d'un clic ;
//  - la variable CLAUDE_ACCESS=off sur l'hébergeur coupe la fonction entière, sans rien supprimer.
const crypto = require('crypto');
const db = require('../db');

const SCOPES = {
  exploitation: 'Commandes, tournées et statistiques d\'activité (sans aucun montant)',
  hotels: 'Fiches hôtels : coordonnées, adresse, SIRET (sans codes d\'accès ni clés techniques)',
  finance: 'Factures, avoirs, encaissements et ventes jour par jour (montants)',
};
const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;
const MAX_ACTIVE = 10;
const TOKEN_RE = /^czc_[A-Za-z0-9_-]{43}$/;
const RATE_PER_MIN = 60;

const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');
const enabled = () => String(process.env.CLAUDE_ACCESS || '').trim().toLowerCase() !== 'off';

class ClaudeAccessError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ClaudeAccessError'; this.status = status; }
}

const insertToken = db.prepare('INSERT INTO claude_tokens (label, token_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
const byHash = db.prepare('SELECT id, label, scopes, expires_at, revoked_at FROM claude_tokens WHERE token_hash = ?');
const touch = db.prepare('UPDATE claude_tokens SET last_used_at = ?, last_ip = ?, use_count = use_count + 1 WHERE id = ?');
const insertLog = db.prepare('INSERT INTO claude_access_log (token_id, method, path, status, ip) VALUES (?, ?, ?, ?, ?)');
const trimLog = db.prepare('DELETE FROM claude_access_log WHERE id <= (SELECT MAX(id) FROM claude_access_log) - 2000');
let logged = 0;

function cleanScopes(list) {
  const raw = Array.isArray(list) ? list : [];
  const out = [...new Set(raw.map(String))];
  if (!out.length) throw new ClaudeAccessError('Choisissez au moins un périmètre à ouvrir à Claude.');
  const bad = out.find(s => !Object.prototype.hasOwnProperty.call(SCOPES, s));
  if (bad) throw new ClaudeAccessError('Périmètre inconnu.');
  return Object.keys(SCOPES).filter(s => out.includes(s));
}

/** Crée un accès ; renvoie le jeton en clair UNE SEULE FOIS. */
function createToken({ label, scopes, days }, now = new Date()) {
  const name = String(label || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new ClaudeAccessError('Donnez un nom à cet accès (par exemple « Analyse de mai »).');
  if (name.length > 60) throw new ClaudeAccessError('Nom trop long (60 caractères au maximum).');
  const sc = cleanScopes(scopes);
  const d = days === undefined || days === null || days === '' ? DEFAULT_DAYS : Number(days);
  if (!Number.isInteger(d) || d < 1 || d > MAX_DAYS) throw new ClaudeAccessError(`La durée doit être de 1 à ${MAX_DAYS} jours.`);
  const active = db.prepare('SELECT COUNT(*) n FROM claude_tokens WHERE revoked_at IS NULL AND expires_at > ?').get(now.toISOString()).n;
  if (active >= MAX_ACTIVE) throw new ClaudeAccessError(`${MAX_ACTIVE} accès actifs au maximum : révoquez-en un avant d'en créer un autre.`, 409);
  const token = 'czc_' + crypto.randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + d * 86400000);
  const info = insertToken.run(name, sha256hex(token), sc.join(','), now.toISOString(), expires.toISOString());
  return { token, id: Number(info.lastInsertRowid), label: name, scopes: sc, expiresAt: expires.toISOString() };
}

const present = (r, now = new Date()) => ({
  id: r.id, label: r.label, scopes: r.scopes.split(','), createdAt: r.created_at, expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at, lastIp: r.last_ip, useCount: r.use_count, revokedAt: r.revoked_at,
  status: r.revoked_at ? 'revoked' : (Date.parse(r.expires_at) <= now.getTime() ? 'expired' : 'active'),
});

function listTokens(now = new Date()) {
  return db.prepare('SELECT * FROM claude_tokens ORDER BY id DESC LIMIT 50').all().map(r => present(r, now));
}

function revoke(id, now = new Date()) {
  return db.prepare('UPDATE claude_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now.toISOString(), Number(id)).changes > 0;
}
function revokeAll(now = new Date()) {
  return db.prepare('UPDATE claude_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(now.toISOString()).changes;
}

/** @returns {{ok:true, token:{id,label,scopes,expiresAt}} | {ok:false, reason:'format'|'unknown'|'revoked'|'expired'}} */
function check(raw, now = new Date()) {
  if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) return { ok: false, reason: 'format' };
  const r = byHash.get(sha256hex(raw));
  if (!r) return { ok: false, reason: 'unknown' };
  if (r.revoked_at) return { ok: false, reason: 'revoked' };
  if (Date.parse(r.expires_at) <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, token: { id: r.id, label: r.label, scopes: r.scopes.split(','), expiresAt: r.expires_at } };
}

// Cadence : 60 lectures par minute et par jeton (un dossier complet se lit largement dans ce cadre).
const buckets = new Map();
function rateOk(tokenId, now = Date.now()) {
  const b = buckets.get(tokenId);
  if (!b || now - b.start >= 60000) { buckets.set(tokenId, { start: now, n: 1 }); return { ok: true }; }
  if (b.n >= RATE_PER_MIN) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.start + 60000 - now) / 1000)) };
  b.n += 1;
  return { ok: true };
}

function recordUse(tokenId, { method, path, status, ip }, now = new Date()) {
  try {
    touch.run(now.toISOString(), ip ? String(ip).slice(0, 64) : null, tokenId);
    insertLog.run(tokenId, String(method || '').slice(0, 8), String(path || '').slice(0, 200), status, ip ? String(ip).slice(0, 64) : null);
    if (++logged % 100 === 0) trimLog.run();
  } catch (e) { console.error('[accès Claude] journal non écrit :', e.message); }
}

function recentLog(limit = 50) {
  return db.prepare(`SELECT l.id, l.at, l.token_id AS tokenId, t.label, l.method, l.path, l.status, l.ip
    FROM claude_access_log l LEFT JOIN claude_tokens t ON t.id = l.token_id ORDER BY l.id DESC LIMIT ?`).all(Math.min(200, limit));
}

module.exports = {
  SCOPES, MAX_DAYS, DEFAULT_DAYS, MAX_ACTIVE, RATE_PER_MIN, TOKEN_RE, ClaudeAccessError,
  enabled, createToken, listTokens, revoke, revokeAll, check, rateOk, recordUse, recentLog,
};
