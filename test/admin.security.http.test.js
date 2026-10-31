// Protection de l'espace administration : en-têtes, origine des requêtes, essais limités,
// session qui expire, changement de mot de passe qui déconnecte les autres appareils.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const path = require('path'); const fs = require('fs');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const PW = 'secret123';

// Un « navigateur » avec son propre cookie de session.
function browser(BASE) {
  const b = {
    cookie: '',
    async call(method, url, body, headers = {}) {
      const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(b.cookie ? { cookie: b.cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) b.cookie = sc.split(';')[0];
      let data = null; try { data = await res.json(); } catch {}
      return { status: res.status, data, headers: res.headers };
    },
  };
  return b;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('en-têtes de sécurité et requête venue d\'un autre site refusée', async (t) => {
  const s = await startServer(); t.after(() => s.stop());
  const b = browser(s.BASE);
  let r = await b.call('GET', '/api/admin/status');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('strict-transport-security'), null, 'pas de HSTS en http');

  // Les pages statiques portent aussi les en-têtes
  const page = await fetch(s.BASE + '/');
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');

  // Création du mot de passe, puis requêtes qui modifient des données
  assert.equal((await b.call('POST', '/api/admin/setup', { password: PW })).status, 201);
  const host = new URL(s.BASE).host;
  r = await b.call('PUT', '/api/admin/settings', { deliveryEmail: 'a@b.fr' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403); assert.equal(r.data.code, 'BAD_ORIGIN');
  r = await b.call('PUT', '/api/admin/settings', { deliveryEmail: 'a@b.fr' }, { Origin: 'http://' + host });
  assert.equal(r.status, 200, 'même site : accepté');
  r = await b.call('PUT', '/api/admin/settings', { deliveryEmail: 'c@d.fr' });
  assert.equal(r.status, 200, 'sans en-tête Origin (outil, test) : accepté');
  assert.equal((await b.call('GET', '/api/admin/settings', null, { Origin: 'https://evil.example' })).status, 200, 'la lecture n\'est pas concernée');
  // Y compris la connexion elle-même
  r = await browser(s.BASE).call('POST', '/api/admin/login', { password: PW }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('connexion : 5 échecs → blocage, le propriétaire reconnu n\'est pas enfermé dehors', async (t) => {
  const s = await startServer(); t.after(() => s.stop());
  const owner = browser(s.BASE);
  assert.equal((await owner.call('POST', '/api/admin/setup', { password: PW })).status, 201);
  assert.equal((await owner.call('POST', '/api/admin/logout')).status, 200);

  // Un inconnu devine
  const intruder = browser(s.BASE);
  const msgs = [];
  for (let i = 0; i < 4; i++) { const r = await intruder.call('POST', '/api/admin/login', { password: 'faux-' + i }); assert.equal(r.status, 401); msgs.push(r.data.error); }
  assert.match(msgs[2], /2 essais/); assert.match(msgs[3], /1 essai avant/);
  let r = await intruder.call('POST', '/api/admin/login', { password: 'faux-4' });
  assert.equal(r.status, 429); assert.equal(r.data.code, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(r.headers.get('retry-after')) > 800, 'au moins ~15 minutes');
  // Même avec le bon mot de passe, pendant le blocage
  r = await intruder.call('POST', '/api/admin/login', { password: PW });
  assert.equal(r.status, 429, 'bon mot de passe refusé pendant le blocage');
  assert.equal((await intruder.call('GET', '/api/admin/status')).data.unlocked, false);
  // Un autre navigateur inconnu, même adresse : bloqué aussi
  assert.equal((await browser(s.BASE).call('POST', '/api/admin/login', { password: PW })).status, 429);

  // Le propriétaire, dont le navigateur a déjà ouvert l'administration, a son propre compteur
  r = await owner.call('POST', '/api/admin/login', { password: PW });
  assert.equal(r.status, 200, 'navigateur connu : pas enfermé dehors par les essais d\'un inconnu');
  assert.equal((await owner.call('GET', '/api/admin/status')).data.unlocked, true);
  // … mais il reste limité lui aussi
  await owner.call('POST', '/api/admin/logout');
  for (let i = 0; i < 4; i++) assert.equal((await owner.call('POST', '/api/admin/login', { password: 'oups-' + i })).status, 401);
  assert.equal((await owner.call('POST', '/api/admin/login', { password: 'oups-4' })).status, 429);
});

test('connexion : un échec isolé n\'empêche rien, un succès remet le compteur à zéro, nouvel identifiant de session', async (t) => {
  const s = await startServer(); t.after(() => s.stop());
  const b = browser(s.BASE);
  assert.equal((await b.call('POST', '/api/admin/setup', { password: PW })).status, 201);
  const afterSetup = b.cookie;
  assert.equal((await b.call('POST', '/api/admin/logout')).status, 200);

  for (let i = 0; i < 3; i++) assert.equal((await b.call('POST', '/api/admin/login', { password: 'non-' + i })).status, 401);
  assert.equal((await b.call('POST', '/api/admin/login', { password: PW })).status, 200);
  const first = b.cookie;
  assert.notEqual(first, afterSetup, 'nouvel identifiant à la connexion');
  // Le compteur est reparti de zéro : 4 nouveaux échecs ne bloquent pas
  assert.equal((await b.call('POST', '/api/admin/logout')).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await b.call('POST', '/api/admin/login', { password: 'non-' + i })).status, 401);
  assert.equal((await b.call('POST', '/api/admin/login', { password: PW })).status, 200);

  // L'ancien identifiant ne sert plus à rien
  const old = b.cookie;
  assert.equal((await b.call('POST', '/api/admin/login', { password: PW })).status, 200);
  assert.notEqual(b.cookie, old);
  const thief = browser(s.BASE); thief.cookie = old;
  assert.equal((await thief.call('GET', '/api/admin/status')).data.unlocked, false);
  assert.equal((await thief.call('GET', '/api/admin/clients')).status, 401);
  // Mauvais type de mot de passe : jamais d'erreur serveur
  const x = browser(s.BASE);
  for (const bad of [null, 12345, { $ne: '' }, ['a']]) assert.equal((await x.call('POST', '/api/admin/login', { password: bad })).status, 401);
});

test('session administrateur : expire après inactivité, puis reconnexion possible', async (t) => {
  const s = await startServer({ env: { ADMIN_IDLE_MINUTES: '0.02' } }); t.after(() => s.stop());   // ≈ 1,2 s
  const b = browser(s.BASE);
  assert.equal((await b.call('POST', '/api/admin/setup', { password: PW })).status, 201);
  assert.equal((await b.call('GET', '/api/admin/clients')).status, 200);
  await sleep(1600);
  let r = await b.call('GET', '/api/admin/clients');
  assert.equal(r.status, 401); assert.equal(r.data.code, 'ADMIN_EXPIRED'); assert.match(r.data.error, /expirée/);
  assert.equal((await b.call('GET', '/api/admin/status')).data.unlocked, false);
  assert.equal((await b.call('POST', '/api/admin/login', { password: PW })).status, 200);
  assert.equal((await b.call('GET', '/api/admin/clients')).status, 200);
});

test('session administrateur : durée maximale même en activité', async (t) => {
  const s = await startServer({ env: { ADMIN_MAX_HOURS: '0.0004' } }); t.after(() => s.stop());   // ≈ 1,4 s
  const b = browser(s.BASE);
  assert.equal((await b.call('POST', '/api/admin/setup', { password: PW })).status, 201);
  assert.equal((await b.call('GET', '/api/admin/clients')).status, 200);
  await sleep(900); assert.equal((await b.call('GET', '/api/admin/clients')).status, 200);
  await sleep(900);
  const r = await b.call('GET', '/api/admin/clients');
  assert.equal(r.status, 401); assert.equal(r.data.code, 'ADMIN_EXPIRED');
});

test('session administrateur : une session ouverte avant ces contrôles (sans horodatage) demande une reconnexion', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-secadm-'));
  const s = await startServer({ dataDir }); t.after(() => s.stop());
  const b = browser(s.BASE);
  assert.equal((await b.call('POST', '/api/admin/setup', { password: PW })).status, 201);
  assert.equal((await b.call('GET', '/api/admin/clients')).status, 200);
  // On retire les horodatages de la session enregistrée, comme avant la mise à jour
  const raw = new Database(path.join(dataDir, 'database.sqlite'));
  const rows = raw.prepare('SELECT sid, sess FROM sessions').all();
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    const o = JSON.parse(row.sess); delete o.adminSince; delete o.adminAt; delete o.adminPw; delete o.deviceOk;
    raw.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(o), row.sid);
  }
  raw.close();
  const r = await b.call('GET', '/api/admin/clients');
  assert.equal(r.status, 401); assert.equal(r.data.code, 'ADMIN_EXPIRED');
  assert.equal((await b.call('GET', '/api/admin/status')).data.unlocked, false);
  assert.equal((await b.call('POST', '/api/admin/login', { password: PW })).status, 200);
});

test('déconnexion : ferme aussi le déverrouillage de la Facturation', async (t) => {
  const s = await startServer(); t.after(() => s.stop());
  const b = browser(s.BASE);
  assert.equal((await b.call('POST', '/api/admin/setup', { password: PW })).status, 201);
  const B = '/api/admin/billing';
  assert.equal((await b.call('POST', `${B}/lock/setup`, { code: 'bonne-phrase-42', confirm: 'bonne-phrase-42' })).status, 201);
  assert.equal((await b.call('GET', `${B}/settings`)).status, 200);
  await b.call('POST', '/api/admin/logout');
  assert.equal((await b.call('GET', `${B}/settings`)).status, 401);
  await b.call('POST', '/api/admin/login', { password: PW });
  assert.equal((await b.call('GET', `${B}/settings`)).status, 423, 'la Facturation est reverrouillée après une déconnexion');
});

test('changement de mot de passe : ancien exigé, 10 caractères, autres appareils déconnectés', async (t) => {
  const s = await startServer(); t.after(() => s.stop());
  const phone = browser(s.BASE), laptop = browser(s.BASE);
  assert.equal((await phone.call('POST', '/api/admin/setup', { password: PW })).status, 201);
  assert.equal((await laptop.call('POST', '/api/admin/login', { password: PW })).status, 200);

  // Sans session : refusé
  assert.equal((await browser(s.BASE).call('POST', '/api/admin/password', { current: PW, next: 'nouveau-mot-de-passe' })).status, 401);
  // Ancien faux, nouveau trop court, identique
  let r = await laptop.call('POST', '/api/admin/password', { current: 'pas-le-bon', next: 'nouveau-mot-de-passe' });
  assert.equal(r.status, 401);
  r = await laptop.call('POST', '/api/admin/password', { current: PW, next: 'court' });
  assert.equal(r.status, 400); assert.match(r.data.error, /10 caractères/);
  r = await laptop.call('POST', '/api/admin/password', { current: PW, next: PW });
  assert.equal(r.status, 400);
  r = await laptop.call('POST', '/api/admin/password', { current: PW, next: 12345678901 });
  assert.equal(r.status, 400);

  // Changement réussi
  r = await laptop.call('POST', '/api/admin/password', { current: PW, next: 'nouveau-mot-de-passe' });
  assert.equal(r.status, 200);
  assert.equal((await laptop.call('GET', '/api/admin/clients')).status, 200, 'l\'appareil qui change reste connecté');
  r = await phone.call('GET', '/api/admin/clients');
  assert.equal(r.status, 401); assert.equal(r.data.code, 'ADMIN_EXPIRED');
  assert.equal((await phone.call('GET', '/api/admin/status')).data.unlocked, false);

  // L'ancien mot de passe ne marche plus, le nouveau oui
  assert.equal((await phone.call('POST', '/api/admin/login', { password: PW })).status, 401);
  assert.equal((await phone.call('POST', '/api/admin/login', { password: 'nouveau-mot-de-passe' })).status, 200);
  assert.equal((await phone.call('GET', '/api/admin/clients')).status, 200);
});

test('changement de mot de passe : les mauvais « mot de passe actuel » comptent comme des échecs de connexion', async (t) => {
  const s = await startServer(); t.after(() => s.stop());
  const b = browser(s.BASE);
  assert.equal((await b.call('POST', '/api/admin/setup', { password: PW })).status, 201);
  for (let i = 0; i < 4; i++) assert.equal((await b.call('POST', '/api/admin/password', { current: 'faux-' + i, next: 'nouveau-mot-de-passe' })).status, 401);
  assert.equal((await b.call('POST', '/api/admin/password', { current: 'faux-4', next: 'nouveau-mot-de-passe' })).status, 429);
  assert.equal((await b.call('POST', '/api/admin/password', { current: PW, next: 'nouveau-mot-de-passe' })).status, 429, 'bloqué aussi avec le bon');
});

test('l\'espace client n\'est pas touché par ces contrôles', async (t) => {
  const s = await startServer(); t.after(() => s.stop());
  const b = browser(s.BASE);
  assert.equal((await b.call('GET', '/api/services')).status, 200);
  assert.equal((await b.call('GET', '/api/admin/status')).data.exists, false);
  assert.equal((await b.call('GET', '/api/admin/orders')).status, 401);
});
