// Tracé routier entre deux points, pour la carte des tournées. Service public OSRM (gratuit, sans clé, usage raisonnable) :
// un tronçon n'est demandé qu'une fois puis gardé en mémoire. Au mieux : tant qu'un tronçon n'est pas disponible (ou si le
// service est injoignable), la carte trace une ligne droite — elle ne bloque jamais et ne dépend pas de ce service.
// Désactivable avec ROAD_ROUTING=off (tests, poste sans accès).

const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const USER_AGENT = 'BlanchisserieCezanne/1.0 (application de gestion de blanchisserie)';
const TIMEOUT_MS = 6000;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const MAX_CACHED = 2000;

const cache = new Map();      // clé de tronçon -> [[lat, lng], …]
const failedAt = new Map();   // clé de tronçon -> instant du dernier échec
const inFlight = new Set();

const round = (n) => Math.round(n * 1e5) / 1e5;
const keyOf = (a, b) => `${round(a.lat)},${round(a.lng)};${round(b.lat)},${round(b.lng)}`;
const enabled = () => String(process.env.ROAD_ROUTING || '').toLowerCase() !== 'off';

async function fetchLeg(a, b, key) {
  inFlight.add(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${OSRM_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const data = await res.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) throw new Error('tracé vide');
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
    cache.set(key, coords.map(([lng, lat]) => [lat, lng]));
    failedAt.delete(key);
  } catch {
    failedAt.set(key, Date.now());
  } finally {
    clearTimeout(timer);
    inFlight.delete(key);
  }
}

/**
 * Tracé routier du tronçon a → b s'il est déjà connu ([[lat, lng], …]), sinon null — et, une seule fois, on le demande en
 * arrière-plan pour que le prochain rafraîchissement de la carte l'ait.
 */
function legGeometry(a, b) {
  if (!enabled()) return null;
  const key = keyOf(a, b);
  const hit = cache.get(key);
  if (hit) return hit;
  const failed = failedAt.get(key);
  if (!inFlight.has(key) && (!failed || Date.now() - failed > RETRY_AFTER_MS)) fetchLeg(a, b, key);
  return null;
}

module.exports = { legGeometry, _cache: cache };
