// Escompte pour règlement anticipé : offre figée à l'émission, règlement « avec escompte »,
// annulation, comptabilité (FEC) et statistiques. Base SQLite jetable.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-escompte-'));
process.env.BACKUP_SCHEDULER = 'off';
delete process.env.ODOO_URL; delete process.env.ODOO_API_KEY;

const db = require('../src/db');
const B = require('../src/billing/engine');
const E = require('../src/billing/escompte');
const { buildFec } = require('../src/billing/fec');
const queries = require('../src/billing/queries');
const daily = require('../src/billing/daily');
const docs = require('../src/billing/documents');

const NBSP = ' ';
let seq = 0;

function seedSeller() {
  db.prepare(`UPDATE billing_settings SET legal_name='BLANCHISSERIE CEZANNE & CO', legal_form='SAS', share_capital='10 000 €',
    siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', address_line='153 boulevard Jean-Louis Passet',
    postal_code='84200', city='Carpentras' WHERE id=1`).run();
}
function setEscompte(rate, hours = 48, all = 1) {
  db.prepare('UPDATE billing_settings SET early_discount_rate=?, early_discount_hours=?, early_discount_all=? WHERE id=1').run(rate, hours, all);
}

// Un hôtel avec 2 BL (283,10 € HT → 339,72 € TTC à 20 %), facture émise le 2026-10-31.
function issued({ escompteClient = null, issueDate = '2026-10-31', vat } = {}) {
  seq += 1;
  const c = db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number, escompte)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`e${seq}@x.fr`, `Hôtel Escompte ${seq}`, 'Jean', '0600000000', '1 rue du Test', '84000', 'Avignon', 'x', '55210055400013', 'FR40552100554', escompteClient);
  const clientId = Number(c.lastInsertRowid);
  const ids = [];
  for (const d of ['2026-10-01', '2026-10-08']) {
    const o = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status)
      VALUES (?,?,?,?,?,?,?, 'livree')`).run(`CZ-E${seq}-${d}`, clientId, `Hôtel Escompte ${seq}`, 'Jean', '06', '1 rue du Test', d);
    const oid = Number(o.lastInsertRowid); ids.push(oid);
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(oid, 'drap', 'Drap 2 places', 'D2', 'DRAP2', 1.234, 100, 100);
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(oid, 'serv', 'Serviette éponge', 'SE', 'SERV', 0.55, 33, 33);
  }
  const draft = B.createDraftFromOrders(clientId, ids, vat ? { vatRate: vat } : {});
  return { clientId, inv: B.issueInvoice(draft.id, { issueDate }) };
}

seedSeller();

// ---------- calculs ----------

test('montants : 1,5 % sur HT et TVA, taux par taux, arrondis stables', () => {
  // 283,10 € HT à 20 % : escompte HT 4,25 (424,65 arrondi), TVA 0,85, TTC 5,10
  const a = E.amounts({ vatBreakdown: [{ rate: 20, baseCents: 28310 }], total_ttc_cents: 33972 }, 33972, 1.5);
  assert.deepEqual(a, { htCents: 425, vatCents: 85, ttcCents: 510 });
  // deux taux : chaque base porte son escompte et sa TVA
  const m = E.amounts({ vatBreakdown: [{ rate: 5.5, baseCents: 10000 }, { rate: 20, baseCents: 20000 }], total_ttc_cents: 10550 + 24000 }, 10550 + 24000, 1.5);
  assert.deepEqual(m, { htCents: 150 + 300, vatCents: 8 + 60, ttcCents: 150 + 300 + 8 + 60 });
  // reste dû partiel : l'escompte suit le reste dû
  const half = E.amounts({ vatBreakdown: [{ rate: 20, baseCents: 20000 }], total_ttc_cents: 24000 }, 12000, 1.5);
  assert.deepEqual(half, { htCents: 150, vatCents: 30, ttcCents: 180 });
  // rien à calculer
  assert.deepEqual(E.amounts({ vatBreakdown: [], total_ttc_cents: 0 }, 0, 1.5), { htCents: 0, vatCents: 0, ttcCents: 0 });
  assert.deepEqual(E.amounts({ vatBreakdown: [{ rate: 20, baseCents: 100 }], total_ttc_cents: 120 }, 120, 0), { htCents: 0, vatCents: 0, ttcCents: 0 });
});

test('taux et délai : validation', () => {
  assert.equal(E.parseRate('1,5'), 1.5);
  assert.equal(E.parseRate(0), 0);
  assert.equal(E.parseRate('abc'), null);
  assert.equal(E.parseRate(-1), null);
  assert.equal(E.parseRate(11), null);
  assert.equal(E.parseHours(48), 48);
  assert.equal(E.parseHours(0), null);
  assert.equal(E.parseHours(1.5), null);
  assert.equal(E.deadline('2026-10-31', 48), '2026-11-02');
  assert.equal(E.deadline('2026-10-31', 24), '2026-11-01');
  assert.equal(E.deadline('2026-10-31', 36), '2026-11-02', 'un délai partiel de jour est arrondi au jour supérieur');
});

// ---------- offre figée à l'émission ----------

test('réglage éteint : aucune offre, conditions inchangées', () => {
  setEscompte(0);
  const { inv } = issued();
  assert.equal(inv.terms.earlyPaymentDiscount, "Pas d'escompte pour paiement anticipé.");
  assert.ok(!('earlyDiscount' in inv.terms), 'aucune trace de l\'escompte dans les conditions figées');
  assert.equal(B.escompteStatus(inv), null);
  assert.equal(B.verifyIntegrity().ok, true);
});

test('réglage 1,5 % / 48 h : l\'offre est figée avec la facture et protégée par l\'empreinte', () => {
  setEscompte(1.5, 48);
  const { inv } = issued();
  const o = inv.terms.earlyDiscount;
  assert.deepEqual(o, { ratePct: 1.5, hours: 48, deadline: '2026-11-02', discountHtCents: 425, discountVatCents: 85, discountTtcCents: 510 });
  assert.match(inv.terms.earlyPaymentDiscount, new RegExp(`1,5${NBSP}%`));
  assert.match(inv.terms.earlyPaymentDiscount, /02\/11\/2026/);
  assert.ok(inv.terms.earlyPaymentDiscount.includes(`339,72${NBSP}€`), 'montant d\'origine');
  assert.ok(inv.terms.earlyPaymentDiscount.includes(`334,62${NBSP}€`), 'net à payer');
  assert.match(inv.terms.earlyPaymentDiscount, /Seule la TVA correspondant au prix effectivement payé ouvre droit à déduction chez l'acheteur/);
  assert.equal(B.verifyIntegrity().ok, true);

  // Changer ensuite le réglage ne touche pas la facture déjà émise
  setEscompte(3, 24);
  const again = B.loadInvoice(inv.id);
  assert.deepEqual(again.terms.earlyDiscount, o);
  assert.equal(B.verifyIntegrity().ok, true);
  // ... ni une altération directe des conditions (trigger d'inaltérabilité)
  assert.throws(() => db.prepare('UPDATE native_invoices SET terms_json = ? WHERE id = ?').run('{}', inv.id), /modification interdite/);
  setEscompte(1.5, 48);
});

test('dérogation par hôtel : « off » exclut, « on » inclut même si le réglage général est « non »', () => {
  setEscompte(1.5, 48, 1);
  assert.ok(!issued({ escompteClient: 'off' }).inv.terms.earlyDiscount, 'hôtel exclu');
  assert.ok(issued({ escompteClient: 'on' }).inv.terms.earlyDiscount);
  assert.ok(issued({ escompteClient: null }).inv.terms.earlyDiscount, 'suit le réglage général');
  setEscompte(1.5, 48, 0);
  assert.ok(!issued({ escompteClient: null }).inv.terms.earlyDiscount, 'général « non » : pas d\'offre par défaut');
  assert.ok(issued({ escompteClient: 'on' }).inv.terms.earlyDiscount, 'hôtel « oui » malgré le général');
  setEscompte(1.5, 48, 1);
});

test('pas d\'offre quand la date limite n\'est pas avant l\'échéance, ni sur un avoir', () => {
  db.prepare('UPDATE billing_settings SET payment_terms_days = 2 WHERE id = 1').run();
  assert.ok(!issued().inv.terms.earlyDiscount, 'échéance = date limite : un escompte n\'aurait aucun sens');
  db.prepare('UPDATE billing_settings SET payment_terms_days = 30 WHERE id = 1').run();

  const { inv } = issued();
  const cn = B.createCreditNoteDraft(inv.id, { reason: 'test', full: true });
  const issuedCn = B.issueInvoice(cn.id, { issueDate: '2026-11-01' });
  assert.ok(!issuedCn.terms.earlyDiscount);
});

test('l\'aperçu d\'un brouillon montre l\'offre qui sera figée', () => {
  const c = db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret) VALUES ('p@x.fr','Hôtel Aperçu','J','06','1 rue','84000','Avignon','x','55210055400013')`).run();
  const o = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES ('CZ-AP',?,?,?,?,?,?, 'livree')`).run(c.lastInsertRowid, 'Hôtel Aperçu', 'J', '06', '1 rue', '2026-10-05');
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o.lastInsertRowid, 'drap', 'Drap', 'D2', 'DRAP2', 2, 100, 100);
  const draft = B.createDraftFromOrders(Number(c.lastInsertRowid), [Number(o.lastInsertRowid)]);
  const pv = B.previewDraft(draft.id, '2026-10-10');
  assert.equal(pv.terms.earlyDiscount.deadline, '2026-10-12');
  assert.equal(pv.terms.earlyDiscount.discountTtcCents, 360); // 200,00 HT → 3,00 HT + 0,60 TVA
});

// ---------- règlement avec escompte ----------

test('règlement avec escompte dans le délai : solde la facture, argent reçu = net, escompte à part', () => {
  const { inv } = issued();
  const st = B.escompteStatus(inv, '2026-11-02');
  assert.equal(st.open, true);
  assert.equal(st.discountCents, 510);
  assert.equal(st.netCents, 33462);
  assert.equal(B.escompteStatus(inv, '2026-11-03').open, false);
  assert.equal(B.escompteStatus(inv, '2026-11-03').expired, true);

  const after = B.recordPayment(inv.id, { paidOn: '2026-11-02', method: 'virement', reference: 'VIR TEST', withDiscount: true });
  assert.equal(B.balanceCents(after), 0);
  assert.equal(B.paymentStatus(after), 'paid');
  assert.equal(B.cashCents(inv.id), 33462, 'argent réellement reçu');
  assert.deepEqual(B.discountSums(inv.id), { ttcCents: 510, htCents: 425, vatCents: 85 });
  const rows = db.prepare('SELECT amount_cents, method, discount_ht_cents, discount_vat_cents FROM native_payments WHERE invoice_id = ? ORDER BY id').all(inv.id);
  assert.deepEqual(rows, [
    { amount_cents: 33462, method: 'virement', discount_ht_cents: null, discount_vat_cents: null },
    { amount_cents: 510, method: 'escompte', discount_ht_cents: 425, discount_vat_cents: 85 },
  ]);
  const tl = queries.timeline(inv.id).map(t => t.type);
  assert.ok(tl.includes('payment_recorded') && tl.includes('discount_granted'));
  assert.equal(B.verifyIntegrity().ok, true);
  // Une facture soldée ne peut plus recevoir d'escompte
  assert.throws(() => B.recordPayment(inv.id, { paidOn: '2026-11-02', withDiscount: true }), /déjà soldée/);
});

test('le montant saisi avec escompte doit être le net exact', () => {
  const { inv } = issued();
  assert.throws(() => B.recordPayment(inv.id, { paidOn: '2026-11-01', amount: 339.72, withDiscount: true }), /règlement attendu est de 334,62/);
  assert.throws(() => B.recordPayment(inv.id, { paidOn: '2026-11-01', amount: 334.61, withDiscount: true }), /règlement attendu/);
  const ok = B.recordPayment(inv.id, { paidOn: '2026-11-01', amount: 334.62, withDiscount: true });
  assert.equal(B.balanceCents(ok), 0);
});

test('hors délai ou sans offre : refus clair, rien n\'est enregistré', () => {
  const { inv } = issued();
  assert.throws(() => B.recordPayment(inv.id, { paidOn: '2026-11-03', withDiscount: true }), /délai de l'escompte est dépassé.*02\/11\/2026/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM native_payments WHERE invoice_id = ?').get(inv.id).c, 0);

  setEscompte(0);
  const { inv: plain } = issued();
  assert.throws(() => B.recordPayment(plain.id, { paidOn: '2026-11-01', withDiscount: true }), /ne propose pas d'escompte/);
  setEscompte(1.5, 48);
});

test('règlement partiel puis solde avec escompte : l\'escompte porte sur le reste dû', () => {
  const { inv } = issued();
  B.recordPayment(inv.id, { paidOn: '2026-11-01', amount: 100 });
  const bal = B.balanceCents(B.loadInvoice(inv.id)); // 33972 − 10000 = 23972
  assert.equal(bal, 23972);
  const st = B.escompteStatus(B.loadInvoice(inv.id), '2026-11-02');
  const expected = E.amounts({ vatBreakdown: inv.vatBreakdown, total_ttc_cents: inv.total_ttc_cents }, bal, 1.5);
  assert.equal(st.discountCents, expected.ttcCents);
  const after = B.recordPayment(inv.id, { paidOn: '2026-11-02', withDiscount: true });
  assert.equal(B.balanceCents(after), 0);
  assert.equal(B.cashCents(inv.id) + B.discountSums(inv.id).ttcCents, 33972);
});

test('un avoir émis avant le règlement réduit la base de l\'escompte', () => {
  const { inv } = issued();
  const cn = B.createCreditNoteDraft(inv.id, { reason: 'remise', lines: [{ lineId: inv.lines.find(l => !l.is_section).id, quantity: 10 }] });
  B.issueInvoice(cn.id, { issueDate: '2026-11-01' });
  const fresh = B.loadInvoice(inv.id);
  const bal = B.balanceCents(fresh);
  assert.ok(bal < 33972);
  const after = B.recordPayment(inv.id, { paidOn: '2026-11-02', withDiscount: true });
  assert.equal(B.balanceCents(after), 0);
  assert.equal(B.discountSums(inv.id).ttcCents, E.amounts({ vatBreakdown: fresh.vatBreakdown, total_ttc_cents: fresh.total_ttc_cents }, bal, 1.5).ttcCents);
});

test('on ne peut pas fabriquer un escompte en passant « escompte » comme mode de paiement', () => {
  const { inv } = issued();
  B.recordPayment(inv.id, { paidOn: '2026-11-05', amount: 10, method: 'escompte' });
  const row = db.prepare('SELECT method FROM native_payments WHERE invoice_id = ?').get(inv.id);
  assert.equal(row.method, 'virement');
  assert.equal(B.discountSums(inv.id).ttcCents, 0);
});

// ---------- annulation ----------

test('annuler le règlement avec son escompte rouvre la facture ; sans l\'option, l\'escompte reste', () => {
  const { inv } = issued();
  B.recordPayment(inv.id, { paidOn: '2026-11-02', withDiscount: true });
  // Annulation du seul argent reçu : l'escompte accordé reste, le reste dû = l'escompte
  const mid = B.recordPayment(inv.id, { paidOn: '2026-11-04', amount: -334.62 });
  assert.equal(B.balanceCents(mid), 33462);
  assert.equal(B.discountSums(inv.id).ttcCents, 510);
  // Puis annulation de l'escompte
  const { inv: inv2 } = issued();
  B.recordPayment(inv2.id, { paidOn: '2026-11-02', withDiscount: true });
  const re = B.recordPayment(inv2.id, { paidOn: '2026-11-04', amount: -334.62, reverseDiscount: true });
  assert.equal(B.balanceCents(re), 33972, 'facture rouverte pour son montant complet');
  assert.deepEqual(B.discountSums(inv2.id), { ttcCents: 0, htCents: 0, vatCents: 0 });
  assert.ok(queries.timeline(inv2.id).some(t => t.type === 'discount_reversed'));
  assert.equal(B.paymentStatus(re), 'unpaid');
  // L'annulation de l'escompte n'a de sens qu'avec un escompte existant et une écriture inverse
  const { inv: inv3 } = issued();
  B.recordPayment(inv3.id, { paidOn: '2026-11-02', amount: 100 });
  assert.throws(() => B.recordPayment(inv3.id, { paidOn: '2026-11-03', amount: -100, reverseDiscount: true }), /Aucun escompte à annuler/);
  assert.throws(() => B.recordPayment(inv3.id, { paidOn: '2026-11-03', amount: 50, reverseDiscount: true }), /accompagne l'annulation/);
  assert.throws(() => B.recordPayment(inv3.id, { paidOn: '2026-11-03', amount: -100, reverseDiscount: true, withDiscount: true }), /pas les deux/);
});

test('l\'écriture inverse est plafonnée à l\'argent réellement reçu, pas à l\'escompte', () => {
  const { inv } = issued();
  B.recordPayment(inv.id, { paidOn: '2026-11-02', withDiscount: true });
  assert.throws(() => B.recordPayment(inv.id, { paidOn: '2026-11-04', amount: -339.72 }), /dépasse le total déjà réglé/);
});

// ---------- comptabilité et statistiques ----------

test('FEC : l\'escompte passe en opérations diverses (665 / TVA / client), le journal de banque ne compte que l\'argent reçu, équilibre respecté', () => {
  const { inv } = issued();
  B.recordPayment(inv.id, { paidOn: '2026-11-02', withDiscount: true });
  const fec = buildFec(2026);
  assert.equal(fec.balanced, true);
  const rows = fec.content.split('\r\n').filter(Boolean).slice(1).map(l => l.split('\t'));
  const col = { journal: 0, compte: 4, debit: 11, credit: 12, lib: 10, piece: 8 };
  const od = rows.filter(r => r[col.journal] === 'OD' && r[col.piece] === inv.number);
  assert.equal(od.length, 3);
  const by = (n) => od.find(r => r[col.compte] === n);
  assert.equal(by('665000')[col.debit], '4,25');
  assert.equal(by('445710')[col.debit], '0,85');
  assert.equal(by('411')[col.credit], '5,10');
  const bq = rows.filter(r => r[col.journal] === 'BQ' && r[col.piece].includes('') && r[col.lib].includes(inv.number));
  const bank = bq.find(r => r[col.compte] === '512000');
  assert.equal(bank[col.debit], '334,62', 'banque = argent reçu, sans l\'escompte');
  // Annulation de l'escompte : écritures inverses
  B.recordPayment(inv.id, { paidOn: '2026-11-04', amount: -334.62, reverseDiscount: true });
  const fec2 = buildFec(2026);
  assert.equal(fec2.balanced, true);
  const rows2 = fec2.content.split('\r\n').filter(Boolean).slice(1).map(l => l.split('\t'));
  const rev = rows2.filter(r => r[col.journal] === 'OD' && r[col.lib].startsWith('Annulation escompte') && r[col.lib].includes(inv.number));
  assert.equal(rev.find(r => r[col.compte] === '665000')[col.credit], '4,25');
  assert.equal(rev.find(r => r[col.compte] === '411')[col.debit], '5,10');
});

test('PDF : l\'offre et l\'escompte accordé se génèrent sans erreur', async () => {
  const { inv } = issued();
  const a = await docs.invoicePdf(inv.id);
  assert.equal(a.buffer.subarray(0, 5).toString(), '%PDF-');
  B.recordPayment(inv.id, { paidOn: '2026-11-02', withDiscount: true });
  const b = await docs.invoicePdf(inv.id);
  assert.equal(b.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(b.buffer.length > 1000);
});

test('statistiques : l\'escompte n\'est jamais compté comme encaissé', () => {
  const { inv } = issued({ issueDate: '2026-12-01' });
  B.recordPayment(inv.id, { paidOn: '2026-12-02', withDiscount: true });

  const dash = queries.dashboard('2026-12-15');
  const dec = dash.series.find(s => s.month === '2026-12');
  assert.equal(dec.collectedCents, 33462, 'encaissé du mois = argent reçu');

  const day = daily.daily('2026-12-02', '2026-12-02');
  assert.equal(day.totals.paidCents, 33462);
  assert.equal(day.totals.paymentCount, 1);
  assert.equal(day.totals.discountCents, 510);
  assert.deepEqual(day.totals.paidByMethod, { virement: 33462 });
  const detail = daily.dayDetail('2026-12-02');
  assert.equal(detail.payments.length, 1);
  assert.equal(detail.discounts.length, 1);
  assert.equal(detail.discounts[0].amountCents, 510);

  const list = queries.listPayments({});
  assert.ok(list.payments.some(p => p.method === 'escompte' && p.invoiceId === inv.id), 'visible dans la liste');
  const inList = list.payments.filter(p => p.invoiceId === inv.id);
  assert.equal(inList.length, 2);
  assert.equal(list.discountCents >= 510, true);

  // La facture soldée apparaît « payée » dans les listes
  const row = queries.listInvoices({ tab: 'paid' }).invoices.find(r => r.id === inv.id);
  assert.ok(row, 'facture payée');
  assert.equal(row.balanceCents, 0);
});
