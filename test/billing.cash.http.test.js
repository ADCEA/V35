// Encaissements de bout en bout : mode de règlement par ligne de relevé, règlements en lot,
// et regroupement des BL à nom libre — avec le verrou de la Facturation et la ressaisie du code.
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

let hotel; const inv = [];
test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number, adresse_facturation)
    VALUES ('h@x.fr','Hôtel Les Lavandes','Jean','0490123456','450 route de Malaucène','84380','Mazan','x','55210055400013','FR40552100554','Siège')`).run().lastInsertRowid);
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // 3 factures émises de 100 € HT (120 € TTC) chacune
  for (const d of ['2026-09-01', '2026-09-08', '2026-09-15']) {
    const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-${d}`, hotel, 'Hôtel', 'J', '06', 'adr', d).lastInsertRowid);
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
    const c = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o] });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const id = c.data.invoice.id;
    const i = await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate: d });
    assert.equal(i.status, 200, JSON.stringify(i.data));
    inv.push({ id, number: i.data.invoice.number, ttc: i.data.invoice.totalTtcCents });
  }
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('rapprochement : le mode « prélèvement » est reconnu dans le libellé et enregistré tel quel', async () => {
  const csv = ['Date;Libellé;Montant',
    `05/10/2026;PRLV SEPA HOTEL LES LAVANDES ${inv[0].number};${(inv[0].ttc / 100).toFixed(2).replace('.', ',')}`,
    `06/10/2026;VIR SEPA HOTEL LES LAVANDES ${inv[1].number};${(inv[1].ttc / 100).toFixed(2).replace('.', ',')}`,
    `07/10/2026;REMISE CHEQUE ${inv[2].number};${(inv[2].ttc / 100).toFixed(2).replace('.', ',')}`].join('\n');
  const p = await call('POST', `${B}/reconcile/parse`, { csv });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.deepEqual(p.data.lines.map(l => l.method), ['prelevement', 'virement', 'cheque']);

  const items = p.data.lines.map((l, i) => ({ fingerprint: l.fingerprint, date: l.date, label: l.label, method: l.method, allocations: [{ invoiceId: inv[i].id, amountCents: l.amountCents }] }));
  // une valeur inconnue est refusée, jamais remplacée en silence
  const bad = await call('POST', `${B}/reconcile/apply`, { items: [{ ...items[0], method: 'bitcoin' }] });
  assert.equal(bad.status, 200); assert.equal(bad.data.failed, 1); assert.match(bad.data.results[0].error, /Mode de règlement inconnu/);
  // la modification manuelle du mode (ici le 2e passe en « autre ») est respectée
  items[1].method = 'autre';
  const ok = await call('POST', `${B}/reconcile/apply`, { items });
  assert.equal(ok.data.applied, 3, JSON.stringify(ok.data));
  const modes = (await call('GET', `${B}/payments`)).data.payments.sort((a, b) => a.paidOn.localeCompare(b.paidOn)).map(x => x.method);
  assert.deepEqual(modes, ['prelevement', 'autre', 'cheque']);
  // sans mode : virement, comme avant
  const csv2 = `Date;Libellé;Montant\n08/10/2026;VIREMENT DIVERS;0,01`;
  const p2 = await call('POST', `${B}/reconcile/parse`, { csv: csv2 });
  assert.equal(p2.data.lines[0].method, 'virement');
});

