// Catalogue d'articles, fiches clients et tarifs par client — partie PROTÉGÉE de la
// facturation (derrière le code de la Facturation, voir billing/lock.js).
//
// Principes :
//  - Le prix catalogue vit dans `articles.price`. Un tarif négocié vit dans
//    `client_prices` : une ligne par période (date_debut → date_fin, NULL = sans fin).
//    Il n'y a une ligne que pour les articles dont le prix diffère du catalogue.
//  - Le prix applicable à une date = tarif négocié couvrant cette date, sinon prix
//    catalogue (services.resolveClientPrice, utilisé partout où une commande est créée).
//  - Le prix est FIGÉ sur chaque ligne de commande à la création (order_items.price) :
//    changer un tarif ne modifie jamais une commande passée, sauf demande explicite
//    « réappliquer aux BL non facturés » (repriceUnbilled), qui ne touche pas les BL
//    déjà dans une facture ou un brouillon.
//  - Chaque changement de prix est inscrit dans le journal chaîné (billing_events).
//  - Aucune route ici : voir routes/billingCatalog.js (validation HTTP, verrou, ressaisie).

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const engine = require('./engine');
const { CATEGORIES, resolveClientPrice, todayParis } = require('../services');
const { parseCsv } = require('../utils/csv');

const { BillingError } = engine;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PRICE = 100000;

// ---------- utilitaires ----------

const round3 = (n) => Math.round(n * 1000) / 1000;
const log = (action, detail) => engine.logEvent(action, null, detail);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const slugify = (s) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function parsePrice(v, label = 'Prix') {
  if (v === null || v === undefined || String(v).trim() === '') throw new BillingError(`${label} manquant.`);
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) throw new BillingError(`${label} invalide : « ${v} ».`);
  return round3(n);
}

function parseNum(v, label, fallback = 0) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = parseFloat(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new BillingError(`${label} invalide : « ${v} ».`);
  return n;
}

function parseDate(v, fallback, label = 'Date') {
  if (v === undefined || v === null || v === '') return fallback;
  if (!engine.isIsoDate(String(v)) || String(v) < '2020-01-01' || String(v) > '2100-01-01') throw new BillingError(`${label} invalide (AAAA-MM-JJ attendu).`);
  return String(v);
}

// Anomalies qui empêcheraient d'émettre une facture à ce client.
function billingIssues({ siret, adresse_facturation, adresse }) {
  const issues = [];
  const siren = engine.sirenFrom(siret);
  if (siren.length !== 9) issues.push('SIREN/SIRET manquant');
  else if (!engine.luhnOk(siren)) issues.push('SIREN/SIRET invalide');
  if (!(adresse_facturation || adresse)) issues.push('adresse de facturation manquante');
  return issues;
}

// Exécute `fn` dans une transaction ; en simulation, annule tout à la fin et rend le résultat.
// La simulation exécute EXACTEMENT le même code que l'application : l'aperçu ne peut pas mentir.
class DryRun extends Error { constructor(result) { super('dry-run'); this.result = result; } }
function transact(apply, fn) {
  const run = db.transaction(() => {
    const result = fn();
    if (!apply) throw new DryRun(result);
    return result;
  });
  try { return run(); } catch (e) { if (e instanceof DryRun) return e.result; throw e; }
}

// ======================================================================
//  ARTICLES
// ======================================================================

const ARTICLE_COLS = `id, name, code, sage_code AS sageCode, price, category, weight_g AS weightG, volume_l AS volumeL, gsm,
  width_cm AS widthCm, length_cm AS lengthCm, folded_width_cm AS foldedWidthCm, folded_length_cm AS foldedLengthCm, folded_height_cm AS foldedHeightCm`;

function computeWeightAndVolume({ widthCm, lengthCm, foldedWidthCm, foldedLengthCm, foldedHeightCm, gsm }) {
  const weightG = Math.round(((widthCm * lengthCm) / 10000) * gsm);
  const volumeL = Math.round(((foldedWidthCm * foldedLengthCm * foldedHeightCm) / 1000) * 100) / 100;
  return { weightG, volumeL };
}

function listArticles() {
  const today = todayParis();
  const since = engine.addDays(today, -90);
  const articles = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles ORDER BY category, name COLLATE NOCASE`).all();
  const negotiated = new Map(db.prepare(`
    SELECT article_id, COUNT(DISTINCT client_id) n FROM client_prices
    WHERE date_debut <= ? AND (date_fin IS NULL OR date_fin >= ?) GROUP BY article_id
  `).all(today, today).map(r => [r.article_id, r.n]));
  const usage = new Map(db.prepare(`
    SELECT oi.service_id AS id, SUM(COALESCE(oi.delivered_qty, oi.qty)) AS qty, COUNT(DISTINCT oi.order_id) AS orders
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE substr(o.created_at, 1, 10) >= ? GROUP BY oi.service_id
  `).all(since).map(r => [r.id, r]));
  return {
    categories: CATEGORIES,
    clientCount: db.prepare('SELECT COUNT(*) c FROM clients').get().c,
    articles: articles.map(a => ({
      ...a,
      negotiatedCount: negotiated.get(a.id) || 0,
      qty90: usage.get(a.id)?.qty || 0,
      orders90: usage.get(a.id)?.orders || 0,
    })),
  };
}

// Qui est au prix catalogue, qui a un tarif négocié (et qui en a un de prévu) : sert à mesurer
// l'effet d'un changement de prix catalogue avant de l'enregistrer.
function articleImpact(articleId) {
  const today = todayParis();
  const rows = db.prepare(`
    SELECT cp.client_id AS clientId, c.societe, cp.price, cp.date_debut AS dateDebut, cp.date_fin AS dateFin
    FROM client_prices cp JOIN clients c ON c.id = cp.client_id
    WHERE cp.article_id = ? AND (cp.date_fin IS NULL OR cp.date_fin >= ?)
    ORDER BY c.societe COLLATE NOCASE
  `).all(articleId, today);
  const negotiated = rows.filter(r => r.dateDebut <= today);
  const upcoming = rows.filter(r => r.dateDebut > today);
  const negotiatedIds = new Set(negotiated.map(r => r.clientId));
  const onCatalogue = db.prepare('SELECT id, societe FROM clients ORDER BY societe COLLATE NOCASE').all().filter(c => !negotiatedIds.has(c.id));
  return { onCatalogue, negotiated, upcoming };
}

function getArticle(id) {
  const a = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles WHERE id = ?`).get(id);
  if (!a) throw new BillingError('Article introuvable.', 404);
  return { ...a, impact: articleImpact(id) };
}

