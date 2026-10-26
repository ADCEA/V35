// FEC sur une période choisie : seules les écritures des documents VALIDÉS (émis) dans les dates demandées,
// aperçu avant téléchargement, code de confirmation propre à la période, refus des périodes invalides ou vides.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; let db; let client;
const call = (...a) => s.call(...a);
async function confirm(scope) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, `confirmation ${scope} : ${JSON.stringify(c.data)}`);
}
async function sensitive(scope, method, url, body, raw) { await confirm(scope); return call(method, url, body, raw); }
let n = 0;
async function draftInvoice(qty = 100) {
  n += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-FEC-${n}`, client, 'Hôtel', 'J', '06', 'adr', '2026-09-01').lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, qty, qty);
  const c = await call('POST', `${B}/invoices`, { clientId: client, orderIds: [o] });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  return c.data.invoice.id;
}
async function issued(issueDate, qty) {
  const id = await draftInvoice(qty);
  const r = await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { id, number: r.data.invoice.number };
}
async function fec(qs, scope) {
  const res = await sensitive(scope, 'GET', `${B}/export/fec?${qs}`, null, true);
  const text = await res.text();
  const rows = res.status === 200 ? text.replace(/\r\n$/, '').split('\r\n').slice(1).map(l => l.split('\t')) : [];
  return { status: res.status, res, text, rows };
}
const COL = { journal: 0, num: 2, date: 3, compte: 4, piece: 8, debit: 11, credit: 12 };
const sum = (rows, c) => rows.reduce((t, r) => t + Math.round(parseFloat(r[c].replace(',', '.')) * 100), 0);

let A; let Bf; let C; let CN;
test.before(async () => {
  s = await startServer();
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  client = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number, adresse_facturation)
    VALUES ('h@x.fr','Hôtel Les Lavandes','Jean','0490123456','450 route de Malaucène','84380','Mazan','x','55210055400013','FR40552100554','Siège')`).run().lastInsertRowid);
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  A = await issued('2026-09-10', 100);
  Bf = await issued('2026-10-05', 200);
  C = await issued('2026-10-20', 300);
  // règlement de la facture de septembre, encaissé en octobre
  assert.equal((await call('POST', `${B}/invoices/${A.id}/payments`, { paidOn: '2026-10-12', amount: 50, method: 'virement', reference: 'VIR-A' })).status, 201);
  // avoir sur la facture d'octobre
  const cn = await sensitive(`credit:${Bf.id}`, 'POST', `${B}/invoices/${Bf.id}/credit-note`, { reason: 'Erreur de quantité', full: true });
  assert.equal(cn.status, 201, JSON.stringify(cn.data));
  const cni = await sensitive(`issue:${cn.data.invoice.id}`, 'POST', `${B}/invoices/${cn.data.invoice.id}/issue`, { issueDate: '2026-10-25' });
  assert.equal(cni.status, 200, JSON.stringify(cni.data));
  CN = { id: cn.data.invoice.id, number: cni.data.invoice.number };
  // un brouillon qui ne doit apparaître nulle part
  await draftInvoice(999);
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('aperçu : décompte des documents validés de la période et des brouillons ignorés', async () => {
  const all = (await call('GET', `${B}/export/fec/preview?from=2026-01-01&to=2026-12-31`)).data;
  assert.equal(all.invoices, 3);
  assert.equal(all.creditNotes, 1);
  assert.equal(all.payments, 1);
  assert.equal(all.draftsIgnored, 1);
  assert.equal(all.balanced, true);
  const oct = (await call('GET', `${B}/export/fec/preview?from=2026-10-01&to=2026-10-31`)).data;
  assert.equal(oct.invoices, 2, 'les deux factures d\'octobre, pas celle de septembre');
  assert.equal(oct.creditNotes, 1);
  assert.equal(oct.payments, 1, 'le règlement d\'octobre est repris même si la facture date de septembre');
  const yearForm = (await call('GET', `${B}/export/fec/preview?year=2026`)).data;
  assert.deepEqual({ ...yearForm }, { ...all }, 'year=2026 équivaut au 1er janvier – 31 décembre');
  const none = (await call('GET', `${B}/export/fec/preview?from=2026-03-01&to=2026-03-31`)).data;
  assert.equal(none.rowCount, 0);
});

