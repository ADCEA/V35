// Prélèvements SEPA : règles de validation, fichier pain.008, mandats, préparation / envoi / clôture d'un lot.
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-sdd-'));
process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const sdd = require('../src/billing/sdd');
const R = require('../src/billing/sddRules');
const { buildPain008 } = require('../src/billing/sddXml');

const TODAY = engine.todayParis();
const IBAN_A = 'FR7630006000011234567890189';
const IBAN_B = 'DE89370400440532013000';
const IBAN_C = 'FR1420041010050500013M02606';
const ICS = 'FR72ZZZ123456';

// ---------- mini lecteur XML (le fichier doit être bien formé : balises appariées, entités valides) ----------
function parseXml(xml) {
  const root = { name: '#root', children: [], text: '' }; const stack = [root];
  const re = /<\?[^>]*\?>|<\/([\w:]+)>|<([\w:]+)((?:\s+[\w:]+="[^"]*")*)\s*(\/?)>|([^<]+)/g; let m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith('<?')) continue;
    if (m[1]) { const top = stack.pop(); assert.equal(top.name, m[1], `balise fermante inattendue </${m[1]}> (ouverte : <${top.name}>)`); continue; }
    if (m[2]) {
      const node = { name: m[2], attrs: Object.fromEntries([...(m[3] || '').matchAll(/([\w:]+)="([^"]*)"/g)].map(a => [a[1], a[2]])), children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!m[4]) stack.push(node);
      continue;
    }
    const t = m[5];
    assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(t), `entité invalide : ${t}`);
    stack[stack.length - 1].text += t.trim();
  }
  assert.equal(stack.length, 1, 'balises non refermées');
  return root.children[0];
}
const kids = (n, name) => n.children.filter(c => c.name === name);
const kid = (n, name) => { const k = kids(n, name); assert.equal(k.length, 1, `<${name}> attendu une fois dans <${n.name}>`); return k[0]; };
const at = (n, ...path) => path.reduce((x, p) => kid(x, p), n);

// ================= règles =================

test('IBAN : clé de contrôle, longueur par pays, zone SEPA', () => {
  assert.equal(R.ibanError(IBAN_A), null);
  assert.equal(R.ibanError('de89 3704 0044 0532 0130 00'), null, 'espaces et minuscules tolérés');
  assert.equal(R.ibanError(IBAN_C), null);
  assert.match(R.ibanError('FR7630006000011234567890188'), /clé de contrôle/);
  assert.match(R.ibanError('FR76300060000112345678901'), /27 caractères attendus/);
  assert.match(R.ibanError('US64SVBKUS6S3300958879'), /hors zone SEPA/);
  assert.match(R.ibanError(''), /manquant/);
  assert.equal(R.maskIban(IBAN_A), 'FR76 **** 0189');
  assert.ok(!R.maskIban(IBAN_A).includes('3000'));
});

test('ICS : format français et clé de contrôle (exemple officiel EPC DE98ZZZ09999999999)', () => {
  assert.equal(R.icsError('DE98ZZZ09999999999'), null);
  assert.equal(R.icsError(ICS), null);
  assert.equal(R.icsError('fr72 zzz 123456'), null);
  assert.match(R.icsError('FR12ZZZ123456'), /devrait être 72/);
  assert.match(R.icsError('FR72ZZZ12345'), /13 caractères/);
  assert.match(R.icsError(''), /manquant/);
});

test('RUM : 35 caractères, jeu restreint, pas de « / » aux bords', () => {
  assert.equal(R.umrError('CEZ-0012-01'), null);
  assert.match(R.umrError('x'.repeat(36)), /35 caractères/);
  assert.match(R.umrError('Hôtel 1'), /sans accent/);
  assert.match(R.umrError('/ABC'), /« \/ »/);
  assert.match(R.umrError('A//B'), /« \/ »/);
});

test('calendrier TARGET : week-ends, Pâques, 1er mai, Noël ; jours ouvrés', () => {
  assert.equal(R.easter(2026), '2026-04-05');
  assert.equal(R.easter(2027), '2027-03-28');
  for (const d of ['2026-10-24', '2026-10-25', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25', '2026-12-26', '2027-01-01']) assert.equal(R.isBusinessDay(d), false, d);
  for (const d of ['2026-10-23', '2026-10-26', '2026-05-04', '2026-07-14', '2026-11-11']) assert.equal(R.isBusinessDay(d), true, `${d} (férié en France mais TARGET ouvre)`);
  assert.equal(R.nextBusinessDay('2026-10-24'), '2026-10-26');
  assert.equal(R.addBusinessDays('2026-10-23', 1), '2026-10-26');
  assert.equal(R.addBusinessDays('2026-04-02', 1), '2026-04-07', 'Vendredi saint et lundi de Pâques sautés');
  assert.equal(R.addMonths('2026-02-28', 36), '2029-02-28');
  assert.equal(R.addMonths('2024-02-29', 12), '2025-02-28');
});

test('texte SEPA : accents retirés, « & » remplacé, caractères interdits supprimés, identifiants sans « / » aux bords', () => {
  assert.equal(R.sepaText('Hôtel Mas & Co — Œuf d’été #12', 70), "Hotel Mas ET Co - OEuf d'ete 12");
  assert.equal(R.sepaText('a'.repeat(100), 70).length, 70);
  assert.equal(R.sepaId('FA 2026/0001'), 'FA-2026/0001');
  assert.equal(R.sepaId('/x//y/'), 'x/y');
  assert.equal(R.amount(123456), '1234.56'); assert.equal(R.amount(5), '0.05'); assert.equal(R.amount(100), '1.00');
});

// ================= fichier pain.008 =================

test('pain.008 : structure, totaux de contrôle, regroupement FRST/RCUR, jeu de caractères', () => {
  const items = [
    { scheme: 'CORE', seqType: 'RCUR', endToEndId: 'FA-2026-000002', amountCents: 5000, umr: 'CEZ-0002-01', signedOn: '2025-01-10', debtorName: 'Hôtel Beta & Fils', debtorIban: IBAN_B, debtorBic: null, remittance: 'Facture FA-2026-000002' },
    { scheme: 'CORE', seqType: 'FRST', endToEndId: 'FA-2026-000001', amountCents: 12345, umr: 'CEZ-0001-01', signedOn: '2026-02-01', debtorName: 'Résidence Œil-de-Bœuf', debtorIban: IBAN_A, debtorBic: 'AGRIFRPP', remittance: 'Facture FA-2026-000001' },
    { scheme: 'B2B', seqType: 'RCUR', endToEndId: 'CEZ9-3', amountCents: 1, umr: 'CEZ-0003-01', signedOn: '2025-05-05', debtorName: 'Gamma', debtorIban: IBAN_C, debtorBic: null, remittance: 'Factures A B' },
  ];
  const xml = buildPain008({ msgId: 'CEZ-SDD-20261024140000-7', createdAt: '2026-10-24T12:00:00.000Z', collectionDate: '2026-10-28', creditor: { name: 'Blanchisserie Cézanne & Co', iban: IBAN_A, bic: null, ics: ICS } }, items);
  const doc = parseXml(xml);
  assert.equal(doc.name, 'Document');
  assert.equal(doc.attrs.xmlns, 'urn:iso:std:iso:20022:tech:xsd:pain.008.001.02');
  const root = kid(doc, 'CstmrDrctDbtInitn');
  const hdr = kid(root, 'GrpHdr');
  assert.deepEqual(hdr.children.map(c => c.name), ['MsgId', 'CreDtTm', 'NbOfTxs', 'CtrlSum', 'InitgPty']);
  assert.equal(at(hdr, 'NbOfTxs').text, '3');
  assert.equal(at(hdr, 'CtrlSum').text, '173.46');
  assert.equal(at(hdr, 'CreDtTm').text, '2026-10-24T12:00:00');
  assert.equal(at(hdr, 'InitgPty', 'Nm').text, 'Blanchisserie Cezanne ET Co');

  const blocks = kids(root, 'PmtInf');
  assert.deepEqual(blocks.map(b => `${at(b, 'PmtTpInf', 'LclInstrm', 'Cd').text}/${at(b, 'PmtTpInf', 'SeqTp').text}`), ['CORE/FRST', 'CORE/RCUR', 'B2B/RCUR'], 'ordre fixe, un bloc par type');
  let sum = 0;
  for (const b of blocks) {
    // ordre des éléments imposé par le schéma
    assert.deepEqual(b.children.map(c => c.name).filter(n => n !== 'DrctDbtTxInf'),
      ['PmtInfId', 'PmtMtd', 'BtchBookg', 'NbOfTxs', 'CtrlSum', 'PmtTpInf', 'ReqdColltnDt', 'Cdtr', 'CdtrAcct', 'CdtrAgt', 'ChrgBr', 'CdtrSchmeId']);
    assert.equal(b.children.at(-1).name, 'DrctDbtTxInf');
    assert.equal(at(b, 'PmtMtd').text, 'DD');
    assert.equal(at(b, 'PmtTpInf', 'SvcLvl', 'Cd').text, 'SEPA');
    assert.equal(at(b, 'ReqdColltnDt').text, '2026-10-28');
    assert.equal(at(b, 'ChrgBr').text, 'SLEV');
    assert.equal(at(b, 'CdtrSchmeId', 'Id', 'PrvtId', 'Othr', 'Id').text, ICS);
    assert.equal(at(b, 'CdtrSchmeId', 'Id', 'PrvtId', 'Othr', 'SchmeNm', 'Prtry').text, 'SEPA');
    assert.equal(at(b, 'CdtrAgt', 'FinInstnId', 'Othr', 'Id').text, 'NOTPROVIDED', 'pas de BIC : NOTPROVIDED');
    const txs = kids(b, 'DrctDbtTxInf');
    assert.equal(Number(at(b, 'NbOfTxs').text), txs.length);
    const blockSum = txs.reduce((s, t) => s + Math.round(Number(at(t, 'InstdAmt').text) * 100), 0);
    assert.equal(at(b, 'CtrlSum').text, R.amount(blockSum));
    sum += blockSum;
    for (const t of txs) {
      assert.deepEqual(t.children.map(c => c.name), ['PmtId', 'InstdAmt', 'DrctDbtTx', 'DbtrAgt', 'Dbtr', 'DbtrAcct', 'RmtInf']);
      assert.equal(at(t, 'InstdAmt').attrs.Ccy, 'EUR');
      assert.match(at(t, 'DrctDbtTx', 'MndtRltdInf', 'DtOfSgntr').text, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  assert.equal(sum, 17346);
  const first = kids(blocks[0], 'DrctDbtTxInf')[0];
  assert.equal(at(first, 'DbtrAgt', 'FinInstnId', 'BIC').text, 'AGRIFRPP');
  assert.equal(at(first, 'Dbtr', 'Nm').text, 'Residence OEil-de-Boeuf');
  assert.equal(at(first, 'DbtrAcct', 'Id', 'IBAN').text, IBAN_A);
  assert.equal(at(first, 'InstdAmt').text, '123.45');
  // tout le texte du fichier respecte le jeu SEPA (hors balises) : pas d'accent, pas de « & » brut
  const text = xml.replace(/<[^>]+>/g, ' ');
  assert.ok(!/[^\x20-\x7E\n]/.test(text), 'ASCII seulement');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml));
  assert.throws(() => buildPain008({ msgId: 'X', createdAt: '2026-10-24T12:00:00Z', collectionDate: '2026-10-28', creditor: {} }, []), /vide/);
});

// ================= moteur =================

function luhnComplete(prefix) { for (let d = 0; d < 10; d++) if (engine.luhnOk(prefix + d)) return prefix + d; }
const siret = (n) => luhnComplete(luhnComplete(String(10000000 + n)) + '0001');
let nClient = 0;
function addClient(societe) {
  nClient++;
  return Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret)
    VALUES (?,?,?,?,?,?,?,'x',?)`).run(`h${nClient}@exemple.fr`, societe, 'Contact', '06', '1 rue du Test', '84000', 'Avignon', siret(40000 + nClient)).lastInsertRowid);
}
const daysAgo = (n) => R.addDays(TODAY, -n);
function invoice(clientId, priceHt, issueDate) {
  const d = engine.createDraftFromLines(clientId, [{ description: 'Prestation', quantity: 1, unitPrice: priceHt, vatRate: 20 }]);
  return engine.issueInvoice(d.id, { issueDate });
}
const COLLECT = R.addBusinessDays(TODAY, 3);
const balances = (...ids) => ids.map(id => engine.balanceCents(engine.loadInvoice(id)));

let alpha, beta, gamma, delta; let fa1, fa2, fb1, fg1, fd1;

test('mise en place : société prête à prélever, quatre hôtels, factures émises', () => {
  db.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', iban=?, bic='AGRIFRPP' WHERE id=1`).run(IBAN_A);
  alpha = addClient('Hôtel Alpha'); beta = addClient('Beta Resort & Spa'); gamma = addClient('Résidence Gamma'); delta = addClient('Delta');
  // la numérotation est chronologique : on émet de la plus ancienne à la plus récente
  fd1 = invoice(delta, 10, daysAgo(30)).id;    // 12,00 € TTC, Delta n'aura pas de mandat
  fa1 = invoice(alpha, 100, daysAgo(20)).id;   // 120,00 €
  fb1 = invoice(beta, 200, daysAgo(15)).id;    // 240,00 €
  fa2 = invoice(alpha, 50, daysAgo(10)).id;    // 60,00 €
  fg1 = invoice(gamma, 75, daysAgo(2)).id;     // 90,00 €, émise il y a 2 jours
  assert.deepEqual(balances(fa1, fa2, fb1, fg1, fd1), [12000, 6000, 24000, 9000, 1200]);
});

test("créancier : tant que l'ICS manque, rien ne se prépare ; l'ICS est contrôlé", () => {
  assert.equal(sdd.creditor().ready, false);
  assert.match(sdd.creditor().problems.join(' '), /ICS/);
  assert.throws(() => sdd.setCreditor({ ics: 'FR12ZZZ123456' }), /clé de contrôle/);
  assert.throws(() => sdd.setCreditor({ noticeDays: 0 }), /entre 1 et 60/);
  assert.throws(() => sdd.setCreditor({}), /Rien à enregistrer/);
  const c = sdd.setCreditor({ ics: 'fr72 zzz 123456', noticeDays: 14 });
  assert.equal(c.ready, true); assert.equal(c.ics, ICS); assert.equal(c.ibanMasked, 'FR76 **** 0189');
  assert.ok(!('iban' in c), 'jamais d\'IBAN complet dans la réponse');
});

test('mandats : contrôles, référence proposée, un seul mandat actif par hôtel, remplacement', () => {
  assert.equal(sdd.suggestUmr(alpha), `CEZ-${String(alpha).padStart(4, '0')}-01`);
  const base = { clientId: alpha, iban: IBAN_A, signedOn: daysAgo(40) };
  assert.throws(() => sdd.createMandate({ ...base, iban: 'FR7630006000011234567890188' }), /clé de contrôle/);
  assert.throws(() => sdd.createMandate({ ...base, bic: 'XX' }), /BIC invalide/);
  assert.throws(() => sdd.createMandate({ ...base, signedOn: R.addDays(TODAY, 1) }), /futur/);
  assert.throws(() => sdd.createMandate({ ...base, signedOn: '2010-01-01' }), /2014/);
  assert.throws(() => sdd.createMandate({ ...base, scheme: 'XXX' }), /CORE ou B2B/);
  assert.throws(() => sdd.createMandate({ ...base, umr: 'Hôtel 1' }), /sans accent/);
  assert.throws(() => sdd.createMandate({ ...base, clientId: 99999 }), /introuvable/);

  const m1 = sdd.createMandate({ ...base, bic: 'agrifrpp' });
  assert.equal(m1.umr, `CEZ-${String(alpha).padStart(4, '0')}-01`); assert.equal(m1.status, 'active'); assert.equal(m1.bic, 'AGRIFRPP');
  assert.equal(m1.ibanMasked, 'FR76 **** 0189'); assert.equal(m1.debtorName, 'Hôtel Alpha');
  assert.throws(() => sdd.createMandate({ ...base, iban: IBAN_B }), /déjà un mandat actif/);
  assert.throws(() => sdd.createMandate({ clientId: beta, iban: IBAN_B, signedOn: daysAgo(10), umr: m1.umr }), /déjà utilisée/);
  // changement de banque : l'ancien mandat est révoqué, le nouveau prend une nouvelle référence
  const m2 = sdd.createMandate({ ...base, iban: IBAN_C, replace: true });
  assert.notEqual(m2.umr, m1.umr);
  const all = sdd.listMandates({ clientId: alpha });
  assert.deepEqual(all.map(m => m.status), ['active', 'revoked']);
  assert.equal(all[1].revokedReason, 'Remplacé par un nouveau mandat');
  // on repart du premier compte pour la suite
  sdd.createMandate({ ...base, iban: IBAN_A, replace: true });
  sdd.createMandate({ clientId: beta, iban: IBAN_B, signedOn: daysAgo(100), scheme: 'CORE' });
  sdd.createMandate({ clientId: gamma, iban: IBAN_C, signedOn: daysAgo(5), umr: 'GAMMA-1' });
  assert.equal(sdd.listMandates({ status: 'active' }).length, 3);
});

test('mandats : jamais supprimés ni modifiés (seule la révocation est possible)', () => {
  const id = db.prepare("SELECT id FROM sdd_mandates WHERE status = 'active' LIMIT 1").get().id;
  assert.throws(() => db.prepare('DELETE FROM sdd_mandates WHERE id = ?').run(id), /suppression interdite/);
  assert.throws(() => db.prepare("UPDATE sdd_mandates SET iban = 'FR0000' WHERE id = ?").run(id), /modification interdite/);
  assert.throws(() => db.prepare("UPDATE sdd_mandates SET umr = 'X' WHERE id = ?").run(id), /modification interdite/);
  const revoked = db.prepare("SELECT id FROM sdd_mandates WHERE status = 'revoked' LIMIT 1").get().id;
  assert.throws(() => db.prepare("UPDATE sdd_mandates SET status = 'active' WHERE id = ?").run(revoked), /modification interdite/);
});

test('à prélever : factures des hôtels avec mandat, hôtels sans mandat à part, avertissements', () => {
  const c = sdd.candidates({ collectionDate: COLLECT });
  assert.equal(c.creditor.ready, true);
  assert.equal(c.dateProblem, null);
  assert.deepEqual(c.lines.map(l => l.invoiceId).sort(), [fa1, fa2, fb1, fg1].sort());
  assert.deepEqual(c.noMandate.map(g => [g.clientName, g.count, g.balanceCents]), [['Delta', 1, 1200]]);
  assert.ok(c.lines.every(l => l.firstCollection === true && !l.blocked));
  const g = c.lines.find(l => l.invoiceId === fg1);
  assert.ok(g.warnings.some(w => /Préavis de 14 jours/.test(w)), 'facture émise il y a 2 jours : préavis court');
  assert.ok(g.warnings.some(w => /avant l'échéance/.test(w)));
  const a = c.lines.find(l => l.invoiceId === fa1);
  assert.ok(!a.warnings.some(w => /Préavis/.test(w)));
  assert.ok(c.lines.every(l => /^FR76 \*\*\*\* 0189$|^DE89 \*\*\*\* 3000$|^FR14 \*\*\*\* 2606$/.test(l.ibanMasked)));
  // date inutilisable : signalée dans la réponse
  assert.match(sdd.candidates({ collectionDate: '2026-12-25' }).dateProblem, /jour ouvré/);
});

test('préparation : un prélèvement par hôtel (factures réunies), premier prélèvement FRST, refus clairs', () => {
  const base = { invoiceIds: [fa1, fa2, fb1], collectionDate: COLLECT };
  const p = sdd.plan(base);
  assert.deepEqual(p.problems, []);
  assert.equal(p.count, 2); assert.equal(p.invoiceCount, 3); assert.equal(p.totalCents, 12000 + 6000 + 24000);
  const dAlpha = p.debits.find(d => d.clientId === alpha);
  assert.equal(dAlpha.amountCents, 18000); assert.equal(dAlpha.seqType, 'FRST'); assert.equal(dAlpha.invoices.length, 2);
  assert.match(dAlpha.remittance, /^Factures FA-\d{4}-\d{6} FA-\d{4}-\d{6}$/);

  const bad = (b) => sdd.plan({ ...base, ...b }).problems.join(' | ');
  assert.match(bad({ collectionDate: R.addDays(TODAY, 0) }), /trop proche|jour ouvré/);
  assert.match(bad({ collectionDate: '2026-12-25' }), /jour ouvré/);
  assert.match(bad({ collectionDate: R.addDays(TODAY, 200) }), /trop lointaine|jour ouvré/);
  assert.match(bad({ invoiceIds: [fd1] }), /n'a pas de mandat actif/);
  assert.match(bad({ invoiceIds: [987654] }), /introuvable/);
  assert.throws(() => sdd.plan({ collectionDate: COLLECT, invoiceIds: [] }), /Cochez/);
  assert.throws(() => sdd.plan({ collectionDate: COLLECT, invoiceIds: ['x'] }), /invalide/);
  // l'aperçu ne contient jamais d'IBAN complet
  const json = JSON.stringify(sdd.preview(base));
  for (const iban of [IBAN_A, IBAN_B, IBAN_C]) assert.ok(!json.includes(iban));
});

test("création d'un lot : atomique, un seul lot préparé à la fois, factures réservées", () => {
  const before = db.prepare('SELECT COUNT(*) c FROM sdd_batches').get().c;
  assert.throws(() => sdd.createBatch({ invoiceIds: [fa1, fd1], collectionDate: COLLECT }), /rien n'a été préparé/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sdd_batches').get().c, before, 'aucun lot à moitié créé');

  const b = sdd.createBatch({ invoiceIds: [fa1, fa2, fb1], collectionDate: COLLECT });
  assert.equal(b.status, 'prepared'); assert.equal(b.itemCount, 2); assert.equal(b.totalCents, 42000);
  assert.match(b.msgId, /^CEZ-SDD-\d{14}-\d+$/); assert.ok(b.msgId.length <= 35);
  assert.deepEqual(b.items.map(i => i.seqType), ['FRST', 'FRST']);
  const iAlpha = b.items.find(i => i.clientName === 'Hôtel Alpha');
  assert.equal(iAlpha.invoices.length, 2); assert.match(iAlpha.endToEndId, /^CEZ\d+-\d+$/);
  const iBeta = b.items.find(i => i.clientName.startsWith('Beta'));
  assert.equal(iBeta.endToEndId, engine.loadInvoice(fb1).number, 'une seule facture : son numéro sert de référence');

  assert.throws(() => sdd.createBatch({ invoiceIds: [fg1], collectionDate: COLLECT }), /déjà préparé/);
  const c = sdd.candidates({ collectionDate: COLLECT });
  assert.deepEqual(c.lines.map(l => l.invoiceId), [fg1], 'les factures du lot ne sont plus proposées');
  assert.equal(c.engagedInvoices, 3); assert.equal(c.preparedBatch.id, b.id);
  assert.match(sdd.plan({ invoiceIds: [fa1], collectionDate: COLLECT }).problems.join(' '), /déjà dans le lot/);
  // un mandat engagé dans un lot ne peut pas être révoqué
  assert.throws(() => sdd.revokeMandate(iAlpha.mandateId, { reason: 'test' }), /pas terminé/);
  // lot figé
  assert.throws(() => db.prepare("UPDATE sdd_batches SET total_cents = 1 WHERE id = ?").run(b.id), /modification interdite/);
  assert.throws(() => db.prepare("UPDATE sdd_batch_items SET amount_cents = 1 WHERE batch_id = ?").run(b.id), /modification interdite/);
  assert.throws(() => db.prepare("DELETE FROM sdd_batch_items WHERE batch_id = ?").run(b.id), /suppression interdite/);
  assert.throws(() => db.prepare("DELETE FROM sdd_batches WHERE id = ?").run(b.id), /suppression interdite/);
  assert.throws(() => db.prepare("DELETE FROM sdd_item_invoices").run(), /suppression interdite/);
});

test('fichier du lot : régénéré à l\'identique, totaux justes, IBAN présents dans le fichier seulement', () => {
  const b = sdd.listBatches()[0];
  const a = sdd.batchXml(b.id); const again = sdd.batchXml(b.id);
  assert.equal(a.xml, again.xml, 'même fichier à chaque téléchargement');
  assert.match(a.filename, new RegExp(`^prelevements-sepa_${COLLECT}_CEZ-SDD-\\d{14}-\\d+\\.xml$`));
  const doc = parseXml(a.xml);
  assert.equal(at(doc, 'CstmrDrctDbtInitn', 'GrpHdr', 'CtrlSum').text, '420.00');
  assert.equal(at(doc, 'CstmrDrctDbtInitn', 'GrpHdr', 'MsgId').text, b.msgId);
  assert.ok(a.xml.includes(IBAN_A) && a.xml.includes(IBAN_B));
  assert.ok(a.xml.includes(`<ReqdColltnDt>${COLLECT}</ReqdColltnDt>`));
  // le journal ne contient aucun IBAN complet
  const journal = db.prepare('SELECT detail_json FROM billing_events').all().map(r => r.detail_json).join('\n');
  for (const iban of [IBAN_A, IBAN_B, IBAN_C]) assert.ok(!journal.includes(iban), `IBAN ${iban.slice(0, 4)}… absent du journal`);
  assert.ok(db.prepare("SELECT 1 FROM billing_events WHERE action = 'sdd_batch_downloaded'").get());
  assert.ok(db.prepare("SELECT 1 FROM billing_events WHERE action = 'sdd_batch_created'").get());
  assert.deepEqual(engine.verifyIntegrity().problems, [], 'journal toujours intègre');
});

test('annulation : motif obligatoire, factures libérées, plus de fichier', () => {
  const b = sdd.listBatches()[0];
  assert.throws(() => sdd.cancelBatch(b.id, { reason: '' }), /motif/);
  const c = sdd.cancelBatch(b.id, { reason: 'Mauvaise date' });
  assert.equal(c.status, 'cancelled'); assert.equal(c.cancelReason, 'Mauvaise date');
  assert.throws(() => sdd.batchXml(b.id), /annulé/);
  assert.throws(() => sdd.cancelBatch(b.id, { reason: 'encore' }), /déjà annulé/);
  assert.throws(() => sdd.markSent(b.id), /préparé/);
  assert.throws(() => db.prepare("UPDATE sdd_batches SET status = 'prepared' WHERE id = ?").run(b.id), /modification interdite/);
  assert.equal(sdd.candidates({ collectionDate: COLLECT }).lines.length, 4, 'les quatre factures sont de nouveau proposées');
  assert.deepEqual(balances(fa1, fa2, fb1), [12000, 6000, 24000], 'rien n\'a été encaissé');
});

let batch1; let itemAlpha; let itemBeta;
test('envoi à la banque : le lot passe à « envoyé » ; la date de prélèvement ne doit pas être atteinte', () => {
  batch1 = sdd.createBatch({ invoiceIds: [fa1, fa2, fb1], collectionDate: COLLECT });
  assert.throws(() => sdd.settle(batch1.id, {}), /Envoyé/);
  const sent = sdd.markSent(batch1.id);
  assert.equal(sent.status, 'sent'); assert.ok(sent.sentAt);
  assert.throws(() => sdd.markSent(batch1.id), /préparé/);
  assert.equal(sdd.overview().sent, 1);
  assert.throws(() => sdd.settle(batch1.id, {}), /pas encore eu lieu/);
  itemAlpha = sdd.getBatch(batch1.id).items.find(i => i.clientName === 'Hôtel Alpha');
  itemBeta = sdd.getBatch(batch1.id).items.find(i => i.clientName.startsWith('Beta'));
  // un autre lot peut être préparé pendant que le premier est chez la banque ; les prélèvements suivants d'un mandat déjà engagé sont récurrents
  const b2 = sdd.plan({ invoiceIds: [fg1], collectionDate: COLLECT });
  assert.deepEqual(b2.problems, []);
});

test('clôture : règlements enregistrés (mode prélèvement), rejet = reste impayé, mandat révoqué, tout ou rien', () => {
  // le temps passe : la date de prélèvement est atteinte (la protection du lot est levée pour le test uniquement)
  db.exec('DROP TRIGGER trg_sdd_batches_no_update');
  db.prepare('UPDATE sdd_batches SET collection_date = ? WHERE id = ?').run(daysAgo(1), batch1.id);

  // un règlement saisi entre-temps sur une facture du lot : la clôture est refusée et RIEN n'est enregistré
  engine.recordPayment(fa1, { paidOn: daysAgo(1), amount: 20, method: 'virement', reference: 'acompte' });
  assert.throws(() => sdd.settle(batch1.id, {}), /inférieur au prélèvement/);
  assert.deepEqual(balances(fa1, fa2, fb1), [10000, 6000, 24000], 'aucune écriture partielle');
  assert.equal(sdd.getBatch(batch1.id).status, 'sent');
  engine.recordPayment(fa1, { paidOn: daysAgo(1), amount: -20, method: 'virement', reference: 'annulation' });
  assert.deepEqual(balances(fa1, fa2, fb1), [12000, 6000, 24000]);

  assert.throws(() => sdd.settle(batch1.id, { rejections: [{ itemId: 424242, reason: 'x' }] }), /inconnu/);
  assert.throws(() => sdd.settle(batch1.id, { rejections: [{ itemId: itemBeta.id, reason: '' }] }), /motif du rejet/);

  const r = sdd.settle(batch1.id, { rejections: [{ itemId: itemBeta.id, reason: 'Provision insuffisante (AM04)', revokeMandate: true }] });
  assert.equal(r.collected, 1); assert.equal(r.rejected, 1); assert.equal(r.collectedCents, 18000); assert.equal(r.payments, 2);
  assert.deepEqual(r.revokedMandates, [itemBeta.umr]);
  assert.deepEqual(balances(fa1, fa2, fb1), [0, 0, 24000], 'Alpha soldé, Beta reste dû');
  assert.equal(r.batch.status, 'settled'); assert.equal(r.batch.collectedCents, 18000); assert.equal(r.batch.rejectedCents, 24000);

  const pays = db.prepare("SELECT invoice_id, paid_on, amount_cents, method, reference FROM native_payments WHERE method = 'prelevement' ORDER BY id").all();
  assert.equal(pays.length, 2);
  assert.ok(pays.every(p => p.paid_on === daysAgo(1) && p.reference.startsWith(`Prélèvement SEPA ${batch1.msgId}`)));
  assert.deepEqual(pays.map(p => p.amount_cents), [12000, 6000]);
  const items = sdd.getBatch(batch1.id).items;
  assert.equal(items.find(i => i.id === itemAlpha.id).status, 'collected');
  assert.equal(items.find(i => i.id === itemBeta.id).status, 'rejected');
  assert.equal(items.find(i => i.id === itemBeta.id).rejectReason, 'Provision insuffisante (AM04)');
  assert.equal(sdd.listMandates({ clientId: beta })[0].status, 'revoked');
  assert.match(sdd.listMandates({ clientId: beta })[0].revokedReason, /Prélèvement rejeté/);
  for (const a of ['sdd_batch_settled', 'sdd_item_rejected', 'sdd_mandate_revoked', 'payment_recorded']) assert.ok(db.prepare('SELECT 1 FROM billing_events WHERE action = ?').get(a), a);
  assert.throws(() => sdd.settle(batch1.id, {}), /déjà clôturé/);
  assert.throws(() => sdd.cancelBatch(batch1.id, { reason: 'trop tard' }), /déjà encaissé/);
  assert.throws(() => db.prepare("UPDATE sdd_batch_items SET status = 'rejected' WHERE id = ?").run(itemAlpha.id), /modification interdite/);
});

test('séquence : le premier prélèvement abouti rend les suivants récurrents (RCUR) ; un premier rejeté reste FRST', () => {
  // Alpha a été prélevé : sa prochaine facture part en RCUR. Beta (premier rejeté, mandat révoqué) repart d'un nouveau mandat : FRST.
  const fa3 = invoice(alpha, 10, daysAgo(1)).id;
  sdd.createMandate({ clientId: beta, iban: IBAN_B, signedOn: daysAgo(1) });
  const p = sdd.plan({ invoiceIds: [fa3, fb1, fg1], collectionDate: COLLECT });
  assert.deepEqual(p.problems, []);
  const seq = Object.fromEntries(p.debits.map(d => [d.clientName, d.seqType]));
  assert.deepEqual(seq, { 'Hôtel Alpha': 'RCUR', 'Beta Resort & Spa': 'FRST', 'Résidence Gamma': 'FRST' });
  const b = sdd.createBatch({ invoiceIds: [fa3, fb1, fg1], collectionDate: COLLECT });
  const xml = parseXml(sdd.batchXml(b.id).xml);
  const blocks = kids(at(xml, 'CstmrDrctDbtInitn'), 'PmtInf');
  assert.deepEqual(blocks.map(x => at(x, 'PmtTpInf', 'SeqTp').text), ['FRST', 'RCUR']);
  assert.equal(at(xml, 'CstmrDrctDbtInitn', 'GrpHdr', 'NbOfTxs').text, '3');
  sdd.cancelBatch(b.id, { reason: 'Test' });
});

test('mandat caduc : 36 mois sans prélèvement, le mandat ne part plus', () => {
  const eps = addClient('Epsilon');
  const fe = invoice(eps, 10, TODAY).id;
  const m = sdd.createMandate({ clientId: eps, iban: IBAN_C, signedOn: '2022-01-15' });
  assert.equal(m.expired, true); assert.equal(m.expiresOn, '2025-01-15');
  const c = sdd.candidates({ collectionDate: COLLECT });
  assert.match(c.lines.find(l => l.invoiceId === fe).blocked, /caduc/);
  assert.match(sdd.plan({ invoiceIds: [fe], collectionDate: COLLECT }).problems.join(' '), /caduc/);
  assert.equal(sdd.overview().mandates, sdd.listMandates({ status: 'active' }).length);
});

test('révocation : motif obligatoire ; un mandat révoqué ne peut plus servir', () => {
  const m = sdd.listMandates({ clientId: gamma })[0];
  assert.throws(() => sdd.revokeMandate(m.id, { reason: '' }), /motif/);
  const r = sdd.revokeMandate(m.id, { reason: 'Hôtel fermé' });
  assert.equal(r.status, 'revoked'); assert.equal(r.revokedOn, TODAY);
  assert.throws(() => sdd.revokeMandate(m.id, { reason: 'encore' }), /déjà révoqué/);
  assert.match(sdd.plan({ invoiceIds: [fg1], collectionDate: COLLECT }).problems.join(' '), /pas de mandat actif/);
});
