// Client suisse : n° IDE (CHE-123.456.789) à la place du SIRET, de la fiche à la facture émise.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');
const engine = require('../src/billing/engine');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
const UID = 'CHE-109.656.756';   // clé de contrôle correcte (SS Catherine)
let s; let db;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, `confirmation ${scope} : ${JSON.stringify(c.data)}`);
  return call(method, url, body);
}
let n = 0;
async function invoiceFor(clientId, issueDate) {
  n += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-CH-${n}`, clientId, 'Client', 'J', '06', 'adr', issueDate).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
  const c = await call('POST', `${B}/invoices`, { clientId, orderIds: [o] });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.invoice.id;
  return { id, issue: () => sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate }) };
}

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('n° IDE : écritures acceptées, clé de contrôle vérifiée, jamais pris pour un SIREN', () => {
  for (const v of ['CHE-109.656.756', 'CHE109656756', 'che 109 656 756', 'CHE-109.656.756 TVA', 'CHE-109.656.756 MWST']) {
    assert.equal(engine.swissUid(v), UID, v);
    assert.deepEqual(engine.cleanClientRegistry(v), { value: UID }, v);
  }
  for (const v of ['CHE-109.656.757', 'CHE-109.656', 'CHE-abc.def.ghi', 'CHEZ-109.656.756']) {
    assert.equal(engine.swissUid(v), '', v);
    assert.match(engine.cleanClientRegistry(v).error, /IDE suisse invalide/, v);
  }
  assert.deepEqual(engine.cleanClientRegistry(''), { value: null });
  assert.deepEqual(engine.cleanClientRegistry('552 100 554 00013'), { value: '55210055400013' }, 'un SIRET français reste accepté');
  assert.match(engine.cleanClientRegistry('123').error, /14 chiffres/);
  assert.equal(engine.sirenFrom(UID), '', 'les 9 chiffres d\'un n° IDE ne sont pas un SIREN');
  assert.equal(engine.sirenFrom('55210055400013'), '552100554');
});

let ch; let fr;
test('fiche : un n° IDE valide est enregistré sous sa forme normalisée et la fiche est prête ; un faux est refusé', async () => {
  const bad = await call('POST', `${B}/catalog/clients`, { societe: 'GRC Faux', contact: 'X', tel: '0600000000', adresse: 'Fledermausgasse 6', siret: 'CHE-109.656.757' });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.match(bad.data.error, /IDE suisse invalide/);
  const badFr = await call('POST', `${B}/catalog/clients`, { societe: 'Faux FR', siret: '1234' });
  assert.equal(badFr.status, 400);
  assert.match(badFr.data.error, /14 chiffres/);

  const c = await call('POST', `${B}/catalog/clients`, { societe: 'SS CATHERINE', contact: 'Bureau', tel: '+41 61 000 00 00', adresse: 'Fledermausgasse 6', codePostal: '4310', ville: 'Rheinfelden', siret: 'CHE109656756' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  ch = c.data.client.id;
  assert.equal(c.data.client.siret, UID);
  assert.deepEqual(c.data.client.issues, [], 'aucune alerte SIRET pour un client suisse : ' + JSON.stringify(c.data.client.issues));

  const f = await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Français', contact: 'Jean', tel: '0490123456', adresse: '1 rue Haute', siret: '55210055400013' });
  fr = f.data.client.id;

  // une valeur « suisse » déjà enregistrée mais abîmée (hors de l'écran) est signalée
  db.prepare('UPDATE clients SET siret = ? WHERE id = ?').run('CHE-109.656.757', ch);
  assert.deepEqual((await call('GET', `${B}/catalog/clients/${ch}`)).data.client.issues, ['N° IDE suisse invalide']);
  db.prepare('UPDATE clients SET siret = ? WHERE id = ?').run(UID, ch);
});

test('émission : acceptée pour un client suisse (n° IDE figé, pays CH, sans SIREN), les clients français restent inchangés', async () => {
  const a = await invoiceFor(ch, '2026-11-03');
  const issued = await a.issue();
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  const buyer = JSON.parse(db.prepare('SELECT buyer_json FROM native_invoices WHERE id = ?').get(a.id).buyer_json);
  assert.equal(buyer.uid, UID);
  assert.equal(buyer.country, 'CH');
  assert.ok(!buyer.siren && !buyer.siret, 'aucun SIREN/SIRET figé pour un client suisse');
  assert.equal(buyer.city, 'Rheinfelden');

  const pdf = await call('GET', `${B}/invoices/${a.id}/pdf`, undefined, true);
  assert.equal(pdf.status, 200);
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdfBuf.subarray(0, 5).toString(), '%PDF-');
  // Le bloc destinataire porte le pays et le n° IDE, sans SIREN (vérifié sur le texte du PDF quand pdftotext est installé).
  const { spawnSync } = require('child_process');
  const txt = spawnSync('pdftotext', ['-', '-'], { input: pdfBuf, encoding: 'utf8' });
  if (txt.status === 0) {
    assert.match(txt.stdout, /4310 Rheinfelden\s+Suisse\s+N° IDE CHE-109\.656\.756/);
    assert.ok(!/SIREN 109656756/.test(txt.stdout));
  }

  const b = await invoiceFor(fr, '2026-11-03');
  assert.equal((await b.issue()).status, 200);
  const frBuyer = JSON.parse(db.prepare('SELECT buyer_json FROM native_invoices WHERE id = ?').get(b.id).buyer_json);
  assert.equal(frBuyer.siren, '552100554');
  assert.equal(frBuyer.country, 'FR');
  assert.ok(!('uid' in frBuyer), 'pas de clé « uid » sur la facture d\'un client français');

  const integ = (await call('GET', `${B}/integrity`)).data;
  assert.ok(integ.ok !== false && !(integ.problems || []).length, JSON.stringify(integ));
});

test('un professionnel sans identifiant reste refusé à l\'émission ; effacer le n° IDE le fait réclamer à nouveau', async () => {
  const cleared = await call('PUT', `${B}/catalog/clients/${ch}`, { siret: '' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.deepEqual(cleared.data.client.issues, ['SIREN/SIRET manquant']);
  const refused = await (await invoiceFor(ch, '2026-11-04')).issue();
  assert.equal(refused.status, 422, JSON.stringify(refused.data));
  assert.match(refused.data.error, /SIREN\/SIRET manquant/);
  const back = await call('PUT', `${B}/catalog/clients/${ch}`, { siret: 'CHE-109.656.756 TVA' });
  assert.equal(back.status, 200);
  assert.equal(back.data.client.siret, UID);
});

test('espace client : un professionnel peut saisir son n° IDE suisse, pas un faux', async () => {
  const code = '482915';
  const upd = await call('PUT', `${B}/catalog/clients/${ch}`, { email: 'ss.catherine@x.ch', siret: '' });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  assert.equal((await sensitive(`client-code:${ch}`, 'PUT', `${B}/catalog/clients/${ch}/access-code`, { code })).status, 200);
  s.newClient();
  assert.equal((await call('POST', '/api/clients/login', { email: 'ss.catherine@x.ch', code })).status, 200);
  const bad = await call('PUT', '/api/clients/me/billing', { siret: 'CHE-109.656.757' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /IDE suisse invalide/);
  const ok = await call('PUT', '/api/clients/me/billing', { siret: 'che109656756', tvaNumber: '' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.client.siret, UID);
});
