const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireClient } = require('../middleware/auth');
const { serializeOrder } = require('../utils/serializeOrder');
const crypto = require('crypto');
const guard = require('../utils/loginGuard');
const mailer = require('../utils/mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicClient(row) {
  if (!row) return null;
  const { id, email, societe, contact, tel, adresse, siret, tva_number, adresse_facturation, created_at } = row;
  return {
    id, email, societe, contact, tel, adresse, clientType: row.client_type || 'pro',
    siret, tvaNumber: tva_number, adresseFacturation: adresse_facturation,
    createdAt: created_at,
  };
}

// POST /api/clients/register
router.post('/register', (req, res) => {
  const { societe, contact, tel, adresse, email, code } = req.body || {};

  if (!societe || !contact || !tel || !adresse || !email) {
    return res.status(400).json({ error: 'Merci de remplir tous les champs.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (!/^\d{4,8}$/.test(code || '')) {
    return res.status(400).json({ error: "Le code d'accès doit contenir entre 4 et 8 chiffres." });
  }

  const existing = db.prepare('SELECT id FROM clients WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  const codeHash = bcrypt.hashSync(code, 10);
  const info = db.prepare(`
    INSERT INTO clients (email, societe, contact, tel, adresse, code_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email.toLowerCase(), societe, contact, tel, adresse, codeHash);

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid);
  req.session.clientId = client.id;
  res.status(201).json({ client: publicClient(client) });
});

// POST /api/clients/login
router.post('/login', (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ error: 'Merci de renseigner votre email et votre code.' });
  }
  // Essais limités par adresse e-mail saisie (existante ou non : la réponse ne révèle rien).
  const key = `login:${String(email).trim().toLowerCase()}`;
  const lock = guard.status(key);
  if (lock.locked) return res.status(429).json({ error: guard.message(lock.retryAfterSec) });
  const client = db.prepare('SELECT * FROM clients WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!client || !bcrypt.compareSync(String(code), client.code_hash)) {
    const after = guard.fail(key);
    if (after.locked) return res.status(429).json({ error: guard.message(after.retryAfterSec) });
    return res.status(401).json({ error: "Email ou code d'accès incorrect." });
  }
  guard.ok(key);
  req.session.clientId = client.id;
  res.json({ client: publicClient(client) });
});

// POST /api/clients/logout
router.post('/logout', (req, res) => {
  delete req.session.clientId;
  res.json({ ok: true });
});

// GET /api/clients/me
router.get('/me', (req, res) => {
  if (!req.session.clientId) return res.json({ client: null });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.clientId);
  if (!client) {
    delete req.session.clientId;
    return res.json({ client: null });
  }
  res.json({ client: publicClient(client) });
});

// PUT /api/clients/me/billing — le client renseigne lui-même ses
// informations légales/facturation (SIRET, TVA, adresse de facturation
// si différente de l'adresse de collecte). Tous les champs sont
// optionnels et peuvent être complétés progressivement.
router.put('/me/billing', requireClient, (req, res) => {
  const { siret, tvaNumber, adresseFacturation } = req.body || {};
  const cur = db.prepare('SELECT client_type FROM clients WHERE id = ?').get(req.session.clientId);
  const particulier = cur && cur.client_type === 'particulier'; // un particulier n'a ni SIRET ni n° de TVA
  if (!particulier && siret && !/^\d{14}$/.test(siret.replace(/\s/g, ''))) {
    return res.status(400).json({ error: 'Le SIRET doit comporter exactement 14 chiffres.' });
  }
  db.prepare('UPDATE clients SET siret = ?, tva_number = ?, adresse_facturation = ? WHERE id = ?')
    .run(!particulier && siret ? siret.replace(/\s/g, '') : null, !particulier && tvaNumber ? tvaNumber : null, adresseFacturation || null, req.session.clientId);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.clientId);
  res.json({ client: publicClient(client) });
});

// GET /api/clients/auth-options — ce que l'écran de connexion peut proposer : la réinitialisation
// du code par e-mail n'existe que si l'envoi d'e-mails et l'adresse publique du site sont configurés.
function publicBaseUrl() {
  return String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
}
router.get('/auth-options', (req, res) => {
  let contact = { phone: null, email: null };
  try { contact = db.prepare('SELECT phone, email FROM billing_settings WHERE id = 1').get() || contact; } catch { /* facturation non initialisée */ }
  res.json({ resetByEmail: mailer.isConfigured() && !!publicBaseUrl(), contact: { phone: contact.phone || null, email: contact.email || null } });
});

// PUT /api/clients/me/profile — l'hôtel tient lui-même ses coordonnées à jour. Le nom de
// l'établissement reste géré par Blanchisserie Cézanne (il figure sur les factures). Changer
// l'adresse e-mail (l'identifiant de connexion) exige le code d'accès actuel.
router.put('/me/profile', requireClient, (req, res) => {
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.clientId);
  const text = (k, label, max) => {
    const v = b[k] === undefined ? cur[k] : String(b[k] ?? '').trim();
    if (!v) throw Object.assign(new Error(`Merci de renseigner ${label}.`), { status: 400 });
    if (v.length > max) throw Object.assign(new Error(`${label[0].toUpperCase()}${label.slice(1)} est trop long.`), { status: 400 });
    return v;
  };
  try {
    const contact = text('contact', 'le nom du contact', 120);
    const tel = text('tel', 'un numéro de téléphone', 40);
    const adresse = text('adresse', "l'adresse", 300);
    let email = cur.email;
    if (b.email !== undefined && String(b.email).trim().toLowerCase() !== (cur.email || '')) {
      email = String(b.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw Object.assign(new Error('Adresse email invalide.'), { status: 400 });
      const key = `code:${cur.id}`;
      const lock = guard.status(key);
      if (lock.locked) throw Object.assign(new Error(guard.message(lock.retryAfterSec)), { status: 429 });
      if (!b.currentCode || !bcrypt.compareSync(String(b.currentCode), cur.code_hash)) {
        const after = guard.fail(key);
        throw Object.assign(new Error(after.locked ? guard.message(after.retryAfterSec) : 'Pour changer votre adresse e-mail, saisissez votre code d\'accès actuel.'), { status: after.locked ? 429 : 403 });
      }
      guard.ok(key);
      if (db.prepare('SELECT id FROM clients WHERE email = ? AND id != ?').get(email, cur.id)) {
        throw Object.assign(new Error('Cet email est déjà utilisé par un autre compte.'), { status: 409 });
      }
    }
    const changed = [['contact', contact], ['tel', tel], ['adresse', adresse], ['email', email]].filter(([k, v]) => (cur[k] || '') !== v).map(([k]) => k);
    db.prepare('UPDATE clients SET contact = ?, tel = ?, adresse = ?, email = ? WHERE id = ?').run(contact, tel, adresse, email, cur.id);
    if (changed.length) require('../billing/engine').logEvent('client_self_updated', null, { clientId: cur.id, client: cur.societe, fields: changed });
    res.json({ client: publicClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(cur.id)) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

// PUT /api/clients/me/code — changer son code d'accès (l'ancien est exigé).
router.put('/me/code', requireClient, (req, res) => {
  const { currentCode, newCode } = req.body || {};
  const key = `code:${req.session.clientId}`;
  const lock = guard.status(key);
  if (lock.locked) return res.status(429).json({ error: guard.message(lock.retryAfterSec) });
  const cur = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.clientId);
  if (!currentCode || !bcrypt.compareSync(String(currentCode), cur.code_hash)) {
    const after = guard.fail(key);
    return res.status(after.locked ? 429 : 403).json({ error: after.locked ? guard.message(after.retryAfterSec) : "Le code d'accès actuel est incorrect." });
  }
  if (!/^\d{4,8}$/.test(String(newCode || ''))) return res.status(400).json({ error: "Le nouveau code doit contenir entre 4 et 8 chiffres." });
  guard.ok(key);
  db.prepare('UPDATE clients SET code_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newCode), 10), cur.id);
  db.prepare("UPDATE client_reset_tokens SET used_at = datetime('now') WHERE client_id = ? AND used_at IS NULL").run(cur.id);
  require('../billing/engine').logEvent('client_code_changed', null, { clientId: cur.id, client: cur.societe, by: 'client' });
  res.json({ ok: true });
});

// POST /api/clients/forgot-code — envoie un lien (valable 1 h, à usage unique) pour choisir un nouveau code.
// La réponse est la même que l'adresse soit connue ou non : on ne révèle pas quels comptes existent.
const RESET_TTL_MIN = 60;
router.post('/forgot-code', async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Adresse email invalide.' });
  const base = publicBaseUrl();
  if (!mailer.isConfigured() || !base) {
    return res.status(503).json({ error: "La réinitialisation par e-mail n'est pas disponible pour le moment. Contactez Blanchisserie Cézanne : nous vous attribuerons un nouveau code." });
  }
  const generic = { ok: true, message: "Si un compte existe avec cette adresse, un e-mail vient de lui être envoyé (valable une heure)." };
  // Au plus 5 demandes par quart d'heure et par adresse ; au-delà, on répond pareil sans rien envoyer.
  const key = `forgot:${email}`;
  const tooMany = guard.status(key).locked;
  guard.fail(key); // chaque demande compte ; 5 demandes → blocage 15 min
  const client = tooMany ? null : db.prepare('SELECT id, societe, email FROM clients WHERE email = ?').get(email);
  if (client) {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare("INSERT INTO client_reset_tokens (client_id, token_hash, expires_at) VALUES (?, ?, datetime('now', ?))").run(client.id, hash, `+${RESET_TTL_MIN} minutes`);
    const link = `${base}/#reset=${token}`;
    try {
      await mailer.sendMail({
        to: client.email,
        subject: 'Votre nouveau code d\'accès — Blanchisserie Cézanne',
        text: `Bonjour,\n\nVous avez demandé à choisir un nouveau code d'accès pour l'espace client de ${client.societe}.\n\nCliquez sur ce lien (valable ${RESET_TTL_MIN} minutes, utilisable une seule fois) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez simplement ce message : votre code actuel reste valable.\n\nBlanchisserie Cézanne`,
      });
    } catch (e) {
      console.error('[clients] e-mail de réinitialisation non envoyé :', e.message);
    }
  }
  res.json(generic);
});

// POST /api/clients/reset-code — choisit le nouveau code avec le jeton reçu par e-mail.
router.post('/reset-code', (req, res) => {
  const { token, code } = req.body || {};
  if (!/^\d{4,8}$/.test(String(code || ''))) return res.status(400).json({ error: "Le code d'accès doit contenir entre 4 et 8 chiffres." });
  const hash = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const row = db.prepare("SELECT t.id, t.client_id, c.societe FROM client_reset_tokens t JOIN clients c ON c.id = t.client_id WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > datetime('now')").get(hash);
  if (!row) return res.status(400).json({ error: "Ce lien n'est plus valable. Demandez-en un nouveau depuis « Code oublié ? »." });
  db.transaction(() => {
    db.prepare('UPDATE clients SET code_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(code), 10), row.client_id);
    db.prepare("UPDATE client_reset_tokens SET used_at = datetime('now') WHERE client_id = ? AND used_at IS NULL").run(row.client_id);
  })();
  guard.ok(`login:${db.prepare('SELECT email FROM clients WHERE id = ?').get(row.client_id).email}`);
  require('../billing/engine').logEvent('client_code_changed', null, { clientId: row.client_id, client: row.societe, by: 'e-mail' });
  res.json({ ok: true });
});

// GET /api/clients/orders — historique du client connecté
router.get('/orders', requireClient, (req, res) => {
  const orders = db.prepare(`
    SELECT * FROM orders WHERE client_id = ? ORDER BY created_at DESC
  `).all(req.session.clientId);

  const itemsStmt = db.prepare('SELECT service_id as id, name, code, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?');
  const serialized = orders.map(o => serializeOrder(o, itemsStmt.all(o.id)));
  res.json({ orders: serialized });
});

// GET /api/clients/invoices — factures du client connecté. Pour la facturation intégrée : statut,
// échéance, montant TTC, reste à payer et, tant qu'elle est ouverte, l'offre d'escompte pour
// règlement anticipé. Les factures du circuit Odoo (anciennes) n'ont que ce dont on dispose.
router.get('/invoices', requireClient, (req, res) => {
  const engine = require('../billing/engine');
  const legacy = db.prepare(`
    SELECT id, odoo_number as odooNumber, total_ht as totalHt,
           period_start as periodStart, period_end as periodEnd, created_at as createdAt
    FROM invoices
    WHERE client_id = ? AND pdf_path IS NOT NULL
    ORDER BY period_start DESC
  `).all(req.session.clientId).map(i => ({ ...i, legacy: true, status: null }));

  // Uniquement les documents ÉMIS (un brouillon n'existe pas pour le client).
  const today = engine.todayParis();
  const sums = { dueCents: 0, overdueCents: 0, openCount: 0 };
  const native = db.prepare("SELECT id FROM native_invoices WHERE client_id = ? AND status = 'issued'").all(req.session.clientId).map(({ id }) => {
    const inv = engine.loadInvoice(id);
    const isCn = inv.kind === 'credit_note';
    const sign = isCn ? -1 : 1;
    const balance = isCn ? 0 : engine.balanceCents(inv);
    const esc = isCn ? null : engine.escompteStatus(inv, today);
    if (balance > 0) {
      sums.dueCents += balance; sums.openCount += 1;
      if (inv.due_date && inv.due_date < today) sums.overdueCents += balance;
    }
    return {
      id: `n${inv.id}`, legacy: false,
      odooNumber: inv.number, number: inv.number, kind: inv.kind,
      status: isCn ? 'credit_note' : engine.paymentStatus(inv),
      totalHt: sign * inv.total_ht_cents / 100, totalTtcCents: sign * inv.total_ttc_cents,
      periodStart: inv.period_start || inv.issue_date, periodEnd: inv.period_end || inv.issue_date,
      createdAt: inv.issue_date, issueDate: inv.issue_date, dueDate: inv.due_date,
      balanceCents: balance,
      overdueDays: !isCn && balance > 0 && inv.due_date && inv.due_date < today ? Math.round((Date.parse(today) - Date.parse(inv.due_date)) / 86400000) : 0,
      grantedDiscountCents: isCn ? 0 : engine.discountSums(inv.id).ttcCents,
      escompte: esc && esc.open && esc.discountCents > 0 && balance > 0
        ? { ratePct: esc.ratePct, deadline: esc.deadline, discountCents: esc.discountCents, netCents: esc.netCents } : null,
      pdfUrl: `/api/clients/native-invoices/${inv.id}/pdf`,
    };
  });

  const all = [...legacy, ...native].sort((a, b) => String(b.issueDate || b.periodStart || '').localeCompare(String(a.issueDate || a.periodStart || '')) || String(b.number || '').localeCompare(String(a.number || '')));
  // Coordonnées de virement : déjà imprimées sur chaque facture, on les rappelle tant qu'il y a quelque chose à payer.
  let payment = null;
  if (sums.dueCents > 0) {
    const st = engine.getSettings();
    if (st.iban) payment = { holder: st.legal_name || 'Blanchisserie Cézanne', iban: st.iban, bic: st.bic || null };
  }
  res.json({ invoices: all, summary: sums, payment });
});

// GET /api/clients/native-invoices/:id/pdf — PDF d'une facture/avoir ÉMIS de
// la facturation intégrée, après vérification stricte de l'appartenance au
// client connecté.
router.get('/native-invoices/:id/pdf', requireClient, async (req, res) => {
  const engine = require('../billing/engine');
  const { buildInvoicePdf } = require('../billing/pdf');
  const inv = engine.loadInvoice(Number(req.params.id));
  if (!inv || inv.client_id !== req.session.clientId || inv.status !== 'issued') {
    return res.status(404).json({ error: 'Facture introuvable.' });
  }
  const extra = {};
  if (inv.credits_invoice_id) extra.creditedInvoiceNumber = db.prepare('SELECT number FROM native_invoices WHERE id = ?').get(inv.credits_invoice_id)?.number;
  if (inv.kind === 'invoice') {
    // Même présentation que dans l'espace de facturation : argent reçu et escompte accordé séparés.
    extra.paidCents = engine.cashCents(inv.id);
    extra.discountCents = engine.discountSums(inv.id).ttcCents;
    extra.balanceCents = engine.balanceCents(inv);
  }
  try {
    const pdf = await buildInvoicePdf(inv, null, extra);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.number}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[billing] PDF client', err);
    res.status(500).json({ error: 'Erreur lors de la génération du PDF.' });
  }
});

// GET /api/clients/invoices/:id/pdf — télécharge le PDF d'UNE facture,
// après vérification stricte qu'elle appartient bien au client connecté
// (jamais l'id seul : un client ne doit jamais pouvoir deviner l'id d'une
// facture d'un autre hôtel pour la consulter).
router.get('/invoices/:id/pdf', requireClient, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.session.clientId);
  if (!invoice || !invoice.pdf_path) return res.status(404).json({ error: 'Facture introuvable.' });
  if (!fs.existsSync(invoice.pdf_path)) return res.status(404).json({ error: 'Fichier PDF introuvable sur le serveur.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(invoice.pdf_path)}"`);
  fs.createReadStream(invoice.pdf_path).pipe(res);
});

// ---------- questionnaire de satisfaction (NPS) ----------

// GET /api/clients/nps/status — indique si le client connecté a déjà
// répondu ce mois-ci civil, pour savoir s'il faut lui proposer le
// questionnaire (au plus une fois par mois, pas à chaque connexion).
router.get('/nps/status', requireClient, (req, res) => {
  const row = db.prepare(`
    SELECT 1 FROM nps_responses
    WHERE client_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    LIMIT 1
  `).get(req.session.clientId);
  res.json({ alreadyResponded: !!row });
});

// POST /api/clients/nps — enregistre la réponse du mois. N'empêche pas
// une deuxième soumission côté serveur (l'interface ne la propose plus
// une fois répondu, mais mieux vaut ne pas bloquer si jamais) — le calcul
// admin utilisera de toute façon la plus récente par mois et par client.
router.post('/nps', requireClient, (req, res) => {
  const { score, comment } = req.body || {};
  const scoreNum = parseInt(score, 10);
  if (!Number.isInteger(scoreNum) || scoreNum < 0 || scoreNum > 10) {
    return res.status(400).json({ error: 'Note invalide (0 à 10 attendu).' });
  }
  db.prepare('INSERT INTO nps_responses (client_id, score, comment) VALUES (?, ?, ?)')
    .run(req.session.clientId, scoreNum, (comment || '').trim() || null);
  res.status(201).json({ ok: true });
});

module.exports = router;
