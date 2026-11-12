// Quand ce qui est livré diffère de ce qui est commandé, le client (son logiciel) doit le savoir :
//  - GET /api/v1/orders/:ticket annonce l'écart par article (difference, discrepancy) et pour la commande (hasDiscrepancy),
//    mais seulement une fois la commande livrée ;
//  - le contenu du webhook porte les mêmes champs ; une correction faite après la livraison déclenche un nouvel événement.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');
const { buildPayload } = require('../src/utils/webhookNotify');
const { lineDiff, hasDiscrepancy } = require('../src/utils/deliveryDiff');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
const TOKEN = 'tok-ecart-livraison';
let s, hotel, jdb;
const call = (...a) => s.call(...a);
const api = (method, url, body) => fetch(`${s.BASE}/api/v1${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
const getOrder = async (ticket) => (await api('GET', `/orders/${ticket}`)).json();

async function newApiOrder(items) {
  const r = await api('POST', '/orders', { items });
  assert.equal(r.status, 201);
  const { ticket } = await r.json();
  const row = jdb.prepare('SELECT id FROM orders WHERE ticket = ?').get(ticket);
  return { ticket, id: row.id };
}
const status = (id, st) => call('PATCH', `/api/admin/orders/${id}/status`, { status: st });
const setDelivered = (id, items) => call('PATCH', `/api/admin/orders/${id}/items`, { items });

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  hotel = (await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Écarts', email: 'e@exemple.fr', siret: '55210055400013', adresse: '1 rue du Linge, 84200 Carpentras' })).data.client.id;
  jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  jdb.prepare('INSERT INTO api_tokens (client_id, token) VALUES (?, ?)').run(hotel, TOKEN);
});
test.after(async () => { if (jdb) jdb.close(); if (s) await s.stop(); });

test('lineDiff : moins, plus, conforme, et lignes de reprise (quantités négatives)', () => {
  assert.deepEqual(lineDiff({ qty: 20, deliveredQty: 18 }), { qtyOrdered: 20, qtyDelivered: 18, difference: -2, discrepancy: 'short' });
  assert.deepEqual(lineDiff({ qty: 20, deliveredQty: 23 }), { qtyOrdered: 20, qtyDelivered: 23, difference: 3, discrepancy: 'over' });
  assert.deepEqual(lineDiff({ qty: 20, deliveredQty: 20 }), { qtyOrdered: 20, qtyDelivered: 20, difference: 0, discrepancy: null });
  assert.equal(lineDiff({ qty: 20, deliveredQty: null }).discrepancy, null, 'quantité livrée absente = celle commandée');
  assert.deepEqual(lineDiff({ qty: -5, deliveredQty: -3 }), { qtyOrdered: -5, qtyDelivered: -3, difference: -2, discrepancy: 'short' });
  assert.equal(hasDiscrepancy([{ qty: 1, deliveredQty: 1 }, { qty: 4, deliveredQty: 5 }]), true);
  assert.equal(hasDiscrepancy([{ qty: 1, deliveredQty: 1 }]), false);
});

test('contenu du webhook : écart par article et pour la commande', () => {
  const items = [{ code: 'DP2', name: 'Drap plat 2 pers.', qty: 20, deliveredQty: 18 }, { code: 'HC2', name: 'Housse', qty: 10, deliveredQty: 10 }];
  const p = buildPayload('order.delivered', { ticket: 'CZ-1' }, items);
  assert.equal(p.event, 'order.delivered');
  assert.equal(p.ticket, 'CZ-1');
  assert.ok(p.deliveredAt && !p.updatedAt);
  assert.equal(p.hasDiscrepancy, true);
  assert.deepEqual(p.items[0], { sageCode: 'DP2', name: 'Drap plat 2 pers.', qtyOrdered: 20, qtyDelivered: 18, difference: -2, discrepancy: 'short' });
  assert.equal(p.items[1].discrepancy, null);

  const u = buildPayload('order.delivery_updated', { ticket: 'CZ-1' }, items);
  assert.equal(u.event, 'order.delivery_updated');
  assert.ok(u.updatedAt && !u.deliveredAt);

  assert.equal(buildPayload('order.delivered', { ticket: 'CZ-2' }, [{ code: 'DP2', name: 'x', qty: 5, deliveredQty: 5 }]).hasDiscrepancy, false);
});

test('API : l\'écart est annoncé une fois la commande livrée, jamais avant', async () => {
  const o = await newApiOrder([{ sageCode: 'B-DP2', qty: 20 }, { sageCode: 'B-HC2', qty: 10 }]);

  let g = await getOrder(o.ticket);
  assert.equal(g.status, 'recue');
  assert.equal(g.hasDiscrepancy, false);
  assert.deepEqual(g.items.map(i => [i.qty, i.deliveredQty, i.difference, i.discrepancy]), [[20, 20, null, null], [10, 10, null, null]], 'rien à signaler avant la livraison');

  await status(o.id, 'traitement');
  const dp2 = jdb.prepare('SELECT service_id AS id FROM order_items WHERE order_id = ? AND sage_code = ?').get(o.id, 'B-DP2').id;
  assert.equal((await setDelivered(o.id, [{ id: dp2, deliveredQty: 17 }])).status, 200);
  g = await getOrder(o.ticket);
  assert.equal(g.hasDiscrepancy, false, 'saisie en cours à l\'atelier : pas d\'écart annoncé');
  assert.equal(g.items.find(i => i.sageCode === 'B-DP2').deliveredQty, 17, 'la quantité livrée, elle, reste visible comme avant');

  await status(o.id, 'livree');
  g = await getOrder(o.ticket);
  assert.equal(g.hasDiscrepancy, true);
  const a = g.items.find(i => i.sageCode === 'B-DP2'); const b = g.items.find(i => i.sageCode === 'B-HC2');
  assert.deepEqual([a.qty, a.deliveredQty, a.difference, a.discrepancy], [20, 17, -3, 'short']);
  assert.deepEqual([b.qty, b.deliveredQty, b.difference, b.discrepancy], [10, 10, 0, null]);
});

test('API : plus que commandé, puis retour à la conformité après correction', async () => {
  const o = await newApiOrder([{ sageCode: 'B-DP2', qty: 5 }]);
  const art = jdb.prepare('SELECT service_id AS id FROM order_items WHERE order_id = ?').get(o.id).id;
  await status(o.id, 'traitement');
  assert.equal((await setDelivered(o.id, [{ id: art, deliveredQty: 8 }])).status, 200);
  await status(o.id, 'livree');
  let g = await getOrder(o.ticket);
  assert.deepEqual([g.hasDiscrepancy, g.items[0].difference, g.items[0].discrepancy], [true, 3, 'over']);

  // correction après la livraison (non facturée) : le webhook est tenté, la réponse ne dépend pas de lui
  jdb.prepare('UPDATE clients SET webhook_url = ?, webhook_secret = ? WHERE id = ?').run('http://localhost:9/hook', 's', hotel);
  assert.equal((await setDelivered(o.id, [{ id: art, deliveredQty: 5 }])).status, 200);
  g = await getOrder(o.ticket);
  assert.deepEqual([g.hasDiscrepancy, g.items[0].difference, g.items[0].discrepancy], [false, 0, null]);
  jdb.prepare('UPDATE clients SET webhook_url = NULL WHERE id = ?').run(hotel);
});
