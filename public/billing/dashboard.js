// Tableau de bord : ce qui reste à encaisser (ruban d'ancienneté), les chiffres du mois,
// ce qu'il y a à faire aujourd'hui, et 12 mois de facturé / encaissé.
(function () {
  const { e, eur, eur0, dFr, plural } = Bill;
  const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

  function delta(now, prev) {
    if (!prev) return '';
    const pct = Math.round(((now - prev) / Math.abs(prev)) * 100);
    if (!pct) return '<small>stable vs mois dernier</small>';
    return `<small class="bl-delta ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '+' : ''}${pct} % vs mois dernier</small>`;
  }

  function ribbon(d) {
    const total = d.open.cents;
    const segs = d.aging.filter(a => a.cents > 0);
    const bar = total > 0
      ? segs.map(a => `<button class="bl-seg" data-k="${a.key}" style="flex:${a.cents} 1 0" aria-label="${e(a.label)} : ${e(eur(a.cents))}" title="${e(a.label)} : ${e(eur(a.cents))}"></button>`).join('')
      : '';
    return `<div class="bl-panel"><div class="bl-ribbon-wrap">
      <div class="bl-ribbon-title">
        <div><h3>À encaisser</h3><div class="bl-muted" style="font-size:13px">${plural(d.open.count, 'facture ouverte', 'factures ouvertes')}${d.overdue.count ? ` dont <b style="color:var(--bl-late)">${eur0(d.overdue.cents)}</b> en retard` : ''}</div></div>
        <div class="bl-ribbon-total bl-num">${eur(total)}</div>
      </div>
      ${total > 0 ? `<div class="bl-ribbon" role="group" aria-label="Ancienneté des créances">${bar}</div>
      <div class="bl-legend">${d.aging.map(a => `<button data-k="${a.key}"><span>${e(a.label)}</span><b>${eur0(a.cents)}</b><small>${plural(a.count, 'facture', 'factures')}</small></button>`).join('')}</div>`
        : '<div class="bl-empty" style="padding:18px 0 6px"><b>Rien à encaisser</b>Toutes les factures émises sont réglées.</div>'}
    </div>
    <div class="bl-figures">
      <button class="bl-figure" data-go="invoices" data-tab="all"><span>Facturé ce mois (HT)</span><b>${eur0(d.invoiced.monthHtCents)}</b>${delta(d.invoiced.monthHtCents, d.invoiced.prevMonthHtCents)}</button>
      <button class="bl-figure" data-go="payments"><span>Encaissé ce mois</span><b>${eur0(d.collected.monthCents)}</b>${delta(d.collected.monthCents, d.collected.prevMonthCents)}</button>
      <button class="bl-figure" data-go="invoices" data-tab="overdue"><span>En retard</span><b style="${d.overdue.count ? 'color:var(--bl-late)' : ''}">${eur0(d.overdue.cents)}</b><small>${plural(d.overdue.count, 'facture', 'factures')}</small></button>
      <div class="bl-figure" style="cursor:default"><span>Délai moyen de paiement</span><b>${d.dsoDays == null ? '—' : d.dsoDays + ' j'}</b><small>sur 12 mois, factures soldées</small></div>
    </div></div>`;
  }

  function todo(d) {
    const items = [];
    if (d.toInvoice.orders) items.push({ n: d.toInvoice.clients, t: 'Hôtels à facturer', s: `${plural(d.toInvoice.orders, 'bon livré', 'bons livrés')} · environ ${eur0(d.toInvoice.htCents)} HT`, go: 'month', cta: 'Facturer' });
    if (d.drafts.count) items.push({ n: d.drafts.count, t: 'Brouillons à vérifier', s: `${eur0(d.drafts.ttcCents)} TTC, rien n'est encore émis`, go: 'invoices', params: { tab: 'draft' }, cta: 'Ouvrir' });
    if (d.reminders && d.reminders.due) items.push({ n: d.reminders.due, t: 'Factures à relancer', s: 'Un message est prêt pour chacune', go: 'reminders', cta: 'Relancer' });
    if (d.quotes.toInvoice.count) items.push({ n: d.quotes.toInvoice.count, t: 'Devis acceptés à facturer', s: eur0(d.quotes.toInvoice.ttcCents) + ' TTC', go: 'quotes', params: { status: 'accepted' }, cta: 'Voir' });
    if (d.quotes.open.count) items.push({ n: d.quotes.open.count, t: 'Devis en attente de réponse', s: eur0(d.quotes.open.ttcCents) + ' TTC', go: 'quotes', params: { status: 'issued' }, cta: 'Voir' });
    if (d.pennylane && d.pennylane.error) items.push({ n: d.pennylane.error, t: 'Envois Pennylane en échec', s: 'À corriger ou relancer', go: 'pennylane', cta: 'Voir' });
    if (d.backup && d.backup.health !== 'ok') items.push({ n: '!', t: 'Sauvegarde à vérifier', s: d.backup.message, go: 'security', cta: 'Voir', bad: d.backup.health === 'critical' });
    if (!items.length) return `<div class="bl-panel"><div class="bl-panel-h"><h3>À faire</h3></div><div class="bl-empty"><b>Tout est à jour</b>Aucune action en attente.</div></div>`;
    return `<div class="bl-panel"><div class="bl-panel-h"><h3>À faire</h3></div><ul class="bl-todo">${items.map((it, i) => `<li>
      <div class="t">${e(it.t)}<small>${e(it.s)}</small></div>
      <div style="display:flex;gap:12px;align-items:center"><span class="n" ${it.bad ? 'style="color:var(--bl-late)"' : ''}>${e(it.n)}</span><button class="bl-btn small" data-todo="${i}">${e(it.cta)}</button></div></li>`).join('')}</ul></div>`;
  }

  function chart(d) {
    const W = 340; const H = 190; const padL = 8; const padB = 22; const padT = 8;
    const max = Math.max(1, ...d.series.flatMap(s => [s.invoicedHtCents, s.collectedCents]));
    const gw = (W - padL) / d.series.length; const bw = Math.min(11, gw / 2 - 2);
    const y = (v) => padT + (H - padT - padB) * (1 - Math.max(0, v) / max);
    const base = H - padB;
    const bars = d.series.map((s, i) => {
      const x = padL + i * gw + gw / 2; const [yy, mm] = s.month.split('-');
      return `<g><title>${MONTHS[Number(mm) - 1]} ${yy} — facturé ${e(eur(s.invoicedHtCents))} HT, encaissé ${e(eur(s.collectedCents))}</title>
        <rect x="${x - bw - 1}" y="${y(s.invoicedHtCents)}" width="${bw}" height="${Math.max(0, base - y(s.invoicedHtCents))}" rx="2" fill="#1D91FF"/>
        <rect x="${x + 1}" y="${y(s.collectedCents)}" width="${bw}" height="${Math.max(0, base - y(s.collectedCents))}" rx="2" fill="#2FB27A"/>
        <text x="${x}" y="${H - 6}" text-anchor="middle">${MONTHS[Number(mm) - 1].replace(".", "")}</text></g>`;
    }).join('');
    return `<div class="bl-panel"><div class="bl-panel-h"><h3>12 derniers mois</h3></div><div class="bl-panel-b">
      <div class="bl-chart-legend"><span><i style="background:#1D91FF"></i>Facturé (HT)</span><span><i style="background:#2FB27A"></i>Encaissé</span></div>
      <svg class="bl-bars" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Facturé et encaissé par mois sur 12 mois">
        <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="#DEE6EE"/>${bars}
      </svg></div></div>`;
  }

  function debtors(d) {
    if (!d.topDebtors.length) return '';
    return `<div class="bl-panel"><div class="bl-panel-h"><h3>Plus gros encours</h3></div>${d.topDebtors.map(t => `<div class="bl-debtor">
      <div><b style="font-weight:500">${e(t.clientName)}</b><small>${plural(t.invoices, 'facture', 'factures')}${t.overdueCents ? ` · <span style="color:var(--bl-late)">${eur0(t.overdueCents)} en retard</span>` : ''}</small></div>
      <div class="bl-num"><b>${eur0(t.balanceCents)}</b></div></div>`).join('')}</div>`;
  }

  Bill.register('dashboard', {
    async render(main) {
      const d = await Bill.get('/dashboard');
      Bill.state.dash = d;
      main.innerHTML = `<div class="bl-head"><div><h2>Tableau de bord</h2><p>Où en est l'argent, et ce qu'il reste à faire aujourd'hui.</p></div>
        <div class="bl-actions"><button class="bl-btn" data-act="quote">Nouveau devis</button><button class="bl-btn primary" data-act="invoice">Nouvelle facture</button></div></div>
        ${ribbon(d)}
        <div class="bl-grid2"><div>${todo(d)}</div><div>${chart(d)}${debtors(d)}</div></div>`;
      const tabFor = { notDue: 'open', d1_30: 'overdue', d31_60: 'overdue', d61_90: 'overdue', d90: 'overdue' };
      main.querySelectorAll('[data-k]').forEach(b => b.onclick = () => Bill.go('invoices', { tab: tabFor[b.dataset.k], bucket: b.dataset.k }));
      main.querySelectorAll('.bl-figure[data-go]').forEach(b => b.onclick = () => Bill.go(b.dataset.go, b.dataset.tab ? { tab: b.dataset.tab } : {}));
      main.querySelector('[data-act="invoice"]').onclick = () => Bill.go('invoices', { newInvoice: true });
      main.querySelector('[data-act="quote"]').onclick = () => Bill.go('quotes', { newQuote: true });
      // Les actions « À faire » sont reconstruites dans le même ordre que l'affichage.
      const acts = [];
      if (d.toInvoice.orders) acts.push(['month', {}]);
      if (d.drafts.count) acts.push(['invoices', { tab: 'draft' }]);
      if (d.reminders && d.reminders.due) acts.push(['reminders', {}]);
      if (d.quotes.toInvoice.count) acts.push(['quotes', { status: 'accepted' }]);
      if (d.quotes.open.count) acts.push(['quotes', { status: 'issued' }]);
      if (d.pennylane && d.pennylane.error) acts.push(['pennylane', {}]);
      if (d.backup && d.backup.health !== 'ok') acts.push(['security', {}]);
      main.querySelectorAll('[data-todo]').forEach(b => b.onclick = () => Bill.go(...acts[Number(b.dataset.todo)]));
    },
  });
})();
