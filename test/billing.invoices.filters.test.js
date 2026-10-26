// Liste des factures : filtres de statut cumulables (brouillon, à régler, en retard, partielles, payées, avoirs) et synthèse de la sélection.
const os = require('os'); const path = require('path'); const fs = require('fs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-filters-'));
process.env.DATA_DIR = DATA_DIR; process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const queries = require('../src/billing/queries');

const TODAY = '2026-10-24';
const L = (description, quantity, unitPrice, vatRate = 20) => ({ description, quantity, unitPrice, vatRate });
const ids = (r) => r.invoices.map(i => i.id).sort((a, b) => a - b);
let client; const I = {};

test('mise en place : un exemplaire de chaque statut', () => {
  db.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', iban='FR7630001007941234567890185', bic='BDFEFRPP', phone='04 90 63 00 00', email='contact@exemple.fr' WHERE id = 1`).run();
  client = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret) VALUES ('f@exemple.fr','Hôtel Filtre','C','06','1 rue','84000','Avignon','x',NULL)`).run().lastInsertRowid);
  db.prepare(`UPDATE clients SET client_type = 'particulier' WHERE id = ?`).run(client);
  const mk = (price, date) => engine.issueInvoice(engine.createDraftFromLines(client, [L('Prestation', 1, price)]).id, { issueDate: date }).id;
  I.overdue = mk(1000, '2026-08-01');          // échue le 31/08
  I.partialOverdue = mk(500, '2026-08-05');    // échue, 100 € reçus
  I.paid = mk(200, '2026-09-15');
  I.credited = mk(120, '2026-09-20');
  I.unpaid = mk(250, '2026-10-20');            // à régler, échéance 19/11
  I.partial = mk(300, '2026-10-21');           // à régler, 100 € reçus
  engine.recordPayment(I.partialOverdue, { paidOn: '2026-09-10', amount: 100, method: 'virement', reference: 'acompte' });
  engine.recordPayment(I.partial, { paidOn: '2026-10-22', amount: 100, method: 'virement', reference: 'acompte' });
  engine.recordPayment(I.paid, { paidOn: '2026-09-30', amount: 240, method: 'virement', reference: 'solde' });
  const cn = engine.createCreditNoteDraft(I.credited, { reason: 'Erreur de facturation', full: true });
  I.creditNote = engine.issueInvoice(cn.id, { issueDate: '2026-10-22' }).id;
  I.draft = engine.createDraftFromLines(client, [L('À vérifier', 1, 80)]).id;
});

test('un statut : chaque filtre ne garde que sa catégorie', () => {
  const by = (status) => ids(queries.listInvoices({ status: [status] }, TODAY));
  assert.deepEqual(by('draft'), [I.draft]);
  assert.deepEqual(by('unpaid'), [I.unpaid], 'à régler = émise, rien reçu, pas échue');
  assert.deepEqual(by('overdue'), [I.overdue, I.partialOverdue].sort((a, b) => a - b));
  assert.deepEqual(by('partial'), [I.partialOverdue, I.partial].sort((a, b) => a - b), 'partielle = reste dû avec un règlement, échue ou non');
  assert.deepEqual(by('paid'), [I.paid, I.credited].sort((a, b) => a - b), 'payée ou soldée par avoir');
  assert.deepEqual(by('credit_notes'), [I.creditNote]);
});

test('plusieurs statuts cochés : union, sans doublon ; sans statut : tout', () => {
  let r = queries.listInvoices({ status: ['overdue', 'partial'] }, TODAY);
  assert.deepEqual(ids(r), [I.overdue, I.partialOverdue, I.partial].sort((a, b) => a - b), 'la facture à la fois en retard et partielle n\'apparaît qu\'une fois');
  assert.equal(r.total, 3);
  r = queries.listInvoices({ status: ['draft', 'credit_notes'] }, TODAY);
  assert.deepEqual(ids(r), [I.draft, I.creditNote].sort((a, b) => a - b));
  assert.equal(queries.listInvoices({ status: [] }, TODAY).total, 8);
  assert.equal(queries.listInvoices({ status: ['n-importe-quoi'] }, TODAY).total, 8, 'clé inconnue ignorée');
  assert.equal(queries.listInvoices({ tab: 'open' }, TODAY).total, 4, 'ancien paramètre tab toujours accepté');
});

test('compteurs des puces et synthèse de la sélection', () => {
  const r = queries.listInvoices({ status: ['unpaid', 'overdue'] }, TODAY);
  assert.deepEqual([r.counts.all, r.counts.draft, r.counts.unpaid, r.counts.overdue, r.counts.partial, r.counts.paid, r.counts.credit_notes], [8, 1, 1, 2, 2, 2, 1],
    'les compteurs ne dépendent pas de la sélection');
  assert.equal(r.sums.unpaid, 30000);
  assert.equal(r.sums.overdue, 120000 + 50000, 'reste dû : 1 200 € + 500 € TTC');
  assert.equal(r.selection.count, 3);
  assert.equal(r.selection.balanceCents, 30000 + 120000 + 50000);
  assert.equal(r.selection.totalTtcCents, 30000 + 120000 + 60000);
  // les compteurs suivent la recherche et le client
  assert.equal(queries.listInvoices({ status: ['paid'], q: 'introuvable' }, TODAY).counts.all, 0);
  assert.equal(queries.listInvoices({ status: ['paid'], clientId: client + 99 }, TODAY).selection.count, 0);
});

test('la sélection respecte le tri et la limite', () => {
  const r = queries.listInvoices({ status: ['overdue', 'partial', 'unpaid'], sort: 'amount', dir: 'desc', limit: 2 }, TODAY);
  assert.equal(r.invoices.length, 2);
  assert.equal(r.total, 4);
  assert.equal(r.invoices[0].id, I.overdue);
  assert.equal(r.selection.count, 4, 'la synthèse porte sur toute la sélection, pas seulement la page');
});
