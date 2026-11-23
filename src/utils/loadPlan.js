// Calculs de chargement partagés : combien de chariots pour un volume donné, et combien en tient sur le plancher d'un camion.

// Recommandation gloutonne : le plus grand chariot d'abord (pour
// minimiser le nombre total), puis les plus petits pour le reste —
// approche simple, pas une optimisation exacte du "bin packing".
function recommendCarts(totalVolumeL, cartTypes) {
  if (totalVolumeL <= 0 || cartTypes.length === 0) return [];
  let remaining = totalVolumeL;
  const recommendation = [];
  // cartTypes attendu trié du plus grand volume au plus petit.
  for (const ct of cartTypes) {
    const count = Math.floor(remaining / ct.volumeL);
    if (count > 0) {
      recommendation.push({ name: ct.name, count });
      remaining -= count * ct.volumeL;
    }
  }
  if (remaining > 0.01) {
    const smallest = cartTypes[cartTypes.length - 1];
    const existing = recommendation.find(r => r.name === smallest.name);
    if (existing) existing.count += 1;
    else recommendation.push({ name: smallest.name, count: 1 });
  }
  return recommendation;
}

/** Nombre de chariots de ce modèle qui tiennent debout sur le plancher du camion (meilleure des deux orientations) ; 0 s'ils sont trop hauts. */
function cartFloorFit(cart, truck) {
  if (!cart || !truck || !(cart.lengthCm > 0) || !(cart.widthCm > 0)) return 0;
  if (cart.heightCm > truck.heightCm) return 0;
  const a = Math.floor(truck.lengthCm / cart.lengthCm) * Math.floor(truck.widthCm / cart.widthCm);
  const b = Math.floor(truck.lengthCm / cart.widthCm) * Math.floor(truck.widthCm / cart.lengthCm);
  return Math.max(a, b);
}

module.exports = { recommendCarts, cartFloorFit };
