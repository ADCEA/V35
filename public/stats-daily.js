// Statistiques — « Activité jour par jour » : ce qui s'est passé chaque jour (commandes, livraisons, pièces, poids, km)
// et, si la Facturation est déverrouillée, les montants du jour (livré, facturé, avoirs, encaissé).
//
// Les chiffres d'exploitation viennent de /api/admin/stats/daily ; les montants de /api/admin/billing/stats/daily,
// derrière le code de la Facturation : sans déverrouillage, l'écran affiche tout sauf les montants.
(function () {
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const nf = (n, d = 0) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const eur = (c) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const eur0 = (c) => `${Math.round(c / 100).toLocaleString('fr-FR')} €`;
  const todayParis = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
  const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const isWeekend = (iso) => { const w = new Date(`${iso}T12:00:00Z`).getUTCDay(); return w === 0 || w === 6; };
  const METHODS = { virement: 'Virement', cheque: 'Chèque', prelevement: 'Prélèvement', carte: 'Carte bancaire', especes: 'Espèces', autre: 'Autre' };
  const STATUS = { recue: 'reçue', traitement: 'en cours', prete: 'prête', livree: 'livrée' };

  const PRESETS = [['7', '7 jours'], ['30', '30 jours'], ['month', 'Ce mois-ci'], ['last', 'Mois dernier'], ['90', '90 jours']];
  const S = { preset: '30', from: '', to: '', metric: null, hideEmpty: true, ops: null, money: null, locked: false, open: new Set(), detail: new Map(), error: '', seq: 0 };

  function range(key) {
    const t = todayParis();
    if (key === '7') return [addDays(t, -6), t];
    if (key === '30') return [addDays(t, -29), t];
    if (key === '90') return [addDays(t, -89), t];
    if (key === 'month') return [t.slice(0, 8) + '01', t];
    if (key === 'last') { const first = new Date(`${t.slice(0, 8)}01T00:00:00Z`); first.setUTCMonth(first.getUTCMonth() - 1); const start = first.toISOString().slice(0, 10); return [start, addDays(t.slice(0, 8) + '01', -1)]; }
    return [S.from, S.to];
  }

  // ---------- colonnes du tableau (et de l'export) ----------
  const COLS = [
    { key: 'ordersReceived', label: 'Reçues', title: 'Commandes reçues ce jour-là' },
    { key: 'piecesOrdered', label: 'Pièces cmd.', title: 'Pièces des commandes reçues ce jour-là' },
    { key: 'ordersDelivered', label: 'Livrées', title: 'Commandes livrées ce jour-là (bons de livraison)' },
    { key: 'piecesDelivered', label: 'Pièces livrées', title: 'Pièces réellement livrées' },
    { key: 'gap', label: 'Écarts', title: 'Pièces manquantes (−) et en plus (+) par rapport à la commande', fmt: (r) => ((r.piecesMissing ? `−${nf(r.piecesMissing)}` : '') + (r.piecesExtra ? ` +${nf(r.piecesExtra)}` : '')).trim() || '', csv: (r) => (r.piecesExtra || 0) - (r.piecesMissing || 0) },
    { key: 'references', label: 'Réf.', title: 'Références (articles) différentes livrées' },
    { key: 'hotelsServed', label: 'Hôtels', title: 'Hôtels livrés' },
    { key: 'drivers', label: 'Chauffeurs', title: 'Chauffeurs ayant livré' },
    { key: 'weightKg', label: 'Poids (kg)', fmt: (r) => nf(r.weightKg, 1) },
    { key: 'volumeL', label: 'Volume (L)', fmt: (r) => nf(r.volumeL, 1) },
    { key: 'km', label: 'Km', fmt: (r) => nf(r.km, 1) },
    { key: 'deliveredHtCents', label: 'Livré HT', money: true, title: 'Valeur des bons de livraison du jour (prix figés)', fmt: (r) => eur(r.deliveredHtCents) },
    { key: 'invoiceCount', label: 'Factures', money: true, title: 'Factures émises ce jour-là' },
    { key: 'invoicedHtCents', label: 'Facturé HT', money: true, fmt: (r) => eur(r.invoicedHtCents) },
    { key: 'invoicedTtcCents', label: 'Facturé TTC', money: true, fmt: (r) => eur(r.invoicedTtcCents) },
    { key: 'creditedTtcCents', label: 'Avoirs TTC', money: true, fmt: (r) => (r.creditedTtcCents ? `−${eur(r.creditedTtcCents)}` : eur(0)), title: 'Avoirs émis ce jour-là' },
    { key: 'paidCents', label: 'Encaissé', money: true, title: 'Règlements reçus ce jour-là, annulations déduites', fmt: (r) => eur(r.paidCents) },
  ];
  const cell = (c, r) => (c.fmt ? c.fmt(r) : nf(r[c.key] || 0));

  const METRICS = [
    { key: 'deliveredHtCents', label: 'Livré (HT)', money: true, fmt: eur0 },
    { key: 'invoicedHtCents', label: 'Facturé (HT)', money: true, fmt: eur0 },
    { key: 'paidCents', label: 'Encaissé', money: true, fmt: eur0 },
    { key: 'ordersReceived', label: 'Commandes reçues', fmt: (v) => nf(v) },
    { key: 'ordersDelivered', label: 'Commandes livrées', fmt: (v) => nf(v) },
    { key: 'piecesDelivered', label: 'Pièces livrées', fmt: (v) => nf(v) },
    { key: 'weightKg', label: 'Poids (kg)', fmt: (v) => nf(v, 1) },
    { key: 'km', label: 'Kilomètres', fmt: (v) => nf(v, 1) },
  ];

  // ---------- données ----------
  function merged() {
    const m = new Map((S.money ? S.money.days : []).map(d => [d.date, d]));
    return S.ops.days.map(d => ({ ...d, ...(m.get(d.date) || {}) }));
  }
  const active = (r) => r.ordersReceived || r.ordersDelivered || r.invoiceCount || r.creditCount || r.paymentCount;

  async function load(host) {
    const [from, to] = S.preset === 'custom' ? [S.from, S.to] : range(S.preset);
    S.from = from; S.to = to; S.error = '';
    const seq = ++S.seq;   // une réponse arrivée en retard ne doit jamais écraser une demande plus récente
    if (from > to) { S.ops = null; S.error = 'La date de début est postérieure à la date de fin.'; return paint(host); }
    host.querySelector('#dd-body').innerHTML = '<p class="empty-note">Chargement…</p>';
    const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    let ops = null; let money = null; let locked = false; let error = '';
    try {
      ops = await api('GET', `/api/admin/stats/daily${qs}`);
      try { money = await api('GET', `/api/admin/billing/stats/daily${qs}`); }
      catch (e) { if (e.status === 423 || e.status === 403) locked = true; else throw e; }
    } catch (e) { ops = null; error = e.message; }
    if (seq !== S.seq || !host.isConnected) return;
    S.ops = ops; S.money = money; S.locked = locked; S.error = error;
    S.open = new Set(); S.detail = new Map();
    if (!S.metric || (!S.money && METRICS.find(m => m.key === S.metric)?.money)) S.metric = S.money ? 'deliveredHtCents' : 'ordersDelivered';
    paint(host);
  }

  // ---------- graphique ----------
  function chart(rows, metric) {
    const m = METRICS.find(x => x.key === metric);
    const vals = rows.map(r => Number(r[metric]) || 0);
    const max = Math.max(...vals, 0);
    if (!max) return '<p class="empty-note" style="margin:14px 0;">Rien à afficher pour cette période.</p>';
    const W = 760; const H = 200; const L = 54; const R = 8; const T = 10; const B = 26;
    const step = (() => { const raw = max / 4; const p = 10 ** Math.floor(Math.log10(raw)); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; })();
    const top = Math.ceil(max / step) * step;
    const bw = (W - L - R) / rows.length;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const grid = []; for (let v = 0; v <= top + 1e-9; v += step) grid.push(v);
    const every = rows.length <= 14 ? 1 : rows.length <= 35 ? 2 : Math.ceil(rows.length / 14);
    const today = todayParis();
    const bars = rows.map((r, i) => {
      const v = vals[i]; const x = L + i * bw; const h = Math.max(0, (H - T - B) * (v / top));
      const label = `${dayName(r.date)} : ${m.fmt(v)}`;
      return `<g><title>${esc(label)}</title><rect x="${(x + bw * 0.12).toFixed(1)}" y="${(y(v)).toFixed(1)}" width="${Math.max(1, bw * 0.76).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" class="dd-bar ${isWeekend(r.date) ? 'we' : ''} ${r.date === today ? 'today' : ''}"/>
        ${i % every === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="dd-x">${r.date.slice(8)}${r.date.endsWith('-01') || i === 0 ? '/' + r.date.slice(5, 7) : ''}</text>` : ''}</g>`;
    }).join('');
    return `<svg class="dd-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${m.label} par jour du ${dFr(rows[0].date)} au ${dFr(rows.at(-1).date)} ; le tableau ci-dessous donne les mêmes chiffres`)}">
      ${grid.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="dd-grid"/><text x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="dd-y">${esc(m.fmt(v))}</text>`).join('')}${bars}</svg>`;
  }

  // ---------- tuiles ----------
  function tiles() {
    const t = S.ops.totals; const m = S.money && S.money.totals;
    const tile = (label, value, sub) => `<div class="stats-card"><div class="eyebrow">${esc(label)}</div><strong>${value}</strong>${sub ? `<div class="dd-sub">${sub}</div>` : ''}</div>`;
    const by = m ? Object.entries(m.paidByMethod).filter(([, c]) => c).map(([k, c]) => `${esc(METHODS[k] || k)} ${eur0(c)}`).join(' · ') : '';
    return [
      m ? tile('Livré (HT)', eur(m.deliveredHtCents), `${nf(m.deliveredCount)} bons de livraison`) : '',
      m ? tile('Facturé (HT)', eur(m.invoicedHtCents), `${nf(m.invoiceCount)} facture${m.invoiceCount > 1 ? 's' : ''}${m.creditCount ? ` · ${nf(m.creditCount)} avoir${m.creditCount > 1 ? 's' : ''}` : ''}`) : '',
      m ? tile('Encaissé', eur(m.paidCents), `${by || `${nf(m.paymentCount)} règlement${m.paymentCount > 1 ? 's' : ''}`}${m.discountCents ? ` · escomptes accordés ${eur0(m.discountCents)}` : ''}`) : '',
      m ? tile('Reste dû à ce jour', eur(S.money.outstandingCents), 'toutes factures ouvertes') : '',
      tile('Commandes livrées', nf(t.ordersDelivered), `${nf(t.ordersReceived)} reçues sur la période`),
      tile('Pièces livrées', nf(t.piecesDelivered), t.piecesMissing || t.piecesExtra ? `${t.piecesMissing ? `−${nf(t.piecesMissing)} manquantes` : ''}${t.piecesMissing && t.piecesExtra ? ' · ' : ''}${t.piecesExtra ? `+${nf(t.piecesExtra)} en plus` : ''}` : `${nf(t.piecesOrdered)} commandées`),
      tile('Poids livré', `${nf(t.weightKg, 1)} kg`, `${nf(t.volumeL, 0)} L`),
      tile('Kilomètres', `${nf(t.km, 1)} km`, `${nf(t.activeDays)} jour${t.activeDays > 1 ? 's' : ''} d'activité${t.activeDays ? ` · ${nf(t.avgDeliveredPerActiveDay, 1)} livrées/jour` : ''}`),
    ].join('');
  }

  // ---------- tableau ----------
  function table(rows) {
    const cols = COLS.filter(c => !c.money || S.money);
    const shown = (S.hideEmpty ? rows.filter(active) : rows).slice().reverse();
    if (!shown.length) return '<p class="empty-note">Aucune activité sur cette période.</p>';
    const tot = { ...S.ops.totals, ...(S.money ? S.money.totals : {}), gap: 0 };
    const totalRow = { ...tot, references: '', hotelsServed: '', drivers: '' };
    const body = shown.map(r => {
      const open = S.open.has(r.date);
      return `<tr class="dd-row ${open ? 'open' : ''} ${active(r) ? '' : 'idle'}" data-date="${r.date}" tabindex="0" role="button" aria-expanded="${open}">
        <th scope="row" class="dd-day ${isWeekend(r.date) ? 'we' : ''}">${esc(dayName(r.date))}</th>${cols.map(c => `<td class="${cell(c, r) === '' || cell(c, r) === '0' ? 'z' : ''}" ${c.title ? `title="${esc(c.title)}"` : ''}>${esc(cell(c, r))}</td>`).join('')}</tr>
        ${open ? `<tr class="dd-detail"><td colspan="${cols.length + 1}">${detailHtml(r.date)}</td></tr>` : ''}`;
    }).join('');
    return `<div class="dd-wrap"><table class="dd-table"><thead><tr><th scope="col">Jour</th>${cols.map(c => `<th scope="col" ${c.title ? `title="${esc(c.title)}"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><th scope="row">Total</th>${cols.map(c => `<td>${esc(c.key === 'gap' ? ((tot.piecesMissing ? `−${nf(tot.piecesMissing)}` : '') + (tot.piecesExtra ? ` +${nf(tot.piecesExtra)}` : '')).trim() : (['references', 'hotelsServed', 'drivers'].includes(c.key) ? '' : cell(c, totalRow)))}</td>`).join('')}</tr></tfoot></table></div>`;
  }

  function detailHtml(date) {
    const d = S.detail.get(date);
    if (!d) return '<p class="empty-note">Chargement du détail…</p>';
    if (d.error) return `<p class="form-error" style="display:block;">${esc(d.error)}</p>`;
    const list = (title, items, row, empty) => `<div class="dd-dcol"><h6>${esc(title)} <span class="mini-badge">${items.length}</span></h6>${items.length ? `<ul>${items.map(row).join('')}</ul>` : `<p class="empty-note">${esc(empty)}</p>`}</div>`;
    const ops = d.ops; const m = d.money;
    return `<div class="dd-detailgrid">
      ${list('Commandes reçues', ops.received, o => `<li><b>${esc(o.ticket)}</b> ${esc(o.clientName)} <span>${nf(o.pieces)} pièces · ${esc(STATUS[o.status] || o.status)}</span></li>`, 'Aucune commande reçue ce jour-là.')}
      ${list('Commandes livrées', ops.delivered, o => `<li><b>${esc(o.ticket)}</b> ${esc(o.clientName)} <span>${nf(o.piecesDelivered)}${o.piecesDelivered !== o.pieces ? ` / ${nf(o.pieces)}` : ''} pièces${o.km ? ` · ${nf(o.km, 1)} km` : ''}${o.driver ? ` · ${esc(o.driver)}` : ''}</span></li>`, 'Aucune livraison ce jour-là.')}
      ${m ? list('Valeur livrée', m.deliveries, o => `<li><b>${esc(o.ticket)}</b> ${esc(o.clientName)} <span>${eur(o.htCents)} HT</span></li>`, 'Aucun bon de livraison.') : ''}
      ${m ? list('Factures et avoirs émis', m.invoices, o => `<li><b>${esc(o.number)}</b> ${esc(o.clientName)} <span>${o.kind === 'credit_note' ? '−' : ''}${eur(o.ttcCents)} TTC</span></li>`, 'Rien d\'émis ce jour-là.') : ''}
      ${m ? list('Règlements reçus', m.payments, o => `<li><b>${esc(o.number)}</b> ${esc(o.clientName)} <span>${esc(METHODS[o.method] || o.method)} · ${eur(o.amountCents)}${o.reference ? ` · ${esc(o.reference)}` : ''}</span></li>`, 'Aucun règlement ce jour-là.') : ''}
      ${m && m.discounts && m.discounts.length ? list('Escomptes accordés', m.discounts, o => `<li><b>${esc(o.number)}</b> ${esc(o.clientName)} <span>${o.amountCents < 0 ? 'annulé · ' : ''}${eur(Math.abs(o.amountCents))} TTC</span></li>`, '') : ''}
    </div>${m ? '' : '<p class="dd-note">Les montants du jour sont protégés : déverrouillez la Facturation pour les voir ici.</p>'}`;
  }

  async function openDay(host, date) {
    if (S.open.has(date)) { S.open.delete(date); return paint(host); }
    S.open.add(date); paint(host);
    if (S.detail.has(date)) return;
    try {
      const ops = await api('GET', `/api/admin/stats/daily/${date}`);
      let money = null;
      if (S.money) { try { money = await api('GET', `/api/admin/billing/stats/daily/${date}`); } catch (e) { if (e.status !== 423) throw e; } }
      S.detail.set(date, { ops, money });
    } catch (e) { S.detail.set(date, { error: e.message }); }
    paint(host);
  }

  // ---------- export ----------
  function exportCsv() {
    const rows = merged(); const cols = COLS.filter(c => !c.money || S.money);
    const money = (c, r) => (c.money && /Cents$/.test(c.key) ? (r[c.key] / 100).toFixed(2).replace('.', ',') : null);
    const out = [['Date', ...cols.map(c => c.label)].join(';')];
    for (const r of rows) {
      out.push([r.date, ...cols.map(c => {
        const v = money(c, r) ?? (c.csv ? c.csv(r) : (r[c.key] ?? 0));
        return typeof v === 'number' ? String(v).replace('.', ',') : String(v);
      })].join(';'));
    }
    const blob = new Blob(['﻿' + out.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `statistiques-jour-par-jour_${S.from}_${S.to}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- écran ----------
  function paint(host) {
    const body = host.querySelector('#dd-body');
    if (S.error) { body.innerHTML = `<p class="form-error" style="display:block;">${esc(S.error)}</p>`; return; }
    if (!S.ops) return;
    const rows = merged();
    const metrics = METRICS.filter(m => !m.money || S.money);
    body.innerHTML = `
      ${S.locked ? `<div class="dd-lock"><span><b>Les montants sont protégés.</b> Déverrouillez la Facturation pour voir ce qui a été livré, facturé et encaissé chaque jour.</span><button class="btn-secondary" id="dd-unlock" type="button">Ouvrir la Facturation</button></div>` : ''}
      <div class="stats-grid dd-tiles">${tiles()}</div>
      <div class="dd-chartbox">
        <div class="dd-metrics" role="group" aria-label="Chiffre à afficher dans le graphique">${metrics.map(m => `<button type="button" class="dd-chip ${S.metric === m.key ? 'on' : ''}" data-metric="${m.key}" aria-pressed="${S.metric === m.key}">${esc(m.label)}</button>`).join('')}</div>
        ${chart(rows, S.metric)}
      </div>
      <label class="dd-check"><input type="checkbox" id="dd-hide" ${S.hideEmpty ? 'checked' : ''}> Masquer les jours sans activité</label>
      ${table(rows)}`;
    body.querySelectorAll('[data-metric]').forEach(b => b.onclick = () => { S.metric = b.dataset.metric; paint(host); });
    const hide = body.querySelector('#dd-hide'); if (hide) hide.onchange = () => { S.hideEmpty = hide.checked; paint(host); };
    body.querySelectorAll('tr.dd-row').forEach(tr => {
      const go = () => openDay(host, tr.dataset.date);
      tr.onclick = go; tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } };
    });
    const unlock = body.querySelector('#dd-unlock');
    if (unlock) unlock.onclick = () => { if (typeof switchAdminView === 'function') switchAdminView('billing'); };
  }

  window.renderDailyDashboard = async function (host) {
    if (!S.from) { [S.from, S.to] = range(S.preset); }
    host.innerHTML = `<div class="card dd" style="margin-bottom:20px;">
      <div class="dd-head"><div><h4 class="card-subhead" style="margin-bottom:4px;">Activité jour par jour</h4>
        <p style="font-size:12.5px;color:var(--steel);margin:0;">Pour chaque jour : commandes, livraisons, pièces, poids, kilomètres — et les montants livrés, facturés et encaissés. Cliquez sur un jour pour voir le détail.</p></div>
        <button class="btn-secondary" id="dd-export" type="button">Exporter (Excel)</button></div>
      <div class="dd-controls">
        <div class="dd-presets" role="group" aria-label="Période">${PRESETS.map(([k, l]) => `<button type="button" class="dd-chip ${S.preset === k ? 'on' : ''}" data-preset="${k}" aria-pressed="${S.preset === k}">${l}</button>`).join('')}</div>
        <div class="dd-dates"><label>Du <input type="date" id="dd-from" value="${esc(S.from)}"></label><label>au <input type="date" id="dd-to" value="${esc(S.to)}"></label></div>
      </div>
      <div id="dd-body"></div></div>`;
    host.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
      S.preset = b.dataset.preset;
      host.querySelectorAll('[data-preset]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      const [f, t] = range(S.preset); host.querySelector('#dd-from').value = f; host.querySelector('#dd-to').value = t;
      load(host);
    });
    const custom = () => {
      const f = host.querySelector('#dd-from').value; const t = host.querySelector('#dd-to').value;
      if (!f || !t) return;
      S.preset = 'custom'; S.from = f; S.to = t;
      host.querySelectorAll('[data-preset]').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
      load(host);
    };
    host.querySelector('#dd-from').onchange = custom; host.querySelector('#dd-to').onchange = custom;
    host.querySelector('#dd-export').onclick = () => { if (S.ops) exportCsv(); };
    await load(host);
  };
})();
