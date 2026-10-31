// Journal de sécurité : qui s'est connecté à l'administration, quand, depuis où, et ce qui a été refusé.
const db = require('../db');

const insert = db.prepare('INSERT INTO security_log (event, ip, agent, detail) VALUES (?, ?, ?, ?)');
const trim = db.prepare('DELETE FROM security_log WHERE id <= (SELECT MAX(id) FROM security_log) - 1000');
let n = 0;

/** @param {string} event  ex. 'admin_login_ok', 'admin_login_fail', 'admin_blocked', 'admin_password_changed' */
function record(event, req, detail) {
  try {
    insert.run(event, req && req.ip ? String(req.ip).slice(0, 64) : null,
      req && req.get ? String(req.get('user-agent') || '').slice(0, 160) : null,
      detail ? String(detail).slice(0, 300) : null);
    if (++n % 50 === 0) trim.run();
  } catch (e) { console.error('[sécurité] journal non écrit :', e.message); }
}

const recent = (limit = 50) => db.prepare('SELECT id, at, event, ip, agent, detail FROM security_log ORDER BY id DESC LIMIT ?').all(Math.min(200, limit));

module.exports = { record, recent };
