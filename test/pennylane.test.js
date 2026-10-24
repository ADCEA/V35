// Envoi vers Pennylane, contre un faux serveur qui reproduit les contrôles documentés
// (jeton, client par référence externe, PDF déposé puis importé, lignes équilibrées).
// Ce test ne prouve PAS que l'API réelle accepte exactement ces champs : il prouve
// que le logiciel fait la séquence prévue et gère les échecs. À valider dans le bac à sable Pennylane.
const os = require('os'); const path = require('path'); const fs = require('fs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-pl-'));
process.env.DATA_DIR = DATA_DIR; process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const db = require('../src/db');
const engine = require('../src/billing/engine');
const pl = require('../src/billing/pennylane');

const TOKEN = 'TESTTOKEN';

function fakePennylane() {
  const st = { customers: [], files: [], invoices: [], calls: [], failImport: null, rateLimitOnce: false, badToken: false };
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const route = `${req.method} ${url.pathname.replace('/api/external/v2', '')}`;
      st.calls.push(route);
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}` || st.badToken) return send(401, { error: 'invalid token' });
      if (st.rateLimitOnce && route === 'POST /file_attachments') { st.rateLimitOnce = false; return send(429, { error: 'slow down' }, { 'retry-after': '1' }); }
      if (route === 'GET /me') return send(200, { company: { name: 'Blanchisserie' } });
      if (route === 'GET /customers') {
        const f = JSON.parse(url.searchParams.get('filter') || '[]')[0] || {};
        return send(200, { items: st.customers.filter(c => c.external_reference === f.value) });
      }
      if (route === 'POST /company_customers') {
        const b = JSON.parse(body); if (!b.name || !b.external_reference) return send(400, { error: 'name/external_reference required' });
        const c = { id: 1000 + st.customers.length, ...b }; st.customers.push(c); return send(201, c);
      }
      if (route === 'POST /file_attachments') {
        const ct = req.headers['content-type'] || ''; const m = ct.match(/boundary=(.+)$/);
        if (!m) return send(400, { error: 'multipart expected' });
        const text = body.toString('latin1');
        if (!/name="file"; filename=".+\.pdf"/.test(text) || !text.includes('%PDF-')) return send(422, { error: 'PDF file required' });
        const f = { id: 5000 + st.files.length }; st.files.push(f); return send(201, f);
      }
      if (route === 'POST /customer_invoices/import') {
        if (st.failImport) { const code = st.failImport; st.failImport = null; return send(code, { error: 'Entry lines are not balanced' }); }
        const b = JSON.parse(body);
        for (const k of ['file_attachment_id', 'customer_id', 'date', 'deadline', 'currency_amount', 'currency_tax', 'currency_amount_before_tax', 'invoice_lines']) if (b[k] === undefined) return send(400, { error: `${k} missing` });
        if (b.invoice_lines.some(l => 'label' in l)) return send(400, { error: 'label not allowed' });
        const sum = b.invoice_lines.reduce((s, l) => s + Math.round(parseFloat(l.currency_amount) * 100), 0);
        if (sum !== Math.round(parseFloat(b.currency_amount) * 100)) return send(422, { error: 'Entry lines are not balanced' });
        const inv = { id: 9000 + st.invoices.length, ...b }; st.invoices.push(inv); return send(201, inv);
      }
      send(404, { error: 'unknown ' + route });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ st, base: `http://127.0.0.1:${server.address().port}/api/external/v2`, close: () => new Promise(x => server.close(x)) })));
}

const L = (description, quantity, unitPrice, vatRate = 20) => ({ description, quantity, unitPrice, vatRate });
function siret(n) {
  const lc = (p) => { for (let d = 0; d < 10; d++) if (engine.luhnOk(p + d)) return p + d; };
  return lc(lc(String(20000000 + n)) + '0001');
}

let client, i1, i2, cn;
const envFor = (fake, extra = {}) => ({ ...process.env, PENNYLANE_API_TOKEN: TOKEN, PENNYLANE_BASE_URL: fake.base, ...extra });

