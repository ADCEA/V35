// Requêtes de lecture de la facturation : liste filtrable, tableau de bord,
// chronologie d'une facture, règlements. Aucune écriture ici.
//
// Les soldes sont calculés avec les mêmes règles que engine.balanceCents /
// engine.paymentStatus (total TTC − avoirs émis − règlements), mais en une seule
// requête agrégée plutôt qu'une lecture par facture.

const db = require('../db');
const engine = require('./engine');

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const BASE_SQL = `
  SELECT i.id, i.kind, i.status, i.number, i.client_id, i.credits_invoice_id, i.issue_date, i.due_date,
         i.reference, i.created_at, i.total_ht_cents, i.total_vat_cents, i.total_ttc_cents, i.is_full_credit,
         c.societe AS client_name,
         COALESCE((SELECT SUM(amount_cents) FROM native_payments p WHERE p.invoice_id = i.id), 0) AS paid_cents,
         COALESCE((SELECT SUM(total_ttc_cents) FROM native_invoices cn WHERE cn.credits_invoice_id = i.id AND cn.kind = 'credit_note' AND cn.status = 'issued'), 0) AS credited_cents,
         (SELECT MAX(p.paid_on) FROM native_payments p WHERE p.invoice_id = i.id) AS last_paid_on,
         (SELECT COUNT(*) FROM native_mail_log m WHERE m.invoice_id = i.id AND m.kind LIKE 'reminder-%' AND m.status IN ('sent','logged')) AS reminder_count,
         (SELECT MAX(m.sent_at) FROM native_mail_log m WHERE m.invoice_id = i.id AND m.kind LIKE 'reminder-%' AND m.status IN ('sent','logged')) AS last_reminder_at,
         (SELECT COUNT(*) FROM native_mail_log m WHERE m.invoice_id = i.id AND m.kind = 'invoice' AND m.status = 'sent') AS sent_count,
         ps.status AS pennylane_status
  FROM native_invoices i
  JOIN clients c ON c.id = i.client_id
  LEFT JOIN pennylane_sync ps ON ps.invoice_id = i.id
`;

// Enrichit une ligne SQL avec solde, retard et statut d'affichage.
function decorate(r, today) {
  const isInvoice = r.kind === 'invoice';
  const issued = r.status === 'issued';
  const balance = issued && isInvoice ? r.total_ttc_cents - r.credited_cents - r.paid_cents : 0;
  const overdueDays = issued && isInvoice && balance > 0 && r.due_date && r.due_date < today ? daysBetween(r.due_date, today) : 0;
  let display;
  if (r.status === 'draft') display = r.kind === 'credit_note' ? 'credit_draft' : 'draft';
  else if (!isInvoice) display = 'credit_note';
  else if (balance <= 0 && r.credited_cents >= r.total_ttc_cents) display = 'credited';
  else if (balance <= 0) display = 'paid';
  else if (overdueDays > 0) display = 'overdue';
  else if (r.paid_cents > 0) display = 'partial';
  else display = 'unpaid';
  return {
    id: r.id, kind: r.kind, status: r.status, number: r.number, clientId: r.client_id, clientName: r.client_name,
    creditsInvoiceId: r.credits_invoice_id, issueDate: r.issue_date, dueDate: r.due_date, reference: r.reference,
    createdAt: r.created_at, totalHtCents: r.total_ht_cents, totalVatCents: r.total_vat_cents, totalTtcCents: r.total_ttc_cents,
    paidCents: r.paid_cents, creditedCents: r.credited_cents, balanceCents: issued && isInvoice ? balance : null,
    lastPaidOn: r.last_paid_on, display, overdueDays,
    reminderCount: r.reminder_count, lastReminderAt: r.last_reminder_at, sentCount: r.sent_count,
    pennylaneStatus: r.pennylane_status || null,
  };
}

