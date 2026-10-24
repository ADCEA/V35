// Envoi des factures et avoirs ÉMIS vers Pennylane (comptabilité).
//
// Principe : le logiciel reste la source de vérité (numérotation, inaltérabilité,
// PDF légal). On envoie à Pennylane le PDF d'origine ET les montants, par l'API
// d'import (« import » = Pennylane n'émet rien et ne renumérote rien : il reçoit un
// document déjà émis). Le jeton d'API ne vit que dans l'environnement du serveur
// (PENNYLANE_API_TOKEN), jamais en base ni dans le code.
//
// Les lignes envoyées sont regroupées par taux de TVA (le détail est dans le PDF
// joint) : c'est ce qu'il faut à la comptabilité et cela évite des centaines de
// lignes par facture.

const db = require('../db');
const engine = require('./engine');
const docs = require('./documents');

const { BillingError } = engine;
const DEFAULT_BASE = 'https://app.pennylane.com/api/external/v2';
const MAX_AUTO_ATTEMPTS = 5;

// Codes de TVA Pennylane pour les taux français courants.
const VAT_CODES = { 20: 'FR_200', 10: 'FR_100', 5.5: 'FR_55', 2.1: 'FR_21', 8.5: 'FR_85', 0: 'exempt' };

function config(env = process.env) {
  return {
    token: env.PENNYLANE_API_TOKEN || '',
    base: (env.PENNYLANE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
    configured: Boolean(env.PENNYLANE_API_TOKEN),
  };
}

const money = (cents) => (cents / 100).toFixed(2);

class PennylaneError extends Error {
  constructor(message, { status, retryAfterSec } = {}) { super(message); this.name = 'PennylaneError'; this.status = status; this.retryAfterSec = retryAfterSec; }
}

async function request(cfg, method, path, { json, form, query, fetchImpl = fetch } = {}) {
  const url = new URL(cfg.base + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form; // FormData : l'en-tête multipart est posé par fetch
  // Reprise automatique en cas de limitation de débit (429) : on respecte Retry-After, 2 fois au plus.
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { method, headers, body });
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 30);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* corps non JSON */ }
    if (!res.ok) {
      const detail = (data && (data.error || data.message || (data.errors && JSON.stringify(data.errors)))) || text.replace(/\s+/g, ' ').slice(0, 300);
      const hint = res.status === 401 ? ' (jeton refusé ou expiré)' : res.status === 403 ? ' (droit manquant sur le jeton : customer_invoices:all)' : '';
      throw new PennylaneError(`Pennylane ${res.status}${hint} : ${detail}`, { status: res.status });
    }
    return data;
  }
}

// ---------- client Pennylane ----------

async function findOrCreateCustomer(cfg, client, opts) {
  const ref = `cezanne-client-${client.id}`;
  const found = await request(cfg, 'GET', '/customers', { ...opts, query: { filter: JSON.stringify([{ field: 'external_reference', operator: 'eq', value: ref }]) } });
  const existing = (found && (found.items || found.customers || []))[0];
  if (existing && existing.id) return String(existing.id);
  const addr = client.adresse_facturation || client.adresse || '';
  const created = await request(cfg, 'POST', '/company_customers', {
    ...opts,
    json: {
      name: client.societe, emails: client.email ? [client.email] : [], external_reference: ref,
      billing_address: { address: addr, postal_code: client.code_postal || '', city: client.ville || '', country: 'FR' },
    },
  });
  if (!created || !created.id) throw new PennylaneError('Pennylane : création du client sans identifiant en réponse.');
  return String(created.id);
}

// Lignes d'import : une par taux de TVA (montants en chaîne, signe négatif pour un avoir).
function importLines(inv) {
  const sign = inv.kind === 'credit_note' ? -1 : 1;
  return inv.vatBreakdown.map(b => {
    const code = VAT_CODES[b.rate];
    if (!code) throw new PennylaneError(`Taux de TVA ${b.rate} % sans code Pennylane connu.`);
    return {
      quantity: 1, unit: 'piece', vat_rate: code,
      raw_currency_unit_price: money(sign * b.baseCents),
      currency_amount: money(sign * (b.baseCents + b.vatCents)),
      currency_tax: money(sign * b.vatCents),
    };
  });
}

