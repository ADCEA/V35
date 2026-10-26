// Duplication d'une commande par l'administrateur : le modèle de copie (client, articles, quantités commandées)
// puis la création réelle par la route de création manuelle, aux tarifs du jour.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

let s; let db; let hotel; let other; let src; let delivered;
const call = (...a) => s.call(...a);

test.before(async () => {
  s = await startServer();
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const art = db.prepare(`INSERT INTO articles (id, name, code, sage_code, price, category) VALUES (?,?,?,?,?,?)`);
  art.run('drap', 'Drap plat', 'DP', 'S-DP', 2, 'lit');
  art.run('taie', 'Taie', 'TA', 'S-TA', 1, 'lit');
  art.run('serv', 'Serviette', 'SE', 'S-SE', 0.5, 'toilette');
  const cl = db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash) VALUES (?,?,?,?,?,?)`);
  hotel = Number(cl.run('h@x.fr', 'Hôtel Les Lavandes', 'Jean', '0490', '1 rue Haute', 'x').lastInsertRowid);
  other = Number(cl.run('o@x.fr', 'Hôtel Autre', 'Eva', '0491', '2 rue Basse', 'x').lastInsertRowid);
  // commande d'origine : drap ×100 (prix d'époque 1,80), taie ×40, serviette ×20 ; livrée en partie
  const o = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, notes, status) VALUES (?,?,?,?,?,?,?,?,'livree')`);
  src = Number(o.run('CZ-2610-S1', hotel, 'Hôtel Les Lavandes', 'Jean', '0490', '1 rue Haute', '2026-10-01', 'Merci de livrer par la porte arrière').lastInsertRowid);
  const it = db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`);
  it.run(src, 'drap', 'Drap plat', 'DP', 'S-DP', 1.8, 100, 90);
  it.run(src, 'taie', 'Taie', 'TA', 'S-TA', 1, 40, 40);
  it.run(src, 'serv', 'Serviette', 'SE', 'S-SE', 0.5, 20, 20);
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  delivered = src;
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('réservé à l\'administrateur', async () => {
  s.newClient();
  const r = await call('GET', `/api/admin/orders/${src}/copy`);
  assert.equal(r.status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'secret123' })).status, 200);
});

test('modèle de copie : même client, articles et quantités COMMANDÉES (pas livrées), sans prix, note de traçabilité', async () => {
  const r = await call('GET', `/api/admin/orders/${delivered}/copy`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.clientId, hotel);
  assert.deepEqual(r.data.items.map(i => [i.serviceId, i.qty]), [['drap', 100], ['taie', 40], ['serv', 20]], 'quantités commandées, pas les 90 livrées');
  assert.deepEqual(r.data.skipped, []);
  assert.equal(r.data.notes, 'Copie de la commande CZ-2610-S1.');
  assert.ok(r.data.items.every(i => !('price' in i)), 'les prix ne sont pas copiés');
  assert.equal((await call('GET', '/api/admin/orders/99999/copy')).status, 404);
});

test('la copie se crée par la création manuelle : nouveau ticket, statut « reçue », tarifs du jour, original intact', async () => {
  // tarif négocié depuis le 1er octobre : le prix de la copie n'est pas celui d'époque (1,80)
  db.prepare(`INSERT INTO client_prices (client_id, article_id, price, date_debut) VALUES (?,?,?,?)`).run(hotel, 'drap', 1.65, '2026-01-01');
  const tpl = (await call('GET', `/api/admin/orders/${src}/copy`)).data;
  const made = await call('POST', '/api/admin/orders/manual', { clientId: tpl.clientId, items: tpl.items.map(({ serviceId, qty }) => ({ serviceId, qty })), livraisonPrevue: '2026-11-03', notes: tpl.notes });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.notEqual(made.data.ticket, 'CZ-2610-S1');
  const copy = db.prepare('SELECT * FROM orders WHERE ticket = ?').get(made.data.ticket);
  assert.equal(copy.status, 'recue');
  assert.equal(copy.client_id, hotel);
  assert.equal(copy.livraison_prevue, '2026-11-03');
  assert.equal(copy.notes, 'Copie de la commande CZ-2610-S1.');
  const items = db.prepare('SELECT service_id, qty, delivered_qty, price FROM order_items WHERE order_id = ? ORDER BY id').all(copy.id);
  assert.deepEqual(items.map(i => [i.service_id, i.qty, i.delivered_qty]), [['drap', 100, 100], ['taie', 40, 40], ['serv', 20, 20]]);
  assert.equal(items[0].price, 1.65, 'tarif négocié du jour, pas le prix figé de la commande d\'origine');
  // l'original n'a pas bougé
  const orig = db.prepare('SELECT status, livraison_prevue FROM orders WHERE id = ?').get(src);
  assert.deepEqual({ ...orig }, { status: 'livree', livraison_prevue: '2026-10-01' });
  assert.deepEqual(db.prepare('SELECT qty, delivered_qty, price FROM order_items WHERE order_id = ? ORDER BY id').all(src).map(i => [i.qty, i.delivered_qty, i.price]), [[100, 90, 1.8], [40, 40, 1], [20, 20, 0.5]]);
});

test('articles qui ne sont plus proposés à ce client : signalés, pas repris en silence ; plus rien à reprendre : refus clair', async () => {
  // le client n'a plus que le drap d'attribué
  db.prepare('INSERT INTO client_articles (client_id, article_id) VALUES (?,?)').run(hotel, 'drap');
  let r = await call('GET', `/api/admin/orders/${src}/copy`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.items.map(i => i.serviceId), ['drap']);
  assert.deepEqual(r.data.skipped.map(x => [x.name, x.qty]), [['Taie', 40], ['Serviette', 20]]);
  // un article supprimé du catalogue
  db.prepare('DELETE FROM client_articles WHERE client_id = ?').run(hotel);
  db.prepare('INSERT INTO client_articles (client_id, article_id) VALUES (?,?)').run(hotel, 'serv');
  r = await call('GET', `/api/admin/orders/${src}/copy`);
  assert.deepEqual(r.data.items.map(i => i.serviceId), ['serv']);
  assert.equal(r.data.skipped.length, 2);
  // plus aucun article de la commande n'est proposé
  db.prepare('DELETE FROM client_articles WHERE client_id = ?').run(hotel);
  db.prepare('INSERT INTO articles (id, name, code, sage_code, price, category) VALUES (?,?,?,?,?,?)').run('autre', 'Autre', 'AU', 'S-AU', 1, 'lit');
  db.prepare('INSERT INTO client_articles (client_id, article_id) VALUES (?,?)').run(hotel, 'autre');
  r = await call('GET', `/api/admin/orders/${src}/copy`);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /rien à dupliquer/);
  db.prepare('DELETE FROM client_articles WHERE client_id = ?').run(hotel);
});

test('client supprimé : la duplication est refusée avec une explication', async () => {
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status) VALUES ('CZ-2610-S2', NULL, 'Ancien client', 'X', '0', 'adr', 'livree')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, price, qty) VALUES (?,?,?,?,?,?)`).run(o, 'drap', 'Drap plat', 'DP', 1, 5);
  const r = await call('GET', `/api/admin/orders/${o}/copy`);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /n'existe plus/);
});

test('les quantités d\'un même article en plusieurs lignes sont additionnées', async () => {
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status) VALUES ('CZ-2610-S3', ?, 'Hôtel Les Lavandes', 'J', '0', 'adr', 'recue')`).run(hotel).lastInsertRowid);
  const it = db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, price, qty) VALUES (?,?,?,?,?,?)`);
  it.run(o, 'drap', 'Drap plat', 'DP', 1, 30); it.run(o, 'drap', 'Drap plat', 'DP', 1, 12);
  const r = await call('GET', `/api/admin/orders/${o}/copy`);
  assert.deepEqual(r.data.items.map(i => [i.serviceId, i.qty]), [['drap', 42]]);
});