test('export sur une période : uniquement les documents validés dans les dates, équilibré, numéroté depuis 1', async () => {
  const r = await fec('from=2026-10-01&to=2026-10-31', 'fec:2026-10-01_2026-10-31');
  assert.equal(r.status, 200, r.text);
  assert.match(r.res.headers.get('content-disposition'), /552100554FEC20261031\.txt/, 'nom conforme : SIREN + FEC + date de fin');
  const pieces = new Set(r.rows.map(x => x[COL.piece]));
  assert.ok(pieces.has(Bf.number) && pieces.has(C.number) && pieces.has(CN.number), 'factures et avoir d\'octobre');
  assert.ok(!pieces.has(A.number) || r.rows.filter(x => x[COL.piece] === A.number).every(x => x[COL.journal] !== 'VT'), 'pas d\'écriture de vente pour la facture de septembre');
  assert.equal(r.rows.filter(x => x[COL.journal] === 'VT' && x[COL.piece] === A.number).length, 0);
  const bq = r.rows.filter(x => x[COL.journal] === 'BQ');
  assert.equal(bq.length, 2, 'banque et client pour le règlement du 12/10');
  assert.ok(bq.every(x => x[COL.date] === '20261012'));
  assert.ok(r.rows.every(x => x[COL.date] >= '20261001' && x[COL.date] <= '20261031'), 'aucune écriture hors période');
  assert.equal(sum(r.rows, COL.debit), sum(r.rows, COL.credit), 'débit = crédit');
  const nums = [...new Set(r.rows.map(x => Number(x[COL.num])))];
  assert.deepEqual(nums, nums.map((_, i) => i + 1), 'numérotation continue depuis 1');
  assert.ok(!r.text.includes('999'), 'le brouillon n\'apparaît pas');
  assert.ok(!r.rows.some(x => !x[COL.piece]), 'chaque écriture a sa pièce (un brouillon n\'a pas de numéro)');
});

test('bornes incluses : un seul jour, et la veille/le lendemain exclus', async () => {
  const day = await fec('from=2026-10-05&to=2026-10-05', 'fec:2026-10-05_2026-10-05');
  assert.equal(day.status, 200, day.text);
  assert.ok(day.rows.length >= 3 && day.rows.every(x => x[COL.piece] === Bf.number && x[COL.date] === '20261005'));
  const before = await fec('from=2026-10-06&to=2026-10-19', 'fec:2026-10-06_2026-10-19');
  assert.equal(before.status, 200);
  assert.ok(!before.rows.some(x => x[COL.piece] === Bf.number || x[COL.piece] === C.number), 'ni le 05/10 ni le 20/10');
  assert.ok(before.rows.some(x => x[COL.journal] === 'BQ'), 'mais le règlement du 12/10');
});

test('année entière comme avant : même nom de fichier et même contenu que la période 1er janv. – 31 déc.', async () => {
  const byYear = await fec('year=2026', 'fec:2026');
  assert.equal(byYear.status, 200, byYear.text);
  assert.match(byYear.res.headers.get('content-disposition'), /552100554FEC20261231\.txt/);
  const byDates = await fec('from=2026-01-01&to=2026-12-31', 'fec:2026-01-01_2026-12-31');
  assert.equal(byDates.text, byYear.text);
  assert.equal(byYear.res.headers.get('x-fec-rows'), String(byYear.rows.length));
  assert.equal(byYear.rows.filter(x => x[COL.journal] === 'VT' && x[COL.compte] === '411').length, 4, '3 factures + 1 avoir validés');
});

test('période invalide : refusée sans demander le code ; période vide : refusée avec un message clair', async () => {
  for (const qs of ['from=2026-10-31&to=2026-10-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-10-01', 'to=2026-10-01', 'from=abc&to=def', 'year=1999', 'year=abc', 'from=1999-12-31&to=2026-01-01']) {
    const r = await call('GET', `${B}/export/fec?${qs}`);
    assert.equal(r.status, 400, `${qs} → ${r.status} ${JSON.stringify(r.data)}`);
    const p = await call('GET', `${B}/export/fec/preview?${qs}`);
    assert.equal(p.status, 400, `aperçu ${qs}`);
  }
  const empty = await fec('from=2026-03-01&to=2026-03-31', 'fec:2026-03-01_2026-03-31');
  assert.equal(empty.status, 422);
  assert.match(JSON.parse(empty.text).error, /Aucune écriture/);
});

test('le code de confirmation vaut pour la période demandée, une seule fois', async () => {
  const noCode = await call('GET', `${B}/export/fec?from=2026-10-01&to=2026-10-31`);
  assert.equal(noCode.status, 403);
  assert.equal(noCode.data.scope, 'fec:2026-10-01_2026-10-31');
  // confirmation d'une autre période : refusé
  await confirm('fec:2026-09-01_2026-09-30');
  assert.equal((await call('GET', `${B}/export/fec?from=2026-10-01&to=2026-10-31`)).status, 403);
  assert.equal((await call('GET', `${B}/export/fec?from=2026-09-01&to=2026-09-30`)).status, 200);
  assert.equal((await call('GET', `${B}/export/fec?from=2026-09-01&to=2026-09-30`)).status, 403, 'usage unique');
  // la confirmation d'une année ne permet pas une période
  await confirm('fec:2026');
  assert.equal((await call('GET', `${B}/export/fec?from=2026-01-01&to=2026-12-31`)).status, 403);
});
