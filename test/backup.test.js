// Sauvegardes : chiffrement, signature S3 (vecteurs officiels AWS), envoi vers un
// faux stockage, rétention, planification.
const os = require('os'); const path = require('path'); const fs = require('fs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-bak-'));
process.env.DATA_DIR = DATA_DIR; process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const db = require('../src/db');
const bk = require('../src/backup');
const { encryptFile, decryptBuffer } = require('../src/backup/crypto');
const s3 = require('../src/backup/s3');
const mailer = require('../src/utils/mailer');

test('chiffrement : aller-retour, mauvaise phrase, fichier altéré', async () => {
  const src = path.join(DATA_DIR, 'clair.bin'); const enc = path.join(DATA_DIR, 'clair.enc');
  const payload = crypto.randomBytes(5000).toString('hex'); // compressible
  fs.writeFileSync(src, payload);
  await encryptFile(src, enc, 'phrase secrète 1');
  const blob = fs.readFileSync(enc);
  assert.equal(decryptBuffer(blob, 'phrase secrète 1').toString(), payload);
  assert.ok(!blob.includes(Buffer.from(payload.slice(0, 40))), 'rien en clair dans le fichier');
  assert.throws(() => decryptBuffer(blob, 'autre phrase'), /phrase secrète incorrecte|altéré/);
  const tampered = Buffer.from(blob); tampered[tampered.length - 40] ^= 1;
  assert.throws(() => decryptBuffer(tampered, 'phrase secrète 1'), /altéré|incorrecte/);
  assert.throws(() => decryptBuffer(Buffer.from('n importe quoi, assez long pour passer la taille minimale ......'), 'x'), /non reconnu/);
  // deux chiffrements du même contenu ne se ressemblent pas (sel et IV aléatoires)
  await encryptFile(src, enc + '2', 'phrase secrète 1');
  assert.notDeepEqual(fs.readFileSync(enc + '2').subarray(5, 33), blob.subarray(5, 33));
});

