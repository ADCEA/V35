// Sauvegardes automatiques de la base (clients, commandes, factures, journal…).
//
// Chaque jour après 3 h (heure de Paris) : instantané cohérent de la base SQLite
// (API de sauvegarde en ligne, sans arrêter le serveur) → purge des sessions →
// vérification d'intégrité → gzip + chiffrement AES-256-GCM → copie :
//   • sur le disque du serveur (rétention 30 fichiers) — protège d'une erreur
//     de manipulation, PAS de la perte du disque ;
//   • HORS serveur, vers un stockage compatible S3 (Backblaze B2, Cloudflare R2…)
//     et/ou par e-mail — c'est ce qui protège réellement.
// Un envoi hors serveur n'a lieu que si les données sont chiffrées
// (BACKUP_PASSPHRASE) : jamais de base en clair qui quitte le serveur.
//
// Copie « chaque soir sur l'ordinateur » : le serveur ne peut pas écrire chez
// l'utilisateur ; c'est l'ordinateur qui vient chercher la copie (programme
// planifié, jeton dédié et révocable, voir routes/backupPull.js). La copie
// reçue compte comme une copie hors serveur.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const db = require('../db');
const { encryptFile, gzipFile } = require('./crypto');
const s3 = require('./s3');
const mailer = require('../utils/mailer'); // appelé via l'objet : substituable dans les tests
const smtpConfigured = () => mailer.isConfigured();

db.exec(`
  CREATE TABLE IF NOT EXISTS backup_runs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    trigger           TEXT NOT NULL DEFAULT 'auto',
    status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
    file_name         TEXT,
    size_bytes        INTEGER,
    sha256            TEXT,
    encrypted         INTEGER NOT NULL DEFAULT 0,
    offsite_ok        INTEGER NOT NULL DEFAULT 0,
    destinations_json TEXT NOT NULL DEFAULT '[]',
    error             TEXT
  );
`);

// Jeton de la copie vers l'ordinateur : seule l'empreinte est conservée (le jeton n'est montré qu'une fois, dans le programme généré).
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_pull (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    token_hash   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    last_name    TEXT
  );
