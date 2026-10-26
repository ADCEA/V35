const path = require('path');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { buildDeliveryNoteText, buildDeliveryNoteHtml } = require('../utils/deliveryNote');
const { buildDeliveryNotePdf, buildInvoiceAnnexPdf, buildInvoiceSummaryPdf } = require('../utils/pdf');
const { sendMail, isConfigured } = require('../utils/mailer');
const { serializeOrder } = require('../utils/serializeOrder');
const { getServicesById, getServicesForClient, getServicesByIdForClient } = require('../services');
const { isOdooConfigured, findOrCreateOdooPartner, findOrCreateOdooProduct, findOrCreateGenericServiceProduct, listSaleTaxes, createDraftInvoice, fetchInvoicePdfFromOdoo } = require('../utils/odoo');
const { checkAndReleaseIfNeeded } = require('../utils/invoiceStatusSync');
const { buildInvoiceLines, aggregateByArticle } = require('../utils/invoiceBuilder');
const { mergePdfs } = require('../utils/pdfMerge');
const { sendWhatsAppNotification } = require('../utils/whatsapp');
const { notifyOrderDelivered } = require('../utils/webhookNotify');

const mail = require('../billing/mail');
const router = express.Router();

const STATUSES = ['recue', 'traitement', 'prete', 'livree'];

const itemsStmt = db.prepare('SELECT service_id as id, name, code, sage_code as sageCode, price, qty, delivered_qty as deliveredQty FROM order_items WHERE order_id = ?');
function getItems(orderId) { return itemsStmt.all(orderId); }

function getAdminRow() {
  return db.prepare('SELECT * FROM admin WHERE id = 1').get();
}

// GET /api/admin/status — l'admin existe-t-il déjà ? la session en cours est-elle déverrouillée ?
router.get('/status', (req, res) => {
  const admin = getAdminRow();
  res.json({ exists: Boolean(admin), unlocked: Boolean(req.session.isAdmin) });
});

// POST /api/admin/setup — définit le mot de passe la toute première fois
router.post('/setup', (req, res) => {
  if (getAdminRow()) {
    return res.status(409).json({ error: 'Un mot de passe administrateur existe déjà.' });
  }
  const { password } = req.body || {};
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO admin (id, password_hash, delivery_email) VALUES (1, ?, NULL)').run(hash);
  req.session.isAdmin = true;
  res.status(201).json({ ok: true });
});