function importPayload(inv, customerId, fileAttachmentId) {
  const sign = inv.kind === 'credit_note' ? -1 : 1;
  return {
    file_attachment_id: fileAttachmentId, customer_id: customerId,
    date: inv.issue_date, deadline: inv.due_date || inv.issue_date,
    currency_amount_before_tax: money(sign * inv.total_ht_cents),
    currency_tax: money(sign * inv.total_vat_cents),
    currency_amount: money(sign * inv.total_ttc_cents),
    invoice_lines: importLines(inv),
  };
}

// ---------- file d'envoi ----------

function enqueue(invoiceId) {
  const inv = db.prepare('SELECT id, status FROM native_invoices WHERE id = ?').get(invoiceId);
  if (!inv) throw new BillingError('Facture introuvable.', 404);
  if (inv.status !== 'issued') throw new BillingError("Seul un document émis peut être envoyé à Pennylane.");
  db.prepare("INSERT OR IGNORE INTO pennylane_sync (invoice_id, status) VALUES (?, 'pending')").run(invoiceId);
  return db.prepare('SELECT * FROM pennylane_sync WHERE invoice_id = ?').get(invoiceId);
}

/** Envoie un document. Idempotent : un document déjà envoyé n'est jamais renvoyé. */
async function sendOne(invoiceId, { env = process.env, fetchImpl } = {}) {
  const cfg = config(env);
  if (!cfg.configured) throw new BillingError("Pennylane n'est pas configuré (variable PENNYLANE_API_TOKEN absente sur le serveur).", 503);
  const row = enqueue(invoiceId);
  if (row.status === 'sent') return row;
  const opts = fetchImpl ? { fetchImpl } : {};
  const inv = engine.loadInvoice(invoiceId);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(inv.client_id);
  db.prepare("UPDATE pennylane_sync SET attempts = attempts + 1, updated_at = datetime('now') WHERE invoice_id = ?").run(invoiceId);
  try {
    const customerId = row.customer_id || await findOrCreateCustomer(cfg, client, opts);
    if (!row.customer_id) db.prepare('UPDATE pennylane_sync SET customer_id = ? WHERE invoice_id = ?').run(customerId, invoiceId);

    const { buffer, filename } = await docs.invoicePdf(invoiceId);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
    const att = await request(cfg, 'POST', '/file_attachments', { ...opts, form });
    if (!att || !att.id) throw new PennylaneError("Pennylane : dépôt du PDF sans identifiant en réponse.");

    const created = await request(cfg, 'POST', '/customer_invoices/import', { ...opts, json: importPayload(inv, customerId, att.id) });
    const plId = created && created.id != null ? String(created.id) : null;
    db.transaction(() => {
      db.prepare("UPDATE pennylane_sync SET status='sent', pennylane_id=?, last_error=NULL, sent_at=datetime('now'), updated_at=datetime('now') WHERE invoice_id=?").run(plId, invoiceId);
      engine.logEvent('pennylane_sent', invoiceId, { pennylaneId: plId });
    })();
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    db.transaction(() => {
      db.prepare("UPDATE pennylane_sync SET status='error', last_error=?, updated_at=datetime('now') WHERE invoice_id=?").run(msg, invoiceId);
      engine.logEvent('pennylane_error', invoiceId, { error: msg });
    })();
  }
  return db.prepare('SELECT * FROM pennylane_sync WHERE invoice_id = ?').get(invoiceId);
}

