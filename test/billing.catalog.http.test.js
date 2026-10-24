// Catalogue et tarifs de bout en bout : vrai serveur, verrou de la Facturation, anciennes routes retirées,
// et tarif négocié effectivement appliqué quand une commande est créée.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s;
const call = (...a) => s.call(...a);

// Ressaisie du code pour un acte sensible, puis l'acte lui-même.
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, `confirmation ${scope} : ${JSON.stringify(c.data)}`);
  return call(method, url, body);
}

test.before(async () => { s = await startServer(); });
test.after(async () => { if (s) await s.stop(); });

test('rien n’est accessible sans session admin, puis sans déverrouiller la Facturation', async () => {
  assert.equal((await call('GET', `${B}/catalog/articles`)).status, 401);
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  assert.equal((await call('POST', `${B}/lock/lock`)).status, 200);
  for (const [m, u] of [['GET', '/catalog/articles'], ['GET', '/catalog/clients'], ['GET', '/catalog/prices/matrix'], ['GET', '/catalog/prices/export.csv'], ['POST', '/catalog/clients/1/prices/bulk']]) {
    const r = await call(m, B + u, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 423, `${m} ${u} doit être verrouillé`);
  }
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
});

test('les anciennes routes non protégées ont disparu, la liste des hôtels est réduite à l’exploitation', async () => {
  for (const [m, u] of [['GET', '/api/admin/articles'], ['POST', '/api/admin/articles'], ['PUT', '/api/admin/articles/x'], ['POST', '/api/admin/articles/import'],
    ['GET', '/api/admin/articles/client/1'], ['GET', '/api/admin/clients/1/prices'], ['PUT', '/api/admin/clients/1/prices/x'], ['PUT', '/api/admin/clients/1'],
    ['DELETE', '/api/admin/clients/1'], ['GET', '/api/admin/clients/1/api-tokens'], ['GET', '/api/admin/clients/1/webhook'], ['POST', '/api/admin/clients/import']]) {
    const r = await call(m, u, m === 'GET' || m === 'DELETE' ? undefined : {});
    assert.equal(r.status, 404, `${m} ${u} ne doit plus exister (reçu ${r.status})`);
  }
  // la logistique reste là où elle était
  assert.equal((await call('GET', '/api/admin/articles/logistics-settings')).status, 200);
  assert.equal((await call('GET', '/api/admin/articles/cart-types')).status, 200);
  // création rapide d'un hôtel depuis « Nouvelle commande »
  const c = await call('POST', '/api/admin/clients', { societe: 'Hôtel Express' });
  assert.equal(c.status, 201);
  const list = (await call('GET', '/api/admin/clients')).data.clients;
  assert.ok(list.length >= 1);
  for (const k of ['siret', 'tvaNumber', 'adresseFacturation', 'invoiceDetailLevel']) assert.ok(!(k in list[0]), `${k} ne doit pas fuiter hors de la Facturation`);
});

let hotel, drap, serviette;

test('catalogue et fiche client via HTTP', async () => {
  let r = await call('POST', `${B}/catalog/articles`, { name: 'Drap test', code: 'DT', sageCode: 'T-DT', category: 'lit', price: '2,00' });
  assert.equal(r.status, 201); drap = r.data.article.id;
  r = await call('POST', `${B}/catalog/articles`, { name: 'Serviette test', code: 'ST', sageCode: 'T-ST', category: 'toilette', price: 1 });
  serviette = r.data.article.id;
  assert.equal((await call('POST', `${B}/catalog/articles`, { name: 'Autre', code: 'A', sageCode: 't-dt', price: 1 })).status, 409, 'code Sage déjà pris');
  assert.equal((await call('PUT', `${B}/catalog/articles/${drap}`, { price: '2,10' })).data.article.price, 2.1);
  assert.equal((await call('GET', `${B}/catalog/articles/inconnu`)).status, 404);

  r = await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Tarifé', email: 'tarife@exemple.fr', siret: '55210055400013' });
  assert.equal(r.status, 201); hotel = r.data.client.id;
  assert.equal((await call('PUT', `${B}/catalog/clients/${hotel}`, { siret: '12' })).status, 400);
  assert.equal((await call('PUT', `${B}/catalog/clients/${hotel}`, { invoiceDetailLevel: 'per_bl' })).data.client.invoiceDetailLevel, 'per_bl');
  const list = (await call('GET', `${B}/catalog/clients`)).data;
  assert.ok(list.clients.some(c => c.id === hotel && c.negotiatedCount === 0));
});

