// Outlook connecté : connexion OAuth (état + PKCE), jeton chiffré, création d'un BROUILLON avec le PDF joint, et tous les
// cas où Microsoft refuse. Microsoft est remplacé par un faux serveur local.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; let db; let hotel; let fake; let n = 0;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body) {
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return call(method, url, body);
}

// ---------- faux Microsoft ----------
function startFake() {
  const st = { tokens: [], messages: [], challenge: null, refreshCount: 0, nextToken: 1, graphMode: 'ok', refreshMode: 'ok', rotate: false, validRefresh: new Set(), validAccess: new Set() };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && req.url.endsWith('/oauth2/v2.0/token')) {
        const f = Object.fromEntries(new URLSearchParams(raw));
        st.tokens.push(f);
        if (f.client_id !== 'client-123' || f.client_secret !== 'secret-456') return json(401, { error: 'invalid_client' });
        if (f.grant_type === 'authorization_code') {
          if (f.code !== 'good-code') return json(400, { error: 'invalid_grant', error_description: 'code invalide' });
          st.pkceOk = crypto.createHash('sha256').update(f.code_verifier || '').digest('base64url') === st.challenge;
          const at = `AT${st.nextToken++}`; st.validAccess.add(at); st.validRefresh.add('RT1');
          return json(200, { access_token: at, refresh_token: 'RT1', expires_in: 3600 });
        }
        if (f.grant_type === 'refresh_token') {
          st.refreshCount += 1;
          if (st.refreshMode === 'revoked' || !st.validRefresh.has(f.refresh_token)) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70008: expiré\r\nTrace ID: x' });
          const at = `AT${st.nextToken++}`; st.validAccess.add(at);
          const out = { access_token: at, expires_in: 3600 };
          if (st.rotate) { out.refresh_token = `RT${st.nextToken}`; st.validRefresh.add(out.refresh_token); }
          return json(200, out);
        }
      }
      const bearer = (req.headers.authorization || '').replace('Bearer ', '');
      if (req.url.startsWith('/v1.0/me?')) return json(200, { displayName: 'Adrien Cézanne', mail: 'adrien@cezanne.fr' });
      if (req.method === 'POST' && req.url === '/v1.0/me/messages') {
        if (!st.validAccess.has(bearer)) return json(401, { error: { message: 'expired' } });
        if (st.graphMode === 'forbidden') return json(403, { error: { message: 'Access is denied' } });
        if (st.graphMode === 'busy') return json(429, { error: { message: 'throttled' } });
        if (st.graphMode === 'expire-once') { st.graphMode = 'ok'; st.validAccess.delete(bearer); return json(401, { error: { message: 'token expired' } }); }
        const msg = JSON.parse(raw); st.messages.push({ ...msg, bearer });
        return json(201, { id: `AAMk${st.messages.length}`, webLink: `https://outlook.office365.com/owa/?ItemID=AAMk${st.messages.length}&exvsurl=1` });
      }
      json(404, { error: 'inconnu' });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ st, port: server.address().port, close: () => new Promise(x => server.close(x)) })));
}

