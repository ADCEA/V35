// Bons de livraison de bout en bout : verrou de la Facturation, filtres, PDF (unitaire et groupé), CSV.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s;
const call = (...a) => s.call(...a);
let hotelA, hotelB, art; const bl = {};

test.before(async () => { s = await startServer(); });
test.after(async () => { if (s) await s.stop(); });

async function deliver(clientId, qty) {
  const o = await call('POST', '/api/admin/orders/manual', { clientId, items: [{ serviceId: art, qty }] });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  const id = o.data.id ?? (await call('GET', '/api/admin/orders')).data.orders.find(x => x.ticket === o.data.ticket).id;
  const d = await call('PATCH', `/api/admin/orders/${id}/status`, { status: 'livree' });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  return { id, ticket: o.data.ticket };
}

test('les BL sont derrière le verrou de la Facturation', async () => {
  assert.equal((await call('GET', `${B}/deliveries`)).status, 401);
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  assert.equal((await call('POST', `${B}/lock/lock`)).status, 200);
  for (const u of ['/deliveries', '/deliveries/1', '/deliveries/1/pdf', '/deliveries/export.pdf', '/deliveries/export.csv']) {
    assert.equal((await call('GET', B + u)).status, 423, `${u} doit être verrouillé`);
  }
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
});

test('liste filtrée par date et par hôtel', async () => {
  art = (await call('POST', `${B}/catalog/articles`, { name: 'Drap BL', code: 'DBL', sageCode: 'T-DBL', category: 'lit', price: 2 })).data.article.id;
  hotelA = (await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Alpha', email: 'a@exemple.fr' })).data.client.id;
  hotelB = (await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Beta', email: 'b@exemple.fr' })).data.client.id;
  bl.a = await deliver(hotelA, 10); bl.b = await deliver(hotelB, 5);
  const open = await call('POST', '/api/admin/orders/manual', { clientId: hotelA, items: [{ serviceId: art, qty: 1 }] });   // non livrée
  assert.equal(open.status, 201);

  let r = (await call('GET', `${B}/deliveries`)).data;
  assert.equal(r.total, 2);
  assert.deepEqual(r.counts, { all: 2, to_invoice: 2, draft: 0, invoiced: 0 });
  assert.equal(r.totals.htCents, 10 * 200 + 5 * 200);

  r = (await call('GET', `${B}/deliveries?clientId=${hotelB}`)).data;
  assert.deepEqual(r.deliveries.map(d => d.ticket), [bl.b.ticket]);

  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await call('GET', `${B}/deliveries?from=${today}&to=${today}`)).data.total, 2, 'livrés aujourd’hui');
  assert.equal((await call('GET', `${B}/deliveries?to=2020-01-01`)).data.total, 0);
  assert.equal((await call('GET', `${B}/deliveries?from=2026-13-01`)).status, 400);
  assert.equal((await call('GET', `${B}/deliveries?status=nimporte`)).status, 400);
});

test('détail, PDF d’un BL, PDF groupé et CSV', async () => {
  const d = await call('GET', `${B}/deliveries/${bl.a.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.data.delivery.ticket, bl.a.ticket);
  assert.equal(d.data.delivery.lines.length, 1);
  assert.ok(!('order' in d.data.delivery) && !('items' in d.data.delivery), 'pas de ligne brute de commande dans la réponse');
  assert.equal((await call('GET', `${B}/deliveries/999999`)).status, 404);

  const one = await call('GET', `${B}/deliveries/${bl.a.id}/pdf`, undefined, true);
  assert.equal(one.status, 200);
  assert.equal(one.headers.get('content-type'), 'application/pdf');
  assert.match(one.headers.get('content-disposition'), new RegExp(`bon-livraison-${bl.a.ticket}\\.pdf`));
  assert.equal(Buffer.from(await one.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  const all = await call('GET', `${B}/deliveries/export.pdf`, undefined, true);
  assert.equal(all.status, 200); assert.equal(all.headers.get('x-order-count'), '2');
  assert.equal(Buffer.from(await all.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  const none = await call('GET', `${B}/deliveries/export.pdf?to=2020-01-01`);
  assert.equal(none.status, 404); assert.match(none.data.error, /Aucun bon/);

  const csv = await call('GET', `${B}/deliveries/export.csv?clientId=${hotelA}`, undefined, true);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /bons-livraison-\d{4}-\d{2}-\d{2}\.csv/);
  const buf = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.ok(buf.toString('utf8').includes(`${bl.a.ticket};`) && !buf.toString('utf8').includes(`${bl.b.ticket};`));
});
