// Chiffre un petit secret (AES-256-GCM) avec une clé dérivée de SESSION_SECRET, pour qu'il ne soit jamais lisible dans la base
// ni dans une sauvegarde. Changer SESSION_SECRET rend ces secrets illisibles (il faut alors les recréer).
const crypto = require('crypto');

let cache = { secret: null, key: null };
function key() {
  const secret = process.env.SESSION_SECRET || 'dev-secret-non-persistant';
  if (cache.secret !== secret) cache = { secret, key: crypto.scryptSync(secret, 'cezanne-secretbox-v1', 32) };
  return cache.key;
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
function unseal(sealed) {
  const [v, iv, tag, ct] = String(sealed || '').split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('format inconnu');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
module.exports = { seal, unseal };
