// Moteur de facturation intégrée.
//
// Règles clés :
//  - Tous les montants sont calculés et stockés en CENTIMES (entiers) : pas
//    de dérive d'arrondi flottant entre l'écran, le PDF, le XML et le FEC.
//  - La TVA est calculée par taux sur la base HT totale du taux (méthode
//    recommandée par la norme EN 16931), pas ligne par ligne.
//  - Un brouillon est librement modifiable. À l'émission (issue), tout se
//    passe dans UNE transaction : contrôle des mentions obligatoires,
//    attribution du numéro (continu, sans trou), hash chaîné, gel des
//    identités vendeur/acheteur. Si une étape échoue, rien n'est consommé.
//  - Après émission, les triggers SQL (schema.js) interdisent toute
//    modification : on corrige par un avoir.

const crypto = require('crypto');
const db = require('../db');
const { aggregateByArticle } = require('../utils/invoiceBuilder');
const escompte = require('./escompte');

class BillingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BillingError';
    this.status = status;
  }
}

// ---------- utilitaires ----------

function todayParis() {
  // 'en-CA' formate en AAAA-MM-JJ.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

// Prix unitaire (jusqu'à 4 décimales) × quantité → centimes entiers.
// Arrondi « demi vers l'extérieur » : une quantité négative donne exactement l'opposé de la même quantité positive
// (Math.round(-2.5) vaudrait -2, pas -3). Sans effet sur les valeurs positives.
const roundAway = (x) => (Math.sign(x) * Math.round(Math.abs(x))) + 0;

function lineCents(quantity, unitPrice) {
  const unit4 = Math.round(Number(unitPrice) * 10000); // prix en 1/10000 €
  return roundAway((Number(quantity) * unit4) / 100);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sirenFrom(siretOrSiren) {
  const digits = String(siretOrSiren || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(0, 9) : '';
}

// Contrôle de Luhn : SIREN/SIRET valides.
function luhnOk(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function getSettings() {
  return db.prepare('SELECT * FROM billing_settings WHERE id = 1').get();
}

// ---------- calculs ----------

/**
 * lines : [{ isSection, quantity, unitPrice, vatRate }]
 * Renvoie { lineCents: [...], totalHtCents, totalVatCents, totalTtcCents, breakdown }
 */
function computeTotals(lines) {
  const perLine = [];
  const baseByRate = new Map();
  for (const l of lines) {
    if (l.isSection) { perLine.push(0); continue; }
    const cents = lineCents(l.quantity, l.unitPrice);
    perLine.push(cents);
    const rate = Number(l.vatRate);
    baseByRate.set(rate, (baseByRate.get(rate) || 0) + cents);
  }
  const breakdown = [...baseByRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, baseCents]) => ({
      rate,
      baseCents,
      vatCents: roundAway((baseCents * rate) / 100),
    }));
  const totalHtCents = breakdown.reduce((s, b) => s + b.baseCents, 0);
  const totalVatCents = breakdown.reduce((s, b) => s + b.vatCents, 0);
  return { lineCents: perLine, totalHtCents, totalVatCents, totalTtcCents: totalHtCents + totalVatCents, breakdown };
}

// ---------- lecture ----------

function loadInvoice(invoiceId) {
  const inv = db.prepare('SELECT * FROM native_invoices WHERE id = ?').get(invoiceId);
  if (!inv) return null;
  inv.lines = db.prepare('SELECT * FROM native_invoice_lines WHERE invoice_id = ? ORDER BY position').all(invoiceId);
  inv.orderIds = db.prepare('SELECT order_id FROM native_invoice_orders WHERE invoice_id = ?').all(invoiceId).map(r => r.order_id);
  inv.seller = inv.seller_json ? JSON.parse(inv.seller_json) : null;
  inv.buyer = inv.buyer_json ? JSON.parse(inv.buyer_json) : null;
  inv.terms = inv.terms_json ? JSON.parse(inv.terms_json) : null;
  inv.vatBreakdown = JSON.parse(inv.vat_breakdown_json || '[]');
  return inv;
}

// Commandes livrées pas encore couvertes par une facture « vivante » : ni
// dans le flux Odoo, ni dans une facture native — sauf si cette facture a
// été intégralement annulée par un avoir émis (les BL redeviennent alors
// facturables).
function listInvoiceableOrders(clientId) {
  return db.prepare(`
    SELECT o.id, o.ticket, o.livraison_prevue as livraisonPrevue
    FROM orders o
    WHERE o.client_id = ? AND o.status = 'livree'
      AND o.id NOT IN (SELECT order_id FROM invoice_orders)
      AND NOT EXISTS (
        SELECT 1 FROM native_invoice_orders no
        JOIN native_invoices ni ON ni.id = no.invoice_id
        WHERE no.order_id = o.id AND ni.kind = 'invoice'
          AND NOT EXISTS (
            SELECT 1 FROM native_invoices cn
            WHERE cn.credits_invoice_id = ni.id AND cn.status = 'issued' AND cn.is_full_credit = 1
          )
      )
    ORDER BY o.livraison_prevue, o.id
  `).all(clientId);
}

// ---------- construction des lignes à partir de BL ----------

function buildNativeLines(orders, detailLevel, vatRate) {
  const out = [];
  const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : 'date à confirmer');

  if (detailLevel === 'per_bl') {
    for (const o of orders) {
      const total = o.items.reduce((s, it) => s + lineCents(it.deliveredQty ?? it.qty, it.price), 0);
      if (total === 0) continue;
      out.push({
        isSection: false, sageCode: null,
        description: `Prestation de blanchisserie — BL ${o.ticket} livré le ${fmt(o.livraisonPrevue)}`,
        // BL à solde négatif (reprises) : quantité −1 à prix positif, pour garder un prix unitaire valide.
        quantity: total < 0 ? -1 : 1, unitPrice: Math.abs(total) / 100, vatRate,
      });
    }
    return out;
  }

  if (detailLevel === 'aggregated') {
    for (const g of aggregateByArticle(orders)) {
      out.push({ isSection: false, sageCode: g.sageCode, description: g.name, quantity: g.qty, unitPrice: g.price, vatRate });
    }
    return out;
  }

  for (const o of orders) {
    const rows = o.items.filter(it => (it.deliveredQty ?? it.qty) !== 0);   // les quantités négatives (reprises) se facturent en moins
    if (rows.length === 0) continue;
    out.push({ isSection: true, description: `BL ${o.ticket} — livré le ${fmt(o.livraisonPrevue)}` });
    for (const it of rows) {
      out.push({ isSection: false, sageCode: it.sageCode, description: it.name, quantity: it.deliveredQty ?? it.qty, unitPrice: it.price, vatRate });
    }
  }
  return out;
}

// ---------- journal chaîné ----------

function logEvent(action, invoiceId, detail = {}) {
  const last = db.prepare('SELECT hash FROM billing_events ORDER BY id DESC LIMIT 1').get();
  const prevHash = last ? last.hash : null;
  const at = new Date().toISOString();
  const detailJson = JSON.stringify(detail);
  const hash = sha256([prevHash || '', at, action, invoiceId ?? '', detailJson].join('|'));
  db.prepare('INSERT INTO billing_events (at, action, invoice_id, detail_json, prev_hash, hash) VALUES (?,?,?,?,?,?)')
    .run(at, action, invoiceId ?? null, detailJson, prevHash, hash);
}

// ---------- création d'un brouillon de facture ----------

function createDraftFromOrders(clientId, orderIds, opts = {}) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new BillingError('Hôtel introuvable.', 404);
  if (!Array.isArray(orderIds) || orderIds.length === 0) throw new BillingError('Sélectionnez au moins une commande.');

  const settings = getSettings();
  const placeholders = orderIds.map(() => '?').join(',');
  const orders = db.prepare(`SELECT * FROM orders WHERE id IN (${placeholders})`).all(...orderIds);
  if (orders.length !== new Set(orderIds).size) throw new BillingError('Une ou plusieurs commandes sont introuvables.');
  const invoiceable = new Set(listInvoiceableOrders(clientId).map(o => o.id));
  for (const o of orders) {
    if (o.client_id !== clientId) throw new BillingError(`La commande ${o.ticket} n'appartient pas à cet hôtel.`);
    if (o.status !== 'livree') throw new BillingError(`La commande ${o.ticket} n'est pas encore livrée.`);
    if (!invoiceable.has(o.id)) throw new BillingError(`La commande ${o.ticket} est déjà incluse dans une facture.`);
  }

  const itemsStmt = db.prepare('SELECT name, sage_code as sageCode, qty, delivered_qty as deliveredQty, price FROM order_items WHERE order_id = ? ORDER BY id');
  const withItems = orders
    .sort((a, b) => String(a.livraison_prevue || '').localeCompare(String(b.livraison_prevue || '')) || a.id - b.id)
    .map(o => ({ id: o.id, ticket: o.ticket, livraisonPrevue: o.livraison_prevue, items: itemsStmt.all(o.id) }));

  const detailLevel = opts.detailLevel || client.invoice_detail_level || 'detail';
  const vatRate = opts.vatRate ?? settings.default_vat_rate;
  const lines = buildNativeLines(withItems, detailLevel, vatRate);
  if (lines.filter(l => !l.isSection).length === 0) {
    throw new BillingError('Aucune ligne facturable (quantités livrées nulles sur les commandes sélectionnées ?).');
  }

  const dates = orders.map(o => o.livraison_prevue).filter(Boolean).sort();
  const totals = computeTotals(lines);

  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO native_invoices (kind, status, client_id, period_start, period_end, operation_category, detail_level, reference, notes,
                                   total_ht_cents, total_vat_cents, total_ttc_cents, vat_breakdown_json)
      VALUES ('invoice','draft',?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      clientId, dates[0] || null, dates[dates.length - 1] || null,
      opts.operationCategory || 'services', detailLevel,
      `BL ${withItems.map(o => o.ticket).join(', ')}`.slice(0, 250), opts.notes || null,
      totals.totalHtCents, totals.totalVatCents, totals.totalTtcCents, JSON.stringify(totals.breakdown),
    );
    const id = Number(info.lastInsertRowid);
    insertLines(id, lines, totals.lineCents);
    const link = db.prepare('INSERT INTO native_invoice_orders (invoice_id, order_id) VALUES (?, ?)');
    for (const o of withItems) link.run(id, o.id);
    logEvent('draft_created', id, { clientId, orders: withItems.map(o => o.ticket) });
    return id;
  });
  return loadInvoice(create());
}

