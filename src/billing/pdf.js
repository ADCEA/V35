// PDF d'une facture, d'un avoir ou d'un devis de la facturation intégrée.
//
// Le document est produit UNIQUEMENT à partir de ce qui a été figé à
// l'émission (vendeur, acheteur, conditions, lignes, totaux) : régénéré dix
// ans plus tard, son contenu sera identique à l'original (la mise en page, elle, suit la charte en vigueur :
// l'empreinte d'intégrité porte sur les données, pas sur le fichier PDF).
// Un brouillon produit le même document, filigrané « BROUILLON », sans numéro.
//
// Mise en page : voir src/utils/pdfKit.js (logo, fenêtre d'enveloppe, tableaux, pied de page légal).

const K = require('../utils/pdfKit');

const { C, L, R, W, eur, num, dateFr } = K;

const CATEGORY_LABEL = {
  services: 'Prestation de services',
  goods: 'Livraison de biens',
  mixed: 'Livraison de biens et prestation de services',
};

/**
 * inv : résultat de engine.loadInvoice() ; seller / buyer / terms viennent du
 * gel à l'émission, ou, pour un brouillon, de `preview` (voir documents.js).
 * extra : { creditedInvoiceNumber, paidCents, balanceCents }
 */
async function buildInvoicePdf(inv, preview = null, extra = {}) {
  const seller = inv.seller || preview?.seller || {};
  const buyer = inv.buyer || preview?.buyer || {};
  const terms = inv.terms || preview?.terms || {};
  const isQuote = inv.kind === 'quote';
  const isDraft = inv.status === 'draft';
  const isCredit = inv.kind === 'credit_note';
  const sign = isCredit ? -1 : 1; // un avoir s'affiche en négatif
  const kindLabel = isQuote ? 'Devis' : isCredit ? 'Avoir' : 'Facture';
  const docLabel = isDraft ? `${kindLabel} — brouillon` : `${kindLabel} ${inv.number}`;

  const { doc, done, F } = K.newDocument({
    title: isDraft ? `Brouillon — ${kindLabel.toLowerCase()}` : docLabel,
    author: seller.legalName || 'Blanchisserie Cézanne',
    subject: buyer.name ? `${kindLabel} pour ${buyer.name}` : kindLabel,
  });

  // ---------- en-tête, fenêtre, informations ----------
  const paid = !isCredit && !isQuote && !isDraft && extra.paidCents > 0 && extra.balanceCents === 0;
  K.header(doc, {
    title: kindLabel,
    number: isDraft ? null : `N° ${inv.number}`,
    chipLabel: isDraft ? 'Brouillon — sans valeur' : paid ? 'Payée' : null,
    chipTone: isDraft ? 'rust' : 'ok',
  });
  K.foldMarks(doc);
  K.senderLine(doc, seller);
  const buyerLines = [
    buyer.address,
    [buyer.postalCode, buyer.city].filter(Boolean).join(' '),
    buyer.siren ? `SIREN ${buyer.siren}` : '',
    buyer.vatNumber ? `TVA ${buyer.vatNumber}` : '',
  ];
  const addrBottom = K.addressBlock(doc, buyer.name, buyerLines);

  const quoteValidUntil = inv.valid_until || preview?.validUntil;
  const issue = inv.issue_date || (isQuote ? preview?.issueDate : null);
  const rows = [
    [isQuote ? 'Date du devis' : "Date d'émission", issue ? dateFr(issue) : "à l'émission"],
  ];
  if (isQuote && quoteValidUntil) rows.push(["Valable jusqu'au", dateFr(quoteValidUntil)]);
  if (!isCredit && !isQuote && inv.due_date) rows.push(['Échéance', dateFr(inv.due_date), true]);
  if (inv.period_start) rows.push(['Période', `${dateFr(inv.period_start)} – ${dateFr(inv.period_end)}`]);
  if (isCredit && extra.creditedInvoiceNumber) rows.push(['Rectifie la facture', extra.creditedInvoiceNumber]);
  let infoBottom = K.infoRows(doc, rows);

  // Mentions « opération » : nature, adresse de livraison si différente, motif ou référence.
  infoBottom += 8;
  infoBottom = K.labelled(doc, "Nature de l'opération", CATEGORY_LABEL[inv.operation_category] || CATEGORY_LABEL.services, L + 285, infoBottom, W - 285);
  if (buyer.deliveryAddress) infoBottom = K.labelled(doc, 'Adresse de livraison', buyer.deliveryAddress, L + 285, infoBottom + 6, W - 285);

  let y = Math.max(addrBottom + 12, infoBottom + 14, K.CONTENT_TOP);
  if (isCredit && inv.credit_reason) {
    doc.font(F.italic).fontSize(9).fillColor(C.soft).text(`Motif de l'avoir : ${inv.credit_reason}`, L, y, { width: W });
    y = doc.y + 10;
  } else if (inv.reference) {
    doc.font(F.sans).fontSize(9).fillColor(C.soft).text(`Référence : ${inv.reference}`, L, y, { width: W });
    y = doc.y + 10;
  }

  // ---------- tableau des lignes ----------
  const cols = [
    { label: 'Désignation', x: L + 8, w: 218 },
    { label: 'Qté', x: L + 212, w: 46, align: 'right' },
    { label: 'Prix unitaire HT', x: L + 262, w: 78, align: 'right' },
    { label: 'TVA', x: L + 344, w: 40, align: 'right' },
    { label: 'Total HT', x: L + 388, w: W - 396, align: 'right' },
  ];
  const descW = cols[0].w - 6;
  const continued = () => `${docLabel}  ·  ${buyer.name || ''}`;
  y = K.tableHeader(doc, cols, y);

  for (const l of inv.lines) {
    const bold = !!l.is_section;
    doc.font(bold ? F.semi : F.sans).fontSize(bold ? 8.8 : 9);
    const h = Math.max(doc.heightOfString(l.description, { width: bold ? W - 16 : descW, lineGap: 1 }), 11) + 12;
    // un intertitre ne reste jamais seul en bas de page : on exige la place de sa première ligne en plus
    if (y + h + (bold ? 34 : 0) > K.BOTTOM) { y = K.nextPage(doc, continued()); y = K.tableHeader(doc, cols, y); }
    if (bold) {
      doc.save().rect(L, y + 2, W, h - 4).fill(C.wash).restore();
      doc.font(F.semi).fontSize(8.8).fillColor(C.ink).text(l.description, L + 8, y + 6.5, { width: W - 16 });
    } else {
      doc.font(F.sans).fontSize(9).fillColor(C.ink).text(l.description, cols[0].x, y + 6, { width: descW, lineGap: 1 });
      const t = { align: 'right', lineBreak: false, features: K.TNUM };
      doc.text(num(l.quantity * sign), cols[1].x, y + 6, { width: cols[1].w, ...t });
      doc.text(num(l.unit_price, 4, 2), cols[2].x, y + 6, { width: cols[2].w, ...t });
      doc.fillColor(C.soft).text(`${num(l.vat_rate, 2)} %`, cols[3].x, y + 6, { width: cols[3].w, ...t });
      doc.font(F.semi).fillColor(C.ink).text(eur(l.line_ht_cents * sign), cols[4].x, y + 6, { width: cols[4].w, ...t });
    }
    y += h;
    K.hr(doc, y);
  }

  // ---------- totaux ----------
  const breakdown = inv.vatBreakdown && inv.vatBreakdown.length ? inv.vatBreakdown : JSON.parse(inv.vat_breakdown_json || '[]');
  const hasSettled = (extra.paidCents > 0 || extra.discountCents > 0) && !isCredit && !isDraft;
  const totalsH = Math.max(breakdown.length * 14 + 34, 104) + (hasSettled ? 34 : 0) + (hasSettled && extra.discountCents > 0 ? 14 : 0);
  if (y + 18 + totalsH > K.BOTTOM) y = K.nextPage(doc, continued());
  y += 18;
  const top = y;

  // à gauche : détail de la TVA
  const tvaX = L; const tvaW = 215;
  doc.font(F.semi).fontSize(7.8).fillColor(C.soft)
    .text('Détail de la TVA', tvaX, top, { width: tvaW, lineBreak: false });
  let ty = top + 15;
  doc.font(F.sans).fontSize(7.8).fillColor(C.mute);
  doc.text('Taux', tvaX, ty, { width: 40, lineBreak: false });
  doc.text('Base HT', tvaX + 40, ty, { width: 90, align: 'right', lineBreak: false });
  doc.text('TVA', tvaX + 135, ty, { width: tvaW - 135, align: 'right', lineBreak: false });
  ty += 12; K.hr(doc, ty - 2, { x2: tvaX + tvaW });
  doc.font(F.sans).fontSize(8.8).fillColor(C.ink);
  for (const b of breakdown) {
    doc.text(`${num(b.rate, 2)} %`, tvaX, ty + 2, { width: 40, lineBreak: false, features: K.TNUM });
    doc.text(eur(b.baseCents * sign), tvaX + 40, ty + 2, { width: 90, align: 'right', lineBreak: false, features: K.TNUM });
    doc.text(eur(b.vatCents * sign), tvaX + 135, ty + 2, { width: tvaW - 135, align: 'right', lineBreak: false, features: K.TNUM });
    ty += 14;
  }

  // à droite : totaux, puis le net à payer en grand
  const rx = L + 270; const rw = R - rx;
  const line = (label, value, yy) => {
    doc.font(F.sans).fontSize(9.5).fillColor(C.soft).text(label, rx, yy, { width: 110, lineBreak: false });
    doc.font(F.medium).fontSize(9.5).fillColor(C.ink).text(value, rx + 80, yy, { width: rw - 80, align: 'right', lineBreak: false, features: K.TNUM });
  };
  line('Total HT', eur(inv.total_ht_cents * sign), top);
  line('Total TVA', eur(inv.total_vat_cents * sign), top + 17);
  K.hr(doc, top + 38, { x1: rx, color: C.ink, width: 1.2 });
  doc.font(F.semi).fontSize(9).fillColor(C.ink)
    .text(isCredit ? 'Total TTC à déduire' : isQuote ? 'Total TTC' : 'Total TTC à payer', rx, top + 49, { width: 120, lineBreak: false });
  doc.font(F.serif).fontSize(26).fillColor(C.ink)
    .text(eur(inv.total_ttc_cents * sign), rx + 60, top + 42, { width: rw - 60, align: 'right', lineBreak: false, features: K.TNUM });
  let ry = top + 80;
  if (!isCredit && !isDraft && !isQuote && hasSettled) {
    if (extra.paidCents > 0) {
      doc.font(F.sans).fontSize(9).fillColor(C.soft)
        .text(`Déjà réglé : ${eur(extra.paidCents)}`, rx, ry, { width: rw, align: 'right', lineBreak: false, features: K.TNUM });
      ry += 14;
    }
    if (extra.discountCents > 0) {
      doc.font(F.sans).fontSize(9).fillColor(C.soft)
        .text(`Escompte accordé : ${eur(extra.discountCents)}`, rx, ry, { width: rw, align: 'right', lineBreak: false, features: K.TNUM });
      ry += 14;
    }
    doc.font(F.semi).fontSize(9.5).fillColor(extra.balanceCents > 0 ? C.ink : C.ok)
      .text(extra.balanceCents > 0 ? `Reste dû : ${eur(extra.balanceCents)}` : 'Facture soldée', rx, ry, { width: rw, align: 'right', lineBreak: false, features: K.TNUM });
    ry += 18;
  }
  y = Math.max(ty, ry) + 18;

  // ---------- règlement (facture), bon pour accord (devis) ----------
  const legal = [];
  if (isQuote) {
    if (y + 80 > K.BOTTOM) y = K.nextPage(doc, continued());
    doc.save().lineWidth(0.8).strokeColor(C.ink).roundedRect(L, y, 262, 70, 4).stroke().restore();
    doc.font(F.semi).fontSize(9).fillColor(C.ink).text('Bon pour accord', L + 12, y + 10, { width: 240, lineBreak: false });
    doc.font(F.sans).fontSize(8).fillColor(C.soft).text('Date, signature et cachet du client, précédés de la mention «\u00A0Bon pour accord\u00A0».', L + 12, y + 25, { width: 238 });
    y += 84;
    legal.push(`Devis valable jusqu'au ${dateFr(quoteValidUntil)}. Délai de paiement : ${terms.paymentTermsDays} jours à compter de la date de facture.`);
    legal.push(terms.latePenaltyText);
    legal.push(`Indemnité forfaitaire pour frais de recouvrement en cas de retard de paiement : ${eur(terms.recoveryIndemnityCents)} (art. D441-5 du Code de commerce).`);
  } else if (!isCredit) {
    if (seller.iban) {
      if (y + 74 > K.BOTTOM) y = K.nextPage(doc, continued());
      doc.save().roundedRect(L, y, W, 62, 4).fill(C.wash).restore();
      doc.save().rect(L, y, 3, 62).fill(C.brand).restore();
      doc.font(F.semi).fontSize(8.5).fillColor(C.ink).text('Règlement par virement', L + 16, y + 10, { width: 260, lineBreak: false });
      doc.font(F.sans).fontSize(7.8).fillColor(C.soft).text('IBAN', L + 16, y + 28, { width: 30, lineBreak: false });
      doc.font(F.medium).fontSize(10).fillColor(C.ink).text(K.ibanFmt(seller.iban), L + 44, y + 26.5, { width: 260, lineBreak: false, features: K.TNUM });
      if (seller.bic) {
        doc.font(F.sans).fontSize(7.8).fillColor(C.soft).text('BIC', L + 16, y + 44, { width: 30, lineBreak: false });
        doc.font(F.medium).fontSize(10).fillColor(C.ink).text(seller.bic, L + 44, y + 42.5, { width: 160, lineBreak: false });
      }
      const px = L + 300;
      doc.font(F.sans).fontSize(7.8).fillColor(C.soft).text(inv.due_date ? 'À régler avant le' : "À régler à compter de l'émission :", px, y + 12, { width: W - 316, align: 'right', lineBreak: false });
      doc.font(F.serif).fontSize(17).fillColor(C.ink).text(inv.due_date ? dateFr(inv.due_date) : `${terms.paymentTermsDays} jours`, px, y + 22, { width: W - 316, align: 'right', lineBreak: false });
      if (inv.number) doc.font(F.sans).fontSize(7.8).fillColor(C.soft).text(`Référence à indiquer : ${inv.number}`, px, y + 46, { width: W - 316, align: 'right', lineBreak: false });
      y += 76;
    }
    // Escompte pour règlement anticipé : l'offre est mise en évidence (le texte complet figure aussi dans les mentions).
    const ed = terms.earlyDiscount;
    if (ed) {
      const msg = `Escompte de ${num(ed.ratePct, 2)}\u00A0% pour tout règlement reçu au plus tard le ${dateFr(ed.deadline)} : ${eur(inv.total_ttc_cents - ed.discountTtcCents)} TTC à payer au lieu de ${eur(inv.total_ttc_cents)}.`;
      doc.font(F.semi).fontSize(9);
      const h = doc.heightOfString(msg, { width: W - 24 });
      if (y + h + 16 > K.BOTTOM) y = K.nextPage(doc, continued());
      doc.save().rect(L, y, 3, h + 8).fill(C.brand).restore();
      doc.font(F.semi).fontSize(9).fillColor(C.ink).text(msg, L + 12, y + 4, { width: W - 24 });
      y += h + 18;
    }
    legal.push(inv.due_date ? `Échéance de règlement : ${dateFr(inv.due_date)} (${terms.paymentTermsDays} jours).` : `Délai de règlement : ${terms.paymentTermsDays} jours à compter de la date d'émission.`);
    legal.push(terms.earlyPaymentDiscount);
    legal.push(terms.latePenaltyText);
    legal.push(`Indemnité forfaitaire pour frais de recouvrement en cas de retard de paiement : ${eur(terms.recoveryIndemnityCents)} (art. D441-5 du Code de commerce).`);
  } else {
    legal.push('Cet avoir vient en déduction de la facture visée ci-dessus.');
  }
  if (terms.vatOnDebits && inv.operation_category !== 'goods') legal.push("Option pour le paiement de la TVA d'après les débits.");
  if (terms.footerNote) legal.push(terms.footerNote);

  // ---------- mentions légales ----------
  const text = legal.filter(Boolean).join('\n');
  doc.font(F.sans).fontSize(7.6);
  const legalH = doc.heightOfString(text, { width: W, lineGap: 2 }) + 22;
  if (y + legalH > K.BOTTOM + 14) y = K.nextPage(doc, continued());
  doc.font(F.semi).fontSize(7.8).fillColor(C.soft).text('Conditions et mentions légales', L, y, { width: W, lineBreak: false });
  doc.font(F.sans).fontSize(7.6).fillColor(C.soft).text(text, L, y + 13, { width: W, lineGap: 2 });

  K.footers(doc, { seller, label: isDraft ? `${kindLabel} — brouillon` : docLabel, draft: isDraft });
  doc.end();
  return done;
}

module.exports = { buildInvoicePdf, eur };