test('un tarif négocié est appliqué aux commandes de l’hôtel (et seulement à lui)', async () => {
  let r = await call('PUT', `${B}/catalog/clients/${hotel}/prices/${drap}`, { price: '1,50', dateDebut: '2026-01-01' });
  assert.equal(r.status, 200);
  assert.equal((await call('PUT', `${B}/catalog/clients/${hotel}/prices/${drap}`, { price: 'x' })).status, 400);

  r = await call('POST', '/api/admin/orders/manual', { clientId: hotel, items: [{ serviceId: drap, qty: 4 }, { serviceId: serviette, qty: 2 }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const priceOf = (ticket, id) => db.prepare('SELECT oi.price FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.ticket=? AND oi.service_id=?').get(ticket, id).price;
  assert.equal(priceOf(r.data.ticket, drap), 1.5, 'tarif négocié');
  assert.equal(priceOf(r.data.ticket, serviette), 1, 'prix catalogue pour les autres articles');

  // commande générée depuis le planning des chambres : même règle (correctif)
  const rt = await call('POST', '/api/admin/room-types', { clientId: hotel, name: 'Double', departureItems: [{ serviceId: drap, qty: 2 }, { serviceId: serviette, qty: 1 }] });
  assert.equal(rt.status, 201);
  const stays = [{ roomTypeId: rt.data.roomType.id, checkinDate: '2026-10-20', checkoutDate: '2026-10-22' }];
  const sim = await call('POST', '/api/admin/room-types/simulate', { stays });
  assert.equal(sim.data.items.find(i => i.id === drap).price, 1.5, 'estimation au tarif négocié');
  const gen = await call('POST', '/api/admin/room-types/generate-order', { stays });
  assert.equal(gen.status, 201, JSON.stringify(gen.data));
  assert.equal(priceOf(gen.data.ticket, drap), 1.5, 'commande générée au tarif négocié');

  // et toujours le prix catalogue pour un hôtel sans tarif
  const other = await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Catalogue' });
  const o2 = await call('POST', '/api/admin/orders/manual', { clientId: other.data.client.id, items: [{ serviceId: drap, qty: 1 }] });
  assert.equal(priceOf(o2.data.ticket, drap), 2.1);
  db.close();
});

test('actes en masse : l’aperçu est libre, l’application demande la ressaisie du code', async () => {
  const url = `${B}/catalog/clients/${hotel}/prices/bulk`;
  const body = { mode: 'percent', percent: 10, from: '2026-10-01' };
  let r = await call('POST', url, body);
  assert.equal(r.status, 200); assert.equal(r.data.applied, false);

  r = await call('POST', url, { ...body, apply: true });
  assert.equal(r.status, 403); assert.equal(r.data.code, 'STEP_UP_REQUIRED');

  r = await sensitive(`prices-bulk:${hotel}`, 'POST', url, { ...body, apply: true });
  assert.equal(r.status, 200); assert.equal(r.data.applied, true);
  assert.ok(r.data.count >= 2, 'tous les articles visibles par cet hôtel sont réévalués (catalogue de démarrage compris)');
  assert.equal((await call('GET', `${B}/catalog/clients/${hotel}/prices`)).data.articles.find(a => a.id === drap).price, 1.65);

  // une ressaisie ne sert qu'une fois
  assert.equal((await call('POST', url, { ...body, apply: true })).status, 403);
  // et seulement pour l'hôtel et l'action visés
  await call('POST', `${B}/lock/confirm`, { code: CODE, scope: `prices-bulk:${hotel + 100}` });
  assert.equal((await call('POST', url, { ...body, percent: 5, apply: true })).status, 403);
});

test('suppression, import et code d’accès : ressaisie exigée, aucun secret dans les réponses du journal', async () => {
  const tmp = (await call('POST', `${B}/catalog/articles`, { name: 'Jetable', code: 'J', sageCode: 'T-J', price: 1 })).data.article.id;
  assert.equal((await call('DELETE', `${B}/catalog/articles/${tmp}`)).status, 403);
  assert.equal((await sensitive(`article-delete:${tmp}`, 'DELETE', `${B}/catalog/articles/${tmp}`)).status, 200);
  // un article utilisé par une règle de chambre ne se supprime pas, même avec le code
  const used = await sensitive(`article-delete:${serviette}`, 'DELETE', `${B}/catalog/articles/${serviette}`);
  assert.equal(used.status, 409); assert.match(used.data.error, /règles de linge/);

  const csv = 'nom,code,code_sage,prix\nPeignoir,PG,T-PG,12';
  assert.equal((await call('POST', `${B}/catalog/articles/import`, { csv })).data.summary.created, 1, 'aperçu libre');
  assert.equal((await call('POST', `${B}/catalog/articles/import`, { csv, apply: true })).status, 403);
  assert.equal((await sensitive('articles-import', 'POST', `${B}/catalog/articles/import`, { csv, apply: true })).data.summary.created, 1);

  assert.equal((await call('PUT', `${B}/catalog/clients/${hotel}/access-code`, { code: '482915' })).status, 403);
  assert.equal((await sensitive(`client-code:${hotel}`, 'PUT', `${B}/catalog/clients/${hotel}/access-code`, { code: '482915' })).status, 200);
  const log = await call('GET', `${B}/catalog/prices/log?clientId=${hotel}`);
  assert.equal(log.status, 200);
  assert.ok(log.data.events.length >= 2);
  assert.ok(!JSON.stringify(log.data).includes('482915'));

  // un hôtel qui a des documents ne se supprime pas
  assert.equal((await sensitive(`client-delete:${hotel}`, 'DELETE', `${B}/catalog/clients/${hotel}`)).status, 200, 'sans document : supprimable');
});

test('accès par article : verrouillé, aperçu puis application, article retiré refusé à la commande', async () => {
  const URL_ = `${B}/catalog/articles/${serviette}/access`;
  await call('POST', `${B}/lock/lock`);
  assert.equal((await call('GET', URL_)).status, 423);
  assert.equal((await call('POST', URL_, { clientIds: [] })).status, 423);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);

  const sel = (await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Sélection', email: 'selection@exemple.fr' })).data.client.id;
  let r = await call('GET', URL_);
  assert.equal(r.status, 200);
  assert.equal(r.data.article.sageCode, 'T-ST');
  assert.ok(r.data.clients.length >= 2 && r.data.clients.every(c => c.hasAccess));
  assert.equal((await call('GET', `${B}/catalog/articles/inconnu/access`)).status, 404);
  assert.equal((await call('POST', URL_, { clientIds: 'x' })).status, 400);
  assert.equal((await call('POST', URL_, { clientIds: [999999] })).status, 400);

  // seul « Hôtel Sélection » perd la serviette ; l'aperçu n'écrit rien
  const everyone = r.data.clients.map(c => c.id).filter(id => id !== sel);
  r = await call('POST', URL_, { clientIds: everyone });
  assert.equal(r.status, 200); assert.equal(r.data.applied, false);
  assert.deepEqual(r.data.changes.map(c => [c.clientId, c.access, c.becameRestricted]), [[sel, false, true]]);
  assert.equal((await call('GET', URL_)).data.clients.find(c => c.id === sel).hasAccess, true, 'aperçu : rien n’est écrit');

  r = await call('POST', URL_, { clientIds: everyone, apply: true });
  assert.equal(r.status, 200); assert.equal(r.data.applied, true);
  assert.equal((await call('GET', URL_)).data.clients.find(c => c.id === sel).hasAccess, false);
  const arts = (await call('GET', `${B}/catalog/articles`)).data.articles;
  assert.equal(arts.find(a => a.id === serviette).hiddenFor, 1);
  assert.equal((await call('GET', `${B}/catalog/prices/log?articleId=${serviette}`)).data.events.filter(e => e.action === 'client_article_access').length, 1);

  // l'hôtel ne peut plus commander l'article retiré, mais le reste passe
  const refused = await call('POST', '/api/admin/orders/manual', { clientId: sel, items: [{ serviceId: serviette, qty: 1 }] });
  assert.ok(refused.status >= 400 && refused.status < 500, `commande refusée (reçu ${refused.status})`);
  const ok = await call('POST', '/api/admin/orders/manual', { clientId: sel, items: [{ serviceId: drap, qty: 1 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  // le recto de la médaille : on lui redonne l'article
  assert.equal((await call('POST', URL_, { clientIds: [...everyone, sel], apply: true })).status, 200);
  assert.equal((await call('GET', `${B}/catalog/articles`)).data.articles.find(a => a.id === serviette).hiddenFor, 0);
});

test('export de la grille tarifaire et intégrité du journal', async () => {
  const res = await call('GET', `${B}/catalog/prices/export.csv`, undefined, true);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /grille-tarifaire\.csv/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM UTF-8 pour Excel');
  assert.ok(buf.toString('utf8').includes('code_sage;article;catalogue;'));
  const integrity = await call('GET', `${B}/integrity`);
  assert.equal(integrity.data.ok, true);
});
