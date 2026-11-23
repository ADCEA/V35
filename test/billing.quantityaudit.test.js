// Contrôle (lecture seule) des quantités des factures émises : écarts avec les commandes, livraisons signalées incomplètes.
const os = require('os'); const path = require('path'); const fs = require('fs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-qty-audit-'));
process.env.DATA_DIR = DATA_DIR; process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const { auditInvoices } = require('../src/billing/quantityAudit');

let hotel; const O = {}; const INV = {};
const today = engine.todayParis();
function mkOrder(ticket, items, notes = null) {
  const id = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, notes, status) VALUES (?,?,?,?,?,?,?,?, 'livree')`)
    .run(ticket, hotel, 'H', 'C', '06', 'adr', today, notes).lastInsertRowid);
  for (const [sid, name, price, qty] of items) {
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(id, sid, name, name.slice(0, 3), name.slice(0, 3).toUpperCase(), price, qty, qty);
  }
  return id;
}
const issue = (order) => engine.issueInvoice(engine.createDraftFromOrders(hotel, [order]).id, { issueDate: today });
const row = (inv) => auditInvoices().invoices.find(r => r.id === inv.id);

test('mise en place : une facture par situation', () => {
  db.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', iban='FR7630001007941234567890185', bic='BDFEFRPP', email='compta@exemple.fr', phone='04 90 00 00 00', payment_terms_days=30 WHERE id=1`).run();
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash, siret, adresse_facturation) VALUES ('a@x.fr','Hôtel Audit','C','06','adr','x','55210055400013','1 rue du Linge, 84200 Carpentras')`).run().lastInsertRowid);
  const items = [['c', 'Couverture', 2, 100], ['b', 'Bain', 1, 50]];
  for (const k of ['PROPRE', 'ECART', 'SIGNALE', 'CORRIGE', 'COMPLEMENT']) O[k] = mkOrder('T-' + k, items);
  for (const k of Object.keys(O)) INV[k] = issue(O[k]);
  assert.equal(auditInvoices().counts.checked, 5);
});

test('facture cohérente avec sa commande : ok', () => {
  const r = row(INV.PROPRE);
  assert.equal(r.status, 'ok'); assert.deepEqual(r.diffs, []); assert.deepEqual(r.orders, ['T-PROPRE']);
});

test('commande modifiée après facturation : écart de quantité', () => {
  db.prepare('UPDATE order_items SET delivered_qty = 90 WHERE order_id = ? AND service_id = ?').run(O.ECART, 'c');
  const r = row(INV.ECART);
  assert.equal(r.status, 'ecart');
  assert.deepEqual(r.diffs.map(d => [d.article, d.kind, d.invoicedQty, d.currentQty, d.invoicedHtCents, d.currentHtCents]), [['Couverture', 'quantité', 100, 90, 20000, 18000]]);
});

test('manque signalé dans un commentaire, facturé au complet : signalé', () => {
  db.prepare('INSERT INTO order_comments (order_id, author, text) VALUES (?,?,?)').run(O.SIGNALE, 'Chauffeur', 'Il manquait 10 couvertures à la livraison');
  const r = row(INV.SIGNALE);
  assert.equal(r.status, 'signale');
  assert.equal(r.hints[0].ticket, 'T-SIGNALE'); assert.match(r.hints[0].text, /manquait/);
});

test('pas de faux positif : quantité déjà corrigée, ou complément déjà créé', () => {
  db.prepare('INSERT INTO order_comments (order_id, author, text) VALUES (?,?,?)').run(O.CORRIGE, 'Chauffeur', 'Livraison partielle');
  db.prepare('UPDATE order_items SET delivered_qty = 80 WHERE order_id = ? AND service_id = ?').run(O.CORRIGE, 'c');
  // la facture avait été émise AVANT la correction : c'est donc un écart, pas un simple signalement
  assert.equal(row(INV.CORRIGE).status, 'ecart');

  db.prepare('INSERT INTO order_comments (order_id, author, text) VALUES (?,?,?)').run(O.COMPLEMENT, 'Chauffeur', 'Livraison partielle, il manque du linge');
  db.prepare('INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, notes, status) VALUES (?,?,?,?,?,?,?,?)')
    .run('T-SUITE', hotel, 'H', 'C', '06', 'adr', 'Commande de complément suite à livraison partielle de T-COMPLEMENT.', 'recue');
  assert.equal(row(INV.COMPLEMENT).status, 'ok', 'un complément existe déjà : le manque a été traité');
});

test('les factures annulées par un avoir total et les factures libres sont ignorées', () => {
  const free = engine.issueInvoice(engine.createDraftFromLines(hotel, [{ description: 'Prestation', quantity: 1, unitPrice: 10, vatRate: 20 }]).id, { issueDate: today });
  assert.equal(row(free), undefined);
  const counts = auditInvoices().counts;
  assert.deepEqual([counts.ecart, counts.signale, counts.ok], [2, 1, 2]);
});
