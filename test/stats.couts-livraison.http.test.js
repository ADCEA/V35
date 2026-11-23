// Statistiques : coûts de livraison (carburant/usure au km, chauffeur à l'heure, entretien du Garage, frais fixes au prorata).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const U = '/api/admin/stats/delivery-costs';
const Q = '?from=2026-11-01&to=2026-11-30';   // 30 jours
let s, jdb, karim, lea;
const call = (...a) => s.call(...a);

function delivered(ticket, { driver, date, km, status = 'livree', weightG = null }) {
  const id = jdb.prepare(`INSERT INTO orders (ticket, societe, contact, tel, adresse, status, created_at, driver_id, livraison_prevue, distance_from_prev_km, delivered_at)
    VALUES (?, 'Hôtel T', 'c', '0', 'a', ?, ?, ?, ?, ?, ?)`).run(ticket, status, `${date} 08:00:00`, driver, date, km, status === 'livree' ? `${date}T10:00:00.000Z` : null).lastInsertRowid;
  return id;
}

test.before(async () => {
  s = await startServer({ env: { ROAD_ROUTING: 'off' } });
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  karim = (await call('POST', '/api/admin/logistics/drivers', { name: 'Karim' })).data.driver;
  lea = (await call('POST', '/api/admin/logistics/drivers', { name: 'Léa' })).data.driver;
  jdb.prepare('UPDATE admin SET avg_speed_kmh = 40, minutes_per_stop = 20 WHERE id = 1').run();
  // Karim : 2 arrêts le 10/11 (10 + 5 km) ; Léa : 1 arrêt le 11/11 sans distance ; hors période et non livrée : ignorées
  delivered('CZ-C1', { driver: karim.id, date: '2026-11-10', km: 10 });
  delivered('CZ-C2', { driver: karim.id, date: '2026-11-10', km: 5 });
  delivered('CZ-C3', { driver: lea.id, date: '2026-11-11', km: null });
  delivered('CZ-C4', { driver: karim.id, date: '2026-10-20', km: 99 });
  delivered('CZ-C5', { driver: karim.id, date: '2026-11-12', km: 50, status: 'prete' });
  const truck = jdb.prepare("INSERT INTO truck_types (name, length_cm, width_cm, height_cm) VALUES ('Master', 400, 200, 200)").run().lastInsertRowid;
  jdb.prepare("INSERT INTO truck_maintenance (truck_type_id, date, type, cost) VALUES (?, '2026-11-12', 'Vidange', 100)").run(truck);
  jdb.prepare("INSERT INTO truck_maintenance (truck_type_id, date, type, cost) VALUES (?, '2026-10-02', 'Pneus', 800)").run(truck);
  jdb.prepare("INSERT INTO truck_maintenance (truck_type_id, date, type, cost) VALUES (?, '2026-11-20', 'Contrôle', NULL)").run(truck);
});
test.after(async () => { if (jdb) jdb.close(); if (s) await s.stop(); });

test('réservé à l\'administration', async () => {
  const anon = await startServer({ env: { ROAD_ROUTING: 'off' } });
  try {
    assert.equal((await anon.call('GET', U + Q)).status, 401);
    assert.equal((await anon.call('PUT', `${U}/settings`, { perKm: 1 })).status, 401);
  } finally { await anon.stop(); }
});

test('sans réglage : seul l\'entretien du Garage est compté, et le total est dit partiel', async () => {
  const r = await call('GET', U + Q);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.equal(d.partial, true);
  assert.deepEqual(d.missing.sort(), ['driverHourly', 'fixedMonthly', 'perKm']);
  assert.deepEqual(d.components, { perKm: null, driver: null, maintenance: 10000, fixed: null }, 'entretien du mois seulement (octobre et sans montant écartés)');
  assert.equal(d.totalCents, 10000);
  assert.equal(d.deliveries, 3);
  assert.equal(d.km, 15);
  assert.equal(d.withoutDistance, 1);
  assert.equal(d.maintenanceEntries, 1);
  assert.equal(d.perDeliveryCents, Math.round(10000 / 3));
});

