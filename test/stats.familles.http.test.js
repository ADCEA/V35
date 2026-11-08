// Statistiques : répartition du linge livré par famille (grand plat, petit plat, éponge, divers), au total et mois par mois.
// Famille choisie dans la fiche article, ou proposée d'après le nom ; serveur réel, verrou de la Facturation pour le catalogue.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');
const { inferFamily } = require('../src/utils/linenFamilies');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; const call = (...a) => s.call(...a);
const art = {};   // nom → id

// Ressaisie du code de la Facturation pour un acte sensible, puis l'acte lui-même.
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, `confirmation ${scope} : ${JSON.stringify(c.data)}`);
  return call(method, url, body);
}

before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
});
after(() => s.stop());

test('proposition d\'après le nom : l\'éponge passe avant le grand plat, le reste est en divers', () => {
  const cases = [
    ['Drap plat 2 pers.', 'lit', 'grand_plat'], ['Housse de couette 1 pers.', 'lit', 'grand_plat'], ['Nappe 140 x 140', 'service', 'grand_plat'], ['Alèse', 'lit', 'grand_plat'],
    ['Taie', 'lit', 'petit_plat'], ['Serviette de table', 'service', 'petit_plat'], ['Torchon', 'service', 'petit_plat'],
    ['Drap de bain', 'toilette', 'eponge'], ['Grand drap de bain (SPA)', 'toilette', 'eponge'], ['Serviette de toilette', 'toilette', 'eponge'], ['Tapis de bain', 'toilette', 'eponge'], ['Peignoir', 'toilette', 'eponge'],
    ['Couverture', 'lit', 'divers'], ['Tablier', 'service', 'divers'], ['Tenue de travail', 'service', 'divers'],
    ['Article inconnu de la catégorie toilette', 'toilette', 'eponge'],
  ];
  for (const [name, cat, want] of cases) assert.equal(inferFamily(name, cat), want, name);
});

