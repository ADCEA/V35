#!/usr/bin/env node
// Génère un exemplaire de chaque PDF du site, avec des données fictives, pour juger la mise en page.
//   npm run pdf:samples [dossier]     (par défaut : ./pdf-samples)
// Aucun accès à la base : seules les données ci-dessous sont utilisées. Les identifiants de la société sont fictifs.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Base jetable : les exemples ne lisent ni n'écrivent la vraie base. La fiche « Émetteur » y est remplie avec les données
// fictives ci-dessous, puisque certains PDF (bons de livraison, annexes…) en tirent leur en-tête et leur pied de page.
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-pdf-samples-'));
process.env.BACKUP_SCHEDULER = process.env.BACKUP_SCHEDULER || 'off';
const { buildInvoicePdf } = require('../src/billing/pdf');
const { buildDeliveryNotePdf, buildPreparationSlipPdf, buildInvoiceAnnexPdf, buildInvoiceSummaryPdf } = require('../src/utils/pdf');

const seller = {
  legalName: 'Blanchisserie Cézanne', legalForm: 'SAS', shareCapital: '10 000 €', siren: '123 456 789', siret: '123 456 789 00012',
  vatNumber: 'FR12 123456789', rcs: 'RCS Avignon 123 456 789', address: '12 avenue des Lavandes', postalCode: '84200', city: 'Carpentras',
  email: 'compta@blanchisserie-cezanne.fr', phone: '04 90 00 00 00', iban: 'FR7630001007941234567890185', bic: 'BDFEFRPP',
};
require('../src/db').prepare(`UPDATE billing_settings SET legal_name=?, legal_form=?, share_capital=?, siren=?, siret=?, vat_number=?, rcs=?, address_line=?, postal_code=?, city=?, email=?, phone=?, iban=?, bic=? WHERE id = 1`)
  .run(seller.legalName, seller.legalForm, seller.shareCapital, seller.siren, seller.siret, seller.vatNumber, seller.rcs, seller.address, seller.postalCode, seller.city, seller.email, seller.phone, seller.iban, seller.bic);
const buyer = {
  name: 'Hôtel Les Lavandes', address: '450 route de Malaucène', postalCode: '84380', city: 'Mazan', siren: '987 654 321', vatNumber: 'FR98 987654321',
  deliveryAddress: null,
};
const terms = {
  paymentTermsDays: 30, latePenaltyText: 'En cas de retard de paiement, des pénalités sont exigibles au taux de trois fois le taux d\'intérêt légal, sans mise en demeure préalable.',
  recoveryIndemnityCents: 4000, earlyPaymentDiscount: 'Pas d\'escompte pour paiement anticipé.', vatOnDebits: false, footerNote: null,
};

const ARTICLES = [
  ['Drap plat 2 personnes', 1.35, 20], ['Housse de couette 2 personnes', 2.1, 20], ['Serviette de bain', 0.62, 20],
  ['Serviette de toilette', 0.48, 20], ['Peignoir adulte', 2.8, 20], ['Tapis de bain', 0.55, 20], ['Taie d\'oreiller', 0.4, 20],
];
function lines(count = 6, sections = false) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (sections && i % 6 === 0) out.push({ description: `Bon de livraison CZ-0${300 + i / 6} — livré le ${String(3 + i).padStart(2, '0')}/09/2026`, is_section: 1 });
    const [d, pu, vat] = ARTICLES[i % ARTICLES.length];
    const q = 40 + ((i * 37) % 280);
    out.push({ description: d, quantity: q, unit_price: pu, vat_rate: vat, line_ht_cents: Math.round(q * pu * 100) });
  }
  return out;
}
function totals(ls) {
  const by = new Map();
  let ht = 0;
  for (const l of ls.filter(x => !x.is_section)) { ht += l.line_ht_cents; by.set(l.vat_rate, (by.get(l.vat_rate) || 0) + l.line_ht_cents); }
  const vatBreakdown = [...by].map(([rate, baseCents]) => ({ rate, baseCents, vatCents: Math.round(baseCents * rate / 100) }));
  const vat = vatBreakdown.reduce((s, b) => s + b.vatCents, 0);
  return { vatBreakdown, total_ht_cents: ht, total_vat_cents: vat, total_ttc_cents: ht + vat };
}
const invoice = (over = {}) => {
  const ls = over.lines || lines(6);
  return { kind: 'invoice', status: 'issued', number: 'FA-2026-000016', issue_date: '2026-10-24', due_date: '2026-11-23', period_start: '2026-10-01', period_end: '2026-10-31',
    operation_category: 'services', reference: null, seller, buyer, terms, ...totals(ls), lines: ls, ...over };
};

const orderItems = [
  { name: 'Drap plat 2 personnes', sageCode: 'B-DP2', qty: 120, deliveredQty: 120 },
  { name: 'Housse de couette 2 personnes', sageCode: 'B-HC2', qty: 80, deliveredQty: 76 },
  { name: 'Serviette de bain', sageCode: 'B-SB', qty: 200, deliveredQty: 200 },
  { name: 'Peignoir adulte', sageCode: 'B-PEI', qty: 12, deliveredQty: 14 },
];

