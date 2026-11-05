// Archive ZIP minimale, sans dépendance : une liste de fichiers (nom + contenu) → un Buffer .zip.
// Noms en UTF-8 (indicateur 0x0800), compression « deflate » quand elle réduit la taille, sinon stockage tel quel.
// Pas de ZIP64 : limité à 65 535 fichiers et 4 Go, très au-delà de l'usage (quelques centaines de PDF).
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Date et heure au format MS-DOS (année ≥ 1980). */
function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param {{ name: string, data: Buffer }[]} files  noms uniques, sans « / » ni « \ » (archive à plat)
 * @param {Date} [when]  date inscrite sur chaque fichier (par défaut : maintenant)
 */
function createZip(files, when = new Date()) {
  if (files.length > 65535) throw new Error('Trop de fichiers pour une archive ZIP.');
  const seen = new Set();
  const { time, date } = dosDateTime(when);
  const locals = []; const centrals = []; let offset = 0;
  for (const f of files) {
    if (!f.name || /[\\/]/.test(f.name)) throw new Error(`Nom de fichier invalide dans l'archive : ${f.name}`);
    if (seen.has(f.name)) throw new Error(`Nom de fichier en double dans l'archive : ${f.name}`);
    seen.add(f.name);
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const deflated = packed.length < raw.length;
    const body = deflated ? packed : raw;
    const method = deflated ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

module.exports = { createZip, crc32 };
