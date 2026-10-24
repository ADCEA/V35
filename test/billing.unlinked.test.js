// BL dont le nom d'hôtel a été saisi librement : regroupement, hôtel proposé, aperçu exact, rattachement.
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-unlinked-'));
process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const catalog = require('../src/billing/catalog');
const deliveries = require('../src/billing/deliveries');
const unlinked = require('../src/billing/unlinked');

const rejects = (fn, re) => assert.throws(fn, (e) => e instanceof engine.BillingError && (!re || re.test(e.message)));
const addClient = (societe, tel = '', adresse = '', email = null) => Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash) VALUES (?,?,?,?,?,'x')`)
  .run(email, societe, 'Contact', tel, adresse).lastInsertRowid);
let seq = 0;
function orphan(societe, status = 'livree', date = '2026-10-10', { tel = '', adresse = '', price = 2, svc = 'svc0' } = {}) {
  const id = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`LIB-${++seq}`, null, societe, 'M. Libre', tel, adresse, date, status, '2026-09-01 08:00:00').lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(id, svc, 'Article', 'A', 'S', price, 10, 10);
  return id;
}
const group = (key) => unlinked.listGroups().groups.find(g => g.key === key);
const clientOf = (id) => db.prepare('SELECT client_id FROM orders WHERE id = ?').get(id).client_id;

let lav, ventoux, cigales, cezanne;

test('mise en place', () => {
  lav = addClient('Hôtel Les Lavandes', '04 90 12 34 56', '450 route de Malaucène');
  ventoux = addClient('Résidence du Mont Ventoux', '04 90 65 43 21', 'Chemin des Garrigues');
  cigales = addClient('Mas des Cigales');
  cezanne = addClient('Hôtel Cézanne');
});

test('les écritures d’un même nom forment un seul groupe (casse, accents, SAS, pluriel, articles)', () => {
  const ids = ['HOTEL LES LAVANDES', 'Hôtel Lavandes SAS', ' hotel  les lavandes ', 'Hôtel des Lavandes'].map(n => orphan(n));
  const g = group('hotel lavande');
  assert.ok(g, 'un groupe « hotel lavande »');
  assert.equal(g.orders, 4);
  assert.equal(g.variants.length, 4, 'les quatre écritures sont conservées pour information');
  assert.equal(g.delivered, 4);
  assert.equal(g.toInvoice, 4);
  assert.equal(g.toInvoiceHtCents, 4 * 2000, '10 pièces à 2 € × 4 BL');
  assert.equal(ids.length, 4);
});

test('fiche proposée : même nom écrit autrement = sûr ; nom approchant = à vérifier ; rien de commun = aucune proposition', () => {
  orphan('Mas des Cigale');                               // faute de frappe sur le nom
  orphan('Rés. Mont Ventoux');                            // abréviation
  orphan('Hôtel du Soleil');                              // rien à voir avec une fiche
  orphan('Auberge Cézanne');                              // un mot important en commun, mais autre type d'établissement
  const lavG = group('hotel lavande');
  assert.equal(lavG.suggestions[0].clientId, lav);
  assert.equal(lavG.suggestions[0].score, 1);
  assert.equal(lavG.suggestions[0].confidence, 'high');

  const cig = group('mas cigale');
  assert.equal(cig.suggestions[0].clientId, cigales, 'la faute de frappe « Cigale » retrouve « Cigales »');
  assert.equal(cig.suggestions[0].confidence, 'high');

  const vent = unlinked.listGroups().groups.find(x => /ventoux/.test(x.key));
  assert.equal(vent.suggestions[0].clientId, ventoux);
  assert.equal(vent.suggestions[0].confidence, 'high', '« Rés. » est reconnu comme « Résidence »');

  const soleil = unlinked.listGroups().groups.find(x => /soleil/.test(x.key));
  assert.deepEqual(soleil.suggestions, [], 'aucune fiche ne ressemble à « Hôtel du Soleil »');
  const aub = unlinked.listGroups().groups.find(x => /auberge/.test(x.key));
  assert.ok(!aub.suggestions.some(s => s.confidence === 'high'), '« Auberge Cézanne » n’est pas sûrement « Hôtel Cézanne »');
});

test('le téléphone et l’adresse renforcent la proposition', () => {
  orphan('Les Lavandes de Mazan', 'livree', '2026-10-11', { tel: '0490123456', adresse: '450 Route de Malaucene' });
  const g = unlinked.listGroups().groups.find(x => /mazan/.test(x.key));
  const s = g.suggestions.find(x => x.clientId === lav);
  assert.ok(s, 'proposée grâce au nom approchant + téléphone + adresse');
  assert.ok(s.why.includes('même téléphone') && s.why.includes('même adresse'), s.why.join(','));
  assert.ok(s.score >= 0.9);
});

test('l’aperçu n’écrit rien : ni lien, ni nouvelle fiche, ni journal', () => {
  const before = { clients: db.prepare('SELECT COUNT(*) n FROM clients').get().n, events: db.prepare('SELECT COUNT(*) n FROM billing_events').get().n, orphans: unlinked.count().orders };
  const r = unlinked.link([{ key: 'hotel lavande', clientId: lav }, { key: 'hotel soleil', create: true }]);
  assert.equal(r.applied, false);
  assert.equal(r.groups, 2);
  assert.equal(r.orders, 5, '4 BL « Lavandes » + 1 « Soleil »');
  assert.equal(r.remaining.orders, before.orphans - 5, 'l’aperçu annonce ce qui resterait');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clients').get().n, before.clients, 'aucune fiche créée');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_events').get().n, before.events, 'aucune ligne de journal');
  assert.equal(unlinked.count().orders, before.orphans, 'aucune commande rattachée');
});

test('rattachement : le lien est posé, le nom figé sur le BL ne change pas, l’hôtel les voit, le journal en garde la trace', () => {
  const g = group('hotel lavande');
  const ids = db.prepare("SELECT id FROM orders WHERE client_id IS NULL AND societe IN ('HOTEL LES LAVANDES','Hôtel Lavandes SAS',' hotel  les lavandes ','Hôtel des Lavandes')").all().map(r => r.id);
  assert.equal(ids.length, g.orders);
  const names = db.prepare(`SELECT societe FROM orders WHERE id IN (${ids.join(',')})`).all().map(r => r.societe).sort();

  const r = unlinked.link([{ key: 'hotel lavande', clientId: lav }], { apply: true });
  assert.equal(r.applied, true);
  assert.equal(r.orders, 4);
  assert.ok(ids.every(id => clientOf(id) === lav));
  assert.deepEqual(db.prepare(`SELECT societe FROM orders WHERE id IN (${ids.join(',')})`).all().map(x => x.societe).sort(), names, 'le texte saisi sur chaque BL est conservé tel quel');
  assert.equal(group('hotel lavande'), undefined, 'le groupe a disparu de la liste');
  assert.equal(deliveries.listDeliveries({ clientId: lav }).total, 4, 'les BL apparaissent maintenant sous l’hôtel');
  assert.ok(deliveries.listDeliveries({ clientId: lav }).deliveries.every(d => d.clientName === 'Hôtel Les Lavandes'), 'et portent le nom de la fiche');
  assert.equal(engine.listInvoiceableOrders(lav).length, 4, 'ils sont désormais facturables');
  const ev = db.prepare("SELECT detail_json FROM billing_events WHERE action = 'orders_linked' ORDER BY id DESC").get();
  const d = JSON.parse(ev.detail_json);
  assert.equal(d.orders, 4); assert.equal(d.client, 'Hôtel Les Lavandes'); assert.equal(d.names.length, 4);
  const integrity = engine.verifyIntegrity();
  assert.deepEqual(integrity.problems || integrity, [], 'la chaîne du journal reste intacte');
});

test('créer la fiche depuis le groupe reprend nom et coordonnées du BL le plus récent', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM clients').get().n;
  const id = orphan('Auberge du Lac', 'livree', '2026-10-12', { tel: '04 11 22 33 44', adresse: '1 quai du Lac' });
  const r = unlinked.link([{ key: 'auberge lac', create: true }], { apply: true });
  assert.equal(r.results[0].created, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clients').get().n, before + 1);
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientOf(id));
  assert.equal(c.societe, 'Auberge du Lac'); assert.equal(c.tel, '04 11 22 33 44'); assert.equal(c.adresse, '1 quai du Lac');
});

test('plusieurs groupes peuvent rejoindre la même fiche (« Cigale » et « Cigales »)', () => {
  const a = orphan('Mas des Cigales SARL'); const b = orphan('mas cigale'); 
  const keys = unlinked.listGroups().groups.filter(g => /cigale/.test(g.key)).map(g => g.key);
  assert.ok(keys.length >= 1);
  const r = unlinked.link(keys.map(key => ({ key, clientId: cigales })), { apply: true });
  assert.ok(r.orders >= 2);
  assert.equal(clientOf(a), cigales); assert.equal(clientOf(b), cigales);
});

test('refus : groupe inconnu, hôtel inconnu, doublon, liste vide — et rien n’est à moitié fait', () => {
  rejects(() => unlinked.link([]), /au moins un groupe/);
  rejects(() => unlinked.link([{ key: 'hotel soleil' }]), /Choisissez un hôtel/);
  rejects(() => unlinked.link([{ key: 'hotel soleil', clientId: lav }, { key: 'hotel soleil', clientId: lav }]), /deux fois/);
  rejects(() => unlinked.link([{ key: 'n-existe-pas', clientId: lav }], { apply: true }), /n'existe plus/);
  rejects(() => unlinked.link([{ key: 'hotel soleil', clientId: 999999 }], { apply: true }), /introuvable/);
  const sol = unlinked.listGroups().groups.find(x => /soleil/.test(x.key));
  assert.ok(sol, 'le groupe « Soleil » est intact après les refus');
  // un groupe valide + un invalide : rien n'est appliqué
  rejects(() => unlinked.link([{ key: sol.key, clientId: lav }, { key: 'fantome', clientId: lav }], { apply: true }), /n'existe plus/);
  assert.ok(unlinked.listGroups().groups.find(x => x.key === sol.key), 'le groupe valide n’a pas été rattaché seul');
});

test('option « recalculer les prix » : tarif négocié appliqué aux BL non facturés rattachés, pas aux BL déjà facturés', () => {
  catalog.createArticle({ name: 'Drap test', code: 'DT', sageCode: 'S-DT', price: 2, category: 'lit' });
  const art = db.prepare("SELECT id FROM articles WHERE name = 'Drap test'").get().id;
  const hotel = addClient('Hôtel Tarifé');
  catalog.setClientPrice(hotel, art, 1.5, '2026-01-01');
  const o1 = orphan('HOTEL TARIFE', 'livree', '2026-10-05', { price: 2, svc: art });
  const o2 = orphan('Hotel Tarifé SAS', 'livree', '2026-10-06', { price: 2, svc: art });
  const billed = orphan('hôtel tarifé', 'livree', '2026-10-07', { price: 2, svc: art });
  // facturé avant l'arrivée de la facturation intégrée (ancien circuit Odoo)
  const legacyInv = Number(db.prepare("INSERT INTO invoices (client_id, period_start, period_end, status) VALUES (?, '2026-09-01', '2026-09-30', 'posted')").run(hotel).lastInsertRowid);
  db.prepare('INSERT INTO invoice_orders (invoice_id, order_id) VALUES (?, ?)').run(legacyInv, billed);
  const key = unlinked.keyOf('HOTEL TARIFE');

  const pv = unlinked.link([{ key, clientId: hotel }], { reprice: true });
  assert.equal(pv.repriced.orders, 2, 'deux BL non facturés seraient recalculés');
  assert.equal(pv.repriced.deltaCents, -2 * 10 * 50, '10 pièces × (1,50 − 2,00) × 2 BL');
  assert.equal(db.prepare('SELECT price FROM order_items WHERE order_id = ?').get(o1).price, 2, 'l’aperçu ne modifie aucun prix');

  const r = unlinked.link([{ key, clientId: hotel }], { reprice: true, apply: true });
  assert.equal(r.repriced.orders, 2);
  assert.equal(db.prepare('SELECT price FROM order_items WHERE order_id = ?').get(o1).price, 1.5);
  assert.equal(db.prepare('SELECT price FROM order_items WHERE order_id = ?').get(o2).price, 1.5);
  assert.equal(db.prepare('SELECT price FROM order_items WHERE order_id = ?').get(billed).price, 2, 'un BL déjà facturé garde son prix');
});

test('sans l’option, les prix ne bougent pas', () => {
  const hotel = addClient('Hôtel Sans Recalcul');
  const art = db.prepare("SELECT id FROM articles WHERE name = 'Drap test'").get().id;
  catalog.setClientPrice(hotel, art, 1, '2026-01-01');
  const o = orphan('Hotel sans recalcul', 'livree', '2026-10-05', { price: 2, svc: art });
  unlinked.link([{ key: unlinked.keyOf('Hotel sans recalcul'), clientId: hotel }], { apply: true });
  assert.equal(db.prepare('SELECT price FROM order_items WHERE order_id = ?').get(o).price, 2);
});

test('noms vides : ils forment leur propre groupe, sans proposition, et se rattachent à la main', () => {
  const id = orphan('   ');
  const g = unlinked.listGroups().groups.find(x => x.key.startsWith('__sans-nom'));
  assert.ok(g); assert.deepEqual(g.suggestions, []);
  unlinked.link([{ key: g.key, clientId: cezanne }], { apply: true });
  assert.equal(clientOf(id), cezanne);
});

test('dice et normalisation', () => {
  assert.equal(unlinked.keyOf('L\'Hôtel des  Lavandes S.A.S.'), 'hotel lavande');
  assert.ok(unlinked.dice('lavande', 'lavandes') > 0.8);
  assert.ok(unlinked.dice('soleil', 'cezanne') < 0.3);
});

test('vérification BL par BL : chaque groupe détaille ses commandes, on peut en exclure, le reste attend', () => {
  const a = orphan('Villa Mirabelle', 'livree', '2026-10-01', { adresse: '3 chemin des Vignes' });
  const b = orphan('VILLA MIRABELLE SAS', 'livree', '2026-10-02', { adresse: '3 chemin des Vignes' });
  const c = orphan('Villa Mirabelle', 'recue', '2026-10-03', { adresse: 'ailleurs' });   // même nom mais autre adresse : on veut pouvoir l'écarter
  const g = group('villa mirabelle');
  assert.equal(g.orderList.length, 3);
  const row = g.orderList.find(o => o.id === c);
  assert.ok(row.ticket && row.date === '2026-10-03' && row.adresse === 'ailleurs' && row.status === 'recue' && row.htCents === 2000 && row.billed === false);
  assert.deepEqual(g.orderList.map(o => o.id), [c, b, a], 'du plus récent au plus ancien');

  const hotel = addClient('Villa Mirabelle');
  const pv = unlinked.link([{ key: 'villa mirabelle', clientId: hotel, orderIds: [a, b] }]);
  assert.equal(pv.orders, 2);
  assert.equal(pv.results[0].left, 1, 'un BL est laissé de côté');
  assert.deepEqual(pv.results[0].list.map(x => x.id).sort(), [a, b].sort(), 'l’aperçu liste exactement les BL concernés');
  assert.equal(clientOf(a), null, 'l’aperçu n’a rien rattaché');

  const r = unlinked.link([{ key: 'villa mirabelle', clientId: hotel, orderIds: [a, b] }], { apply: true });
  assert.equal(clientOf(a), hotel); assert.equal(clientOf(b), hotel); assert.equal(clientOf(c), null, 'le BL écarté reste libre');
  assert.equal(group('villa mirabelle').orderList.length, 1, 'il reste dans la liste pour être traité à part');
  const ev = JSON.parse(db.prepare("SELECT detail_json FROM billing_events WHERE action = 'orders_linked' ORDER BY id DESC").get().detail_json);
  assert.equal(ev.orders, 2);
  assert.equal(ev.tickets.length, 2, 'le journal garde la liste des BL rattachés');
  assert.ok(ev.tickets.includes(db.prepare('SELECT ticket FROM orders WHERE id = ?').get(a).ticket));
  assert.equal(r.results[0].toInvoice, 2);
});

test('sous-ensemble invalide : BL d’un autre groupe, déjà rattaché, liste vide → refus sans rien écrire', () => {
  const x = orphan('Chalet Edelweiss'); const y = orphan('Domaine du Rocher');
  const hotel = addClient('Chalet Edelweiss'); const KEY = unlinked.keyOf('Chalet Edelweiss');
  rejects(() => unlinked.link([{ key: KEY, clientId: hotel, orderIds: [x, y] }], { apply: true }), /ne fait plus partie/);
  rejects(() => unlinked.link([{ key: KEY, clientId: hotel, orderIds: [] }], { apply: true }), /Aucune commande retenue/);
  rejects(() => unlinked.link([{ key: KEY, clientId: hotel, orderIds: 'tous' }], { apply: true }), /invalide/);
  assert.equal(clientOf(x), null); assert.equal(clientOf(y), null);
  unlinked.link([{ key: KEY, clientId: hotel, orderIds: [x] }], { apply: true });
  rejects(() => unlinked.link([{ key: KEY, clientId: hotel, orderIds: [x] }], { apply: true }), /n'existe plus/);
});

test('l’aperçu du recalcul des prix détaille chaque BL concerné', () => {
  const art = db.prepare("SELECT id FROM articles WHERE name = 'Drap test'").get().id;
  const hotel = addClient('Hôtel Détail');
  catalog.setClientPrice(hotel, art, 1, '2026-01-01');
  const o = orphan('hotel detail', 'livree', '2026-10-05', { price: 2, svc: art });
  const r = unlinked.link([{ key: unlinked.keyOf('hotel detail'), clientId: hotel }], { reprice: true });
  assert.equal(r.repriced.detail.length, 1);
  assert.equal(r.repriced.detail[0].ticket, db.prepare('SELECT ticket FROM orders WHERE id = ?').get(o).ticket);
  assert.equal(r.repriced.detail[0].lines[0].from, 2); assert.equal(r.repriced.detail[0].lines[0].to, 1);
});

test('deux fiches de même nom : la proposition n’est jamais « sûre » et indique le lieu pour les distinguer', () => {
  const a = addClient('Hôtel Doublon', '', '1 rue A, Avignon'); const b = addClient('Hôtel Doublon', '', '2 rue B, Nîmes');
  orphan('HOTEL DOUBLON');
  const g = group(unlinked.keyOf('Hôtel Doublon'));
  assert.equal(g.suggestions.length, 2);
  assert.deepEqual(g.suggestions.map(s => s.clientId).sort(), [a, b].sort());
  assert.ok(g.suggestions.every(s => s.confidence !== 'high'), 'ambigu : à l’utilisateur de choisir');
  assert.ok(g.suggestions.some(s => /Avignon/.test(s.place)) && g.suggestions.some(s => /Nîmes/.test(s.place)));
});
