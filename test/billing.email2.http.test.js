// 2e destinataire d'un client : une adresse de plus, proposée à l'envoi des factures, bons et relances.
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

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

let id;
test('fiche : le 2e destinataire s\'enregistre, se relit et se modifie sans toucher à l\'e-mail de connexion', async () => {
  const c = await call('POST', `${B}/catalog/clients`, { societe: 'HOTEL DEUX ADRESSES', contact: 'X', tel: '0600000000', adresse: '1 rue A', email: 'Direction@Hotel2.fr', siret: '55210055400013' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  id = c.data.client.id;
  assert.equal(c.data.client.email2, null, 'vide par défaut');

  const u = await call('PUT', `${B}/catalog/clients/${id}`, { email2: ' Compta@Hotel2.fr ' });
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.equal(u.data.client.email, 'direction@hotel2.fr');
  assert.equal(u.data.client.email2, 'compta@hotel2.fr', 'normalisé en minuscules');

  // une mise à jour qui ne parle pas du 2e destinataire le conserve
  const keep = await call('PUT', `${B}/catalog/clients/${id}`, { tel: '0611111111' });
  assert.equal(keep.data.client.email2, 'compta@hotel2.fr');

  const list = await call('GET', `${B}/catalog/clients`);
  assert.equal(list.data.clients.find(x => x.id === id).email2, 'compta@hotel2.fr');

  // le 2e destinataire n'ouvre pas l'espace client : il n'est pas un identifiant
  const login = await call('POST', '/api/clients/login', { email: 'compta@hotel2.fr', code: 'nimportequoi1' });
  assert.equal(login.status, 401);

  // il est journalisé comme modification de la fiche
  const row = db.prepare("SELECT detail_json FROM billing_events WHERE action = 'client_updated' ORDER BY id DESC LIMIT 2").all().map(r => r.detail_json).join(' ');
  assert.match(row, /2e destinataire/);

  const clear = await call('PUT', `${B}/catalog/clients/${id}`, { email2: '' });
  assert.equal(clear.data.client.email2, null);
  await call('PUT', `${B}/catalog/clients/${id}`, { email2: 'compta@hotel2.fr' });
});

test('fiche : une seule adresse valide, différente de la première et seulement si la première existe', async () => {
  const bad = await call('PUT', `${B}/catalog/clients/${id}`, { email2: 'a@x.fr, b@x.fr' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /2e destinataire invalide/);
  const typo = await call('PUT', `${B}/catalog/clients/${id}`, { email2: 'pas-une-adresse' });
  assert.equal(typo.status, 400);
  const same = await call('PUT', `${B}/catalog/clients/${id}`, { email2: 'DIRECTION@hotel2.fr' });
  assert.equal(same.status, 400);
  assert.match(same.data.error, /identique/);

  const noMain = await call('POST', `${B}/catalog/clients`, { societe: 'SANS PRINCIPAL', email2: 'seul@hotel3.fr' });
  assert.equal(noMain.status, 400);
  assert.match(noMain.data.error, /e-mail principal/);

  // le même 2e destinataire peut servir à plusieurs fiches (ce n'est pas un identifiant)
  const other = await call('POST', `${B}/catalog/clients`, { societe: 'AUTRE HOTEL', email: 'autre@hotel4.fr', email2: 'compta@hotel2.fr' });
  assert.equal(other.status, 201, JSON.stringify(other.data));
  assert.equal(other.data.client.email2, 'compta@hotel2.fr');
});

test('envoi : la fenêtre d\'envoi propose les deux adresses (facture et bon de livraison) ; sans 2e adresse, une seule', async () => {
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES ('CZ-E2-1',?,?,?,?,?,?, 'livree')`).run(id, 'HOTEL DEUX ADRESSES', 'J', '06', 'adr', '2026-11-02').lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
  const inv = await call('POST', `${B}/invoices`, { clientId: id, orderIds: [o] });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  const iid = inv.data.invoice.id;
  const issued = await sensitive(`issue:${iid}`, 'POST', `${B}/invoices/${iid}/issue`, { issueDate: '2026-11-02' });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));

  const pv = await call('GET', `${B}/invoices/${iid}/mail-preview?kind=invoice`);
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  assert.equal(pv.data.to, 'direction@hotel2.fr, compta@hotel2.fr');

  const bl = await call('GET', `${B}/deliveries/${o}/mail-preview`);
  assert.equal(bl.status, 200, JSON.stringify(bl.data));
  assert.equal(bl.data.to, 'direction@hotel2.fr, compta@hotel2.fr');

  // les deux adresses passent la validation des destinataires à l'envoi
  const { parseRecipients } = require('../src/billing/mail');
  assert.deepEqual(parseRecipients(pv.data.to), ['direction@hotel2.fr', 'compta@hotel2.fr']);

  // sans 2e destinataire, comportement inchangé
  await call('PUT', `${B}/catalog/clients/${id}`, { email2: '' });
  const pv1 = await call('GET', `${B}/invoices/${iid}/mail-preview?kind=invoice`);
  assert.equal(pv1.data.to, 'direction@hotel2.fr');
});
