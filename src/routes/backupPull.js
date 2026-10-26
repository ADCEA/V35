// /api/backup-pull — l'ordinateur de l'utilisateur vient chercher la sauvegarde chiffrée (programme planifié chaque soir).
//
// Authentification : en-tête « Authorization: Bearer <jeton> », jeton propre à cette fonction (Facturation → Sécurité et
// sauvegardes), seule son empreinte est stockée ; il ne donne accès qu'à CETTE route, jamais à l'administration.
// Jamais de base en clair : sans BACKUP_PASSPHRASE, la route refuse (comme pour le stockage externe et l'e-mail).

const express = require('express');
const fs = require('fs');
const path = require('path');
const backup = require('../backup');

const router = express.Router();

// Anti-essais : au-delà de 20 jetons faux en 15 minutes, la route se ferme 15 minutes (le jeton fait 256 bits : c'est
// du bruit à éteindre, pas une vraie menace). Compteur par adresse vue par le serveur.
const fails = new Map();
const WINDOW_MS = 15 * 60 * 1000; const MAX_FAILS = 20;
function blocked(ip, now) {
  const f = fails.get(ip);
  if (!f) return 0;
  if (now - f.first > WINDOW_MS) { fails.delete(ip); return 0; }
  return f.n >= MAX_FAILS ? Math.ceil((f.first + WINDOW_MS - now) / 1000) : 0;
}
function fail(ip, now) {
  const f = fails.get(ip);
  if (!f || now - f.first > WINDOW_MS) fails.set(ip, { n: 1, first: now }); else f.n += 1;
  if (fails.size > 500) for (const [k, v] of fails) if (now - v.first > WINDOW_MS) fails.delete(k);
}

function auth(req, res, next) {
  const now = Date.now();
  const wait = blocked(req.ip, now);
  if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: 'Trop d\'essais. Réessayez plus tard.' }); }
  const m = (req.headers.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
  if (!m || !backup.checkPullToken(m[1].trim())) {
    fail(req.ip, now);
    return res.status(401).json({ error: m ? 'Jeton invalide ou révoqué : reprenez le programme depuis Facturation → Sécurité et sauvegardes.' : 'Jeton manquant.' });
  }
  next();
}

// GET /api/backup-pull/latest[?fresh=1] — fresh=1 : sauvegarde d'abord un instantané à jour (sans copie S3 ni e-mail
// supplémentaire) ; si cet instantané échoue, on envoie la dernière sauvegarde existante plutôt que rien.
router.get('/latest', auth, async (req, res) => {
  try {
    if (!backup.config().passphrase) {
      return res.status(409).json({ error: "La sauvegarde n'est pas chiffrée : ajoutez la variable BACKUP_PASSPHRASE sur l'hébergeur (aucune base en clair ne quitte le serveur)." });
    }
    let file = null; let fresh = false; let freshError = null;
    if (req.query.fresh === '1') {
      try {
        const run = await backup.runBackup({ trigger: 'pull', offsite: false });
        fresh = true;
        file = { runId: run.id, path: path.join(backup.BACKUP_DIR, run.file_name), name: run.file_name, sha256: run.sha256 };
      } catch (e) { freshError = e.message; }
    }
    if (!file) file = backup.latestFile();
    if (!file || !fs.existsSync(file.path)) {
      return res.status(404).json({ error: freshError ? `Sauvegarde impossible : ${freshError}` : "Aucune sauvegarde disponible pour l'instant." });
    }
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fs.statSync(file.path).size),
      'X-Backup-Name': file.name,
      'X-Backup-Sha256': file.sha256 || '',
      'X-Backup-Fresh': fresh ? '1' : '0',
    });
    res.on('finish', () => { try { backup.markPulled(file.runId, file.name); } catch (e) { console.error('[backup]', e.message); } });
    fs.createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    res.status(500).json({ error: `Erreur serveur : ${e.message}` });
  }
});

module.exports = router;
