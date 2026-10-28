// Bons de livraison : liste filtrée par date et par hôtel, état de facturation, montants, exports.
const os = require('os'); const path = require('path'); const fs = require('fs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-deliveries-'));
process.env.DATA_DIR = DATA_DIR; process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const deliveries = require('../src/billing/deliveries');

const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof engine.BillingError && (!re || re.test(e.message)));
const tickets = (r) => r.deliveries.map(d => d.ticket);

let alpha, beta; const O = {};

const addClient = (societe, email) => Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash, siret) VALUES (?,?,?,?,?,'x','55210055400013')`)
  .run(email, societe, 'Contact', '06', '1 rue du Test').lastInsertRowid);
function mkOrder(client, ticket, date, status, lines = [[10, 10, 1.35]], created = '2026-09-01 08:00:00') {
  const id = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(ticket, client, 'Société figée', 'C', '06', 'adr', date, status, created).lastInsertRowid);
  lines.forEach(([qty, delivered, price], i) => db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, `svc${i}`, `Article ${i}`, `A${i}`, `S-${i}`, price, qty, delivered));
  return id;
}

test('mise en place', () => {
  db.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', iban='FR7630001007941234567890185', bic='BDFEFRPP', email='compta@exemple.fr', phone='04 90 00 00 00' WHERE id=1`).run();
  alpha = addClient('Hôtel Alpha', 'alpha@exemple.fr');
  beta = addClient('Beta Resort', 'beta@exemple.fr');
  O.a1 = mkOrder(alpha, 'BL-A1', '2026-10-02', 'livree');
  O.a2 = mkOrder(alpha, 'BL-A2', '2026-10-15', 'livree', [[10, 8, 1.35], [4, 4, 0.5]]);      // livré moins que commandé
  O.a3 = mkOrder(alpha, 'BL-A3', '2026-10-31', 'livree');
  O.b1 = mkOrder(beta, 'BL-B1', '2026-10-15', 'livree');
  O.b2 = mkOrder(beta, 'BL-B2', null, 'livree', [[5, 5, 2]], '2026-10-20 09:30:00');          // sans date de livraison : date de création
  O.open = mkOrder(alpha, 'BL-OUVERT', '2026-10-16', 'traitement');                           // pas livrée : n'est pas un BL
  assert.equal(deliveries.listDeliveries({}).total, 5);
});

test('seules les commandes livrées sont des BL ; plus récent d’abord', () => {
  const r = deliveries.listDeliveries({});
  assert.deepEqual(tickets(r), ['BL-A3', 'BL-B2', 'BL-B1', 'BL-A2', 'BL-A1'], 'par date décroissante, puis par numéro interne décroissant');
  assert.ok(!tickets(r).includes('BL-OUVERT'));
});

test('filtre par date : bornes incluses, date de création à défaut de date de livraison', () => {
  assert.deepEqual(tickets(deliveries.listDeliveries({ from: '2026-10-15', to: '2026-10-15' })).sort(), ['BL-A2', 'BL-B1']);
  assert.deepEqual(tickets(deliveries.listDeliveries({ from: '2026-10-16' })).sort(), ['BL-A3', 'BL-B2'], 'BL-B2 est daté de sa création (20/10)');
  assert.deepEqual(tickets(deliveries.listDeliveries({ to: '2026-10-02' })), ['BL-A1']);
  assert.equal(deliveries.listDeliveries({ from: '2027-01-01' }).total, 0);
  rejects(() => deliveries.listDeliveries({ from: '2026-13-45' }), /début invalide/);
  rejects(() => deliveries.listDeliveries({ to: 'demain' }), /fin invalide/);
  rejects(() => deliveries.listDeliveries({ from: '2026-10-20', to: '2026-10-01' }), /postérieure/);
});

test('filtre par hôtel, par recherche, et les deux combinés', () => {
  assert.deepEqual(tickets(deliveries.listDeliveries({ clientId: beta })).sort(), ['BL-B1', 'BL-B2']);
  assert.deepEqual(tickets(deliveries.listDeliveries({ clientId: alpha, from: '2026-10-10', to: '2026-10-20' })), ['BL-A2']);
  assert.deepEqual(tickets(deliveries.listDeliveries({ q: 'bl-b' })).sort(), ['BL-B1', 'BL-B2'], 'recherche par numéro, sans tenir compte de la casse');
  assert.deepEqual(tickets(deliveries.listDeliveries({ q: 'resort' })).sort(), ['BL-B1', 'BL-B2'], 'recherche par nom d’hôtel (fiche actuelle)');
  assert.equal(deliveries.listDeliveries({ q: '100%' }).total, 0, 'les caractères spéciaux de LIKE sont neutralisés');
  rejects(() => deliveries.listDeliveries({ clientId: 'abc' }), /Hôtel invalide/);
});

test('montants : quantité livrée × prix figé sur la commande', () => {
  const r = deliveries.listDeliveries({});
  const a2 = r.deliveries.find(d => d.ticket === 'BL-A2');
  assert.equal(a2.htCents, 8 * 135 + 4 * 50, '8 livrés à 1,35 + 4 à 0,50');
  assert.equal(a2.pieces, 12); assert.equal(a2.refs, 2);
  assert.equal(r.deliveries.find(d => d.ticket === 'BL-B2').htCents, 1000);
  assert.equal(r.totals.htCents, r.deliveries.reduce((s, d) => s + d.htCents, 0));
  // un changement de tarif ultérieur ne touche pas un BL déjà livré
  db.prepare('UPDATE order_items SET price = 9 WHERE order_id = ? AND service_id = ?').run(O.b2, 'svc0');
  assert.equal(deliveries.listDeliveries({ q: 'BL-B2' }).deliveries[0].htCents, 5 * 900, 'c’est bien le prix de la ligne qui compte');
  db.prepare('UPDATE order_items SET price = 2 WHERE order_id = ? AND service_id = ?').run(O.b2, 'svc0');
});

