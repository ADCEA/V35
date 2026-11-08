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

test('« Nouvel avoir » : bouton sur la liste des factures et sur le tableau de bord, qui ouvre la fenêtre de création d\'avoir', () => {
  const read = (f) => fs.readFileSync(path.join(PUBLIC, 'billing', f), 'utf8');
  const inv = read('invoices.js'); const dash = read('dashboard.js');
  assert.ok(inv.includes('id="il-credit">Nouvel avoir</button>') && inv.includes("#il-credit').onclick"));
  assert.ok(inv.includes('Bill.openInvoice(invId, done, { credit: true })'), 'le choix de la facture ouvre le parcours d\'avoir existant');
  assert.ok(inv.includes('opts.credit') && inv.includes('ACTIONS.credit()'));
  assert.ok(dash.includes('data-act="credit">Nouvel avoir') && dash.includes('newCreditNote: true') && inv.includes('params.newCreditNote'));
});

test('cases à cocher : listes des factures et des BL, barre de sélection, export ZIP, colonne « Format » (de la facture)', () => {
  const read = (f) => fs.readFileSync(path.join(PUBLIC, 'billing', f), 'utf8');
  const inv = read('invoices.js'); const bl = read('deliveries.js'); const css = read('billing.css');
  assert.ok(inv.includes('class="il-pick"') && inv.includes('id="il-all"') && inv.includes('/invoices/export.zip?ids='));
  assert.ok(inv.includes('id="il-bar"') && inv.includes('Exporter en PDF (un par facture)'));
  assert.ok(bl.includes('class="dl-pick"') && bl.includes('id="dl-all"') && bl.includes('/deliveries/export.pdf?ids=') && bl.includes('/deliveries/export.csv?ids='));
  assert.ok(bl.includes('>Format</th>') && bl.includes('fmtTag(d)'));
  assert.ok(css.includes('.bl-selbar') && css.includes('.bl-fmt'));
});

test('présentation compacte : bons de livraison et « Facturer le mois » reprennent la liste des factures (lignes serrées, hauteur d\'écran, en-tête fixe)', () => {
  const read = (f) => fs.readFileSync(path.join(PUBLIC, 'billing', f), 'utf8');
  const core = read('core.js'); const inv = read('invoices.js'); const bl = read('deliveries.js'); const mo = read('month.js'); const css = read('billing.css');
  // une seule fonction d'ajustement à la hauteur de l'écran, partagée, rappelée au redimensionnement
  assert.ok(core.includes('Bill.fitList = function') && core.includes("window.addEventListener('resize'") && core.includes('p.refit(m)'));
  assert.ok(inv.includes("Bill.fitList(main, '.bl-tablewrap.inv'") && inv.includes('refit(main)') && !inv.includes('fitBound'));
  // BL : tableau compact, puces de filtre comme les factures, barre de sélection qui retire sa hauteur au tableau
  assert.ok(bl.includes('<div class="bl-tablewrap inv"><table class="bl-table inv dl">') && bl.includes("Bill.fitList(main, '.bl-tablewrap.inv'") && bl.includes('refit(main)'));
  assert.ok(bl.includes('class="bl-head tight"') && bl.includes('class="bl-filters inline"') && bl.includes('class="bl-chipf ') && !bl.includes('class="bl-tab '));
  assert.ok(bl.includes('<td class="client" title="'));
  assert.ok((bl.match(/fit\(main, false\)/g) || []).length >= 3, 'la barre de sélection (affichée ou retirée) réajuste le tableau');
  assert.ok(inv.includes('la barre pousse le tableau vers le bas'));
  // Facturer le mois : les deux tableaux sont compacts, la ligne coche/ouvre, les brouillons sont atteignables sous la liste pleine hauteur
  assert.equal((mo.match(/<div class="bl-tablewrap inv hug"><table class="bl-table inv">/g) || []).length, 2);
  assert.ok(mo.includes("Bill.fitList(main, '#mo-prev .bl-tablewrap'") && mo.includes('refit(main)') && mo.includes('function goDrafts'));
  assert.ok(mo.includes('id="mo-goto"') && mo.includes('id="mo-p2"'));
  assert.ok(mo.includes('id="mo-all"') && mo.includes('class="mo-c"') && mo.includes('id="md-all"') && mo.includes('class="md-c"'), 'les cases existantes sont conservées');
  // styles
  assert.ok(css.includes('.bl-table.inv.dl td.client') && css.includes('.bl-tablewrap.inv.hug') && css.includes('.bl-chipsrow.pay'));
});