/**
 * Brouillon de facture « libre » (sans BL) : prestation ponctuelle, ou conversion
 * d'un devis. Mêmes règles de lignes que l'édition d'un brouillon.
 */
function createDraftFromLines(clientId, rawLines, opts = {}) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new BillingError('Hôtel introuvable.', 404);
  const lines = sanitizeLines(rawLines);
  if (lines.filter(l => !l.isSection).length === 0) throw new BillingError('La facture doit contenir au moins une ligne facturable.');
  const category = opts.operationCategory || 'services';
  if (!['services', 'goods', 'mixed'].includes(category)) throw new BillingError("Catégorie d'opération invalide.");
  const totals = computeTotals(lines);
  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO native_invoices (kind, status, client_id, operation_category, detail_level, reference, notes,
                                   total_ht_cents, total_vat_cents, total_ttc_cents, vat_breakdown_json)
      VALUES ('invoice','draft',?,?,'detail',?,?,?,?,?,?)
    `).run(clientId, category, opts.reference ? String(opts.reference).slice(0, 250) : null, opts.notes || null,
      totals.totalHtCents, totals.totalVatCents, totals.totalTtcCents, JSON.stringify(totals.breakdown));
    const id = Number(info.lastInsertRowid);
    insertLines(id, lines, totals.lineCents);
    logEvent('draft_created', id, { clientId, free: true, ...(opts.fromQuote ? { fromQuote: opts.fromQuote } : {}) });
    return id;
  });
  return loadInvoice(create());
}

// Montant HT estimé (centimes) de commandes livrées, avant création du brouillon.
function estimateOrdersHtCents(orderIds) {
  if (!orderIds.length) return 0;
  const rows = db.prepare(`SELECT qty, delivered_qty AS d, price FROM order_items WHERE order_id IN (${orderIds.map(() => '?').join(',')})`).all(...orderIds);
  return rows.reduce((s, r) => s + lineCents(r.d ?? r.qty, r.price), 0);
}

function insertLines(invoiceId, lines, perLineCents) {
  const ins = db.prepare(`
    INSERT INTO native_invoice_lines (invoice_id, position, is_section, sage_code, description, quantity, unit_price, vat_rate, line_ht_cents, credit_of_line_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  lines.forEach((l, i) => {
    ins.run(invoiceId, i + 1, l.isSection ? 1 : 0, l.sageCode || null, l.description,
      l.isSection ? 0 : l.quantity, l.isSection ? 0 : l.unitPrice, l.isSection ? 0 : l.vatRate,
      perLineCents[i], l.creditOfLineId || null);
  });
}

