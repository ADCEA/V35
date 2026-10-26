// Devis : document commercial, non comptable.
//
// Cycle : brouillon (libre) → finalisé (numéro DE-AAAA-NNNN, identités figées,
// validité) → accepté ou refusé → converti en brouillon de facture. Un devis
// finalisé ne se modifie plus : on en refait un autre.

const db = require('../db');
const engine = require('./engine');

const { BillingError } = engine;
const todayParis = engine.todayParis;
const VALID_DAYS = 30;

function loadQuote(id) {
  const q = db.prepare('SELECT * FROM native_quotes WHERE id = ?').get(id);
  if (!q) return null;
  q.kind = 'quote';
  q.lines = db.prepare('SELECT * FROM native_quote_lines WHERE quote_id = ? ORDER BY position').all(id);
  q.seller = q.seller_json ? JSON.parse(q.seller_json) : null;
  q.buyer = q.buyer_json ? JSON.parse(q.buyer_json) : null;
  q.terms = q.terms_json ? JSON.parse(q.terms_json) : null;
  q.vatBreakdown = JSON.parse(q.vat_breakdown_json || '[]');
  return q;
}

function insertQuoteLines(quoteId, lines, perLineCents) {
  const ins = db.prepare(`INSERT INTO native_quote_lines (quote_id, position, is_section, sage_code, description, quantity, unit_price, vat_rate, line_ht_cents)
                          VALUES (?,?,?,?,?,?,?,?,?)`);
  lines.forEach((l, i) => ins.run(quoteId, i + 1, l.isSection ? 1 : 0, l.sageCode || null, l.description,
    l.isSection ? 0 : l.quantity, l.isSection ? 0 : l.unitPrice, l.isSection ? 0 : l.vatRate, perLineCents[i]));
}

function writeLines(quoteId, rawLines) {
  const lines = engine.sanitizeLines(rawLines);
  if (!lines.some(l => !l.isSection)) throw new BillingError('Le devis doit contenir au moins une ligne chiffrée.');
  const t = engine.computeTotals(lines);
  db.prepare('DELETE FROM native_quote_lines WHERE quote_id = ?').run(quoteId);
  insertQuoteLines(quoteId, lines, t.lineCents);
  db.prepare('UPDATE native_quotes SET total_ht_cents=?, total_vat_cents=?, total_ttc_cents=?, vat_breakdown_json=? WHERE id=?')
    .run(t.totalHtCents, t.totalVatCents, t.totalTtcCents, JSON.stringify(t.breakdown), quoteId);
}

function assertDraft(q) {
  if (!q) throw new BillingError('Devis introuvable.', 404);
  if (q.status !== 'draft') throw new BillingError('Devis finalisé : modification interdite. Créez un nouveau devis.', 409);
}

function createQuote(clientId, rawLines, opts = {}) {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new BillingError('Hôtel introuvable.', 404);
  const category = opts.operationCategory || 'services';
  if (!['services', 'goods', 'mixed'].includes(category)) throw new BillingError("Catégorie d'opération invalide.");
  const id = db.transaction(() => {
    const info = db.prepare("INSERT INTO native_quotes (status, client_id, reference, notes, operation_category) VALUES ('draft',?,?,?,?)")
      .run(clientId, opts.reference ? String(opts.reference).slice(0, 250) : null, opts.notes || null, category);
    const qid = Number(info.lastInsertRowid);
    writeLines(qid, rawLines);
    engine.logEvent('quote_draft_created', null, { quoteId: qid, clientId });
    return qid;
  })();
  return loadQuote(id);
}

