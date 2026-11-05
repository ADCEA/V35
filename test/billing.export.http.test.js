// Cases à cocher : export des factures sélectionnées (un PDF par facture, en ZIP) et export des BL cochés ;
// format de facture (niveau de détail) dans la liste des BL.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');
const { createZip, crc32 } = require('../src/utils/zip');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; let db;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, `confirmation ${scope} : ${JSON.stringify(c.data)}`);
  return call(method, url, body);
}

/** Relit une archive ZIP (répertoire central) : [{ name, data }], en vérifiant tailles et CRC. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'fin d\'archive introuvable');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10); const crc = buf.readUInt32LE(p + 16); const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const elen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32); const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(off), 0x04034b50);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const body = buf.slice(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.equal(data.length, usize, `taille de ${name}`); assert.equal(crc32(data), crc, `CRC de ${name}`);
    out.push({ name, data }); p += 46 + nlen + elen + clen;
  }
  return out;
}

test('zip : archive relisible, noms UTF-8, contenu compressible ou non, refus des doublons et des chemins', () => {
  const text = Buffer.from('bonjour '.repeat(500));
  const random = require('crypto').randomBytes(300);
  const files = readZip(createZip([{ name: 'a.txt', data: text }, { name: 'été-é.bin', data: random }, { name: 'vide.txt', data: Buffer.alloc(0) }]));
  assert.deepEqual(files.map(f => f.name), ['a.txt', 'été-é.bin', 'vide.txt']);
  assert.ok(files[0].data.equals(text) && files[1].data.equals(random) && files[2].data.length === 0);
  assert.throws(() => createZip([{ name: 'x', data: Buffer.from('1') }, { name: 'x', data: Buffer.from('2') }]), /double/);
  assert.throws(() => createZip([{ name: '../x', data: Buffer.from('1') }]), /invalide/);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

let n = 0;
const mkClient = async (societe, extra = {}) => (await call('POST', `${B}/catalog/clients`, { societe, contact: 'X', tel: '0600000000', adresse: '1 rue A', email: `${societe.toLowerCase().replace(/\W/g, '')}@x.fr`, siret: '55210055400013', ...extra })).data.client.id;
function mkOrder(clientId, date, qty = 10, price = 2) {
  n += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-EX-${n}`, clientId, 'Client', 'J', '06', 'adr', date).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', price, qty, qty);
  return o;
}
async function mkInvoice(clientId, orderIds, issue, detailLevel) {
  const c = await call('POST', `${B}/invoices`, { clientId, orderIds, detailLevel });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.invoice.id;
  if (!issue) return { id };
  const r = await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate: '2026-11-02' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { id, number: r.data.invoice.number };
}
const bin = async (url) => { const res = await call('GET', url, null, true); return { status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) }; };

let a; let b2; let dr; let hotelA; let hotelB; let oA; let oB; let oC;
test('export des factures cochées : une archive ZIP avec un PDF par document émis, les brouillons sont ignorés', async () => {
  hotelA = await mkClient('HOTEL ALPHA'); hotelB = await mkClient('HOTEL BRAVO', { invoiceDetailLevel: 'per_bl' });
  oA = mkOrder(hotelA, '2026-10-12'); oB = mkOrder(hotelB, '2026-10-20'); oC = mkOrder(hotelA, '2026-11-02');
  a = await mkInvoice(hotelA, [oA], true, 'aggregated'); b2 = await mkInvoice(hotelB, [oB], true); dr = await mkInvoice(hotelA, [oC], false, 'per_bl');

  const r = await bin(`${B}/invoices/export.zip?ids=${a.id},${b2.id},${dr.id}`);
  assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'application/zip');
  assert.match(r.headers['content-disposition'], /attachment; filename="factures-\d{4}-\d{2}-\d{2}\.zip"/);
  assert.equal(r.headers['x-document-count'], '2'); assert.equal(r.headers['x-skipped-drafts'], '1');
  const files = readZip(r.body);
  assert.deepEqual(files.map(f => f.name).sort(), [`${a.number}.pdf`, `${b2.number}.pdf`].sort());
  for (const f of files) assert.equal(f.data.slice(0, 5).toString(), '%PDF-', `${f.name} est un PDF`);
  // Même PDF que le téléchargement unitaire
  const single = await bin(`${B}/invoices/${a.id}/pdf`);
  assert.equal(single.status, 200);
  assert.equal(files.find(f => f.name === `${a.number}.pdf`).data.length, single.body.length);
  assert.ok(db.prepare("SELECT 1 FROM billing_events WHERE action = 'invoices_exported'").get(), 'export inscrit au journal');
});

test('export des factures : sélection vide, invalide, uniquement des brouillons, trop grande', async () => {
  const none = await call('GET', `${B}/invoices/export.zip`);
  assert.equal(none.status, 400); assert.match(none.data.error, /au moins une facture/);
  const bad = await call('GET', `${B}/invoices/export.zip?ids=abc`);
  assert.equal(bad.status, 400);
  const onlyDraft = await call('GET', `${B}/invoices/export.zip?ids=${dr.id}`);
  assert.equal(onlyDraft.status, 422); assert.match(onlyDraft.data.error, /brouillon/);
  const missing = await call('GET', `${B}/invoices/export.zip?ids=999999`);
  assert.equal(missing.status, 404);
  const many = await call('GET', `${B}/invoices/export.zip?ids=${Array.from({ length: 201 }, (_, i) => i + 1).join(',')}`);
  assert.equal(many.status, 400); assert.match(many.data.error, /Maximum 200/);
});

test('BL : liste avec le format de facture (fiche de l\'hôtel ou facture), sélection par identifiants pour les exports', async () => {
  const all = (await call('GET', `${B}/deliveries`)).data;
  const by = Object.fromEntries(all.deliveries.map(d => [d.id, d]));
  assert.equal(by[oA].invoiceFormat, 'aggregated', 'facturé : format de la facture émise (pas celui de la fiche)');
  assert.equal(by[oB].invoiceFormat, 'per_bl', 'facturé : format de la fiche au moment de la facture');
  assert.equal(by[oC].invoiceFormat, 'per_bl', 'brouillon : format du brouillon (la fiche de l\'hôtel dit « détaillé »)');
  // à facturer : format de la fiche de l'hôtel
  const oD = mkOrder(hotelB, '2026-11-03'); const oE = mkOrder(hotelA, '2026-11-03');
  const again = Object.fromEntries((await call('GET', `${B}/deliveries`)).data.deliveries.map(d => [d.id, d]));
  assert.equal(again[oD].invoiceFormat, 'per_bl'); assert.equal(again[oE].invoiceFormat, 'detail');
  // ancien circuit : format inconnu
  const old = Number(db.prepare(`INSERT INTO invoices (client_id, period_start, period_end, status) VALUES (?,?,?, 'posted')`).run(hotelA, '2026-10-01', '2026-10-31').lastInsertRowid);
  db.prepare('INSERT INTO invoice_orders (invoice_id, order_id) VALUES (?,?)').run(old, oE);
  const legacy = (await call('GET', `${B}/deliveries`)).data.deliveries.find(d => d.id === oE);
  assert.equal(legacy.billing.legacy, true); assert.equal(legacy.invoiceFormat, null);

  // sélection par identifiants
  const sel = (await call('GET', `${B}/deliveries?ids=${oA},${oD}`)).data;
  assert.deepEqual(sel.deliveries.map(d => d.id).sort((x, y) => x - y), [oA, oD].sort((x, y) => x - y)); assert.equal(sel.total, 2);
  assert.equal((await call('GET', `${B}/deliveries?ids=1,x`)).status, 400);
  const pdf = await bin(`${B}/deliveries/export.pdf?ids=${oA},${oB},${oD}`);
  assert.equal(pdf.status, 200); assert.equal(pdf.headers['x-order-count'], '3'); assert.equal(pdf.body.slice(0, 5).toString(), '%PDF-');
  const csv = await bin(`${B}/deliveries/export.csv?ids=${oA},${oD}`);
  assert.equal(csv.status, 200);
  const lines = csv.body.toString('utf8').replace(/^﻿/, '').trim().split(/\r\n/);
  assert.match(lines[0], /;paiement;format_facture$/); assert.equal(lines.length, 3);
  assert.ok(lines.some(l => /Regroupé/.test(l)) && lines.some(l => /Une ligne par BL/.test(l)));
  const tooMany = await call('GET', `${B}/deliveries?ids=${Array.from({ length: 501 }, (_, i) => i + 1).join(',')}`);
  assert.equal(tooMany.status, 400);
});
