// Trafic en temps réel (TomTom) : tuiles de circulation, vitesse en un point, durée d'un itinéraire avec le trafic du moment.
//
// Tout passe par le SERVEUR : la clé d'API vit dans la variable d'environnement TOMTOM_API_KEY et n'est jamais envoyée au
// navigateur, ni écrite dans la base, un journal ou un message d'erreur. Les pages ne parlent qu'à /api/admin/traffic/*.
//
// Garde-fous (cette clé se paie à l'usage, et TomTom la place dans l'adresse de chaque requête) :
//   - adresse de TomTom FIXE (https://api.tomtom.com) ; seule une variable d'environnement du serveur peut la remplacer, jamais
//     une donnée venue d'une page ; les redirections ne sont pas suivies ; délai, taille de réponse et nature de la réponse
//     (image PNG, JSON attendu) contrôlés ;
//   - paramètres reconstruits un à un après validation (nombres, liste de styles autorisés, zone France) : rien de saisi
//     n'est recopié dans l'adresse envoyée à TomTom ;
//   - plafond quotidien d'appels RÉELLEMENT envoyés, gardé en base (survit aux redémarrages) : au-delà, plus aucun appel ;
//   - réponses gardées quelques minutes en mémoire, demandes identiques simultanées regroupées en une seule ;
//   - coupe-circuit : clé refusée (401/403) → pause de 30 min et ligne dans le journal de sécurité ; trop de demandes (429)
//     ou service en panne → pause de quelques minutes, au lieu d'insister ;
//   - tout texte d'erreur est nettoyé de la clé avant d'être écrit où que ce soit.
//
// Réglages (variables d'environnement) : TOMTOM_API_KEY (obligatoire, 16 à 128 caractères : lettres, chiffres, _ et -),
// TOMTOM_REQUESTS_PER_DAY (1500, itinéraires et vitesses), TOMTOM_TILES_PER_DAY (15000, tuiles),
// TOMTOM_TRAVEL_MODE (car | van | truck, défaut car), TRAFFIC=off (coupe tout), TOMTOM_BASE_URL (tests : serveur factice),
// TOMTOM_DRIVER_TILES_PER_DAY (4000) et TOMTOM_DRIVER_REQUESTS_PER_DAY (600) : plafond de chaque lien de livreur.
const crypto = require('crypto');
const db = require('../db');
const securityLog = require('./securityLog');

const HOST = 'https://api.tomtom.com';
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const TIMEOUT_MS = 6000;
const MAX_BODY = 1.5 * 1024 * 1024;
const USER_AGENT = 'BlanchisserieCezanne/1.0 (application de gestion de blanchisserie)';
const STYLES = ['relative0', 'relative', 'absolute', 'relative-delay', 'reduced-sensitivity'];
const MODES = ['car', 'van', 'truck'];
const TILE_ZOOM = { min: 6, max: 18 };
const MAX_POINTS = 25;
const FRANCE = { latMin: 41.0, latMax: 51.5, lngMin: -5.6, lngMax: 9.8 };   // France métropolitaine et Corse : rien d'autre n'est demandé
const MIN = 60 * 1000;

class TrafficError extends Error {
  /** @param {string} code  disabled | key_invalid | bad_config | key_rejected | budget | paused | upstream | bad_input | no_start | driver_quota */
  constructor(code, message, http) { super(message); this.code = code; this.http = http || 502; }
}
const MESSAGES = {
  disabled: 'Le trafic en temps réel n\'est pas activé (clé TomTom absente).',
  key_invalid: 'La clé TomTom enregistrée sur le serveur n\'a pas le bon format.',
  bad_config: 'Le réglage TOMTOM_BASE_URL du serveur est refusé (https obligatoire).',
  key_rejected: 'TomTom a refusé la clé. Vérifiez-la dans l\'espace TomTom.',
  budget: 'Plafond quotidien d\'appels TomTom atteint : réessayez demain ou relevez le plafond.',
  paused: 'TomTom ne répond pas correctement pour le moment : nouvel essai dans quelques minutes.',
  upstream: 'Réponse inattendue de TomTom.',
};
const fail = (code, http, msg) => new TrafficError(code, msg || MESSAGES[code] || 'Erreur', http);

