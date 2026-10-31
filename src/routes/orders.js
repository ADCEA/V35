const express = require('express');
const db = require('../db');
const { getServicesByIdForClient } = require('../services');
const { serializeOrder } = require('../utils/serializeOrder');
const { sendWhatsAppNotification } = require('../utils/whatsapp');
const security = require('../middleware/security');

const router = express.Router();

// Commande d'un invité (sans compte) : au plus 30 par heure et par adresse ; d'un hôtel connecté : 120 par heure et par compte.
// Un robot qui inonderait le formulaire remplirait la production et déclencherait des notifications.
const orderLimitClient = security.rateLimit({
  name: 'commande (hôtel connecté)', windowMs: 60 * 60 * 1000, max: 120,
  key: (req) => `client:${req.session.clientId}`, countOnly: (req) => !!req.session.clientId,
  message: 'Trop de commandes envoyées en peu de temps. Réessayez dans quelques minutes ou appelez Blanchisserie Cézanne.',
});
const orderLimitGuest = security.rateLimit({
  name: 'commande (invité)', windowMs: 60 * 60 * 1000, max: 30,
  key: (req) => `ip:${req.ip}`, countOnly: (req) => !req.session.clientId,
  message: 'Trop de commandes envoyées en peu de temps. Réessayez dans quelques minutes ou appelez Blanchisserie Cézanne.',
});
const MAX_LINES = 150, MAX_QTY = 100000;
const LIMITS = { societe: 120, contact: 120, tel: 40, adresse: 250 };

function nextTicket(now) {
  const row = db.prepare('SELECT value FROM order_seq WHERE id = 1').get();
  const seq = row.value + 1;
  db.prepare('UPDATE order_seq SET value = ? WHERE id = 1').run(seq);

  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `CZ-${yy}${mm}${dd}-${String(seq).padStart(4, '0')}`;
}

// POST /api/orders — créer une commande (client connecté ou invité)
router.post('/', orderLimitGuest, orderLimitClient, (req, res) => {
  const { items, livraisonPrevue, notes, client } = req.body || {};
  const { societe, contact, tel, adresse } = client || {};

  if (!societe || !contact || !tel || !adresse) {
    return res.status(400).json({ error: 'Merci de renseigner société, contact, téléphone et adresse.' });
  }
  for (const [k, v] of Object.entries({ societe, contact, tel, adresse })) {
    if (typeof v !== 'string') return res.status(400).json({ error: `Champ « ${k} » invalide.` });
    if (v.length > LIMITS[k]) return res.status(400).json({ error: `Champ « ${k} » trop long (${LIMITS[k]} caractères au plus).` });
  }
  if (notes != null && (typeof notes !== 'string' || notes.length > 2000)) return res.status(400).json({ error: 'Les notes sont trop longues (2000 caractères au plus).' });
  if (livraisonPrevue != null && (typeof livraisonPrevue !== 'string' || livraisonPrevue.length > 40)) return res.status(400).json({ error: 'Date de livraison invalide.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Merci de sélectionner au moins un article.' });
  }
  if (items.length > MAX_LINES) return res.status(400).json({ error: `Trop d'articles différents (${MAX_LINES} au plus).` });

  const clientId = req.session.clientId || null;
  const servicesById = getServicesByIdForClient(clientId);
  const resolved = [];
  for (const it of items) {
    if (!it || typeof it.id !== 'string') return res.status(400).json({ error: 'Ligne de commande invalide.' });
    const svc = Object.prototype.hasOwnProperty.call(servicesById, it.id) ? servicesById[it.id] : null;
    const qty = parseInt(it.qty, 10);
    if (!svc) return res.status(400).json({ error: `Article inconnu : ${String(it.id).slice(0, 40)}` });
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) {
      return res.status(400).json({ error: `Quantité invalide pour ${svc.name}.` });
    }
    resolved.push({ ...svc, qty, deliveredQty: qty });
  }

  const now = new Date();

  const insertOrder = db.prepare(`
    INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, notes, status, created_at)
    VALUES (@ticket, @clientId, @societe, @contact, @tel, @adresse, @livraisonPrevue, @notes, 'recue', @createdAt)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty)
    VALUES (@orderId, @id, @name, @code, @sageCode, @price, @qty, @qty)
  `);

  const createOrder = db.transaction(() => {
    const ticket = nextTicket(now);
    const info = insertOrder.run({
      ticket,
      clientId,
      societe, contact, tel, adresse,
      livraisonPrevue: livraisonPrevue || null,
      notes: notes || null,
      createdAt: now.toISOString(),
    });
    const orderId = info.lastInsertRowid;
    for (const it of resolved) {
      insertItem.run({ orderId, id: it.id, name: it.name, code: it.code, sageCode: it.sageCode, price: it.price, qty: it.qty });
    }
    return { orderId, ticket };
  });

  const { orderId, ticket } = createOrder();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  // Notification best-effort : une erreur ici ne doit jamais empêcher
  // la commande d'être créée avec succès pour le client.
  const itemsSummary = resolved.map(i => `${i.name} x${i.qty}`).join(', ');
  sendWhatsAppNotification(`Nouvelle commande ${ticket} — ${societe} (${contact}) — ${itemsSummary}`)
    .catch(err => console.error('Notification WhatsApp échouée :', err.message));

  res.status(201).json({ order: serializeOrder(order, resolved), ticket });
});

// GET /api/orders/track/:ticket — suivi par numéro de ticket.
// Les numéros se suivent (CZ-AAMMJJ-0001…) : n'importe qui pourrait donc les énumérer. Sans connexion, on ne répond que
// l'avancement (statut, date) — ni nom d'hôtel, ni adresse, ni articles, ni prix. Le détail complet n'est donné qu'à l'hôtel
// qui a passé la commande ou à l'administration.
const trackLimit = security.rateLimit({ name: 'suivi de commande', windowMs: 15 * 60 * 1000, max: 60, message: 'Trop de recherches. Réessayez dans quelques minutes.' });
router.get('/track/:ticket', trackLimit, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE ticket = ?').get(String(req.params.ticket).trim().toUpperCase().slice(0, 40));
  if (!order) return res.status(404).json({ error: 'Aucune commande trouvée pour ce numéro.' });
  const isOwner = !!req.session.clientId && order.client_id === req.session.clientId;
  if (!isOwner && !security.adminActive(req.session)) {
    return res.json({ order: { ticket: order.ticket, status: order.status, livraisonPrevue: order.livraison_prevue, createdAt: order.created_at } });
  }
  const items = db.prepare('SELECT service_id as id, name, code, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?').all(order.id);
  res.json({ order: serializeOrder(order, items) });
});

module.exports = router;
