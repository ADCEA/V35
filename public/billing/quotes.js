// Devis : liste, tiroir (aperçu, détail), envoi, décision du client, conversion en facture.
(function () {
  const { e, eur, eur0, dFr, today, plural } = Bill;
  const TABS = [['all', 'Tous'], ['draft', 'Brouillons'], ['issued', 'En attente'], ['accepted', 'Acceptés'], ['refused', 'Refusés'], ['invoiced', 'Facturés']];
  const LABEL = { draft: 'Brouillon', issued: 'En attente de réponse', accepted: 'Accepté', refused: 'Refusé', invoiced: 'Facturé', expired: 'Expiré' };
  const CLASS = { draft: 'draft', issued: 'unpaid', accepted: 'paid', refused: 'credited', invoiced: 'partial', expired: 'overdue' };
  const qpill = (status, expired) => { const k = expired ? 'expired' : status; return `<span class="bl-pill ${CLASS[k]}">${LABEL[k]}</span>`; };
  const S = { status: 'all', q: '' };

  async function load(main) {
    const box = main.querySelector('#ql-table');
    let r; try { r = await Bill.get(`/quotes?status=${S.status}&q=${encodeURIComponent(S.q)}`); } catch (err) { return Bill.fail(err, box); }
    main.querySelector('#ql-tabs').innerHTML = TABS.map(([k, l]) => `<button class="bl-tab ${S.status === k ? 'active' : ''}" data-s="${k}">${l}<small>${r.counts[k]}</small></button>`).join('');
    main.querySelectorAll('#ql-tabs [data-s]').forEach(b => b.onclick = () => { S.status = b.dataset.s; load(main); });
    if (!r.quotes.length) {
      box.innerHTML = `<div class="bl-empty"><b>${S.q ? 'Aucun résultat' : 'Aucun devis ici'}</b>${S.status === 'all' && !S.q ? 'Créez un devis pour chiffrer une prestation avant de la facturer.' : 'Rien dans cette catégorie pour le moment.'}</div>`;
      return;
    }
    box.innerHTML = `<div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Statut</th><th>Numéro</th><th>Hôtel</th><th>Date</th><th>Valable jusqu'au</th><th class="r">Total TTC</th></tr></thead><tbody>
      ${r.quotes.map(q => `<tr class="bl-row" tabindex="0" data-id="${q.id}"><td>${qpill(q.status, q.expired)}</td>
        <td class="bl-num"><b style="font-weight:600">${e(q.number || 'Brouillon')}</b>${q.invoiceNumber ? `<span class="sub">Facture ${e(q.invoiceNumber)}</span>` : ''}</td>
        <td class="client">${e(q.clientName)}${q.reference ? `<span class="sub">${e(q.reference)}</span>` : ''}</td>
        <td class="bl-num">${q.issueDate ? dFr(q.issueDate) : '—'}</td><td class="bl-num">${q.validUntil ? dFr(q.validUntil) : '—'}</td><td class="r bl-num">${eur(q.totalTtcCents)}</td></tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('tr.bl-row').forEach(tr => {
      const open = () => openQuote(Number(tr.dataset.id), () => load(main));
      tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    });
  }

  Bill.register('quotes', {
    async render(main, params = {}) {
      if (params.status) S.status = params.status;
      main.innerHTML = `<div class="bl-head"><div><h2>Devis</h2><p>Chiffrez une prestation, envoyez le devis, puis transformez-le en facture une fois accepté.</p></div>
        <div class="bl-actions"><button class="bl-btn primary" id="ql-new">Nouveau devis</button></div></div>
        <div class="bl-panel"><div class="bl-tabs" id="ql-tabs"></div>
        <div class="bl-filters"><div class="bl-field grow"><label for="ql-q">Rechercher</label><input id="ql-q" type="search" value="${e(S.q)}" placeholder="Numéro, hôtel ou référence"></div></div>
        <div id="ql-table"><div class="bl-spin">Chargement…</div></div></div>`;
      let t; main.querySelector('#ql-q').oninput = (ev) => { clearTimeout(t); t = setTimeout(() => { S.q = ev.target.value.trim(); load(main); }, 250); };
      main.querySelector('#ql-new').onclick = () => newQuote(() => load(main));
      await load(main);
      if (params.newQuote) newQuote(() => load(main));
    },
  });

  async function newQuote(done) {
    const clients = await Bill.clients();
    const settings = (await Bill.get('/settings')).settings;
    let editor;
    Bill.modal({
      title: 'Nouveau devis', wide: true,
      body: `<div class="bl-row2"><div class="bl-field"><label for="nq-c">Hôtel</label><select id="nq-c">${Bill.clientOptions(clients)}</select></div>
        <div class="bl-field"><label for="nq-ref">Référence (facultatif)</label><input id="nq-ref" placeholder="Ex. Location de linge saison 2027"></div></div><div id="nq-lines"></div>`,
      buttons: [{ label: 'Annuler', onClick: async () => {} }, { label: 'Créer le brouillon', primary: true, onClick: async (m) => {
        const clientId = Number(m.$('#nq-c').value); if (!clientId) throw new Error('Choisissez un hôtel.');
        const r = await Bill.post('/quotes', { clientId, lines: editor.get(), reference: m.$('#nq-ref').value.trim() || undefined });
        Bill.toast('Brouillon de devis créé'); if (done) done(); openQuote(r.quote.id, done);
      } }],
      onOpen: (m) => { editor = Bill.linesEditor(m.$('#nq-lines'), null, { defaultVat: Number(settings.default_vat_rate ?? 20) }); },
    });
  }

  async function openQuote(id, onChange) {
    let changed = false; let q; let view = null; let editing = false; let tick = Date.now();
    const d = Bill.drawer({ onClose: () => { if (changed && onChange) onChange(); } });
    d.body.innerHTML = '<div class="bl-spin">Chargement…</div>';
    const mark = () => { changed = true; };

    async function reload() {
      try { q = (await Bill.get('/quotes/' + id)).quote; } catch (err) { Bill.closeDrawer(); return Bill.fail(err); }
      tick = Date.now(); if (!view) view = q.status === 'draft' ? 'detail' : 'preview'; paint();
    }

    function paint() {
      const acts = [];
      if (q.status === 'draft') { acts.push('<button class="bl-btn primary" data-a="issue">Finaliser le devis…</button>'); if (!editing) acts.push('<button class="bl-btn" data-a="edit">Modifier</button>'); acts.push('<button class="bl-btn danger" data-a="delete">Supprimer</button>'); }
      else {
        if (q.status === 'issued') acts.push('<button class="bl-btn primary" data-a="send">Envoyer par e-mail</button>', '<button class="bl-btn" data-a="accept">Marquer accepté</button>', '<button class="bl-btn" data-a="refuse">Marquer refusé</button>');
        if (q.status === 'accepted') acts.push('<button class="bl-btn primary" data-a="convert">Créer la facture</button>', '<button class="bl-btn" data-a="send">Envoyer par e-mail</button>');
        if (q.status === 'issued') acts.push('<button class="bl-btn" data-a="convert">Créer la facture</button>');
        if (q.status === 'refused') acts.push('<button class="bl-btn" data-a="accept">Finalement accepté</button>');
        if (q.status === 'invoiced') acts.push('<button class="bl-btn primary" data-a="openinv">Ouvrir la facture</button>');
        acts.push('<button class="bl-btn" data-a="pdf">PDF</button>');
      }
      d.setHead({ title: e(q.number ? `Devis ${q.number}` : 'Brouillon de devis'), sub: `${e(q.buyerName)} &nbsp;${qpill(q.status, q.status === 'issued' && q.validUntil && q.validUntil < today())}`, actions: acts.join('') });
      d.body.innerHTML = `<div class="bl-tabs" style="margin:-4px 0 16px">${[['preview', 'Aperçu'], ['detail', 'Détail']].map(([k, l]) => `<button class="bl-tab ${view === k ? 'active' : ''}" data-v="${k}">${l}</button>`).join('')}</div><div id="dv"></div>`;
      d.body.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { view = b.dataset.v; editing = false; paint(); });
      (view === 'preview' ? paintPreview : paintDetail)(d.body.querySelector('#dv'));
      d.head.querySelectorAll('[data-a]').forEach(b => b.onclick = () => ACTIONS[b.dataset.a](b));
    }

    const problems = () => (q.preview && q.preview.problems) || [];
    const alertHtml = () => problems().length ? `<div class="bl-alert warn"><b>À compléter avant de finaliser</b><ul>${problems().map(x => `<li>${e(x)}</li>`).join('')}</ul><button class="bl-btn small" data-a2="settings">Ouvrir les coordonnées de l'émetteur</button></div>` : '';

    function paintPreview(host) {
      host.innerHTML = `${q.status === 'draft' ? alertHtml() : ''}<iframe class="bl-pdf" title="Aperçu du devis" src="${Bill.base}/quotes/${id}/pdf?v=${tick}"></iframe>
        <div class="bl-pdf-fallback"><p>L'aperçu du PDF n'est pas affiché sur petit écran.</p><a class="bl-btn primary" href="${Bill.base}/quotes/${id}/pdf" target="_blank" rel="noopener">Ouvrir le PDF</a></div>
        <p class="bl-hint"><a href="${Bill.base}/quotes/${id}/pdf" target="_blank" rel="noopener">Ouvrir dans un onglet</a></p>`;
      const s = host.querySelector('[data-a2="settings"]'); if (s) s.onclick = () => Bill.go('issuer');
    }

    function paintDetail(host) {
      if (editing) return paintEditor(host);
      host.innerHTML = `${q.status === 'draft' ? alertHtml() : ''}
        <div class="bl-panel"><div class="bl-panel-b"><dl class="bl-kv"><dt>Hôtel</dt><dd>${e(q.buyerName)}</dd><dt>Date du devis</dt><dd>${q.issueDate ? dFr(q.issueDate) : '—'}</dd>
          <dt>Valable jusqu'au</dt><dd>${q.validUntil ? dFr(q.validUntil) : '—'}</dd>${q.reference ? `<dt>Référence</dt><dd>${e(q.reference)}</dd>` : ''}${q.notes ? `<dt>Note</dt><dd>${e(q.notes)}</dd>` : ''}
          ${q.invoiceNumber ? `<dt>Facture</dt><dd>${e(q.invoiceNumber)}</dd>` : ''}</dl></div></div>
        <div class="bl-panel"><div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">Prix HT</th><th class="r">TVA</th><th class="r">Total HT</th></tr></thead><tbody>
          ${q.lines.map(l => l.isSection ? `<tr><td colspan="5" style="background:var(--bl-row);font-weight:600">${e(l.description)}</td></tr>`
            : `<tr><td>${e(l.description)}</td><td class="r bl-num">${e(String(l.quantity).replace('.', ','))}</td><td class="r bl-num">${e(eur(Math.round(l.unitPrice * 100)))}</td><td class="r bl-num">${e(String(l.vatRate).replace('.', ','))} %</td><td class="r bl-num">${e(eur(l.lineHtCents))}</td></tr>`).join('')}</tbody></table></div>
          <div class="bl-panel-b"><div class="bl-totals"><div><span>Total HT</span><span class="bl-num">${eur(q.totalHtCents)}</span></div><div><span>TVA</span><span class="bl-num">${eur(q.totalVatCents)}</span></div><div class="grand"><span>Total TTC</span><span class="bl-num">${eur(q.totalTtcCents)}</span></div></div></div></div>
        ${q.mails && q.mails.length ? `<div class="bl-panel"><div class="bl-panel-h"><h3>Envois</h3></div><ul class="bl-todo">${q.mails.map(m => `<li><div class="t">${m.status === 'sent' ? 'Envoyé à ' + e(m.toEmail) : '<span style="color:var(--bl-late)">Échec : ' + e(m.error || '') + '</span>'}<small>${e(m.sentAt)}</small></div></li>`).join('')}</ul></div>` : ''}`;
      const s = host.querySelector('[data-a2="settings"]'); if (s) s.onclick = () => Bill.go('issuer');
    }

    function paintEditor(host) {
      host.innerHTML = `<div class="bl-panel"><div class="bl-panel-b"><div class="bl-row3">
        <div class="bl-field"><label for="qe-date">Date du devis</label><input id="qe-date" type="date" value="${e(q.issueDate || '')}"></div>
        <div class="bl-field"><label for="qe-valid">Valable jusqu'au</label><input id="qe-valid" type="date" value="${e(q.validUntil || '')}"><div class="bl-hint">Vide : 30 jours après la date du devis.</div></div>
        <div class="bl-field"><label for="qe-ref">Référence</label><input id="qe-ref" value="${e(q.reference || '')}"></div></div>
        <div class="bl-field"><label for="qe-notes">Note visible sur le devis</label><input id="qe-notes" value="${e(q.notes || '')}"></div><div id="qe-lines"></div>
        <div class="bl-err" id="qe-err" role="alert"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="bl-btn" id="qe-cancel">Annuler</button><button class="bl-btn primary" id="qe-save">Enregistrer</button></div></div></div>`;
      const ed = Bill.linesEditor(host.querySelector('#qe-lines'), q.lines.map(l => ({ isSection: l.isSection, description: l.description, sageCode: l.sageCode, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })));
      host.querySelector('#qe-cancel').onclick = () => { editing = false; paint(); };
      host.querySelector('#qe-save').onclick = async (ev) => {
        ev.target.disabled = true;
        try {
          await Bill.put('/quotes/' + id, { lines: ed.get(), reference: host.querySelector('#qe-ref').value.trim(), notes: host.querySelector('#qe-notes').value.trim(), issueDate: host.querySelector('#qe-date').value || null, validUntil: host.querySelector('#qe-valid').value || null });
          editing = false; mark(); Bill.toast('Devis enregistré'); await reload();
        } catch (err) { ev.target.disabled = false; Bill.fail(err, host.querySelector('#qe-err')); }
      };
    }

    const decide = async (decision) => { try { await Bill.post(`/quotes/${id}/decision`, { decision }); mark(); Bill.toast(decision === 'accepted' ? 'Devis marqué accepté' : 'Devis marqué refusé'); await reload(); } catch (err) { Bill.fail(err); } };

    const ACTIONS = {
      edit() { editing = true; view = 'detail'; paint(); },
      async delete() {
        if (!(await Bill.confirm('Supprimer ce brouillon de devis ?', 'Il sera effacé définitivement.', 'Supprimer', true))) return;
        try { await Bill.del('/quotes/' + id); mark(); Bill.closeDrawer(); Bill.toast('Brouillon supprimé'); } catch (err) { Bill.fail(err); }
      },
      issue() {
        if (problems().length) return Bill.modal({ title: 'Devis incomplet', body: `<div class="bl-alert warn"><ul>${problems().map(x => `<li>${e(x)}</li>`).join('')}</ul></div>`, buttons: [{ label: 'Compris', primary: true, onClick: async () => {} }] });
        Bill.modal({
          title: 'Finaliser le devis',
          body: `<p class="bl-note">Le devis reçoit son numéro définitif et ne pourra plus être modifié. Pour le changer, il faudra en créer un nouveau.</p>
            <div class="bl-row2"><div class="bl-field"><label for="qi-d">Date du devis</label><input id="qi-d" type="date" value="${e(q.issueDate || today())}"></div><div class="bl-field"><label for="qi-v">Valable jusqu'au</label><input id="qi-v" type="date" value="${e(q.validUntil || '')}"></div></div>`,
          buttons: [{ label: 'Annuler', onClick: async () => {} }, { label: 'Finaliser', primary: true, onClick: async (m) => {
            await Bill.post(`/quotes/${id}/issue`, { issueDate: m.$('#qi-d').value || undefined, validUntil: m.$('#qi-v').value || undefined });
            mark(); view = 'preview'; Bill.toast('Devis finalisé'); await reload();
          } }],
        });
      },
      send() { Bill.mailModal({ title: 'Envoyer le devis', previewPath: `/quotes/${id}/mail-preview`, sendPath: `/quotes/${id}/send`, pdfPath: `/quotes/${id}/pdf`, onDone: async () => { mark(); await reload(); } }); },
      accept() { decide('accepted'); },
      async refuse() { if (await Bill.confirm('Marquer ce devis refusé ?', 'Vous pourrez revenir dessus si le client change d\'avis.', 'Marquer refusé')) decide('refused'); },
      async convert() {
        if (!(await Bill.confirm('Créer la facture ?', `Un brouillon de facture reprenant les lignes du devis ${q.number} est créé. Vous pourrez le vérifier avant de l'émettre.`, 'Créer le brouillon'))) return;
        try { const r = await Bill.post(`/quotes/${id}/convert`); mark(); Bill.toast('Brouillon de facture créé'); Bill.openInvoice(r.invoice.id); } catch (err) { Bill.fail(err); }
      },
      openinv() { Bill.go('invoices', { openId: q.invoiceId, tab: 'all' }); },
      pdf() { Bill.openPdf(`/quotes/${id}/pdf`); },
    };
    reload();
  }
})();
