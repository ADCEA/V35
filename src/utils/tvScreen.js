// Écran TV : jeton de la TV (conservé sous forme d'empreinte) et version « publique » de la carte des tournées.
const crypto = require('crypto');

const tvTokenHash = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');

/**
 * La TV est dans un local où passe du monde : on ne lui envoie que ce qu'elle affiche. Ni adresses (clients, dépôt), ni
 * numéros de ticket, ni détail de l'itinéraire client par client au-delà des points de la carte.
 */
function publicMap(m) {
  const stop = ({ adresse, ticket, ...rest }) => rest;   // eslint-disable-line no-unused-vars
  return {
    depot: m.depot ? { lat: m.depot.lat, lng: m.depot.lng } : null,
    drivers: m.drivers.map(d => ({
      id: d.id, name: d.name, vehicle: d.vehicle, color: d.color, sharing: d.sharing,
      truck: d.truck ? { lat: d.truck.lat, lng: d.truck.lng, source: d.truck.source, at: d.truck.at, label: d.truck.label || null } : null,
      stats: d.stats,
      stops: d.stops.map(stop),
      legs: d.legs,
    })),
    unassigned: m.unassigned.map(stop),
    generatedAt: m.generatedAt,
  };
}

module.exports = { tvTokenHash, publicMap };
