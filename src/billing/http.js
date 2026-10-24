// Aides communes aux routes de facturation : gestion d'erreurs et présentation JSON.

const engine = require('./engine');

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.catch(e => fail(res, e));
  } catch (e) {
    fail(res, e);
  }
};

function fail(res, e) {
  if (e instanceof engine.BillingError || (e && e.name === 'StatsError')) return res.status(e.status).json({ error: e.message });
  // Violation d'un trigger d'inaltérabilité (dernier rempart) : message clair, pas une 500.
  if (e && /interdite|interdit/.test(e.message || '')) return res.status(409).json({ error: e.message });
  console.error('[billing]', e);
  return res.status(500).json({ error: 'Erreur serveur.' });
}

// Représentation JSON d'une facture ou d'un avoir pour l'écran.
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

function presentQuote(q) {
  return {
    id: q.id, status: q.status, number: q.number, clientId: q.client_id, buyerName: q.buyer?.name || null,
    issueDate: q.issue_date, validUntil: q.valid_until, reference: q.reference, notes: q.notes, operationCategory: q.operation_category,
    totalHtCents: q.total_ht_cents, totalVatCents: q.total_vat_cents, totalTtcCents: q.total_ttc_cents, vatBreakdown: q.vatBreakdown,
    invoiceId: q.invoice_id, decidedAt: q.decided_at,
    lines: q.lines.map(l => ({
      id: l.id, position: l.position, isSection: !!l.is_section, sageCode: l.sage_code, description: l.description,
      quantity: l.quantity, unitPrice: l.unit_price, vatRate: l.vat_rate, lineHtCents: l.line_ht_cents,
    })),
  };
}

module.exports = { wrap, fail, present, presentQuote };