test('fiche article : famille choisie ou automatique, refus d\'une valeur inconnue, rien ne change si on ne la touche pas', async () => {
  const make = async (name, code, extra = {}) => {
    const r = await call('POST', `${B}/catalog/articles`, { name, code, sageCode: 'S-' + code, price: '1,00', category: 'lit', gsm: 100, widthCm: 100, lengthCm: 100, foldedWidthCm: 10, foldedLengthCm: 10, foldedHeightCm: 1, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    art[name] = r.data.article.id; return r.data.article;
  };
  const drap = await make('Drap plat', 'DP');
  assert.equal(drap.linenFamily, null, 'automatique par défaut');
  assert.equal(drap.linenFamilyAuto, 'grand_plat');
  await make('Taie', 'TA');
  await make('Drap de bain', 'DB', { category: 'toilette' });
  await make('Couverture', 'CV');
  await make('Plaid décoratif', 'PL', { linenFamily: 'petit_plat' });
  assert.equal((await call('GET', `${B}/catalog/articles/${art['Plaid décoratif']}`)).data.article.linenFamily, 'petit_plat', 'famille fixée à la création');

  const bad = await call('PUT', `${B}/catalog/articles/${art['Drap plat']}`, { linenFamily: 'serviettes' });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /Famille de linge invalide/);

  // Modifier autre chose ne touche pas à la famille fixée
  const kept = await call('PUT', `${B}/catalog/articles/${art['Plaid décoratif']}`, { price: '2,00' });
  assert.equal(kept.data.article.linenFamily, 'petit_plat');
  // Fixer puis revenir à « automatique »
  const fixed = await call('PUT', `${B}/catalog/articles/${art['Couverture']}`, { linenFamily: 'grand_plat' });
  assert.equal(fixed.data.article.linenFamily, 'grand_plat');
  const auto = await call('PUT', `${B}/catalog/articles/${art['Couverture']}`, { linenFamily: '' });
  assert.equal(auto.data.article.linenFamily, null);
  assert.equal(auto.data.article.linenFamilyAuto, 'divers');

  const list = (await call('GET', `${B}/catalog/articles`)).data;
  assert.deepEqual(list.families.map(f => f.id), ['grand_plat', 'petit_plat', 'eponge', 'divers']);
  assert.ok(list.articles.every(a => 'linenFamily' in a && a.linenFamilyAuto));
  assert.equal(list.articles.find(a => a.id === art['Taie']).linenFamilyAuto, 'petit_plat');
});

test('import CSV : un nouvel article est en automatique, une mise à jour ne défait pas la famille choisie', async () => {
  const fix = await call('PUT', `${B}/catalog/articles/${art['Taie']}`, { linenFamily: 'divers' });
  assert.equal(fix.status, 200); assert.equal(fix.data.article.linenFamily, 'divers');
  const csv = ['nom,code,code_sage,prix,categorie', 'Taie,TA,S-TA,0.60,lit', 'Serviette de table coton,SDT,S-SDT,0.55,service'].join('\n');
  const r = await sensitive('articles-import', 'POST', `${B}/catalog/articles/import`, { csv, apply: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const list = (await call('GET', `${B}/catalog/articles`)).data.articles;
  assert.equal(list.find(a => a.id === art['Taie']).linenFamily, 'divers', 'famille choisie conservée par la mise à jour');
  const created = list.find(a => a.sageCode === 'S-SDT');
  assert.equal(created.linenFamily, null); assert.equal(created.linenFamilyAuto, 'petit_plat');
  // on la remet comme avant pour les tests suivants
  assert.equal((await call('PUT', `${B}/catalog/articles/${art['Taie']}`, { linenFamily: '' })).data.article.linenFamily, null);
});

test('répartition : livré seulement, quantité livrée prioritaire, reprises exclues, mois par mois, Divers à vérifier', async () => {
  const db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  db.prepare("UPDATE articles SET weight_g = ? WHERE id = ?").run(400, art['Drap plat']);
  db.prepare("UPDATE articles SET weight_g = ? WHERE id = ?").run(100, art['Taie']);
  db.prepare("UPDATE articles SET weight_g = ? WHERE id = ?").run(500, art['Drap de bain']);
  db.prepare("UPDATE articles SET weight_g = ? WHERE id = ?").run(1500, art['Couverture']);
  db.prepare("UPDATE articles SET weight_g = ? WHERE id = ?").run(0, art['Plaid décoratif']);
  const order = (ticket, date, status, lines) => {
    const id = Number(db.prepare(`INSERT INTO orders (ticket, societe, contact, tel, adresse, livraison_prevue, status, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(ticket, 'Hôtel', 'C', '06', 'adr', date, status, date + 'T08:00:00.000Z').lastInsertRowid);
    for (const [svc, name, qty, delivered] of lines) db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(id, svc, name, name, name, 1, qty, delivered);
  };
  // octobre
  order('T1', '2026-10-05', 'livree', [[art['Drap plat'], 'Drap plat', 10, 8], [art['Taie'], 'Taie', 20, null], [art['Drap de bain'], 'Drap de bain', 6, 6]]);
  order('T2', '2026-10-20', 'livree', [[art['Couverture'], 'Couverture', 2, 2], [art['Drap plat'], 'Drap plat', -3, null]]);   // reprise : ignorée
  order('T3', '2026-10-21', 'recue', [[art['Drap plat'], 'Drap plat', 50, null]]);                                               // pas livrée : ignorée
  // novembre
  order('T4', '2026-11-03', 'livree', [[art['Drap plat'], 'Drap plat', 5, null], [art['Plaid décoratif'], 'Plaid décoratif', 4, null], ['inconnu', 'Torchon cuisine', 7, null]]);
  // Hors période
  order('T5', '2026-09-30', 'livree', [[art['Drap plat'], 'Drap plat', 99, null]]);
  db.close();

  const all = await call('GET', '/api/admin/stats/families?from=2026-10-01&to=2026-11-08');
  assert.equal(all.status, 200, JSON.stringify(all.data));
  const d = all.data;
  const f = Object.fromEntries(d.families.map(x => [x.id, x]));
  assert.equal(f.grand_plat.pieces, 8 + 5, 'quantité livrée (8) et non commandée (10) ; reprise, commande non livrée et hors période exclues');
  assert.equal(f.grand_plat.weightKg, 5.2);
  assert.equal(f.petit_plat.pieces, 20 + 4 + 7, 'taie, plaid fixé en petit plat, torchon sans fiche article (famille d\'après le nom de la ligne)');
  assert.equal(f.petit_plat.weightKg, 2, 'le plaid sans poids ne pèse rien : 20 taies × 100 g');
  assert.equal(f.eponge.pieces, 6); assert.equal(f.eponge.weightKg, 3);
  assert.equal(f.divers.pieces, 2); assert.equal(f.divers.weightKg, 3);
  assert.equal(d.totalPieces, 13 + 31 + 6 + 2);
  assert.equal(d.totalWeightKg, 5.2 + 2 + 3 + 3);
  assert.equal(f.eponge.weightPct, Math.round(3 / 13.2 * 1000) / 10);
  assert.equal(Math.round(d.families.reduce((a, x) => a + x.piecesPct, 0)), 100);
  assert.equal(d.piecesNoWeight, 4 + 7, 'plaid et torchon sans poids : comptés en pièces, pas en poids');
  assert.deepEqual(d.diversArticles.map(a => [a.name, a.pieces]), [['Couverture', 2]], 'à vérifier : ce qui est rangé en Divers');
  assert.ok(d.inferredArticles >= 4, 'drap plat, taie, drap de bain, couverture et torchon n\'ont pas de famille choisie');

  assert.deepEqual(d.months.map(m => m.month), ['2026-10', '2026-11']);
  const oct = Object.fromEntries(d.months[0].families.map(x => [x.id, x]));
  assert.equal(oct.grand_plat.pieces, 8); assert.equal(oct.petit_plat.pieces, 20);
  const nov = Object.fromEntries(d.months[1].families.map(x => [x.id, x]));
  assert.equal(nov.grand_plat.pieces, 5); assert.equal(nov.petit_plat.pieces, 11); assert.equal(nov.divers.pieces, 0);
  assert.equal(d.months[0].totalPieces + d.months[1].totalPieces, d.totalPieces);

  // un seul mois : une seule ligne de mois ; période vide : tout à zéro
  const oneMonth = (await call('GET', '/api/admin/stats/families?from=2026-11-01&to=2026-11-30')).data;
  assert.equal(oneMonth.months.length, 1); assert.equal(oneMonth.totalPieces, 5 + 4 + 7);
  const none = (await call('GET', '/api/admin/stats/families?from=2026-01-01&to=2026-01-31')).data;
  assert.equal(none.totalPieces, 0); assert.deepEqual(none.months, []);
  assert.ok(none.families.every(x => x.weightPct === 0 && x.piecesPct === 0));
});

test('prix moyen au kilo par famille : articles pesés seulement, mêmes lignes que la répartition, derrière le verrou de la Facturation', async () => {
  const Q = '?from=2026-10-01&to=2026-11-08';
  // verrouillée : refusé, et la répartition (sans montants) ne contient aucun montant
  await call('POST', `${B}/lock/lock`);
  assert.equal((await call('GET', `${B}/stats/families${Q}`)).status, 423);
  const open = await call('GET', `/api/admin/stats/families${Q}`);
  assert.equal(open.status, 200); assert.ok(!JSON.stringify(open.data).includes('Cents'), 'aucun montant hors verrou');
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);

  // Mêmes commandes que ci-dessus, tous les prix figés à 1,00 € : grand plat 8+5 draps, petit plat 20 taies (+ plaid et torchon sans poids),
  // éponge 6 draps de bain, divers 2 couvertures. Les reprises (-3 draps) et la commande non livrée ne comptent pas.
  const r = await call('GET', `${B}/stats/families${Q}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = Object.fromEntries(r.data.families.map(x => [x.id, x]));
  assert.deepEqual(f.grand_plat, { id: 'grand_plat', htCents: 1300, unweightedHtCents: 0, kg: 5.2, centsPerKg: 250 }, '13,00 € ÷ 5,2 kg = 2,50 €/kg');
  assert.deepEqual(f.petit_plat, { id: 'petit_plat', htCents: 2000, unweightedHtCents: 1100, kg: 2, centsPerKg: 1000 }, 'plaid (4,00 €) et torchon (7,00 €) sans poids : exclus du prix, signalés à part');
  assert.equal(f.eponge.centsPerKg, 200); assert.equal(f.eponge.kg, 3);
  assert.equal(f.divers.centsPerKg, 67, '2,00 € ÷ 3 kg');
  assert.deepEqual(r.data.total, { htCents: 4100, unweightedHtCents: 1100, kg: 13.2, centsPerKg: 311 });

  // cohérence avec la répartition : même poids, famille par famille
  const rep = (await call('GET', `/api/admin/stats/families${Q}`)).data;
  for (const x of rep.families) assert.equal(f[x.id].kg, x.weightKg, `${x.id} : même poids que la répartition`);
  assert.equal(r.data.total.kg, rep.totalWeightKg);

  // mois par mois
  assert.deepEqual(r.data.months.map(m => m.month), ['2026-10', '2026-11']);
  const oct = Object.fromEntries(r.data.months[0].families.map(x => [x.id, x]));
  assert.equal(oct.grand_plat.centsPerKg, 250); assert.equal(oct.petit_plat.centsPerKg, 1000);
  const nov = Object.fromEntries(r.data.months[1].families.map(x => [x.id, x]));
  assert.equal(nov.grand_plat.htCents, 500); assert.equal(nov.grand_plat.kg, 2); assert.equal(nov.grand_plat.centsPerKg, 250);
  assert.equal(nov.eponge.centsPerKg, null, 'rien de pesé livré en novembre dans cette famille : pas de prix');
  assert.equal(nov.petit_plat.centsPerKg, null); assert.equal(nov.petit_plat.unweightedHtCents, 1100);

  // période vide ; dates contrôlées
  const none = (await call('GET', `${B}/stats/families?from=2026-01-01&to=2026-01-31`)).data;
  assert.equal(none.total.centsPerKg, null); assert.deepEqual(none.months, []);
  assert.equal((await call('GET', `${B}/stats/families?from=2026-11-30&to=2026-11-01`)).status, 400);
});

test('route : réservée à l\'administrateur, dates contrôlées', async () => {
  const anon = await fetch(s.BASE + '/api/admin/stats/families');
  assert.equal(anon.status, 401);
  assert.equal((await call('GET', '/api/admin/stats/families?from=2026-11-30&to=2026-11-01')).status, 400);
  assert.equal((await call('GET', '/api/admin/stats/families?from=2024-01-01&to=2026-11-01')).status, 400, 'au plus 400 jours');
  assert.equal((await call('GET', '/api/admin/stats/families')).status, 200, '30 derniers jours par défaut');
});
