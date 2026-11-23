// Prévision des tournées fixes : on rejoue l'historique des livraisons pour savoir si le camion est assez grand
// (poids, volume, nombre de chariots) aux prochains passages.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const T = '/api/admin/logistics/tours';
let s, jdb, petit, mini, karim, lea, sans;
const call = (...a) => s.call(...a);
const paris = (d = new Date()) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const plusDays = (n) => { const d = new Date(`${paris()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekdayOf = (iso) => { const d = new Date(`${iso}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
const ALL = [1, 2, 3, 4, 5, 6, 7];

let n = 0;
const client = (societe) => Number(jdb.prepare(`INSERT INTO clients (societe, contact, tel, adresse, code_hash, created_at) VALUES (?, 'c', '0', ?, 'x', datetime('now'))`).run(societe, `1 rue ${societe}, Carpentras`).lastInsertRowid);
const article = (id, weightG, w, l, h) => jdb.prepare(`INSERT INTO articles (id, name, code, sage_code, price, weight_g, folded_width_cm, folded_length_cm, folded_height_cm) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, id, id, id, weightG, w, l, h);
function order(clientId, status, items, extra = {}) {
  n += 1;
  const id = Number(jdb.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, livraison_prevue, delivered_at, created_at) VALUES (?, ?, 'S', 'c', '0', 'a', ?, ?, ?, datetime('now'))`)
    .run(`CZ-P${n}`, clientId, status, extra.livraison ?? null, extra.deliveredAt ?? null).lastInsertRowid);
  for (const [art, qty] of items) jdb.prepare(`INSERT INTO order_items (order_id, service_id, name, code, price, qty) VALUES (?, ?, ?, ?, 1, ?)`).run(id, art, art, art, qty);
  return id;
}
/** Une livraison faite `ago` jours avant aujourd'hui. */
const delivered = (clientId, ago, items) => order(clientId, 'livree', items, { deliveredAt: `${plusDays(-ago)}T10:00:00.000Z`, livraison: plusDays(-ago) });
/** Même livraison chaque jour des 20 derniers jours (override possible par jour). */
function history(clientId, items, override = {}) {
  for (let ago = 1; ago <= 20; ago += 1) delivered(clientId, ago, override[ago] || items);
}
const tour = async (name, driverId, weekdays, clientIds) => {
  const r = await call('POST', T, { name, driverId, weekdays, clientIds });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.tour;
};
const fc = async (days) => (await call('GET', `${T}/forecast${days ? `?days=${days}` : ''}`)).data;
const find = (f, id) => f.tours.find(t => t.id === id);

test.before(async () => {
  s = await startServer({ env: { ROAD_ROUTING: 'off' } });
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  // Réglages : charge utile 100 kg, chariot vide 20 kg, 120 kg max par chariot
  jdb.prepare('UPDATE admin SET truck_capacity_kg = 100, cart_weight_kg = 20, max_cart_weight_kg = 120 WHERE id = 1').run();
  petit = Number(jdb.prepare(`INSERT INTO truck_types (name, length_cm, width_cm, height_cm) VALUES ('Petit', 200, 150, 150)`).run().lastInsertRowid); // 4,5 m³, 8 chariots au sol
  mini = Number(jdb.prepare(`INSERT INTO truck_types (name, length_cm, width_cm, height_cm) VALUES ('Mini', 100, 100, 200)`).run().lastInsertRowid); // 2 m³, 2 chariots au sol
  jdb.prepare('DELETE FROM cart_types').run(); // on écarte les chariots d'amorçage : jeu de données maîtrisé
  jdb.prepare(`INSERT INTO cart_types (name, length_cm, width_cm, height_cm) VALUES ('Chariot', 50, 70, 120)`).run(); // 420 L
  karim = (await call('POST', '/api/admin/logistics/drivers', { name: 'Karim' })).data.driver;
  lea = (await call('POST', '/api/admin/logistics/drivers', { name: 'Léa' })).data.driver;
  sans = (await call('POST', '/api/admin/logistics/drivers', { name: 'Sans camion' })).data.driver;
  jdb.prepare('UPDATE drivers SET truck_type_id = ? WHERE id = ?').run(petit, karim.id);
  jdb.prepare('UPDATE drivers SET truck_type_id = ? WHERE id = ?').run(mini, lea.id);
  article('drap', 1000, 40, 30, 5);       // 1 kg, 6 L
  article('couette', 200, 60, 50, 20);    // 0,2 kg, 60 L (volumineux, léger)
  article('sanspoids', 0, 0, 0, 0);       // aucune donnée
});
test.after(async () => { if (jdb) jdb.close(); if (s) await s.stop(); });

