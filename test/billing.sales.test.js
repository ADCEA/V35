// Ventes : liste/tableau de bord, devis, facturation en lot, e-mails & relances, rapprochement bancaire.
const os = require('os'); const path = require('path'); const fs = require('fs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-sales-'));
process.env.DATA_DIR = DATA_DIR; process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const queries = require('../src/billing/queries');
const quotes = require('../src/billing/quotes');
const batch = require('../src/billing/batch');
const mail = require('../src/billing/mail');
const bank = require('../src/billing/bank');
const docs = require('../src/billing/documents');
const mailer = require('../src/utils/mailer');

const TODAY = '2026-10-24';

// SIRET valides (clé de Luhn) fabriqués pour les tests.
function luhnComplete(prefix) {
  for (let d = 0; d < 10; d++) if (engine.luhnOk(prefix + d)) return prefix + d;
}
const siret = (n) => luhnComplete(luhnComplete(String(10000000 + n)) + '0001'); // SIREN (8 + clé) puis NIC (4 + clé) = 14 chiffres

function addClient(societe, email, withSiret = true) {
  return Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret)
    VALUES (?,?,?,?,?,?,?,'x',?)`).run(email, societe, 'Contact', '06', '1 rue du Test', '84000', 'Avignon', withSiret ? siret(Math.floor(Math.random() * 90000)) : null).lastInsertRowid);
}
const L = (description, quantity, unitPrice, vatRate = 20) => ({ description, quantity, unitPrice, vatRate });

let alpha, beta, gamma, inv1, inv2, inv3, inv4;

test('mise en place : réglages, hôtels, quatre factures émises', () => {
  db.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', iban='FR7630001007941234567890185', bic='BDFEFRPP', email='compta@exemple.fr', phone='04 90 00 00 00' WHERE id=1`).run();
  alpha = addClient('Hôtel Alpha', 'alpha@exemple.fr');
  beta = addClient('Beta Resort', 'beta@exemple.fr');
  gamma = addClient('Résidence Gamma', 'gamma@exemple.fr');
  const mk = (client, price, date) => {
    const d = engine.createDraftFromLines(client, [L('Prestation', 1, price)]);
    return engine.issueInvoice(d.id, { issueDate: date });
  };
  inv1 = mk(alpha, 1000, '2026-08-01').id; // échue 2026-08-31 : 54 j de retard
  inv2 = mk(beta, 500, '2026-09-01').id;   // échue 2026-10-01 : 23 j de retard
  inv3 = mk(gamma, 250, '2026-10-01').id;  // échéance 2026-10-31
  inv4 = mk(alpha, 100, '2026-10-15').id;  // échéance 2026-11-14
  engine.recordPayment(inv2, { paidOn: '2026-10-10', amount: 100, method: 'virement', reference: 'acompte' });
  assert.equal(engine.loadInvoice(inv1).number, 'FA-2026-000001');
});

test('liste : onglets, comptes, recherche, tri, retard', () => {
  let r = queries.listInvoices({ tab: 'all' }, TODAY);
  assert.deepEqual([r.counts.all, r.counts.open, r.counts.overdue, r.counts.paid, r.counts.draft], [4, 4, 2, 0, 0]);
  assert.equal(r.sums.open, 120000 + 50000 + 30000 + 12000);
  assert.equal(r.sums.overdue, 170000);

  r = queries.listInvoices({ tab: 'overdue', sort: 'due', dir: 'asc' }, TODAY);
  assert.deepEqual(r.invoices.map(i => i.id), [inv1, inv2]);
  assert.equal(r.invoices[0].overdueDays, 54);
  assert.equal(r.invoices[1].display, 'overdue', 'partiellement payée mais échue = en retard');
  assert.equal(r.invoices[1].balanceCents, 50000);

  r = queries.listInvoices({ q: 'alpha' }, TODAY);
  assert.deepEqual(r.invoices.map(i => i.id).sort(), [inv1, inv4].sort());
  assert.equal(queries.listInvoices({ q: 'FA-2026-000003' }, TODAY).invoices[0].id, inv3);
  assert.equal(queries.listInvoices({ q: 'hotel alpha' }, TODAY).total, 2, 'accents et casse ignorés, tous les mots requis');
  assert.equal(queries.listInvoices({ from: '2026-10-01' }, TODAY).total, 2);
  r = queries.listInvoices({ sort: 'amount', dir: 'desc' }, TODAY);
  assert.equal(r.invoices[0].id, inv1);
  // les compteurs d'onglets suivent le filtre client mais pas l'onglet
  r = queries.listInvoices({ tab: 'overdue', clientId: alpha }, TODAY);
  assert.deepEqual([r.total, r.counts.all, r.counts.open], [1, 2, 2]);
});

