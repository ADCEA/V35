// Fonds de carte de la carte des tournées : chaque serveur de tuiles utilisé par la page doit être autorisé par la politique de
// contenu (sinon le navigateur bloque les images et la carte reste vide sans message), et les adresses WMTS de l'IGN doivent
// garder le bon ordre colonne / ligne / zoom.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const { startServer } = require('./helpers');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'logistics-map.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('chaque fond de carte a son serveur dans img-src, et rien d\'autre n\'est ouvert', async () => {
  const s = await startServer({ env: { ROAD_ROUTING: 'off' } });
  try {
    const csp = (await s.call('GET', '/', null, true)).headers.get('content-security-policy');
    const imgSrc = /img-src ([^;]+)/.exec(csp)[1].split(/\s+/);
    // adresses de tuiles déclarées dans le code de la carte (hors tuiles du trafic, relayées par le serveur lui-même)
    const hosts = [...new Set([...SRC.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map(m => `https://${m[1]}`))]
      .filter(h => /tile|geopf/.test(h));
    assert.deepEqual(hosts.sort(), ['https://data.geopf.fr', 'https://tile.openstreetmap.org']);
    for (const h of hosts) assert.ok(imgSrc.includes(h), `${h} absent de img-src : ${csp}`);
    // la liste autorisée est exactement : le site, data:, blob: et ces deux serveurs
    assert.deepEqual(imgSrc.sort(), ["'self'", 'blob:', 'data:', ...hosts].sort());
  } finally { await s.stop(); }
});

test('adresses des tuiles IGN : zoom, colonne et ligne au bon endroit, sans clé', () => {
  const m = /const IGN = \(layer, format\) => `([^`]+)`/.exec(SRC);
  assert.ok(m, 'modèle d\'adresse IGN introuvable');
  const url = new URL(m[1].replace(/\$\{layer\}/, 'L').replace(/\$\{format\}/, 'F').replace(/\{([zxy])\}/g, '<$1>'));
  assert.equal(url.origin + url.pathname, 'https://data.geopf.fr/wmts');
  assert.equal(url.searchParams.get('TILEMATRIX'), '<z>');
  assert.equal(url.searchParams.get('TILEROW'), '<y>');   // ligne = y
  assert.equal(url.searchParams.get('TILECOL'), '<x>');   // colonne = x
  assert.equal(url.searchParams.get('TILEMATRIXSET'), 'PM');
  assert.ok(![...url.searchParams.keys()].some(k => /key|apikey|token/i.test(k)), 'aucune clé dans l\'adresse');
  assert.match(SRC, /IGN\('GEOGRAPHICALGRIDSYSTEMS\.PLANIGNV2', 'image\/png'\)/);
  assert.match(SRC, /IGN\('ORTHOIMAGERY\.ORTHOPHOTOS', 'image\/jpeg'\)/);
});

test('le sélecteur de la page propose exactement les fonds définis dans le code', () => {
  const inCode = [...SRC.matchAll(/\{ id: '([a-z]+)', label: '([^']+)'/g)].map(m => [m[1], m[2]]);
  const inPage = [...HTML.matchAll(/<button type="button" data-basemap="([a-z]+)" aria-pressed="(?:true|false)">([^<]+)<\/button>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(inPage, inCode);
  assert.deepEqual(inCode.map(x => x[0]), ['plan', 'ign', 'sat']);
});
