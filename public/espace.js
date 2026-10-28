// ============================================================
// Espace client à onglets : Accueil, Factures, Contrat, Livraisons, Mon compte.
//
// Ce fichier est chargé AVANT app.js (qui appelle renderOwnInvoices, renderDeliveries, espaceSetTab…) et se sert
// des utilitaires d'app.js (api, escapeHtml, plural, portalEur, portalDay…) uniquement au moment de l'exécution.
// Les données viennent de /api/clients/* ; rien n'est gardé dans le navigateur.
// ============================================================

const ESPACE_TABS = ['accueil', 'factures', 'contrat', 'livraisons', 'compte'];
let espaceTab = 'accueil';
const espaceData = { invoices: null, summary: null, payment: null, deliveries: null, documents: null };

const espEsc = (v) => escapeHtml(String(v ?? ''));
const espCap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
// 2026-10-27 -> « lundi 27 octobre 2026 » (midi : à l'abri des décalages d'heure d'été)
function espDayLong(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? portalDay(iso) : espCap(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
}
function espMonthLabel(ym) {
  const d = new Date(`${ym}-15T12:00:00`);
  return Number.isNaN(d.getTime()) ? ym : espCap(d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
}
const espPrice = (p) => `${Number(p).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} €`;
const espPill = (label, tone) => `<span class="inv-pill ${tone}">${espEsc(label)}</span>`;
const espPdfIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 20h16"/></svg>';
const espChevron = '<svg class="esp-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

// ---------- onglets ----------

function espaceSetTab(tab, { focus = false } = {}) {
  if (!ESPACE_TABS.includes(tab)) tab = 'accueil';
  espaceTab = tab;
  for (const t of ESPACE_TABS) {
    const on = t === tab;
    const btn = document.getElementById('esp-tab-' + t);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
    document.getElementById('esp-panel-' + t).hidden = !on;
    if (on) {
      if (focus) btn.focus();
      try { btn.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* navigateur ancien */ }
    }
  }
  if (tab === 'contrat') renderContract().catch(err => {
    console.error(err);
    document.getElementById('contract-body').innerHTML = `<p class="empty-note">${espEsc(err.message || 'Impossible de charger le contrat.')}</p>`;
  });
}

// À la déconnexion : on oublie tout ce qui concernait l'hôtel précédent.
function espaceReset() {
  espaceTab = 'accueil';
  Object.assign(espaceData, { invoices: null, summary: null, payment: null, deliveries: null, documents: null });
  delivState.month = 'all'; delivState.status = 'all'; delivState.q = ''; delivState.expanded.clear(); delivState.open.clear(); delivState.firstOpenDone = false;
  invoiceFilter = 'all';
  const q = document.getElementById('deliv-q'); if (q) q.value = '';
  espaceSetTab('accueil');
}

function initEspaceTabs() {
  const tabs = document.getElementById('esp-tabs');
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-esp-tab]');
    if (btn) espaceSetTab(btn.dataset.espTab);
  });
  // Flèches, Début, Fin : le clavier se déplace d'un onglet à l'autre (schéma WAI-ARIA « tabs »).
  tabs.addEventListener('keydown', (e) => {
    const i = ESPACE_TABS.indexOf(espaceTab);
    let next = null;
    if (e.key === 'ArrowRight') next = ESPACE_TABS[(i + 1) % ESPACE_TABS.length];
    else if (e.key === 'ArrowLeft') next = ESPACE_TABS[(i + ESPACE_TABS.length - 1) % ESPACE_TABS.length];
    else if (e.key === 'Home') next = ESPACE_TABS[0];
    else if (e.key === 'End') next = ESPACE_TABS[ESPACE_TABS.length - 1];
    if (next) { e.preventDefault(); espaceSetTab(next, { focus: true }); }
  });
  // Liens internes (« Voir mes factures », « Modifier dans Mon compte »…).
  document.getElementById('espace-dashboard').addEventListener('click', (e) => {
    const go = e.target.closest('[data-esp-go]');
    if (!go) return;
    espaceSetTab(go.dataset.espGo);
    if (go.dataset.espOpen) { const d = document.getElementById(go.dataset.espOpen); if (d) d.open = true; }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  document.getElementById('invoice-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-inv-filter]');
    if (b) { invoiceFilter = b.dataset.invFilter; renderInvoiceList(); }
  });

  document.getElementById('deliv-month').addEventListener('change', (e) => { delivState.month = e.target.value; renderDeliveryList(); });
  document.getElementById('deliv-q').addEventListener('input', (e) => { delivState.q = e.target.value.trim().toLowerCase(); renderDeliveryList(); });
  document.getElementById('deliv-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-deliv-status]');
    if (b) { delivState.status = b.dataset.delivStatus; renderDeliveryList(); }
  });
  const list = document.getElementById('deliv-list');
  // « toggle » ne remonte pas : on l'écoute à la capture pour se souvenir des bons dépliés quand la liste est redessinée.
  list.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d && d.matches && d.matches('details.bon')) { if (d.open) delivState.open.add(d.dataset.id); else delivState.open.delete(d.dataset.id); }
  }, true);
  list.addEventListener('click', (e) => {
    const more = e.target.closest('[data-deliv-more]');
    if (more) { delivState.expanded.add(more.dataset.delivMore); renderDeliveryList(); return; }
    const re = e.target.closest('[data-deliv-reorder]');
    if (re) reorderFrom(re.dataset.delivReorder);
  });
}

