// Trafic en temps réel sur le LIEN DU LIVREUR : un faux TomTom local joue le service, le vrai serveur tourne avec une clé d'essai.
// On vérifie surtout la sécurité : un lien invalide n'obtient rien (et ne coûte rien), un livreur ne voit que sa tournée, ni la clé ni le lien
// ne sortent (réponses, appels TomTom, journaux), plafonds par lien, cadence limitée, panne de TomTom sans casser la tournée.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const KEY = 'TESTKEY_abcdefghijklmnopqrstuvwxyz0123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const DEPOT = { lat: 44.0553, lng: 5.0489 };

// ---------- faux TomTom ----------
let fake, fakePort; const seen = []; let mode = 'ok';
function startFake() {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), url: req.url });
    if (mode === 'forbidden') { res.writeHead(403); return res.end('{"error":"Forbidden"}'); }
    if (u.pathname.startsWith('/traffic/map/4/tile/flow/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    if (u.pathname.startsWith('/traffic/services/4/flowSegmentData/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ flowSegmentData: { currentSpeed: 34, freeFlowSpeed: 50, currentTravelTime: 80, freeFlowTravelTime: 55, confidence: 0.9, roadClosure: false } }));
    }
    const m = /^\/routing\/1\/calculateRoute\/([^/]+)\/json$/.exec(u.pathname);
    if (m) {
      const n = m[1].split(':').length - 1;
      const legs = Array.from({ length: n }, (_, i) => ({ summary: {
        lengthInMeters: 2000, travelTimeInSeconds: 600, trafficDelayInSeconds: 60, noTrafficTravelTimeInSeconds: 540,
        departureTime: '2026-11-24T07:00:00+01:00', arrivalTime: `2026-11-24T07:${String((i + 1) * 10).padStart(2, '0')}:00+01:00`,
      } }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ routes: [{ summary: { lengthInMeters: 2000 * n, travelTimeInSeconds: 600 * n, trafficDelayInSeconds: 60 * n, noTrafficTravelTimeInSeconds: 540 * n, departureTime: '2026-11-24T07:00:00+01:00', arrivalTime: `2026-11-24T07:${String(n * 10).padStart(2, '0')}:00+01:00` }, legs }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise(r => fake.listen(0, '127.0.0.1', () => { fakePort = fake.address().port; r(); }));
}
const withTomTom = (extra = {}) => ({ ROAD_ROUTING: 'off', NODE_ENV: 'test', TOMTOM_API_KEY: KEY, TOMTOM_BASE_URL: `http://127.0.0.1:${fakePort}`, ...extra });
const routingCalls = () => seen.filter(r => r.path.startsWith('/routing/'));
const tileCalls = () => seen.filter(r => r.path.startsWith('/traffic/map/'));

test.before(startFake);
test.after(() => fake && fake.close());
test.beforeEach(() => { seen.length = 0; mode = 'ok'; });

// Serveur + deux livreurs (Karim : 2 arrêts, Léa : 1 arrêt) + dépôt localisé.
async function setup(env) {
  const s = await startServer({ env });
  assert.equal((await s.call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  const jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const karim = (await s.call('POST', '/api/admin/logistics/drivers', { name: 'Karim', vehicle: 'Camionnette 1' })).data.driver;
  const lea = (await s.call('POST', '/api/admin/logistics/drivers', { name: 'Léa' })).data.driver;
  jdb.prepare('UPDATE admin SET depot_address = ?, depot_lat = ?, depot_lng = ? WHERE id = 1').run('35 rue Théodore Aubanel, Carpentras', DEPOT.lat, DEPOT.lng);
  const order = (ticket, driverId, seq, lat, lng) => jdb.prepare(`INSERT INTO orders (ticket, societe, contact, tel, adresse, status, created_at, driver_id, delivery_sequence, lat, lng)
    VALUES (?, ?, 'c', '0', ?, 'prete', datetime('now'), ?, ?, ?, ?)`).run(ticket, `Hôtel ${ticket}`, `1 rue ${ticket}, Carpentras`, driverId, seq, lat, lng).lastInsertRowid;
  const o1 = order('CZ-T1', karim.id, 1, 44.06, 5.06);
  const o2 = order('CZ-T2', karim.id, 2, 44.07, 5.07);
  const o3 = order('CZ-T3', lea.id, 1, 44.08, 5.08);
  const portal = (token, method, url, body) => fetch(`${s.BASE}/api/driver-portal/${token}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => { const type = r.headers.get('content-type') || ''; return { status: r.status, headers: r.headers, type, data: type.includes('json') ? await r.json().catch(() => null) : Buffer.from(await r.arrayBuffer()) }; });
  const done = async () => { jdb.close(); await s.stop(); };
  return { s, jdb, karim, lea, o1, o2, o3, portal, done };
}
const TILE = 'relative0/12/2105/1488.png';

test('lien invalide : 404 partout et aucun appel TomTom', async () => {
  const a = await setup(withTomTom());
  try {
    for (const u of ['/traffic', '/traffic/speed?lat=44.05&lng=5.05', `/traffic/tiles/${TILE}`]) {
      const r = await a.portal('jeton-qui-n-existe-pas', 'GET', u);
      assert.equal(r.status, 404, u);
    }
    assert.equal(seen.length, 0);
  } finally { await a.done(); }
});

test('sans clé TomTom : « désactivé », la tournée reste normale et rien ne part', async () => {
  const a = await setup({ ROAD_ROUTING: 'off', TOMTOM_API_KEY: undefined });
  try {
    const t = await a.portal(a.karim.access_token, 'GET', '/traffic');
    assert.equal(t.status, 200);
    assert.deepEqual(t.data, { enabled: false });
    assert.equal((await a.portal(a.karim.access_token, 'GET', `/traffic/tiles/${TILE}`)).status, 503);
    assert.equal((await a.portal(a.karim.access_token, 'GET', '/traffic/speed?lat=44.05&lng=5.05')).status, 503);
    assert.equal((await a.portal(a.karim.access_token, 'GET', '')).status, 200);
    assert.equal(seen.length, 0);
  } finally { await a.done(); }
});

test('heures de passage : ordre du lien, temps sur place ajouté, départ depuis le dépôt, ni clé ni lien chez TomTom', async () => {
  const a = await setup(withTomTom());
  try {
    const page = await a.portal(a.karim.access_token, 'GET', '');
    const r = await a.portal(a.karim.access_token, 'GET', '/traffic');
    assert.equal(r.status, 200);
    assert.equal(r.data.enabled, true);
    assert.equal(r.data.error, undefined);
    assert.equal(r.data.source, 'depot');
    assert.deepEqual(r.data.driver, { id: a.karim.id, name: 'Karim' });
    assert.equal(r.data.dwellMin, 20, 'minutes par arrêt de l\'atelier');
    // mêmes arrêts, dans le même ordre que la page du livreur
    assert.deepEqual(r.data.stops.map(st => st.items[0].orderId), page.data.stops.map(st => st.orderId));
    assert.deepEqual(r.data.stops.map(st => st.items[0].ticket), ['CZ-T1', 'CZ-T2']);
    // 10 min de route entre deux arrêts (faux TomTom) + 20 min sur place au premier = 30 min
    const gap = (Date.parse(r.data.stops[1].etaAt) - Date.parse(r.data.stops[0].etaAt)) / 60000;
    assert.equal(gap, 30);
    const back = (Date.parse(r.data.backToDepot.etaAt) - Date.parse(r.data.stops[1].etaAt)) / 60000;
    assert.equal(back, 30, 'retour au dépôt : 10 min de route + 20 min sur place au dernier arrêt');
    assert.equal(r.data.stops[0].driveMin, 10);
    assert.equal(r.data.stops[0].delayMin, 1);
    assert.equal(r.data.totals.driveMin, 30);
    // un seul appel d'itinéraire, qui part du dépôt, avec la clé ; jamais le lien du livreur
    const calls = routingCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].path.includes(`${DEPOT.lat},${DEPOT.lng}:44.06,5.06:44.07,5.07:${DEPOT.lat},${DEPOT.lng}`), calls[0].path);
    assert.equal(calls[0].q.key, KEY);
    assert.ok(!JSON.stringify(seen).includes(a.karim.access_token), 'le lien du livreur ne part jamais chez TomTom');
    assert.ok(!JSON.stringify({ d: r.data, h: [...r.headers] }).includes(KEY), 'la clé ne sort jamais');
  } finally { await a.done(); }
});

test('chaque livreur ne voit que sa tournée', async () => {
  const a = await setup(withTomTom());
  try {
    const k = await a.portal(a.karim.access_token, 'GET', '/traffic');
    const l = await a.portal(a.lea.access_token, 'GET', '/traffic');
    assert.deepEqual(k.data.stops.map(st => st.items[0].ticket), ['CZ-T1', 'CZ-T2']);
    assert.deepEqual(l.data.stops.map(st => st.items[0].ticket), ['CZ-T3']);
    assert.equal(l.data.driver.name, 'Léa');
    assert.ok(!JSON.stringify(l.data).includes('CZ-T1'));
  } finally { await a.done(); }
});

test('position partagée : le départ vient du téléphone ; un arrêt livré recalcule, sinon la réponse est mémorisée', async () => {
  const a = await setup(withTomTom());
  try {
    assert.equal((await a.portal(a.karim.access_token, 'POST', '/position', { lat: 44.0601, lng: 5.0602, accuracy: 10 })).status, 200);
    const r1 = await a.portal(a.karim.access_token, 'GET', '/traffic');
    assert.equal(r1.data.source, 'gps');
    assert.equal(routingCalls().length, 1);
    assert.ok(routingCalls()[0].path.includes('44.0601,5.0602:'), 'premier point = la position du livreur');
    await a.portal(a.karim.access_token, 'GET', '/traffic');
    assert.equal(routingCalls().length, 1, 'même situation : pas de nouvel appel TomTom');
    // livraison du 1er arrêt : le reste de la tournée est recalculé
    assert.equal((await a.portal(a.karim.access_token, 'POST', `/orders/${a.o1}/deliver`, {})).status, 200);
    const r2 = await a.portal(a.karim.access_token, 'GET', '/traffic');
    assert.deepEqual(r2.data.stops.map(st => st.items[0].ticket), ['CZ-T2']);
    assert.equal(routingCalls().length, 2);
  } finally { await a.done(); }
});

test('tuiles : PNG servi par le serveur, clé jamais exposée, adresses refusées avant tout appel', async () => {
  const a = await setup(withTomTom());
  try {
    const t = await a.portal(a.karim.access_token, 'GET', `/traffic/tiles/${TILE}`);
    assert.equal(t.status, 200);
    assert.equal(t.type, 'image/png');
    assert.ok(Buffer.isBuffer(t.data) && t.data.equals(PNG));
    assert.equal(t.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(t.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(![...t.headers.values()].some(v => v.includes(KEY)));
    assert.equal(tileCalls().length, 1);
    assert.equal(tileCalls()[0].q.key, KEY);
    assert.ok(!JSON.stringify(seen).includes(a.karim.access_token));
    seen.length = 0;
    for (const p of ['evil/12/2105/1488.png', 'relative0/5/10/10.png', 'relative0/12/2105/1488.jpg', 'relative0/12/abc/1488.png', 'relative0/10/0/0.png', 'relative0/12/2105/3000.png']) {
      const r = await a.portal(a.karim.access_token, 'GET', `/traffic/tiles/${p}`);
      assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`);
    }
    assert.equal(seen.length, 0);
  } finally { await a.done(); }
});

test('vitesse à un endroit : validée avant l\'appel', async () => {
  const a = await setup(withTomTom());
  try {
    const ok = await a.portal(a.karim.access_token, 'GET', '/traffic/speed?lat=44.0553&lng=5.0489');
    assert.equal(ok.status, 200);
    assert.equal(ok.data.currentKmh, 34);
    assert.equal(ok.data.freeFlowKmh, 50);
    const calls = seen.length;
    for (const q of ['lat=abc&lng=5', 'lat=44.05', 'lat=0&lng=0', 'lat=48.85&lng=-20', 'lat=44.05&lng=5.05%27%20OR%201%3D1']) {
      const r = await a.portal(a.karim.access_token, 'GET', `/traffic/speed?${q}`);
      assert.ok([400, 404].includes(r.status), `${q} → ${r.status}`);
    }
    assert.equal(seen.length, calls, 'rien de plus chez TomTom');
  } finally { await a.done(); }
});

test('plafond quotidien par lien : le livreur qui l\'atteint est arrêté, l\'autre non', async () => {
  const a = await setup(withTomTom({ TOMTOM_DRIVER_TILES_PER_DAY: '2', TOMTOM_DRIVER_REQUESTS_PER_DAY: '2' }));
  try {
    const tile = (token, x) => a.portal(token, 'GET', `/traffic/tiles/relative0/12/${x}/1488.png`);
    assert.equal((await tile(a.karim.access_token, 2105)).status, 200);
    assert.equal((await tile(a.karim.access_token, 2106)).status, 200);
    const stop = await tile(a.karim.access_token, 2107);
    assert.equal(stop.status, 429);
    assert.equal(stop.data.code, 'driver_quota');
    assert.equal((await tile(a.lea.access_token, 2105)).status, 200, 'le plafond est propre à chaque lien');

    assert.equal((await a.portal(a.karim.access_token, 'GET', '/traffic')).data.error, undefined);
    assert.equal((await a.portal(a.karim.access_token, 'GET', '/traffic')).data.error, undefined);
    const third = await a.portal(a.karim.access_token, 'GET', '/traffic');
    assert.equal(third.status, 200, 'la page reste utilisable');
    assert.equal(third.data.code, 'driver_quota');
    assert.equal((await a.portal(a.karim.access_token, 'GET', '')).status, 200);
  } finally { await a.done(); }
});

test('cadence limitée par lien, et le lien n\'apparaît jamais dans les journaux de sécurité', async () => {
  const a = await setup(withTomTom());
  try {
    let last;
    for (let i = 0; i < 14; i++) last = await a.portal(a.karim.access_token, 'GET', '/traffic');
    assert.equal(last.status, 429);
    assert.equal((await a.portal(a.lea.access_token, 'GET', '/traffic')).status, 200, 'la limite est propre à chaque lien');
    let pos;
    for (let i = 0; i < 42; i++) pos = await a.portal(a.karim.access_token, 'POST', '/position', { lat: 44.06, lng: 5.06 });
    assert.equal(pos.status, 429);
    // journaux du serveur (ceux de Render) et journal de sécurité de la base
    const out = a.s.logs();
    assert.match(out, /driver-trafic : trop de demandes/, 'le blocage est bien journalisé');
    assert.match(out, /driver-position : trop de demandes/);
    const logs = out + JSON.stringify(a.jdb.prepare('SELECT * FROM security_log').all());
    assert.ok(!logs.includes(a.karim.access_token), 'le lien du livreur n\'est jamais écrit dans un journal');
    assert.ok(!logs.includes(KEY));
  } finally { await a.done(); }
});

test('TomTom en panne ou clé refusée : message sobre, tournée intacte, clé invisible', async () => {
  const a = await setup(withTomTom());
  try {
    mode = 'forbidden';
    const r = await a.portal(a.karim.access_token, 'GET', '/traffic');
    assert.equal(r.status, 200);
    assert.equal(r.data.enabled, true);
    assert.ok(r.data.error && r.data.code);
    assert.ok(!JSON.stringify(r.data).includes(KEY));
    const page = await a.portal(a.karim.access_token, 'GET', '');
    assert.equal(page.status, 200);
    assert.equal(page.data.stops.length, 2);
  } finally { await a.done(); }
});

test('page du livreur : le script trafic est chargé, valide, et ne parle jamais à TomTom ni à un autre site que les fonds de carte', () => {
  const PUBLIC = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(PUBLIC, 'tournee.html'), 'utf8');
  const main = fs.readFileSync(path.join(PUBLIC, 'tournee.js'), 'utf8');
  const code = fs.readFileSync(path.join(PUBLIC, 'tournee-trafic.js'), 'utf8');
  assert.ok(html.indexOf('/tournee.js') < html.indexOf('/tournee-trafic.js'), 'chargé après tournee.js dont il réutilise les fonctions');
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'tournee-trafic.js' }));
  for (const [name, src] of [['tournee.js', main], ['tournee-trafic.js', code]]) {
    assert.ok(!/api\.tomtom\.com/i.test(src), `${name} ne doit jamais contacter TomTom directement`);
    assert.ok(!/[?&]key=/.test(src) && !/TOMTOM_API_KEY/.test(src), `${name} ne contient aucune clé`);
  }
  const hosts = new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1]));
  const allowed = new Set(['tile.openstreetmap.org', 'www.openstreetmap.org', 'www.tomtom.com']);   // fond de carte et mentions légales (liens, pas de requêtes)
  for (const h of hosts) assert.ok(allowed.has(h), `hôte inattendu : ${h}`);
  const csp = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'security.js'), 'utf8');
  assert.match(csp, /img-src[^"]*https:\/\/tile\.openstreetmap\.org/);
});
