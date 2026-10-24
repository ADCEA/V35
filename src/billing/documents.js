// Fabrication des PDF de documents (facture, avoir, devis) — un seul endroit pour
// l'écran, l'envoi par e-mail, le portail client et l'envoi à Pennylane.

const db = require('../db');
const engine = require('./engine');
const quotes = require('./quotes');
const { buildInvoicePdf } = require('./pdf');

async function invoicePdf(invoiceId) {
  const inv = engine.loadInvoice(invoiceId);
  if (!inv) throw new engine.BillingError('Facture introuvable.', 404);
  const preview = inv.status === 'draft' ? engine.previewDraft(inv.id) : null;
  const extra = {};
  if (inv.credits_invoice_id) extra.creditedInvoiceNumber = db.prepare('SELECT number FROM native_invoices WHERE id = ?').get(inv.credits_invoice_id)?.number;
  if (inv.status === 'issued' && inv.kind === 'invoice') { extra.paidCents = engine.paidCents(inv.id); extra.balanceCents = engine.balanceCents(inv); }
  const buffer = await buildInvoicePdf(inv, preview, extra);
  return { buffer, inv, filename: inv.number ? `${inv.number}.pdf` : `brouillon-${inv.id}.pdf` };
}

async function quotePdf(quoteId) {
  const q = quotes.loadQuote(quoteId);
  if (!q) throw new engine.BillingError('Devis introuvable.', 404);
  const preview = q.status === 'draft' ? quotes.previewQuote(q.id) : null;
  const buffer = await buildInvoicePdf(q, preview, {});
  return { buffer, quote: q, filename: q.number ? `${q.number}.pdf` : `devis-brouillon-${q.id}.pdf` };
}

module.exports = { invoicePdf, quotePdf };
