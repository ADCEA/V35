// Chiffrement des sauvegardes : gzip puis AES-256-GCM.
//
// Format du fichier .enc :  "CZBK1" | sel (16) | iv (12) | données chiffrées | étiquette GCM (16)
// La clé est dérivée de la phrase secrète (BACKUP_PASSPHRASE) par scrypt avec
// un sel aléatoire propre à chaque fichier. Sans la phrase secrète, le fichier
// est illisible ; GCM détecte aussi toute altération du fichier.

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('CZBK1');
const SALT_LEN = 16; const IV_LEN = 12; const TAG_LEN = 16;

const deriveKey = (passphrase, salt) => crypto.scryptSync(passphrase, salt, 32);

/** Compresse (gzip) puis chiffre srcPath → destPath. Renvoie la taille écrite. */
async function encryptFile(srcPath, destPath, passphrase) {
  if (!passphrase) throw new Error('Phrase secrète de sauvegarde absente.');
  const salt = crypto.randomBytes(SALT_LEN); const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  fs.writeFileSync(destPath, Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(srcPath), zlib.createGzip({ level: 9 }), cipher, fs.createWriteStream(destPath, { flags: 'a' }));
  fs.appendFileSync(destPath, cipher.getAuthTag());
  return fs.statSync(destPath).size;
}

/** Compresse seulement (pas de phrase secrète configurée). */
async function gzipFile(srcPath, destPath) {
  await pipeline(fs.createReadStream(srcPath), zlib.createGzip({ level: 9 }), fs.createWriteStream(destPath));
  return fs.statSync(destPath).size;
}

/** Déchiffre et décompresse un fichier .enc → Buffer (la base SQLite). Lève si phrase fausse ou fichier altéré. */
function decryptBuffer(encBuf, passphrase) {
  if (encBuf.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN || !encBuf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Fichier de sauvegarde non reconnu.');
  }
  let o = MAGIC.length;
  const salt = encBuf.subarray(o, o += SALT_LEN);
  const iv = encBuf.subarray(o, o += IV_LEN);
  const tag = encBuf.subarray(encBuf.length - TAG_LEN);
  const data = encBuf.subarray(o, encBuf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  let plain;
  try { plain = Buffer.concat([decipher.update(data), decipher.final()]); }
  catch { throw new Error('Déchiffrement impossible : phrase secrète incorrecte ou fichier altéré.'); }
  return zlib.gunzipSync(plain);
}

module.exports = { encryptFile, gzipFile, decryptBuffer };
