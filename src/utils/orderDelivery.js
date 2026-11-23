// Passage d'une commande à « livrée » par le livreur (lien de tournée) : un seul endroit pour ce que cela entraîne,
// avec les mêmes effets que le changement de statut fait depuis l'administration (date de livraison complétée,
// notification du logiciel de l'hôtel s'il est intégré par API), plus l'heure exacte et le lieu de la validation.
const db = require('../db');
const { notifyOrderDelivered } = require('./webhookNotify');

const itemsStmt = db.prepare('SELECT service_id as id, name, code, sage_code as sageCode, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?');

/** Jour civil à Paris (AAAA-MM-JJ) d'un instant : « aujourd'hui » pour l'équipe, quel que soit le fuseau du serveur. */
function parisDay(date = new Date()) {
  return new Date(date).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
}

/** Coordonnées plausibles (nombres finis dans les bornes du globe), sinon null. */
function cleanCoords(lat, lng) {
  const la = Number(lat); const ln = Number(lng);
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return { lat: la, lng: ln };
}

/**
 * Valide la livraison d'une commande prête. Idempotent : une commande déjà livrée est renvoyée telle quelle (l'heure
 * d'origine est conservée, le logiciel de l'hôtel n'est pas prévenu une seconde fois).
 * Renvoie { order, already }.
 */
function markDelivered(order, { at = new Date(), lat = null, lng = null } = {}) {
  if (order.status === 'livree') return { order, already: true };
  const where = cleanCoords(lat, lng);
  const deliveredAt = new Date(at).toISOString();
  const livraisonPrevue = order.livraison_prevue || parisDay(at);
  db.prepare('UPDATE orders SET status = ?, livraison_prevue = ?, delivered_at = ?, delivered_lat = ?, delivered_lng = ? WHERE id = ?')
    .run('livree', livraisonPrevue, deliveredAt, where ? where.lat : null, where ? where.lng : null, order.id);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);

  // Comme côté administration : au mieux, sans jamais bloquer ni faire échouer la validation.
  if (order.client_id && !order.collect_only) {   // un arrêt de collecte ne livre rien : le logiciel de l'hôtel n'a rien à recevoir
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    if (client?.webhook_url) notifyOrderDelivered(client, updated, itemsStmt.all(order.id)).catch(() => {});
  }
  return { order: updated, already: false };
}

module.exports = { markDelivered, parisDay, cleanCoords };
