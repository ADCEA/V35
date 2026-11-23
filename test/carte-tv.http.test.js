// Carte plein écran pour la TV : lien en lecture seule (jeton conservé sous forme d'empreinte, remplaçable, désactivable),
// données de la carte sans adresses ni numéros de ticket, page servie sans session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const L = '/api/admin/logistics';
let s, jdb, karim, lea;
const admin = (...a) => s.call(...a);
const tv = (token, extra = {}) => fetch(`${s.BASE}/api/tv/map`, { headers: token ? { 'x-tv-token': token, ...extra } : extra })
  .then(async r => ({ status: r.status, data: await r.json().catch(() => null), headers: r.headers }));

function order(ticket, { driverId = null, seq = null, status = 'prete', lat = 44.05, lng = 5.05, societe = `Hôtel ${ticket}`, deliveredAt = null, collect = 0 } = {}) {
  return jdb.prepare(`INSERT INTO orders (ticket, societe, contact, tel, adresse, status, created_at, driver_id, delivery_sequence, lat, lng, delivered_at, collect_only)
    VALUES (?, ?, 'c', '0', ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`).run(ticket, societe, `12 impasse Secrète ${ticket}, Carpentras`, status, driverId, seq, lat, lng, deliveredAt, collect).lastInsertRowid;
}

