// Quantités négatives (reprise de linge, retour) : sur les lignes d'une commande saisie par l'administration, et sur les
// lignes article d'une facture. La base existante est migrée sans perte ; les totaux, TVA, PDF, avoirs et FEC suivent.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; let db; let hotel; let n = 0;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body, raw) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return call(method, url, body, raw);
}
const items = (orderId) => db.prepare('SELECT service_id AS id, qty, delivered_qty AS d FROM order_items WHERE order_id = ? ORDER BY id').all(orderId).map(r => ({ ...r }));
const manual = (list, extra = {}) => call('POST', '/api/admin/orders/manual', { clientId: hotel, items: list, livraisonPrevue: '2026-10-20', ...extra });
function deliveredOrder(lines, date = '2026-10-20') {
  n += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-NEG-${n}`, hotel, 'Hôtel', 'J', '06', 'adr', date).lastInsertRowid);
  for (const [id, name, price, qty] of lines) db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, id, name, id.toUpperCase(), `S-${id}`, price, qty, qty);
  return o;
}

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const art = db.prepare(`INSERT INTO articles (id, name, code, sage_code, price, category) VALUES (?,?,?,?,?,?)`);
  art.run('drap', 'Drap plat', 'DP', 'S-DP', 2, 'lit');
  art.run('taie', 'Taie', 'TA', 'S-TA', 1, 'lit');
  art.run('serv', 'Serviette', 'SE', 'S-SE', 0.5, 'toilette');
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number, adresse_facturation)
    VALUES ('h@x.fr','Hôtel Les Lavandes','Jean','0490123456','450 route de Malaucène','84380','Mazan','x','55210055400013','FR40552100554','Siège')`).run().lastInsertRowid);
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

// ---------- commandes ----------

test('commande manuelle : une quantité négative est une reprise ; zéro et non-entiers sont refusés', async () => {
  const ok = await manual([{ serviceId: 'drap', qty: 100 }, { serviceId: 'taie', qty: -20 }]);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const id = db.prepare('SELECT id FROM orders WHERE ticket = ?').get(ok.data.ticket).id;
  assert.deepEqual(items(id), [{ id: 'drap', qty: 100, d: 100 }, { id: 'taie', qty: -20, d: -20 }]);
  assert.equal((await manual([{ serviceId: 'drap', qty: 0 }])).status, 400);
  assert.equal((await manual([{ serviceId: 'drap', qty: 'abc' }])).status, 400);
  assert.equal((await manual([{ serviceId: 'drap', qty: 2.5 }, { serviceId: 'taie', qty: 1 }])).status, 201, 'décimal : tronqué comme avant');
  const bad = await manual([{ serviceId: 'inconnu', qty: -5 }]);
  assert.equal(bad.status, 400);
});

test('ajout d\'un article à une commande : négatif accepté ; fusion avec une ligne existante sans changer de sens', async () => {
  const made = await manual([{ serviceId: 'drap', qty: 100 }]);
  const id = db.prepare('SELECT id FROM orders WHERE ticket = ?').get(made.data.ticket).id;
  assert.equal((await call('POST', `/api/admin/orders/${id}/items`, { serviceId: 'serv', qty: -5 })).status, 201);
  assert.deepEqual(items(id).at(-1), { id: 'serv', qty: -5, d: -5 });
  assert.equal((await call('POST', `/api/admin/orders/${id}/items`, { serviceId: 'drap', qty: -30 })).status, 201, 'réduit la ligne existante');
  assert.equal(items(id)[0].qty, 70);
  assert.equal((await call('POST', `/api/admin/orders/${id}/items`, { serviceId: 'drap', qty: -70 })).status, 409, 'tomberait à zéro');
  assert.equal((await call('POST', `/api/admin/orders/${id}/items`, { serviceId: 'drap', qty: -100 })).status, 409, 'changerait de sens');
  assert.equal((await call('POST', `/api/admin/orders/${id}/items`, { serviceId: 'taie', qty: 0 })).status, 400);
  assert.equal(items(id)[0].qty, 70, 'rien n\'a bougé');
});