test('réservé à l\'administration', async () => {
  const anon = await startServer({ env: { ROAD_ROUTING: 'off' } });
  try { assert.equal((await anon.call('GET', `${T}/forecast`)).status, 401); } finally { await anon.stop(); }
});

test('charge régulière et légère : le camion est assez grand', async () => {
  const c = client('Régulier');
  history(c, [['drap', 10]]);
  const t = await tour('Léger', karim.id, ALL, [c]);
  const tt = find(await fc(), t.id);
  assert.equal(tt.verdict, 'ok');
  assert.equal(tt.history.orders, 20);
  assert.equal(tt.history.runs, 20);
  assert.equal(tt.truck.name, 'Petit');
  const p = tt.profiles[1];
  assert.equal(p.verdict, 'ok');
  const w = p.dims.find(d => d.key === 'weight');
  assert.equal(w.typical, 30, '10 kg de linge + 1 chariot vide de 20 kg');
  assert.equal(w.capacity, 100);
  assert.equal(p.dims.find(d => d.key === 'volume').capacity, 4.5);
  assert.equal(p.dims.find(d => d.key === 'carts').typical, 1);
  assert.equal(tt.warnings.length, 0, tt.warnings.join(' | '));
  await call('DELETE', `${T}/${t.id}`);
});

test('trop de poids : dépassé ; proche de la limite : juste', async () => {
  const lourd = client('Lourd'); history(lourd, [['drap', 100]]);        // 100 kg + 2 chariots = 140 kg
  const limite = client('Limite'); history(limite, [['drap', 70]]);      // 70 kg + 1 chariot = 90 kg
  const t1 = await tour('Lourde', karim.id, ALL, [lourd]);
  const t2 = await tour('Limite', lea.id, ALL, [limite]);
  const f = await fc();
  const a = find(f, t1.id), b = find(f, t2.id);
  assert.equal(a.verdict, 'depasse');
  assert.equal(a.profiles[1].limiting, 'weight');
  assert.equal(a.profiles[1].dims.find(d => d.key === 'weight').typical, 140);
  assert.equal(a.profiles[1].dims.find(d => d.key === 'carts').typical, 2);
  assert.equal(b.verdict, 'juste');
  assert.equal(b.profiles[1].ratio, 0.9);
  await call('DELETE', `${T}/${t1.id}`); await call('DELETE', `${T}/${t2.id}`);
});

test('un pic isolé ne fait pas passer la tournée en rouge : « juste » avec pic signalé', async () => {
  const c = client('Pic');
  history(c, [['drap', 10]], { 7: [['drap', 300]] });
  const t = await tour('Pic', karim.id, ALL, [c]);
  const tt = find(await fc(), t.id);
  const p = tt.profiles[1];
  assert.equal(p.verdict, 'juste');
  assert.equal(p.peak, true);
  const w = p.dims.find(d => d.key === 'weight');
  assert.equal(w.high, 30, 'la charge forte (9 jours sur 10) reste normale');
  assert.ok(w.max > 300, 'le pic observé est conservé');
  await call('DELETE', `${T}/${t.id}`);
});

test('le nombre de chariots qui tiennent sur le plancher limite : même charge, autre camion, autre verdict', async () => {
  const c = client('Volumineux');
  history(c, [['couette', 20]]);   // 4 kg mais 1 200 L → 3 chariots
  const t = await tour('Volumineuse', lea.id, ALL, [c]);
  const tt = find(await fc(), t.id);
  const p = tt.profiles[1];
  assert.equal(tt.truck.name, 'Mini');
  assert.equal(p.verdict, 'depasse');
  assert.equal(p.limiting, 'carts');
  const ch = p.dims.find(d => d.key === 'carts');
  assert.equal(ch.high, 3);
  assert.equal(ch.capacity, 2, '2 chariots seulement tiennent debout dans le Mini');
  assert.equal(p.dims.find(d => d.key === 'weight').typical, 64);
  assert.ok(tt.suggestions.some(x => x.name === 'Petit' && x.verdict === 'ok'), JSON.stringify(tt.suggestions));
  // avec le Petit camion : tout passe
  await call('PUT', `${T}/${t.id}`, { driverId: karim.id });
  assert.equal(find(await fc(), t.id).profiles[1].verdict, 'ok');
  await call('DELETE', `${T}/${t.id}`);
});