const TAB_TEST = {
  all: () => true,
  draft: (d) => d.status === 'draft',
  open: (d) => d.balanceCents > 0,                       // à encaisser (échues ou non)
  overdue: (d) => d.overdueDays > 0,
  paid: (d) => d.display === 'paid' || d.display === 'credited',
  credit_notes: (d) => d.kind === 'credit_note',
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const SORTERS = {
  date: (d) => d.issueDate || String(d.createdAt || '').slice(0, 10),
  number: (d) => d.number || '~',
  client: (d) => norm(d.clientName),
  amount: (d) => d.totalTtcCents * (d.kind === 'credit_note' ? -1 : 1),
  due: (d) => d.dueDate || '9999-12-31',
  balance: (d) => d.balanceCents ?? -1,
};

/** Toutes les factures émises qui ont un reste à payer (sans limite) : sert à préparer les prélèvements. */
function listOpen(today = engine.todayParis()) {
  return db.prepare(`${BASE_SQL} WHERE i.kind = 'invoice' AND i.status = 'issued'`).all().map(r => decorate(r, today)).filter(TAB_TEST.open);
}

/**
 * Liste des factures et avoirs.
 * f : { tab, clientId, q, from, to, sort, dir, limit, offset }
 * Les compteurs des onglets tiennent compte des filtres (client, recherche, dates) mais pas de l'onglet.
 */
function listInvoices(f = {}, today = engine.todayParis()) {
  let rows = db.prepare(BASE_SQL).all().map(r => decorate(r, today));
  if (f.clientId) rows = rows.filter(d => d.clientId === Number(f.clientId));
  const dateOf = SORTERS.date;
  if (f.from) rows = rows.filter(d => dateOf(d) >= f.from);
  if (f.to) rows = rows.filter(d => dateOf(d) <= f.to);
  if (f.q) {
    const terms = norm(f.q).split(/\s+/).filter(Boolean);
    rows = rows.filter(d => {
      const hay = norm(`${d.number || ''} ${d.clientName} ${d.reference || ''} ${(d.totalTtcCents / 100).toFixed(2)} ${(d.totalTtcCents / 100).toFixed(2).replace('.', ',')}`);
      return terms.every(t => hay.includes(t));
    });
  }

  const counts = {}; const sums = {};
  for (const [tab, test] of Object.entries(TAB_TEST)) {
    const sel = rows.filter(test);
    counts[tab] = sel.length;
    sums[tab] = sel.reduce((s, d) => s + (tab === 'open' || tab === 'overdue' ? d.balanceCents : d.totalTtcCents * (d.kind === 'credit_note' ? -1 : 1)), 0);
  }

  const test = TAB_TEST[f.tab] || TAB_TEST.all;
  let sel = rows.filter(test);
  const key = SORTERS[f.sort] || SORTERS.date;
  const dir = f.dir === 'asc' ? 1 : -1;
  sel.sort((a, b) => {
    const ka = key(a); const kb = key(b);
    if (ka < kb) return -dir; if (ka > kb) return dir;
    return b.id - a.id;
  });
  const total = sel.length;
  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(f.offset, 10) || 0, 0);
  return { invoices: sel.slice(offset, offset + limit), total, counts, sums };
}

// ---------- tableau de bord ----------

const monthOf = (iso) => String(iso || '').slice(0, 7);

