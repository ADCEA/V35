// Envoi « via Outlook » : le serveur n'envoie rien (aucun SMTP nécessaire), il garde la trace de la préparation
// du message dans l'historique ; l'écran ouvre Outlook et télécharge le PDF à joindre.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; let db; let hotel; let overdue; let n = 0;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return call(method, url, body);
}
async function issuedInvoice(issueDate) {
  n += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-OL-${n}`, hotel, 'Hôtel', 'J', '06', 'adr', issueDate).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
  const c = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o] });
  const id = c.data.invoice.id;
  if (issueDate) assert.equal((await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate })).status, 200);
  return id;
}
const logs = (where = '1=1') => db.prepare(`SELECT kind, channel, to_email, subject, status FROM native_mail_log WHERE ${where} ORDER BY id`).all();

test.before(async () => {
  s = await startServer();   // pas de SMTP dans ce serveur de test
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number)
    VALUES ('h@x.fr','Hôtel Les Lavandes','Jean','0490123456','450 route de Malaucène','84380','Mazan','x','55210055400013','FR40552100554')`).run().lastInsertRowid);
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  overdue = await issuedInvoice('2026-08-01');   // émise en premier : la numérotation reste chronologique ; échue depuis longtemps
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('facture : sans SMTP l\'envoi direct reste refusé, mais Outlook fonctionne et la préparation est tracée', async () => {
  const id = await issuedInvoice('2026-10-05');
  const pv = (await call('GET', `${B}/invoices/${id}/mail-preview?kind=invoice`)).data;
  assert.equal(pv.smtp, false);
  const direct = await call('POST', `${B}/invoices/${id}/send`, { to: 'h@x.fr', subject: pv.subject, body: pv.body });
  assert.equal(direct.status, 503, 'envoi direct : toujours « SMTP non configuré »');
  assert.deepEqual(logs(`invoice_id = ${id}`), [], 'rien n\'est tracé quand rien n\'a été fait');

  const r = await call('POST', `${B}/invoices/${id}/send`, { channel: 'outlook', to: 'h@x.fr, compta@x.fr', subject: pv.subject, body: pv.body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.outlook, true);
  assert.deepEqual(r.data.to, ['h@x.fr', 'compta@x.fr']);
  const row = logs(`invoice_id = ${id}`);
  assert.equal(row.length, 1);
  assert.deepEqual({ ...row[0] }, { kind: 'invoice', channel: 'outlook', to_email: 'h@x.fr, compta@x.fr', subject: pv.subject, status: 'sent' });

  // la facture apparaît comme envoyée, et l'historique le dit clairement
  const list = (await call('GET', `${B}/invoices`)).data.invoices.find(i => i.id === id);
  assert.ok(list.sentCount >= 1);
  const timeline = (await call('GET', `${B}/invoices/${id}`)).data.invoice.timeline;
  assert.ok(timeline.some(t => /Outlook/.test(t.detail) && /h@x\.fr/.test(t.detail)), JSON.stringify(timeline.map(t => t.detail)));
});

test('contrôles : brouillon refusé, objet ou message vide refusés, adresse invalide refusée, destinataire facultatif', async () => {
  const draft = await issuedInvoice(null);
  const rd = await call('POST', `${B}/invoices/${draft}/send`, { channel: 'outlook', to: 'h@x.fr', subject: 'S', body: 'B' });
  assert.equal(rd.status, 400); assert.match(rd.data.error, /émis/);
  const id = await issuedInvoice('2026-10-06');
  for (const bad of [{ subject: '', body: 'B' }, { subject: 'S', body: '  ' }]) {
    const r = await call('POST', `${B}/invoices/${id}/send`, { channel: 'outlook', to: 'h@x.fr', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const inv = await call('POST', `${B}/invoices/${id}/send`, { channel: 'outlook', to: 'pas-une-adresse', subject: 'S', body: 'B' });
  assert.equal(inv.status, 400); assert.match(inv.data.error, /invalide/);
  assert.deepEqual(logs(`invoice_id = ${id}`), [], 'une demande refusée ne laisse aucune trace');
  const noTo = await call('POST', `${B}/invoices/${id}/send`, { channel: 'outlook', subject: 'S', body: 'B' });
  assert.equal(noTo.status, 200, 'la personne peut saisir le destinataire dans Outlook');
  assert.deepEqual(noTo.data.to, []);
  assert.equal((await call('POST', `${B}/invoices/99999/send`, { channel: 'outlook', subject: 'S', body: 'B' })).status, 404);
});

test('relance : tracée comme les autres, elle compte pour le niveau suivant', async () => {
  const id = overdue;
  const before = (await call('GET', `${B}/reminders`)).data.invoices.find(i => i.id === id);
  assert.equal(before.reminderCount, 0); assert.equal(before.suggestedLevel, 1);
  const pv = (await call('GET', `${B}/invoices/${id}/mail-preview?kind=reminder-1`)).data;
  const r = await call('POST', `${B}/invoices/${id}/remind`, { level: 1, channel: 'outlook', to: 'h@x.fr', subject: pv.subject, body: pv.body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.outlook, true);
  assert.deepEqual(logs(`invoice_id = ${id}`).map(l => [l.kind, l.channel, l.status]), [['reminder-1', 'outlook', 'sent']]);
  const after = (await call('GET', `${B}/reminders`)).data.invoices.find(i => i.id === id);
  assert.equal(after.reminderCount, 1);
  // niveau invalide, facture soldée
  assert.equal((await call('POST', `${B}/invoices/${id}/remind`, { level: 9, channel: 'outlook', subject: 'S', body: 'B' })).status, 400);
  const pay = await call('POST', `${B}/invoices/${id}/payments`, { paidOn: '2026-10-20', amount: 120, method: 'virement' });
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  assert.equal((await call('POST', `${B}/invoices/${id}/remind`, { level: 2, channel: 'outlook', subject: 'S', body: 'B' })).status, 400);
});

test('devis : même principe, brouillon refusé', async () => {
  let q = await call('POST', `${B}/quotes`, { clientId: hotel, lines: [{ description: 'Location nappes', quantity: 10, unitPrice: 4, vatRate: 20 }] });
  assert.equal(q.status, 201);
  const qid = q.data.quote.id;
  const refused = await call('POST', `${B}/quotes/${qid}/send`, { channel: 'outlook', to: 'h@x.fr', subject: 'S', body: 'B' });
  assert.equal(refused.status, 400); assert.match(refused.data.error, /Finalisez/);
  assert.equal((await call('POST', `${B}/quotes/${qid}/issue`, { issueDate: '2026-10-07' })).status, 200);
  const ok = await call('POST', `${B}/quotes/${qid}/send`, { channel: 'outlook', to: 'h@x.fr', subject: 'Devis', body: 'Bonjour' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.outlook, true);
  assert.deepEqual(logs(`quote_id = ${qid}`).map(l => [l.kind, l.channel, l.status]), [['quote', 'outlook', 'sent']]);
  const pdf = await call('GET', `${B}/quotes/${qid}/pdf`, null, true);
  assert.equal(pdf.status, 200);
});

test('l\'historique des envois reste en ajout seul', async () => {
  assert.throws(() => db.prepare(`UPDATE native_mail_log SET status = 'failed'`).run(), /modification interdite/);
});
