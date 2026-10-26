// Outlook : créer, dans la boîte Brouillons de l'utilisateur, un message prêt (destinataire, objet, texte) avec le PDF
// déjà joint, puis ouvrir ce brouillon. Passe par Microsoft Graph, avec l'autorisation de l'utilisateur donnée une fois.
//
// - Autorisation : OAuth 2.0 (code + PKCE) ; permissions « Mail.ReadWrite » (créer un brouillon — aucun droit d'ENVOI :
//   rien ne part sans que la personne clique sur Envoyer dans Outlook), « User.Read » (afficher le compte connecté)
//   et « offline_access » (ne pas se reconnecter à chaque fois).
// - Le jeton de renouvellement est chiffré (AES-256-GCM, clé dérivée de SESSION_SECRET) dans la base ; jamais renvoyé à l'écran.
// - Configuration (variables d'environnement) : MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT (défaut « common ») et l'adresse
//   publique du site (PUBLIC_URL, ou RENDER_EXTERNAL_URL fournie par Render). MS_AUTH_BASE / MS_GRAPH_BASE ne servent qu'aux tests.

const crypto = require('crypto');
const db = require('../db');
const engine = require('./engine');

const SCOPE = 'offline_access Mail.ReadWrite User.Read';
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;   // au-delà, Graph exige une session de téléversement : inutile pour une facture
const TIMEOUT_MS = 20000;

class OutlookError extends engine.BillingError {
  constructor(message, status = 502, code = 'OUTLOOK_ERROR') { super(message, status); this.name = 'OutlookError'; this.code = code; }
}
const reconnect = () => new OutlookError("La connexion à Outlook a expiré ou a été retirée : reconnectez-la dans Configuration → Outlook.", 409, 'OUTLOOK_RECONNECT');

function config(env = process.env) {
  const trim = (v) => String(v || '').trim().replace(/\/+$/, '');
  return {
    clientId: String(env.MS_CLIENT_ID || '').trim(), clientSecret: String(env.MS_CLIENT_SECRET || '').trim(),
    tenant: String(env.MS_TENANT || 'common').trim() || 'common',
    authBase: trim(env.MS_AUTH_BASE) || 'https://login.microsoftonline.com',
    graphBase: trim(env.MS_GRAPH_BASE) || 'https://graph.microsoft.com/v1.0',
    publicUrl: trim(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL),
  };
}
const isConfigured = (c = config()) => Boolean(c.clientId && c.clientSecret && c.publicUrl);
const redirectUri = (c = config()) => (c.publicUrl ? `${c.publicUrl}/api/admin/billing/outlook/callback` : null);

// ---------- jeton de renouvellement chiffré ----------

let keyCache = { secret: null, key: null };
function key() {
  const secret = process.env.SESSION_SECRET || 'dev-secret-non-persistant';
  if (keyCache.secret !== secret) keyCache = { secret, key: crypto.scryptSync(secret, 'cezanne-outlook-v1', 32) };
  return keyCache.key;
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
function unseal(sealed) {
  const [v, iv, tag, ct] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('format inconnu');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

const row = () => db.prepare('SELECT account_email, account_name, refresh_token_enc, connected_at FROM outlook_connection WHERE id = 1').get();
let tokenCache = null;   // { token, exp } — en mémoire seulement

function readableRefreshToken() {
  const r = row(); if (!r) return null;
  try { return unseal(r.refresh_token_enc); } catch { return null; }   // clé changée (SESSION_SECRET) : à reconnecter
}

/** État pour l'écran : jamais le moindre jeton. */
function status() {
  const c = config(); const r = row();
  const readable = r ? readableRefreshToken() !== null : false;
  return {
    configured: isConfigured(c),
    connected: isConfigured(c) && Boolean(r) && readable,
    needsReconnect: Boolean(r) && !readable,
    account: r ? { email: r.account_email, name: r.account_name, connectedAt: r.connected_at } : null,
    redirectUri: redirectUri(c), tenant: c.tenant,
    missing: [!c.clientId && 'MS_CLIENT_ID', !c.clientSecret && 'MS_CLIENT_SECRET', !c.publicUrl && 'PUBLIC_URL'].filter(Boolean),
  };
}

// ---------- appels Microsoft ----------

async function http(url, init) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw new OutlookError(`Microsoft est injoignable pour le moment (${e.name === 'TimeoutError' ? 'délai dépassé' : e.message}). Réessayez dans un instant.`, 502, 'OUTLOOK_UNREACHABLE'); }
}

