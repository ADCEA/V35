// Connexion à Odoo via l'API JSON/2 (endpoint moderne /json/2/<model>/<method>,
// authentification par clé API en Bearer token) — PAS l'ancien /jsonrpc
// avec common.login : ce dernier est en cours de suppression par Odoo
// (les sources officielles divergent sur la date exacte — quelque part
// entre fin 2026 et 2028 selon la version et l'hébergement — mais la
// direction est claire), en plus de n'avoir jamais été vérifié sur ce
// compte contrairement à /json/2/.
//
// Variables d'environnement requises (à définir sur Render, jamais en dur
// dans le code) :
//   ODOO_URL      — ex. https://votrebase.odoo.com (sans slash final)
//   ODOO_DB       — nom de la base (utile si plusieurs bases sur le même domaine)
//   ODOO_API_KEY  — clé API personnelle, générée depuis Odoo → Mon profil
//                   → Sécurité du compte → Nouvelle clé API
//
// IMPORTANT — lecture vs écriture :
// Le format ci-dessous (arguments nommés à plat dans le corps JSON, ex.
// { domain: [...], fields: [...] }) est confirmé pour les appels de
// LECTURE (search_read, search_count, read...).
// Pour CREATE, confirmé directement depuis la page /doc de l'instance
// réelle (pas une supposition) : le corps attend { vals_list: [ {...} ] }
// — une LISTE de dictionnaires, même pour créer un seul enregistrement
// (convention Odoo : create() peut créer plusieurs enregistrements d'un
// coup). La méthode renvoie la liste des ids créés, ex. [42].
// Pour WRITE (modifier des enregistrements existants), la doc générale
// JSON-2 indique un paramètre universel "ids" en plus des arguments
// propres à la méthode — donc { ids: [42], vals: {...} }, non encore
// vérifié en conditions réelles à ce stade.

// Odoo renvoie `false` (jamais null/undefined) pour un champ non
// renseigné — convention historique de son ORM Python. SQLite ne sait
// lier que nombres/chaînes/bigints/buffers/null : transmettre un `false`
// Odoo tel quel à une requête déclenche "SQLite3 can only bind numbers,
// strings, bigints, buffers, and null". Toute valeur lue depuis Odoo et
// destinée à être stockée localement doit passer par ici avant.
function odooFalseToNull(value) {
  return value === false ? null : value;
}

function isOdooConfigured() {
  return !!(process.env.ODOO_URL && process.env.ODOO_API_KEY);
}

/**
 * Appelle une méthode du modèle Odoo donné. `params` est un objet plat
 * d'arguments NOMMÉS correspondant exactement à ce que la méthode Odoo
 * attend (ex. { domain, fields, limit } pour search_read).
 */