// POST /api/admin/login
router.post('/login', (req, res) => {
  const admin = getAdminRow();
  if (!admin) return res.status(409).json({ error: "Aucun mot de passe défini. Passez d'abord par la configuration." });
  const { password } = req.body || {};
  if (!password || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

// POST /api/admin/logout
router.post('/logout', (req, res) => {
  delete req.session.isAdmin;
  delete req.session.billing; // le déverrouillage de la Facturation ne survit pas à la déconnexion
  res.json({ ok: true });
});

// Tout ce qui suit nécessite une session admin déverrouillée
router.use(requireAdmin);

// GET /api/admin/clients — liste des hôtels pour les sélecteurs de la production (nouvelle commande,
// commandes automatiques…). Volontairement limitée aux coordonnées d'exploitation : SIRET, TVA,
// adresse de facturation, tarifs, jetons et webhook ne se consultent que dans la Facturation protégée.
router.get('/clients', (req, res) => {
  const rows = db.prepare(`
    SELECT id, email, societe, contact, tel, adresse, code_postal as codePostal, ville, created_at as createdAt
    FROM clients ORDER BY societe COLLATE NOCASE
  `).all();
  res.json({ clients: rows });
});

// POST /api/admin/clients — créer un compte hôtel manuellement (sans
// passer par l'auto-inscription publique) — utile pour préparer un accès
// avant même que l'hôtel s'en serve, en lui communiquant le code choisi.
router.post('/clients', (req, res) => {
  const { societe, contact, tel, adresse, codePostal, ville, code } = req.body || {};
  // Seul le nom est obligatoire : le reste se complète ensuite dans Facturation → Hôtels
  // (création rapide depuis « Nouvelle commande »).
  if (!societe || !societe.trim()) {
    return res.status(400).json({ error: 'Merci de renseigner le nom du client.' });
  }
  const email = (req.body?.email || '').trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (code && !/^\d{4,8}$/.test(code)) {
    return res.status(400).json({ error: "Le code d'accès doit contenir entre 4 et 8 chiffres." });
  }
  if (email) {
    const existing = db.prepare('SELECT id FROM clients WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  // Sans code choisi, on enregistre l'empreinte d'un secret aléatoire jamais
  // communiqué : l'espace client reste fermé tant qu'un code n'est pas défini.
  const codeHash = bcrypt.hashSync(code || crypto.randomBytes(24).toString('hex'), 10);
  const info = db.prepare(`
    INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(email, societe.trim(), (contact || '').trim(), (tel || '').trim(), (adresse || '').trim(), codePostal?.trim() || null, ville?.trim() || null, codeHash);

  const row = db.prepare('SELECT id, email, societe, contact, tel, adresse, code_postal as codePostal, ville, created_at as createdAt FROM clients WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ client: row });
});

// Gestion complète des hôtels (fiche, facturation, tarifs, jetons d'API, webhook, import) :
// déplacée dans la partie protégée — voir routes/billingCatalog.js (/api/admin/billing/catalog/*).

// ---------- intégration Odoo ----------

// POST /api/admin/clients/:id/odoo-sync — crée (ou retrouve) le
// res.partner Odoo correspondant à cet hôtel, et enregistre la
// correspondance. Opération volontairement sûre et réversible (contraire
// à la création d'une facture) — sert de test concret pour valider que
// la connexion et le format d'appel fonctionnent avant d'aller plus loin.
router.post('/clients/:id/odoo-sync', async (req, res) => {
  const clientId = Number(req.params.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Hôtel introuvable.' });
  if (!isOdooConfigured()) {
    return res.status(400).json({ error: "Odoo n'est pas configuré (variables ODOO_URL / ODOO_API_KEY absentes sur le serveur)." });
  }

  try {
    const odooPartnerId = await findOrCreateOdooPartner(client);
    db.prepare('UPDATE clients SET odoo_partner_id = ? WHERE id = ?').run(odooPartnerId, clientId);
    res.json({ ok: true, odooPartnerId });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/admin/clients/:id/invoiceable-orders — commandes livrées de cet
// hôtel qui ne sont incluses dans AUCUNE facture existante (voir la
// contrainte UNIQUE sur invoice_orders.order_id, garante qu'une commande
// n'est jamais facturée deux fois).
router.get('/clients/:id/invoiceable-orders', (req, res) => {
  const clientId = Number(req.params.id);
  const orders = db.prepare(`
    SELECT o.id, o.ticket, o.livraison_prevue as livraisonPrevue, o.created_at as createdAt
    FROM orders o
    WHERE o.client_id = ? AND o.status = 'livree'
      AND o.id NOT IN (SELECT order_id FROM invoice_orders)
      AND o.id NOT IN (
        -- BL déjà pris par une facture de la facturation intégrée (sauf si
        -- cette facture a été intégralement annulée par un avoir émis).
        SELECT no.order_id FROM native_invoice_orders no
        JOIN native_invoices ni ON ni.id = no.invoice_id
        WHERE ni.kind = 'invoice'
          AND NOT EXISTS (SELECT 1 FROM native_invoices cn WHERE cn.credits_invoice_id = ni.id AND cn.status = 'issued' AND cn.is_full_credit = 1)
      )
    ORDER BY o.livraison_prevue ASC, o.created_at ASC
  `).all(clientId);
  res.json({ orders });
});

// GET /api/admin/clients/:id/invoices — factures déjà générées pour cet
// hôtel (historique de suivi local).
router.get('/clients/:id/invoices', (req, res) => {
  const invoices = db.prepare(`
    SELECT id, odoo_move_id as odooMoveId, odoo_number as odooNumber, status, total_ht as totalHt,
           period_start as periodStart, period_end as periodEnd, pdf_path as pdfPath, created_at as createdAt
    FROM invoices WHERE client_id = ? ORDER BY created_at DESC
  `).all(Number(req.params.id));
  res.json({ invoices });
});

// POST /api/admin/invoices/:id/retrieve-pdf — va chercher le PDF de la
// facture VALIDÉE dans Odoo (échoue proprement si elle est encore en
// brouillon), génère l'annexe BL par BL, fusionne les deux, et sauvegarde
// le résultat sur le disque persistant.
router.post('/invoices/:id/retrieve-pdf', async (req, res) => {
  const invoiceId = Number(req.params.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Facture introuvable.' });
  if (!isOdooConfigured()) {
    return res.status(400).json({ error: "Odoo n'est pas configuré (variables ODOO_URL / ODOO_API_KEY absentes sur le serveur)." });
  }

  try {
    const { pdfBuffer, reason, state } = await fetchInvoicePdfFromOdoo(invoice.odoo_move_id);
    if (!pdfBuffer) {
      const messages = {
        not_posted: `Facture encore en statut "${state}" dans Odoo — validez-la là-bas avant de pouvoir récupérer son PDF.`,
        no_attachment_yet: 'Facture validée, mais Odoo ne génère le PDF qu\'après un premier clic sur "Imprimer" (ou "Aperçu") sur la facture, directement dans Odoo — la validation seule ne suffit pas. Faites-le une fois là-bas, puis réessayez ici.',
        attachment_empty: 'La pièce jointe existe mais semble vide côté Odoo — à vérifier directement là-bas.',
      };
      return res.status(400).json({ error: messages[reason] || 'PDF indisponible pour le moment.' });
    }

    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(invoice.client_id);
    const orderIds = db.prepare('SELECT order_id FROM invoice_orders WHERE invoice_id = ?').all(invoiceId).map(r => r.order_id);
    const itemsStmtLocal = db.prepare('SELECT name, sage_code as sageCode, qty, delivered_qty as deliveredQty, price FROM order_items WHERE order_id = ?');
    const orders = orderIds.map(oid => {
      const o = db.prepare('SELECT ticket, livraison_prevue FROM orders WHERE id = ?').get(oid);
      return { ticket: o.ticket, livraisonPrevue: o.livraison_prevue, items: itemsStmtLocal.all(oid) };
    });

    const invoiceRef = invoice.odoo_number || `Facture #${invoice.odoo_move_id}`;
    const aggregated = aggregateByArticle(orders);
    const summaryBuffer = await buildInvoiceSummaryPdf(invoiceRef, client.societe, invoice.period_start, invoice.period_end, orders.length, aggregated);
    const annexBuffer = await buildInvoiceAnnexPdf(invoiceRef, client.societe, orders);
    const mergedBuffer = await mergePdfs([summaryBuffer, pdfBuffer, annexBuffer]);

    const invoicesDir = path.join(db.DATA_DIR, 'invoices');
    if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir, { recursive: true });
    const fileName = `facture-${invoiceId}-${(invoice.odoo_number || invoice.odoo_move_id).toString().replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const filePath = path.join(invoicesDir, fileName);
    fs.writeFileSync(filePath, mergedBuffer);

    db.prepare('UPDATE invoices SET status = ?, pdf_path = ?, updated_at = ? WHERE id = ?')
      .run('pdf_retrieved', filePath, new Date().toISOString(), invoiceId);

    res.json({ ok: true, pdfPath: filePath });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/admin/invoices/:id/pdf — télécharge le PDF fusionné déjà
// récupéré (voir la route ci-dessus pour le générer d'abord).
router.get('/invoices/:id/pdf', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(req.params.id));
  if (!invoice || !invoice.pdf_path) return res.status(404).json({ error: 'PDF pas encore récupéré pour cette facture.' });
  if (!fs.existsSync(invoice.pdf_path)) return res.status(404).json({ error: 'Fichier PDF introuvable sur le serveur (a-t-il été supprimé ?).' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(invoice.pdf_path)}"`);
  fs.createReadStream(invoice.pdf_path).pipe(res);
});

// POST /api/admin/invoices/:id/sync-status — vérifie le statut ACTUEL de
// la facture dans Odoo. Si elle y a été annulée (state='cancel'), les BL
// qui lui étaient rattachés sont LIBÉRÉS (retirés de invoice_orders) pour
// redevenir facturables — sans quoi ils resteraient bloqués pour
// toujours, considérés comme "déjà facturés" alors que la facture
// correspondante n'existe plus vraiment.
router.post('/invoices/:id/sync-status', async (req, res) => {
  const invoiceId = Number(req.params.id);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Facture introuvable.' });
  if (!isOdooConfigured()) {
    return res.status(400).json({ error: "Odoo n'est pas configuré (variables ODOO_URL / ODOO_API_KEY absentes sur le serveur)." });
  }
  if (!invoice.odoo_move_id) {
    return res.status(400).json({ error: 'Aucune facture Odoo associée à vérifier.' });
  }

  try {
    const { released, odooState } = await checkAndReleaseIfNeeded(invoice);
    res.json({ ok: true, odooState, localStatus: released ? 'cancelled' : invoice.status, released });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/admin/clients/:id/invoices — génère une facture BROUILLON
// dans Odoo à partir d'un ensemble de BL (commandes livrées) choisis.
// Ne valide/ne poste JAMAIS automatiquement — la facture reste modifiable
// et supprimable dans Odoo tant qu'elle n'y est pas confirmée à la main.
router.post('/clients/:id/invoices', async (req, res) => {
  // Le circuit Odoo est retiré : toute la facturation passe par la facturation intégrée
  // (Administration → Plus → Facturation). Le code ci-dessous est conservé, inactif,
  // pour pouvoir le réactiver si besoin.
  return res.status(410).json({ error: "La génération de factures via Odoo est désactivée. Utilisez Administration → Plus → Facturation." });
  const clientId = Number(req.params.id);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Hôtel introuvable.' });
  if (!isOdooConfigured()) {
    return res.status(400).json({ error: "Odoo n'est pas configuré (variables ODOO_URL / ODOO_API_KEY absentes sur le serveur)." });
  }

  const { orderIds } = req.body || {};
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: 'Sélectionnez au moins une commande.' });
  }

  const placeholders = orderIds.map(() => '?').join(',');
  const orders = db.prepare(`SELECT * FROM orders WHERE id IN (${placeholders})`).all(...orderIds);
  if (orders.length !== orderIds.length) {
    return res.status(400).json({ error: 'Une ou plusieurs commandes sont introuvables.' });
  }
  for (const o of orders) {
    if (o.client_id !== clientId) return res.status(400).json({ error: `La commande ${o.ticket} n'appartient pas à cet hôtel.` });
    if (o.status !== 'livree') return res.status(400).json({ error: `La commande ${o.ticket} n'est pas encore livrée.` });
  }
  const alreadyNative = db.prepare(`
    SELECT DISTINCT no.order_id FROM native_invoice_orders no
    JOIN native_invoices ni ON ni.id = no.invoice_id
    WHERE no.order_id IN (${placeholders}) AND ni.kind = 'invoice'
      AND NOT EXISTS (SELECT 1 FROM native_invoices cn WHERE cn.credits_invoice_id = ni.id AND cn.status = 'issued' AND cn.is_full_credit = 1)
  `).all(...orderIds);
  if (alreadyNative.length > 0) {
    const ids = alreadyNative.map(r => r.order_id);
    return res.status(400).json({ error: `Déjà inclus dans une facture de la facturation intégrée, à décocher : ${orders.filter(o => ids.includes(o.id)).map(o => o.ticket).join(', ')}.` });
  }
  const alreadyInvoiced = db.prepare(`SELECT order_id FROM invoice_orders WHERE order_id IN (${placeholders})`).all(...orderIds);
  if (alreadyInvoiced.length > 0) {
    const invoicedIds = alreadyInvoiced.map(r => r.order_id);
    const invoicedTickets = orders.filter(o => invoicedIds.includes(o.id)).map(o => o.ticket);
    return res.status(400).json({ error: `Déjà inclus dans une autre facture, à décocher : ${invoicedTickets.join(', ')}.` });
  }

  try {
    // 1. Client synchronisé côté Odoo (crée si besoin).
    let odooPartnerId = client.odoo_partner_id;
    if (!odooPartnerId) {
      odooPartnerId = await findOrCreateOdooPartner(client);
      db.prepare('UPDATE clients SET odoo_partner_id = ? WHERE id = ?').run(odooPartnerId, clientId);
    }

    // 2. Charge le détail articles de chaque commande sélectionnée.
    const itemsStmtLocal = db.prepare('SELECT service_id, name, sage_code as sageCode, qty, delivered_qty as deliveredQty, price FROM order_items WHERE order_id = ?');
    const ordersWithItems = orders.map(o => ({ ...o, livraisonPrevue: o.livraison_prevue, items: itemsStmtLocal.all(o.id) }));

    // 3. Synchronise chaque article DISTINCT référencé (une seule fois par
    // référence, même répétée sur plusieurs BL), en réutilisant le cache
    // odoo_product_id déjà connu quand il existe.
    const distinctArticleIds = [...new Set(ordersWithItems.flatMap(o => o.items.map(it => it.service_id)))];
    const productIdByArticle = {};
    for (const articleId of distinctArticleIds) {
      const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      if (!article) continue;
      let odooProductId = article.odoo_product_id;
      if (!odooProductId) {
        odooProductId = await findOrCreateOdooProduct({ name: article.name, sageCode: article.sage_code });
        db.prepare('UPDATE articles SET odoo_product_id = ? WHERE id = ?').run(odooProductId, articleId);
      }
      productIdByArticle[articleId] = odooProductId;
    }
    for (const o of ordersWithItems) {
      for (const it of o.items) it.odooProductId = productIdByArticle[it.service_id] || null;
    }

    // 4. Produit générique, seulement nécessaire pour le niveau "per_bl".
    let genericProductId = null;
    if (client.invoice_detail_level === 'per_bl') {
      genericProductId = await findOrCreateGenericServiceProduct();
    }

    // 5. Construit les lignes selon le niveau choisi pour cet hôtel.
    const lines = buildInvoiceLines(ordersWithItems, client.invoice_detail_level, genericProductId);
    if (lines.filter(l => !l.isSection).length === 0) {
      return res.status(400).json({ error: 'Aucune ligne facturable (quantités livrées nulles sur les commandes sélectionnées ?).' });
    }

    // 6. Crée la facture BROUILLON dans Odoo.
    const adminRow = db.prepare('SELECT odoo_tax_id as taxId FROM admin WHERE id = 1').get();
    const tickets = orders.map(o => o.ticket).join(', ');
    const dates = orders.map(o => o.livraison_prevue).filter(Boolean).sort();
    const invoiceDate = new Date().toISOString().slice(0, 10);

    const { odooMoveId, totalHt, odooNumber } = await createDraftInvoice({
      partnerId: odooPartnerId,
      taxId: adminRow?.taxId || null,
      ref: `BL ${tickets}`,
      invoiceDate,
      lines,
    });

    // 7. Enregistre le suivi local — transaction : soit tout, soit rien.
    const recordInvoice = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO invoices (client_id, odoo_move_id, period_start, period_end, status, odoo_number, total_ht)
        VALUES (?, ?, ?, ?, 'draft_created', ?, ?)
      `).run(clientId, odooMoveId, dates[0] || invoiceDate, dates[dates.length - 1] || invoiceDate, odooNumber, totalHt);
      const invoiceId = info.lastInsertRowid;
      const linkOrder = db.prepare('INSERT INTO invoice_orders (invoice_id, order_id) VALUES (?, ?)');
      for (const o of orders) linkOrder.run(invoiceId, o.id);
      return invoiceId;
    });
    const invoiceId = recordInvoice();

    res.status(201).json({ invoiceId, odooMoveId, odooNumber, totalHt, ordersCount: orders.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/admin/odoo/taxes — liste les taxes de vente disponibles côté
// Odoo, pour choisir laquelle appliquer sans avoir à en chercher l'id
// manuellement dans l'interface Odoo.
router.get('/odoo/taxes', async (req, res) => {
  if (!isOdooConfigured()) {
    return res.status(400).json({ error: "Odoo n'est pas configuré (variables ODOO_URL / ODOO_API_KEY absentes sur le serveur)." });
  }
  try {
    const taxes = await listSaleTaxes();
    res.json({ taxes });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/admin/odoo/settings — réglages de facturation Odoo actuels.
router.get('/odoo/settings', (req, res) => {
  const row = db.prepare('SELECT odoo_tax_id as odooTaxId, odoo_journal_id as odooJournalId FROM admin WHERE id = 1').get();
  res.json(row || { odooTaxId: null, odooJournalId: null });
});

// PUT /api/admin/odoo/settings — enregistre la taxe (et éventuellement le
// journal) à utiliser sur chaque ligne de facture générée.
router.put('/odoo/settings', (req, res) => {
  const { odooTaxId, odooJournalId } = req.body || {};
  db.prepare('UPDATE admin SET odoo_tax_id = ?, odoo_journal_id = ? WHERE id = 1')
    .run(odooTaxId || null, odooJournalId || null);
  res.json({ ok: true });
});

// GET /api/admin/orders/:id/extra — hôtels supplémentaires + commentaires
// d'une commande, chargés à la demande (pas à chaque liste de commandes).
router.get('/orders/:id/extra', (req, res) => {
  const orderId = Number(req.params.id);
  const extraClients = db.prepare(`
    SELECT c.id, c.societe FROM order_extra_clients oec
    JOIN clients c ON c.id = oec.client_id
    WHERE oec.order_id = ? ORDER BY c.societe
  `).all(orderId);
  const comments = db.prepare(`
    SELECT id, author, text, created_at as createdAt FROM order_comments
    WHERE order_id = ? ORDER BY created_at ASC
  `).all(orderId);
  res.json({ extraClients, comments });
});

// PUT /api/admin/orders/:id/extra-clients — définit la liste complète des
// hôtels supplémentaires associés (remplace, ne cumule pas).
router.put('/orders/:id/extra-clients', (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });

  const { clientIds } = req.body || {};
  if (!Array.isArray(clientIds)) return res.status(400).json({ error: 'clientIds doit être une liste.' });

  const setExtra = db.transaction(() => {
    db.prepare('DELETE FROM order_extra_clients WHERE order_id = ?').run(orderId);
    const insert = db.prepare('INSERT OR IGNORE INTO order_extra_clients (order_id, client_id) VALUES (?, ?)');
    for (const cid of clientIds) insert.run(orderId, Number(cid));
  });
  setExtra();
  res.json({ ok: true });
});

// POST /api/admin/orders/:id/comments — ajoute un message au fil de
// discussion de la commande (l'équipe de production peut se laisser des
// notes, chacune horodatée).
router.post('/orders/:id/comments', (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });

  const { author, text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Le message ne peut pas être vide.' });

  const info = db.prepare('INSERT INTO order_comments (order_id, author, text) VALUES (?, ?, ?)')
    .run(orderId, (author || '').trim() || null, text.trim());
  const comment = db.prepare('SELECT id, author, text, created_at as createdAt FROM order_comments WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ comment });
});

function nextTicket(now) {
  const row = db.prepare('SELECT value FROM order_seq WHERE id = 1').get();
  const seq = row.value + 1;
  db.prepare('UPDATE order_seq SET value = ? WHERE id = 1').run(seq);
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `CZ-${yy}${mm}${dd}-${String(seq).padStart(4, '0')}`;
}

const PRODUCTION_STAGES = ['tri', 'lavage', 'sechage', 'repassage', 'pliage', 'en_stock'];

// POST /api/admin/orders/manual — création manuelle par l'admin, depuis
// l'onglet "Préparation de commande" (statut "recue" par défaut) ou
// "Production" (statut "traitement" avec une étape de départ).
// body: { clientId, items:[{id,qty}],
//         livraisonPrevue?, notes?, status?, productionStage? }
router.post('/orders/manual', (req, res) => {
  const { clientId, items, livraisonPrevue, notes, status, productionStage } = req.body || {};
  let { societe, contact, tel, adresse } = req.body || {};

  // Uniquement des clients enregistrés : un client inconnu se crée d'abord
  // (raccourci « + Nouveau client » dans la fenêtre de commande).
  if (!clientId) {
    return res.status(400).json({ error: 'Merci de choisir un client enregistré.' });
  }
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(clientId));
  if (!client) return res.status(404).json({ error: 'Client introuvable.' });
  ({ societe, contact, tel, adresse } = client);
  contact = contact || '';
  tel = tel || '';
  adresse = adresse || '';
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Merci de sélectionner au moins un article.' });
  }

  const servicesById = getServicesByIdForClient(clientId || null);
  const resolved = [];
  for (const it of items) {
    const itemId = it.serviceId || it.id; // collectQtyGrid renvoie "serviceId" ; on accepte aussi "id" par tolérance
    const svc = servicesById[itemId];
    const qty = parseInt(it.qty, 10);
    if (!svc) return res.status(400).json({ error: `Article inconnu : ${itemId}` });
    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ error: `Quantité invalide pour ${svc.name}.` });
    }
    resolved.push({ ...svc, qty });
  }

  const finalStatus = STATUSES.includes(status) ? status : 'recue';
  const itemStage = finalStatus === 'traitement' && PRODUCTION_STAGES.includes(productionStage) ? productionStage : 'tri';
  // orders.production_stage n'accepte volontairement PAS "en_stock" (sa
  // contrainte n'a pas été migrée, cette colonne n'étant plus utilisée
  // que comme valeur de départ) — on la plafonne à "pliage" dans ce cas
  // précis, tandis que order_items reçoit la vraie étape choisie.
  const orderStage = itemStage === 'en_stock' ? 'pliage' : itemStage;

  const now = new Date();
  const insertOrder = db.prepare(`
    INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, notes, status, production_stage, created_at)
    VALUES (@ticket, @clientId, @societe, @contact, @tel, @adresse, @livraisonPrevue, @notes, @status, @productionStage, @createdAt)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty, production_stage)
    VALUES (@orderId, @id, @name, @code, @sageCode, @price, @qty, @qty, @productionStage)
  `);

  const createOrder = db.transaction(() => {
    const ticket = nextTicket(now);
    const info = insertOrder.run({
      ticket,
      clientId: clientId || null,
      societe, contact, tel, adresse,
      livraisonPrevue: livraisonPrevue || null,
      notes: notes || 'Commande créée manuellement par un administrateur.',
      status: finalStatus,
      productionStage: orderStage,
      createdAt: now.toISOString(),
    });
    const orderId = info.lastInsertRowid;
    for (const it of resolved) {
      insertItem.run({ orderId, id: it.id, name: it.name, code: it.code, sageCode: it.sageCode, price: it.price, qty: it.qty, productionStage: itemStage });
    }
    return { orderId, ticket };
  });

  const { orderId, ticket } = createOrder();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  const itemsSummary = resolved.map(i => `${i.name} x${i.qty}`).join(', ');
  sendWhatsAppNotification(`Commande créée manuellement ${ticket} — ${societe} — ${itemsSummary}`)
    .catch(err => console.error('Notification WhatsApp échouée :', err.message));

  res.status(201).json({ order: serializeOrder(order, resolved), ticket });
});

// GET /api/admin/orders/:id/copy — de quoi préremplir la création d'une commande identique à celle-ci :
// même client, mêmes articles et quantités COMMANDÉES (pas les quantités livrées). Les articles sont
// revérifiés pour ce client à l'instant T : ceux qui ne sont plus au catalogue ou plus attribués sont
// signalés dans `skipped` au lieu d'être repris en silence. Les prix ne sont pas copiés : la nouvelle
// commande prend les tarifs du jour à sa création (POST /orders/manual).
router.get('/orders/:id/copy', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (!order.client_id) {
    return res.status(409).json({ error: "Le client de cette commande n'existe plus : créez la nouvelle commande depuis une fiche client." });
  }
  const servicesById = getServicesByIdForClient(order.client_id);
  const rows = db.prepare('SELECT service_id, name, qty FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  const kept = new Map(); const skipped = [];
  for (const r of rows) {
    const svc = servicesById[r.service_id];
    if (!svc) { skipped.push({ name: r.name, qty: r.qty }); continue; }
    const prev = kept.get(r.service_id);
    if (prev) prev.qty += r.qty;
    else kept.set(r.service_id, { serviceId: r.service_id, name: svc.name, code: svc.code, qty: r.qty });
  }
  if (kept.size === 0) {
    return res.status(409).json({ error: "Aucun article de cette commande n'est encore proposé à ce client : rien à dupliquer." });
  }
  res.json({ clientId: order.client_id, societe: order.societe, items: [...kept.values()], skipped, notes: `Copie de la commande ${order.ticket}.` });
});

// GET /api/admin/orders — toutes les commandes, tous clients
router.get('/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json({ orders: orders.map(o => serializeOrder(o, getItems(o.id))) });
});

// PATCH /api/admin/orders/:id/status
router.patch('/orders/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Statut invalide.' });
  }
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });

  // Si la commande passe en "livrée" sans jamais avoir eu de date de
  // livraison prévue renseignée, on la complète avec la date du jour —
  // mieux vaut une date réelle a posteriori qu'un champ vide sur une
  // commande pourtant bien livrée (utile pour l'historique, les
  // statistiques, et la facturation Odoo qui s'appuie dessus).
  let livraisonPrevue = order.livraison_prevue;
  if (status === 'livree' && !livraisonPrevue) {
    livraisonPrevue = new Date().toISOString().slice(0, 10);
  }

  db.prepare('UPDATE orders SET status = ?, livraison_prevue = ? WHERE id = ?').run(status, livraisonPrevue, order.id);

  // Notifie le logiciel du client (si intégré via API et webhook
  // configuré) avec les quantités définitives, sans jamais bloquer la
  // réponse ni faire échouer le changement de statut si l'appel rate.
  if (status === 'livree' && order.client_id) {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(order.client_id);
    if (client?.webhook_url) {
      notifyOrderDelivered(client, order, getItems(order.id)).catch(() => {});
    }
  }

  res.json({ order: serializeOrder({ ...order, status, livraison_prevue: livraisonPrevue }, getItems(order.id)) });
});

// PATCH /api/admin/orders/:id/livraison-prevue — définit ou modifie la
// date de livraison prévue d'une commande existante (vide = effacée).
router.patch('/orders/:id/livraison-prevue', (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });

  const { livraisonPrevue } = req.body || {};
  db.prepare('UPDATE orders SET livraison_prevue = ? WHERE id = ?').run(livraisonPrevue || null, orderId);
  res.json({ order: serializeOrder({ ...order, livraison_prevue: livraisonPrevue || null }, getItems(order.id)) });
});

// POST /api/admin/orders/:id/create-followup — crée une commande de
// complément pour le lendemain, reprenant UNIQUEMENT les quantités
// manquantes (qty - delivered_qty) d'une commande livrée partiellement.
// Appelée après confirmation de l'admin, pas automatiquement.
router.post('/orders/:id/create-followup', (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });

  const items = getItems(orderId);
  const missing = items
    .map(it => ({ ...it, missingQty: it.qty - (it.deliveredQty ?? it.qty) }))
    .filter(it => it.missingQty > 0);

  if (missing.length === 0) {
    return res.status(400).json({ error: 'Aucun manquant sur cette commande — rien à reporter.' });
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const livraisonPrevue = tomorrow.toISOString().slice(0, 10);

  const now = new Date();
  const insertOrder = db.prepare(`
    INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, notes, status, created_at)
    VALUES (@ticket, @clientId, @societe, @contact, @tel, @adresse, @livraisonPrevue, @notes, 'recue', @createdAt)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty)
    VALUES (@orderId, @serviceId, @name, @code, @sageCode, @price, @qty, @qty)
  `);

  const createFollowup = db.transaction(() => {
    const ticket = nextTicket(now);
    const info = insertOrder.run({
      ticket,
      clientId: order.client_id,
      societe: order.societe, contact: order.contact, tel: order.tel, adresse: order.adresse,
      livraisonPrevue,
      notes: `Commande de complément suite à livraison partielle de ${order.ticket}.`,
      createdAt: now.toISOString(),
    });
    const followupId = info.lastInsertRowid;
    for (const it of missing) {
      insertItem.run({
        orderId: followupId, serviceId: it.id, name: it.name, code: it.code, sageCode: it.sageCode,
        price: it.price, qty: it.missingQty,
      });
    }
    return { followupId, ticket };
  });

  const { followupId, ticket } = createFollowup();
  const followupOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(followupId);
  res.status(201).json({ order: serializeOrder(followupOrder, getItems(followupId)) });
});

// PATCH /api/admin/orders/:id/items — ajuste la quantité RÉELLEMENT PRÉPARÉE
// de chaque article (commande "en traitement"). La quantité commandée par le
// client (colonne qty) n'est jamais modifiée : seule delivered_qty change,
// pour que le client puisse toujours voir les deux valeurs sur son aperçu.
router.patch('/orders/:id/items', (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  if (order.status !== 'traitement') {
    return res.status(409).json({ error: 'Les quantités ne peuvent être modifiées que pour une commande en traitement.' });
  }

  const { items } = req.body || {};
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Liste d'articles invalide." });
  }

  const existing = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  const update = db.prepare('UPDATE order_items SET delivered_qty = ? WHERE order_id = ? AND service_id = ?');

  db.transaction(() => {
    existing.forEach(row => {
      const found = items.find(i => i.id === row.service_id);
      if (!found) return; // article non transmis : on laisse sa valeur actuelle
      const raw = parseInt(found.deliveredQty, 10);
      const deliveredQty = Number.isInteger(raw) && raw >= 0 ? raw : row.delivered_qty;
      update.run(deliveredQty, order.id, row.service_id);
    });
  })();

  res.json({ order: serializeOrder(order, getItems(order.id)) });
});

// POST /api/admin/orders/:id/items — ajoute un article supplémentaire à
// une commande déjà existante (ex. l'hôtel appelle pour en rajouter).
// Le nom/code/prix sont figés au moment de l'ajout, comme pour tout
// article de commande — un changement ultérieur du catalogue ne modifie
// pas rétroactivement cette ligne.
// GET /api/admin/orders/:id/available-articles — catalogue accessible au
// CLIENT de cette commande précise (respecte l'attribution par hôtel),
// pour alimenter la liste déroulante "+ Ajouter un article" — jamais le
// catalogue complet, sans quoi un admin pourrait ajouter à une commande
// un article que cet hôtel n'est normalement pas censé pouvoir commander.
router.get('/orders/:id/available-articles', (req, res) => {
  const order = db.prepare('SELECT client_id FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  const articles = getServicesForClient(order.client_id);
  res.json({ articles });
});

router.post('/orders/:id/items', (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });

  const { serviceId, qty } = req.body || {};
  const servicesById = getServicesByIdForClient(order.client_id);
  const svc = servicesById[serviceId];
  if (!svc) return res.status(400).json({ error: 'Article inconnu.' });
  const qtyNum = parseInt(qty, 10);
  if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
    return res.status(400).json({ error: 'Quantité invalide.' });
  }

  const existing = db.prepare('SELECT id, qty FROM order_items WHERE order_id = ? AND service_id = ?').get(orderId, serviceId);
  if (existing) {
    // Déjà présent sur cette commande : on augmente la ligne existante
    // plutôt que d'en créer une seconde pour le même article.
    const newQty = existing.qty + qtyNum;
    db.prepare('UPDATE order_items SET qty = ?, delivered_qty = ? WHERE id = ?').run(newQty, newQty, existing.id);
  } else {
    db.prepare(`
      INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty, production_stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, svc.id, svc.name, svc.code, svc.sageCode, svc.price, qtyNum, qtyNum, order.production_stage || 'tri');
  }

  res.status(201).json({ order: serializeOrder(order, getItems(orderId)) });
});

