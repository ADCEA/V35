// Texte à géocoder pour une commande : son adresse, complétée par le code postal et la ville de la fiche client (voir geocodeQuery).
const db = require('../db');
const { geocodeQuery } = require('./geocode');

function queryForOrder(order) {
  const c = order && order.client_id ? db.prepare('SELECT code_postal, ville FROM clients WHERE id = ?').get(order.client_id) : null;
  return geocodeQuery({ adresse: order && order.adresse, codePostal: c && c.code_postal, ville: c && c.ville });
}

module.exports = { queryForOrder };