async function odooCall(model, method, params = {}) {
  if (!isOdooConfigured()) {
    throw new Error('Odoo non configuré (ODOO_URL / ODOO_API_KEY manquants).');
  }
  const url = `${process.env.ODOO_URL}/json/2/${model}/${method}`;
  const headers = {
    Authorization: `Bearer ${process.env.ODOO_API_KEY}`,
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (process.env.ODOO_DB) headers['X-Odoo-Database'] = process.env.ODOO_DB;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(params) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`Odoo ${model}.${method} a échoué (${res.status}) : ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Vérifie si un champ donné existe réellement sur res.partner, avant de
 * l'utiliser — évite de répéter l'erreur rencontrée avec `siret`
 * (supposer qu'un champ existe et se prendre un KeyError Odoo en
 * conditions réelles). Mis en cache par nom de champ après le premier
 * appel : le schéma d'Odoo ne change pas en cours de fonctionnement du
 * serveur, pas besoin de revérifier à chaque synchronisation.
 */
const partnerFieldExistsCache = new Map();
async function odooPartnerFieldExists(fieldName) {
  if (partnerFieldExistsCache.has(fieldName)) return partnerFieldExistsCache.get(fieldName);
  let exists;
  try {
    const fields = await odooCall('res.partner', 'fields_get', { allfields: [fieldName] });
    exists = !!(fields && Object.keys(fields).includes(fieldName));
  } catch {
    // Si la vérification elle-même échoue, on suppose l'absence par
    // prudence — mieux vaut omettre un champ que faire échouer toute la
    // synchronisation du partenaire pour ça.
    exists = false;
  }
  partnerFieldExistsCache.set(fieldName, exists);
  return exists;
}

/**
 * Trouve ou crée le res.partner correspondant à un client, et le tient à
 * jour avec les dernières informations connues (SIRET, TVA, adresse de
 * facturation). Recherche d'abord par email (idempotent : un ré-essai
 * après un problème réseau ne crée jamais de doublon). Retourne l'id
 * Odoo du partenaire.
 *
 * Note sur `vat` vs `siret` vs `company_registry` :
 * - `vat` (n° de TVA intracommunautaire) est un champ standard Odoo,
 *   présent sur toute installation.
 * - `siret` est ajouté par la localisation française (l10n_fr) —
 *   confirmé ABSENTE sur cette instance (KeyError Odoo reçu en
 *   conditions réelles) : n'est donc envoyé que si
 *   odooPartnerFieldExists('siret') le confirme présent (utile si la
 *   localisation est installée plus tard).
 * - `company_registry` est le champ GÉNÉRIQUE (indépendant de toute
 *   localisation, présent dans le module account lui-même) prévu pour
 *   ce type d'identifiant d'entreprise — confirmé disponible sur
 *   l'instance (retour direct). C'est celui réellement utilisé pour
 *   porter le SIRET ici.
 */
async function findOrCreateOdooPartner(client) {
  const vals = {
    name: client.societe,
    email: client.email || false,
    phone: client.tel,
    street: client.adresse_facturation || client.adresse,
    // city/zip ne sont envoyés QUE si c'est bien l'adresse de collecte qui
    // sert de street ci-dessus (seule adresse pour laquelle on a une ville
    // et un code postal structurés) — jamais si adresse_facturation est
    // renseignée, pour ne pas associer la ville de collecte à une rue de
    // facturation potentiellement différente.
    city: client.adresse_facturation ? false : (client.ville || false),
    zip: client.adresse_facturation ? false : (client.code_postal || false),
    is_company: true,
    vat: client.tva_number || false,
    // Le nom du contact n'a pas de champ dédié universel sur res.partner
    // pour une fiche "société" sans créer un contact enfant séparé (plus
    // de complexité pour un gain limité ici) — comment est un champ
    // standard, toujours présent, adapté à cette info interne.
    comment: client.contact ? `Contact référent : ${client.contact}` : false,
  };
  // SIRET transmis sur le champ générique company_registry (indépendant
  // de toute localisation, confirmé présent dans le module account) —
  // ET, en bonus si la localisation française est installée un jour, sur
  // le champ siret lui-même. Les deux vérifiés dynamiquement avant envoi.
  if (client.siret) {
    if (await odooPartnerFieldExists('company_registry')) vals.company_registry = client.siret;
    if (await odooPartnerFieldExists('siret')) vals.siret = client.siret;
  }

  // Recherche par email uniquement si le client en a un : sans email, un
  // domaine [['email', '=', false]] renverrait n'importe quel partenaire
  // sans email. On réutilise alors le partenaire déjà lié s'il existe.
  let existing = [];
  if (client.email) {
    existing = await odooCall('res.partner', 'search_read', {
      domain: [['email', '=', client.email]],
      fields: ['id'],
      limit: 1,
    });
  } else if (client.odoo_partner_id) {
    existing = await odooCall('res.partner', 'search_read', {
      domain: [['id', '=', client.odoo_partner_id]],
      fields: ['id'],
      limit: 1,
    });
  }

  if (Array.isArray(existing) && existing.length > 0) {
    const partnerId = existing[0].id;
    await odooCall('res.partner', 'write', { ids: [partnerId], vals });
    return partnerId;
  }

  const created = await odooCall('res.partner', 'create', { vals_list: [vals] });
  // create renvoie une liste d'ids (ex. [42]), même pour un seul enregistrement.
  return created[0];
}

/**
 * Trouve ou crée le product.product correspondant à un article du
 * catalogue. Recherche par default_code = code Sage (idempotent, comme
 * pour les partenaires). Retourne l'id Odoo du produit.
 *
 * Note : le champ déterminant le type "service" (sans suivi de stock)
 * a changé de nom selon les versions d'Odoo (`type` historiquement,
 * `detailed_type` sur certaines versions intermédiaires). Non vérifié sur
 * cette instance précise — en cas d'erreur explicite sur ce champ, c'est
 * le premier point à corriger.
 */
async function findOrCreateOdooProduct(article) {
  const existing = await odooCall('product.product', 'search_read', {
    domain: [['default_code', '=', article.sageCode]],
    fields: ['id'],
    limit: 1,
  });
  if (Array.isArray(existing) && existing.length > 0) {
    return existing[0].id;
  }
  const created = await odooCall('product.product', 'create', {
    vals_list: [{
      name: article.name,
      default_code: article.sageCode,
      type: 'service',
      sale_ok: true,
    }],
  });
  return created[0];
}

/**
 * Liste les taxes de VENTE disponibles côté Odoo (account.tax, type_tax_use
 * = 'sale') — sert à peupler un sélecteur côté admin pour choisir l'ODOO_TAX_ID
 * sans avoir à le chercher manuellement dans l'interface Odoo.
 */
async function listSaleTaxes() {
  return odooCall('account.tax', 'search_read', {
    domain: [['type_tax_use', '=', 'sale']],
    fields: ['id', 'name', 'amount'],
  });
}

/**
 * Trouve ou crée un produit "générique" utilisé UNIQUEMENT pour les
 * lignes de facture en mode "une ligne par BL" (un montant total, sans
 * article précis associé). Sans ça, Odoo exigerait soit un product_id,
 * soit un account_id explicite que nous n'avons aucun moyen de connaître
 * depuis ce système — ce produit dédié règle le problème proprement.
 */
async function findOrCreateGenericServiceProduct() {
  const code = 'SERVICE-BL-GROUPE';
  const existing = await odooCall('product.product', 'search_read', {
    domain: [['default_code', '=', code]],
    fields: ['id'],
    limit: 1,
  });
  if (Array.isArray(existing) && existing.length > 0) return existing[0].id;
  const created = await odooCall('product.product', 'create', {
    vals_list: [{ name: 'Prestation de blanchisserie (facturation groupée par BL)', default_code: code, type: 'service', sale_ok: true }],
  });
  return created[0];
}

/**
 * Crée une facture BROUILLON dans Odoo (jamais validée/postée
 * automatiquement — reste modifiable et supprimable tant qu'elle n'est
 * pas confirmée dans Odoo lui-même). `lines` est déjà construit (voir
 * buildInvoiceLines côté routes/admin.js selon le niveau de détail
 * choisi) : [{ isSection, name, productId?, quantity?, priceUnit? }].
 *
 * Format des invoice_line_ids non vérifié à 100% sur cette instance : la
 * syntaxe [0, 0, {...}] ("créer une ligne liée") est LA convention Odoo
 * historique et stable pour les champs one2many, mais n'a pas été
 * spécifiquement testée via l'API JSON-2 avant ce premier essai réel.
 */
async function createDraftInvoice({ partnerId, taxId, ref, invoiceDate, lines }) {
  let sequence = 10;
  const invoiceLineIds = lines.map(line => {
    if (line.isSection) {
      return [0, 0, { display_type: 'line_section', name: line.name, sequence: sequence++ }];
    }
    return [0, 0, {
      sequence: sequence++,
      product_id: line.productId,
      name: line.name,
      quantity: line.quantity,
      price_unit: line.priceUnit,
      tax_ids: taxId ? [[6, 0, [taxId]]] : undefined,
    }];
  });

  const created = await odooCall('account.move', 'create', {
    vals_list: [{
      move_type: 'out_invoice',
      partner_id: partnerId,
      invoice_date: invoiceDate,
      ref,
      invoice_line_ids: invoiceLineIds,
    }],
  });
  const moveId = created[0];

  const [move] = await odooCall('account.move', 'read', { ids: [moveId], fields: ['amount_untaxed', 'name'] });
  // Sur une facture encore en BROUILLON, "name" (le numéro séquentiel)
  // n'est pas encore attribué — Odoo renvoie `false`, pas null, d'où le
  // passage par odooFalseToNull avant tout stockage local.
  return {
    odooMoveId: moveId,
    totalHt: odooFalseToNull(move?.amount_untaxed) ?? null,
    odooNumber: odooFalseToNull(move?.name) ?? null,
  };
}

/**
 * Récupère le PDF d'une facture VALIDÉE (postée) dans Odoo, sous forme de
 * Buffer. Renvoie null si la facture n'est pas encore postée (un
 * brouillon n'a pas de PDF) ou si vraiment aucune pièce jointe PDF n'est
 * trouvée — CE N'EST PAS UN PROBLÈME DE DÉLAI : le comportement standard
 * d'Odoo est que la validation seule NE génère PAS le PDF, seul un
 * premier clic sur "Imprimer"/"Aperçu" dans Odoo le déclenche réellement.
 *
 * Champ confirmé pour Odoo 19 (votre version) : invoice_pdf_report_id,
 * Many2one vers ir.attachment. MAIS bug connu et confirmé sur certaines
 * configurations Odoo 19 Enterprise (module Documents, avec un mapping de
 * dossier sur les factures de vente) : ce champ précis reste vide même
 * quand le PDF a bel et bien été généré et existe comme pièce jointe —
 * d'où la recherche de secours ci-dessous, qui cherche directement dans
 * ir.attachment plutôt que de dépendre uniquement de ce champ.
 */
async function fetchInvoicePdfFromOdoo(odooMoveId) {
  const [move] = await odooCall('account.move', 'read', {
    ids: [odooMoveId],
    fields: ['state', 'name', 'invoice_pdf_report_id'],
  });
  if (!move || move.state !== 'posted') {
    return { pdfBuffer: null, reason: 'not_posted', state: move?.state || 'inconnu' };
  }

  let attachmentId = null;
  const attachmentRef = odooFalseToNull(move.invoice_pdf_report_id);
  if (attachmentRef) {
    // Many2one renvoyé comme [id, display_name] par l'API — on ne garde que l'id.
    attachmentId = Array.isArray(attachmentRef) ? attachmentRef[0] : attachmentRef;
  } else {
    // Secours : invoice_pdf_report_id est vide, mais un PDF existe peut-être
    // quand même comme pièce jointe directe sur cette facture (bug connu
    // Odoo 19 Enterprise + Documents). Cherche la pièce jointe PDF la plus
    // récente rattachée à ce record account.move précis.
    const fallback = await odooCall('ir.attachment', 'search_read', {
      domain: [['res_model', '=', 'account.move'], ['res_id', '=', odooMoveId], ['mimetype', '=', 'application/pdf']],
      fields: ['id'],
      order: 'create_date desc',
      limit: 1,
    });
    if (Array.isArray(fallback) && fallback.length > 0) {
      attachmentId = fallback[0].id;
    }
  }

  if (!attachmentId) {
    return { pdfBuffer: null, reason: 'no_attachment_yet', state: move.state };
  }

  const [attachment] = await odooCall('ir.attachment', 'read', {
    ids: [attachmentId],
    fields: ['datas', 'name'],
  });
  if (!attachment?.datas) {
    return { pdfBuffer: null, reason: 'attachment_empty', state: move.state };
  }
  return { pdfBuffer: Buffer.from(attachment.datas, 'base64'), odooFileName: attachment.name, state: move.state };
}

/**
 * Consulte le statut ACTUEL d'une facture dans Odoo (draft / posted /
 * cancel). Sert à détecter une annulation faite directement dans Odoo,
 * pour que les BL qui lui étaient rattachés redeviennent facturables
 * plutôt que de rester bloqués indéfiniment.
 */
async function checkOdooInvoiceState(odooMoveId) {
  const [move] = await odooCall('account.move', 'read', {
    ids: [odooMoveId],
    fields: ['state'],
  });
  return move?.state || null;
}

module.exports = {
  odooCall, isOdooConfigured, odooFalseToNull, findOrCreateOdooPartner, findOrCreateOdooProduct,
  findOrCreateGenericServiceProduct, listSaleTaxes, createDraftInvoice, fetchInvoicePdfFromOdoo, checkOdooInvoiceState,
};
