// Escompte pour règlement anticipé, de bout en bout par l'API : réglages, fiche hôtel, offre sur la facture,
// règlement avec escompte, rapprochement bancaire — avec le verrou de la Facturation.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; let db; let hotel;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, `confirmation ${scope} : ${JSON.stringify(c.data)}`);
  return call(method, url, body);
}
let day = 0;
async function newInvoice(issueDate) {
  day += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-ESC-${day}`, hotel, 'Hôtel', 'J', '06', 'adr', issueDate).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
  const c = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o] });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.invoice.id;
  const i = await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate });
  assert.equal(i.status, 200, JSON.stringify(i.data));
  return { id, number: i.data.invoice.number, ttc: i.data.invoice.totalTtcCents };
}

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number, adresse_facturation)
    VALUES ('h@x.fr','Hôtel Les Lavandes','Jean','0490123456','450 route de Malaucène','84380','Mazan','x','55210055400013','FR40552100554','Siège')`).run().lastInsertRowid);
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('réglages : par défaut éteint ; taux et délai validés ; modification protégée par le code', async () => {
  const g = await call('GET', `${B}/settings`);
  assert.equal(g.data.settings.early_discount_rate, 0);
  assert.equal(g.data.settings.early_discount_hours, 48);
  // sans ressaisie du code : refusé
  const denied = await call('PUT', `${B}/settings`, { early_discount_rate: '1,5' });
  assert.equal(denied.status, 403);
  // valeurs invalides
  for (const bad of [{ early_discount_rate: '11' }, { early_discount_rate: 'beaucoup' }, { early_discount_rate: '-1' }, { early_discount_hours: 0 }, { early_discount_hours: 'x' }, { early_discount_hours: 100000 }]) {
    const r = await sensitive('settings', 'PUT', `${B}/settings`, bad);
    assert.equal(r.status, 400, JSON.stringify(bad) + ' ' + JSON.stringify(r.data));
  }
  const ok = await sensitive('settings', 'PUT', `${B}/settings`, { early_discount_rate: '1,5', early_discount_hours: 48, early_discount_all: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.settings.early_discount_rate, 1.5);
  assert.equal(ok.data.settings.early_discount_all, 1);
});

test('fiche hôtel : option d\'escompte validée et conservée', async () => {
  const bad = await call('PUT', `${B}/catalog/clients/${hotel}`, { escompte: 'peut-être' });
  assert.equal(bad.status, 400);
  const off = await call('PUT', `${B}/catalog/clients/${hotel}`, { escompte: 'off' });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.client.escompte, 'off');
  const unrelated = await call('PUT', `${B}/catalog/clients/${hotel}`, { contact: 'Marie' });
  assert.equal(unrelated.data.client.escompte, 'off', 'une modification sans rapport ne remet pas l\'option à zéro');
  const back = await call('PUT', `${B}/catalog/clients/${hotel}`, { escompte: '' });
  assert.equal(back.data.client.escompte, null);
  const list = await call('GET', `${B}/catalog/clients`);
  assert.ok('escompte' in list.data.clients.find(c => c.id === hotel));
});

