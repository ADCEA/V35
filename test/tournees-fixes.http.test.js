// Tournées fixes : planifiées à l'avance (jours, chauffeur, hôtels dans l'ordre), les commandes des hôtels rattachés
// partent automatiquement chez le bon chauffeur, et l'équipe peut tout modifier ou replacer une commande à la main.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const T = '/api/admin/logistics/tours';
let s, jdb, karim, lea, A, B, C;
const call = (...a) => s.call(...a);
const paris = (d = new Date()) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const plusDays = (n) => { const d = new Date(`${paris()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekdayOf = (iso) => { const d = new Date(`${iso}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
const ALL = [1, 2, 3, 4, 5, 6, 7];

function client(societe) {
  return Number(jdb.prepare(`INSERT INTO clients (societe, contact, tel, adresse, code_hash, created_at) VALUES (?, 'c', '0', ?, 'x', datetime('now'))`).run(societe, `1 rue ${societe}, Carpentras`).lastInsertRowid);
}
let n = 0;
function order(clientId, status = 'recue', extra = {}) {
  n += 1;
  return Number(jdb.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, livraison_prevue, created_at) VALUES (?, ?, 'S', 'c', '0', 'a', ?, ?, datetime('now'))`)
    .run(`CZ-T${n}`, clientId, status, extra.livraison ?? null).lastInsertRowid);
}
const row = (id) => jdb.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const orders = () => call('GET', '/api/admin/logistics/orders');

test.before(async () => {
  s = await startServer({ env: { ROAD_ROUTING: 'off' } });
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  karim = (await call('POST', '/api/admin/logistics/drivers', { name: 'Karim' })).data.driver;
  lea = (await call('POST', '/api/admin/logistics/drivers', { name: 'Léa' })).data.driver;
  A = client('Hôtel A'); B = client('Hôtel B'); C = client('Hôtel C');
});
test.after(async () => { if (jdb) jdb.close(); if (s) await s.stop(); });

test('réservé à l\'administration', async () => {
  const anon = await startServer({ env: { ROAD_ROUTING: 'off' } });
  try {
    assert.equal((await anon.call('GET', T)).status, 401);
    assert.equal((await anon.call('POST', T, { name: 'x' })).status, 401);
  } finally { await anon.stop(); }
});

test('création et validation d\'une tournée', async () => {
  assert.equal((await call('POST', T, { name: '  ' })).status, 400);
  assert.equal((await call('POST', T, { name: 'X', weekdays: [0] })).status, 400);
  assert.equal((await call('POST', T, { name: 'X', weekdays: [8] })).status, 400);
  assert.equal((await call('POST', T, { name: 'X', driverId: 9999 })).status, 400);
  assert.equal((await call('POST', T, { name: 'X', clientIds: [999999] })).status, 400);
  assert.equal((await call('PUT', `${T}/9999`, { name: 'X' })).status, 404);

  const r = await call('POST', T, { name: 'Centre-ville', driverId: karim.id, weekdays: [5, 1, 1], clientIds: [A, B] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const t = r.data.tour;
  assert.deepEqual(t.weekdays, [1, 5], 'jours triés, sans doublon');
  assert.deepEqual(t.clients.map(c => c.societe), ['Hôtel A', 'Hôtel B'], 'ordre de passage conservé');
  assert.equal(t.active, true);

  const list = await call('GET', T);
  assert.equal(list.data.tours.length, 1);
  assert.ok(list.data.clients.length >= 3 && list.data.drivers.length === 2);
  await call('DELETE', `${T}/${t.id}`);
  assert.equal((await call('GET', T)).data.tours.length, 0);
});

test('les commandes des hôtels rattachés rejoignent la tournée, dans l\'ordre ; modifier la tournée les replace', async () => {
  const t = (await call('POST', T, { name: 'Tous les jours', driverId: karim.id, weekdays: ALL, clientIds: [A, B] })).data.tour;
  const oa = order(A); const ob = order(B, 'prete'); const oc = order(C);

  const l = await orders();
  const byId = Object.fromEntries(l.data.orders.map(o => [o.id, o]));
  assert.equal(byId[oa].driverId, karim.id);
  assert.equal(byId[ob].driverId, karim.id);
  assert.equal(byId[oc].driverId ?? null, null, 'un hôtel hors tournée reste non assigné');
  assert.deepEqual([row(oa).delivery_sequence, row(ob).delivery_sequence], [1, 2]);
  assert.equal(row(oa).tour_id, t.id);

  // le chef inverse l'ordre de passage : les rangs suivent
  const re = await call('PUT', `${T}/${t.id}`, { clientIds: [B, A] });
  assert.equal(re.status, 200, JSON.stringify(re.data));
  assert.deepEqual([row(ob).delivery_sequence, row(oa).delivery_sequence], [1, 2]);

  // il change de chauffeur : les commandes suivent
  await call('PUT', `${T}/${t.id}`, { driverId: lea.id });
  assert.equal(row(oa).driver_id, lea.id);
  assert.equal(row(ob).driver_id, lea.id);

  // il retire un hôtel : sa commande redevient non assignée
  await call('PUT', `${T}/${t.id}`, { clientIds: [B] });
  assert.equal(row(oa).driver_id, null);
  assert.equal(row(oa).tour_id, null);
  assert.equal(row(ob).driver_id, lea.id);

  // il désactive la tournée : plus aucune commande affectée
  await call('PUT', `${T}/${t.id}`, { active: false });
  assert.equal(row(ob).driver_id, null);

  // il la supprime : rien ne reste accroché
  await call('PUT', `${T}/${t.id}`, { active: true });
  assert.equal(row(ob).driver_id, lea.id);
  assert.equal((await call('DELETE', `${T}/${t.id}`)).status, 200);
  assert.equal(row(ob).driver_id, null);
  assert.equal(jdb.prepare('SELECT COUNT(*) AS n FROM fixed_tour_clients').get().n, 0);
});

test('un placement à la main n\'est jamais défait par l\'automatisme', async () => {
  const t = (await call('POST', T, { name: 'Auto', driverId: karim.id, weekdays: ALL, clientIds: [A] })).data.tour;
  const o1 = order(A); const o2 = order(A);
  await orders();
  assert.equal(row(o1).driver_id, karim.id);

  // glisser-déposer vers un autre chauffeur, puis vers « non assigné »
  assert.equal((await call('PATCH', `/api/admin/logistics/orders/${o1}`, { driverId: lea.id, deliverySequence: null })).status, 200);
  assert.equal((await call('PATCH', `/api/admin/logistics/orders/${o2}`, { driverId: null, deliverySequence: null })).status, 200);
  await orders();
  await call('PUT', `${T}/${t.id}`, { name: 'Auto 2' });
  assert.equal(row(o1).driver_id, lea.id, 'resté chez le chauffeur choisi à la main');
  assert.equal(row(o2).driver_id, null, 'resté non assigné');
  await call('DELETE', `${T}/${t.id}`);
  assert.equal(row(o1).driver_id, lea.id, 'la suppression de la tournée ne touche pas aux placements manuels');
});

test('un hôtel ne peut pas être dans deux tournées qui roulent le même jour', async () => {
  const t1 = (await call('POST', T, { name: 'Lundi-Jeudi', driverId: karim.id, weekdays: [1, 4], clientIds: [A] })).data.tour;
  const clash = await call('POST', T, { name: 'Lundi', driverId: lea.id, weekdays: [1, 2], clientIds: [A, B] });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /Hôtel A/);
  assert.match(clash.data.error, /lundi/);
  const ok = await call('POST', T, { name: 'Mardi-Vendredi', driverId: lea.id, weekdays: [2, 5], clientIds: [A, B] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  // modifier pour recouvrir les jours de l'autre est refusé aussi, et rien n'est modifié
  const bad = await call('PUT', `${T}/${ok.data.tour.id}`, { weekdays: [2, 4] });
  assert.equal(bad.status, 409);
  assert.deepEqual((await call('GET', T)).data.tours.find(x => x.id === ok.data.tour.id).weekdays, [2, 5]);
  // une tournée inactive ne bloque personne
  await call('PUT', `${T}/${t1.id}`, { active: false });
  assert.equal((await call('PUT', `${T}/${ok.data.tour.id}`, { weekdays: [1, 2] })).status, 200);
  await call('DELETE', `${T}/${t1.id}`); await call('DELETE', `${T}/${ok.data.tour.id}`);
});

test('planifier à l\'avance : une tournée qui ne roule que demain prend déjà les commandes d\'aujourd\'hui, et le planning de demain les montre', async () => {
  const tomorrow = plusDays(1); const wd = weekdayOf(tomorrow);
  const other = ALL.filter(d => d !== wd)[0];
  const t = (await call('POST', T, { name: 'Demain', driverId: karim.id, weekdays: [wd], clientIds: [C, A] })).data.tour;
  const oc = order(C); const oa = order(A, 'traitement');
  await orders();
  assert.equal(row(oc).driver_id, karim.id);
  assert.deepEqual([row(oc).delivery_sequence, row(oa).delivery_sequence], [1, 2]);

  const plan = await call('GET', `${T}/plan`);   // par défaut : demain
  assert.equal(plan.status, 200);
  assert.equal(plan.data.date, tomorrow);
  assert.equal(plan.data.tours.length, 1);
  const tour = plan.data.tours[0];
  assert.equal(tour.driverName, 'Karim');
  assert.deepEqual(tour.stops.map(x => x.societe), ['Hôtel C', 'Hôtel A']);
  assert.ok(tour.stops[0].orders.some(x => x.id === oc), 'la commande de l\'hôtel apparaît sur son arrêt');
  assert.ok(tour.stops[1].orders.some(x => x.id === oa && x.status === 'traitement'));
  assert.equal(tour.stops[1].position, 2);

  const none = await call('GET', `${T}/plan?date=${plusDays(1 + ((other - wd + 7) % 7 || 7))}`);
  assert.equal(none.data.tours.length, 0, 'un autre jour de la semaine : rien ne roule');
  assert.equal((await call('GET', `${T}/plan?date=pas-une-date`)).status, 400);

  // une livraison déjà prévue plus tard est rattachée à la tournée qui roule ce jour-là ou après
  const later = plusDays(3);
  const ol = order(A, 'recue', { livraison: later });
  jdb.prepare('UPDATE orders SET driver_id = NULL WHERE id = ?').run(ol);
  assert.equal((await call('POST', `${T}/apply`)).status, 200);
  assert.equal(row(ol).driver_id, karim.id);
  await call('DELETE', `${T}/${t.id}`);
});

test('le livreur voit la commande prête de son hôtel sans qu\'on ouvre la logistique', async () => {
  const t = (await call('POST', T, { name: 'Portail', driverId: lea.id, weekdays: ALL, clientIds: [B] })).data.tour;
  const o = order(B, 'prete');
  assert.equal(row(o).driver_id, null, 'pas encore affectée : personne n\'a rien demandé');
  const g = await fetch(`${s.BASE}/api/driver-portal/${lea.access_token}`).then(r => r.json());
  assert.ok(g.stops.some(x => x.orderId === o), JSON.stringify(g.stops));
  await call('DELETE', `${T}/${t.id}`);
});

test('passer une commande à « prête » l\'affecte à la tournée de l\'hôtel', async () => {
  const t = (await call('POST', T, { name: 'Statut', driverId: karim.id, weekdays: ALL, clientIds: [C] })).data.tour;
  const o = order(C, 'traitement');
  jdb.prepare('UPDATE orders SET driver_id = NULL, tour_id = NULL WHERE id = ?').run(o);
  assert.equal((await call('PATCH', `/api/admin/orders/${o}/status`, { status: 'prete' })).status, 200);
  assert.equal(row(o).driver_id, karim.id);
  await call('DELETE', `${T}/${t.id}`);
});
