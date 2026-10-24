// PDF d'exploitation : bon de livraison, bon de préparation, annexe détaillée et récapitulatif de facture.
// Mise en page commune : voir src/utils/pdfKit.js.

const K = require('./pdfKit');
const { STATUS_LABELS } = require('./deliveryNote');

const { C, L, R, W, eur, num, price, dateFr } = K;

const dateOrTbc = (iso) => (iso ? dateFr(iso) : 'à confirmer');

/**
 * Bon de livraison. `order` : ticket, status, societe, contact, tel, adresse, livraison_prevue, notes,
 * items ([{ name, qty, deliveredQty, sageCode? }]). Une zone de signature permet de faire valider la remise.
 */
async function buildDeliveryNotePdf(order) {
  const seller = K.brandSeller();
  const { doc, done, F } = K.newDocument({ title: `Bon de livraison ${order.ticket}`, subject: order.societe });
  const continued = () => `Bon de livraison ${order.ticket}  ·  ${order.societe}`;

  const statusLabel = STATUS_LABELS[order.status] || order.status;
  K.header(doc, { title: 'Bon de livraison', number: `N° ${order.ticket}`, chipLabel: statusLabel, chipTone: order.status === 'livree' ? 'ok' : 'soft' });
  K.foldMarks(doc);
  K.senderLine(doc, seller);
  const addrBottom = K.addressBlock(doc, order.societe, [order.contact ? `À l'attention de ${order.contact}` : '', order.adresse, order.tel ? `Tél. ${order.tel}` : '']);
  const infoBottom = K.infoRows(doc, [
    ['Livraison prévue', dateOrTbc(order.livraison_prevue), true],
    ['Commande', order.ticket],
    ['Références', String(order.items.length)],
  ]);
  let y = Math.max(addrBottom + 12, infoBottom + 14, K.CONTENT_TOP);

  // ---------- articles ----------
  const cols = [
    { label: 'Désignation', x: L + 8, w: 280 },
    { label: 'Commandé', x: L + 300, w: 80, align: 'right' },
    { label: 'Livré', x: L + 390, w: W - 398, align: 'right' },
  ];
  y = K.tableHeader(doc, cols, y);
  let adjusted = false; let totalOrdered = 0; let totalDelivered = 0;
  for (const it of order.items) {
    const delivered = it.deliveredQty ?? it.qty;
    const diff = delivered !== it.qty;
    adjusted = adjusted || diff; totalOrdered += it.qty; totalDelivered += delivered;
    if (y + 30 > K.BOTTOM) { y = K.nextPage(doc, continued()); y = K.tableHeader(doc, cols, y); }
    doc.font(F.sans).fontSize(10.5).fillColor(C.ink).text(it.name, cols[0].x, y + 7.5, { width: cols[0].w, lineBreak: false });
    if (it.sageCode) doc.font(F.sans).fontSize(7.5).fillColor(C.mute).text(it.sageCode, cols[0].x, y + 20, { width: cols[0].w, lineBreak: false });
    const t = { align: 'right', lineBreak: false, features: K.TNUM };
    doc.font(F.sans).fontSize(10.5).fillColor(C.soft).text(num(it.qty), cols[1].x, y + 7.5, { width: cols[1].w, ...t });
    // Une quantité ajustée se distingue par le gras et un astérisque, pas par la couleur seule.
    doc.font(diff ? F.bold : F.semi).fillColor(C.ink).text(diff ? `${num(delivered)}\u00A0*` : num(delivered), cols[2].x, y + 7.5, { width: cols[2].w, ...t });
    y += it.sageCode ? 33 : 28;
    K.hr(doc, y);
  }
  // total
  if (y + 40 > K.BOTTOM) { y = K.nextPage(doc, continued()); }
  doc.font(F.semi).fontSize(9).fillColor(C.soft).text('Total pièces', cols[0].x, y + 10, { width: 200, lineBreak: false });
  const tt = { align: 'right', lineBreak: false, features: K.TNUM };
  doc.font(F.medium).fontSize(10.5).fillColor(C.soft).text(num(totalOrdered), cols[1].x, y + 9, { width: cols[1].w, ...tt });
  doc.font(F.bold).fontSize(12).fillColor(C.ink).text(num(totalDelivered), cols[2].x, y + 8, { width: cols[2].w, ...tt });
  K.hr(doc, y + 30, { color: C.ink, width: 1 });
  y += 42;
  if (adjusted) {
    doc.font(F.italic).fontSize(8).fillColor(C.soft).text('* Quantité livrée différente de la quantité commandée.', L, y, { width: W });
    y = doc.y + 8;
  }

  // ---------- notes ----------
  if (order.notes) {
    doc.font(F.sans).fontSize(9).fillColor(C.ink);
    const h = doc.heightOfString(order.notes, { width: W - 28, lineGap: 1.5 }) + 34;
    if (y + h > K.BOTTOM) y = K.nextPage(doc, continued());
    doc.save().roundedRect(L, y, W, h, 4).fill(C.wash).restore();
    doc.font(F.semi).fontSize(8).fillColor(C.soft).text('Notes de livraison', L + 14, y + 10, { width: W - 28, lineBreak: false });
    doc.font(F.sans).fontSize(9).fillColor(C.ink).text(order.notes, L + 14, y + 24, { width: W - 28, lineGap: 1.5 });
    y += h + 14;
  }

  // ---------- remise et réception ----------
  if (y + 96 > K.BOTTOM) y = K.nextPage(doc, continued());
  y = Math.max(y + 10, Math.min(y + 30, K.BOTTOM - 86));
  const bw = (W - 16) / 2;
  [['Remis par', 'Nom du chauffeur, signature'], ['Reçu par', 'Nom, date, signature et réserves éventuelles']].forEach(([title, hint], i) => {
    const x = L + i * (bw + 16);
    doc.save().lineWidth(0.8).strokeColor(C.ink).roundedRect(x, y, bw, 78, 4).stroke().restore();
    doc.font(F.semi).fontSize(9).fillColor(C.ink).text(title, x + 12, y + 10, { width: bw - 24, lineBreak: false });
    doc.font(F.sans).fontSize(7.6).fillColor(C.mute).text(hint, x + 12, y + 23, { width: bw - 24, lineBreak: false });
  });

  K.footers(doc, { seller, label: `Bon de livraison ${order.ticket}` });
  doc.end();
  return done;
}

