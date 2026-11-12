// Écart entre ce que l'hôtel a commandé (qty) et ce que nous avons réellement livré (deliveredQty).
// Un seul endroit pour ce calcul : le webhook et l'API client disent ainsi exactement la même chose.
//
// `difference` = livré − commandé, en valeur absolue : négatif = moins que commandé, positif = plus.
// (En valeur absolue pour que les lignes de reprise, dont les quantités sont négatives, se lisent pareil.)
// `discrepancy` vaut 'short' (moins livré), 'over' (plus livré) ou null (conforme).

function lineDiff(item) {
  const qtyOrdered = item.qty;
  const qtyDelivered = item.deliveredQty ?? item.qty;
  const difference = Math.abs(qtyDelivered) - Math.abs(qtyOrdered);
  return {
    qtyOrdered,
    qtyDelivered,
    difference,
    discrepancy: difference < 0 ? 'short' : difference > 0 ? 'over' : null,
  };
}

/** Vrai si au moins une ligne n'a pas été livrée telle que commandée. */
function hasDiscrepancy(items) {
  return items.some(it => lineDiff(it).discrepancy !== null);
}

module.exports = { lineDiff, hasDiscrepancy };