test('tableau de bord : facturé, encaissé, encours, âge des créances, plus gros débiteurs', () => {
  const d = queries.dashboard(TODAY);
  assert.equal(d.invoiced.monthHtCents, 35000);
  assert.equal(d.invoiced.prevMonthHtCents, 50000);
  assert.equal(d.invoiced.yearHtCents, 185000);
  assert.equal(d.collected.monthCents, 10000);
  assert.deepEqual([d.open.count, d.open.cents], [4, 212000]);
  assert.deepEqual([d.overdue.count, d.overdue.cents], [2, 170000]);
  const by = Object.fromEntries(d.aging.map(b => [b.key, b.cents]));
  assert.deepEqual([by.notDue, by.d1_30, by.d31_60, by.d61_90, by.d90], [42000, 50000, 120000, 0, 0]);
  assert.equal(d.topDebtors[0].clientName, 'Hôtel Alpha');
  assert.equal(d.topDebtors[0].balanceCents, 132000);
  assert.equal(d.series.length, 12);
  assert.equal(d.series.at(-1).month, '2026-10');
  assert.equal(d.dsoDays, null, 'aucune facture soldée encore');
});

test('chronologie d\'une facture', () => {
  const t = queries.timeline(inv2);
  assert.deepEqual(t.map(x => x.type), ['draft_created', 'issued', 'payment_recorded']);
  assert.match(t[2].detail, /100,00 €/);
});

test('devis : brouillon → finalisé (n° DE) → accepté → converti en brouillon de facture', async () => {
  const q = quotes.createQuote(alpha, [{ description: 'Location linge — banquet', isSection: true }, L('Nappes', 40, 3.5), L('Serviettes', 120, 0.8)], { reference: 'Mariage du 12/12' });
  assert.equal(q.status, 'draft'); assert.equal(q.total_ht_cents, 14000 + 9600);
  assert.equal(quotes.updateQuote(q.id, { notes: 'Livraison la veille' }).notes, 'Livraison la veille');
  const pdfDraft = await docs.quotePdf(q.id);
  assert.equal(pdfDraft.buffer.subarray(0, 5).toString(), '%PDF-');

  const issued = quotes.issueQuote(q.id, { issueDate: '2026-10-20' });
  assert.equal(issued.number, 'DE-2026-0001'); assert.equal(issued.valid_until, '2026-11-19');
  assert.throws(() => quotes.updateQuote(q.id, { notes: 'x' }), /finalisé/);
  assert.throws(() => quotes.deleteQuote(q.id), /finalisé/);
  const second = quotes.issueQuote(quotes.createQuote(beta, [L('Draps', 10, 2)]).id, { issueDate: '2026-10-21' });
  assert.equal(second.number, 'DE-2026-0002', 'numérotation continue');
  assert.equal((await docs.quotePdf(q.id)).filename, 'DE-2026-0001.pdf');

  assert.equal(quotes.listQuotes({}, TODAY).counts.issued, 2);
  assert.equal(quotes.listQuotes({}, '2026-12-01').quotes.find(x => x.id === q.id).expired, true);

  quotes.decideQuote(q.id, 'accepted');
  const draftInv = quotes.convertToInvoice(q.id);
  assert.equal(draftInv.status, 'draft'); assert.equal(draftInv.reference, 'Devis DE-2026-0001 — Mariage du 12/12');
  assert.equal(draftInv.total_ht_cents, 23600); assert.equal(draftInv.orderIds.length, 0);
  assert.equal(quotes.loadQuote(q.id).status, 'invoiced');
  assert.throws(() => quotes.convertToInvoice(q.id), /déjà été converti/);
  // La facture issue du devis s'émet comme n'importe quelle autre
  const out = engine.issueInvoice(draftInv.id, { issueDate: '2026-10-22' });
  assert.equal(out.number, 'FA-2026-000005');
  inv5 = out.id;
});
let inv5;

