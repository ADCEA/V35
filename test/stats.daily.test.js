// Statistiques jour par jour : exploitation (sans montants) et ventes (montants).
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-daily-'));
process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const catalog = require('../src/billing/catalog');
const stats = require('../src/utils/dailyStats');
const money = require('../src/billing/daily');

const day = (r, date) => r.days.find(d => d.date === date);
let A, B, X, Y, Z; const O = {};

function order(ticket, client, { created = '2026-10-05T08:00:00.000Z', date = null, status = 'livree', km = null, lines = [] } = {}) {
  const id = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status, created_at, distance_from_prev_km) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(ticket, client, 'Société', 'C', '06', 'adr', date, status, created, km).lastInsertRowid);
  for (const [svc, qty, delivered, price] of lines) db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(id, svc, svc, svc, svc, price, qty, delivered);
  return id;
}

test('mise en place', () => {
  db.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', iban='FR7630001007941234567890185', bic='BDFEFRPP', email='c@x.fr', phone='04' WHERE id=1`).run();
  const cl = (n, e) => Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash, siret) VALUES (?,?,?,?,?,'x','55210055400013')`).run(e, n, 'C', '06', '1 rue').lastInsertRowid);
  A = cl('Hôtel A', 'a@x.fr'); B = cl('Hôtel B', 'b@x.fr');
  for (const [name, code, w, v] of [['Drap', 'DR', 500, 2], ['Serviette', 'SV', 200, 1], ['Peignoir', 'PG', 1000, 4]]) {
    catalog.createArticle({ name, code, sageCode: 'S-' + code, price: 1, category: 'lit' });
  }
  const id = (n) => db.prepare('SELECT id FROM articles WHERE name = ?').get(n).id;
  X = id('Drap'); Y = id('Serviette'); Z = id('Peignoir');
  db.prepare('UPDATE articles SET weight_g = 500, volume_l = 2 WHERE id = ?').run(X);
  db.prepare('UPDATE articles SET weight_g = 200, volume_l = 1 WHERE id = ?').run(Y);
  db.prepare('UPDATE articles SET weight_g = 1000, volume_l = 4 WHERE id = ?').run(Z);

  O.o1 = order('T1', A, { created: '2026-10-10T08:00:00.000Z', date: '2026-10-12', km: 12.5, lines: [[X, 10, 8, 2], [Y, 5, 5, 1]] });   // livré moins que commandé
  O.o2 = order('T2', A, { created: '2026-10-10 22:30:00', status: 'recue', lines: [[X, 3, null, 2]] });                                // reçue à 00:30 heure de Paris : le 11
  O.o3 = order('T3', B, { created: '2026-10-11T09:00:00.000Z', date: '2026-10-12', km: 7, lines: [[Z, 4, 6, 3]] });                      // livré plus que commandé
  O.o4 = order('T4', B, { created: '2026-10-11T09:30:00.000Z', date: '2026-10-12' });                                                      // livrée, aucune ligne
  O.o5 = order('T5', A, { created: '2026-10-13T09:30:00.000Z', date: null, lines: [[X, 2, 2, 2]] });                                       // sans date de livraison : date de création
});

test('période : 30 derniers jours par défaut, bornes contrôlées', () => {
  const r = stats.daily();
  assert.equal(r.days.length, 30);
  assert.equal(r.days.at(-1).date, stats.todayParis());
  assert.equal(stats.daily('2026-10-01', '2026-10-31').days.length, 31);
  assert.throws(() => stats.daily('2026-10-31', '2026-10-01'), /postérieure/);
  assert.throws(() => stats.daily('2026-13-01', '2026-10-01'), /invalides/);
  assert.throws(() => stats.daily('2024-01-01', '2026-10-01'), /limitée/);
  assert.throws(() => stats.dayDetail('hier'), /invalide/);
});

test('exploitation : réception à l’heure de Paris, livraison à la date du BL, écarts, poids, km', () => {
  const r = stats.daily('2026-10-09', '2026-10-14');
  assert.equal(r.days.length, 6);
  assert.equal(day(r, '2026-10-10').ordersReceived, 1, 'T1 reçue le 10');
  assert.equal(day(r, '2026-10-10').piecesOrdered, 15);
  assert.equal(day(r, '2026-10-11').ordersReceived, 3, 'T2 (22h30 UTC = 00h30 à Paris), T3 et T4 sont du 11');
  assert.equal(day(r, '2026-10-11').piecesOrdered, 3 + 4 + 0);
  const d = day(r, '2026-10-12');
  assert.equal(d.ordersDelivered, 3, 'T1, T3 et T4 (sans aucune ligne)');
  assert.equal(d.piecesDelivered, 8 + 5 + 6);
  assert.equal(d.references, 3);
  assert.equal(d.hotelsServed, 2);
  assert.equal(d.weightKg, (8 * 500 + 5 * 200 + 6 * 1000) / 1000);
  assert.equal(d.volumeL, 8 * 2 + 5 * 1 + 6 * 4);
  assert.equal(d.km, 19.5);
  assert.equal(d.piecesMissing, 2); assert.equal(d.piecesExtra, 2);
  assert.equal(d.ordersAdjusted, 2, 'T1 et T3 ne sont pas livrées à l’identique de la commande');
  const d13 = day(r, '2026-10-13');
  assert.equal(d13.ordersDelivered, 1, 'T5 sans date de livraison : daté de sa création, comme sur la page des BL');
  assert.equal(day(r, '2026-10-09').ordersReceived + day(r, '2026-10-09').ordersDelivered, 0, 'jour sans activité : zéros, mais présent');
  assert.equal(r.totals.ordersDelivered, 4);
  assert.equal(r.totals.activeDays, 4);
  assert.equal(r.totals.piecesDelivered, 8 + 5 + 6 + 2);
  assert.ok(!JSON.stringify(r).includes('Cents'), 'aucun montant dans la partie exploitation');
});

test('détail d’un jour : commandes reçues et livrées', () => {
  const d = stats.dayDetail('2026-10-12');
  assert.deepEqual(d.delivered.map(o => o.ticket).sort(), ['T1', 'T3', 'T4']);
  const t1 = d.delivered.find(o => o.ticket === 'T1');
  assert.equal(t1.pieces, 15); assert.equal(t1.piecesDelivered, 13); assert.equal(t1.clientName, 'Hôtel A'); assert.equal(t1.km, 12.5);
  assert.deepEqual(stats.dayDetail('2026-10-11').received.map(o => o.ticket).sort(), ['T2', 'T3', 'T4']);
  assert.deepEqual(stats.dayDetail('2026-10-14').delivered, []);
});

test('ventes : livré valorisé, factures, avoirs, encaissements par mode, annulation de règlement', () => {
  const draft = engine.createDraftFromOrders(A, [O.o1]);
  const inv = engine.issueInvoice(draft.id, { issueDate: '2026-10-13' });      // 8×2 + 5×1 = 21,00 € HT
  assert.equal(inv.total_ht_cents, 2100);
  engine.recordPayment(inv.id, { paidOn: '2026-10-14', amount: 10, method: 'prelevement', reference: 'PRLV' });
  engine.recordPayment(inv.id, { paidOn: '2026-10-14', amount: 5, method: 'virement' });
  engine.recordPayment(inv.id, { paidOn: '2026-10-14', amount: -1, method: 'virement', reference: 'erreur' });
  const cn = engine.issueInvoice(engine.createCreditNoteDraft(inv.id, { reason: 'Remise', full: false, lines: [{ lineId: inv.lines.find(l => !l.is_section).id, quantity: 1 }] }).id, { issueDate: '2026-10-15' });

  const r = money.daily('2026-10-09', '2026-10-16');
  const d12 = day(r, '2026-10-12');
  assert.equal(d12.deliveredCount, 3);
  assert.equal(d12.deliveredHtCents, 1600 + 500 + 6 * 300, 'quantités LIVRÉES × prix figé : 16,00 + 5,00 + 18,00');
  const d13 = day(r, '2026-10-13');
  assert.equal(d13.invoiceCount, 1); assert.equal(d13.invoicedHtCents, 2100); assert.equal(d13.invoicedTtcCents, inv.total_ttc_cents);
  assert.equal(d13.deliveredHtCents, 400, 'T5 : 2 × 2,00 €');
  const d14 = day(r, '2026-10-14');
  assert.equal(d14.paymentCount, 3);
  assert.equal(d14.paidCents, 1000 + 500 - 100, 'net des annulations : ce qui est réellement entré');
  assert.equal(d14.reversedCents, 100);
  assert.deepEqual(d14.paidByMethod, { prelevement: 1000, virement: 400 });
  const d15 = day(r, '2026-10-15');
  assert.equal(d15.creditCount, 1); assert.equal(d15.creditedTtcCents, cn.total_ttc_cents);
  assert.equal(r.totals.invoiceCount, 1); assert.equal(r.totals.paidCents, 1400);
  assert.deepEqual(r.totals.paidByMethod, { prelevement: 1000, virement: 400 });
  assert.equal(r.outstandingCents, inv.total_ttc_cents - cn.total_ttc_cents - 1400, 'reste dû = facturé − avoirs − encaissé');

  const det = money.dayDetail('2026-10-14');
  assert.equal(det.payments.length, 3); assert.equal(det.payments[0].number, inv.number);
  assert.equal(money.dayDetail('2026-10-13').invoices[0].number, inv.number);
  assert.equal(money.dayDetail('2026-10-12').deliveries.reduce((s, o) => s + o.htCents, 0), d12.deliveredHtCents, 'le détail retombe sur le total du jour');
});