function updateQuote(id, patch) {
  const q = loadQuote(id);
  assertDraft(q);
  db.transaction(() => {
    if (patch.lines) writeLines(id, patch.lines);
    if (patch.operationCategory !== undefined) {
      if (!['services', 'goods', 'mixed'].includes(patch.operationCategory)) throw new BillingError("Catégorie d'opération invalide.");
      db.prepare('UPDATE native_quotes SET operation_category=? WHERE id=?').run(patch.operationCategory, id);
    }
    if (patch.reference !== undefined) db.prepare('UPDATE native_quotes SET reference=? WHERE id=?').run(patch.reference ? String(patch.reference).slice(0, 250) : null, id);
    if (patch.notes !== undefined) db.prepare('UPDATE native_quotes SET notes=? WHERE id=?').run(patch.notes || null, id);
    if (patch.issueDate !== undefined) {
      if (patch.issueDate !== null && !engine.isIsoDate(patch.issueDate)) throw new BillingError('Date du devis invalide.');
      db.prepare('UPDATE native_quotes SET issue_date=? WHERE id=?').run(patch.issueDate, id);
    }
    if (patch.validUntil !== undefined) {
      if (patch.validUntil !== null && !engine.isIsoDate(patch.validUntil)) throw new BillingError('Date de validité invalide.');
      db.prepare('UPDATE native_quotes SET valid_until=? WHERE id=?').run(patch.validUntil, id);
    }
  })();
  return loadQuote(id);
}

function deleteQuote(id) {
  const q = loadQuote(id);
  assertDraft(q);
  db.transaction(() => {
    db.prepare('DELETE FROM native_quotes WHERE id = ?').run(id);
    engine.logEvent('quote_draft_deleted', null, { quoteId: id });
  })();
}

function previewQuote(id) {
  const q = loadQuote(id);
  if (!q) throw new BillingError('Devis introuvable.', 404);
  const settings = engine.getSettings();
  const issueDate = q.issue_date || todayParis();
  const seller = engine.snapshotSeller(settings);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(q.client_id);
  const buyer = engine.snapshotBuyer(client);
  const terms = { ...engine.snapshotTerms(settings, issueDate, 'invoice', { client }) };
  delete terms.dueDate;
  const validUntil = q.valid_until || engine.addDays(issueDate, VALID_DAYS);
  terms.validUntil = validUntil;
  const problems = q.status === 'draft' ? missing(seller, buyer, q, issueDate, validUntil) : [];
  return { seller, buyer, terms, issueDate, validUntil, problems };
}

function missing(seller, buyer, q, issueDate, validUntil) {
  const p = [];
  if (!seller.legalName) p.push('Émetteur : raison sociale manquante (Réglages de facturation).');
  if (!(seller.address && seller.postalCode && seller.city)) p.push("Émetteur : adresse du siège incomplète.");
  if (engine.sirenFrom(seller.siren || seller.siret).length !== 9) p.push('Émetteur : SIREN manquant.');
  if (!buyer.name) p.push('Client : dénomination manquante.');
  if (!buyer.address) p.push('Client : adresse manquante.');
  if (!engine.isIsoDate(issueDate)) p.push('Date du devis invalide.');
  if (validUntil < issueDate) p.push('La date de validité précède la date du devis.');
  if (!q.lines.some(l => !l.is_section)) p.push('Aucune ligne chiffrée.');
  return p;
}

function issueQuote(id, opts = {}) {
  const run = db.transaction(() => {
    const q = loadQuote(id);
    assertDraft(q);
    const issueDate = opts.issueDate || q.issue_date || todayParis();
    const prev = previewQuote(id);
    const validUntil = opts.validUntil || q.valid_until || engine.addDays(issueDate, VALID_DAYS);
    const problems = missing(prev.seller, prev.buyer, q, issueDate, validUntil);
    if (problems.length) throw new BillingError(`Finalisation impossible :\n- ${problems.join('\n- ')}`, 422);

    const year = Number(issueDate.slice(0, 4));
    const seqKey = `quote-${year}`;
    db.prepare('INSERT OR IGNORE INTO native_invoice_seq (seq_key, value) VALUES (?, 0)').run(seqKey);
    db.prepare('UPDATE native_invoice_seq SET value = value + 1 WHERE seq_key = ?').run(seqKey);
    const seqNo = db.prepare('SELECT value FROM native_invoice_seq WHERE seq_key = ?').get(seqKey).value;
    const number = `DE-${year}-${String(seqNo).padStart(4, '0')}`;
    const terms = { ...prev.terms, validUntil };

    db.prepare(`UPDATE native_quotes SET status='issued', number=?, seq_year=?, seq_no=?, issue_date=?, valid_until=?, seller_json=?, buyer_json=?, terms_json=? WHERE id=?`)
      .run(number, year, seqNo, issueDate, validUntil, JSON.stringify(prev.seller), JSON.stringify(prev.buyer), JSON.stringify(terms), id);
    engine.logEvent('quote_issued', null, { quoteId: id, number, totalTtcCents: q.total_ttc_cents });
  });
  run.immediate();
  return loadQuote(id);
}