// ---------- réglages ----------
const posInt = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };
const limits = () => ({ api: posInt(process.env.TOMTOM_REQUESTS_PER_DAY, 1500), tiles: posInt(process.env.TOMTOM_TILES_PER_DAY, 15000) });
const travelMode = () => { const m = String(process.env.TOMTOM_TRAVEL_MODE || 'car').toLowerCase(); return MODES.includes(m) ? m : 'car'; };

/** Adresse de base : TomTom, sauf variable d'environnement du serveur (https, ou http sur la machine même en test). null = refusée. */
function baseUrl() {
  const o = String(process.env.TOMTOM_BASE_URL || '').trim();
  if (!o) return HOST;
  let u; try { u = new URL(o); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol === 'https:' && !u.username && !u.password) return u.origin;
  if (u.protocol === 'http:' && local && process.env.NODE_ENV === 'test') return u.origin;
  return null;
}

/** → { state: 'on' } | { state: 'off', reason } */
function availability() {
  if (String(process.env.TRAFFIC || '').toLowerCase() === 'off') return { state: 'off', reason: 'disabled' };
  const raw = String(process.env.TOMTOM_API_KEY || '').trim();
  if (!raw) return { state: 'off', reason: 'disabled' };
  if (!KEY_RE.test(raw)) return { state: 'off', reason: 'key_invalid' };
  if (!baseUrl()) return { state: 'off', reason: 'bad_config' };
  return { state: 'on' };
}
const apiKey = () => String(process.env.TOMTOM_API_KEY || '').trim();

/** Retire la clé (et tout « key=… ») d'un texte avant de l'écrire dans un journal ou un message. */
function scrub(text) {
  let s = String(text == null ? '' : text);
  const k = apiKey();
  if (k) s = s.split(k).join('«clé»');
  return s.replace(/([?&;]key=)[^&\s"')]+/gi, '$1«clé»').replace(/(tomtom[-_ ]?api[-_ ]?key["':= ]+)[A-Za-z0-9_-]{8,}/gi, '$1«clé»');
}
const warn = (msg) => console.warn(`[trafic] ${scrub(msg)}`);

// ---------- plafond quotidien (en base) ----------
const utcDay = () => new Date().toISOString().slice(0, 10);
const readUsage = db.prepare('SELECT n FROM traffic_usage WHERE day = ? AND kind = ?');
const bump = db.prepare('INSERT INTO traffic_usage (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1');
const purge = db.prepare("DELETE FROM traffic_usage WHERE day < date('now', '-60 day')");
const reserveTx = db.transaction((kind, limit) => {
  const day = utcDay();
  const used = (readUsage.get(day, kind) || { n: 0 }).n;
  if (used >= limit) return false;
  bump.run(day, kind);
  return true;
});
const usedToday = (kind) => (readUsage.get(utcDay(), kind) || { n: 0 }).n;
const budgetLogged = new Set();   // « jour/nature » déjà inscrits au journal de sécurité
let purgeDay = '';

function reserve(kind) {
  const day = utcDay();
  if (purgeDay !== day) { purgeDay = day; try { purge.run(); } catch { /* sans gravité */ } }
  const ok = reserveTx(kind, limits()[kind]);
  if (!ok && !budgetLogged.has(`${day}/${kind}`)) {
    budgetLogged.add(`${day}/${kind}`);
    securityLog.record('traffic_budget_reached', null, `plafond quotidien ${kind} atteint (${limits()[kind]})`);
  }
  return ok;
}

/**
 * Plafond quotidien PAR LIEN DE LIVREUR (un lien est un secret transmis par message : s'il fuit, il ne doit pas pouvoir vider le
 * budget du site). Compte les demandes servies, mémoire comprise. kind : « drv<id>:tiles » ou « drv<id>:api ». Faux = plafond atteint.
 */
function spend(kind, limit) {
  const day = utcDay();
  if (purgeDay !== day) { purgeDay = day; try { purge.run(); } catch { /* sans gravité */ } }
  return reserveTx(kind, limit);
}
const driverLimits = () => ({ tiles: posInt(process.env.TOMTOM_DRIVER_TILES_PER_DAY, 4000), api: posInt(process.env.TOMTOM_DRIVER_REQUESTS_PER_DAY, 600) });

// ---------- coupe-circuit ----------
const breaker = { failures: 0, openUntil: 0, reason: null };
const isPaused = (now = Date.now()) => now < breaker.openUntil;
function onSuccess() { breaker.failures = 0; }
function onFailure(httpStatus) {
  const now = Date.now();
  if (httpStatus === 401 || httpStatus === 403) {
    if (!isPaused(now) || breaker.reason !== 'key_rejected') securityLog.record('traffic_key_rejected', null, `TomTom a répondu ${httpStatus} : clé refusée, appels suspendus 30 min`);
    breaker.openUntil = now + 30 * MIN; breaker.reason = 'key_rejected';
  } else if (httpStatus === 429) {
    breaker.openUntil = now + 2 * MIN; breaker.reason = 'paused';
  } else if (++breaker.failures >= 5) {
    breaker.openUntil = now + 2 * MIN; breaker.reason = 'paused'; breaker.failures = 0;
  }
}

// ---------- mémoire (réponses récentes) ----------
class Memo {
  constructor(maxEntries, maxBytes) { this.m = new Map(); this.bytes = 0; this.maxEntries = maxEntries; this.maxBytes = maxBytes; }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.drop(k); return undefined; }
    return e.v;
  }
  drop(k) { const e = this.m.get(k); if (e) { this.bytes -= e.size; this.m.delete(k); } }
  set(k, v, ttlMs, size = 1) {
    this.drop(k);
    this.m.set(k, { v, exp: Date.now() + ttlMs, size }); this.bytes += size;
    while (this.m.size > this.maxEntries || this.bytes > this.maxBytes) this.drop(this.m.keys().next().value);
  }
}
const tileMemo = new Memo(600, 24 * 1024 * 1024);
const dataMemo = new Memo(400, 4 * 1024 * 1024);
const inflight = new Map();
const once = (k, fn) => {
  if (inflight.has(k)) return inflight.get(k);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
};

