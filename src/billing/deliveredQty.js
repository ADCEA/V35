// Correction des quantités LIVRÉES d'une commande.
//
// La facture suit la quantité livrée (delivered_qty), pas la quantité commandée. À la création d'une commande,
// la quantité livrée est pré-remplie avec la quantité commandée : c'est à l'équipe de la corriger quand la
// livraison est incomplète. Elle reste donc corrigeable jusqu'à ce que la commande soit reprise dans une facture
// (ou un brouillon) : ensuite les montants sont figés, et seul un avoir permet de rectifier.
//
// La quantité commandée par le client (qty) n'est jamais modifiée ici.
// Une correction faite APRÈS la préparation (commande prête ou livrée) est inscrite au journal de facturation
// (append-only, chaîné par hash) : on peut toujours savoir qui a changé quoi avant l'émission d'une facture.

const db = require('../db');
const engine = require('./engine');
const deliveries = require('./deliveries');

const { BillingError } = engine;

// Avant « traitement », rien n'a encore été préparé : il n'y a pas de quantité livrée à saisir.
const EDITABLE_STATUSES = ['traitement', 'prete', 'livree'];

/** Refuse si la commande figure déjà dans une facture ou un brouillon (les montants y sont figés). */
function assertNotBilled(orderId) {
  const b = deliveries.billingOfOrder(orderId);
  if (b.status === 'invoiced') {
    throw new BillingError(b.invoiceNumber
      ? `Commande déjà facturée (${b.invoiceNumber}) : les quantités sont figées. Pour corriger, émettez un avoir.`
      : 'Commande déjà facturée : les quantités sont figées. Pour corriger, émettez un avoir.', 409);
  }
  if (b.status === 'draft') {
    throw new BillingError('Cette commande est dans un brouillon de facture : supprimez le brouillon avant de corriger les quantités livrées.', 409);
  }
}

/**
 * Enregistre les quantités livrées. `items` = [{ id: service_id, deliveredQty }]. Un article absent de la liste
 * garde sa valeur ; une valeur de mauvais signe (ligne normale < 0, reprise > 0) est ignorée.
 * Renvoie la liste des changements effectifs.
 */
function setDelivered(orderId, items) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new BillingError('Commande introuvable.', 404);
  if (!EDITABLE_STATUSES.includes(order.status)) {
    throw new BillingError('Les quantités livrées se saisissent une fois la commande passée en traitement.', 409);
  }
  assertNotBilled(orderId);
  if (!Array.isArray(items)) throw new BillingError("Liste d'articles invalide.", 400);

  const rows = db.prepare('SELECT service_id AS serviceId, name, qty, delivered_qty AS deliveredQty FROM order_items WHERE order_id = ?').all(orderId);
  const update = db.prepare('UPDATE order_items SET delivered_qty = ? WHERE order_id = ? AND service_id = ?');
  const changes = [];
  db.transaction(() => {
    for (const row of rows) {
      const found = items.find(i => i && i.id === row.serviceId);
      if (!found) continue;
      const raw = parseInt(found.deliveredQty, 10);
      const okSign = Number.isInteger(raw) && (row.qty < 0 ? raw <= 0 : raw >= 0);
      if (!okSign) continue;
      const before = row.deliveredQty ?? row.qty;
      update.run(raw, orderId, row.serviceId);
      if (raw !== before) changes.push({ article: row.name, ordered: row.qty, from: before, to: raw });
    }
    if (changes.length && order.status !== 'traitement') {
      engine.logEvent('delivered_qty_changed', null, { orderId, ticket: order.ticket, status: order.status, changes });
    }
  })();
  return changes;
}

module.exports = { EDITABLE_STATUSES, assertNotBilled, setDelivered };