`);

const BACKUP_DIR = path.join(db.DATA_DIR, 'backups');
const FILE_RE = /^cezanne-\d{8}T\d{6}Z\.sqlite\.gz(\.enc)?$/;

function config(env = process.env) {
  return {
    passphrase: env.BACKUP_PASSPHRASE || '',
    s3: s3.getConfig(env),
    emailTo: env.BACKUP_EMAIL_TO || '',
    emailMaxBytes: (Number(env.BACKUP_EMAIL_MAX_MB) || 15) * 1024 * 1024,
    keepLocal: Math.max(3, Number(env.BACKUP_KEEP_LOCAL) || 30),
  };
}

const stamp = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, ''); // 20261024T031500Z
const parisDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);
const parisHour = (d) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(d)) % 24;

let running = null;

async function makeSnapshot(tmpPath) {
  await db.backup(tmpPath);
  const copy = new Database(tmpPath);
  try {
    const check = copy.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`Instantané corrompu (integrity_check : ${check}).`);
    // Les sessions (cookies de connexion) n'ont rien à faire dans une sauvegarde.
    try { copy.exec('DELETE FROM sessions'); } catch { /* table absente : rien à purger */ }
    copy.exec('VACUUM');
  } finally { copy.close(); }
}

function pruneLocal(keep) {
  const files = fs.readdirSync(BACKUP_DIR).filter(f => FILE_RE.test(f)).sort(); // l'horodatage trie par date
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* déjà supprimé */ }
  }
}

async function runBackup({ trigger = 'auto', env = process.env, now = new Date(), fetchImpl, offsite = true } = {}) {
  if (running) throw new Error('Une sauvegarde est déjà en cours.');
  const job = (async () => {
    const cfg = config(env);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const id = Number(db.prepare("INSERT INTO backup_runs (started_at, trigger) VALUES (?, ?)").run(now.toISOString(), trigger).lastInsertRowid);
    const tmp = path.join(BACKUP_DIR, `.tmp-${stamp(now)}.sqlite`);
    const destinations = [];
    let fileName = null; let size = null; let sha = null; let encrypted = false;
    try {
      await makeSnapshot(tmp);
      encrypted = Boolean(cfg.passphrase);
      fileName = `cezanne-${stamp(now)}.sqlite.gz${encrypted ? '.enc' : ''}`;
      const finalPath = path.join(BACKUP_DIR, fileName);
      size = encrypted ? await encryptFile(tmp, finalPath, cfg.passphrase) : await gzipFile(tmp, finalPath);
      const buf = fs.readFileSync(finalPath);
      sha = crypto.createHash('sha256').update(buf).digest('hex');
      destinations.push({ type: 'local', ok: true, detail: `${BACKUP_DIR}` });
      try { pruneLocal(cfg.keepLocal); } catch (e) { /* purge non bloquante */ }

      if (offsite && cfg.s3.configured) {
        try {
          if (!encrypted) throw new Error('refusé : BACKUP_PASSPHRASE absente (aucune base en clair hors du serveur)');
          const r = await s3.putObject(cfg.s3, fileName, buf, { now, ...(fetchImpl ? { fetchImpl } : {}) });
          destinations.push({ type: 's3', ok: true, detail: `${cfg.s3.bucket}/${r.key}` });
        } catch (e) { destinations.push({ type: 's3', ok: false, detail: e.message }); }
      }
      if (offsite && cfg.emailTo) {
        try {
          if (!encrypted) throw new Error('refusé : BACKUP_PASSPHRASE absente (aucune base en clair par e-mail)');
          if (!smtpConfigured()) throw new Error('SMTP non configuré');
          if (size > cfg.emailMaxBytes) throw new Error(`fichier trop gros pour un e-mail (${(size / 1048576).toFixed(1)} Mo)`);
          await mailer.sendMail({
            to: cfg.emailTo,
            subject: `Sauvegarde Blanchisserie Cézanne — ${parisDate(now)}`,
            text: `Sauvegarde chiffrée de la base (${(size / 1024).toFixed(0)} Ko), empreinte SHA-256 :\n${sha}\n\nElle ne se lit qu'avec la phrase secrète de sauvegarde (BACKUP_PASSPHRASE) : voir scripts/restore-backup.js.`,
            attachments: [{ filename: fileName, content: buf, contentType: 'application/octet-stream' }],
          });
          destinations.push({ type: 'email', ok: true, detail: cfg.emailTo });
        } catch (e) { destinations.push({ type: 'email', ok: false, detail: e.message }); }
      }

      const off = destinations.filter(d => d.type !== 'local');
      const offsiteOk = off.some(d => d.ok);
      const status = off.length > 0 && off.every(d => d.ok) ? 'ok' : 'partial';
      db.prepare("UPDATE backup_runs SET finished_at=?, status=?, file_name=?, size_bytes=?, sha256=?, encrypted=?, offsite_ok=?, destinations_json=? WHERE id=?")
        .run(new Date().toISOString(), status, fileName, size, sha, encrypted ? 1 : 0, offsiteOk ? 1 : 0, JSON.stringify(destinations), id);
      if (status === 'partial' && off.some(d => !d.ok)) {
        notifyFailure(env, `Sauvegarde du ${parisDate(now)} : copie hors serveur en échec — ${off.filter(d => !d.ok).map(d => `${d.type} : ${d.detail}`).join(' ; ')}`);
      }
      return db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id);
    } catch (err) {
      db.prepare("UPDATE backup_runs SET finished_at=?, status='failed', file_name=?, error=?, destinations_json=? WHERE id=?")
        .run(new Date().toISOString(), fileName, String(err.message || err).slice(0, 500), JSON.stringify(destinations), id);
      notifyFailure(env, `La sauvegarde du ${parisDate(now)} a échoué : ${err.message}`);
      throw err;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* déjà absent */ }
    }
  })();
  running = job.finally(() => { running = null; });
  return job;
}