test('Équipe (RH) : onglet branché dans l\'administration, scripts valides, page de pointage sans script en ligne', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  // onglet de l'administration
  assert.ok(html.includes('data-admin-view="rh"') && html.includes('id="admin-view-rh"') && html.includes('id="rh-root"'));
  assert.ok(/const ADMIN_VIEWS = \[[^\]]*'rh'/.test(app) && app.includes("if (view === 'rh') renderRhView()"));
  assert.ok(html.includes('<link rel="stylesheet" href="/rh.css">') && html.includes('<script src="/rh.js"></script>'));
  assert.ok(html.indexOf('/billing/core.js') < html.indexOf('/rh.js') && html.indexOf('/app.js') < html.indexOf('/rh.js'), 'rh.js utilise Bill, api() et escHtml()');
  for (const f of ['rh.js', 'rh.css', 'badgeuse.js', 'badgeuse.css', 'badgeuse.html']) assert.ok(fs.existsSync(path.join(PUBLIC, f)), `${f} manquant`);
  for (const f of ['rh.js', 'badgeuse.js']) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), { filename: f }), f);

  // tablette : la politique de sécurité interdit les scripts en ligne, donc la page ne doit en contenir aucun
  const kiosk = fs.readFileSync(path.join(PUBLIC, 'badgeuse.html'), 'utf8');
  assert.deepEqual([...kiosk.matchAll(/<script\b[^>]*>/g)].map(m => m[0]), ['<script src="/badgeuse.js">']);
  assert.ok(!/\son(click|load|error|submit|change)=/i.test(kiosk), 'aucun gestionnaire en ligne');
  assert.ok(kiosk.includes('<link rel="stylesheet" href="/badgeuse.css">') && kiosk.includes('noindex'));

  // textes saisis (noms, notes, machines) : toujours échappés avant d'être placés dans la page
  const rh = fs.readFileSync(path.join(PUBLIC, 'rh.js'), 'utf8');
  const kjs = fs.readFileSync(path.join(PUBLIC, 'badgeuse.js'), 'utf8');
  // (les deux seules interpolations directes de `x.name` de rh.js sont le titre et le texte des fenêtres Bill, qui échappent eux-mêmes)
  for (const [name, src, allowed] of [['rh.js', rh, 2], ['badgeuse.js', kjs, 0]]) {
    assert.ok(/const e(sc)? = /.test(src), `${name} : fonction d'échappement`);
    const bare = [...src.matchAll(/\$\{\s*[a-z]\w*\.(?:name|firstName|lastName|jobTitle|machineName|note|notes|label|poste)\s*\}/g)].map(m => m[0]);
    assert.equal(bare.length, allowed, `${name} : texte saisi placé sans échappement : ${bare.join(', ')}`);
  }
  // le jeton de tablette ne reste ni dans l'adresse ni ailleurs que dans le stockage local
  assert.ok(kjs.includes("history.replaceState(null, '', location.pathname)") && kjs.includes("'x-terminal-token'"));
});

