// Statistiques : prix unitaire moyen par article (montants → derrière le verrou de la Facturation).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

let s, jdb; const call = (...a) => s.call(...a);
const today = new Date().toISOString().slice(0, 10);

test.before(async () => {
  s = await startServer();
  await call('POST', '/api/admin/setup', { password: 'secret123' });
  await call('POST', '/api/admin/billing/lock/setup', { code: 'code-facturation-1', confirm: 'code-facturation-1' });
  jdb = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const mk = (ticket, createdAt, items) => {
    const o = Number(jdb.prepare(`INSERT INTO orders (ticket, societe, contact, tel, adresse, livraison_prevue, status, created_at) VALUES (?,?,?,?,?,?,?,?)`).run(ticket, 'H', 'C', '06', 'adr', today, 'livree', createdAt).lastInsertRowid);
    for (const [sid, name, price, qty] of items) jdb.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, sid, name, 'X', 'X', price, qty, qty);
  };
  mk('T1', `${today}T10:00:00.000Z`, [['a', 'Taie', 0.5, 100], ['b', 'Drap', 1.2, 10]]);
  mk('T2', `${today}T11:00:00.000Z`, [['a', 'Taie', 0.6, 100], ['c', 'Reprise', 1, -5]]);
  mk('ANCIENNE', '2020-01-01T10:00:00.000Z', [['a', 'Taie', 9, 1000]]);
});
test.after(async () => { if (jdb) jdb.close(); if (s) await s.stop(); });

test('prix moyen pondéré par les quantités, sur la période seulement, reprises exclues', async () => {
  const r = await call('GET', `/api/admin/billing/stats/articles?from=${today}&to=${today}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const by = Object.fromEntries(r.data.articles.map(a => [a.name, a]));
  assert.equal(by.Taie.avgPrice, 0.55);            // (100×0,5 + 100×0,6) ÷ 200 ; la commande de 2020 est hors période
  assert.equal(by.Taie.varies, true); assert.equal(by.Taie.minPrice, 0.5); assert.equal(by.Taie.maxPrice, 0.6);
  assert.equal(by.Drap.avgPrice, 1.2); assert.equal(by.Drap.varies, false);
  assert.equal(by.Reprise, undefined, 'une reprise (quantité négative) n\'a pas de prix moyen');
});

test('les prix sont des montants : verrouillés avec la Facturation, jamais dans /stats', async () => {
  const st = await call('GET', `/api/admin/stats?from=${today}&to=${today}`);
  assert.equal(st.status, 200);
  assert.ok(!JSON.stringify(st.data).match(/avgPrice|price/i), 'aucun prix dans les statistiques d\'exploitation');
  assert.equal(st.data.totalOrders, 2);
  assert.equal(st.data.articlesTotalQty, 210, 'volume total des articles de la période : 200 taies + 10 draps (la reprise et la commande de 2020 ne comptent pas)');
  const taie = st.data.topArticles.find(a => a.name === 'Taie');
  assert.equal(Math.round((taie.totalQty / st.data.articlesTotalQty) * 1000) / 10, 95.2, 'part des taies dans le volume total');
  await call('POST', '/api/admin/billing/lock/lock');
  assert.equal((await call('GET', `/api/admin/billing/stats/articles?from=${today}&to=${today}`)).status, 423);
});

test('période invalide refusée', async () => {
  await call('POST', '/api/admin/billing/lock/unlock', { code: 'code-facturation-1' });
  assert.equal((await call('GET', '/api/admin/billing/stats/articles?from=2026-10-10&to=2026-10-01')).status, 400);
});
