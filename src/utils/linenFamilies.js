// Familles de linge pour les statistiques : grand plat, petit plat, éponge, divers.
//
// Chaque article a une famille : celle choisie dans sa fiche (articles.linen_family) ou, à défaut, une famille PROPOSÉE
// d'après son nom (voir inferFamily). La proposition n'est qu'un point de départ — elle est signalée comme telle dans
// les statistiques et se corrige article par article dans Facturation → Articles.
//
// La répartition porte sur le linge LIVRÉ (commandes livrées, date du BL, quantité livrée si elle est connue, sinon
// commandée), le même périmètre que « Poids livré » : un chiffre ici ne peut donc pas contredire les bons de livraison.
// Les reprises (quantités négatives) ne sont pas comptées. Le poids vient de la fiche article (poids unitaire × quantité) :
// c'est un poids théorique, pas un poids pesé.

const db = require('../db');
const dailyStats = require('./dailyStats');

const FAMILIES = [
  { id: 'grand_plat', label: 'Grand plat' },
  { id: 'petit_plat', label: 'Petit plat' },
  { id: 'eponge', label: 'Éponge' },
  { id: 'divers', label: 'Divers' },
];
const IDS = new Set(FAMILIES.map(f => f.id));
const LABEL = Object.fromEntries(FAMILIES.map(f => [f.id, f.label]));

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Famille proposée d'après le nom (et la catégorie) de l'article. L'ordre des règles compte : « drap de bain » est de l'éponge, pas du grand plat. */
function inferFamily(name, category) {
  const n = norm(name);
  if (/eponge|serviette de toilette|serviette de bain|serviette de piscine|drap de bain|tapis de bain|peignoir|bain de soleil|\bgant\b|\bspa\b/.test(n)) return 'eponge';
  if (/\btaie|traversin|serviette de table|set de table|chemin de table|torchon/.test(n)) return 'petit_plat';
  if (/\bdrap\b|housse de couette|\bnappe|\balese|\balaise/.test(n)) return 'grand_plat';
  if (category === 'toilette') return 'eponge';
  return 'divers';
}

/** Valeur acceptée pour articles.linen_family : une des familles, ou null (= automatique). Lève une erreur sinon. */
function cleanFamily(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 'auto') return null;
  if (!IDS.has(v)) { const e = new Error('Famille de linge invalide.'); e.status = 400; throw e; }
  return v;
}

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (n, total) => (total > 0 ? round1((n / total) * 100) : 0);
const emptyFam = () => Object.fromEntries(FAMILIES.map(f => [f.id, { pieces: 0, weightKg: 0, refs: new Set() }]));

/** Répartition du linge livré dans la période p ({from, to}) : total, mois par mois, et articles rangés en « Divers » à vérifier. */
function breakdown(p) {
  const rows = db.prepare(`
    SELECT ${dailyStats.DELIVERY_DATE_SQL} AS date, oi.service_id AS serviceId, oi.name AS itemName,
           oi.qty AS qty, oi.delivered_qty AS delivered,
           a.name AS articleName, a.category AS category, a.linen_family AS explicit, COALESCE(a.weight_g, 0) AS weightG
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN articles a ON a.id = oi.service_id
    WHERE o.status = 'livree' AND ${dailyStats.DELIVERY_DATE_SQL} BETWEEN ? AND ?
  `).all(p.from, p.to);

  const total = emptyFam();
  const months = new Map();
  const divers = new Map();          // article → pièces rangées en Divers
  const inferred = new Set();        // articles livrés dont la famille est proposée (non choisie)
  const refs = new Set();
  let piecesNoWeight = 0;

  for (const r of rows) {
    const qty = r.delivered ?? r.qty;
    if (!(qty > 0)) continue;       // reprises et lignes à zéro : hors répartition
    const name = r.articleName || r.itemName;
    const fam = IDS.has(r.explicit) ? r.explicit : inferFamily(name, r.category);
    if (!IDS.has(r.explicit)) inferred.add(r.serviceId);
    const kg = (qty * r.weightG) / 1000;
    if (!r.weightG) piecesNoWeight += qty;
    refs.add(r.serviceId);

    const month = r.date.slice(0, 7);
    if (!months.has(month)) months.set(month, emptyFam());
    for (const t of [total, months.get(month)]) { t[fam].pieces += qty; t[fam].weightKg += kg; t[fam].refs.add(r.serviceId); }

    if (fam === 'divers') {
      const d = divers.get(r.serviceId) || { name, pieces: 0, weightKg: 0, explicit: IDS.has(r.explicit) };
      d.pieces += qty; d.weightKg += kg; divers.set(r.serviceId, d);
    }
  }

  const sum = (t, k) => FAMILIES.reduce((s, f) => s + t[f.id][k], 0);
  const totalPieces = sum(total, 'pieces');
  const totalKg = sum(total, 'weightKg');
  const shape = (t) => {
    const tp = sum(t, 'pieces'); const tk = sum(t, 'weightKg');
    return FAMILIES.map(f => ({
      id: f.id, label: f.label, pieces: t[f.id].pieces, weightKg: round1(t[f.id].weightKg),
      piecesPct: pct(t[f.id].pieces, tp), weightPct: pct(t[f.id].weightKg, tk), references: t[f.id].refs.size,
    }));
  };

  return {
    period: { from: p.from, to: p.to, days: p.days },
    families: shape(total),
    totalPieces, totalWeightKg: round1(totalKg), references: refs.size,
    months: [...months.keys()].sort().map(m => ({ month: m, totalPieces: sum(months.get(m), 'pieces'), totalWeightKg: round1(sum(months.get(m), 'weightKg')), families: shape(months.get(m)) })),
    diversArticles: [...divers.values()].sort((a, b) => b.pieces - a.pieces).slice(0, 8).map(d => ({ ...d, weightKg: round1(d.weightKg) })),
    inferredArticles: inferred.size,
    piecesNoWeight,
  };
}

module.exports = { FAMILIES, LABEL, inferFamily, cleanFamily, breakdown };