function decideQuote(id, decision) {
  if (!['accepted', 'refused'].includes(decision)) throw new BillingError('Décision invalide.');
  const q = loadQuote(id);
  if (!q) throw new BillingError('Devis introuvable.', 404);
  if (q.status !== 'issued' && !(q.status === 'accepted' && decision === 'refused') && !(q.status === 'refused' && decision === 'accepted')) {
    throw new BillingError('Seul un devis finalisé, non encore converti, peut être accepté ou refusé.', 409);
  }
  db.prepare('UPDATE native_quotes SET status=?, decided_at=? WHERE id=?').run(decision, new Date().toISOString(), id);
  engine.logEvent(`quote_${decision}`, null, { quoteId: id, number: q.number });
  return loadQuote(id);
}

/** Crée le brouillon de facture correspondant (devis accepté ou finalisé). */
function convertToInvoice(id) {
  const q = loadQuote(id);
  if (!q) throw new BillingError('Devis introuvable.', 404);
  if (q.status === 'invoiced') throw new BillingError('Ce devis a déjà été converti en facture.', 409);
  if (!['issued', 'accepted'].includes(q.status)) throw new BillingError('Seul un devis finalisé ou accepté peut être converti en facture.', 409);
  const inv = db.transaction(() => {
    const draft = engine.createDraftFromLines(q.client_id, q.lines.map(l => ({
      isSection: !!l.is_section, description: l.description, sageCode: l.sage_code, quantity: l.quantity, unitPrice: l.unit_price, vatRate: l.vat_rate,
    })), { operationCategory: q.operation_category, reference: `Devis ${q.number}${q.reference ? ' — ' + q.reference : ''}`, notes: q.notes, fromQuote: q.number });
    db.prepare("UPDATE native_quotes SET status='invoiced', invoice_id=?, decided_at=COALESCE(decided_at, ?) WHERE id=?").run(draft.id, new Date().toISOString(), id);
    engine.logEvent('quote_invoiced', draft.id, { quoteId: id, number: q.number });
    return draft;
  })();
  return inv;
}

function listQuotes({ status, clientId, q: search } = {}, today = todayParis()) {
  const rows = db.prepare(`
    SELECT n.id, n.status, n.number, n.client_id, c.societe AS client_name, n.issue_date, n.valid_until, n.reference,
           n.total_ht_cents, n.total_ttc_cents, n.invoice_id, n.created_at,
           (SELECT number FROM native_invoices WHERE id = n.invoice_id) AS invoice_number
    FROM native_quotes n JOIN clients c ON c.id = n.client_id
    ORDER BY COALESCE(n.issue_date, substr(n.created_at,1,10)) DESC, n.id DESC
  `).all().map(r => ({
    id: r.id, status: r.status, number: r.number, clientId: r.client_id, clientName: r.client_name, issueDate: r.issue_date,
    validUntil: r.valid_until, reference: r.reference, totalHtCents: r.total_ht_cents, totalTtcCents: r.total_ttc_cents,
    invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, createdAt: r.created_at,
    expired: r.status === 'issued' && !!r.valid_until && r.valid_until < today,
  }));
  const needle = String(search || '').toLowerCase();
  const filtered = rows.filter(r => (!clientId || r.clientId === Number(clientId))
    && (!needle || `${r.number || ''} ${r.clientName} ${r.reference || ''}`.toLowerCase().includes(needle)));
  const counts = { all: filtered.length };
  for (const k of ['draft', 'issued', 'accepted', 'refused', 'invoiced']) counts[k] = filtered.filter(r => r.status === k).length;
  return { quotes: status && status !== 'all' ? filtered.filter(r => r.status === status) : filtered, counts };
}

module.exports = { loadQuote, createQuote, updateQuote, deleteQuote, previewQuote, issueQuote, decideQuote, convertToInvoice, listQuotes, VALID_DAYS };
