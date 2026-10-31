// /api/claude/v1 — consultation des données par Claude, en LECTURE SEULE.
//
// Authentification : « Authorization: Bearer czc_… » (jeton créé dans Facturation → Sécurité et sauvegardes → Accès Claude).
// Ce jeton ne donne accès qu'à CETTE API : jamais à l'administration, jamais à l'écriture. Cette API ne sait faire que
// des GET ; tout le reste est refusé avant même de lire le jeton. Chaque périmètre (exploitation, hôtels, finance) est
// choisi à la création du jeton. Ne sortent jamais d'ici : mots de passe, codes d'accès des hôtels, clés et secrets
// techniques (webhooks, jetons d'API), IBAN et mandats de prélèvement, réglages, sauvegardes, PDF.
const express = require('express');
const db = require('../db');
const access = require('../utils/claudeAccess');
const engine = require('../billing/engine');
const queries = require('../billing/queries');
const daily = require('../billing/daily');
const dailyStats = require('../utils/dailyStats');
const statsRouter = require('./stats');
const { wrap, present } = require('../billing/http');

const router = express.Router();

// ---------- accès : méthode, jeton, cadence ----------

// Anti-essais : 20 jetons faux en 15 minutes depuis une même adresse ferment la route 15 minutes (le jeton fait 256 bits :
// c'est du bruit à éteindre, pas une vraie menace).
const fails = new Map();
const WINDOW_MS = 15 * 60 * 1000; const MAX_FAILS = 20;
function blocked(ip, now) {
  const f = fails.get(ip);
  if (!f) return 0;
  if (now - f.first > WINDOW_MS) { fails.delete(ip); return 0; }
  return f.n >= MAX_FAILS ? Math.ceil((f.first + WINDOW_MS - now) / 1000) : 0;
}
function fail(ip, now) {
  const f = fails.get(ip);
  if (!f || now - f.first > WINDOW_MS) fails.set(ip, { n: 1, first: now }); else f.n += 1;
  if (fails.size > 500) for (const [k, v] of fails) if (now - v.first > WINDOW_MS) fails.delete(k);
}

const ASK = 'demandez un nouvel accès à Adrien (Facturation → Sécurité et sauvegardes → Accès Claude)';
const REASONS = {
  format: 'Jeton manquant ou mal formé.',
  unknown: 'Jeton inconnu.',
  revoked: `Jeton révoqué : ${ASK}.`,
  expired: `Jeton expiré : ${ASK}.`,
};

router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.set('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Accès en lecture seule : seules les requêtes GET sont acceptées.' });
  }
  if (!access.enabled()) return res.status(503).json({ error: "L'accès Claude est désactivé sur ce serveur (variable CLAUDE_ACCESS)." });
  const now = Date.now();
  const wait = blocked(req.ip, now);
  if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: "Trop d'essais. Réessayez plus tard." }); }
  // Le jeton ne passe JAMAIS dans l'adresse (elle finirait dans des journaux) : seulement dans l'en-tête.
  const m = String(req.headers.authorization || '').trim().match(/^Bearer\s+(\S+)$/i);
  const r = access.check(m ? m[1] : '');
  if (!r.ok) {
    fail(req.ip, now);
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: REASONS[r.reason] || REASONS.unknown });
  }
  const rate = access.rateOk(r.token.id, now);
  if (!rate.ok) {
    res.set('Retry-After', String(rate.retryAfterSec));
    return res.status(429).json({ error: `Trop de lectures à la suite (${access.RATE_PER_MIN} par minute). Réessayez dans ${rate.retryAfterSec} s.` });
  }
  req.claude = r.token;
  const url = req.originalUrl;
  res.on('finish', () => access.recordUse(r.token.id, { method: req.method, path: url, status: res.statusCode, ip: req.ip }));
  next();
});

const need = (scope) => (req, res, next) => {
  if (req.claude.scopes.includes(scope)) return next();
  return res.status(403).json({ error: `Cet accès n'ouvre pas le périmètre « ${scope} ».`, code: 'SCOPE_NOT_GRANTED', scope });
};

// ---------- aides ----------

const text = (v, max = 80) => (v === undefined || v === null ? '' : String(Array.isArray(v) ? v[0] : v).slice(0, max));
const isoOrNull = (v) => (v && engine.isIsoDate(v) ? v : undefined);
const pageOf = (q, def = 100, max = 500) => ({
  limit: Math.min(Math.max(parseInt(text(q.limit, 6), 10) || def, 1), max),
  offset: Math.max(parseInt(text(q.offset, 8), 10) || 0, 0),
});

