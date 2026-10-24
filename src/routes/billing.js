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
const lock = require('../billing/lock');
const backup = require('../backup');
const queries = require('../billing/queries');
const mail = require('../billing/mail');
const docs = require('../billing/documents');
const pennylane = require('../billing/pennylane');
const { wrap, present } = require('../billing/http');

const router = express.Router();
router.use(requireAdmin);
// Verrou propre à la Facturation (code distinct du mot de passe admin) : les
// routes /lock/* restent accessibles verrouillées, tout le reste exige un
// déverrouillage récent. Les actes sensibles exigent en plus une ressaisie.
router.use('/lock', lock.router);
router.use(lock.requireUnlocked);

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

router.put('/settings', lock.requireStepUp('settings'), wrap((req, res) => {
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

// ---------- tableau de bord, liste, détail ----------

router.get('/dashboard', wrap((req, res) => {
  const d = queries.dashboard();
  d.backup = (() => { const b = backup.getStatus(); return { health: b.health, message: b.message }; })();
  d.reminders = { due: mail.remindersOverview().filter(x => x.suggestedLevel).length };
  res.json(d);
}));

router.get('/invoices', wrap((req, res) => {
  const q = req.query;
  const tab = ['all', 'draft', 'open', 'overdue', 'paid', 'credit_notes'].includes(q.tab) ? q.tab : 'all';
  res.json(queries.listInvoices({
    tab, clientId: q.clientId, q: q.q ? String(q.q).slice(0, 80) : '',
    from: engine.isIsoDate(q.from) ? q.from : undefined, to: engine.isIsoDate(q.to) ? q.to : undefined,
    sort: q.sort, dir: q.dir, limit: q.limit, offset: q.offset,
  }));
}));

router.get('/invoices/:id', wrap((req, res) => {
  const inv = engine.loadInvoice(Number(req.params.id));
  if (!inv) throw new engine.BillingError('Facture introuvable.', 404);
  const out = present(inv);
  const client = db.prepare('SELECT societe, email FROM clients WHERE id = ?').get(inv.client_id);
  out.buyerName = out.buyerName || client?.societe || '—';
  out.clientEmail = client?.email || '';
  if (inv.status === 'draft') out.preview = engine.previewDraft(inv.id);
  if (inv.status === 'issued' && inv.kind === 'invoice') {
    out.payments = db.prepare('SELECT id, paid_on AS paidOn, amount_cents AS amountCents, method, reference FROM native_payments WHERE invoice_id = ? ORDER BY paid_on, id').all(inv.id);
    out.creditNotes = db.prepare("SELECT id, number, issue_date AS issueDate, total_ttc_cents AS totalTtcCents FROM native_invoices WHERE credits_invoice_id = ? AND status='issued' ORDER BY chain_no").all(inv.id);
    out.overdueDays = inv.due_date && inv.due_date < engine.todayParis() && out.balanceCents > 0 ? queries.daysBetween(inv.due_date, engine.todayParis()) : 0;
  }
  if (inv.credits_invoice_id) {
    out.creditsInvoiceNumber = db.prepare('SELECT number FROM native_invoices WHERE id = ?').get(inv.credits_invoice_id)?.number || null;
  }
  out.timeline = queries.timeline(inv.id);
  out.pennylane = db.prepare('SELECT status, attempts, last_error AS lastError, pennylane_id AS pennylaneId, sent_at AS sentAt FROM pennylane_sync WHERE invoice_id = ?').get(inv.id) || null;
  res.json({ invoice: out });
}));

// ---------- brouillons ----------

router.post('/invoices', wrap((req, res) => {
  const { clientId, orderIds, detailLevel, operationCategory, notes } = req.body || {};
  if (detailLevel && !['detail', 'per_bl', 'aggregated'].includes(detailLevel)) throw new engine.BillingError('Niveau de détail invalide.');
  const inv = engine.createDraftFromOrders(Number(clientId), (orderIds || []).map(Number), { detailLevel, operationCategory, notes });
  res.status(201).json({ invoice: present(inv) });
}));

// Facture libre (sans BL) : prestation ponctuelle.
router.post('/invoices/free', wrap((req, res) => {
  const { clientId, lines, operationCategory, reference, notes } = req.body || {};
  const inv = engine.createDraftFromLines(Number(clientId), lines, { operationCategory, reference, notes });
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

router.post('/invoices/:id/issue', lock.requireStepUp(req => `issue:${req.params.id}`), wrap((req, res) => {
  const issueDate = req.body?.issueDate || undefined;
  const inv = engine.issueInvoice(Number(req.params.id), { issueDate });
  pennylane.kickAuto();
  res.json({ invoice: present(inv) });
}));

// ---------- avoirs ----------

router.post('/invoices/:id/credit-note', lock.requireStepUp(req => `credit:${req.params.id}`), wrap((req, res) => {
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
  const { buffer, filename } = await docs.invoicePdf(Number(req.params.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
}));

// ---------- envoi par e-mail et relances ----------

router.get('/invoices/:id/mail-preview', wrap((req, res) => {
  const inv = engine.loadInvoice(Number(req.params.id));
  if (!inv) throw new engine.BillingError('Facture introuvable.', 404);
  if (inv.status !== 'issued') throw new engine.BillingError("Seul un document émis peut être envoyé.");
  const kind = ['invoice', 'reminder-1', 'reminder-2', 'reminder-3'].includes(req.query.kind) ? req.query.kind : 'invoice';
  const client = db.prepare('SELECT societe, email FROM clients WHERE id = ?').get(inv.client_id);
  res.json({ ...mail.render(kind, inv, client?.societe), to: client?.email || '', smtp: require('../utils/mailer').isConfigured() });
}));

router.post('/invoices/:id/send', wrap(async (req, res) => {
  const r = await mail.sendInvoice(Number(req.params.id), req.body || {});
  res.json({ ok: true, to: r.to });
}));

router.post('/invoices/:id/remind', wrap(async (req, res) => {
  const r = await mail.sendReminder(Number(req.params.id), req.body || {});
  res.json({ ok: true, ...r });
}));

router.get('/reminders', wrap((req, res) => {
  res.json({ invoices: mail.remindersOverview(), smtp: require('../utils/mailer').isConfigured() });
}));

// ---------- contrôle d'intégrité et exports ----------

router.get('/integrity', wrap((req, res) => {
  res.json(engine.verifyIntegrity());
}));

router.get('/export/fec', lock.requireStepUp(req => `fec:${parseInt(req.query.year, 10) || new Date().getFullYear()}`), wrap((req, res) => {
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

// ---------- sauvegardes ----------

router.get('/backup/status', wrap((req, res) => { res.json(backup.getStatus()); }));

router.post('/backup/run', wrap(async (req, res) => {
  try {
    const run = await backup.runBackup({ trigger: 'manual' });
    res.json({ ok: true, status: run.status, status_detail: backup.getStatus() });
  } catch (e) {
    res.status(500).json({ error: `Sauvegarde impossible : ${e.message}` });
  }
}));

// Téléchargement d'une copie (chiffrée si BACKUP_PASSPHRASE est définie) : ressaisie du code exigée.
router.get('/backup/:id/download', lock.requireStepUp(req => `backup:${req.params.id}`), wrap((req, res) => {
  const f = backup.localFilePath(Number(req.params.id));
  if (!f) throw new engine.BillingError('Fichier de sauvegarde introuvable (purgé ?).', 404);
  res.download(f.path, f.name);
}));

// ---------- Pennylane ----------

router.get('/pennylane/status', wrap((req, res) => { res.json(pennylane.getStatus()); }));

router.post('/pennylane/test', wrap(async (req, res) => { res.json(await pennylane.testConnection()); }));

// Envoi immédiat d'une sélection de documents émis (20 au plus à la fois).
router.post('/pennylane/send', wrap(async (req, res) => {
  const ids = ((req.body || {}).invoiceIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw new engine.BillingError('Sélectionnez au moins un document.');
  if (ids.length > 20) throw new engine.BillingError('20 documents au plus par envoi (les suivants peuvent être envoyés ensuite).');
  const results = [];
  for (const id of ids) {
    const r = await pennylane.sendOne(id);
    results.push({ invoiceId: id, status: r.status, error: r.last_error || null });
  }
  res.json({ results });
}));

router.post('/pennylane/retry', wrap(async (req, res) => {
  const n = pennylane.retryFailed();
  pennylane.kickAuto(true);
  res.json({ requeued: n });
}));

router.post('/pennylane/auto', lock.requireStepUp('pennylane-auto'), wrap((req, res) => {
  const enabled = Boolean((req.body || {}).enabled);
  if (enabled && !pennylane.config().configured) throw new engine.BillingError("Renseignez d'abord PENNYLANE_API_TOKEN sur le serveur.", 503);
  pennylane.setAuto(enabled);
  res.json(pennylane.getStatus());
}));

// Ventes : encaissements, rapprochement, facturation en lot, devis.
router.use(require('./billingSales'));
router.use(require('./billingCatalog'));
router.use(require('./billingDeliveries'));
router.use(require('./billingDaily'));

module.exports = router;