// ---------- modification d'un brouillon ----------

function assertDraft(inv) {
  if (!inv) throw new BillingError('Facture introuvable.', 404);
  if (inv.status !== 'draft') throw new BillingError("Facture émise : modification interdite. Émettez un avoir pour corriger.", 409);
}

function sanitizeLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new BillingError('La facture doit contenir au moins une ligne.');
  return rawLines.map((l, i) => {
    const description = String(l.description || '').trim();
    if (!description) throw new BillingError(`Ligne ${i + 1} : désignation manquante.`);
    if (l.isSection) return { isSection: true, description };
    const quantity = Number(l.quantity);
    const unitPrice = Number(l.unitPrice);
    const vatRate = Number(l.vatRate);
    // Quantité négative autorisée (reprise, remise en nature) ; zéro refusé. Le prix, lui, reste positif.
    if (!Number.isFinite(quantity) || quantity === 0) throw new BillingError(`Ligne ${i + 1} : quantité invalide (nombre non nul ; négatif possible pour une reprise).`);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new BillingError(`Ligne ${i + 1} : prix unitaire invalide.`);
    if (![0, 2.1, 5.5, 8.5, 10, 20].includes(vatRate)) throw new BillingError(`Ligne ${i + 1} : taux de TVA inattendu (${l.vatRate}).`);
    return { isSection: false, description, sageCode: l.sageCode || null, quantity, unitPrice, vatRate, creditOfLineId: l.creditOfLineId || null };
  });
}

function updateDraft(invoiceId, patch) {
  const inv = loadInvoice(invoiceId);
  assertDraft(inv);
  const update = db.transaction(() => {
    if (patch.lines) {
      const lines = sanitizeLines(patch.lines);
      if (inv.kind === 'credit_note') throw new BillingError("Les lignes d'un avoir sont déterminées par la facture d'origine.");
      const totals = computeTotals(lines);
      db.prepare('DELETE FROM native_invoice_lines WHERE invoice_id = ?').run(invoiceId);
      insertLines(invoiceId, lines, totals.lineCents);
      db.prepare('UPDATE native_invoices SET total_ht_cents=?, total_vat_cents=?, total_ttc_cents=?, vat_breakdown_json=? WHERE id=?')
        .run(totals.totalHtCents, totals.totalVatCents, totals.totalTtcCents, JSON.stringify(totals.breakdown), invoiceId);
    }
    const allowedCategory = ['services', 'goods', 'mixed'];
    if (patch.operationCategory !== undefined) {
      if (!allowedCategory.includes(patch.operationCategory)) throw new BillingError("Catégorie d'opération invalide.");
      db.prepare('UPDATE native_invoices SET operation_category=? WHERE id=?').run(patch.operationCategory, invoiceId);
    }
    if (patch.issueDate !== undefined) {
      if (patch.issueDate !== null && !isIsoDate(patch.issueDate)) throw new BillingError("Date d'émission invalide.");
      db.prepare('UPDATE native_invoices SET issue_date=? WHERE id=?').run(patch.issueDate, invoiceId);
    }
    if (patch.notes !== undefined) db.prepare('UPDATE native_invoices SET notes=? WHERE id=?').run(patch.notes || null, invoiceId);
    if (patch.reference !== undefined) db.prepare('UPDATE native_invoices SET reference=? WHERE id=?').run(patch.reference || null, invoiceId);
    logEvent('draft_updated', invoiceId, { fields: Object.keys(patch) });
  });
  update();
  return loadInvoice(invoiceId);
}

function deleteDraft(invoiceId) {
  const inv = loadInvoice(invoiceId);
  assertDraft(inv);
  db.transaction(() => {
    db.prepare('DELETE FROM native_invoices WHERE id = ?').run(invoiceId); // lignes et liens BL : CASCADE
    logEvent('draft_deleted', invoiceId, { kind: inv.kind, client_id: inv.client_id });
  })();
}

