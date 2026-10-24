// Escompte pour règlement anticipé.
//
// Principe : l'offre (taux, date limite, montants) est figée sur la facture à
// l'émission, dans ses conditions (terms.earlyDiscount), donc dans l'empreinte
// du document. À l'encaissement, si le règlement arrive avant la date limite,
// l'escompte s'inscrit comme une ligne de règlement de méthode « escompte » :
// le reste dû et les statuts se calculent comme avant, rien d'autre à changer.
//
// TVA (art. 267-II-1° et 272 du CGI) : l'escompte réduit la base d'imposition.
// Le montant escompté est donc ventilé en HT + TVA, taux par taux, ce qui
// alimente la comptabilité (665 escomptes accordés, TVA collectée, 411 clients).
//
// Tous les calculs sont en centimes entiers (BigInt le temps de la division :
// pas de dérive flottante, mêmes arrondis à l'émission et à l'encaissement).

const NBSP = ' ';

const METHOD = 'escompte';
const MAX_RATE_PCT = 10;
const MAX_HOURS = 24 * 30;

// ---------- formats (stables : le texte est figé et haché avec la facture) ----------

function eur(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${neg ? '-' : ''}${int},${String(abs % 100).padStart(2, '0')}${NBSP}€`;
}
const pct = (p) => `${String(Number(p)).replace('.', ',')}${NBSP}%`;
const dateFr = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- règles ----------

/** Taux valide (0 = désactivé), au centième de point près. */
function parseRate(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > MAX_RATE_PCT) return null;
  return Math.round(n * 100) / 100;
}

function parseHours(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_HOURS) return null;
  return n;
}

/** L'hôtel reçoit-il l'offre ? Réglage général + exception éventuelle de sa fiche. */
function offeredTo(settings, client) {
  if (!(Number(settings.early_discount_rate) > 0)) return false;
  const c = client && client.escompte;
  if (c === 'on') return true;
  if (c === 'off') return false;
  return Boolean(settings.early_discount_all);
}

/** Dernier jour pour régler en bénéficiant de l'escompte (le jour d'émission compte pour le jour 0). */
function deadline(issueDate, hours) {
  return addDays(issueDate, Math.ceil(hours / 24));
}

// Division arrondie au plus proche (demi vers le haut en valeur absolue), sur des BigInt.
function divRound(num, den) {
  const neg = num < 0n;
  const n = neg ? -num : num;
  const q = (2n * n + den) / (2n * den);
  return Number(neg ? -q : q);
}

/**
 * Montants de l'escompte sur un reste dû, ventilés par taux de TVA.
 * invoice : { vatBreakdown: [{rate, baseCents}], total_ttc_cents } — balanceCents : montant TTC encore dû.
 * Pour balanceCents = total TTC, c'est l'escompte de l'offre figée à l'émission.
 */
function amounts(invoice, balanceCents, ratePct) {
  const total = Number(invoice.total_ttc_cents);
  const out = { htCents: 0, vatCents: 0, ttcCents: 0 };
  if (!(total > 0) || !(balanceCents > 0) || !(ratePct > 0)) return out;
  const bp = BigInt(Math.round(ratePct * 100));
  const bal = BigInt(balanceCents);
  const tot = BigInt(total);
  for (const b of invoice.vatBreakdown || []) {
    const ht = divRound(BigInt(b.baseCents) * bal * bp, tot * 10000n);
    const vat = divRound(BigInt(ht) * BigInt(Math.round(Number(b.rate) * 100)), 10000n);
    out.htCents += ht; out.vatCents += vat;
  }
  out.ttcCents = out.htCents + out.vatCents;
  return out;
}

function offerText(o, totalTtcCents) {
  return `Escompte pour paiement anticipé : ${pct(o.ratePct)} du montant de la facture. Réglée au plus tard le ${dateFr(o.deadline)} `
    + `(${o.hours}${NBSP}h après la date d'émission), cette facture est à payer ${eur(totalTtcCents - o.discountTtcCents)} TTC `
    + `au lieu de ${eur(totalTtcCents)} (escompte de ${eur(o.discountTtcCents)} TTC, dont ${eur(o.discountVatCents)} de TVA). `
    + `Seule la TVA correspondant au prix effectivement payé ouvre droit à déduction chez l'acheteur.`;
}

/**
 * Offre à figer sur une facture qu'on émet, ou null (pas d'escompte : réglage éteint,
 * hôtel exclu, avoir, échéance antérieure à la date limite, montant nul).
 */
function buildOffer({ settings, client, inv, issueDate, dueDate }) {
  if (inv.kind !== 'invoice') return null;
  if (!offeredTo(settings, client)) return null;
  const ratePct = Number(settings.early_discount_rate);
  const hours = parseHours(settings.early_discount_hours) || 48;
  const limit = deadline(issueDate, hours);
  // Un escompte récompense un règlement plus tôt que prévu : sans écart avec l'échéance, il n'a pas de sens.
  if (dueDate && limit >= dueDate) return null;
  const a = amounts(inv, inv.total_ttc_cents, ratePct);
  if (a.ttcCents <= 0 || a.ttcCents >= inv.total_ttc_cents) return null;
  const offer = { ratePct, hours, deadline: limit, discountHtCents: a.htCents, discountVatCents: a.vatCents, discountTtcCents: a.ttcCents };
  return { offer, text: offerText(offer, inv.total_ttc_cents) };
}

/** Phrase par défaut des conditions quand aucun escompte n'est proposé. */
const NO_DISCOUNT_TEXT = "Pas d'escompte pour paiement anticipé.";

module.exports = {
  METHOD, MAX_RATE_PCT, MAX_HOURS, NO_DISCOUNT_TEXT,
  eur, pct, dateFr, addDays,
  parseRate, parseHours, offeredTo, deadline, amounts, offerText, buildOffer,
};