test('e-mails : envoi de facture, relances, niveau conseillé, échec journalisé', async () => {
  const sent = [];
  const realSend = mailer.sendMail; const realCfg = mailer.isConfigured;
  mailer.isConfigured = () => true;
  mailer.sendMail = async (m) => { sent.push(m); return { sent: true }; };
  try {
    const client = 'Hôtel Alpha';
    const tpl = mail.render('invoice', engine.loadInvoice(inv1), client, TODAY);
    assert.match(tpl.subject, /FA-2026-000001/); assert.match(tpl.body, /1 200,00 €/); assert.match(tpl.body, /IBAN FR76/);

    await mail.sendInvoice(inv1, { to: 'alpha@exemple.fr', subject: tpl.subject, body: tpl.body });
    assert.equal(sent[0].attachments[0].filename, 'FA-2026-000001.pdf');
    assert.equal(sent[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-');
    await assert.rejects(() => mail.sendInvoice(inv1, { to: 'pas-un-email', subject: 's', body: 'b' }), /invalide/);
    const draft = engine.createDraftFromLines(alpha, [L('x', 1, 1)]);
    await assert.rejects(() => mail.sendInvoice(draft.id, { to: 'a@b.fr', subject: 's', body: 'b' }), /émis/);

    // Niveau conseillé : jamais relancée + en retard → 1
    let ov = mail.remindersOverview(TODAY);
    assert.deepEqual(ov.map(o => [o.id, o.suggestedLevel]), [[inv1, 1], [inv2, 1]]);
    assert.equal(ov[0].email, 'alpha@exemple.fr');

    const r1 = mail.render('reminder-1', engine.loadInvoice(inv2), 'Beta Resort', TODAY);
    assert.match(r1.body, /500,00 €/, 'le reste dû (net de l\'acompte), pas le total (600 €)');
    assert.doesNotMatch(r1.body, /600,00 €/);
    await mail.sendReminder(inv2, { level: 1, to: 'beta@exemple.fr', subject: r1.subject, body: r1.body });
    assert.match(mail.render('reminder-2', engine.loadInvoice(inv2), 'Beta', TODAY).body, /40 €/);
    await assert.rejects(() => mail.sendReminder(inv3 + 999, { level: 1 }), /introuvable/);
    await assert.rejects(() => mail.sendReminder(inv2, { level: 4, to: 'a@b.fr', subject: 's', body: 'b' }), /Niveau/);

    // Relance par téléphone, notée à la main
    const manual = await mail.sendReminder(inv1, { level: 1, channel: 'manual', subject: 'Appelé le 24/10, promet un virement' });
    assert.equal(manual.logged, true);
    ov = mail.remindersOverview(TODAY);
    assert.equal(ov.find(o => o.id === inv1).reminderCount, 1);
    assert.equal(ov.find(o => o.id === inv1).suggestedLevel, null, 'pas de nouvelle relance avant 15 j de retard et 10 j après la dernière');
    assert.equal(mail.suggestLevel({ reminderCount: 1, overdueDays: 30, lastReminderAt: '2026-10-05 10:00:00' }, TODAY), 2);
    assert.equal(mail.suggestLevel({ reminderCount: 2, overdueDays: 45, lastReminderAt: '2026-10-05 10:00:00' }, TODAY), 3);
    assert.equal(mail.suggestLevel({ reminderCount: 0, overdueDays: 0 }, TODAY), null);

    // Échec SMTP : journalisé et remonté en 502
    mailer.sendMail = async () => { throw new Error('connexion refusée'); };
    await assert.rejects(() => mail.sendInvoice(inv3, { to: 'g@exemple.fr', subject: 's', body: 'b' }), (e) => e.status === 502 && /connexion refusée/.test(e.message));
    const failed = db.prepare("SELECT status, error FROM native_mail_log WHERE invoice_id = ? AND status = 'failed'").get(inv3);
    assert.match(failed.error, /connexion refusée/);

    // SMTP non configuré : 503, rien d'enregistré comme envoyé
    mailer.isConfigured = () => false;
    await assert.rejects(() => mail.sendInvoice(inv3, { to: 'g@exemple.fr', subject: 's', body: 'b' }), (e) => e.status === 503);

    // Historique immuable
    assert.throws(() => db.prepare('DELETE FROM native_mail_log').run(), /suppression interdite/);
    const tl = queries.timeline(inv2).map(x => x.type);
    assert.ok(tl.includes('mail:reminder-1'));
  } finally { mailer.sendMail = realSend; mailer.isConfigured = realCfg; }
});

test('facturation en lot : aperçu, brouillons, émission avec un échec isolé', () => {
  const delta = addClient('Domaine Delta', 'delta@exemple.fr', false); // pas de SIRET
  const mkOrder = (client, date, qty) => {
    const id = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`)
      .run(`CZ-${client}-${date}`, client, 'S', 'C', '06', 'adr', date).lastInsertRowid);
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(id, 'd', 'Drap', 'D', 'DRAP', 2, qty, qty);
    return id;
  };
  mkOrder(alpha, '2026-10-20', 100); mkOrder(alpha, '2026-10-22', 50); mkOrder(delta, '2026-10-21', 10); mkOrder(gamma, '2026-11-05', 10);

  let p = batch.preview('2026-10-31');
  assert.deepEqual(p.map(x => x.clientName), ['Domaine Delta', 'Hôtel Alpha']);
  assert.equal(p.find(x => x.clientName === 'Hôtel Alpha').estimatedHtCents, 30000);
  assert.deepEqual(p.find(x => x.clientName === 'Domaine Delta').issues, ['SIREN/SIRET manquant']);
  assert.equal(batch.preview('2026-11-30').length, 3, 'avec une date limite plus tardive, Gamma apparaît');

  const created = batch.createDrafts({ clientIds: [alpha, delta], upTo: '2026-10-31' });
  assert.ok(created.every(r => r.ok));
  assert.equal(batch.preview('2026-10-31').length, 0, 'plus rien à facturer : tous les BL sont dans des brouillons');

  const issued = batch.issueMany({ invoiceIds: created.map(r => r.invoiceId), issueDate: '2026-10-24' });
  const okOnes = issued.filter(r => r.ok); const bad = issued.filter(r => !r.ok);
  assert.equal(okOnes.length, 1); assert.match(okOnes[0].number, /^FA-2026-0000\d\d$/);
  assert.equal(bad.length, 1); assert.match(bad[0].error, /SIREN\/SIRET manquant/);
  assert.equal(engine.loadInvoice(bad[0].invoiceId).status, 'draft', 'le brouillon en échec reste intact');
  assert.deepEqual(engine.verifyIntegrity().problems, []);
});

test('rapprochement : lecture de relevés (formats français), propositions, application idempotente', () => {
  const csv = [
    'Compte courant;FR76 3000 1007 9412 3456 7890 185',
    'Période du 01/10/2026 au 24/10/2026',
    '',
    'Date opération;Date valeur;Libellé;Détail;Débit;Crédit',
    '05/10/2026;05/10/2026;VIR SEPA HOTEL ALPHA;PAIEMENT FA-2026-000001;;"1 200,00"',
    '12/10/2026;12/10/2026;VIR BETA RESORT;REGLEMENT;;"500,00"',
    '15/10/2026;15/10/2026;PRLV EDF;FACTURE ELEC;"85,40";',
    '20/10/2026;20/10/2026;VIR INCONNU SARL;DIVERS;;"42,00"',
    '21/10/2026;21/10/2026;VIR HOTEL ALPHA;SOLDE;;"1 320,00"',
  ].join('\n');
  const parsed = bank.parseBankCsv(csv);
  assert.equal(parsed.complete, true); assert.equal(parsed.delimiter, ';'); assert.equal(parsed.headerRow, 2, 'les lignes vides ne comptent pas');
  assert.deepEqual(parsed.lines.map(l => l.amountCents), [120000, 50000, -8540, 4200, 132000]);
  assert.equal(parsed.lines[0].label, 'VIR SEPA HOTEL ALPHA — PAIEMENT FA-2026-000001');

  const m = bank.matchLines(parsed.lines, TODAY);
  assert.equal(m[0].confidence, 'high'); assert.equal(m[0].candidates[0].invoiceId, inv1);
  assert.match(m[0].candidates[0].why.join(), /numéro de facture/);
  assert.equal(m[1].confidence, 'high'); assert.equal(m[1].candidates[0].invoiceId, inv2, 'montant = reste dû (500) + nom du client');
  assert.equal(m[2].credit, false); assert.equal(m[2].candidates.length, 0, 'un débit n\'est jamais rapproché');
  assert.equal(m[3].confidence, 'none');
  assert.ok(m[4].multi, 'virement groupé');
  assert.deepEqual(m[4].multi.allocations.map(a => a.invoiceId).sort(), [inv1, inv4].sort());

  // Application : une ligne simple + le virement groupé
  const items = [
    { fingerprint: m[1].fingerprint, date: m[1].date, label: m[1].label, allocations: [{ invoiceId: inv2, amountCents: 50000 }] },
    { fingerprint: m[4].fingerprint, date: m[4].date, label: m[4].label, allocations: m[4].multi.allocations.map(a => ({ invoiceId: a.invoiceId, amountCents: a.amountCents })) },
  ];
  let res = bank.apply(items);
  assert.ok(res.every(r => r.ok), JSON.stringify(res));
  assert.equal(engine.paymentStatus(engine.loadInvoice(inv2)), 'paid');
  assert.equal(engine.paymentStatus(engine.loadInvoice(inv1)), 'paid');
  assert.equal(engine.paymentStatus(engine.loadInvoice(inv4)), 'paid');

  // Réimport du même relevé : ignoré, rien n'est enregistré deux fois
  const again = bank.matchLines(bank.parseBankCsv(csv).lines, TODAY);
  assert.equal(again[1].alreadyImported, true); assert.equal(again[4].alreadyImported, true);
  res = bank.apply(items);
  assert.ok(res.every(r => !r.ok && /déjà été rapprochée|dépasse|soldée/i.test(r.error)), JSON.stringify(res));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM native_payments WHERE invoice_id = ?').get(inv2).c, 2, 'acompte + 1 seul règlement bancaire');

  // Le tableau de bord voit maintenant des factures soldées → délai moyen calculé
  assert.ok(queries.dashboard(TODAY).dsoDays > 0);
  assert.equal(queries.listPayments({ q: 'beta' }).payments.some(p => p.fromBank), true);
});

test('rapprochement : variantes de fichiers (virgule, colonnes signées, séparateur tabulation, dates ISO)', () => {
  const a = bank.parseBankCsv('date,libelle,montant\n2026-10-03,"VIR, ALPHA",1234.56\n2026-10-04,PRLV,-20.00\n');
  assert.deepEqual(a.lines.map(l => [l.date, l.amountCents, l.label]), [['2026-10-03', 123456, 'VIR, ALPHA'], ['2026-10-04', -2000, 'PRLV']]);
  const b = bank.parseBankCsv('Date\tLabel\tAmount\n03/10/26\tVirement\t1.234,56\n');
  assert.equal(b.lines[0].amountCents, 123456); assert.equal(b.lines[0].date, '2026-10-03');
  const c = bank.parseBankCsv('truc;machin\n1;2\n');
  assert.equal(c.complete, false, 'colonnes non reconnues : l\'écran demande de les indiquer');
  const d = bank.parseBankCsv('truc;machin\n03/10/2026;12,00\n', { delimiter: ';', headerRow: 0, dateCol: 0, labelCols: [], amountCol: 1 });
  assert.equal(d.lines[0].amountCents, 1200);
  assert.throws(() => bank.parseBankCsv('   '), /vide/);
});
