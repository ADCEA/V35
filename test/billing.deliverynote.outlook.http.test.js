// Bon de livraison par Outlook, PDF joint : depuis la fiche d'un BL (Facturation) et depuis la fenêtre d'une commande
// (administration). Outlook connecté → brouillon avec le PDF du bon ; sinon lien simple ; « Outlook installé » → fichier .eml.
// Aucun historique d'envoi pour les bons (le journal des e-mails ne concerne que factures, avoirs, devis et relances).
// Microsoft est remplacé par un faux serveur local.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
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

function startFake() {
  const st = { messages: [], nextToken: 1, validAccess: new Set() };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && req.url.endsWith('/oauth2/v2.0/token')) {
        const f = Object.fromEntries(new URLSearchParams(raw));
        const at = `AT${st.nextToken++}`; st.validAccess.add(at);
        return json(200, f.grant_type === 'authorization_code' ? { access_token: at, refresh_token: 'RT1', expires_in: 3600 } : { access_token: at, expires_in: 3600 });
      }
      const bearer = (req.headers.authorization || '').replace('Bearer ', '');
      if (req.url.startsWith('/v1.0/me?')) return json(200, { displayName: 'Adrien Cézanne', mail: 'adrien@cezanne.fr' });
      if (req.method === 'POST' && req.url === '/v1.0/me/messages') {
        if (!st.validAccess.has(bearer)) return json(401, { error: { message: 'expired' } });
        st.messages.push(JSON.parse(raw));
        return json(201, { id: `AAMk${st.messages.length}`, webLink: `https://outlook.office365.com/owa/?ItemID=AAMk${st.messages.length}&exvsurl=1` });
      }
      json(404, { error: 'inconnu' });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ st, port: server.address().port, close: () => new Promise(x => server.close(x)) })));
}

