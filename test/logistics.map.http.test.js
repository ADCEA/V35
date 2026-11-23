// Carte des tournées : le livreur valide ses livraisons sur son lien (heure enregistrée), peut partager sa position,
// et l'administration voit sur la carte les arrêts faits / à faire et où se trouve chaque camion.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

let s, jdb, driver, other, depot;
const call = (...a) => s.call(...a);
const portal = (token, method, url, body) => fetch(`${s.BASE}/api/driver-portal/${token}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));

function order(ticket, { driverId = null, seq = null, status = 'prete', lat = 44.05, lng = 5.05, societe = `Hôtel ${ticket}` } = {}) {
  return jdb.prepare(`INSERT INTO orders (ticket, societe, contact, tel, adresse, status, created_at, driver_id, delivery_sequence, lat, lng)
    VALUES (?, ?, 'c', '0', ?, ?, datetime('now'), ?, ?, ?, ?)`).run(ticket, societe, `1 rue ${ticket}, Carpentras`, status, driverId, seq, lat, lng).lastInsertRowid;
}
const row = (id) => jdb.prepare('SELECT * FROM orders WHERE id = ?').get(id);

test.before(async () => {
  s = await startServer({ env: { ROAD_ROUTING: 'off' } });
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  driver = (await call('POST', '/api/admin/logistics/drivers', { name: 'Karim', vehicle: 'Camionnette 1' })).data.driver;
  other = (await call('POST', '/api/admin/logistics/drivers', { name: 'Léa' })).data.driver;
  jdb.prepare('UPDATE admin SET depot_address = ?, depot_lat = ?, depot_lng = ? WHERE id = 1').run('35 rue Théodore Aubanel, Carpentras', 44.0553, 5.0489);
  depot = { lat: 44.0553, lng: 5.0489 };
});
test.after(async () => { if (jdb) jdb.close(); if (s) await s.stop(); });

test('la carte est réservée à l\'administration', async () => {
  const anon = await startServer({ env: { ROAD_ROUTING: 'off' } });
  try { assert.equal((await anon.call('GET', '/api/admin/logistics/map')).status, 401); } finally { await anon.stop(); }
});

test('le livreur valide une livraison : l\'heure est enregistrée, la commande passe à livrée, un second appui ne change rien', async () => {
  const a = order('CZ-A1', { driverId: driver.id, seq: 1 });
  const b = order('CZ-A2', { driverId: driver.id, seq: 2, lat: 44.06, lng: 5.06 });

  let g = await portal(driver.access_token, 'GET', '');
  assert.equal(g.status, 200);
  assert.deepEqual(g.data.stops.map(x => x.ticket), ['CZ-A1', 'CZ-A2']);
  assert.deepEqual(g.data.deliveredToday, []);

  const before = Date.now();
  const r = await portal(driver.access_token, 'POST', `/orders/${a}/deliver`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.already, false);
  assert.equal(r.data.remaining, 1);
  const o = row(a);
  assert.equal(o.status, 'livree');
  assert.ok(Math.abs(Date.parse(o.delivered_at) - before) < 5000, 'heure du serveur');
  assert.match(o.livraison_prevue, /^\d{4}-\d{2}-\d{2}$/, 'la date de livraison est complétée comme côté administration');
  assert.equal(o.delivered_lat, null, 'sans partage de position, aucun lieu n\'est enregistré');

  const again = await portal(driver.access_token, 'POST', `/orders/${a}/deliver`, {});
  assert.equal(again.status, 200);
  assert.equal(again.data.already, true);
  assert.equal(again.data.deliveredAt, o.delivered_at, 'l\'heure d\'origine est conservée');

  g = await portal(driver.access_token, 'GET', '');
  assert.deepEqual(g.data.stops.map(x => x.ticket), ['CZ-A2'], 'l\'arrêt livré quitte la liste des restants');
  assert.deepEqual(g.data.deliveredToday.map(x => x.ticket), ['CZ-A1']);
  assert.equal(g.data.deliveredToday[0].minutesSincePrev, null);

  // une commande pas encore prête, ou celle d'un autre livreur, ne se valide pas
  const notReady = order('CZ-A3', { driverId: driver.id, seq: 3, status: 'traitement' });
  assert.equal((await portal(driver.access_token, 'POST', `/orders/${notReady}/deliver`, {})).status, 409);
  assert.equal((await portal(other.access_token, 'POST', `/orders/${b}/deliver`, {})).status, 404);
  assert.equal((await portal('jeton-inconnu', 'POST', `/orders/${b}/deliver`, {})).status, 404);
  assert.equal(row(b).status, 'prete');
});

test('position partagée : validée, bornée, effacée à l\'arrêt et à la dernière livraison', async () => {
  const t = driver.access_token;
  assert.equal((await portal(t, 'POST', '/position', { lat: 'abc', lng: 5 })).status, 400);
  assert.equal((await portal(t, 'POST', '/position', { lat: 91, lng: 5 })).status, 400);
  assert.equal((await portal(t, 'POST', '/position', { lat: 44.056, lng: 5.052, accuracy: 12 })).status, 200);
  let d = jdb.prepare('SELECT * FROM drivers WHERE id = ?').get(driver.id);
  assert.deepEqual([d.last_lat, d.last_lng, d.last_accuracy_m], [44.056, 5.052, 12]);
  assert.equal((await portal('jeton-inconnu', 'POST', '/position', { lat: 44, lng: 5 })).status, 404);

  assert.equal((await portal(t, 'POST', '/position/stop', {})).status, 200);
  d = jdb.prepare('SELECT * FROM drivers WHERE id = ?').get(driver.id);
  assert.deepEqual([d.last_lat, d.last_lng, d.last_position_at], [null, null, null]);

  // validation avec position : le lieu est conservé avec la livraison ; la dernière livraison efface la position
  const c = order('CZ-P1', { driverId: other.id, seq: 1 });
  assert.equal((await portal(other.access_token, 'POST', '/position', { lat: 44.07, lng: 5.07 })).status, 200);
  const r = await portal(other.access_token, 'POST', `/orders/${c}/deliver`, { lat: 44.0702, lng: 5.0701, accuracy: 8 });
  assert.equal(r.status, 200);
  assert.deepEqual([row(c).delivered_lat, row(c).delivered_lng], [44.0702, 5.0701]);
  assert.equal(jdb.prepare('SELECT last_lat FROM drivers WHERE id = ?').get(other.id).last_lat, null, 'plus de livraison à faire : plus de position conservée');
});

test('la carte : arrêts livrés / à faire, durée entre livraisons, position du camion', async () => {
  const t = driver.access_token;
  // deux livraisons validées à 25 minutes d'écart, puis un arrêt restant
  const first = order('CZ-M1', { driverId: driver.id, seq: 10, lat: 44.07, lng: 5.07 });
  const second = order('CZ-M2', { driverId: driver.id, seq: 11, lat: 44.08, lng: 5.08 });
  const third = order('CZ-M3', { driverId: driver.id, seq: 12, lat: 44.09, lng: 5.09 });
  await portal(t, 'POST', `/orders/${first}/deliver`, {});
  await portal(t, 'POST', `/orders/${second}/deliver`, {});
  // la livraison de CZ-A1, validée plus haut dans ce fichier, est antérieure : la dernière du jour reste CZ-M2
  jdb.prepare("UPDATE orders SET delivered_at = ? WHERE ticket = 'CZ-A1'").run(new Date(Date.now() - 120 * 60000).toISOString());
  jdb.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(new Date(Date.now() - 60 * 60000).toISOString(), first);
  jdb.prepare('UPDATE orders SET delivered_at = ? WHERE id = ?').run(new Date(Date.now() - 35 * 60000).toISOString(), second);

  let m = (await call('GET', '/api/admin/logistics/map')).data;
  assert.deepEqual(m.depot, { lat: depot.lat, lng: depot.lng, address: '35 rue Théodore Aubanel, Carpentras' });
  const k = m.drivers.find(x => x.id === driver.id);
  const pend = k.stops.filter(x => x.status === 'pending').map(x => x.ticket);
  assert.ok(pend.includes('CZ-M3'));
  const m2 = k.stops.find(x => x.ticket === 'CZ-M2');
  assert.equal(m2.status, 'delivered');
  assert.equal(m2.minutesSincePrev, 25);
  assert.equal(k.stats.done >= 2, true);
  assert.ok(k.stats.avgMinutesBetween >= 0);
  assert.equal(k.color.startsWith('#'), true);

  // sans position partagée : le camion est à la dernière livraison validée
  assert.equal(k.truck.source, 'delivery');
  assert.equal(k.truck.label, 'Hôtel CZ-M2');
  assert.deepEqual([k.truck.lat, k.truck.lng], [44.08, 5.08]);

  // les tronçons : faits pour les arrêts livrés, restants pour les autres, partant du dépôt
  assert.equal(k.legs.length, k.stops.filter(x => x.lat != null).length);
  assert.deepEqual(k.legs[0].points[0], [depot.lat, depot.lng]);
  assert.equal(k.legs.find(l => l.points[1][0] === 44.09).done, false);
  assert.equal(k.legs.find(l => l.points[1][0] === 44.08).done, true);

  // position partagée récente : elle prime
  await portal(t, 'POST', '/position', { lat: 44.085, lng: 5.085, accuracy: 15 });
  m = (await call('GET', '/api/admin/logistics/map')).data;
  const live = m.drivers.find(x => x.id === driver.id);
  assert.equal(live.sharing, true);
  assert.deepEqual([live.truck.source, live.truck.lat, live.truck.lng], ['gps', 44.085, 5.085]);

  // position périmée : retour à la dernière livraison
  jdb.prepare('UPDATE drivers SET last_position_at = ? WHERE id = ?').run(new Date(Date.now() - 30 * 60000).toISOString(), driver.id);
  m = (await call('GET', '/api/admin/logistics/map')).data;
  assert.equal(m.drivers.find(x => x.id === driver.id).truck.source, 'delivery');
  assert.equal(m.drivers.find(x => x.id === driver.id).sharing, false);

  // une commande prête sans chauffeur apparaît à part
  order('CZ-U1');
  m = (await call('GET', '/api/admin/logistics/map')).data;
  assert.ok(m.unassigned.some(x => x.ticket === 'CZ-U1'));
});

test('l\'heure de livraison suit le statut côté administration', async () => {
  const id = order('CZ-S1', { driverId: driver.id, seq: 50, status: 'prete' });
  assert.equal(row(id).delivered_at, null);
  assert.equal((await call('PATCH', `/api/admin/orders/${id}/status`, { status: 'livree' })).status, 200);
  const at = row(id).delivered_at;
  assert.ok(at, 'posée au passage en livrée');
  assert.equal((await call('PATCH', `/api/admin/orders/${id}/status`, { status: 'prete' })).status, 200);
  assert.equal(row(id).delivered_at, null, 'effacée si la commande repasse à un statut antérieur');
});

test('la page du livreur peut demander la position ; aucune autre page ne le peut', async () => {
  const tour = await fetch(`${s.BASE}/tournee.html`);
  assert.match(tour.headers.get('permissions-policy'), /geolocation=\(self\)/);
  const home = await fetch(`${s.BASE}/`);
  assert.match(home.headers.get('permissions-policy'), /geolocation=\(\)/);
  assert.match(home.headers.get('content-security-policy'), /img-src[^;]*https:\/\/tile\.openstreetmap\.org/);
});