// Valide et complète les champs d'un article (création : existing = null).
function normalizeArticle(body, existing) {
  const b = body || {};
  const name = String(b.name ?? existing?.name ?? '').trim();
  const code = String(b.code ?? existing?.code ?? '').trim();
  const sageCode = String(b.sageCode ?? existing?.sage_code ?? '').trim();
  if (!name) throw new BillingError("Le nom de l'article est requis.");
  if (!code) throw new BillingError('Le code (badge) est requis.');
  if (!sageCode) throw new BillingError('Le code Sage est requis.');
  const category = b.category ?? existing?.category ?? 'lit';
  if (!CATEGORIES.some(c => c.id === category)) throw new BillingError('Catégorie invalide.');
  const price = b.price !== undefined ? parsePrice(b.price) : (existing ? round3(existing.price) : parsePrice(undefined));

  const widthCm = parseNum(b.widthCm, 'Largeur', existing?.width_cm ?? 0);
  const lengthCm = parseNum(b.lengthCm, 'Longueur', existing?.length_cm ?? 0);
  const foldedWidthCm = parseNum(b.foldedWidthCm, 'Largeur pliée', existing?.folded_width_cm ?? 0);
  const foldedLengthCm = parseNum(b.foldedLengthCm, 'Longueur pliée', existing?.folded_length_cm ?? 0);
  const foldedHeightCm = parseNum(b.foldedHeightCm, 'Épaisseur pliée', existing?.folded_height_cm ?? 0);

  // gsm non transmis : reprend la valeur connue, ou la rétro-calcule depuis le poids déjà enregistré
  // (article créé avant l'ajout du champ) — pour ne jamais faire retomber le poids à zéro sans le vouloir.
  let gsm;
  if (b.gsm !== undefined) gsm = parseNum(b.gsm, 'Densité (GSM)');
  else if (existing?.gsm > 0) gsm = existing.gsm;
  else if (existing?.weight_g > 0 && existing.width_cm > 0 && existing.length_cm > 0) gsm = existing.weight_g / ((existing.width_cm * existing.length_cm) / 10000);
  else gsm = 0;

  const { weightG, volumeL } = computeWeightAndVolume({ widthCm, lengthCm, foldedWidthCm, foldedLengthCm, foldedHeightCm, gsm });
  return { name, code, sageCode, category, price, widthCm, lengthCm, foldedWidthCm, foldedLengthCm, foldedHeightCm, gsm, weightG, volumeL };
}

function assertSageFree(sageCode, exceptId) {
  const dup = db.prepare('SELECT id, name FROM articles WHERE UPPER(sage_code) = UPPER(?) AND id != ?').get(sageCode, exceptId || '');
  if (dup) throw new BillingError(`Le code Sage « ${sageCode} » est déjà utilisé par « ${dup.name} ».`, 409);
}

function uniqueArticleId(name) {
  const base = slugify(name);
  if (!base) throw new BillingError("Nom invalide pour générer l'identifiant.");
  let id = base; let n = 2;
  while (db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id)) { id = `${base}_${n}`; n += 1; }
  return id;
}

const INSERT_ARTICLE = () => db.prepare(`
  INSERT INTO articles (id, name, code, sage_code, price, category, weight_g, volume_l, gsm, width_cm, length_cm, folded_width_cm, folded_length_cm, folded_height_cm)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function createArticle(body) {
  const v = normalizeArticle(body, null);
  assertSageFree(v.sageCode, null);
  const id = uniqueArticleId(v.name);
  db.transaction(() => {
    INSERT_ARTICLE().run(id, v.name, v.code, v.sageCode, v.price, v.category, v.weightG, v.volumeL, v.gsm, v.widthCm, v.lengthCm, v.foldedWidthCm, v.foldedLengthCm, v.foldedHeightCm);
    log('article_created', { articleId: id, name: v.name, sageCode: v.sageCode, price: v.price });
  })();
  return getArticle(id);
}

function updateArticle(id, body) {
  const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  if (!existing) throw new BillingError('Article introuvable.', 404);
  const v = normalizeArticle(body, existing);
  if (v.sageCode.toUpperCase() !== String(existing.sage_code).toUpperCase()) assertSageFree(v.sageCode, id);
  const before = round3(existing.price);
  db.transaction(() => {
    db.prepare(`
      UPDATE articles SET name=?, code=?, sage_code=?, price=?, category=?, weight_g=?, volume_l=?, gsm=?, width_cm=?, length_cm=?,
        folded_width_cm=?, folded_length_cm=?, folded_height_cm=? WHERE id=?
    `).run(v.name, v.code, v.sageCode, v.price, v.category, v.weightG, v.volumeL, v.gsm, v.widthCm, v.lengthCm, v.foldedWidthCm, v.foldedLengthCm, v.foldedHeightCm, id);
    if (v.price !== before) log('article_price_changed', { articleId: id, name: v.name, sageCode: v.sageCode, from: before, to: v.price });
    const changed = [];
    if (v.name !== existing.name) changed.push('nom');
    if (v.code !== existing.code) changed.push('code');
    if (v.sageCode !== existing.sage_code) changed.push('code Sage');
    if (v.category !== existing.category) changed.push('catégorie');
    if (changed.length) log('article_updated', { articleId: id, name: v.name, fields: changed });
  })();
  return getArticle(id);
}

function deleteArticle(id) {
  const a = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  if (!a) throw new BillingError('Article introuvable.', 404);
  // Les règles de chambre référencent les articles dans du JSON : supprimer l'article les ferait
  // silencieusement disparaître du calcul de linge. On bloque et on dit où.
  const needle = JSON.stringify(id);
  const used = db.prepare('SELECT name, departure_items, recouche_items, monthly_overrides FROM room_types').all()
    .filter(r => [r.departure_items, r.recouche_items, r.monthly_overrides].some(j => typeof j === 'string' && j.includes(needle)));
  if (used.length) {
    throw new BillingError(`Cet article est utilisé dans les règles de linge de ${used.length} type(s) de chambre (${used.slice(0, 4).map(r => r.name).join(', ')}${used.length > 4 ? '…' : ''}). Retirez-le de ces règles avant de le supprimer.`, 409);
  }
  const prices = db.prepare('SELECT COUNT(*) c FROM client_prices WHERE article_id = ?').get(id).c;
  db.transaction(() => {
    db.prepare('DELETE FROM articles WHERE id = ?').run(id);
    log('article_deleted', { articleId: id, name: a.name, sageCode: a.sage_code, price: a.price, clientPricesRemoved: prices });
  })();
  return { ok: true, clientPricesRemoved: prices };
}

/** Import CSV du catalogue. `apply:false` = simulation exacte (rien n'est écrit). */
function importArticles(csvText, { apply = false } = {}) {
  let parsed;
  try { parsed = parseCsv(String(csvText || '')); } catch (e) { throw new BillingError(`Fichier CSV illisible : ${e.message}`); }
  if (!parsed.rows.length) throw new BillingError('Le fichier ne contient aucune ligne de données (juste un en-tête, ou vide).');
  const missing = ['nom', 'code', 'code_sage'].filter(c => !parsed.headers.includes(c));
  if (missing.length) throw new BillingError(`Colonne(s) obligatoire(s) manquante(s) : ${missing.join(', ')}. Colonnes trouvées : ${parsed.headers.join(', ')}.`);

  const findBySage = db.prepare('SELECT * FROM articles WHERE UPPER(sage_code) = UPPER(?)');
  const findByName = db.prepare('SELECT sage_code FROM articles WHERE LOWER(TRIM(name)) = ?');
  const insert = INSERT_ARTICLE();
  const update = db.prepare(`
    UPDATE articles SET name=?, code=?, price=?, category=?, weight_g=?, volume_l=?, gsm=?, width_cm=?, length_cm=?, folded_width_cm=?, folded_length_cm=?, folded_height_cm=? WHERE id=?
  `);
  const out = { created: [], updated: [], unchanged: [], duplicates: [], possibleDuplicates: [], errors: [] };
  const seen = new Map();
  const cols = { densite_gsm: 'gsm', largeur_cm: 'widthCm', longueur_cm: 'lengthCm', largeur_pliee_cm: 'foldedWidthCm', longueur_pliee_cm: 'foldedLengthCm', epaisseur_pliee_cm: 'foldedHeightCm' };

  transact(apply, () => {
    parsed.rows.forEach((row, idx) => {
      const line = idx + 2;
      const name = (row.nom || '').trim(); const code = (row.code || '').trim(); const sageCode = (row.code_sage || '').trim();
      if (!name) return out.errors.push({ line, error: 'Colonne « nom » vide.' });
      if (!code) return out.errors.push({ line, error: 'Colonne « code » vide.' });
      if (!sageCode) return out.errors.push({ line, error: 'Colonne « code_sage » vide.' });
      const key = sageCode.toUpperCase();
      if (seen.has(key)) return out.duplicates.push({ line, sageCode, error: `Doublon dans le fichier — même code_sage qu'à la ligne ${seen.get(key)}, ignoré.` });
      seen.set(key, line);
      const category = (row.categorie || 'lit').trim();
      if (!CATEGORIES.some(c => c.id === category)) return out.errors.push({ line, error: `Catégorie « ${category} » invalide (attendu : ${CATEGORIES.map(c => c.id).join(', ')}).` });
      const existing = findBySage.get(sageCode);
      // Cellule vide sur un article qui existe déjà = on conserve la valeur actuelle (jamais de remise à zéro silencieuse).
      let price;
      try { price = row.prix !== undefined && row.prix !== '' ? parsePrice(row.prix) : (existing ? round3(existing.price) : 0); } catch (e) { return out.errors.push({ line, error: e.message }); }
      const current = existing ? { gsm: existing.gsm, widthCm: existing.width_cm, lengthCm: existing.length_cm, foldedWidthCm: existing.folded_width_cm, foldedLengthCm: existing.folded_length_cm, foldedHeightCm: existing.folded_height_cm } : {};
      const num = {};
      for (const [col, k] of Object.entries(cols)) {
        try { num[k] = parseNum(row[col], `Colonne « ${col} »`, current[k] ?? 0); } catch (e) { return out.errors.push({ line, error: e.message }); }
      }
      let gsm = num.gsm;
      if (existing && !gsm && existing.weight_g > 0 && existing.width_cm > 0 && existing.length_cm > 0) {
        gsm = existing.weight_g / ((existing.width_cm * existing.length_cm) / 10000);   // rétro-calcul pour un article ancien
      }
      const { weightG, volumeL } = computeWeightAndVolume({ ...num, gsm });
      if (existing) {
        update.run(name, code, price, category, weightG, volumeL, gsm, num.widthCm, num.lengthCm, num.foldedWidthCm, num.foldedLengthCm, num.foldedHeightCm, existing.id);
        const from = round3(existing.price);
        if (from !== price) {
          log('article_price_changed', { articleId: existing.id, name, sageCode, from, to: price, via: 'import' });
          return out.updated.push({ line, name, sageCode, priceFrom: from, priceTo: price });
        }
        return out.unchanged.push({ line, name, sageCode });
      }
      const sameName = findByName.get(norm(name));
      if (sameName) out.possibleDuplicates.push({ line, name, error: `Un article nommé « ${name} » existe déjà avec le code_sage « ${sameName.sage_code} » (celui-ci : « ${sageCode} ») — à vérifier, créé quand même.` });
      const id = uniqueArticleId(name);
      insert.run(id, name, code, sageCode, price, category, weightG, volumeL, gsm, num.widthCm, num.lengthCm, num.foldedWidthCm, num.foldedLengthCm, num.foldedHeightCm);
      log('article_created', { articleId: id, name, sageCode, price, via: 'import' });
      out.created.push({ line, name, sageCode, price });
    });
    return out;
  });
  return {
    applied: !!apply,
    summary: { total: parsed.rows.length, created: out.created.length, updated: out.updated.length, unchanged: out.unchanged.length, duplicates: out.duplicates.length, possibleDuplicates: out.possibleDuplicates.length, errors: out.errors.length },
    ...out,
  };
}