// ---------- appel à TomTom ----------
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) throw fail('upstream', 502);
  const chunks = []; let total = 0;
  for await (const c of res.body) {
    total += c.length;
    if (total > MAX_BODY) throw fail('upstream', 502);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

/** Envoie UNE requête à TomTom (après plafond et coupe-circuit) ; renvoie le corps brut. `params` : paire nom/valeur déjà validées. */
async function call(kind, pathname, params, accept) {
  const av = availability();
  if (av.state !== 'on') throw fail(av.reason, 503);
  if (isPaused()) throw fail(breaker.reason || 'paused', 503);
  if (!reserve(kind)) throw fail('budget', 429);
  const url = new URL(baseUrl() + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('key', apiKey());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: accept, 'User-Agent': USER_AGENT, 'Tracking-ID': crypto.randomUUID() } });
    if (res.status !== 200) {
      warn(`TomTom a répondu ${res.status} (${kind} ${pathname.split('/').slice(1, 4).join('/')})`);
      // Demande refusée pour son contenu (pas d'itinéraire, point sans route…) : ce n'est pas une panne, le coupe-circuit n'y touche pas.
      if (res.status === 400 || res.status === 404) throw fail('upstream', 502, 'TomTom n\'a pas pu traiter cette demande.');
      onFailure(res.status);
      if (res.status === 401 || res.status === 403) throw fail('key_rejected', 503);
      if (res.status === 429) throw fail('paused', 503);
      throw fail('upstream', 502);
    }
    const body = await readCapped(res);
    onSuccess();
    return body;
  } catch (e) {
    if (e instanceof TrafficError) throw e;
    onFailure(0);
    warn(`appel TomTom impossible : ${e && e.name === 'AbortError' ? 'délai dépassé' : (e && e.message)}`);
    throw fail('upstream', 502, 'TomTom est injoignable.');
  } finally { clearTimeout(timer); }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b) => b.length > 8 && b.subarray(0, 8).equals(PNG);
function parseJson(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch { throw fail('upstream', 502); }
}

