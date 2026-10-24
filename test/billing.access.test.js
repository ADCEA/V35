// Restreindre un article aux hôtels qui l'utilisent : accès par article, usage sur 12 mois, règles de sécurité, journal.
const os = require('os'); const path = require('path'); const fs = require('fs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-access-'));
process.env.DATA_DIR = DATA_DIR; process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const catalog = require('../src/billing/catalog');
const services = require('../src/services');

const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof engine.BillingError && (!re || re.test(e.message)));
const events = () => db.prepare("SELECT * FROM billing_events WHERE action = 'client_article_access' ORDER BY id").all().map(e => ({ ...e, d: JSON.parse(e.detail_json) }));
const rowsOf = (clientId) => db.prepare('SELECT article_id FROM client_articles WHERE client_id = ? ORDER BY article_id').all(clientId).map(r => r.article_id);
const addClient = (societe, email) => Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash) VALUES (?,?,?,?,?,'x')`).run(email, societe, 'C', '06', '1 rue du Test').lastInsertRowid);
const daysAgo = (n) => engine.addDays(engine.todayParis(), -n);
function order(clientId, serviceId, qty, delivered, createdDate) {
  const id = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, created_at) VALUES (?,?,?,?,?,?, 'livree', ?)`)
    .run(`T-${clientId}-${serviceId}-${createdDate}`, clientId, 'S', 'C', '06', 'a', `${createdDate} 08:00:00`).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(id, serviceId, 'x', 'x', 'x', 1, qty, delivered);
}
const accessOf = (articleId) => Object.fromEntries(catalog.articleAccess(articleId).clients.map(c => [c.societe, c]));

let drap, serviette, peignoir, alpha, beta, gamma;

test('mise en place : trois articles, trois hôtels', () => {
  db.prepare('DELETE FROM articles').run();
  drap = catalog.createArticle({ name: 'Drap', code: 'D', sageCode: 'S-D', price: 1 }).id;
  serviette = catalog.createArticle({ name: 'Serviette', code: 'S', sageCode: 'S-S', price: 1 }).id;
  peignoir = catalog.createArticle({ name: 'Peignoir', code: 'P', sageCode: 'S-P', price: 1 }).id;
  alpha = addClient('Hôtel Alpha', 'a@exemple.fr'); beta = addClient('Beta Resort', 'b@exemple.fr'); gamma = addClient('Gamma Lodge', 'c@exemple.fr');
  // Alpha commande des peignoirs régulièrement, Beta en a commandé il y a plus d'un an, Gamma jamais
  order(alpha, peignoir, 5, 4, daysAgo(20)); order(alpha, peignoir, 3, null, daysAgo(60));
  order(beta, peignoir, 2, 2, daysAgo(500));
  order(alpha, drap, 9, 9, daysAgo(10));
  const list = catalog.listArticles();
  assert.ok(list.articles.every(a => a.hiddenFor === 0), 'aucun hôtel restreint : rien n’est masqué');
});

test('état initial : tous les hôtels ont accès, usage sur 12 mois (quantité livrée à défaut de commandée)', () => {
  const a = catalog.articleAccess(peignoir);
  assert.equal(a.article.name, 'Peignoir');
  assert.equal(a.clients.length, 3);
  assert.ok(a.clients.every(c => c.hasAccess && !c.restricted));
  const by = accessOf(peignoir);
  assert.equal(by['Hôtel Alpha'].pieces12m, 4 + 3, '4 livrés + 3 commandés (pas de quantité livrée saisie)');
  assert.equal(by['Hôtel Alpha'].lastOrderAt, daysAgo(20));
  assert.equal(by['Beta Resort'].pieces12m, 0, 'commandé il y a plus de 12 mois : ne compte pas');
  assert.equal(by['Beta Resort'].lastOrderAt, daysAgo(500), 'mais la dernière commande reste connue');
  assert.equal(by['Gamma Lodge'].lastOrderAt, null);
  rejects(() => catalog.articleAccess('inconnu'), /introuvable/);
});

test('aperçu : rien n’est écrit ni journalisé', () => {
  const r = catalog.setArticleAccess(peignoir, [alpha], { apply: false });
  assert.equal(r.applied, false);
  assert.deepEqual(r.changes.map(c => [c.client, c.access, c.becameRestricted, c.articleCount]), [['Beta Resort', false, true, 2], ['Gamma Lodge', false, true, 2]]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM client_articles').get().c, 0);
  assert.equal(events().length, 0);
});

test('retirer un article à des hôtels « catalogue complet » les passe en sélection sans toucher aux autres articles', () => {
  const r = catalog.setArticleAccess(peignoir, [alpha], { apply: true });
  assert.equal(r.applied, true); assert.equal(r.changes.length, 2);
  assert.deepEqual(rowsOf(beta), [drap, serviette].sort(), 'Beta garde les autres articles');
  assert.deepEqual(rowsOf(gamma), [drap, serviette].sort());
  assert.deepEqual(rowsOf(alpha), [], 'Alpha n’est pas touché : il garde le catalogue complet');
  // effet réel sur ce que voit l’hôtel
  const names = (c) => services.getServicesForClient(c).map(s => s.name).sort();
  assert.deepEqual(names(beta), ['Drap', 'Serviette']);
  assert.deepEqual(names(alpha), ['Drap', 'Peignoir', 'Serviette']);
  // journal : un événement par hôtel, filtrable par article et par hôtel
  const ev = events();
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map(e => [e.d.client, e.d.access, e.d.restricted, e.d.count]), [['Beta Resort', false, true, 2], ['Gamma Lodge', false, true, 2]]);
  assert.equal(catalog.priceLog({ articleId: peignoir }).events.filter(e => e.action === 'client_article_access').length, 2);
  assert.equal(catalog.priceLog({ clientId: beta }).events.filter(e => e.action === 'client_article_access').length, 1);
  const by = accessOf(peignoir);
  assert.deepEqual([by['Hôtel Alpha'].hasAccess, by['Beta Resort'].hasAccess, by['Beta Resort'].restricted], [true, false, true]);
  assert.equal(catalog.listArticles().articles.find(a => a.id === peignoir).hiddenFor, 2);
  assert.equal(catalog.listArticles().articles.find(a => a.id === drap).hiddenFor, 0);
});