test('réglages saisis en euros (virgule acceptée), puis coûts calculés poste par poste', async () => {
  const put = await call('PUT', `${U}/settings`, { perKm: '0,25', driverHourly: 20, fixedMonthly: ' 300 ' });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data.settings, { perKm: 0.25, driverHourly: 20, fixedMonthly: 300 });

  const d = (await call('GET', U + Q)).data;
  assert.equal(d.partial, false);
  assert.deepEqual(d.missing, []);
  // Karim le 10/11 : 15 km, 2 arrêts → (15/40×60 + 2×20) / 60 = 1,0417 h ; Léa le 11/11 : 0 km, 1 arrêt → 20 min
  const hoursKarim = (15 / 40 * 60 + 2 * 20) / 60, hoursLea = 20 / 60;
  assert.equal(d.components.perKm, 375);
  assert.equal(d.components.driver, Math.round((hoursKarim + hoursLea) * 20 * 100));
  assert.equal(d.components.maintenance, 10000);
  assert.equal(d.components.fixed, Math.round(300 * 100 * 30 / (365 / 12)), 'frais fixes au prorata des 30 jours');
  const sum = d.components.perKm + d.components.driver + d.components.maintenance + d.components.fixed;
  assert.equal(d.totalCents, sum);
  assert.equal(d.perDeliveryCents, Math.round(sum / 3));
  assert.equal(d.perKmCents, Math.round(sum / 15));
  assert.equal(d.hours, Math.round((hoursKarim + hoursLea) * 10) / 10);

  // par chauffeur et par jour : carburant + temps seulement
  const k = d.byDriver.find(x => x.driver === 'Karim'), l = d.byDriver.find(x => x.driver === 'Léa');
  assert.equal(k.stops, 2); assert.equal(k.km, 15); assert.equal(k.days, 1);
  assert.equal(k.cents, Math.round(15 * 0.25 * 100 + hoursKarim * 20 * 100));
  assert.equal(l.km, 0); assert.equal(l.stops, 1);
  assert.deepEqual(d.byDay.map(x => x.date), ['2026-11-10', '2026-11-11']);
  assert.equal(d.byDay[0].cents, k.cents);
});

test('une autre période ne mélange rien ; réglages vidés = poste non compté ; entrées invalides refusées', async () => {
  const oct = (await call('GET', `${U}?from=2026-10-01&to=2026-10-31`)).data;
  assert.equal(oct.deliveries, 1);
  assert.equal(oct.km, 99);
  assert.equal(oct.components.maintenance, 80000);
  assert.equal(oct.components.fixed, Math.round(300 * 100 * 31 / (365 / 12)));

  const cleared = await call('PUT', `${U}/settings`, { driverHourly: '' });
  assert.equal(cleared.data.settings.driverHourly, null);
  assert.equal(cleared.data.settings.perKm, 0.25, 'les autres réglages ne bougent pas');
  const d = (await call('GET', U + Q)).data;
  assert.equal(d.components.driver, null);
  assert.deepEqual(d.missing, ['driverHourly']);

  for (const bad of [{ perKm: 'abc' }, { perKm: -1 }, { perKm: 101 }, { driverHourly: 501 }, { fixedMonthly: 100001 }]) {
    const r = await call('PUT', `${U}/settings`, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.data.error);
  }
  assert.equal((await call('GET', `${U}?from=2026-11-30&to=2026-11-01`)).status, 400);
  assert.equal((await call('GET', `${U}?from=pas-une-date`)).status, 400);
  assert.equal((await call('GET', U + Q)).data.settings.perKm, 0.25, 'un refus ne change rien');
});

test('période sans livraison : pas de division par zéro', async () => {
  const r = await call('GET', `${U}?from=2026-01-01&to=2026-01-31`);
  assert.equal(r.status, 200);
  assert.equal(r.data.deliveries, 0);
  assert.equal(r.data.perDeliveryCents, null);
  assert.equal(r.data.perKmCents, null);
  assert.equal(r.data.perKgCents, null);
});

test('page : le bloc est branché, le script est valide et affiche tout via esc()', () => {
  const PUBLIC = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const code = fs.readFileSync(path.join(PUBLIC, 'stats-couts-livraison.js'), 'utf8');
  assert.ok(html.includes('<script src="/stats-couts-livraison.js"></script>'));
  assert.ok(app.includes('id="stats-delivery-costs"') && app.includes('renderStatsDeliveryCosts'));
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'stats-couts-livraison.js' }));
  assert.ok(!/\.innerHTML\s*=\s*[^;]*\$\{\s*err\.message/.test(code), 'un message d\'erreur n\'est jamais injecté sans esc()');
});