// ======================================================================
//  CLIENTS
// ======================================================================

function listClients() {
  const today = todayParis();
  const rows = db.prepare(`
    SELECT c.id, c.societe, c.contact, c.tel, c.email, c.adresse, c.code_postal AS codePostal, c.ville, c.siret,
           c.tva_number AS tvaNumber, c.adresse_facturation AS adresseFacturation, c.invoice_detail_level AS invoiceDetailLevel,
           c.created_at AS createdAt,
           (SELECT COUNT(*) FROM client_prices cp WHERE cp.client_id = c.id AND cp.date_debut <= @t AND (cp.date_fin IS NULL OR cp.date_fin >= @t)) AS negotiatedCount,
           (SELECT COUNT(*) FROM client_prices cp WHERE cp.client_id = c.id AND cp.date_debut > @t) AS upcomingCount,
           (SELECT COUNT(*) FROM client_articles ca WHERE ca.client_id = c.id) AS assignedCount,
           (SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id) AS ordersCount,
           (SELECT MAX(o.created_at) FROM orders o WHERE o.client_id = c.id) AS lastOrderAt,
           (SELECT COUNT(*) FROM native_invoices i WHERE i.client_id = c.id AND i.status = 'issued') AS invoicesCount
    FROM clients c ORDER BY c.societe COLLATE NOCASE
  `).all({ t: today });
  const total = db.prepare('SELECT COUNT(*) c FROM articles').get().c;
  return {
    articleCount: total,
    clients: rows.map(r => ({ ...r, issues: billingIssues({ siret: r.siret, adresse_facturation: r.adresseFacturation, adresse: r.adresse }) })),
  };
}

function getClient(id) {
  const c = db.prepare(`
    SELECT id, societe, contact, tel, email, adresse, code_postal AS codePostal, ville, siret, tva_number AS tvaNumber,
           adresse_facturation AS adresseFacturation, invoice_detail_level AS invoiceDetailLevel, created_at AS createdAt,
           webhook_url AS webhookUrl, webhook_secret AS webhookSecret
    FROM clients WHERE id = ?
  `).get(id);
  if (!c) throw new BillingError('Hôtel introuvable.', 404);
  const stats = db.prepare(`
    SELECT (SELECT COUNT(*) FROM orders WHERE client_id = @id) AS orders,
           (SELECT MAX(created_at) FROM orders WHERE client_id = @id) AS lastOrderAt,
           (SELECT COUNT(*) FROM native_invoices WHERE client_id = @id AND status = 'issued' AND kind = 'invoice') AS invoices
  `).get({ id });
  const tokens = db.prepare('SELECT id, token, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE client_id = ? ORDER BY created_at DESC').all(id);
  return { client: { ...c, issues: billingIssues({ siret: c.siret, adresse_facturation: c.adresseFacturation, adresse: c.adresse }) }, stats, tokens };
}