// ---------- validation ----------
const bad = (msg) => fail('bad_input', 400, msg);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
function point(lat, lng) {
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) throw bad('Coordonnées invalides.');
  if (la < FRANCE.latMin || la > FRANCE.latMax || lo < FRANCE.lngMin || lo > FRANCE.lngMax) throw bad('Position hors de France.');
  return { lat: Math.round(la * 1e5) / 1e5, lng: Math.round(lo * 1e5) / 1e5 };
}

/** Paramètres d'adresse d'une tuile (chaînes) → { style, z, x, y } contrôlés ; lève bad_input sinon. y arrive sous la forme « 1488.png ». */
function parseTileParams({ style, z, x, y }) {
  const ym = /^(\d{1,7})\.png$/.exec(String(y));
  if (!/^[a-z0-9-]{1,20}$/.test(String(style)) || !/^\d{1,2}$/.test(String(z)) || !/^\d{1,7}$/.test(String(x)) || !ym) throw bad('Tuile invalide.');
  return { style: String(style), z: Number(z), x: Number(x), y: Number(ym[1]) };
}

// ---------- tuiles de circulation ----------
/** Tuile PNG (256 px) des vitesses de circulation. */
function tile({ style = 'relative0', z, x, y }) {
  if (!STYLES.includes(style)) throw bad('Style de trafic inconnu.');
  if (![z, x, y].every(isInt) || z < TILE_ZOOM.min || z > TILE_ZOOM.max) throw bad('Tuile hors zone.');
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw bad('Tuile hors zone.');
  // Zone France : on refuse les tuiles dont aucun coin n'est dans la boîte, pour ne pas payer des tuiles d'ailleurs.
  const lng0 = (x / n) * 360 - 180, lng1 = ((x + 1) / n) * 360 - 180;
  const lat = (t) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180) / Math.PI;
  const lat0 = lat(y + 1), lat1 = lat(y);
  if (lng1 < FRANCE.lngMin || lng0 > FRANCE.lngMax || lat1 < FRANCE.latMin || lat0 > FRANCE.latMax) throw bad('Tuile hors de France.');
  const key = `t:${style}/${z}/${x}/${y}`;
  const hit = tileMemo.get(key);
  if (hit) return Promise.resolve(hit);
  return once(key, async () => {
    const buf = await call('tiles', `/traffic/map/4/tile/flow/${style}/${z}/${x}/${y}.png`, { tileSize: 256 }, 'image/png');
    if (!isPng(buf)) throw fail('upstream', 502);
    tileMemo.set(key, buf, 2 * MIN, buf.length);
    return buf;
  });
}

