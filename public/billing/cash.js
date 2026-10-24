// Encaissements : liste des règlements, rapprochement bancaire (import CSV), relances.
(function () {
  const { e, eur, eur0, dFr, dtFr, today, plural } = Bill;

  // ================= Règlements =================
  const P = { q: '', from: '', to: '' };
  async function loadPayments(main) {
    const box = main.querySelector('#pa-table');
    let r; try { r = await Bill.get(`/payments?q=${encodeURIComponent(P.q)}&from=${P.from}&to=${P.to}`); } catch (err) { return Bill.fail(err, box); }
    main.querySelector('#pa-sum').textContent = r.count ? `${plural(r.count, 'règlement', 'règlements')} · ${eur(r.totalCents)}${r.discountCents ? ` · escomptes accordés ${eur(r.discountCents)}` : ''}` : '';
    if (!r.payments.length) { box.innerHTML = `<div class="bl-empty"><b>${P.q || P.from || P.to ? 'Aucun résultat' : 'Aucun règlement enregistré'}</b>Les règlements apparaissent ici dès que vous les saisissez sur une facture ou par le rapprochement bancaire.</div>`; return; }
    box.innerHTML = `<div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Date</th><th>Hôtel</th><th>Facture</th><th>Mode</th><th>Référence</th><th class="r">Montant</th></tr></thead><tbody>
      ${r.payments.map(p => `<tr class="bl-row" tabindex="0" data-inv="${p.invoiceId}"><td class="bl-num">${dFr(p.paidOn)}</td><td class="client">${e(p.clientName)}</td><td class="bl-num">${e(p.number)}</td>
        <td>${p.method === 'escompte' ? '<i>Escompte accordé</i>' : e(Bill.METHODS[p.method] || p.method)}${p.fromBank ? ' <span class="bl-ind">relevé</span>' : ''}</td><td class="bl-muted">${e(p.reference || '')}</td>
        <td class="r bl-num" style="${p.amountCents < 0 ? 'color:var(--bl-late)' : p.method === 'escompte' ? 'color:var(--bl-faint,#888)' : ''}">${p.method === 'escompte' ? '<span title="Remise pour règlement anticipé : ce n\'est pas de l\'argent reçu">(' + eur(p.amountCents) + ')</span>' : eur(p.amountCents)}</td></tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('tr.bl-row').forEach(tr => { const open = () => Bill.openInvoice(Number(tr.dataset.inv), () => loadPayments(main)); tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter') open(); }; });
  }
  Bill.register('payments', {
    async render(main) {
      main.innerHTML = `<div class="bl-head"><div><h2>Règlements</h2><p>Tout ce qui a été encaissé. Pour enregistrer d'un coup des prélèvements ou des virements déjà reçus, utilisez « en lot » (vous cochez les factures) ou le rapprochement bancaire (vous importez le relevé).</p></div>
        <div class="bl-actions"><button class="bl-btn" id="pa-bulk">Enregistrer des règlements en lot</button><button class="bl-btn primary" id="pa-rec">Rapprocher un relevé</button></div></div>
        <div class="bl-panel"><div class="bl-filters"><div class="bl-field grow"><label for="pa-q">Rechercher</label><input id="pa-q" type="search" value="${e(P.q)}" placeholder="Hôtel, numéro de facture, référence"></div>
        <div class="bl-field"><label for="pa-f">Du</label><input id="pa-f" type="date" value="${e(P.from)}"></div><div class="bl-field"><label for="pa-t">Au</label><input id="pa-t" type="date" value="${e(P.to)}"></div>
        <div class="bl-muted" id="pa-sum" style="padding-bottom:8px"></div></div><div id="pa-table"><div class="bl-spin">Chargement…</div></div></div>`;
      let t; main.querySelector('#pa-q').oninput = (ev) => { clearTimeout(t); t = setTimeout(() => { P.q = ev.target.value.trim(); loadPayments(main); }, 250); };
      main.querySelector('#pa-f').onchange = (ev) => { P.from = ev.target.value; loadPayments(main); };
      main.querySelector('#pa-t').onchange = (ev) => { P.to = ev.target.value; loadPayments(main); };
      main.querySelector('#pa-rec').onclick = () => Bill.go('reconcile');
      main.querySelector('#pa-bulk').onclick = () => bulkPayments(() => loadPayments(main));
      await loadPayments(main);
    },
  });

  // ---------- Règlements en lot ----------
  // On coche des factures ouvertes, on indique la date, le mode et une référence : chaque facture est réglée en totalité.
  // Aperçu d'abord ; tout est enregistré ou rien (une facture refusée annule le lot).
  async function bulkPayments(onDone) {
    let open;
    try { open = (await Bill.get('/invoices?tab=open&limit=500&sort=client&dir=asc')).invoices; } catch (err) { return Bill.fail(err); }
    if (!open.length) return Bill.toast('Aucune facture à régler.', true);
    const rowOf = (d) => `<tr data-q="${e(`${d.clientName} ${d.number}`.toLowerCase())}"><td><input type="checkbox" class="bk-c" value="${d.id}" data-cents="${d.balanceCents}" aria-label="Régler ${e(d.number)}"></td>
      <td class="client">${e(d.clientName)}</td><td class="bl-num">${e(d.number)}</td><td class="bl-num">${dFr(d.dueDate)}</td><td class="r bl-num"><b>${eur(d.balanceCents)}</b></td></tr>`;
    let ids = []; let form = {};
    Bill.previewThenConfirm({
      title: 'Enregistrer des règlements en lot', applyLabel: 'Enregistrer', previewLabel: 'Voir le résultat', scope: 'payments-bulk',
      body: `<p class="bl-note">Cochez les factures déjà réglées : chacune est soldée pour son reste dû. Utile pour des prélèvements passés avant le module SEPA, ou un lot de chèques. Le résultat s'affiche avant que rien ne soit écrit ; si une facture pose problème, aucune n'est enregistrée.</p>
        <div class="bl-row3"><div class="bl-field"><label for="bk-d">Date d'encaissement</label><input id="bk-d" type="date" value="${Bill.today()}" max="${Bill.today()}"></div>
        <div class="bl-field"><label for="bk-m">Mode de règlement</label><select id="bk-m">${Object.entries(Bill.METHODS).map(([k, v]) => `<option value="${k}" ${k === 'prelevement' ? 'selected' : ''}>${e(v)}</option>`).join('')}</select></div>
        <div class="bl-field"><label for="bk-r">Référence (facultatif)</label><input id="bk-r" maxlength="120" placeholder="Ex. Prélèvement du 05/10"></div></div>
        <div class="bl-field"><label for="bk-q">Filtrer la liste</label><input id="bk-q" type="search" placeholder="Hôtel ou numéro de facture"></div>
        <div class="bl-tablewrap" style="max-height:300px;overflow:auto"><table class="bl-table"><thead><tr><th style="width:34px"><input type="checkbox" id="bk-all" aria-label="Tout cocher (liste affichée)"></th><th>Hôtel</th><th>Facture</th><th>Échéance</th><th class="r">Reste dû</th></tr></thead><tbody id="bk-rows">${open.map(rowOf).join('')}</tbody></table></div>
        <div class="bl-muted" id="bk-sum" style="margin-top:6px"></div>`,
      onOpen: (m) => {
        m.el.classList.add('xl');
        const rows = () => [...m.el.querySelectorAll('#bk-rows tr')];
        const sum = () => {
          const on = [...m.el.querySelectorAll('.bk-c:checked')];
          m.$('#bk-sum').textContent = on.length ? `${plural(on.length, 'facture cochée', 'factures cochées')} · ${eur(on.reduce((t, x) => t + Number(x.dataset.cents), 0))}` : 'Aucune facture cochée';
        };
        m.$('#bk-q').addEventListener('input', (ev) => { const q = ev.target.value.trim().toLowerCase(); rows().forEach(tr => { tr.hidden = !!q && !tr.dataset.q.includes(q); }); });
        m.$('#bk-all').addEventListener('change', (ev) => { rows().filter(tr => !tr.hidden).forEach(tr => { tr.querySelector('.bk-c').checked = ev.target.checked; }); sum(); });
        m.el.addEventListener('change', (ev) => { if (ev.target.classList.contains('bk-c')) sum(); });
        sum();
      },
      preview: async (m) => {
        ids = [...m.el.querySelectorAll('.bk-c:checked')].map(x => Number(x.value));
        form = { paidOn: m.$('#bk-d').value, method: m.$('#bk-m').value, reference: m.$('#bk-r').value.trim() };
        if (!ids.length) throw new Error('Cochez au moins une facture.');
        const r = await Bill.post('/payments/bulk', { invoiceIds: ids, ...form });
        const label = Bill.METHODS[r.method] || r.method;
        return {
          canApply: r.refused === 0 && r.count > 0,
          confirm: `${plural(r.count, 'facture sera soldée', 'factures seront soldées')} (${label.toLowerCase()}, le ${dFr(r.paidOn)}) pour un total de ${eur(r.totalCents)}. Une erreur se corrige ensuite en annulant le règlement sur la facture.`,
          html: `${r.refused ? `<div class="bl-alert bad"><b>${plural(r.refused, 'facture ne peut pas être réglée', 'factures ne peuvent pas être réglées')}</b> : décochez-les pour continuer.</div>` : `<div class="bl-alert ok"><b>${plural(r.count, 'facture sera soldée', 'factures seront soldées')}</b> — ${label.toLowerCase()} du ${dFr(r.paidOn)} · ${eur(r.totalCents)}. Rien n'est encore enregistré.</div>`}
            <div class="bl-tablewrap" style="max-height:240px;overflow:auto"><table class="bl-table"><thead><tr><th>Hôtel</th><th>Facture</th><th class="r">Montant réglé</th></tr></thead><tbody>
            ${r.lines.map(l => `<tr><td class="client">${e(l.clientName || '')}</td><td class="bl-num">${e(l.number || '#' + l.invoiceId)}</td><td class="r bl-num">${l.ok ? `<b>${eur(l.amountCents)}</b>` : `<span style="color:var(--bl-late)">${e(l.error)}</span>`}</td></tr>`).join('')}</tbody></table></div>`,
        };
      },
      apply: async () => {
        const r = await Bill.post('/payments/bulk', { invoiceIds: ids, ...form, apply: true });
        Bill.toast(`${plural(r.count, 'règlement enregistré', 'règlements enregistrés')} · ${eur(r.totalCents)}`);
        Bill.refreshBadges();
        if (onDone) await onDone();
      },
    });
  }

  // ================= Rapprochement bancaire =================
  const R = { csv: null, parsed: null, choice: new Map(), method: new Map(), openInv: null };

  async function readFile(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { return new TextDecoder('windows-1252').decode(buf); }
  }

  function defaultChoice(l) {
    if (l.alreadyImported || !l.credit) return { type: 'none' };
    if (l.multi) return { type: 'multi', allocations: l.multi.allocations };
    const top = l.candidates[0];
    if (top && (l.confidence === 'high')) return { type: 'one', invoiceId: top.invoiceId, number: top.number, balanceCents: top.balanceCents };
    return { type: 'none' };
  }

  function optionsFor(l, idx) {
    const cur = R.choice.get(idx) || { type: 'none' };
    const opts = ['<option value="none">Ne pas rapprocher</option>'];
    if (l.multi) opts.push(`<option value="multi" ${cur.type === 'multi' ? 'selected' : ''}>${l.multi.allocations.map(a => e(a.number)).join(' + ')} (${e(l.multi.clientName)})</option>`);
    l.candidates.forEach(c => opts.push(`<option value="c:${c.invoiceId}" ${cur.type === 'one' && cur.invoiceId === c.invoiceId ? 'selected' : ''}>${e(c.number)} · ${e(c.clientName)} · reste ${e(eur(c.balanceCents))}</option>`));
    if (cur.type === 'one' && !l.candidates.some(c => c.invoiceId === cur.invoiceId)) opts.push(`<option value="c:${cur.invoiceId}" selected>${e(cur.number)} (choisie)</option>`);
    opts.push('<option value="other">Autre facture…</option>');
    return opts.join('');
  }

  function why(l) {
    const top = l.candidates[0];
    if (l.multi) return 'Somme de plusieurs factures du même hôtel';
    return top ? top.why.join(', ') : '';
  }

  function paintLines(host, main) {
    const p = R.parsed;
    const credits = p.lines.filter(l => l.credit);
    const todo = credits.filter(l => !l.alreadyImported);
    if (!credits.length) { host.innerHTML = '<div class="bl-empty"><b>Aucun encaissement dans ce relevé</b>Seules les lignes créditrices (sommes reçues) sont rapprochées.</div>'; return; }
    host.innerHTML = `<div class="bl-panel-b" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
        <span class="bl-muted">${plural(credits.length, 'encaissement', 'encaissements')}${p.skippedDebits ? ` · ${plural(p.skippedDebits, 'débit ignoré', 'débits ignorés')}` : ''}${credits.length - todo.length ? ` · ${credits.length - todo.length} déjà enregistré(s)` : ''}</span>
        <button class="bl-btn small" id="rc-map">Ajuster les colonnes</button></div>
      <div class="bl-tablewrap"><table class="bl-table"><thead><tr><th style="width:34px"></th><th>Date</th><th>Libellé de la banque</th><th class="r">Montant</th><th style="min-width:280px">Facture proposée</th></tr></thead><tbody>
      ${credits.map(l => {
        const idx = l.index; const done = l.alreadyImported; const cur = R.choice.get(idx) || { type: 'none' };
        return `<tr style="${done ? 'opacity:.55' : ''}"><td><input type="checkbox" class="rc-c" data-i="${idx}" ${cur.type !== 'none' ? 'checked' : ''} ${done ? 'disabled' : ''} aria-label="Valider cette ligne"></td>
          <td class="bl-num">${dFr(l.date)}</td><td style="max-width:320px">${e(l.label)}</td><td class="r bl-num"><b>${eur(l.amountCents)}</b></td>
          <td>${done ? '<span class="bl-ind">Déjà enregistré lors d\'un import précédent</span>' : `<select class="bl-input rc-s" data-i="${idx}" aria-label="Facture pour ${e(l.label)}">${optionsFor(l, idx)}</select>
            <div class="rc-mode"><label for="rc-m-${idx}">Reçu par</label><select class="bl-input rc-m" id="rc-m-${idx}" data-i="${idx}">${Object.entries(Bill.METHODS).map(([k, v]) => `<option value="${k}" ${(R.method.get(idx) || l.method) === k ? 'selected' : ''}>${e(v)}</option>`).join('')}</select>${l.method !== 'virement' && (R.method.get(idx) || l.method) === l.method ? ' <span class="bl-ind">d\'après le libellé</span>' : ''}</div>
            <div class="bl-hint"><span class="bl-conf ${l.confidence}">${{ high: 'Sûr', medium: 'Probable', low: 'À vérifier', none: 'Aucune piste' }[l.confidence]}</span> ${e(why(l))}${cur.type === 'one' && cur.balanceCents < l.amountCents ? ` <span style="color:var(--bl-wait)">· ${eur(l.amountCents - cur.balanceCents)} non affectés</span>` : ''}</div>`}</td></tr>`;
      }).join('')}</tbody></table></div>
      <div class="bl-panel-b" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line)"><span class="bl-muted" id="rc-sum"></span><button class="bl-btn primary" id="rc-apply">Enregistrer les règlements cochés</button></div>`;
    const lineBy = new Map(p.lines.map(l => [l.index, l]));
    const sum = () => {
      const sel = [...host.querySelectorAll('.rc-c:checked')].map(x => Number(x.dataset.i));
      const tot = sel.reduce((s, i) => { const c = R.choice.get(i); if (!c) return s; if (c.type === 'multi') return s + c.allocations.reduce((a, x) => a + x.amountCents, 0); return s + Math.min(lineBy.get(i).amountCents, c.balanceCents); }, 0);
      host.querySelector('#rc-sum').textContent = `${plural(sel.length, 'ligne cochée', 'lignes cochées')} · ${eur(tot)}`;
      host.querySelector('#rc-apply').disabled = !sel.length;
    };
    host.querySelectorAll('.rc-c').forEach(cb => cb.onchange = () => {
      const i = Number(cb.dataset.i);
      if (cb.checked && (R.choice.get(i) || { type: 'none' }).type === 'none') { cb.checked = false; Bill.toast('Choisissez d\'abord une facture pour cette ligne.', true); }
      sum();
    });
    host.querySelectorAll('.rc-s').forEach(sel => sel.onchange = async () => {
      const i = Number(sel.dataset.i); const l = lineBy.get(i); const v = sel.value;
      if (v === 'none') R.choice.set(i, { type: 'none' });
      else if (v === 'multi') R.choice.set(i, { type: 'multi', allocations: l.multi.allocations });
      else if (v === 'other') { const picked = await pickInvoice(); if (picked) R.choice.set(i, { type: 'one', invoiceId: picked.id, number: picked.number, balanceCents: picked.balanceCents }); }
      else { const c = l.candidates.find(x => x.invoiceId === Number(v.slice(2))); R.choice.set(i, { type: 'one', invoiceId: c.invoiceId, number: c.number, balanceCents: c.balanceCents }); }
      paintLines(host, main);
      const cb = host.querySelector(`.rc-c[data-i="${i}"]`); if (cb && R.choice.get(i).type !== 'none') { cb.checked = true; sum(); }
    });
    host.querySelectorAll('.rc-m').forEach(sel => sel.onchange = () => { R.method.set(Number(sel.dataset.i), sel.value); });
    host.querySelector('#rc-map').onclick = () => mappingModal(main);
    host.querySelector('#rc-apply').onclick = async (ev) => {
      const items = [...host.querySelectorAll('.rc-c:checked')].map(cb => {
        const i = Number(cb.dataset.i); const l = lineBy.get(i); const c = R.choice.get(i);
        const allocations = c.type === 'multi' ? c.allocations.map(a => ({ invoiceId: a.invoiceId, amountCents: a.amountCents })) : [{ invoiceId: c.invoiceId, amountCents: Math.min(l.amountCents, c.balanceCents) }];
        return { fingerprint: l.fingerprint, date: l.date, label: l.label, method: R.method.get(i) || l.method || 'virement', allocations };
      });
      const modes = [...new Set(items.map(x => Bill.METHODS[x.method] || x.method))];
      if (!(await Bill.confirm('Enregistrer ces règlements ?', `${plural(items.length, 'ligne', 'lignes')} du relevé ${items.length > 1 ? 'seront enregistrées' : 'sera enregistrée'} comme règlements (${modes.join(', ').toLowerCase()}). Une erreur se corrige ensuite en annulant le règlement sur la facture.`, 'Enregistrer'))) return;
      ev.target.disabled = true;
      try {
        const r = await Bill.post('/reconcile/apply', { items });
        Bill.toast(`${plural(r.applied, 'règlement enregistré', 'règlements enregistrés')}${r.failed ? `, ${r.failed} refusé(s)` : ''}`, r.failed > 0 && !r.applied);
        if (r.failed) Bill.modal({ title: 'Certaines lignes ont été refusées', body: `<div class="bl-alert bad"><ul>${r.results.filter(x => !x.ok).map(x => `<li>${e(x.error)}</li>`).join('')}</ul></div>`, buttons: [{ label: 'Compris', primary: true, onClick: async () => {} }] });
        Bill.refreshBadges();
        await parse(main, R.csv, R.mapping);   // recalcul : les lignes enregistrées passent en « déjà enregistré »
      } catch (err) { ev.target.disabled = false; Bill.fail(err); }
    };
    sum();
  }

  async function pickInvoice() {
    const open = (await Bill.get('/invoices?tab=open&limit=500&sort=client&dir=asc')).invoices;
    if (!open.length) { Bill.toast('Aucune facture ouverte.', true); return null; }
    return new Promise(resolve => {
      let chosen = null;
      Bill.modal({
        title: 'Choisir une facture', body: `<div class="bl-field"><label for="pk">Facture à rapprocher</label><select id="pk">${open.map(d => `<option value="${d.id}">${e(d.number)} · ${e(d.clientName)} · reste ${e(eur(d.balanceCents))}</option>`).join('')}</select></div>`,
        buttons: [{ label: 'Annuler', onClick: async () => { resolve(null); } }, { label: 'Choisir', primary: true, onClick: async (m) => { const d = open.find(x => x.id === Number(m.$('#pk').value)); chosen = d; resolve(d ? { id: d.id, number: d.number, balanceCents: d.balanceCents } : null); } }],
      });
    });
  }

  async function parse(main, csv, mapping) {
    const host = main.querySelector('#rc-result');
    host.innerHTML = '<div class="bl-spin">Analyse du relevé…</div>';
    let p; try { p = await Bill.post('/reconcile/parse', { csv, mapping: mapping || {} }); } catch (err) { host.innerHTML = ''; return Bill.fail(err, main.querySelector('#rc-err')); }
    R.csv = csv; R.mapping = mapping || {}; R.parsed = p; R.choice = new Map(); R.method = new Map();
    main.querySelector('#rc-err').textContent = '';
    if (!p.complete) { host.innerHTML = '<div class="bl-alert warn" style="margin:16px">Les colonnes du relevé n\'ont pas été reconnues automatiquement. Indiquez-les ci-dessous.</div>'; return mappingModal(main); }
    p.lines.forEach(l => R.choice.set(l.index, defaultChoice(l)));
    paintLines(host, main);
  }

  function mappingModal(main) {
    const p = R.parsed; const hs = p.headers; const m = p.mapping;
    const colOpts = (sel, none) => (none ? '<option value="">—</option>' : '') + hs.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${e(h || 'Colonne ' + (i + 1))}</option>`).join('');
    Bill.modal({
      title: 'Colonnes du relevé', wide: true,
      body: `<p class="bl-note">Aperçu des premières lignes : ${p.sample.map(r => `<span class="bl-code">${e(r.join(' | ').slice(0, 110))}</span>`).join('<br>')}</p>
        <div class="bl-row2"><div class="bl-field"><label for="mp-d">Date</label><select id="mp-d">${colOpts(m.dateCol, true)}</select></div>
        <div class="bl-field"><label for="mp-l">Libellé</label><select id="mp-l">${colOpts((m.labelCols || [])[0], true)}</select></div></div>
        <div class="bl-row3"><div class="bl-field"><label for="mp-a">Montant (positif/négatif)</label><select id="mp-a">${colOpts(m.amountCol, true)}</select></div>
        <div class="bl-field"><label for="mp-c">Crédit</label><select id="mp-c">${colOpts(m.creditCol, true)}</select></div>
        <div class="bl-field"><label for="mp-x">Débit</label><select id="mp-x">${colOpts(m.debitCol, true)}</select></div></div>
        <div class="bl-hint">Indiquez soit une colonne « Montant », soit les colonnes « Crédit » et « Débit ».</div>`,
      buttons: [{ label: 'Annuler', onClick: async () => {} }, { label: 'Analyser', primary: true, onClick: async (mm) => {
        const n = (id) => (mm.$(id).value === '' ? null : Number(mm.$(id).value));
        const mapping = { headerRow: p.headerRow, delimiter: p.delimiter, dateCol: n('#mp-d'), labelCols: n('#mp-l') === null ? [] : [n('#mp-l')], amountCol: n('#mp-a'), creditCol: n('#mp-c'), debitCol: n('#mp-x') };
        if (mapping.dateCol === null || (mapping.amountCol === null && mapping.creditCol === null)) throw new Error('Choisissez la colonne de date et celle du montant (ou du crédit).');
        await parse(main, R.csv, mapping);
      } }],
    });
  }

  Bill.register('reconcile', {
    async render(main) {
      R.parsed = null;
      main.innerHTML = `<div class="bl-head"><div><h2>Rapprochement bancaire</h2><p>Importez le relevé de votre banque (fichier CSV). Le logiciel propose la facture et le mode de chaque encaissement (virement, prélèvement, chèque) ; rien n'est enregistré sans votre validation.</p></div></div>
        <div class="bl-panel"><div class="bl-panel-b">
          <div class="bl-field"><label for="rc-file">Relevé de compte (CSV)</label><input id="rc-file" type="file" accept=".csv,.txt,text/csv,text/plain">
          <div class="bl-hint">Exportez-le depuis l'espace en ligne de votre banque. Vos données restent sur votre serveur. Un virement déjà enregistré n'est jamais compté deux fois.</div></div>
          <div class="bl-err" id="rc-err" role="alert"></div></div><div id="rc-result"></div></div>`;
      main.querySelector('#rc-file').onchange = async (ev) => {
        const f = ev.target.files[0]; if (!f) return;
        if (f.size > 3_000_000) return Bill.fail(new Error('Fichier trop volumineux (3 Mo maximum).'), main.querySelector('#rc-err'));
        await parse(main, await readFile(f));
      };
    },
  });

  // ================= Relances =================
  const LEVELS = { 1: 'Rappel amiable', 2: 'Relance', 3: 'Dernier rappel avant recouvrement' };
  let onlyDue = null;

  Bill.register('reminders', {
    async render(main) {
      const r = await Bill.get('/reminders');
      const due = r.invoices.filter(x => x.suggestedLevel);
      if (onlyDue === null) onlyDue = due.length > 0;
      paint(main, r);
    },
  });

  function paint(main, r) {
    const rows = onlyDue ? r.invoices.filter(x => x.suggestedLevel) : r.invoices;
    main.innerHTML = `<div class="bl-head"><div><h2>Relances</h2><p>Les factures échues et non soldées. Le logiciel propose le bon moment et le bon ton ; c'est toujours vous qui décidez d'envoyer.</p></div>
      <div class="bl-actions"><label class="bl-check"><input type="checkbox" id="rm-only" ${onlyDue ? 'checked' : ''}> Seulement celles à relancer maintenant</label></div></div>
      ${r.smtp ? '' : '<div class="bl-alert warn">L\'envoi d\'e-mails n\'est pas configuré sur le serveur. Vous pouvez noter une relance faite par téléphone, mais pas l\'envoyer ici.</div>'}
      <div class="bl-panel">${rows.length ? `<div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Hôtel</th><th>Facture</th><th>Retard</th><th class="r">Reste dû</th><th>Dernière relance</th><th>Conseil</th><th></th></tr></thead><tbody>
      ${rows.map(x => `<tr><td class="client">${e(x.clientName)}${x.email ? '' : '<span class="sub" style="color:var(--bl-wait)">pas d\'adresse e-mail</span>'}</td>
        <td class="bl-num"><a href="#" data-inv="${x.id}">${e(x.number)}</a><span class="sub">échue le ${dFr(x.dueDate)}</span></td>
        <td class="bl-num"><span style="color:var(--bl-late)">${plural(x.overdueDays, 'jour', 'jours')}</span></td><td class="r bl-num"><b>${eur(x.balanceCents)}</b></td>
        <td>${x.reminderCount ? `${plural(x.reminderCount, 'relance', 'relances')}<span class="sub">il y a ${plural(x.daysSinceLastReminder ?? 0, 'jour', 'jours')}</span>` : '<span class="bl-faint">aucune</span>'}</td>
        <td>${x.suggestedLevel ? `<span class="bl-pill overdue">${e(LEVELS[x.suggestedLevel])}</span>` : '<span class="bl-muted">Patienter</span>'}</td>
        <td class="r"><button class="bl-btn small ${x.suggestedLevel ? 'primary' : ''}" data-rem="${x.id}">Relancer</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="bl-empty"><b>${r.invoices.length ? 'Rien à relancer pour le moment' : 'Aucune facture en retard'}</b>${r.invoices.length ? 'Les factures échues ont déjà été relancées récemment.' : 'Tous vos clients sont à jour.'}</div>`}</div>`;
    main.querySelector('#rm-only').onchange = (ev) => { onlyDue = ev.target.checked; paint(main, r); };
    main.querySelectorAll('[data-inv]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); Bill.openInvoice(Number(a.dataset.inv), refresh); });
    main.querySelectorAll('[data-rem]').forEach(b => b.onclick = () => Bill.remind(Number(b.dataset.rem), { onDone: refresh }));
    async function refresh() { Bill.refreshBadges(); paint(main, await Bill.get('/reminders')); }
  }

  // Fenêtre de relance d'une facture : niveau, texte prêt, envoi ou simple note.
  Bill.remind = async function (invoiceId, { onDone } = {}) {
    let info; try { info = (await Bill.get('/reminders')); } catch (err) { return Bill.fail(err); }
    const row = info.invoices.find(x => x.id === invoiceId);
    let level = (row && row.suggestedLevel) || Math.min(3, ((row && row.reminderCount) || 0) + 1);
    const m = Bill.modal({
      title: 'Relancer', wide: true,
      body: `<div class="bl-field"><label for="rl-lvl">Ton du message</label><select id="rl-lvl">${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}" ${Number(k) === level ? 'selected' : ''}>${v}</option>`).join('')}</select>
          ${row && row.suggestedLevel ? `<div class="bl-hint">Conseillé ici : ${e(LEVELS[row.suggestedLevel])}.</div>` : ''}</div>
        <div class="bl-field"><label class="bl-check"><input type="radio" name="rl-ch" value="email" checked> Envoyer un e-mail avec la facture en pièce jointe</label>
        <label class="bl-check" style="margin-top:6px"><input type="radio" name="rl-ch" value="manual"> J'ai relancé par téléphone ou courrier : le noter seulement</label></div>
        <div id="rl-mail"><div class="bl-field"><label for="rl-to">Destinataire</label><input id="rl-to"></div><div class="bl-field"><label for="rl-sub">Objet</label><input id="rl-sub"></div>
        <div class="bl-field"><label for="rl-body">Message</label><textarea id="rl-body"></textarea></div></div>
        <div id="rl-note" style="display:none"><div class="bl-field"><label for="rl-nt">Note (facultatif)</label><input id="rl-nt" placeholder="Ex. appelé M. Martin, paiement promis vendredi"></div></div>`,
      buttons: [{ label: 'Annuler', onClick: async () => {} }, { label: 'Envoyer', primary: true, onClick: async (mm) => {
        const manual = mm.el.querySelector('input[name="rl-ch"]:checked').value === 'manual';
        if (manual) await Bill.post(`/invoices/${invoiceId}/remind`, { level, channel: 'manual', subject: mm.$('#rl-nt').value.trim() || undefined });
        else await Bill.post(`/invoices/${invoiceId}/remind`, { level, to: mm.$('#rl-to').value, subject: mm.$('#rl-sub').value, body: mm.$('#rl-body').value });
        Bill.toast(manual ? 'Relance notée' : 'Relance envoyée'); if (onDone) onDone();
      } }],
    });
    async function fill() {
      try {
        const pv = await Bill.get(`/invoices/${invoiceId}/mail-preview?kind=reminder-${level}`);
        m.$('#rl-to').value = pv.to; m.$('#rl-sub').value = pv.subject; m.$('#rl-body').value = pv.body;
        if (!pv.smtp) m.err('L\'envoi d\'e-mails n\'est pas configuré sur le serveur : vous pouvez seulement noter la relance.');
      } catch (err) { Bill.fail(err, m.$('.bl-err')); }
    }
    m.$('#rl-lvl').onchange = (ev) => { level = Number(ev.target.value); fill(); };
    m.el.querySelectorAll('input[name="rl-ch"]').forEach(r => r.onchange = () => {
      const manual = m.el.querySelector('input[name="rl-ch"]:checked').value === 'manual';
      m.$('#rl-mail').style.display = manual ? 'none' : ''; m.$('#rl-note').style.display = manual ? '' : 'none';
      m.el.querySelector('.bl-foot .primary').textContent = manual ? 'Noter la relance' : 'Envoyer';
    });
    fill();
  };
})();