function cleanClientFields(body, existing) {
  const b = body || {};
  const has = (k) => b[k] !== undefined;
  const str = (k, cur) => (has(k) ? String(b[k] ?? '').trim() : (cur ?? ''));
  const societe = str('societe', existing?.societe);
  if (!societe) throw new BillingError(existing ? 'Le nom du client ne peut pas être vide.' : 'Merci de renseigner le nom du client.');
  let email = has('email') ? (String(b.email || '').trim().toLowerCase() || null) : (existing?.email ?? null);
  if (email && !EMAIL_RE.test(email)) throw new BillingError('Adresse email invalide.');
  if (email && email !== existing?.email) {
    const taken = db.prepare('SELECT id FROM clients WHERE email = ? AND id != ?').get(email, existing?.id ?? 0);
    if (taken) throw new BillingError('Cet email est déjà utilisé par un autre compte.', 409);
  }
  let siret = has('siret') ? (String(b.siret || '').replace(/\s/g, '') || null) : (existing?.siret ?? null);
  if (siret && !/^\d{14}$/.test(siret)) throw new BillingError('Le SIRET doit comporter exactement 14 chiffres.');
  const level = has('invoiceDetailLevel') ? b.invoiceDetailLevel : (existing?.invoice_detail_level || 'detail');
  if (!['detail', 'per_bl', 'aggregated'].includes(level)) throw new BillingError('Niveau de détail de facture invalide.');
  return {
    societe, email, siret,
    contact: str('contact', existing?.contact),
    tel: str('tel', existing?.tel),
    adresse: str('adresse', existing?.adresse),
    codePostal: has('codePostal') ? (String(b.codePostal || '').trim() || null) : (existing?.code_postal ?? null),
    ville: has('ville') ? (String(b.ville || '').trim() || null) : (existing?.ville ?? null),
    tvaNumber: has('tvaNumber') ? (String(b.tvaNumber || '').trim() || null) : (existing?.tva_number ?? null),
    adresseFacturation: has('adresseFacturation') ? (String(b.adresseFacturation || '').trim() || null) : (existing?.adresse_facturation ?? null),
    invoiceDetailLevel: level,
  };
}

function validateAccessCode(code) {
  if (!/^\d{4,8}$/.test(String(code))) throw new BillingError("Le code d'accès doit contenir entre 4 et 8 chiffres.");
}

function createClient(body) {
  const f = cleanClientFields(body, null);
  const code = body && body.code ? String(body.code) : '';
  if (code) validateAccessCode(code);
  // Sans code choisi : empreinte d'un secret aléatoire jamais communiqué, l'espace client reste fermé.
  const hash = bcrypt.hashSync(code || crypto.randomBytes(24).toString('hex'), 10);
  let id;
  db.transaction(() => {
    id = db.prepare(`
      INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret, tva_number, adresse_facturation, invoice_detail_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(f.email, f.societe, f.contact, f.tel, f.adresse, f.codePostal, f.ville, hash, f.siret, f.tvaNumber, f.adresseFacturation, f.invoiceDetailLevel).lastInsertRowid;
    log('client_created', { clientId: Number(id), client: f.societe });
  })();
  return getClient(Number(id));
}

const CLIENT_FIELD_LABELS = { societe: 'nom', contact: 'contact', tel: 'téléphone', email: 'e-mail', adresse: 'adresse', codePostal: 'code postal', ville: 'ville', siret: 'SIRET', tvaNumber: 'n° TVA', adresseFacturation: 'adresse de facturation', invoiceDetailLevel: 'détail des factures' };

function updateClient(id, body) {
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!existing) throw new BillingError('Hôtel introuvable.', 404);
  const f = cleanClientFields(body, existing);
  const before = {
    societe: existing.societe, contact: existing.contact ?? '', tel: existing.tel ?? '', email: existing.email, adresse: existing.adresse ?? '',
    codePostal: existing.code_postal, ville: existing.ville, siret: existing.siret, tvaNumber: existing.tva_number,
    adresseFacturation: existing.adresse_facturation, invoiceDetailLevel: existing.invoice_detail_level || 'detail',
  };
  const changed = Object.keys(CLIENT_FIELD_LABELS).filter(k => (f[k] ?? null) !== (before[k] ?? null));
  db.transaction(() => {
    db.prepare(`
      UPDATE clients SET societe=?, contact=?, tel=?, adresse=?, code_postal=?, ville=?, email=?, siret=?, tva_number=?, adresse_facturation=?, invoice_detail_level=? WHERE id=?
    `).run(f.societe, f.contact, f.tel, f.adresse, f.codePostal, f.ville, f.email, f.siret, f.tvaNumber, f.adresseFacturation, f.invoiceDetailLevel, id);
    if (changed.length) log('client_updated', { clientId: id, client: f.societe, fields: changed.map(k => CLIENT_FIELD_LABELS[k]) });
  })();
  return getClient(id);
}

function setAccessCode(id, code) {
  const c = db.prepare('SELECT societe FROM clients WHERE id = ?').get(id);
  if (!c) throw new BillingError('Hôtel introuvable.', 404);
  validateAccessCode(code);
  db.transaction(() => {
    db.prepare('UPDATE clients SET code_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(code), 10), id);
    log('client_access_code_reset', { clientId: id, client: c.societe });
  })();
  return { ok: true };
}

function deleteClient(id) {
  const c = db.prepare('SELECT societe FROM clients WHERE id = ?').get(id);
  if (!c) throw new BillingError('Hôtel introuvable.', 404);
  const docs = db.prepare('SELECT (SELECT COUNT(*) FROM native_invoices WHERE client_id = @id) + (SELECT COUNT(*) FROM native_quotes WHERE client_id = @id) AS n').get({ id }).n;
  if (docs > 0) {
    throw new BillingError(`Cet hôtel a ${docs} document(s) de facturation (factures, avoirs ou devis) : ils doivent être conservés, l'hôtel ne peut donc pas être supprimé.`, 409);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM clients WHERE id = ?').run(id);   // ses commandes passées restent (client_id → NULL)
    log('client_deleted', { clientId: id, client: c.societe });
  })();
  return { ok: true };
}

// ---- jetons API et webhook (secrets de l'intégration d'un hôtel) ----

function createToken(clientId, label) {
  const c = db.prepare('SELECT societe FROM clients WHERE id = ?').get(clientId);
  if (!c) throw new BillingError('Hôtel introuvable.', 404);
  const token = crypto.randomBytes(24).toString('hex');
  const info = db.prepare('INSERT INTO api_tokens (client_id, token, label) VALUES (?, ?, ?)').run(clientId, token, String(label || '').trim().slice(0, 80) || null);
  log('client_api_token_created', { clientId, client: c.societe });
  return db.prepare('SELECT id, token, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE id = ?').get(info.lastInsertRowid);
}

function revokeToken(clientId, tokenId) {
  const info = db.prepare('DELETE FROM api_tokens WHERE id = ? AND client_id = ?').run(tokenId, clientId);
  if (!info.changes) throw new BillingError('Jeton introuvable.', 404);
  log('client_api_token_revoked', { clientId });
  return { ok: true };
}

