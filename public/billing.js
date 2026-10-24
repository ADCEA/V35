// Écran « Facturation » (facturation intégrée) — administration.
// Dépend de api() et escHtml() définis dans app.js. Point d'entrée : renderBillingTab().

(function () {
  const root = () => document.getElementById('billing-root');
  const e = (s) => escHtml(s == null ? '' : String(s));
  const eur = (c) => (c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const dFr = (iso) => (iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—');
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });

  const STATUS = {
    draft: ['Brouillon', '#64798D'], unpaid: ['À payer', '#B8860B'], partial: ['Partiel', '#B8860B'],
    paid: ['Payée', '#1E8E6B'], overdue: ['En retard', '#E0574B'], credited: ['Annulée par avoir', '#64798D'],
  };
  function badge(inv) {
    let key = inv.status === 'draft' ? 'draft' : inv.paymentStatus;
    if (inv.kind === 'credit_note') return `<span class="mini-badge" style="border-color:#64798D;color:#64798D;">${inv.status === 'draft' ? 'Avoir brouillon' : 'Avoir'}</span>`;
    const [label, color] = STATUS[key] || [key || '—', '#64798D'];
    return `<span class="mini-badge" style="border-color:${color};color:${color};">${label}</span>`;
  }

  const state = { tab: 'invoices', filterClient: '', filterStatus: '', clients: [], settings: null };

  async function ensureClients() {
    if (state.clients.length) return;
    const { clients } = await api('GET', '/api/admin/clients');
    state.clients = clients;
  }

  window.renderBillingTab = async function () {
    const [{ settings, odooConfigured, hasIssuedDocuments }] = await Promise.all([api('GET', '/api/admin/billing/settings'), ensureClients()]);
    state.settings = settings; state.odooConfigured = odooConfigured; state.hasIssuedDocuments = hasIssuedDocuments;
    draw();
  };

  function draw() {
    const nav = [['invoices', 'Factures et avoirs'], ['settings', 'Réglages'], ['controls', 'Contrôle et exports']];
    root().innerHTML = `
      <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;">
        ${nav.map(([k, l]) => `<button class="btn-secondary" data-bt="${k}" style="width:auto;padding:7px 14px;${state.tab === k ? 'background:var(--ink);color:#fff;' : ''}">${l}</button>`).join('')}
      </div>
      ${state.settings.engine !== 'native' ? `<div class="card" style="border-color:var(--amber);margin-bottom:16px;"><p style="margin:0;font-size:12.5px;">Moteur actif : <b>Odoo</b>. La facturation intégrée est en lecture seule (aucune création ni émission). Pour l'utiliser : <a href="#" id="bt-goto-settings">Réglages → moteur de facturation</a>.</p></div>` : ''}
      <div id="bt-body"></div>`;
    root().querySelectorAll('[data-bt]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.bt; draw(); }));
    const g = document.getElementById('bt-goto-settings');
    if (g) g.addEventListener('click', (ev) => { ev.preventDefault(); state.tab = 'settings'; draw(); });
    if (state.tab === 'invoices') drawList();
    if (state.tab === 'settings') drawSettings();
    if (state.tab === 'controls') drawControls();
  }
  const body = () => document.getElementById('bt-body');
  const note = (el, msg, isErr) => { el.textContent = msg; el.classList.toggle('error', !!isErr); el.style.color = isErr ? '' : 'var(--teal)'; };

  // ======================= LISTE =======================
  async function drawList() {
    const q = new URLSearchParams();
    if (state.filterClient) q.set('clientId', state.filterClient);
    if (state.filterStatus) q.set('status', state.filterStatus);
    const { invoices } = await api('GET', '/api/admin/billing/invoices?' + q);
    const native = state.settings.engine === 'native';
    body().innerHTML = `
      <div class="card">
        <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:14px;">
          <div class="field" style="margin:0;min-width:200px;"><label>Hôtel</label>
            <select id="bf-client"><option value="">Tous</option>${state.clients.map(c => `<option value="${c.id}" ${String(c.id) === String(state.filterClient) ? 'selected' : ''}>${e(c.societe)}</option>`).join('')}</select></div>
          <div class="field" style="margin:0;"><label>Statut</label>
            <select id="bf-status"><option value="">Tous</option><option value="draft" ${state.filterStatus === 'draft' ? 'selected' : ''}>Brouillons</option><option value="issued" ${state.filterStatus === 'issued' ? 'selected' : ''}>Émis</option></select></div>
          <button class="btn-primary" id="bf-new" style="width:auto;margin:0;" ${native ? '' : 'disabled'}>Nouvelle facture</button>
        </div>
        ${invoices.length === 0 ? '<p class="empty-note">Aucune facture pour ces critères.</p>' : `
        <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead><tr style="text-align:left;color:var(--steel-light);font-size:11px;text-transform:uppercase;">
            <th style="padding:6px 8px;">N°</th><th>Hôtel</th><th>Date</th><th style="text-align:right;">HT</th><th style="text-align:right;">TTC</th><th style="text-align:right;">Reste dû</th><th>Statut</th><th></th></tr></thead>
          <tbody>${invoices.map(i => {
            const sg = i.kind === 'credit_note' ? -1 : 1;
            return `<tr style="border-top:1px solid var(--line);">
              <td style="padding:7px 8px;" class="mono">${i.number ? e(i.number) : '<i style="color:var(--steel-light);">brouillon</i>'}</td>
              <td>${e(i.buyerName)}</td><td>${dFr(i.issueDate || '')}</td>
              <td style="text-align:right;">${eur(sg * i.totalHtCents)}</td><td style="text-align:right;">${eur(sg * i.totalTtcCents)}</td>
              <td style="text-align:right;">${i.kind === 'invoice' && i.status === 'issued' ? eur(i.balanceCents) : ''}</td>
              <td>${badge(i)}</td>
              <td style="text-align:right;"><button class="btn-secondary" data-open="${i.id}" style="width:auto;padding:4px 10px;">Ouvrir</button></td></tr>`;
          }).join('')}</tbody></table></div>`}
      </div>`;
    document.getElementById('bf-client').onchange = (ev) => { state.filterClient = ev.target.value; drawList(); };
    document.getElementById('bf-status').onchange = (ev) => { state.filterStatus = ev.target.value; drawList(); };
    document.getElementById('bf-new').onclick = drawNew;
    body().querySelectorAll('[data-open]').forEach(b => b.onclick = () => drawDetail(Number(b.dataset.open)));
  }

  // ======================= NOUVELLE FACTURE =======================
  async function drawNew() {
    body().innerHTML = `
      <div class="card">
        <button class="btn-secondary" id="bn-back" style="width:auto;padding:5px 12px;margin-bottom:12px;">← Retour</button>
        <h4 class="card-subhead">Nouvelle facture</h4>
        <div class="field" style="max-width:360px;"><label>Hôtel</label>
          <select id="bn-client"><option value="">— Choisir —</option>${state.clients.map(c => `<option value="${c.id}">${e(c.societe)}</option>`).join('')}</select></div>
        <div id="bn-orders"></div>
        <div class="field-row" style="max-width:560px;margin-top:10px;">
          <div class="field"><label>Niveau de détail</label>
            <select id="bn-detail"><option value="">Selon la fiche client</option><option value="detail">Par article et par BL</option><option value="per_bl">Un montant par BL</option><option value="aggregated">Cumul par article</option></select></div>
          <div class="field"><label>Nature de l'opération</label>
            <select id="bn-cat"><option value="services">Prestation de services</option><option value="goods">Livraison de biens</option><option value="mixed">Mixte</option></select></div>
        </div>
        <button class="btn-primary" id="bn-create" style="width:auto;" disabled>Créer le brouillon</button>
        <div class="qty-save-note" id="bn-note"></div>
      </div>`;
    document.getElementById('bn-back').onclick = drawList;
    const sel = document.getElementById('bn-client');
    const create = document.getElementById('bn-create');
    sel.onchange = async () => {
      const zone = document.getElementById('bn-orders');
      create.disabled = true;
      if (!sel.value) { zone.innerHTML = ''; return; }
      const { orders } = await api('GET', `/api/admin/billing/clients/${sel.value}/invoiceable-orders`);
      if (!orders.length) { zone.innerHTML = '<p class="empty-note">Aucun BL livré en attente de facturation pour cet hôtel.</p>'; return; }
      zone.innerHTML = `<p style="font-size:11px;color:var(--steel-light);margin:8px 0 6px;">${orders.length} BL livré(s) non facturé(s) :</p>` +
        orders.map(o => `<label style="display:flex;gap:6px;font-size:12.5px;padding:3px 0;cursor:pointer;"><input type="checkbox" class="bn-chk" value="${o.id}" checked> ${e(o.ticket)} — livré le ${o.livraisonPrevue ? new Date(o.livraisonPrevue).toLocaleDateString('fr-FR') : 'date inconnue'}</label>`).join('');
      const upd = () => { create.disabled = !zone.querySelectorAll('.bn-chk:checked').length; };
      zone.querySelectorAll('.bn-chk').forEach(c => c.onchange = upd); upd();
    };
    create.onclick = async () => {
      const n = document.getElementById('bn-note');
      create.disabled = true;
      try {
        const { invoice } = await api('POST', '/api/admin/billing/invoices', {
          clientId: Number(sel.value),
          orderIds: [...document.querySelectorAll('.bn-chk:checked')].map(c => Number(c.value)),
          detailLevel: document.getElementById('bn-detail').value || undefined,
          operationCategory: document.getElementById('bn-cat').value,
        });
        drawDetail(invoice.id);
      } catch (err) { note(n, err.message, true); create.disabled = false; }
    };
  }

  // ======================= DÉTAIL =======================
  async function drawDetail(id) {
    const { invoice: inv } = await api('GET', `/api/admin/billing/invoices/${id}`);
    const isDraft = inv.status === 'draft';
    const isCredit = inv.kind === 'credit_note';
    const sg = isCredit ? -1 : 1;
    const native = state.settings.engine === 'native';
    const problems = isDraft && inv.preview ? inv.preview.problems : [];

    const linesHtml = inv.lines.map((l, idx) => {
      if (l.isSection) return `<tr data-idx="${idx}" data-section="1"><td colspan="5" style="padding:8px 8px 2px;font-weight:600;color:var(--steel);font-size:12px;">${isDraft && !isCredit ? `<input class="bl-desc" value="${e(l.description)}" style="width:80%;">` : e(l.description)}</td>${isDraft && !isCredit ? `<td><button data-del="${idx}" title="Supprimer">✕</button></td>` : ''}</tr>`;
      if (isDraft && !isCredit) {
        return `<tr data-idx="${idx}">
          <td><input class="bl-desc" value="${e(l.description)}" style="width:100%;"></td>
          <td><input class="bl-qty" type="number" step="any" min="0" value="${l.quantity}" style="width:70px;text-align:right;"></td>
          <td><input class="bl-pu" type="number" step="0.0001" min="0" value="${l.unitPrice}" style="width:80px;text-align:right;"></td>
          <td><select class="bl-vat">${[20, 10, 5.5, 2.1, 0].map(v => `<option value="${v}" ${Number(l.vatRate) === v ? 'selected' : ''}>${v} %</option>`).join('')}</select></td>
          <td style="text-align:right;" class="mono">${eur(l.lineHtCents)}</td>
          <td><button data-del="${idx}" title="Supprimer la ligne">✕</button></td></tr>`;
      }
      return `<tr style="border-top:1px solid var(--line);"><td style="padding:5px 8px;">${e(l.description)}</td>
        <td style="text-align:right;">${sg * l.quantity}</td><td style="text-align:right;">${l.unitPrice}</td><td style="text-align:right;">${l.vatRate} %</td>
        <td style="text-align:right;" class="mono">${eur(sg * l.lineHtCents)}</td></tr>`;
    }).join('');

    body().innerHTML = `
      <div class="card">
        <button class="btn-secondary" id="bd-back" style="width:auto;padding:5px 12px;margin-bottom:12px;">← Retour à la liste</button>
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center;">
          <h4 class="card-subhead" style="margin:0;">${isCredit ? 'Avoir' : 'Facture'} ${inv.number ? e(inv.number) : '(brouillon)'} — ${e(inv.buyerName)} ${badge(inv)}</h4>
          <a class="btn-secondary" href="/api/admin/billing/invoices/${inv.id}/pdf" target="_blank" style="text-decoration:none;width:auto;padding:7px 14px;">${isDraft ? 'Aperçu PDF' : 'PDF'}</a>
        </div>
        ${isCredit ? `<p style="font-size:12.5px;margin:8px 0 0;">Rectifie la facture <b>${e(inv.creditsInvoiceNumber)}</b>. Motif : ${e(inv.creditReason)}</p>` : ''}
        ${inv.reference ? `<p style="font-size:11.5px;color:var(--steel-light);margin:6px 0 0;">${e(inv.reference)}</p>` : ''}

        ${problems.length ? `<div style="background:#FFF6E5;border:1px solid var(--amber);border-radius:5px;padding:10px 14px;margin:14px 0;font-size:12.5px;">
          <b>À compléter avant l'émission :</b><ul style="margin:6px 0 0 18px;">${problems.map(p => `<li>${e(p)}</li>`).join('')}</ul></div>` : ''}

        <div style="overflow-x:auto;margin-top:14px;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;" id="bd-lines">
          <thead><tr style="text-align:left;color:var(--steel-light);font-size:11px;text-transform:uppercase;"><th style="padding:6px 8px;">Désignation</th><th style="text-align:right;">Qté</th><th style="text-align:right;">PU HT</th><th style="text-align:right;">TVA</th><th style="text-align:right;">Total HT</th>${isDraft && !isCredit ? '<th></th>' : ''}</tr></thead>
          <tbody>${linesHtml}</tbody></table></div>
        ${isDraft && !isCredit ? '<button class="btn-secondary" id="bd-addline" style="width:auto;padding:5px 12px;margin-top:8px;">+ Ajouter une ligne</button>' : ''}

        <div style="text-align:right;margin-top:14px;font-size:13px;">
          ${inv.vatBreakdown.map(b => `<div style="color:var(--steel);">TVA ${b.rate} % sur ${eur(sg * b.baseCents)} : ${eur(sg * b.vatCents)}</div>`).join('')}
          <div>Total HT : <b>${eur(sg * inv.totalHtCents)}</b></div>
          <div style="font-size:15px;">Total TTC : <b>${eur(sg * inv.totalTtcCents)}</b></div>
          ${!isCredit && inv.status === 'issued' ? `<div style="color:var(--steel);">Réglé : ${eur(inv.paidCents)} · Avoirs : ${eur(inv.creditedCents)} · <b>Reste dû : ${eur(inv.balanceCents)}</b></div>` : ''}
        </div>

        ${isDraft ? `
        <div class="field-row" style="max-width:560px;margin-top:14px;">
          <div class="field"><label>Date d'émission</label><input type="date" id="bd-date" value="${e(inv.issueDate || inv.preview.issueDate)}"></div>
          <div class="field"><label>Nature de l'opération</label>
            <select id="bd-cat" ${isCredit ? 'disabled' : ''}>${[['services', 'Prestation de services'], ['goods', 'Livraison de biens'], ['mixed', 'Mixte']].map(([v, l]) => `<option value="${v}" ${inv.operationCategory === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>Notes (apparaissent sur la facture)</label><input id="bd-notes" value="${e(inv.notes || '')}" ${isCredit ? 'disabled' : ''}></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
          ${isCredit ? '' : '<button class="btn-secondary" id="bd-save" style="width:auto;">Enregistrer le brouillon</button>'}
          <button class="btn-primary" id="bd-issue" style="width:auto;margin:0;" ${native ? '' : 'disabled'}>Émettre ${isCredit ? "l'avoir" : 'la facture'}</button>
          <button class="btn-secondary" id="bd-delete" style="width:auto;border-color:var(--rust);color:var(--rust);">Supprimer le brouillon</button>
        </div>
        <p style="font-size:11.5px;color:var(--steel-light);margin-top:8px;">Émettre attribue le numéro définitif et verrouille le document : plus aucune modification possible, seulement un avoir.</p>` : ''}
        <div class="qty-save-note" id="bd-note"></div>
      </div>
      ${!isDraft && !isCredit ? paymentsAndCredit(inv) : ''}`;

    document.getElementById('bd-back').onclick = drawList;
    const n = document.getElementById('bd-note');

    if (isDraft) {
      const readLines = () => [...document.querySelectorAll('#bd-lines tbody tr')].map(tr => {
        if (tr.dataset.section) return { isSection: true, description: tr.querySelector('.bl-desc').value };
        return { description: tr.querySelector('.bl-desc').value, quantity: tr.querySelector('.bl-qty').value, unitPrice: tr.querySelector('.bl-pu').value, vatRate: tr.querySelector('.bl-vat').value, sageCode: (inv.lines[Number(tr.dataset.idx)] || {}).sageCode || null };
      });
      const save = async () => {
        const patch = { issueDate: document.getElementById('bd-date').value || null };
        if (!isCredit) { patch.lines = readLines(); patch.operationCategory = document.getElementById('bd-cat').value; patch.notes = document.getElementById('bd-notes').value; }
        await api('PUT', `/api/admin/billing/invoices/${inv.id}`, patch);
      };
      document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        const lines = readLines(); lines.splice(Number(b.dataset.del), 1);
        try { await api('PUT', `/api/admin/billing/invoices/${inv.id}`, { lines }); drawDetail(inv.id); } catch (err) { note(n, err.message, true); }
      });
      const add = document.getElementById('bd-addline');
      if (add) add.onclick = async () => {
        const lines = readLines(); lines.push({ description: 'Nouvelle prestation', quantity: 1, unitPrice: 0, vatRate: state.settings.default_vat_rate });
        try { await api('PUT', `/api/admin/billing/invoices/${inv.id}`, { lines }); drawDetail(inv.id); } catch (err) { note(n, err.message, true); }
      };
      const sv = document.getElementById('bd-save');
      if (sv) sv.onclick = async () => { try { await save(); note(n, 'Brouillon enregistré ✓'); drawDetail(inv.id); } catch (err) { note(n, err.message, true); } };
      document.getElementById('bd-issue').onclick = async () => {
        if (!confirm(`Émettre définitivement ce document ?\n\nLe numéro est attribué et le document ne pourra plus jamais être modifié (correction par avoir uniquement).`)) return;
        try { await save(); const r = await api('POST', `/api/admin/billing/invoices/${inv.id}/issue`, { issueDate: document.getElementById('bd-date').value || undefined }); drawDetail(r.invoice.id); }
        catch (err) { note(n, err.message, true); }
      };
      document.getElementById('bd-delete').onclick = async () => {
        if (!confirm('Supprimer ce brouillon ? Les BL redeviennent facturables.')) return;
        try { await api('DELETE', `/api/admin/billing/invoices/${inv.id}`); drawList(); } catch (err) { note(n, err.message, true); }
      };
    } else if (!isCredit) {
      wirePaymentsAndCredit(inv);
    }
  }

  function paymentsAndCredit(inv) {
    const methods = [['virement', 'Virement'], ['cheque', 'Chèque'], ['prelevement', 'Prélèvement'], ['carte', 'Carte'], ['especes', 'Espèces'], ['autre', 'Autre']];
    const creditable = inv.lines.filter(l => !l.isSection);
    return `
      <div class="card" style="margin-top:16px;">
        <h4 class="card-subhead">Règlements</h4>
        ${inv.payments.length ? `<table style="width:100%;font-size:12.5px;border-collapse:collapse;">${inv.payments.map(p => `<tr style="border-top:1px solid var(--line);"><td style="padding:5px 8px;">${dFr(p.paidOn)}</td><td>${e(p.method)}</td><td>${e(p.reference || '')}</td><td style="text-align:right;${p.amountCents < 0 ? 'color:var(--rust);' : ''}">${eur(p.amountCents)}</td></tr>`).join('')}</table>` : '<p class="empty-note">Aucun règlement enregistré.</p>'}
        <div class="field-row" style="max-width:640px;margin-top:12px;grid-template-columns:repeat(4,1fr);">
          <div class="field"><label>Date</label><input type="date" id="bp-date" value="${today()}"></div>
          <div class="field"><label>Montant (€) — négatif pour annuler</label><input type="number" step="0.01" id="bp-amount" value="${(inv.balanceCents / 100).toFixed(2)}"></div>
          <div class="field"><label>Mode</label><select id="bp-method">${methods.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          <div class="field"><label>Référence</label><input id="bp-ref"></div>
        </div>
        <button class="btn-secondary" id="bp-add" style="width:auto;">Enregistrer le règlement</button>
        <div class="qty-save-note" id="bp-note"></div>
        <p style="font-size:11.5px;color:var(--steel-light);">Un règlement enregistré ne se modifie pas : on saisit une écriture inverse (montant négatif).</p>
      </div>

      <div class="card" style="margin-top:16px;">
        <h4 class="card-subhead">Avoirs</h4>
        ${inv.creditNotes.length ? inv.creditNotes.map(c => `<div style="font-size:12.5px;padding:4px 0;"><a href="#" data-open-cn="${c.id}">${e(c.number)}</a> — ${dFr(c.issueDate)} — ${eur(-c.totalTtcCents)}</div>`).join('') : '<p class="empty-note">Aucun avoir émis sur cette facture.</p>'}
        <details style="margin-top:10px;"><summary style="cursor:pointer;font-size:12.5px;font-weight:600;">Créer un avoir</summary>
          <div class="field" style="margin-top:10px;"><label>Motif (obligatoire)</label><input id="bc-reason" placeholder="Ex. erreur de tarif sur les draps"></div>
          <label style="font-size:12.5px;display:block;margin-bottom:8px;"><input type="checkbox" id="bc-full"> Avoir total (tout ce qui n'a pas déjà été crédité)</label>
          <div id="bc-lines"><table style="font-size:12.5px;border-collapse:collapse;width:100%;">${creditable.map(l => `<tr style="border-top:1px solid var(--line);"><td style="padding:4px 8px;">${e(l.description)}</td><td style="text-align:right;color:var(--steel-light);">facturé ${l.quantity}</td><td style="text-align:right;"><input type="number" step="any" min="0" class="bc-qty" data-line="${l.id}" placeholder="qté à créditer" style="width:110px;text-align:right;"></td></tr>`).join('')}</table></div>
          <button class="btn-secondary" id="bc-create" style="width:auto;margin-top:10px;">Créer le brouillon d'avoir</button>
          <div class="qty-save-note" id="bc-note"></div>
        </details>
      </div>`;
  }

  function wirePaymentsAndCredit(inv) {
    document.getElementById('bp-add').onclick = async () => {
      const n = document.getElementById('bp-note');
      try {
        await api('POST', `/api/admin/billing/invoices/${inv.id}/payments`, {
          paidOn: document.getElementById('bp-date').value, amount: document.getElementById('bp-amount').value,
          method: document.getElementById('bp-method').value, reference: document.getElementById('bp-ref').value,
        });
        drawDetail(inv.id);
      } catch (err) { note(n, err.message, true); }
    };
    document.querySelectorAll('[data-open-cn]').forEach(a => a.onclick = (ev) => { ev.preventDefault(); drawDetail(Number(a.dataset.openCn)); });
    const full = document.getElementById('bc-full');
    full.onchange = () => { document.getElementById('bc-lines').style.opacity = full.checked ? 0.4 : 1; };
    document.getElementById('bc-create').onclick = async () => {
      const n = document.getElementById('bc-note');
      const lines = [...document.querySelectorAll('.bc-qty')].filter(i => i.value !== '' && Number(i.value) > 0).map(i => ({ lineId: Number(i.dataset.line), quantity: Number(i.value) }));
      try {
        const { invoice } = await api('POST', `/api/admin/billing/invoices/${inv.id}/credit-note`, { reason: document.getElementById('bc-reason').value, full: full.checked, lines: full.checked ? undefined : lines });
        drawDetail(invoice.id);
      } catch (err) { note(n, err.message, true); }
    };
  }

  // ======================= RÉGLAGES =======================
  function drawSettings() {
    const s = state.settings;
    const f = (id, label, val, extra = '') => `<div class="field"><label>${label}</label><input id="bs-${id}" value="${e(val || '')}" ${extra}></div>`;
    body().innerHTML = `
      <div class="card">
        <h4 class="card-subhead">Moteur de facturation</h4>
        <div class="field" style="max-width:420px;"><label>Moteur actif</label>
          <select id="bs-engine"><option value="native" ${s.engine === 'native' ? 'selected' : ''}>Facturation intégrée</option><option value="odoo" ${s.engine === 'odoo' ? 'selected' : ''}>Odoo (circuit existant)</option></select></div>
        <p style="font-size:12px;color:var(--steel);">Un seul moteur est actif à la fois, pour qu'un BL ne soit jamais facturé deux fois. Les BL déjà passés par Odoo ne sont jamais re-proposés ici. ${state.hasIssuedDocuments ? '<b>Des documents ont déjà été émis par la facturation intégrée : leur numérotation et leurs préfixes ne peuvent plus changer.</b>' : ''}</p>
      </div>
      <div class="card" style="margin-top:16px;">
        <h4 class="card-subhead">Identité de l'émetteur (mentions légales)</h4>
        <div class="field-row">${f('legal_name', 'Raison sociale', s.legal_name)}${f('legal_form', 'Forme juridique', s.legal_form)}</div>
        <div class="field-row">${f('share_capital', 'Capital social (ex. 10 000 €)', s.share_capital)}${f('rcs', 'Immatriculation (ex. RCS Avignon)', s.rcs)}</div>
        <div class="field-row">${f('siren', 'SIREN (9 chiffres)', s.siren, 'inputmode="numeric" maxlength="11"')}${f('siret', 'SIRET (14 chiffres)', s.siret, 'inputmode="numeric" maxlength="17"')}</div>
        ${f('vat_number', 'N° de TVA intracommunautaire', s.vat_number)}
        ${f('address_line', 'Adresse du siège', s.address_line)}
        <div class="field-row">${f('postal_code', 'Code postal', s.postal_code)}${f('city', 'Ville', s.city)}</div>
        <div class="field-row">${f('email', 'Email', s.email)}${f('phone', 'Téléphone', s.phone)}</div>
        <div class="field-row">${f('iban', 'IBAN', s.iban)}${f('bic', 'BIC', s.bic)}</div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h4 class="card-subhead">Conditions</h4>
        <div class="field-row">
          <div class="field"><label>Délai de paiement (jours, 60 max)</label><input id="bs-payment_terms_days" type="number" min="0" max="60" value="${s.payment_terms_days}"></div>
          <div class="field"><label>TVA par défaut</label><select id="bs-default_vat_rate">${[20, 10, 5.5, 2.1, 0].map(v => `<option value="${v}" ${Number(s.default_vat_rate) === v ? 'selected' : ''}>${v} %</option>`).join('')}</select></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Préfixe factures</label><input id="bs-invoice_prefix" value="${e(s.invoice_prefix)}" ${state.hasIssuedDocuments ? 'disabled' : ''}></div>
          <div class="field"><label>Préfixe avoirs</label><input id="bs-credit_prefix" value="${e(s.credit_prefix)}" ${state.hasIssuedDocuments ? 'disabled' : ''}></div>
        </div>
        <div class="field"><label>Pénalités de retard</label><input id="bs-late_penalty_text" value="${e(s.late_penalty_text)}"></div>
        <div class="field"><label>Mention de pied de page (facultatif)</label><input id="bs-footer_note" value="${e(s.footer_note || '')}"></div>
        <label style="font-size:12.5px;"><input type="checkbox" id="bs-vat_on_debits" ${s.vat_on_debits ? 'checked' : ''}> J'ai opté pour le paiement de la TVA d'après les débits (mention imprimée sur les prestations de services)</label>
        <div><button class="btn-primary" id="bs-save" style="width:auto;">Enregistrer</button></div>
        <div class="qty-save-note" id="bs-note"></div>
      </div>`;
    document.getElementById('bs-save').onclick = async () => {
      const g = (id) => document.getElementById('bs-' + id);
      const payload = {};
      ['legal_name', 'legal_form', 'share_capital', 'rcs', 'siren', 'siret', 'vat_number', 'address_line', 'postal_code', 'city', 'email', 'phone', 'iban', 'bic', 'late_penalty_text', 'footer_note', 'payment_terms_days', 'default_vat_rate', 'engine'].forEach(k => payload[k] = g(k).value);
      if (!state.hasIssuedDocuments) { payload.invoice_prefix = g('invoice_prefix').value; payload.credit_prefix = g('credit_prefix').value; }
      payload.vat_on_debits = g('vat_on_debits').checked;
      try {
        const { settings } = await api('PUT', '/api/admin/billing/settings', payload);
        state.settings = settings;
        note(document.getElementById('bs-note'), 'Réglages enregistrés ✓');
        setTimeout(draw, 600);
      } catch (err) { note(document.getElementById('bs-note'), err.message, true); }
    };
  }

  // ======================= CONTRÔLES / EXPORTS =======================
  function drawControls() {
    const y = new Date().getFullYear();
    body().innerHTML = `
      <div class="card">
        <h4 class="card-subhead">Contrôle d'intégrité</h4>
        <p style="font-size:12.5px;color:var(--steel);">Vérifie la numérotation continue, la chaîne d'empreintes entre tous les documents émis, la cohérence des totaux et le journal d'événements. À lancer avant chaque clôture.</p>
        <button class="btn-secondary" id="bc-run" style="width:auto;">Lancer le contrôle</button>
        <div id="bc-result" style="margin-top:10px;font-size:12.5px;"></div>
      </div>
      <div class="card" style="margin-top:16px;">
        <h4 class="card-subhead">Export FEC (fichier des écritures comptables)</h4>
        <p style="font-size:12.5px;color:var(--steel);">Ventes (journal VT) et règlements (journal BQ) de l'exercice. À faire relire par votre expert-comptable : les numéros de comptes (411, 706000, 445710, 512000) sont des comptes usuels du plan comptable général.</p>
        <div style="display:flex;gap:10px;align-items:end;"><div class="field" style="margin:0;"><label>Année</label><input type="number" id="bx-year" value="${y}" style="width:100px;"></div>
        <a class="btn-secondary" id="bx-go" href="#" style="text-decoration:none;width:auto;">Télécharger le FEC</a></div>
      </div>`;
    document.getElementById('bc-run').onclick = async () => {
      const r = await api('GET', '/api/admin/billing/integrity');
      document.getElementById('bc-result').innerHTML = r.ok
        ? `<span style="color:var(--teal);">✓ Intègre — ${r.checked} document(s) émis vérifié(s).</span>`
        : `<b style="color:var(--rust);">Anomalies détectées :</b><ul>${r.problems.map(p => `<li>${e(p)}</li>`).join('')}</ul>`;
    };
    document.getElementById('bx-go').onclick = (ev) => { ev.currentTarget.href = `/api/admin/billing/export/fec?year=${document.getElementById('bx-year').value}`; };
  }
})();