test('Atelier (production) : onglet admin branché, écran tablette sans script en ligne, textes saisis échappés', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  // onglet de l'administration
  assert.ok(html.includes('data-admin-view="atelier"') && html.includes('id="admin-view-atelier"') && html.includes('id="atelier-root"'));
  assert.ok(/const ADMIN_VIEWS = \[[^\]]*'atelier'/.test(app) && app.includes("if (view === 'atelier') renderAtelierView()"));
  assert.ok(app.includes("if (view === 'rh') renderRhView()"), 'l\'onglet Équipe reste branché');
  assert.ok(html.includes('<link rel="stylesheet" href="/prod.css">') && html.includes('<script src="/prod.js"></script>'));
  for (const dep of ['/app.js', '/billing/core.js', '/rh.js']) assert.ok(html.indexOf(dep) < html.indexOf('/prod.js'), `prod.js se charge après ${dep}`);
  for (const f of ['prod.js', 'prod.css', 'atelier.js', 'atelier.css', 'atelier.html']) assert.ok(fs.existsSync(path.join(PUBLIC, f)), `${f} manquant`);
  for (const f of ['prod.js', 'atelier.js']) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), { filename: f }), f);

  // tablette : aucun script en ligne (la politique de sécurité les interdit), page non indexée
  const tab = fs.readFileSync(path.join(PUBLIC, 'atelier.html'), 'utf8');
  assert.deepEqual([...tab.matchAll(/<script\b[^>]*>/g)].map(m => m[0]), ['<script src="/atelier.js">']);
  assert.ok(!/\son(click|load|error|submit|change)=/i.test(tab), 'aucun gestionnaire en ligne');
  assert.ok(tab.includes('<link rel="stylesheet" href="/atelier.css">') && tab.includes('noindex'));

  // textes saisis (clients, notes, motifs, programmes) : toujours échappés avant d'être placés dans la page
  const pj = fs.readFileSync(path.join(PUBLIC, 'prod.js'), 'utf8');
  const aj = fs.readFileSync(path.join(PUBLIC, 'atelier.js'), 'utf8');
  // (seule interpolation directe : le code du lot, généré par le serveur, dans le titre d'une fenêtre Bill)
  for (const [name, src, allowed] of [['prod.js', pj, 1], ['atelier.js', aj, 0]]) {
    assert.ok(/const e(sc)? = /.test(src), `${name} : fonction d'échappement`);
    const bare = [...src.matchAll(/\$\{\s*[a-z]\w*\.(?:name|firstName|lastName|jobTitle|machineName|note|notes|label|poste|text|reason|clientName|programName|linenType|code)\s*\}/g)].map(m => m[0]);
    assert.equal(bare.length, allowed, `${name} : texte saisi placé sans échappement : ${bare.join(', ')}`);
  }
  // l'écran tablette partage le jeton de la badgeuse et n'en laisse rien dans l'adresse
  assert.ok(aj.includes("history.replaceState(null, '', location.pathname)") && aj.includes("'x-terminal-token'") && aj.includes('cezanne.badgeuse.token'));
});

test('Statistiques : bloc « Répartition du linge » branché après le filtre de dates, famille de linge dans la fiche article', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.ok(html.includes('<script src="/stats-families.js"></script>'));
  assert.ok(html.indexOf('/stats-daily.js') < html.indexOf('/stats-families.js'), 'stats-families.js utilise window.statsRange défini par stats-daily.js');
  assert.ok(html.indexOf('/app.js') < html.indexOf('/stats-families.js'), 'api() et escHtml() viennent de app.js');
  assert.ok(app.includes('<div id="stats-families"></div>') && app.includes('renderStatsFamilies(fam)'));
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(PUBLIC, 'stats-families.js'), 'utf8'), { filename: 'stats-families.js' }));
  const sf = fs.readFileSync(path.join(PUBLIC, 'stats-families.js'), 'utf8');
  assert.ok(sf.includes('/api/admin/stats/families?from=') && sf.includes('window.statsRange()'));
  // noms d'articles (saisis) : toujours échappés
  const bare = [...sf.matchAll(/\$\{\s*[a-z]\w*\.(?:name|label)\s*\}/g)].map(m => m[0]);
  assert.deepEqual(bare, [], `texte saisi placé sans échappement : ${bare.join(', ')}`);
  const articles = fs.readFileSync(path.join(PUBLIC, 'billing', 'articles.js'), 'utf8');
  assert.ok(articles.includes('id="a-fam"') && articles.includes('linenFamily: val(\'#a-fam\')'));
  assert.ok(fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8').includes('.sf-row'));
});