const ENDPOINTS = {
  exploitation: [
    ['/orders', 'Commandes : ?from=AAAA-MM-JJ&to=AAAA-MM-JJ (date de livraison prévue, à défaut de réception), ?status=recue|traitement|prete|livree, ?clientId=, ?limit= (500 au plus), ?offset='],
    ['/orders/:id', 'Une commande avec ses articles et quantités livrées (sans prix)'],
    ['/stats', "Vue d'ensemble de l'activité : ?from=&to= (400 jours au plus)"],
    ['/stats/daily', 'Activité jour par jour : ?from=&to='],
    ['/stats/daily/:date', "Détail d'une journée"],
  ],
  hotels: [
    ['/hotels', 'Liste des hôtels : ?q= (nom, ville, code postal)'],
    ['/hotels/:id', 'Une fiche hôtel'],
  ],
  finance: [
    ['/finance/dashboard', 'Tableau de bord : facturé, encaissé, en retard…'],
    ['/finance/invoices', 'Factures et avoirs : ?status=draft,open,unpaid,partial,overdue,paid,credit_notes&clientId=&q=&from=&to=&sort=&dir=&limit=&offset='],
    ['/finance/invoices/:id', 'Une facture avec ses lignes et ses règlements'],
    ['/finance/payments', 'Encaissements : ?from=&to=&q='],
    ['/finance/stats/daily', 'Ventes jour par jour : ?from=&to='],
  ],
};

router.get('/', (req, res) => {
  res.json({
    readOnly: true,
    token: { label: req.claude.label, scopes: req.claude.scopes, expiresAt: req.claude.expiresAt },
    limits: { requestsPerMinute: access.RATE_PER_MIN },
    endpoints: Object.fromEntries(req.claude.scopes.map(s => [s, ENDPOINTS[s].map(([route, doc]) => ({ method: 'GET', route: `/api/claude/v1${route}`, doc }))])),
    notes: ['Les montants sont en centimes (…Cents).', "Aucune écriture n'est possible avec cet accès."],
  });
});

// ---------- exploitation ----------

const STATUSES = ['recue', 'traitement', 'prete', 'livree'];
const itemsStmt = db.prepare('SELECT service_id AS id, name, code, sage_code AS sageCode, qty, delivered_qty AS deliveredQty FROM order_items WHERE order_id = ? ORDER BY id');
// Ni téléphone ni prix : ce que l'atelier a besoin de savoir pour préparer et livrer.
const orderOut = (o) => ({
  id: o.id, ticket: o.ticket, status: o.status, productionStage: o.production_stage, deliverySequence: o.delivery_sequence,
  hotel: { id: o.client_id, name: o.societe, contact: o.contact, adresse: o.adresse },
  livraisonPrevue: o.livraison_prevue, notes: o.notes, createdAt: o.created_at, items: itemsStmt.all(o.id),
});
const ORDER_DATE = "COALESCE(o.livraison_prevue, substr(o.created_at, 1, 10))";

router.get('/orders', need('exploitation'), wrap((req, res) => {
  const where = []; const args = [];
  for (const [key, op] of [['from', '>='], ['to', '<=']]) {
    const raw = text(req.query[key], 10);
    if (!raw) continue;
    if (!isoOrNull(raw)) throw new engine.BillingError(`Date « ${key} » invalide (AAAA-MM-JJ).`);
    where.push(`${ORDER_DATE} ${op} ?`); args.push(raw);
  }
  const status = text(req.query.status, 12);
  if (status) {
    if (!STATUSES.includes(status)) throw new engine.BillingError('Statut inconnu.');
    where.push('o.status = ?'); args.push(status);
  }
  const clientId = parseInt(text(req.query.clientId, 10), 10);
  if (clientId > 0) { where.push('o.client_id = ?'); args.push(clientId); }
  const { limit, offset } = pageOf(req.query);
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM orders o ${cond}`).get(...args).n;
  const rows = db.prepare(`SELECT o.* FROM orders o ${cond} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  res.json({ orders: rows.map(orderOut), total, limit, offset });
}));

router.get('/orders/:id', need('exploitation'), wrap((req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!o) throw new engine.BillingError('Commande introuvable.', 404);
  res.json({ order: orderOut(o) });
}));

