// Rapprochement bancaire assisté : on importe le relevé (CSV exporté de la banque),
// le logiciel propose pour chaque encaissement la ou les factures concernées,
// l'utilisateur valide, et les règlements sont enregistrés.
//
// Rien n'est enregistré sans validation. Une empreinte par ligne de relevé empêche
// d'enregistrer deux fois le même encaissement si le fichier est réimporté.

const crypto = require('crypto');
const db = require('../db');
const engine = require('./engine');
const queries = require('./queries');
const escompte = require('./escompte');

const { BillingError } = engine;

/** Modes de règlement acceptés (mêmes valeurs que engine.recordPayment). */
const METHODS = ['virement', 'cheque', 'prelevement', 'carte', 'especes', 'autre'];

/**
 * Devine le mode de règlement d'après le libellé de la banque : « PRLV SEPA », « REMISE PRELEVEMENT »…
 * → prélèvement ; « REMISE CHEQUE » → chèque ; sinon virement. Ce n'est qu'une proposition affichée
 * dans la liste déroulante : l'utilisateur la change d'un clic avant de valider.
 */
function detectMethod(label) {
  const t = plain(label);
  if (/\b(prlv|prelev\w*|sdd|sepa direct\w*)\b/.test(t)) return 'prelevement';
  if (/\b(cheques?|chq|chque)\b/.test(t)) return 'cheque';
  return 'virement';
}

// ---------- lecture du CSV ----------

function tokenize(text, delimiter) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(text) {
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim()).slice(0, 15);
  let best = ';'; let bestScore = -1;
  for (const d of [';', '\t', ',', '|']) {
    const counts = lines.map(l => l.split(d).length - 1).filter(n => n > 0);
    // Un bon séparateur revient le même nombre de fois sur beaucoup de lignes.
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] || 0;
    const score = counts.filter(n => n === mode).length * (mode >= 2 ? 1 : 0.1);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const plain = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function parseDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?!\d)/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return engine.isIsoDate(iso) ? iso : null;
  }
  return null;
}

function parseAmount(s) {
  let t = String(s ?? '').replace(/[  €]|EUR/gi, '').trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.endsWith('-')) { neg = true; t = t.slice(0, -1); }
  if (t.startsWith('-')) { neg = true; t = t.slice(1); }
  if (t.startsWith('+')) t = t.slice(1);
  // Séparateur décimal = le dernier de « , » ou « . » s'il est suivi de 1 ou 2 chiffres.
  const m = t.match(/^(.*?)[.,](\d{1,2})$/);
  const intPart = (m ? m[1] : t).replace(/[.,\s]/g, '');
  const dec = m ? m[2].padEnd(2, '0') : '00';
  if (!/^\d+$/.test(intPart) || !/^\d+$/.test(dec)) return null;
  const cents = Number(intPart) * 100 + Number(dec);
  return neg ? -cents : cents;
}

const HEAD = {
  date: /\bdate\b/, label: /(libell|label|description|intitul|motif|detail|reference|objet|operation)/,
  amount: /^(montant|amount|somme)/, credit: /(credit|encaissement|recette)/, debit: /(debit|decaissement|depense)/,
};

function detectMapping(headers) {
  const h = headers.map(plain);
  const pick = (re, avoid) => { const i = h.findIndex(x => re.test(x) && !(avoid && avoid.test(x))); return i >= 0 ? i : null; };
  const dateCol = pick(HEAD.date, /valeur/) ?? pick(HEAD.date);
  const labelCols = h.map((x, i) => (HEAD.label.test(x) && !HEAD.date.test(x) ? i : -1)).filter(i => i >= 0);
  return { dateCol, labelCols, amountCol: pick(HEAD.amount), creditCol: pick(HEAD.credit), debitCol: pick(HEAD.debit) };
}