// DELETE /api/admin/orders/:id — supprime une commande. Les lignes
// d'articles, hôtels supplémentaires et commentaires liés partent avec
// elle (ON DELETE CASCADE, clés étrangères actives — voir db.js).
router.delete('/orders/:id', (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  res.json({ ok: true });
});

// GET /api/admin/settings
router.get('/settings', (req, res) => {
  const admin = getAdminRow();
  res.json({ deliveryEmail: admin?.delivery_email || '' });
});

// PUT /api/admin/settings
router.put('/settings', (req, res) => {
  const { deliveryEmail } = req.body || {};
  db.prepare('UPDATE admin SET delivery_email = ? WHERE id = 1').run(deliveryEmail || null);
  res.json({ ok: true });
});

// POST /api/admin/orders/:id/delivery-note — génère (et tente d'envoyer) le bon de livraison
router.post('/orders/:id/delivery-note', async (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });

  const items = getItems(order.id);
  const orderWithItems = { ...order, items };
  const text = buildDeliveryNoteText(orderWithItems);
  const admin = getAdminRow();
  const to = admin?.delivery_email;

  // Outlook (onglet en ligne ou Outlook installé) : brouillon avec le PDF du bon joint. L'adresse des réglages sert de
  // destinataire (facultative : on peut la saisir dans Outlook). Rien ne part sans le clic sur Envoyer dans Outlook.
  const channel = req.body && req.body.channel;
  if (channel) {
    try {
      const msg = mail.renderDeliveryNote(orderWithItems);
      const r = await mail.sendDeliveryNote(order.id, { to: to || '', subject: msg.subject, body: msg.body, channel });
      return res.json({ ok: true, sent: false, ...msg, to: r.to, outlook: !!r.outlook, draft: !!r.draft, webLink: r.webLink || null, draftError: r.draftError || null, file: !!r.file, eml: r.eml || null, emlName: r.emlName || null, text });
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message, code: err.code || null });
    }
  }

  if (!to) {
    return res.json({ sent: false, reason: 'no_email', text });
  }
  if (!isConfigured()) {
    return res.json({ sent: false, reason: 'smtp_not_configured', text, to });
  }

  try {
    const [html, pdfBuffer] = await Promise.all([
      Promise.resolve(buildDeliveryNoteHtml(orderWithItems)),
      buildDeliveryNotePdf(orderWithItems),
    ]);
    await sendMail({
      to,
      subject: `Bon de livraison ${order.ticket}`,
      text,
      html,
      attachments: [{
        filename: `bon-livraison-${order.ticket}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });
    res.json({ sent: true, to, text });
  } catch (err) {
    console.error('Échec envoi email :', err.message);
    res.status(502).json({ sent: false, reason: 'send_failed', text, to, error: err.message });
  }
});

// GET /api/admin/orders/:id/delivery-note.pdf — le PDF du bon (téléchargé quand Outlook ne peut pas le joindre tout seul)
router.get('/orders/:id/delivery-note.pdf', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  try {
    const pdf = await buildDeliveryNotePdf({ ...order, items: getItems(order.id) });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="bon-livraison-${String(order.ticket).replace(/[^\w.-]+/g, '-')}.pdf"` });
    res.send(pdf);
  } catch (err) {
    console.error('Échec PDF bon de livraison :', err.message);
    res.status(500).json({ error: 'Erreur de génération du bon de livraison.' });
  }
});

