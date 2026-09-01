const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { CATEGORIES } = require('../services');
const { parseCsv } = require('../utils/csv');

const router = express.Router();
router.use(requireAdmin);
// Stockage en mémoire EXPLICITE (buffer), pas seulement le comportement
// par défaut de multer 1.x sans storage précisé — ce comportement par
// défaut a changé entre versions majeures de multer (buffer devient
// undefined sans memoryStorage() explicite sur certaines versions plus
// récentes), mieux vaut ne pas en dépendre implicitement.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5 Mo, largement suffisant pour un CSV

function slugify(text) {
  return text.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire les accents
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const ARTICLE_SELECT = 'SELECT id, name, code, sage_code as sageCode, price, category, weight_g as weightG, volume_l as volumeL, gsm, width_cm as widthCm, length_cm as lengthCm, folded_width_cm as foldedWidthCm, folded_length_cm as foldedLengthCm, folded_height_cm as foldedHeightCm FROM articles';

// weight_g = (largeur × longueur à plat, en m²) × gsm (g/m²).
// volume_l = (largeur × longueur × hauteur pliées, en cm³) / 1000.
// Centralisé ici : utilisé à la fois par la création manuelle et l'import
// CSV, pour ne jamais laisser les deux formules diverger.
function computeWeightAndVolume({ widthCm, lengthCm, foldedWidthCm, foldedLengthCm, foldedHeightCm, gsm }) {
  const areaM2 = (widthCm * lengthCm) / 10000;
  const weightG = Math.round(areaM2 * gsm);
  const volumeL = Math.round(((foldedWidthCm * foldedLengthCm * foldedHeightCm) / 1000) * 100) / 100;
  return { weightG, volumeL };
}

// GET /api/admin/articles — catalogue complet, pour l'écran de gestion.
router.get('/', (req, res) => {
  const rows = db.prepare(`${ARTICLE_SELECT} ORDER BY category, name`).all();
  res.json({ articles: rows, categories: CATEGORIES });
});

// POST /api/admin/articles — créer un nouvel article.
router.post('/', (req, res) => {
  const { name, code, sageCode, price, category, gsm, widthCm, lengthCm, foldedWidthCm, foldedLengthCm, foldedHeightCm } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Le nom de l'article est requis." });
  if (!code || !code.trim()) return res.status(400).json({ error: 'Le code (badge) est requis.' });
  if (!sageCode || !sageCode.trim()) return res.status(400).json({ error: 'Le code Sage est requis.' });
  const priceNum = parseFloat(price);
  if (!Number.isFinite(priceNum) || priceNum < 0) return res.status(400).json({ error: 'Prix invalide.' });
  if (!CATEGORIES.some(c => c.id === category)) return res.status(400).json({ error: 'Catégorie invalide.' });
  const gsmNum = gsm !== undefined ? parseFloat(gsm) : 0;
  const widthNum = widthCm !== undefined ? parseFloat(widthCm) : 0;
  const lengthNum = lengthCm !== undefined ? parseFloat(lengthCm) : 0;
  const foldedWidthNum = foldedWidthCm !== undefined ? parseFloat(foldedWidthCm) : 0;
  const foldedLengthNum = foldedLengthCm !== undefined ? parseFloat(foldedLengthCm) : 0;
  const foldedHeightNum = foldedHeightCm !== undefined ? parseFloat(foldedHeightCm) : 0;
  if (!Number.isFinite(gsmNum) || gsmNum < 0) return res.status(400).json({ error: 'Densité (GSM) invalide.' });
  if (!Number.isFinite(widthNum) || widthNum < 0) return res.status(400).json({ error: 'Largeur invalide.' });
  if (!Number.isFinite(lengthNum) || lengthNum < 0) return res.status(400).json({ error: 'Longueur invalide.' });
  if (!Number.isFinite(foldedWidthNum) || foldedWidthNum < 0) return res.status(400).json({ error: 'Largeur pliée invalide.' });
  if (!Number.isFinite(foldedLengthNum) || foldedLengthNum < 0) return res.status(400).json({ error: 'Longueur pliée invalide.' });
  if (!Number.isFinite(foldedHeightNum) || foldedHeightNum < 0) return res.status(400).json({ error: 'Épaisseur pliée invalide.' });
  const { weightG: weightNum, volumeL: volumeNum } = computeWeightAndVolume({
    widthCm: widthNum, lengthCm: lengthNum,
    foldedWidthCm: foldedWidthNum, foldedLengthCm: foldedLengthNum, foldedHeightCm: foldedHeightNum,
    gsm: gsmNum,
  });

  let id = slugify(name);
  if (!id) return res.status(400).json({ error: 'Nom invalide pour générer un identifiant.' });
  // Garantit un id unique si un article du même nom existe déjà.
  let suffix = 2;
  const exists = id0 => db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id0);
  while (exists(id)) { id = `${slugify(name)}_${suffix}`; suffix += 1; }

  db.prepare(`
    INSERT INTO articles (id, name, code, sage_code, price, category, weight_g, volume_l, gsm, width_cm, length_cm, folded_width_cm, folded_length_cm, folded_height_cm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), code.trim(), sageCode.trim(), priceNum, category, weightNum, volumeNum, gsmNum, widthNum, lengthNum, foldedWidthNum, foldedLengthNum, foldedHeightNum);

  const row = db.prepare(`${ARTICLE_SELECT} WHERE id = ?`).get(id);
  res.status(201).json({ article: row });
});

// PUT /api/admin/articles/:id — modifier un article existant.
router.put('/:id', (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Article introuvable.' });

  const { name, code, sageCode, price, category, gsm, widthCm, lengthCm, foldedWidthCm, foldedLengthCm, foldedHeightCm } = req.body || {};
  const priceNum = price !== undefined ? parseFloat(price) : existing.price;
  if (!Number.isFinite(priceNum) || priceNum < 0) return res.status(400).json({ error: 'Prix invalide.' });
  if (category !== undefined && !CATEGORIES.some(c => c.id === category)) {
    return res.status(400).json({ error: 'Catégorie invalide.' });
  }
  const widthNum = widthCm !== undefined ? parseFloat(widthCm) : existing.width_cm;
  const lengthNum = lengthCm !== undefined ? parseFloat(lengthCm) : existing.length_cm;
  const foldedWidthNum = foldedWidthCm !== undefined ? parseFloat(foldedWidthCm) : existing.folded_width_cm;
  const foldedLengthNum = foldedLengthCm !== undefined ? parseFloat(foldedLengthCm) : existing.folded_length_cm;
  const foldedHeightNum = foldedHeightCm !== undefined ? parseFloat(foldedHeightCm) : existing.folded_height_cm;

  // gsm absent de la requête : reprend la valeur déjà connue si elle
  // existe, sinon la RÉTRO-CALCULE depuis le poids déjà enregistré (cas
  // d'un article créé avant l'ajout de ce champ) — pour ne jamais faire
  // retomber le poids à zéro simplement parce qu'aucun gsm n'a été
  // explicitement fourni sur cette modification précise.
  let gsmNum;
  if (gsm !== undefined) {
    gsmNum = parseFloat(gsm);
  } else if (existing.gsm > 0) {
    gsmNum = existing.gsm;
  } else if (existing.weight_g > 0 && existing.width_cm > 0 && existing.length_cm > 0) {
    gsmNum = existing.weight_g / ((existing.width_cm * existing.length_cm) / 10000);
  } else {
    gsmNum = 0;
  }
  if (!Number.isFinite(gsmNum) || gsmNum < 0) return res.status(400).json({ error: 'Densité (GSM) invalide.' });
  if (!Number.isFinite(widthNum) || widthNum < 0) return res.status(400).json({ error: 'Largeur invalide.' });
  if (!Number.isFinite(lengthNum) || lengthNum < 0) return res.status(400).json({ error: 'Longueur invalide.' });
  if (!Number.isFinite(foldedWidthNum) || foldedWidthNum < 0) return res.status(400).json({ error: 'Largeur pliée invalide.' });
  if (!Number.isFinite(foldedLengthNum) || foldedLengthNum < 0) return res.status(400).json({ error: 'Longueur pliée invalide.' });
  if (!Number.isFinite(foldedHeightNum) || foldedHeightNum < 0) return res.status(400).json({ error: 'Épaisseur pliée invalide.' });
  const { weightG: weightNum, volumeL: volumeNum } = computeWeightAndVolume({
    widthCm: widthNum, lengthCm: lengthNum,
    foldedWidthCm: foldedWidthNum, foldedLengthCm: foldedLengthNum, foldedHeightCm: foldedHeightNum,
    gsm: gsmNum,
  });

  db.prepare(`
    UPDATE articles SET name = ?, code = ?, sage_code = ?, price = ?, category = ?, weight_g = ?, volume_l = ?, gsm = ?, width_cm = ?, length_cm = ?, folded_width_cm = ?, folded_length_cm = ?, folded_height_cm = ? WHERE id = ?
  `).run(
    (name ?? existing.name).trim(),
    (code ?? existing.code).trim(),
    (sageCode ?? existing.sage_code).trim(),
    priceNum,
    category ?? existing.category,
    weightNum,
    volumeNum,
    gsmNum,
    widthNum,
    lengthNum,
    foldedWidthNum,
    foldedLengthNum,
    foldedHeightNum,
    id
  );

  const row = db.prepare(`${ARTICLE_SELECT} WHERE id = ?`).get(id);
  res.json({ article: row });
});

// DELETE /api/admin/articles/:id — retirer un article du catalogue.
// Les commandes déjà passées ne sont pas affectées : order_items garde
// sa propre copie (nom, code, prix) indépendamment de cette suppression.
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- attribution des articles par hôtel ----------

// GET /api/admin/articles/client/:clientId — articles actuellement
// attribués à cet hôtel (liste vide = catalogue complet par défaut).
router.get('/client/:clientId', (req, res) => {
  const rows = db.prepare(`
    SELECT article_id as articleId FROM client_articles WHERE client_id = ?
  `).all(Number(req.params.clientId));
  res.json({ articleIds: rows.map(r => r.articleId) });
});

// PUT /api/admin/articles/client/:clientId — définit la liste complète
// des articles attribués (remplace, ne cumule pas). Liste vide = retour
// au comportement par défaut (catalogue complet visible).
router.put('/client/:clientId', (req, res) => {
  const clientId = Number(req.params.clientId);
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
  if (!client) return res.status(404).json({ error: 'Hôtel introuvable.' });

  const { articleIds } = req.body || {};
  if (!Array.isArray(articleIds)) return res.status(400).json({ error: 'articleIds doit être une liste.' });

  const setAssignment = db.transaction(() => {
    db.prepare('DELETE FROM client_articles WHERE client_id = ?').run(clientId);
    const insert = db.prepare('INSERT OR IGNORE INTO client_articles (client_id, article_id) VALUES (?, ?)');
    for (const articleId of articleIds) insert.run(clientId, articleId);
  });
  setAssignment();
  res.json({ ok: true });
});

// ---------- capacité camion + poids chariot (réglages simples) ----------

// GET /api/admin/articles/logistics-settings
router.get('/logistics-settings', (req, res) => {
  const row = db.prepare('SELECT truck_capacity_kg as truckCapacityKg, cart_weight_kg as cartWeightKg, avg_speed_kmh as avgSpeedKmh, minutes_per_stop as minutesPerStop, max_cart_weight_kg as maxCartWeightKg, prioritize_grouping as prioritizeGrouping FROM admin WHERE id = 1').get();
  res.json(row || { truckCapacityKg: 1200, cartWeightKg: 20, avgSpeedKmh: 40, minutesPerStop: 20, maxCartWeightKg: 120, prioritizeGrouping: 1 });
});

// PUT /api/admin/articles/logistics-settings
router.put('/logistics-settings', (req, res) => {
  const { truckCapacityKg, cartWeightKg, avgSpeedKmh, minutesPerStop, maxCartWeightKg, prioritizeGrouping } = req.body || {};
  const truck = parseFloat(truckCapacityKg);
  const cartWeight = parseFloat(cartWeightKg);
  const avgSpeed = parseFloat(avgSpeedKmh);
  const perStop = parseFloat(minutesPerStop);
  const maxCartWeight = parseFloat(maxCartWeightKg);
  if (!Number.isFinite(truck) || truck <= 0) return res.status(400).json({ error: 'Capacité de camion invalide.' });
  if (!Number.isFinite(cartWeight) || cartWeight < 0) return res.status(400).json({ error: 'Poids de chariot invalide.' });
  if (!Number.isFinite(avgSpeed) || avgSpeed <= 0) return res.status(400).json({ error: 'Vitesse moyenne invalide.' });
  if (!Number.isFinite(perStop) || perStop < 0) return res.status(400).json({ error: 'Temps par arrêt invalide.' });
  if (!Number.isFinite(maxCartWeight) || maxCartWeight <= 0) return res.status(400).json({ error: 'Poids maximum par chariot invalide.' });
  db.prepare('UPDATE admin SET truck_capacity_kg = ?, cart_weight_kg = ?, avg_speed_kmh = ?, minutes_per_stop = ?, max_cart_weight_kg = ?, prioritize_grouping = ? WHERE id = 1')
    .run(truck, cartWeight, avgSpeed, perStop, maxCartWeight, prioritizeGrouping ? 1 : 0);
  res.json({ ok: true });
});

// ---------- types de chariots ----------

function serializeCartType(row) {
  return {
    id: row.id,
    name: row.name,
    lengthCm: row.length_cm,
    widthCm: row.width_cm,
    heightCm: row.height_cm,
    volumeL: Math.round((row.length_cm * row.width_cm * row.height_cm / 1000) * 10) / 10,
  };
}

// GET /api/admin/articles/cart-types
router.get('/cart-types', (req, res) => {
  const rows = db.prepare('SELECT * FROM cart_types ORDER BY length_cm * width_cm * height_cm DESC').all();
  res.json({ cartTypes: rows.map(serializeCartType) });
});

// POST /api/admin/articles/cart-types
router.post('/cart-types', (req, res) => {
  const { name, lengthCm, widthCm, heightCm } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du chariot est requis.' });
  const l = parseFloat(lengthCm), w = parseFloat(widthCm), h = parseFloat(heightCm);
  if (![l, w, h].every(n => Number.isFinite(n) && n > 0)) {
    return res.status(400).json({ error: 'Longueur, largeur et hauteur doivent être des nombres positifs (en cm).' });
  }
  const info = db.prepare('INSERT INTO cart_types (name, length_cm, width_cm, height_cm) VALUES (?, ?, ?, ?)').run(name.trim(), l, w, h);
  const row = db.prepare('SELECT * FROM cart_types WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ cartType: serializeCartType(row) });
});

// DELETE /api/admin/articles/cart-types/:id
router.delete('/cart-types/:id', (req, res) => {
  db.prepare('DELETE FROM cart_types WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- types de camions ----------

function serializeTruckType(row) {
  return {
    id: row.id,
    name: row.name,
    lengthCm: row.length_cm,
    widthCm: row.width_cm,
    heightCm: row.height_cm,
    volumeL: Math.round((row.length_cm * row.width_cm * row.height_cm / 1000) * 10) / 10,
  };
}

// GET /api/admin/articles/truck-types
router.get('/truck-types', (req, res) => {
  const rows = db.prepare('SELECT * FROM truck_types ORDER BY length_cm * width_cm * height_cm DESC').all();
  res.json({ truckTypes: rows.map(serializeTruckType) });
});

// POST /api/admin/articles/truck-types
router.post('/truck-types', (req, res) => {
  const { name, lengthCm, widthCm, heightCm } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du véhicule est requis.' });
  const l = parseFloat(lengthCm), w = parseFloat(widthCm), h = parseFloat(heightCm);
  if (![l, w, h].every(n => Number.isFinite(n) && n > 0)) {
    return res.status(400).json({ error: 'Longueur, largeur et hauteur doivent être des nombres positifs (en cm).' });
  }
  const info = db.prepare('INSERT INTO truck_types (name, length_cm, width_cm, height_cm) VALUES (?, ?, ?, ?)').run(name.trim(), l, w, h);
  const row = db.prepare('SELECT * FROM truck_types WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ truckType: serializeTruckType(row) });
});

// DELETE /api/admin/articles/truck-types/:id
router.delete('/truck-types/:id', (req, res) => {
  db.prepare('DELETE FROM truck_types WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// POST /api/admin/articles/import — import en masse depuis un fichier
// CSV. Colonnes attendues (première ligne = en-têtes) : nom, code,
// code_sage sont OBLIGATOIRES ; prix, categorie, densite_gsm, largeur_cm,
// longueur_cm, largeur_pliee_cm, longueur_pliee_cm, epaisseur_pliee_cm
// sont optionnelles (défaut 0, ou 'lit' pour categorie). Poids et volume
// ne sont PAS des colonnes du fichier — calculés automatiquement depuis
// les dimensions et la densité (voir computeWeightAndVolume). Si
// code_sage correspond à un article déjà existant, ses valeurs sont
// MISES À JOUR plutôt que de créer un doublon — permet de réimporter un
// fichier corrigé sans casser les identifiants existants ni dupliquer.
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu (champ "file" attendu).' });

  let parsed;
  try {
    parsed = parseCsv(req.file.buffer.toString('utf-8'));
  } catch (err) {
    return res.status(400).json({ error: `Fichier CSV illisible : ${err.message}` });
  }
  if (parsed.rows.length === 0) {
    return res.status(400).json({ error: 'Le fichier ne contient aucune ligne de données (juste un en-tête, ou vide).' });
  }
  const requiredCols = ['nom', 'code', 'code_sage'];
  const missingCols = requiredCols.filter(c => !parsed.headers.includes(c));
  if (missingCols.length > 0) {
    return res.status(400).json({ error: `Colonne(s) obligatoire(s) manquante(s) dans l'en-tête : ${missingCols.join(', ')}. Colonnes trouvées : ${parsed.headers.join(', ')}.` });
  }

  const findBySageCode = db.prepare('SELECT id FROM articles WHERE sage_code = ?');
  const findById = db.prepare('SELECT 1 FROM articles WHERE id = ?');
  // Détecte les doublons PROBABLES entre le fichier et la base : même nom
  // (normalisé), mais code_sage différent — signale ce cas plutôt que de
  // créer silencieusement un second article pour ce qui est peut-être la
  // même référence saisie avec un code Sage différent (faute de frappe,
  // ou deux saisies à des moments différents).
  const findByNormalizedName = db.prepare("SELECT sage_code FROM articles WHERE LOWER(TRIM(name)) = ?");
  const findCurrentBySageCode = db.prepare('SELECT gsm, weight_g, width_cm, length_cm FROM articles WHERE sage_code = ?');
  const insertArticle = db.prepare(`
    INSERT INTO articles (id, name, code, sage_code, price, category, weight_g, volume_l, gsm, width_cm, length_cm, folded_width_cm, folded_length_cm, folded_height_cm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateArticle = db.prepare(`
    UPDATE articles SET name=?, code=?, price=?, category=?, weight_g=?, volume_l=?, gsm=?, width_cm=?, length_cm=?, folded_width_cm=?, folded_length_cm=?, folded_height_cm=?
    WHERE sage_code=?
  `);

  const results = { created: [], updated: [], duplicates: [], possibleDuplicates: [], errors: [] };
  // Suit les code_sage déjà rencontrés DANS ce fichier — première
  // occurrence traitée normalement (création ou mise à jour), toute
  // occurrence suivante avec le même code_sage est un doublon interne au
  // fichier, ignorée et signalée distinctement plutôt que silencieusement
  // absorbée comme une "mise à jour" de ce que la ligne précédente venait
  // de créer.
  const seenSageCodes = new Map();

  const runImport = db.transaction(() => {
    parsed.rows.forEach((row, idx) => {
      const lineNum = idx + 2; // +1 pour l'en-tête, +1 car idx commence à 0
      const name = (row.nom || '').trim();
      const code = (row.code || '').trim();
      const sageCode = (row.code_sage || '').trim();
      if (!name) return results.errors.push({ line: lineNum, error: 'Colonne "nom" vide.' });
      if (!code) return results.errors.push({ line: lineNum, error: 'Colonne "code" vide.' });
      if (!sageCode) return results.errors.push({ line: lineNum, error: 'Colonne "code_sage" vide.' });

      const sageCodeKey = sageCode.toUpperCase();
      if (seenSageCodes.has(sageCodeKey)) {
        return results.duplicates.push({ line: lineNum, sageCode, error: `Doublon dans le fichier — même code_sage qu'à la ligne ${seenSageCodes.get(sageCodeKey)}, ignoré.` });
      }
      seenSageCodes.set(sageCodeKey, lineNum);

      const category = (row.categorie || 'lit').trim();
      if (!CATEGORIES.some(c => c.id === category)) {
        return results.errors.push({ line: lineNum, error: `Catégorie "${category}" invalide (attendu : ${CATEGORIES.map(c => c.id).join(', ')}).` });
      }
      const priceNum = row.prix !== undefined && row.prix !== '' ? parseFloat(row.prix.replace(',', '.')) : 0;
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        return results.errors.push({ line: lineNum, error: `Prix "${row.prix}" invalide.` });
      }
      const numericCols = { densite_gsm: 'gsm', largeur_cm: 'widthCm', longueur_cm: 'lengthCm', largeur_pliee_cm: 'foldedWidthCm', longueur_pliee_cm: 'foldedLengthCm', epaisseur_pliee_cm: 'foldedHeightCm' };
      const numeric = {};
      let numericError = null;
      for (const [col, key] of Object.entries(numericCols)) {
        const raw = row[col];
        const val = raw !== undefined && raw !== '' ? parseFloat(raw.replace(',', '.')) : 0;
        if (!Number.isFinite(val) || val < 0) { numericError = `Colonne "${col}" invalide : "${raw}".`; break; }
        numeric[key] = val;
      }
      if (numericError) return results.errors.push({ line: lineNum, error: numericError });

      const existingBySage = findBySageCode.get(sageCode);
      // densite_gsm vide sur cette ligne ET l'article existe déjà : reprend
      // son gsm actuel plutôt que de recalculer vers un poids à zéro (même
      // principe défensif que pour la modification manuelle).
      let gsmForCalc = numeric.gsm;
      if (gsmForCalc === 0 && (row.densite_gsm === undefined || row.densite_gsm === '') && existingBySage) {
        const currentRow = findCurrentBySageCode.get(sageCode);
        if (currentRow.gsm > 0) gsmForCalc = currentRow.gsm;
        else if (currentRow.weight_g > 0 && currentRow.width_cm > 0 && currentRow.length_cm > 0) {
          gsmForCalc = currentRow.weight_g / ((currentRow.width_cm * currentRow.length_cm) / 10000);
        }
      }
      const { weightG, volumeL } = computeWeightAndVolume({
        widthCm: numeric.widthCm, lengthCm: numeric.lengthCm,
        foldedWidthCm: numeric.foldedWidthCm, foldedLengthCm: numeric.foldedLengthCm, foldedHeightCm: numeric.foldedHeightCm,
        gsm: gsmForCalc,
      });

      if (existingBySage) {
        updateArticle.run(name, code, priceNum, category, weightG, volumeL, gsmForCalc, numeric.widthCm, numeric.lengthCm, numeric.foldedWidthCm, numeric.foldedLengthCm, numeric.foldedHeightCm, sageCode);
        return results.updated.push({ line: lineNum, name, sageCode });
      }

      // Pas de correspondance exacte par code_sage, mais un article de
      // même nom existe déjà avec un AUTRE code_sage — probablement la
      // même référence saisie deux fois (faute de frappe sur le code, ou
      // import redondant). On ne bloque PAS la création (le nom seul
      // n'est pas une preuve suffisante — pourrait être une variante
      // légitime), mais on le signale clairement pour vérification
      // manuelle plutôt que de laisser deux fiches silencieusement
      // coexister pour ce qui est peut-être le même article.
      const nameMatch = findByNormalizedName.get(name.toLowerCase().trim());
      if (nameMatch) {
        results.possibleDuplicates.push({ line: lineNum, name, error: `Un article nommé "${name}" existe déjà avec le code_sage "${nameMatch.sage_code}" (celui-ci : "${sageCode}") — à vérifier, créé quand même.` });
      }

      let id = name.toString().trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (!id) return results.errors.push({ line: lineNum, error: 'Impossible de générer un identifiant depuis le nom.' });
      let suffix = 2;
      const baseId = id;
      while (findById.get(id)) { id = `${baseId}_${suffix}`; suffix += 1; }

      insertArticle.run(id, name, code, sageCode, priceNum, category, weightG, volumeL, gsmForCalc, numeric.widthCm, numeric.lengthCm, numeric.foldedWidthCm, numeric.foldedLengthCm, numeric.foldedHeightCm);
      results.created.push({ line: lineNum, name, sageCode });
    });
  });
  runImport();

  res.json({
    summary: { total: parsed.rows.length, created: results.created.length, updated: results.updated.length, duplicates: results.duplicates.length, possibleDuplicates: results.possibleDuplicates.length, errors: results.errors.length },
    ...results,
  });
});

module.exports = router;
