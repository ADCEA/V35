// Test de bout en bout : vrai serveur, vraie base jetable, vraies requêtes HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os'); const path = require('path'); const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-http-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
let server; let cookie = '';

async function call(method, url, body, raw = false) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  if (raw) return res;
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

test.before(async () => {
  const env = { ...process.env, DATA_DIR, PORT: String(PORT), SESSION_SECRET: 'test-secret' };
  delete env.ODOO_URL; delete env.ODOO_API_KEY;
  server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('serveur non démarré')), 15000);
    server.stdout.on('data', d => { if (String(d).includes('serveur lancé')) { clearTimeout(t); resolve(); } });
    server.stderr.on('data', d => process.stderr.write(d));
  });
});
test.after(() => server && server.kill());

test('accès refusé sans session admin', async () => {
  assert.equal((await call('GET', '/api/admin/billing/settings')).status, 401);
  assert.equal((await call('GET', '/api/admin/billing/integrity')).status, 401);
});

test('scénario complet via HTTP', async () => {
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);

  // Seed
  const db = new Database(path.join(DATA_DIR, 'database.sqlite'));
  const c = db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number, adresse_facturation)
    VALUES ('h@x.fr','Hôtel <b>Test</b>','Jean','06','1 rue du Test','84000','Avignon','x','55210055400013','FR40552100554','Siège, 2 avenue du Siège')`).run();
  const clientId = Number(c.lastInsertRowid);
  const ids = [];
  for (const d of ['2026-10-01', '2026-10-08']) {
    const o = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`)
      .run(`CZ-${d}`, clientId, 'Hôtel', 'J', '06', '1 rue du Test', d);
    ids.push(Number(o.lastInsertRowid));
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(ids.at(-1), 'd', 'Drap 2 places', 'D2', 'DRAP2', 1.234, 100, 100);
  }
  db.close();

  // Réglages incomplets → émission refusée avec la liste des manques
  let r = await call('GET', '/api/admin/billing/settings');
  assert.equal(r.data.settings.engine, 'native');
  r = await call('POST', '/api/admin/billing/invoices', { clientId, orderIds: ids });
  assert.equal(r.status, 201);
  const invId = r.data.invoice.id;
  assert.equal(r.data.invoice.totalHtCents, 24680);
  r = await call('POST', `/api/admin/billing/invoices/${invId}/issue`, { issueDate: '2026-10-31' });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /capital social/);
  assert.match(r.data.error, /RCS/);

  // Réglages invalides refusés
  assert.equal((await call('PUT', '/api/admin/billing/settings', { siren: '123456789' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/billing/settings', { payment_terms_days: 90 })).status, 400);

  r = await call('PUT', '/api/admin/billing/settings', { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200);

  // Le détail du brouillon liste les manques (aucun maintenant) et le PDF brouillon se génère
  r = await call('GET', `/api/admin/billing/invoices/${invId}`);
  assert.deepEqual(r.data.invoice.preview.problems, []);
  let pdf = await call('GET', `/api/admin/billing/invoices/${invId}/pdf`, null, true);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  // Édition du brouillon puis émission
  r = await call('PUT', `/api/admin/billing/invoices/${invId}`, { notes: 'Merci' });
  assert.equal(r.status, 200);
  r = await call('POST', `/api/admin/billing/invoices/${invId}/issue`, { issueDate: '2026-10-31' });
  assert.equal(r.status, 200);
  assert.equal(r.data.invoice.number, 'FA-2026-000001');
  // Émise : modification et suppression refusées (409)
  assert.equal((await call('PUT', `/api/admin/billing/invoices/${invId}`, { notes: 'x' })).status, 409);
  assert.equal((await call('DELETE', `/api/admin/billing/invoices/${invId}`)).status, 409);

  // Le circuit Odoo ne voit plus ces BL
  r = await call('GET', `/api/admin/clients/${clientId}/invoiceable-orders`);
  assert.equal(r.data.orders.length, 0);

  // Avoir total puis BL de nouveau facturables
  r = await call('POST', `/api/admin/billing/invoices/${invId}/credit-note`, { reason: 'Annulation', full: true });
  assert.equal(r.status, 201);
  const cnId = r.data.invoice.id;
  r = await call('POST', `/api/admin/billing/invoices/${cnId}/issue`, { issueDate: '2026-11-02' });
  assert.equal(r.data.invoice.number, 'AV-2026-000001');
  r = await call('GET', `/api/admin/billing/clients/${clientId}/invoiceable-orders`);
  assert.equal(r.data.orders.length, 2, 'BL libérés par l\'avoir total');
  r = await call('GET', `/api/admin/billing/invoices/${invId}`);
  assert.equal(r.data.invoice.paymentStatus, 'credited');

  // Règlement sur une facture entièrement créditée → refusé
  assert.equal((await call('POST', `/api/admin/billing/invoices/${invId}/payments`, { amount: 10 })).status, 400);

  // Nouvelle facture + règlement partiel + solde
  r = await call('POST', '/api/admin/billing/invoices', { clientId, orderIds: ids });
  const inv2 = r.data.invoice.id;
  r = await call('POST', `/api/admin/billing/invoices/${inv2}/issue`, { issueDate: '2026-11-05' });
  assert.equal(r.data.invoice.number, 'FA-2026-000002');
  r = await call('POST', `/api/admin/billing/invoices/${inv2}/payments`, { paidOn: '2026-11-20', amount: 100, method: 'virement', reference: 'VIR 123' });
  assert.equal(r.data.invoice.paymentStatus, 'partial');
  r = await call('POST', `/api/admin/billing/invoices/${inv2}/payments`, { paidOn: '2026-11-21', amount: r.data.invoice.balanceCents / 100, method: 'cheque' });
  assert.equal(r.data.invoice.paymentStatus, 'paid');

  // PDF émis + PDF avoir
  for (const id of [inv2, cnId]) {
    pdf = await call('GET', `/api/admin/billing/invoices/${id}/pdf`, null, true);
    assert.equal(pdf.status, 200);
    assert.ok((await pdf.arrayBuffer()).byteLength > 1500);
  }

  // Intégrité + FEC
  r = await call('GET', '/api/admin/billing/integrity');
  assert.deepEqual(r.data.problems, []);
  assert.equal(r.data.checked, 3);
  const fec = await call('GET', '/api/admin/billing/export/fec?year=2026', null, true);
  assert.equal(fec.status, 200);
  assert.match(fec.headers.get('content-disposition'), /552100554FEC20261231\.txt/);
  const txt = await fec.text();
  const lines = txt.replace(/\r\n$/, '').split('\r\n');
  assert.equal(lines[0].split('\t').length, 18);
  assert.ok(lines.slice(1).every(l => l.split('\t').length === 18));
  // Équilibre débit = crédit
  let d = 0, cr = 0;
  for (const l of lines.slice(1)) { const f = l.split('\t'); d += parseFloat(f[11].replace(',', '.')); cr += parseFloat(f[12].replace(',', '.')); }
  assert.equal(Math.round(d * 100), Math.round(cr * 100));
  assert.ok(txt.includes('Hôtel <b>Test</b>'), 'libellé tel quel dans le FEC (pas de HTML interprété)');

  // Falsification directe de la base → détectée
  const raw = new Database(path.join(DATA_DIR, 'database.sqlite'));
  assert.throws(() => raw.prepare('UPDATE native_invoice_lines SET unit_price = 0.01').run(), /modification interdite/);
  raw.close();
});