test('idempotent : rejouer la même liste ne change rien et ne journalise rien', () => {
  const r = catalog.setArticleAccess(peignoir, [alpha], { apply: true });
  assert.deepEqual(r.changes, []);
  assert.equal(events().length, 2);
});

test('redonner l’article à un hôtel restreint ; retrouver tout le catalogue le ramène en « catalogue complet »', () => {
  const r = catalog.setArticleAccess(peignoir, [alpha, beta], { apply: true });
  assert.deepEqual(r.changes.map(c => [c.client, c.access, c.backToFull]), [['Beta Resort', true, true]]);
  assert.deepEqual(rowsOf(beta), [], 'Beta voit de nouveau tout, y compris les articles futurs');
  assert.equal(catalog.priceGrid(beta).hasRestriction, false);
  assert.equal(accessOf(peignoir)['Beta Resort'].restricted, false);
  // Gamma (toujours restreint) retrouve un article parmi d'autres
  const fresh = catalog.createArticle({ name: 'Nappe', code: 'N', sageCode: 'S-N', price: 2 }).id;
  assert.equal(accessOf(fresh)['Gamma Lodge'].hasAccess, false, 'un nouvel article n’est pas proposé aux hôtels en sélection');
  assert.equal(accessOf(fresh)['Hôtel Alpha'].hasAccess, true);
  const r2 = catalog.setArticleAccess(fresh, [alpha, beta, gamma], { apply: true });
  assert.deepEqual(r2.changes.map(c => [c.client, c.access, c.backToFull, c.articleCount]), [['Gamma Lodge', true, false, 3]]);
  assert.deepEqual(rowsOf(gamma), [drap, serviette, fresh].sort());
  catalog.setArticleAccess(peignoir, [alpha, beta, gamma], { apply: true });   // Gamma a maintenant les quatre : catalogue complet
  assert.deepEqual(rowsOf(gamma), []);
  catalog.deleteArticle(fresh);
});

test('un hôtel ne peut jamais se retrouver sans article', () => {
  db.prepare('DELETE FROM client_articles').run();
  catalog.setAssignment(beta, [peignoir]);                                     // Beta ne voit plus que les peignoirs
  rejects(() => catalog.setArticleAccess(peignoir, [alpha, gamma], { apply: true }), /Beta Resort.*aucun article/);
  assert.deepEqual(rowsOf(beta), [peignoir], 'refus complet : rien n’a été modifié');
  rejects(() => catalog.setArticleAccess(peignoir, [alpha, gamma], { apply: false }), /Beta Resort.*aucun article/, 'l’aperçu prévient déjà');
  // le refus d'une liste annule aussi les autres changements de la même demande
  catalog.setAssignment(gamma, [drap, peignoir]);
  const logged = events().length;
  rejects(() => catalog.setArticleAccess(peignoir, [alpha], { apply: true }), /aucun article/);
  assert.deepEqual(rowsOf(gamma), [drap, peignoir].sort());
  assert.equal(events().length, logged, 'aucun événement pour une demande refusée');
});

test('un hôtel à un seul article du catalogue entier ne peut pas le perdre', () => {
  db.prepare('DELETE FROM client_articles').run();
  db.prepare('DELETE FROM articles WHERE id IN (?, ?)').run(drap, serviette);
  rejects(() => catalog.setArticleAccess(peignoir, [], { apply: true }), /seul du catalogue/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM client_articles').get().c, 0);
});

test('entrées invalides', () => {
  const art = db.prepare('SELECT id FROM articles LIMIT 1').get().id;
  rejects(() => catalog.setArticleAccess(art, 'tous', { apply: true }), /liste des hôtels/);
  rejects(() => catalog.setArticleAccess(art, [999999], { apply: true }), /Hôtel inconnu/);
  rejects(() => catalog.setArticleAccess('inconnu', [], { apply: true }), /introuvable/);
});

test('la grille d’un hôtel indique l’usage sur 12 mois de chaque article', () => {
  const g = catalog.priceGrid(alpha);
  const peign = g.articles.find(a => a.id === peignoir);
  assert.equal(peign.pieces12m, 7); assert.equal(peign.lastOrderAt, daysAgo(20));
  assert.equal(catalog.priceGrid(gamma).articles.find(a => a.id === peignoir).pieces12m, 0);
});
