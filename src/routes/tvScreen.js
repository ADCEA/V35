// Écran TV (lecture seule) : GET /api/tv/map avec l'en-tête x-tv-token. Pas de session administrateur : le jeton se crée et
// se remplace dans Logistique (POST /api/admin/logistics/tv). Un jeton inconnu ou remplacé reçoit 401.
const express = require('express');
const db = require('../db');
const security = require('../middleware/security');
const { buildMap } = require('./logistics');
const { tvTokenHash, publicMap } = require('../utils/tvScreen');

const router = express.Router();
router.use(security.rateLimit({ name: 'écran TV', windowMs: 60 * 1000, max: 90, message: 'Trop de demandes. Réessayez dans une minute.' }));

const SEEN_EVERY_MS = 60 * 1000;
const seenStmt = db.prepare('UPDATE tv_screen SET last_seen_at = ? WHERE id = 1');

router.get('/map', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const raw = req.get('x-tv-token');
  if (!raw || raw.length < 32 || raw.length > 128) return res.status(401).json({ error: 'Lien de la TV manquant.', code: 'TV_UNKNOWN' });
  const row = db.prepare('SELECT token_hash, last_seen_at FROM tv_screen WHERE id = 1').get();
  if (!row) return res.status(401).json({ error: 'Le lien de la TV est désactivé.', code: 'TV_DISABLED' });
  if (row.token_hash !== tvTokenHash(raw)) return res.status(401).json({ error: 'Ce lien de la TV n\'est plus valable : un nouveau lien a été créé.', code: 'TV_UNKNOWN' });
  const now = Date.now();
  if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > SEEN_EVERY_MS) seenStmt.run(new Date(now).toISOString());
  res.json(publicMap(buildMap()));
});

module.exports = router;
