// Tests du moteur de facturation intégrée — base SQLite jetable.
// Lancer : npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-billing-'));
delete process.env.ODOO_URL; delete process.env.ODOO_API_KEY;

const db = require('../src/db');
const B = require('../src/billing/engine');

function seed() {
  db.prepare(`UPDATE billing_settings SET legal_name='BLANCHISSERIE CEZANNE & CO', legal_form='SAS', share_capital='10 000 €',
    siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', address_line='153 boulevard Jean-Louis Passet',
    postal_code='84200', city='Carpentras' WHERE id=1`).run();
  const c = db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number)
    VALUES ('h@x.fr','Hôtel Test','Jean','0600000000','1 rue du Test','84000','Avignon','x','55210055400013','FR40552100554')`).run();
  const clientId = Number(c.lastInsertRowid);
  const ids = [];
  for (const [i, d] of [['001', '2026-10-01'], ['002', '2026-10-08']]) {
    const o = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status)
      VALUES (?,?,?,?,?,?,?, 'livree')`).run(`CZ-T-${i}`, clientId, 'Hôtel Test', 'Jean', '06', '1 rue du Test', d);
    const oid = Number(o.lastInsertRowid); ids.push(oid);
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`)
      .run(oid, 'drap', 'Drap 2 places', 'D2', 'DRAP2', 1.234, 100, 100);
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`)
      .run(oid, 'serv', 'Serviette éponge', 'SE', 'SERV', 0.55, 33, 33);
  }
  return { clientId, ids };
}

test('calculs en centimes : pas de dérive flottante', () => {
  assert.equal(B.lineCents(33, 0.55), 1815);
  assert.equal(B.lineCents(100, 1.234), 12340);
  const t = B.computeTotals([{ quantity: 3, unitPrice: 0.1, vatRate: 20 }, { quantity: 3, unitPrice: 0.2, vatRate: 20 }]);
  assert.equal(t.totalHtCents, 90);
  assert.equal(t.totalVatCents, 18);
  assert.equal(t.totalTtcCents, 108);
});

test('SIREN : contrôle de Luhn', () => {
  assert.ok(B.luhnOk('552100554'));
  assert.ok(!B.luhnOk('552100555'));
});

test('cycle complet : brouillon → émission → avoir → règlement → intégrité', () => {
  const { clientId, ids } = seed();
  assert.equal(B.listInvoiceableOrders(clientId).length, 2);

  const draft = B.createDraftFromOrders(clientId, ids);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.number, null);
  // 2 × (100×1,234 + 33×0,55) = 2 × (123,40 + 18,15) = 283,10 HT
  assert.equal(draft.total_ht_cents, 28310);
  assert.equal(draft.total_ttc_cents, 33972);
  assert.equal(B.listInvoiceableOrders(clientId).length, 0, 'les BL d\'un brouillon ne sont plus facturables');

  const inv = B.issueInvoice(draft.id, { issueDate: '2026-10-31' });
  assert.equal(inv.status, 'issued');
  assert.equal(inv.number, 'FA-2026-000001');
  assert.equal(inv.due_date, '2026-11-30');
  assert.equal(B.paymentStatus(inv), 'unpaid');

  // Immuabilité au niveau SQL
  assert.throws(() => db.prepare('UPDATE native_invoices SET total_ht_cents = 1 WHERE id = ?').run(inv.id), /modification interdite/);
  assert.throws(() => db.prepare('DELETE FROM native_invoices WHERE id = ?').run(inv.id), /suppression interdite/);
  assert.throws(() => db.prepare('UPDATE native_invoice_lines SET quantity = 1 WHERE invoice_id = ?').run(inv.id), /modification interdite/);
  assert.throws(() => db.prepare('DELETE FROM native_invoice_orders WHERE invoice_id = ?').run(inv.id), /modification interdite/);
  assert.throws(() => B.updateDraft(inv.id, { notes: 'x' }), /modification interdite/);

  // Avoir partiel : 10 draps sur la 1re ligne
  const firstLine = inv.lines.find(l => !l.is_section);
  const cn = B.createCreditNoteDraft(inv.id, { reason: 'Erreur de tarif', lines: [{ lineId: firstLine.id, quantity: 10 }] });
  assert.equal(cn.kind, 'credit_note');
  const cnIssued = B.issueInvoice(cn.id, { issueDate: '2026-11-02' });
  assert.equal(cnIssued.number, 'AV-2026-000001');
  assert.equal(cnIssued.total_ht_cents, 1234);

  // Impossible de re-créditer au-delà
  assert.throws(() => B.createCreditNoteDraft(inv.id, { reason: 'x', lines: [{ lineId: firstLine.id, quantity: 91 }] }), /on ne peut créditer que 90/);

  // Règlements : append-only
  const afterPay = B.recordPayment(inv.id, { paidOn: '2026-11-10', amount: 100, method: 'virement' });
  assert.equal(B.paymentStatus(afterPay), 'partial');
  assert.throws(() => db.prepare('DELETE FROM native_payments').run(), /suppression interdite/);
  assert.throws(() => B.recordPayment(inv.id, { amount: 99999 }), /dépasse le reste à payer/);

  const check = B.verifyIntegrity();
  assert.deepEqual(check.problems, []);
  assert.equal(check.checked, 2);
});

test('numérotation chronologique : date antérieure refusée', () => {
  const { clientId } = db.prepare('SELECT id AS clientId FROM clients LIMIT 1').get() && { clientId: db.prepare('SELECT id FROM clients LIMIT 1').get().id };
  const o = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES ('CZ-T-003',?,?,?,?,?,?, 'livree')`)
    .run(clientId, 'Hôtel Test', 'J', '06', 'a', '2026-10-20');
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`)
    .run(Number(o.lastInsertRowid), 'drap', 'Drap', 'D', 'D', 2, 10, 10);
  const d = B.createDraftFromOrders(clientId, [Number(o.lastInsertRowid)]);
  assert.throws(() => B.issueInvoice(d.id, { issueDate: '2026-10-15' }), /antérieure/);
  // Rien n'a été consommé : le numéro suivant est bien le 2
  const ok = B.issueInvoice(d.id, { issueDate: '2026-11-03' });
  assert.equal(ok.number, 'FA-2026-000002');
});

test('mentions obligatoires manquantes : émission refusée, aucun numéro consommé', () => {
  db.prepare(`UPDATE billing_settings SET rcs=NULL WHERE id=1`).run();
  const { clientId } = { clientId: db.prepare('SELECT id FROM clients LIMIT 1').get().id };
  const o = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES ('CZ-T-004',?,?,?,?,?,?, 'livree')`)
    .run(clientId, 'Hôtel Test', 'J', '06', 'a', '2026-11-05');
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`)
    .run(Number(o.lastInsertRowid), 'drap', 'Drap', 'D', 'D', 2, 10, 10);
  const d = B.createDraftFromOrders(clientId, [Number(o.lastInsertRowid)]);
  assert.throws(() => B.issueInvoice(d.id, { issueDate: '2026-11-06' }), /RCS/);
  db.prepare(`UPDATE billing_settings SET rcs='RCS Avignon' WHERE id=1`).run();
  assert.equal(B.issueInvoice(d.id, { issueDate: '2026-11-06' }).number, 'FA-2026-000003');
  assert.deepEqual(B.verifyIntegrity().problems, []);
});