/**
 * Bon de préparation (plan de conditionnement), à imprimer et cocher à la main. `order` : ticket, societe (et
 * livraison_prevue si connue). `plan` : { carts: [{ name, usedL, capacityL, usedKg, maxWeightKg, items: [{ name, code, qty }] }],
 * unpacked: [{ name, qty }] }.
 */
async function buildPreparationSlipPdf(order, plan) {
  const seller = K.brandSeller();
  const { doc, done, F } = K.newDocument({ title: `Bon de préparation ${order.ticket}`, subject: order.societe });
  const continued = () => `Bon de préparation ${order.ticket}  ·  ${order.societe}`;

  K.header(doc, { title: 'Bon de préparation', number: `N° ${order.ticket}` });
  const itemCount = plan.carts.reduce((s, c) => s + c.items.length, 0) + (plan.unpacked || []).length;
  let y = K.metaBand(doc, 120, [
    ['Client', order.societe],
    ['Livraison prévue', order.livraison_prevue ? dateFr(order.livraison_prevue) : 'à confirmer'],
    ['Chariots', String(plan.carts.length)],
    ['Références', String(itemCount)],
  ]) + 22;

  plan.carts.forEach((cart) => {
    const need = 52 + Math.min(cart.items.length, 3) * 28;
    if (y + need > K.BOTTOM) y = K.nextPage(doc, continued());
    // bandeau du chariot : nom, remplissage en volume et en poids
    doc.save().roundedRect(L, y, W, 44, 4).fill(C.wash).restore();
    doc.font(F.semi).fontSize(12.5).fillColor(C.ink).text(cart.name, L + 14, y + 15, { width: 190, lineBreak: false });
    const metric = (label, used, cap, unit, x) => {
      const ratio = cap ? used / cap : 0;
      doc.font(F.sans).fontSize(7.8).fillColor(C.soft).text(label, x, y + 9, { width: 120, lineBreak: false });
      doc.font(F.semi).fontSize(8.5).fillColor(ratio > 0.95 ? C.rust : C.ink)
        .text(`${num(used, 1)} / ${num(cap, 1)} ${unit}`, x, y + 9, { width: 112, align: 'right', lineBreak: false, features: K.TNUM });
      K.gauge(doc, x, y + 26, 112, ratio, ratio > 0.95 ? C.rust : C.brand);
    };
    metric('Volume', cart.usedL, cart.capacityL, 'L', L + 218);
    metric('Poids', cart.usedKg, cart.maxWeightKg, 'kg', L + 218 + 128);
    y += 56;
    doc.font(F.italic).fontSize(8).fillColor(C.soft).text("Ordre de chargement : le plus lourd d'abord, au fond du chariot.", L + 2, y, { width: W, lineBreak: false });
    y += 16;
    cart.items.forEach((item, i) => {
      if (y + 28 > K.BOTTOM) y = K.nextPage(doc, continued());
      doc.font(F.medium).fontSize(8.5).fillColor(C.mute).text(String(i + 1), L + 2, y + 7, { width: 16, align: 'right', lineBreak: false });
      K.checkbox(doc, L + 28, y + 5, 13);
      doc.font(F.sans).fontSize(11).fillColor(C.ink).text(item.name, L + 54, y + 6, { width: 280, lineBreak: false });
      if (i === 0) doc.font(F.italic).fontSize(8).fillColor(C.mute).text('au fond', L + 340, y + 8.5, { width: 60, lineBreak: false });
      doc.font(F.bold).fontSize(12.5).fillColor(C.ink).text(`× ${item.qty}`, R - 90, y + 5, { width: 90, align: 'right', lineBreak: false, features: K.TNUM });
      y += 28;
      K.hr(doc, y - 2);
    });
    y += 16;
  });

  // ---------- articles qui ne rentrent dans aucun chariot ----------
  if (plan.unpacked && plan.unpacked.length > 0) {
    const h = 38 + plan.unpacked.length * 18;
    if (y + h > K.BOTTOM) y = K.nextPage(doc, continued());
    doc.save().lineWidth(1.2).strokeColor(C.rust).roundedRect(L, y, W, h, 4).stroke().restore();
    K.alertIcon(doc, L + 14, y + 12, 15);
    doc.font(F.semi).fontSize(10).fillColor(C.rust).text('Ne rentre dans aucun chariot ci-dessus', L + 38, y + 14, { width: W - 52, lineBreak: false });
    let uy = y + 36;
    plan.unpacked.forEach((it) => {
      doc.font(F.sans).fontSize(10.5).fillColor(C.rust).text(`${it.name}`, L + 38, uy, { width: 340, lineBreak: false });
      doc.font(F.bold).text(`× ${it.qty}`, R - 100, uy, { width: 88, align: 'right', lineBreak: false, features: K.TNUM });
      uy += 18;
    });
    y += h + 18;
  }

  // ---------- visa ----------
  if (y + 40 > K.BOTTOM) y = K.nextPage(doc, continued());
  doc.font(F.sans).fontSize(8.5).fillColor(C.soft);
  doc.text('Préparé par', L, y + 14, { width: 70, lineBreak: false });
  K.hr(doc, y + 24, { x1: L + 66, x2: L + 230, color: C.mute });
  doc.text('Contrôlé par', L + 270, y + 14, { width: 70, lineBreak: false });
  K.hr(doc, y + 24, { x1: L + 340, x2: R, color: C.mute });

  K.footers(doc, { seller, label: `Bon de préparation ${order.ticket}` });
  doc.end();
  return done;
}

