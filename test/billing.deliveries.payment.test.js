// Bons de livraison : filtre sur le paiement de la facture (à encaisser, en retard, partielle, payée),
// compteurs croisés avec le filtre de facturation, colonne « paiement » de l'export.
const os = require('os'); const path = require('path'); const fs = require('fs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-deliveries-pay-'));
process.env.DATA_DIR = DATA_DIR; process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const deliveries = require('../src/billing/deliveries');

const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof engine.BillingError && (!re || re.test(e.message)));
const tickets = (r) => r.deliveries.map(d => d.ticket).sort();
const today = engine.todayParis();
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let hotel; const O = {}; const INV = {};
function mkOrder(ticket, date) {
  const id = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?, 'livree')`)
    .run(ticket, hotel, 'H', 'C', '06', 'adr', date).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(id, 's', 'Drap', 'D', 'DRAP', 1, 100, 100);
  return id;
}
const invoice = (order, issueDate) => engine.issueInvoice(engine.createDraftFromOrders(hotel, [order]).id, { issueDate });

test('mise en place : un BL par situation de paiement', () => {
  db.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', iban='FR7630001007941234567890185', bic='BDFEFRPP', email='compta@exemple.fr', phone='04 90 00 00 00', payment_terms_days=30 WHERE id=1`).run();
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash, siret) VALUES ('p@x.fr','Hôtel Paiement','C','06','adr','x','55210055400013')`).run().lastInsertRowid);
  for (const k of ['NEUF', 'BROUILLON', 'ATTENTE', 'PARTIEL', 'RETARD', 'RETARD-PARTIEL', 'PAYE', 'ANCIEN']) O[k] = mkOrder('BL-' + k, addDays(today, -3));

  engine.createDraftFromOrders(hotel, [O.BROUILLON]);
  // la numérotation reste chronologique : les plus anciennes d'abord
  INV.RETARD = invoice(O.RETARD, addDays(today, -60));                  // échue depuis 30 jours
  INV['RETARD-PARTIEL'] = invoice(O['RETARD-PARTIEL'], addDays(today, -60));
  engine.recordPayment(INV['RETARD-PARTIEL'].id, { paidOn: addDays(today, -20), amount: 50, method: 'virement' });
  INV.PAYE = invoice(O.PAYE, addDays(today, -60));
  engine.recordPayment(INV.PAYE.id, { paidOn: addDays(today, -40), amount: engine.balanceCents(INV.PAYE) / 100, method: 'virement' });
  INV.ATTENTE = invoice(O.ATTENTE, today);                              // échéance dans 30 jours, rien reçu
  INV.PARTIEL = invoice(O.PARTIEL, today);
  engine.recordPayment(INV.PARTIEL.id, { paidOn: today, amount: 50, method: 'virement' });
  const legacy = Number(db.prepare(`INSERT INTO invoices (client_id, period_start, period_end, status) VALUES (?,?,?, 'posted')`).run(hotel, '2026-01-01', '2026-01-31').lastInsertRowid);
  db.prepare('INSERT INTO invoice_orders (invoice_id, order_id) VALUES (?,?)').run(legacy, O.ANCIEN);
  assert.equal(deliveries.listDeliveries({}).total, 8);
});

test('chaque BL facturé porte l\'état de paiement de sa facture', () => {
  const pay = (t) => deliveries.listDeliveries({ q: t }).deliveries[0].billing;
  assert.equal(pay('BL-ATTENTE').payment, 'unpaid');
  assert.equal(pay('BL-PARTIEL').payment, 'partial');
  assert.equal(pay('BL-RETARD').payment, 'overdue');
  assert.equal(pay('BL-RETARD-PARTIEL').payment, 'overdue', 'l\'échéance passée prime sur le règlement partiel, comme dans la liste des factures');
  assert.equal(pay('BL-PAYE').payment, 'paid');
  assert.equal(pay('BL-ATTENTE').dueDate, addDays(today, 30));
  for (const t of ['BL-NEUF', 'BL-BROUILLON', 'BL-ANCIEN']) assert.equal(pay(t).payment, null, `${t} : pas de paiement à suivre`);
  // même règle que la liste des factures
  const list = require('../src/billing/queries').listInvoices({}).invoices.filter(d => d.kind === 'invoice' && d.status === 'issued');
  const bls = deliveries.listDeliveries({}).deliveries;
  let compared = 0;
  for (const d of list) {
    const bl = bls.find(x => x.billing.invoiceId === d.id); if (!bl) continue;
    assert.equal(bl.billing.payment, d.display, `facture ${d.number}`); compared += 1;
  }
  assert.equal(compared, 5);
});

test('filtre de paiement : un ou plusieurs états, les autres BL disparaissent', () => {
  assert.deepEqual(tickets(deliveries.listDeliveries({ payment: 'unpaid' })), ['BL-ATTENTE']);
  assert.deepEqual(tickets(deliveries.listDeliveries({ payment: 'overdue' })), ['BL-RETARD', 'BL-RETARD-PARTIEL']);
  assert.deepEqual(tickets(deliveries.listDeliveries({ payment: 'partial' })), ['BL-PARTIEL']);
  assert.deepEqual(tickets(deliveries.listDeliveries({ payment: 'paid' })), ['BL-PAYE']);
  assert.deepEqual(tickets(deliveries.listDeliveries({ payment: 'unpaid,partial' })), ['BL-ATTENTE', 'BL-PARTIEL'], 'liste séparée par des virgules');
  assert.deepEqual(tickets(deliveries.listDeliveries({ payment: ['paid', 'overdue'] })), ['BL-PAYE', 'BL-RETARD', 'BL-RETARD-PARTIEL'], 'ou tableau');
  assert.equal(deliveries.listDeliveries({ payment: '' }).total, 8, 'filtre vide = pas de filtre');
  const r = deliveries.listDeliveries({ payment: 'overdue' });
  assert.equal(r.total, 2); assert.equal(r.totals.htCents, 20000);
  rejects(() => deliveries.listDeliveries({ payment: 'impayé' }), /paiement/);
  rejects(() => deliveries.listDeliveries({ payment: 'paid,xx' }), /paiement/);
});

test('compteurs : chaque filtre ignore le sien et tient compte de l\'autre', () => {
  const all = deliveries.listDeliveries({});
  assert.deepEqual(all.counts, { all: 8, to_invoice: 1, draft: 1, invoiced: 6, payments: { unpaid: 1, overdue: 2, partial: 1, paid: 1 } });
  // avec un filtre de paiement, les onglets de facturation se recalculent sur ce filtre
  const od = deliveries.listDeliveries({ payment: 'overdue' });
  assert.deepEqual(od.counts, { all: 2, to_invoice: 0, draft: 0, invoiced: 2, payments: { unpaid: 1, overdue: 2, partial: 1, paid: 1 } });
  // avec un onglet de facturation, les puces de paiement se recalculent sur cet onglet
  const td = deliveries.listDeliveries({ status: 'to_invoice' });
  assert.deepEqual(td.counts.payments, { unpaid: 0, overdue: 0, partial: 0, paid: 0 });
  assert.equal(td.counts.all, 8);
  // combiné avec l'hôtel et la recherche
  assert.equal(deliveries.listDeliveries({ payment: 'overdue', clientId: hotel, q: 'PARTIEL' }).total, 1);
  assert.equal(deliveries.listDeliveries({ payment: 'paid', status: 'to_invoice' }).total, 0, 'payé et à facturer s\'excluent');
});

test('un règlement ou un avoir change le BL de catégorie', () => {
  engine.recordPayment(INV.RETARD.id, { paidOn: today, amount: engine.balanceCents(INV.RETARD) / 100, method: 'virement' });
  assert.deepEqual(tickets(deliveries.listDeliveries({ payment: 'paid' })), ['BL-PAYE', 'BL-RETARD']);
  assert.deepEqual(tickets(deliveries.listDeliveries({ payment: 'overdue' })), ['BL-RETARD-PARTIEL']);
  // facture annulée par un avoir total : le BL redevient « à facturer », donc sans paiement
  const cn = engine.createCreditNoteDraft(INV.ATTENTE.id, { reason: 'Erreur', full: true });
  engine.issueInvoice(cn.id, { issueDate: today });
  assert.equal(deliveries.listDeliveries({ payment: 'unpaid' }).total, 0);
  assert.equal(deliveries.listDeliveries({ q: 'BL-ATTENTE' }).deliveries[0].billing.status, 'to_invoice');
});

test('export CSV : colonne « paiement »', () => {
  const csv = deliveries.deliveriesCsv({ payment: 'overdue' });
  assert.ok(csv.startsWith('﻿bl;date_livraison;hotel;references;pieces;montant_ht;facturation;facture;paiement\r\n'));
  assert.match(csv, /BL-RETARD-PARTIEL;[^\r]*;Facturé;FA-[^;]*;En retard\r\n/);
  assert.ok(!csv.includes('BL-PAYE'), 'le filtre s\'applique aussi à l\'export');
  const all = deliveries.deliveriesCsv({});
  assert.match(all, /BL-PAYE;[^\r]*;Payée\r\n/);
  assert.match(all, /BL-NEUF;[^\r]*;À facturer;;\r\n/);
});
