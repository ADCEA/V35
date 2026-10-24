// Garde-fous de l'interface Facturation : les fichiers référencés existent et sont du JavaScript valide.
// (La vérification complète dans un navigateur se fait à la main avec Playwright : voir le README.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

test('index.html charge les fichiers de la Facturation, et eux seuls', () => {
  const scripts = [...html.matchAll(/<script src="(\/billing[^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['/billing/core.js', '/billing/shared.js', '/billing/dashboard.js', '/billing/invoices.js', '/billing/quotes.js', '/billing/month.js', '/billing/cash.js', '/billing/config.js']);
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
