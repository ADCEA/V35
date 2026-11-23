// Points des commandes sur les cartes (Logistique, TV, lien livreur) : adresse → coordonnées, mis à jour tout seul.
//
// Chaque point retient le texte exact qui a servi à le calculer (orders.geo_query : l'adresse complétée par le code postal et la
// ville de la fiche). Un point est « périmé » quand ce texte n'est plus celui d'aujourd'hui : fiche corrigée, règle de calcul
// améliorée, ou point antérieur à cette trace (donc tous les anciens points, calculés avec la seule adresse tapée). Les points
// périmés sont recalculés en arrière-plan, une adresse par seconde (limite de Nominatim) ; l'ancien point reste affiché tant que
// le nouveau n'est pas trouvé. Les livraisons validées avec la position GPS du chauffeur gardent cette position.
const db = require('../db');
const { geocodeAddress, sleep } = require('./geocode');
const { queryForOrder } = require('./orderGeocode');
const { parisDay } = require('./orderDelivery');

const RETRY_MS = 10 * 60 * 1000;        // une adresse introuvable n'est pas redemandée avant 10 min
const PER_PASS = 25;                    // adresses recalculées par passage
const triedAt = new Map();              // id de commande -> instant du dernier essai infructueux
let running = false;

/** Commandes à placer sur les cartes : les « prêtes », et celles livrées aujourd'hui par un chauffeur. */
function mapOrders() {
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const today = parisDay();
  return db.prepare(`
    SELECT * FROM orders
    WHERE status = 'prete' OR (status = 'livree' AND driver_id IS NOT NULL AND delivered_at IS NOT NULL AND delivered_at >= ?)
  `).all(since).filter(o => o.status === 'prete' || parisDay(o.delivered_at) === today);
}

/** Le point manque, ou n'a pas été calculé avec l'adresse (et la fiche) d'aujourd'hui. */
function needsCoords(o) {
  if (!o.adresse || o.delivered_lat != null) return false;   // livrée avec la position du chauffeur : on la garde
  if (o.lat == null || o.lng == null) return true;
  return o.geo_query !== queryForOrder(o);
}

/** Géocode une commande et enregistre le point avec le texte utilisé. Renvoie { lat, lng } ou null si introuvable. */
async function geocodeOrder(o) {
  const q = queryForOrder(o);
  const c = await geocodeAddress(q);
  if (!c) return null;
  db.prepare('UPDATE orders SET lat = ?, lng = ?, geo_query = ? WHERE id = ?').run(c.lat, c.lng, q, o.id);
  return c;
}

/** Nombre de points de la carte à calculer ou à recalculer (hors adresses récemment introuvables). */
function pendingCount(orders = mapOrders()) {
  return orders.filter(o => needsCoords(o) && !(triedAt.get(o.id) > Date.now() - RETRY_MS)).length;
}

/** Recalcule, en arrière-plan, les points manquants ou périmés. Un seul passage à la fois. */
async function refreshOrderCoords() {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    const todo = mapOrders().filter(o => needsCoords(o) && !(triedAt.get(o.id) > Date.now() - RETRY_MS)).slice(0, PER_PASS);
    for (const o of todo) {
      try {
        if (await geocodeOrder(o)) { done++; triedAt.delete(o.id); } else triedAt.set(o.id, Date.now());
      } catch { triedAt.set(o.id, Date.now()); }
      await sleep(1100);
    }
  } finally { running = false; }
  return done;
}

/** Au démarrage puis toutes les 10 minutes : les anciens points se mettent à jour même sans que personne n'ouvre la carte. */
function startScheduler() {
  if (String(process.env.GEOCODE_SCHEDULER || '').toLowerCase() === 'off') return;
  const tick = () => { refreshOrderCoords().catch(() => {}); };
  setTimeout(tick, Number(process.env.GEOCODE_FIRST_RUN_MS) || 20 * 1000).unref();
  setInterval(tick, RETRY_MS).unref();
}

module.exports = { mapOrders, needsCoords, geocodeOrder, pendingCount, refreshOrderCoords, startScheduler };
