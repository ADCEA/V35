// Envoi d'un fichier vers un stockage compatible S3 (Backblaze B2, Cloudflare R2,
// AWS S3, Scaleway, OVH…) avec la signature AWS Signature V4, sans dépendance.
// Adressage « path-style » (endpoint/bucket/clé), accepté par tous ces services.

const crypto = require('crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Encodage d'URI strict (RFC 3986) tel qu'exigé par SigV4.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');

/**
 * Calcule l'en-tête Authorization SigV4.
 * headers : en-têtes À SIGNER (noms quelconques, déjà complets : host, x-amz-date, x-amz-content-sha256…)
 */
function signV4({ method, path, query = {}, headers, payloadHash, region, service = 's3', accessKey, secretKey, amzDate }) {
  const dateStamp = amzDate.slice(0, 8);
  const canonHeaders = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const signedHeaders = canonHeaders.map(([k]) => k).join(';');
  const canonQuery = Object.entries(query).map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, encPath(path), canonQuery, canonHeaders.map(([k, v]) => `${k}:${v}\n`).join(''), signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

function getConfig(env = process.env) {
  const c = {
    endpoint: (env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
    bucket: env.BACKUP_S3_BUCKET || '',
    region: env.BACKUP_S3_REGION || 'auto',
    accessKey: env.BACKUP_S3_ACCESS_KEY || '',
    secretKey: env.BACKUP_S3_SECRET_KEY || '',
    prefix: (env.BACKUP_S3_PREFIX === undefined ? 'cezanne/' : env.BACKUP_S3_PREFIX),
  };
  c.configured = Boolean(c.endpoint && c.bucket && c.accessKey && c.secretKey);
  return c;
}

/** PUT d'un objet. Lève en cas d'échec HTTP. Renvoie { key, status }. */
async function putObject(cfg, key, body, { now = new Date(), fetchImpl = fetch } = {}) {
  const url = new URL(cfg.endpoint);
  const path = `${url.pathname.replace(/\/+$/, '')}/${cfg.bucket}/${cfg.prefix}${key}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // AAAAMMJJTHHMMSSZ
  const payloadHash = sha256hex(body);
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const { authorization } = signV4({ method: 'PUT', path, headers, payloadHash, region: cfg.region, accessKey: cfg.accessKey, secretKey: cfg.secretKey, amzDate });
  const res = await fetchImpl(`${url.origin}${encPath(path)}`, {
    method: 'PUT',
    headers: { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, authorization, 'content-type': 'application/octet-stream' },
    body,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Stockage distant : HTTP ${res.status} ${detail}`);
  }
  return { key: `${cfg.prefix}${key}`, status: res.status };
}

module.exports = { signV4, putObject, getConfig, sha256hex };
