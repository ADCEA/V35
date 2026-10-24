// Routes « ventes » de la facturation : encaissements et rapprochement bancaire,
// facturation en lot, devis. Montées par routes/billing.js APRÈS le verrou.

const express = require('express');
const db = require('../db');
const engine = require('../billing/engine');
const queries = require('../billing/queries');
const bank = require('../billing/bank');
const bulkPayments = require('../billing/bulkPayments');
const batch = require('../billing/batch');
const quotes = require('../billing/quotes');
const mail = require('../billing/mail');
const docs = require('../billing/documents');
const lock = require('../billing/lock');
const pennylane = require('../billing/pennylane');
const { wrap, present, presentQuote } = require('../billing/http');

const router = express.Router();
const iso = (s) => (engine.isIsoDate(s) ? s : undefined);
// Les aperçus sont libres ; l'enregistrement exige la ressaisie du code de la Facturation.
const stepUpWhen = (pred, scopeOf) => (req, res, next) => (pred(req) ? lock.requireStepUp(scopeOf)(req, res, next) : next());
const applying = (req) => !!(req.body && req.body.apply);

// ---------- encaissements ----------

router.get('/payments', wrap((req, res) => {
  res.json(queries.listPayments({ from: iso(req.query.from), to: iso(req.query.to), q: req.query.q ? String(req.query.q).slice(0, 80) : '' }));
}));

// Lecture d'un relevé CSV (envoyé en texte dans le JSON) + propositions de rapprochement.
router.post('/reconcile/parse', wrap((req, res) => {
  const { csv, mapping } = req.body || {};
  if (typeof csv !== 'string' || csv.length > 3_000_000) throw new engine.BillingError('Relevé absent ou trop volumineux (3 Mo maximum).');
  const parsed = bank.parseBankCsv(csv, mapping || {});
  const lines = parsed.complete ? bank.matchLines(parsed.lines) : [];
  res.json({
    delimiter: parsed.delimiter, headerRow: parsed.headerRow, headers: parsed.headers, mapping: parsed.mapping,
    complete: parsed.complete, sample: parsed.sample, lines,
    skippedDebits: parsed.lines.filter(l => l.amountCents < 0).length,
  });
}));

router.post('/reconcile/apply', wrap((req, res) => {
  const results = bank.apply((req.body || {}).items);
  res.json({ results, applied: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
}));

// Règlements en lot : plusieurs factures soldées d'un coup (prélèvements déjà passés, lot de chèques…).
// Sans « apply » : aperçu seulement. Avec « apply » : tout est enregistré, ou rien.
router.post('/payments/bulk', stepUpWhen(applying, 'payments-bulk'), wrap((req, res) => {
  if (applying(req)) {
    const r = bulkPayments.apply(req.body);
    res.status(201).json(r);
  } else res.json(bulkPayments.preview(req.body));
}));

// ---------- facturation en lot ----------

router.get('/batch/preview', wrap((req, res) => {
  res.json({ clients: batch.preview(iso(req.query.upTo)) });
}));

router.post('/batch/drafts', wrap((req, res) => {
  const { clientIds, upTo } = req.body || {};
  res.json({ results: batch.createDrafts({ clientIds, upTo: iso(upTo) }) });
}));

router.post('/batch/issue', lock.requireStepUp('batch-issue'), wrap((req, res) => {
  const { invoiceIds, issueDate } = req.body || {};
  const results = batch.issueMany({ invoiceIds, issueDate: iso(issueDate) });
  pennylane.kickAuto();
  res.json({ results });
}));

// ---------- devis ----------

router.get('/quotes', wrap((req, res) => {
  res.json(quotes.listQuotes({ status: req.query.status, clientId: req.query.clientId, q: req.query.q }));
}));

router.post('/quotes', wrap((req, res) => {
  const { clientId, lines, operationCategory, reference, notes } = req.body || {};
  res.status(201).json({ quote: presentQuote(quotes.createQuote(Number(clientId), lines, { operationCategory, reference, notes })) });
}));

function quoteOut(id) {
  const q = quotes.loadQuote(id);
  if (!q) throw new engine.BillingError('Devis introuvable.', 404);
  const out = presentQuote(q);
  const client = db.prepare('SELECT societe, email FROM clients WHERE id = ?').get(q.client_id);
  out.buyerName = out.buyerName || client?.societe || '—';
  out.clientEmail = client?.email || '';
  if (q.status === 'draft') out.preview = quotes.previewQuote(q.id);
  if (q.invoice_id) out.invoiceNumber = db.prepare('SELECT number FROM native_invoices WHERE id = ?').get(q.invoice_id)?.number || null;
  out.mails = db.prepare("SELECT sent_at AS sentAt, to_email AS toEmail, status, error FROM native_mail_log WHERE quote_id = ? ORDER BY id").all(q.id);
  return out;
}

router.get('/quotes/:id', wrap((req, res) => { res.json({ quote: quoteOut(Number(req.params.id)) }); }));

router.put('/quotes/:id', wrap((req, res) => {
  quotes.updateQuote(Number(req.params.id), req.body || {});
  res.json({ quote: quoteOut(Number(req.params.id)) });
}));

router.delete('/quotes/:id', wrap((req, res) => { quotes.deleteQuote(Number(req.params.id)); res.json({ ok: true }); }));

router.post('/quotes/:id/issue', wrap((req, res) => {
  const { issueDate, validUntil } = req.body || {};
  quotes.issueQuote(Number(req.params.id), { issueDate: iso(issueDate), validUntil: iso(validUntil) });
  res.json({ quote: quoteOut(Number(req.params.id)) });
}));

router.post('/quotes/:id/decision', wrap((req, res) => {
  quotes.decideQuote(Number(req.params.id), (req.body || {}).decision);
  res.json({ quote: quoteOut(Number(req.params.id)) });
}));

router.post('/quotes/:id/convert', wrap((req, res) => {
  const inv = quotes.convertToInvoice(Number(req.params.id));
  res.status(201).json({ invoice: present(inv), quote: quoteOut(Number(req.params.id)) });
}));

router.get('/quotes/:id/pdf', wrap(async (req, res) => {
  const { buffer, filename } = await docs.quotePdf(Number(req.params.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
}));

router.get('/quotes/:id/mail-preview', wrap((req, res) => {
  const q = quotes.loadQuote(Number(req.params.id));
  if (!q) throw new engine.BillingError('Devis introuvable.', 404);
  if (q.status === 'draft') throw new engine.BillingError('Finalisez le devis avant de l\'envoyer.');
  const client = db.prepare('SELECT email FROM clients WHERE id = ?').get(q.client_id);
  res.json({ ...mail.renderQuote(q), to: client?.email || '', smtp: require('../utils/mailer').isConfigured() });
}));

router.post('/quotes/:id/send', wrap(async (req, res) => {
  const r = await mail.sendQuote(Number(req.params.id), req.body || {});
  res.json({ ok: true, to: r.to });
}));

module.exports = router;