// ---------- avoirs ----------

// Quantité déjà créditée par ligne de la facture d'origine (avoirs émis ET
// brouillons, pour empêcher deux brouillons de créditer deux fois la même ligne).
function creditedQtyByLine(originalInvoiceId, excludeCreditNoteId = null) {
  const rows = db.prepare(`
    SELECT l.credit_of_line_id AS lineId, SUM(l.quantity) AS qty
    FROM native_invoice_lines l
    JOIN native_invoices cn ON cn.id = l.invoice_id
    WHERE cn.credits_invoice_id = ? AND cn.kind = 'credit_note' AND l.credit_of_line_id IS NOT NULL
      AND (? IS NULL OR cn.id <> ?)
    GROUP BY l.credit_of_line_id
  `).all(originalInvoiceId, excludeCreditNoteId, excludeCreditNoteId);
  return new Map(rows.map(r => [r.lineId, r.qty]));
}

/**
 * Crée un brouillon d'avoir sur une facture émise.
 * opts.full = true         → crédite tout ce qui n'a pas déjà été crédité
 * opts.lines = [{lineId, quantity}] → avoir partiel (quantités à créditer)
 */
function createCreditNoteDraft(originalInvoiceId, opts = {}) {
  const orig = loadInvoice(originalInvoiceId);
  if (!orig) throw new BillingError('Facture introuvable.', 404);
  if (orig.kind !== 'invoice') throw new BillingError("On ne peut pas créditer un avoir.");
  if (orig.status !== 'issued') throw new BillingError("Seule une facture émise peut être créditée (un brouillon se supprime).");
  const reason = String(opts.reason || '').trim();
  if (!reason) throw new BillingError("Indiquez le motif de l'avoir.");

  const already = creditedQtyByLine(originalInvoiceId);
  const creditable = new Map(); // lineId → quantité restante
  for (const l of orig.lines) {
    if (l.is_section) continue;
    creditable.set(l.id, Math.round((l.quantity - (already.get(l.id) || 0)) * 1e6) / 1e6);
  }

  let wanted;
  if (opts.full) {
    // Une ligne négative de la facture (reprise) se crédite en négatif : l'avoir total annule bien le total de la facture.
    wanted = [...creditable.entries()].filter(([, q]) => q !== 0).map(([lineId, quantity]) => ({ lineId, quantity }));
  } else {
    if (!Array.isArray(opts.lines) || opts.lines.length === 0) throw new BillingError('Indiquez les lignes à créditer.');
    wanted = opts.lines.map(x => ({ lineId: Number(x.lineId), quantity: Number(x.quantity) }));
    const seen = new Set();
    for (const w of wanted) {
      if (seen.has(w.lineId)) throw new BillingError('Une même ligne est indiquée plusieurs fois.');
      seen.add(w.lineId);
      if (!creditable.has(w.lineId)) throw new BillingError(`Ligne ${w.lineId} : introuvable sur cette facture.`);
      if (!Number.isFinite(w.quantity) || w.quantity === 0) throw new BillingError(`Ligne ${w.lineId} : quantité invalide.`);
      const rest = creditable.get(w.lineId);
      // Même sens que la ligne d'origine (positive ou négative), et pas plus que ce qui reste à créditer.
      if (rest === 0 || Math.sign(w.quantity) !== Math.sign(rest) || Math.abs(w.quantity) > Math.abs(rest) + 1e-9) {
        throw new BillingError(`Ligne ${w.lineId} : on ne peut créditer que ${rest} (déjà crédité, sens opposé ou saisie trop élevée).`);
      }
    }
  }
  if (wanted.length === 0) throw new BillingError('Cette facture est déjà intégralement créditée.');

  const byId = new Map(orig.lines.map(l => [l.id, l]));
  const lines = [];
  let lastSection = null;
  for (const l of orig.lines) {
    if (l.is_section) { lastSection = l; continue; }
    const w = wanted.find(x => x.lineId === l.id);
    if (!w) continue;
    if (lastSection) { lines.push({ isSection: true, description: lastSection.description }); lastSection = null; }
    lines.push({
      isSection: false, sageCode: l.sage_code, description: l.description,
      quantity: w.quantity, unitPrice: l.unit_price, vatRate: l.vat_rate, creditOfLineId: l.id,
    });
  }

  // Avoir total = tout ce qui restait à créditer, ET plus rien de créditable ensuite.
  const isFull = [...creditable.entries()].every(([lineId, rest]) => {
    const w = wanted.find(x => x.lineId === lineId);
    return Math.abs(rest - (w ? w.quantity : 0)) < 1e-9;
  });

  const totals = computeTotals(lines);
  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO native_invoices (kind, status, client_id, credits_invoice_id, is_full_credit, credit_reason, period_start, period_end,
                                   operation_category, detail_level, reference, total_ht_cents, total_vat_cents, total_ttc_cents, vat_breakdown_json)
      VALUES ('credit_note','draft',?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      orig.client_id, originalInvoiceId, isFull ? 1 : 0, reason, orig.period_start, orig.period_end,
      orig.operation_category, orig.detail_level, `Avoir sur facture ${orig.number}`,
      totals.totalHtCents, totals.totalVatCents, totals.totalTtcCents, JSON.stringify(totals.breakdown),
    );
    const id = Number(info.lastInsertRowid);
    insertLines(id, lines, totals.lineCents);
    logEvent('credit_note_draft_created', id, { credits: orig.number, full: isFull, reason });
    return id;
  });
  void byId;
  return loadInvoice(create());
}

// ---------- contrôle des mentions obligatoires ----------

