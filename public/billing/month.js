// Facturer le mois : un brouillon par hôtel pour tous les bons livrés, vérification, puis émission groupée.
(function () {
  const { e, eur, eur0, dFr, today, plural } = Bill;
  const M = { upTo: '', selectedDrafts: null };

  async function paintPreview(main) {
    const box = main.querySelector('#mo-prev');
    let r; try { r = (await Bill.get('/batch/preview' + (M.upTo ? '?upTo=' + M.upTo : ''))).clients; } catch (err) { return Bill.fail(err, box); }
    if (!r.length) { box.innerHTML = '<div class="bl-empty"><b>Rien à facturer</b>Tous les bons livrés sont déjà facturés' + (M.upTo ? ' jusqu\'au ' + dFr(M.upTo) : '') + '.</div>'; return; }
    box.innerHTML = `<div class="bl-tablewrap"><table class="bl-table"><thead><tr><th style="width:36px"><input type="checkbox" id="mo-all" aria-label="Tout sélectionner" checked></th><th>Hôtel</th><th class="r">Bons livrés</th><th class="r">Montant estimé HT</th><th>À corriger</th></tr></thead><tbody>
      ${r.map(c => `<tr><td><input type="checkbox" class="mo-c" value="${c.clientId}" ${c.issues.length ? '' : 'checked'} aria-label="Facturer ${e(c.clientName)}"></td>
        <td class="client">${e(c.clientName)}</td><td class="r bl-num">${c.orders.length}</td><td class="r bl-num">${eur(c.estimatedHtCents)}</td>
        <td>${c.issues.length ? c.issues.map(i => `<span class="bl-chip" style="background:var(--bl-wait-bg);color:var(--bl-wait)">${e(i)}</span>`).join(' ') : '<span class="bl-faint">—</span>'}</td></tr>`).join('')}</tbody></table></div>
      <div class="bl-panel-b" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line)">
        <span class="bl-muted" id="mo-sum"></span><button class="bl-btn primary" id="mo-go">Préparer les brouillons</button></div>`;
    const sync = () => {
      const sel = [...box.querySelectorAll('.mo-c:checked')].map(x => Number(x.value));
      const ht = r.filter(c => sel.includes(c.clientId)).reduce((s, c) => s + c.estimatedHtCents, 0);
      box.querySelector('#mo-sum').textContent = `${plural(sel.length, 'hôtel sélectionné', 'hôtels sélectionnés')} · environ ${eur0(ht)} HT`;
      box.querySelector('#mo-go').disabled = !sel.length;
    };
    box.querySelectorAll('.mo-c').forEach(c => c.onchange = sync);
    box.querySelector('#mo-all').onchange = (ev) => { box.querySelectorAll('.mo-c').forEach(c => { c.checked = ev.target.checked; }); sync(); };
    sync();
    box.querySelector('#mo-go').onclick = async (ev) => {
      const ids = [...box.querySelectorAll('.mo-c:checked')].map(x => Number(x.value));
      ev.target.disabled = true;
      try {
        const res = (await Bill.post('/batch/drafts', { clientIds: ids, upTo: M.upTo || undefined })).results;
        const ok = res.filter(x => x.ok); const ko = res.filter(x => !x.ok);
        M.selectedDrafts = new Set(ok.map(x => x.invoiceId));
        Bill.toast(`${plural(ok.length, 'brouillon créé', 'brouillons créés')}${ko.length ? `, ${ko.length} en erreur` : ''}`, ko.length > 0 && ok.length === 0);
        if (ko.length) M.errors = ko; else M.errors = null;
      } catch (err) { Bill.fail(err); }
      await paintAll(main);
    };
  }

  async function paintDrafts(main) {
    const box = main.querySelector('#mo-drafts');
    let rows; try { rows = (await Bill.get('/invoices?tab=draft&limit=200&sort=client&dir=asc')).invoices.filter(d => d.kind === 'invoice'); } catch (err) { return Bill.fail(err, box); }
    const errs = M.errors ? `<div class="bl-alert bad"><b>Brouillons non créés</b><ul>${M.errors.map(x => `<li>${e(x.clientName || 'Hôtel')} : ${e(x.error)}</li>`).join('')}</ul></div>` : '';
    if (!rows.length) { box.innerHTML = `<div class="bl-panel-b">${errs}<div class="bl-empty" style="padding:14px"><b>Aucun brouillon en attente</b>Préparez les brouillons depuis la liste ci-dessus.</div></div>`; return; }
    if (!M.selectedDrafts) M.selectedDrafts = new Set(rows.map(d => d.id));
    box.innerHTML = `<div class="bl-panel-b" style="padding-bottom:0">${errs}<p class="bl-note">Ouvrez chaque brouillon pour vérifier les lignes si besoin. Rien n'est définitif tant que vous n'avez pas émis.</p></div>
      <div class="bl-tablewrap"><table class="bl-table"><thead><tr><th style="width:36px"><input type="checkbox" id="md-all" aria-label="Tout sélectionner"></th><th>Hôtel</th><th>Référence</th><th class="r">Total TTC</th><th></th></tr></thead><tbody>
      ${rows.map(d => `<tr><td><input type="checkbox" class="md-c" value="${d.id}" ${M.selectedDrafts.has(d.id) ? 'checked' : ''} aria-label="Émettre le brouillon de ${e(d.clientName)}"></td><td class="client">${e(d.clientName)}</td><td class="bl-muted">${e(d.reference || '')}</td><td class="r bl-num">${eur(d.totalTtcCents)}</td><td class="r"><button class="bl-btn small" data-open="${d.id}">Vérifier</button></td></tr>`).join('')}</tbody></table></div>
      <div class="bl-panel-b" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line)"><span class="bl-muted" id="md-sum"></span><button class="bl-btn primary" id="md-issue">Émettre la sélection…</button></div>`;
    const sync = () => {
      const sel = [...box.querySelectorAll('.md-c:checked')].map(x => Number(x.value));
      M.selectedDrafts = new Set(sel);
      const tot = rows.filter(d => M.selectedDrafts.has(d.id)).reduce((s, d) => s + d.totalTtcCents, 0);
      box.querySelector('#md-sum').textContent = `${plural(sel.length, 'brouillon sélectionné', 'brouillons sélectionnés')} · ${eur(tot)} TTC`;
      box.querySelector('#md-issue').disabled = !sel.length;
      box.querySelector('#md-all').checked = sel.length === rows.length;
    };
    box.querySelectorAll('.md-c').forEach(c => c.onchange = sync);
    box.querySelector('#md-all').onchange = (ev) => { box.querySelectorAll('.md-c').forEach(c => { c.checked = ev.target.checked; }); sync(); };
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => Bill.openInvoice(Number(b.dataset.open), () => paintAll(main)));
    sync();
    box.querySelector('#md-issue').onclick = () => {
      const ids = rows.filter(d => M.selectedDrafts.has(d.id)).map(d => d.id);
      const total = rows.filter(d => M.selectedDrafts.has(d.id)).reduce((s, d) => s + d.totalTtcCents, 0);
      Bill.sensitive({
        title: 'Émettre les factures', scope: 'batch-issue', okLabel: `Émettre ${plural(ids.length, 'facture', 'factures')}`,
        text: `${plural(ids.length, 'facture sera émise', 'factures seront émises')} pour ${eur(total)} TTC. Une fois émises, elles reçoivent leur numéro définitif et ne sont plus modifiables.`,
        body: `<div class="bl-field"><label for="mi-date">Date d'émission</label><input id="mi-date" type="date" value="${today()}"></div>`,
        onSubmit: async (m) => {
          const res = (await Bill.post('/batch/issue', { invoiceIds: ids, issueDate: m.$('#mi-date').value || undefined })).results;
          M.selectedDrafts = null; M.errors = null;
          const ok = res.filter(x => x.ok); const ko = res.filter(x => !x.ok);
          const byId = new Map(rows.map(d => [d.id, d]));
          Bill.modal({
            title: ko.length ? 'Émission terminée, avec des erreurs' : 'Factures émises',
            body: `${ok.length ? `<div class="bl-alert ok">${plural(ok.length, 'facture émise', 'factures émises')} : ${ok.map(x => e(x.number)).join(', ')}.</div>` : ''}
              ${ko.length ? `<div class="bl-alert bad"><b>${plural(ko.length, 'brouillon non émis', 'brouillons non émis')}</b><ul>${ko.map(x => `<li>${e(byId.get(x.invoiceId)?.clientName || '#' + x.invoiceId)} : ${e(x.error)}</li>`).join('')}</ul>Ils restent en brouillon : corrigez-les puis réémettez.</div>` : ''}
              <p class="bl-note">Vous pouvez maintenant envoyer chaque facture depuis la liste des factures.</p>`,
            buttons: [{ label: 'Voir les factures', onClick: async () => { Bill.go('invoices', { tab: 'open' }); } }, { label: 'Fermer', primary: true, onClick: async () => {} }],
          });
          Bill.refreshBadges();
          await paintAll(main);
        },
      });
    };
  }

  async function paintAll(main) { await Promise.all([paintPreview(main), paintDrafts(main)]); }

  Bill.register('month', {
    async render(main) {
      main.innerHTML = `<div class="bl-head"><div><h2>Facturer le mois</h2><p>Un brouillon par hôtel pour tous les bons livrés non facturés. Vous vérifiez, puis vous émettez le tout d'un coup.</p></div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>1. Hôtels à facturer</h3><div class="bl-field" style="margin:0;display:flex;align-items:center;gap:8px"><label for="mo-up" style="margin:0">Livraisons jusqu'au</label><input id="mo-up" type="date" value="${e(M.upTo)}" style="width:auto"></div></div><div id="mo-prev"><div class="bl-spin">Chargement…</div></div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>2. Brouillons à émettre</h3></div><div id="mo-drafts"><div class="bl-spin">Chargement…</div></div></div>`;
      main.querySelector('#mo-up').onchange = (ev) => { M.upTo = ev.target.value; paintPreview(main); };
      await paintAll(main);
    },
  });
})();
