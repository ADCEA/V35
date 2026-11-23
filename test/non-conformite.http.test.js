// Non-conformités : l'hôtel signale un problème sur une livraison depuis son espace client ; l'équipe est prévenue, répond et
// clôt ; l'hôtel lit la réponse. Le sac « pour linge non conforme » est un article du catalogue, commandable comme les autres.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

let s, db;
const call = (...a) => s.call(...a);
const NC = '/api/clients/non-conformities';
const ADM = '/api/admin/non-conformities';
const base = { contact: 'C', tel: '0600000000', adresse: '1 rue du Linge, Carpentras' };

async function asClient(email) { s.newClient(); const r = await call('POST', '/api/clients/login', { email, code: '482916' }); assert.equal(r.status, 200, JSON.stringify(r.data)); }
async function asAdmin() { s.newClient(); assert.equal((await call('POST', '/api/admin/login', { password: 'secret123' })).status, 200); }

function delivered(clientId, societe, ticket, status = 'livree') {
  const id = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, created_at) VALUES (?, ?, ?, 'c', '0', 'a', ?, datetime('now'))`).run(ticket, clientId, societe, status).lastInsertRowid;
  const ins = db.prepare('INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  ins.run(id, 'b_dp2', 'Drap plat 2 pers.', 'DP2', 'B-DP2', 20, 18);
  ins.run(id, 'b_hc2', 'Housse de couette 2 pers.', 'HC2', 'B-HC2', 10, 10);
  return id;
}

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  for (const [n, email] of [['A', 'a@exemple.fr'], ['B', 'b@exemple.fr']]) {
    s.newClient();
    assert.equal((await call('POST', '/api/clients/register', { ...base, societe: `Hôtel ${n}`, email, code: '482916' })).status, 201);
  }
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('sans connexion, ni l\'hôtel ni l\'administration ne répondent', async () => {
  s.newClient();
  assert.equal((await call('GET', NC)).status, 401);
  assert.equal((await call('POST', NC, { orderId: 1, kind: 'manque', comment: 'x' })).status, 401);
  assert.equal((await call('GET', ADM)).status, 401);
  assert.equal((await call('PATCH', `${ADM}/1`, { status: 'resolue' })).status, 401);
});

test('un hôtel signale un problème sur SA livraison, avec les articles concernés', async () => {
  const a = db.prepare("SELECT id FROM clients WHERE email = 'a@exemple.fr'").get().id;
  const b = db.prepare("SELECT id FROM clients WHERE email = 'b@exemple.fr'").get().id;
  const orderA = delivered(a, 'Hôtel A', 'CZ-NC-A1');
  const notYet = delivered(a, 'Hôtel A', 'CZ-NC-A2', 'prete');
  const orderB = delivered(b, 'Hôtel B', 'CZ-NC-B1');

  await asClient('a@exemple.fr');
  const bad = (body) => call('POST', NC, body);
  assert.equal((await bad({ orderId: orderA, kind: 'inconnu', comment: 'abc' })).status, 400, 'type inconnu');
  assert.equal((await bad({ orderId: orderA, kind: 'manque' })).status, 400, 'ni article ni commentaire');
  assert.equal((await bad({ orderId: orderA, kind: 'manque', lines: [{ id: 'b_inconnu', qty: 1 }] })).status, 400, 'article absent de la livraison');
  assert.equal((await bad({ orderId: orderA, kind: 'manque', lines: [{ id: 'b_dp2', qty: 0 }] })).status, 400, 'quantité nulle');
  assert.equal((await bad({ orderId: orderA, kind: 'manque', lines: [{ id: 'b_dp2', qty: 1.5 }] })).status, 400, 'quantité non entière');
  assert.equal((await bad({ orderId: orderA, kind: 'manque', comment: 'x'.repeat(1001) })).status, 400, 'commentaire trop long');
  assert.equal((await bad({ orderId: orderB, kind: 'manque', comment: 'pas la mienne' })).status, 404, 'livraison d\'un autre hôtel');
  assert.equal((await bad({ orderId: notYet, kind: 'manque', comment: 'pas encore livrée' })).status, 404, 'commande pas encore livrée');
  assert.equal((await bad({ orderId: 99999, kind: 'manque', comment: 'inexistante' })).status, 404);

  const ok = await bad({ orderId: orderA, kind: 'manque', comment: 'Il manquait des draps dans le chariot 2', lines: [{ id: 'b_dp2', qty: 2 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const nc = ok.data.nonConformity;
  assert.deepEqual([nc.ticket, nc.kind, nc.status, nc.statusLabel], ['CZ-NC-A1', 'manque', 'ouverte', 'Reçu']);
  assert.deepEqual(nc.lines, [{ id: 'b_dp2', name: 'Drap plat 2 pers.', qty: 2 }]);

  // l'équipe le retrouve dans la discussion de la commande
  const com = db.prepare('SELECT author, text FROM order_comments WHERE order_id = ?').all(orderA);
  assert.equal(com.length, 1);
  assert.match(com[0].author, /Hôtel A \(non-conformité\)/);
  assert.match(com[0].text, /Il manque du linge.*Drap plat 2 pers\. ×2.*Il manquait des draps/);

  // un commentaire seul suffit
  assert.equal((await bad({ orderId: orderA, kind: 'sale', comment: 'Taies tachées à la livraison' })).status, 201);

  const mine = (await call('GET', NC)).data;
  assert.equal(mine.nonConformities.length, 2);
  assert.equal(mine.nonConformities[0].kind, 'sale', 'le plus récent d\'abord');

  // l'autre hôtel ne voit rien
  await asClient('b@exemple.fr');
  assert.deepEqual((await call('GET', NC)).data.nonConformities, []);
});

test('l\'équipe répond et clôt ; l\'hôtel lit la réponse', async () => {
  await asAdmin();
  let list = (await call('GET', ADM)).data;
  assert.equal(list.open, 2);
  const first = list.nonConformities.find(n => n.kind === 'manque');
  assert.equal(first.client.societe, 'Hôtel A');

  assert.equal((await call('PATCH', `${ADM}/${first.id}`, { status: 'nimporte' })).status, 400);
  assert.equal((await call('PATCH', `${ADM}/99999`, { status: 'resolue' })).status, 404);
  assert.equal((await call('PATCH', `${ADM}/${first.id}`, { teamNote: 'x'.repeat(1001) })).status, 400);

  const r = await call('PATCH', `${ADM}/${first.id}`, { status: 'resolue', teamNote: 'Les 2 draps vous sont livrés demain.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.nonConformity.status, 'resolue');
  assert.equal((await call('GET', `${ADM}?status=open`)).data.nonConformities.length, 1, 'le filtre « ouverts » écarte le traité');
  assert.equal((await call('GET', ADM)).data.open, 1);

  await asClient('a@exemple.fr');
  const mine = (await call('GET', NC)).data.nonConformities.find(n => n.id === first.id);
  assert.equal(mine.statusLabel, 'Traité');
  assert.equal(mine.teamNote, 'Les 2 draps vous sont livrés demain.');
});

test('le sac pour linge non conforme est un article du catalogue, créé une seule fois', async () => {
  const art = db.prepare("SELECT id, name, price, category FROM articles WHERE id = 'sac_nc'").get();
  assert.deepEqual(art, { id: 'sac_nc', name: 'Sac pour linge non conforme', price: 0, category: 'service' });
  assert.ok(db.prepare("SELECT 1 FROM schema_flags WHERE name = 'article_sac_non_conforme'").get());

  await asClient('a@exemple.fr');
  const cat = await call('GET', '/api/services');
  assert.ok(cat.data.services.some(x => x.id === 'sac_nc'), 'visible dans le catalogue de l\'hôtel');
  const order = await call('POST', '/api/orders', { items: [{ id: 'sac_nc', qty: 10 }], client: { societe: 'Hôtel A', contact: 'C', tel: '0600000000', adresse: '1 rue du Linge' } });
  assert.equal(order.status, 201, JSON.stringify(order.data));
});