// ---------- vitesse en un point ----------
/** Vitesse actuelle et vitesse habituelle de la route la plus proche. */
function speedAt(lat, lng) {
  const p = point(lat, lng);
  const key = `s:${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  const hit = dataMemo.get(key);
  if (hit) return Promise.resolve(hit);
  return once(key, async () => {
    const data = parseJson(await call('api', '/traffic/services/4/flowSegmentData/absolute/14/json', { point: `${p.lat},${p.lng}`, unit: 'KMPH' }, 'application/json'));
    const f = data && data.flowSegmentData;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    if (!f || num(f.currentSpeed) == null || num(f.freeFlowSpeed) == null) throw fail('upstream', 502, 'Pas de donnée de circulation à cet endroit.');
    const out = {
      currentKmh: Math.round(f.currentSpeed), freeFlowKmh: Math.round(f.freeFlowSpeed),
      currentSec: num(f.currentTravelTime), freeFlowSec: num(f.freeFlowTravelTime),
      confidence: num(f.confidence), closed: f.roadClosure === true,
    };
    out.ratio = out.freeFlowKmh > 0 ? Math.round((out.currentKmh / out.freeFlowKmh) * 100) / 100 : null;
    dataMemo.set(key, out, 1 * MIN);
    return out;
  });
}

// ---------- durée d'un itinéraire avec le trafic ----------
/**
 * points : 2 à 25 positions dans l'ordre de passage. departAt : instant de départ (Date) ou null = maintenant (trafic réel).
 * Renvoie { lengthM, travelSec, noTrafficSec, delaySec, departAt, arrivalAt, legs: [{ lengthM, travelSec, noTrafficSec, delaySec, arrivalAt }] }.
 */
function route(points, { departAt = null } = {}) {
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS) throw bad(`Un itinéraire compte de 2 à ${MAX_POINTS} points.`);
  const pts = points.map(p => point(p.lat, p.lng));
  const now = Date.now();
  let when = null;
  if (departAt != null) {
    const t = departAt instanceof Date ? departAt.getTime() : NaN;
    if (!Number.isFinite(t)) throw bad('Heure de départ invalide.');
    if (t > now + 3 * MIN) {
      if (t > now + 14 * 24 * 60 * MIN) throw bad('Heure de départ trop lointaine (14 jours au plus).');
      when = new Date(Math.round(t / (5 * MIN)) * 5 * MIN);   // arrondie à 5 min : un même créneau repart de la mémoire
    }
  }
  const mode = travelMode();
  const locs = pts.map(p => `${p.lat},${p.lng}`).join(':');
  const key = `r:${mode}:${locs}:${when ? when.toISOString() : `now${Math.floor(now / (5 * MIN))}`}`;
  const hit = dataMemo.get(key);
  if (hit) return Promise.resolve(hit);
  return once(key, async () => {
    const params = { traffic: 'true', travelMode: mode, routeType: 'fastest', computeTravelTimeFor: 'all' };
    if (when) params.departAt = when.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const data = parseJson(await call('api', `/routing/1/calculateRoute/${locs}/json`, params, 'application/json'));
    const r = data && Array.isArray(data.routes) ? data.routes[0] : null;
    const sum = r && r.summary;
    if (!sum || !Number.isFinite(sum.travelTimeInSeconds) || !Array.isArray(r.legs) || !r.legs.length) throw fail('upstream', 502, 'TomTom n\'a trouvé aucun itinéraire.');
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const shape = (s) => {
      const travel = Math.round(s.travelTimeInSeconds);
      const delay = Math.max(0, Math.round(n(s.trafficDelayInSeconds) ?? 0));
      const free = Math.round(n(s.noTrafficTravelTimeInSeconds) ?? Math.max(0, travel - delay));
      return { lengthM: Math.round(n(s.lengthInMeters) ?? 0), travelSec: travel, noTrafficSec: free, delaySec: delay, arrivalAt: typeof s.arrivalTime === 'string' ? s.arrivalTime : null };
    };
    const out = { ...shape(sum), departAt: typeof sum.departureTime === 'string' ? sum.departureTime : (when || new Date(now)).toISOString(), legs: r.legs.map(l => shape(l.summary || {})) };
    dataMemo.set(key, out, 5 * MIN);
    return out;
  });
}

// ---------- état (pour l'interface : jamais la clé) ----------
function status() {
  const av = availability();
  const lim = limits();
  const usage = { api: { used: usedToday('api'), limit: lim.api }, tiles: { used: usedToday('tiles'), limit: lim.tiles } };
  const paused = av.state === 'on' && isPaused();
  // Plafond du jour atteint : dit clairement ce qui est suspendu (les réponses déjà en mémoire continuent d'être servies).
  let reason = av.state === 'on' ? (paused ? breaker.reason : null) : av.reason;
  let message = av.state === 'on' ? (paused ? MESSAGES[breaker.reason] : null) : MESSAGES[av.reason];
  if (av.state === 'on' && !paused) {
    if (usage.tiles.used >= usage.tiles.limit) { reason = 'budget'; message = 'Plafond quotidien de tuiles atteint : la couche Trafic est suspendue jusqu\'à demain (minuit UTC).'; }
    else if (usage.api.used >= usage.api.limit) { reason = 'budget'; message = 'Plafond quotidien de calculs atteint : heures de passage et vitesses suspendues jusqu\'à demain (minuit UTC).'; }
  }
  return {
    enabled: av.state === 'on', reason, message,
    pausedUntil: paused ? new Date(breaker.openUntil).toISOString() : null,
    travelMode: travelMode(), usage,
  };
}

module.exports = { tile, parseTileParams, speedAt, route, status, scrub, spend, driverLimits, TrafficError, STYLES, TILE_ZOOM, MAX_POINTS, _breaker: breaker };