test('état de facturation : à facturer, brouillon, facturé, ancien circuit, avoir total', () => {
  const state = (t) => deliveries.listDeliveries({ q: t }).deliveries[0].billing;
  assert.equal(state('BL-A1').status, 'to_invoice');

  const draft = engine.createDraftFromOrders(alpha, [O.a1]);
  assert.deepEqual([state('BL-A1').status, state('BL-A1').invoiceId], ['draft', draft.id]);
  assert.equal(state('BL-A1').invoiceNumber, null, 'pas de numéro avant l’émission');

  const issued = engine.issueInvoice(draft.id, { issueDate: '2026-11-02' });
  assert.equal(state('BL-A1').status, 'invoiced');
  assert.equal(state('BL-A1').invoiceNumber, issued.number);
  assert.equal(state('BL-A1').invoiceDate, '2026-11-02');

  // ancien circuit (Odoo)
  const legacyInv = Number(db.prepare(`INSERT INTO invoices (client_id, period_start, period_end, status) VALUES (?,?,?, 'posted')`).run(beta, '2026-10-01', '2026-10-31').lastInsertRowid);
  db.prepare('INSERT INTO invoice_orders (invoice_id, order_id) VALUES (?,?)').run(legacyInv, O.b1);
  assert.deepEqual([state('BL-B1').status, state('BL-B1').legacy], ['invoiced', true]);

  // une facture annulée par un avoir total remet le BL à facturer (même règle que « Facturer le mois »)
  const cn = engine.createCreditNoteDraft(issued.id, { reason: 'Erreur', full: true });
  engine.issueInvoice(cn.id, { issueDate: '2026-11-03' });
  assert.equal(state('BL-A1').status, 'to_invoice');
  assert.ok(engine.listInvoiceableOrders(alpha).some(o => o.id === O.a1), 'cohérent avec la facturation du mois');

  // filtre et compteurs
  const all = deliveries.listDeliveries({});
  assert.deepEqual(all.counts, { all: 5, to_invoice: 4, draft: 0, invoiced: 1, payments: { unpaid: 0, overdue: 0, partial: 0, paid: 0 } });
  assert.deepEqual(tickets(deliveries.listDeliveries({ status: 'invoiced' })), ['BL-B1']);
  assert.equal(deliveries.listDeliveries({ status: 'to_invoice' }).total, 4);
  assert.equal(deliveries.listDeliveries({ status: 'invoiced', clientId: alpha }).total, 0);
  assert.equal(deliveries.listDeliveries({ status: 'to_invoice' }).counts.all, 5, 'les compteurs ignorent le filtre de statut');
  assert.equal(all.totals.byStatus.to_invoice.count + all.totals.byStatus.invoiced.count, 5);
  rejects(() => deliveries.listDeliveries({ status: 'payé' }), /Statut/);
});

test('détail d’un BL', () => {
  const d = deliveries.getDelivery(O.a2);
  assert.equal(d.ticket, 'BL-A2'); assert.equal(d.client.societe, 'Hôtel Alpha');
  assert.equal(d.lines.length, 2); assert.equal(d.lines[0].delivered, 8); assert.equal(d.lines[0].qty, 10);
  assert.equal(d.adjusted, true, 'livré ≠ commandé est signalé');
  assert.equal(d.htCents, 8 * 135 + 4 * 50);
  assert.equal(deliveries.getDelivery(O.a3).adjusted, false);
  rejects(() => deliveries.getDelivery(O.open), /introuvable/);
  rejects(() => deliveries.getDelivery(999999), /introuvable/);
});

test('exports : CSV Excel et ensemble de BL pour le PDF groupé', () => {
  const csv = deliveries.deliveriesCsv({ clientId: beta });
  assert.ok(csv.startsWith('﻿bl;date_livraison;hotel;references;pieces;montant_ht;facturation;facture;paiement\r\n'));
  assert.match(csv, /BL-B1;2026-10-15;Beta Resort;1;10;13,50;Facturé \(ancien circuit\);;\r\n/);
  assert.match(csv, /BL-B2;2026-10-20;Beta Resort;1;5;10,00;À facturer;;\r\n/);
  assert.ok(csv.indexOf('BL-B1') < csv.indexOf('BL-B2'), 'du plus ancien au plus récent');

  const set = deliveries.exportSet({ from: '2026-10-15', to: '2026-10-15' });
  assert.deepEqual(set.map(o => o.ticket), ['BL-A2', 'BL-B1'], 'du plus ancien au plus récent (à date égale, par numéro interne)');
  assert.ok(set.every(o => Array.isArray(o.items) && o.items.length && o.status === 'livree' && o.societe));
  rejects(() => deliveries.exportSet({ from: '2030-01-01' }), /Aucun bon/);
  // plafond du PDF groupé
  const many = deliveries.MAX_EXPORT + 1;
  const ins = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?, 'livree')`);
  db.transaction(() => { for (let i = 0; i < many; i++) ins.run(`BULK-${i}`, alpha, 'S', 'C', '06', 'a', '2025-01-15'); })();
  rejects(() => deliveries.exportSet({ from: '2025-01-01', to: '2025-01-31' }), /Trop de bons/);
  assert.equal(deliveries.listDeliveries({ from: '2025-01-01', to: '2025-01-31' }).total, many, 'la liste, elle, renvoie le total exact');
});
