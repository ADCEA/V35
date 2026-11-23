// L'adresse d'une commande est la copie de celle de la fiche client. Une fiche corrigée doit corriger ses commandes pas encore
// livrées (carte, bon de livraison, chauffeur) : sinon un point faux ne se rattrape jamais (cas « Château des Oliviers de Salette » :
// la commande gardait « … RTE DU CHATEAU RTE DU CHATEAU », introuvable, et l'ancien point, en Savoie, restait affiché).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const B = '/api/admin/billing'; const CODE = 'code-facturation-1';
const JUNK = '1205 ROUTE DU CHATEAU RTE DU CHATEAU';
const FICHE = '1205 ROUTE DU CHATEAU , 26450 CHAROLS';
let fake, fakePort; const asked = [];
test.before(() => new Promise(r => {
  fake = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    asked.push(q);
    // comme le vrai service : l'adresse dédoublée est introuvable, l'adresse propre est trouvée
    const hit = /CHATEAU RTE DU CHATEAU/i.test(q) ? [] : [q.includes('26450') ? { lat: '44.5875', lon: '4.9698' } : { lat: '45.4114', lon: '5.8424' }];
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(hit));
  });
  fake.listen(0, '127.0.0.1', () => { fakePort = fake.address().port; r(); });
}));
test.after(() => fake && fake.close());
async function until(fn, ms = 15000) { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) return null; await new Promise(r => setTimeout(r, 150)); } }
const env = () => ({ ROAD_ROUTING: 'off', NODE_ENV: 'test', GEOCODER_URL: `http://127.0.0.1:${fakePort}/search` });

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
  return { jdb, mk, ins, drv, row: (id) => jdb.prepare('SELECT adresse, lat, lng, geo_query FROM orders WHERE id = ?').get(id) };
}

test('fiche corrigée : les commandes en cours prennent la nouvelle adresse (pas les livrées) et le point est recalculé aussitôt', async () => {
  asked.length = 0;
  const s = await startServer({ env: env() });
  let ctx;
  try {
    ctx = await setup(s);
    const { mk, ins, row } = ctx;
    const c = await mk('CHATEAU TEST', JUNK, '26450', 'CHAROLS', 'chateau@test.fr');
    const open = ins('CZ-A1', c, JUNK, { lat: 45.4114, lng: 5.8424 });                                       // ancien point faux
    const done = ins('CZ-A2', c, JUNK, { status: 'livree', lat: 45.4114, lng: 5.8424, deliveredLat: 44.5, deliveredLng: 4.9 });

    // avant correction : l'adresse dédoublée est introuvable, l'ancien point reste
    assert.equal((await s.call('GET', '/api/admin/logistics/map')).status, 200);
    assert.ok(await until(() => asked.length >= 1));
    await new Promise(r => setTimeout(r, 1500));
    assert.deepEqual(row(open), { adresse: JUNK, lat: 45.4114, lng: 5.8424, geo_query: null });

    // la fiche est corrigée dans le logiciel
    const put = await s.call('PUT', `${B}/catalog/clients/${c}`, { societe: 'CHATEAU TEST', contact: 'X', tel: '0600000000', email: 'chateau@test.fr', adresse: FICHE, codePostal: '26450', ville: 'CHAROLS' });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.equal(row(open).adresse, FICHE, 'la commande en cours prend l\'adresse de la fiche');
    assert.equal(row(done).adresse, JUNK, 'la commande livrée garde son adresse');
    assert.deepEqual([row(done).lat, row(done).lng], [45.4114, 5.8424]);

    // recalcul tout de suite (pas d'attente de 10 min : le texte a changé)
    asked.length = 0;
    const m = await s.call('GET', '/api/admin/logistics/map');
    assert.equal(m.status, 200);
    const stop = m.data.drivers[0].stops.find(x => x.ticket === 'CZ-A1');
    assert.equal(stop.adresse, FICHE, 'la carte affiche l\'adresse corrigée');
    assert.ok(await until(() => row(open).geo_query === FICHE), 'point recalculé avec la fiche corrigée');
    assert.deepEqual(row(open), { adresse: FICHE, lat: 44.5875, lng: 4.9698, geo_query: FICHE });
    assert.deepEqual(asked, [FICHE]);
  } finally { if (ctx) ctx.jdb.close(); await s.stop(); }
});

test('fiche déjà corrigée avant : la carte rattrape les commandes en cours ; invités, fiches sans adresse et livrées restent intacts', async () => {
  asked.length = 0;
  const s = await startServer({ env: env() });
  let ctx;
  try {
    ctx = await setup(s);
    const { mk, ins, row, jdb } = ctx;
    const c = await mk('CHATEAU TEST', FICHE, '26450', 'CHAROLS', 'chateau@test.fr');
    const vide = await mk('SANS ADRESSE', '5 rue Neuve', '84200', 'Carpentras', 'vide@test.fr');
    jdb.prepare('UPDATE clients SET adresse = ? WHERE id = ?').run('', vide);                          // fiche vidée : ne doit rien effacer
    const open = ins('CZ-B1', c, JUNK, { lat: 45.4114, lng: 5.8424 });
    const done = ins('CZ-B2', c, JUNK, { status: 'livree', deliveredLat: 44.5, deliveredLng: 4.9, lat: 45.4114, lng: 5.8424 });
    const keep = ins('CZ-B3', vide, '5 rue Neuve', { lat: 44.0, lng: 5.0 });
    const guest = ins('CZ-B4', null, 'Adresse libre d\'un invité', { lat: 44.1, lng: 5.1 });

    const m = await s.call('GET', '/api/admin/logistics/map');
    assert.equal(m.status, 200);
    const stops = m.data.drivers[0].stops;
    assert.equal(stops.find(x => x.ticket === 'CZ-B1').adresse, FICHE);
    assert.equal(row(open).adresse, FICHE);
    assert.equal(row(done).adresse, JUNK, 'livrée : adresse du jour de la livraison');
    assert.equal(row(keep).adresse, '5 rue Neuve', 'fiche sans adresse : la commande garde la sienne');
    assert.equal(row(guest).adresse, 'Adresse libre d\'un invité', 'sans fiche : inchangée');
    assert.ok(await until(() => row(open).geo_query === FICHE));
    assert.deepEqual([row(open).lat, row(open).lng], [44.5875, 4.9698]);
  } finally { if (ctx) ctx.jdb.close(); await s.stop(); }
});
