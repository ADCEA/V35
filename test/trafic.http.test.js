// Trafic en temps réel (TomTom) : un faux serveur TomTom local joue le rôle du service, le vrai serveur de l'application tourne
// avec une clé d'essai. On vérifie surtout la SÉCURITÉ : la clé ne sort jamais, rien sans session administrateur, entrées
// strictement validées, plafond quotidien, mémoire des réponses, coupe-circuit, pas d'appel hors de la zone prévue.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs'); const os = require('os'); const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const KEY = 'TESTKEY_abcdefghijklmnopqrstuvwxyz0123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// ---------- faux TomTom ----------
let fake, fakePort; const seen = []; let mode = 'ok';
function startFake() {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), headers: req.headers });
    if (mode === 'forbidden') { res.writeHead(403); return res.end('{"error":"Forbidden"}'); }
    if (mode === 'ratelimit') { res.writeHead(429); return res.end('{}'); }
    if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>pas une image</html>'); }
    if (mode === 'redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${fakePort}/vole-la-cle` }); return res.end(); }
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
const T = '/api/admin/traffic';
const everything = (r) => JSON.stringify({ d: r.data, h: r.headers ? Object.fromEntries(r.headers) : null });   // corps et en-têtes, pour y chercher la clé

async function admin(extraEnv) {
  const s = await startServer({ env: withTomTom(extraEnv) });
  assert.equal((await s.call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  const jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const done = async () => { jdb.close(); await s.stop(); };
  return { s, jdb, done, call: s.call };
}
const tileGet = async (s, p) => {
  const res = await s.call('GET', `${T}/tiles/${p}`, null, true);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body, type };
};
// Tuile de Carpentras au zoom 12 (dans la zone autorisée).
const OK_TILE = '12/2105/1488';
const tileKey = () => seen.filter(r => r.path.startsWith('/traffic/map/'));

test.before(startFake);
test.after(() => fake && fake.close());
test.beforeEach(() => { seen.length = 0; mode = 'ok'; });

test('sans session administrateur : rien ne part vers TomTom', async () => {
  const anon = await startServer({ env: withTomTom() });
  try {
    for (const url of [`${T}/status`, `${T}/tiles/relative0/${OK_TILE}.png`, `${T}/speed?lat=44.05&lng=5.05`, `${T}/driver/1/eta`, `${T}/tour/1/eta`]) {
      assert.equal((await anon.call('GET', url)).status, 401, url);
    }
    assert.equal(seen.length, 0);
  } finally { await anon.stop(); }
});

test('état : activé, plafonds, et jamais la clé', async () => {
  const a = await admin();
  try {
    const r = await a.call('GET', `${T}/status`);
    assert.equal(r.status, 200);
    assert.equal(r.data.enabled, true);
    assert.equal(r.data.usage.api.limit, 1500);
    assert.equal(r.data.usage.tiles.limit, 15000);
    assert.ok(!everything(r).includes(KEY));
    assert.ok(!JSON.stringify(r.data).toLowerCase().includes('tomtom_api_key'));
  } finally { await a.done(); }
});

test('tuile : PNG servi, clé envoyée à TomTom seulement, mémoire, en-têtes sûrs', async () => {
  const a = await admin();
  try {
    const t = await tileGet(a.s, `relative0/${OK_TILE}.png`);
    assert.equal(t.status, 200);
    assert.equal(t.type, 'image/png');
    assert.ok(Buffer.isBuffer(t.body) && t.body.equals(PNG));
    assert.match(t.headers.get('cache-control'), /^private, max-age=60$/);
    assert.equal(t.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(t.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.ok(![...t.headers.values()].some(v => v.includes(KEY)));
    const calls = tileKey();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, `/traffic/map/4/tile/flow/relative0/${OK_TILE}.png`);
    assert.equal(calls[0].q.key, KEY);                                  // la clé n'existe que dans l'appel serveur → TomTom
    // même tuile : servie depuis la mémoire, rien de plus chez TomTom
    assert.equal((await tileGet(a.s, `relative0/${OK_TILE}.png`)).status, 200);
    assert.equal(tileKey().length, 1);
  } finally { await a.done(); }
});

test('tuile : entrées refusées avant tout appel (style, zoom, hors tuile, hors France, écriture bizarre)', async () => {
  const a = await admin();
  try {
    const bad = [
      `evil/${OK_TILE}.png`, `..%2F..%2Fx/${OK_TILE}.png`, `relative0%3Brm/${OK_TILE}.png`,   // style hors liste
      'relative0/5/10/10.png', 'relative0/19/1/1.png',                                        // zoom hors 6–18
      'relative0/12/9999/1488.png', 'relative0/12/2105/-1.png', 'relative0/12/2105/1488.jpg', 'relative0/12/2105/1488',
      'relative0/12/abc/1488.png', 'relative0/12/2105/1488.png%00',                           // écritures bizarres
      'relative0/10/0/0.png', 'relative0/10/1023/1023.png', 'relative0/12/2105/3000.png',     // pôle, Pacifique, hémisphère sud
    ];
    for (const p of bad) {
      const t = await tileGet(a.s, p);
      assert.ok([400, 404].includes(t.status), `${p} → ${t.status}`);
    }
    assert.equal(seen.length, 0, 'aucun appel TomTom pour des entrées invalides');
  } finally { await a.done(); }
});

test('TomTom répond autre chose qu\'une image : refusé et non gardé', async () => {
  const a = await admin();
  try {
    mode = 'html';
    const t = await tileGet(a.s, `relative0/${OK_TILE}.png`);
    assert.equal(t.status, 502);
    mode = 'ok';
    assert.equal((await tileGet(a.s, `relative0/${OK_TILE}.png`)).status, 200);   // pas de réponse invalide en mémoire
  } finally { await a.done(); }
});

test('redirection de TomTom : jamais suivie (la clé ne part pas ailleurs)', async () => {
  const a = await admin();
  try {
    mode = 'redirect';
    const t = await tileGet(a.s, `relative0/${OK_TILE}.png`);
    assert.equal(t.status, 502);
    assert.equal(seen.length, 1);
    assert.ok(!seen.some(r => r.path === '/vole-la-cle'), 'la redirection n\'a pas été suivie');
    assert.ok(!JSON.stringify(t.body).includes(KEY));
  } finally { await a.done(); }
});

test('vitesse en un point : validée, mise en mémoire', async () => {
  const a = await admin();
  try {
    const r = await a.call('GET', `${T}/speed?lat=44.0553&lng=5.0491`);
    assert.equal(r.status, 200);
    assert.equal(r.data.currentKmh, 34); assert.equal(r.data.freeFlowKmh, 50); assert.equal(r.data.ratio, 0.68); assert.equal(r.data.closed, false);
    const c = seen.filter(x => x.path.startsWith('/traffic/services/4/flowSegmentData/'));
    assert.equal(c.length, 1); assert.equal(c[0].q.point, '44.0553,5.0491'); assert.equal(c[0].q.key, KEY);
    assert.equal((await a.call('GET', `${T}/speed?lat=44.0553&lng=5.0491`)).status, 200);
    assert.equal(seen.filter(x => x.path.startsWith('/traffic/services/')).length, 1);
    for (const q of ['lat=0&lng=0', 'lat=abc&lng=5', 'lat=44', 'lat=44&lng=5;DROP', 'lat=NaN&lng=1', 'lat=48.8&lng=30', 'lat[]=1&lng=2']) {
      assert.equal((await a.call('GET', `${T}/speed?${q}`)).status, 400, q);
    }
    assert.equal(seen.filter(x => x.path.startsWith('/traffic/services/')).length, 1);
    assert.ok(!everything(r).includes(KEY));
  } finally { await a.done(); }
});

test('chauffeur : itinéraire construit depuis la base (dépôt → arrêts dans l\'ordre → dépôt), heures de passage', async () => {
  const a = await admin();
  try {
    const drv = (await a.call('POST', '/api/admin/logistics/drivers', { name: 'Karim' })).data.driver;
    a.jdb.prepare(`UPDATE admin SET depot_address = 'Dépôt', depot_lat = 44.0550, depot_lng = 5.0490 WHERE id = 1`).run();
    const ins = a.jdb.prepare(`INSERT INTO orders (ticket, societe, contact, tel, adresse, status, driver_id, lat, lng, delivery_sequence, created_at) VALUES (?, ?, 'c', '0', 'a', 'prete', ?, ?, ?, ?, datetime('now'))`);
    ins.run('CZ-T2', 'Hôtel Deux', drv.id, 44.0600, 5.0600, 2);
    ins.run('CZ-T1', 'Hôtel Un', drv.id, 44.0580, 5.0550, 1);
    ins.run('CZ-T3', 'Hôtel sans position', drv.id, null, null, 3);
    const r = await a.call('GET', `${T}/driver/${drv.id}/eta`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.source, 'depot');
    assert.equal(r.data.missingAddresses, 1);
    assert.deepEqual(r.data.stops.map(s => s.items[0].societe), ['Hôtel Un', 'Hôtel Deux']);
    assert.equal(r.data.stops[0].etaAt, '2026-11-24T07:10:00+01:00');
    assert.equal(r.data.stops[0].delayMin, 1);
    assert.ok(r.data.backToDepot);
    assert.deepEqual(r.data.totals, { driveMin: 30, freeFlowMin: 27, delayMin: 3, km: 6 });
    const c = seen.filter(x => x.path.startsWith('/routing/'));
    assert.equal(c.length, 1);
    assert.equal(c[0].path, '/routing/1/calculateRoute/44.055,5.049:44.058,5.055:44.06,5.06:44.055,5.049/json');
    assert.equal(c[0].q.traffic, 'true'); assert.equal(c[0].q.travelMode, 'car'); assert.equal(c[0].q.key, KEY);
    assert.equal(c[0].q.departAt, undefined, 'départ maintenant : trafic en direct');
    // recalcul demandé tout de suite : mémoire, aucun nouvel appel
    assert.equal((await a.call('GET', `${T}/driver/${drv.id}/eta`)).status, 200);
    assert.equal(seen.filter(x => x.path.startsWith('/routing/')).length, 1);
    // numéros invalides, chauffeur inconnu
    assert.equal((await a.call('GET', `${T}/driver/abc/eta`)).status, 400);
    assert.equal((await a.call('GET', `${T}/driver/0/eta`)).status, 400);
    assert.equal((await a.call('GET', `${T}/driver/9999/eta`)).status, 404);
  } finally { await a.done(); }
});

test('chauffeur sans arrêt restant : réponse vide, aucun appel payant', async () => {
  const a = await admin();
  try {
    const drv = (await a.call('POST', '/api/admin/logistics/drivers', { name: 'Léa' })).data.driver;
    const r = await a.call('GET', `${T}/driver/${drv.id}/eta`);
    assert.equal(r.status, 200); assert.deepEqual(r.data.stops, []); assert.equal(r.data.totals, null);
    assert.equal(seen.length, 0);
  } finally { await a.done(); }
});

test('tournée fixe : hôtels localisés d\'après leurs commandes, départ prévu, entrées validées', async () => {
  const a = await admin();
  try {
    a.jdb.prepare(`UPDATE admin SET depot_address = 'Dépôt', depot_lat = 44.0550, depot_lng = 5.0490 WHERE id = 1`).run();
    const cl = (name) => Number(a.jdb.prepare(`INSERT INTO clients (societe, contact, tel, adresse, code_hash, created_at) VALUES (?, 'c', '0', 'rue', 'x', datetime('now'))`).run(name).lastInsertRowid);
    const A = cl('Hôtel A'), B = cl('Hôtel B');
    a.jdb.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, lat, lng, created_at) VALUES ('CZ-X1', ?, 'Hôtel A', 'c', '0', 'a', 'livree', 44.06, 5.06, datetime('now'))`).run(A);
    const tour = (await a.call('POST', '/api/admin/logistics/tours', { name: 'Centre', weekdays: [1, 2, 3, 4, 5, 6, 7], clientIds: [A, B], active: true })).data.tour;
    const soon = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    const r = await a.call('GET', `${T}/tour/${tour.id}/eta?departAt=${encodeURIComponent(soon)}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.forecast, true);
    assert.deepEqual(r.data.missing.map(m => m.societe), ['Hôtel B']);
    assert.equal(r.data.stops.length, 1);
    const c = seen.filter(x => x.path.startsWith('/routing/'));
    assert.equal(c.length, 1);
    assert.match(c[0].q.departAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(c[0].path, '/routing/1/calculateRoute/44.055,5.049:44.06,5.06:44.055,5.049/json');
    // départ invalide, trop lointain, tournée inconnue
    for (const bad of ['demain', '2026-13-45T99:00:00Z', "2026-11-24T07:00:00Z';DROP", '']) {
      assert.equal((await a.call('GET', `${T}/tour/${tour.id}/eta?departAt=${encodeURIComponent(bad)}`)).status, 400, bad);
    }
    const far = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();
    assert.equal((await a.call('GET', `${T}/tour/${tour.id}/eta?departAt=${encodeURIComponent(far)}`)).status, 400);
    assert.equal((await a.call('GET', `${T}/tour/9999/eta`)).status, 404);
    assert.equal((await a.call('GET', `${T}/tour/x/eta`)).status, 400);
  } finally { await a.done(); }
});

test('plafond quotidien : au-delà, plus aucun appel, et c\'est écrit au journal de sécurité', async () => {
  const a = await admin({ TOMTOM_TILES_PER_DAY: '2' });
  try {
    const tiles = ['12/2105/1488', '12/2106/1488', '12/2107/1488'];
    const out = [];
    for (const t of tiles) out.push(await tileGet(a.s, `relative0/${t}.png`));
    assert.deepEqual(out.map(o => o.status), [200, 200, 429]);
    assert.equal(out[2].body.code, 'budget');
    assert.equal(out[2].headers.get('retry-after'), '3600');
    assert.equal(tileKey().length, 2, 'le 3e appel n\'est jamais parti');
    // tuile déjà en mémoire : toujours servie, ne compte pas
    assert.equal((await tileGet(a.s, `relative0/${tiles[0]}.png`)).status, 200);
    const st = (await a.call('GET', `${T}/status`)).data;
    assert.equal(st.usage.tiles.used, 2); assert.equal(st.usage.tiles.limit, 2);
    assert.equal(st.reason, 'budget'); assert.match(st.message, /tuiles atteint/);
    const ev = a.jdb.prepare("SELECT event, detail FROM security_log WHERE event = 'traffic_budget_reached'").all();
    assert.equal(ev.length, 1);
    assert.ok(!JSON.stringify(ev).includes(KEY));
  } finally { await a.done(); }
});

test('clé refusée par TomTom : suspension, aucune insistance, journal sans la clé', async () => {
  const a = await admin();
  try {
    mode = 'forbidden';
    const first = await tileGet(a.s, `relative0/${OK_TILE}.png`);
    assert.equal(first.status, 503);
    assert.equal(first.body.code, 'key_rejected');
    mode = 'ok';
    const second = await tileGet(a.s, 'relative0/12/2106/1488.png');
    assert.equal(second.status, 503);
    assert.equal(seen.length, 1, 'plus aucun appel pendant la suspension');
    const st = (await a.call('GET', `${T}/status`)).data;
    assert.equal(st.enabled, true); assert.equal(st.reason, 'key_rejected'); assert.ok(st.pausedUntil); assert.ok(st.message);
    const ev = a.jdb.prepare("SELECT event, detail FROM security_log WHERE event = 'traffic_key_rejected'").all();
    assert.equal(ev.length, 1);
    assert.ok(!JSON.stringify(ev).includes(KEY));
    for (const r of [first, second]) assert.ok(!JSON.stringify(r.body).includes(KEY));
  } finally { await a.done(); }
});

test('TomTom limite les demandes (429) : pause courte au lieu d\'insister', async () => {
  const a = await admin();
  try {
    mode = 'ratelimit';
    assert.equal((await tileGet(a.s, `relative0/${OK_TILE}.png`)).status, 503);
    mode = 'ok';
    assert.equal((await tileGet(a.s, 'relative0/12/2106/1488.png')).status, 503);
    assert.equal(seen.length, 1);
    assert.equal((await a.call('GET', `${T}/status`)).data.reason, 'paused');
  } finally { await a.done(); }
});

test('TomTom injoignable : erreur claire sans adresse ni clé, puis pause après 5 échecs', async () => {
  const dead = http.createServer(); await new Promise(r => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port; await new Promise(r => dead.close(r));   // port fermé : connexion refusée
  const a = await admin({ TOMTOM_BASE_URL: `http://127.0.0.1:${port}` });
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const t = await tileGet(a.s, `relative0/12/${2105 + i}/1488.png`);
      codes.push(t.status);
      const text = JSON.stringify(t.body);
      assert.ok(!text.includes(KEY) && !text.includes(String(port)) && !text.includes('127.0.0.1'), text);
    }
    assert.deepEqual(codes, [502, 502, 502, 502, 502, 503]);
  } finally { await a.done(); }
});

test('cadence : au-delà de 40 demandes de calcul par minute, 429 sans appel supplémentaire', async () => {
  const a = await admin({ TOMTOM_REQUESTS_PER_DAY: '500' });
  try {
    let limited = 0, last = null;
    for (let i = 0; i < 44; i++) {
      const r = await a.call('GET', `${T}/speed?lat=${(44 + i / 1000).toFixed(4)}&lng=5.05`);
      if (r.status === 429) { limited++; last = r; }
    }
    assert.equal(limited, 4);
    assert.equal(last.data.code, 'RATE_LIMITED');
    assert.equal(seen.length, 40);
  } finally { await a.done(); }
});

test('sans clé, clé mal formée ou adresse refusée : désactivé, rien ne part, la clé n\'est jamais répétée', async () => {
  const cases = [
    [{ TOMTOM_API_KEY: undefined }, 'disabled'],
    [{ TOMTOM_API_KEY: 'trop court!' }, 'key_invalid'],
    [{ TOMTOM_API_KEY: 'x'.repeat(40) + '"; <script>' }, 'key_invalid'],
    [{ TOMTOM_BASE_URL: 'http://example.com' }, 'bad_config'],
    [{ TOMTOM_BASE_URL: 'https://user:pass@example.com' }, 'bad_config'],
    [{ TRAFFIC: 'off' }, 'disabled'],
  ];
  for (const [env, reason] of cases) {
    const a = await admin(env);
    try {
      const st = await a.call('GET', `${T}/status`);
      assert.equal(st.data.enabled, false, JSON.stringify(env)); assert.equal(st.data.reason, reason);
      const t = await tileGet(a.s, `relative0/${OK_TILE}.png`);
      assert.equal(t.status, 503);
      for (const v of Object.values(env)) if (v && v.length > 8) assert.ok(!JSON.stringify([st.data, t.body]).includes(v));
      assert.equal(seen.length, 0);
    } finally { await a.done(); }
  }
});

test('la page ne connaît ni la clé, ni TomTom : politique de contenu inchangée', async () => {
  const a = await admin();
  try {
    const res = await a.s.call('GET', '/', null, true);
    const csp = res.headers.get('content-security-policy');
    assert.ok(!/tomtom/i.test(csp), csp);
    assert.match(csp, /img-src 'self' data: blob: https:\/\/tile\.openstreetmap\.org https:\/\/data\.geopf\.fr;/);
    assert.match(csp, /connect-src 'self';/);
    const html = await res.text();
    assert.ok(!html.includes(KEY));
  } finally { await a.done(); }
  // aucun fichier servi aux navigateurs ne cite la variable de la clé ni l'adresse de TomTom (hors mention « © TomTom »)
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(__dirname, '..', 'public')).filter(f => /\.(js|html|css|json)$/.test(f))) {
    const txt = fs.readFileSync(f, 'utf8');
    assert.ok(!/TOMTOM_API_KEY|api\.tomtom\.com/i.test(txt), `${path.relative(path.join(__dirname, '..'), f)} cite la clé ou l'adresse de TomTom`);
  }
});

test('nettoyage des textes : la clé disparaît de tout message avant écriture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-traffic-'));
  process.env.DATA_DIR = dir; process.env.TOMTOM_API_KEY = KEY;
  const { scrub } = require('../src/utils/traffic');
  const dirty = `fetch failed: https://api.tomtom.com/traffic/map/4/tile/flow/relative0/12/1/1.png?tileSize=256&key=${KEY} (clé ${KEY}); aussi ?key=AUTRECLE1234567890&x=1`;
  const clean = scrub(dirty);
  assert.ok(!clean.includes(KEY) && !clean.includes('AUTRECLE1234567890'), clean);
  assert.ok(clean.includes('«clé»'));
  assert.equal(scrub(null), '');
});
