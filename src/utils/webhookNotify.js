// Notifie automatiquement le logiciel d'un hôtel intégré via API quand
// une de ses commandes passe au statut "livrée", avec les quantités
// définitivement livrées (potentiellement différentes de la quantité
// commandée, si un ajustement a eu lieu pendant le traitement).
//
// Best-effort, comme les autres notifications (WhatsApp, email) : si
// l'hôtel n'a pas configuré d'URL, ou si l'appel échoue (serveur client
// injoignable, timeout...), ça ne doit JAMAIS bloquer le changement de
// statut côté admin — juste être tenté, en silence en cas d'échec.

const { assertPublicUrl } = require('./publicHost');

const TIMEOUT_MS = 8000;

/**
 * Envoie le webhook de livraison. `client` doit contenir webhook_url et
 * webhook_secret. `order` la commande (déjà passée à 'livree'). `items`
 * la liste [{ code, name, qty, deliveredQty }].
 * Ne fait rien si aucune URL n'est configurée pour cet hôtel.
 */
async function notifyOrderDelivered(client, order, items) {
  if (!client?.webhook_url) return { sent: false, reason: 'not_configured' };

  const payload = {
    event: 'order.delivered',
    ticket: order.ticket,
    deliveredAt: new Date().toISOString(),
    items: items.map(it => ({
      sageCode: it.code,
      name: it.name,
      qtyOrdered: it.qty,
      qtyDelivered: it.deliveredQty ?? it.qty,
    })),
  };

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

module.exports = { notifyOrderDelivered };