/** Lit le CSV. mapping (facultatif) : { headerRow, delimiter, dateCol, labelCols, amountCol, creditCol, debitCol } */
function parseBankCsv(text, mapping = {}) {
  const clean = String(text || '').replace(/^﻿/, '');
  if (!clean.trim()) throw new BillingError('Fichier vide.');
  const delimiter = mapping.delimiter || detectDelimiter(clean);
  const rows = tokenize(clean, delimiter);
  let headerRow = mapping.headerRow;
  if (headerRow === undefined || headerRow === null) {
    headerRow = rows.slice(0, 20).findIndex(r => { const m = detectMapping(r); return m.dateCol !== null && (m.amountCol !== null || m.creditCol !== null || m.debitCol !== null); });
    if (headerRow < 0) headerRow = 0;
  }
  const headers = rows[headerRow] || [];
  const auto = detectMapping(headers);
  const map = {
    dateCol: mapping.dateCol ?? auto.dateCol,
    labelCols: mapping.labelCols ?? auto.labelCols,
    amountCol: mapping.amountCol !== undefined ? mapping.amountCol : auto.amountCol,
    creditCol: mapping.creditCol !== undefined ? mapping.creditCol : auto.creditCol,
    debitCol: mapping.debitCol !== undefined ? mapping.debitCol : auto.debitCol,
  };
  const complete = map.dateCol !== null && map.dateCol !== undefined && (map.amountCol != null || map.creditCol != null);
  const lines = [];
  if (complete) {
    for (const r of rows.slice(headerRow + 1)) {
      const date = parseDate(r[map.dateCol]);
      if (!date) continue;
      let cents = null;
      if (map.amountCol != null) cents = parseAmount(r[map.amountCol]);
      else {
        const cr = parseAmount(r[map.creditCol]); const db_ = map.debitCol != null ? parseAmount(r[map.debitCol]) : null;
        cents = (cr || 0) - Math.abs(db_ || 0);
        if (cr === null && db_ === null) cents = null;
      }
      if (cents === null || cents === 0) continue;
      const label = (map.labelCols && map.labelCols.length ? map.labelCols : []).map(i => (r[i] || '').trim()).filter(Boolean).join(' — ').replace(/\s+/g, ' ');
      lines.push({ date, label: label || '(sans libellé)', amountCents: cents });
    }
  }
  return { delimiter, headerRow, headers, mapping: map, complete, sample: rows.slice(headerRow, headerRow + 4), lines };
}

// ---------- rapprochement ----------

const STOP = new Set(['hotel', 'hotels', 'sas', 'sarl', 'eurl', 'sasu', 'les', 'des', 'the', 'residence', 'groupe', 'group', 'societe', 'ste', 'cie', 'and', 'del', 'resort', 'spa', 'auberge', 'maison', 'gite', 'gites', 'chambres', 'dhotes', 'domaine', 'mas', 'bastide', 'hostellerie', 'logis', 'de', 'du', 'la', 'le', 'et']);
const clientTokens = (name) => plain(name).split(' ').filter(t => t.length >= 3 && !STOP.has(t));

function numberRegex(number) {
  const m = String(number).match(/^([A-Z0-9]+)-(\d{4})-(\d+)$/);
  if (!m) return new RegExp(plain(number).replace(/ /g, '\\s*'));
  return new RegExp(`${m[1].toLowerCase()}\\s*[-_ ]?\\s*${m[2]}\\s*[-_ ]?\\s*0*${Number(m[3])}(?!\\d)`);
}

function fingerprints(lines) {
  const seen = new Map();
  return lines.map(l => {
    const base = `${l.date}|${l.amountCents}|${plain(l.label)}`;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return crypto.createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 32);
  });
}

