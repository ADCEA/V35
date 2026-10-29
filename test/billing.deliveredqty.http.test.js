// La facture suit les quantités LIVRÉES : elles restent corrigeables (commande en traitement, prête ou livrée)
// tant que la commande n'est pas reprise dans une facture ou un brouillon, puis elles sont figées.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s, hotel, art, art2, jdb;
const call = (...a) => s.call(...a);
const stepUp = async (scope) => assert.equal((await call('POST', `${B}/lock/confirm`, { code: CODE, scope })).status, 200);
const rows = (id) => jdb.prepare('SELECT service_id AS s, qty, delivered_qty AS d FROM order_items WHERE order_id = ? ORDER BY id').all(id);
const events = () => jdb.prepare("SELECT detail_json FROM billing_events WHERE action = 'delivered_qty_changed' ORDER BY id").all().map(r => JSON.parse(r.detail_json));

async function newOrder(items) {
  const r = await call('POST', '/api/admin/orders/manual', { clientId: hotel, items });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return (await call('GET', '/api/admin/orders')).data.orders.find(x => x.ticket === r.data.ticket);
}
const status = (id, st) => call('PATCH', `/api/admin/orders/${id}/status`, { status: st });
const patch = (id, items) => call('PATCH', `/api/admin/orders/${id}/items`, { items });

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  await stepUp('settings');
  assert.equal((await call('PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' })).status, 200);
  art = (await call('POST', `${B}/catalog/articles`, { name: 'Couverture Q', code: 'CQ', sageCode: 'T-CQ', category: 'lit', price: 2 })).data.article.id;
  art2 = (await call('POST', `${B}/catalog/articles`, { name: 'Bain de soleil Q', code: 'BQ', sageCode: 'T-BQ', category: 'lit', price: 1 })).data.article.id;
  hotel = (await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Quantités', email: 'q@exemple.fr', siret: '55210055400013', adresse: '1 rue du Linge, 84200 Carpentras' })).data.client.id;
  jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
});
test.after(async () => { if (jdb) jdb.close(); if (s) await s.stop(); });

test('par défaut la quantité livrée égale la commandée ; elle se corrige en traitement, prête ou livrée', async () => {
  const o = await newOrder([{ serviceId: art, qty: 100 }, { serviceId: art2, qty: 50 }]);
  assert.deepEqual(rows(o.id).map(r => [r.qty, r.d]), [[100, 100], [50, 50]]);
  assert.equal(o.billed, false);

  // « reçue » : rien n'est encore préparé
  assert.equal((await patch(o.id, [{ id: art, deliveredQty: 90 }])).status, 409);

  await status(o.id, 'traitement');
  assert.equal((await patch(o.id, [{ id: art, deliveredQty: 95 }])).status, 200);
  assert.equal(events().length, 0, 'la saisie pendant la préparation n\'encombre pas le journal');

  await status(o.id, 'prete');
  let r = await patch(o.id, [{ id: art, deliveredQty: 90 }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(rows(o.id).map(x => [x.qty, x.d]), [[100, 90], [50, 50]]);

  await status(o.id, 'livree');
  r = await patch(o.id, [{ id: art2, deliveredQty: 40 }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(rows(o.id).map(x => [x.qty, x.d]), [[100, 90], [50, 40]], 'la quantité commandée ne bouge jamais');
  assert.equal(r.data.order.items.find(i => i.id === art2).deliveredQty, 40);

  // chaque correction après préparation laisse une trace (qui n'a pas à être justifiée pour la saisie en traitement)
  const ev = events();
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[1].changes, [{ article: 'Bain de soleil Q', ordered: 50, from: 50, to: 40 }]);
  assert.equal(ev[1].ticket, o.ticket);
  // même valeur renvoyée : aucun changement, aucune trace
  await patch(o.id, [{ id: art2, deliveredQty: 40 }]);
  assert.equal(events().length, 2);
});

test('la facture reprend les quantités corrigées APRÈS la livraison', async () => {
  const o = await newOrder([{ serviceId: art, qty: 100 }]);
  await status(o.id, 'traitement'); await status(o.id, 'prete'); await status(o.id, 'livree');
  assert.equal((await patch(o.id, [{ id: art, deliveredQty: 70 }])).status, 200);

  const bl = (await call('GET', `${B}/deliveries/${o.id}`)).data.delivery;
  assert.equal(bl.lines[0].delivered, 70);
  assert.equal(bl.htCents, 70 * 200);
  assert.equal(bl.adjusted, true);

  const inv = (await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o.id] })).data.invoice;
  const line = inv.lines.find(l => !l.isSection);
  assert.equal(Number(line.quantity), 70, 'facturé = livré, pas commandé');
});