// ---------- accueil ----------

function renderHome() {
  renderHomeBalance(); renderHomeDeliveries(); renderHomeDocs(); renderHomeContact();
}

function renderHomeBalance() {
  const box = document.getElementById('home-balance');
  const invoices = espaceData.invoices; const s = espaceData.summary;
  if (!invoices || !s) { box.innerHTML = ''; return; }
  if (s.openCount > 0) {
    box.innerHTML = `
      <section class="esp-card esp-balance ${s.overdueCents > 0 ? 'late' : ''}" aria-labelledby="home-balance-h">
        <h4 id="home-balance-h" class="esp-card-title">Reste à payer</h4>
        <div class="esp-balance-fig">${portalEur(s.dueCents)} <span>TTC</span></div>
        <div class="esp-balance-sub">${plural(s.openCount, 'facture ouverte', 'factures ouvertes')}${s.overdueCents > 0 ? `, dont <strong>${portalEur(s.overdueCents)} en retard</strong>` : ''}</div>
        <button type="button" class="esp-btn solid" data-esp-go="factures">Voir mes factures</button>
      </section>`;
  } else if (invoices.some(i => !i.legacy && i.kind !== 'credit_note')) {
    box.innerHTML = '<section class="esp-card esp-balance ok"><h4 class="esp-card-title">Factures</h4><div class="esp-balance-sub">Toutes vos factures sont réglées. Merci !</div></section>';
  } else {
    box.innerHTML = '';
  }
}

function renderHomeDeliveries() {
  const box = document.getElementById('home-deliveries');
  const list = espaceData.deliveries;
  if (!list) { box.innerHTML = ''; return; }
  if (!list.length) { box.innerHTML = '<p class="empty-note">Aucune livraison pour le moment.</p>'; return; }
  box.innerHTML = `<div class="esp-list">${list.slice(0, 3).map(d => `
    <div class="esp-list-row">
      <div class="esp-list-main"><span class="bon-num">${espEsc(d.ticket)}</span><span class="bon-date">${espEsc(espDayLong(d.date))} · ${plural(d.pieces, 'pièce', 'pièces')}</span></div>
      <div class="esp-list-side">${deliveryPill(d)}<a class="inv-pdf" href="/api/clients/deliveries/${d.id}/pdf" target="_blank" rel="noopener" aria-label="Bon de livraison ${espEsc(d.ticket)} en PDF">PDF</a></div>
    </div>`).join('')}</div>`;
}

