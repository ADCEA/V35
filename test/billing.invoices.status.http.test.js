// Route GET /invoices : paramètre status (liste de statuts séparés par des virgules), valeurs inconnues ignorées, synthèse de la sélection.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; let db;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, `confirmation ${scope} : ${JSON.stringify(c.data)}`);
  return call(method, url, body);
}
let n = 0; let clientId;
async function issued(issueDate) {
  n += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-ST-${n}`, clientId, 'H', 'J', '06', 'adr', issueDate).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
  const c = await call('POST', `${B}/invoices`, { clientId, orderIds: [o] });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  return c.data.invoice.id;
}
const issue = (id, issueDate) => sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate });

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP', phone: '04 90 63 00 00', email: 'contact@blanchisserie-cezanne.fr' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  clientId = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret) VALUES ('s@exemple.fr','Hôtel Statut','C','06','1 rue','84000','Avignon','x','55210055400013')`).run().lastInsertRowid);
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('filtres de statut par l\'API', async () => {
  const old = await issued('2026-01-10'); assert.equal((await issue(old, '2026-01-10')).status, 200);    // échue depuis longtemps
  const paid = await issued('2026-02-10'); assert.equal((await issue(paid, '2026-02-10')).status, 200);
  const pay = await sensitive(`payment:${paid}`, 'POST', `${B}/invoices/${paid}/payments`, { paidOn: '2026-02-20', amount: 120, method: 'virement', reference: 'solde' });
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  const draft = await issued('2026-03-01');

  const list = async (qs) => { const r = await call('GET', `${B}/invoices?${qs}`); assert.equal(r.status, 200); return r.data; };
  const ids = (r) => r.invoices.map(i => i.id).sort((a, b) => a - b);
  assert.deepEqual(ids(await list('status=overdue')), [old]);
  assert.deepEqual(ids(await list('status=paid')), [paid]);
  assert.deepEqual(ids(await list('status=draft')), [draft]);
  assert.deepEqual(ids(await list('status=overdue,paid')), [old, paid].sort((a, b) => a - b));
  assert.equal((await list('status=bidon')).total, 3, 'valeur inconnue ignorée = pas de filtre');
  assert.equal((await list('tab=open')).total, 1, 'ancien paramètre tab accepté');
  const r = await list('status=overdue,draft');
  assert.deepEqual([r.selection.count, r.counts.all, r.counts.overdue, r.counts.paid, r.counts.draft], [2, 3, 1, 1, 1]);
  assert.equal(r.selection.balanceCents, 12000);
});
