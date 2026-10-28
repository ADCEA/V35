// Garde-fous de l'interface Facturation : les fichiers référencés existent et sont du JavaScript valide.
// (La vérification complète dans un navigateur se fait à la main avec Playwright : voir le README.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

test('index.html charge les fichiers de la Facturation, et eux seuls', () => {
  const scripts = [...html.matchAll(/<script src="(\/billing[^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['/billing/core.js', '/billing/shared.js', '/billing/dashboard.js', '/billing/invoices.js', '/billing/deliveries.js', '/billing/quotes.js', '/billing/month.js', '/billing/cash.js', '/billing/sdd.js', '/billing/config.js', '/billing/articles.js', '/billing/prices.js', '/billing/clients.js']);
  assert.ok(html.includes('<link rel="stylesheet" href="/billing/billing.css">'));
  assert.ok(!html.includes('/billing.js'), "l'ancien écran /billing.js ne doit plus être chargé");
  for (const f of [...scripts, '/billing/billing.css']) assert.ok(fs.existsSync(path.join(PUBLIC, f)), `${f} manquant`);
  assert.ok(!fs.existsSync(path.join(PUBLIC, 'billing.js')));
});

test('les scripts de la Facturation sont du JavaScript valide', () => {
  for (const f of fs.readdirSync(path.join(PUBLIC, 'billing')).filter(n => n.endsWith('.js'))) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(PUBLIC, 'billing', f), 'utf8'), { filename: f }), f);
  }
});

test('chaque page de la navigation est enregistrée', () => {
  const nav = [...fs.readFileSync(path.join(PUBLIC, 'billing', 'core.js'), 'utf8').matchAll(/\{ key: '(\w+)'/g)].map(m => m[1]);
  const registered = new Set();
  for (const f of fs.readdirSync(path.join(PUBLIC, 'billing')).filter(n => n.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(PUBLIC, 'billing', f), 'utf8').matchAll(/Bill\.register\('(\w+)'/g)) registered.add(m[1]);
  }
  for (const k of nav) assert.ok(registered.has(k), `page « ${k} » non enregistrée`);
  assert.ok(nav.length >= 10);
});

test('le tableau de bord journalier des Statistiques est chargé et valide', () => {
  assert.ok(html.includes('<script src="/stats-daily.js"></script>'));
  const file = path.join(PUBLIC, 'stats-daily.js');
  assert.ok(fs.existsSync(file));
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: 'stats-daily.js' }));
  assert.ok(html.indexOf('/app.js') < html.indexOf('/stats-daily.js'), 'chargé après app.js (il utilise api() et escHtml())');
});

test("l'espace client à onglets : espace.js est chargé avant app.js, valide, et les identifiants qu'il manipule existent", () => {
  assert.ok(html.includes('<script src="/espace.js"></script>'));
  assert.ok(html.indexOf('/espace.js') < html.indexOf('/app.js'), 'espace.js d\'abord : app.js l\'appelle en fin d\'initialisation');
  const src = fs.readFileSync(path.join(PUBLIC, 'espace.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'espace.js' }));
  // chaque onglet a son bouton et son panneau
  for (const t of ['accueil', 'factures', 'contrat', 'livraisons', 'compte']) {
    assert.ok(html.includes(`id="esp-tab-${t}"`), `bouton de l'onglet ${t}`);
    assert.ok(html.includes(`id="esp-panel-${t}"`), `panneau de l'onglet ${t}`);
  }
  // tous les éléments que le script va chercher par identifiant sont dans la page
  const ids = new Set([...src.matchAll(/getElementById\('([\w-]+)'\)/g)].map(m => m[1]));
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  for (const m of app.matchAll(/getElementById\('((?:esp|own|invoice|inprogress|nps|account)[\w-]*)'\)/g)) ids.add(m[1]);
  // (les éléments que les scripts fabriquent eux-mêmes, comme la carte NPS, n'ont pas à figurer dans la page)
  for (const id of ids) assert.ok(html.includes(`id="${id}"`) || src.includes(`id="${id}"`) || app.includes(`id="${id}"`), `#${id} absent de index.html`);
});