// ---------- copie vers l'ordinateur de l'utilisateur ----------

const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');

/** Crée (ou remplace) le jeton ; renvoie le jeton en clair, qui n'est jamais relisible ensuite. */
function createPullToken(now = new Date()) {
  const token = 'cz-' + crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO backup_pull (id, token_hash, created_at, last_used_at, last_name) VALUES (1, ?, ?, NULL, NULL)
    ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = NULL, last_name = NULL`)
    .run(sha256hex(token), now.toISOString());
  return token;
}
function revokePullToken() { return db.prepare('DELETE FROM backup_pull WHERE id = 1').run().changes > 0; }
function checkPullToken(token) {
  const row = db.prepare('SELECT token_hash FROM backup_pull WHERE id = 1').get();
  if (!row || typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  const a = Buffer.from(sha256hex(token)); const b = Buffer.from(row.token_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function pullState(now = new Date()) {
  const r = db.prepare('SELECT created_at, last_used_at, last_name FROM backup_pull WHERE id = 1').get();
  if (!r) return { configured: false };
  return {
    configured: true, createdAt: r.created_at, lastUsedAt: r.last_used_at, lastName: r.last_name,
    ageHours: r.last_used_at ? Math.round((now - Date.parse(r.last_used_at)) / 3.6e6) : null,
  };
}

/** Dernière sauvegarde terminée dont le fichier est encore sur le disque. */
function latestFile() {
  const rows = db.prepare("SELECT id, file_name, sha256, encrypted FROM backup_runs WHERE status IN ('ok','partial') AND file_name IS NOT NULL ORDER BY id DESC LIMIT 10").all();
  for (const r of rows) {
    if (!FILE_RE.test(r.file_name)) continue;
    const p = path.join(BACKUP_DIR, r.file_name);
    if (fs.existsSync(p)) return { runId: r.id, path: p, name: r.file_name, sha256: r.sha256, encrypted: !!r.encrypted };
  }
  return null;
}

/** Le fichier est bien parti vers l'ordinateur : la copie compte comme copie hors serveur. */
function markPulled(runId, name, now = new Date()) {
  const r = db.prepare('SELECT destinations_json FROM backup_runs WHERE id = ?').get(runId);
  if (!r) return;
  const dests = JSON.parse(r.destinations_json || '[]').filter(d => d.type !== 'pc');
  dests.push({ type: 'pc', ok: true, detail: 'ordinateur' });
  const allOff = dests.filter(d => d.type !== 'local');
  db.prepare("UPDATE backup_runs SET destinations_json = ?, offsite_ok = 1, status = ? WHERE id = ? AND status IN ('ok','partial')")
    .run(JSON.stringify(dests), allOff.every(d => d.ok) ? 'ok' : 'partial', runId);
  db.prepare('UPDATE backup_pull SET last_used_at = ?, last_name = ? WHERE id = 1').run(now.toISOString(), name);
}

// Alerte e-mail (au plus une par jour) si une sauvegarde échoue ou n'a pas pu partir hors serveur.
let lastAlertDay = null;
function notifyFailure(env, message) {
  console.error('[backup]', message);
  try {
    const day = parisDate(new Date());
    if (lastAlertDay === day || !smtpConfigured()) return;
    const to = env.BACKUP_ALERT_TO || env.BACKUP_EMAIL_TO || (db.prepare('SELECT email FROM billing_settings WHERE id = 1').get() || {}).email;
    if (!to) return;
    lastAlertDay = day;
    mailer.sendMail({ to, subject: 'Blanchisserie Cézanne — alerte sauvegarde', text: message }).catch(() => { lastAlertDay = null; });
  } catch { /* l'alerte ne doit jamais faire échouer la sauvegarde */ }
}

function isDue(now = new Date()) {
  const lastAttempt = db.prepare('SELECT started_at FROM backup_runs ORDER BY id DESC LIMIT 1').get();
  if (lastAttempt && now - Date.parse(lastAttempt.started_at) < 60 * 60 * 1000) return false; // une tentative par heure au plus
  const last = db.prepare("SELECT started_at FROM backup_runs WHERE status IN ('ok','partial') ORDER BY id DESC LIMIT 1").get();
  if (!last) return true;
  const ageH = (now - Date.parse(last.started_at)) / 3.6e6;
  if (ageH > 26) return true; // rattrapage (serveur éteint, échec…)
  return parisDate(now) !== parisDate(new Date(last.started_at)) && parisHour(now) >= 3;
}

function startScheduler(env = process.env) {
  if (env.BACKUP_SCHEDULER === 'off') { console.log('[backup] planificateur désactivé (BACKUP_SCHEDULER=off).'); return; }
  // Une sauvegarde « en cours » au démarrage est forcément un reste d'un arrêt brutal.
  db.prepare("UPDATE backup_runs SET status='failed', finished_at=?, error='Interrompue par un redémarrage du serveur.' WHERE status='running'").run(new Date().toISOString());
  const tick = async () => {
    if (running || !isDue()) return;
    try { await runBackup({ trigger: 'auto', env }); } catch (e) { /* déjà journalisé dans backup_runs */ }
  };
  setTimeout(tick, 2 * 60 * 1000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}

function getStatus(env = process.env, now = new Date()) {
  const cfg = config(env);
  const rows = db.prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 15').all();
  const runs = rows.map(r => ({
    id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, trigger: r.trigger, status: r.status,
    fileName: r.file_name, sizeBytes: r.size_bytes, sha256: r.sha256, encrypted: !!r.encrypted, offsiteOk: !!r.offsite_ok,
    destinations: JSON.parse(r.destinations_json || '[]'), error: r.error,
    downloadable: Boolean(r.file_name && fs.existsSync(path.join(BACKUP_DIR, r.file_name))),
  }));
  const lastOff = db.prepare("SELECT started_at FROM backup_runs WHERE offsite_ok = 1 ORDER BY id DESC LIMIT 1").get();
  const ageHours = lastOff ? Math.round((now - Date.parse(lastOff.started_at)) / 3.6e6) : null;
  const pull = pullState(now);
  const offsiteConfigured = cfg.s3.configured || Boolean(cfg.emailTo) || pull.configured;

  let health = 'ok'; let message = `Dernière copie hors serveur il y a ${ageHours} h.`;
  if (!offsiteConfigured) { health = 'warning'; message = "Aucune destination hors serveur configurée : en cas de perte du disque du serveur, tout serait perdu."; }
  else if (!cfg.passphrase) { health = 'warning'; message = "BACKUP_PASSPHRASE manquante : les envois hors serveur sont désactivés tant que la sauvegarde n'est pas chiffrée."; }
  else if (ageHours === null) { health = 'warning'; message = "Aucune copie hors serveur n'a encore abouti."; }
  else if (ageHours > 48) { health = 'critical'; message = `Dernière copie hors serveur il y a ${ageHours} h : vérifiez la configuration.`; }

  return {
    health, message, ageHours,
    config: {
      passphraseSet: Boolean(cfg.passphrase),
      s3: { configured: cfg.s3.configured, host: cfg.s3.endpoint ? new URL(cfg.s3.endpoint).host : null, bucket: cfg.s3.bucket || null, prefix: cfg.s3.prefix },
      email: { configured: Boolean(cfg.emailTo), smtp: smtpConfigured() },
      pull,
      keepLocal: cfg.keepLocal,
      scheduler: env.BACKUP_SCHEDULER !== 'off',
    },
    runs,
  };
}

function localFilePath(runId) {
  const r = db.prepare('SELECT file_name FROM backup_runs WHERE id = ?').get(runId);
  if (!r || !r.file_name || !FILE_RE.test(r.file_name)) return null;
  const p = path.join(BACKUP_DIR, r.file_name);
  return fs.existsSync(p) ? { path: p, name: r.file_name } : null;
}

module.exports = { runBackup, startScheduler, getStatus, isDue, localFilePath, config, BACKUP_DIR, createPullToken, revokePullToken, checkPullToken, pullState, latestFile, markPulled };