function snapshotSeller(settings) {
  return {
    legalName: settings.legal_name, legalForm: settings.legal_form, shareCapital: settings.share_capital,
    siren: settings.siren, siret: settings.siret, vatNumber: settings.vat_number, rcs: settings.rcs,
    address: settings.address_line, postalCode: settings.postal_code, city: settings.city, country: settings.country,
    email: settings.email, phone: settings.phone, iban: settings.iban, bic: settings.bic,
  };
}

const isParticulier = (client) => Boolean(client) && client.client_type === 'particulier';

function snapshotBuyer(client) {
  const billingAddress = client.adresse_facturation || client.adresse;
  const part = isParticulier(client);
  return {
    clientId: client.id,
    // La clé « type » n'est écrite que pour un particulier : les documents d'un professionnel restent identiques à avant.
    ...(part ? { type: 'particulier' } : {}),
    name: client.societe,
    siren: part ? '' : sirenFrom(client.siret),
    siret: part ? '' : String(client.siret || '').replace(/\s/g, ''),
    vatNumber: part ? '' : (client.tva_number || ''),
    address: billingAddress,
    postalCode: client.code_postal || '',
    city: client.ville || '',
    country: 'FR',
    // Adresse de livraison (nouvelle mention obligatoire si différente).
    deliveryAddress: client.adresse && client.adresse !== billingAddress ? client.adresse : null,
  };
}

function snapshotTerms(settings, issueDate, kind, { client, inv } = {}) {
  const dueDate = kind === 'invoice' ? addDays(issueDate, settings.payment_terms_days) : null;
  const terms = {
    paymentTermsDays: settings.payment_terms_days,
    dueDate,
    latePenaltyText: settings.late_penalty_text,
    // indemnité forfaitaire de recouvrement : 40 € (art. D441-5 C. com.) — entre professionnels seulement, donc jamais pour un particulier
    recoveryIndemnityCents: isParticulier(client) ? 0 : 4000,
    earlyPaymentDiscount: escompte.NO_DISCOUNT_TEXT,
    vatOnDebits: Boolean(settings.vat_on_debits),
    footerNote: settings.footer_note || null,
  };
  // Escompte pour règlement anticipé : l'offre est figée avec la facture (taux, date limite, montants).
  // La clé n'existe que si une offre est faite : les documents émis avant n'en portent aucune trace.
  const offer = inv ? escompte.buildOffer({ settings, client, inv, issueDate, dueDate }) : null;
  if (offer) { terms.earlyPaymentDiscount = offer.text; terms.earlyDiscount = offer.offer; }
  return terms;
}

function missingMentions(seller, buyer, inv, issueDate) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };

  need(seller.legalName, "Émetteur : raison sociale manquante (Réglages de facturation).");
  need(seller.legalForm, "Émetteur : forme juridique manquante (ex. SAS).");
  need(seller.shareCapital, "Émetteur : capital social manquant (obligatoire sur les factures d'une société).");
  need(seller.address && seller.postalCode && seller.city, "Émetteur : adresse du siège incomplète.");
  const siren = sirenFrom(seller.siren || seller.siret);
  need(siren.length === 9, "Émetteur : SIREN manquant (9 chiffres).");
  if (siren.length === 9) need(luhnOk(siren), "Émetteur : SIREN invalide (contrôle de clé).");
  need(seller.rcs, "Émetteur : mention RCS (ville d'immatriculation) manquante.");
  need(seller.vatNumber, "Émetteur : numéro de TVA intracommunautaire manquant.");

  need(buyer.name, "Client : dénomination manquante.");
  need(buyer.address, "Client : adresse de facturation manquante.");
  // Le SIREN du client devient obligatoire sur les factures B2B émises depuis le 1er septembre 2026 ; un particulier n'en a pas.
  if (buyer.type !== 'particulier') {
    need(buyer.siren.length === 9, `Client « ${buyer.name} » : SIREN/SIRET manquant (fiche client) — obligatoire sur les factures depuis le 1er septembre 2026.`);
    if (buyer.siren.length === 9) need(luhnOk(buyer.siren), `Client « ${buyer.name} » : SIREN/SIRET invalide (contrôle de clé).`);
  }

  need(isIsoDate(issueDate), "Date d'émission invalide.");
  need(inv.lines.some(l => !l.is_section), 'Aucune ligne facturable.');
  if (inv.total_ttc_cents < 0) need(false, inv.kind === 'invoice'
    ? 'Le total de la facture est négatif (les lignes en quantité négative dépassent les autres) : une facture ne peut pas être négative, émettez plutôt un avoir.'
    : "Le total de l'avoir est négatif (seules des lignes de reprise sont créditées) : ajoutez les lignes à créditer.");
  else need(inv.total_ttc_cents > 0, 'Montant total nul : rien à facturer.');
  return problems;
}

// ---------- émission ----------

function canonicalDocument(inv, number, issueDate, prevHash) {
  // Tout ce qui fait le document, dans un ordre fixe. Ce JSON est ce qui est haché.
  return JSON.stringify({
    number, kind: inv.kind, issueDate, prevHash: prevHash || '',
    clientId: inv.client_id, creditsInvoiceId: inv.credits_invoice_id || null,
    period: [inv.period_start || '', inv.period_end || ''],
    category: inv.operation_category,
    seller: inv.seller, buyer: inv.buyer, terms: inv.terms,
    lines: inv.lines.map(l => [l.position, l.is_section, l.sage_code || '', l.description, l.quantity, l.unit_price, l.vat_rate, l.line_ht_cents, l.credit_of_line_id || null]),
    totals: [inv.total_ht_cents, inv.total_vat_cents, inv.total_ttc_cents],
    breakdown: inv.vatBreakdown,
  });
}