function setWebhook(clientId, { webhookUrl, regenerateSecret }) {
  const c = db.prepare('SELECT societe, webhook_secret FROM clients WHERE id = ?').get(clientId);
  if (!c) throw new BillingError('Hôtel introuvable.', 404);
  const url = String(webhookUrl || '').trim();
  if (url) {
    let u; try { u = new URL(url); } catch { throw new BillingError('URL invalide.'); }
    if (!/^https?:$/.test(u.protocol)) throw new BillingError('URL invalide (http ou https).');
  }
  const secret = (regenerateSecret || !c.webhook_secret) ? crypto.randomBytes(20).toString('hex') : c.webhook_secret;
  db.prepare('UPDATE clients SET webhook_url = ?, webhook_secret = ? WHERE id = ?').run(url || null, secret, clientId);
  log(regenerateSecret ? 'client_webhook_secret_regenerated' : 'client_webhook_set', { clientId, client: c.societe });
  return { webhookUrl: url || null, webhookSecret: secret };
}

/** Import CSV des hôtels (colonnes : societe, contact, tel, adresse, email obligatoires). */
function importClients(csvText, { apply = false } = {}) {
  let parsed;
  try { parsed = parseCsv(String(csvText || '')); } catch (e) { throw new BillingError(`Fichier CSV illisible : ${e.message}`); }
  if (!parsed.rows.length) throw new BillingError('Le fichier ne contient aucune ligne de données (juste un en-tête, ou vide).');
  const missing = ['societe', 'contact', 'tel', 'adresse', 'email'].filter(c => !parsed.headers.includes(c));
  if (missing.length) throw new BillingError(`Colonne(s) obligatoire(s) manquante(s) : ${missing.join(', ')}. Colonnes trouvées : ${parsed.headers.join(', ')}.`);

  const byEmail = db.prepare('SELECT id, code_hash FROM clients WHERE email = ?');
  const bySociete = db.prepare('SELECT email FROM clients WHERE LOWER(TRIM(societe)) = ?');
  const insert = db.prepare('INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE clients SET societe=?, contact=?, tel=?, adresse=?, code_postal=?, ville=?, code_hash=? WHERE email=?');
  const out = { created: [], updated: [], duplicates: [], possibleDuplicates: [], errors: [] };
  const seen = new Map();

  transact(apply, () => {
    parsed.rows.forEach((row, idx) => {
      const line = idx + 2;
      const societe = (row.societe || '').trim(); const contact = (row.contact || '').trim(); const tel = (row.tel || '').trim();
      const adresse = (row.adresse || '').trim(); const email = (row.email || '').trim().toLowerCase();
      for (const [k, v] of Object.entries({ societe, contact, tel, adresse })) if (!v) return out.errors.push({ line, error: `Colonne « ${k} » vide.` });
      if (!email || !EMAIL_RE.test(email)) return out.errors.push({ line, error: `Email invalide : « ${row.email} ».` });
      if (seen.has(email)) return out.duplicates.push({ line, email, error: `Doublon dans le fichier — même email qu'à la ligne ${seen.get(email)}, ignoré.` });
      seen.set(email, line);
      const codePostal = (row.code_postal || '').trim() || null; const ville = (row.ville || '').trim() || null;
      const provided = (row.code || '').trim();
      if (provided && !/^\d{4,8}$/.test(provided)) return out.errors.push({ line, error: `Colonne « code » invalide : « ${provided} » (4 à 8 chiffres attendus).` });
      const existing = byEmail.get(email);
      if (existing) {
        update.run(societe, contact, tel, adresse, codePostal, ville, provided ? bcrypt.hashSync(provided, 10) : existing.code_hash, email);
        return out.updated.push({ line, societe, email, codeChanged: !!provided });
      }
      const same = bySociete.get(norm(societe));
      if (same) out.possibleDuplicates.push({ line, societe, error: `Un hôtel nommé « ${societe} » existe déjà avec l'email « ${same.email} » (celui-ci : « ${email} ») — à vérifier, créé quand même.` });
      const finalCode = provided || String(100000 + crypto.randomInt(900000));
      insert.run(email, societe, contact, tel, adresse, codePostal, ville, bcrypt.hashSync(finalCode, 10));
      out.created.push({ line, societe, email, code: finalCode, codeWasGenerated: !provided });
    });
    if (out.created.length || out.updated.length) log('clients_imported', { created: out.created.length, updated: out.updated.length });
    return out;
  });
  // En simulation, les codes tirés au sort n'existent pas vraiment : on ne les montre pas.
  if (!apply) out.created.forEach(c => { delete c.code; });
  return {
    applied: !!apply,
    summary: { total: parsed.rows.length, created: out.created.length, updated: out.updated.length, duplicates: out.duplicates.length, possibleDuplicates: out.possibleDuplicates.length, errors: out.errors.length },
    ...out,
  };
}

// ======================================================================
//  CATALOGUE ACCESSIBLE PAR HÔTEL
// ======================================================================

/** articleIds vide ⇒ aucune restriction (tout le catalogue). */
function setAssignment(clientId, articleIds) {
  const c = db.prepare('SELECT societe FROM clients WHERE id = ?').get(clientId);
  if (!c) throw new BillingError('Hôtel introuvable.', 404);
  const ids = [...new Set((Array.isArray(articleIds) ? articleIds : []).map(String))];
  const known = new Set(db.prepare('SELECT id FROM articles').all().map(r => r.id));
  const unknown = ids.filter(i => !known.has(i));
  if (unknown.length) throw new BillingError(`Article(s) inconnu(s) : ${unknown.slice(0, 3).join(', ')}.`);
  db.transaction(() => {
    db.prepare('DELETE FROM client_articles WHERE client_id = ?').run(clientId);
    const ins = db.prepare('INSERT INTO client_articles (client_id, article_id) VALUES (?, ?)');
    ids.forEach(a => ins.run(clientId, a));
    log('client_catalog_set', { clientId, client: c.societe, restricted: ids.length > 0, count: ids.length });
  })();
  return { ok: true, hasRestriction: ids.length > 0 };
}

// ======================================================================
//  TARIFS PAR CLIENT
// ======================================================================

const activeAt = (rows, date) => rows
  .filter(r => r.date_debut <= date && (r.date_fin == null || r.date_fin >= date))
  .sort((a, b) => b.date_debut.localeCompare(a.date_debut))[0] || null;

function clientRow(clientId) {
  const c = db.prepare('SELECT id, societe FROM clients WHERE id = ?').get(clientId);
  if (!c) throw new BillingError('Hôtel introuvable.', 404);
  return c;
}
function articleRow(articleId) {
  const a = db.prepare('SELECT id, name, sage_code, price FROM articles WHERE id = ?').get(articleId);
  if (!a) throw new BillingError(`Article introuvable : ${articleId}.`, 404);
  return a;
}