async function issuedInvoice(issueDate) {
  n += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-OD-${n}`, hotel, 'Hôtel', 'J', '06', 'adr', issueDate).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
  const c = await call('POST', `${B}/invoices`, { clientId: hotel, orderIds: [o] });
  const id = c.data.invoice.id;
  assert.equal((await sensitive(`issue:${id}`, 'POST', `${B}/invoices/${id}/issue`, { issueDate })).status, 200);
  return id;
}
const send = (id, extra = {}) => call('POST', `${B}/invoices/${id}/send`, { channel: 'outlook', to: 'compta@lavandes.fr', subject: 'Facture', body: 'Bonjour,\nVoici la facture.', ...extra });
const logs = (id) => db.prepare('SELECT kind, channel, status FROM native_mail_log WHERE invoice_id = ? ORDER BY id').all(id).map(l => `${l.kind}/${l.channel}/${l.status}`);
const authorizeUrl = async () => { const r = await sensitive('outlook-connect', 'POST', `${B}/outlook/connect`); assert.equal(r.status, 200, JSON.stringify(r.data)); return new URL(r.data.url); };
const callback = (qs) => call('GET', `${B}/outlook/callback?${qs}`, undefined, true);

test.before(async () => {
  fake = await startFake();
  s = await startServer({ env: { MS_CLIENT_ID: 'client-123', MS_CLIENT_SECRET: 'secret-456', MS_AUTH_BASE: `http://127.0.0.1:${fake.port}`, MS_GRAPH_BASE: `http://127.0.0.1:${fake.port}/v1.0`, PUBLIC_URL: 'https://cezanne.example/' } });
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number)
    VALUES ('h@x.fr','Hôtel Les Lavandes','Jean','0490123456','450 route de Malaucène','84380','Mazan','x','55210055400013','FR40552100554')`).run().lastInsertRowid);
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); if (fake) await fake.close(); });

test('avant connexion : configuré mais pas connecté ; l\'envoi Outlook reste le lien simple', async () => {
  const st = (await call('GET', `${B}/outlook/status`)).data;
  assert.equal(st.configured, true); assert.equal(st.connected, false);
  assert.equal(st.redirectUri, 'https://cezanne.example/api/admin/billing/outlook/callback');
  assert.ok(!JSON.stringify(st).includes('secret-456'), 'le secret ne sort jamais');
  const id = await issuedInvoice('2026-10-01');
  const pv = (await call('GET', `${B}/invoices/${id}/mail-preview?kind=invoice`)).data;
  assert.deepEqual({ ...pv.outlook }, { configured: true, connected: false, needsReconnect: false, account: null });
  const r = await send(id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.draft, false); assert.equal(r.data.webLink, null); assert.equal(r.data.draftError, null);
  assert.deepEqual(logs(id), ['invoice/outlook/sent']);
});

test('connexion : l\'ouverture exige le code ; Microsoft reçoit l\'état, PKCE et les seules permissions utiles', async () => {
  assert.equal((await call('POST', `${B}/outlook/connect`)).status, 403, 'ressaisie du code exigée');
  const u = await authorizeUrl();
  assert.equal(u.origin, `http://127.0.0.1:${fake.port}`); assert.equal(u.pathname, '/common/oauth2/v2.0/authorize');
  assert.equal(u.searchParams.get('client_id'), 'client-123');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://cezanne.example/api/admin/billing/outlook/callback');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('state').length >= 20 && u.searchParams.get('code_challenge').length >= 40);
  const scopes = u.searchParams.get('scope').split(' ');
  assert.deepEqual(scopes.sort(), ['Mail.ReadWrite', 'User.Read', 'offline_access']);
  assert.ok(!scopes.includes('Mail.Send'), 'aucun droit d\'envoi demandé');
});

test('retour de Microsoft : état inconnu, refus et code invalide ne connectent rien', async () => {
  let u = await authorizeUrl();
  let r = await callback(`code=good-code&state=autre-chose`);
  assert.equal(r.status, 400); assert.match(await r.text(), /inconnue ou expirée/);
  // l'état est à usage unique : même le bon état ne marche plus ensuite
  r = await callback(`code=good-code&state=${u.searchParams.get('state')}`);
  assert.equal(r.status, 400);
  u = await authorizeUrl();
  r = await callback(`error=access_denied&error_description=${encodeURIComponent("L'utilisateur a refusé")}&state=${u.searchParams.get('state')}`);
  assert.equal(r.status, 400); assert.match(await r.text(), /refusé/);
  u = await authorizeUrl();
  r = await callback(`code=mauvais&state=${u.searchParams.get('state')}`);
  assert.equal(r.status, 400);
  assert.equal((await call('GET', `${B}/outlook/status`)).data.connected, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outlook_connection').get().n, 0);
  // sans session d'administrateur : refusé
  s.newClient();
  assert.equal((await callback('code=good-code&state=x')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'secret123' })).status, 200);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
});

test('connexion réussie : compte affiché, jeton chiffré en base, PKCE vérifié par Microsoft', async () => {
  const u = await authorizeUrl(); fake.st.challenge = u.searchParams.get('code_challenge');
  const r = await callback(`code=good-code&state=${u.searchParams.get('state')}`);
  const html = await r.text();
  assert.equal(r.status, 200, html); assert.match(html, /Outlook est connecté/); assert.match(html, /adrien@cezanne\.fr/);
  assert.equal(fake.st.pkceOk, true, 'le vérificateur PKCE correspond au défi envoyé');
  const st = (await call('GET', `${B}/outlook/status`)).data;
  assert.equal(st.connected, true); assert.equal(st.account.email, 'adrien@cezanne.fr'); assert.equal(st.account.name, 'Adrien Cézanne');
  const stored = db.prepare('SELECT refresh_token_enc FROM outlook_connection').get().refresh_token_enc;
  assert.match(stored, /^v1\./); assert.ok(!stored.includes('RT1'), 'jeton chiffré, jamais en clair');
  assert.ok(!JSON.stringify(st).includes('RT1'));
});

