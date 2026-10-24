// PDF : chaque modèle se génère, tient dans le bon nombre de pages, embarque ses polices, et les formats sont propres.
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-pdf-'));
process.env.BACKUP_SCHEDULER = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { SAMPLES } = require('../scripts/pdf-samples');
const K = require('../src/utils/pdfKit');

test('chaque modèle de PDF se génère et a le bon nombre de pages', async () => {
  for (const [name, pages, make] of SAMPLES) {
    const buf = await make();
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-', `${name} : en-tête`);
    assert.match(buf.subarray(-16).toString(), /%%EOF/, `${name} : fin de fichier`);
    const n = (await PDFDocument.load(buf)).getPageCount();
    if (typeof pages === 'number') assert.equal(n, pages, `${name} : ${n} page(s), ${pages} attendue(s) (pas de page blanche en plus)`);
    else assert.ok(n >= parseInt(pages, 10), `${name} : ${n} page(s), au moins ${pages} attendues`);
  }
});

test('les polices sont embarquées (rendu identique partout)', async () => {
  const buf = await SAMPLES.find(([n]) => n === 'facture')[2]();
  const text = buf.toString('latin1');
  assert.match(text, /Inter/, 'police de texte');
  assert.match(text, /InstrumentSerif|Instrument/, 'police de titre');
  assert.ok(!/BaseFont\s*\/Helvetica\b/.test(text), 'pas de repli sur Helvetica quand les polices sont présentes');
});

test('formats : espaces insécables, signe moins typographique, jamais d’espace fine absente de la police', () => {
  assert.equal(K.eur(123456), '1 234,56 €');
  assert.equal(K.eur(-1200), '−12,00 €');
  assert.ok(!/[ ]/.test(K.eur(99999999) + K.num(1234567.891, 2) + K.price(12345.6)), 'U+202F absent (le glyphe manque aux polices embarquées)');
  assert.equal(K.price(1.35), '1,35 €');
  assert.equal(K.price(0.925), '0,925 €');
  assert.equal(K.num(40), '40');
  assert.equal(K.dateFr('2026-10-24'), '24/10/2026');
  assert.equal(K.dateFr('2026-10-24 08:00:00'), '24/10/2026');
  assert.equal(K.dateFr(null), '—');
  assert.equal(K.ibanFmt('FR7630001007941234567890185'), 'FR76 3000 1007 9412 3456 7890 185');
});

test('un bon de livraison sans date, sans lignes ni notes se génère quand même', async () => {
  const { buildDeliveryNotePdf } = require('../src/utils/pdf');
  const buf = await buildDeliveryNotePdf({ ticket: 'X-1', status: 'recue', societe: 'Hôtel Test', contact: '', tel: '', adresse: '', livraison_prevue: null, notes: null, items: [] });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await PDFDocument.load(buf)).getPageCount(), 1);
});
