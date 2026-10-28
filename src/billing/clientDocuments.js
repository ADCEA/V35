// Documents contractuels visibles par l'hôtel dans son espace client (contrat signé, conditions générales…).
//
// L'administration dépose un PDF (stocké dans la base, donc dans chaque sauvegarde) ; l'hôtel le consulte dans
// l'onglet « Contrat ». Un document sans hôtel (client_id NULL) est commun à tous : conditions générales de vente.

const crypto = require('crypto');
const db = require('../db');
const engine = require('./engine');

const { BillingError } = engine;

const MAX_BYTES = 8 * 1024 * 1024;     // 8 Mo par document
const MAX_PER_CLIENT = 30;
const DEFAULT_TITLE = { contract: 'Contrat de prestation', terms: 'Conditions générales de vente', other: 'Document' };

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 16 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

const toMeta = (r) => ({
  id: r.id, clientId: r.client_id, common: r.client_id == null, kind: r.kind, title: r.title, filename: r.filename,
  signedOn: r.signed_on, size: r.size, uploadedAt: r.uploaded_at,
});
const COLS = 'id, client_id, kind, title, filename, signed_on, size, uploaded_at';

function cleanTitle(v, kind) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return t || DEFAULT_TITLE[kind];
}

function cleanFilename(v, title) {
  const base = String(v ?? '').split(/[\\/]/).pop().replace(/[^\w.\- ()àâäçéèêëîïôöùûüÿ]+/gi, '_').trim();
  const stem = (base.replace(/\.pdf$/i, '') || title.replace(/[^\w\-]+/g, '_')).slice(0, 80) || 'document';
  return `${stem}.pdf`;
}

function cleanDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!engine.isIsoDate(String(v))) throw new BillingError('Date de signature invalide (format AAAA-MM-JJ).');
  return String(v);
}

function clientExists(clientId) {
  if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId)) throw new BillingError('Hôtel introuvable.', 404);
}

/** Documents d'un hôtel (sans son PDF), le contrat en premier. */
function listForClient(clientId) {
  clientExists(clientId);
  return db.prepare(`SELECT ${COLS} FROM client_documents WHERE client_id = ? ORDER BY (kind = 'contract') DESC, COALESCE(signed_on, substr(uploaded_at,1,10)) DESC, id DESC`).all(clientId).map(toMeta);
}

/** Documents communs à tous les hôtels. */
function listCommon() {
  return db.prepare(`SELECT ${COLS} FROM client_documents WHERE client_id IS NULL ORDER BY (kind = 'terms') DESC, id DESC`).all().map(toMeta);
}

/** Ce que voit l'hôtel : ses documents, puis les documents communs. */
function listVisibleTo(clientId) {
  return db.prepare(`SELECT ${COLS} FROM client_documents WHERE client_id = ? OR client_id IS NULL
                     ORDER BY (client_id IS NULL), (kind = 'contract') DESC, (kind = 'terms') DESC, COALESCE(signed_on, substr(uploaded_at,1,10)) DESC, id DESC`).all(clientId).map(toMeta);
}

/** Dépose un PDF. clientId null = document commun. */
function add({ clientId = null, kind, title, filename, signedOn, data }) {
  const k = clientId == null ? (kind === 'other' ? 'other' : 'terms') : (['contract', 'other'].includes(kind) ? kind : 'contract');
  if (clientId != null) {
    clientExists(clientId);
    const n = db.prepare('SELECT COUNT(*) c FROM client_documents WHERE client_id = ?').get(clientId).c;
    if (n >= MAX_PER_CLIENT) throw new BillingError(`Trente documents au plus par hôtel : supprimez-en avant d'en ajouter.`, 409);
  }
  if (!isPdf(data)) throw new BillingError('Le fichier doit être un PDF.');
  if (data.length > MAX_BYTES) throw new BillingError('Fichier trop volumineux (8 Mo au plus).', 413);
  const t = cleanTitle(title, k);
  const info = db.prepare('INSERT INTO client_documents (client_id, kind, title, filename, signed_on, size, sha256, data) VALUES (?,?,?,?,?,?,?,?)')
    .run(clientId, k, t, cleanFilename(filename, t), cleanDate(signedOn), data.length, crypto.createHash('sha256').update(data).digest('hex'), data);
  engine.logEvent('client_document_added', null, { documentId: Number(info.lastInsertRowid), clientId, kind: k, title: t, size: data.length });
  return toMeta(db.prepare(`SELECT ${COLS} FROM client_documents WHERE id = ?`).get(info.lastInsertRowid));
}

function update(id, { title, signedOn }) {
  const cur = db.prepare(`SELECT ${COLS} FROM client_documents WHERE id = ?`).get(id);
  if (!cur) throw new BillingError('Document introuvable.', 404);
  const t = title === undefined ? cur.title : cleanTitle(title, cur.kind);
  const d = signedOn === undefined ? cur.signed_on : cleanDate(signedOn);
  db.prepare('UPDATE client_documents SET title = ?, signed_on = ? WHERE id = ?').run(t, d, id);
  return toMeta(db.prepare(`SELECT ${COLS} FROM client_documents WHERE id = ?`).get(id));
}

function remove(id) {
  const cur = db.prepare(`SELECT ${COLS} FROM client_documents WHERE id = ?`).get(id);
  if (!cur) throw new BillingError('Document introuvable.', 404);
  db.prepare('DELETE FROM client_documents WHERE id = ?').run(id);
  engine.logEvent('client_document_removed', null, { documentId: id, clientId: cur.client_id, kind: cur.kind, title: cur.title });
  return { ok: true };
}

/** Le PDF et ses informations, ou null. */
function getFile(id) {
  const r = db.prepare('SELECT id, client_id, kind, title, filename, data FROM client_documents WHERE id = ?').get(id);
  return r || null;
}

module.exports = { MAX_BYTES, MAX_PER_CLIENT, DEFAULT_TITLE, isPdf, listForClient, listCommon, listVisibleTo, add, update, remove, getFile };