function renderHomeDocs() {
  const box = document.getElementById('home-docs');
  const rows = [];
  const inv = (espaceData.invoices || []).find(i => !i.legacy && i.kind !== 'credit_note');
  if (inv) rows.push(['Dernière facture', inv.number, inv.pdfUrl]);
  const bl = (espaceData.deliveries || [])[0];
  if (bl) rows.push(['Dernier bon de livraison', bl.ticket, `/api/clients/deliveries/${bl.id}/pdf`]);
  const contract = (espaceData.documents || []).find(d => d.kind === 'contract');
  if (contract) rows.push([contract.title, contract.signedOn ? `signé le ${portalDay(contract.signedOn)}` : '', contract.url]);
  if (!rows.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <section class="esp-card" aria-labelledby="home-docs-h">
      <h4 id="home-docs-h" class="esp-card-title">Documents utiles</h4>
      ${rows.map(([label, sub, url]) => `
        <a class="esp-doc" href="${espEsc(url)}" target="_blank" rel="noopener">
          <span>${espEsc(label)}${sub ? `<small>${espEsc(sub)}</small>` : ''}</span><span class="esp-doc-pdf">PDF</span>
        </a>`).join('')}
    </section>`;
}

function renderHomeContact() {
  const box = document.getElementById('home-contact');
  const links = contactLinks((portalOptions && portalOptions.contact) || {});
  box.innerHTML = `
    <section class="esp-card" aria-labelledby="home-contact-h">
      <h4 id="home-contact-h" class="esp-card-title">Une question ?</h4>
      <div class="esp-contact">Blanchisserie Cézanne${links ? `<br>${links}` : ''}</div>
    </section>`;
}

// ---------- factures ----------

let invoiceFilter = 'all';
const INV_FILTERS = [['all', 'Toutes'], ['open', 'À régler'], ['paid', 'Payées'], ['credit', 'Avoirs']];
function invoiceMatches(inv, f) {
  if (f === 'open') return !inv.legacy && inv.kind !== 'credit_note' && inv.balanceCents > 0;
  if (f === 'paid') return inv.legacy || (inv.kind !== 'credit_note' && inv.balanceCents <= 0);
  if (f === 'credit') return inv.kind === 'credit_note';
  return true;
}

async function renderOwnInvoices() {
  const { invoices, summary, payment } = await api('GET', '/api/clients/invoices');
  Object.assign(espaceData, { invoices, summary, payment });
  renderInvoiceSummary(invoices, summary);
  renderPaymentBox(payment, invoices);
  const badge = document.getElementById('esp-badge-factures');
  if (summary && summary.openCount > 0) {
    badge.hidden = false;
    badge.className = `esp-badge ${summary.overdueCents > 0 ? 'late' : ''}`;
    badge.innerHTML = `${summary.openCount}<span class="esp-sr"> à régler</span>`;
  } else {
    badge.hidden = true;
  }
  renderInvoiceList();
  renderHome();
}

function renderInvoiceList() {
  const invoices = espaceData.invoices || [];
  const box = document.getElementById('own-invoices');
  const chips = document.getElementById('invoice-filters');
  if (!invoices.length) {
    chips.innerHTML = '';
    box.innerHTML = '<p class="empty-note">Aucune facture pour le moment. Elles apparaîtront ici dès leur émission.</p>';
    return;
  }
  const counts = Object.fromEntries(INV_FILTERS.map(([k]) => [k, invoices.filter(i => invoiceMatches(i, k)).length]));
  if (!counts[invoiceFilter]) invoiceFilter = 'all';
  chips.innerHTML = INV_FILTERS.filter(([k]) => k === 'all' || counts[k] > 0).map(([k, label]) =>
    `<button type="button" class="esp-chip" data-inv-filter="${k}" aria-pressed="${k === invoiceFilter}">${label} · ${counts[k]}</button>`).join('');

  let shown = invoices.filter(i => invoiceMatches(i, invoiceFilter));
  if (invoiceFilter === 'open') {
    shown = [...shown].sort((a, b) => (b.overdueDays > 0) - (a.overdueDays > 0) || String(a.dueDate).localeCompare(String(b.dueDate)));
  }
  const byYear = new Map();
  for (const inv of shown) {
    const y = String(inv.issueDate || inv.periodStart || inv.createdAt || '').slice(0, 4) || 'Anciennes factures';
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(inv);
  }
  box.innerHTML = [...byYear.entries()].map(([y, list]) => `<h5 class="inv-group">${espEsc(y)}</h5>${list.map(invoiceHtml).join('')}`).join('');
}

// ---------- livraisons ----------

const delivState = { month: 'all', status: 'all', q: '', expanded: new Set(), open: new Set(), firstOpenDone: false };
const DELIV_CAP = 6;       // bons affichés par mois tant que « Tous les mois » est choisi

function deliveryPill(d) {
  return d.billing.status === 'invoiced'
    ? `${espPill('Facturée', 'paid')}${d.billing.invoiceNumber ? `<span class="bon-inv">${espEsc(d.billing.invoiceNumber)}</span>` : ''}`
    : espPill('À facturer', 'neutral');
}

async function renderDeliveries() {
  const { deliveries } = await api('GET', '/api/clients/deliveries');
  espaceData.deliveries = deliveries;
  if (!delivState.firstOpenDone && deliveries.length) { delivState.open.add(String(deliveries[0].id)); delivState.firstOpenDone = true; }
  const months = [...new Set(deliveries.map(d => String(d.date).slice(0, 7)))];
  const sel = document.getElementById('deliv-month');
  if (delivState.month !== 'all' && !months.includes(delivState.month)) delivState.month = 'all';
  sel.innerHTML = `<option value="all">Tous les mois</option>${months.map(m => `<option value="${m}">${espEsc(espMonthLabel(m))}</option>`).join('')}`;
  sel.value = delivState.month;
  renderDeliveryList();
  renderHome();
}

function deliveryBodyHtml(d) {
  const meta = [d.collecteDate ? `collecte le ${portalDay(d.collecteDate)}` : '', `livraison le ${portalDay(d.date)}`].filter(Boolean).join(' · ');
  const rows = d.items.map(i => {
    let note = '';
    if (i.qty < 0) note = '<span class="esp-flag neutral">Reprise</span>';
    else if (i.delivered < i.qty) note = `<span class="esp-flag warn">${plural(i.qty - i.delivered, 'non livrée', 'non livrées')}</span>`;
    else if (i.delivered > i.qty) note = `<span class="esp-flag neutral">${plural(i.delivered - i.qty, 'en plus', 'en plus')}</span>`;
    return `<tr class="${i.qty < 0 ? 'reprise' : ''}"><td>${espEsc(i.name)}</td><td class="num">${i.qty}</td><td class="num ${i.delivered !== i.qty ? 'diff' : ''}">${i.delivered}</td><td>${note}</td></tr>`;
  }).join('');
  const canReorder = d.items.some(i => i.qty > 0);
  return `
    <div class="bon-body">
      <div class="bon-meta">${espEsc(meta)}</div>
      <div class="esp-tablewrap"><table class="esp-table">
        <thead><tr><th scope="col">Article</th><th scope="col" class="num">Commandé</th><th scope="col" class="num">Livré</th><th scope="col"><span class="esp-sr">Remarque</span></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">Aucun article.</td></tr>'}</tbody>
      </table></div>
      <div class="bon-actions">
        <a class="esp-btn" href="/api/clients/deliveries/${d.id}/pdf" target="_blank" rel="noopener">${espPdfIcon}Bon de livraison (PDF)</a>
        ${canReorder ? `<button type="button" class="link-btn" data-deliv-reorder="${d.id}">Commander à nouveau</button>` : ''}
      </div>
    </div>`;
}

function deliveryHtml(d) {
  const open = delivState.open.has(String(d.id));
  return `
    <details class="bon" data-id="${d.id}" ${open ? 'open' : ''}>
      <summary>
        <span class="esp-list-main"><span class="bon-num">${espEsc(d.ticket)}</span><span class="bon-date">${espEsc(espDayLong(d.date))}</span></span>
        <span class="bon-side">
          <span class="bon-pieces">${plural(d.pieces, 'pièce', 'pièces')}${d.reprises ? `<small>${plural(d.reprises, 'reprise', 'reprises')}</small>` : ''}</span>
          <span class="bon-state">${deliveryPill(d)}</span>
          ${espChevron}
        </span>
      </summary>
      ${open ? deliveryBodyHtml(d) : `<template>${deliveryBodyHtml(d)}</template>`}
    </details>`;
}

function renderDeliveryList() {
  const all = espaceData.deliveries || [];
  const box = document.getElementById('deliv-list');
  const chips = document.getElementById('deliv-chips');
  const summaryBox = document.getElementById('deliv-summary');
  if (!all.length) {
    chips.innerHTML = ''; summaryBox.innerHTML = '';
    box.innerHTML = '<p class="empty-note">Aucune livraison pour le moment. Vos bons de livraison apparaîtront ici après chaque livraison.</p>';
    return;
  }
  const { month, status, q } = delivState;
  const scoped = all.filter(d => (month === 'all' || String(d.date).startsWith(month)) && (!q || String(d.ticket).toLowerCase().includes(q)));
  const counts = { all: scoped.length, to_invoice: scoped.filter(d => d.billing.status === 'to_invoice').length, invoiced: scoped.filter(d => d.billing.status === 'invoiced').length };
  chips.innerHTML = [['all', 'Toutes'], ['to_invoice', 'À facturer'], ['invoiced', 'Facturées']].map(([k, label]) =>
    `<button type="button" class="esp-chip" data-deliv-status="${k}" aria-pressed="${k === status}">${label} · ${counts[k]}</button>`).join('');
  const list = scoped.filter(d => status === 'all' || d.billing.status === status);

  if (!list.length) {
    summaryBox.innerHTML = '';
    box.innerHTML = '<p class="empty-note">Aucun bon de livraison ne correspond à ces filtres.</p>';
    return;
  }
  const pieces = list.reduce((n, d) => n + d.pieces, 0);
  const reprises = list.reduce((n, d) => n + d.reprises, 0);
  summaryBox.innerHTML = `
    <div class="esp-strip">
      <span><strong>${list.length}</strong> ${list.length > 1 ? 'livraisons' : 'livraison'}</span>
      <span><strong>${pieces.toLocaleString('fr-FR')}</strong> ${pieces > 1 ? 'pièces livrées' : 'pièce livrée'}</span>
      ${reprises ? `<span><strong>${reprises.toLocaleString('fr-FR')}</strong> ${reprises > 1 ? 'pièces reprises' : 'pièce reprise'}</span>` : ''}
      <span class="esp-muted">Dernière livraison le ${espEsc(espDayLong(list[0].date))}</span>
    </div>`;

  const groups = new Map();
  for (const d of list) {
    const m = String(d.date).slice(0, 7);
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(d);
  }
  box.innerHTML = [...groups.entries()].map(([m, items]) => {
    const capped = month === 'all' && !delivState.expanded.has(m) && !q && items.length > DELIV_CAP + 1;
    const shown = capped ? items.slice(0, DELIV_CAP) : items;
    return `
      <h5 class="inv-group">${espEsc(espMonthLabel(m))}</h5>
      <div class="bon-list">${shown.map(deliveryHtml).join('')}</div>
      ${capped ? `<button type="button" class="esp-more" data-deliv-more="${m}">Afficher les ${items.length - DELIV_CAP} autres livraisons de ${espEsc(espMonthLabel(m).split(' ')[0].toLowerCase())}</button>` : ''}`;
  }).join('');

  // Le détail d'un bon n'est fabriqué qu'à son ouverture : une longue liste reste légère.
  box.querySelectorAll('details.bon').forEach(el => {
    el.addEventListener('toggle', () => {
      if (!el.open || el.querySelector('.bon-body')) return;
      const tpl = el.querySelector('template');
      if (tpl) el.appendChild(tpl.content.cloneNode(true));
    });
  });
}

// ---------- contrat ----------

const DETAIL_LEVEL_TEXT = {
  detail: 'Une ligne par article et par bon de livraison',
  per_bl: 'Une ligne par bon de livraison',
  aggregated: 'Une ligne par article pour la période',
};
const QUOTE_STATE = (q) => {
  if (q.status === 'accepted') return ['Accepté', 'paid'];
  if (q.status === 'invoiced') return ['Facturé', 'paid'];
  if (q.status === 'refused') return ['Refusé', 'neutral'];
  return q.expired ? ['Expiré', 'neutral'] : [q.validUntil ? `Valable jusqu'au ${portalDay(q.validUntil)}` : 'En cours', 'due'];
};

function dlRow(label, value) {
  return `<dt>${espEsc(label)}</dt><dd>${value}</dd>`;
}

async function renderContract() {
  const box = document.getElementById('contract-body');
  const c = await api('GET', '/api/clients/contract');
  espaceData.documents = c.documents;
  const cond = c.conditions; const est = c.establishment;

  const delay = cond.paymentTermsDays > 0 ? `${plural(cond.paymentTermsDays, 'jour', 'jours')} à compter de la date de facture` : 'À réception de la facture';
  const method = cond.paymentMethod.type === 'sdd'
    ? `Prélèvement SEPA <small>(mandat ${espEsc(cond.paymentMethod.umr)}${cond.paymentMethod.signedOn ? `, signé le ${espEsc(portalDay(cond.paymentMethod.signedOn))}` : ''})</small>`
    : 'Virement bancaire';
  let escompteText = '';
  if (cond.escompte) {
    const h = cond.escompte.hours;
    const d = h % 24 === 0 ? plural(h / 24, 'jour', 'jours') : `${h} h`;
    escompteText = `${portalPct(cond.escompte.ratePct)} % pour tout règlement sous ${d}`;
  }
  const conditions = `
    <section class="esp-card" aria-labelledby="ct-cond-h">
      <h4 id="ct-cond-h" class="esp-card-h">Conditions de règlement</h4>
      <dl class="esp-dl">
        ${dlRow('Délai de paiement', espEsc(delay))}
        ${dlRow('Mode de règlement', method)}
        ${escompteText ? dlRow('Escompte', espEsc(escompteText)) : ''}
        ${dlRow('Détail des factures', espEsc(DETAIL_LEVEL_TEXT[cond.detailLevel] || DETAIL_LEVEL_TEXT.detail))}
        ${cond.latePenalty ? dlRow('Retard de paiement', `<small class="ct-legal">${espEsc(cond.latePenalty)}</small>`) : ''}
      </dl>
    </section>`;

  const establishment = `
    <section class="esp-card" aria-labelledby="ct-etab-h">
      <div class="esp-sechead"><h4 id="ct-etab-h" class="esp-card-h">Mon établissement</h4><button type="button" class="link-btn" data-esp-go="compte" data-esp-open="acct-billing">Modifier dans Mon compte</button></div>
      <dl class="esp-dl">
        ${dlRow('Raison sociale', espEsc(est.societe))}
        ${est.clientType === 'particulier' ? '' : dlRow('SIRET', est.siret ? `<span class="mono">${espEsc(est.siret)}</span>` : '<span class="esp-muted">Non renseigné</span>')}
        ${est.clientType === 'particulier' ? '' : dlRow('N° de TVA', est.tvaNumber ? `<span class="mono">${espEsc(est.tvaNumber)}</span>` : '<span class="esp-muted">Non renseigné</span>')}
        ${dlRow('Adresse de collecte', espEsc(est.adresse))}
        ${dlRow('Adresse de facturation', est.adresseFacturation ? espEsc(est.adresseFacturation) : 'Identique à l\'adresse de collecte')}
      </dl>
    </section>`;

  // tarifs, par famille d'articles
  const byCat = new Map();
  for (const p of c.prices) { if (!byCat.has(p.categoryLabel)) byCat.set(p.categoryLabel, []); byCat.get(p.categoryLabel).push(p); }
  const priceRows = [...byCat.entries()].map(([cat, list]) => `
    <tbody>
      <tr class="grp"><th scope="rowgroup" colspan="3">${espEsc(cat)}</th></tr>
      ${list.map(p => `<tr>
        <td>${espEsc(p.name)}</td>
        <td class="num mono">${espPrice(p.price)}${p.previous != null && p.previous !== p.price ? `<small>avant : ${espPrice(p.previous)}</small>` : ''}${p.upcoming ? `<small>dès le ${espEsc(portalDay(p.upcoming.from))} : ${espPrice(p.upcoming.price)}</small>` : ''}</td>
        <td class="since">${p.since ? espEsc(portalDay(p.since)) : '<span class="esp-muted">Tarif catalogue</span>'}</td>
      </tr>`).join('')}
    </tbody>`).join('');
  const prices = `
    <section class="esp-card wide" aria-labelledby="ct-prix-h">
      <div class="esp-sechead"><h4 id="ct-prix-h" class="esp-card-h">Mes tarifs</h4><span class="esp-muted esp-small">Prix unitaires hors taxes, au ${espEsc(portalDay(c.today))}</span></div>
      ${c.prices.length ? `<div class="esp-tablewrap"><table class="esp-table prices">
        <thead><tr><th scope="col">Article</th><th scope="col" class="num">Prix HT</th><th scope="col">En vigueur depuis</th></tr></thead>
        ${priceRows}
      </table></div>` : '<p class="empty-note">Vos tarifs ne sont pas encore renseignés. Contactez-nous pour les recevoir.</p>'}
    </section>`;

  const quotes = c.quotes.length ? `
    <section class="esp-card" aria-labelledby="ct-devis-h">
      <h4 id="ct-devis-h" class="esp-card-h">Devis</h4>
      ${c.quotes.map(q => { const [label, tone] = QUOTE_STATE(q); return `
        <div class="esp-line">
          <div class="esp-line-main"><span class="bon-num">${espEsc(q.number || '')}</span><span class="bon-date">${espEsc([q.reference, q.totalHtCents != null ? `${portalEur(q.totalHtCents)} HT` : ''].filter(Boolean).join(' · '))}</span></div>
          <div class="esp-line-side">${espPill(label, tone)}<a class="inv-pdf" href="${espEsc(q.pdfUrl)}" target="_blank" rel="noopener" aria-label="Devis ${espEsc(q.number || '')} en PDF">PDF</a></div>
        </div>`; }).join('')}
    </section>` : '';

  const docs = `
    <section class="esp-card" aria-labelledby="ct-docs-h">
      <h4 id="ct-docs-h" class="esp-card-h">Documents</h4>
      ${c.documents.length ? c.documents.map(d => `
        <div class="esp-line">
          <div class="esp-line-main"><span class="esp-line-title">${espEsc(d.title)}</span><span class="bon-date">${d.signedOn ? `Signé le ${espEsc(portalDay(d.signedOn))}` : (d.common ? 'Valable pour tous nos clients' : '')}</span></div>
          <a class="esp-btn" href="${espEsc(d.url)}" target="_blank" rel="noopener" aria-label="${espEsc(d.title)} en PDF">${espPdfIcon}PDF</a>
        </div>`).join('')
        : '<p class="empty-note">Aucun document pour le moment. Votre contrat signé apparaîtra ici dès que Blanchisserie Cézanne l\'aura déposé.</p>'}
    </section>`;

  box.innerHTML = `
    <div class="esp-grid">${conditions}${establishment}</div>
    ${prices}
    <div class="esp-grid">${quotes}${docs}</div>`;
  renderHomeDocs();
}

// Accueil : les documents (contrat signé) sans ouvrir l'onglet Contrat.
async function renderHomeDocuments() {
  const { documents } = await api('GET', '/api/clients/documents');
  espaceData.documents = documents;
  renderHomeDocs();
}

initEspaceTabs();
