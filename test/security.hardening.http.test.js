// Renforcement de la sécurité : double authentification, journal, politique des codes d'accès, API publique, en-têtes,
// adresses de webhook, cadences. (Protection de la connexion admin elle-même : admin.security.http.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');
const totp = require('../src/utils/totp');
const accessCode = require('../src/utils/accessCode');
const { assertPublicUrl, isPrivateIp } = require('../src/utils/publicHost');

const PWD = 'secret-123456';
let s; let t;

test.before(async () => {
  s = await startServer({ env: { CLIENT_CODE_POLICY: undefined } });   // règle des codes en vigueur en production
  assert.equal((await s.call('POST', '/api/admin/setup', { password: PWD })).status, 201);
  t = await startServer({ env: { CLIENT_CODE_POLICY: undefined } });
  assert.equal((await t.call('POST', '/api/admin/setup', { password: PWD })).status, 201);
});
test.after(async () => { if (s) await s.stop(); if (t) await t.stop(); });

const db = (who = s) => new Database(path.join(who.DATA_DIR, 'database.sqlite'));
const exec = (sql, ...a) => { const d = db(); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const journal = async () => (await s.call('GET', '/api/admin/security')).data.journal;

// ---------- bibliothèques ----------

test('TOTP : vecteurs de la norme (RFC 4226), tolérance d\'un pas, pas de rejeu', () => {
  const key = totp.base32encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.hotp(key, 0), '755224');
  assert.equal(totp.hotp(key, 1), '287082');
  assert.equal(totp.hotp(key, 9), '520489');
  const now = 1_700_000_000_000; const step = totp.stepOf(now);
  assert.equal(totp.verify(key, totp.hotp(key, step), { now }), step);
  assert.equal(totp.verify(key, totp.hotp(key, step - 1), { now }), step - 1, 'téléphone en retard de 30 s');
  assert.equal(totp.verify(key, totp.hotp(key, step + 1), { now }), step + 1, 'téléphone en avance de 30 s');
  assert.equal(totp.verify(key, totp.hotp(key, step + 2), { now }), null, 'au-delà : refusé');
  assert.equal(totp.verify(key, totp.hotp(key, step), { now, afterStep: step }), null, 'un pas déjà utilisé ne resert pas');
  assert.equal(totp.verify(key, '12345', { now }), null);
  assert.equal(totp.verify(key, 'abcdef', { now }), null);
  const rc = totp.newRecoveryCodes(8);
  assert.equal(new Set(rc).size, 8);
  assert.ok(rc.every(c => totp.looksLikeRecovery(c)));
});

test('codes d\'accès des hôtels : 6 à 10 chiffres, pas de suite ni de répétition', () => {
  const saved = process.env.CLIENT_CODE_POLICY; delete process.env.CLIENT_CODE_POLICY;
  try {
    for (const bad of ['1234', '12345', '12345678901', 'abcdef', '', null, '123456', '654321', '111111', '000000', '121212', '123123', '7890123', '12 3456']) {
      assert.notEqual(accessCode.check(bad), null, `refusé : ${bad}`);
    }
    for (const good of ['482916', '7294851', '19283746', '3957204861']) assert.equal(accessCode.check(good), null, `accepté : ${good}`);
    process.env.CLIENT_CODE_POLICY = 'legacy';
    assert.equal(accessCode.check('1234'), null);
  } finally { if (saved === undefined) delete process.env.CLIENT_CODE_POLICY; else process.env.CLIENT_CODE_POLICY = saved; }
});

test('webhooks : jamais d\'adresse interne (localhost, réseau privé, métadonnées du cloud, IPv6 locale)', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.9', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::5', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  for (const url of ['http://localhost/x', 'http://127.0.0.1:3000/x', 'http://[::1]/x', 'http://10.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://a.internal/x', 'http://pc.local/x', 'ftp://exemple.fr/x', 'https://user:pass@exemple.fr/x', 'pas une url']) {
    await assert.rejects(() => assertPublicUrl(url), undefined, url);
  }
  assert.equal((await assertPublicUrl('https://8.8.8.8/hook')).hostname, '8.8.8.8');
});

// ---------- en-têtes et page ----------

