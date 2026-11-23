// Points des cartes : chaque point retient le texte avec lequel il a été calculé ; un point ancien (sans cette trace) ou calculé
// avec une adresse qui a changé est recalculé tout seul, sans toucher aux livraisons validées avec la position du chauffeur.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const B = '/api/admin/billing'; const CODE = 'code-facturation-1';
let fake, fakePort; const asked = [];
test.before(() => new Promise(r => {
  fake = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    asked.push(q);
    const hit = /introuvable/i.test(q) ? [] : [q.includes('84100') ? { lat: '44.1388', lon: '4.8079' } : q.includes('26450') ? { lat: '44.5001', lon: '4.8002' } : { lat: '10.0', lon: '10.0' }];
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(hit));
  });
  fake.listen(0, '127.0.0.1', () => { fakePort = fake.address().port; r(); });
}));
test.after(() => fake && fake.close());
async function until(fn, ms = 15000) { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) return null; await new Promise(r => setTimeout(r, 150)); } }
const env = (extra = {}) => ({ ROAD_ROUTING: 'off', NODE_ENV: 'test', GEOCODER_URL: `http://127.0.0.1:${fakePort}/search`, ...extra });

async function setup(s) {
  assert.equal((await s.call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await s.call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  const jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  jdb.prepare('UPDATE admin SET depot_address = ?, depot_lat = ?, depot_lng = ? WHERE id = 1').run('35 rue Théodore Aubanel, Carpentras', 44.0553, 5.0489);
  const mk = async (societe, adresse, codePostal, ville, email) => {
    const c = await s.call('POST', `${B}/catalog/clients`, { societe, contact: 'X', tel: '0600000000', adresse, codePostal, ville, email });
    assert.equal(c.status, 201, JSON.stringify(c.data)); return c.data.client.id;
  };
  const drv = (await s.call('POST', '/api/admin/logistics/drivers', { name: 'Karim' })).data.driver;
  const ins = (ticket, clientId, adresse, { status = 'prete', lat = null, lng = null, geoQuery = null, deliveredLat = null, deliveredLng = null } = {}) =>
    jdb.prepare(`INSERT INTO orders (ticket, societe, contact, tel, adresse, status, created_at, client_id, driver_id, delivery_sequence, lat, lng, geo_query, delivered_at, delivered_lat, delivered_lng)
      VALUES (?, 'S', 'c', '0', ?, ?, datetime('now'), ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(ticket, adresse, status, clientId, drv.id, lat, lng, geoQuery, status === 'livree' ? new Date().toISOString() : null, deliveredLat, deliveredLng).lastInsertRowid;
  return { jdb, mk, ins, drv, row: (id) => jdb.prepare('SELECT lat, lng, geo_query FROM orders WHERE id = ?').get(id) };
}

test('les anciens points sont recalculés ; ni les livrées avec position du chauffeur, ni un point stable ne sont redemandés', async () => {
  asked.length = 0;
  const s = await startServer({ env: env() });
  let ctx;
  try {
    ctx = await setup(s);
    const { mk, ins, row } = ctx;
    const orange = await mk('CCAS TEST', '12 rue de la Paix', '84100', 'Orange', 'ccas@test.fr');
    const charols = await mk('CHATEAU TEST', '1205 route du Château', '26450', 'Charols', 'chateau@test.fr');
    const old = ins('CZ-A1', orange, '12 rue de la Paix', { lat: 1.0, lng: 2.0 });                       // ancien point : aucune trace de son calcul
    const fresh = ins('CZ-A2', charols, '1205 route du Château', { lat: 44.5001, lng: 4.8002, geoQuery: '1205 route du Château, 26450 Charols' });
    const gps = ins('CZ-A3', orange, '12 rue de la Paix', { status: 'livree', lat: 1.0, lng: 2.0, deliveredLat: 44.2, deliveredLng: 4.9 });

    let m = await s.call('GET', '/api/admin/logistics/map');
    assert.equal(m.status, 200);
    assert.equal(m.data.geocoding, true, 'la carte annonce un recalcul en cours');
    const stop = (data, ticket) => data.drivers[0].stops.find(x => x.ticket === ticket);
    assert.deepEqual([stop(m.data, 'CZ-A1').lat, stop(m.data, 'CZ-A1').lng], [1.0, 2.0], 'l\'ancien point reste affiché en attendant');

    assert.ok(await until(() => row(old).geo_query), 'l\'ancien point a été recalculé');
    assert.deepEqual(row(old), { lat: 44.1388, lng: 4.8079, geo_query: '12 rue de la Paix, 84100 Orange' });
    assert.deepEqual(asked, ['12 rue de la Paix, 84100 Orange'], 'seule la commande ancienne est redemandée');
    assert.deepEqual(row(fresh), { lat: 44.5001, lng: 4.8002, geo_query: '1205 route du Château, 26450 Charols' }, 'un point à jour n\'est pas touché');
    assert.deepEqual(row(gps), { lat: 1.0, lng: 2.0, geo_query: null }, 'livrée avec la position du chauffeur : gardée');

    // stable : plus de recalcul, plus de requête au service
    await new Promise(r => setTimeout(r, 1500));
    m = await s.call('GET', '/api/admin/logistics/map');
    assert.equal(m.data.geocoding, false);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(asked.length, 1, 'aucune requête de plus');
    assert.equal(stop(m.data, 'CZ-A1').lat, 44.1388);
    assert.equal(stop(m.data, 'CZ-A3').lat, 44.2, 'la livrée s\'affiche à la position du chauffeur');

    // la fiche change sans passer par l'écran (autre commune) : le point devient périmé et se recalcule
    ctx.jdb.prepare('UPDATE clients SET code_postal = ?, ville = ? WHERE id = ?').run('84100', 'Orange', charols);
    asked.length = 0;
    m = await s.call('GET', '/api/admin/logistics/map');
    assert.equal(m.data.geocoding, true);
    assert.ok(await until(() => row(fresh).geo_query === '1205 route du Château, 84100 Orange'));
    assert.deepEqual(row(fresh), { lat: 44.1388, lng: 4.8079, geo_query: '1205 route du Château, 84100 Orange' });
  } finally { if (ctx) ctx.jdb.close(); await s.stop(); }
});

test('adresse introuvable : l\'ancien point est gardé, et elle n\'est pas redemandée à chaque passage', async () => {
  asked.length = 0;
  const s = await startServer({ env: env() });
  let ctx;
  try {
    ctx = await setup(s);
    const c = await ctx.mk('HOTEL TEST', '8 impasse Introuvable', '84200', 'Carpentras', 'h@test.fr');
    const o = ctx.ins('CZ-B1', c, '8 impasse Introuvable', { lat: 44.05, lng: 5.05 });
    assert.equal((await s.call('GET', '/api/admin/logistics/map')).status, 200);
    assert.ok(await until(() => asked.length >= 1));
    await new Promise(r => setTimeout(r, 1500));
    assert.deepEqual(ctx.row(o), { lat: 44.05, lng: 5.05, geo_query: null }, 'ancien point conservé');
    const n = asked.length;
    for (let i = 0; i < 3; i++) { assert.equal((await s.call('GET', '/api/admin/logistics/map')).status, 200); await new Promise(r => setTimeout(r, 400)); }
    assert.equal(asked.length, n, 'pas de nouvelle demande avant le délai de reprise');
  } finally { if (ctx) ctx.jdb.close(); await s.stop(); }
});

test('sans que personne n\'ouvre la carte : la mise à jour tourne au démarrage', async () => {
  asked.length = 0;
  const dir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'cz-geo-'));
  // 1er démarrage : on prépare les données, puis on relance le serveur avec le planificateur actif
  let s = await startServer({ dataDir: dir, env: env() });
  let ctx = await setup(s);
  const c = await ctx.mk('CCAS TEST', '12 rue de la Paix', '84100', 'Orange', 'ccas@test.fr');
  const o = ctx.ins('CZ-C1', c, '12 rue de la Paix', { lat: 1.0, lng: 2.0 });
  ctx.jdb.close(); await s.stop();
  s = await startServer({ dataDir: dir, env: env({ GEOCODE_SCHEDULER: 'on', GEOCODE_FIRST_RUN_MS: '300' }) });
  const jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  try {
    const r = (id) => jdb.prepare('SELECT lat, lng, geo_query FROM orders WHERE id = ?').get(id);
    assert.ok(await until(() => r(o).geo_query), 'recalculé sans aucune visite de la carte');
    assert.deepEqual(r(o), { lat: 44.1388, lng: 4.8079, geo_query: '12 rue de la Paix, 84100 Orange' });
  } finally { jdb.close(); await s.stop(); }
});