test('le BL se corrige depuis la facturation, sauf une fois facturé (brouillon ou facture émise)', async () => {
  const o = await newOrder([{ serviceId: art, qty: 10 }, { serviceId: art2, qty: 20 }]);
  await status(o.id, 'traitement'); await status(o.id, 'prete'); await status(o.id, 'livree');

  const put = (items) => call('PUT', `${B}/deliveries/${o.id}/quantities`, { items });
  let r = await put([{ id: art, deliveredQty: 8 }, { id: art2, deliveredQty: 20 }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.changes, [{ article: 'Couverture Q', ordered: 10, from: 10, to: 8 }]);
  assert.equal(r.data.delivery.lines.find(l => l.id === art).delivered, 8);
  assert.equal(r.data.delivery.htCents, 8 * 200 + 20 * 100);
  assert.equal((await call('GET', '/api/admin/orders')).data.orders.find(x => x.id === o.id).billed, false);

  // une saisie de mauvais signe est ignorée, pas appliquée
  r = await put([{ id: art, deliveredQty: -4 }]);
  assert.equal(r.status, 200); assert.deepEqual(r.data.changes, []);
  assert.equal(rows(o.id)[0].d, 8);

  // brouillon : les montants sont déjà recopiés dans la facture → on bloque pour ne pas les désynchroniser
  const draft = (await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o.id] })).data.invoice;
  r = await put([{ id: art, deliveredQty: 5 }]);
  assert.equal(r.status, 409); assert.match(r.data.error, /brouillon/);
  assert.equal((await patch(o.id, [{ id: art, deliveredQty: 5 }])).status, 409, 'même règle depuis la fiche commande');
  assert.equal((await call('POST', `/api/admin/orders/${o.id}/items`, { serviceId: art, qty: 1 })).status, 409, 'et pour l\'ajout d\'un article');
  assert.equal((await call('GET', '/api/admin/orders')).data.orders.find(x => x.id === o.id).billed, true);
  assert.deepEqual(rows(o.id).map(x => x.d), [8, 20]);

  // supprimer le brouillon libère le bon
  assert.equal((await call('DELETE', `${B}/invoices/${draft.id}`)).status, 200);
  assert.equal((await put([{ id: art, deliveredQty: 6 }])).status, 200);

  // facture émise : figé
  const inv = (await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o.id] })).data.invoice;
  await stepUp(`issue:${inv.id}`);
  const issued = await call('POST', `${B}/invoices/${inv.id}/issue`, {});
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  r = await put([{ id: art, deliveredQty: 1 }]);
  assert.equal(r.status, 409); assert.match(r.data.error, /facturée.*avoir/);
  assert.equal((await patch(o.id, [{ id: art, deliveredQty: 1 }])).status, 409);
  assert.deepEqual(rows(o.id).map(x => x.d), [6, 20]);
  const detail = (await call('GET', `${B}/deliveries/${o.id}`)).data.delivery;
  assert.equal(detail.billing.status, 'invoiced');

  // un avoir total annule la facture : le bon redevient corrigeable et refacturable
  await stepUp(`credit:${inv.id}`);
  const cn = await call('POST', `${B}/invoices/${inv.id}/credit-note`, { reason: 'Erreur de quantité', full: true });
  assert.equal(cn.status, 201, JSON.stringify(cn.data));
  await stepUp(`issue:${cn.data.invoice.id}`);
  assert.equal((await call('POST', `${B}/invoices/${cn.data.invoice.id}/issue`, {})).status, 200);
  assert.equal((await put([{ id: art, deliveredQty: 7 }])).status, 200);
});

test('seul un bon livré se corrige depuis la facturation', async () => {
  const o = await newOrder([{ serviceId: art, qty: 3 }]);
  assert.equal((await call('PUT', `${B}/deliveries/${o.id}/quantities`, { items: [{ id: art, deliveredQty: 1 }] })).status, 404);
  assert.equal((await call('PUT', `${B}/deliveries/999999/quantities`, { items: [] })).status, 404);
  await status(o.id, 'livree');
  assert.equal((await call('PUT', `${B}/deliveries/${o.id}/quantities`, { items: 'x' })).status, 400);
});

test('ajouter à un article déjà présent garde la quantité livrée déjà saisie', async () => {
  const o = await newOrder([{ serviceId: art, qty: 100 }]);
  await status(o.id, 'traitement');
  await patch(o.id, [{ id: art, deliveredQty: 90 }]);

  assert.equal((await call('POST', `/api/admin/orders/${o.id}/items`, { serviceId: art, qty: 10 })).status, 201);
  assert.deepEqual(rows(o.id).map(x => [x.qty, x.d]), [[110, 100]], 'commandé 110 ; livré 90 + 10, le manque de 10 reste visible');

  // retirer plus que ce qui était livré ne rend pas la quantité livrée négative
  assert.equal((await call('POST', `/api/admin/orders/${o.id}/items`, { serviceId: art, qty: -105 })).status, 201);
  assert.deepEqual(rows(o.id).map(x => [x.qty, x.d]), [[5, 0]]);
});
