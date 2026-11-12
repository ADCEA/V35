// Notifie automatiquement le logiciel d'un hôtel intégré via API quand
// une de ses commandes passe au statut "livrée", avec les quantités
// définitivement livrées (potentiellement différentes de la quantité
// commandée, si un ajustement a eu lieu pendant le traitement).
//
// Deux événements :
//   - order.delivered        : la commande vient d'être livrée ;
//   - order.delivery_updated : les quantités livrées ont été corrigées APRÈS la livraison (tant que la commande
//                              n'est pas facturée) — le logiciel de l'hôtel remplace alors ce qu'il avait reçu.
// Les deux portent le même contenu. Pour chaque article : qtyOrdered, qtyDelivered, difference (livré − commandé,
// négatif = moins que commandé) et discrepancy ('short', 'over' ou null) ; au niveau de la commande : hasDiscrepancy,
// vrai dès qu'un article n'a pas été livré tel que commandé.
//
// Best-effort, comme les autres notifications (WhatsApp, email) : si
// l'hôtel n'a pas configuré d'URL, ou si l'appel échoue (serveur client
// injoignable, timeout...), ça ne doit JAMAIS bloquer le changement de
// statut côté admin — juste être tenté, en silence en cas d'échec.

const { assertPublicUrl } = require('./publicHost');
const { lineDiff } = require('./deliveryDiff');

const TIMEOUT_MS = 8000;

/** Contenu envoyé à l'hôtel. `items` : [{ code, name, qty, deliveredQty }]. */
function buildPayload(event, order, items) {
  const lines = items.map(it => ({
    sageCode: it.code,
    name: it.name,
    ...lineDiff(it),
  }));
  return {
    event,
    ticket: order.ticket,
    [event === 'order.delivered' ? 'deliveredAt' : 'updatedAt']: new Date().toISOString(),
    hasDiscrepancy: lines.some(l => l.discrepancy !== null),
    items: lines,
  };
}

async function post(client, payload) {
  // Jamais vers une machine interne (serveur, réseau privé, métadonnées du cloud) ; et pas de redirection suivie
  // (elle contournerait la vérification).
  await assertPublicUrl(client.webhook_url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(client.webhook_url, {
      redirect: 'manual',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cezanne-Webhook-Secret': client.webhook_secret || '',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Le webhook a répondu ${res.status}`);
    }
    return { sent: true };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Envoie le webhook de livraison. `client` doit contenir webhook_url et
 * webhook_secret. `order` la commande (déjà passée à 'livree'). `items`
 * la liste [{ code, name, qty, deliveredQty }].
 * Ne fait rien si aucune URL n'est configurée pour cet hôtel.
 */
async function notifyOrderDelivered(client, order, items) {
  if (!client?.webhook_url) return { sent: false, reason: 'not_configured' };
  return post(client, buildPayload('order.delivered', order, items));
}

/** Même chose quand les quantités livrées sont corrigées après la livraison. */
async function notifyOrderDeliveryUpdated(client, order, items) {
  if (!client?.webhook_url) return { sent: false, reason: 'not_configured' };
  return post(client, buildPayload('order.delivery_updated', order, items));
}

module.exports = { notifyOrderDelivered, notifyOrderDeliveryUpdated, buildPayload };
