// Espace client à onglets, de bout en bout par l'API : livraisons (bons de livraison), contrat (conditions, tarifs, devis) et
// documents PDF déposés par la blanchisserie — avec l'isolation entre hôtels et le verrou de la Facturation.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const ADMIN_PW = 'secret123';
const B = '/api/admin/billing';
let s; let db; let hotel; let other; let third;
const call = (...a) => s.call(...a);

const pdf = (label = 'x', pad = 0) => Buffer.concat([Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`), Buffer.alloc(pad, 0x20)]);
const PDF_A = pdf('contrat-lavandes'); const PDF_CGV = pdf('cgv'); const PDF_B = pdf('contrat-ventoux');

async function asAdmin() {
  s.newClient();
  assert.equal((await call('POST', '/api/admin/login', { password: ADMIN_PW })).status, 200);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
}
async function asClient(email) {
  s.newClient();
  const r = await call('POST', '/api/clients/login', { email, code: '1234' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, `confirmation ${scope} : ${JSON.stringify(c.data)}`);
  return call(method, url, body);
}
const bytesOf = async (url) => {
  const res = await call('GET', url, null, true);
  return { status: res.status, type: res.headers.get('content-type'), disp: res.headers.get('content-disposition'), buf: Buffer.from(await res.arrayBuffer()) };
};

let ticketN = 0;
function delivered(clientId, { date, items, status = 'livree' }) {
  ticketN += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, collecte_date, status) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`CZ-ESP-${ticketN}`, clientId, 'Hôtel', 'J', '06', 'adr', date, date, status).lastInsertRowid);
  for (const [name, code, qty, deliveredQty, price] of items) {
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, code.toLowerCase(), name, code, code, price, qty, deliveredQty);
  }
  return o;
}

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: ADMIN_PW })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const mk = (mail, name) => Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash, siret, tva_number, adresse_facturation, code_postal, ville)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(mail, name, 'Jean', '0490123456', '1 rue Test', bcrypt.hashSync('1234', 10), '55210055400013', 'FR40552100554', 'Siège', '84000', 'Avignon').lastInsertRowid);
  hotel = mk('lavandes@x.fr', 'Hôtel des Lavandes'); other = mk('ventoux@x.fr', 'Hôtel du Ventoux'); third = mk('luberon@x.fr', 'Hôtel du Luberon');
  const r = await call('PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP', payment_terms_days: 30 });
  if (r.status === 403) assert.equal((await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP', payment_terms_days: 30 })).status, 200);
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('sans connexion, les routes de l\'espace client sont fermées', async () => {
  s.newClient();
  for (const u of ['/api/clients/deliveries', '/api/clients/deliveries/1/pdf', '/api/clients/contract', '/api/clients/documents', '/api/clients/documents/1', '/api/clients/quotes/1/pdf']) {
    assert.equal((await call('GET', u)).status, 401, u);
  }
});

test('documents : seul l\'administrateur déverrouillé dépose, modifie ou supprime — jamais un hôtel', async () => {
  const up = `${B}/catalog/clients/${hotel}/documents?kind=contract&title=Contrat`;
  s.newClient();
  assert.ok([401, 403].includes((await s.upload(up, PDF_A)).status), 'sans session');
  await asClient('lavandes@x.fr');
  assert.ok([401, 403].includes((await s.upload(up, PDF_A)).status), 'un hôtel ne dépose rien');
  assert.ok([401, 403].includes((await call('DELETE', `${B}/catalog/documents/1`)).status));
  // administrateur connecté mais Facturation verrouillée
  s.newClient();
  assert.equal((await call('POST', '/api/admin/login', { password: ADMIN_PW })).status, 200);
  assert.equal((await s.upload(up, PDF_A)).status, 423);
});

test('dépôt : PDF seulement, 8 Mo au plus, date valide, hôtel existant', async () => {
  await asAdmin();
  const up = (id, q = '') => `${B}/catalog/clients/${id}/documents?${q}`;
  const notPdf = await s.upload(up(hotel, 'kind=contract'), Buffer.from('<html>pas un pdf du tout, juste du texte</html>'));
  assert.ok([400, 415].includes(notPdf.status), 'un fichier qui n\'est pas un PDF est refusé : ' + notPdf.status);
  const wrongType = await s.upload(up(hotel, 'kind=contract'), PDF_A, 'text/plain');
  assert.ok(wrongType.status >= 400 && wrongType.status < 500, 'mauvais Content-Type refusé');
  const fake = await s.upload(up(hotel, 'kind=contract'), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]));
  assert.equal(fake.status, 400, 'un exécutable renommé en PDF est refusé');
  const huge = await s.upload(up(hotel, 'kind=contract'), pdf('gros', 9 * 1024 * 1024));
  assert.equal(huge.status, 413);
  assert.match(huge.data.error, /8 Mo/);
  const badDate = await s.upload(up(hotel, 'kind=contract&signedOn=31%2F12%2F2025'), PDF_A);
  assert.equal(badDate.status, 400);
  assert.equal((await s.upload(up(999999, 'kind=contract'), PDF_A)).status, 404);
  assert.equal((await call('GET', `${B}/catalog/clients/${hotel}/documents`)).data.documents.length, 0, 'rien n\'a été enregistré');
});

let docContract; let docAvenant; let docCgv; let docOther;
test('dépôt réussi : contrat de l\'hôtel, avenant, CGV communes ; types normalisés', async () => {
  await asAdmin();
  let r = await s.upload(`${B}/catalog/clients/${hotel}/documents?kind=contract&title=${encodeURIComponent('Contrat de prestation 2026')}&filename=${encodeURIComponent('contrat lavandes.pdf')}&signedOn=2026-01-15`, PDF_A);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  docContract = r.data.document;
  assert.equal(docContract.kind, 'contract'); assert.equal(docContract.title, 'Contrat de prestation 2026'); assert.equal(docContract.signedOn, '2026-01-15');
  assert.equal(docContract.size, PDF_A.length); assert.equal(docContract.common, false); assert.match(docContract.filename, /\.pdf$/);
  assert.ok(!('data' in docContract) && !('sha256' in docContract), 'le contenu ne voyage pas dans la liste');

  r = await s.upload(`${B}/catalog/clients/${hotel}/documents?kind=other`, pdf('avenant'));
  assert.equal(r.status, 201); docAvenant = r.data.document;
  assert.equal(docAvenant.kind, 'other'); assert.equal(docAvenant.title, 'Document', 'titre par défaut');
  r = await s.upload(`${B}/catalog/clients/${third}/documents?kind=bizarre`, pdf('inconnu'));
  assert.equal(r.status, 201);
  assert.equal(r.data.document.kind, 'contract', 'type inconnu pour un hôtel → contrat');
  assert.equal(r.data.document.title, 'Contrat de prestation', 'titre par défaut');
  assert.equal((await call('DELETE', `${B}/catalog/documents/${r.data.document.id}`)).status, 200);

  r = await s.upload(`${B}/catalog/documents/common?kind=contract&title=${encodeURIComponent('Conditions générales de vente')}`, PDF_CGV);
  assert.equal(r.status, 201); docCgv = r.data.document;
  assert.equal(docCgv.common, true); assert.equal(docCgv.clientId, null);
  assert.equal(docCgv.kind, 'terms', 'un document commun n\'est jamais un contrat individuel');

  r = await s.upload(`${B}/catalog/documents/common?kind=other&title=Charte%20qualit%C3%A9`, pdf('charte'));
  assert.equal(r.status, 201); docOther = r.data.document; assert.equal(docOther.kind, 'other');

  r = await s.upload(`${B}/catalog/clients/${other}/documents?kind=contract&title=Contrat%20Ventoux`, PDF_B);
  assert.equal(r.status, 201);

  const list = await call('GET', `${B}/catalog/clients/${hotel}/documents`);
  assert.equal(list.data.documents.length, 2, 'les documents des autres hôtels et les communs n\'y sont pas');
  assert.equal(list.data.documents[0].id, docContract.id, 'le contrat signé d\'abord');
  assert.equal((await call('GET', `${B}/catalog/documents/common`)).data.documents.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM billing_events WHERE action = 'client_document_added'").get().c >= 5, true, 'chaque dépôt est journalisé');
});

test('administrateur : voir le fichier, renommer, dater', async () => {
  await asAdmin();
  const f = await bytesOf(`${B}/catalog/documents/${docContract.id}/file`);
  assert.equal(f.status, 200); assert.equal(f.type, 'application/pdf'); assert.ok(f.buf.equals(PDF_A), 'le fichier ressort tel qu\'il est entré');
  assert.match(f.disp, /^inline; filename=/);
  assert.equal((await call('GET', `${B}/catalog/documents/99999/file`)).status, 404);
  const u = await call('PUT', `${B}/catalog/documents/${docAvenant.id}`, { title: 'Avenant n°1 — tarifs 2027', signedOn: '2026-10-01' });
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.equal(u.data.document.title, 'Avenant n°1 — tarifs 2027'); assert.equal(u.data.document.signedOn, '2026-10-01');
  assert.equal((await call('PUT', `${B}/catalog/documents/${docAvenant.id}`, { signedOn: 'hier' })).status, 400);
  assert.equal((await call('PUT', `${B}/catalog/documents/99999`, { title: 'x' })).status, 404);
  const cleared = await call('PUT', `${B}/catalog/documents/${docAvenant.id}`, { signedOn: null });
  assert.equal(cleared.data.document.signedOn, null);
  assert.equal((await call('PUT', `${B}/catalog/documents/${docAvenant.id}`, { signedOn: '2026-10-01' })).status, 200);
});

test('l\'hôtel voit ses documents puis les documents communs — jamais ceux d\'un autre hôtel', async () => {
  await asClient('lavandes@x.fr');
  const mine = (await call('GET', '/api/clients/documents')).data.documents;
  assert.deepEqual(mine.map(d => d.id), [docContract.id, docAvenant.id, docCgv.id, docOther.id], 'contrat, avenant, puis communs');
  assert.ok(mine.every(d => d.url === `/api/clients/documents/${d.id}`));
  assert.ok(!mine.some(d => d.title === 'Contrat Ventoux'));
  const f = await bytesOf(`/api/clients/documents/${docContract.id}`);
  assert.equal(f.status, 200); assert.equal(f.type, 'application/pdf'); assert.ok(f.buf.equals(PDF_A));
  assert.equal((await bytesOf(`/api/clients/documents/${docCgv.id}`)).status, 200, 'un document commun est lisible');

  await asClient('ventoux@x.fr');
  const theirs = (await call('GET', '/api/clients/documents')).data.documents;
  assert.equal(theirs.length, 3); assert.ok(!theirs.some(d => d.id === docContract.id || d.id === docAvenant.id));
  assert.equal((await call('GET', `/api/clients/documents/${docContract.id}`)).status, 404, 'le contrat d\'un autre hôtel est introuvable');
  assert.equal((await call('GET', '/api/clients/documents/abc')).status, 404);

  await asClient('luberon@x.fr');
  assert.deepEqual((await call('GET', '/api/clients/documents')).data.documents.map(d => d.id), [docCgv.id, docOther.id], 'un hôtel sans contrat ne voit que les communs');
});

test('livraisons : seuls les bons de livraison de l\'hôtel, avec ce qui a été livré, sans prix', async () => {
  const o1 = delivered(hotel, { date: '2026-09-10', items: [['Drap plat', 'DRAP', 100, 100, 1.2], ['Serviette', 'SERV', 50, 48, 0.9]] });
  const o2 = delivered(hotel, { date: '2026-10-05', items: [['Drap plat', 'DRAP', 80, 80, 1.2], ['Reprise taies', 'TAIE', -6, -6, 0.5]] });
  const pending = delivered(hotel, { date: '2026-10-20', status: 'traitement', items: [['Drap plat', 'DRAP', 10, null, 1.2]] });
  const foreign = delivered(other, { date: '2026-10-06', items: [['Drap plat', 'DRAP', 5, 5, 1.2]] });

  await asClient('lavandes@x.fr');
  const r = await call('GET', '/api/clients/deliveries');
  assert.equal(r.status, 200);
  const ids = r.data.deliveries.map(d => d.id);
  assert.deepEqual(ids, [o2, o1], 'les plus récents d\'abord, uniquement les livrées de l\'hôtel');
  assert.ok(!ids.includes(pending) && !ids.includes(foreign));
  const d1 = r.data.deliveries.find(d => d.id === o1);
  assert.equal(d1.pieces, 148); assert.equal(d1.reprises, 0); assert.equal(d1.adjusted, true, 'serviettes : 50 commandées, 48 livrées');
  assert.deepEqual(d1.items.map(i => [i.name, i.qty, i.delivered]), [['Drap plat', 100, 100], ['Serviette', 50, 48]]);
  const d2 = r.data.deliveries.find(d => d.id === o2);
  assert.equal(d2.pieces, 80); assert.equal(d2.reprises, 6, 'une quantité négative est une reprise');
  assert.equal(d2.billing.status, 'to_invoice'); assert.equal(d2.billing.invoiceNumber, null);
  assert.ok(!JSON.stringify(r.data).match(/price|prix|Cents|total/i), 'aucun montant dans les livraisons');

  // PDF du bon de livraison
  const ok = await bytesOf(`/api/clients/deliveries/${o1}/pdf`);
  assert.equal(ok.status, 200); assert.equal(ok.type, 'application/pdf'); assert.equal(ok.buf.subarray(0, 5).toString(), '%PDF-');
  for (const id of [foreign, pending, 999999]) assert.equal((await call('GET', `/api/clients/deliveries/${id}/pdf`)).status, 404, `bon ${id}`);
});

test('livraisons : une fois facturé, l\'hôtel voit le numéro de facture', async () => {
  const o = db.prepare("SELECT id FROM orders WHERE ticket = 'CZ-ESP-1'").get().id;
  await asAdmin();
  const c = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o] });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.invoice.id;
  const i = await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate: '2026-10-10' });
  assert.equal(i.status, 200, JSON.stringify(i.data));

  await asClient('lavandes@x.fr');
  const d = (await call('GET', '/api/clients/deliveries')).data.deliveries.find(x => x.id === o);
  assert.equal(d.billing.status, 'invoiced'); assert.equal(d.billing.invoiceNumber, i.data.invoice.number);
  const other2 = (await call('GET', '/api/clients/deliveries')).data.deliveries.find(x => x.id !== o);
  assert.equal(other2.billing.status, 'to_invoice');
});

test('contrat : conditions, établissement, tarifs et mandat — propres à l\'hôtel', async () => {
  await asAdmin();
  const art = (await call('GET', `${B}/catalog/articles`)).data.articles;
  assert.ok(art.length > 0, 'le catalogue de départ contient des articles');
  const a = art[0];
  assert.equal((await call('PUT', `${B}/catalog/clients/${hotel}/prices/${a.id}`, { price: '1,15', dateDebut: '2026-01-01' })).status, 200);
  await sensitive('settings', 'PUT', `${B}/settings`, { early_discount_rate: '1,5', early_discount_hours: 48, early_discount_all: true });

  await asClient('lavandes@x.fr');
  let c = (await call('GET', '/api/clients/contract')).data;
  assert.equal(c.conditions.paymentTermsDays, 30);
  assert.deepEqual(c.conditions.paymentMethod, { type: 'transfer' });
  assert.deepEqual(c.conditions.escompte, { ratePct: 1.5, hours: 48 });
  assert.equal(c.establishment.societe, 'Hôtel des Lavandes'); assert.equal(c.establishment.siret, '55210055400013');
  assert.match(c.establishment.adresse, /84000 Avignon/);
  const mine = c.prices.find(p => p.id === a.id);
  assert.ok(mine, 'l\'article au tarif négocié figure dans « Mes tarifs »'); assert.equal(mine.price, 1.15); assert.equal(mine.since, '2026-01-01');
  assert.deepEqual(c.documents.map(d => d.id), [docContract.id, docAvenant.id, docCgv.id, docOther.id]);
  assert.ok(!JSON.stringify(c).match(/iban|FR76/i), 'pas d\'IBAN dans le contrat affiché');

  // mandat de prélèvement actif → mode de règlement
  db.prepare("INSERT INTO sdd_mandates (client_id, umr, scheme, debtor_name, iban, bic, signed_on) VALUES (?,?,?,?,?,?,?)").run(hotel, 'CEZ-LAV-001', 'CORE', 'Hôtel des Lavandes', 'FR7630001007941234567890185', 'BDFEFRPP', '2026-02-02');
  c = (await call('GET', '/api/clients/contract')).data;
  assert.deepEqual(c.conditions.paymentMethod, { type: 'sdd', umr: 'CEZ-LAV-001', signedOn: '2026-02-02' });
  assert.ok(!JSON.stringify(c).match(/FR7630001007941234567890185/), 'l\'IBAN du mandat ne sort pas');

  await asClient('ventoux@x.fr');
  c = (await call('GET', '/api/clients/contract')).data;
  assert.deepEqual(c.conditions.paymentMethod, { type: 'transfer' }, 'le mandat d\'un autre hôtel ne se voit pas');
  assert.equal(c.establishment.societe, 'Hôtel du Ventoux');
  const nego = c.prices.find(p => p.id === a.id);
  assert.ok(!nego || nego.price !== 1.15 || nego.since == null, 'le tarif négocié d\'un hôtel n\'est pas celui des autres');
});

test('contrat : devis finalisés visibles, brouillons et devis des autres hôtels jamais', async () => {
  await asAdmin();
  const mkQuote = async (clientId, issue) => {
    const q = await call('POST', `${B}/quotes`, { clientId, lines: [{ description: 'Location nappes', quantity: 10, unitPrice: 4, vatRate: 20 }] });
    assert.equal(q.status, 201, JSON.stringify(q.data));
    if (issue) assert.equal((await call('POST', `${B}/quotes/${q.data.quote.id}/issue`, { issueDate: '2026-10-08' })).status, 200);
    return q.data.quote.id;
  };
  const draft = await mkQuote(hotel, false); const issued = await mkQuote(hotel, true); const foreign = await mkQuote(other, true);

  await asClient('lavandes@x.fr');
  const q = (await call('GET', '/api/clients/contract')).data.quotes;
  assert.deepEqual(q.map(x => x.id), [issued]);
  assert.equal(q[0].status, 'issued'); assert.equal(q[0].totalHtCents, 4000); assert.equal(q[0].pdfUrl, `/api/clients/quotes/${issued}/pdf`);
  const ok = await bytesOf(`/api/clients/quotes/${issued}/pdf`);
  assert.equal(ok.status, 200); assert.equal(ok.type, 'application/pdf'); assert.equal(ok.buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call('GET', `/api/clients/quotes/${draft}/pdf`)).status, 404, 'un brouillon n\'est pas visible');
  assert.equal((await call('GET', `/api/clients/quotes/${foreign}/pdf`)).status, 404, 'le devis d\'un autre hôtel non plus');
});

test('suppression : le document disparaît de l\'espace de l\'hôtel ; supprimer l\'hôtel emporte ses documents', async () => {
  await asAdmin();
  assert.equal((await call('DELETE', `${B}/catalog/documents/${docAvenant.id}`)).status, 200);
  assert.equal((await call('DELETE', `${B}/catalog/documents/${docAvenant.id}`)).status, 404);
  assert.equal((await call('DELETE', `${B}/catalog/documents/${docOther.id}`)).status, 200);
  await asClient('lavandes@x.fr');
  assert.deepEqual((await call('GET', '/api/clients/documents')).data.documents.map(d => d.id), [docContract.id, docCgv.id]);
  assert.equal((await call('GET', `/api/clients/documents/${docAvenant.id}`)).status, 404);

  // l'hôtel du Luberon n'a ni facture ni devis : on peut le supprimer, avec ses documents
  await asAdmin();
  const r = await s.upload(`${B}/catalog/clients/${third}/documents?kind=contract&title=Contrat%20Luberon`, pdf('luberon'));
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM client_documents WHERE client_id = ?').get(third).c, 1);
  assert.equal((await sensitive(`client-delete:${third}`, 'DELETE', `${B}/catalog/clients/${third}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM client_documents WHERE client_id = ?').get(third).c, 0, 'plus de documents orphelins');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM client_documents WHERE client_id IS NULL').get().c, 1, 'les documents communs restent');
});

test('limite : trente documents au plus par hôtel', async () => {
  await asAdmin();
  const n = db.prepare('SELECT COUNT(*) c FROM client_documents WHERE client_id = ?').get(other).c;
  for (let i = n; i < 30; i++) assert.equal((await s.upload(`${B}/catalog/clients/${other}/documents?kind=other&title=Annexe%20${i}`, pdf('a' + i))).status, 201);
  const over = await s.upload(`${B}/catalog/clients/${other}/documents?kind=other`, pdf('trop'));
  assert.equal(over.status, 409); assert.match(over.data.error, /Trente/);
});
