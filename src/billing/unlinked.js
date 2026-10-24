// BL dont le nom de client a été saisi librement (aucune fiche hôtel liée).
//
// Une commande porte à la fois `client_id` (la fiche hôtel) et `societe` (un texte). Les anciennes
// commandes, ou celles issues d'un import, ont parfois seulement le texte : « HOTEL LES LAVANDES »,
// « Hôtel Lavandes SAS », « les lavandes »… Sans fiche liée, ces BL n'apparaissent sous aucun hôtel,
// ne sont jamais facturés par lot et ne reçoivent aucun tarif négocié.
//
// Ce module :
//  1. regroupe les commandes sans fiche par nom « normalisé » (casse, accents, ponctuation, SAS/SARL,
//     articles et pluriel ignorés) : toutes les écritures d'un même nom forment UN groupe ;
//  2. propose pour chaque groupe la ou les fiches existantes les plus proches (nom, téléphone, adresse) ;
//  3. rattache les groupes choisis à une fiche (existante, ou créée à partir du groupe), avec aperçu exact.
//
// Le texte `societe` de chaque commande n'est JAMAIS modifié : c'est ce qui figurait sur le BL à la
// livraison. Seul le lien `client_id` est posé, ce qui suffit pour la liste, la facturation et les tarifs.

const db = require('../db');
const engine = require('./engine');
const catalog = require('./catalog');

const { BillingError } = engine;

const MAX_ITEMS = 300;
const MAX_LIST = 1000;   // commandes détaillées par groupe
const MAX_JOURNAL = 200; // tickets conservés dans le journal pour chaque rattachement

// ---------- normalisation ----------

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' et ').replace(/[^a-z0-9]+/g, ' ').trim();

