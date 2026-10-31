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

// ---- adresse postale et e-mail facultatifs pour un particulier (jamais pour un professionnel) ----

// Le test précédent a ouvert une session « client » : on revient en administrateur (la Facturation se déverrouille à chaque action sensible).
async function backToAdmin() {
  s.newClient();
  const r = await call('POST', '/api/admin/login', { password: 'secret123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const u = await call('POST', `${B}/lock/unlock`, { code: CODE });
  assert.equal(u.status, 200, JSON.stringify(u.data));
}

test('particulier sans adresse ni e-mail : fiche « prête », facture et devis émis ; le professionnel reste exigé', async () => {
  await backToAdmin();
  const p = await call('POST', `${B}/catalog/clients`, { societe: 'Madame Sans Adresse', clientType: 'particulier' });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const ps = p.data.client;
  assert.deepEqual(ps.issues, [], 'aucune alerte pour un particulier sans adresse : ' + JSON.stringify(ps.issues));
  assert.equal(ps.email, null);

  const q = await call('POST', `${B}/catalog/clients`, { societe: 'Hôtel Sans Adresse', siret: '55210055400013' });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  const pro2 = q.data.client.id;
  assert.deepEqual(q.data.client.issues, ['adresse de facturation manquante'], 'un professionnel sans adresse reste signalé');

  // facture
  const okInv = await (await invoiceFor(ps.id, '2026-10-12')).issue();
  assert.equal(okInv.status, 200, JSON.stringify(okInv.data));
  const refused = await (await invoiceFor(pro2, '2026-10-12')).issue();
  assert.equal(refused.status, 422, JSON.stringify(refused.data));
  assert.match(refused.data.error, /adresse de facturation manquante/);

  // devis
  const qp = await call('POST', `${B}/quotes`, { clientId: ps.id, lines: [{ description: 'Location nappes', quantity: 10, unitPrice: 4, vatRate: 20 }] });
  assert.equal(qp.status, 201, JSON.stringify(qp.data));
  assert.equal((await call('POST', `${B}/quotes/${qp.data.quote.id}/issue`, { issueDate: '2026-10-12' })).status, 200, 'devis émis pour un particulier sans adresse');
  const qq = await call('POST', `${B}/quotes`, { clientId: pro2, lines: [{ description: 'Location nappes', quantity: 10, unitPrice: 4, vatRate: 20 }] });
  const refusedQuote = await call('POST', `${B}/quotes/${qq.data.quote.id}/issue`, { issueDate: '2026-10-12' });
  assert.ok(refusedQuote.status >= 400, JSON.stringify(refusedQuote.data));
  assert.match(JSON.stringify(refusedQuote.data), /adresse manquante/);

  // PDF de la facture d'un particulier sans adresse : généré normalement
  const issued = db.prepare(`SELECT id FROM native_invoices WHERE client_id = ? AND status='issued'`).get(ps.id);
  const pdf = await call('GET', `${B}/invoices/${issued.id}/pdf`, undefined, true);
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('import CSV : adresse et e-mail peuvent rester vides pour un particulier, pas pour un professionnel', async () => {
  await backToAdmin();
  const csv = [
    'societe,contact,tel,adresse,email,type',
    'Monsieur Sans Rien,Marc,0633333333,,,particulier',
    'Madame Sans Mail,Anne,0644444444,8 rue du Four,,particulier',
    'Hôtel Sans Adresse CSV,Luc,0490111111,,luc@x.fr,professionnel',
    'Hôtel Sans Mail CSV,Eva,0490222222,2 rue Haute,,professionnel',
    'Monsieur Sans Rien,Marc,0633333333,,,particulier',
  ].join('\n');
  const sim = await call('POST', `${B}/catalog/clients/import`, { csv });
  assert.equal(sim.status, 200, JSON.stringify(sim.data));
  assert.equal(sim.data.created.length, 2, JSON.stringify(sim.data));
  assert.equal(sim.data.errors.length, 2);
  assert.match(sim.data.errors.find(e => e.line === 4).error, /adresse/);
  assert.match(sim.data.errors.find(e => e.line === 5).error, /Email/i);
  assert.equal(sim.data.duplicates.length, 1, 'même nom répété dans le fichier : ignoré');
  assert.ok(sim.data.created.every(c => !c.code), 'sans e-mail, aucun code d\'accès à communiquer');

  const a = await sensitive('clients-import', 'POST', `${B}/catalog/clients/import`, { csv, apply: true });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const rows = db.prepare(`SELECT societe, email, adresse, client_type FROM clients WHERE societe IN ('Monsieur Sans Rien','Madame Sans Mail') ORDER BY societe`).all();
  assert.deepEqual(rows, [
    { societe: 'Madame Sans Mail', email: null, adresse: '8 rue du Four', client_type: 'particulier' },
    { societe: 'Monsieur Sans Rien', email: null, adresse: '', client_type: 'particulier' },
  ]);

  // réimport : retrouvé par son nom (pas de doublon) et l'adresse déjà connue n'est pas effacée par une cellule vide
  const csv2 = ['societe,contact,tel,adresse,email,type', 'Madame Sans Mail,Anne B.,0644444444,,,particulier'].join('\n');
  const again = await sensitive('clients-import', 'POST', `${B}/catalog/clients/import`, { csv: csv2, apply: true });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.updated.length, 1);
  assert.equal(again.data.created.length, 0);
  const m = db.prepare(`SELECT contact, adresse FROM clients WHERE societe = 'Madame Sans Mail'`).all();
  assert.deepEqual(m, [{ contact: 'Anne B.', adresse: '8 rue du Four' }]);
});

test('espace client et commande : l\'adresse est facultative pour un particulier connecté, obligatoire sinon', async () => {
  await backToAdmin();
  const code = '482915';
  const mk = async (societe, email, clientType) => {
    const c = await call('POST', `${B}/catalog/clients`, { societe, contact: 'Moi', tel: '0600000000', email, clientType, siret: clientType === 'pro' ? '55210055400013' : undefined });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const id = c.data.client.id;
    assert.equal((await sensitive(`client-code:${id}`, 'PUT', `${B}/catalog/clients/${id}/access-code`, { code })).status, 200);
    return id;
  };
  await mk('Particulier Connecté', 'part.conn@x.fr', 'particulier');
  await mk('Pro Connecté', 'pro.conn@x.fr', 'pro');
  const order = { items: [{ id: 'd', qty: 1 }], client: { societe: 'X', contact: 'Moi', tel: '0600000000' } };
  const svc = db.prepare('SELECT id FROM articles LIMIT 1').get();
  assert.ok(svc, 'le catalogue de démarrage contient au moins un article');
  order.items[0].id = svc.id;

  s.newClient();
  assert.equal((await call('POST', '/api/clients/login', { email: 'part.conn@x.fr', code })).status, 200);
  const prof = await call('PUT', '/api/clients/me/profile', { contact: 'Moi', tel: '0600000000', adresse: '' });
  assert.equal(prof.status, 200, JSON.stringify(prof.data));
  assert.equal(prof.data.client.adresse, '');
  const o = await call('POST', '/api/orders', order);
  assert.equal(o.status, 201, 'commande d\'un particulier sans adresse : ' + JSON.stringify(o.data));

  s.newClient();
  assert.equal((await call('POST', '/api/clients/login', { email: 'pro.conn@x.fr', code })).status, 200);
  const profPro = await call('PUT', '/api/clients/me/profile', { contact: 'Moi', tel: '0600000000', adresse: '' });
  assert.equal(profPro.status, 400, 'un professionnel doit garder son adresse');
  const oPro = await call('POST', '/api/orders', order);
  assert.equal(oPro.status, 400);
  assert.match(oPro.data.error, /adresse/);

  s.newClient();   // invité : l'adresse reste exigée
  const oGuest = await call('POST', '/api/orders', order);
  assert.equal(oGuest.status, 400);
  assert.match(oGuest.data.error, /adresse/);
});
