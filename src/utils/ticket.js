// Numéro de commande suivant (CZ-AAMMJJ-0001, la séquence ne repart jamais à zéro). À appeler dans la même transaction que l'insertion.
const db = require('../db');

function nextTicket(now = new Date()) {
  const row = db.prepare('SELECT value FROM order_seq WHERE id = 1').get();
  const seq = row.value + 1;
  db.prepare('UPDATE order_seq SET value = ? WHERE id = 1').run(seq);
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `CZ-${yy}${mm}${dd}-${String(seq).padStart(4, '0')}`;
}

module.exports = { nextTicket };