test.before(async () => {
  s = await startServer({ env: { ROAD_ROUTING: 'off' } });
  assert.equal((await admin('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  karim = (await admin('POST', `${L}/drivers`, { name: 'Karim', vehicle: 'Camionnette 1' })).data.driver;
  lea = (await admin('POST', `${L}/drivers`, { name: 'Léa' })).data.driver;
  jdb.prepare('UPDATE admin SET depot_address = ?, depot_lat = ?, depot_lng = ? WHERE id = 1').run('35 rue Théodore Aubanel, Carpentras', 44.0553, 5.0489);
  order('CZ-TV-1', { driverId: karim.id, seq: 1, status: 'livree', deliveredAt: new Date().toISOString(), societe: 'Hôtel des Lavandes' });
  order('CZ-TV-2', { driverId: karim.id, seq: 2, lat: 44.06, lng: 5.06, societe: 'Mas des Oliviers' });
  order('CZ-TV-3', { driverId: karim.id, seq: 3, lat: 44.07, lng: 5.04, societe: 'Collecte Clos des Pins', collect: 1 });
  order('CZ-TV-4', { driverId: null, lat: 44.04, lng: 5.03, societe: 'Hôtel sans chauffeur' });
});
test.after(async () => { if (jdb) jdb.close(); if (s) await s.stop(); });

test('gestion du lien : réservée à l\'administration', async () => {
  const anon = (method) => fetch(`${s.BASE}${L}/tv`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }).then(r => r.status);
  assert.equal(await anon('GET'), 401);
  assert.equal(await anon('POST'), 401);
  assert.equal(await anon('DELETE'), 401);
  const st = await admin('GET', `${L}/tv`);
  assert.equal(st.status, 200);
  assert.deepEqual(st.data, { active: false, createdAt: null, lastSeenAt: null });
});

test('sans lien actif, ou avec un jeton absent / faux : 401 et aucune donnée', async () => {
  const none = await tv('a'.repeat(48));
  assert.equal(none.status, 401);
  assert.equal(none.data.code, 'TV_DISABLED');
  assert.equal((await tv(null)).status, 401);
  assert.equal((await tv('trop-court')).status, 401);
  assert.equal(none.data.drivers, undefined);
});

let token;
test('création : le jeton n\'est donné qu\'une fois et seule son empreinte est conservée', async () => {
  const r = await admin('POST', `${L}/tv`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  token = r.data.token;
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(r.data.active, true);
  const row = jdb.prepare('SELECT * FROM tv_screen').get();
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(token), 'le jeton lui-même n\'est pas stocké');
  const st = await admin('GET', `${L}/tv`);
  assert.equal(st.data.active, true);
  assert.ok(!JSON.stringify(st.data).includes(token), 'la lecture ne redonne pas le jeton');
  assert.equal(st.data.lastSeenAt, null, 'la TV ne s\'est pas encore connectée');
  assert.equal((await tv('b'.repeat(48))).data.code, 'TV_UNKNOWN', 'un autre jeton est refusé');
});

test('la TV reçoit les tournées sans adresses ni tickets, et l\'administration voit qu\'elle s\'est connectée', async () => {
  const r = await tv(token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const raw = JSON.stringify(r.data);
  assert.ok(!/impasse|Secr[eè]te|Aubanel|adresse|address|ticket|CZ-TV/i.test(raw), `donnée privée envoyée à la TV : ${raw.slice(0, 400)}`);
  assert.deepEqual(r.data.depot, { lat: 44.0553, lng: 5.0489 });
  const k = r.data.drivers.find(d => d.id === karim.id);
  assert.equal(k.name, 'Karim'); assert.equal(k.vehicle, 'Camionnette 1');
  assert.deepEqual(k.stops.map(x => x.societe), ['Hôtel des Lavandes', 'Mas des Oliviers', 'Collecte Clos des Pins']);
  assert.deepEqual(k.stops.map(x => x.status), ['delivered', 'pending', 'pending']);
  assert.deepEqual(k.stops.map(x => x.collectOnly), [false, false, true], 'la collecte est distinguée d\'une livraison');
  assert.equal(k.stats.done, 1); assert.equal(k.stats.total, 3);
  assert.ok(k.truck && k.truck.lat != null, 'le camion est placé');
  assert.ok(k.legs.length >= 1);
  assert.deepEqual(r.data.unassigned.map(x => x.societe), ['Hôtel sans chauffeur']);
  assert.equal(r.data.drivers.find(d => d.id === lea.id).stops.length, 0);
  const st = await admin('GET', `${L}/tv`);
  assert.ok(st.data.lastSeenAt, 'dernière connexion enregistrée');
});

test('la carte de l\'administration garde ses adresses et signale les collectes', async () => {
  const m = await admin('GET', `${L}/map`);
  assert.equal(m.status, 200);
  const k = m.data.drivers.find(d => d.id === karim.id);
  assert.match(k.stops[1].adresse, /impasse/);
  assert.deepEqual(k.stops.map(x => x.collectOnly), [false, false, true]);
});

test('un nouveau lien invalide l\'ancien ; la désactivation coupe tout', async () => {
  const old = token;
  const r = await admin('POST', `${L}/tv`, {});
  token = r.data.token;
  assert.notEqual(token, old);
  assert.equal(jdb.prepare('SELECT COUNT(*) n FROM tv_screen').get().n, 1, 'un seul lien actif');
  const refused = await tv(old);
  assert.equal(refused.status, 401);
  assert.equal(refused.data.code, 'TV_UNKNOWN');
  assert.equal((await tv(token)).status, 200);
  const off = await admin('DELETE', `${L}/tv`);
  assert.equal(off.status, 200);
  assert.equal(off.data.active, false);
  const after = await tv(token);
  assert.equal(after.status, 401);
  assert.equal(after.data.code, 'TV_DISABLED');
});

test('la page est servie sans session, sans script en ligne, et ses fichiers existent', async () => {
  const r = await fetch(`${s.BASE}/carte-tv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /html/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const html = await r.text();
  assert.match(html, /noindex/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'aucun script en ligne (politique de contenu)');
  assert.ok(!/\son[a-z]+=/i.test(html), 'aucun gestionnaire d\'événement en ligne');
  for (const f of ['/carte-tv.js', '/carte-tv.css', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css']) {
    assert.equal((await fetch(`${s.BASE}${f}`)).status, 200, f);
  }
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
});

test('la page TV n\'utilise que les fonds de carte déjà autorisés', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'carte-tv.js'), 'utf8');
  const csp = (await s.call('GET', '/', null, true)).headers.get('content-security-policy');
  const imgSrc = /img-src ([^;]+)/.exec(csp)[1].split(/\s+/);
  const hosts = [...new Set([...src.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map(m => `https://${m[1]}`))].filter(h => /tile|geopf/.test(h));
  assert.deepEqual(hosts.sort(), ['https://data.geopf.fr', 'https://tile.openstreetmap.org']);
  for (const h of hosts) assert.ok(imgSrc.includes(h), `${h} absent de img-src`);
});