test('en-têtes : politique de contenu stricte sur la page, interdiction d\'être encadrée sur l\'API', async () => {
  const page = await fetch(s.BASE + '/');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/, 'seuls les scripts du site s\'exécutent');
  assert.ok(!/script-src[^;]*unsafe/.test(csp), 'jamais de script en ligne ni d\'eval');
  assert.match(csp, /object-src 'self' blob:/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(page.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal(page.headers.get('strict-transport-security'), null, 'pas en http');

  const api = await fetch(s.BASE + '/api/services');
  assert.equal(api.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(api.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(api.headers.get('cache-control'), /no-store/);

  // derrière l'hébergeur (https) : HSTS annoncé
  const https = await fetch(s.BASE + '/', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(https.headers.get('strict-transport-security') || '', /max-age=\d+/);
});

test('pages : aucun script en ligne, aucun gestionnaire en ligne, aucun script venu d\'ailleurs ; jsPDF servi par le site', async () => {
  const pub = path.join(__dirname, '..', 'public');
  for (const f of fs.readdirSync(pub).filter(x => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(pub, f), 'utf8');
    for (const tag of html.match(/<script\b[^>]*>/gi) || []) {
      assert.match(tag, /\ssrc="\/[^"]+"/, `${f} : script sans src local : ${tag}`);
    }
    for (const body of html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || []) {
      assert.equal(body.replace(/<script\b[^>]*>|<\/script>/gi, '').trim(), '', `${f} : script en ligne`);
    }
    assert.ok(!/\son(click|change|submit|load|error|input|focus|blur|keydown|keyup|mouseover)\s*=/i.test(html), `${f} : gestionnaire en ligne`);
    assert.ok(!/javascript:/i.test(html), `${f} : adresse javascript:`);
  }
  const lib = await fetch(s.BASE + '/vendor/jspdf.umd.min.js');
  assert.equal(lib.status, 200);
  assert.match(lib.headers.get('content-type'), /javascript/);
  assert.ok((await lib.text()).length > 50000);
});

// ---------- double authentification ----------

test('double authentification : activation, connexion en deux étapes, rejeu refusé, codes de secours à usage unique, désactivation', async () => {
  assert.equal((await s.call('GET', '/api/admin/security')).data.totpEnabled, false);
  // préparation : mot de passe exigé
  assert.equal((await s.call('POST', '/api/admin/2fa/setup', { password: 'faux' })).status, 401);
  const prep = await s.call('POST', '/api/admin/2fa/setup', { password: PWD });
  assert.equal(prep.status, 200);
  const secret = prep.data.secret.replace(/\s/g, '');
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(prep.data.uri, /^otpauth:\/\/totp\/.+secret=/);
  assert.match(prep.data.qrSvg, /^<svg/);
  // le secret n'est pas lisible dans la base (scellé)
  assert.ok(!fs.readFileSync(path.join(s.DATA_DIR, 'database.sqlite')).includes(Buffer.from(secret)));
  assert.equal((await s.call('GET', '/api/admin/security')).data.totpEnabled, false, 'rien n\'est actif avant la confirmation');

  // confirmation : mauvais code refusé, bon code accepté
  assert.equal((await s.call('POST', '/api/admin/2fa/enable', { code: '000000' })).status, 400);
  const step = totp.stepOf();
  const en = await s.call('POST', '/api/admin/2fa/enable', { code: totp.hotp(secret, step) });
  assert.equal(en.status, 200, JSON.stringify(en.data));
  assert.equal(en.data.recoveryCodes.length, 8);
  const recovery = en.data.recoveryCodes;
  assert.ok(!fs.readFileSync(path.join(s.DATA_DIR, 'database.sqlite')).includes(Buffer.from(recovery[0])), 'codes de secours : seules les empreintes sont gardées');
  assert.equal((await s.call('POST', '/api/admin/2fa/enable', { code: totp.hotp(secret, step) })).status, 409, 'déjà actif');

  // connexion : le mot de passe seul n'ouvre plus rien
  s.newClient();
  let r = await s.call('POST', '/api/admin/login', { password: PWD });
  assert.equal(r.status, 200);
  assert.equal(r.data.needCode, true);
  assert.equal(r.data.ok, false);
  assert.equal((await s.call('GET', '/api/admin/orders')).status, 401, 'étape 1 seule : administration fermée');
  assert.equal((await s.call('GET', '/api/admin/billing/lock/status')).status, 401);
  // mauvais code
  assert.equal((await s.call('POST', '/api/admin/login/2fa', { code: '123457' })).status, 401);
  assert.equal((await s.call('POST', '/api/admin/login/2fa', { code: 123456 })).status, 401, 'pas un texte');
  // le code utilisé à l'activation ne sert pas une seconde fois
  assert.equal((await s.call('POST', '/api/admin/login/2fa', { code: totp.hotp(secret, step) })).status, 401, 'rejeu refusé');
  // pas de 2e étape sans avoir passé la 1re
  s.newClient();
  r = await s.call('POST', '/api/admin/login/2fa', { code: totp.hotp(secret, step + 1) });
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'RESTART_LOGIN');

  // bon code (pas suivant, accepté par la tolérance de ±30 s)
  r = await s.call('POST', '/api/admin/login', { password: PWD });
  assert.equal(r.data.needCode, true);
  r = await s.call('POST', '/api/admin/login/2fa', { code: totp.hotp(secret, step + 1) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await s.call('GET', '/api/admin/orders')).status, 200);
  // et ce code ne resert pas non plus
  s.newClient();
  await s.call('POST', '/api/admin/login', { password: PWD });
  assert.equal((await s.call('POST', '/api/admin/login/2fa', { code: totp.hotp(secret, step + 1) })).status, 401);

  // code de secours : une seule fois
  r = await s.call('POST', '/api/admin/login/2fa', { code: recovery[0] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await s.call('GET', '/api/admin/security')).data.recoveryLeft, 7);
  s.newClient();
  await s.call('POST', '/api/admin/login', { password: PWD });
  assert.equal((await s.call('POST', '/api/admin/login/2fa', { code: recovery[0] })).status, 401, 'déjà utilisé');
  assert.equal((await s.call('POST', '/api/admin/login/2fa', { code: recovery[1].toLowerCase().replace('-', '') })).status, 200, 'casse et tiret sans importance');

  // le journal raconte tout, sans rien de secret
  const j = await journal();
  const events = j.map(x => x.event);
  for (const ev of ['admin_2fa_enabled', 'admin_login_ok', 'admin_2fa_fail']) assert.ok(events.includes(ev), ev);
  assert.ok(j.some(x => /code de secours utilisé/.test(x.detail || '')));
  const raw = JSON.stringify(j);
  for (const secretThing of [PWD, secret, ...recovery]) assert.ok(!raw.includes(secretThing), 'le journal ne contient ni mot de passe ni code');

  // désactivation : mot de passe ET code de l'application (pas un code de secours)
  exec('UPDATE admin SET totp_last_step = -1 WHERE id = 1');   // raccourci de test : repartir d'un pas libre
  assert.equal((await s.call('POST', '/api/admin/2fa/disable', { password: PWD, code: recovery[2] })).status, 401, 'code de secours refusé ici');
  assert.equal((await s.call('POST', '/api/admin/2fa/disable', { password: 'faux', code: totp.hotp(secret, totp.stepOf()) })).status, 401);
  assert.equal((await s.call('POST', '/api/admin/2fa/disable', { password: PWD, code: totp.hotp(secret, totp.stepOf()) })).status, 200);
  assert.equal((await s.call('GET', '/api/admin/security')).data.totpEnabled, false);
  s.newClient();
  r = await s.call('POST', '/api/admin/login', { password: PWD });
  assert.equal(r.status, 200);
  assert.equal(r.data.needCode, undefined);
  assert.equal((await s.call('GET', '/api/admin/orders')).status, 200);
});

test('les fonctions de sécurité exigent la session administrateur', async () => {
  s.newClient();
  for (const [m, u, b] of [['GET', '/api/admin/security'], ['POST', '/api/admin/2fa/setup', { password: PWD }], ['POST', '/api/admin/2fa/enable', { code: '123456' }],
    ['POST', '/api/admin/2fa/disable', { password: PWD, code: '123456' }], ['POST', '/api/admin/2fa/recovery', { password: PWD, code: '123456' }], ['POST', '/api/admin/password', { current: PWD, password: 'x'.repeat(12) }]]) {
    assert.equal((await s.call(m, u, b)).status, 401, `${m} ${u}`);
  }
  assert.equal((await s.call('POST', '/api/admin/login', { password: PWD })).status, 200);
});

test('2ᵉ étape : les codes faux comptent dans le blocage, même avec le bon mot de passe', async () => {
  const sec = await t.call('POST', '/api/admin/2fa/setup', { password: PWD });
  const secret = sec.data.secret.replace(/\s/g, '');
  assert.equal((await t.call('POST', '/api/admin/2fa/enable', { code: totp.hotp(secret, totp.stepOf()) })).status, 200);
  t.newClient();
  assert.equal((await t.call('POST', '/api/admin/login', { password: PWD })).data.needCode, true);
  let last;
  for (let i = 0; i < 6; i++) last = await t.call('POST', '/api/admin/login/2fa', { code: String(100000 + i * 7) });
  assert.equal(last.status, 429, 'bloqué après quelques essais');
  // le bon code ne passe plus pendant le blocage, et le mot de passe seul ne remet pas le compteur à zéro
  assert.equal((await t.call('POST', '/api/admin/login/2fa', { code: totp.hotp(secret, totp.stepOf() + 1) })).status, 429);
  assert.equal((await t.call('POST', '/api/admin/login', { password: PWD })).status, 429);
});

// ---------- espace hôtel : codes, blocages, API publique ----------

test('création de compte hôtel : code de 6 à 10 chiffres, sans suite ni répétition', async () => {
  const base = { societe: 'Hôtel A', contact: 'A', tel: '0600000000', adresse: '1 rue A', email: 'a@exemple.fr' };
  for (const code of ['1234', '12345', '123456', '000000', '121212', '11111111', 'abcdef', '12345678901']) {
    s.newClient();
    const r = await s.call('POST', '/api/clients/register', { ...base, code });
    assert.equal(r.status, 400, `refusé : ${code}`);
    assert.match(r.data.error, /code d'accès/);
  }
  s.newClient();
  assert.equal((await s.call('POST', '/api/clients/register', { ...base, code: '482916' })).status, 201);
  s.newClient();
  const dup = await s.call('POST', '/api/clients/register', { ...base, code: '482916' });
  assert.equal(dup.status, 409);
  // champs trop longs refusés (ils s'affichent ensuite dans l'administration)
  for (const [k, n] of [['societe', 121], ['contact', 121], ['tel', 41], ['adresse', 251]]) {
    s.newClient();
    const r = await s.call('POST', '/api/clients/register', { ...base, email: `b${k}@exemple.fr`, code: '482916', [k]: 'x'.repeat(n) });
    assert.equal(r.status, 400, k);
    assert.match(r.data.error, /trop long/);
  }
  s.newClient();
  assert.equal((await s.call('POST', '/api/clients/register', { ...base, email: 'c@exemple.fr', code: '482916', societe: { $gt: '' } })).status, 400, 'pas un texte');
});

test('connexion hôtel : 5 codes faux bloquent ce compte (pas les autres), le bon code ne passe plus pendant le blocage', async () => {
  const mk = async (email) => { s.newClient(); const r = await s.call('POST', '/api/clients/register', { societe: 'H', contact: 'C', tel: '06', adresse: 'a', email, code: '482916' }); assert.equal(r.status, 201); s.newClient(); };
  await mk('lock@exemple.fr'); await mk('autre@exemple.fr');
  let r;
  for (let i = 0; i < 4; i++) { r = await s.call('POST', '/api/clients/login', { email: 'lock@exemple.fr', code: '999000' }); assert.equal(r.status, 401); }
  r = await s.call('POST', '/api/clients/login', { email: 'lock@exemple.fr', code: '999000' });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /Trop d'essais/);
  assert.equal((await s.call('POST', '/api/clients/login', { email: 'lock@exemple.fr', code: '482916' })).status, 429, 'même avec le bon code');
  assert.equal((await s.call('POST', '/api/clients/login', { email: 'LOCK@exemple.fr ', code: '482916' })).status, 429, 'majuscules et espaces ne contournent rien');
  assert.equal((await s.call('POST', '/api/clients/login', { email: 'autre@exemple.fr', code: '482916' })).status, 200, 'les autres comptes ne sont pas touchés');
  // un e-mail inconnu se comporte pareil (rien ne révèle quels comptes existent)
  let u; for (let i = 0; i < 5; i++) u = await s.call('POST', '/api/clients/login', { email: 'inconnu@exemple.fr', code: '999000' });
  assert.equal(u.status, 429);
});

test('suivi de commande public : seulement l\'avancement ; le détail est réservé à l\'hôtel et à l\'administration', async () => {
  const services = (await s.call('GET', '/api/services')).data.services;
  s.newClient();
  const r = await s.call('POST', '/api/orders', { client: { societe: 'Hôtel <b>Secret</b>', contact: 'Jean Dupont', tel: '0611223344', adresse: '12 rue Discrète' }, items: [{ id: services[0].id, qty: 3 }], notes: 'code porte 4821' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const ticket = r.data.order.ticket;

  s.newClient();
  const pub = await s.call('GET', `/api/orders/track/${ticket}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(Object.keys(pub.data.order).sort(), ['createdAt', 'livraisonPrevue', 'status', 'ticket']);
  const raw = JSON.stringify(pub.data);
  for (const leak of ['Secret', 'Dupont', '0611223344', 'Discrète', '4821', 'items', 'price', 'adresse']) assert.ok(!raw.includes(leak), `fuite : ${leak}`);
  assert.equal((await s.call('GET', '/api/orders/track/CZ-000000-0000')).status, 404);
  assert.equal((await s.call('GET', `/api/orders/track/${'9'.repeat(500)}`)).status, 404);

  assert.equal((await s.call('POST', '/api/admin/login', { password: PWD })).status, 200);
  const adm = await s.call('GET', `/api/orders/track/${ticket}`);
  assert.equal(adm.data.order.client.societe, 'Hôtel <b>Secret</b>');
  assert.equal(adm.data.order.items.length, 1);
});

test('commande d\'un invité : champs bornés, articles inconnus et quantités absurdes refusés', async () => {
  const services = (await s.call('GET', '/api/services')).data.services;
  s.newClient();
  const ok = { societe: 'H', contact: 'C', tel: '06', adresse: 'a' };
  const post = (over) => s.call('POST', '/api/orders', { client: ok, items: [{ id: services[0].id, qty: 1 }], ...over });
  assert.equal((await post({ client: { ...ok, societe: 'x'.repeat(121) } })).status, 400);
  assert.equal((await post({ client: { ...ok, adresse: { a: 1 } } })).status, 400);
  assert.equal((await post({ notes: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post({ livraisonPrevue: 'x'.repeat(41) })).status, 400);
  assert.equal((await post({ items: [] })).status, 400);
  assert.equal((await post({ items: [{ id: 'inexistant', qty: 1 }] })).status, 400);
  assert.equal((await post({ items: [{ id: '__proto__', qty: 1 }] })).status, 400, 'pas d\'accès aux propriétés internes');
  assert.equal((await post({ items: [{ id: 'constructor', qty: 1 }] })).status, 400);
  for (const qty of [0, -5, 100001, 'abc', 1.5e9]) assert.equal((await post({ items: [{ id: services[0].id, qty }] })).status, 400, `qty ${qty}`);
  assert.equal((await post({ items: Array.from({ length: 151 }, () => ({ id: services[0].id, qty: 1 })) })).status, 400);
});

test('cadence : un invité ne peut pas inonder la production (30 commandes par heure et par adresse)', async () => {
  s.newClient();
  let last;
  for (let i = 0; i < 40; i++) { last = await s.call('POST', '/api/orders', { client: {}, items: [] }); if (last.status === 429) break; }
  assert.equal(last.status, 429);
  assert.equal(last.data.code, 'RATE_LIMITED');
  assert.ok(last.data.retryAfterSec > 0);
});

test('derrière Cloudflare puis Render : l\'adresse retenue est celle du visiteur, pas celle d\'un relais, et une fausse adresse ne la change pas', async () => {
  const r = await startServer({ env: { RENDER: 'true', TRUST_PROXY: undefined } });
  try {
    const hdr = (xff, cookie) => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': xff, 'X-Forwarded-Proto': 'https', ...(cookie ? { cookie } : {}) });
    const setup = await fetch(`${r.BASE}/api/admin/setup`, { method: 'POST', headers: hdr('203.0.113.7, 172.64.1.1'), body: JSON.stringify({ password: PWD }) });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    // chaîne réelle : visiteur, Cloudflare (ajouté par Render)
    let sec = await (await fetch(`${r.BASE}/api/admin/security`, { headers: hdr('203.0.113.7, 172.64.1.1', cookie) })).json();
    assert.equal(sec.connection.ip, '203.0.113.7');
    assert.equal(sec.connection.trustProxy, 2);
    assert.equal(sec.connection.secure, true);
    // le visiteur écrit lui-même une fausse adresse devant : elle reste en tête de chaîne et n'est pas retenue
    sec = await (await fetch(`${r.BASE}/api/admin/security`, { headers: hdr('6.6.6.6, 203.0.113.7, 172.64.1.1', cookie) })).json();
    assert.equal(sec.connection.ip, '203.0.113.7', 'une adresse inventée par le visiteur ne compte pas');
  } finally { await r.stop(); }
});
