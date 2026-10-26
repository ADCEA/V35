// Copie chaque soir sur l'ordinateur : jeton dédié (seule son empreinte est conservée), sauvegarde fraîche chiffrée envoyée
// avec son empreinte SHA-256, refus sans chiffrement, révocation, anti-essais, programme Windows généré.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { startServer } = require('./helpers');
const { decryptBuffer } = require('../src/backup/crypto');
const { buildScript } = require('../src/backup/pullScript');

const CODE = 'code-facturation-1';
const PASS = 'phrase de test pour la copie du soir';
const B = '/api/admin/billing';
let s; let s2;
const call = (...a) => s.call(...a);
async function sensitive(scope, method, url, body, who = s) {
  const c = await who.call('POST', `${B}/lock/confirm`, { code: CODE, scope });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return who.call(method, url, body);
}
const pull = (token, qs = '') => fetch(`${s.BASE}/api/backup-pull/latest${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const tokenOf = (content) => content.match(/\$Jeton\s+=\s+'(cz-[0-9a-f]{64})'/)[1];
async function until(fn, ms = 3000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await new Promise(r => setTimeout(r, 50)); } }

test.before(async () => {
  s = await startServer({ env: { BACKUP_PASSPHRASE: PASS, PUBLIC_URL: undefined, RENDER_EXTERNAL_URL: undefined } });
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  s2 = await startServer({ env: { BACKUP_PASSPHRASE: undefined } });   // serveur sans chiffrement
  assert.equal((await s2.call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await s2.call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
});
test.after(async () => { if (s) await s.stop(); if (s2) await s2.stop(); });

test('la préparation du programme exige la ressaisie du code, et le chiffrement', async () => {
  assert.equal((await call('POST', `${B}/backup/pull/setup`, { origin: s.BASE })).status, 403);
  const nope = await sensitive('backup-pull', 'POST', `${B}/backup/pull/setup`, { origin: s2.BASE }, s2);
  assert.equal(nope.status, 409);
  assert.match(nope.data.error, /BACKUP_PASSPHRASE/);
  const st = await s2.call('GET', `${B}/backup/status`);
  assert.equal(st.data.config.pull.configured, false);
});

test('programme généré : adresse, jeton, BOM, accents ; seule l\'empreinte du jeton est conservée', async () => {
  const st0 = await call('GET', `${B}/backup/status`);
  assert.equal(st0.data.config.pull.configured, false);
  assert.equal(st0.data.health, 'warning');   // rien hors serveur pour l'instant
  const r = await sensitive('backup-pull', 'POST', `${B}/backup/pull/setup`, { origin: s.BASE });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.filename, 'sauvegarde-cezanne.ps1');
  const c = r.data.content;
  assert.equal(c.charCodeAt(0), 0xFEFF, 'BOM UTF-8 pour que PowerShell 5.1 lise les accents');
  assert.ok(c.includes(`$Site     = '${s.BASE}'`));
  assert.ok(c.includes('/api/backup-pull/latest?fresh=1'));
  assert.ok(!c.includes('@@'), 'aucun marqueur resté');
  assert.ok(/\r\n/.test(c) && !/[^\r]\n/.test(c), 'fins de ligne Windows');
  assert.match(c, /Sauvegardes Cezanne/);
  const token = tokenOf(c);
  // le jeton n'est pas relisible : ni dans la réponse d'état, ni dans le fichier de base
  const st = await call('GET', `${B}/backup/status`);
  assert.equal(st.data.config.pull.configured, true);
  assert.ok(!JSON.stringify(st.data).includes(token));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(s.DATA_DIR, 'database.sqlite'), { readonly: true });
  const row = db.prepare('SELECT token_hash FROM backup_pull WHERE id = 1').get(); db.close();
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!fs.readFileSync(path.join(s.DATA_DIR, 'database.sqlite')).includes(Buffer.from(token)));
  assert.equal(st.data.health, 'warning');   // configuré mais aucune copie reçue
  assert.match(st.data.message, /aucune copie hors serveur/i);
});

test('buildScript refuse une adresse ou un jeton qui pourraient injecter du code', () => {
  const ok = 'cz-' + 'a'.repeat(64);
  assert.throws(() => buildScript({ origin: "http://x'; Remove-Item *; '", token: ok }), /Adresse/);
  assert.throws(() => buildScript({ origin: 'https://site.fr/chemin', token: ok }), /Adresse/);
  assert.throws(() => buildScript({ origin: 'https://site.fr', token: "cz-x'; calc; '" }), /Jeton/);
  assert.ok(buildScript({ origin: 'https://blanchisserie-cezanne.fr', token: ok }).includes("'https://blanchisserie-cezanne.fr'"));
});

test('sans jeton, avec un faux jeton : refus ; le jeton ne donne pas accès à l\'administration', async () => {
  assert.equal((await pull(null)).status, 401);
  assert.equal((await pull('cz-' + '0'.repeat(64))).status, 401);
  const gen = await sensitive('backup-pull', 'POST', `${B}/backup/pull/setup`, { origin: s.BASE });
  const token = tokenOf(gen.data.content);
  const admin = await fetch(`${s.BASE}${B}/backup/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(admin.status, 401);
  const files = await fetch(`${s.BASE}${B}/backup/1/download`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(files.status, 401);
});

