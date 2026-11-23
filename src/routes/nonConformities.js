// Non-conformités : un hôtel signale, depuis son espace client, un problème sur une livraison (il manque du linge, du linge
// en trop, sale, abîmé…). L'équipe est prévenue, retrouve les signalements dans l'administration, y répond et les clôt ;
// l'hôtel suit l'état de chaque signalement et lit la réponse.
const express = require('express');
const db = require('../db');
const security = require('../middleware/security');
const { requireClient, requireAdmin } = require('../middleware/auth');
const { sendWhatsAppNotification } = require('../utils/whatsapp');

const KINDS = {
  manque: 'Il manque du linge',
  en_trop: 'Du linge en trop ou qui n\'est pas à nous',
  sale: 'Linge sale, taché ou mal lavé',
  abime: 'Linge abîmé (troué, déchiré, décoloré)',
  autre: 'Autre problème',
};
const STATUSES = { ouverte: 'Reçu', en_cours: 'En cours de traitement', resolue: 'Traité' };
const MAX_LINES = 30; const MAX_QTY = 100000; const MAX_COMMENT = 1000; const MAX_NOTE = 1000;

const parseLines = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const shape = (r) => ({
  id: r.id, orderId: r.order_id, ticket: r.ticket,
  kind: r.kind, kindLabel: KINDS[r.kind] || r.kind,
  lines: parseLines(r.lines_json),
  comment: r.comment || '',
  status: r.status, statusLabel: STATUSES[r.status] || r.status,
  teamNote: r.team_note || '',
  createdAt: r.created_at, updatedAt: r.updated_at,
});

// ---------- côté hôtel ----------
const clientRouter = express.Router();
clientRouter.use(requireClient);

const createLimit = security.rateLimit({
  name: 'non-conformité', windowMs: 60 * 60 * 1000, max: 30, key: (req) => `nc:${req.session.clientId}`,
  message: 'Trop de signalements envoyés en peu de temps. Appelez Blanchisserie Cézanne si c\'est urgent.',
});

// GET /api/clients/non-conformities — les signalements de l'hôtel connecté, du plus récent au plus ancien.
clientRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM non_conformities WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT 200').all(req.session.clientId);
  res.json({ nonConformities: rows.map(shape), kinds: KINDS });
});

// POST /api/clients/non-conformities — signaler un problème sur une livraison.
// body : { orderId, kind, comment?, lines?: [{ id, qty }] }  (au moins un article ou un commentaire)
clientRouter.post('/', createLimit, (req, res) => {
  const clientId = req.session.clientId;
  const { orderId, kind, comment, lines } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) return res.status(400).json({ error: 'Choisissez le type de problème.' });
  if (comment != null && (typeof comment !== 'string' || comment.length > MAX_COMMENT)) return res.status(400).json({ error: `Le commentaire est trop long (${MAX_COMMENT} caractères au plus).` });
  if (lines != null && (!Array.isArray(lines) || lines.length > MAX_LINES)) return res.status(400).json({ error: 'Liste d\'articles invalide.' });

  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND client_id = ? AND status = 'livree'").get(Number(orderId), clientId);
  if (!order) return res.status(404).json({ error: 'Livraison introuvable.' });

  const items = Object.fromEntries(db.prepare('SELECT service_id AS id, name FROM order_items WHERE order_id = ?').all(order.id).map(i => [i.id, i.name]));
  const resolved = [];
  for (const l of lines || []) {
    const qty = Number(l && l.qty);
    if (!l || typeof l.id !== 'string' || !Object.prototype.hasOwnProperty.call(items, l.id)) return res.status(400).json({ error: 'Article inconnu sur cette livraison.' });
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) return res.status(400).json({ error: `Quantité invalide pour ${items[l.id]}.` });
    resolved.push({ id: l.id, name: items[l.id], qty });
  }
  const text = (comment || '').trim();
  if (!resolved.length && text.length < 3) return res.status(400).json({ error: 'Indiquez les articles concernés ou décrivez le problème.' });

  const now = new Date().toISOString();
  const id = db.prepare(`INSERT INTO non_conformities (client_id, order_id, ticket, kind, lines_json, comment, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'ouverte', ?)`)
    .run(clientId, order.id, order.ticket, kind, JSON.stringify(resolved), text || null, now).lastInsertRowid;

  // L'équipe le voit dans la discussion de la commande et par message ; au mieux, sans jamais faire échouer le signalement.
  const summary = `${KINDS[kind]}${resolved.length ? ` — ${resolved.map(l => `${l.name} ×${l.qty}`).join(', ')}` : ''}${text ? ` — « ${text} »` : ''}`;
  try { db.prepare('INSERT INTO order_comments (order_id, author, text) VALUES (?, ?, ?)').run(order.id, `${order.societe} (non-conformité)`, summary); } catch { /* facultatif */ }
  sendWhatsAppNotification(`Non-conformité — ${order.societe} — ${order.ticket} — ${summary}`).catch(err => console.error('Notification WhatsApp échouée :', err.message));

  res.status(201).json({ nonConformity: shape(db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(id)) });
});

// ---------- côté administration ----------
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// GET /api/admin/non-conformities?status=open|ouverte|en_cours|resolue — du plus récent au plus ancien.
adminRouter.get('/', (req, res) => {
  const st = String(req.query.status || '');
  const where = st === 'open' ? "WHERE n.status != 'resolue'" : Object.prototype.hasOwnProperty.call(STATUSES, st) ? 'WHERE n.status = @st' : '';
  const rows = db.prepare(`
    SELECT n.*, c.societe, c.contact, c.tel FROM non_conformities n JOIN clients c ON c.id = n.client_id
    ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT 300
  `).all(where.includes('@st') ? { st } : {});
  const open = db.prepare("SELECT COUNT(*) AS n FROM non_conformities WHERE status != 'resolue'").get().n;
  res.json({
    open,
    nonConformities: rows.map(r => ({ ...shape(r), client: { societe: r.societe, contact: r.contact, tel: r.tel } })),
    statuses: STATUSES,
  });
});

// PATCH /api/admin/non-conformities/:id — changer l'état et/ou écrire la réponse visible par l'hôtel.
// body : { status?, teamNote? }
adminRouter.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Signalement introuvable.' });
  const { status, teamNote } = req.body || {};
  if (status != null && !Object.prototype.hasOwnProperty.call(STATUSES, status)) return res.status(400).json({ error: 'État invalide.' });
  if (teamNote != null && (typeof teamNote !== 'string' || teamNote.length > MAX_NOTE)) return res.status(400).json({ error: `La réponse est trop longue (${MAX_NOTE} caractères au plus).` });
  db.prepare('UPDATE non_conformities SET status = ?, team_note = ?, updated_at = ? WHERE id = ?')
    .run(status ?? row.status, teamNote != null ? (teamNote.trim() || null) : row.team_note, new Date().toISOString(), row.id);
  res.json({ nonConformity: shape(db.prepare('SELECT * FROM non_conformities WHERE id = ?').get(row.id)) });
});

module.exports = { clientRouter, adminRouter, KINDS, STATUSES };