const manyItems = Array.from({ length: 44 }, (_, i) => ({ name: `${ARTICLES[i % ARTICLES.length][0]} — lot ${i + 1}`, sageCode: `B-L${i + 1}`, qty: 10 + i, deliveredQty: i % 9 === 4 ? 9 + i : 10 + i }));
const annexOrders = [
  { ticket: 'CZ-0301', livraisonPrevue: '2026-10-03', items: [{ name: 'Drap plat 2 personnes', qty: 120, deliveredQty: 120, price: 1.35 }, { name: 'Serviette de bain', qty: 200, deliveredQty: 196, price: 0.62 }] },
  { ticket: 'CZ-0302', livraisonPrevue: '2026-10-10', items: [{ name: 'Drap plat 2 personnes', qty: 90, deliveredQty: 90, price: 1.35 }, { name: 'Housse de couette 2 personnes', qty: 80, deliveredQty: 76, price: 2.1 }, { name: 'Peignoir adulte', qty: 12, deliveredQty: 14, price: 2.8 }] },
  { ticket: 'CZ-0305', livraisonPrevue: '2026-10-17', items: [{ name: 'Serviette de toilette', qty: 300, deliveredQty: 300, price: 0.48 }, { name: 'Tapis de bain', qty: 60, deliveredQty: 60, price: 0.55 }] },
];
const manyOrders = Array.from({ length: 14 }, (_, i) => ({ ticket: `CZ-0${320 + i}`, livraisonPrevue: `2026-10-${String(2 + i * 2).padStart(2, '0')}`,
  items: annexOrders[i % 3].items.map((it) => ({ ...it, qty: it.qty + i, deliveredQty: it.qty + i })) }));

/** Tous les exemplaires : nom de fichier, fabrication, et nombre de pages attendu (nombre ou « n+ »). */
const SAMPLES = [
  ['facture', 1, () => buildInvoicePdf(invoice(), null, { paidCents: 20000, balanceCents: 31422 })],
  ['facture-payee', 1, () => buildInvoicePdf(invoice(), null, { paidCents: invoice().total_ttc_cents, balanceCents: 0 })],
  ['facture-longue', '3+', () => buildInvoicePdf(invoice({ lines: lines(58, true), number: 'FA-2026-000017' }), null, {})],
  ['facture-brouillon', 1, () => buildInvoicePdf(invoice({ status: 'draft', number: null, issue_date: null, due_date: null }), { seller, buyer, terms }, {})],
  ['avoir', 1, () => buildInvoicePdf(invoice({ kind: 'credit_note', number: 'AV-2026-000003', due_date: null, credit_reason: 'Quantités facturées en trop sur le BL CZ-0302', lines: lines(2), credits_invoice_id: 1 }), null, { creditedInvoiceNumber: 'FA-2026-000016' })],
  ['devis', 1, () => buildInvoicePdf(invoice({ kind: 'quote', number: 'DE-2026-0007', due_date: null, valid_until: '2026-11-23', period_start: null, period_end: null, reference: 'Contrat annuel 2027 — linge de lit et de bain' }), null, {})],
  ['bon-de-livraison', 1, () => buildDeliveryNotePdf({ ticket: 'CZ-0421', status: 'livree', societe: 'Hôtel Les Lavandes', contact: 'Mme Martin', tel: '04 90 12 34 56',
    adresse: '450 route de Malaucène, 84380 Mazan', livraison_prevue: '2026-10-23', notes: 'Livrer côté cuisine, avant 8 h. Sonner à l\'interphone « Livraisons ».', items: orderItems })],
  ['bon-de-livraison-long', '3+', () => buildDeliveryNotePdf({ ticket: 'CZ-0430', status: 'livree', societe: 'Résidence du Mont Ventoux', contact: 'M. Bernard', tel: '04 90 65 43 21',
    adresse: 'Chemin des Garrigues, 84410 Bédoin', livraison_prevue: null, notes: '', items: manyItems })],
  ['bon-de-preparation', 1, () => buildPreparationSlipPdf({ ticket: 'CZ-0421', societe: 'Hôtel Les Lavandes', livraison_prevue: '2026-10-23' }, {
    carts: [
      { name: 'Chariot A — grand', usedL: 640, capacityL: 800, usedKg: 96.5, maxWeightKg: 120, items: [{ name: 'Housse de couette 2 personnes', code: 'HC2', qty: 76 }, { name: 'Drap plat 2 personnes', code: 'DP2', qty: 120 }, { name: 'Peignoir adulte', code: 'PEI', qty: 14 }] },
      { name: 'Chariot B — moyen', usedL: 300, capacityL: 400, usedKg: 118, maxWeightKg: 120, items: [{ name: 'Serviette de bain', code: 'SB', qty: 200 }] },
    ],
    unpacked: [{ name: 'Couverture 2 personnes', code: 'COU', qty: 6 }],
  })],
  ['annexe-facture', 1, () => buildInvoiceAnnexPdf('FA-2026-000016', 'Hôtel Les Lavandes', annexOrders)],
  ['annexe-facture-longue', '2+', () => buildInvoiceAnnexPdf('FA-2026-000018', 'Hôtel Les Lavandes', manyOrders)],
  ['recapitulatif-facture', 1, () => buildInvoiceSummaryPdf('FA-2026-000016', 'Hôtel Les Lavandes', '2026-10-01', '2026-10-31', 3, [
    { name: 'Drap plat 2 personnes', price: 1.35, qty: 210 }, { name: 'Serviette de bain', price: 0.62, qty: 196 }, { name: 'Housse de couette 2 personnes', price: 2.1, qty: 76 },
    { name: 'Peignoir adulte', price: 2.8, qty: 14 }, { name: 'Serviette de toilette', price: 0.48, qty: 300 }, { name: 'Tapis de bain', price: 0.55, qty: 60 },
  ])],
];

async function main() {
  const out = path.resolve(process.argv[2] || 'pdf-samples');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, , make] of SAMPLES) {
    const buf = await make();
    fs.writeFileSync(path.join(out, `${name}.pdf`), buf);
    console.log(`${name}.pdf  (${Math.round(buf.length / 1024)} Ko)`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { SAMPLES };
