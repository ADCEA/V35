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

function buildFec(year) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows = [];
  let ecritureNum = 0;

  const docs = db.prepare(`
    SELECT i.*, c.societe FROM native_invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.status = 'issued' AND i.issue_date BETWEEN ? AND ?
    ORDER BY i.chain_no
  `).all(from, to);

  for (const inv of docs) {
    ecritureNum += 1;
    const isCredit = inv.kind === 'credit_note';
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
    WHERE p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on, p.id
  `).all(from, to);
  for (const p of payments) {
    ecritureNum += 1;
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
  return { content: lines.join('\r\n') + '\r\n', rowCount: rows.length, balanced: debit === credit, debit, credit };
}

module.exports = { buildFec, ACCOUNTS };