function subsetSum(items, target, maxItems = 5) {
  // items triés par échéance ; recherche exhaustive bornée (≤ 12 factures) d'un sous-ensemble dont la somme = target.
  const list = items.slice(0, 12);
  let found = null;
  const walk = (i, chosen, sum) => {
    if (found || sum > target) return;
    if (sum === target && chosen.length > 1) { found = chosen.slice(); return; }
    if (i >= list.length || chosen.length >= maxItems) return;
    chosen.push(list[i]); walk(i + 1, chosen, sum + list[i].balanceCents); chosen.pop();
    walk(i + 1, chosen, sum);
  };
  walk(0, [], 0);
  return found;
}

/** Propose, pour chaque encaissement (montant > 0), les factures probables. */
function matchLines(lines, today = engine.todayParis()) {
  const open = queries.listInvoices({ tab: 'open', sort: 'due', dir: 'asc', limit: 500 }, today).invoices;
  const tokensByClient = new Map();
  for (const c of new Set(open.map(o => o.clientId))) tokensByClient.set(c, clientTokens(open.find(o => o.clientId === c).clientName));
  const regexByInvoice = new Map(open.map(o => [o.id, numberRegex(o.number)]));
  const fps = fingerprints(lines);
  // Escompte pour règlement anticipé : pour chaque facture ouverte qui en propose un, le net à recevoir
  // et la date limite. Un virement égal à ce net, arrivé à temps, solde la facture avec escompte.
  const escById = new Map();
  if (open.length) {
    const rows = db.prepare(`SELECT id, terms_json, vat_breakdown_json, total_ttc_cents FROM native_invoices WHERE id IN (${open.map(() => '?').join(',')})`).all(...open.map(o => o.id));
    const byId = new Map(open.map(o => [o.id, o]));
    for (const r of rows) {
      let terms = null; try { terms = JSON.parse(r.terms_json || 'null'); } catch { /* conditions illisibles : pas d'escompte */ }
      const offer = terms && terms.earlyDiscount;
      if (!offer) continue;
      const bal = byId.get(r.id).balanceCents;
      const a = escompte.amounts({ vatBreakdown: JSON.parse(r.vat_breakdown_json || '[]'), total_ttc_cents: r.total_ttc_cents }, bal, offer.ratePct);
      if (a.ttcCents > 0 && a.ttcCents < bal) escById.set(r.id, { deadline: offer.deadline, ratePct: offer.ratePct, discountCents: a.ttcCents, netCents: bal - a.ttcCents });
    }
  }

  return lines.map((l, index) => {
    const out = { index, date: l.date, label: l.label, amountCents: l.amountCents, fingerprint: fps[index], method: detectMethod(l.label), alreadyImported: false, credit: l.amountCents > 0, candidates: [], multi: null, confidence: 'none' };
    if (l.amountCents <= 0) return out;
    out.alreadyImported = !!db.prepare("SELECT 1 FROM native_payments WHERE bank_fingerprint LIKE ? LIMIT 1").get(`${fps[index]}:%`);
    if (out.alreadyImported) return out;

    const label = plain(l.label);
    const scored = [];
    for (const inv of open) {
      let score = 0; const why = [];
      if (regexByInvoice.get(inv.id).test(label)) { score += 100; why.push('numéro de facture dans le libellé'); }
      const toks = tokensByClient.get(inv.clientId) || [];
      const hit = toks.filter(t => label.includes(t));
      const clientMatch = toks.length > 0 && hit.length / toks.length >= 0.5 && hit.some(t => t.length >= 4);
      if (clientMatch) { score += 30; why.push('nom du client dans le libellé'); }
      const esc = escById.get(inv.id);
      const escMatch = !!esc && l.amountCents === esc.netCents && l.amountCents !== inv.balanceCents && !!l.date && l.date <= esc.deadline;
      if (l.amountCents === inv.balanceCents) { score += 50; why.push('montant égal au reste dû'); }
      else if (escMatch) { score += 50; why.push(`montant égal au reste dû après escompte de ${escompte.pct(esc.ratePct).replace(/\u00A0/g, ' ')}`); }
      else if (l.amountCents < inv.balanceCents && (clientMatch || score >= 100)) { score += 10; why.push('règlement partiel possible'); }
      if (l.amountCents > inv.balanceCents) score = Math.min(score, 25); // dépasse le dû : applicable seulement en plusieurs factures
      if (score >= 30) scored.push({ invoiceId: inv.id, number: inv.number, clientName: inv.clientName, balanceCents: inv.balanceCents, dueDate: inv.dueDate, score, why, ...(escMatch ? { withDiscount: true, discountCents: esc.discountCents } : {}) });
    }
    scored.sort((a, b) => b.score - a.score || (a.dueDate < b.dueDate ? -1 : 1));
    out.candidates = scored.slice(0, 4);

    if (!out.candidates.length || out.candidates[0].score < 130) {
      // Un virement groupé : plusieurs factures du même client dont la somme = montant.
      const byClient = new Map();
      for (const inv of open) { if (!byClient.has(inv.clientId)) byClient.set(inv.clientId, []); byClient.get(inv.clientId).push(inv); }
      for (const [cid, invs] of byClient) {
        const toks = tokensByClient.get(cid) || [];
        const nameHit = toks.some(t => t.length >= 4 && label.includes(t));
        const numberHits = invs.filter(i => regexByInvoice.get(i.id).test(label));
        const pool = numberHits.length > 1 ? numberHits : (nameHit ? invs : []);
        const sub = pool.length > 1 ? subsetSum(pool, l.amountCents) : null;
        if (sub) { out.multi = { clientName: invs[0].clientName, allocations: sub.map(i => ({ invoiceId: i.id, number: i.number, amountCents: i.balanceCents })) }; break; }
      }
    }

    const top = out.candidates[0];
    const unique = top && out.candidates.filter(c => c.score === top.score).length === 1;
    if (out.multi) out.confidence = 'high';
    else if (top && top.score >= 130 && unique) out.confidence = 'high';
    else if (top && top.score >= 80 && unique) out.confidence = 'high';
    else if (top && top.score >= 50) out.confidence = 'medium';
    else if (top) out.confidence = 'low';
    return out;
  });
}