function newOrder(status = 'livree', ticket) {
  n += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,?)`)
    .run(ticket || `CZ-BL-${n}`, hotel, 'Hôtel Les Lavandes', 'Jean', '0490123456', '450 route de Malaucène', '2026-10-20', status).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1.2, 100, 96);
  return o;
}
const mailLogCount = () => db.prepare('SELECT COUNT(*) n FROM native_mail_log').get().n;

test.before(async () => {
  fake = await startFake();
  s = await startServer({ env: { MS_CLIENT_ID: 'client-123', MS_CLIENT_SECRET: 'secret-456', MS_AUTH_BASE: `http://127.0.0.1:${fake.port}`, MS_GRAPH_BASE: `http://127.0.0.1:${fake.port}/v1.0`, PUBLIC_URL: 'https://cezanne.example/' } });
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash)
    VALUES ('h@x.fr','Hôtel Les Lavandes','Jean','0490123456','450 route de Malaucène','84380','Mazan','x')`).run().lastInsertRowid);
  const r = await sensitive('settings', 'PUT', `${B}/settings`, { phone: '04 90 63 00 00', email: 'contact@blanchisserie-cezanne.fr' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); if (fake) await fake.close(); });

test('fiche d\'un BL : message prêt (objet, texte, adresse de l\'hôtel), Outlook pas encore connecté → lien simple', async () => {
  const o = newOrder('livree', 'CZ-BL-A');
  const pv = (await call('GET', `${B}/deliveries/${o}/mail-preview`)).data;
  assert.match(pv.subject, /^Bon de livraison CZ-BL-A — /);
  assert.match(pv.body, /bon de livraison CZ-BL-A \(Hôtel Les Lavandes\)/);
  assert.match(pv.body, /livraison du 20\/10\/2026/);
  assert.match(pv.body, /Cordialement/);
  assert.equal(pv.to, 'h@x.fr'); assert.equal(pv.smtp, false);
  assert.equal(pv.outlook.configured, true); assert.equal(pv.outlook.connected, false);
  const before = mailLogCount();
  const r = await call('POST', `${B}/deliveries/${o}/send`, { channel: 'outlook', to: pv.to, subject: pv.subject, body: pv.body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.outlook, true); assert.equal(r.data.draft, false); assert.equal(r.data.webLink, null);
  assert.equal(mailLogCount(), before, 'pas d\'historique d\'envoi pour un bon de livraison');
});

test('connexion à Outlook en ligne (faux Microsoft)', async () => {
  const c = await sensitive('outlook-connect', 'POST', `${B}/outlook/connect`);
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const state = new URL(c.data.url).searchParams.get('state');
  const r = await call('GET', `${B}/outlook/callback?code=good-code&state=${state}`, undefined, true);
  assert.equal(r.status, 200, await r.text());
  assert.equal((await call('GET', `${B}/outlook/status`)).data.connected, true);
});

test('Outlook connecté : brouillon créé dans la boîte avec le PDF du bon joint, ouvert par son lien', async () => {
  const o = newOrder('livree', 'CZ-BL-B');
  const pv = (await call('GET', `${B}/deliveries/${o}/mail-preview`)).data;
  assert.equal(pv.outlook.connected, true); assert.equal(pv.outlook.account, 'adrien@cezanne.fr');
  const before = fake.st.messages.length; const logs = mailLogCount();
  const r = await call('POST', `${B}/deliveries/${o}/send`, { channel: 'outlook', to: 'reception@lavandes.fr', subject: pv.subject, body: pv.body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.draft, true); assert.match(r.data.webLink, /^https:\/\/outlook\.office365\.com\/owa\//); assert.equal(r.data.draftError, null);
  assert.equal(fake.st.messages.length, before + 1);
  const m = fake.st.messages.at(-1);
  assert.equal(m.subject, pv.subject); assert.equal(m.body.content, pv.body);
  assert.deepEqual(m.toRecipients.map(x => x.emailAddress.address), ['reception@lavandes.fr']);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].name, 'bon-livraison-CZ-BL-B.pdf'); assert.equal(m.attachments[0].contentType, 'application/pdf');
  assert.equal(Buffer.from(m.attachments[0].contentBytes, 'base64').subarray(0, 5).toString(), '%PDF-', 'le vrai PDF du bon');
  assert.equal(mailLogCount(), logs, 'rien dans l\'historique des e-mails');
  // destinataire facultatif
  const noTo = await call('POST', `${B}/deliveries/${o}/send`, { channel: 'outlook', to: '', subject: pv.subject, body: pv.body });
  assert.equal(noTo.data.draft, true); assert.deepEqual(fake.st.messages.at(-1).toRecipients, []);
});

test('Outlook installé : fichier .eml, PDF du bon joint, brouillon non envoyé', async () => {
  const o = newOrder('livree', 'CZ-BL-C');
  const r = await call('POST', `${B}/deliveries/${o}/send`, { channel: 'outlook-file', to: 'h@x.fr', subject: 'Bon CZ-BL-C', body: 'Bonjour' });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 200));
  assert.equal(r.data.file, true); assert.equal(r.data.emlName, 'bon-livraison-CZ-BL-C.eml');
  const raw = Buffer.from(r.data.eml, 'base64').toString('latin1');
  assert.match(raw, /X-Unsent: 1/i); assert.match(raw, /bon-livraison-CZ-BL-C\.pdf/); assert.match(raw, /application\/pdf/i);
  assert.ok(!/^From:/mi.test(raw), 'pas d\'expéditeur imposé');
});

test('contrôles : objet vide, adresse invalide, canal inconnu ou direct, bon non livré ou absent', async () => {
  const o = newOrder('livree', 'CZ-BL-D');
  const base = { channel: 'outlook', to: 'h@x.fr', subject: 'S', body: 'B' };
  for (const bad of [{ subject: '' }, { body: ' ' }, { to: 'pas-une-adresse' }]) {
    assert.equal((await call('POST', `${B}/deliveries/${o}/send`, { ...base, ...bad })).status, 400, JSON.stringify(bad));
  }
  for (const channel of [undefined, 'email', 'smtp']) {
    const r = await call('POST', `${B}/deliveries/${o}/send`, { ...base, channel });
    assert.equal(r.status, 400, String(channel)); assert.match(r.data.error, /Outlook/);
  }
  const pending = newOrder('prete', 'CZ-BL-E');
  assert.equal((await call('POST', `${B}/deliveries/${pending}/send`, base)).status, 404);
  assert.equal((await call('GET', `${B}/deliveries/${pending}/mail-preview`)).status, 404);
  assert.equal((await call('POST', `${B}/deliveries/99999/send`, base)).status, 404);
  s.newClient();
  assert.equal((await call('POST', `${B}/deliveries/${o}/send`, base)).status, 401, 'réservé à la session administrateur');
  assert.equal((await call('POST', '/api/admin/login', { password: 'secret123' })).status, 200);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
});

test('fenêtre d\'une commande (administration) : brouillon Outlook avec le PDF, adressé à l\'e-mail des réglages', async () => {
  const o = newOrder('livree', 'CZ-BL-F');
  assert.equal((await call('PUT', '/api/admin/settings', { deliveryEmail: 'moi@cezanne.fr' })).status, 200);
  const before = fake.st.messages.length;
  const r = await call('POST', `/api/admin/orders/${o}/delivery-note`, { channel: 'outlook' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.draft, true); assert.equal(r.data.sent, false); assert.match(r.data.webLink, /^https:\/\/outlook\.office365\.com\//);
  assert.match(r.data.subject, /^Bon de livraison CZ-BL-F/);
  const m = fake.st.messages.at(-1);
  assert.equal(fake.st.messages.length, before + 1);
  assert.deepEqual(m.toRecipients.map(x => x.emailAddress.address), ['moi@cezanne.fr']);
  assert.equal(m.attachments[0].name, 'bon-livraison-CZ-BL-F.pdf');
  assert.equal(Buffer.from(m.attachments[0].contentBytes, 'base64').subarray(0, 5).toString(), '%PDF-');
  // sans adresse dans les réglages : le brouillon est créé quand même, à compléter dans Outlook
  assert.equal((await call('PUT', '/api/admin/settings', { deliveryEmail: '' })).status, 200);
  const noTo = await call('POST', `/api/admin/orders/${o}/delivery-note`, { channel: 'outlook' });
  assert.equal(noTo.data.draft, true); assert.deepEqual(fake.st.messages.at(-1).toRecipients, []);
  // .eml
  const eml = await call('POST', `/api/admin/orders/${o}/delivery-note`, { channel: 'outlook-file' });
  assert.equal(eml.data.file, true); assert.equal(eml.data.emlName, 'bon-livraison-CZ-BL-F.eml');
  // un canal inconnu est refusé ; sans canal, l'ancien comportement reste (pas d'adresse → no_email)
  assert.equal((await call('POST', `/api/admin/orders/${o}/delivery-note`, { channel: 'x' })).status, 400);
  assert.equal((await call('POST', `/api/admin/orders/${o}/delivery-note`)).data.reason, 'no_email');
  assert.equal((await call('POST', '/api/admin/orders/99999/delivery-note', { channel: 'outlook' })).status, 404);
});

test('PDF du bon d\'une commande : téléchargeable (repli quand Outlook ne peut pas le joindre), réservé à l\'administrateur', async () => {
  const o = newOrder('livree', 'CZ-BL-G');
  const res = await call('GET', `/api/admin/orders/${o}/delivery-note.pdf`, undefined, true);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
  assert.match(res.headers.get('content-disposition'), /bon-livraison-CZ-BL-G\.pdf/);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call('GET', '/api/admin/orders/99999/delivery-note.pdf')).status, 404);
  s.newClient();
  assert.equal((await call('GET', `/api/admin/orders/${o}/delivery-note.pdf`)).status, 401);
});
