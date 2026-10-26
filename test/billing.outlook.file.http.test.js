// « Outlook installé sur l'ordinateur » : le serveur fabrique un message .eml (brouillon non envoyé, « X-Unsent: 1 »)
// avec le PDF en pièce jointe ; le navigateur le télécharge, un clic l'ouvre dans Outlook. Aucun SMTP, aucun compte Microsoft.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; let db; let hotel; let n = 0;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return call(method, url, body);
}
async function issuedInvoice(issueDate) {
  n += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-EML-${n}`, hotel, 'Hôtel', 'J', '06', 'adr', issueDate || '2026-10-01').lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
  const c = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o] });
  const id = c.data.invoice.id;
  if (issueDate) assert.equal((await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate })).status, 200);
  return id;
}
const logs = (where) => db.prepare(`SELECT kind, channel, to_email, status FROM native_mail_log WHERE ${where} ORDER BY id`).all();

// Lecture minimale d'un message MIME (assez pour vérifier ce que verra Outlook).
function decodeWords(v) {
  return String(v).replace(/\r?\n[ \t]+/g, ' ').replace(/=\?UTF-8\?([QB])\?([^?]*)\?=\s*/gi, (_, enc, txt) =>
    enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64').toString('utf8')
      : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
}
function parse(buf) {
  const raw = buf.toString('latin1');
  const [head, ...rest] = raw.split(/\r?\n\r?\n/); const body = rest.join('\n\n');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  return { headers, body, raw };
}
function parts(msg) {
  const m = /boundary="?([^";]+)"?/i.exec(msg.headers['content-type'] || ''); assert.ok(m, 'message à plusieurs parties');
  return msg.body.split('--' + m[1]).slice(1, -1).map(p => parse(Buffer.from(p.replace(/^\r?\n/, ''), 'latin1')));
}
function decodeBody(part) {
  const cte = (part.headers['content-transfer-encoding'] || '7bit').toLowerCase();
  if (cte === 'base64') return Buffer.from(part.body.replace(/\s+/g, ''), 'base64');
  if (cte === 'quoted-printable') return Buffer.from(part.body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return Buffer.from(part.body, 'latin1');
}

test.before(async () => {
  s = await startServer();   // pas de SMTP, pas de Microsoft
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number)
    VALUES ('h@x.fr','Hôtel Les Lavandes','Jean','0490123456','450 route de Malaucène','84380','Mazan','x','55210055400013','FR40552100554')`).run().lastInsertRowid);
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP', phone: '04 90 63 00 00', email: 'contact@blanchisserie-cezanne.fr' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('facture : message prêt à envoyer — destinataires, objet accentué, texte, PDF joint, brouillon non envoyé', async () => {
  const id = await issuedInvoice('2026-10-05');
  const pv = (await call('GET', `${B}/invoices/${id}/mail-preview?kind=invoice`)).data;
  const r = await call('POST', `${B}/invoices/${id}/send`, { channel: 'outlook-file', to: 'h@x.fr, compta@x.fr', subject: pv.subject, body: pv.body });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 200));
  assert.equal(r.data.file, true); assert.equal(r.data.outlook, true);
  assert.deepEqual(r.data.to, ['h@x.fr', 'compta@x.fr']);
  assert.match(r.data.emlName, /^FA-2026-\d+\.eml$/);

  const msg = parse(Buffer.from(r.data.eml, 'base64'));
  assert.equal(msg.headers['x-unsent'], '1', 'Outlook l\'ouvre comme un brouillon à envoyer');
  assert.match(msg.headers.to, /h@x\.fr/); assert.match(msg.headers.to, /compta@x\.fr/);
  assert.equal(decodeWords(msg.headers.subject), pv.subject, 'objet identique, accents et tiret long compris');
  assert.equal(msg.headers.from, undefined, 'pas d\'expéditeur imposé : Outlook met le compte de la personne');

  const ps = parts(msg);
  const text = ps.find(p => /text\/plain/i.test(p.headers['content-type']));
  assert.equal(decodeBody(text).toString('utf8').replace(/\r\n/g, '\n').trim(), pv.body.replace(/\r\n/g, '\n').trim(), 'le texte arrive intact');
  const pdf = ps.find(p => /application\/pdf/i.test(p.headers['content-type']));
  assert.ok(pdf, 'PDF joint');
  assert.match(pdf.headers['content-disposition'], /attachment/i);
  assert.match(pdf.headers['content-disposition'], /FA-2026-\d+\.pdf/);
  const bytes = decodeBody(pdf);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 2000 && bytes.toString('latin1').includes('%%EOF'), `PDF complet (${bytes.length} octets)`);

  assert.deepEqual(logs(`invoice_id = ${id}`).map(l => ({ ...l })), [{ kind: 'invoice', channel: 'outlook-file', to_email: 'h@x.fr, compta@x.fr', status: 'sent' }]);
  const timeline = (await call('GET', `${B}/invoices/${id}`)).data.invoice.timeline;
  assert.ok(timeline.some(t => /Outlook/.test(t.detail) && /PDF joint/.test(t.detail) && /h@x\.fr/.test(t.detail)), JSON.stringify(timeline.map(t => t.detail)));
  const row = (await call('GET', `${B}/invoices`)).data.invoices.find(i => i.id === id);
  assert.ok(row.sentCount >= 1, 'la facture apparaît comme envoyée');
});

