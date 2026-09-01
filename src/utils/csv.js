// Parseur CSV minimal, sans dépendance externe (npm indisponible dans
// l'environnement de développement au moment d'écrire ceci — préférable
// à une bibliothèque que je ne peux pas tester réellement). Gère les
// champs entre guillemets (avec virgules ou guillemets échappés à
// l'intérieur), le séparateur point-virgule ou virgule (Excel français
// exporte souvent en ;), et les fins de ligne \r\n ou \n.
//
// Renvoie { headers: string[], rows: object[] } — rows sont déjà mappées
// sur les en-têtes (première ligne), pas de tableaux positionnels à
// gérer côté appelant.
function detectDelimiter(sample) {
  const firstLine = sample.split(/\r\n|\n/)[0] || '';
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function parseCsv(text) {
  // Retire le BOM UTF-8 éventuel (Excel l'ajoute systématiquement).
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(clean);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  function pushField() { row.push(field); field = ''; }
  function pushRow() { pushField(); rows.push(row); row = []; }

  while (i < clean.length) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === delimiter) { pushField(); i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { pushRow(); i += 1; continue; }
    field += c; i += 1;
  }
  // Dernière ligne sans retour final.
  if (field.length > 0 || row.length > 0) pushRow();

  const nonEmptyRows = rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
  if (nonEmptyRows.length === 0) return { headers: [], rows: [] };

  const headers = nonEmptyRows[0].map(h => h.trim());
  const dataRows = nonEmptyRows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
  return { headers, rows: dataRows };
}

module.exports = { parseCsv };
