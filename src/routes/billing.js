// API de la facturation intégrée — /api/admin/billing/*  (administrateur uniquement)
//
// Aucune règle métier ici : tout est dans src/billing/engine.js. Ce fichier
// ne fait que valider les entrées, appeler le moteur et formater les sorties.

const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const engine = require('../billing/engine');
const { buildInvoicePdf } = require('../billing/pdf');
const { buildFec } = require('../billing/fec');

const router = express.Router();
router.use(requireAdmin);

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') {
      out.catch(e => fail(res, e));
    }
  } catch (e) {
    fail(res, e);
  }
};
function fail(res, e) {
  if (e instanceof engine.BillingError) return res.status(e.status).json({ error: e.message });
  // Violation d'un trigger d'inaltérabilité (dernier rempart) : message clair, pas une 500.
  if (e && /interdite|interdit/.test(e.message || '')) return res.status(409).json({ error: e.message });
  console.error('[billing]', e);
  return res.status(500).json({ error: 'Erreur serveur.' });
}

// Représentation JSON d'une facture pour l'écran.
function present(inv) {
  const issued = inv.status === 'issued';
  return {
    id: inv.id, kind: inv.kind, status: inv.status, number: inv.number,
    clientId: inv.client_id, creditsInvoiceId: inv.credits_invoice_id, isFullCredit: !!inv.is_full_credit, creditReason: inv.credit_reason,
    issueDate: inv.issue_date, dueDate: inv.due_date, periodStart: inv.period_start, periodEnd: inv.period_end,
    operationCategory: inv.operation_category, detailLevel: inv.detail_level, reference: inv.reference, notes: inv.notes,
    totalHtCents: inv.total_ht_cents, totalVatCents: inv.total_vat_cents, totalTtcCents: inv.total_ttc_cents,
    vatBreakdown: inv.vatBreakdown, orderIds: inv.orderIds,
    buyerName: inv.buyer?.name || null,
    paidCents: issued && inv.kind === 'invoice' ? engine.paidCents(inv.id) : 0,
    creditedCents: issued && inv.kind === 'invoice' ? engine.creditedCents(inv.id) : 0,
    balanceCents: issued ? engine.balanceCents(inv) : null,
    paymentStatus: engine.paymentStatus(inv),
    hash: inv.hash, issuedAt: inv.issued_at, paStatus: inv.pa_status,
    lines: inv.lines.map(l => ({
      id: l.id, position: l.position, isSection: !!l.is_section, sageCode: l.sage_code, description: l.description,
      quantity: l.quantity, unitPrice: l.unit_price, vatRate: l.vat_rate, lineHtCents: l.line_ht_cents, creditOfLineId: l.credit_of_line_id,
    })),
  };
}

// ---------- réglages ----------

const SETTINGS_FIELDS = {
  legal_name: 'text', legal_form: 'text', share_capital: 'text', siren: 'siren', siret: 'siret', vat_number: 'text', rcs: 'text',
  address_line: 'text', postal_code: 'text', city: 'text', email: 'text', phone: 'text', iban: 'text', bic: 'text',
  late_penalty_text: 'text', footer_note: 'text', invoice_prefix: 'prefix', credit_prefix: 'prefix',
  default_vat_rate: 'vat', payment_terms_days: 'days', vat_on_debits: 'bool',
};

router.get('/settings', wrap((req, res) => {
  const s = engine.getSettings();
  const issuedCount = db.prepare("SELECT COUNT(*) c FROM native_invoices WHERE status='issued'").get().c;
  res.json({ settings: s, hasIssuedDocuments: issuedCount > 0 });
}));