// POST /api/admin/delivery-notes/export — regroupe dans un seul PDF les bons
// de livraison des commandes livrées dont les identifiants sont fournis
// (ceux qu'affiche l'historique avec les filtres en cours). Un BL par page
// (ou plus si le BL est long), du plus ancien au plus récent.
const EXPORT_MAX_ORDERS = 500;
router.post('/delivery-notes/export', async (req, res) => {
  const ids = [...new Set((req.body?.ids || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return res.status(400).json({ error: 'Aucune commande à exporter.' });
  if (ids.length > EXPORT_MAX_ORDERS) {
    return res.status(400).json({ error: `Trop de bons à la fois (${ids.length}). Maximum ${EXPORT_MAX_ORDERS} : resserrez les filtres.` });
  }

  const placeholders = ids.map(() => '?').join(',');
  const orders = db.prepare(
    `SELECT * FROM orders WHERE id IN (${placeholders}) AND status = 'livree' ORDER BY created_at ASC, id ASC`
  ).all(...ids);
  if (orders.length === 0) return res.status(404).json({ error: 'Aucune commande livrée trouvée.' });

  try {
    const buffers = [];
    for (const order of orders) {
      buffers.push(await buildDeliveryNotePdf({ ...order, items: getItems(order.id) }));
    }
    const merged = await mergePdfs(buffers);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bons-livraison-${stamp}.pdf"`);
    res.setHeader('X-Order-Count', String(orders.length));
    res.send(merged);
  } catch (err) {
    console.error('Échec export BL groupé :', err.message);
    res.status(500).json({ error: 'Erreur lors de la génération du PDF groupé.' });
  }
});

module.exports = router;
