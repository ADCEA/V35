#!/usr/bin/env node
// Restauration d'une sauvegarde chiffrée.
//
//   BACKUP_PASSPHRASE='votre phrase secrète' node scripts/restore-backup.js cezanne-AAAAMMJJTHHMMSSZ.sqlite.gz.enc restauree.sqlite
//
// Écrit une base SQLite lisible et en vérifie l'intégrité. Pour l'utiliser en
// production : arrêter le serveur, garder une copie de DATA_DIR/database.sqlite,
// remplacer ce fichier par la base restaurée, redémarrer, puis lancer
// « Contrôle d'intégrité » dans Facturation → Contrôle et exports.

const fs = require('fs');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { decryptBuffer } = require('../src/backup/crypto');

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('Usage : BACKUP_PASSPHRASE=… node scripts/restore-backup.js <sauvegarde.enc|.gz> <sortie.sqlite>');
  process.exit(1);
}
if (fs.existsSync(dest)) { console.error(`Refus d'écraser ${dest} : choisissez un autre nom de sortie.`); process.exit(1); }

const raw = fs.readFileSync(src);
let sqlite;
try {
  if (src.endsWith('.enc')) {
    if (!process.env.BACKUP_PASSPHRASE) { console.error('Définissez BACKUP_PASSPHRASE (la phrase secrète utilisée pour chiffrer).'); process.exit(1); }
    sqlite = decryptBuffer(raw, process.env.BACKUP_PASSPHRASE);
  } else {
    sqlite = zlib.gunzipSync(raw);
  }
} catch (e) { console.error('Échec :', e.message); process.exit(1); }

fs.writeFileSync(dest, sqlite, { mode: 0o600 });
const d = new Database(dest, { readonly: true });
const check = d.pragma('integrity_check', { simple: true });
const count = (t) => { try { return d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { return 'n/a'; } };
console.log(`Base restaurée : ${dest}`);
console.log(`  contrôle SQLite : ${check}`);
console.log(`  clients : ${count('clients')} · commandes : ${count('orders')} · documents de facturation : ${count('native_invoices')}`);
d.close();
process.exit(check === 'ok' ? 0 : 2);
