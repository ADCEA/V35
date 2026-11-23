// Géocodage : le code postal et la ville de la fiche client sont ajoutés à l'adresse de la commande quand elle ne les contient pas,
// pour que « 1205 route du Château » ne tombe pas dans une autre commune. Un faux service de géocodage local joue Nominatim.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');
const { geocodeQuery } = require('../src/utils/geocode');

test('texte géocodé : adresse + code postal + ville, sans doublon', () => {
  const q = (adresse, codePostal, ville) => geocodeQuery({ adresse, codePostal, ville });
  assert.equal(q('1205 route du Château', '26450', 'Charols'), '1205 route du Château, 26450 Charols');
  assert.equal(q('  1205   route du Château ', '26450', 'Charols'), '1205 route du Château, 26450 Charols', 'espaces nettoyés');
  assert.equal(q('1205 route du Château 26450 Charols', '26450', 'Charols'), '1205 route du Château 26450 Charols', 'déjà complet : rien d\'ajouté');
  assert.equal(q('12 rue Saint-Étienne, ORANGE', '84100', 'Orange'), '12 rue Saint-Étienne, ORANGE, 84100', 'ville déjà présente (casse et accents ignorés) : seul le code postal manque');
  assert.equal(q('12 rue de la Paix, Orange', '84100', 'orange'), '12 rue de la Paix, Orange, 84100');
  assert.equal(q('3 avenue Foch 84100', '84100', 'Orange'), '3 avenue Foch 84100, Orange', 'code postal déjà présent : seule la ville manque');
  assert.equal(q('3 avenue Foch', null, null), '3 avenue Foch', 'fiche sans code postal ni ville : adresse seule, comme avant');
  assert.equal(q('3 avenue Foch', 'abc', 'Orange'), '3 avenue Foch, Orange', 'un code postal qui n\'a pas 5 chiffres est ignoré');
  assert.equal(q('3 avenue Foch', '8410', ''), '3 avenue Foch');
  assert.equal(q('', '84100', 'Orange'), '', 'jamais la seule commune : le point serait celui de la mairie');
  assert.equal(q(undefined, '84100', 'Orange'), '');
});

// ---------- faux service de géocodage ----------
let fake, fakePort; const asked = [];
test.before(() => new Promise(r => {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const q = u.searchParams.get('q') || '';
    asked.push(q);
    const hit = q.includes('26450') ? { lat: '44.5001', lon: '4.8002' } : q.includes('84100') ? { lat: '44.1388', lon: '4.8079' } : { lat: '10.0', lon: '10.0' };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([hit]));
  });
  fake.listen(0, '127.0.0.1', () => { fakePort = fake.address().port; r(); });
}));
test.after(() => fake && fake.close());

const CODE = 'code-facturation-1'; const B = '/api/admin/billing';
async function until(fn, ms = 12000) { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) return null; await new Promise(r => setTimeout(r, 150)); } }

test('commande « prête » : le point vient de l\'adresse complétée par la fiche ; une fiche corrigée replace les commandes en cours, pas les livrées', async () => {
  asked.length = 0;
  const s = await startServer({ env: { ROAD_ROUTING: 'off', NODE_ENV: 'test', GEOCODER_URL: `http://127.0.0.1:${fakePort}/search` } });
  let jdb;
  try {
    assert.equal((await s.call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
    assert.equal((await s.call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
    jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
    jdb.prepare('UPDATE admin SET depot_address = ?, depot_lat = ?, depot_lng = ? WHERE id = 1').run('35 rue Théodore Aubanel, Carpentras', 44.0553, 5.0489);   // dépôt déjà localisé : seule la commande est géocodée
    const c = await s.call('POST', `${B}/catalog/clients`, { societe: 'CHATEAU TEST', contact: 'X', tel: '0600000000', adresse: '1205 route du Château', codePostal: '26450', ville: 'Charols', email: 'chateau@test.fr' });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const id = c.data.client.id;
    const ins = (ticket, status) => jdb.prepare(`INSERT INTO orders (ticket, societe, contact, tel, adresse, status, created_at, client_id, lat, lng) VALUES (?, 'CHATEAU TEST', 'c', '0', '1205 route du Château', ?, datetime('now'), ?, ?, ?)`)
      .run(ticket, status, id, status === 'livree' ? 1.5 : null, status === 'livree' ? 2.5 : null).lastInsertRowid;
    const ready = ins('CZ-G1', 'prete');
    const done = ins('CZ-G2', 'livree');
    const row = (i) => jdb.prepare('SELECT lat, lng FROM orders WHERE id = ?').get(i);

    assert.equal((await s.call('GET', '/api/admin/logistics/map')).status, 200);
    assert.ok(await until(() => row(ready).lat != null), 'la commande a été géocodée');
    assert.deepEqual(asked, ['1205 route du Château, 26450 Charols'], 'le service reçoit adresse + code postal + ville');
    assert.deepEqual(row(ready), { lat: 44.5001, lng: 4.8002 });

    // la fiche est corrigée (autre commune) : la commande en cours perd son point, la livrée garde le sien
    const u = await s.call('PUT', `${B}/catalog/clients/${id}`, { codePostal: '84100', ville: 'Orange' });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.deepEqual(row(ready), { lat: null, lng: null });
    assert.deepEqual(row(done), { lat: 1.5, lng: 2.5 });
    // modifier autre chose (téléphone) ne replace rien
    assert.equal((await s.call('PUT', `${B}/catalog/clients/${id}`, { tel: '0611111111' })).status, 200);
    assert.deepEqual(row(done), { lat: 1.5, lng: 2.5 });

    asked.length = 0;
    // la carte se réinterroge toute seule : un passage précédent peut encore être en pause (1 s entre deux appels au service)
    for (let i = 0; i < 10 && row(ready).lat == null; i++) { assert.equal((await s.call('GET', '/api/admin/logistics/map')).status, 200); await new Promise(r => setTimeout(r, 1500)); }
    assert.ok(row(ready).lat != null, 'replacée avec la fiche corrigée');
    assert.deepEqual(asked, ['1205 route du Château, 84100 Orange']);
    assert.deepEqual(row(ready), { lat: 44.1388, lng: 4.8079 });
  } finally { if (jdb) jdb.close(); await s.stop(); }
});