test('sans historique, sans camion, avec des données d\'articles manquantes : on le dit', async () => {
  const vide = client('Nouveau');
  const t0 = await tour('Sans histoire', karim.id, ALL, [vide]);
  const a = find(await fc(), t0.id);
  assert.equal(a.verdict, 'inconnu');
  assert.ok(a.warnings.some(w => /historique/i.test(w)), a.warnings.join(' | '));
  assert.equal((await fc()).runs.find(r => r.tourId === t0.id).verdict, 'inconnu');
  await call('DELETE', `${T}/${t0.id}`);

  const c = client('Sans camion'); history(c, [['drap', 10]]);
  const t1 = await tour('Orpheline', sans.id, ALL, [c]);
  const b = find(await fc(), t1.id);
  assert.equal(b.truck, null);
  assert.ok(b.warnings.some(w => /type de camion/i.test(w)), b.warnings.join(' | '));
  assert.deepEqual(b.profiles[1].dims.map(d => d.key), ['weight'], 'sans camion, seul le poids est comparé');
  await call('DELETE', `${T}/${t1.id}`);

  const m = client('Mal renseigné'); history(m, [['sanspoids', 10]]);
  const t2 = await tour('Données manquantes', karim.id, ALL, [m]);
  const d = find(await fc(), t2.id);
  assert.equal(d.history.coverage.weightPct, 0);
  assert.ok(d.warnings.some(w => /manquants/.test(w)), d.warnings.join(' | '));
  await call('DELETE', `${T}/${t2.id}`);
});

test('jour de la semaine précis, prochains passages et commandes déjà reçues', async () => {
  const demain = plusDays(1), wd = weekdayOf(demain);
  const c = client('Hebdo');
  for (let w = 1; w <= 5; w += 1) delivered(c, w * 7 - 1, [["drap", 10]]); // les 5 derniers passages (même jour de la semaine que demain)
  const t = await tour('Hebdo', karim.id, [wd], [c]);
  const reçue = order(c, 'recue', [['drap', 200]]);                       // 200 kg déjà commandés : partira demain
  const f = await fc();
  const tt = find(f, t.id);
  assert.equal(tt.profiles[wd].scope, 'weekday');
  assert.equal(tt.profiles[wd].runs, 5);
  assert.equal(tt.profiles[wd].verdict, 'ok');
  const runs = f.runs.filter(r => r.tourId === t.id);
  assert.equal(runs.length, 4, '28 jours = 4 passages');
  assert.equal(runs[0].date, demain);
  assert.ok(runs.every(r => r.weekday === wd));
  assert.equal(runs[0].known.orders, 1);
  assert.equal(runs[0].known.verdict, 'depasse', '200 kg + chariots dépassent le camion : visible dès maintenant');
  assert.equal(runs[0].verdict, 'depasse');
  assert.equal(runs[1].known, undefined);
  assert.equal(runs[1].verdict, 'ok');
  jdb.prepare('DELETE FROM orders WHERE id = ?').run(reçue);
  await call('DELETE', `${T}/${t.id}`);
});

test('un chariot trop haut pour le camion n\'est pas compté : prévenu', async () => {
  const bas = Number(jdb.prepare(`INSERT INTO truck_types (name, length_cm, width_cm, height_cm) VALUES ('Bas', 200, 150, 100)`).run().lastInsertRowid);
  const d = (await call('POST', '/api/admin/logistics/drivers', { name: 'Camion bas' })).data.driver;
  jdb.prepare('UPDATE drivers SET truck_type_id = ? WHERE id = ?').run(bas, d.id);
  const c = client('Chariots hauts'); history(c, [['drap', 10]]);
  const t = await tour('Bas', d.id, ALL, [c]);
  const tt = find(await fc(), t.id);
  assert.ok(tt.warnings.some(w => /chariot/i.test(w) && /Bas/.test(w)), tt.warnings.join(' | '));
  assert.deepEqual(tt.profiles[1].dims.map(x => x.key), ['weight', 'volume']);
  await call('DELETE', `${T}/${t.id}`);
});

test('une tournée désactivée n\'apparaît pas ; la durée est bornée', async () => {
  const c = client('Inactif'); history(c, [['drap', 5]]);
  const t = await tour('Inactive', karim.id, ALL, [c]);
  await call('PUT', `${T}/${t.id}`, { active: false });
  const f = await fc(9999);
  assert.equal(f.days, 60);
  assert.ok(!find(f, t.id));
  assert.equal((await fc(1)).days, 7);
  await call('DELETE', `${T}/${t.id}`);
});
