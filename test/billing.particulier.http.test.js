// Clients particuliers (sans SIRET) : de la fiche à la facture émise, par l'API, avec le verrou de la Facturation.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
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
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-PART-${n}`, clientId, 'Client', 'J', '06', 'adr', issueDate).lastInsertRowid);
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

let part; let pro;

test('création : un particulier n\'a ni SIRET ni TVA, même si on en saisit ; un professionnel reste « à compléter » sans SIRET', async () => {
  const bad = await call('POST', `${B}/catalog/clients`, { societe: 'X', clientType: 'martien' });
  assert.equal(bad.status, 400);

  const p = await call('POST', `${B}/catalog/clients`, { societe: 'Madame Dupont', contact: 'Léa Dupont', tel: '0612345678', adresse: '12 rue des Lilas', codePostal: '84200', ville: 'Carpentras', clientType: 'particulier', email: 'lea@x.fr', siret: '55210055400013', tvaNumber: 'FR40552100554' });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  part = p.data.client.id;
  const fiche = (await call('GET', `${B}/catalog/clients/${part}`)).data.client;
  assert.equal(fiche.clientType, 'particulier');
  assert.ok(!fiche.siret && !fiche.tvaNumber, 'SIRET et TVA écartés pour un particulier');
  assert.ok(!(fiche.issues || []).some(i => /SIRET/i.test(i)), 'pas d\'alerte SIRET sur un particulier : ' + JSON.stringify(fiche.issues));

  const q = await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Pro', contact: 'Jean', tel: '0490123456', adresse: '1 rue Haute', codePostal: '84200', ville: 'Carpentras' });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  pro = q.data.client.id;
  const pf = (await call('GET', `${B}/catalog/clients/${pro}`)).data.client;
  assert.equal(pf.clientType, 'pro', 'professionnel par défaut');
  assert.ok((pf.issues || []).some(i => /SIRET/i.test(i)), 'un professionnel sans SIRET est signalé');

  const list = (await call('GET', `${B}/catalog/clients`)).data.clients;
  assert.equal(list.find(c => c.id === part).clientType, 'particulier');
});

test('modification : passer en particulier efface SIRET/TVA ; repasser en pro les réclame à nouveau', async () => {
  const ok = await call('PUT', `${B}/catalog/clients/${pro}`, { siret: '55210055400013', tvaNumber: 'FR40552100554' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.client.siret, '55210055400013');
  const toPart = await call('PUT', `${B}/catalog/clients/${pro}`, { clientType: 'particulier' });
  assert.equal(toPart.status, 200, JSON.stringify(toPart.data));
  assert.equal(toPart.data.client.clientType, 'particulier');
  assert.ok(!toPart.data.client.siret && !toPart.data.client.tvaNumber);
  const back = await call('PUT', `${B}/catalog/clients/${pro}`, { clientType: 'pro' });
  assert.equal(back.data.client.clientType, 'pro');
  assert.ok((back.data.client.issues || []).some(i => /SIRET/i.test(i)));
  // une modification sans rapport ne change pas le type
  const unrelated = await call('PUT', `${B}/catalog/clients/${part}`, { contact: 'Léa D.' });
  assert.equal(unrelated.data.client.clientType, 'particulier');
});

test('émission : refusée pour un professionnel sans SIRET, acceptée pour un particulier', async () => {
  const refused = await (await invoiceFor(pro, '2026-10-05')).issue();
  assert.equal(refused.status, 422, JSON.stringify(refused.data));
  assert.match(refused.data.error, /SIREN\/SIRET manquant/);

  const a = await invoiceFor(part, '2026-10-05');
  const issued = await a.issue();
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  const frozen = db.prepare('SELECT status, buyer_json, terms_json FROM native_invoices WHERE id = ?').get(a.id);
  const buyer = JSON.parse(frozen.buyer_json); const terms = JSON.parse(frozen.terms_json);
  assert.equal(frozen.status, 'issued');
  assert.equal(buyer.type, 'particulier');
  assert.ok(!buyer.siren && !buyer.siret && !buyer.vatNumber, 'aucun identifiant d\'entreprise figé sur la facture');
  assert.equal(terms.recoveryIndemnityCents, 0, 'pas d\'indemnité de 40 € pour un particulier');
  assert.ok(!terms.earlyDiscount, 'pas d\'escompte proposé par défaut à un particulier');
});

test('facture d\'un particulier : PDF généré, relances sans indemnité de 40 €, intégrité intacte', async () => {
  const issued = db.prepare(`SELECT id FROM native_invoices WHERE client_id = ? AND status='issued'`).get(part);
  const pdf = await call('GET', `${B}/invoices/${issued.id}/pdf`, undefined, true);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');

  const r2 = (await call('GET', `${B}/invoices/${issued.id}/mail-preview?kind=reminder-2`)).data;
  assert.ok(!/40 €/.test(r2.body), 'relance 2 sans indemnité forfaitaire pour un particulier');
  const r3 = (await call('GET', `${B}/invoices/${issued.id}/mail-preview?kind=reminder-3`)).data;
  assert.ok(!/40 €/.test(r3.body), 'relance 3 sans indemnité forfaitaire pour un particulier');

  const integ = (await call('GET', `${B}/integrity`)).data;
  assert.ok(integ.ok !== false && !(integ.problems || []).length, JSON.stringify(integ));
});

test('un professionnel garde l\'indemnité de 40 € dans ses relances', async () => {
  const ok = await call('PUT', `${B}/catalog/clients/${pro}`, { siret: '55210055400013' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const a = await invoiceFor(pro, '2026-10-06');
  assert.equal((await a.issue()).status, 200);
  const frozen = db.prepare('SELECT buyer_json, terms_json FROM native_invoices WHERE id = ?').get(a.id);
  assert.equal(JSON.parse(frozen.terms_json).recoveryIndemnityCents, 4000);
  assert.ok(!JSON.parse(frozen.buyer_json).type, 'pas de marque « particulier » sur un professionnel');
  const r2 = (await call('GET', `${B}/invoices/${a.id}/mail-preview?kind=reminder-2`)).data;
  assert.match(r2.body, /40 €/);
});

test('import CSV : colonne « type » facultative, validée, et sans effet quand elle est vide', async () => {
  const csv = [
    'societe,contact,tel,adresse,email,type',
    'Monsieur Martin,Paul Martin,0611111111,3 impasse du Four,paul@x.fr,particulier',
    'Hôtel Import,Sophie,0490000000,5 place Haute,sophie@x.fr,',
    'Madame Z,Zoé,0622222222,9 rue Basse,zoe@x.fr,client roi',
  ].join('\n');
  const r = await call('POST', `${B}/catalog/clients/import`, { csv });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created.length, 2);
  assert.equal(r.data.errors.length, 1);
  assert.match(r.data.errors[0].error, /type/);
  const a = await sensitive('clients-import', 'POST', `${B}/catalog/clients/import`, { csv, apply: true });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const types = Object.fromEntries(db.prepare('SELECT email, client_type FROM clients').all().map(x => [x.email, x.client_type]));
  assert.equal(types['paul@x.fr'], 'particulier');
  assert.equal(types['sophie@x.fr'], 'pro');
  assert.ok(!('zoe@x.fr' in types));

  // réimport sans colonne « type » : le type d'un client existant est conservé
  const again = await sensitive('clients-import', 'POST', `${B}/catalog/clients/import`, { csv: 'societe,contact,tel,adresse,email\nMonsieur Martin,Paul,0611111111,3 impasse du Four,paul@x.fr', apply: true });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(db.prepare(`SELECT client_type FROM clients WHERE email='paul@x.fr'`).get().client_type, 'particulier');
});

test('espace client : un particulier ne peut pas enregistrer de SIRET ni de TVA', async () => {
  const code = '482915';
  assert.equal((await call('PUT', `${B}/catalog/clients/${part}/access-code`, undefined)).status, 403, 'le code d\'accès exige la ressaisie du code');
  const set = await sensitive(`client-code:${part}`, 'PUT', `${B}/catalog/clients/${part}/access-code`, { code });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  const email = db.prepare('SELECT email FROM clients WHERE id = ?').get(part).email;

  s.newClient();
  const login = await call('POST', '/api/clients/login', { email, code });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.client.clientType, 'particulier');
  const save = await call('PUT', '/api/clients/me/billing', { siret: '55210055400013', tvaNumber: 'FR40552100554', adresseFacturation: '4 rue Neuve, 84200 Carpentras' });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  assert.ok(!save.data.client.siret && !save.data.client.tvaNumber);
  assert.equal(save.data.client.adresseFacturation, '4 rue Neuve, 84200 Carpentras');
});
