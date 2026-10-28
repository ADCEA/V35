// Les quantités négatives (reprises de linge) ne se saisissent que dans l'administration (routes /api/admin protégées par la
// session administrateur). Tout autre chemin qui crée des lignes de commande — espace client, API, e-mails entrants,
// planning des chambres — passe par ce contrôle : la contrainte de la base n'interdit plus les quantités négatives.

/** Lance une erreur si une ligne n'a pas une quantité entière strictement positive. */
function assertPositiveQuantities(items, where = 'commande') {
  for (const it of items || []) {
    if (!Number.isInteger(it.qty) || it.qty <= 0) {
      throw new Error(`Quantité invalide (${it.qty}) pour « ${it.name || it.id} » : une ${where} automatique ne peut contenir que des quantités positives.`);
    }
  }
}

module.exports = { assertPositiveQuantities };