/** Documents émis depuis l'activation de l'envoi automatique et pas encore dans la file. */
function autoEnqueue() {
  const since = db.prepare('SELECT pennylane_auto_since AS s FROM billing_settings WHERE id = 1').get().s;
  if (!since) return 0;
  const rows = db.prepare(`SELECT id FROM native_invoices WHERE status='issued' AND issued_at > ? AND id NOT IN (SELECT invoice_id FROM pennylane_sync)`).all(since);
  for (const r of rows) enqueue(r.id);
  return rows.length;
}

/** Traite la file (en attente, et en erreur si peu de tentatives). Renvoie le nombre de tentatives faites. */
async function processQueue({ env = process.env, fetchImpl, limit = 20 } = {}) {
  if (!config(env).configured) return 0;
  autoEnqueue();
  const rows = db.prepare(`SELECT invoice_id FROM pennylane_sync WHERE status = 'pending' OR (status = 'error' AND attempts < ?) ORDER BY invoice_id LIMIT ?`).all(MAX_AUTO_ATTEMPTS, limit);
  let n = 0;
  for (const r of rows) { await sendOne(r.invoice_id, { env, fetchImpl }); n++; await new Promise(res => setTimeout(res, 250)); } // ~4 appels/s max
  return n;
}

function startScheduler(env = process.env) {
  if (!config(env).configured || env.PENNYLANE_SCHEDULER === 'off') return;
  let busy = false;
  setInterval(async () => {
    if (busy) return; busy = true;
    try { await processQueue({ env }); } catch (e) { console.error('[pennylane]', e.message); } finally { busy = false; }
  }, 5 * 60 * 1000).unref();
}

// Après une émission : si l'envoi automatique est actif, traite la file sans bloquer la réponse.
function kickAuto(force = false, env = process.env) {
  if (!config(env).configured) return;
  const on = db.prepare('SELECT pennylane_auto_since AS s FROM billing_settings WHERE id = 1').get().s;
  if (!on && !force) return;
  setImmediate(() => processQueue({ env }).catch(e => console.error('[pennylane]', e.message)));
}

function retryFailed() {
  return db.prepare("UPDATE pennylane_sync SET status='pending', attempts=0 WHERE status='error'").run().changes;
}

function setAuto(enabled) {
  db.prepare('UPDATE billing_settings SET pennylane_auto_since = ? WHERE id = 1').run(enabled ? new Date().toISOString() : null);
}

async function testConnection({ env = process.env, fetchImpl } = {}) {
  const cfg = config(env);
  if (!cfg.configured) throw new BillingError("Pennylane n'est pas configuré (variable PENNYLANE_API_TOKEN absente sur le serveur).", 503);
  try { await request(cfg, 'GET', '/me', fetchImpl ? { fetchImpl } : {}); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function getStatus(env = process.env) {
  const cfg = config(env);
  const counts = db.prepare('SELECT status, COUNT(*) c FROM pennylane_sync GROUP BY status').all().reduce((o, r) => ({ ...o, [r.status]: r.c }), {});
  const issued = db.prepare("SELECT COUNT(*) c FROM native_invoices WHERE status='issued'").get().c;
  const since = db.prepare('SELECT pennylane_auto_since AS s FROM billing_settings WHERE id = 1').get().s;
  const errors = db.prepare(`SELECT s.invoice_id AS invoiceId, i.number, s.last_error AS error, s.attempts FROM pennylane_sync s JOIN native_invoices i ON i.id = s.invoice_id WHERE s.status = 'error' ORDER BY s.updated_at DESC LIMIT 10`).all();
  return {
    configured: cfg.configured, host: new URL(cfg.base).host, autoSince: since,
    counts: { pending: counts.pending || 0, sent: counts.sent || 0, error: counts.error || 0, notQueued: Math.max(0, issued - (counts.pending || 0) - (counts.sent || 0) - (counts.error || 0)) },
    errors,
  };
}

module.exports = { config, kickAuto, enqueue, sendOne, processQueue, startScheduler, retryFailed, setAuto, testConnection, getStatus, autoEnqueue, importPayload, importLines, PennylaneError, VAT_CODES };
