// Accès Claude : jeton en lecture seule, périmètres, expiration, révocation, journal, et surtout rien qui fuite.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'); const crypto = require('crypto');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
const API = '/api/claude/v1';
let s; let off; let clientId; let invoiceId; let orderIds;

async function sensitive(who, scope, method, url, body) {
  const c = await who.call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return who.call(method, url, body);
}
const mint = async (body = {}) => {
  const r = await sensitive(s, 'claude-access', 'POST', `${B}/claude/access`, { label: 'Analyse', scopes: ['exploitation'], days: 7, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const get = (token, url, init = {}) => fetch(`${s.BASE}${API}${url}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
const json = async (res) => { try { return await res.json(); } catch { return null; } };
const rows = (sql, ...a) => { const db = new Database(path.join(s.DATA_DIR, 'database.sqlite')); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const exec = (sql, ...a) => { const db = new Database(path.join(s.DATA_DIR, 'database.sqlite')); try { return db.prepare(sql).run(...a); } finally { db.close(); } };

test.before(async () => {
  s = await startServer();
  assert.equal((await s.call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await s.call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);

  const db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const c = db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number, adresse_facturation, webhook_url, webhook_secret)
    VALUES ('h@x.fr','Hôtel Test','Jean','0600000000','1 rue du Test','84000','Avignon','HASH-SECRET-DU-CODE','55210055400013','FR40552100554','Siège, 2 avenue du Siège','https://hooks.example.org/in','WEBHOOK-SECRET-XYZ')`).run();
  clientId = Number(c.lastInsertRowid);
  db.prepare(`INSERT INTO api_tokens (client_id, token, label) VALUES (?, 'API-TOKEN-CLAIR-123', 'logiciel hôtel')`).run(clientId);
  orderIds = [];
  for (const d of ['2026-10-01', '2026-10-08']) {
    const o = db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`)
      .run(`CZ-${d}`, clientId, 'Hôtel Test', 'Jean', '0600000000', '1 rue du Test', d);
    orderIds.push(Number(o.lastInsertRowid));
    db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(orderIds.at(-1), 'd', 'Drap 2 places', 'D2', 'DRAP2', 1.234, 100, 100);
  }
  db.close();

  let r = await sensitive(s, 'settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await s.call('POST', `${B}/invoices`, { clientId, orderIds });
  invoiceId = r.data.invoice.id;
  r = await sensitive(s, `issue:${invoiceId}`, 'POST', `${B}/invoices/${invoiceId}/issue`, { issueDate: '2026-10-31' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await s.call('POST', `${B}/invoices/${invoiceId}/payments`, { paidOn: '2026-11-05', amount: 100, method: 'virement', reference: 'VIR 42' });
  assert.equal(r.status, 201, JSON.stringify(r.data));

  off = await startServer({ env: { CLAUDE_ACCESS: 'off' } });
  assert.equal((await off.call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await off.call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
});
test.after(async () => { if (s) await s.stop(); if (off) await off.stop(); });

test('créer un accès exige l\'administrateur, le code de la Facturation, un nom, un périmètre et une durée raisonnable', async () => {
  s.newClient();
  assert.equal((await s.call('GET', `${B}/claude/access`)).status, 401);
  assert.equal((await s.call('POST', `${B}/claude/access`, { label: 'x', scopes: ['finance'] })).status, 401);
  assert.equal((await s.call('POST', '/api/admin/login', { password: 'secret123' })).status, 200);
  assert.equal((await s.call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);

  const st = await s.call('GET', `${B}/claude/access`);
  assert.equal(st.status, 200);
  assert.equal(st.data.enabled, true);
  assert.deepEqual(Object.keys(st.data.scopes), ['exploitation', 'hotels', 'finance']);
  assert.deepEqual(st.data.tokens, []);

  // sans ressaisie du code : refusé
  const r0 = await s.call('POST', `${B}/claude/access`, { label: 'x', scopes: ['finance'] });
  assert.equal(r0.status, 403);
  assert.equal(r0.data.code, 'STEP_UP_REQUIRED');

  for (const [body, re] of [
    [{ label: '', scopes: ['finance'] }, /nom/i],
    [{ label: 'x', scopes: [] }, /périmètre/i],
    [{ label: 'x', scopes: ['admin'] }, /inconnu/i],
    [{ label: 'x', scopes: ['finance'], days: 31 }, /1 à 30/],
    [{ label: 'x', scopes: ['finance'], days: 0 }, /1 à 30/],
    [{ label: 'x', scopes: ['finance'], days: 2.5 }, /1 à 30/],
    [{ label: 'x'.repeat(61), scopes: ['finance'] }, /trop long/i],
  ]) {
    const r = await sensitive(s, 'claude-access', 'POST', `${B}/claude/access`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, re);
  }
});

test('le jeton n\'est montré qu\'une fois : la base et la liste n\'en gardent que l\'empreinte', async () => {
  const r = await mint({ label: 'Analyse de mai', scopes: ['finance', 'exploitation'], days: 3 });
  assert.match(r.token, /^czc_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(r.access.scopes, ['exploitation', 'finance'], 'ordre stable');
  const days = (Date.parse(r.access.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 2.9 && days < 3.1);

  const st = await s.call('GET', `${B}/claude/access`);
  assert.ok(!JSON.stringify(st.data).includes(r.token), 'ni dans la liste ni dans le journal');
  assert.ok(!JSON.stringify(r.state).includes(r.token));
  const row = rows('SELECT token_hash, label, scopes FROM claude_tokens WHERE id = ?', r.access.id)[0];
  assert.equal(row.token_hash, crypto.createHash('sha256').update(r.token).digest('hex'));
  const fs = require('fs');
  assert.ok(!fs.readFileSync(path.join(s.DATA_DIR, 'database.sqlite')).includes(Buffer.from(r.token)));
  assert.ok(st.data.tokens.some(t => t.id === r.access.id && t.status === 'active' && t.useCount === 0));
  // tracé dans le journal de sécurité (sans le jeton)
  const ev = rows("SELECT detail FROM security_log WHERE event = 'claude_token_created'");
  assert.ok(ev.length >= 1 && ev.every(e => !e.detail.includes(r.token)));
  await s.call('DELETE', `${B}/claude/access/${r.access.id}`);
});

test('sans jeton, avec un faux jeton, ou jeton dans l\'adresse : refus', async () => {
  assert.equal((await get(null, '/')).status, 401);
  assert.equal((await get('czc_' + 'a'.repeat(43), '/')).status, 401);
  assert.equal((await get('n-importe-quoi', '/')).status, 401);
  const t = await mint();
  const viaUrl = await fetch(`${s.BASE}${API}/?token=${t.token}&access_token=${t.token}`);
  assert.equal(viaUrl.status, 401, 'le jeton ne passe jamais dans l\'adresse');
  assert.equal((await get(t.token, '/')).status, 200);
});

test('lecture seule : tout sauf GET est refusé, même avec un jeton valable', async () => {
  const t = await mint({ scopes: ['exploitation', 'hotels', 'finance'] });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const url of ['/orders', `/orders/${orderIds[0]}/status`, '/hotels/1', '/finance/invoices', '/']) {
      const res = await get(t.token, url, { method, body: method === 'DELETE' ? undefined : '{}' });
      assert.equal(res.status, 405, `${method} ${url}`);
      assert.match(res.headers.get('allow'), /GET/);
    }
  }
  // et rien n'a bougé
  assert.equal(rows('SELECT status FROM orders WHERE id = ?', orderIds[0])[0].status, 'livree');
  assert.equal(rows('SELECT COUNT(*) n FROM clients')[0].n, 1);
});

test('le jeton Claude ne donne accès ni à l\'administration, ni à l\'API des hôtels, ni aux sauvegardes', async () => {
  const t = await mint({ scopes: ['exploitation', 'hotels', 'finance'] });
  const H = { Authorization: `Bearer ${t.token}` };
  for (const url of ['/api/admin/orders', '/api/admin/stats', `${B}/invoices`, `${B}/settings`, `${B}/backup/status`, '/api/v1/articles', '/api/backup-pull/latest']) {
    const res = await fetch(s.BASE + url, { headers: H });
    assert.ok([401, 403].includes(res.status), `${url} → ${res.status}`);
  }
});

test('périmètre « exploitation » : commandes sans prix ni téléphone, et pas les autres périmètres', async () => {
  const t = await mint({ scopes: ['exploitation'] });
  const root = await json(await get(t.token, '/'));
  assert.equal(root.readOnly, true);
  assert.deepEqual(Object.keys(root.endpoints), ['exploitation']);

  const res = await get(t.token, '/orders?from=2026-10-01&to=2026-10-31&status=livree');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /no-store/);
  const body = await json(res);
  assert.equal(body.total, 2);
  assert.equal(body.orders[0].items[0].qty, 100);
  assert.equal(body.orders[0].items[0].deliveredQty, 100);
  const raw = JSON.stringify(body);
  assert.ok(!/price|"tel"|0600000000|1\.234/.test(raw), 'aucun prix ni téléphone');

  assert.equal((await json(await get(t.token, `/orders/${orderIds[1]}`))).order.ticket, 'CZ-2026-10-08');
  assert.equal((await get(t.token, '/orders/99999')).status, 404);
  assert.equal((await get(t.token, '/orders?from=2026-13-45')).status, 400);
  assert.equal((await get(t.token, '/orders?status=piratage')).status, 400);
  assert.equal((await json(await get(t.token, '/orders?from=2026-10-05'))).total, 1);
  assert.equal((await json(await get(t.token, '/orders?limit=1&offset=1'))).orders.length, 1);

  const stats = await json(await get(t.token, '/stats?from=2026-10-01&to=2026-10-31'));
  assert.equal(typeof stats.totalOrders, 'number');
  assert.ok(!/Cents|prix|price|amount/i.test(JSON.stringify(stats)), 'statistiques d\'exploitation : jamais de montant');
  assert.equal((await get(t.token, '/stats/daily?from=2026-10-01&to=2026-10-31')).status, 200);
  assert.equal((await get(t.token, '/stats/daily/2026-10-08')).status, 200);
  assert.equal((await get(t.token, '/stats/daily/pas-une-date')).status, 400);

  for (const url of ['/hotels', `/hotels/${clientId}`, '/finance/invoices', '/finance/dashboard', '/finance/payments', '/finance/stats/daily', `/finance/invoices/${invoiceId}`]) {
    const r = await get(t.token, url);
    assert.equal(r.status, 403, url);
    assert.equal((await json(r)).code, 'SCOPE_NOT_GRANTED');
  }
});

test('périmètre « hôtels » : coordonnées oui, codes d\'accès / webhook / jetons d\'API jamais', async () => {
  const t = await mint({ scopes: ['hotels'] });
  const list = await json(await get(t.token, '/hotels?q=avignon'));
  assert.equal(list.total, 1);
  assert.equal(list.hotels[0].siret, '55210055400013');
  assert.equal(list.hotels[0].ordersCount, 2);
  const one = await json(await get(t.token, `/hotels/${clientId}`));
  assert.equal(one.hotel.societe, 'Hôtel Test');
  for (const body of [list, one]) {
    const raw = JSON.stringify(body);
    for (const secret of ['HASH-SECRET-DU-CODE', 'WEBHOOK-SECRET-XYZ', 'hooks.example.org', 'API-TOKEN-CLAIR-123', 'code_hash', 'webhook', 'FR76']) {
      assert.ok(!raw.includes(secret), `fuite : ${secret}`);
    }
  }
  assert.equal((await json(await get(t.token, '/hotels?q=zzz'))).total, 0);
  assert.equal((await get(t.token, '/hotels/99999')).status, 404);
  assert.equal((await get(t.token, '/orders')).status, 403);
});

test('périmètre « finance » : factures, règlements, tableau de bord ; jamais l\'IBAN ni les réglages', async () => {
  const t = await mint({ scopes: ['finance'] });
  const list = await json(await get(t.token, '/finance/invoices?status=open,partial&limit=10'));
  assert.equal(list.total, 1);
  assert.equal(list.invoices[0].id, invoiceId);
  const inv = await json(await get(t.token, `/finance/invoices/${invoiceId}`));
  assert.equal(inv.invoice.number, 'FA-2026-000001');
  assert.equal(inv.invoice.payments.length, 1);
  assert.equal(inv.invoice.payments[0].amountCents, 10000);
  assert.equal(inv.invoice.lines.length >= 1, true);
  const pay = await json(await get(t.token, '/finance/payments?from=2026-11-01&to=2026-11-30'));
  assert.equal(pay.payments.length, 1);
  assert.equal((await get(t.token, '/finance/dashboard')).status, 200);
  assert.equal((await get(t.token, '/finance/stats/daily?from=2026-10-01&to=2026-10-31')).status, 200);
  assert.equal((await get(t.token, '/finance/invoices/99999')).status, 404);
  const raw = JSON.stringify([list, inv, pay]);
  assert.ok(!/FR76|BDFEFRPP|HASH-SECRET|WEBHOOK-SECRET|API-TOKEN/.test(raw));
  assert.equal((await get(t.token, '/orders')).status, 403);
  assert.equal((await get(t.token, '/hotels')).status, 403);
  assert.equal((await get(t.token, '/settings')).status, 404, 'aucune route de réglages');
  assert.equal((await get(t.token, `/finance/invoices/${invoiceId}/pdf`)).status, 404, 'aucun PDF');
});

test('révoquer coupe l\'accès immédiatement ; « tout révoquer » coupe tout', async () => {
  const a = await mint(); const b = await mint(); const c = await mint();
  assert.equal((await get(a.token, '/')).status, 200);
  const r = await s.call('DELETE', `${B}/claude/access/${a.access.id}`);
  assert.equal(r.status, 200);
  const after = await get(a.token, '/');
  assert.equal(after.status, 401);
  assert.match((await json(after)).error, /révoqué/);
  assert.equal((await s.call('DELETE', `${B}/claude/access/${a.access.id}`)).status, 404, 'déjà révoqué');
  assert.equal((await get(b.token, '/')).status, 200);

  const all = await s.call('DELETE', `${B}/claude/access`);
  assert.equal(all.status, 200);
  assert.ok(all.data.revoked >= 2);
  for (const t of [b, c]) assert.equal((await get(t.token, '/')).status, 401);
  assert.ok(all.data.state.tokens.every(t => t.status !== 'active'));
  const ev = rows("SELECT event FROM security_log WHERE event LIKE 'claude_%'").map(x => x.event);
  assert.ok(ev.includes('claude_token_revoked') && ev.includes('claude_token_revoked_all'));
});

test('un jeton expiré est refusé', async () => {
  const t = await mint({ days: 1 });
  assert.equal((await get(t.token, '/')).status, 200);
  exec("UPDATE claude_tokens SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), t.access.id);
  const r = await get(t.token, '/');
  assert.equal(r.status, 401);
  assert.match((await json(r)).error, /expiré/);
  const st = await s.call('GET', `${B}/claude/access`);
  assert.equal(st.data.tokens.find(x => x.id === t.access.id).status, 'expired');
});

test('journal : chaque lecture est tracée (chemin, statut, adresse), jamais le jeton, et les compteurs avancent', async () => {
  const t = await mint({ label: 'Journal', scopes: ['exploitation'] });
  await get(t.token, '/orders?limit=1');
  await get(t.token, '/finance/invoices');   // refusé : tracé aussi
  await get(t.token, '/orders', { method: 'POST', body: '{}' });   // 405 : refusé avant la lecture du jeton, donc non tracé comme accès
  await new Promise(r => setTimeout(r, 150));
  const st = await s.call('GET', `${B}/claude/access`);
  const mine = st.data.log.filter(l => l.tokenId === t.access.id);
  assert.ok(mine.some(l => l.path === `${API}/orders?limit=1` && l.status === 200));
  assert.ok(mine.some(l => l.path === `${API}/finance/invoices` && l.status === 403));
  assert.ok(!mine.some(l => l.method === 'POST'));
  assert.ok(mine.every(l => l.label === 'Journal'));
  const tok = st.data.tokens.find(x => x.id === t.access.id);
  assert.equal(tok.useCount, 2);
  assert.ok(tok.lastUsedAt);
  assert.ok(!JSON.stringify(st.data).includes(t.token));
});

test('cadence : 60 lectures par minute et par jeton', async () => {
  const t = await mint({ label: 'Cadence' });
  const other = await mint({ label: 'Autre' });
  let last;
  for (let i = 0; i < 60; i++) { last = await get(t.token, '/'); assert.equal(last.status, 200, `lecture ${i + 1}`); }
  last = await get(t.token, '/');
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
  assert.equal((await get(other.token, '/')).status, 200, 'le plafond est propre à chaque jeton');
});

test('10 accès actifs au plus', async () => {
  await s.call('DELETE', `${B}/claude/access`);
  for (let i = 0; i < 10; i++) await mint({ label: `Accès ${i}` });
  const r = await sensitive(s, 'claude-access', 'POST', `${B}/claude/access`, { label: 'Un de trop', scopes: ['hotels'] });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /10 accès/);
  await s.call('DELETE', `${B}/claude/access`);
});

test('CLAUDE_ACCESS=off coupe la fonction entière, sans rien supprimer', async () => {
  const st = await off.call('GET', `${B}/claude/access`);
  assert.equal(st.data.enabled, false);
  const r = await sensitive(off, 'claude-access', 'POST', `${B}/claude/access`, { label: 'x', scopes: ['hotels'] });
  assert.equal(r.status, 409);
  const res = await fetch(`${off.BASE}${API}/`, { headers: { Authorization: 'Bearer czc_' + 'a'.repeat(43) } });
  assert.equal(res.status, 503);
  assert.equal((await fetch(`${off.BASE}${API}/orders`, { method: 'POST' })).status, 405);
});

test('essais répétés avec de faux jetons : la route se ferme, y compris pour un vrai jeton', async () => {
  const t = await mint({ label: 'Vrai' });
  let status;
  for (let i = 0; i < 25; i++) status = (await get('czc_' + crypto.randomBytes(32).toString('base64url'), '/')).status;
  assert.equal(status, 429);
  const res = await get(t.token, '/');
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});