test('mise en place', () => {
  db.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', vat_number='FR40552100554', rcs='RCS Avignon' WHERE id=1`).run();
  client = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret) VALUES ('p@x.fr','Hôtel Pennylane','J','06','2 rue Test','84000','Avignon','x',?)`).run(siret(7)).lastInsertRowid);
  // taux mixtes : 100 € à 20 % + 50 € à 10 %
  i1 = engine.issueInvoice(engine.createDraftFromLines(client, [L('A', 1, 100, 20), L('B', 1, 50, 10)]).id, { issueDate: '2026-10-01' }).id;
  i2 = engine.issueInvoice(engine.createDraftFromLines(client, [L('C', 3, 33.33, 20)]).id, { issueDate: '2026-10-02' }).id;
  const draft = engine.createCreditNoteDraft(i2, { reason: 'Erreur', lines: [{ lineId: engine.loadInvoice(i2).lines[0].id, quantity: 1 }] });
  cn = engine.issueInvoice(draft.id, { issueDate: '2026-10-03' }).id;
});

test('payload : lignes par taux de TVA, équilibrées, avoir en négatif', () => {
  const a = pl.importPayload(engine.loadInvoice(i1), 'C1', 'F1');
  assert.deepEqual(a.invoice_lines.map(l => [l.vat_rate, l.raw_currency_unit_price, l.currency_tax, l.currency_amount]), [['FR_100', '50.00', '5.00', '55.00'], ['FR_200', '100.00', '20.00', '120.00']]);
  assert.deepEqual([a.currency_amount_before_tax, a.currency_tax, a.currency_amount, a.date, a.deadline], ['150.00', '25.00', '175.00', '2026-10-01', '2026-10-31']);
  const c = pl.importPayload(engine.loadInvoice(cn), 'C1', 'F2');
  assert.equal(c.currency_amount, '-40.00'); assert.equal(c.invoice_lines[0].currency_amount, '-40.00');
  assert.ok(a.invoice_lines.every(l => !('label' in l)));
});

test('envoi : client créé une fois, PDF déposé, facture importée, idempotent', async () => {
  const fake = await fakePennylane();
  try {
    const env = envFor(fake);
    assert.deepEqual(await pl.testConnection({ env }), { ok: true });
    let row = await pl.sendOne(i1, { env });
    assert.equal(row.status, 'sent'); assert.equal(row.pennylane_id, '9000'); assert.equal(fake.st.customers.length, 1);
    assert.equal(fake.st.customers[0].external_reference, `cezanne-client-${client}`);
    assert.deepEqual(fake.st.customers[0].emails, ['p@x.fr']);

    row = await pl.sendOne(i2, { env });
    assert.equal(row.status, 'sent'); assert.equal(fake.st.customers.length, 1, 'le client existant est retrouvé, pas recréé');
    const callsBefore = fake.st.calls.length;
    await pl.sendOne(i1, { env });
    assert.equal(fake.st.calls.length, callsBefore, 'déjà envoyé : aucun appel');
    assert.equal(fake.st.invoices.length, 2);

    // Avoir : montants négatifs
    await pl.sendOne(cn, { env });
    assert.equal(fake.st.invoices[2].currency_amount, '-40.00');

    const ev = db.prepare("SELECT action FROM billing_events WHERE action LIKE 'pennylane%'").all().map(e => e.action);
    assert.deepEqual(ev, ['pennylane_sent', 'pennylane_sent', 'pennylane_sent']);
    assert.deepEqual(pl.getStatus(env).counts, { pending: 0, sent: 3, error: 0, notQueued: 0 });
  } finally { await fake.close(); }
});

test('échecs : 422 conservé avec le message, relance manuelle, 401, limitation de débit, jeton absent', async () => {
  const fake = await fakePennylane();
  try {
    const env = envFor(fake);
    const i3 = engine.issueInvoice(engine.createDraftFromLines(client, [L('D', 1, 10, 20)]).id, { issueDate: '2026-10-05' }).id;
    fake.st.failImport = 422;
    let row = await pl.sendOne(i3, { env });
    assert.equal(row.status, 'error'); assert.match(row.last_error, /422.*not balanced/); assert.equal(row.attempts, 1);
    assert.equal(pl.getStatus(env).errors[0].number, engine.loadInvoice(i3).number);
    assert.equal(engine.verifyIntegrity().ok, true, 'le journal reste chaîné et valide');

    assert.equal(pl.retryFailed(), 1);
    assert.equal(await pl.processQueue({ env }), 1);
    assert.equal(db.prepare('SELECT status FROM pennylane_sync WHERE invoice_id = ?').get(i3).status, 'sent');

    // 401 : message explicite
    const i4 = engine.issueInvoice(engine.createDraftFromLines(client, [L('E', 1, 10, 20)]).id, { issueDate: '2026-10-06' }).id;
    fake.st.badToken = true;
    row = await pl.sendOne(i4, { env });
    assert.match(row.last_error, /401.*jeton refusé/);
    fake.st.badToken = false;

    // 429 : une seule reprise après Retry-After, puis succès
    pl.retryFailed(); fake.st.rateLimitOnce = true;
    const t0 = Date.now();
    row = await pl.sendOne(i4, { env });
    assert.equal(row.status, 'sent'); assert.ok(Date.now() - t0 >= 900, 'a attendu le Retry-After');

    // Jeton absent : refus clair, aucune ligne d'erreur parasite
    await assert.rejects(() => pl.sendOne(i4, { env: { ...process.env, PENNYLANE_API_TOKEN: '' } }), (e) => e.status === 503);
    // Brouillon : refusé
    const d = engine.createDraftFromLines(client, [L('F', 1, 1, 20)]);
    await assert.rejects(() => pl.sendOne(d.id, { env }), /émis/);
  } finally { await fake.close(); }
});

test('envoi automatique : seulement les documents émis après l\'activation', async () => {
  const fake = await fakePennylane();
  try {
    const env = envFor(fake);
    const old = engine.issueInvoice(engine.createDraftFromLines(client, [L('G', 1, 5, 20)]).id, { issueDate: '2026-10-07' }).id;
    await new Promise(r => setTimeout(r, 5));
    pl.setAuto(true);
    await new Promise(r => setTimeout(r, 20));
    const fresh = engine.issueInvoice(engine.createDraftFromLines(client, [L('H', 1, 5, 20)]).id, { issueDate: '2026-10-08' }).id;
    assert.equal(pl.autoEnqueue(), 1);
    assert.equal(await pl.processQueue({ env }), 1);
    assert.equal(db.prepare('SELECT status FROM pennylane_sync WHERE invoice_id = ?').get(fresh).status, 'sent');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pennylane_sync WHERE invoice_id = ?').get(old).c, 0, 'l\'ancien document n\'est pas envoyé automatiquement');
    assert.equal(pl.getStatus(env).counts.notQueued, 1);
    pl.setAuto(false);
    assert.equal(pl.getStatus(env).autoSince, null);
  } finally { await fake.close(); }
});
