// Export FEC (Fichier des Écritures Comptables) à partir de la facturation
// intégrée : ventes (journal VT) et règlements (journal BQ).
//
// Format : 18 colonnes séparées par des tabulations, encodage UTF-8, dates
// AAAAMMJJ, montants à virgule décimale (art. A47 A-1 du LPF).
//
// Les numéros de comptes ci-dessous sont les comptes usuels du PCG. Si votre
// expert-comptable utilise d'autres comptes (ex. 70601 au lieu de 706000),
// ne changez que les constantes du bloc ACCOUNTS.

const db = require('../db');

const ACCOUNTS = {
  customer: '411',           // collectif clients ; le tiers va en CompAuxNum (411 + id)
  salesServices: '706000',   // prestations de services
  salesGoods: '707000',      // ventes de marchandises
  vatCollected: '445710',    // TVA collectée
  bank: '512000',
  discountGranted: '665000', // escomptes accordés (charge financière)
};

const COLUMNS = [
  'JournalCode', 'JournalLib', 'EcritureNum', 'EcritureDate', 'CompteNum', 'CompteLib',
  'CompAuxNum', 'CompAuxLib', 'PieceRef', 'PieceDate', 'EcritureLib', 'Debit', 'Credit',
  'EcritureLet', 'DateLet', 'ValidDate', 'Montantdevise', 'Idevise',
];

