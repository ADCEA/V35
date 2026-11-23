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
  assert.ok(!/PLANIGN/.test(SRC), 'le plan IGN a été retiré');
  assert.match(SRC, /IGN\('ORTHOIMAGERY\.ORTHOPHOTOS', 'image\/jpeg'\)/);
});

test('le sélecteur de la page propose exactement les fonds définis dans le code', () => {
  const inCode = [...SRC.matchAll(/\{ id: '([a-z]+)', label: '([^']+)'/g)].map(m => [m[1], m[2]]);
  const inPage = [...HTML.matchAll(/<button type="button" data-basemap="([a-z]+)" aria-pressed="(?:true|false)"(?: title="[^"]*")?>([^<]+)<\/button>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(inPage, inCode);
  assert.deepEqual(inCode.map(x => x[0]), ['nav', 'plan', 'sat']);
  assert.ok(!/Plan IGN/.test(HTML));
});

// ---------- fond « Navigation » (tuiles vectorielles OpenFreeMap dessinées par MapLibre) ----------
const ROOT = path.join(__dirname, '..', 'public');
const TV_JS = fs.readFileSync(path.join(ROOT, 'carte-tv.js'), 'utf8');
const TV_HTML = fs.readFileSync(path.join(ROOT, 'carte-tv.html'), 'utf8');
const STYLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'fonds', 'navigation.json'), 'utf8'));
const OPENMAPTILES = ['aerodrome_label', 'aeroway', 'boundary', 'building', 'housenumber', 'landcover', 'landuse', 'mountain_peak', 'park', 'place', 'poi', 'transportation', 'transportation_name', 'water', 'water_name', 'waterway'];

test('style Navigation : valide, une seule source (OpenFreeMap), couches du schéma OpenMapTiles', () => {
  assert.equal(STYLE.version, 8);
  assert.deepEqual(Object.keys(STYLE.sources), ['openmaptiles']);
  assert.equal(new URL(STYLE.sources.openmaptiles.url).origin, 'https://tiles.openfreemap.org');
  assert.equal(new URL(STYLE.glyphs.replace('{fontstack}', 'x').replace('{range}', '0-255')).origin, 'https://tiles.openfreemap.org');
  assert.ok(!STYLE.sprite, 'aucune planche d\'icônes : rien d\'autre à autoriser');
  assert.match(STYLE.sources.openmaptiles.attribution, /OpenFreeMap/);
  assert.match(STYLE.sources.openmaptiles.attribution, /OpenStreetMap/);   // l'attribution OSM est obligatoire
  const ids = STYLE.layers.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length, 'identifiants de couche uniques');
  for (const l of STYLE.layers) {
    if (l.type === 'background') continue;
    assert.equal(l.source, 'openmaptiles', l.id);
    assert.ok(OPENMAPTILES.includes(l['source-layer']), `${l.id} : couche « ${l['source-layer']} » inconnue du schéma`);
  }
  for (const needed of ['eau', 'parcs', 'routes', 'routes-lisere', 'batiments', 'lieux-ville']) assert.ok(ids.includes(needed), needed);
  // les routes sont dessinées des petites aux grandes : le liseré avant le remplissage
  assert.ok(ids.indexOf('routes-lisere') < ids.indexOf('routes'));
  // polices demandées au service : uniquement des piles que les styles d'OpenFreeMap utilisent
  const fonts = new Set(STYLE.layers.flatMap(l => (l.layout && l.layout['text-font']) || []));
  assert.deepEqual([...fonts].sort(), ['Noto Sans Bold', 'Noto Sans Italic', 'Noto Sans Regular']);
});

test('fond Navigation : politique de contenu (service, worker du site), bibliothèques locales, ordre de chargement', async () => {
  const s = await startServer({ env: { ROAD_ROUTING: 'off' } });
  try {
    for (const url of ['/', '/carte-tv']) {
      const csp = (await s.call('GET', url, null, true)).headers.get('content-security-policy');
      assert.deepEqual(/connect-src ([^;]+)/.exec(csp)[1].split(/\s+/).sort(), ["'self'", 'https://tiles.openfreemap.org'], url);
      assert.match(csp, /worker-src 'self'(;|$)/, 'le worker de MapLibre est un fichier du site, pas un blob');
      assert.ok(!/script-src[^;]*(blob:|unsafe-eval|unsafe-inline|https:)/.test(csp), 'aucun script en plus : ' + csp);
    }
    // tout ce que le style appelle est autorisé : le seul hôte est celui de connect-src
    const hosts = new Set([STYLE.sources.openmaptiles.url, STYLE.glyphs].map(u => new URL(u.replace(/\{[^}]+\}/g, 'x')).origin));
    assert.deepEqual([...hosts], ['https://tiles.openfreemap.org']);
    for (const f of ['/vendor/maplibre/maplibre-gl-csp.js', '/vendor/maplibre/maplibre-gl-csp-worker.js', '/vendor/maplibre/maplibre-gl.css', '/vendor/maplibre/leaflet-maplibre-gl.js', '/fond-navigation.js', '/fonds/navigation.json']) {
      assert.equal((await fetch(`${s.BASE}${f}`)).status, 200, f);
    }
    assert.equal((await fetch(`${s.BASE}/fonds/navigation.json`)).headers.get('content-type').split(';')[0], 'application/json');
  } finally { await s.stop(); }
  for (const [name, html] of [['index', HTML], ['carte-tv', TV_HTML]]) {
    const order = ['/vendor/leaflet/leaflet.js', '/vendor/maplibre/maplibre-gl-csp.js', '/vendor/maplibre/leaflet-maplibre-gl.js', '/fond-navigation.js'].map(f => html.indexOf(`<script src="${f}"></script>`));
    assert.ok(order.every(i => i >= 0), `${name} : script manquant`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${name} : Leaflet, puis MapLibre, puis le plugin, puis le fond`);
    assert.ok(html.includes('/vendor/maplibre/maplibre-gl.css'));
  }
  const worker = fs.readFileSync(path.join(ROOT, 'fond-navigation.js'), 'utf8');
  assert.match(worker, /setWorkerUrl\('\/vendor\/maplibre\/maplibre-gl-csp-worker\.js'\)|WORKER = '\/vendor\/maplibre\/maplibre-gl-csp-worker\.js'/);
});

test('carte de la TV : mêmes fonds que l\'administration, Navigation par défaut, plus de plan IGN', () => {
  assert.ok(!/PLANIGN|ign:/.test(TV_JS), 'plan IGN retiré de la page TV');
  assert.match(TV_JS, /want === 'nav' \|\| BASEMAPS\[want\] \? want : 'nav'/);
  assert.match(TV_JS, /plan: \{/); assert.match(TV_JS, /sat: \{/);
  assert.match(SRC, /get\(\) \{ try \{ const v = localStorage\.getItem\('cezanne\.basemap'\); return BASEMAPS\.some\(b => b\.id === v\) \? v : 'nav'/);
});