router.put('/settings', wrap((req, res) => {
  const body = req.body || {};
  const current = engine.getSettings();
  const issuedCount = db.prepare("SELECT COUNT(*) c FROM native_invoices WHERE status='issued'").get().c;
  const sets = []; const vals = [];
  for (const [field, type] of Object.entries(SETTINGS_FIELDS)) {
    if (body[field] === undefined) continue;
    let v = body[field];
    if (type === 'text') v = String(v ?? '').trim() || null;
    if (type === 'siren') {
      v = String(v ?? '').replace(/\s/g, '');
      if (v && (!/^\d{9}$/.test(v) || !engine.luhnOk(v))) throw new engine.BillingError('SIREN invalide (9 chiffres, clé de contrôle).');
      v = v || null;
    }
    if (type === 'siret') {
      v = String(v ?? '').replace(/\s/g, '');
      if (v && (!/^\d{14}$/.test(v) || !engine.luhnOk(v))) throw new engine.BillingError('SIRET invalide (14 chiffres, clé de contrôle).');
      v = v || null;
    }
    if (type === 'prefix') {
      v = String(v ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{1,6}$/.test(v)) throw new engine.BillingError('Préfixe invalide (1 à 6 lettres/chiffres).');
      // Changer de préfixe en cours de route ne casse pas la continuité (séquence par type/année),
      // mais on l'interdit une fois des documents émis pour ne pas mélanger deux formats la même année.
      if (issuedCount > 0 && v !== current[field]) throw new engine.BillingError('Le préfixe ne peut plus être modifié : des documents ont déjà été émis.', 409);
    }
    if (type === 'vat') {
      v = Number(v);
      if (![0, 2.1, 5.5, 8.5, 10, 20].includes(v)) throw new engine.BillingError('Taux de TVA par défaut invalide.');
    }
    if (type === 'days') {
      v = parseInt(v, 10);
      // Plafond légal : 60 jours à compter de la date d'émission (ou 45 jours fin de mois) — art. L441-10 C. com.
      if (!Number.isInteger(v) || v < 0 || v > 60) throw new engine.BillingError('Délai de paiement : 0 à 60 jours (plafond légal, art. L441-10 du Code de commerce).');
    }
    if (type === 'bool') v = v ? 1 : 0;
    sets.push(`${field} = ?`); vals.push(v);
  }
  if (sets.length) db.prepare(`UPDATE billing_settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  res.json({ settings: engine.getSettings() });
}));

// ---------- BL facturables ----------

router.get('/clients/:id/invoiceable-orders', wrap((req, res) => {
  res.json({ orders: engine.listInvoiceableOrders(Number(req.params.id)) });
}));

// ---------- liste / détail ----------

router.get('/invoices', wrap((req, res) => {
  const where = []; const args = [];
  if (req.query.clientId) { where.push('client_id = ?'); args.push(Number(req.query.clientId)); }
  if (['draft', 'issued'].includes(req.query.status)) { where.push('status = ?'); args.push(req.query.status); }
  if (['invoice', 'credit_note'].includes(req.query.kind)) { where.push('kind = ?'); args.push(req.query.kind); }
  if (req.query.year) { where.push("substr(COALESCE(issue_date, created_at),1,4) = ?"); args.push(String(req.query.year)); }
  const rows = db.prepare(`SELECT id FROM native_invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(chain_no, 1e12) DESC, id DESC LIMIT 500`).all(...args);
  const names = new Map(db.prepare('SELECT id, societe FROM clients').all().map(c => [c.id, c.societe]));
  const invoices = rows.map(r => {
    const p = present(engine.loadInvoice(r.id));
    p.buyerName = p.buyerName || names.get(p.clientId) || '—';
    delete p.lines;
    return p;
  });
  res.json({ invoices });
}));

router.get('/invoices/:id', wrap((req, res) => {
  const inv = engine.loadInvoice(Number(req.params.id));
  if (!inv) throw new engine.BillingError('Facture introuvable.', 404);
  const out = present(inv);
  const names = db.prepare('SELECT societe FROM clients WHERE id = ?').get(inv.client_id);
  out.buyerName = out.buyerName || names?.societe || '—';
  if (inv.status === 'draft') out.preview = engine.previewDraft(inv.id);
  if (inv.status === 'issued' && inv.kind === 'invoice') {
    out.payments = db.prepare('SELECT id, paid_on AS paidOn, amount_cents AS amountCents, method, reference FROM native_payments WHERE invoice_id = ? ORDER BY paid_on, id').all(inv.id);
    out.creditNotes = db.prepare("SELECT id, number, issue_date AS issueDate, total_ttc_cents AS totalTtcCents FROM native_invoices WHERE credits_invoice_id = ? AND status='issued' ORDER BY chain_no").all(inv.id);
  }
  if (inv.credits_invoice_id) {
    out.creditsInvoiceNumber = db.prepare('SELECT number FROM native_invoices WHERE id = ?').get(inv.credits_invoice_id)?.number || null;
  }
  res.json({ invoice: out });
}));

// ---------- brouillons ----------

router.post('/invoices', wrap((req, res) => {
  const { clientId, orderIds, detailLevel, operationCategory, notes } = req.body || {};
  if (detailLevel && !['detail', 'per_bl', 'aggregated'].includes(detailLevel)) throw new engine.BillingError('Niveau de détail invalide.');
  const inv = engine.createDraftFromOrders(Number(clientId), (orderIds || []).map(Number), { detailLevel, operationCategory, notes });
  res.status(201).json({ invoice: present(inv) });
}));

router.put('/invoices/:id', wrap((req, res) => {
  const inv = engine.updateDraft(Number(req.params.id), req.body || {});
  res.json({ invoice: present(inv) });
}));

router.delete('/invoices/:id', wrap((req, res) => {
  engine.deleteDraft(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- émission ----------

router.post('/invoices/:id/issue', wrap((req, res) => {
  const issueDate = req.body?.issueDate || undefined;
  const inv = engine.issueInvoice(Number(req.params.id), { issueDate });
  res.json({ invoice: present(inv) });
}));

// ---------- avoirs ----------

router.post('/invoices/:id/credit-note', wrap((req, res) => {
  const { reason, full, lines } = req.body || {};
  const cn = engine.createCreditNoteDraft(Number(req.params.id), { reason, full: !!full, lines });
  res.status(201).json({ invoice: present(cn) });
}));

// ---------- règlements ----------

router.post('/invoices/:id/payments', wrap((req, res) => {
  const inv = engine.recordPayment(Number(req.params.id), req.body || {});
  res.status(201).json({ invoice: present(inv) });
}));

// ---------- PDF ----------

router.get('/invoices/:id/pdf', wrap(async (req, res) => {
  const inv = engine.loadInvoice(Number(req.params.id));
  if (!inv) throw new engine.BillingError('Facture introuvable.', 404);
  const preview = inv.status === 'draft' ? engine.previewDraft(inv.id) : null;
  const extra = {};
  if (inv.credits_invoice_id) extra.creditedInvoiceNumber = db.prepare('SELECT number FROM native_invoices WHERE id = ?').get(inv.credits_invoice_id)?.number;
  if (inv.status === 'issued' && inv.kind === 'invoice') { extra.paidCents = engine.paidCents(inv.id); extra.balanceCents = engine.balanceCents(inv); }
  const pdf = await buildInvoicePdf(inv, preview, extra);
  const name = inv.number ? `${inv.number}.pdf` : `brouillon-${inv.id}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.send(pdf);
}));

// ---------- contrôle d'intégrité et exports ----------

router.get('/integrity', wrap((req, res) => {
  res.json(engine.verifyIntegrity());
}));

router.get('/export/fec', wrap((req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  if (year < 2000 || year > 2100) throw new engine.BillingError('Année invalide.');
  const { content, rowCount, balanced } = buildFec(year);
  if (!balanced) throw new engine.BillingError('FEC déséquilibré : export refusé. Lancez le contrôle d\'intégrité.', 500);
  const siren = engine.sirenFrom(engine.getSettings().siren) || '000000000';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${siren}FEC${year}1231.txt"`);
  res.setHeader('X-Fec-Rows', String(rowCount));
  res.send(content);
}));

module.exports = router;