/**
 * Enregistre les règlements validés.
 * items : [{ fingerprint, date, label, method?, allocations: [{ invoiceId, amountCents }] }]
 * method : virement (défaut), cheque, prelevement, carte, especes, autre. Une valeur inconnue est refusée
 * (jamais remplacée en silence) pour que le journal et les exports comptables restent exacts.
 */
function apply(items) {
  if (!Array.isArray(items) || !items.length) throw new BillingError('Rien à enregistrer.');
  if (items.length > 500) throw new BillingError('500 lignes au plus par opération.');
  const results = [];
  for (const it of items) {
    for (const a of it.allocations || []) {
      try {
        if (!/^[0-9a-f]{32}$/.test(String(it.fingerprint))) throw new BillingError('Empreinte de ligne invalide.');
        const method = it.method === undefined || it.method === null || it.method === '' ? 'virement' : String(it.method);
        if (!METHODS.includes(method)) throw new BillingError(`Mode de règlement inconnu : « ${method.slice(0, 30)} ».`);
        engine.recordPayment(Number(a.invoiceId), {
          paidOn: it.date, amount: Number(a.amountCents) / 100, method,
          reference: String(it.label || '').slice(0, 120), bankFingerprint: `${it.fingerprint}:${Number(a.invoiceId)}`,
          withDiscount: a.withDiscount === true, // le moteur vérifie date limite et montant exact
        });
        results.push({ fingerprint: it.fingerprint, invoiceId: Number(a.invoiceId), ok: true });
      } catch (e) {
        if (!(e instanceof BillingError)) throw e;
        results.push({ fingerprint: it.fingerprint, invoiceId: Number(a.invoiceId), ok: false, error: e.message });
      }
    }
  }
  return results;
}

module.exports = { parseBankCsv, matchLines, apply, parseAmount, parseDate, fingerprints, detectMethod, METHODS };
