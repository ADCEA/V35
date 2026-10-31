// Garde-fou pour les appels sortants vers une adresse saisie par un utilisateur (webhook d'un hôtel) :
// refuse les adresses internes (le serveur lui-même, le réseau privé de l'hébergeur, les services de métadonnées du cloud).
const dns = require('dns').promises;
const net = require('net');

function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
}
function privateV6(ip) {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) return privateV4(m[1]);
  return /^f[cd]/.test(x) || /^fe[89ab]/.test(x);
}
const isPrivateIp = (ip) => (net.isIPv4(ip) ? privateV4(ip) : net.isIPv6(ip) ? privateV6(ip) : true);

/** Lève une erreur si l'adresse web vise une machine interne. Résout le nom comme le fera l'appel. */
async function assertPublicUrl(urlStr) {
  let u; try { u = new URL(urlStr); } catch { throw new Error('URL invalide.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('URL invalide (http ou https).');
  if (u.username || u.password) throw new Error("L'URL ne doit pas contenir d'identifiants.");
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('Adresse interne refusée.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('Adresse interne refusée.');
  return u;
}

module.exports = { assertPublicUrl, isPrivateIp };
