// PDF d'une facture ou d'un avoir de la facturation intégrée.
//
// Le document est produit UNIQUEMENT à partir de ce qui a été figé à
// l'émission (vendeur, acheteur, conditions, lignes, totaux) : régénéré dix
// ans plus tard, il sera identique à l'original.
// Un brouillon produit le même document, filigrané « BROUILLON — sans valeur
// de facture », sans numéro.

const PDFDocument = require('pdfkit');

const INK = '#16324F';
const GRAY = '#64798D';
const LINE = '#B9C4CE';
const ACCENT = '#1D91FF';
const RUST = '#E0574B';

const eur = (cents) => (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[  ]/g, ' ') + ' €';
const num = (n, max = 4) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: max }).replace(/[  ]/g, ' ');
const dateFr = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—');

const CATEGORY_LABEL = {
  services: 'Prestation de services',
  goods: 'Livraison de biens',
  mixed: 'Livraison de biens et prestation de services',
};

/**
 * inv : résultat de engine.loadInvoice() ; seller / buyer / terms viennent du
 * gel à l'émission, ou, pour un brouillon, de `preview` (voir routes).
 * extra : { creditedInvoiceNumber, paidCents, balanceCents }
 */
function buildInvoicePdf(inv, preview = null, extra = {}) {
  return new Promise((resolve, reject) => {
    const seller = inv.seller || preview?.seller;
    const buyer = inv.buyer || preview?.buyer;
    const terms = inv.terms || preview?.terms;
    const isDraft = inv.status === 'draft';
    const isCredit = inv.kind === 'credit_note';
    const sign = isCredit ? -1 : 1; // un avoir s'affiche en négatif

    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: {
      Title: isDraft ? 'Brouillon' : `${isCredit ? 'Avoir' : 'Facture'} ${inv.number}`,
      Author: seller?.legalName || 'Blanchisserie Cézanne',
    } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;
    const bottomLimit = () => doc.page.height - 95; // réserve pour le pied de page

    // ---------- en-tête vendeur ----------
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(15).text(seller.legalName || '', left, 45, { width: width * 0.55 });
    doc.font('Helvetica').fontSize(8.5).fillColor(GRAY);
    const sellerLines = [
      [seller.legalForm, seller.shareCapital ? `au capital de ${seller.shareCapital}` : null].filter(Boolean).join(' '),
      seller.address,
      [seller.postalCode, seller.city].filter(Boolean).join(' '),
      seller.siren ? `SIREN ${seller.siren}${seller.siret ? ` — SIRET ${seller.siret}` : ''}` : (seller.siret ? `SIRET ${seller.siret}` : ''),
      seller.rcs,
      seller.vatNumber ? `TVA intracommunautaire ${seller.vatNumber}` : '',
      [seller.email, seller.phone].filter(Boolean).join(' — '),
    ].filter(Boolean);
    doc.text(sellerLines.join('\n'), left, doc.y + 2, { width: width * 0.55, lineGap: 1 });
    const sellerBottom = doc.y;

    // ---------- titre + numéro (à droite) ----------
    const title = isCredit ? 'AVOIR' : 'FACTURE';
    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text(title, left + width * 0.6, 45, { width: width * 0.4, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(isDraft ? RUST : INK)
      .text(isDraft ? 'BROUILLON — sans valeur' : `N° ${inv.number}`, left + width * 0.6, doc.y + 2, { width: width * 0.4, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(GRAY);
    const meta = [];
    meta.push(`Date d'émission : ${dateFr(inv.issue_date)}`);
    if (!isCredit && inv.due_date) meta.push(`Échéance : ${dateFr(inv.due_date)}`);
    if (inv.period_start) meta.push(`Période : ${dateFr(inv.period_start)} au ${dateFr(inv.period_end)}`);
    if (isCredit && extra.creditedInvoiceNumber) meta.push(`Rectifie la facture ${extra.creditedInvoiceNumber}`);
    doc.text(meta.join('\n'), left + width * 0.6, doc.y + 4, { width: width * 0.4, align: 'right', lineGap: 1 });

    let y = Math.max(sellerBottom, doc.y) + 14;
    doc.save().strokeColor(ACCENT).lineWidth(1.5).moveTo(left, y).lineTo(right, y).stroke().restore();
    y += 14;

    // ---------- bloc client ----------
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('FACTURÉ À', left, y, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(buyer.name || '', left, y + 12, { width: width * 0.55 });
    doc.font('Helvetica').fontSize(9).fillColor(INK);
    const buyerLines = [
      buyer.address,
      [buyer.postalCode, buyer.city].filter(Boolean).join(' '),
      buyer.siren ? `SIREN ${buyer.siren}` : '',
      buyer.vatNumber ? `TVA ${buyer.vatNumber}` : '',
    ].filter(Boolean);
    doc.text(buyerLines.join('\n'), left, doc.y + 1, { width: width * 0.55, lineGap: 1 });
    const buyerBottom = doc.y;

    // Mentions « opération » à droite : catégorie + adresse de livraison si différente.
    doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('NATURE DE L\'OPÉRATION', left + width * 0.6, y, { characterSpacing: 1, width: width * 0.4 });
    doc.font('Helvetica').fontSize(9).fillColor(INK)
      .text(CATEGORY_LABEL[inv.operation_category] || CATEGORY_LABEL.services, left + width * 0.6, y + 12, { width: width * 0.4 });
    if (buyer.deliveryAddress) {
      doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('ADRESSE DE LIVRAISON', left + width * 0.6, doc.y + 6, { characterSpacing: 1, width: width * 0.4 });
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(buyer.deliveryAddress, left + width * 0.6, doc.y + 2, { width: width * 0.4 });
    }
    y = Math.max(buyerBottom, doc.y) + 10;

    if (isCredit && inv.credit_reason) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(GRAY).text(`Motif : ${inv.credit_reason}`, left, y, { width });
      y = doc.y + 6;
    } else if (inv.reference) {
      doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(`Référence : ${inv.reference}`, left, y, { width });
      y = doc.y + 6;
    }
    y += 6;

    // ---------- tableau des lignes ----------
    const col = { desc: left, qty: left + 255, pu: left + 310, vat: left + 385, total: left + 430 };
    const colW = { desc: 245, qty: 50, pu: 70, vat: 40, total: width - 430 };

    function tableHeader(atY) {
      doc.save().rect(left, atY, width, 18).fill('#EEF3F8').restore();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK);
      doc.text('Désignation', col.desc + 4, atY + 5, { width: colW.desc });
      doc.text('Qté', col.qty, atY + 5, { width: colW.qty, align: 'right' });
      doc.text('PU HT', col.pu, atY + 5, { width: colW.pu, align: 'right' });
      doc.text('TVA', col.vat, atY + 5, { width: colW.vat, align: 'right' });
      doc.text('Total HT', col.total, atY + 5, { width: colW.total - 4, align: 'right' });
      return atY + 22;
    }
    y = tableHeader(y);

    for (const l of inv.lines) {
      const h = doc.font(l.is_section ? 'Helvetica-Bold' : 'Helvetica').fontSize(l.is_section ? 8.5 : 9)
        .heightOfString(l.description, { width: colW.desc - 4 }) + 6;
      if (y + h > bottomLimit()) {
        doc.addPage();
        y = tableHeader(50);
      }
      if (l.is_section) {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY).text(l.description, col.desc + 4, y + 2, { width: width - 8 });
      } else {
        doc.font('Helvetica').fontSize(9).fillColor(INK);
        doc.text(l.description, col.desc + 4, y + 2, { width: colW.desc - 4 });
        doc.text(num(l.quantity * sign), col.qty, y + 2, { width: colW.qty, align: 'right' });
        doc.text(num(l.unit_price), col.pu, y + 2, { width: colW.pu, align: 'right' });
        doc.text(`${num(l.vat_rate, 2)} %`, col.vat, y + 2, { width: colW.vat, align: 'right' });
        doc.text(eur(l.line_ht_cents * sign), col.total, y + 2, { width: colW.total - 4, align: 'right' });
      }
      y += h;
      doc.save().strokeColor(LINE).lineWidth(0.4).moveTo(left, y - 2).lineTo(right, y - 2).stroke().restore();
    }

    // ---------- totaux ----------
    const breakdown = inv.vatBreakdown && inv.vatBreakdown.length ? inv.vatBreakdown : JSON.parse(inv.vat_breakdown_json || '[]');
    const blockH = 20 + breakdown.length * 13 + 60;
    if (y + blockH > bottomLimit()) { doc.addPage(); y = 50; }
    y += 8;
    const tx = left + 250;
    const tw = right - tx;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY);
    doc.text('Taux', tx, y, { width: 40 }); doc.text('Base HT', tx + 40, y, { width: 70, align: 'right' }); doc.text('TVA', tx + 115, y, { width: tw - 115, align: 'right' });
    y += 13;
    doc.font('Helvetica').fontSize(9).fillColor(INK);
    for (const b of breakdown) {
      doc.text(`${num(b.rate, 2)} %`, tx, y, { width: 40 });
      doc.text(eur(b.baseCents * sign), tx + 40, y, { width: 70, align: 'right' });
      doc.text(eur(b.vatCents * sign), tx + 115, y, { width: tw - 115, align: 'right' });
      y += 13;
    }
    y += 4;
    doc.save().strokeColor(LINE).lineWidth(0.6).moveTo(tx, y).lineTo(right, y).stroke().restore();
    y += 6;
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    doc.text('Total HT', tx, y, { width: 100 }); doc.text(eur(inv.total_ht_cents * sign), tx + 100, y, { width: tw - 100, align: 'right' }); y += 14;
    doc.text('Total TVA', tx, y, { width: 100 }); doc.text(eur(inv.total_vat_cents * sign), tx + 100, y, { width: tw - 100, align: 'right' }); y += 16;
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK);
    doc.text(isCredit ? 'Total TTC à déduire' : 'Total TTC à payer', tx, y, { width: 130 });
    doc.text(eur(inv.total_ttc_cents * sign), tx + 120, y, { width: tw - 120, align: 'right' });
    y += 22;
    if (!isCredit && !isDraft && extra.paidCents > 0) {
      doc.font('Helvetica').fontSize(9).fillColor(GRAY);
      doc.text(`Déjà réglé : ${eur(extra.paidCents)} — reste dû : ${eur(extra.balanceCents)}`, tx, y, { width: tw, align: 'right' });
      y += 14;
    }

    // ---------- conditions de règlement et mentions légales ----------
    const legal = [];
    if (!isCredit) {
      legal.push(`Échéance de règlement : ${dateFr(inv.due_date)} (${terms.paymentTermsDays} jours).`);
      if (seller.iban) legal.push(`Règlement par virement — IBAN ${seller.iban}${seller.bic ? ` — BIC ${seller.bic}` : ''}.`);
      legal.push(terms.earlyPaymentDiscount);
      legal.push(terms.latePenaltyText);
      legal.push(`Indemnité forfaitaire pour frais de recouvrement en cas de retard de paiement : ${eur(terms.recoveryIndemnityCents)} (art. D441-5 du Code de commerce).`);
    } else {
      legal.push('Cet avoir vient en déduction de la facture visée ci-dessus.');
    }
    if (terms.vatOnDebits && inv.operation_category !== 'goods') legal.push("Option pour le paiement de la TVA d'après les débits.");
    if (terms.footerNote) legal.push(terms.footerNote);

    doc.font('Helvetica').fontSize(7.8).fillColor(GRAY);
    const legalH = doc.heightOfString(legal.join('\n'), { width }) + 10;
    if (y + legalH > doc.page.height - 50) { doc.addPage(); y = 50; }
    y += 6;
    doc.save().strokeColor(LINE).lineWidth(0.4).moveTo(left, y).lineTo(right, y).stroke().restore();
    doc.text(legal.join('\n'), left, y + 6, { width, lineGap: 1.5 });

    // ---------- filigrane brouillon + pied de page sur chaque page ----------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // le pied de page est sous la marge : sans ça pdfkit ajoute une page vide
      if (isDraft) {
        doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] })
          .font('Helvetica-Bold').fontSize(70).fillColor(RUST).fillOpacity(0.10)
          .text('BROUILLON', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false }).restore();
      }
      doc.font('Helvetica').fontSize(7).fillColor(GRAY).fillOpacity(1)
        .text(`${isDraft ? 'Brouillon' : inv.number} — page ${i - range.start + 1}/${range.count}`, left, doc.page.height - 32, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { buildInvoicePdf, eur };
