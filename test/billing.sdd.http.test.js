// Prélèvements SEPA de bout en bout par HTTP : verrou de la Facturation, ressaisie du code pour les actes sensibles,
// aucun IBAN complet dans les listes, fichier pain.008 et formulaire de mandat téléchargeables.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
const IBAN = 'FR7630006000011234567890189';
const ICS = 'FR72ZZZ123456';
let s; let db; let hotel; let invoiceId;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, `confirmation ${scope} : ${JSON.stringify(c.data)}`);
  return call(method, url, body);
}
const businessDay = (offset) => {
  const R = require('../src/billing/sddRules');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  return R.addBusinessDays(today, offset);
};

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number, adresse_facturation)
    VALUES ('h@x.fr','Hôtel Les Lavandes','Jean','0490123456','450 route de Malaucène','84380','Mazan','x','55210055400013','FR40552100554','Siège')`).run().lastInsertRowid);
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: IBAN, bic: 'AGRIFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = new Date(Date.now() - 20 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run('CZ-SDD', hotel, 'Hôtel', 'J', '06', 'adr', d).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
  const c = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o] });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  invoiceId = c.data.invoice.id;
  const i = await sensitive(`issue:${invoiceId}`, 'POST', `${B}/invoices/${invoiceId}/issue`, { issueDate: d });
  assert.equal(i.status, 200, JSON.stringify(i.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('sans session administrateur : accès refusé', async () => {
  const other = await startServer();
  try {
    for (const [m, u] of [['GET', '/sdd/overview'], ['GET', '/sdd/mandates'], ['POST', '/sdd/batches']]) {
      const r = await other.call(m, `${B}${u}`, m === 'POST' ? {} : undefined);
      assert.ok([401, 403].includes(r.status), `${m} ${u} : ${r.status}`);
    }
  } finally { await other.stop(); }
});

test('société pas prête : le tableau le dit, rien ne se prépare', async () => {
  const o = await call('GET', `${B}/sdd/overview`);
  assert.equal(o.status, 200);
  assert.equal(o.data.creditor.ready, false);
  assert.match(o.data.creditor.problems.join(' '), /ICS/);
  assert.equal(o.data.creditor.ibanMasked, 'FR76 **** 0189');
  assert.ok(!JSON.stringify(o.data).includes(IBAN));
  const p = await call('POST', `${B}/sdd/batches/preview`, { invoiceIds: [invoiceId], collectionDate: businessDay(3) });
  assert.equal(p.status, 200);
  assert.ok(p.data.problems.some(x => /ICS/.test(x)) && p.data.problems.some(x => /mandat actif/.test(x)));
});

test("l'ICS se règle après ressaisie du code, et il est contrôlé", async () => {
  const noCode = await call('PUT', `${B}/sdd/creditor`, { ics: ICS });
  assert.equal(noCode.status, 403); assert.equal(noCode.data.code, 'STEP_UP_REQUIRED');
  const bad = await sensitive('sdd-settings', 'PUT', `${B}/sdd/creditor`, { ics: 'FR12ZZZ123456' });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /clé de contrôle/);
  const ok = await sensitive('sdd-settings', 'PUT', `${B}/sdd/creditor`, { ics: ICS, noticeDays: 14 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.creditor.ready, true);
});

test('mandat : ressaisie du code, IBAN contrôlé, jamais renvoyé en clair', async () => {
  const body = { clientId: hotel, iban: IBAN, bic: 'AGRIFRPP', signedOn: '2026-09-01', scheme: 'CORE' };
  const noCode = await call('POST', `${B}/sdd/mandates`, body);
  assert.equal(noCode.status, 403);
  const bad = await sensitive('sdd-mandate', 'POST', `${B}/sdd/mandates`, { ...body, iban: 'FR7630006000011234567890188' });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /clé de contrôle/);
  const ok = await sensitive('sdd-mandate', 'POST', `${B}/sdd/mandates`, body);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.mandate.status, 'active'); assert.equal(ok.data.mandate.ibanMasked, 'FR76 **** 0189');
  const list = await call('GET', `${B}/sdd/mandates`);
  assert.equal(list.data.mandates.length, 1);
  assert.ok(!JSON.stringify(list.data).includes(IBAN));
  const sug = await call('GET', `${B}/sdd/mandates/suggest?clientId=${hotel}`);
  assert.match(sug.data.umr, /^CEZ-\d{4}-02$/);
  const dup = await sensitive('sdd-mandate', 'POST', `${B}/sdd/mandates`, body);
  assert.equal(dup.status, 409);
});

test('formulaire de mandat : PDF vierge libre ; copie du mandat enregistré seulement après ressaisie du code', async () => {
  const blank = await call('GET', `${B}/sdd/mandate-form?clientId=${hotel}&scheme=CORE`, undefined, true);
  assert.equal(blank.status, 200); assert.match(blank.headers.get('content-type'), /application\/pdf/);
  assert.equal(Buffer.from(await blank.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const id = (await call('GET', `${B}/sdd/mandates`)).data.mandates[0].id;
  const noCode = await call('GET', `${B}/sdd/mandates/${id}/pdf`, undefined, true);
  assert.equal(noCode.status, 403);
  await call('POST', `${B}/lock/confirm`, { code: CODE, scope: `sdd-copy:${id}` });
  const copy = await call('GET', `${B}/sdd/mandates/${id}/pdf`, undefined, true);
  assert.equal(copy.status, 200); assert.match(copy.headers.get('content-type'), /application\/pdf/);
});

let batchId;
test('lot : aperçu libre, création et fichier après ressaisie du code', async () => {
  const date = businessDay(3);
  const c = await call('GET', `${B}/sdd/candidates?collectionDate=${date}`);
  assert.equal(c.status, 200);
  assert.deepEqual(c.data.lines.map(l => l.invoiceId), [invoiceId]);
  assert.ok(!JSON.stringify(c.data).includes(IBAN));
  const p = await call('POST', `${B}/sdd/batches/preview`, { invoiceIds: [invoiceId], collectionDate: date });
  assert.equal(p.data.problems.length, 0); assert.equal(p.data.count, 1); assert.equal(p.data.debits[0].seqType, 'FRST');
  assert.ok(!JSON.stringify(p.data).includes(IBAN));

  const noCode = await call('POST', `${B}/sdd/batches`, { invoiceIds: [invoiceId], collectionDate: date });
  assert.equal(noCode.status, 403);
  const badDate = await sensitive('sdd-batch', 'POST', `${B}/sdd/batches`, { invoiceIds: [invoiceId], collectionDate: '2026-12-25' });
  assert.equal(badDate.status, 400); assert.match(badDate.data.error, /jour ouvré/);
  const ok = await sensitive('sdd-batch', 'POST', `${B}/sdd/batches`, { invoiceIds: [invoiceId], collectionDate: date });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  batchId = ok.data.batch.id;
  assert.equal(ok.data.batch.status, 'prepared'); assert.equal(ok.data.batch.totalCents, 12000);
  assert.ok(!JSON.stringify(ok.data).includes(IBAN));
  assert.ok(!JSON.stringify((await call('GET', `${B}/sdd/batches`)).data).includes(IBAN));
  assert.ok(!JSON.stringify((await call('GET', `${B}/sdd/batches/${batchId}`)).data).includes(IBAN));

  const f1 = await call('GET', `${B}/sdd/batches/${batchId}/file`, undefined, true);
  assert.equal(f1.status, 403, 'le fichier contient les IBAN : ressaisie du code');
  await call('POST', `${B}/lock/confirm`, { code: CODE, scope: `sdd-file:${batchId}` });
  const f2 = await call('GET', `${B}/sdd/batches/${batchId}/file`, undefined, true);
  assert.equal(f2.status, 200);
  assert.match(f2.headers.get('content-type'), /application\/xml/);
  assert.match(f2.headers.get('content-disposition'), /prelevements-sepa_\d{4}-\d{2}-\d{2}_CEZ-SDD-\d{14}-\d+\.xml/);
  assert.equal(f2.headers.get('cache-control'), 'no-store');
  const xml = await f2.text();
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes(`<IBAN>${IBAN}</IBAN>`) && xml.includes(`<Id>${ICS}</Id>`) && xml.includes('<InstdAmt Ccy="EUR">120.00</InstdAmt>'));
  assert.ok(xml.includes('<SeqTp>FRST</SeqTp>'));
});

test('envoi puis clôture : la clôture exige le code, et la date de prélèvement doit être atteinte', async () => {
  const sent = await call('POST', `${B}/sdd/batches/${batchId}/sent`, {});
  assert.equal(sent.status, 200); assert.equal(sent.data.batch.status, 'sent');
  const noCode = await call('POST', `${B}/sdd/batches/${batchId}/settle`, {});
  assert.equal(noCode.status, 403);
  const early = await sensitive(`sdd-settle:${batchId}`, 'POST', `${B}/sdd/batches/${batchId}/settle`, {});
  assert.equal(early.status, 400); assert.match(early.data.error, /pas encore eu lieu/);
  assert.equal((await call('GET', `${B}/invoices/${invoiceId}`)).data.invoice.paidCents, 0, 'rien d\'enregistré tant que le lot n\'est pas clôturé');

  // un autre lot ne peut pas partir avec la même facture
  const again = await sensitive('sdd-batch', 'POST', `${B}/sdd/batches`, { invoiceIds: [invoiceId], collectionDate: businessDay(4) });
  assert.equal(again.status, 400); assert.match(again.data.error, /déjà dans le lot/);

  const cancel = await call('POST', `${B}/sdd/batches/${batchId}/cancel`, { reason: 'Test' });
  assert.equal(cancel.status, 403);
  const ok = await sensitive(`sdd-cancel:${batchId}`, 'POST', `${B}/sdd/batches/${batchId}/cancel`, { reason: 'Essai terminé' });
  assert.equal(ok.status, 200); assert.equal(ok.data.batch.status, 'cancelled');
  const gone = await call('GET', `${B}/sdd/batches/${batchId}/file`, undefined, true);
  assert.equal(gone.status, 403);
});

test('verrouillée, toute la partie prélèvements répond « verrouillé » (423)', async () => {
  assert.equal((await call('POST', `${B}/lock/lock`, {})).status, 200);
  for (const [m, u] of [['GET', '/sdd/overview'], ['GET', '/sdd/mandates'], ['GET', '/sdd/candidates'], ['GET', '/sdd/batches'], ['POST', '/sdd/batches/preview']]) {
    const r = await call(m, `${B}${u}`, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 423, `${m} ${u}`);
  }
});

test('le journal garde la trace de chaque acte, sans IBAN complet', async () => {
  const actions = db.prepare('SELECT action FROM billing_events').all().map(r => r.action);
  for (const a of ['sdd_creditor_set', 'sdd_mandate_created', 'sdd_batch_created', 'sdd_batch_downloaded', 'sdd_batch_sent', 'sdd_batch_cancelled']) assert.ok(actions.includes(a), a);
  assert.ok(!db.prepare('SELECT detail_json FROM billing_events').all().some(r => r.detail_json.includes(IBAN)));
});
