// Charte graphique commune de tous les PDF (factures, avoirs, devis, bons de livraison, bons de préparation, annexes).
//
// Principes :
//  - un papier à en-tête sobre : logo Cézanne à gauche, titre du document en serif à droite, filet bleu en haut de page ;
//  - l'adresse du destinataire est placée à l'emplacement normalisé de la fenêtre d'enveloppe (NF Z 10-011 / DIN 5008 B),
//    avec les repères de pliage dans la marge gauche : le document peut partir tel quel sous enveloppe à fenêtre ;
//  - texte en Inter (chiffres tabulaires dans les tableaux), titres en Instrument Serif : polices embarquées dans le dépôt
//    (src/assets/fonts), donc rendu identique sur toutes les machines ;
//  - lisible en noir et blanc : la couleur n'est qu'un renfort, jamais le seul porteur d'information ;
//  - pied de page légal sur chaque page (identité de la société), pagination « page n/N ».
//
// Si les polices manquent, on retombe sur Helvetica : un PDF est toujours produit.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'img', 'logo.png');
const FONT_FILES = {
  sans: 'inter-latin-400-normal.woff',
  medium: 'inter-latin-500-normal.woff',
  semi: 'inter-latin-600-normal.woff',
  bold: 'inter-latin-700-normal.woff',
  italic: 'inter-latin-400-italic.woff',
  serif: 'instrument-serif-latin-400-normal.woff',
  serifItalic: 'instrument-serif-latin-400-italic.woff',
};
const FALLBACK = { sans: 'Helvetica', medium: 'Helvetica', semi: 'Helvetica-Bold', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', serif: 'Times-Roman', serifItalic: 'Times-Italic' };

// Palette : un encre bleu nuit, des gris bleutés, le bleu de la marque (logo) en filet et en accent.
const C = {
  ink: '#13283E', soft: '#566879', mute: '#8795A4', rule: '#D6DDE4', wash: '#F2F5F8',
  brand: '#1D91FF', brandDeep: '#0E5DB0', rust: '#C0392B', ok: '#1B7A5A',
};

// Page A4 en points ; marges de 20 mm. La fenêtre d'enveloppe (forme B) démarre à 45 mm du haut.
const PAGE_W = 595.28; const PAGE_H = 841.89;
const L = 56.7; const R = PAGE_W - 56.7; const W = R - L;
const WINDOW_TOP = 127.6;            // 45 mm
const CONTENT_TOP = 272;             // sous la fenêtre (45 mm + 45 mm) et l'encadré d'informations
const BOTTOM = 762;                  // au-delà : saut de page (le pied de page occupe le bas)
const NBSP = ' ';

// ---------- formats ----------
const clean = (s) => String(s).replace(/[  ]/g, NBSP).replace(/^-/, '−');
const eur = (cents) => clean((cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + NBSP + '€';
const num = (n, max = 4, min = 0) => clean(Number(n).toLocaleString('fr-FR', { minimumFractionDigits: min, maximumFractionDigits: max }));
const price = (p) => num(p, 3, 2) + NBSP + '€';
const dateFr = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—');
const ibanFmt = (s) => String(s || '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
const TNUM = ['tnum'];

// ---------- ressources ----------
let fonts = null; let logo;
function loadFonts() {
  if (fonts) return fonts;
  fonts = {};
  try { for (const [k, f] of Object.entries(FONT_FILES)) fonts[k] = fs.readFileSync(path.join(FONT_DIR, f)); } catch (_) { fonts = false; }
  return fonts;
}
function loadLogo() {
  if (logo === undefined) { try { logo = fs.readFileSync(LOGO_PATH); } catch (_) { logo = false; } }
  return logo;
}

/** Société émettrice (fiche de la Facturation), pour l'en-tête et le pied de page des documents sans vendeur figé. */
function brandSeller() {
  try {
    const engine = require('../billing/engine');
    return engine.snapshotSeller(engine.getSettings());
  } catch (_) { return null; }
}

/** Crée le document : polices, pages, flux. `done` résout avec le Buffer une fois doc.end() appelé. */
function newDocument({ title, author = 'Blanchisserie Cézanne', subject = '' }) {
  const doc = new PDFDocument({
    size: 'A4', margins: { top: 0, bottom: 0, left: L, right: L }, bufferPages: true,
    info: { Title: title, Author: author, Subject: subject, Creator: 'Blanchisserie Cézanne' },
  });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const buffers = loadFonts();
  const F = {};
  for (const k of Object.keys(FONT_FILES)) {
    if (buffers) { doc.registerFont(`cz-${k}`, buffers[k]); F[k] = `cz-${k}`; } else F[k] = FALLBACK[k];
  }
  doc.F = F;
  return { doc, done, F };
}

// ---------- éléments de page ----------
/** Filet bleu pleine largeur en haut de chaque page. */
function band(doc) { doc.save().rect(0, 0, PAGE_W, 5).fill(C.brand).restore(); }

/** Repères de pliage (105 mm et 210 mm) et de perforation (148,5 mm) dans la marge gauche. */
function foldMarks(doc) {
  doc.save().strokeColor(C.mute).lineWidth(0.5);
  for (const y of [297.6, 595.3]) doc.moveTo(0, y).lineTo(12, y).stroke();
  doc.moveTo(0, 421.3).lineTo(6, 421.3).stroke();
  doc.restore();
}

function hr(doc, y, { x1 = L, x2 = R, color = C.rule, width = 0.5, dash } = {}) {
  doc.save().strokeColor(color).lineWidth(width);
  if (dash) doc.dash(dash, { space: dash });
  doc.moveTo(x1, y).lineTo(x2, y).stroke().undash().restore();
}

/** Pastille de statut : contour + texte (lisible sans couleur). Renvoie sa largeur. */
function chip(doc, label, xRight, y, tone = 'ink') {
  const col = { ink: C.ink, rust: C.rust, ok: C.ok, soft: C.soft }[tone] || C.ink;
  doc.font(doc.F.semi).fontSize(8);
  const w = doc.widthOfString(label) + 18;
  doc.save().lineWidth(0.9).strokeColor(col).roundedRect(xRight - w, y, w, 17, 8.5).stroke().restore();
  doc.fillColor(col).text(label, xRight - w, y + 4.8, { width: w, align: 'center', lineBreak: false });
  return w;
}

/**
 * En-tête de première page : logo à gauche ; à droite le titre en serif, le numéro et une pastille de statut.
 * Renvoie le y sous l'en-tête.
 */
function header(doc, { title, number, chipLabel, chipTone }) {
  band(doc);
  const lg = loadLogo();
  if (lg) doc.image(lg, L, 27, { width: 138 });
  else doc.font(doc.F.serif).fontSize(24).fillColor(C.brand).text('Cézanne', L, 30, { lineBreak: false });
  doc.font(doc.F.serif).fontSize(34).fillColor(C.ink).text(title, L + 180, 26, { width: W - 180, align: 'right', lineBreak: false });
  let y = 68;
  if (number) { doc.font(doc.F.semi).fontSize(11).fillColor(C.ink).text(number, L + 180, y, { width: W - 180, align: 'right', lineBreak: false }); y += 19; }
  if (chipLabel) chip(doc, chipLabel, R, y, chipTone);
  return 118;
}

/** En-tête réduit des pages suivantes. Renvoie le y où reprendre. */
function continuationHeader(doc, label) {
  band(doc);
  const lg = loadLogo();
  if (lg) doc.image(lg, L, 20, { width: 64 });
  doc.font(doc.F.medium).fontSize(8.5).fillColor(C.soft).text(label, L + 80, 27, { width: W - 80, align: 'right', lineBreak: false });
  hr(doc, 52);
  return 66;
}

/** Ligne expéditeur minuscule au-dessus de la fenêtre, comme sur un courrier normalisé. */
function senderLine(doc, seller) {
  if (!seller) return;
  const s = [seller.legalName, seller.address, [seller.postalCode, seller.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  fitText(doc, s, L, WINDOW_TOP - 9, 245, 6.8, C.mute);
  hr(doc, WINDOW_TOP + 1, { x2: L + 245 });
}

/** Bloc destinataire dans la fenêtre : nom en évidence puis lignes d'adresse. Renvoie le y final. */
function addressBlock(doc, name, lines) {
  doc.font(doc.F.semi).fontSize(11.5).fillColor(C.ink).text(name || '', L, WINDOW_TOP + 11, { width: 245 });
  doc.font(doc.F.sans).fontSize(9.5).fillColor(C.ink).text(lines.filter(Boolean).join('\n'), L, doc.y + 2, { width: 245, lineGap: 1.5 });
  return doc.y;
}

/** Encadré d'informations à droite de la fenêtre : libellé à gauche, valeur à droite, un filet entre chaque ligne. */
function infoRows(doc, rows, { x = L + 285, y = WINDOW_TOP + 2, w = W - 285 } = {}) {
  for (const [label, value, strong] of rows) {
    if (value === undefined || value === null || value === '') continue;
    doc.font(doc.F.sans).fontSize(8.5).fillColor(C.soft).text(label, x, y + 4.5, { width: w * 0.5, lineBreak: false });
    doc.font(strong ? doc.F.semi : doc.F.medium).fontSize(9).fillColor(C.ink)
      .text(String(value), x + w * 0.38, y + 4, { width: w * 0.62, align: 'right', lineBreak: false, features: TNUM });
    y += 20;
    hr(doc, y, { x1: x, x2: x + w });
  }
  return y;
}

/** Petit libellé (casse de phrase, gris) suivi d'un texte ; renvoie le y final. */
function labelled(doc, label, text, x, y, w) {
  doc.font(doc.F.sans).fontSize(8).fillColor(C.mute).text(label, x, y, { width: w, lineBreak: false });
  doc.font(doc.F.medium).fontSize(9).fillColor(C.ink).text(text, x, y + 11, { width: w, lineGap: 1 });
  return doc.y;
}

/** Bandeau de repères (client, période, nombre de bons…) en cellules séparées par un filet. cells : [[libellé, valeur]]. Renvoie le y sous le bandeau. */
function metaBand(doc, y, cells) {
  const h = 46; const cw = W / cells.length;
  doc.save().roundedRect(L, y, W, h, 4).fill(C.wash).restore();
  cells.forEach(([label, value], i) => {
    const x = L + i * cw + 14;
    if (i > 0) doc.save().strokeColor(C.rule).lineWidth(0.6).moveTo(L + i * cw, y + 9).lineTo(L + i * cw, y + h - 9).stroke().restore();
    doc.font(doc.F.sans).fontSize(7.8).fillColor(C.soft).text(label, x, y + 9, { width: cw - 22, lineBreak: false });
    fitText(doc, String(value), x, y + 22, cw - 24, 10, C.ink, doc.F.semi, { features: TNUM });
  });
  return y + h;
}

/** En-tête de tableau : bandeau gris clair, libellés en semi-gras. cols : [{ label, x, w, align }]. */
function tableHeader(doc, cols, y) {
  doc.save().rect(L, y, W, 21).fill(C.wash).restore();
  hr(doc, y + 21, { color: C.ink, width: 0.8 });
  doc.font(doc.F.semi).fontSize(7.8).fillColor(C.soft);
  for (const c of cols) doc.text(c.label, c.x, y + 7, { width: c.w, align: c.align || 'left', lineBreak: false });
  return y + 21;
}

// ---------- pages suivantes, pied de page, filigrane ----------
/** Texte sur une seule ligne, dont la taille est réduite (jusqu'à 5,5 pt) pour tenir dans la largeur donnée. */
function fitText(doc, text, x, y, maxW, size, color, font = doc.F.sans, opts = {}) {
  let sz = size;
  doc.font(font);
  doc.fontSize(sz);
  while (sz > 5.5 && doc.widthOfString(text) > maxW) { sz -= 0.2; doc.fontSize(sz); }
  doc.fillColor(color).text(text, x, y, { width: maxW + 2, lineBreak: false, ...opts });
}

/** Pied de page sur chaque page : identité légale de la société, mention de document, pagination. */
function footers(doc, { seller, label, draft = false }) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (draft) {
      doc.save().rotate(-35, { origin: [PAGE_W / 2, PAGE_H / 2] }).font(doc.F.semi).fontSize(78).fillColor(C.rust).fillOpacity(0.09)
        .text('BROUILLON', 0, PAGE_H / 2 - 44, { width: PAGE_W, align: 'center', lineBreak: false }).restore();
      doc.fillOpacity(1);
    }
    hr(doc, 790);
    if (seller) {
      const l1 = [seller.legalName, [seller.address, [seller.postalCode, seller.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join('  ·  ');
      const l2 = [[seller.legalForm, seller.shareCapital ? `au capital de ${seller.shareCapital}` : ''].filter(Boolean).join(' '),
        seller.siren ? `SIREN ${seller.siren}` : '', seller.rcs, seller.vatNumber ? `TVA ${seller.vatNumber}` : ''].filter(Boolean).join('  ·  ');
      const l3 = [seller.phone, seller.email].filter(Boolean).join('  ·  ');
      [l1, l2, l3].filter(Boolean).forEach((t, i) => fitText(doc, t, L, 797 + i * 9.5, W - 140, 6.8, C.mute));
    }
    doc.font(doc.F.medium).fontSize(7.2).fillColor(C.soft)
      .text(`${label ? label + '  ·  ' : ''}page ${i - range.start + 1}/${range.count}`, R - 200, 797, { width: 200, align: 'right', lineBreak: false });
  }
}

/** Passe à la page suivante ; renvoie le y de reprise. */
function nextPage(doc, label) { doc.addPage(); return continuationHeader(doc, label); }

/** Case à cocher à remplir à la main. */
function checkbox(doc, x, y, size = 11) { doc.save().lineWidth(1).strokeColor(C.ink).roundedRect(x, y, size, size, 1.5).stroke().restore(); }

/** Jauge horizontale (taux de remplissage). */
function gauge(doc, x, y, w, ratio, tone = C.brand) {
  const r = Math.max(0, Math.min(1, ratio || 0));
  doc.save().roundedRect(x, y, w, 5, 2.5).fill(C.rule).restore();
  if (r > 0) doc.save().roundedRect(x, y, Math.max(5, w * r), 5, 2.5).fill(tone).restore();
}

/** Triangle d'alerte dessiné (le glyphe ⚠ n'existe pas dans les polices). */
function alertIcon(doc, x, y, size, color = C.rust) {
  doc.save().lineWidth(1.2).strokeColor(color).lineJoin('round')
    .moveTo(x + size / 2, y).lineTo(x + size, y + size * 0.9).lineTo(x, y + size * 0.9).closePath().stroke();
  doc.rect(x + size / 2 - 0.6, y + size * 0.3, 1.2, size * 0.32).fill(color);
  doc.rect(x + size / 2 - 0.6, y + size * 0.7, 1.2, 1.2).fill(color);
  doc.restore();
}

module.exports = {
  C, L, R, W, PAGE_W, PAGE_H, WINDOW_TOP, CONTENT_TOP, BOTTOM, NBSP, TNUM,
  eur, num, price, dateFr, ibanFmt,
  newDocument, brandSeller, band, foldMarks, hr, chip, header, continuationHeader, senderLine, addressBlock,
  infoRows, labelled, metaBand, tableHeader, fitText, footers, nextPage, checkbox, gauge, alertIcon,
};