test('quantités livrées : une ligne de reprise reste négative ou nulle, une ligne normale positive ou nulle', async () => {
  const made = await manual([{ serviceId: 'drap', qty: 10 }, { serviceId: 'taie', qty: -10 }], { status: 'traitement' });
  const id = db.prepare('SELECT id FROM orders WHERE ticket = ?').get(made.data.ticket).id;
  let r = await call('PATCH', `/api/admin/orders/${id}/items`, { items: [{ id: 'drap', deliveredQty: 8 }, { id: 'taie', deliveredQty: -6 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(items(id), [{ id: 'drap', qty: 10, d: 8 }, { id: 'taie', qty: -10, d: -6 }]);
  r = await call('PATCH', `/api/admin/orders/${id}/items`, { items: [{ id: 'drap', deliveredQty: -3 }, { id: 'taie', deliveredQty: 4 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(items(id), [{ id: 'drap', qty: 10, d: 8 }, { id: 'taie', qty: -10, d: -6 }], 'valeurs de sens contraire ignorées');
  await call('PATCH', `/api/admin/orders/${id}/items`, { items: [{ id: 'taie', deliveredQty: 0 }] });
  assert.equal(items(id)[1].d, 0);
});

test('production : une reprise n\'est pas du travail d\'atelier (ni étiquette, ni total à préparer)', async () => {
  const made = await manual([{ serviceId: 'drap', qty: 10 }, { serviceId: 'serv', qty: -4 }], { status: 'traitement' });
  const id = db.prepare('SELECT id FROM orders WHERE ticket = ?').get(made.data.ticket).id;
  const list = (await call('GET', '/api/admin/production/items')).data.items.filter(i => i.orderId === id);
  assert.deepEqual(list.map(i => i.code), ['DP']);
  const totals = (await call('GET', '/api/admin/production/totals')).data.totals;
  assert.ok(totals.every(t => t.totalQty > 0), JSON.stringify(totals));
  // l'aperçu de la commande, lui, montre bien la reprise
  const orders = (await call('GET', '/api/admin/production/orders')).data.orders.find(o => o.id === id);
  assert.ok(orders.items.some(i => i.qty === -4));
});

// ---------- migration d'une base existante ----------

test('migration : une base qui interdit encore les quantités ≤ 0 est mise à niveau sans perdre une commande', async () => {
  const first = await startServer();
  const dir = first.DATA_DIR;
  await first.stop();
  // on remet la table dans son ancien état (CHECK qty > 0) avec des lignes dedans, comme sur la base de production
  const old = new Database(path.join(dir, 'database.sqlite'));
  old.pragma('foreign_keys = OFF');
  const sql = old.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='order_items'`).get().sql;
  assert.match(sql, /qty <> 0/);
  old.exec(sql.replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?"?order_items"?/i, 'CREATE TABLE order_items_old').replace('qty <> 0', 'qty > 0'));
  old.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash) VALUES ('a@x.fr','H','J','06','adr','x')`).run();
  old.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status) VALUES ('CZ-OLD-1',1,'H','J','06','adr','livree')`).run();
  old.prepare(`INSERT INTO order_items_old (order_id, service_id, name, code, sage_code, price, qty, delivered_qty, production_stage) VALUES (1,'drap','Drap','DP','S-DP',2,50,48,'pliage')`).run();
  old.prepare(`INSERT INTO order_items_old (order_id, service_id, name, code, sage_code, price, qty, delivered_qty, production_stage) VALUES (1,'taie','Taie','TA','S-TA',1,10,10,'tri')`).run();
  old.exec('DROP TABLE order_items; ALTER TABLE order_items_old RENAME TO order_items;');
  assert.throws(() => old.prepare(`INSERT INTO order_items (order_id, service_id, name, code, price, qty) VALUES (1,'x','X','X',1,-1)`).run(), /CHECK/);
  old.close();

  const second = await startServer({ dataDir: dir });
  try {
    const chk = new Database(path.join(dir, 'database.sqlite'), { readonly: true });
    const newSql = chk.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='order_items'`).get().sql;
    assert.match(newSql, /qty <> 0/); assert.ok(!/qty > 0/.test(newSql));
    assert.deepEqual(chk.prepare('SELECT service_id, qty, delivered_qty, production_stage, sage_code, price FROM order_items ORDER BY id').all().map(r => ({ ...r })),
      [{ service_id: 'drap', qty: 50, delivered_qty: 48, production_stage: 'pliage', sage_code: 'S-DP', price: 2 }, { service_id: 'taie', qty: 10, delivered_qty: 10, production_stage: 'tri', sage_code: 'S-TA', price: 1 }]);
    const idx = chk.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='order_items'`).all().map(r => r.name);
    assert.ok(idx.includes('idx_items_order') && idx.includes('idx_items_production'), JSON.stringify(idx));
    assert.equal(chk.prepare('SELECT COUNT(*) n FROM orders').get().n, 1, 'la commande est toujours là');
    chk.close();
    // et la saisie négative fonctionne sur cette base migrée
    assert.equal((await second.call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
    const art = new Database(path.join(dir, 'database.sqlite'));
    art.prepare(`INSERT INTO articles (id, name, code, sage_code, price, category) VALUES ('drap','Drap','DP','S-DP',2,'lit')`).run(); art.close();
    const r = await second.call('POST', '/api/admin/orders/manual', { clientId: 1, items: [{ serviceId: 'drap', qty: -7 }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  } finally { await second.stop(); }
  // un second démarrage ne refait rien
  const third = await startServer({ dataDir: dir });
  try {
    const chk = new Database(path.join(dir, 'database.sqlite'), { readonly: true });
    assert.equal(chk.prepare('SELECT COUNT(*) n FROM order_items').get().n, 3);
    chk.close();
  } finally { await third.stop(); }
});

// ---------- factures ----------

test('facture depuis un BL avec reprise : la quantité négative vient en déduction (détail, regroupé, par BL)', async () => {
  const o1 = deliveredOrder([['drap', 'Drap plat', 2, 100], ['taie', 'Taie', 1, -20]], '2026-10-01');
  const o2 = deliveredOrder([['drap', 'Drap plat', 2, -10]], '2026-10-02');
  const detail = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o1, o2], detailLevel: 'detail' });
  assert.equal(detail.status, 201, JSON.stringify(detail.data));
  const L = detail.data.invoice.lines.filter(l => !l.isSection);
  assert.deepEqual(L.map(l => [l.description, l.quantity, l.lineHtCents]), [['Drap plat', 100, 20000], ['Taie', -20, -2000], ['Drap plat', -10, -2000]]);
  assert.equal(detail.data.invoice.totalHtCents, 16000);
  assert.equal(detail.data.invoice.totalTtcCents, 19200, 'TVA 20 % sur 160,00 €');
  await call('DELETE', `${B}/invoices/${detail.data.invoice.id}`);

  const agg = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o1, o2], detailLevel: 'aggregated' });
  assert.equal(agg.status, 201, JSON.stringify(agg.data));
  assert.deepEqual(agg.data.invoice.lines.filter(l => !l.isSection).map(l => [l.description, l.quantity]), [['Drap plat', 90], ['Taie', -20]]);
  assert.equal(agg.data.invoice.totalHtCents, 16000);
  await call('DELETE', `${B}/invoices/${agg.data.invoice.id}`);

  const perBl = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o1, o2], detailLevel: 'per_bl' });
  assert.equal(perBl.status, 201, JSON.stringify(perBl.data));
  assert.deepEqual(perBl.data.invoice.lines.filter(l => !l.isSection).map(l => [l.quantity, l.unitPrice]), [[1, 180], [-1, 20]], 'BL à solde négatif : quantité −1, prix positif');
  assert.equal(perBl.data.invoice.totalHtCents, 16000);
  // le brouillon se ré-enregistre tel quel (prix toujours positif)
  const again = await call('PUT', `${B}/invoices/${perBl.data.invoice.id}`, { lines: perBl.data.invoice.lines });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  await call('DELETE', `${B}/invoices/${perBl.data.invoice.id}`);
});

test('ligne article en quantité négative sur une facture libre : acceptée, totaux et TVA exacts ; zéro refusé ; prix négatif refusé', async () => {
  const mk = (lines) => call('POST', `${B}/invoices/free`, { clientId: hotel, lines });
  assert.equal((await mk([{ description: 'Drap', quantity: 0, unitPrice: 2, vatRate: 20 }])).status, 400);
  assert.equal((await mk([{ description: 'Drap', quantity: 1, unitPrice: -2, vatRate: 20 }])).status, 400, 'le prix reste positif');
  const r = await mk([
    { description: 'Prestation', quantity: 100, unitPrice: 1, vatRate: 20 },
    { description: 'Reprise de linge', quantity: -30, unitPrice: 1, vatRate: 10 },
  ]);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const inv = r.data.invoice;
  assert.deepEqual(inv.lines.map(l => l.lineHtCents), [10000, -3000]);
  assert.equal(inv.totalHtCents, 7000);
  assert.equal(inv.totalVatCents, 2000 - 300, 'TVA 20 % sur +100 € moins TVA 10 % sur 30 €');
  assert.equal(inv.totalTtcCents, 8700);
  assert.deepEqual(inv.vatBreakdown.map(b => [b.rate, b.baseCents, b.vatCents]), [[10, -3000, -300], [20, 10000, 2000]]);
  // arrondi symétrique : −2,5 centimes → −3, comme +2,5 → +3
  const half = await mk([{ description: 'A', quantity: 5, unitPrice: 0.005, vatRate: 0 }, { description: 'B', quantity: -5, unitPrice: 0.005, vatRate: 0 }, { description: 'C', quantity: 1, unitPrice: 1, vatRate: 0 }]);
  assert.deepEqual(half.data.invoice.lines.map(l => l.lineHtCents), [3, -3, 100]);
  // modification d'un brouillon
  const up = await call('PUT', `${B}/invoices/${inv.id}`, { lines: [{ description: 'Prestation', quantity: 100, unitPrice: 1, vatRate: 20 }, { description: 'Reprise', quantity: -50, unitPrice: 1, vatRate: 20 }] });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.invoice.totalHtCents, 5000);
  for (const d of [inv.id, half.data.invoice.id]) await call('DELETE', `${B}/invoices/${d}`);
});

test('un total négatif se saisit en brouillon mais ne s\'émet pas : message clair, on renvoie vers l\'avoir', async () => {
  const r = await call('POST', `${B}/invoices/free`, { clientId: hotel, lines: [{ description: 'Prestation', quantity: 1, unitPrice: 10, vatRate: 20 }, { description: 'Reprise', quantity: -5, unitPrice: 10, vatRate: 20 }] });
  assert.equal(r.status, 201); assert.equal(r.data.invoice.totalTtcCents, -4800, "10 − 50 = −40 € HT, TVA 20 %");
  const issue = await sensitive(`issue:${r.data.invoice.id}`, 'POST', `${B}/invoices/${r.data.invoice.id}/issue`, { issueDate: '2026-10-05' });
  assert.equal(issue.status, 422, JSON.stringify(issue.data));
  assert.match(issue.data.error, /négatif/); assert.match(issue.data.error, /avoir/);
  await call('DELETE', `${B}/invoices/${r.data.invoice.id}`);
});

test('facture émise avec une reprise : PDF complet, FEC équilibré sans montant négatif, avoir total et avoirs partiels', async () => {
  const o = deliveredOrder([['drap', 'Drap plat', 2, 100], ['taie', 'Taie', 1, -20], ['serv', 'Serviette', 0.5, 40]], '2026-10-06');
  const c = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o] });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.invoice.id;
  // un taux de TVA différent sur la ligne de reprise : base négative pour ce taux
  const edited = await call('PUT', `${B}/invoices/${id}`, { lines: c.data.invoice.lines.map(l => (l.description === 'Taie' ? { ...l, vatRate: 10 } : l)) });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const iss = await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate: '2026-10-06' });
  assert.equal(iss.status, 200, JSON.stringify(iss.data));
  const inv = iss.data.invoice;
  assert.equal(inv.totalHtCents, 20000 - 2000 + 2000);
  assert.deepEqual(inv.vatBreakdown.map(b => b.baseCents), [-2000, 22000]);

  const pdf = await call('GET', `${B}/invoices/${id}/pdf`, undefined, true);
  assert.equal(pdf.status, 200);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-'); assert.ok(bytes.length > 2000);

  const res = await sensitive('fec:2026-10-01_2026-10-31', 'GET', `${B}/export/fec?from=2026-10-01&to=2026-10-31`, null, true);
  assert.equal(res.status, 200);
  const rows = (await res.text()).replace(/\r\n$/, '').split('\r\n').slice(1).map(l => l.split('\t'));
  const cents = (v) => Math.round(parseFloat(v.replace(',', '.')) * 100);
  assert.ok(rows.length >= 4);
  assert.ok(rows.every(r => cents(r[11]) >= 0 && cents(r[12]) >= 0), 'aucun montant négatif dans le FEC');
  assert.equal(rows.reduce((t, r) => t + cents(r[11]), 0), rows.reduce((t, r) => t + cents(r[12]), 0), 'débit = crédit');
  const vat10 = rows.find(r => /TVA collectée 10 %/.test(r[5]));
  assert.ok(vat10 && cents(vat10[11]) === 200 && cents(vat10[12]) === 0, 'la TVA négative du taux 10 % passe au débit');

  // avoir partiel sur la ligne de reprise : seulement en négatif, et pas plus que la ligne
  const detail = (await call('GET', `${B}/invoices/${id}`)).data.invoice;
  const taie = detail.lines.find(l => l.description === 'Taie');
  const credit = (lines) => sensitive(`credit:${id}`, 'POST', `${B}/invoices/${id}/credit-note`, { reason: 'Essai', full: false, lines });
  assert.equal((await credit([{ lineId: taie.id, quantity: 5 }])).status, 400, 'sens opposé à la ligne');
  assert.equal((await credit([{ lineId: taie.id, quantity: -25 }])).status, 400, 'plus que la ligne');
  const part = await credit([{ lineId: taie.id, quantity: -5 }]);
  assert.equal(part.status, 201, JSON.stringify(part.data));
  assert.equal(part.data.invoice.lines.find(l => !l.isSection).quantity, -5);
  assert.ok(part.data.invoice.totalTtcCents < 0);
  const badIssue = await sensitive(`issue:${part.data.invoice.id}`, 'POST', `${B}/invoices/${part.data.invoice.id}/issue`, { issueDate: '2026-10-07' });
  assert.equal(badIssue.status, 422, JSON.stringify(badIssue.data));
  assert.match(badIssue.data.error, /avoir est négatif/);
  assert.equal((await call('DELETE', `${B}/invoices/${part.data.invoice.id}`)).status, 200);

  // avoir total : la ligne de reprise est créditée en négatif, l'avoir vaut exactement la facture
  const full = await sensitive(`credit:${id}`, 'POST', `${B}/invoices/${id}/credit-note`, { reason: 'Annulation', full: true });
  assert.equal(full.status, 201, JSON.stringify(full.data));
  assert.deepEqual(full.data.invoice.lines.filter(l => !l.isSection).map(l => l.quantity).sort((a, b) => a - b), [-20, 40, 100]);
  assert.equal(full.data.invoice.totalTtcCents, inv.totalTtcCents);
  const cnIssue = await sensitive(`issue:${full.data.invoice.id}`, 'POST', `${B}/invoices/${full.data.invoice.id}/issue`, { issueDate: '2026-10-07' });
  assert.equal(cnIssue.status, 200, JSON.stringify(cnIssue.data));
  const after = (await call('GET', `${B}/invoices/${id}`)).data.invoice;
  assert.equal(after.creditedCents, inv.totalTtcCents); assert.equal(after.balanceCents, 0);
  assert.equal(after.paymentStatus, 'credited');
});

// ---------- réservé à l'administrateur ----------

test('seul l\'administrateur saisit une quantité négative : invité, espace client, API, e-mails et planning la refusent', async () => {
  const { assertPositiveQuantities } = require('../src/utils/orderQty');
  assert.doesNotThrow(() => assertPositiveQuantities([{ id: 'drap', qty: 3 }]));
  for (const qty of [-5, 0, 2.5, NaN, undefined]) assert.throws(() => assertPositiveQuantities([{ id: 'drap', name: 'Drap', qty }]), /quantités positives/, String(qty));

  s.newClient();   // plus aucune session d'administrateur
  const guest = { client: { societe: 'Hôtel', contact: 'Jean', tel: '06', adresse: '1 rue' }, livraisonPrevue: '2026-11-03' };
  let r = await call('POST', '/api/orders', { ...guest, items: [{ id: 'drap', qty: -5 }] });
  assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, /Quantité invalide/);
  r = await call('POST', '/api/orders', { ...guest, items: [{ id: 'drap', qty: 0 }] });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/orders', { ...guest, items: [{ id: 'drap', qty: 4 }] });
  assert.equal(r.status, 201, 'la commande positive, elle, passe toujours');

  db.prepare(`INSERT INTO api_tokens (client_id, token) VALUES (?, 'tok-negatif-test')`).run(hotel);
  const api = (qty) => fetch(`${s.BASE}/api/v1/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-negatif-test' }, body: JSON.stringify({ items: [{ sageCode: 'S-DP', qty }] }) });
  const neg = await api(-5);
  assert.equal(neg.status, 400, await neg.text());
  assert.equal((await api(3)).status, 201, 'l\'API accepte toujours le positif');

  // sans session : aucune route d'administration, de production ni de facturation n'accepte la saisie
  const some = db.prepare('SELECT id FROM orders ORDER BY id LIMIT 1').get().id;
  for (const [method, url, body] of [
    ['POST', '/api/admin/orders/manual', { clientId: hotel, items: [{ serviceId: 'drap', qty: -5 }] }],
    ['POST', `/api/admin/orders/${some}/items`, { serviceId: 'serv', qty: -5 }],
    ['PATCH', `/api/admin/orders/${some}/items`, { items: [{ id: 'drap', deliveredQty: -1 }] }],
    ['POST', `${B}/invoices/free`, { clientId: hotel, lines: [{ description: 'Reprise', quantity: -1, unitPrice: 1, vatRate: 20 }] }],
  ]) assert.equal((await call(method, url, body)).status, 401, `${method} ${url}`);

  // administrateur connecté mais Facturation verrouillée : pas de facture avec reprise sans le code
  assert.equal((await call('POST', '/api/admin/login', { password: 'secret123' })).status, 200);
  const locked = await call('POST', `${B}/invoices/free`, { clientId: hotel, lines: [{ description: 'Reprise', quantity: 5, unitPrice: 1, vatRate: 20 }, { description: 'Reprise', quantity: -1, unitPrice: 1, vatRate: 20 }] });
  assert.ok([401, 403, 423].includes(locked.status), `facturation verrouillée : ${locked.status}`);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
  assert.equal((await call('POST', `${B}/invoices/free`, { clientId: hotel, lines: [{ description: 'Reprise', quantity: 5, unitPrice: 1, vatRate: 20 }, { description: 'Reprise', quantity: -1, unitPrice: 1, vatRate: 20 }] })).status, 201, 'déverrouillée, l\'administrateur peut');

});