test('facture émise : l\'offre figée, le règlement avec escompte et ses garde-fous', async () => {
  const a = await newInvoice('2026-10-01');
  const d = (await call('GET', `${B}/invoices/${a.id}`)).data.invoice;
  assert.equal(a.ttc, 12000);
  assert.deepEqual({ ...d.escompte }, { ratePct: 1.5, hours: 48, deadline: '2026-10-03', open: d.escompte.open, expired: d.escompte.expired, discountCents: 180, netCents: 11820, grantedCents: 0 });

  // Refus hors délai, et montant qui ne correspond pas
  const late = await call('POST', `${B}/invoices/${a.id}/payments`, { paidOn: '2026-10-04', method: 'virement', withDiscount: true });
  assert.equal(late.status, 400); assert.match(late.data.error, /délai de l'escompte est dépassé/);
  const wrong = await call('POST', `${B}/invoices/${a.id}/payments`, { paidOn: '2026-10-02', amount: 120, method: 'virement', withDiscount: true });
  assert.equal(wrong.status, 400); assert.match(wrong.data.error, /règlement attendu est de 118,20/);
  // « withDiscount » doit valoir exactement true : une chaîne ne déclenche rien
  const str = await call('POST', `${B}/invoices/${a.id}/payments`, { paidOn: '2026-10-02', amount: 118.2, method: 'virement', withDiscount: 'true' });
  assert.equal(str.status, 201);
  assert.equal(str.data.invoice.balanceCents, 180, 'sans escompte accordé : il reste l\'écart');
  assert.equal(str.data.invoice.discountCents, 0);
  // le reste (1,80 €) se solde avec l'escompte sur ce reste dû ? non : l'escompte est calculé sur le reste dû
  const rest = await call('POST', `${B}/invoices/${a.id}/payments`, { paidOn: '2026-10-02', amount: 1.8, method: 'virement' });
  assert.equal(rest.data.invoice.balanceCents, 0);

  const b = await newInvoice('2026-10-02');
  const ok = await call('POST', `${B}/invoices/${b.id}/payments`, { paidOn: '2026-10-03', method: 'virement', reference: 'VIR HOTEL', withDiscount: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.invoice.balanceCents, 0);
  assert.equal(ok.data.invoice.paymentStatus, 'paid');
  assert.equal(ok.data.invoice.cashCents, 11820);
  assert.equal(ok.data.invoice.discountCents, 180);
  assert.equal(ok.data.invoice.paidCents, 12000);

  const det = (await call('GET', `${B}/invoices/${b.id}`)).data.invoice;
  assert.deepEqual(det.payments.map(p => [p.method, p.amountCents]), [['virement', 11820], ['escompte', 180]]);
  assert.ok(det.timeline.some(t => t.label === 'Escompte accordé (règlement anticipé)'));
  assert.equal(det.escompte.grantedCents, 180);

  // Statistiques : 118,20 € encaissés, l'escompte à part
  const pay = (await call('GET', `${B}/payments`)).data;
  assert.equal(pay.discountCents, 180);
  assert.ok(pay.payments.some(p => p.method === 'escompte'));

  // Annulation du règlement avec son escompte : la facture se rouvre pour 120 €
  const undo = await call('POST', `${B}/invoices/${b.id}/payments`, { paidOn: '2026-10-05', amount: -118.2, method: 'virement', reverseDiscount: true });
  assert.equal(undo.status, 201, JSON.stringify(undo.data));
  assert.equal(undo.data.invoice.balanceCents, 12000);
  assert.equal(undo.data.invoice.discountCents, 0);
  // « reverseDiscount » ne s'accepte qu'avec une écriture inverse
  const bogus = await call('POST', `${B}/invoices/${b.id}/payments`, { paidOn: '2026-10-05', amount: 10, reverseDiscount: true });
  assert.equal(bogus.status, 400);
});

test('PDF : la facture avec offre se génère, et la mention figure dans les conditions figées', async () => {
  const c = await newInvoice('2026-10-06');
  const res = await call('GET', `${B}/invoices/${c.id}/pdf`, null, true);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /pdf/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const terms = JSON.parse(db.prepare('SELECT terms_json FROM native_invoices WHERE id = ?').get(c.id).terms_json);
  assert.equal(terms.earlyDiscount.deadline, '2026-10-08');
  assert.match(terms.earlyPaymentDiscount, /ouvre droit à déduction chez l'acheteur/);
  assert.equal((await call('GET', `${B}/integrity`)).data.ok, true);
});

test('rapprochement bancaire : un virement égal au net, arrivé à temps, est proposé et enregistré avec escompte', async () => {
  const e1 = await newInvoice('2026-10-10');   // limite : 12/10
  const e2 = await newInvoice('2026-10-10');
  const csv = ['Date;Libellé;Montant',
    `12/10/2026;VIR SEPA HOTEL LES LAVANDES ${e1.number};118,20`,   // dans le délai, net exact
    `14/10/2026;VIR SEPA HOTEL LES LAVANDES ${e2.number};118,20`].join('\n'); // hors délai
  const p = await call('POST', `${B}/reconcile/parse`, { csv });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const [l1, l2] = p.data.lines;
  assert.equal(l1.candidates[0].invoiceId, e1.id);
  assert.equal(l1.candidates[0].withDiscount, true);
  assert.equal(l1.candidates[0].discountCents, 180);
  assert.equal(l1.confidence, 'high');
  assert.ok(l1.candidates[0].why.some(w => /après escompte/.test(w)));
  assert.ok(!l2.candidates[0].withDiscount, 'hors délai : aucune proposition d\'escompte');

  const items = [{ fingerprint: l1.fingerprint, date: l1.date, label: l1.label, method: 'virement', allocations: [{ invoiceId: e1.id, amountCents: l1.amountCents, withDiscount: true }] }];
  const ok = await call('POST', `${B}/reconcile/apply`, { items });
  assert.equal(ok.data.applied, 1, JSON.stringify(ok.data));
  const d = (await call('GET', `${B}/invoices/${e1.id}`)).data.invoice;
  assert.equal(d.balanceCents, 0);
  assert.equal(d.discountCents, 180);
  assert.equal(d.cashCents, 11820);

  // Le même relevé importé deux fois n'enregistre rien de plus (empreinte de ligne)
  const again = await call('POST', `${B}/reconcile/apply`, { items });
  assert.equal(again.data.applied, 0);
  assert.equal((await call('GET', `${B}/invoices/${e1.id}`)).data.invoice.discountCents, 180);

  // Hors délai, demander l'escompte est refusé par le moteur
  const late = [{ fingerprint: l2.fingerprint, date: l2.date, label: l2.label, method: 'virement', allocations: [{ invoiceId: e2.id, amountCents: l2.amountCents, withDiscount: true }] }];
  const refused = await call('POST', `${B}/reconcile/apply`, { items: late });
  assert.equal(refused.data.failed, 1);
  assert.match(refused.data.results[0].error, /délai de l'escompte est dépassé/);
  assert.equal((await call('GET', `${B}/invoices/${e2.id}`)).data.invoice.balanceCents, 12000);
});