test('règlements en lot : aperçu libre, enregistrement après ressaisie du code, tout ou rien', async () => {
  // 3 nouvelles factures à régler en lot
  const batch = [];
  for (const d of ['2026-09-20', '2026-09-22', '2026-09-24']) {
    const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-L-${d}`, hotel, 'Hôtel', 'J', '06', 'adr', d).lastInsertRowid);
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 50, 50);
    const c = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o] });
    const id = c.data.invoice.id;
    const i = await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate: d });
    batch.push({ id, number: i.data.invoice.number, ttc: i.data.invoice.totalTtcCents });
  }
  const ids = batch.map(b => b.id); const total = batch.reduce((x, b) => x + b.ttc, 0);

  // aperçu : aucune ressaisie, rien n'est écrit
  let r = await call('POST', `${B}/payments/bulk`, { invoiceIds: ids, paidOn: '2026-10-05', reference: 'Prélèvement 05/10' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.method, 'prelevement', 'prélèvement par défaut');
  assert.equal(r.data.count, 3); assert.equal(r.data.refused, 0); assert.equal(r.data.totalCents, total);
  assert.equal((await call('GET', `${B}/payments`)).data.payments.filter(p => p.reference === 'Prélèvement 05/10').length, 0);

  // application sans ressaisie du code : refusée
  r = await call('POST', `${B}/payments/bulk`, { invoiceIds: ids, paidOn: '2026-10-05', reference: 'Prélèvement 05/10', apply: true });
  assert.equal(r.status, 403); assert.equal(r.data.code, 'STEP_UP_REQUIRED'); assert.equal(r.data.scope, 'payments-bulk');

  // une date future est refusée, un mode inconnu aussi, une liste vide aussi
  assert.equal((await sensitive('payments-bulk', 'POST', `${B}/payments/bulk`, { invoiceIds: ids, paidOn: '2999-01-01', apply: true })).status, 400);
  assert.equal((await sensitive('payments-bulk', 'POST', `${B}/payments/bulk`, { invoiceIds: ids, method: 'troc', apply: true })).status, 400);
  assert.equal((await call('POST', `${B}/payments/bulk`, { invoiceIds: [] })).status, 400);

  // tout ou rien : une facture déjà soldée fait refuser TOUT le lot
  const paidOne = await call('POST', `${B}/invoices/${ids[0]}/payments`, { paidOn: '2026-10-01', amount: batch[0].ttc / 100, method: 'virement' });
  assert.equal(paidOne.status, 201);
  const prev = await call('POST', `${B}/payments/bulk`, { invoiceIds: ids, paidOn: '2026-10-05' });
  assert.equal(prev.data.refused, 1); assert.equal(prev.data.count, 2);
  assert.equal(prev.data.lines.find(l => l.invoiceId === ids[0]).error, 'Déjà soldée.');
  const refused = await sensitive('payments-bulk', 'POST', `${B}/payments/bulk`, { invoiceIds: ids, paidOn: '2026-10-05', apply: true });
  assert.equal(refused.status, 400); assert.match(refused.data.error, /Lot refusé, rien n'a été enregistré/);
  assert.equal((await call('GET', `${B}/payments`)).data.payments.filter(p => p.invoiceId === ids[1]).length, 0, 'les autres factures sont intactes');

  // le lot valide s'enregistre en une fois, une ressaisie = une seule opération
  const good = ids.slice(1);
  const done = await sensitive('payments-bulk', 'POST', `${B}/payments/bulk`, { invoiceIds: good, paidOn: '2026-10-05', reference: 'Prélèvement 05/10', apply: true });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.data.count, 2); assert.equal(done.data.totalCents, batch[1].ttc + batch[2].ttc);
  const pays = (await call('GET', `${B}/payments`)).data.payments.filter(p => p.reference === 'Prélèvement 05/10');
  assert.equal(pays.length, 2); assert.ok(pays.every(p => p.method === 'prelevement' && p.paidOn === '2026-10-05'));
  const again = await call('POST', `${B}/payments/bulk`, { invoiceIds: good, paidOn: '2026-10-05', apply: true });
  assert.equal(again.status, 403, 'la ressaisie ne sert qu’une fois');
  for (const id of good) assert.equal((await call('GET', `${B}/invoices/${id}`)).data.invoice.paymentStatus, 'paid');
});

test('BL à nom libre : groupes, aperçu sans écriture, rattachement après ressaisie du code, une seule fois', async () => {
  const mk = (ticket, societe) => Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,NULL,?,?,?,?,?, 'livree')`)
    .run(ticket, societe, 'M. Libre', '0490123456', '450 route de Malaucène', '2026-10-02').lastInsertRowid);
  const o1 = mk('LIB-1', 'HOTEL LES LAVANDES'); const o2 = mk('LIB-2', 'Hôtel Lavandes SAS'); const o3 = mk('LIB-3', 'Hotel les lavandes');
  for (const o of [o1, o2, o3]) db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 10, 10);

  const list = await call('GET', `${B}/deliveries`);
  assert.ok(list.data.unlinked.orders >= 3, 'la page des BL sait combien de commandes n’ont pas de fiche');

  const g = await call('GET', `${B}/deliveries/unlinked`);
  assert.equal(g.status, 200);
  const grp = g.data.groups.find(x => x.key === 'hotel lavande');
  assert.equal(grp.orders, 3); assert.equal(grp.orderList.length, 3);
  assert.equal(grp.suggestions[0].clientId, hotel); assert.equal(grp.suggestions[0].confidence, 'high');
  assert.deepEqual(grp.orderList.map(o => o.ticket).sort(), ['LIB-1', 'LIB-2', 'LIB-3']);

  const item = { key: 'hotel lavande', clientId: hotel, orderIds: [o1, o2] };   // le 3e bon est écarté après vérification
  const pv = await call('POST', `${B}/deliveries/unlinked/link`, { items: [item] });
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.equal(pv.data.applied, false); assert.equal(pv.data.orders, 2); assert.equal(pv.data.results[0].left, 1);
  assert.equal(db.prepare('SELECT client_id FROM orders WHERE id = ?').get(o1).client_id, null, 'l’aperçu n’écrit rien');

  const denied = await call('POST', `${B}/deliveries/unlinked/link`, { items: [item], apply: true });
  assert.equal(denied.status, 403); assert.equal(denied.data.scope, 'orders-link');

  const done = await sensitive('orders-link', 'POST', `${B}/deliveries/unlinked/link`, { items: [item], apply: true });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.orders, 2);
  assert.equal(db.prepare('SELECT client_id FROM orders WHERE id = ?').get(o1).client_id, hotel);
  assert.equal(db.prepare('SELECT client_id FROM orders WHERE id = ?').get(o3).client_id, null, 'le bon écarté reste libre');
  assert.equal((await call('GET', `${B}/deliveries?clientId=${hotel}`)).data.deliveries.filter(d => d.ticket.startsWith('LIB-')).length, 2);
  const again = await call('POST', `${B}/deliveries/unlinked/link`, { items: [item], apply: true });
  assert.equal(again.status, 403, 'la ressaisie ne sert qu’une fois');
  const integrity = await call('GET', `${B}/integrity`);
  assert.equal(integrity.status, 200);
});