async function tokenRequest(params) {
  const c = config();
  const body = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, scope: SCOPE, ...params });
  const res = await http(`${c.authBase}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  let j = {}; try { j = await res.json(); } catch { /* corps vide */ }
  if (!res.ok || !j.access_token) {
    if (j.error === 'invalid_grant' || j.error === 'interaction_required') throw reconnect();
    throw new OutlookError(`Microsoft a refusé la demande : ${j.error_description ? String(j.error_description).split('\r\n')[0] : (j.error || res.status)}`, 502, 'OUTLOOK_TOKEN');
  }
  return j;
}

async function accessToken(force = false) {
  if (!force && tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const refresh = readableRefreshToken();
  if (!refresh) throw reconnect();
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  if (j.refresh_token && j.refresh_token !== refresh) {   // Microsoft renouvelle parfois le jeton : on garde le dernier
    db.prepare('UPDATE outlook_connection SET refresh_token_enc = ? WHERE id = 1').run(seal(j.refresh_token));
  }
  return tokenCache.token;
}

const graph = (method, path, token, payload) => http(`${config().graphBase}${path}`, {
  method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
  body: payload ? JSON.stringify(payload) : undefined,
});

// ---------- connexion (OAuth) ----------

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Adresse Microsoft où envoyer la personne pour autoriser l'accès ; la session retient l'état et la preuve PKCE. */
function authorizeUrl(session) {
  const c = config();
  if (!isConfigured(c)) {
    throw new OutlookError(`Outlook n'est pas encore configuré sur le serveur : il manque ${status().missing.join(', ')}.`, 503, 'OUTLOOK_NOT_CONFIGURED');
  }
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  session.outlookAuth = { state, verifier, at: Date.now() };
  const q = new URLSearchParams({
    client_id: c.clientId, response_type: 'code', redirect_uri: redirectUri(c), response_mode: 'query', scope: SCOPE,
    state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account',
  });
  return `${c.authBase}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/authorize?${q}`;
}

const sameText = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Retour de Microsoft : vérifie l'état, échange le code, retient le compte connecté. */
async function complete(session, { code, state, error, error_description: description } = {}) {
  const pending = session.outlookAuth; delete session.outlookAuth;
  if (!pending || !state || !sameText(state, pending.state) || Date.now() - pending.at > STATE_TTL_MS) {
    throw new OutlookError('Demande de connexion inconnue ou expirée : recommencez depuis Configuration → Outlook.', 400, 'OUTLOOK_STATE');
  }
  if (error) throw new OutlookError(`Microsoft n'a pas autorisé la connexion : ${description ? String(description).split('\r\n')[0] : error}`, 400, 'OUTLOOK_DENIED');
  if (!code) throw new OutlookError("Microsoft n'a renvoyé aucun code d'autorisation.", 400, 'OUTLOOK_DENIED');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pending.verifier });
  if (!tok.refresh_token) throw new OutlookError("Microsoft n'a pas accordé l'autorisation durable (offline_access) : vérifiez les permissions de l'application.", 502, 'OUTLOOK_TOKEN');
  const res = await graph('GET', '/me?$select=displayName,mail,userPrincipalName', tok.access_token);
  let me = {}; try { me = await res.json(); } catch { /* compte illisible : on connecte quand même */ }
  const email = me.mail || me.userPrincipalName || null;
  db.prepare(`INSERT INTO outlook_connection (id, account_email, account_name, refresh_token_enc, connected_at) VALUES (1, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET account_email = excluded.account_email, account_name = excluded.account_name, refresh_token_enc = excluded.refresh_token_enc, connected_at = excluded.connected_at`)
    .run(email, me.displayName || null, seal(tok.refresh_token));
  tokenCache = { token: tok.access_token, exp: Date.now() + (Number(tok.expires_in) || 3600) * 1000 };
  return { email, name: me.displayName || null };
}

function disconnect() {
  db.prepare('DELETE FROM outlook_connection WHERE id = 1').run();
  tokenCache = null;
}

// ---------- brouillon ----------

/** Crée le brouillon dans la boîte de l'utilisateur, PDF joint. Renvoie { id, webLink } (webLink : l'ouvre dans Outlook web). */
async function createDraft({ to = [], subject, body, filename, buffer }) {
  if (!status().connected) throw new OutlookError("Outlook n'est pas connecté.", 409, 'OUTLOOK_NOT_CONNECTED');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new OutlookError('Le PDF dépasse 3 Mo : trop lourd pour être joint automatiquement.', 413, 'OUTLOOK_TOO_BIG');
  const payload = {
    subject: String(subject).slice(0, 255),
    body: { contentType: 'Text', content: String(body) },
    toRecipients: to.map(address => ({ emailAddress: { address } })),
    attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: filename, contentType: 'application/pdf', contentBytes: Buffer.from(buffer).toString('base64') }],
  };
  let res = await graph('POST', '/me/messages', await accessToken(), payload);
  if (res.status === 401) res = await graph('POST', '/me/messages', await accessToken(true), payload);   // jeton refusé : un seul renouvellement
  if (res.status === 401) throw reconnect();
  if (!res.ok) {
    let msg = ''; try { msg = (await res.json()).error?.message || ''; } catch { /* corps vide */ }
    if (res.status === 403) throw new OutlookError("Microsoft refuse de créer le brouillon : l'autorisation « Mail.ReadWrite » manque. Reconnectez Outlook dans Configuration → Outlook.", 409, 'OUTLOOK_RECONNECT');
    if (res.status === 429 || res.status >= 500) throw new OutlookError('Microsoft est momentanément indisponible. Réessayez dans un instant.', 502, 'OUTLOOK_UNREACHABLE');
    throw new OutlookError(`Microsoft a refusé le brouillon : ${msg || res.status}`, 502, 'OUTLOOK_ERROR');
  }
  const j = await res.json();
  return { id: j.id, webLink: j.webLink || null };
}

module.exports = { status, authorizeUrl, complete, disconnect, createDraft, isConfigured, config, redirectUri, OutlookError, SCOPE };