function issueInvoice(invoiceId, opts = {}) {
  const run = db.transaction(() => {
    const inv = loadInvoice(invoiceId);
    assertDraft(inv);
    const settings = getSettings();
    const issueDate = opts.issueDate || inv.issue_date || todayParis();

    if (inv.kind === 'credit_note') {
      const orig = loadInvoice(inv.credits_invoice_id);
      if (!orig || orig.status !== 'issued') throw new BillingError("La facture d'origine n'est plus valide.");
      if (issueDate < orig.issue_date) throw new BillingError("L'avoir ne peut pas être daté avant la facture qu'il corrige.");
      // Re-contrôle des quantités créditables au moment de l'émission.
      const already = creditedQtyByLine(orig.id, inv.id);
      const issuedOnly = db.prepare(`
        SELECT l.credit_of_line_id AS lineId, SUM(l.quantity) AS qty
        FROM native_invoice_lines l JOIN native_invoices cn ON cn.id = l.invoice_id
        WHERE cn.credits_invoice_id = ? AND cn.kind='credit_note' AND cn.status='issued' AND l.credit_of_line_id IS NOT NULL
        GROUP BY l.credit_of_line_id
      `).all(orig.id);
      void already;
      const issuedMap = new Map(issuedOnly.map(r => [r.lineId, r.qty]));
      for (const l of inv.lines) {
        if (l.is_section) continue;
        const origLine = orig.lines.find(x => x.id === l.credit_of_line_id);
        if (!origLine) throw new BillingError('Ligne d\'avoir sans ligne d\'origine.');
        const creditedSoFar = l.quantity + (issuedMap.get(origLine.id) || 0);
        if (Math.sign(l.quantity) !== Math.sign(origLine.quantity) || Math.abs(creditedSoFar) > Math.abs(origLine.quantity) + 1e-9) {
          throw new BillingError(`Ligne « ${l.description} » : crédit supérieur à la quantité facturée.`);
        }
      }
    }

    const seller = snapshotSeller(settings);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(inv.client_id);
    if (!client) throw new BillingError('Hôtel introuvable.');
    const buyer = snapshotBuyer(client);

    const problems = missingMentions(seller, buyer, inv, issueDate);
    if (problems.length) throw new BillingError(`Émission impossible :\n- ${problems.join('\n- ')}`, 422);

    // Date chronologique : jamais antérieure à la dernière facture émise de la même séquence.
    const year = Number(issueDate.slice(0, 4));
    const lastSameKind = db.prepare(`SELECT MAX(issue_date) AS d FROM native_invoices WHERE status='issued' AND kind=?`).get(inv.kind);
    if (lastSameKind && lastSameKind.d && issueDate < lastSameKind.d) {
      throw new BillingError(`Date d'émission antérieure à la dernière ${inv.kind === 'invoice' ? 'facture' : 'avoir'} émise (${lastSameKind.d}) : la numérotation doit rester chronologique.`, 422);
    }

    // Numéro continu : ligne de séquence créée ou incrémentée dans CETTE transaction.
    const seqKey = `${inv.kind}-${year}`;
    db.prepare('INSERT OR IGNORE INTO native_invoice_seq (seq_key, value) VALUES (?, 0)').run(seqKey);
    db.prepare('UPDATE native_invoice_seq SET value = value + 1 WHERE seq_key = ?').run(seqKey);
    const seqNo = db.prepare('SELECT value FROM native_invoice_seq WHERE seq_key = ?').get(seqKey).value;
    const prefix = inv.kind === 'invoice' ? settings.invoice_prefix : settings.credit_prefix;
    const number = `${prefix}-${year}-${String(seqNo).padStart(6, '0')}`;

    // Chaîne d'intégrité globale.
    const last = db.prepare('SELECT chain_no, hash FROM native_invoices WHERE chain_no IS NOT NULL ORDER BY chain_no DESC LIMIT 1').get();
    const chainNo = last ? last.chain_no + 1 : 1;
    const prevHash = last ? last.hash : null;

    const terms = snapshotTerms(settings, issueDate, inv.kind, { client, inv });
    const frozen = { ...inv, seller, buyer, terms };
    const hash = sha256(canonicalDocument(frozen, number, issueDate, prevHash));
    const issuedAt = new Date().toISOString();

    db.prepare(`
      UPDATE native_invoices
      SET status='issued', number=?, seq_year=?, seq_no=?, chain_no=?, issue_date=?, due_date=?,
          seller_json=?, buyer_json=?, terms_json=?, prev_hash=?, hash=?, issued_at=?
      WHERE id=?
    `).run(number, year, seqNo, chainNo, issueDate, terms.dueDate, JSON.stringify(seller), JSON.stringify(buyer), JSON.stringify(terms),
      prevHash, hash, issuedAt, invoiceId);

    logEvent('issued', invoiceId, { number, chainNo, hash, totalTtcCents: inv.total_ttc_cents });
    return number;
  });
  run.immediate();
  return loadInvoice(invoiceId);
}

// ---------- règlements ----------

// Total réglé : encaissements ET escomptes accordés (c'est ce qui solde la facture).
function paidCents(invoiceId) {
  return db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM native_payments WHERE invoice_id = ?').get(invoiceId).s;
}

// Argent réellement reçu (hors escompte).
function cashCents(invoiceId) {
  return db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM native_payments WHERE invoice_id = ? AND method <> 'escompte'").get(invoiceId).s;
}