function lastMonths(today, n) {
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function dashboard(today = engine.todayParis()) {
  const rows = db.prepare(BASE_SQL).all().map(r => decorate(r, today));
  const issued = rows.filter(d => d.status === 'issued');
  const sign = (d) => (d.kind === 'credit_note' ? -1 : 1);

  // Facturé / encaissé, par mois, sur 12 mois glissants
  const months = lastMonths(today, 12);
  const invoicedBy = new Map(months.map(m => [m, 0])); const collectedBy = new Map(months.map(m => [m, 0]));
  for (const d of issued) { const m = monthOf(d.issueDate); if (invoicedBy.has(m)) invoicedBy.set(m, invoicedBy.get(m) + sign(d) * d.totalHtCents); }
  for (const p of db.prepare('SELECT paid_on, amount_cents FROM native_payments').all()) {
    const m = monthOf(p.paid_on); if (collectedBy.has(m)) collectedBy.set(m, collectedBy.get(m) + p.amount_cents);
  }
  const series = months.map(m => ({ month: m, invoicedHtCents: invoicedBy.get(m), collectedCents: collectedBy.get(m) }));

  const thisMonth = months[months.length - 1]; const prevMonth = months[months.length - 2];
  const year = today.slice(0, 4);
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

  const open = issued.filter(d => d.balanceCents > 0);
  const overdue = open.filter(d => d.overdueDays > 0);

  // Âge des créances
  const buckets = [
    { key: 'notDue', label: 'Non échu', test: d => d.overdueDays === 0 },
    { key: 'd1_30', label: '1 à 30 j', test: d => d.overdueDays >= 1 && d.overdueDays <= 30 },
    { key: 'd31_60', label: '31 à 60 j', test: d => d.overdueDays >= 31 && d.overdueDays <= 60 },
    { key: 'd61_90', label: '61 à 90 j', test: d => d.overdueDays >= 61 && d.overdueDays <= 90 },
    { key: 'd90', label: '+ de 90 j', test: d => d.overdueDays > 90 },
  ].map(b => { const sel = open.filter(b.test); return { key: b.key, label: b.label, count: sel.length, cents: sum(sel, d => d.balanceCents) }; });

  // Plus gros encours par hôtel
  const byClient = new Map();
  for (const d of open) {
    const c = byClient.get(d.clientId) || { clientId: d.clientId, clientName: d.clientName, balanceCents: 0, overdueCents: 0, invoices: 0, oldestDue: null };
    c.balanceCents += d.balanceCents; c.invoices += 1;
    if (d.overdueDays > 0) c.overdueCents += d.balanceCents;
    if (d.dueDate && (!c.oldestDue || d.dueDate < c.oldestDue)) c.oldestDue = d.dueDate;
    byClient.set(d.clientId, c);
  }
  const topDebtors = [...byClient.values()].sort((a, b) => b.balanceCents - a.balanceCents).slice(0, 6);

  // Délai moyen de paiement sur les factures soldées (12 derniers mois)
  const since = months[0] + '-01';
  const paidInv = issued.filter(d => d.kind === 'invoice' && d.display === 'paid' && d.lastPaidOn && d.issueDate >= since);
  const dso = paidInv.length ? Math.round(sum(paidInv, d => daysBetween(d.issueDate, d.lastPaidOn)) / paidInv.length) : null;

  // BL livrés pas encore facturés
  const clientsWithDelivered = db.prepare("SELECT DISTINCT client_id FROM orders WHERE status = 'livree' AND client_id IS NOT NULL").all().map(r => r.client_id);
  let toInvoiceCount = 0; let toInvoiceCents = 0; let toInvoiceClients = 0;
  for (const cid of clientsWithDelivered) {
    const ids = engine.listInvoiceableOrders(cid).map(o => o.id);
    if (ids.length) { toInvoiceCount += ids.length; toInvoiceCents += engine.estimateOrdersHtCents(ids); toInvoiceClients += 1; }
  }

  const drafts = rows.filter(d => d.status === 'draft' && d.kind === 'invoice');
  const quotes = db.prepare("SELECT status, total_ttc_cents AS c, valid_until FROM native_quotes WHERE status IN ('issued','accepted')").all();
  const openQuotes = quotes.filter(q => q.status === 'issued');
  const acceptedQuotes = quotes.filter(q => q.status === 'accepted');

  const pennylane = db.prepare("SELECT status, COUNT(*) c FROM pennylane_sync GROUP BY status").all().reduce((o, r) => ({ ...o, [r.status]: r.c }), {});

  return {
    today,
    invoiced: {
      monthHtCents: invoicedBy.get(thisMonth), prevMonthHtCents: invoicedBy.get(prevMonth),
      yearHtCents: sum(issued.filter(d => (d.issueDate || '').startsWith(year)), d => sign(d) * d.totalHtCents),
    },
    collected: { monthCents: collectedBy.get(thisMonth), prevMonthCents: collectedBy.get(prevMonth) },
    open: { count: open.length, cents: sum(open, d => d.balanceCents) },
    overdue: { count: overdue.length, cents: sum(overdue, d => d.balanceCents) },
    aging: buckets, topDebtors, series, dsoDays: dso,
    toInvoice: { orders: toInvoiceCount, clients: toInvoiceClients, htCents: toInvoiceCents },
    drafts: { count: drafts.length, ttcCents: sum(drafts, d => d.totalTtcCents) },
    quotes: {
      open: { count: openQuotes.length, ttcCents: sum(openQuotes, q => q.c) },
      toInvoice: { count: acceptedQuotes.length, ttcCents: sum(acceptedQuotes, q => q.c) },
    },
    pennylane,
  };
}

// ---------- chronologie d'une facture ----------

const EVENT_LABEL = {
  draft_created: 'Brouillon créé',
  draft_updated: 'Brouillon modifié',
  credit_note_draft_created: "Brouillon d'avoir créé",
  issued: 'Émis',
  payment_recorded: 'Règlement enregistré',
  payment_reversed: 'Règlement annulé (écriture inverse)',
  pennylane_sent: 'Envoyé à Pennylane',
  pennylane_error: "Échec d'envoi à Pennylane",
};
const MAIL_LABEL = { invoice: 'Envoyée au client', 'reminder-1': 'Rappel amiable', 'reminder-2': 'Relance', 'reminder-3': 'Dernier rappel avant recouvrement', quote: 'Devis envoyé' };

function timeline(invoiceId) {
  const items = [];
  const fmtEur = (c) => (c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  for (const e of db.prepare('SELECT at, action, detail_json FROM billing_events WHERE invoice_id = ? ORDER BY id').all(invoiceId)) {
    let d = {}; try { d = JSON.parse(e.detail_json); } catch { /* détail illisible : ignoré */ }
    let detail = '';
    if (e.action === 'issued') detail = `${d.number} · empreinte ${String(d.hash || '').slice(0, 10)}…`;
    if (e.action.startsWith('payment_')) detail = `${fmtEur(Math.abs(d.amountCents || 0))} (${d.method || ''}) le ${d.paidOn || ''}`;
    if (e.action === 'pennylane_sent') detail = d.pennylaneId ? `Réf. Pennylane ${d.pennylaneId}` : '';
    if (e.action === 'pennylane_error') detail = d.error || '';
    if (e.action === 'credit_note_draft_created') detail = d.reason ? `Motif : ${d.reason}` : '';
    items.push({ at: e.at, type: e.action, label: EVENT_LABEL[e.action] || e.action, detail });
  }
  for (const m of db.prepare('SELECT sent_at, kind, channel, to_email, status, error FROM native_mail_log WHERE invoice_id = ? ORDER BY id').all(invoiceId)) {
    const at = m.sent_at.includes('T') ? m.sent_at : m.sent_at.replace(' ', 'T') + 'Z';
    const how = m.channel === 'manual' ? 'noté manuellement' : (m.status === 'failed' ? `ÉCHEC : ${m.error || 'envoi impossible'}` : `à ${m.to_email}`);
    items.push({ at, type: `mail:${m.kind}`, label: MAIL_LABEL[m.kind] || m.kind, detail: how, failed: m.status === 'failed' });
  }
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// ---------- règlements ----------

function listPayments({ from, to, q, limit = 300 } = {}) {
  const rows = db.prepare(`
    SELECT p.id, p.paid_on, p.amount_cents, p.method, p.reference, p.bank_fingerprint IS NOT NULL AS from_bank,
           i.id AS invoice_id, i.number, c.societe AS client_name
    FROM native_payments p JOIN native_invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id
    ORDER BY p.paid_on DESC, p.id DESC
  `).all().filter(r => (!from || r.paid_on >= from) && (!to || r.paid_on <= to)
    && (!q || norm(`${r.number} ${r.client_name} ${r.reference || ''}`).includes(norm(q))));
  return {
    payments: rows.slice(0, limit).map(r => ({ id: r.id, paidOn: r.paid_on, amountCents: r.amount_cents, method: r.method, reference: r.reference, fromBank: !!r.from_bank, invoiceId: r.invoice_id, number: r.number, clientName: r.client_name })),
    totalCents: rows.reduce((s, r) => s + r.amount_cents, 0), count: rows.length,
  };
}

module.exports = { listInvoices, listOpen, dashboard, timeline, listPayments, decorate, BASE_SQL, norm, daysBetween };
