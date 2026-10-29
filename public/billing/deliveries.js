// Bons de livraison : les commandes livrées, filtrables par période, par hôtel et par état de facturation.
(function () {
  const { e, eur, dFr, today, plural } = Bill;
  const TABS = [['', 'Tous'], ['to_invoice', 'À facturer'], ['draft', 'Dans un brouillon'], ['invoiced', 'Facturés']];
  const MAX_PDF = 500;
  // Paiement de la facture d'un BL facturé : mêmes libellés et mêmes pastilles que la liste des factures.
  const PAY = [['unpaid', 'À encaisser'], ['overdue', 'En retard'], ['partial', 'Partielles'], ['paid', 'Payés']];
  const S = { status: '', pay: new Set(), q: '', clientId: '', from: '', to: '', sort: 'date', dir: 'desc' };
  let R = null;   // dernière réponse du serveur

  // ---------- périodes rapides ----------
  const iso = (d) => d.toISOString().slice(0, 10);
  const utc = (s) => new Date(s + 'T00:00:00Z');
  function preset(key) {
    const t = today(); const d = utc(t);
    if (key === 'month') return [t.slice(0, 8) + '01', t];
    if (key === 'last') { const a = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)); const b = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)); return [iso(a), iso(b)]; }
    if (key === '30') { const a = new Date(d); a.setUTCDate(a.getUTCDate() - 29); return [iso(a), t]; }
    return ['', ''];
  }
  const PRESETS = [['month', 'Ce mois-ci'], ['last', 'Mois dernier'], ['30', '30 derniers jours'], ['all', 'Toute la période']];

  function qs(extra = {}) {
    const p = new URLSearchParams(extra);
    for (const k of ['status', 'q', 'clientId', 'from', 'to']) if (S[k]) p.set(k, S[k]);
    if (S.pay.size) p.set('payment', [...S.pay].join(','));
    return p.toString();
  }

  // ---------- état de facturation ----------
  function billingTag(b) {
    if (b.status === 'to_invoice') return '<span class="bl-tag wait">À facturer</span>';
    if (b.status === 'draft') return '<span class="bl-tag info">Dans un brouillon</span>';
    return `<span class="bl-tag ok">Facturé</span>${b.invoiceNumber ? `<span class="sub bl-num">${e(b.invoiceNumber)}</span>` : (b.legacy ? '<span class="sub">ancien circuit</span>' : '')}`;
  }
  // « Payée », « En retard »… la même pastille que dans la liste des factures ; rien pour l'ancien circuit (paiement non suivi).
  const payTag = (b) => (b.payment ? Bill.pill(b.payment) : '');

  // ---------- liste ----------
  const SORTERS = {
    date: (a, b) => a.date.localeCompare(b.date) || a.id - b.id,
    ticket: (a, b) => a.ticket.localeCompare(b.ticket, 'fr', { numeric: true }),
    client: (a, b) => a.clientName.localeCompare(b.clientName, 'fr') || a.date.localeCompare(b.date),
    amount: (a, b) => a.htCents - b.htCents,
  };
  const sortTh = (key, label, cls = '') => {
    const on = S.sort === key; const arrow = on ? (S.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th class="sortable ${cls}" data-sort="${key}" ${on ? `aria-sort="${S.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${label}${arrow}</th>`;
  };

  function rowHtml(d) {
    return `<tr class="bl-row" tabindex="0" data-id="${d.id}">
      <td class="bl-num"><b style="font-weight:600">${e(d.ticket)}</b></td>
      <td class="bl-num">${dFr(d.date)}</td>
      <td class="client">${e(d.clientName)}</td>
      <td class="bl-muted">${plural(d.refs, 'référence', 'références')} · ${plural(d.pieces, 'pièce', 'pièces')}</td>
      <td class="r bl-num">${eur(d.htCents)}</td>
      <td>${billingTag(d.billing)}</td>
      <td>${payTag(d.billing) || '<span class="bl-muted">—</span>'}</td></tr>`;
  }

  function summary() {
    const t = R.totals; const todo = t.byStatus.to_invoice;
    if (!R.total) return '';
    const parts = [`<b>${plural(R.total, 'bon de livraison', 'bons de livraison')}</b> · ${eur(t.htCents)} HT`];
    if (!S.status && todo.count && todo.count < R.total) parts.push(`dont ${plural(todo.count, 'à facturer', 'à facturer')} : ${eur(todo.htCents)} HT`);
    return parts.join(' — ');
  }

  function paint(main) {
    const box = main.querySelector('#dl-table');
    main.querySelector('#dl-tabs').innerHTML = TABS.map(([k, label]) =>
      `<button class="bl-tab ${S.status === k ? 'active' : ''}" data-tab="${k}">${label}<small>${R.counts[k || 'all']}</small></button>`).join('');
    main.querySelectorAll('#dl-tabs [data-tab]').forEach(b => b.onclick = () => { S.status = b.dataset.tab; load(main); });
    main.querySelector('#dl-pay').innerHTML = `<span class="bl-muted">Paiement</span>`
      + PAY.map(([k, label]) => `<button type="button" class="bl-chipf ${S.pay.has(k) ? 'on' : ''} ${k === 'overdue' && R.counts.payments[k] ? 'late' : ''}" data-pay="${k}" aria-pressed="${S.pay.has(k)}"><i class="bl-dot ${k}"></i>${label} <b>${R.counts.payments[k]}</b></button>`).join('')
      + (S.pay.size ? '<button type="button" class="bl-btn link small" id="dl-pay-clear">Tout afficher</button>' : '');
    main.querySelectorAll('#dl-pay [data-pay]').forEach(b => b.onclick = () => { const k = b.dataset.pay; if (S.pay.has(k)) S.pay.delete(k); else S.pay.add(k); load(main); });
    const clr = main.querySelector('#dl-pay-clear'); if (clr) clr.onclick = () => { S.pay.clear(); load(main); };
    main.querySelector('#dl-sum').innerHTML = summary();
    paintUnlinked(main);

    const pdf = main.querySelector('#dl-pdf'); const csv = main.querySelector('#dl-csv');
    pdf.disabled = !R.total || R.total > MAX_PDF; csv.disabled = !R.total;
    pdf.textContent = R.total ? `Télécharger ${plural(R.total, 'BL', 'BL')} (PDF)` : 'Télécharger les BL (PDF)';
    pdf.title = R.total > MAX_PDF ? `Un PDF contient ${MAX_PDF} BL au plus : resserrez la période ou choisissez un hôtel.` : 'Un seul PDF, un bon par page, du plus ancien au plus récent';

    if (!R.deliveries.length) {
      const filtered = S.q || S.clientId || S.from || S.to || S.status || S.pay.size;
      box.innerHTML = `<div class="bl-empty"><b>${filtered ? 'Aucun bon de livraison' : 'Aucune livraison pour le moment'}</b>${filtered ? 'Aucun BL ne correspond à ces filtres : élargissez la période, changez d\'hôtel ou de statut.' : 'Un bon de livraison apparaît ici dès qu\'une commande est marquée « Livrée ».'}</div>`;
      return;
    }
    const rows = [...R.deliveries].sort(SORTERS[S.sort]); if (S.dir === 'desc') rows.reverse();
    box.innerHTML = `<div class="bl-tablewrap"><table class="bl-table"><thead><tr>${sortTh('ticket', 'Bon')}${sortTh('date', 'Livré le')}${sortTh('client', 'Hôtel')}<th>Contenu</th>${sortTh('amount', 'Montant HT', 'r')}<th>Facturation</th><th>Paiement</th></tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody></table></div>
      ${R.truncated ? `<p class="bl-hint" style="padding:10px 14px">Les ${R.deliveries.length} plus récents sont affichés sur ${R.total}. Resserrez la période pour voir les autres.</p>` : ''}`;
    box.querySelectorAll('[data-sort]').forEach(th => th.onclick = () => {
      const k = th.dataset.sort; if (S.sort === k) S.dir = S.dir === 'asc' ? 'desc' : 'asc'; else { S.sort = k; S.dir = (k === 'client' || k === 'ticket') ? 'asc' : 'desc'; } paint(main);
    });
    box.querySelectorAll('tr.bl-row').forEach(tr => {
      const open = () => openDelivery(Number(tr.dataset.id), () => load(main));
      tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    });
  }

  // ---------- BL dont le nom d'hôtel a été saisi librement ----------
  function paintUnlinked(main) {
    const box = main.querySelector('#dl-unlinked'); if (!box) return;
    const u = R && R.unlinked;
    if (!u || !u.orders) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="bl-alert warn bl-unlinked" role="status"><div><b>${plural(u.orders, 'commande n\'a', 'commandes n\'ont')} pas de fiche hôtel</b>
      <span>${u.delivered ? `dont ${plural(u.delivered, 'BL livré', 'BL livrés')}` : ''} — le nom a été tapé à la main (« HOTEL LAVANDES », « Hôtel Lavandes SAS »…). Ces bons n'apparaissent sous aucun hôtel, ne sont pas facturés par lot et n'ont pas le tarif négocié. Regroupez-les en quelques clics.</span></div>
      <button class="bl-btn primary" id="dl-link">Regrouper ces BL</button></div>`;
    box.querySelector('#dl-link').onclick = () => openUnlinked(main);
  }

  async function openUnlinked(main) {
    let U; let clients;
    try { [U, clients] = await Promise.all([Bill.get('/deliveries/unlinked'), Bill.clients(true)]); } catch (err) { return Bill.fail(err); }
    if (!U.groups.length) { Bill.toast('Plus aucun BL sans fiche hôtel.'); return load(main); }
    const CONF = { high: 'Sûr', medium: 'Probable', low: 'À vérifier' };
    const STATE = { livree: 'livré', recue: 'reçue', traitement: 'en cours', prete: 'prête' };
    const preset = (g) => { const s = g.suggestions[0]; return s && s.confidence === 'high' ? `c:${s.clientId}` : ''; };
    const options = (g) => {
      const ids = new Set(g.suggestions.map(s => s.clientId)); const pre = preset(g);
      const sug = g.suggestions.map(s => `<option value="c:${s.clientId}" ${pre === `c:${s.clientId}` ? 'selected' : ''}>${e(s.societe)}${s.place ? ` (${e(s.place.slice(0, 40))})` : ''} — ${CONF[s.confidence]}${s.why.length ? ` (${e(s.why.join(', '))})` : ''}</option>`).join('');
      const rest = clients.filter(c => !ids.has(c.id)).map(c => `<option value="c:${c.id}">${e(c.societe)}</option>`).join('');
      const named = !g.key.startsWith('__');
      return `<option value="" ${pre ? '' : 'selected'}>Choisir un hôtel…</option>${sug ? `<optgroup label="Hôtels proposés">${sug}</optgroup>` : ''}
        ${named ? `<option value="new">➕ Créer la fiche « ${e(g.name)} »</option>` : ''}<optgroup label="Tous les hôtels">${rest}</optgroup>`;
    };
    // Une ligne par BL : on voit le nom tapé, l'adresse, la date, l'état — et on peut écarter ce qui n'est pas le bon hôtel.
    const orderRow = (o) => `<tr><td><input type="checkbox" class="ul-o" value="${o.id}" checked aria-label="Rattacher le bon ${e(o.ticket)}"></td>
      <td class="bl-num"><b style="font-weight:600">${e(o.ticket)}</b></td><td class="bl-num">${dFr(o.date)}</td><td>${e(o.name)}</td>
      <td class="bl-muted">${e(o.adresse || '—')}</td><td class="r bl-num">${eur(o.htCents)}</td>
      <td>${o.billed ? '<span class="bl-tag ok">facturé (ancien circuit)</span>' : `<span class="bl-tag ${o.status === 'livree' ? 'wait' : 'info'}">${STATE[o.status] || e(o.status)}</span>`}</td></tr>`;
    const row = (g) => `<tr data-key="${e(g.key)}" class="ul-g">
      <td><input type="checkbox" class="ul-c" aria-label="Rattacher ${e(g.name)}" ${preset(g) ? 'checked' : ''}></td>
      <td class="client"><span class="ul-name">${e(g.name)}</span>${g.variants.length > 1 ? `<span class="sub">aussi écrit : ${e(g.variants.slice(1, 5).map(v => `${v.name} (${v.orders})`).join(' · '))}${g.variants.length > 5 ? '…' : ''}</span>` : ''}
        ${g.adresse ? `<span class="sub">${e(g.adresse)}${g.tel ? ' · ' + e(g.tel) : ''}</span>` : ''}</td>
      <td class="bl-num"><span class="ul-count">${plural(g.orders, 'commande', 'commandes')}</span><span class="sub">${g.toInvoice ? `${plural(g.toInvoice, 'à facturer', 'à facturer')} · ${eur(g.toInvoiceHtCents)} HT` : 'rien à facturer'}</span></td>
      <td class="bl-num">${dFr(g.firstDate)}${g.lastDate !== g.firstDate ? `<span class="sub">au ${dFr(g.lastDate)}</span>` : ''}</td>
      <td style="min-width:250px"><select class="bl-input ul-s" aria-label="Hôtel pour ${e(g.name)}">${options(g)}</select>
        <button type="button" class="bl-btn link small ul-more" aria-expanded="false">Vérifier les ${g.orders} BL</button></td></tr>
      <tr class="ul-detail" data-for="${e(g.key)}" hidden><td></td><td colspan="4">
        <div class="bl-tablewrap" style="max-height:240px;overflow:auto"><table class="bl-table"><thead><tr><th style="width:30px"></th><th>Bon</th><th>Date</th><th>Nom tapé</th><th>Adresse</th><th class="r">HT</th><th>État</th></tr></thead>
        <tbody>${g.orderList.map(orderRow).join('')}</tbody></table></div>
        ${g.truncated ? `<p class="bl-hint">Les ${g.orderList.length} plus récents sont listés sur ${g.orders} ; les autres resteront à rattacher ensuite.</p>` : ''}
        <p class="bl-hint">Décochez un bon qui ne concerne pas cet hôtel : il restera dans la liste, à traiter à part.</p></td></tr>`;
    const nameOf = (tr) => tr.querySelector('.ul-name').textContent;
    const detailOf = (m, key) => [...m.el.querySelectorAll('tr.ul-detail')].find(t => t.dataset.for === key);
    const pick = (m) => [...m.el.querySelectorAll('tr.ul-g')].filter(tr => tr.querySelector('.ul-c').checked).map(tr => {
      const v = tr.querySelector('.ul-s').value;
      if (!v) throw new Error(`Choisissez un hôtel pour « ${nameOf(tr)} », ou décochez-le.`);
      const orderIds = [...detailOf(m, tr.dataset.key).querySelectorAll('.ul-o:checked')].map(x => Number(x.value));
      if (!orderIds.length) throw new Error(`Aucun bon coché pour « ${nameOf(tr)} » : décochez le groupe ou cochez au moins un bon.`);
      return v === 'new' ? { key: tr.dataset.key, create: true, orderIds } : { key: tr.dataset.key, clientId: Number(v.slice(2)), orderIds };
    });
    let items = []; let reprice = false;
    Bill.previewThenConfirm({
      title: 'Regrouper les BL sans fiche hôtel', applyLabel: 'Rattacher', previewLabel: 'Voir le résultat', scope: 'orders-link',
      body: `<p class="bl-note">Les écritures d'un même nom sont déjà regroupées (majuscules, accents, « SAS » ignorés). Pour chaque groupe, <b>ouvrez « Vérifier les BL »</b> pour voir chaque bon, puis choisissez la fiche hôtel : le logiciel propose la plus proche. Le nom tapé sur chaque BL n'est jamais modifié, seul le lien avec l'hôtel est ajouté. Le résultat exact s'affiche avant que rien ne soit écrit.</p>
        <div class="bl-tablewrap" style="max-height:380px;overflow:auto"><table class="bl-table"><thead><tr><th style="width:34px"></th><th>Nom saisi</th><th>Commandes</th><th>Période</th><th>Rattacher à</th></tr></thead>
        <tbody>${U.groups.map(row).join('')}</tbody></table></div>
        <label class="bl-check" style="margin-top:12px"><input type="checkbox" id="ul-reprice"> Recalculer aussi les BL non facturés au tarif négocié de l'hôtel <span class="bl-muted">(jamais les BL déjà facturés — le détail s'affiche dans le résultat)</span></label>`,
      onOpen: (m) => {
        m.el.classList.add('xl');   // un tableau de vérification demande de la largeur
        m.el.querySelectorAll('tr.ul-g').forEach(tr => {
          const sel = tr.querySelector('.ul-s'); const box = tr.querySelector('.ul-c'); const det = detailOf(m, tr.dataset.key); const btn = tr.querySelector('.ul-more');
          sel.addEventListener('change', () => { box.checked = !!sel.value; });      // choisir un hôtel coche le groupe
          btn.addEventListener('click', () => { det.hidden = !det.hidden; btn.setAttribute('aria-expanded', String(!det.hidden)); btn.textContent = det.hidden ? `Vérifier les ${det.querySelectorAll('.ul-o').length} BL` : 'Masquer les BL'; });
          const count = () => {
            const all = det.querySelectorAll('.ul-o'); const on = det.querySelectorAll('.ul-o:checked');
            tr.querySelector('.ul-count').textContent = on.length === all.length ? plural(all.length, 'commande', 'commandes') : `${on.length} sur ${all.length} commandes`;
          };
          det.addEventListener('change', (ev) => { if (ev.target.classList.contains('ul-o')) count(); });
        });
      },
      preview: async (m) => {
        items = pick(m); reprice = m.$('#ul-reprice').checked;
        if (!items.length) throw new Error('Cochez au moins un groupe et choisissez son hôtel.');
        const r = await Bill.post('/deliveries/unlinked/link', { items, reprice });
        const created = r.results.filter(x => x.created).length;
        const left = r.results.reduce((s, x) => s + x.left, 0);
        const block = (x) => `<details class="ul-res" ${x.orders <= 6 ? 'open' : ''}><summary><b>${e(x.name)}</b> → <b>${e(x.client)}</b>${x.created ? ' <span class="bl-tag info">nouvelle fiche</span>' : ''} · ${plural(x.orders, 'commande', 'commandes')}${x.left ? ` <span class="bl-muted">(${plural(x.left, 'autre laissée', 'autres laissées')} de côté)</span>` : ''}</summary>
          <div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Bon</th><th>Date</th><th>Nom tapé</th><th class="r">HT</th></tr></thead><tbody>
          ${x.list.map(o => `<tr><td class="bl-num">${e(o.ticket)}</td><td class="bl-num">${dFr(o.date)}</td><td>${e(o.name)}</td><td class="r bl-num">${eur(o.htCents)}</td></tr>`).join('')}</tbody></table></div></details>`;
        const rp = r.repriced;
        return {
          canApply: r.orders > 0,
          confirm: `${plural(r.orders, 'commande sera rattachée', 'commandes seront rattachées')} à ${plural(r.groups, 'hôtel', 'hôtels')}${created ? ` (dont ${plural(created, 'fiche créée', 'fiches créées')})` : ''}.${rp.orders ? ` ${plural(rp.orders, 'BL sera recalculé', 'BL seront recalculés')} (écart ${eur(rp.deltaCents)} HT).` : ''}`,
          html: `<div class="bl-alert ok"><b>${plural(r.orders, 'commande sera rattachée', 'commandes seront rattachées')}</b> à ${plural(r.groups, 'hôtel', 'hôtels')} — il en resterait ${r.remaining.orders} sans fiche${left ? ` (dont ${left} écartée(s) à l'instant)` : ''}. Rien n'est encore écrit : vérifiez chaque regroupement ci-dessous.</div>
            <div style="max-height:300px;overflow:auto">${r.results.map(block).join('')}</div>
            ${reprice ? (rp.orders ? `<div class="bl-alert warn" style="margin-top:10px"><b>${plural(rp.orders, 'BL non facturé sera recalculé', 'BL non facturés seront recalculés')}</b> au tarif négocié de leur hôtel : écart total ${eur(rp.deltaCents)} HT${rp.skippedInDraft ? ` (${plural(rp.skippedInDraft, 'BL dans un brouillon est laissé', 'BL dans un brouillon sont laissés')} tel quel)` : ''}.
              <ul>${rp.detail.slice(0, 30).map(d => `<li>${e(d.ticket)} : ${d.lines.map(l => `${e(l.name)} ${Bill.num3(l.from)} → <b>${Bill.num3(l.to)}</b> × ${l.qty}`).join(' ; ')} — ${eur(d.deltaCents)}</li>`).join('')}${rp.detail.length > 30 ? `<li>… et ${rp.detail.length - 30} autres</li>` : ''}</ul></div>` : '<div class="bl-hint" style="margin-top:10px">Aucun prix à recalculer : ces hôtels n\'ont pas de tarif négocié différent du catalogue.</div>') : ''}`,
        };
      },
      apply: async () => {
        const r = await Bill.post('/deliveries/unlinked/link', { items, reprice, apply: true });
        Bill.toast(`${plural(r.orders, 'commande rattachée', 'commandes rattachées')}${r.repriced.orders ? `, ${plural(r.repriced.orders, 'BL recalculé', 'BL recalculés')}` : ''}`);
        await Bill.clients(true).catch(() => {});
        Bill.refreshBadges();
        await Bill.go('deliveries');   // recharge aussi le filtre « Hôtel » (une fiche a pu être créée)
      },
    });
  }

  async function load(main) {
    const box = main.querySelector('#dl-table');
    let r;
    try { r = await Bill.get('/deliveries?' + qs()); } catch (err) { return Bill.fail(err, main.querySelector('#dl-table') || box); }
    if (!main.querySelector('#dl-table')) return;     // l'écran a changé pendant le chargement
    R = r; paint(main);
  }

  Bill.register('deliveries', {
    async render(main, params = {}) {
      if (params.clientId !== undefined) { S.clientId = String(params.clientId || ''); S.status = ''; S.pay.clear(); S.q = ''; }
      const clients = await Bill.clients();
      main.innerHTML = `<div class="bl-head"><div><h2>Bons de livraison</h2><p>Les commandes livrées, par période et par hôtel, avec leur état de facturation. Cliquez sur un bon pour voir son détail ou télécharger son PDF.</p></div>
        <div class="bl-actions"><button class="bl-btn" id="dl-csv" disabled>Exporter (Excel)</button><button class="bl-btn primary" id="dl-pdf" disabled>Télécharger les BL (PDF)</button></div></div>
        <div id="dl-unlinked"></div>
        <div class="bl-panel"><div class="bl-tabs" id="dl-tabs" role="tablist"></div>
        <div class="bl-statusbar" role="group" aria-label="Filtrer par paiement de la facture"><div class="bl-chipsrow" id="dl-pay"></div></div>
        <div class="bl-filters">
          <div class="bl-field grow"><label for="dl-q">Rechercher</label><input id="dl-q" type="search" value="${e(S.q)}" placeholder="N° de bon ou nom d'hôtel"></div>
          <div class="bl-field"><label for="dl-c">Hôtel</label><select id="dl-c"><option value="">Tous</option>${clients.map(c => `<option value="${c.id}" ${String(S.clientId) === String(c.id) ? 'selected' : ''}>${e(c.societe)}</option>`).join('')}</select></div>
          <div class="bl-field"><label for="dl-f">Livrés du</label><input id="dl-f" type="date" value="${e(S.from)}"></div>
          <div class="bl-field"><label for="dl-t">au</label><input id="dl-t" type="date" value="${e(S.to)}"></div>
        </div>
        <div class="bl-presets" role="group" aria-label="Périodes rapides">${PRESETS.map(([k, l]) => `<button type="button" class="bl-btn link small" data-preset="${k}">${l}</button>`).join('')}<span class="bl-muted" id="dl-sum"></span></div>
        <div id="dl-table"><div class="bl-spin">Chargement…</div></div></div>`;
      let timer;
      const q = (s) => main.querySelector(s);
      q('#dl-q').oninput = (ev) => { clearTimeout(timer); timer = setTimeout(() => { S.q = ev.target.value.trim(); load(main); }, 250); };
      q('#dl-c').onchange = (ev) => { S.clientId = ev.target.value; load(main); };
      const dates = () => { S.from = q('#dl-f').value; S.to = q('#dl-t').value; if (S.from && S.to && S.from > S.to) { Bill.toast('La date de début est après la date de fin.', true); return; } load(main); };
      q('#dl-f').onchange = dates; q('#dl-t').onchange = dates;
      main.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { [S.from, S.to] = preset(b.dataset.preset); q('#dl-f').value = S.from; q('#dl-t').value = S.to; load(main); });
      q('#dl-pdf').onclick = async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try { await Bill.download('/deliveries/export.pdf?' + qs(), 'bons-livraison.pdf'); } catch (err) { Bill.fail(err); } finally { btn.disabled = !R || !R.total || R.total > MAX_PDF; }
      };
      q('#dl-csv').onclick = async () => { try { await Bill.download('/deliveries/export.csv?' + qs(), 'bons-livraison.csv'); } catch (err) { Bill.fail(err); } };
      await load(main);
      if (params.openId) openDelivery(Number(params.openId), () => load(main));
    },
  });

  // ---------- détail d'un bon ----------
  async function openDelivery(id, onChange) {
    const d = Bill.drawer({ onClose: () => { if (onChange) onChange(); } });
    d.body.innerHTML = '<div class="bl-spin">Chargement…</div>';
    let D;
    try { D = (await Bill.get('/deliveries/' + id)).delivery; } catch (err) { Bill.closeDrawer(); return Bill.fail(err); }
    draw(false);

    // editing = true : la colonne « Livré » devient saisissable (bon pas encore facturé).
    function draw(editing) {
      const b = D.billing;
      const canEdit = b.status === 'to_invoice';
      const actions = [`<button class="bl-btn primary" id="dd-mail">Envoyer par e-mail</button>`, `<button class="bl-btn" id="dd-pdf">Télécharger le PDF</button>`];
      if (b.status === 'invoiced' && b.invoiceId) actions.push(`<button class="bl-btn" id="dd-inv">Ouvrir la facture ${e(b.invoiceNumber || '')}</button>`);
      if (b.status === 'draft' && b.invoiceId) actions.push('<button class="bl-btn" id="dd-inv">Ouvrir le brouillon</button>');
      if (b.status === 'to_invoice') actions.push('<button class="bl-btn" id="dd-month">Facturer le mois</button>');
      d.setHead({ title: `Bon ${e(D.ticket)}`, sub: `${e(D.client.societe)} · livré le ${dFr(D.date)}`, actions: actions.join('') });
      const note = editing
        ? '<div class="bl-alert info">Saisissez ce qui a réellement été livré : la facture reprendra ces quantités. Une reprise de linge reste négative ou nulle.</div>'
        : D.adjusted ? '<div class="bl-alert warn">Certaines quantités livrées diffèrent de la commande : la facture suit les quantités livrées.</div>' : '';
      const cell = (l) => editing
        ? `<input class="bl-input bl-qty-in" type="number" step="1" ${l.qty < 0 ? 'max="0"' : 'min="0"'} data-id="${e(l.id)}" value="${l.delivered}" aria-label="Quantité livrée : ${e(l.name)}">`
        : `<b>${l.delivered}</b>`;
      d.body.innerHTML = `
        <div class="bl-panel"><div class="bl-panel-b"><dl class="bl-kv">
          <dt>Facturation</dt><dd>${billingTag(b)}${b.invoiceDate ? ` <span class="bl-muted">émise le ${dFr(b.invoiceDate)}</span>` : ''}</dd>
          ${b.payment ? `<dt>Paiement</dt><dd>${payTag(b)}${b.dueDate ? ` <span class="bl-muted">échéance le ${dFr(b.dueDate)}</span>` : ''}</dd>` : ''}
          <dt>Hôtel</dt><dd>${e(D.client.societe)}</dd>
          <dt>Adresse de livraison</dt><dd>${e(D.client.adresse || '—')}</dd>
          <dt>Contact</dt><dd>${e([D.client.contact, D.client.tel].filter(Boolean).join(' · ') || '—')}</dd>
          ${D.notes ? `<dt>Notes</dt><dd style="white-space:pre-line">${e(D.notes)}</dd>` : ''}
        </dl></div></div>
        ${note}
        <div class="bl-panel"><div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Article</th><th class="r">Commandé</th><th class="r">Livré</th><th class="r">Prix HT</th><th class="r">Total HT</th></tr></thead><tbody>
          ${D.lines.map(l => `<tr class="${l.deliveredQty != null && l.deliveredQty !== l.qty ? 'bl-diff' : ''}"><td class="client">${e(l.name)}<span class="sub">${e(l.sageCode || l.code || '')}</span></td>
            <td class="r bl-num">${l.qty}</td><td class="r bl-num">${cell(l)}</td><td class="r bl-num">${Bill.num3(l.price)}</td><td class="r bl-num">${eur(l.htCents)}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="bl-panel-b"><div class="bl-totals"><div class="grand"><span>Total HT</span><span>${eur(D.htCents)}</span></div></div>
            ${editing
              ? `<div class="bl-qty-actions"><button class="bl-btn primary" id="dd-qty-save">Enregistrer les quantités</button><button class="bl-btn" id="dd-qty-cancel">Annuler</button><span class="bl-muted" id="dd-qty-msg" role="status"></span></div>`
              : canEdit ? `<div class="bl-qty-actions"><button class="bl-btn" id="dd-qty">Corriger les quantités livrées</button><span class="bl-muted">Tant que le bon n'est pas facturé.</span></div>`
              : b.status === 'draft' ? '<p class="bl-hint" style="margin-top:10px">Ce bon est dans un brouillon de facture : supprimez le brouillon pour corriger les quantités livrées.</p>'
              : '<p class="bl-hint" style="margin-top:10px">Bon facturé : les quantités sont figées. Pour corriger, émettez un avoir.</p>'}
            <p class="bl-hint" style="margin-top:10px">Les prix sont ceux figés sur la commande au moment de sa saisie (tarif de l'hôtel à cette date).</p></div></div>`;
      d.el.querySelector('#dd-mail').onclick = () => Bill.mailModal({ title: 'Envoyer le bon de livraison', previewPath: `/deliveries/${id}/mail-preview`, sendPath: `/deliveries/${id}/send`, pdfPath: `/deliveries/${id}/pdf` });
      d.el.querySelector('#dd-pdf').onclick = async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try { await Bill.download(`/deliveries/${id}/pdf`, `bon-livraison-${D.ticket}.pdf`); } catch (err) { Bill.fail(err); } finally { btn.disabled = false; }
      };
      const inv = d.el.querySelector('#dd-inv'); if (inv) inv.onclick = () => Bill.openInvoice(b.invoiceId, onChange);
      const month = d.el.querySelector('#dd-month'); if (month) month.onclick = () => { Bill.closeDrawer(); Bill.go('month'); };
      const edit = d.el.querySelector('#dd-qty'); if (edit) edit.onclick = () => draw(true);
      const cancel = d.el.querySelector('#dd-qty-cancel'); if (cancel) cancel.onclick = () => draw(false);
      const save = d.el.querySelector('#dd-qty-save');
      if (save) save.onclick = async () => {
        const msg = d.el.querySelector('#dd-qty-msg');
        const items = [...d.el.querySelectorAll('.bl-qty-in')].map(i => ({ id: i.dataset.id, deliveredQty: i.value }));
        // Une case vide ou de mauvais signe ne doit pas être ignorée en silence : on le dit avant d'envoyer.
        const bad = items.find((it, k) => { const n = Number(it.deliveredQty); return it.deliveredQty === '' || !Number.isInteger(n) || (D.lines[k].qty < 0 ? n > 0 : n < 0); });
        if (bad) { msg.textContent = 'Quantité invalide : entier positif ou nul (négatif ou nul pour une reprise).'; return; }
        save.disabled = true; msg.textContent = '';
        try {
          const r = await Bill.put(`/deliveries/${id}/quantities`, { items });
          D = r.delivery;
          Bill.toast(r.changes.length ? `Quantités mises à jour (${r.changes.length} ligne${r.changes.length > 1 ? 's' : ''}).` : 'Aucune quantité modifiée.');
          draw(false);
        } catch (err) { save.disabled = false; msg.textContent = err.message; }
      };
    }
  }
})();