// Escomptes accordés (net des annulations) : TTC, HT et TVA.
function discountSums(invoiceId) {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS ttc, COALESCE(SUM(discount_ht_cents),0) AS ht, COALESCE(SUM(discount_vat_cents),0) AS vat
    FROM native_payments WHERE invoice_id = ? AND method = 'escompte'`).get(invoiceId);
  return { ttcCents: r.ttc, htCents: r.ht, vatCents: r.vat };
}

function creditedCents(invoiceId) {
  return db.prepare(`SELECT COALESCE(SUM(total_ttc_cents),0) AS s FROM native_invoices WHERE credits_invoice_id = ? AND kind='credit_note' AND status='issued'`).get(invoiceId).s;
}

// Reste à payer d'une facture (net des avoirs émis et des règlements).
function balanceCents(inv) {
  if (inv.kind !== 'invoice') return 0;
  return inv.total_ttc_cents - creditedCents(inv.id) - paidCents(inv.id);
}

function paymentStatus(inv) {
  if (inv.status !== 'issued' || inv.kind !== 'invoice') return null;
  const bal = balanceCents(inv);
  if (bal <= 0 && creditedCents(inv.id) >= inv.total_ttc_cents) return 'credited';
  if (bal <= 0) return 'paid';
  if (paidCents(inv.id) > 0) return 'partial';
  return inv.due_date && inv.due_date < todayParis() ? 'overdue' : 'unpaid';
}

/**
 * Situation de l'escompte d'une facture émise : offre figée à l'émission, ce qui reste
 * possible aujourd'hui (selon la date de règlement visée) et ce qui a déjà été accordé.
 * null si la facture ne prévoyait aucun escompte.
 */
function escompteStatus(inv, onDate = todayParis()) {
  const offer = inv.terms && inv.terms.earlyDiscount;
  if (!offer || inv.status !== 'issued' || inv.kind !== 'invoice') return null;
  const granted = discountSums(inv.id);
  const balance = balanceCents(inv);
  const open = balance > 0 && onDate <= offer.deadline;
  // Montants sur le reste dû actuel, que le délai soit passé ou non (l'écran les affiche selon la date saisie).
  const now = balance > 0 ? escompte.amounts({ vatBreakdown: inv.vatBreakdown, total_ttc_cents: inv.total_ttc_cents }, balance, offer.ratePct) : null;
  return {
    ratePct: offer.ratePct, hours: offer.hours, deadline: offer.deadline,
    open, expired: balance > 0 && onDate > offer.deadline,
    discountCents: now ? now.ttcCents : 0, netCents: now ? balance - now.ttcCents : null,
    grantedCents: granted.ttcCents,
  };
}

function recordPayment(invoiceId, { paidOn, amount, method, reference, bankFingerprint, withDiscount, reverseDiscount }) {
  const inv = loadInvoice(invoiceId);
  if (!inv) throw new BillingError('Facture introuvable.', 404);
  if (inv.status !== 'issued' || inv.kind !== 'invoice') throw new BillingError("Un règlement ne s'enregistre que sur une facture émise.");
  const given = amount !== undefined && amount !== null && amount !== '';
  let amountCents = given ? Math.round(Number(amount) * 100) : null;
  // Avec escompte, le montant se déduit de la facture ; s'il est donné, il doit y correspondre.
  if (given || !withDiscount) {
    if (!Number.isFinite(amountCents) || amountCents === 0) throw new BillingError('Montant invalide.');
  }
  if (withDiscount && reverseDiscount) throw new BillingError("Un escompte s'accorde ou s'annule, pas les deux à la fois.");
  if (reverseDiscount && !(amountCents < 0)) throw new BillingError("L'annulation d'un escompte accompagne l'annulation d'un règlement.");
  const date = paidOn || todayParis();
  if (!isIsoDate(date)) throw new BillingError('Date de règlement invalide.');
  const methods = ['virement', 'cheque', 'prelevement', 'carte', 'especes', 'autre'];
  const m = methods.includes(method) ? method : 'virement';
  const run = db.transaction(() => {
    const bal = balanceCents(inv);
    let disc = null;
    if (withDiscount) {
      const offer = inv.terms && inv.terms.earlyDiscount;
      if (!offer) throw new BillingError("Cette facture ne propose pas d'escompte.");
      if (bal <= 0) throw new BillingError('Cette facture est déjà soldée.');
      if (date > offer.deadline) {
        throw new BillingError(`Le délai de l'escompte est dépassé (règlement attendu au plus tard le ${escompte.dateFr(offer.deadline)}). Pour une remise exceptionnelle, émettez un avoir.`);
      }
      disc = escompte.amounts({ vatBreakdown: inv.vatBreakdown, total_ttc_cents: inv.total_ttc_cents }, bal, offer.ratePct);
      if (disc.ttcCents <= 0) throw new BillingError("Escompte nul sur ce reste dû.");
      const net = bal - disc.ttcCents;
      if (amountCents === null) amountCents = net;
      if (amountCents !== net) throw new BillingError(`Avec l'escompte de ${escompte.pct(offer.ratePct)}, le règlement attendu est de ${escompte.eur(net)} (au lieu de ${escompte.eur(bal)}).`);
      disc.ratePct = offer.ratePct;
    }
    if (amountCents > 0 && amountCents > bal) throw new BillingError(`Le règlement dépasse le reste à payer (${(bal / 100).toFixed(2)} €).`);
    if (amountCents < 0 && -amountCents > cashCents(invoiceId)) throw new BillingError("L'écriture inverse dépasse le total déjà réglé.");
    let undone = null;
    if (reverseDiscount) {
      undone = discountSums(invoiceId);
      if (undone.ttcCents <= 0) throw new BillingError('Aucun escompte à annuler sur cette facture.');
    }
    try {
      db.prepare('INSERT INTO native_payments (invoice_id, paid_on, amount_cents, method, reference, bank_fingerprint) VALUES (?,?,?,?,?,?)')
        .run(invoiceId, date, amountCents, m, reference ? String(reference).slice(0, 120) : null, bankFingerprint || null);
    } catch (e) {
      if (/UNIQUE/.test(e.message) && /bank_fingerprint/.test(e.message)) throw new BillingError('Cette ligne de relevé a déjà été rapprochée.', 409);
      throw e;
    }
    logEvent(amountCents > 0 ? 'payment_recorded' : 'payment_reversed', invoiceId, { amountCents, method: m, paidOn: date, ...(bankFingerprint ? { bank: true } : {}) });
    const insertDiscount = db.prepare("INSERT INTO native_payments (invoice_id, paid_on, amount_cents, method, reference, discount_ht_cents, discount_vat_cents) VALUES (?,?,?,'escompte',?,?,?)");
    if (disc) {
      insertDiscount.run(invoiceId, date, disc.ttcCents, `Escompte ${escompte.pct(disc.ratePct)} pour règlement anticipé`, disc.htCents, disc.vatCents);
      logEvent('discount_granted', invoiceId, { amountCents: disc.ttcCents, htCents: disc.htCents, vatCents: disc.vatCents, ratePct: disc.ratePct, paidOn: date });
    }
    if (undone) {
      insertDiscount.run(invoiceId, date, -undone.ttcCents, "Annulation de l'escompte accordé", -undone.htCents, -undone.vatCents);
      logEvent('discount_reversed', invoiceId, { amountCents: undone.ttcCents, htCents: undone.htCents, vatCents: undone.vatCents, paidOn: date });
    }
  });
  run.immediate();
  return loadInvoice(invoiceId);
}

