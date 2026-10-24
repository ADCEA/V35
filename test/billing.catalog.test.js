// Catalogue, fiches clients et tarifs par client : règles de prix, dates d'effet, imports, recalcul des BL.
const os = require('os'); const path = require('path'); const fs = require('fs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-catalog-'));
process.env.DATA_DIR = DATA_DIR; process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const catalog = require('../src/billing/catalog');
const services = require('../src/services');

const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof engine.BillingError && (!re || re.test(e.message)));
const price = (clientId, articleId, date) => services.resolveClientPrice(clientId, articleId, date);
const events = (action) => db.prepare('SELECT * FROM billing_events WHERE action = ? ORDER BY id').all(action).map(e => ({ ...e, d: JSON.parse(e.detail_json) }));

let alpha, beta, drap, serviette;

function addClient(societe, email) {
  return Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash) VALUES (?,?,?,?,?,'x')`).run(email, societe, 'C', '06', '1 rue du Test').lastInsertRowid);
}

test('mise en place : deux articles, deux hôtels', () => {
  db.prepare('DELETE FROM articles').run();   // la base de test contient le catalogue de démarrage : on repart de zéro
  drap = catalog.createArticle({ name: 'Drap plat 2 pers.', code: 'DP2', sageCode: 'B-DP2', category: 'lit', price: '1,35', gsm: 130, widthCm: 240, lengthCm: 300, foldedWidthCm: 40, foldedLengthCm: 30, foldedHeightCm: 4 }).id;
  serviette = catalog.createArticle({ name: 'Serviette bain', code: 'SB', sageCode: 'B-SB', category: 'toilette', price: 0.9 }).id;
  alpha = addClient('Hôtel Alpha', 'alpha@exemple.fr');
  beta = addClient('Beta Resort', 'beta@exemple.fr');
  const a = catalog.getArticle(drap);
  assert.equal(a.price, 1.35);
  assert.equal(a.weightG, Math.round(2.4 * 3 * 130), 'poids = surface à plat × densité');
  assert.equal(a.volumeL, 4.8);
  assert.equal(a.impact.onCatalogue.length, 2);
});

test('articles : validations et unicité du code Sage', () => {
  rejects(() => catalog.createArticle({ name: 'X', code: 'X', sageCode: 'b-dp2', price: 1 }), /déjà utilisé/);   // casse ignorée
  rejects(() => catalog.createArticle({ name: '', code: 'X', sageCode: 'X1', price: 1 }), /nom/);
  rejects(() => catalog.createArticle({ name: 'X', code: 'X', sageCode: 'X1', price: -2 }), /invalide/);
  rejects(() => catalog.createArticle({ name: 'X', code: 'X', sageCode: 'X1', price: 'abc' }), /invalide/);
  rejects(() => catalog.createArticle({ name: 'X', code: 'X', sageCode: 'X1', price: 1, category: 'nimporte' }), /Catégorie/);
  rejects(() => catalog.createArticle({ name: 'X', code: 'X', sageCode: 'X1' }), /manquant/);
  const second = catalog.createArticle({ name: 'Drap plat 2 pers.', code: 'DP2b', sageCode: 'B-DP2B', price: 2 });
  assert.equal(second.id, `${drap}_2`, 'identifiant unique pour un nom identique');
  catalog.deleteArticle(second.id);
});

test('prix catalogue : modification journalisée, aucun effet sur le reste', () => {
  const r = catalog.updateArticle(drap, { price: 1.4 });
  assert.equal(r.price, 1.4);
  assert.equal(r.weightG, Math.round(2.4 * 3 * 130), 'les dimensions et le poids sont conservés');
  const ev = events('article_price_changed').at(-1);
  assert.deepEqual([ev.d.from, ev.d.to, ev.d.sageCode], [1.35, 1.4, 'B-DP2']);
  catalog.updateArticle(drap, { price: 1.35 });
  assert.equal(events('article_price_changed').length, 2);
  catalog.updateArticle(drap, { name: 'Drap plat 2 pers.' });
  assert.equal(events('article_price_changed').length, 2, 'pas de journal si le prix ne bouge pas');
  assert.ok(engine.verifyIntegrity().ok, 'le journal chaîné reste valide');
});

test('tarif négocié : prend effet à sa date, jamais avant', () => {
  const r = catalog.setClientPrice(alpha, drap, '1,20', '2026-10-01');
  assert.deepEqual([r.changed, r.from, r.to], [true, 1.35, 1.2]);
  assert.equal(price(alpha, drap, '2026-09-30'), 1.35);
  assert.equal(price(alpha, drap, '2026-10-01'), 1.2);
  assert.equal(price(beta, drap, '2026-10-24'), 1.35, 'les autres hôtels ne sont pas touchés');
  assert.equal(price(alpha, serviette, '2026-10-24'), 0.9, 'les articles sans tarif restent au catalogue');
});

test('tarif négocié : un nouveau tarif clôt le précédent la veille, sans chevauchement', () => {
  catalog.setClientPrice(alpha, drap, 1.1, '2026-11-01');
  const rows = db.prepare('SELECT price, date_debut, date_fin FROM client_prices WHERE client_id=? AND article_id=? ORDER BY date_debut').all(alpha, drap);
  assert.deepEqual(rows.map(r => [r.price, r.date_debut, r.date_fin]), [[1.2, '2026-10-01', '2026-10-31'], [1.1, '2026-11-01', null]]);
  assert.equal(price(alpha, drap, '2026-10-31'), 1.2);
  assert.equal(price(alpha, drap, '2026-11-01'), 1.1);
  const g = catalog.priceGrid(alpha).articles.find(a => a.id === drap);
  assert.equal(g.catalogPrice, 1.35);
  assert.ok(g.negotiatedPrice === 1.2 || g.upcoming, 'selon la date du jour : en cours ou à venir');
});

test('tarif négocié : une date antérieure remplace ce qui commençait après', () => {
  const r = catalog.setClientPrice(alpha, drap, 1.15, '2026-10-15');
  assert.equal(r.superseded.length, 1, 'le tarif du 1er novembre est remplacé');
  const rows = db.prepare('SELECT price, date_debut, date_fin FROM client_prices WHERE client_id=? AND article_id=? ORDER BY date_debut').all(alpha, drap);
  assert.deepEqual(rows.map(r => [r.price, r.date_debut, r.date_fin]), [[1.2, '2026-10-01', '2026-10-14'], [1.15, '2026-10-15', null]]);
  assert.equal(price(alpha, drap, '2026-12-01'), 1.15);
  assert.ok(events('client_price_set').at(-1).d.replaced.length === 1, 'le remplacement est tracé');
});

test('tarif négocié : même prix = aucune écriture ; retrait = retour au catalogue', () => {
  const n = events('client_price_set').length;
  assert.equal(catalog.setClientPrice(alpha, drap, 1.15, '2026-11-20').changed, false);
  assert.equal(events('client_price_set').length, n);
  const r = catalog.removeClientPrice(alpha, drap, '2026-12-01');
  assert.equal(r.changed, true);
  assert.equal(price(alpha, drap, '2026-11-30'), 1.15);
  assert.equal(price(alpha, drap, '2026-12-01'), 1.35, 'catalogue à partir du retrait');
  assert.equal(catalog.removeClientPrice(alpha, serviette).changed, false);
});

test('tarif négocié : validations', () => {
  rejects(() => catalog.setClientPrice(alpha, drap, '', '2026-10-01'), /manquant/);
  rejects(() => catalog.setClientPrice(alpha, drap, -1, '2026-10-01'), /invalide/);
  rejects(() => catalog.setClientPrice(alpha, drap, 1, '01/10/2026'), /Date/);
  rejects(() => catalog.setClientPrice(alpha, 'inconnu', 1, '2026-10-01'), /Article introuvable/);
  rejects(() => catalog.setClientPrice(99999, drap, 1, '2026-10-01'), /Hôtel introuvable/);
});

test('opérations groupées : +x %, copie, retour au catalogue — aperçu identique au résultat', () => {
  db.prepare('DELETE FROM client_prices').run();
  const preview = catalog.bulkPrices(beta, { mode: 'percent', percent: -10, from: '2026-10-01' }, { apply: false });
  assert.equal(preview.applied, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM client_prices').get().c, 0, "l'aperçu n'écrit rien");
  assert.equal(events('client_prices_bulk').length, 0, "l'aperçu ne journalise rien");
  const done = catalog.bulkPrices(beta, { mode: 'percent', percent: -10, from: '2026-10-01' }, { apply: true });
  assert.deepEqual(done.changes.map(c => [c.sageCode, c.from, c.to]), preview.changes.map(c => [c.sageCode, c.from, c.to]));
  assert.equal(price(beta, drap, '2026-10-24'), 1.215);
  assert.equal(price(beta, serviette, '2026-10-24'), 0.81);

  // copie vers un autre hôtel
  const copy = catalog.bulkPrices(alpha, { mode: 'copy', sourceClientId: beta, from: '2026-10-01' }, { apply: true });
  assert.equal(copy.count, 2);
  assert.equal(price(alpha, drap, '2026-10-24'), 1.215);
  rejects(() => catalog.bulkPrices(alpha, { mode: 'copy', sourceClientId: alpha }, { apply: true }), /autre hôtel/);
  rejects(() => catalog.bulkPrices(alpha, { mode: 'percent', percent: 0 }, { apply: true }), /Pourcentage/);
  rejects(() => catalog.bulkPrices(alpha, { mode: 'percent', percent: 900 }, { apply: true }), /Pourcentage/);

  // seulement certains articles, sur la base du catalogue
  catalog.bulkPrices(alpha, { mode: 'percent', percent: 10, base: 'catalogue', articleIds: [serviette], from: '2026-10-01' }, { apply: true });
  assert.equal(price(alpha, serviette, '2026-10-24'), 0.99);
  assert.equal(price(alpha, drap, '2026-10-24'), 1.215, 'les autres articles ne bougent pas');

  const reset = catalog.bulkPrices(alpha, { mode: 'reset', from: '2026-11-01' }, { apply: true });
  assert.equal(reset.count, 2);
  assert.equal(price(alpha, drap, '2026-10-31'), 1.215);
  assert.equal(price(alpha, drap, '2026-11-01'), 1.35);
  assert.ok(engine.verifyIntegrity().ok);
});

test("catalogue accessible : restriction par hôtel et effet sur les prix proposés", () => {
  catalog.setAssignment(beta, [drap]);
  assert.deepEqual(services.getServicesForClient(beta).map(s => s.id), [drap]);
  assert.equal(services.getServicesForClient(beta).find(s => s.id === drap).price, 1.215, 'les tarifs négociés sont appliqués à la liste proposée');
  assert.equal(services.getServicesForClient(alpha).length, 2);
  // le calcul de linge ne doit pas perdre d'article à cause de la restriction
  const priced = services.getServicesByIdPricedForClient(beta, '2026-10-24');
  assert.equal(priced[serviette].price, 0.81);
  rejects(() => catalog.setAssignment(beta, ['fantome']), /inconnu/);
  assert.equal(catalog.setAssignment(beta, []).hasRestriction, false);
});

test('import des tarifs : aperçu exact, lignes en erreur isolées', () => {
  const csv = [
    'client;code_sage;prix;date_debut',
    'hôtel alpha;b-dp2;1,05;2026-10-01',         // casse et accents ignorés
    'Beta Resort;B-SB;0,70;2026-10-01',
    'Inconnu SARL;B-SB;0,70;2026-10-01',
    'Beta Resort;B-ZZZ;0,70;2026-10-01',
    'Beta Resort;B-SB;abc;2026-10-01',
  ].join('\n');
  const before = db.prepare('SELECT COUNT(*) c FROM client_prices').get().c;
  const preview = catalog.importPrices(csv, { apply: false });
  assert.deepEqual(preview.summary, { total: 5, changed: 2, same: 0, errors: 3 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM client_prices').get().c, before, "l'aperçu n'écrit rien");
  assert.match(preview.lines[2].error, /Hôtel inconnu/);
  assert.match(preview.lines[3].error, /Article inconnu/);
  const done = catalog.importPrices(csv, { apply: true });
  assert.equal(done.summary.changed, 2);
  assert.equal(price(alpha, drap, '2026-10-24'), 1.05);
  assert.equal(price(beta, serviette, '2026-10-24'), 0.7);
  assert.equal(catalog.importPrices(csv, { apply: true }).summary.same, 2, 'réimporter le même fichier ne change rien');

  // sans colonne client : l'hôtel est choisi à l'import
  rejects(() => catalog.importPrices('code_sage;prix\nB-SB;1', {}), /colonne « client »|hôtel concerné/);
  assert.equal(catalog.importPrices('code_sage,prix\nB-SB,0.5', { clientId: alpha, defaultDate: '2026-10-01', apply: true }).summary.changed, 1);
  assert.equal(price(alpha, serviette, '2026-10-24'), 0.5);
});

test('grille articles × hôtels et export CSV', () => {
  const m = catalog.priceMatrix();
  assert.equal(m.articles.length, 2);
  assert.equal(m.clients.length, 2);
  assert.equal(m.cells[alpha][drap].price, 1.05);
  const csv = catalog.matrixCsv();
  assert.ok(csv.startsWith('﻿code_sage;article;catalogue;'));
  assert.match(csv, /B-DP2;Drap plat 2 pers\.;1,35;1,215;1,05\r\n/);   // colonnes : Beta Resort, Hôtel Alpha
});

test('recalcul des BL non facturés : seulement ceux qui ne sont pas facturés, au tarif de leur date', () => {
  db.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', iban='FR7630001007941234567890185', bic='BDFEFRPP', email='compta@exemple.fr', phone='04 90 00 00 00' WHERE id=1`).run();
  db.prepare(`UPDATE clients SET siret='55210055400013' WHERE id=?`).run(alpha);
  const mkOrder = (client, ticket, date, status, qty = 10) => {
    const id = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,?)`).run(ticket, client, 'H', 'C', '06', 'adr', date, status).lastInsertRowid);
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(id, drap, 'Drap plat 2 pers.', 'DP2', 'B-DP2', 1.35, qty, qty);
    return id;
  };
  db.prepare('DELETE FROM client_prices').run();
  catalog.setClientPrice(alpha, drap, 1.1, '2026-10-10');
  const before = mkOrder(alpha, 'T-AVANT', '2026-10-05', 'livree');        // avant la date d'effet
  const open = mkOrder(alpha, 'T-OUVERT', '2026-10-12', 'traitement');     // pas encore livré : concerné aussi
  const delivered = mkOrder(alpha, 'T-LIVRE', '2026-10-15', 'livree');
  const billed = mkOrder(alpha, 'T-FACTURE', '2026-10-16', 'livree');
  const inDraft = mkOrder(alpha, 'T-BROUILLON', '2026-10-17', 'livree');
  const other = mkOrder(beta, 'T-AUTRE', '2026-10-15', 'livree');
  engine.issueInvoice(engine.createDraftFromOrders(alpha, [billed]).id, { issueDate: '2026-10-20' });
  engine.createDraftFromOrders(alpha, [inDraft]);

  const preview = catalog.repriceUnbilled(alpha, { from: '2026-10-10' }, { apply: false });
  assert.deepEqual(preview.orders.map(o => o.ticket), ['T-OUVERT', 'T-LIVRE']);
  assert.equal(preview.skippedInDraft, 1, 'le BL déjà dans un brouillon est signalé, pas modifié');
  assert.equal(preview.deltaCents, -2 * 10 * 25, '2 BL × 10 pièces × -0,25 €');
  const frozen = (id) => db.prepare('SELECT price FROM order_items WHERE order_id=?').get(id).price;
  assert.equal(frozen(delivered), 1.35, "l'aperçu ne modifie rien");

  const done = catalog.repriceUnbilled(alpha, { from: '2026-10-10' }, { apply: true });
  assert.equal(done.applied, true);
  assert.equal(frozen(delivered), 1.1);
  assert.equal(frozen(open), 1.1);
  for (const [id, label] of [[before, 'avant la date'], [billed, 'facturé'], [inDraft, 'dans un brouillon'], [other, "d'un autre hôtel"]]) {
    assert.equal(frozen(id), 1.35, `BL ${label} : prix inchangé`);
  }
  assert.equal(catalog.repriceUnbilled(alpha, { from: '2026-10-10' }, { apply: false }).orders.length, 0, 'idempotent');
  assert.equal(events('orders_repriced').length, 1);
  rejects(() => catalog.repriceUnbilled(alpha, {}, {}), /date/i);
});

test('journal des prix : filtrable par hôtel et par article', () => {
  const all = catalog.priceLog({}).events;
  assert.ok(all.length > 5);
  assert.ok(catalog.priceLog({ clientId: beta }).events.every(e => e.detail.clientId === beta));
  const forDrap = catalog.priceLog({ articleId: drap }).events;
  assert.ok(forDrap.some(e => e.action === 'client_price_set'));
  assert.ok(!forDrap.some(e => e.action === 'article_created' && e.detail.articleId === serviette));
});

test('import du catalogue : simulation exacte, mises à jour de prix signalées', () => {
  const csv = [
    'nom,code,code_sage,prix,categorie,densite_gsm,largeur_cm,longueur_cm,largeur_pliee_cm,longueur_pliee_cm,epaisseur_pliee_cm',
    'Drap plat 2 pers.,DP2,B-DP2,1.50,lit,,,,,,',             // existant : nouveau prix, dimensions conservées
    'Taie oreiller,TO,B-TO,0.45,lit,120,65,65,20,20,3',
    'Taie oreiller,TO,b-to,0.45,lit,,,,,,',                  // doublon du fichier
    'Peignoir,PG,B-PG,abc,lit,,,,,,',
    'Serviette bain,SB2,B-SB2,0.9,toilette,,,,,,',           // même nom, autre code Sage
  ].join('\n');
  const n = db.prepare('SELECT COUNT(*) c FROM articles').get().c;
  const preview = catalog.importArticles(csv, { apply: false });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM articles').get().c, n, "la simulation n'écrit rien");
  assert.equal(preview.summary.created, 2);
  assert.equal(preview.summary.updated, 1);
  assert.equal(preview.summary.duplicates, 1);
  assert.equal(preview.summary.errors, 1);
  assert.equal(preview.possibleDuplicates.length, 1);
  assert.deepEqual([preview.updated[0].priceFrom, preview.updated[0].priceTo], [1.35, 1.5]);

  catalog.importArticles(csv, { apply: true });
  const a = catalog.getArticle(drap);
  assert.equal(a.price, 1.5);
  assert.equal(a.gsm, 130, 'la densité existante est conservée quand la colonne est vide');
  assert.equal(a.weightG, Math.round(2.4 * 3 * 130));
  assert.equal(events('article_price_changed').at(-1).d.via, 'import');
  assert.ok(engine.verifyIntegrity().ok);
});

test("suppression d'article : bloquée si une règle de chambre l'utilise", () => {
  db.prepare(`INSERT INTO room_types (client_id, name, departure_items) VALUES (?,?,?)`).run(alpha, 'Double', JSON.stringify([{ serviceId: serviette, qty: 2 }]));
  rejects(() => catalog.deleteArticle(serviette), /règles de linge/);
  db.prepare('DELETE FROM room_types').run();
  catalog.setClientPrice(alpha, serviette, 0.6, '2026-10-01');
  const r = catalog.deleteArticle(serviette);
  assert.equal(r.clientPricesRemoved, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM client_prices WHERE article_id=?').get(serviette).c, 0);
});

test('fiches clients : validations, modifications journalisées, suppression protégée', () => {
  const c = catalog.createClient({ societe: 'Gîte du Test', email: 'Gite@Exemple.fr', siret: '552 100 554 00013', code: '123456' }).client;
  assert.equal(c.email, 'gite@exemple.fr');
  assert.equal(c.siret, '55210055400013');
  assert.equal(c.invoiceDetailLevel, 'detail');
  rejects(() => catalog.createClient({ societe: 'Autre', email: 'gite@exemple.fr' }), /déjà utilisé/);
  rejects(() => catalog.createClient({ societe: '' }), /nom/);
  rejects(() => catalog.createClient({ societe: 'Z', email: 'pas-un-mail' }), /email/i);
  rejects(() => catalog.createClient({ societe: 'Z', code: '12' }), /code d'accès/);
  rejects(() => catalog.updateClient(c.id, { siret: '123' }), /14 chiffres/);
  rejects(() => catalog.updateClient(c.id, { invoiceDetailLevel: 'bizarre' }), /Niveau/);
  rejects(() => catalog.updateClient(c.id, { email: 'alpha@exemple.fr' }), /déjà utilisé/);

  const u = catalog.updateClient(c.id, { societe: 'Gîte du Test SARL', adresseFacturation: 'Siège, 84000 Avignon', invoiceDetailLevel: 'per_bl' }).client;
  assert.equal(u.invoiceDetailLevel, 'per_bl');
  assert.equal(u.siret, '55210055400013', 'les champs non transmis sont conservés');
  assert.deepEqual(events('client_updated').at(-1).d.fields.sort(), ['adresse de facturation', 'détail des factures', 'nom'].sort());
  assert.equal(u.issues.length, 0, 'SIRET valide + adresse : rien à signaler');
  assert.ok(catalog.listClients().clients.find(x => x.id === beta).issues.includes('SIREN/SIRET manquant'));

  // le code d'accès est stocké chiffré
  catalog.setAccessCode(c.id, '654321');
  const hash = db.prepare('SELECT code_hash FROM clients WHERE id=?').get(c.id).code_hash;
  assert.ok(hash.startsWith('$2') && !hash.includes('654321'));
  rejects(() => catalog.setAccessCode(c.id, 'abc'), /code d'accès/);
  assert.ok(!JSON.stringify(events('client_access_code_reset')).includes('654321'), "le code n'est jamais journalisé");

  // jetons et webhook
  const t = catalog.createToken(c.id, 'Logiciel de commande');
  assert.equal(catalog.getClient(c.id).tokens.length, 1);
  catalog.revokeToken(c.id, t.id);
  assert.equal(catalog.getClient(c.id).tokens.length, 0);
  const w = catalog.setWebhook(c.id, { webhookUrl: 'https://exemple.fr/hook' });
  assert.ok(w.webhookSecret.length >= 20);
  assert.equal(catalog.setWebhook(c.id, { webhookUrl: 'https://exemple.fr/hook' }).webhookSecret, w.webhookSecret, 'le secret ne change pas sans demande');
  assert.notEqual(catalog.setWebhook(c.id, { webhookUrl: 'https://exemple.fr/hook', regenerateSecret: true }).webhookSecret, w.webhookSecret);
  rejects(() => catalog.setWebhook(c.id, { webhookUrl: 'ftp://exemple.fr' }), /URL/);

  // un hôtel qui a des documents de facturation ne peut pas être supprimé
  engine.createDraftFromLines(c.id, [{ description: 'Prestation', quantity: 1, unitPrice: 10, vatRate: 20 }]);
  rejects(() => catalog.deleteClient(c.id), /conservés/);
  const free = catalog.createClient({ societe: 'À supprimer' }).client;
  assert.equal(catalog.deleteClient(free.id).ok, true);
  rejects(() => catalog.getClient(free.id), /introuvable/);
});

test('import des hôtels : simulation sans codes, application avec codes', () => {
  const csv = ['societe,contact,tel,adresse,email,code', 'Hôtel Neuf,Léa,0600,1 rue A,neuf@exemple.fr,', 'Hôtel Alpha,Luc,0601,2 rue B,alpha@exemple.fr,', 'Sans mail,X,0,adr,pas-un-mail,'].join('\n');
  const preview = catalog.importClients(csv, { apply: false });
  assert.deepEqual([preview.summary.created, preview.summary.updated, preview.summary.errors], [1, 1, 1]);
  assert.equal(preview.created[0].code, undefined, 'pas de code affiché en simulation');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM clients WHERE email='neuf@exemple.fr'").get().c, 0);
  const done = catalog.importClients(csv, { apply: true });
  assert.match(done.created[0].code, /^\d{6}$/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM clients WHERE email='neuf@exemple.fr'").get().c, 1);
});