test('copie du soir : sauvegarde fraîche, chiffrée, empreinte exacte, comptée comme copie hors serveur', async () => {
  const gen = await sensitive('backup-pull', 'POST', `${B}/backup/pull/setup`, { origin: s.BASE });
  const token = tokenOf(gen.data.content);
  // aucune sauvegarde existante, pas de « fresh » : rien à envoyer
  assert.equal((await pull(token)).status, 404);

  const res = await pull(token, '?fresh=1');
  assert.equal(res.status, 200);
  const name = res.headers.get('x-backup-name');
  assert.match(name, /^cezanne-\d{8}T\d{6}Z\.sqlite\.gz\.enc$/);
  assert.equal(res.headers.get('x-backup-fresh'), '1');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(res.headers.get('x-backup-sha256'), crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(Number(res.headers.get('content-length')), body.length);
  // chiffré : rien en clair, déchiffrable avec la phrase, c'est bien une base SQLite
  assert.ok(!body.includes(Buffer.from('SQLite format 3')));
  const sqlite = decryptBuffer(body, PASS);   // déchiffre ET décompresse
  assert.equal(sqlite.subarray(0, 15).toString(), 'SQLite format 3');
  assert.ok(!sqlite.includes(Buffer.from(token)), 'le jeton n\'est pas dans la sauvegarde');

  const st = await until(async () => { const x = (await call('GET', `${B}/backup/status`)).data; return x.runs[0] && x.runs[0].destinations.some(d => d.type === 'pc') ? x : null; });
  assert.ok(st, 'la copie reçue est notée');
  assert.equal(st.runs[0].trigger, 'pull');
  assert.equal(st.runs[0].status, 'ok');
  assert.equal(st.runs[0].offsiteOk, true);
  assert.equal(st.runs[0].fileName, name);
  assert.equal(st.config.pull.configured, true);
  assert.ok(st.config.pull.lastUsedAt);
  assert.equal(st.config.pull.lastName, name);
  assert.equal(st.health, 'ok', st.message);
  assert.ok(!(st.runs[0].destinations || []).some(d => d.type === 's3' || d.type === 'email'), 'pas d\'envoi supplémentaire ailleurs');

  // sans « fresh » : la dernière sauvegarde existante, sans en refaire une
  const again = await pull(token);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('x-backup-name'), name);
  assert.equal(again.headers.get('x-backup-fresh'), '0');
  await again.arrayBuffer();
  const runs = (await call('GET', `${B}/backup/status`)).data.runs.filter(r => r.trigger === 'pull');
  assert.equal(runs.length, 1, 'aucune nouvelle sauvegarde sans fresh=1');
});

test('un nouveau programme remplace l\'ancien jeton', async () => {
  const a = tokenOf((await sensitive('backup-pull', 'POST', `${B}/backup/pull/setup`, { origin: s.BASE })).data.content);
  const b = tokenOf((await sensitive('backup-pull', 'POST', `${B}/backup/pull/setup`, { origin: s.BASE })).data.content);
  assert.notEqual(a, b);
  assert.equal((await pull(a)).status, 401);
  assert.equal((await pull(b)).status, 200);
});

test('arrêt de la copie : le jeton est révoqué', async () => {
  const token = tokenOf((await sensitive('backup-pull', 'POST', `${B}/backup/pull/setup`, { origin: s.BASE })).data.content);
  assert.equal((await pull(token)).status, 200);
  assert.equal((await call('DELETE', `${B}/backup/pull`)).status, 403, 'ressaisie du code exigée');
  const off = await sensitive('backup-pull', 'DELETE', `${B}/backup/pull`);
  assert.equal(off.status, 200);
  assert.equal(off.data.state.configured, false);
  assert.equal((await pull(token)).status, 401);
  assert.equal((await call('GET', `${B}/backup/status`)).data.config.pull.configured, false);
});

test('anti-essais : au-delà de 20 faux jetons, la route se ferme (le vrai jeton aussi, le temps de la pause)', async () => {
  const token = tokenOf((await sensitive('backup-pull', 'POST', `${B}/backup/pull/setup`, { origin: s.BASE })).data.content);
  let last;
  for (let i = 0; i < 25; i++) last = await pull('cz-' + crypto.randomBytes(32).toString('hex'));
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal((await pull(token)).status, 429);
});