test('contrôles : brouillon, objet ou texte vide, adresse invalide refusés sans trace ; destinataire facultatif', async () => {
  const draft = await issuedInvoice(null);
  const rd = await call('POST', `${B}/invoices/${draft}/send`, { channel: 'outlook-file', to: 'h@x.fr', subject: 'S', body: 'B' });
  assert.equal(rd.status, 400); assert.match(rd.data.error, /émis/);
  const id = await issuedInvoice('2026-10-06');
  for (const bad of [{ subject: '', body: 'B' }, { subject: 'S', body: ' ' }, { subject: 'S', body: 'B', to: 'pas-une-adresse' }]) {
    const r = await call('POST', `${B}/invoices/${id}/send`, { channel: 'outlook-file', to: 'h@x.fr', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(logs(`invoice_id = ${id}`), []);
  const noTo = await call('POST', `${B}/invoices/${id}/send`, { channel: 'outlook-file', subject: 'S', body: 'B' });
  assert.equal(noTo.status, 200);
  assert.deepEqual(noTo.data.to, []);
  assert.equal(parse(Buffer.from(noTo.data.eml, 'base64')).headers['x-unsent'], '1');
  assert.equal((await call('POST', `${B}/invoices/99999/send`, { channel: 'outlook-file', subject: 'S', body: 'B' })).status, 404);
});

test('relance et devis : même message, PDF joint, tracé', async () => {
  const id = await issuedInvoice('2026-10-07');
  const rem = await call('POST', `${B}/invoices/${id}/remind`, { level: 1, channel: 'outlook-file', to: 'h@x.fr', subject: 'Relance facture', body: 'Bonjour, un rappel.' });
  assert.equal(rem.status, 200, JSON.stringify(rem.data).slice(0, 200));
  assert.equal(rem.data.file, true);
  assert.ok(parts(parse(Buffer.from(rem.data.eml, 'base64'))).some(p => /application\/pdf/i.test(p.headers['content-type'])));
  assert.deepEqual(logs(`invoice_id = ${id}`).map(l => [l.kind, l.channel, l.status]), [['reminder-1', 'outlook-file', 'sent']]);
  assert.equal((await call('POST', `${B}/invoices/${id}/remind`, { level: 9, channel: 'outlook-file', subject: 'S', body: 'B' })).status, 400);

  const q = await call('POST', `${B}/quotes`, { clientId: hotel, lines: [{ description: 'Location nappes', quantity: 10, unitPrice: 4, vatRate: 20 }] });
  const qid = q.data.quote.id;
  assert.equal((await call('POST', `${B}/quotes/${qid}/send`, { channel: 'outlook-file', to: 'h@x.fr', subject: 'S', body: 'B' })).status, 400, 'devis non finalisé refusé');
  assert.equal((await call('POST', `${B}/quotes/${qid}/issue`, { issueDate: '2026-10-08' })).status, 200);
  const ok = await call('POST', `${B}/quotes/${qid}/send`, { channel: 'outlook-file', to: 'h@x.fr', subject: 'Devis', body: 'Bonjour' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data).slice(0, 200));
  assert.ok(parts(parse(Buffer.from(ok.data.eml, 'base64'))).some(p => /application\/pdf/i.test(p.headers['content-type'])));
  assert.deepEqual(logs(`quote_id = ${qid}`).map(l => [l.kind, l.channel, l.status]), [['quote', 'outlook-file', 'sent']]);
});

test('les autres modes ne changent pas : « outlook » n\'envoie aucun fichier', async () => {
  const id = await issuedInvoice('2026-10-09');
  const r = await call('POST', `${B}/invoices/${id}/send`, { channel: 'outlook', to: 'h@x.fr', subject: 'S', body: 'B' });
  assert.equal(r.status, 200);
  assert.equal(r.data.file, false); assert.equal(r.data.eml, null);
});