const ymd = (iso) => String(iso || '').slice(0, 10).replace(/-/g, '');
const amount = (cents) => (cents / 100).toFixed(2).replace('.', ',');
// Les champs libres ne doivent pas casser le tableau : ni tabulation, ni retour ligne.
const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function validIso(d) {
  if (!ISO.test(String(d))) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

/**
 * Période d'un export : une année civile (nombre ou « 2026 »), ou { from, to } en AAAA-MM-JJ, bornes incluses.
 * Renvoie { from, to } ou lève une erreur au message lisible.
 */
function resolvePeriod(arg) {
  let from; let to;
  if (arg && typeof arg === 'object') { from = String(arg.from || ''); to = String(arg.to || ''); }
  else {
    const year = Number(arg);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Année invalide.');
    from = `${year}-01-01`; to = `${year}-12-31`;
  }
  if (!validIso(from) || !validIso(to)) throw new Error('Dates invalides : utilisez le format AAAA-MM-JJ.');
  if (from < '2000-01-01' || to > '2100-12-31') throw new Error('Période hors limites (2000 à 2100).');
  if (from > to) throw new Error('La date de début doit être antérieure ou égale à la date de fin.');
  return { from, to };
}

/**
 * Écritures de la période [from, to] (bornes incluses). Ne reprend que des documents VALIDÉS (émis) :
 * un brouillon n'a ni numéro ni date d'émission, il n'entre jamais dans un FEC. Les règlements repris
 * sont ceux dont la date tombe dans la période, rattachés à une facture émise.
 * Argument : année (compatibilité) ou { from, to }.
 */
function buildFec(period) {
  const { from, to } = resolvePeriod(period);
  const rows = [];
  let ecritureNum = 0;
  let invoiceCount = 0; let creditCount = 0; let paymentCount = 0; let discountCount = 0;

  const docs = db.prepare(`
    SELECT i.*, c.societe FROM native_invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.status = 'issued' AND i.issue_date BETWEEN ? AND ?
    ORDER BY i.chain_no
  `).all(from, to);

  for (const inv of docs) {
    ecritureNum += 1;
    const isCredit = inv.kind === 'credit_note';
    if (isCredit) creditCount += 1; else invoiceCount += 1;
    const breakdown = JSON.parse(inv.vat_breakdown_json || '[]');
    const aux = `${ACCOUNTS.customer}${String(inv.client_id).padStart(5, '0')}`;
    const lib = `${isCredit ? 'Avoir' : 'Facture'} ${inv.number} ${inv.societe}`;
    const salesAccount = inv.operation_category === 'goods' ? ACCOUNTS.salesGoods : ACCOUNTS.salesServices;
    const salesLabel = inv.operation_category === 'goods' ? 'Ventes de marchandises' : 'Prestations de services';
    const common = {
      JournalCode: 'VT', JournalLib: 'Journal des ventes', EcritureNum: ecritureNum,
      EcritureDate: ymd(inv.issue_date), PieceRef: inv.number, PieceDate: ymd(inv.issue_date),
      EcritureLib: lib, ValidDate: ymd(inv.issued_at),
    };
    // Facture : débit client / crédit ventes et TVA. Avoir : l'inverse.
    const side = (cents, debitSide) => (debitSide ? { Debit: amount(cents), Credit: '0,00' } : { Debit: '0,00', Credit: amount(cents) });
    rows.push({ ...common, CompteNum: ACCOUNTS.customer, CompteLib: 'Clients', CompAuxNum: aux, CompAuxLib: inv.societe, ...side(inv.total_ttc_cents, !isCredit) });
    rows.push({ ...common, CompteNum: salesAccount, CompteLib: salesLabel, CompAuxNum: '', CompAuxLib: '', ...side(inv.total_ht_cents, isCredit) });
    for (const b of breakdown) {
      if (b.vatCents === 0) continue;
      rows.push({ ...common, CompteNum: ACCOUNTS.vatCollected, CompteLib: `TVA collectée ${b.rate} %`, CompAuxNum: '', CompAuxLib: '', ...side(b.vatCents, isCredit) });
    }
  }

  const payments = db.prepare(`
    SELECT p.*, i.number, i.client_id, c.societe FROM native_payments p
    JOIN native_invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id
    WHERE i.status = 'issued' AND p.paid_on BETWEEN ? AND ? AND p.method <> 'escompte' ORDER BY p.paid_on, p.id
  `).all(from, to);
  for (const p of payments) {
    ecritureNum += 1; paymentCount += 1;
    const reversal = p.amount_cents < 0;
    const abs = Math.abs(p.amount_cents);
    const common = {
      JournalCode: 'BQ', JournalLib: 'Journal de banque', EcritureNum: ecritureNum,
      EcritureDate: ymd(p.paid_on), PieceRef: p.reference || p.number, PieceDate: ymd(p.paid_on),
      EcritureLib: `${reversal ? 'Annulation règlement' : 'Règlement'} ${p.number} ${p.societe}`, ValidDate: ymd(p.created_at),
    };
    const aux = `${ACCOUNTS.customer}${String(p.client_id).padStart(5, '0')}`;
    const side = (cents, debitSide) => (debitSide ? { Debit: amount(cents), Credit: '0,00' } : { Debit: '0,00', Credit: amount(cents) });
    rows.push({ ...common, CompteNum: ACCOUNTS.bank, CompteLib: 'Banque', CompAuxNum: '', CompAuxLib: '', ...side(abs, !reversal) });
    rows.push({ ...common, CompteNum: ACCOUNTS.customer, CompteLib: 'Clients', CompAuxNum: aux, CompAuxLib: p.societe, ...side(abs, reversal) });
  }

  // Escomptes pour règlement anticipé : opérations diverses. L'escompte réduit la base de TVA
  // (art. 267-II-1° CGI) : débit 665 (HT) et TVA collectée, crédit du compte client (TTC).
  // Une annulation d'escompte passe les mêmes écritures en sens inverse.
  const discounts = db.prepare(`
    SELECT p.*, i.number, i.client_id, c.societe FROM native_payments p
    JOIN native_invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id
    WHERE i.status = 'issued' AND p.paid_on BETWEEN ? AND ? AND p.method = 'escompte' ORDER BY p.paid_on, p.id
  `).all(from, to);
  for (const p of discounts) {
    ecritureNum += 1; discountCount += 1;
    const reversal = p.amount_cents < 0;
    const ht = Math.abs(p.discount_ht_cents ?? p.amount_cents);
    const vat = Math.abs(p.discount_vat_cents ?? 0);
    const ttc = Math.abs(p.amount_cents);
    const common = {
      JournalCode: 'OD', JournalLib: 'Opérations diverses', EcritureNum: ecritureNum,
      EcritureDate: ymd(p.paid_on), PieceRef: p.number, PieceDate: ymd(p.paid_on),
      EcritureLib: `${reversal ? 'Annulation escompte' : 'Escompte accordé'} ${p.number} ${p.societe}`, ValidDate: ymd(p.created_at),
    };
    const aux = `${ACCOUNTS.customer}${String(p.client_id).padStart(5, '0')}`;
    const side = (cents, debitSide) => (debitSide ? { Debit: amount(cents), Credit: '0,00' } : { Debit: '0,00', Credit: amount(cents) });
    rows.push({ ...common, CompteNum: ACCOUNTS.discountGranted, CompteLib: 'Escomptes accordés', CompAuxNum: '', CompAuxLib: '', ...side(ht, !reversal) });
    if (vat !== 0) rows.push({ ...common, CompteNum: ACCOUNTS.vatCollected, CompteLib: 'TVA collectée (régularisation escompte)', CompAuxNum: '', CompAuxLib: '', ...side(vat, !reversal) });
    rows.push({ ...common, CompteNum: ACCOUNTS.customer, CompteLib: 'Clients', CompAuxNum: aux, CompAuxLib: p.societe, ...side(ttc, reversal) });
  }

  const lines = [COLUMNS.join('\t')];
  for (const r of rows) {
    lines.push(COLUMNS.map(c => (c === 'Montantdevise' || c === 'Idevise' || c === 'EcritureLet' || c === 'DateLet') ? '' : clean(r[c])).join('\t'));
  }
  // Contrôle d'équilibre : un FEC déséquilibré est refusé par les outils de contrôle.
  let debit = 0, credit = 0;
  for (const r of rows) {
    debit += Math.round(parseFloat(r.Debit.replace(',', '.')) * 100);
    credit += Math.round(parseFloat(r.Credit.replace(',', '.')) * 100);
  }
  return {
    content: lines.join('\r\n') + '\r\n', rowCount: rows.length, balanced: debit === credit, debit, credit,
    from, to, invoiceCount, creditCount, paymentCount, discountCount,
  };
}

/** Ce que contiendrait l'export, sans le produire : de quoi vérifier la période avant de télécharger. */
function previewFec(period) {
  const r = buildFec(period);
  const drafts = db.prepare(`SELECT COUNT(*) AS n FROM native_invoices WHERE status = 'draft'`).get().n;
  return {
    from: r.from, to: r.to, rowCount: r.rowCount, balanced: r.balanced,
    invoices: r.invoiceCount, creditNotes: r.creditCount, payments: r.paymentCount, discounts: r.discountCount,
    draftsIgnored: drafts,
  };
}

module.exports = { buildFec, previewFec, resolvePeriod, ACCOUNTS };
