// Prévision de production : l'équipe saisit à l'avance les lots d'un jour à venir ; ces prévisions n'entrent dans aucun chiffre et se
// lancent le jour J (admin ou tablette), ce qui crée le vrai lot.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const A = '/api/admin/atelier';
const T = '/api/atelier';
const parisDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
const plus = (n) => parisDate(Date.now() + n * 86400000);
let s, db, M, types, hotel, hotel2, token, camille, order1;
const admin = (...a) => s.call(...a);
const mach = (name) => M.find(m => m.name === name);
async function tablet(method, url, body, tok = token) {
  const res = await fetch(s.BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { 'x-terminal-token': tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const plan = (day) => admin('GET', `${A}/forecast?day=${day}`);
const lotsCount = () => db.prepare('SELECT COUNT(*) AS n FROM lots').get().n;

test.before(async () => {
  s = await startServer();
  assert.equal((await admin('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  M = (await admin('GET', '/api/admin/rh/overview')).data.machines;
  types = (await admin('GET', `${A}/overview`)).data.linenTypes;
  hotel = Number(db.prepare(`INSERT INTO clients (societe, contact, tel, adresse, code_hash, created_at) VALUES ('Hôtel Prévu', 'c', '0', 'a', 'x', datetime('now'))`).run().lastInsertRowid);
  hotel2 = Number(db.prepare(`INSERT INTO clients (societe, contact, tel, adresse, code_hash, created_at) VALUES ('Mas Prévu', 'c', '0', 'a', 'x', datetime('now'))`).run().lastInsertRowid);
  db.prepare(`INSERT INTO articles (id, name, code, sage_code, price, category, weight_g) VALUES ('a-draps', 'Drap', 'DR', 'DR', 1, 'lit', 600)`).run();
  order1 = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, livraison_prevue, created_at) VALUES ('CZ-PV1', ?, 'Hôtel Prévu', 'c', '0', 'a', 'recue', ?, datetime('now'))`).run(hotel, plus(3)).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, price, qty) VALUES (?, 'a-draps', 'Drap', 'DR', 1, 100)`).run(order1);
  camille = (await admin('POST', '/api/admin/rh/employees', { firstName: 'Camille', lastName: 'Martin', contract: 'cdi', machineId: mach('Laveuse 1').id, pin: '4827', hourlyCost: '20' })).data.employee;
  token = (await admin('POST', '/api/admin/rh/terminals', { label: 'Atelier' })).data.token;
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('réservé à l\'administration (et à la tablette pour lancer)', async () => {
  assert.equal((await fetch(`${s.BASE}${A}/forecast`)).status, 401);
  assert.equal((await fetch(`${s.BASE}${A}/forecasts`, { method: 'POST' })).status, 401);
  assert.equal((await tablet('POST', `${T}/forecasts/1/launch`, {}, null)).status, 401);
});

let f1;
test('saisie d\'une prévision pour demain : contrôles, puis lecture du jour', async () => {
  const tomorrow = plus(1);
  const ok = { day: tomorrow, linenTypeId: types[0].id, weightKg: '24,5', clients: [{ clientId: hotel, orderId: order1, weightKg: 14 }, { societe: 'Camping des Pins', weightKg: 8 }], machineId: mach('Laveuse 1').id, note: 'Draps du week-end' };
  // refus
  assert.equal((await admin('POST', `${A}/forecasts`, { ...ok, day: plus(-1) })).status, 400, 'pas de prévision dans le passé');
  assert.equal((await admin('POST', `${A}/forecasts`, { ...ok, day: 'demain' })).status, 400);
  assert.equal((await admin('POST', `${A}/forecasts`, { ...ok, day: plus(200) })).status, 400, 'trop loin');
  assert.equal((await admin('POST', `${A}/forecasts`, { ...ok, linenTypeId: 9999 })).status, 400);
  assert.equal((await admin('POST', `${A}/forecasts`, { ...ok, clients: [] })).status, 400);
  assert.equal((await admin('POST', `${A}/forecasts`, { ...ok, weightKg: -3 })).status, 400);
  assert.equal((await admin('POST', `${A}/forecasts`, { ...ok, clients: [{ clientId: hotel, weightKg: 30 }] })).status, 400, 'les poids par client ne dépassent pas le total');
  const wrong = await admin('POST', `${A}/forecasts`, { ...ok, machineId: mach('Calandre 320 cm').id });
  assert.equal(wrong.status, 400, 'la laveuse prévue doit être une laveuse');
  assert.equal((await admin('POST', `${A}/forecasts`, { ...ok, weightKg: 9999 })).status, 400);

  const r = await admin('POST', `${A}/forecasts`, ok);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  f1 = r.data.forecast;
  assert.equal(f1.status, 'prevu');
  assert.equal(f1.weightKg, 24.5);
  assert.equal(f1.machineName, 'Laveuse 1');
  assert.deepEqual(f1.clients.map(c => c.societe), ['Hôtel Prévu', 'Camping des Pins']);
  assert.equal(f1.clients[0].orderTicket, 'CZ-PV1');

  // sans poids, sans machine : permis (on prévoit ce qu'on sait)
  const light = await admin('POST', `${A}/forecasts`, { day: tomorrow, linenTypeId: types[1].id, clients: [{ clientId: hotel2 }] });
  assert.equal(light.status, 201, JSON.stringify(light.data));
  assert.equal(light.data.forecast.weightKg, null);

  const p = (await plan(tomorrow)).data;
  assert.equal(p.today, plus(0));
  assert.deepEqual(p.forecasts.map(f => f.id), [f1.id, light.data.forecast.id]);
  assert.deepEqual([p.totals.count, p.totals.kg, p.totals.withoutWeight, p.totals.clients], [2, 24.5, 1, 3]);
  assert.equal(p.upcoming.length, 7);
  assert.deepEqual(p.upcoming.slice(0, 3).map(d => d.count), [0, 2, 0]);
  assert.equal(p.upcoming[1].day, tomorrow);
  // par défaut, l'écran montre demain
  assert.equal((await admin('GET', `${A}/forecast`)).data.day, tomorrow);
});

test('une prévision n\'est pas un lot : aucun lot, aucun passage, aucun chiffre', async () => {
  assert.equal(lotsCount(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lot_steps').get().n, 0);
  const o = (await admin('GET', `${A}/overview?day=${plus(0)}`)).data;
  assert.equal(o.view.totals.lots, 0);
  assert.ok(o.machines.every(m => m.state === 'free'));
  assert.deepEqual(o.forecastDue, [], 'rien à lancer tant que le jour n\'est pas arrivé');
  const st = await admin('GET', `${A}/stats?from=${plus(-6)}&to=${plus(0)}`);
  assert.equal(st.status, 200);
});

test('commandes à planifier : estimation du poids, et disparition une fois prévues', async () => {
  const p = (await plan(plus(1))).data;
  assert.ok(!p.orders.some(o => o.orderId === order1), 'la commande déjà prévue n\'est pas reproposée');
  const o2 = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, created_at) VALUES ('CZ-PV2', ?, 'Mas Prévu', 'c', '0', 'a', 'traitement', datetime('now'))`).run(hotel2).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, price, qty) VALUES (?, 'a-draps', 'Drap', 'DR', 1, 50)`).run(o2);
  const q = (await plan(plus(1))).data.orders.find(o => o.orderId === o2);
  assert.ok(q);
  assert.equal(q.estimatedKg, 30);                       // 50 draps × 600 g
  assert.equal(q.societe, 'Mas Prévu');
  const ok = await admin('POST', `${A}/forecasts`, { day: plus(2), linenTypeId: types[0].id, clients: [{ clientId: hotel2, orderId: o2 }] });
  assert.equal(ok.status, 201);
  assert.ok(!(await plan(plus(1))).data.orders.some(o => o.orderId === o2));
  // la supprimer la remet dans la liste
  assert.equal((await admin('DELETE', `${A}/forecasts/${ok.data.forecast.id}`)).status, 200);
  assert.ok((await plan(plus(1))).data.orders.some(o => o.orderId === o2));
});

test('modifier, réordonner, recopier, supprimer', async () => {
  const tomorrow = plus(1);
  const [a, b] = (await plan(tomorrow)).data.forecasts;
  // ordre
  assert.equal((await admin('POST', `${A}/forecasts/${b.id}/move`, { direction: 'up' })).status, 200);
  assert.deepEqual((await plan(tomorrow)).data.forecasts.map(f => f.id), [b.id, a.id]);
  assert.equal((await admin('POST', `${A}/forecasts/${b.id}/move`, { direction: 'up' })).status, 200, 'déjà en tête : sans effet');
  assert.equal((await admin('POST', `${A}/forecasts/${b.id}/move`, { direction: 'sideways' })).status, 400);
  assert.equal((await admin('POST', `${A}/forecasts/99999/move`, { direction: 'up' })).status, 404);

  // modification partielle : le reste est conservé
  const u = await admin('PUT', `${A}/forecasts/${a.id}`, { weightKg: 26, note: '' });
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.equal(u.data.forecast.weightKg, 26);
  assert.equal(u.data.forecast.note, null);
  assert.equal(u.data.forecast.clients.length, 2);
  assert.equal(u.data.forecast.machineName, 'Laveuse 1');
  assert.equal((await admin('PUT', `${A}/forecasts/${a.id}`, { machineId: null })).data.forecast.machineId, null);
  assert.equal((await admin('PUT', `${A}/forecasts/${a.id}`, { day: plus(-2) })).status, 400);
  assert.equal((await admin('PUT', `${A}/forecasts/99999`, { weightKg: 1 })).status, 404);

  // changer le jour déplace la prévision
  await admin('PUT', `${A}/forecasts/${b.id}`, { day: plus(4) });
  assert.deepEqual((await plan(tomorrow)).data.forecasts.map(f => f.id), [a.id]);
  assert.deepEqual((await plan(plus(4))).data.forecasts.map(f => f.id), [b.id]);

  // recopier un jour sur un autre (sans la commande liée)
  const c = await admin('POST', `${A}/forecasts/copy`, { from: tomorrow, to: plus(5) });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(c.data.copied, 1);
  const copy = (await plan(plus(5))).data.forecasts[0];
  assert.equal(copy.linenTypeId, a.linenTypeId);
  assert.equal(copy.weightKg, 26);
  assert.ok(copy.clients.every(x => x.orderId === null));
  assert.equal((await admin('POST', `${A}/forecasts/copy`, { from: tomorrow, to: tomorrow })).status, 400);
  assert.equal((await admin('POST', `${A}/forecasts/copy`, { from: plus(9), to: plus(6) })).status, 400, 'jour d\'origine vide');
  assert.equal((await admin('POST', `${A}/forecasts/copy`, { from: tomorrow, to: plus(-1) })).status, 400);

  assert.equal((await admin('DELETE', `${A}/forecasts/${copy.id}`)).status, 200);
  assert.equal((await admin('DELETE', `${A}/forecasts/${copy.id}`)).status, 404);
  assert.equal((await admin('DELETE', `${A}/forecasts/${b.id}`)).status, 200);
});

test('lancer : pas avant le jour J ; le lot créé reprend la prévision ; une prévision ne se lance qu\'une fois', async () => {
  const tomorrow = plus(1);
  const [a] = (await plan(tomorrow)).data.forecasts;
  const early = await admin('POST', `${A}/forecasts/${a.id}/launch`, { machineId: mach('Laveuse 1').id });
  assert.equal(early.status, 409);
  assert.equal(early.data.code, 'TOO_EARLY');
  assert.equal(lotsCount(), 0);

  // le chef la passe à aujourd'hui : elle devient « à lancer »
  assert.equal((await admin('PUT', `${A}/forecasts/${a.id}`, { day: plus(0) })).status, 200);
  const due = (await admin('GET', `${A}/overview`)).data.forecastDue;
  assert.deepEqual(due.map(f => f.id), [a.id]);

  // laveuse occupée : rien n'est créé, la prévision reste à lancer
  const busy = mach('Laveuse 2');
  const other = await admin('POST', `${A}/lots`, { linenTypeId: types[2].id, clients: [{ societe: 'Autre' }], weightKg: 10, machineId: busy.id, date: plus(0), start: '06:00' });
  assert.equal(other.status, 201, JSON.stringify(other.data));
  const clash = await admin('POST', `${A}/forecasts/${a.id}/launch`, { machineId: busy.id, date: plus(0), start: '06:30' });
  assert.equal(clash.status, 409, JSON.stringify(clash.data));
  assert.equal(lotsCount(), 1);
  assert.equal((await admin('GET', `${A}/overview`)).data.forecastDue.length, 1);

  // lancement : ce qui n'est pas précisé reprend la prévision (type, clients, poids)
  const go = await admin('POST', `${A}/forecasts/${a.id}/launch`, { machineId: mach('Laveuse 1').id });
  assert.equal(go.status, 201, JSON.stringify(go.data));
  const lot = go.data.lot;
  assert.equal(lot.linenTypeId, types[0].id);
  assert.equal(lot.weightKg, 26);
  assert.deepEqual(lot.clients.map(c => c.societe), ['Hôtel Prévu', 'Camping des Pins']);
  assert.equal(lot.clients[0].orderTicket, 'CZ-PV1');
  assert.equal(lot.steps.length, 1);
  assert.equal(lot.steps[0].machineName, 'Laveuse 1');
  assert.equal(lotsCount(), 2);

  const after = (await plan(plus(0))).data.forecasts.find(f => f.id === a.id);
  assert.equal(after.status, 'lance');
  assert.equal(after.lotCode, lot.code);
  assert.deepEqual((await admin('GET', `${A}/overview`)).data.forecastDue, []);

  // plus rien à faire sur une prévision lancée
  assert.equal((await admin('POST', `${A}/forecasts/${a.id}/launch`, { machineId: mach('Laveuse 3').id })).status, 409);
  assert.equal((await admin('PUT', `${A}/forecasts/${a.id}`, { weightKg: 5 })).status, 409);
  assert.equal((await admin('DELETE', `${A}/forecasts/${a.id}`)).status, 409);
  assert.equal(lotsCount(), 2);
});

test('tablette : les prévisions du jour s\'affichent et se lancent avec le code du collaborateur', async () => {
  const mk = await admin('POST', `${A}/forecasts`, { day: plus(0), linenTypeId: types[3].id, weightKg: 18, clients: [{ clientId: hotel2 }], note: 'Peignoirs spa' });
  assert.equal(mk.status, 201);
  const id = mk.data.forecast.id;
  await admin('POST', `${A}/forecasts`, { day: plus(1), linenTypeId: types[0].id, weightKg: 22, clients: [{ clientId: hotel }] });

  const st = (await tablet('GET', `${T}/state`)).data;
  assert.deepEqual(st.forecast.due.map(f => f.id), [id]);
  assert.equal(st.forecast.due[0].linenType, 'Spa');
  assert.ok(st.forecast.tomorrow.count >= 1 && st.forecast.tomorrow.kg >= 22, JSON.stringify(st.forecast.tomorrow));

  const noPin = await tablet('POST', `${T}/forecasts/${id}/launch`, { machineId: mach('Laveuse 3').id });
  assert.equal(noPin.status, 401);
  assert.equal(lotsCount(), 2);

  const go = await tablet('POST', `${T}/forecasts/${id}/launch`, { employeeId: camille.id, pin: '4827', machineId: mach('Laveuse 3').id, weightKg: 17.5 });
  assert.equal(go.status, 201, JSON.stringify(go.data));
  assert.equal(go.data.lot.weightKg, 17.5, 'le poids réellement chargé prime sur la prévision');
  assert.equal(go.data.lot.createdBy, 'Camille Martin');
  assert.equal(go.data.lot.note, 'Peignoirs spa');
  assert.deepEqual((await tablet('GET', `${T}/state`)).data.forecast.due, []);
  assert.equal((await tablet('POST', `${T}/forecasts/${id}/launch`, { employeeId: camille.id, pin: '4827', machineId: mach('Laveuse 1').id })).status, 409);
});