// ---------- annexe et récapitulatif de facture ----------

/** Quantité facturée d'une ligne de BL (la quantité livrée prime sur la quantité commandée). */
const billedQty = (it) => it.deliveredQty ?? it.qty;

/**
 * Annexe détaillée, BL par BL : de quoi vérifier la facture ligne à ligne.
 * `orders` : [{ ticket, livraisonPrevue, items: [{ name, qty, deliveredQty, price }] }]
 */
async function buildInvoiceAnnexPdf(invoiceRef, societe, orders) {
  const seller = K.brandSeller();
  const { doc, done, F } = K.newDocument({ title: `Annexe — ${invoiceRef}`, subject: societe });
  const continued = () => `Annexe  ·  ${invoiceRef}  ·  ${societe}`;

  K.header(doc, { title: 'Annexe', number: invoiceRef });
  let y = K.metaBand(doc, 120, [['Client', societe], ['Facture', invoiceRef], ['Bons de livraison', String(orders.length)]]) + 24;

  const cols = [
    { label: 'Article', x: L + 14, w: 230 },
    { label: 'Quantité', x: L + 250, w: 60, align: 'right' },
    { label: 'Prix unitaire HT', x: L + 316, w: 80, align: 'right' },
    { label: 'Total HT', x: L + 402, w: W - 414, align: 'right' },
  ];
  const t = { align: 'right', lineBreak: false, features: K.TNUM };
  y = K.tableHeader(doc, cols, y) + 10;
  let grand = 0;
  for (const order of orders) {
    const lines = order.items.filter((it) => billedQty(it) > 0);
    const sub = lines.reduce((s, it) => s + Math.round(billedQty(it) * it.price * 100), 0);
    grand += sub;
    if (y + 26 + Math.min(lines.length, 2) * 21 + 24 > K.BOTTOM) { y = K.nextPage(doc, continued()); y = K.tableHeader(doc, cols, y) + 10; }
    // bandeau du bon : numéro, date de livraison, sous-total
    doc.save().roundedRect(L, y, W, 26, 4).fill(C.wash).restore();
    doc.font(F.semi).fontSize(10).fillColor(C.ink).text(`BL ${order.ticket}`, L + 14, y + 8, { width: 120, lineBreak: false });
    doc.font(F.sans).fontSize(9).fillColor(C.soft).text(`livré le ${dateOrTbc(order.livraisonPrevue)}`, L + 100, y + 8.5, { width: 200, lineBreak: false });
    doc.font(F.semi).fontSize(9.5).fillColor(C.ink).text(eur(sub), cols[3].x - 60, y + 8, { width: cols[3].w + 60, ...t });
    y += 30;
    if (!lines.length) { doc.font(F.italic).fontSize(8.5).fillColor(C.mute).text('Aucune pièce livrée.', cols[0].x, y + 4, { width: 200, lineBreak: false }); y += 22; }
    for (const it of lines) {
      if (y + 22 > K.BOTTOM) { y = K.nextPage(doc, continued()); y = K.tableHeader(doc, cols, y); }
      const qty = billedQty(it);
      doc.font(F.sans).fontSize(9.5).fillColor(C.ink).text(it.name, cols[0].x, y + 5, { width: cols[0].w, lineBreak: false });
      doc.text(num(qty), cols[1].x, y + 5, { width: cols[1].w, ...t });
      doc.fillColor(C.soft).text(price(it.price), cols[2].x, y + 5, { width: cols[2].w, ...t });
      doc.font(F.semi).fillColor(C.ink).text(eur(Math.round(qty * it.price * 100)), cols[3].x, y + 5, { width: cols[3].w, ...t });
      y += 21;
      K.hr(doc, y);
    }
    y += 14;
  }

  if (y + 56 > K.BOTTOM) y = K.nextPage(doc, continued());
  K.hr(doc, y, { x1: L + 250, color: C.ink, width: 1.2 });
  doc.font(F.semi).fontSize(9).fillColor(C.ink).text('Total HT de l\'annexe', L + 250, y + 17, { width: 120, lineBreak: false });
  doc.font(F.serif).fontSize(24).fillColor(C.ink).text(eur(grand), L + 300, y + 8, { width: W - 300, ...t });

  K.footers(doc, { seller, label: `Annexe ${invoiceRef}` });
  doc.end();
  return done;
}