// ---------- vérification d'intégrité ----------

function verifyIntegrity() {
  const problems = [];
  const issued = db.prepare("SELECT id FROM native_invoices WHERE status='issued' ORDER BY chain_no").all();
  let prevHash = null;
  let expectedChain = 1;
  for (const { id } of issued) {
    const inv = loadInvoice(id);
    if (inv.chain_no !== expectedChain) problems.push(`Rang de chaîne : attendu ${expectedChain}, trouvé ${inv.chain_no} (${inv.number}).`);
    expectedChain = inv.chain_no + 1;
    if ((inv.prev_hash || null) !== prevHash) problems.push(`${inv.number} : lien vers le document précédent rompu.`);
    const recomputed = sha256(canonicalDocument(inv, inv.number, inv.issue_date, inv.prev_hash));
    if (recomputed !== inv.hash) problems.push(`${inv.number} : contenu altéré (empreinte différente).`);
    const t = computeTotals(inv.lines.map(l => ({ isSection: l.is_section, quantity: l.quantity, unitPrice: l.unit_price, vatRate: l.vat_rate })));
    if (t.totalHtCents !== inv.total_ht_cents || t.totalVatCents !== inv.total_vat_cents || t.totalTtcCents !== inv.total_ttc_cents) {
      problems.push(`${inv.number} : totaux incohérents avec les lignes.`);
    }
    prevHash = inv.hash;
  }
  // Numérotation continue par séquence.
  const seqs = db.prepare("SELECT kind, seq_year, COUNT(*) c, MIN(seq_no) mn, MAX(seq_no) mx FROM native_invoices WHERE status='issued' GROUP BY kind, seq_year").all();
  for (const s of seqs) {
    if (s.mn !== 1 || s.mx !== s.c) problems.push(`Séquence ${s.kind} ${s.seq_year} : numérotation discontinue (${s.c} documents, n° ${s.mn} à ${s.mx}).`);
  }
  // Journal d'événements.
  let evPrev = null;
  for (const e of db.prepare('SELECT * FROM billing_events ORDER BY id').all()) {
    if ((e.prev_hash || null) !== evPrev) problems.push(`Journal : lien rompu à l'événement ${e.id}.`);
    const h = sha256([e.prev_hash || '', e.at, e.action, e.invoice_id ?? '', e.detail_json].join('|'));
    if (h !== e.hash) problems.push(`Journal : événement ${e.id} altéré.`);
    evPrev = e.hash;
  }
  return { ok: problems.length === 0, checked: issued.length, problems };
}

// Prévisualisation d'un brouillon : vendeur/acheteur/conditions tels qu'ils
// seraient figés aujourd'hui, et liste des mentions encore manquantes.
// N'écrit rien.
function previewDraft(invoiceId, issueDateOverride) {
  const inv = loadInvoice(invoiceId);
  if (!inv) throw new BillingError('Facture introuvable.', 404);
  const settings = getSettings();
  const issueDate = issueDateOverride || inv.issue_date || todayParis();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(inv.client_id);
  const seller = snapshotSeller(settings);
  const buyer = snapshotBuyer(client);
  const terms = snapshotTerms(settings, issueDate, inv.kind, { client, inv });
  const problems = inv.status === 'draft' ? missingMentions(seller, buyer, inv, issueDate) : [];
  return { seller, buyer, terms, issueDate, problems };
}

module.exports = {
  snapshotSeller, snapshotBuyer, snapshotTerms,
  previewDraft, logEvent, createDraftFromLines, estimateOrdersHtCents, sanitizeLines, isIsoDate, sha256,
  BillingError, todayParis, addDays, lineCents, computeTotals, sirenFrom, luhnOk, isParticulier,
  getSettings, loadInvoice, listInvoiceableOrders,
  createDraftFromOrders, updateDraft, deleteDraft, createCreditNoteDraft, issueInvoice,
  recordPayment, paidCents, cashCents, discountSums, escompteStatus, creditedCents, balanceCents, paymentStatus, verifyIntegrity,
};