router.get('/stats', need('exploitation'), wrap((req, res) => {
  const q = req.query;
  const p = (q.from || q.to) ? dailyStats.period(text(q.from, 10), text(q.to, 10)) : null;
  res.json(statsRouter.overview(p));
}));
router.get('/stats/daily', need('exploitation'), wrap((req, res) => { res.json(dailyStats.daily(text(req.query.from, 10), text(req.query.to, 10))); }));
router.get('/stats/daily/:date', need('exploitation'), wrap((req, res) => { res.json(dailyStats.dayDetail(req.params.date)); }));

// ---------- hôtels ----------

// Volontairement absents : mot de passe / code d'accès, webhook (adresse et secret), jetons d'API, mandats et IBAN.
const HOTEL_COLS = `c.id, c.societe, c.contact, c.tel, c.email, c.adresse, c.code_postal AS codePostal, c.ville, c.siret,
  c.tva_number AS tvaNumber, c.adresse_facturation AS adresseFacturation, c.invoice_detail_level AS invoiceDetailLevel,
  c.escompte, c.client_type AS clientType, c.created_at AS createdAt`;
const HOTEL_STATS = `(SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id) AS ordersCount,
  (SELECT MAX(o.created_at) FROM orders o WHERE o.client_id = c.id) AS lastOrderAt`;

router.get('/hotels', need('hotels'), wrap((req, res) => {
  const q = text(req.query.q, 60).trim().toLowerCase();
  let rows = db.prepare(`SELECT ${HOTEL_COLS}, ${HOTEL_STATS} FROM clients c ORDER BY c.societe COLLATE NOCASE`).all();
  if (q) rows = rows.filter(r => `${r.societe} ${r.ville || ''} ${r.codePostal || ''}`.toLowerCase().includes(q));
  res.json({ hotels: rows, total: rows.length });
}));

router.get('/hotels/:id', need('hotels'), wrap((req, res) => {
  const r = db.prepare(`SELECT ${HOTEL_COLS}, ${HOTEL_STATS} FROM clients c WHERE c.id = ?`).get(Number(req.params.id));
  if (!r) throw new engine.BillingError('Hôtel introuvable.', 404);
  res.json({ hotel: r });
}));

// ---------- finance ----------

router.get('/finance/dashboard', need('finance'), wrap((req, res) => { res.json(queries.dashboard()); }));

router.get('/finance/invoices', need('finance'), wrap((req, res) => {
  const q = req.query;
  const KEYS = ['draft', 'open', 'unpaid', 'partial', 'overdue', 'paid', 'credit_notes'];
  const tab = ['all', ...KEYS].includes(text(q.tab, 14)) ? text(q.tab, 14) : 'all';
  const status = text(q.status, 120).split(',').map(x => x.trim()).filter(k => KEYS.includes(k));
  const { limit, offset } = pageOf(q);
  res.json(queries.listInvoices({
    tab, status, clientId: text(q.clientId, 10), q: text(q.q, 80),
    from: isoOrNull(text(q.from, 10)), to: isoOrNull(text(q.to, 10)),
    sort: text(q.sort, 20), dir: text(q.dir, 4), limit, offset,
  }));
}));

router.get('/finance/invoices/:id', need('finance'), wrap((req, res) => {
  const inv = engine.loadInvoice(Number(req.params.id));
  if (!inv) throw new engine.BillingError('Facture introuvable.', 404);
  const out = present(inv);
  const client = db.prepare('SELECT societe FROM clients WHERE id = ?').get(inv.client_id);
  out.buyerName = out.buyerName || (client && client.societe) || null;
  if (inv.status === 'issued' && inv.kind === 'invoice') {
    out.payments = db.prepare('SELECT id, paid_on AS paidOn, amount_cents AS amountCents, method, reference FROM native_payments WHERE invoice_id = ? ORDER BY paid_on, id').all(inv.id);
  }
  res.json({ invoice: out });
}));

router.get('/finance/payments', need('finance'), wrap((req, res) => {
  res.json(queries.listPayments({ from: isoOrNull(text(req.query.from, 10)), to: isoOrNull(text(req.query.to, 10)), q: text(req.query.q, 80) }));
}));

router.get('/finance/stats/daily', need('finance'), wrap((req, res) => { res.json(daily.daily(text(req.query.from, 10), text(req.query.to, 10))); }));

// Tout le reste : introuvable (jamais de repli vers l'application).
router.use((req, res) => res.status(404).json({ error: 'Route inconnue. La liste est à GET /api/claude/v1.' }));

module.exports = router;
module.exports.ENDPOINTS = ENDPOINTS;