/**
 * Récapitulatif global : quantités livrées totales par article, tous bons confondus ; ouvre le PDF consolidé.
 * `aggregated` : [{ name, price, qty }].
 */
async function buildInvoiceSummaryPdf(invoiceRef, societe, periodStart, periodEnd, orderCount, aggregated) {
  const seller = K.brandSeller();
  const { doc, done, F } = K.newDocument({ title: `Récapitulatif — ${invoiceRef}`, subject: societe });
  const continued = () => `Récapitulatif  ·  ${invoiceRef}  ·  ${societe}`;

  K.header(doc, { title: 'Récapitulatif', number: invoiceRef });
  let y = K.metaBand(doc, 120, [
    ['Client', societe],
    ['Période', `${dateOrTbc(periodStart)} – ${dateOrTbc(periodEnd)}`],
    ['Bons de livraison', String(orderCount)],
  ]) + 24;

  const cols = [
    { label: 'Article', x: L + 8, w: 220 },
    { label: 'Quantité livrée', x: L + 232, w: 90, align: 'right' },
    { label: 'Prix unitaire HT', x: L + 328, w: 78, align: 'right' },
    { label: 'Sous-total HT', x: L + 412, w: W - 420, align: 'right' },
  ];
  const t = { align: 'right', lineBreak: false, features: K.TNUM };
  y = K.tableHeader(doc, cols, y);
  let totalHt = 0; let totalQty = 0;
  for (const g of aggregated) {
    if (y + 26 > K.BOTTOM) { y = K.nextPage(doc, continued()); y = K.tableHeader(doc, cols, y); }
    const cents = Math.round(g.qty * g.price * 100);
    totalHt += cents; totalQty += g.qty;
    doc.font(F.sans).fontSize(10).fillColor(C.ink).text(g.name, cols[0].x, y + 7, { width: cols[0].w, lineBreak: false });
    doc.text(num(g.qty), cols[1].x, y + 7, { width: cols[1].w, ...t });
    doc.fillColor(C.soft).text(price(g.price), cols[2].x, y + 7, { width: cols[2].w, ...t });
    doc.font(F.semi).fillColor(C.ink).text(eur(cents), cols[3].x, y + 7, { width: cols[3].w, ...t });
    y += 26;
    K.hr(doc, y);
  }

  if (y + 78 > K.BOTTOM) y = K.nextPage(doc, continued());
  y += 14;
  doc.font(F.sans).fontSize(9.5).fillColor(C.soft).text('Total pièces livrées', L + 232, y, { width: 130, lineBreak: false });
  doc.font(F.semi).fillColor(C.ink).text(num(totalQty), L + 340, y, { width: W - 340, ...t });
  K.hr(doc, y + 20, { x1: L + 232, color: C.ink, width: 1.2 });
  doc.font(F.semi).fontSize(9).fillColor(C.ink).text('Total HT', L + 232, y + 37, { width: 80, lineBreak: false });
  doc.font(F.serif).fontSize(24).fillColor(C.ink).text(eur(totalHt), L + 290, y + 28, { width: W - 290, ...t });

  K.footers(doc, { seller, label: `Récapitulatif ${invoiceRef}` });
  doc.end();
  return done;
}

module.exports = { buildDeliveryNotePdf, buildPreparationSlipPdf, buildInvoiceAnnexPdf, buildInvoiceSummaryPdf };