/** Tarifs d'un hôtel : pour chaque article, prix catalogue, tarif négocié en cours / à venir / passés. */
function priceGrid(clientId) {
  const client = clientRow(clientId);
  const today = todayParis();
  const articles = db.prepare('SELECT id, name, code, sage_code, category, price FROM articles ORDER BY category, name COLLATE NOCASE').all();
  const rows = db.prepare('SELECT article_id, price, date_debut, date_fin FROM client_prices WHERE client_id = ? ORDER BY date_debut').all(clientId);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.article_id)) by.set(r.article_id, []); by.get(r.article_id).push(r); }
  const assigned = new Set(db.prepare('SELECT article_id FROM client_articles WHERE client_id = ?').all(clientId).map(r => r.article_id));
  const hasRestriction = assigned.size > 0;
  return {
    client, hasRestriction, today,
    articles: articles.map(a => {
      const list = by.get(a.id) || [];
      const cur = activeAt(list, today);
      const next = list.filter(r => r.date_debut > today)[0] || null;
      return {
        id: a.id, name: a.name, code: a.code, sageCode: a.sage_code, category: a.category,
        catalogPrice: round3(a.price),
        price: cur ? cur.price : round3(a.price),
        negotiatedPrice: cur ? cur.price : null, negotiatedSince: cur ? cur.date_debut : null, negotiatedUntil: cur ? cur.date_fin : null,
        upcoming: next ? { price: next.price, from: next.date_debut } : null,
        history: list.filter(r => r !== cur && r !== next && r.date_debut <= today).reverse().map(r => ({ price: r.price, from: r.date_debut, to: r.date_fin })),
        attributed: hasRestriction ? assigned.has(a.id) : true,
      };
    }),
  };
}

// Écrit un tarif (sans transaction propre : appelable depuis une opération groupée).
// Règle : le nouveau tarif remplace tout ce qui commence à sa date d'effet ou après ; le tarif qui
// couvrait cette date est clos la veille. Aucune période ne se chevauche jamais.
function writePrice(clientId, article, price, date) {
  const rows = db.prepare('SELECT * FROM client_prices WHERE client_id = ? AND article_id = ? ORDER BY date_debut').all(clientId, article.id);
  const current = activeAt(rows, date);
  if (current && current.price === price && current.date_fin == null) return { changed: false, from: current.price, to: price };
  const from = current ? current.price : round3(article.price);
  const superseded = rows.filter(r => r.date_debut >= date);
  for (const r of superseded) db.prepare('DELETE FROM client_prices WHERE id = ?').run(r.id);
  const spanning = rows.filter(r => r.date_debut < date && (r.date_fin == null || r.date_fin >= date));
  for (const r of spanning) db.prepare('UPDATE client_prices SET date_fin = ? WHERE id = ?').run(engine.addDays(date, -1), r.id);
  db.prepare('INSERT INTO client_prices (client_id, article_id, price, date_debut) VALUES (?, ?, ?, ?)').run(clientId, article.id, price, date);
  return { changed: true, from, to: price, superseded: superseded.map(r => ({ price: r.price, from: r.date_debut })) };
}

// Retire le tarif négocié à partir de `date` : l'article retombe au prix catalogue.
function dropPrice(clientId, article, date) {
  const rows = db.prepare('SELECT * FROM client_prices WHERE client_id = ? AND article_id = ? ORDER BY date_debut').all(clientId, article.id);
  const current = activeAt(rows, date);
  const later = rows.filter(r => r.date_debut >= date);
  if (!current && !later.length) return { changed: false };
  for (const r of later) db.prepare('DELETE FROM client_prices WHERE id = ?').run(r.id);
  for (const r of rows.filter(r => r.date_debut < date && (r.date_fin == null || r.date_fin >= date))) {
    db.prepare('UPDATE client_prices SET date_fin = ? WHERE id = ?').run(engine.addDays(date, -1), r.id);
  }
  return { changed: true, from: current ? current.price : later[0].price, to: round3(article.price) };
}

function setClientPrice(clientId, articleId, priceInput, dateInput) {
  const client = clientRow(clientId);
  const article = articleRow(articleId);
  const price = parsePrice(priceInput, 'Prix');
  const date = parseDate(dateInput, todayParis(), "Date d'effet");
  return db.transaction(() => {
    const r = writePrice(clientId, article, price, date);
    if (r.changed) log('client_price_set', { clientId, client: client.societe, articleId, article: article.name, sageCode: article.sage_code, from: r.from, to: price, effective: date, ...(r.superseded?.length ? { replaced: r.superseded } : {}) });
    return { ...r, effective: date };
  })();
}

function removeClientPrice(clientId, articleId, dateInput) {
  const client = clientRow(clientId);
  const article = articleRow(articleId);
  const date = parseDate(dateInput, todayParis(), 'Date');
  return db.transaction(() => {
    const r = dropPrice(clientId, article, date);
    if (r.changed) log('client_price_removed', { clientId, client: client.societe, articleId, article: article.name, sageCode: article.sage_code, from: r.from, to: r.to, effective: date });
    return { ...r, effective: date };
  })();
}

function visibleArticles(clientId) {
  const assigned = db.prepare('SELECT article_id FROM client_articles WHERE client_id = ?').all(clientId).map(r => r.article_id);
  const all = db.prepare('SELECT id, name, sage_code, price FROM articles ORDER BY category, name COLLATE NOCASE').all();
  return assigned.length ? all.filter(a => assigned.includes(a.id)) : all;
}

/**
 * Opérations groupées sur les tarifs d'un hôtel.
 *  mode 'percent' : +/- x % (sur le prix applicable aujourd'hui, ou sur le prix catalogue si base = 'catalogue')
 *  mode 'copy'    : reprend les tarifs négociés en cours d'un autre hôtel
 *  mode 'reset'   : retire tous les tarifs négociés (retour au catalogue)
 * `apply:false` rend l'aperçu exact sans rien écrire.
 */
function bulkPrices(clientId, opts, { apply = false } = {}) {
  const client = clientRow(clientId);
  const o = opts || {};
  const date = parseDate(o.from, todayParis(), "Date d'effet");
  const mode = o.mode;
  const changes = [];
  transact(apply, () => {
    if (mode === 'percent') {
      const pct = Number(o.percent);
      if (!Number.isFinite(pct) || pct < -90 || pct > 500 || pct === 0) throw new BillingError('Pourcentage invalide (entre -90 et +500, différent de 0).');
      const wanted = Array.isArray(o.articleIds) && o.articleIds.length ? new Set(o.articleIds.map(String)) : null;
      for (const a of visibleArticles(clientId)) {
        if (wanted && !wanted.has(a.id)) continue;
        const base = o.base === 'catalogue' ? round3(a.price) : resolveClientPrice(clientId, a.id, date);
        const to = round3(base * (1 + pct / 100));
        const cur = resolveClientPrice(clientId, a.id, date);
        if (to === cur) continue;
        const r = writePrice(clientId, a, to, date);
        if (r.changed) changes.push({ articleId: a.id, article: a.name, sageCode: a.sage_code, from: r.from, to });
      }
    } else if (mode === 'copy') {
      const src = clientRow(Number(o.sourceClientId));
      if (src.id === clientId) throw new BillingError('Choisissez un autre hôtel comme source.');
      const today = todayParis();
      const rows = db.prepare(`
        SELECT cp.article_id, cp.price FROM client_prices cp
        WHERE cp.client_id = ? AND cp.date_debut <= ? AND (cp.date_fin IS NULL OR cp.date_fin >= ?)
      `).all(src.id, today, today);
      for (const r of rows) {
        const a = db.prepare('SELECT id, name, sage_code, price FROM articles WHERE id = ?').get(r.article_id);
        if (!a) continue;
        const w = writePrice(clientId, a, r.price, date);
        if (w.changed) changes.push({ articleId: a.id, article: a.name, sageCode: a.sage_code, from: w.from, to: r.price });
      }
    } else if (mode === 'reset') {
      const ids = db.prepare('SELECT DISTINCT article_id FROM client_prices WHERE client_id = ? AND (date_fin IS NULL OR date_fin >= ?)').all(clientId, date).map(r => r.article_id);
      for (const id of ids) {
        const a = db.prepare('SELECT id, name, sage_code, price FROM articles WHERE id = ?').get(id);
        if (!a) continue;
        const d = dropPrice(clientId, a, date);
        if (d.changed) changes.push({ articleId: a.id, article: a.name, sageCode: a.sage_code, from: d.from, to: d.to });
      }
    } else {
      throw new BillingError('Opération inconnue.');
    }
    if (changes.length) {
      log('client_prices_bulk', {
        clientId, client: client.societe, mode, effective: date, count: changes.length,
        ...(mode === 'percent' ? { percent: Number(o.percent) } : {}),
        ...(mode === 'copy' ? { sourceClientId: Number(o.sourceClientId) } : {}),
        changes: changes.slice(0, 60).map(c => ({ sageCode: c.sageCode, from: c.from, to: c.to })),
      });
    }
  });
  return { applied: !!apply, effective: date, count: changes.length, changes };
}

