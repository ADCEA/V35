// Arrêt de collecte : le chauffeur passe chercher du linge sale chez un client, sans linge propre à livrer.
// Programmable un jour à venir, affectable à un chauffeur, mais jamais facturé ni compté comme livraison.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { startServer } = require('./helpers');

const L = '/api/admin/logistics';
const parisDay = (offset = 0) => new Date(Date.now() + offset * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
let s, db, hotel, sansAdresse, karim, lea, article, delivered;
const admin = (...a) => s.call(...a);
const portal = async (token, method, url, body) => {
  const r = await fetch(`${s.BASE}/api/driver-portal/${token}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const orderIds = (list) => list.map(o => o.id);

test.before(async () => {
  s = await startServer({ env: { ROAD_ROUTING: 'off' } });
  assert.equal((await admin('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await admin('POST', '/api/admin/billing/lock/setup', { code: 'code-facturation-1', confirm: 'code-facturation-1' })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const mk = (mail, name, adresse) => Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash, code_postal, ville, created_at) VALUES (?, ?, 'Jean', '0490123456', ?, ?, '84200', 'Carpentras', datetime('now'))`)
    .run(mail, name, adresse, bcrypt.hashSync('1234', 10)).lastInsertRowid);
  hotel = mk('lavandes@x.fr', 'Hôtel des Lavandes', '1 rue Test');
  sansAdresse = mk('vide@x.fr', 'Hôtel Sans Adresse', '');
  karim = (await admin('POST', `${L}/drivers`, { name: 'Karim' })).data.driver;
  lea = (await admin('POST', `${L}/drivers`, { name: 'Léa' })).data.driver;
  article = db.prepare('SELECT id, name, code, price FROM articles ORDER BY id LIMIT 1').get();
  // une vraie livraison de linge propre, pour comparer avec ce qui n'est PAS compté
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, created_at, livraison_prevue, delivered_at) VALUES ('CZ-REEL-0001', ?, 'Hôtel des Lavandes', 'Jean', '0', '1 rue Test', 'livree', datetime('now'), ?, datetime('now'))`).run(hotel, parisDay()).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, price, qty, delivered_qty, production_stage) VALUES (?, ?, ?, ?, ?, 10, 10, 'tri')`).run(o, article.id, article.name, article.code || 'X', article.price || 1);
  delivered = o;
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('création : réservée à l\'administration, contrôles du client, de la date et du chauffeur', async () => {
  assert.equal((await fetch(`${s.BASE}${L}/collections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const post = (b) => admin('POST', `${L}/collections`, b);
  assert.equal((await post({})).status, 400, 'client obligatoire');
  assert.equal((await post({ clientId: 99999 })).status, 400, 'client inconnu');
  const noAddr = await post({ clientId: sansAdresse });
  assert.equal(noAddr.status, 400);
  assert.match(noAddr.data.error, /adresse/i, 'le chauffeur ne peut pas aller nulle part');
  assert.equal((await post({ clientId: hotel, date: parisDay(-1) })).status, 400, 'pas dans le passé');
  assert.equal((await post({ clientId: hotel, date: '2026-13-45' })).status, 400, 'date invalide');
  assert.equal((await post({ clientId: hotel, date: 'demain' })).status, 400);
  assert.equal((await post({ clientId: hotel, date: parisDay(400) })).status, 400, 'pas plus d\'un an');
  assert.equal((await post({ clientId: hotel, driverId: 99999 })).status, 400, 'chauffeur inconnu');
  // rien n'a été créé par les refus
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders WHERE collect_only = 1').get().n, 0);
});

test('arrêt du jour affecté à un chauffeur : sur sa page, sans linge ni bon de livraison, validable', async () => {
  const r = await admin('POST', `${L}/collections`, { clientId: hotel, driverId: karim.id, notes: ' 3 sacs à la réception ' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const o = r.data.order;
  assert.equal(o.collectOnly, true);
  assert.equal(o.status, 'prete', 'du jour : prêt à partir');
  assert.deepEqual(o.items, []);
  assert.equal(o.driverId, karim.id);
  assert.equal(o.livraisonPrevue, parisDay());
  assert.equal(o.notes, '3 sacs à la réception');
  assert.match(o.ticket, /^CZ-\d{6}-\d{4}$/);
  assert.equal(o.client.adresse, '1 rue Test');

  // vu de Logistique, avec l'indicateur
  const lg = (await admin('GET', `${L}/orders`)).data.orders.find(x => x.id === o.id);
  assert.equal(lg.collectOnly, true);

  // page du chauffeur
  const page = (await portal(karim.access_token, 'GET', '')).data;
  const stop = page.stops.find(x => x.orderId === o.id);
  assert.ok(stop, 'l\'arrêt est dans la tournée');
  assert.equal(stop.collectOnly, true);
  assert.equal(stop.deliveryNoteUrl, null);
  assert.deepEqual(stop.items, []);
  assert.equal(stop.notes, '3 sacs à la réception');
  assert.equal((await portal(karim.access_token, 'GET', `/orders/${o.id}/delivery-note.pdf`)).status, 404, 'pas de bon de livraison pour une collecte');
  // l'autre chauffeur ne le voit pas
  assert.ok(!(await portal(lea.access_token, 'GET', '')).data.stops.some(x => x.orderId === o.id));

  // validation : même geste que pour une livraison
  const done = await portal(karim.access_token, 'POST', `/orders/${o.id}/deliver`, {});
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.remaining, 0);
  const after = (await portal(karim.access_token, 'GET', '')).data;
  assert.ok(!after.stops.some(x => x.orderId === o.id));
  const row = after.deliveredToday.find(x => x.orderId === o.id);
  assert.equal(row.collectOnly, true);
  assert.equal(row.deliveryNoteUrl, null);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'livree');
});

test('une collecte n\'est ni facturée, ni un bon de livraison, ni une livraison, ni dans l\'historique de l\'hôtel', async () => {
  const collectId = db.prepare('SELECT id FROM orders WHERE collect_only = 1 AND status = \'livree\' ORDER BY id LIMIT 1').get().id;
  const today = parisDay();
  const B = '/api/admin/billing';

  // bons de livraison : seul le vrai y est
  const bl = (await admin('GET', `${B}/deliveries?from=${today}&to=${today}`)).data;
  assert.deepEqual(orderIds(bl.deliveries), [delivered], JSON.stringify(bl.deliveries.map(d => d.ticket)));
  assert.equal((await admin('GET', `${B}/deliveries/${collectId}`)).status, 404);

  // à facturer
  const inv = (await admin('GET', `/api/admin/clients/${hotel}/invoiceable-orders`)).data;
  assert.deepEqual(orderIds(inv.orders), [delivered]);
  const inv2 = (await admin('GET', `${B}/clients/${hotel}/invoiceable-orders`)).data;
  assert.deepEqual(orderIds(inv2.orders || inv2.deliveries || []), [delivered]);

  // statistiques : une livraison, une commande reçue (la collecte compte pour rien)
  const ov = (await admin('GET', `/api/admin/stats?from=${today}&to=${today}`)).data;
  assert.equal(ov.deliveredOrders, 1, 'une seule livraison');
  assert.equal(ov.totalOrders, 1, 'une seule commande reçue');
  const daily = (await admin('GET', `/api/admin/stats/daily?from=${today}&to=${today}`)).data;
  const day = daily.days.find(d => d.date === today);
  assert.equal(day.ordersDelivered, 1);
  assert.equal(day.ordersReceived, 1);
  const detail = (await admin('GET', `/api/admin/stats/daily/${today}`)).data;
  assert.deepEqual(orderIds(detail.delivered), [delivered]);
  assert.deepEqual(orderIds(detail.received), [delivered]);
  const bd = (await admin('GET', `${B}/stats/daily?from=${today}&to=${today}`)).data;
  assert.equal(bd.days.find(d => d.date === today).deliveredCount, 1);
  assert.deepEqual(orderIds((await admin('GET', `${B}/stats/daily/${today}`)).data.deliveries), [delivered], 'détail du jour (ventes)');
  const whole = (await admin('GET', '/api/admin/stats')).data;   // sans période
  assert.equal(whole.totalOrders, 1);
  assert.equal(whole.deliveredOrders, 1);
  assert.equal(whole.last30Days, 1);

  // liste des commandes de l'administration (Préparation, Historique) : sans la collecte
  const all = (await admin('GET', '/api/admin/orders')).data.orders;
  assert.ok(all.some(o => o.id === delivered));
  assert.ok(!all.some(o => o.id === collectId));

  // espace de l'hôtel : ni commande, ni livraison
  const login = await fetch(`${s.BASE}/api/clients/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'lavandes@x.fr', code: '1234' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const mine = await (await fetch(`${s.BASE}/api/clients/orders`, { headers: { cookie } })).json();
  assert.deepEqual(orderIds(mine.orders), [delivered]);
  const dl = await (await fetch(`${s.BASE}/api/clients/deliveries`, { headers: { cookie } })).json();
  assert.deepEqual(orderIds(dl.deliveries), [delivered]);
  assert.equal((await fetch(`${s.BASE}/api/clients/deliveries/${collectId}/pdf`, { headers: { cookie } })).status, 404);
  // on ne peut pas signaler un problème sur une collecte (ce n'est pas une livraison)
  const nc = (b) => fetch(`${s.BASE}/api/clients/non-conformities`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(b) });
  assert.equal((await nc({ orderId: collectId, kind: 'sale', comment: 'test' })).status, 404);
  assert.equal((await nc({ orderId: delivered, kind: 'sale', comment: 'test' })).status, 201, 'la vraie livraison, elle, se signale');
});

test('programmé un jour à venir : invisible du chauffeur et de l\'atelier jusqu\'à ce jour-là', async () => {
  const r = await admin('POST', `${L}/collections`, { clientId: hotel, driverId: lea.id, date: parisDay(3), notes: '' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const o = r.data.order;
  assert.equal(o.status, 'recue', 'programmé : en attente de son jour');
  assert.equal(o.notes, null);
  assert.equal(o.livraisonPrevue, parisDay(3));
  assert.ok(!(await portal(lea.access_token, 'GET', '')).data.stops.some(x => x.orderId === o.id), 'pas avant son jour');
  // visible dans Logistique (anticipation), pas dans l'atelier ni dans la préparation
  assert.ok((await admin('GET', `${L}/orders`)).data.orders.some(x => x.id === o.id && x.collectOnly));
  const atelier = (await admin('GET', `/api/admin/atelier/forecast?day=${parisDay(1)}`)).data;
  assert.ok(!(atelier.orders || []).some(x => x.orderId === o.id), 'pas une commande à planifier à l\'atelier');
  const choices = (await admin('GET', '/api/admin/atelier/choices')).data;
  assert.ok(!JSON.stringify(choices).includes(o.ticket), 'ni dans les commandes proposées pour un lot');
  assert.ok(!(await admin('GET', '/api/admin/orders')).data.orders.some(x => x.id === o.id));

  // le jour venu (on avance la date de l'arrêt) : il passe « prêt » tout seul et apparaît chez le chauffeur
  db.prepare('UPDATE orders SET livraison_prevue = ? WHERE id = ?').run(parisDay(), o.id);
  const page = (await portal(lea.access_token, 'GET', '')).data;
  assert.ok(page.stops.some(x => x.orderId === o.id && x.collectOnly));
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id).status, 'prete');
  // un arrêt programmé plus tard ne bouge pas
  const later = (await admin('POST', `${L}/collections`, { clientId: hotel, driverId: lea.id, date: parisDay(10) })).data.order;
  await portal(lea.access_token, 'GET', '');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(later.id).status, 'recue');
});

test('sans chauffeur choisi : l\'hôtel rejoint sa tournée fixe, sinon « non assigné » ; suppression possible', async () => {
  // sans tournée fixe : non assigné
  const free = (await admin('POST', `${L}/collections`, { clientId: hotel })).data.order;
  assert.equal(free.driverId, null);
  // avec une tournée fixe qui passe tous les jours chez l'hôtel
  const tour = await admin('POST', `${L}/tours`, { name: 'Tous les jours', driverId: karim.id, weekdays: [1, 2, 3, 4, 5, 6, 7], clientIds: [hotel] });
  assert.equal(tour.status, 201, JSON.stringify(tour.data));
  const viaTour = (await admin('POST', `${L}/collections`, { clientId: hotel })).data.order;
  const row = db.prepare('SELECT driver_id, tour_id FROM orders WHERE id = ?').get(viaTour.id);
  assert.equal(row.driver_id, karim.id, 'rattaché au chauffeur de la tournée fixe');
  assert.ok(row.tour_id);
  // un chauffeur choisi à la main l'emporte sur la tournée fixe
  const manual = (await admin('POST', `${L}/collections`, { clientId: hotel, driverId: lea.id })).data.order;
  assert.equal(db.prepare('SELECT driver_id, tour_manual FROM orders WHERE id = ?').get(manual.id).driver_id, lea.id);
  // suppression d'un arrêt
  assert.equal((await admin('DELETE', `/api/admin/orders/${manual.id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders WHERE id = ?').get(manual.id).n, 0);
});

test('une vraie livraison est inchangée : bon de livraison, lignes, notification', async () => {
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, created_at, driver_id) VALUES ('CZ-REEL-0002', ?, 'Hôtel des Lavandes', 'Jean', '0', '1 rue Test', 'prete', datetime('now'), ?)`).run(hotel, lea.id).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, price, qty, delivered_qty, production_stage) VALUES (?, ?, ?, ?, ?, 4, 4, 'tri')`).run(o, article.id, article.name, article.code || 'X', article.price || 1);
  const stop = (await portal(lea.access_token, 'GET', '')).data.stops.find(x => x.orderId === o);
  assert.equal(stop.collectOnly, false);
  assert.match(stop.deliveryNoteUrl, /delivery-note\.pdf$/);
  assert.equal(stop.items.length, 1);
  assert.equal((await portal(lea.access_token, 'GET', `/orders/${o}/delivery-note.pdf`)).status, 200);
});

test('les prévisions de charge des tournées ne comptent pas les collectes', async () => {
  // une vraie livraison et une collecte, toutes deux il y a 8 jours, chez l'hôtel de la tournée fixe créée plus haut
  const past = new Date(Date.now() - 8 * 86400000).toISOString();
  const real = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, created_at, livraison_prevue, delivered_at, collect_only) VALUES ('CZ-HIST-0001', ?, 'Hôtel des Lavandes', 'Jean', '0', '1 rue Test', 'livree', ?, ?, ?, 0)`).run(hotel, past, past.slice(0, 10), past).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, price, qty, delivered_qty, production_stage) VALUES (?, ?, ?, ?, ?, 5, 5, 'tri')`).run(real, article.id, article.name, article.code || 'X', article.price || 1);
  db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, status, created_at, livraison_prevue, delivered_at, collect_only) VALUES ('CZ-HIST-0002', ?, 'Hôtel des Lavandes', 'Jean', '0', '1 rue Test', 'livree', ?, ?, ?, 1)`).run(hotel, past, past.slice(0, 10), past);
  const f = (await admin('GET', `${L}/tours/forecast?days=7`)).data;
  const tour = f.tours.find(t => t.name === 'Tous les jours');
  assert.equal(tour.history.orders, 1, 'la collecte n\'entre pas dans l\'historique de charge');
  assert.equal(tour.clients[0].deliveries, 1);
  // et les collectes en attente chez cet hôtel (rattachées à la tournée) ne comptent pas comme charge à livrer
  assert.ok(db.prepare('SELECT COUNT(*) n FROM orders WHERE collect_only = 1 AND tour_id IS NOT NULL AND status != \'livree\'').get().n > 0, 'il y a bien des collectes en attente sur la tournée');
  assert.ok(f.runs.length > 0 && f.runs.every(r => !r.known), JSON.stringify(f.runs.map(r => r.known)));
});
