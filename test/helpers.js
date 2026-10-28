// Outils de test partagés : lance un vrai serveur sur une base jetable et
// fournit un client HTTP avec son propre jeu de cookies.
const { spawn } = require('child_process');
const os = require('os'); const path = require('path'); const fs = require('fs');

// Port libre demandé au système : les fichiers de test tournent en parallèle, et un port tiré au hasard dans une plage étroite
// finissait parfois par tomber sur celui d'un autre fichier (échec ponctuel « serveur arrêté »).
const net = require('net');
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer({ dataDir, env = {} } = {}) {
  const DATA_DIR = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-test-'));
  const PORT = await freePort();
  const BASE = `http://localhost:${PORT}`;
  const full = { ...process.env, DATA_DIR, PORT: String(PORT), SESSION_SECRET: 'test-secret', BACKUP_SCHEDULER: 'off', ...env };
  delete full.ODOO_URL; delete full.ODOO_API_KEY;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete full[k];
  const child = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], { env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('serveur non démarré')), 15000);
    child.stdout.on('data', d => { if (String(d).includes('serveur lancé')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', d => { if (process.env.TEST_VERBOSE) process.stderr.write(d); });
    child.on('exit', c => { clearTimeout(t); reject(new Error('serveur arrêté (' + c + ')')); });
  });

  let cookie = '';
  async function call(method, url, body, raw = false) {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    if (raw) return res;
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
  // Envoi d'un fichier tel quel dans le corps de la requête (PDF des documents de contrat).
  async function upload(url, buffer, contentType = 'application/pdf') {
    const res = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': contentType, cookie }, body: buffer });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }
  let exited = false;
  const stop = () => new Promise(r => {
    if (exited || child.exitCode !== null) return r();
    child.removeAllListeners('exit');
    child.on('exit', () => { exited = true; r(); });
    child.kill();
  });
  return { DATA_DIR, BASE, call, upload, stop, newClient: () => { cookie = ''; } };
}

module.exports = { startServer };
