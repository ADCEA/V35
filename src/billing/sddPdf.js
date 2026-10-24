// Formulaire de mandat de prélèvement SEPA, à faire signer par l'hôtel (charte commune des PDF).
//
// Les mentions « autorisation » et « droits du débiteur » reprennent le texte du modèle de mandat européen (EPC) :
// elles ne se reformulent pas, la banque du client les reconnaît telles quelles. Deux versions : CORE (remboursement
// possible 8 semaines) et B2B (entreprises : pas de remboursement après débit, mandat à confirmer auprès de sa banque).

const K = require('../utils/pdfKit');

const { C, L, R, W } = K;

const CORE_RIGHTS = "Vos droits concernant le présent mandat sont expliqués dans un document que vous pouvez obtenir auprès de votre banque. Vous bénéficiez du droit d'être remboursé par votre banque selon les conditions décrites dans la convention que vous avez passée avec elle. Toute demande de remboursement doit être présentée dans un délai de 8 semaines à compter de la date de débit de votre compte pour un prélèvement autorisé.";
const B2B_RIGHTS = "Ce mandat est destiné uniquement aux transactions entre entreprises. Vous n'avez pas droit à un remboursement de votre banque après l'exécution du débit de votre compte, mais vous avez le droit de demander à votre banque de ne pas débiter votre compte jusqu'à la date d'échéance convenue. Vous devez faire confirmer ce mandat auprès de votre banque avant le premier prélèvement.";

/**
 * data : { umr, scheme ('CORE'|'B2B'), creditor: { name, address, ics }, debtor: { name, contact, lines: [...] },
 *          iban?, bic?, signedOn? (mandat déjà enregistré) }
 */
async function buildMandateFormPdf(data) {
  const seller = K.brandSeller();
  const { doc, done, F } = K.newDocument({ title: `Mandat de prélèvement SEPA ${data.umr}`, subject: data.debtor.name });
  const b2b = data.scheme === 'B2B';

  K.header(doc, { title: 'Mandat SEPA', number: `RUM ${data.umr}`, chipLabel: b2b ? 'Interentreprises (B2B)' : 'Prélèvement SEPA Core', chipTone: 'soft' });
  K.foldMarks(doc);
  K.senderLine(doc, seller);
  const addrBottom = K.addressBlock(doc, data.debtor.name, [data.debtor.contact ? `À l'attention de ${data.debtor.contact}` : '', ...(data.debtor.lines || [])]);
  const infoBottom = K.infoRows(doc, [
    ['Mandat (RUM)', data.umr, true],
    ['ICS créancier', data.creditor.ics],
    ['Paiement', 'Récurrent'],
  ]);
  let y = Math.max(addrBottom + 26, infoBottom + 28);

  // ---------- autorisation ----------
  const label = (t, x, yy, w) => doc.font(F.semi).fontSize(8.6).fillColor(C.soft).text(t, x, yy, { width: w, lineBreak: false });
  label('Autorisation', L, y, 200); y += 14;
  const auth = `En signant ce formulaire de mandat, vous autorisez (A) ${data.creditor.name} à envoyer des instructions à votre banque pour débiter votre compte, et (B) votre banque à débiter votre compte conformément aux instructions de ${data.creditor.name}.`;
  doc.font(F.sans).fontSize(9.2).fillColor(C.ink).text(auth, L, y, { width: W, lineGap: 2 });
  y = doc.y + 6;
  doc.font(F.sans).fontSize(8.4).fillColor(C.soft).text(b2b ? B2B_RIGHTS : CORE_RIGHTS, L, y, { width: W, lineGap: 1.8 });
  y = doc.y + 18;

  // ---------- champs ----------
  const field = (name, value, x, yy, w) => {
    doc.font(F.sans).fontSize(7.8).fillColor(C.mute).text(name, x, yy, { width: w, lineBreak: false });
    if (value) K.fitText(doc, String(value), x, yy + 12, w, 10, C.ink, F.medium);
    K.hr(doc, yy + 28, { x1: x, x2: x + w, color: value ? C.rule : C.mute });
    return yy + 40;
  };
  const half = (W - 20) / 2;

  label('Titulaire du compte à débiter', L, y, 260); y += 15;
  y = field('Nom ou raison sociale', data.debtor.name, L, y, W);
  y = field('Adresse', (data.debtor.lines || []).filter(Boolean).join(', '), L, y, W);
  y = field('IBAN', data.iban ? K.ibanFmt(data.iban) : '', L, y, W);
  y = field('BIC', data.bic || '', L, y, half);
  y += 4;

  label('Créancier', L, y, 260); y += 15;
  const cy = y;
  y = field('Nom', data.creditor.name, L, cy, half);
  field('Identifiant créancier (ICS)', data.creditor.ics, L + half + 20, cy, half);
  y = field('Adresse', data.creditor.address, L, y, W);
  y += 2;

  // ---------- type de paiement, lieu, date, signature ----------
  const cb = (x, yy, text, checked) => {
    K.checkbox(doc, x, yy, 11);
    if (checked) doc.save().lineWidth(1.6).strokeColor(C.ink).moveTo(x + 2.5, yy + 5.8).lineTo(x + 4.8, yy + 8.4).lineTo(x + 9, yy + 2.6).stroke().restore();
    doc.font(F.sans).fontSize(9.2).fillColor(C.ink).text(text, x + 18, yy + 1.2, { width: 130, lineBreak: false });
  };
  label('Type de paiement', L, y, 200);
  cb(L + 130, y - 2, 'Paiement récurrent', true);
  cb(L + 280, y - 2, 'Paiement ponctuel', false);
  y += 26;

  const bw = (W - 16) / 2;
  const boxY = y;
  doc.save().lineWidth(0.8).strokeColor(C.ink).roundedRect(L, boxY, bw, 92, 4).stroke().restore();
  doc.font(F.semi).fontSize(9).fillColor(C.ink).text('Lieu et date', L + 12, boxY + 10, { width: bw - 24, lineBreak: false });
  if (data.signedOn) doc.font(F.medium).fontSize(10).fillColor(C.ink).text(`Signé le ${K.dateFr(data.signedOn)}`, L + 12, boxY + 28, { width: bw - 24, lineBreak: false });
  doc.font(F.sans).fontSize(7.6).fillColor(C.mute).text('Fait à …………………………………   le ……… / ……… / …………', L + 12, boxY + 70, { width: bw - 24, lineBreak: false });
  const x2 = L + bw + 16;
  doc.save().lineWidth(0.8).strokeColor(C.ink).roundedRect(x2, boxY, bw, 92, 4).stroke().restore();
  doc.font(F.semi).fontSize(9).fillColor(C.ink).text('Signature du titulaire', x2 + 12, boxY + 10, { width: bw - 24, lineBreak: false });
  doc.font(F.sans).fontSize(7.6).fillColor(C.mute).text('Nom, qualité du signataire et cachet', x2 + 12, boxY + 23, { width: bw - 24, lineBreak: false });
  y = boxY + 108;

  doc.font(F.italic).fontSize(8.2).fillColor(C.soft)
    .text(`Merci de retourner ce mandat signé, accompagné d'un relevé d'identité bancaire (RIB), à ${data.creditor.name}${data.creditor.address ? ` — ${data.creditor.address}` : ''}. Les données de ce formulaire ne servent qu'à la gestion des prélèvements ; vous pouvez en demander la rectification à tout moment.`,
      L, y, { width: W, lineGap: 1.5 });

  K.footers(doc, { seller, label: `Mandat SEPA ${data.umr}` });
  doc.end();
  return done;
}

module.exports = { buildMandateFormPdf };