// ---- import des tarifs depuis un CSV ----

const HEADER_ALIASES = {
  client: ['client', 'hotel', 'societe', 'etablissement'],
  article: ['code_sage', 'sage', 'code', 'article', 'reference', 'ref'],
  prix: ['prix', 'tarif', 'price', 'prix_ht', 'tarif_ht'],
  date: ['date_debut', 'date', 'debut', 'effet', 'date_effet', 'a_partir_du'],
};
function mapHeaders(headers) {
  const keyed = headers.map(h => ({ raw: h, k: norm(h).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') }));
  const out = {};
  for (const [field, names] of Object.entries(HEADER_ALIASES)) {
    const hit = names.map(n => keyed.find(h => h.k === n)).find(Boolean);
    if (hit) out[field] = hit.raw;
  }
  return out;
}

/**
 * Deux présentations de fichier :
 *  - en liste : [client], code_sage (ou code), prix, [date_debut] ; sans colonne client, `clientId` est requis ;
 *  - en grille (celle de l'export) : code_sage puis une colonne par hôtel. Une case vide est ignorée, une case égale
 *    au prix déjà applicable ne change rien, une case égale au prix catalogue retire le tarif négocié.
 * Les lignes sont rapprochées par nom d'hôtel / code Sage sans tenir compte des accents ni de la casse.
 */
function importPrices(csvText, { apply = false, clientId = null, defaultDate = null } = {}) {
  let parsed;
  try { parsed = parseCsv(String(csvText || '')); } catch (e) { throw new BillingError(`Fichier CSV illisible : ${e.message}`); }
  if (!parsed.rows.length) throw new BillingError('Le fichier ne contient aucune ligne de données.');
  const map = mapHeaders(parsed.headers);
  const clients = db.prepare('SELECT id, societe FROM clients').all();
  const clientByName = new Map(clients.map(c => [norm(c.societe), c]));
  const wideCols = !map.prix && map.article ? parsed.headers.filter(h => h !== map.article && clientByName.has(norm(h))) : [];
  const wide = wideCols.length > 0;
  if (!map.article || (!map.prix && !wide)) {
    throw new BillingError(`Colonnes « code_sage » et « prix » requises (ou une colonne par hôtel, comme dans l'export de la grille). Colonnes trouvées : ${parsed.headers.join(', ')}.`);
  }
  const fixedClient = !wide && clientId ? clientRow(Number(clientId)) : null;
  if (!wide && !map.client && !fixedClient) throw new BillingError('Ajoutez une colonne « client » ou choisissez l\'hôtel concerné avant l\'import.');
  const fallbackDate = parseDate(defaultDate, todayParis(), "Date d'effet");

  const articles = db.prepare('SELECT id, name, code, sage_code, price FROM articles').all();
  const bySage = new Map(articles.map(a => [norm(a.sage_code), a]));
  const byCode = new Map(articles.map(a => [norm(a.code), a]));

  const lines = [];
  const handle = (line, c, row, priceRaw) => {
    const rec = { line, client: c ? c.societe : '', article: '', from: null, to: null, effective: null, status: 'error', error: null };
    lines.push(rec);
    try {
      if (!c) throw new BillingError(`Hôtel inconnu : « ${row[map.client] || ''} ».`);
      const ref = norm(row[map.article]);
      const a = bySage.get(ref) || byCode.get(ref);
      if (!a) throw new BillingError(`Article inconnu : « ${row[map.article] || ''} ».`);
      rec.article = a.name;
      const to = parsePrice(priceRaw, 'Prix');
      const date = parseDate(map.date ? String(row[map.date] || '').trim() : '', fallbackDate, "Date d'effet");
      rec.to = to; rec.effective = date;
      rec.from = resolveClientPrice(c.id, a.id, date);
      if (wide && to === rec.from) { rec.status = 'same'; return; }
      if (wide && to === round3(a.price)) {                       // retour au catalogue
        const d = dropPrice(c.id, a, date);
        rec.status = d.changed ? 'ok' : 'same';
        if (d.changed) log('client_price_removed', { clientId: c.id, client: c.societe, articleId: a.id, article: a.name, sageCode: a.sage_code, from: d.from, to: d.to, effective: date, via: 'import' });
        return;
      }
      const w = writePrice(c.id, a, to, date);
      rec.status = w.changed ? 'ok' : 'same';
      if (w.changed) log('client_price_set', { clientId: c.id, client: c.societe, articleId: a.id, article: a.name, sageCode: a.sage_code, from: w.from, to, effective: date, via: 'import' });
    } catch (e) {
      if (!(e instanceof BillingError)) throw e;
      rec.error = e.message;
    }
  };
  transact(apply, () => {
    parsed.rows.forEach((row, idx) => {
      const line = idx + 2;
      if (wide) {
        for (const col of wideCols) if (String(row[col] ?? '').trim() !== '') handle(line, clientByName.get(norm(col)), row, row[col]);
      } else {
        handle(line, fixedClient || clientByName.get(norm(row[map.client])), row, row[map.prix]);
      }
    });
    return lines;
  });
  const n = (s) => lines.filter(l => l.status === s).length;
  return { applied: !!apply, format: wide ? 'grille' : 'liste', summary: { total: lines.length, changed: n('ok'), same: n('same'), errors: n('error') }, lines };
}

// ---- grille articles × hôtels ----

function priceMatrix() {
  const today = todayParis();
  const articles = db.prepare('SELECT id, name, code, sage_code AS sageCode, category, price FROM articles ORDER BY category, name COLLATE NOCASE').all();
  const clients = db.prepare('SELECT id, societe FROM clients ORDER BY societe COLLATE NOCASE').all();
  const rows = db.prepare('SELECT client_id, article_id, price, date_debut, date_fin FROM client_prices ORDER BY date_debut').all();
  const by = new Map();
  for (const r of rows) { const k = `${r.client_id}|${r.article_id}`; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  const assigned = new Map();
  for (const r of db.prepare('SELECT client_id, article_id FROM client_articles').all()) {
    if (!assigned.has(r.client_id)) assigned.set(r.client_id, new Set());
    assigned.get(r.client_id).add(r.article_id);
  }
  const cells = {};
  for (const [k, list] of by) {
    const [cid, aid] = k.split('|');
    const cur = activeAt(list, today);
    const next = list.find(r => r.date_debut > today);
    if (!cur && !next) continue;
    (cells[cid] ||= {})[aid] = { price: cur ? cur.price : null, since: cur ? cur.date_debut : null, upcoming: next ? { price: next.price, from: next.date_debut } : null };
  }
  return {
    today,
    articles: articles.map(a => ({ ...a, price: round3(a.price) })),
    clients: clients.map(c => ({ id: c.id, societe: c.societe, restricted: assigned.has(c.id), articleIds: assigned.has(c.id) ? [...assigned.get(c.id)] : null })),
    cells,
  };
}

const fr = (n) => String(n).replace('.', ',');
const csvCell = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** Grille tarifaire en CSV (séparateur « ; », virgule décimale : s'ouvre directement dans Excel en français). */
function matrixCsv() {
  const m = priceMatrix();
  const head = ['code_sage', 'article', 'catalogue', ...m.clients.map(c => c.societe)];
  const lines = [head.map(csvCell).join(';')];
  for (const a of m.articles) {
    const row = [a.sageCode, a.name, fr(a.price)];
    for (const c of m.clients) {
      const cell = m.cells[c.id]?.[a.id];
      const excluded = c.restricted && !c.articleIds.includes(a.id);
      row.push(excluded ? '' : fr(cell && cell.price != null ? cell.price : a.price));
    }
    lines.push(row.map(csvCell).join(';'));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---- réappliquer les tarifs aux BL non facturés ----

function repriceCandidates(clientId, from, articleIds) {
  const client = clientRow(clientId);
  const wanted = Array.isArray(articleIds) && articleIds.length ? new Set(articleIds.map(String)) : null;
  const orders = db.prepare(`
    SELECT o.id, o.ticket, o.status, COALESCE(NULLIF(substr(o.livraison_prevue, 1, 10), ''), substr(o.created_at, 1, 10)) AS refDate,
      EXISTS (SELECT 1 FROM native_invoice_orders no JOIN native_invoices ni ON ni.id = no.invoice_id
              WHERE no.order_id = o.id AND ni.kind = 'invoice' AND ni.status = 'draft') AS inDraft,
      (o.id IN (SELECT order_id FROM invoice_orders)
        OR EXISTS (SELECT 1 FROM native_invoice_orders no JOIN native_invoices ni ON ni.id = no.invoice_id
                   WHERE no.order_id = o.id AND ni.kind = 'invoice' AND ni.status = 'issued'
                     AND NOT EXISTS (SELECT 1 FROM native_invoices cn WHERE cn.credits_invoice_id = ni.id AND cn.status = 'issued' AND cn.is_full_credit = 1))) AS billed
    FROM orders o WHERE o.client_id = ? ORDER BY refDate, o.id
  `).all(clientId).filter(o => o.refDate >= from && !o.billed);
  const itemsStmt = db.prepare('SELECT id, service_id, name, price, qty, delivered_qty FROM order_items WHERE order_id = ?');
  const result = []; let skippedInDraft = 0;
  for (const o of orders) {
    const lines = [];
    for (const it of itemsStmt.all(o.id)) {
      if (wanted && !wanted.has(it.service_id)) continue;
      const target = resolveClientPrice(clientId, it.service_id, o.refDate);
      if (target == null || round3(target) === round3(it.price)) continue;
      lines.push({ itemId: it.id, name: it.name, from: round3(it.price), to: round3(target), qty: it.delivered_qty ?? it.qty });
    }
    if (!lines.length) continue;
    if (o.inDraft) { skippedInDraft += 1; continue; }
    const deltaCents = lines.reduce((s, l) => s + Math.round((l.to - l.from) * l.qty * 100), 0);
    result.push({ id: o.id, ticket: o.ticket, status: o.status, date: o.refDate, lines, deltaCents });
  }
  return { client, orders: result, skippedInDraft, deltaCents: result.reduce((s, o) => s + o.deltaCents, 0) };
}

/** Aperçu, ou application, du recalcul des BL non facturés à partir de `from` au tarif en vigueur à leur date. */
function repriceUnbilled(clientId, { from, articleIds } = {}, { apply = false } = {}) {
  const date = parseDate(from, null, 'Date de départ');
  if (!date) throw new BillingError('Indiquez la date à partir de laquelle recalculer les BL.');
  const r = repriceCandidates(clientId, date, articleIds);
  if (apply && r.orders.length) {
    db.transaction(() => {
      const upd = db.prepare('UPDATE order_items SET price = ? WHERE id = ?');
      for (const o of r.orders) for (const l of o.lines) upd.run(l.to, l.itemId);
      log('orders_repriced', { clientId, client: r.client.societe, from: date, orders: r.orders.length, lines: r.orders.reduce((s, o) => s + o.lines.length, 0), deltaCents: r.deltaCents });
    })();
  }
  return { applied: !!apply && r.orders.length > 0, from: date, skippedInDraft: r.skippedInDraft, deltaCents: r.deltaCents, orders: r.orders };
}

// ---- journal des prix ----

const PRICE_ACTIONS = ['article_price_changed', 'article_created', 'article_deleted', 'client_price_set', 'client_price_removed', 'client_prices_bulk', 'orders_repriced', 'client_catalog_set'];

function priceLog({ clientId, articleId, limit = 100 } = {}) {
  const sage = articleId ? db.prepare('SELECT sage_code FROM articles WHERE id = ?').get(articleId)?.sage_code : null;
  const rows = db.prepare(`SELECT id, at, action, detail_json FROM billing_events WHERE action IN (${PRICE_ACTIONS.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 2000`).all(...PRICE_ACTIONS);
  const out = [];
  for (const r of rows) {
    let d; try { d = JSON.parse(r.detail_json); } catch { d = {}; }
    if (clientId && d.clientId !== Number(clientId)) continue;
    if (articleId && d.articleId !== articleId && !(sage && (d.changes || []).some(c => c.sageCode === sage))) continue;
    out.push({ id: r.id, at: r.at, action: r.action, detail: d });
    if (out.length >= limit) break;
  }
  return { events: out };
}

module.exports = {
  billingIssues, round3,
  listArticles, getArticle, createArticle, updateArticle, deleteArticle, importArticles,
  listClients, getClient, createClient, updateClient, setAccessCode, deleteClient,
  createToken, revokeToken, setWebhook, importClients, setAssignment,
  priceGrid, setClientPrice, removeClientPrice, bulkPrices, importPrices, priceMatrix, matrixCsv,
  repriceUnbilled, priceLog,
};
