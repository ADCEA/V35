// Bons de livraison : les commandes livrées, filtrables par période, par hôtel et par état de facturation.
(function () {
  const { e, eur, dFr, today, plural } = Bill;
  const TABS = [['', 'Tous'], ['to_invoice', 'À facturer'], ['draft', 'Dans un brouillon'], ['invoiced', 'Facturés']];
  const MAX_PDF = 500;
  const S = { status: '', q: '', clientId: '', from: '', to: '', sort: 'date', dir: 'desc' };
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
    return p.toString();
  }

  // ---------- état de facturation ----------
  function billingTag(b) {
    if (b.status === 'to_invoice') return '<span class="bl-tag wait">À facturer</span>';
    if (b.status === 'draft') return '<span class="bl-tag info">Dans un brouillon</span>';
    return `<span class="bl-tag ok">Facturé</span>${b.invoiceNumber ? `<span class="sub bl-num">${e(b.invoiceNumber)}</span>` : (b.legacy ? '<span class="sub">ancien circuit</span>' : '')}`;
  }

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
      <td>${billingTag(d.billing)}</td></tr>`;
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
    main.querySelector('#dl-sum').innerHTML = summary();

    const pdf = main.querySelector('#dl-pdf'); const csv = main.querySelector('#dl-csv');
    pdf.disabled = !R.total || R.total > MAX_PDF; csv.disabled = !R.total;
    pdf.textContent = R.total ? `Télécharger ${plural(R.total, 'BL', 'BL')} (PDF)` : 'Télécharger les BL (PDF)';
    pdf.title = R.total > MAX_PDF ? `Un PDF contient ${MAX_PDF} BL au plus : resserrez la période ou choisissez un hôtel.` : 'Un seul PDF, un bon par page, du plus ancien au plus récent';

    if (!R.deliveries.length) {
      const filtered = S.q || S.clientId || S.from || S.to || S.status;
      box.innerHTML = `<div class="bl-empty"><b>${filtered ? 'Aucun bon de livraison' : 'Aucune livraison pour le moment'}</b>${filtered ? 'Aucun BL ne correspond à ces filtres : élargissez la période ou changez d\'hôtel.' : 'Un bon de livraison apparaît ici dès qu\'une commande est marquée « Livrée ».'}</div>`;
      return;
    }
    const rows = [...R.deliveries].sort(SORTERS[S.sort]); if (S.dir === 'desc') rows.reverse();
    box.innerHTML = `<div class="bl-tablewrap"><table class="bl-table"><thead><tr>${sortTh('ticket', 'Bon')}${sortTh('date', 'Livré le')}${sortTh('client', 'Hôtel')}<th>Contenu</th>${sortTh('amount', 'Montant HT', 'r')}<th>Facturation</th></tr></thead>
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

  async function load(main) {
    const box = main.querySelector('#dl-table');
    let r;
    try { r = await Bill.get('/deliveries?' + qs()); } catch (err) { return Bill.fail(err, main.querySelector('#dl-table') || box); }
    if (!main.querySelector('#dl-table')) return;     // l'écran a changé pendant le chargement
    R = r; paint(main);
  }

  Bill.register('deliveries', {
    async render(main, params = {}) {
      if (params.clientId !== undefined) { S.clientId = String(params.clientId || ''); S.status = ''; S.q = ''; }
      const clients = await Bill.clients();
      main.innerHTML = `<div class="bl-head"><div><h2>Bons de livraison</h2><p>Les commandes livrées, par période et par hôtel, avec leur état de facturation. Cliquez sur un bon pour voir son détail ou télécharger son PDF.</p></div>
        <div class="bl-actions"><button class="bl-btn" id="dl-csv" disabled>Exporter (Excel)</button><button class="bl-btn primary" id="dl-pdf" disabled>Télécharger les BL (PDF)</button></div></div>
        <div class="bl-panel"><div class="bl-tabs" id="dl-tabs" role="tablist"></div>
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
    const b = D.billing;
    const actions = [`<button class="bl-btn primary" id="dd-pdf">Télécharger le PDF</button>`];
    if (b.status === 'invoiced' && b.invoiceId) actions.push(`<button class="bl-btn" id="dd-inv">Ouvrir la facture ${e(b.invoiceNumber || '')}</button>`);
    if (b.status === 'draft' && b.invoiceId) actions.push('<button class="bl-btn" id="dd-inv">Ouvrir le brouillon</button>');
    if (b.status === 'to_invoice') actions.push('<button class="bl-btn" id="dd-month">Facturer le mois</button>');
    d.setHead({ title: `Bon ${e(D.ticket)}`, sub: `${e(D.client.societe)} · livré le ${dFr(D.date)}`, actions: actions.join('') });
    d.body.innerHTML = `
      <div class="bl-panel"><div class="bl-panel-b"><dl class="bl-kv">
        <dt>Facturation</dt><dd>${billingTag(b)}${b.invoiceDate ? ` <span class="bl-muted">émise le ${dFr(b.invoiceDate)}</span>` : ''}</dd>
        <dt>Hôtel</dt><dd>${e(D.client.societe)}</dd>
        <dt>Adresse de livraison</dt><dd>${e(D.client.adresse || '—')}</dd>
        <dt>Contact</dt><dd>${e([D.client.contact, D.client.tel].filter(Boolean).join(' · ') || '—')}</dd>
        ${D.notes ? `<dt>Notes</dt><dd style="white-space:pre-line">${e(D.notes)}</dd>` : ''}
      </dl></div></div>
      ${D.adjusted ? '<div class="bl-alert warn">Certaines quantités livrées diffèrent de la commande : la facture suit les quantités livrées.</div>' : ''}
      <div class="bl-panel"><div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Article</th><th class="r">Commandé</th><th class="r">Livré</th><th class="r">Prix HT</th><th class="r">Total HT</th></tr></thead><tbody>
        ${D.lines.map(l => `<tr class="${l.deliveredQty != null && l.deliveredQty !== l.qty ? 'bl-diff' : ''}"><td class="client">${e(l.name)}<span class="sub">${e(l.sageCode || l.code || '')}</span></td>
          <td class="r bl-num">${l.qty}</td><td class="r bl-num"><b>${l.delivered}</b></td><td class="r bl-num">${Bill.num3(l.price)}</td><td class="r bl-num">${eur(l.htCents)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="bl-panel-b"><div class="bl-totals"><div class="grand"><span>Total HT</span><span>${eur(D.htCents)}</span></div></div>
          <p class="bl-hint" style="margin-top:10px">Les prix sont ceux figés sur la commande au moment de sa saisie (tarif de l'hôtel à cette date).</p></div></div>`;
    d.el.querySelector('#dd-pdf').onclick = async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true;
      try { await Bill.download(`/deliveries/${id}/pdf`, `bon-livraison-${D.ticket}.pdf`); } catch (err) { Bill.fail(err); } finally { btn.disabled = false; }
    };
    const inv = d.el.querySelector('#dd-inv'); if (inv) inv.onclick = () => Bill.openInvoice(b.invoiceId, onChange);
    const month = d.el.querySelector('#dd-month'); if (month) month.onclick = () => { Bill.closeDrawer(); Bill.go('month'); };
  }
})();