test('signature SigV4 : vecteurs officiels de la documentation AWS S3', () => {
  const base = { region: 'us-east-1', accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z' };
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const get = s3.signV4({ ...base, method: 'GET', path: '/test.txt', payloadHash: empty,
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': base.amzDate } });
  assert.equal(get.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  const ph = s3.sha256hex('Welcome to Amazon S3.');
  const put = s3.signV4({ ...base, method: 'PUT', path: '/test$file.text', payloadHash: ph,
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': ph, 'x-amz-date': base.amzDate, 'x-amz-storage-class': 'REDUCED_REDUNDANCY' } });
  assert.equal(put.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

// Faux stockage S3 : revérifie la signature et l'empreinte du corps à chaque PUT.
function fakeS3({ secret = 'SECRET', accessKey = 'AK', region = 'auto', failWith = 0 } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const amzDate = req.headers['x-amz-date'];
      const claimed = req.headers['x-amz-content-sha256'];
      const { authorization } = s3.signV4({ method: req.method, path: decodeURIComponent(req.url.split('?')[0]), payloadHash: claimed, region, accessKey, secretKey: secret, amzDate,
        headers: { host: req.headers.host, 'x-amz-content-sha256': claimed, 'x-amz-date': amzDate } });
      const ok = authorization === req.headers.authorization && claimed === s3.sha256hex(body);
      received.push({ method: req.method, url: req.url, ok, body });
      if (failWith) { res.statusCode = failWith; return res.end('<Error><Code>AccessDenied</Code></Error>'); }
      res.statusCode = ok ? 200 : 403; res.end(ok ? '' : '<Error><Code>SignatureDoesNotMatch</Code></Error>');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, received, endpoint: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })));
}

const envFor = (fake, extra = {}) => ({
  ...process.env, BACKUP_PASSPHRASE: 'phrase-de-test', BACKUP_S3_ENDPOINT: fake.endpoint, BACKUP_S3_BUCKET: 'bucket',
  BACKUP_S3_ACCESS_KEY: 'AK', BACKUP_S3_SECRET_KEY: 'SECRET', BACKUP_S3_REGION: 'auto', ...extra,
});

test('sauvegarde complète : instantané, chiffrement, copie locale + envoi S3 signé, sessions purgées', async () => {
  db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash) VALUES ('a@b.fr','Hôtel Sauvegarde','J','06','1 rue','x')`).run();
  db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, expire INTEGER, sess TEXT)');
  db.prepare("INSERT INTO sessions (sid, expire, sess) VALUES ('abc', ?, '{\"secret\":\"cookie\"}')").run(Date.now() + 1e6);
  const fake = await fakeS3();
  try {
    const run = await bk.runBackup({ env: envFor(fake), now: new Date('2026-10-24T03:10:00Z') });
    assert.equal(run.status, 'ok'); assert.equal(run.offsite_ok, 1); assert.equal(run.encrypted, 1);
    assert.match(run.file_name, /^cezanne-20261024T031000Z\.sqlite\.gz\.enc$/);

    // Le stockage a reçu exactement le fichier local, signature valide
    assert.equal(fake.received.length, 1);
    assert.equal(fake.received[0].ok, true, 'signature et empreinte valides');
    assert.equal(fake.received[0].url, '/bucket/cezanne/' + run.file_name);
    const local = fs.readFileSync(path.join(bk.BACKUP_DIR, run.file_name));
    assert.deepEqual(fake.received[0].body, local);
    assert.equal(s3.sha256hex(local), run.sha256);

    // Restauration : la base revient, sans les sessions
    const sqlite = decryptBuffer(local, 'phrase-de-test');
    const out = path.join(DATA_DIR, 'restauree.sqlite'); fs.writeFileSync(out, sqlite);
    const r = new Database(out, { readonly: true });
    assert.equal(r.prepare("SELECT COUNT(*) c FROM clients WHERE societe='Hôtel Sauvegarde'").get().c, 1);
    assert.equal(r.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(r.prepare('SELECT COUNT(*) c FROM sessions').get().c, 0, 'sessions purgées de la copie');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 1, 'mais intactes dans la base vivante');
    r.close();
    assert.ok(!fs.readdirSync(bk.BACKUP_DIR).some(f => f.startsWith('.tmp-')), 'pas de fichier temporaire résiduel');

    // Statut : ok, avec la configuration (jamais les secrets)
    const st = bk.getStatus(envFor(fake), new Date('2026-10-24T05:10:00Z'));
    assert.equal(st.health, 'ok'); assert.equal(st.ageHours, 2);
    assert.equal(st.runs[0].downloadable, true);
    assert.ok(!JSON.stringify(st).includes('SECRET') && !JSON.stringify(st).includes('phrase-de-test'));
    assert.ok(bk.localFilePath(run.id));
  } finally { await fake.close(); }
});

test('échecs : stockage qui refuse → partielle ; pas de phrase secrète → rien ne sort en clair', async () => {
  const bad = await fakeS3({ failWith: 403 });
  try {
    const run = await bk.runBackup({ env: envFor(bad), now: new Date('2026-10-25T03:10:00Z') });
    assert.equal(run.status, 'partial'); assert.equal(run.offsite_ok, 0);
    const d = JSON.parse(run.destinations_json);
    assert.equal(d.find(x => x.type === 's3').ok, false);
    assert.match(d.find(x => x.type === 's3').detail, /HTTP 403/);
    assert.equal(d.find(x => x.type === 'local').ok, true, 'la copie locale existe quand même');
    assert.equal(bk.getStatus(envFor(bad), new Date('2026-10-30T05:10:00Z')).health, 'critical', 'plus de 48 h sans copie hors serveur');
  } finally { await bad.close(); }

  const fake = await fakeS3();
  try {
    const run = await bk.runBackup({ env: envFor(fake, { BACKUP_PASSPHRASE: '' }), now: new Date('2026-10-26T03:10:00Z') });
    assert.equal(run.status, 'partial'); assert.equal(run.encrypted, 0);
    assert.equal(fake.received.length, 0, 'aucune requête : base en clair jamais envoyée');
    assert.match(JSON.parse(run.destinations_json).find(x => x.type === 's3').detail, /BACKUP_PASSPHRASE/);
    assert.match(run.file_name, /\.sqlite\.gz$/);
  } finally { await fake.close(); }
});

test('e-mail : pièce jointe chiffrée envoyée ; refus si trop gros ou SMTP absent', async () => {
  const sent = [];
  const realSend = mailer.sendMail; const realCfg = mailer.isConfigured;
  mailer.sendMail = async (m) => { sent.push(m); return { sent: true }; };
  mailer.isConfigured = () => true;
  try {
    const env = { ...process.env, BACKUP_PASSPHRASE: 'phrase-de-test', BACKUP_EMAIL_TO: 'moi@exemple.fr', BACKUP_S3_ENDPOINT: '' };
    let run = await bk.runBackup({ env, now: new Date('2026-10-27T03:10:00Z') });
    assert.equal(run.status, 'ok'); assert.equal(run.offsite_ok, 1);
    assert.equal(sent[0].to, 'moi@exemple.fr');
    assert.equal(sent[0].attachments[0].filename, run.file_name);
    assert.equal(s3.sha256hex(sent[0].attachments[0].content), run.sha256);
    assert.doesNotThrow(() => decryptBuffer(sent[0].attachments[0].content, 'phrase-de-test'));

    run = await bk.runBackup({ env: { ...env, BACKUP_EMAIL_MAX_MB: '0.0001' }, now: new Date('2026-10-28T03:10:00Z') });
    assert.equal(run.status, 'partial');
    assert.match(JSON.parse(run.destinations_json).find(x => x.type === 'email').detail, /trop gros/);

    mailer.isConfigured = () => false;
    run = await bk.runBackup({ env, now: new Date('2026-10-28T03:11:00Z') });
    assert.match(JSON.parse(run.destinations_json).find(x => x.type === 'email').detail, /SMTP/);
  } finally { mailer.sendMail = realSend; mailer.isConfigured = realCfg; }
});

test('rétention locale et planification', async () => {
  // Rétention : on ne garde que les N plus récents
  for (let i = 0; i < 4; i++) await bk.runBackup({ env: { ...process.env, BACKUP_KEEP_LOCAL: '3', BACKUP_PASSPHRASE: 'p' }, now: new Date(`2026-11-0${i + 1}T03:10:00Z`) });
  const files = fs.readdirSync(bk.BACKUP_DIR).filter(f => f.startsWith('cezanne-'));
  assert.equal(files.length, 3);
  assert.ok(files.every(f => f >= 'cezanne-20261102'), 'les plus anciens sont supprimés');

  // Planification : dernière sauvegarde réussie = 4 nov. 03:10 UTC (04:10 à Paris)
  const T = (s) => new Date(s);
  db.prepare("UPDATE backup_runs SET started_at = '2026-11-04T03:10:00.000Z'").run();
  assert.equal(bk.isDue(T('2026-11-04T05:00:00Z')), false, 'déjà faite aujourd\'hui');
  assert.equal(bk.isDue(T('2026-11-05T00:30:00Z')), false, 'jour suivant mais avant 3 h à Paris');
  assert.equal(bk.isDue(T('2026-11-05T02:30:00Z')), true, 'jour suivant, après 3 h à Paris');
  assert.equal(bk.isDue(T('2026-11-06T00:00:00Z')), true, 'rattrapage au-delà de 26 h');
  // Une tentative récente (même ratée) bloque la suivante pendant 1 h
  db.prepare("INSERT INTO backup_runs (started_at, status, error) VALUES (?, 'failed', 'x')").run('2026-11-05T02:35:00.000Z');
  assert.equal(bk.isDue(T('2026-11-05T02:50:00Z')), false);
  assert.equal(bk.isDue(T('2026-11-05T03:40:00Z')), true);
});

test('une seule sauvegarde à la fois', async () => {
  const env = { ...process.env, BACKUP_PASSPHRASE: 'p' };
  const first = bk.runBackup({ env, now: new Date('2026-12-01T03:10:00Z') });
  await assert.rejects(() => bk.runBackup({ env, now: new Date('2026-12-01T03:11:00Z') }), /déjà en cours/);
  await first;
});

test('script de restauration en ligne de commande', () => {
  const { spawnSync } = require('child_process');
  const enc = fs.readdirSync(bk.BACKUP_DIR).filter(f => f.endsWith('.enc')).sort().pop();
  const script = path.join(__dirname, '..', 'scripts', 'restore-backup.js');
  const out = path.join(DATA_DIR, 'cli-restauree.sqlite');
  let r = spawnSync('node', [script, path.join(bk.BACKUP_DIR, enc), out], { env: { ...process.env, BACKUP_PASSPHRASE: 'mauvaise' }, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /incorrecte|altéré/); assert.ok(!fs.existsSync(out));
  const good = fs.readdirSync(bk.BACKUP_DIR).filter(f => f.endsWith('.enc')).sort();
  // Les fichiers restants ont été chiffrés avec 'p' (test de rétention) : le bon mot de passe restaure
  let ok = null;
  for (const f of good) {
    r = spawnSync('node', [script, path.join(bk.BACKUP_DIR, f), out], { env: { ...process.env, BACKUP_PASSPHRASE: 'p' }, encoding: 'utf8' });
    if (r.status === 0) { ok = r; break; }
  }
  assert.ok(ok, 'au moins une sauvegarde se restaure en CLI');
  assert.match(ok.stdout, /contrôle SQLite : ok/);
  assert.match(ok.stdout, /clients : 1/);
  // Refus d'écraser un fichier existant
  r = spawnSync('node', [script, path.join(bk.BACKUP_DIR, good[0]), out], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Refus d'écraser/);
});