test('brouillon : créé dans la boîte avec le PDF joint, destinataires et texte ; tracé dans l\'historique', async () => {
  const id = await issuedInvoice('2026-10-02');
  const pv = (await call('GET', `${B}/invoices/${id}/mail-preview?kind=invoice`)).data;
  assert.equal(pv.outlook.connected, true); assert.equal(pv.outlook.account, 'adrien@cezanne.fr');
  const before = fake.st.messages.length;
  const r = await send(id, { to: 'compta@lavandes.fr, direction@lavandes.fr', subject: pv.subject, body: pv.body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.draft, true); assert.match(r.data.webLink, /^https:\/\/outlook\.office365\.com\/owa\//); assert.equal(r.data.draftError, null);
  assert.equal(fake.st.messages.length, before + 1);
  const m = fake.st.messages.at(-1);
  assert.equal(m.subject, pv.subject);
  assert.equal(m.body.contentType, 'Text'); assert.equal(m.body.content, pv.body);
  assert.deepEqual(m.toRecipients.map(x => x.emailAddress.address), ['compta@lavandes.fr', 'direction@lavandes.fr']);
  assert.equal(m.attachments.length, 1);
  const att = m.attachments[0];
  assert.equal(att['@odata.type'], '#microsoft.graph.fileAttachment'); assert.equal(att.contentType, 'application/pdf');
  assert.match(att.name, /\.pdf$/);
  assert.equal(Buffer.from(att.contentBytes, 'base64').subarray(0, 5).toString(), '%PDF-', 'le vrai PDF de la facture');
  assert.match(m.bearer, /^AT\d+$/);
  assert.deepEqual(logs(id), ['invoice/outlook-draft/sent']);
  const timeline = (await call('GET', `${B}/invoices/${id}`)).data.invoice.timeline;
  assert.ok(timeline.some(t => /brouillon créé dans Outlook/.test(t.detail)), JSON.stringify(timeline.map(t => t.detail)));
  // sans destinataire : le brouillon est créé quand même
  const noTo = await send(id, { to: '' });
  assert.equal(noTo.data.draft, true);
  assert.deepEqual(fake.st.messages.at(-1).toRecipients, []);
  // un objet vide est refusé avant tout appel à Microsoft
  const count = fake.st.messages.length;
  assert.equal((await send(id, { subject: '' })).status, 400);
  assert.equal(fake.st.messages.length, count);
});

test('jeton d\'accès expiré : renouvelé automatiquement une fois, nouveau jeton de renouvellement conservé', async () => {
  const id = await issuedInvoice('2026-10-03');
  fake.st.graphMode = 'expire-once'; fake.st.rotate = true;
  const refreshes = fake.st.refreshCount;
  const r = await send(id);
  assert.equal(r.data.draft, true, JSON.stringify(r.data));
  assert.equal(fake.st.refreshCount, refreshes + 1, 'un seul renouvellement');
  fake.st.rotate = false;
  // le jeton renouvelé sert pour la suite : on force un renouvellement en expirant encore l'accès
  fake.st.graphMode = 'expire-once';
  const r2 = await send(id);
  assert.equal(r2.data.draft, true, JSON.stringify(r2.data));
  const last = fake.st.tokens.filter(t => t.grant_type === 'refresh_token').at(-1);
  assert.notEqual(last.refresh_token, 'RT1', 'le jeton renouvelé par Microsoft est celui qui est réutilisé');
});

test('Microsoft refuse : repli sur le lien Outlook avec la raison, rien n\'est perdu', async () => {
  const id = await issuedInvoice('2026-10-04');
  for (const [mode, expected] of [['forbidden', /Mail\.ReadWrite/], ['busy', /indisponible/]]) {
    fake.st.graphMode = mode;
    const r = await send(id);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.draft, false); assert.equal(r.data.webLink, null); assert.match(r.data.draftError, expected);
  }
  fake.st.graphMode = 'ok';
  assert.deepEqual(logs(id), ['invoice/outlook/sent', 'invoice/outlook/sent']);
  // connexion révoquée côté Microsoft
  fake.st.validAccess.clear(); fake.st.refreshMode = 'revoked';   // l'accès en cours est refusé, et le renouvellement aussi
  const rev = await send(id);
  assert.equal(rev.data.draft, false); assert.match(rev.data.draftError, /reconnectez-la dans Configuration/);
  fake.st.refreshMode = 'ok';
  assert.equal((await call('GET', `${B}/outlook/status`)).data.connected, true, 'la connexion reste affichée : seule la personne la retire ou la refait');
});

test('relance et devis passent aussi par un brouillon avec leur PDF', async () => {
  const unpaid = db.prepare(`SELECT id FROM native_invoices WHERE status='issued' ORDER BY id LIMIT 1`).get().id;
  const before = fake.st.messages.length;
  const rem = await call('POST', `${B}/invoices/${unpaid}/remind`, { level: 1, channel: 'outlook', to: 'compta@lavandes.fr', subject: 'Rappel', body: 'Merci de régler.' });
  assert.equal(rem.status, 200, JSON.stringify(rem.data));
  assert.equal(rem.data.draft, true);
  assert.equal(fake.st.messages.length, before + 1);
  assert.equal(Buffer.from(fake.st.messages.at(-1).attachments[0].contentBytes, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.ok(logs(unpaid).includes('reminder-1/outlook-draft/sent'));
  const q = await call('POST', `${B}/quotes`, { clientId: hotel, lines: [{ description: 'Location nappes', quantity: 10, unitPrice: 4, vatRate: 20 }] });
  const qid = q.data.quote.id;
  assert.equal((await call('POST', `${B}/quotes/${qid}/issue`, { issueDate: '2026-10-08' })).status, 200);
  const pv = (await call('GET', `${B}/quotes/${qid}/mail-preview`)).data;
  assert.equal(pv.outlook.connected, true);
  const sent = await call('POST', `${B}/quotes/${qid}/send`, { channel: 'outlook', to: 'h@x.fr', subject: pv.subject, body: pv.body });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.draft, true);
  assert.match(fake.st.messages.at(-1).attachments[0].name, /\.pdf$/);
  assert.deepEqual(db.prepare('SELECT kind, channel FROM native_mail_log WHERE quote_id = ?').all(qid).map(l => `${l.kind}/${l.channel}`), ['quote/outlook-draft']);
});

test('déconnexion : code exigé, la boîte n\'est plus utilisée, l\'envoi redevient le lien simple', async () => {
  assert.equal((await call('POST', `${B}/outlook/disconnect`)).status, 403);
  assert.equal((await sensitive('outlook-disconnect', 'POST', `${B}/outlook/disconnect`)).status, 200);
  assert.equal((await call('GET', `${B}/outlook/status`)).data.connected, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outlook_connection').get().n, 0);
  const id = db.prepare(`SELECT id FROM native_invoices WHERE status='issued' ORDER BY id DESC LIMIT 1`).get().id;
  const before = fake.st.messages.length;
  const r = await send(id);
  assert.equal(r.data.draft, false); assert.equal(fake.st.messages.length, before);
});

test('clé de chiffrement changée (SESSION_SECRET) : à reconnecter, jamais d\'erreur ; non configuré : message clair', async () => {
  // reconnecter d'abord
  const u = await authorizeUrl(); fake.st.challenge = u.searchParams.get('code_challenge');
  assert.equal((await callback(`code=good-code&state=${u.searchParams.get('state')}`)).status, 200);
  const dir = s.DATA_DIR; db.close(); db = null; await s.stop();
  const env = { MS_CLIENT_ID: 'client-123', MS_CLIENT_SECRET: 'secret-456', MS_AUTH_BASE: `http://127.0.0.1:${fake.port}`, MS_GRAPH_BASE: `http://127.0.0.1:${fake.port}/v1.0`, PUBLIC_URL: 'https://cezanne.example' };
  s = await startServer({ dataDir: dir, env: { ...env, SESSION_SECRET: 'une-autre-cle' } });
  assert.equal((await call('POST', '/api/admin/login', { password: 'secret123' })).status, 200);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
  const st = (await call('GET', `${B}/outlook/status`)).data;
  assert.equal(st.connected, false); assert.equal(st.needsReconnect, true);
  await s.stop();
  s = await startServer({ dataDir: dir, env: { MS_CLIENT_ID: undefined, MS_CLIENT_SECRET: undefined, PUBLIC_URL: undefined, RENDER_EXTERNAL_URL: undefined } });
  assert.equal((await call('POST', '/api/admin/login', { password: 'secret123' })).status, 200);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
  const un = (await call('GET', `${B}/outlook/status`)).data;
  assert.equal(un.configured, false); assert.deepEqual(un.missing, ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'PUBLIC_URL']);
  const c = await sensitive('outlook-connect', 'POST', `${B}/outlook/connect`);
  assert.equal(c.status, 503); assert.match(c.data.error, /MS_CLIENT_ID/);
});