const LEGAL = new Set(['sas', 'sarl', 'eurl', 'sasu', 'sa', 'sci', 'snc', 'ets', 'etablissements', 'ste', 'societe', 'cie', 'et', 'ei', 'sasu']);
const ARTICLES = new Set(['le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'au', 'aux', 'a', 'en', 'chez']);
// Mots qui décrivent le TYPE d'établissement : trop courants pour prouver à eux seuls qu'il s'agit du même hôtel.
// Abréviations courantes, ramenées au mot entier (« Rés. Mont Ventoux » = « Résidence du Mont Ventoux »).
const ALIASES = { res: 'residence', resid: 'residence', htl: 'hotel', appt: 'appartement' };
const GENERIC = new Set(['hotel', 'residence', 'resort', 'spa', 'auberge', 'maison', 'gite', 'domaine', 'mas', 'bastide', 'hostellerie', 'logis', 'chambres', 'dhotes', 'camping', 'villa', 'chateau', 'relais', 'appart', 'appartement', 'hebergement', 'restaurant']);

/** Mots significatifs d'un nom : sans forme juridique, sans article, au singulier. */
function tokensOf(name) {
  // « S.A.S. » → « SAS » avant de découper, sinon « s a s » donnerait trois mots.
  const dotted = String(name ?? '').replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ''));
  return plain(dotted).split(' ')
    .filter(t => t && !LEGAL.has(t) && !ARTICLES.has(t))
    .map(t => ALIASES[t] || t)
    .map(t => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}
const keyOf = (name) => tokensOf(name).join(' ');

function bigrams(s) {
  const t = ` ${s} `; const out = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}
/** Coefficient de Dice sur les paires de lettres : tolère une faute de frappe (« Lavande » / « Lavandes »). */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a); const B = bigrams(b); let inter = 0; let sa = 0; let sb = 0;
  for (const [g, n] of A) { sa += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
  for (const n of B.values()) sb += n;
  return sa + sb ? (2 * inter) / (sa + sb) : 0;
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');
const phoneKey = (s) => { const d = digits(s); return d.length >= 9 ? d.slice(-9) : ''; };
const addressKey = (s) => plain(s).replace(/\b(avenue|av|boulevard|bd|chemin|route|rue|impasse|place|allee|cours|quartier|lieu dit)\b/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- proposition de fiche ----------

/** Note de ressemblance (0 à 1) entre un groupe de BL et une fiche hôtel, avec ses raisons. */
function scoreClient(group, client) {
  const why = []; let score = 0;
  const ck = keyOf(client.societe);
  if (group.key && ck && group.key === ck) { score = 1; why.push('même nom, écrit autrement'); }
  else {
    const gt = tokensOf(group.name); const ct = tokensOf(client.societe);
    const distinct = (arr) => arr.filter(t => !GENERIC.has(t));
    const gd = distinct(gt); const cd = distinct(ct);
    if (gd.length && cd.length) {
      const common = gd.filter(t => cd.includes(t) || cd.some(x => x.length >= 5 && dice(t, x) >= 0.85)).length;
      const union = new Set([...gd, ...cd]).size;
      const jac = common / union;
      const sim = Math.max(jac, dice(gd.join(' '), cd.join(' ')) * 0.9);
      if (sim >= 0.6) {
        score = Math.min(0.9, sim); why.push(jac >= 0.99 ? 'mêmes mots importants dans le nom' : 'nom très proche');
        // « Auberge Cézanne » n'est pas sûrement « Hôtel Cézanne » : un type d'établissement différent ou absent ne permet jamais « sûr ».
        const gg = gt.filter(t => GENERIC.has(t)); const cg = ct.filter(t => GENERIC.has(t));
        if (gg.length && cg.length && !gg.some(t => cg.includes(t))) { score = Math.min(score, 0.75); why.push('type d\'établissement différent'); }
        else if (!gg.length !== !cg.length) score = Math.min(score, 0.85);
      }
    }
  }
  const gp = phoneKey(group.tel); const cp = phoneKey(client.tel);
  if (gp && cp && gp === cp) { score = Math.min(1, score + (score ? 0.35 : 0.6)); why.push('même téléphone'); }
  const ga = addressKey(group.adresse); const ca = addressKey(client.adresse);
  if (ga.length >= 8 && ca.length >= 8 && (ga === ca || ga.includes(ca) || ca.includes(ga))) { score = Math.min(1, score + (score ? 0.25 : 0.45)); why.push('même adresse'); }
  return { score: Math.round(score * 100) / 100, why };
}

// ---------- lecture ----------

function orphanOrders() {
  const orders = db.prepare(`
    SELECT o.id, o.ticket, o.societe, o.contact, o.tel, o.adresse, o.status, o.created_at AS createdAt,
           COALESCE(NULLIF(substr(o.livraison_prevue, 1, 10), ''), substr(o.created_at, 1, 10)) AS date,
           (o.id IN (SELECT order_id FROM invoice_orders)
            OR EXISTS (SELECT 1 FROM native_invoice_orders no JOIN native_invoices ni ON ni.id = no.invoice_id WHERE no.order_id = o.id AND ni.kind = 'invoice')) AS billed
    FROM orders o WHERE o.client_id IS NULL ORDER BY date DESC, o.id DESC
  `).all();
  const ht = new Map();
  for (const it of db.prepare('SELECT oi.order_id AS id, oi.qty, oi.delivered_qty AS d, oi.price FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.client_id IS NULL').all()) {
    ht.set(it.id, (ht.get(it.id) || 0) + engine.lineCents(it.d ?? it.qty, it.price));
  }
  return orders.map(o => ({ ...o, htCents: ht.get(o.id) || 0 }));
}

/** Groupes de commandes sans fiche hôtel, du plus important au plus petit, avec les fiches proposées. */
function listGroups() {
  const clients = db.prepare('SELECT id, societe, tel, adresse, ville, contact FROM clients ORDER BY societe COLLATE NOCASE').all();
  const byKey = new Map();
  for (const o of orphanOrders()) {
    const key = keyOf(o.societe) || `__sans-nom-${plain(o.societe) || 'vide'}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(o);
  }
  const groups = [];
  for (const [key, orders] of byKey) {
    const variants = new Map();
    for (const o of orders) variants.set(o.societe.trim(), (variants.get(o.societe.trim()) || 0) + 1);
    const sorted = [...variants].sort((a, b) => b[1] - a[1]);
    const latest = orders[0];   // déjà trié du plus récent au plus ancien
    const delivered = orders.filter(o => o.status === 'livree');
    const toInvoice = delivered.filter(o => !o.billed);
    const g = {
      key, name: sorted[0][0] || '(sans nom)', variants: sorted.map(([name, count]) => ({ name: name || '(sans nom)', orders: count })),
      orders: orders.length, delivered: delivered.length, toInvoice: toInvoice.length, toInvoiceHtCents: toInvoice.reduce((s, o) => s + o.htCents, 0),
      firstDate: orders[orders.length - 1].date, lastDate: latest.date,
      contact: latest.contact || '', tel: latest.tel || '', adresse: latest.adresse || '',
      // Chaque commande du groupe, pour pouvoir tout vérifier (et en exclure une) avant de rattacher.
      orderList: orders.slice(0, MAX_LIST).map(o => ({ id: o.id, ticket: o.ticket, name: o.societe.trim() || '(sans nom)', adresse: o.adresse || '', tel: o.tel || '', status: o.status, date: o.date, htCents: o.htCents, billed: !!o.billed })),
      truncated: orders.length > MAX_LIST,
    };
    const named = !key.startsWith('__');
    g.suggestions = named ? clients.map(c => ({ c, ...scoreClient(g, c) })).filter(x => x.score >= 0.55)
      .sort((a, b) => b.score - a.score).slice(0, 3)
      .map(x => ({ clientId: x.c.id, societe: x.c.societe, place: [x.c.ville, x.c.adresse].find(v => v && v.trim()) || '', score: x.score, why: x.why, confidence: x.score >= 0.9 ? 'high' : x.score >= 0.7 ? 'medium' : 'low' })) : [];
    // Une proposition n'est « sûre » que si elle est nettement meilleure que la suivante.
    // Si plusieurs fiches se valent (doublon d'hôtel), aucune n'est « sûre » : c'est à l'utilisateur de choisir.
    if (g.suggestions.length > 1 && g.suggestions[1].score > g.suggestions[0].score - 0.15) {
      for (const sg of g.suggestions) if (sg.score > g.suggestions[0].score - 0.15 && sg.confidence === 'high') sg.confidence = 'medium';
    }
    groups.push(g);
  }
  groups.sort((a, b) => b.toInvoice - a.toInvoice || b.orders - a.orders || a.name.localeCompare(b.name, 'fr'));
  return { groups, orders: groups.reduce((s, g) => s + g.orders, 0), toInvoice: groups.reduce((s, g) => s + g.toInvoice, 0), toInvoiceHtCents: groups.reduce((s, g) => s + g.toInvoiceHtCents, 0) };
}

/** Nombre de commandes sans fiche (pour la pastille de la page Bons de livraison). */
function count() {
  const r = db.prepare("SELECT COUNT(*) n, SUM(status = 'livree') delivered FROM orders WHERE client_id IS NULL").get();
  return { orders: r.n || 0, delivered: r.delivered || 0 };
}

// ---------- rattachement ----------

class Rollback extends Error { constructor(result) { super('rollback'); this.result = result; } }

/**
 * Rattache des groupes à des fiches hôtel.
 *  items : [{ key, clientId }  ou  { key, create: true }]  (create = nouvelle fiche à partir des coordonnées du groupe)
 *  opts  : { apply, reprice }  — sans apply, tout est exécuté puis ANNULÉ : l'aperçu est exact, rien n'est écrit.
 *  reprice : recalcule aussi les BL non facturés au tarif négocié de l'hôtel (jamais ceux déjà facturés).
 */
function link(items, { apply = false, reprice = false } = {}) {
  if (!Array.isArray(items) || !items.length) throw new BillingError('Choisissez au moins un groupe à rattacher.');
  if (items.length > MAX_ITEMS) throw new BillingError(`${MAX_ITEMS} groupes au plus par opération.`);
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it.key !== 'string' || !it.key) throw new BillingError('Groupe invalide.');
    if (seen.has(it.key)) throw new BillingError('Un même groupe est choisi deux fois.');
    seen.add(it.key);
    if (!it.create && !Number.isInteger(Number(it.clientId))) throw new BillingError('Choisissez un hôtel pour chaque groupe retenu.');
  }

  const run = db.transaction(() => {
    const current = new Map(listGroups().groups.map(g => [g.key, g]));
    const orderRows = orphanOrders();
    const results = []; const touched = new Map();   // clientId → date la plus ancienne rattachée
    for (const it of items) {
      const g = current.get(it.key);
      if (!g) throw new BillingError('Un des groupes n\'existe plus (déjà rattaché ?). Rechargez la liste.');
      let client;
      if (it.create) {
        client = catalog.createClient({ societe: g.name, contact: g.contact, tel: g.tel, adresse: g.adresse }).client;
      } else {
        client = db.prepare('SELECT id, societe FROM clients WHERE id = ?').get(Number(it.clientId));
        if (!client) throw new BillingError('Hôtel introuvable.', 404);
      }
      if (!client || !Number.isInteger(client.id)) throw new BillingError('Fiche hôtel introuvable ou non créée : rien n\'a été rattaché.');
      const inGroup = orderRows.filter(o => (keyOf(o.societe) || `__sans-nom-${plain(o.societe) || 'vide'}`) === it.key);
      let chosen = inGroup;
      if (it.orderIds !== undefined) {
        // Sous-ensemble choisi à la main : chaque commande doit encore faire partie du groupe, sinon on s'arrête.
        if (!Array.isArray(it.orderIds)) throw new BillingError('Liste de commandes invalide.');
        const want = [...new Set(it.orderIds.map(Number))];
        const byId = new Map(inGroup.map(o => [o.id, o]));
        if (want.some(x => !byId.has(x))) throw new BillingError('Une des commandes ne fait plus partie de ce groupe. Rechargez la liste.');
        if (!want.length) throw new BillingError(`Aucune commande retenue pour « ${g.name} » : décochez le groupe ou cochez au moins un BL.`);
        chosen = want.map(x => byId.get(x));
      }
      const ids = chosen.map(o => o.id);
      const upd = db.prepare(`UPDATE orders SET client_id = ? WHERE client_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(client.id, ...ids);
      engine.logEvent('orders_linked', null, {
        clientId: client.id, client: client.societe, created: !!it.create, orders: upd.changes, delivered: chosen.filter(o => o.status === 'livree').length,
        names: [...new Set(chosen.map(o => o.societe.trim() || '(sans nom)'))].slice(0, 8),
        tickets: chosen.slice(0, MAX_JOURNAL).map(o => o.ticket), ticketsTruncated: chosen.length > MAX_JOURNAL,
      });
      results.push({
        key: it.key, name: g.name, clientId: client.id, client: client.societe, created: !!it.create, orders: upd.changes,
        delivered: chosen.filter(o => o.status === 'livree').length, toInvoice: chosen.filter(o => o.status === 'livree' && !o.billed).length,
        left: inGroup.length - chosen.length,   // commandes du groupe laissées de côté (restent à rattacher plus tard)
        list: chosen.map(o => ({ id: o.id, ticket: o.ticket, name: o.societe.trim() || '(sans nom)', date: o.date, status: o.status, htCents: o.htCents })),
      });
      const prev = touched.get(client.id);
      if (!prev || g.firstDate < prev) touched.set(client.id, g.firstDate);
    }
    const repriced = { orders: 0, lines: 0, deltaCents: 0, skippedInDraft: 0, detail: [] };
    if (reprice) {
      for (const [clientId, from] of touched) {
        const r = catalog.repriceUnbilled(clientId, { from }, { apply: true });
        repriced.orders += r.orders.length; repriced.lines += r.orders.reduce((s, o) => s + o.lines.length, 0);
        repriced.deltaCents += r.deltaCents; repriced.skippedInDraft += r.skippedInDraft;
        for (const o of r.orders) repriced.detail.push({ ticket: o.ticket, clientId, deltaCents: o.deltaCents, lines: o.lines.map(l => ({ name: l.name, from: l.from, to: l.to, qty: l.qty })) });
      }
    }
    const out = { applied: !!apply, groups: results.length, orders: results.reduce((s, r) => s + r.orders, 0), results, repriced, remaining: count() };
    if (!apply) throw new Rollback(out);
    return out;
  });
  try { return run.immediate(); } catch (e) { if (e instanceof Rollback) return e.result; throw e; }
}

module.exports = { listGroups, count, link, keyOf, tokensOf, scoreClient, dice };
