// Factures : liste filtrable + tiroir de détail (aperçu PDF, détail, historique) + actions.
(function () {
  const { e, eur, eur0, dFr, dtFr, today, plural } = Bill;
  // Filtres de statut : plusieurs peuvent être cochés (union). [clé, libellé, couleur de la pastille, montant affiché]
  const CHIPS = [['draft', 'Brouillons', 'draft', null], ['unpaid', 'À encaisser', 'unpaid', 'balance'], ['overdue', 'En retard', 'overdue', 'balance'],
    ['partial', 'Partielles', 'partial', 'balance'], ['paid', 'Payées', 'paid', 'total'], ['credit_notes', 'Avoirs', 'credit_note', null]];
  // Anciens liens (tableau de bord, relances…) : un onglet devient une sélection de statuts.
  const TAB_TO_SEL = { all: [], open: ['unpaid', 'overdue', 'partial'] };
  const setTab = (t) => { S.sel = new Set(TAB_TO_SEL[t] || (CHIPS.some(c => c[0] === t) ? [t] : [])); };
  const CATEGORY = { services: 'Prestation de services', goods: 'Livraison de biens', mixed: 'Livraison et prestation' };
  Bill.METHODS = { virement: 'Virement', cheque: 'Chèque', prelevement: 'Prélèvement', carte: 'Carte bancaire', especes: 'Espèces', autre: 'Autre' };
  const BUCKETS = {
    notDue: ['Non échu', d => d.overdueDays === 0], d1_30: ['1 à 30 jours de retard', d => d.overdueDays >= 1 && d.overdueDays <= 30],
    d31_60: ['31 à 60 jours de retard', d => d.overdueDays >= 31 && d.overdueDays <= 60], d61_90: ['61 à 90 jours de retard', d => d.overdueDays >= 61 && d.overdueDays <= 90],
    d90: ['Plus de 90 jours de retard', d => d.overdueDays > 90],
  };
  const S = { sel: new Set(), q: '', clientId: '', from: '', to: '', sort: 'date', dir: 'desc', limit: 100, bucket: null };

  // ---------- liste ----------
  function qs() {
    const p = new URLSearchParams({ sort: S.sort, dir: S.dir, limit: S.bucket ? 500 : S.limit });
    if (S.sel.size) p.set('status', [...S.sel].join(','));
    if (S.q) p.set('q', S.q); if (S.clientId) p.set('clientId', S.clientId); if (S.from) p.set('from', S.from); if (S.to) p.set('to', S.to);
    return p.toString();
  }

  // Sur ordinateur, la liste occupe toute la hauteur de l'écran (défilement dans le tableau, en-tête toujours visible) : un maximum de lignes d'un coup.
  function fit(main, scroll) {
    const wrap = main.querySelector('.bl-tablewrap.inv'); if (!wrap) return;
    if (window.innerWidth <= 900) { wrap.style.maxHeight = ''; return; }
    const mainTop = main.getBoundingClientRect().top + window.scrollY;
    if (scroll) window.scrollTo({ top: Math.max(0, mainTop - 92) });
    const off = wrap.getBoundingClientRect().top + window.scrollY - mainTop;
    wrap.style.maxHeight = Math.max(240, window.innerHeight - 92 - off - 16) + 'px';
  }
  let fitBound = false;

  function titleOf(d) {
    if (d.status === 'draft') return d.kind === 'credit_note' ? "Brouillon d'avoir" : 'Brouillon';
    return d.number;
  }

  function followUp(d) {
    const out = [];
    if (d.sentCount) out.push('<span class="bl-ind ok" title="Envoyée par e-mail ou préparée dans Outlook">envoyée</span>');
    if (d.reminderCount) out.push(`<span class="bl-ind" title="Relances faites">${plural(d.reminderCount, 'relance', 'relances')}</span>`);
    if (d.pennylaneStatus === 'sent') out.push('<span class="bl-ind ok" title="Transmise à Pennylane">Pennylane</span>');
    if (d.pennylaneStatus === 'error') out.push('<span class="bl-ind bad" title="Échec d\'envoi à Pennylane">Pennylane !</span>');
    return out.join('');
  }

  function rowHtml(d) {
    const isCn = d.kind === 'credit_note';
    return `<tr class="bl-row" tabindex="0" data-id="${d.id}">
      <td>${Bill.pill(d.display)}${d.overdueDays ? `<span class="bl-late-days" title="${plural(d.overdueDays, 'jour', 'jours')} de retard">${d.overdueDays} j</span>` : ''}</td>
      <td class="bl-num"><b style="font-weight:600">${e(titleOf(d))}</b></td>
      <td class="client" title="${e(d.clientName)}${d.reference ? ' — ' + e(d.reference) : ''}">${e(d.clientName)}${d.reference ? `<span class="sub">${e(d.reference)}</span>` : ''}</td>
      <td class="bl-num">${d.issueDate ? dFr(d.issueDate) : '—'}</td>
      <td class="bl-num">${d.dueDate && !isCn ? dFr(d.dueDate) : '—'}</td>
      <td class="r bl-num">${eur(isCn ? -d.totalTtcCents : d.totalTtcCents)}</td>
      <td class="r bl-num">${d.balanceCents ? `<b>${eur(d.balanceCents)}</b>` : '<span class="bl-faint">—</span>'}</td>
      <td class="bl-follow">${followUp(d)}</td></tr>`;
  }

  function sortTh(key, label, cls = '') {
    const on = S.sort === key; const arrow = on ? (S.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th class="sortable ${cls}" data-sort="${key}" ${on ? `aria-sort="${S.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${label}${arrow}</th>`;
  }

  async function load(main) {
    const box = main.querySelector('#il-table');
    let r;
    try { r = await Bill.get('/invoices?' + qs()); } catch (err) { return Bill.fail(err, box); }
    let rows = r.invoices;
    if (S.bucket) rows = rows.filter(d => d.balanceCents > 0 && BUCKETS[S.bucket][1](d));
    const sumOf = (k, kind) => (kind === 'balance' || kind === 'total') && r.counts[k] ? `<small>${eur0(r.sums[k])}</small>` : '';
    main.querySelector('#il-tabs').innerHTML = `<button class="bl-chipf ${S.sel.size ? '' : 'on'}" data-st="all" aria-pressed="${S.sel.size ? 'false' : 'true'}">Toutes <b>${r.counts.all}</b></button>`
      + CHIPS.map(([k, label, cls, kind]) => `<button class="bl-chipf ${S.sel.has(k) ? 'on' : ''} ${k === 'overdue' && r.counts[k] ? 'late' : ''}" data-st="${k}" aria-pressed="${S.sel.has(k)}"><i class="bl-dot ${cls}"></i>${label} <b>${r.counts[k]}</b>${sumOf(k, kind)}</button>`).join('');
    main.querySelectorAll('#il-tabs [data-st]').forEach(b => b.onclick = () => {
      const k = b.dataset.st;
      if (k === 'all') S.sel.clear(); else if (S.sel.has(k)) S.sel.delete(k); else S.sel.add(k);
      S.bucket = null; S.limit = 100; load(main);
    });
    const sel = r.selection || { count: r.total, totalTtcCents: 0, balanceCents: 0 };
    main.querySelector('#il-sum').innerHTML = `<b>${plural(sel.count, 'facture', 'factures')}</b> · ${eur0(sel.totalTtcCents)} TTC${sel.balanceCents ? ` · <b>${eur0(sel.balanceCents)}</b> à encaisser` : ''}`;
    main.querySelector('#il-chip').innerHTML = S.bucket ? `<span class="bl-chip">${e(BUCKETS[S.bucket][0])} <button class="bl-btn link small" id="il-clear" aria-label="Retirer le filtre">×</button></span>` : '';
    const clr = main.querySelector('#il-clear'); if (clr) clr.onclick = () => { S.bucket = null; load(main); };

    if (!rows.length) {
      const filtered = S.q || S.clientId || S.from || S.to || S.bucket;
      box.innerHTML = `<div class="bl-empty"><b>${filtered ? 'Aucun résultat' : 'Aucune facture ici'}</b>${filtered ? 'Essayez d\'élargir la recherche ou les dates.' : (!S.sel.size ? 'Créez une première facture avec « Nouvelle facture », ou facturez le mois d\'un coup.' : 'Aucune facture avec ces statuts pour le moment.')}</div>`;
      return;
    }
    box.innerHTML = `<div class="bl-tablewrap inv"><table class="bl-table inv"><thead><tr><th>Statut</th>${sortTh('number', 'Numéro')}${sortTh('client', 'Hôtel')}${sortTh('date', 'Émise le')}${sortTh('due', 'Échéance')}${sortTh('amount', 'Total TTC', 'r')}${sortTh('balance', 'Reste dû', 'r')}<th>Suivi</th></tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody></table></div>
      ${!S.bucket && r.total > rows.length ? `<div class="bl-more"><button class="bl-btn" id="il-more">Afficher la suite (${r.total - rows.length} de plus)</button></div>` : ''}`;
    box.querySelectorAll('[data-sort]').forEach(th => th.onclick = () => { const k = th.dataset.sort; if (S.sort === k) S.dir = S.dir === 'asc' ? 'desc' : 'asc'; else { S.sort = k; S.dir = (k === 'client' || k === 'number' || k === 'due') ? 'asc' : 'desc'; } load(main); });
    box.querySelectorAll('tr.bl-row').forEach(tr => {
      const open = () => Bill.openInvoice(Number(tr.dataset.id), () => load(main));
      tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    });
    const more = box.querySelector('#il-more'); if (more) more.onclick = () => { S.limit += 100; load(main); };
    fit(main, false);
  }

  Bill.register('invoices', {
    async render(main, params = {}) {
      if (params.tab) { setTab(params.tab); S.limit = 100; }
      if (params.clientId !== undefined) { S.clientId = String(params.clientId || ''); setTab(params.tab || 'all'); S.q = ''; S.limit = 100; }
      S.bucket = params.bucket || null;
      const clients = await Bill.clients();
      main.innerHTML = `<div class="bl-head tight"><div><h2>Factures</h2><p>Toutes vos factures et avoirs. Cliquez sur une ligne pour l'ouvrir, l'envoyer ou enregistrer un règlement.</p></div>
        <div class="bl-actions"><button class="bl-btn" id="il-month">Facturer le mois</button><button class="bl-btn primary" id="il-new">Nouvelle facture</button></div></div>
        <div class="bl-panel"><div class="bl-statusbar"><div class="bl-chipsrow" id="il-tabs" role="group" aria-label="Filtrer par statut"></div><div class="bl-listsum" id="il-sum" aria-live="polite"></div></div>
        <div class="bl-filters inline">
          <div class="bl-field grow"><label for="il-q" class="bl-sr">Rechercher</label><input id="il-q" type="search" value="${e(S.q)}" placeholder="Rechercher : numéro, hôtel, référence ou montant"></div>
          <div class="bl-field"><label for="il-c" class="bl-sr">Hôtel</label><select id="il-c"><option value="">Tous les hôtels</option>${clients.map(c => `<option value="${c.id}" ${String(S.clientId) === String(c.id) ? 'selected' : ''}>${e(c.societe)}</option>`).join('')}</select></div>
          <div class="bl-field dates"><label for="il-f">Du</label><input id="il-f" type="date" value="${e(S.from)}"><label for="il-t">au</label><input id="il-t" type="date" value="${e(S.to)}"></div>
          <div id="il-chip"></div>
        </div><div id="il-table"><div class="bl-spin">Chargement…</div></div></div>`;
      let timer;
      main.querySelector('#il-q').oninput = (ev) => { clearTimeout(timer); timer = setTimeout(() => { S.q = ev.target.value.trim(); S.limit = 100; load(main); }, 250); };
      main.querySelector('#il-c').onchange = (ev) => { S.clientId = ev.target.value; S.limit = 100; load(main); };
      main.querySelector('#il-f').onchange = (ev) => { S.from = ev.target.value; load(main); };
      main.querySelector('#il-t').onchange = (ev) => { S.to = ev.target.value; load(main); };
      main.querySelector('#il-new').onclick = () => newInvoice(() => load(main));
      main.querySelector('#il-month').onclick = () => Bill.go('month');
      await load(main);
      fit(main, true);
      if (!fitBound) { fitBound = true; window.addEventListener('resize', () => { const m = document.getElementById('bl-main'); if (m && Bill.state.page === 'invoices') fit(m, false); }); }
      if (params.newInvoice) newInvoice(() => load(main));
      if (params.openId) Bill.openInvoice(params.openId, () => load(main));
    },
  });

  // ---------- nouvelle facture ----------
  async function newInvoice(done) {
    const clients = await Bill.clients();
    const settings = (await Bill.get('/settings')).settings;
    let editor = null; let orders = [];
    const m = Bill.modal({
      title: 'Nouvelle facture', wide: true,
      body: `<div class="bl-field"><label for="ni-c">Hôtel</label><select id="ni-c">${Bill.clientOptions(clients)}</select></div>
        <div id="ni-mode" style="display:none"><div class="bl-steps" role="tablist">
          <label class="bl-check"><input type="radio" name="ni-m" value="bl" checked> À partir des bons de livraison</label>
          <label class="bl-check" style="margin-left:18px"><input type="radio" name="ni-m" value="free"> Facture libre (prestation hors livraison)</label></div>
        <div id="ni-bl"></div><div id="ni-free" style="display:none">
          <div class="bl-field"><label for="ni-ref">Référence (facultatif)</label><input id="ni-ref" placeholder="Ex. Remplacement de linge, commande n° …"></div><div id="ni-lines"></div></div></div>`,
      buttons: [
        { label: 'Annuler', onClick: async () => {} },
        { label: 'Créer le brouillon', primary: true, onClick: async (mm) => {
          const clientId = Number(mm.$('#ni-c').value);
          if (!clientId) throw new Error('Choisissez un hôtel.');
          const free = mm.el.querySelector('input[name="ni-m"]:checked').value === 'free';
          let r;
          if (free) r = await Bill.post('/invoices/free', { clientId, lines: editor.get(), reference: mm.$('#ni-ref').value.trim() || undefined });
          else {
            const ids = [...mm.el.querySelectorAll('.ni-ord:checked')].map(x => Number(x.value));
            if (!ids.length) throw new Error('Cochez au moins un bon de livraison.');
            r = await Bill.post('/invoices', { clientId, orderIds: ids, detailLevel: mm.$('#ni-detail').value || undefined });
          }
          Bill.toast('Brouillon créé. Vérifiez-le avant de l\'émettre.');
          if (done) done();
          Bill.openInvoice(r.invoice.id, done);
        } },
      ],
    });
    const blBox = m.$('#ni-bl'); const freeBox = m.$('#ni-free');
    async function loadOrders() {
      const cid = Number(m.$('#ni-c').value);
      m.$('#ni-mode').style.display = cid ? '' : 'none';
      if (!cid) return;
      blBox.innerHTML = '<div class="bl-spin">Chargement des bons…</div>';
      try { orders = (await Bill.get(`/clients/${cid}/invoiceable-orders`)).orders; } catch (err) { return Bill.fail(err, m.$('.bl-err')); }
      blBox.innerHTML = orders.length
        ? `<p class="bl-note">${plural(orders.length, 'bon livré non facturé', 'bons livrés non facturés')}. Décochez ceux à laisser pour plus tard.</p>
           <div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 10px">${orders.map(o => `<label class="bl-check" style="padding:4px 0"><input class="ni-ord" type="checkbox" value="${o.id}" checked> <span>Bon ${e(o.ticket || '#' + o.id)} <span class="bl-muted">· livraison du ${dFr(o.livraisonPrevue)}</span></span></label>`).join('')}</div>
           <div class="bl-field" style="margin-top:12px"><label for="ni-detail">Niveau de détail</label><select id="ni-detail"><option value="">Selon la fiche de l'hôtel</option><option value="detail">Détaillé, article par article</option><option value="per_bl">Un total par bon de livraison</option><option value="aggregated">Regroupé par article</option></select></div>`
        : '<div class="bl-empty" style="padding:18px"><b>Aucun bon à facturer pour cet hôtel</b>Utilisez « Facture libre » pour une prestation hors livraison.</div>';
    }
    m.$('#ni-c').onchange = loadOrders;
    m.el.querySelectorAll('input[name="ni-m"]').forEach(r => r.onchange = () => {
      const free = m.el.querySelector('input[name="ni-m"]:checked').value === 'free';
      blBox.style.display = free ? 'none' : ''; freeBox.style.display = free ? '' : 'none';
      if (free && !editor) editor = Bill.linesEditor(m.$('#ni-lines'), null, { defaultVat: Number(settings.default_vat_rate ?? 20) });
    });
  }
  Bill.newInvoice = newInvoice;

  // ---------- tiroir de détail ----------
  Bill.openInvoice = async function (id, onChange) {
    let changed = false; let inv; let view = null; let editing = false; let pdfTick = Date.now();
    const d = Bill.drawer({ onClose: () => { if (changed && onChange) onChange(); } });
    d.body.innerHTML = '<div class="bl-spin">Chargement…</div>';
    const mark = () => { changed = true; };

    async function reload() {
      try { inv = (await Bill.get('/invoices/' + id)).invoice; } catch (err) { Bill.closeDrawer(); return Bill.fail(err); }
      pdfTick = Date.now();
      if (!view) view = inv.status === 'draft' ? 'detail' : 'preview';
      paint();
    }

    const isCn = () => inv.kind === 'credit_note';
    const pctFr = (r) => `${String(r).replace('.', ',')} %`;

    // Offre d'escompte encore ouverte (ou dépassée) sur une facture non soldée.
    function escompteNote() {
      const x = inv.escompte;
      if (!x || isCn() || inv.status !== 'issued' || !(inv.balanceCents > 0)) return '';
      if (x.open) return `<div class="bl-alert ok" style="margin-top:12px"><b>Escompte de ${pctFr(x.ratePct)} possible jusqu'au ${dFr(x.deadline)}</b><div>${eur(x.netCents)} à encaisser au lieu de ${eur(inv.balanceCents)} (escompte de ${eur(x.discountCents)}). Cochez « avec escompte » en enregistrant le règlement.</div></div>`;
      return `<p class="bl-hint" style="margin:12px 0">Escompte de ${pctFr(x.ratePct)} : délai dépassé depuis le ${dFr(x.deadline)}. Pour une remise exceptionnelle, créez un avoir.</p>`;
    }
    const display = () => (inv.status === 'draft' ? (isCn() ? 'credit_draft' : 'draft') : isCn() ? 'credit_note' : (inv.overdueDays > 0 && inv.paymentStatus !== 'paid' && inv.paymentStatus !== 'credited' ? 'overdue' : inv.paymentStatus));

    function paint() {
      const draft = inv.status === 'draft';
      const title = draft ? (isCn() ? "Brouillon d'avoir" : 'Brouillon de facture') : `${isCn() ? 'Avoir' : 'Facture'} ${inv.number}`;
      const acts = [];
      if (draft) {
        acts.push('<button class="bl-btn primary" data-a="issue">Émettre…</button>');
        if (!editing) acts.push('<button class="bl-btn" data-a="edit">Modifier</button>');
        acts.push('<button class="bl-btn danger" data-a="delete">Supprimer</button>');
      } else {
        if (!isCn() && inv.balanceCents > 0) acts.push('<button class="bl-btn primary" data-a="pay">Enregistrer un règlement</button>');
        acts.push(`<button class="bl-btn ${!isCn() && inv.balanceCents > 0 ? '' : 'primary'}" data-a="send">Envoyer par e-mail</button>`);
        if (!isCn() && inv.overdueDays > 0) acts.push('<button class="bl-btn" data-a="remind">Relancer</button>');
        if (!isCn() && inv.balanceCents !== null && inv.paymentStatus !== 'credited') acts.push('<button class="bl-btn" data-a="credit">Créer un avoir…</button>');
        acts.push('<button class="bl-btn" data-a="pdf">PDF</button>');
        acts.push('<button class="bl-btn" data-a="pl">Envoyer à Pennylane</button>');
      }
      d.setHead({ title: e(title), sub: `${e(inv.buyerName)} &nbsp;${Bill.pill(display())}`, actions: acts.join('') });
      const viewTabs = [['preview', 'Aperçu'], ['detail', 'Détail'], ['history', 'Historique']];
      d.body.innerHTML = `<div class="bl-tabs" style="margin:-4px 0 16px">${viewTabs.map(([k, l]) => `<button class="bl-tab ${view === k ? 'active' : ''}" data-v="${k}">${l}</button>`).join('')}</div><div id="dv"></div>`;
      d.body.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { view = b.dataset.v; editing = false; paint(); });
      ({ preview: paintPreview, detail: paintDetail, history: paintHistory })[view](d.body.querySelector('#dv'));
      d.head.querySelectorAll('[data-a]').forEach(b => b.onclick = () => ACTIONS[b.dataset.a](b));
    }

    function problemsAlert() {
      const p = inv.preview && inv.preview.problems;
      return p && p.length ? `<div class="bl-alert warn"><b>À compléter avant l'émission</b><ul>${p.map(x => `<li>${e(x)}</li>`).join('')}</ul><div style="margin-top:8px"><button class="bl-btn small" data-a2="settings">Ouvrir les coordonnées de l'émetteur</button></div></div>` : '';
    }

    function paintPreview(host) {
      host.innerHTML = `${inv.status === 'draft' ? problemsAlert() : ''}
        <iframe class="bl-pdf" title="Aperçu du PDF" src="${Bill.base}/invoices/${id}/pdf?v=${pdfTick}"></iframe>
        <div class="bl-pdf-fallback"><p>L'aperçu du PDF n'est pas affiché sur petit écran.</p><a class="bl-btn primary" href="${Bill.base}/invoices/${id}/pdf" target="_blank" rel="noopener">Ouvrir le PDF</a></div>
        <p class="bl-hint">${inv.status === 'draft' ? 'Aperçu du brouillon : le numéro et l\'empreinte sont attribués à l\'émission.' : 'Document définitif, tel qu\'il est envoyé au client.'} <a href="${Bill.base}/invoices/${id}/pdf" target="_blank" rel="noopener">Ouvrir dans un onglet</a></p>`;
      const s = host.querySelector('[data-a2="settings"]'); if (s) s.onclick = () => Bill.go('issuer');
    }

    function paintDetail(host) {
      if (editing) return paintEditor(host);
      const kv = [];
      kv.push(['Hôtel', e(inv.buyerName)]);
      if (inv.creditsInvoiceNumber) kv.push(['Avoir sur', e(inv.creditsInvoiceNumber)], ['Motif', e(inv.creditReason || '—')]);
      kv.push(["Date d'émission", inv.issueDate ? dFr(inv.issueDate) : '—']);
      if (!isCn()) kv.push(['Échéance', inv.dueDate ? dFr(inv.dueDate) + (inv.overdueDays ? ` <span style="color:var(--bl-late)">(${plural(inv.overdueDays, 'jour', 'jours')} de retard)</span>` : '') : '—']);
      const edDraft = inv.status === 'draft' && inv.preview && inv.preview.terms && inv.preview.terms.earlyDiscount;
      if (edDraft) kv.push(['Escompte', `${pctFr(edDraft.ratePct)} pour un règlement reçu dans les ${edDraft.hours} h suivant l'émission <span class="bl-faint">(figé à l'émission)</span>`]);
      if (inv.escompte) kv.push(['Escompte', `${pctFr(inv.escompte.ratePct)} pour un règlement reçu au plus tard le ${dFr(inv.escompte.deadline)}${inv.discountCents > 0 ? ' <span class="bl-tag ok">accordé</span>' : inv.escompte.expired ? ' <span class="bl-faint">(délai dépassé)</span>' : ''}`]);
      if (inv.periodStart) kv.push(['Période', `${dFr(inv.periodStart)} au ${dFr(inv.periodEnd)}`]);
      kv.push(['Nature', e(CATEGORY[inv.operationCategory] || inv.operationCategory)]);
      if (inv.reference) kv.push(['Référence', e(inv.reference)]);
      if (inv.notes) kv.push(['Note', e(inv.notes)]);
      if (inv.hash) kv.push(['Empreinte', `<span class="bl-code" title="${e(inv.hash)}">${e(inv.hash.slice(0, 24))}…</span>`]);
      if (inv.pennylane) kv.push(['Pennylane', inv.pennylane.status === 'sent' ? `Transmise le ${dtFr(inv.pennylane.sentAt)}` : inv.pennylane.status === 'error' ? `<span style="color:var(--bl-late)">Échec : ${e(inv.pennylane.lastError || '')}</span>` : 'En attente d\'envoi']);
      const sign = isCn() ? -1 : 1;
      host.innerHTML = `${inv.status === 'draft' ? problemsAlert() : ''}
        <div class="bl-panel"><div class="bl-panel-b"><dl class="bl-kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div></div>
        <div class="bl-panel"><div class="bl-tablewrap inv"><table class="bl-table inv"><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">Prix HT</th><th class="r">TVA</th><th class="r">Total HT</th></tr></thead><tbody>
          ${inv.lines.map(l => l.isSection ? `<tr><td colspan="5" style="background:var(--bl-row);font-weight:600">${e(l.description)}</td></tr>`
            : `<tr><td>${e(l.description)}</td><td class="r bl-num">${e(String(l.quantity).replace('.', ','))}</td><td class="r bl-num">${e(eur(Math.round(l.unitPrice * 100)))}</td><td class="r bl-num">${e(String(l.vatRate).replace('.', ','))} %</td><td class="r bl-num">${e(eur(sign * l.lineHtCents))}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="bl-panel-b"><div class="bl-totals">
          <div><span>Total HT</span><span class="bl-num">${eur(sign * inv.totalHtCents)}</span></div>
          ${(inv.vatBreakdown || []).map(v => `<div class="bl-muted"><span>TVA ${String(v.rate).replace('.', ',')} % sur ${eur(v.baseCents ?? v.base_cents ?? 0)}</span><span class="bl-num">${eur(sign * (v.vatCents ?? v.vat_cents ?? 0))}</span></div>`).join('')}
          <div class="grand"><span>Total TTC</span><span class="bl-num">${eur(sign * inv.totalTtcCents)}</span></div>
          ${!isCn() && inv.status === 'issued' ? `${inv.creditedCents ? `<div><span>Avoirs</span><span class="bl-num">− ${eur(inv.creditedCents)}</span></div>` : ''}${inv.discountCents ? `<div><span>Escompte accordé</span><span class="bl-num">− ${eur(inv.discountCents)}</span></div>` : ''}<div><span>Déjà réglé</span><span class="bl-num">${eur(inv.cashCents ?? inv.paidCents)}</span></div><div class="${inv.balanceCents > 0 ? 'due' : ''}"><span>Reste à payer</span><span class="bl-num">${eur(inv.balanceCents)}</span></div>` : ''}
        </div></div></div>
        ${escompteNote()}
        ${inv.payments && inv.payments.length ? `<div class="bl-panel"><div class="bl-panel-h"><h3>Règlements</h3></div><div class="bl-tablewrap"><table class="bl-table"><tbody>${inv.payments.map(p => `<tr><td class="bl-num">${dFr(p.paidOn)}</td><td>${p.method === 'escompte' ? '<i>Escompte accordé</i>' : e(Bill.METHODS[p.method] || p.method)}${p.reference ? `<span class="sub">${e(p.reference)}</span>` : ''}</td><td class="r bl-num" style="${p.amountCents < 0 ? 'color:var(--bl-late)' : p.method === 'escompte' ? 'color:#8C9DAE' : ''}">${p.method === 'escompte' ? `(${eur(p.amountCents)})` : eur(p.amountCents)}</td><td class="r">${p.method === 'escompte' ? `<span class="bl-faint">${p.amountCents > 0 ? 'avec le règlement' : 'annulation'}</span>` : p.amountCents > 0 ? `<button class="bl-btn link small" data-undo="${p.id}">Annuler</button>` : '<span class="bl-faint">annulation</span>'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
        ${inv.creditNotes && inv.creditNotes.length ? `<div class="bl-panel"><div class="bl-panel-h"><h3>Avoirs liés</h3></div><div class="bl-tablewrap"><table class="bl-table"><tbody>${inv.creditNotes.map(c => `<tr class="bl-row" tabindex="0" data-cn="${c.id}"><td><b style="font-weight:600">${e(c.number)}</b></td><td class="bl-num">${dFr(c.issueDate)}</td><td class="r bl-num">− ${eur(c.totalTtcCents)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
      const s = host.querySelector('[data-a2="settings"]'); if (s) s.onclick = () => Bill.go('issuer');
      host.querySelectorAll('[data-cn]').forEach(tr => tr.onclick = () => Bill.openInvoice(Number(tr.dataset.cn), onChange));
      host.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => undoPayment(Number(b.dataset.undo)));
    }

    function paintEditor(host) {
      host.innerHTML = `<div class="bl-panel"><div class="bl-panel-b">
        <div class="bl-row3"><div class="bl-field"><label for="de-date">Date d'émission</label><input id="de-date" type="date" value="${e(inv.issueDate || '')}"><div class="bl-hint">Laissez vide pour la date du jour à l'émission.</div></div>
        <div class="bl-field"><label for="de-cat">Nature de l'opération</label><select id="de-cat">${Object.entries(CATEGORY).map(([k, v]) => `<option value="${k}" ${inv.operationCategory === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="bl-field"><label for="de-ref">Référence</label><input id="de-ref" value="${e(inv.reference || '')}"></div></div>
        <div class="bl-field"><label for="de-notes">Note visible sur la facture</label><input id="de-notes" value="${e(inv.notes || '')}"></div>
        <div id="de-lines"></div>
        <div class="bl-err" id="de-err" role="alert"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="bl-btn" id="de-cancel">Annuler</button><button class="bl-btn primary" id="de-save">Enregistrer</button></div></div></div>`;
      const ed = Bill.linesEditor(host.querySelector('#de-lines'), inv.lines.map(l => ({ isSection: l.isSection, description: l.description, sageCode: l.sageCode, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })));
      host.querySelector('#de-cancel').onclick = () => { editing = false; paint(); };
      host.querySelector('#de-save').onclick = async (ev) => {
        ev.target.disabled = true;
        try {
          await Bill.put('/invoices/' + id, { lines: ed.get(), operationCategory: host.querySelector('#de-cat').value, reference: host.querySelector('#de-ref').value.trim(), notes: host.querySelector('#de-notes').value.trim(), issueDate: host.querySelector('#de-date').value || null });
          editing = false; mark(); Bill.toast('Brouillon enregistré'); await reload();
        } catch (err) { ev.target.disabled = false; Bill.fail(err, host.querySelector('#de-err')); }
      };
    }

    function paintHistory(host) {
      host.innerHTML = inv.timeline.length
        ? `<ul class="bl-timeline">${inv.timeline.map(t => `<li class="${t.failed ? 'failed' : ''}"><b>${e(t.label)}</b>${t.detail ? `<small>${e(t.detail)}</small>` : ''}<small>${dtFr(t.at)}</small></li>`).join('')}</ul>`
        : '<div class="bl-empty">Aucun événement.</div>';
    }

    // ----- actions -----
    async function undoPayment(paymentId) {
      const p = inv.payments.find(x => x.id === paymentId);
      const text = `Une écriture inverse de ${eur(p.amountCents)} sera ajoutée. Le règlement d'origine reste visible dans l'historique, rien n'est effacé.`;
      const post = async (extra) => {
        await Bill.post(`/invoices/${id}/payments`, { paidOn: today(), amount: -p.amountCents / 100, method: p.method, reference: `Annulation du règlement du ${dFr(p.paidOn)}`, ...extra });
        mark(); Bill.toast('Règlement annulé'); await reload();
      };
      if (!(inv.discountCents > 0)) {
        if (!(await Bill.confirm('Annuler ce règlement ?', text, 'Annuler le règlement', true))) return;
        try { await post({}); } catch (err) { Bill.fail(err); }
        return;
      }
      // Un escompte a été accordé : on propose de l'annuler avec le règlement (la facture se rouvre pour son montant complet).
      Bill.modal({
        title: 'Annuler ce règlement ?',
        body: `<p class="bl-note">${e(text)}</p>
          <div class="bl-field"><label class="bl-check"><input type="checkbox" id="un-esc" checked> Annuler aussi l'escompte accordé (${e(eur(inv.discountCents))})</label>
          <div class="bl-hint">Décochez si l'escompte reste acquis à l'hôtel : il ne devra alors que le reste, sans l'escompte.</div></div>`,
        buttons: [{ label: 'Garder le règlement', onClick: async () => {} },
          { label: 'Annuler le règlement', danger: true, onClick: async (m) => { await post({ reverseDiscount: m.$('#un-esc').checked }); } }],
      });
    }

    const ACTIONS = {
      edit() { editing = true; view = 'detail'; paint(); },
      async delete() {
        if (!(await Bill.confirm('Supprimer ce brouillon ?', 'Le brouillon sera effacé. Les bons de livraison redeviennent facturables.', 'Supprimer', true))) return;
        try { await Bill.del('/invoices/' + id); mark(); Bill.closeDrawer(); Bill.toast('Brouillon supprimé'); } catch (err) { Bill.fail(err); }
      },
      issue() {
        const problems = inv.preview && inv.preview.problems || [];
        const kindLabel = isCn() ? "l'avoir" : 'la facture';
        Bill.sensitive({
          title: isCn() ? "Émettre l'avoir" : 'Émettre la facture', scope: `issue:${id}`, okLabel: 'Émettre définitivement',
          text: `Une fois émis, ${kindLabel} reçoit son numéro définitif et ne peut plus être modifié ni supprimé. Pour corriger, il faudra émettre un avoir.`,
          body: `${problems.length ? `<div class="bl-alert warn"><b>Impossible pour l'instant</b><ul>${problems.map(x => `<li>${e(x)}</li>`).join('')}</ul></div>` : ''}
            <div class="bl-row2"><div class="bl-field"><label for="is-date">Date d'émission</label><input id="is-date" type="date" value="${e(inv.issueDate || today())}"></div>
            <div class="bl-field"><label>Montant</label><div style="padding:8px 0;font-weight:600" class="bl-num">${eur((isCn() ? -1 : 1) * inv.totalTtcCents)} TTC</div></div></div>`,
          onOpen: (m) => { if (problems.length) m.el.querySelector('.bl-foot .primary').disabled = true; },
          onSubmit: async (m) => {
            const r = await Bill.post(`/invoices/${id}/issue`, { issueDate: m.$('#is-date').value || undefined });
            mark(); Bill.toast(`${r.invoice.number} émis`); view = 'preview'; await reload();
          },
        });
      },
      pay() {
        const x = inv.escompte && inv.balanceCents > 0 ? inv.escompte : null;
        const net = x ? x.netCents : null;
        Bill.modal({
          title: 'Enregistrer un règlement',
          body: `<p class="bl-note">Reste à payer : <b>${eur(inv.balanceCents)}</b>. Pour un règlement partiel, indiquez le montant reçu.</p>
            <div class="bl-row2"><div class="bl-field"><label for="py-date">Date de réception</label><input id="py-date" type="date" value="${today()}"></div>
            <div class="bl-field"><label for="py-amt">Montant reçu (€)</label><input id="py-amt" inputmode="decimal" value="${(inv.balanceCents / 100).toFixed(2).replace('.', ',')}"></div></div>
            ${x ? `<div class="bl-field"><label class="bl-check"><input type="checkbox" id="py-esc"> Règlement avec escompte de ${pctFr(x.ratePct)} : <b>${eur(net)}</b> soldent la facture</label>
              <div class="bl-hint" id="py-esc-h"></div></div>` : ''}
            <div class="bl-row2"><div class="bl-field"><label for="py-m">Mode de paiement</label><select id="py-m">${Object.entries(Bill.METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
            <div class="bl-field"><label for="py-ref">Référence (facultatif)</label><input id="py-ref" placeholder="N° de chèque, libellé du virement…"></div></div>`,
          onOpen: (m) => {
            if (!x) return;
            const cb = m.$('#py-esc'); const date = m.$('#py-date'); const amt = m.$('#py-amt'); const hint = m.$('#py-esc-h');
            const eligible = () => !!date.value && date.value <= x.deadline;
            const fullAmount = (inv.balanceCents / 100).toFixed(2).replace('.', ',');
            const sync = () => {
              const ok = eligible();
              cb.disabled = !ok; if (!ok) cb.checked = false;
              hint.textContent = ok
                ? (cb.checked ? `L'escompte de ${eur(x.discountCents)} est comptabilisé à part : l'argent reçu est de ${eur(net)}.` : `Possible pour un règlement reçu au plus tard le ${dFr(x.deadline)}.`)
                : `Délai dépassé : l'escompte devait être réglé au plus tard le ${dFr(x.deadline)}.`;
              amt.disabled = cb.checked;
              amt.value = cb.checked ? (net / 100).toFixed(2).replace('.', ',') : (amt.dataset.touched ? amt.value : fullAmount);
            };
            cb.checked = eligible(); // par défaut : coché tant que le délai est tenu
            cb.onchange = sync; date.onchange = sync; date.oninput = sync;
            amt.oninput = () => { amt.dataset.touched = '1'; };
            sync();
          },
          buttons: [{ label: 'Annuler', onClick: async () => {} }, { label: 'Enregistrer', primary: true, onClick: async (m) => {
            const withDiscount = !!(x && m.$('#py-esc').checked);
            const amount = withDiscount ? net / 100 : Number(m.$('#py-amt').value.replace(/\s/g, '').replace(',', '.'));
            if (!(amount > 0)) throw new Error('Indiquez un montant supérieur à zéro.');
            await Bill.post(`/invoices/${id}/payments`, { paidOn: m.$('#py-date').value, amount, method: m.$('#py-m').value, reference: m.$('#py-ref').value.trim() || undefined, ...(withDiscount ? { withDiscount: true } : {}) });
            mark(); Bill.toast(withDiscount ? 'Règlement enregistré avec escompte' : 'Règlement enregistré'); await reload();
          } }],
        });
      },
      send() {
        Bill.mailModal({ title: isCn() ? "Envoyer l'avoir" : 'Envoyer la facture', previewPath: `/invoices/${id}/mail-preview?kind=invoice`, sendPath: `/invoices/${id}/send`, pdfPath: `/invoices/${id}/pdf`, onDone: async () => { mark(); await reload(); } });
      },
      remind() { if (Bill.remind) Bill.remind(id, { onDone: async () => { mark(); await reload(); } }); },
      pdf() { Bill.openPdf(`/invoices/${id}/pdf`); },
      async pl(btn) {
        btn.disabled = true;
        try {
          const r = (await Bill.post('/pennylane/send', { invoiceIds: [id] })).results[0];
          if (r.status === 'sent') Bill.toast('Transmise à Pennylane'); else Bill.toast(r.error || 'Envoi à Pennylane impossible', true);
          mark(); await reload();
        } catch (err) { btn.disabled = false; Bill.fail(err); }
      },
      async credit() { await creditModal(); },
    };

    async function creditModal() {
      // Quantités déjà créditées par ligne (avoirs émis) pour borner la saisie.
      const done = new Map();
      for (const c of inv.creditNotes || []) {
        try { for (const l of (await Bill.get('/invoices/' + c.id)).invoice.lines) if (l.creditOfLineId) done.set(l.creditOfLineId, (done.get(l.creditOfLineId) || 0) + l.quantity); } catch (_) { /* borne approximative : le serveur contrôle */ }
      }
      const real = inv.lines.filter(l => !l.isSection).map(l => ({ ...l, rest: Math.round((l.quantity - (done.get(l.id) || 0)) * 1e6) / 1e6 })).filter(l => l.rest !== 0);   // une ligne en quantité négative (reprise) se crédite en négatif
      if (!real.length) return Bill.toast('Cette facture est déjà intégralement créditée.', true);
      Bill.sensitive({
        title: 'Créer un avoir', scope: `credit:${id}`, okLabel: 'Créer le brouillon d\'avoir', wide: true,
        text: 'Un avoir annule tout ou partie de la facture. Il est créé en brouillon : vous le vérifierez, puis l\'émettrez avec le code.',
        body: `<div class="bl-field"><label for="cn-reason">Motif de l'avoir</label><input id="cn-reason" placeholder="Ex. erreur de quantité, article non livré, geste commercial"></div>
          <div class="bl-field"><label class="bl-check"><input type="radio" name="cn-m" value="full" checked> Avoir total (${eur(inv.totalTtcCents - inv.creditedCents)} TTC restant)</label>
          <label class="bl-check" style="margin-top:6px"><input type="radio" name="cn-m" value="part"> Avoir partiel : choisir les quantités à créditer</label></div>
          <div id="cn-lines" style="display:none"><div class="bl-tablewrap"><table class="bl-table bl-lines"><thead><tr><th>Désignation</th><th class="r">Restant</th><th style="width:100px">À créditer</th></tr></thead><tbody>
            ${real.map(l => `<tr><td>${e(l.description)}</td><td class="r bl-num">${e(String(l.rest).replace('.', ','))}</td><td><input data-line="${l.id}" data-max="${l.rest}" placeholder="${l.rest < 0 ? '-0' : '0'}" title="${l.rest < 0 ? 'Ligne de reprise : saisissez une quantité négative' : ''}" aria-label="Quantité à créditer : ${e(l.description)}"></td></tr>`).join('')}</tbody></table></div></div>`,
        onOpen: (m) => m.el.querySelectorAll('input[name="cn-m"]').forEach(r => r.onchange = () => { m.$('#cn-lines').style.display = m.el.querySelector('input[name="cn-m"]:checked').value === 'part' ? '' : 'none'; }),
        onSubmit: async (m) => {
          const reason = m.$('#cn-reason').value.trim(); if (!reason) throw new Error("Indiquez le motif de l'avoir.");
          const full = m.el.querySelector('input[name="cn-m"]:checked').value === 'full';
          const lines = full ? undefined : [...m.el.querySelectorAll('[data-line]')].map(i => ({ lineId: Number(i.dataset.line), quantity: Number(String(i.value).replace(',', '.')) })).filter(x => Number.isFinite(x.quantity) && x.quantity !== 0);
          if (!full && !lines.length) throw new Error('Indiquez au moins une quantité à créditer.');
          const r = await Bill.post(`/invoices/${id}/credit-note`, { reason, full, lines });
          mark(); Bill.toast("Brouillon d'avoir créé");
          Bill.openInvoice(r.invoice.id, onChange);
        },
      });
    }

    reload();
  };
})();
