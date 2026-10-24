// Prélèvements SEPA : factures à prélever, lots (fichier remis à la banque), mandats des hôtels.
(function () {
  const { e, eur, dFr, dtFr, plural } = Bill;

  const S = { tab: 'collect', date: '', sel: new Set(), showRevoked: false };
  const BATCH = { prepared: ['draft', 'Préparé'], sent: ['partial', 'Envoyé à la banque'], settled: ['paid', 'Encaissé'], cancelled: ['credited', 'Annulé'] };
  const pill = (cls, label) => `<span class="bl-pill ${cls}">${e(label)}</span>`;
  const batchPill = (st) => pill(...BATCH[st]);
  const SEQ = { FRST: 'Premier prélèvement', RCUR: 'Récurrent' };
  const REASONS = ['Provision insuffisante (AM04)', 'Compte clos (AC04)', 'IBAN invalide (AC01)', 'Mandat inexistant ou révoqué (MD01)', "Opposition du débiteur (MS02)", 'Autre motif…'];
  const longDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const list = (items, max = 6) => `<ul>${items.slice(0, max).map(x => `<li>${e(x)}</li>`).join('')}${items.length > max ? `<li>… et ${items.length - max} autre(s)</li>` : ''}</ul>`;

  Bill.register('sdd', {
    async render(main, params = {}) {
      if (params.tab) S.tab = params.tab;
      paint(main, await Bill.get('/sdd/overview'));
    },
  });

  function paint(main, ov) {
    const cr = ov.creditor;
    const open = ov.prepared + ov.sent;
    main.innerHTML = `<div class="bl-head"><div><h2>Prélèvements SEPA</h2><p>Vous préparez un fichier, vous le remettez à votre banque, et les règlements ne sont enregistrés sur les factures qu'une fois le prélèvement passé.</p></div>
      <div class="bl-actions"><button class="bl-btn" id="sd-set">Identifiant créancier et préavis</button></div></div>
      ${cr.ready ? '' : `<div class="bl-alert warn"><b>Avant le premier prélèvement</b>${list(cr.problems)}</div>`}
      ${ov.toSettle ? `<div class="bl-alert info"><b>${plural(ov.toSettle, 'lot à clôturer', 'lots à clôturer')}</b> : la date de prélèvement est passée. Vérifiez votre relevé de compte, puis clôturez le lot pour enregistrer les règlements. <button class="bl-btn small" id="sd-goto">Voir les lots</button></div>` : ''}
      <div class="bl-panel"><div class="bl-tabs" role="tablist">
        <button class="bl-tab ${S.tab === 'collect' ? 'active' : ''}" role="tab" data-t="collect">À prélever</button>
        <button class="bl-tab ${S.tab === 'batches' ? 'active' : ''} ${ov.toSettle ? 'late' : ''}" role="tab" data-t="batches">Lots${open ? ` <small>${plural(open, 'en cours', 'en cours')}</small>` : ''}</button>
        <button class="bl-tab ${S.tab === 'mandates' ? 'active' : ''}" role="tab" data-t="mandates">Mandats <small>${plural(ov.mandates, 'actif', 'actifs')}</small></button>
      </div><div id="sd-body" class="bl-panel-b"></div></div>`;
    main.querySelector('#sd-set').onclick = () => settingsDialog(cr);
    const goto = main.querySelector('#sd-goto'); if (goto) goto.onclick = () => { S.tab = 'batches'; paint(main, ov); };
    main.querySelectorAll('.bl-tab').forEach(b => b.onclick = () => { S.tab = b.dataset.t; main.querySelectorAll('.bl-tab').forEach(x => x.classList.toggle('active', x === b)); tab(main, ov); });
    tab(main, ov);
  }

  function tab(main, ov) {
    const body = main.querySelector('#sd-body');
    return (S.tab === 'batches' ? batchesTab : S.tab === 'mandates' ? mandatesTab : collectTab)(body, ov).catch(err => Bill.fail(err, body));
  }

  // ================= À prélever =================
  async function collectTab(body, ov) {
    body.innerHTML = '<div class="bl-spin">Chargement…</div>';
    const c = await Bill.get('/sdd/candidates' + (S.date ? `?collectionDate=${encodeURIComponent(S.date)}` : ''));
    S.date = c.collectionDate;
    const usable = new Map(c.lines.filter(l => !l.blocked).map(l => [l.invoiceId, l]));
    for (const id of [...S.sel]) if (!usable.has(id)) S.sel.delete(id);

    const row = (l) => `<tr data-id="${l.invoiceId}"><td><input type="checkbox" class="sd-c" value="${l.invoiceId}" ${l.blocked ? 'disabled' : ''} ${S.sel.has(l.invoiceId) ? 'checked' : ''} aria-label="Prélever ${e(l.number)}"></td>
      <td class="client">${e(l.clientName)}</td>
      <td class="bl-num">${e(l.number)}${l.warnings.map(w => `<span class="sub sdd-w">${e(w)}</span>`).join('')}${l.blocked ? `<span class="sub" style="color:var(--bl-late)">${e(l.blocked)}</span>` : ''}</td>
      <td class="bl-num">${dFr(l.dueDate)}${l.overdueDays ? `<span class="sub" style="color:var(--bl-late)">${plural(l.overdueDays, 'jour de retard', 'jours de retard')}</span>` : ''}</td>
      <td>${e(l.umr)}<span class="sub">${e(l.ibanMasked)}${l.firstCollection ? ' · premier prélèvement' : ''}</span></td>
      <td class="r bl-num"><b>${eur(l.balanceCents)}</b></td></tr>`;

    body.innerHTML = `${c.preparedBatch ? `<div class="bl-alert info">Le lot <b>${e(c.preparedBatch.msgId)}</b> est déjà préparé : remettez-le à la banque (puis marquez-le « Envoyé ») ou annulez-le avant d'en préparer un autre. <button class="bl-btn small" id="sd-open-prep">Ouvrir ce lot</button></div>` : ''}
      <div class="bl-filters" style="border:1px solid var(--line);border-radius:8px 8px 0 0">
        <div class="bl-field"><label for="sd-date">Date de prélèvement</label><input id="sd-date" type="date" value="${e(c.collectionDate)}" min="${e(c.bounds.min)}" max="${e(c.bounds.max)}"></div>
        <div class="bl-muted grow" style="padding-bottom:8px">Un jour ouvré bancaire, au plus tôt le ${dFr(c.bounds.min)}. Prévoyez aussi le préavis de ${plural(c.creditor.noticeDays, 'jour', 'jours')} que vous devez à vos hôtels.</div>
        <div style="display:flex;gap:8px;padding-bottom:2px"><button class="bl-btn small" id="sd-due">Cocher les factures échues</button><button class="bl-btn small" id="sd-none">Tout décocher</button></div></div>
      ${c.dateProblem ? `<div class="bl-alert bad" style="margin:12px 0 0">${e(c.dateProblem)}</div>` : ''}
      ${c.lines.length ? `<div class="bl-tablewrap"><table class="bl-table"><thead><tr><th style="width:34px"><input type="checkbox" id="sd-all" aria-label="Tout cocher"></th><th>Hôtel</th><th>Facture</th><th>Échéance</th><th>Mandat</th><th class="r">Reste dû</th></tr></thead><tbody>${c.lines.map(row).join('')}</tbody></table></div>
        <div class="sdd-bar"><span id="sd-sum"></span><button class="bl-btn primary" id="sd-prep">Préparer le lot…</button></div>`
        : `<div class="bl-empty"><b>Aucune facture à prélever</b>${ov.mandates ? "Les hôtels qui ont un mandat n'ont aucune facture ouverte, ou leurs factures sont déjà dans un lot." : 'Commencez par enregistrer les mandats de vos hôtels (onglet « Mandats »).'}</div>`}
      ${c.noMandate.length ? `<details class="sdd-nomandate"><summary>${plural(c.noMandate.length, 'hôtel avec des factures ouvertes n\'a', 'hôtels avec des factures ouvertes n\'ont')} pas de mandat</summary>
        <div class="bl-tablewrap"><table class="bl-table"><tbody>${c.noMandate.map(g => `<tr><td class="client">${e(g.clientName)}</td><td>${plural(g.count, 'facture ouverte', 'factures ouvertes')}</td><td class="r bl-num">${eur(g.balanceCents)}</td><td class="r"><button class="bl-btn small" data-mandate="${g.clientId}">Créer le mandat</button></td></tr>`).join('')}</tbody></table></div></details>` : ''}
      ${c.engagedInvoices ? `<p class="bl-muted" style="margin-top:10px">${plural(c.engagedInvoices, 'facture est déjà dans un lot en cours', 'factures sont déjà dans un lot en cours')} et n'apparaît pas ici.</p>` : ''}`;

    const sum = () => {
      const on = [...S.sel].map(id => usable.get(id));
      const el = body.querySelector('#sd-sum'); if (!el) return;
      el.textContent = on.length ? `${plural(on.length, 'facture cochée', 'factures cochées')} · ${plural(new Set(on.map(l => l.clientId)).size, 'hôtel', 'hôtels')} · ${eur(on.reduce((t, l) => t + l.balanceCents, 0))}` : 'Aucune facture cochée';
      const all = body.querySelector('#sd-all'); if (all) { all.checked = on.length > 0 && on.length === usable.size; all.indeterminate = on.length > 0 && on.length < usable.size; }
    };
    const sync = () => { body.querySelectorAll('.sd-c').forEach(x => { x.checked = S.sel.has(Number(x.value)); }); sum(); };
    sum();
    const date = body.querySelector('#sd-date');
    date.onchange = () => { if (date.value) { S.date = date.value; collectTab(body, ov).catch(err => Bill.fail(err, body)); } };
    const bind = (id, fn) => { const el = body.querySelector(id); if (el) el.onclick = fn; };
    bind('#sd-open-prep', async () => { S.tab = 'batches'; await Bill.go('sdd'); openBatch(c.preparedBatch.id); });
    bind('#sd-none', () => { S.sel.clear(); sync(); });
    bind('#sd-due', () => { S.sel.clear(); for (const l of usable.values()) if (l.dueDate && l.dueDate <= c.collectionDate) S.sel.add(l.invoiceId); sync(); if (!S.sel.size) Bill.toast("Aucune facture n'est échue à cette date.", true); });
    const all = body.querySelector('#sd-all'); if (all) all.onchange = () => { S.sel = all.checked ? new Set(usable.keys()) : new Set(); sync(); };
    body.onchange = (ev) => { if (ev.target.classList.contains('sd-c')) { const id = Number(ev.target.value); if (ev.target.checked) S.sel.add(id); else S.sel.delete(id); sum(); } };
    body.querySelectorAll('[data-mandate]').forEach(b => b.onclick = () => mandateDialog({ clientId: Number(b.dataset.mandate) }));
    bind('#sd-prep', () => {
      if (!S.sel.size) return Bill.toast('Cochez au moins une facture.', true);
      prepareDialog(c.collectionDate, [...S.sel]);
    });
  }

  async function prepareDialog(date, ids) {
    let r;
    try { r = await Bill.post('/sdd/batches/preview', { invoiceIds: ids, collectionDate: date }); } catch (err) { return Bill.fail(err); }
    const ok = r.problems.length === 0 && r.count > 0;
    Bill.modal({
      title: 'Préparer un lot de prélèvements', wide: true,
      body: `${r.problems.length ? `<div class="bl-alert bad"><b>Impossible de préparer ce lot</b>${list(r.problems, 8)}</div>` : ''}
        ${r.warnings.length ? `<div class="bl-alert warn"><b>À vérifier avant de continuer</b>${list(r.warnings, 8)}<div class="bl-hint">Ces points ne bloquent pas le lot : c'est à vous de juger s'ils posent un problème.</div></div>` : ''}
        ${ok ? `<div class="bl-alert ok"><b>${plural(r.count, 'prélèvement', 'prélèvements')}</b> (${plural(r.invoiceCount, 'facture', 'factures')}) pour <b>${eur(r.totalCents)}</b>, le ${e(longDate(r.collectionDate))}${r.firstCount ? ` · ${plural(r.firstCount, 'premier prélèvement', 'premiers prélèvements')}` : ''}. Rien n'est encore enregistré comme payé : les règlements seront saisis à la clôture du lot.</div>` : ''}
        <div class="bl-tablewrap" style="max-height:300px;overflow:auto"><table class="bl-table"><thead><tr><th>Hôtel</th><th>Mandat</th><th>Type</th><th>Factures</th><th class="r">Montant</th></tr></thead><tbody>
        ${r.debits.map(d => `<tr><td class="client">${e(d.clientName)}</td><td>${e(d.umr)}<span class="sub">${e(d.ibanMasked)}</span></td><td>${e(SEQ[d.seqType])}${d.scheme === 'B2B' ? ' · B2B' : ''}</td><td>${d.invoices.map(i => e(i.number)).join(', ')}</td><td class="r bl-num"><b>${eur(d.amountCents)}</b></td></tr>`).join('')}</tbody></table></div>`,
      buttons: [
        { label: ok ? 'Annuler' : 'Fermer', onClick: async () => {} },
        ...(ok ? [{ label: 'Préparer le lot', primary: true, onClick: async (m) => {
          m.close();
          Bill.sensitive({
            title: 'Préparer le lot de prélèvements', scope: 'sdd-batch', okLabel: 'Préparer le lot',
            text: `${plural(r.count, 'prélèvement', 'prélèvements')} pour ${eur(r.totalCents)}, le ${dFr(r.collectionDate)}. Les factures concernées sont réservées jusqu'à la clôture ou l'annulation du lot.`,
            onSubmit: async () => {
              const b = (await Bill.post('/sdd/batches', { invoiceIds: ids, collectionDate: date })).batch;
              S.sel.clear(); S.tab = 'batches';
              Bill.toast('Lot préparé : téléchargez le fichier pour le remettre à votre banque.');
              await Bill.go('sdd');
              openBatch(b.id);
            },
          });
          return true;
        } }] : []),
      ],
    });
  }

  // ================= Lots =================
  async function batchesTab(body) {
    body.innerHTML = '<div class="bl-spin">Chargement…</div>';
    const { batches } = await Bill.get('/sdd/batches');
    if (!batches.length) { body.innerHTML = '<div class="bl-empty"><b>Aucun lot pour le moment</b>Cochez des factures dans « À prélever » pour préparer le premier fichier.</div>'; return; }
    const today = Bill.today();
    body.innerHTML = `<div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Lot</th><th>Prélèvement le</th><th>Prélèvements</th><th class="r">Montant</th><th>Statut</th></tr></thead><tbody>
      ${batches.map(b => `<tr class="bl-row" tabindex="0" data-id="${b.id}"><td class="bl-num">${e(b.msgId)}<span class="sub">préparé le ${dtFr(b.createdAt)}</span></td><td class="bl-num">${dFr(b.collectionDate)}</td><td>${plural(b.itemCount, 'prélèvement', 'prélèvements')}</td>
        <td class="r bl-num"><b>${eur(b.totalCents)}</b>${b.status === 'settled' && b.rejectedCount ? `<span class="sub" style="color:var(--bl-late)">dont ${eur(b.rejectedCents)} rejeté</span>` : ''}</td>
        <td>${batchPill(b.status)}${b.status === 'sent' && b.collectionDate <= today ? '<span class="sub" style="color:var(--bl-wait)">à clôturer</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
    body.querySelectorAll('tr.bl-row').forEach(tr => { const open = () => openBatch(Number(tr.dataset.id)); tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter') open(); }; });
  }

  async function openBatch(id) {
    let dirty = false;
    const d = Bill.drawer({ onClose: () => { if (dirty && Bill.state.page === 'sdd') Bill.go('sdd'); } });
    d.body.innerHTML = '<div class="bl-spin">Chargement…</div>';
    const draw = async () => {
      let b;
      try { b = (await Bill.get(`/sdd/batches/${id}`)).batch; } catch (err) { return Bill.fail(err, d.body); }
      const today = Bill.today();
      const due = b.status === 'sent' && b.collectionDate <= today;
      const act = [];
      if (b.status === 'prepared' || b.status === 'sent') act.push(`<button class="bl-btn ${b.status === 'prepared' ? 'primary' : ''}" id="bt-dl">Télécharger le fichier</button>`);
      if (b.status === 'prepared') act.push('<button class="bl-btn" id="bt-sent">Je l\'ai remis à la banque</button>');
      if (b.status === 'sent') act.push(`<button class="bl-btn ${due ? 'primary' : ''}" id="bt-settle">Clôturer le lot…</button>`);
      if (b.status === 'prepared' || b.status === 'sent') act.push('<button class="bl-btn danger" id="bt-cancel">Annuler le lot</button>');
      d.setHead({ title: e(b.msgId), sub: `${batchPill(b.status)} · prélèvement le ${dFr(b.collectionDate)} · ${eur(b.totalCents)}`, actions: act.join('') });
      const steps = { prepared: ['Téléchargez le fichier', "Déposez-le sur l'espace de télétransmission de votre banque (remise de prélèvements SEPA)", 'Revenez ici et cliquez « Je l\'ai remis à la banque »', `À partir du ${dFr(b.collectionDate)}, vérifiez le relevé de compte, puis clôturez le lot`],
        sent: [`Le fichier est chez la banque. Le prélèvement a lieu le ${dFr(b.collectionDate)}.`, due ? 'La date est passée : consultez votre relevé de compte.' : 'Rien à faire d\'ici là.', 'Clôturez le lot : indiquez les prélèvements rejetés, tous les autres sont enregistrés comme payés.'] }[b.status];
      d.body.innerHTML = `${steps ? `<div class="bl-alert info"><ol class="sdd-steps">${steps.map(s => `<li>${e(s)}</li>`).join('')}</ol></div>` : ''}
        ${b.status === 'cancelled' ? `<div class="bl-alert warn">Lot annulé le ${dtFr(b.cancelledAt)} : ${e(b.cancelReason || '')}. Les factures sont de nouveau disponibles.</div>` : ''}
        ${b.status === 'settled' ? `<div class="bl-alert ok">Clôturé le ${dtFr(b.settledAt)} : ${eur(b.collectedCents)} encaissés${b.rejectedCount ? `, ${eur(b.rejectedCents)} rejetés (${plural(b.rejectedCount, 'prélèvement', 'prélèvements')}, restés impayés)` : ''}.</div>` : ''}
        <div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Hôtel</th><th>Mandat</th><th class="r">Montant</th></tr></thead><tbody>
        ${b.items.map(i => `<tr><td class="client">${e(i.clientName)}<span class="sub">${i.invoices.map(v => e(v.number)).join(', ')}</span></td><td>${e(i.umr)}<span class="sub">${e(i.ibanMasked)} · ${e(SEQ[i.seqType])}${i.scheme === 'B2B' ? ' · B2B' : ''}</span></td>
          <td class="r bl-num"><b>${eur(i.amountCents)}</b>${i.status === 'collected' ? `<span class="sub">${pill('paid', 'Encaissé')}</span>` : i.status === 'rejected' ? `<span class="sub">${pill('overdue', 'Rejeté')}</span><span class="sub">${e(i.rejectReason || '')}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
        <p class="bl-muted" style="margin-top:12px">Identifiant créancier ${e(b.creditor.ics)} · compte ${e(b.creditor.ibanMasked)}${b.sentAt ? ` · remis à la banque le ${dtFr(b.sentAt)}` : ''}</p>`;
      const on = (sel, fn) => { const el = d.el.querySelector(sel); if (el) el.onclick = fn; };
      on('#bt-dl', () => Bill.sensitive({ title: 'Télécharger le fichier de prélèvements', scope: `sdd-file:${id}`, okLabel: 'Télécharger',
        text: "Ce fichier contient les IBAN de vos hôtels. Déposez-le uniquement sur l'espace de télétransmission de votre banque, puis supprimez-le de votre ordinateur.",
        onSubmit: async () => { await Bill.download(`/sdd/batches/${id}/file`, 'prelevements-sepa.xml'); Bill.toast('Fichier téléchargé'); } }));
      on('#bt-sent', async () => {
        if (!await Bill.confirm('Fichier remis à la banque ?', "Confirmez seulement si vous avez déposé le fichier chez votre banque. Les factures restent réservées à ce lot jusqu'à sa clôture.", 'Oui, il est remis')) return;
        try { await Bill.post(`/sdd/batches/${id}/sent`); dirty = true; Bill.toast('Lot marqué « Envoyé à la banque »'); draw(); } catch (err) { Bill.fail(err); }
      });
      on('#bt-settle', () => settleDialog(b, async () => { dirty = true; await draw(); }));
      on('#bt-cancel', () => Bill.sensitive({ title: `Annuler le lot ${b.msgId}`, scope: `sdd-cancel:${id}`, okLabel: 'Annuler le lot', danger: true,
        text: b.status === 'sent' ? "Le fichier a été remis à la banque : l'annuler ici ne l'arrête pas. À faire seulement si vous l'avez retiré auprès de votre banque avant son exécution." : 'Les factures redeviennent disponibles pour un autre lot.',
        body: '<div class="bl-field"><label for="bc-r">Motif</label><input id="bc-r" maxlength="140" placeholder="Ex. mauvaise date, facture à corriger"></div>',
        onSubmit: async (m) => { await Bill.post(`/sdd/batches/${id}/cancel`, { reason: m.$('#bc-r').value }); dirty = true; Bill.toast('Lot annulé'); draw(); } }));
    };
    await draw();
  }

  function settleDialog(b, done) {
    Bill.sensitive({
      title: `Clôturer le lot ${b.msgId}`, wide: true, scope: `sdd-settle:${b.id}`, okLabel: 'Enregistrer les règlements',
      text: `Cochez uniquement les prélèvements que la banque a rejetés ou n'a pas encaissés (regardez votre relevé de compte). Tous les autres sont enregistrés comme payés, mode « Prélèvement », à la date du ${dFr(b.collectionDate)}. Une facture rejetée reste impayée.`,
      body: `<div class="bl-tablewrap" style="max-height:320px;overflow:auto"><table class="bl-table"><thead><tr><th style="width:70px">Rejeté</th><th>Hôtel</th><th class="r">Montant</th><th>Motif du rejet</th></tr></thead><tbody>
        ${b.items.map(i => `<tr data-item="${i.id}"><td><input type="checkbox" class="st-r" aria-label="Rejeté : ${e(i.clientName)}"></td><td class="client">${e(i.clientName)}<span class="sub">${i.invoices.map(v => e(v.number)).join(', ')}</span></td><td class="r bl-num">${eur(i.amountCents)}</td>
          <td><div class="st-why" hidden><select class="st-sel">${REASONS.map(r => `<option>${e(r)}</option>`).join('')}</select><input class="st-txt" maxlength="140" placeholder="Précisez le motif" hidden>
          <label class="bl-check" style="margin-top:4px"><input type="checkbox" class="st-rev"> <span>Révoquer ce mandat</span></label></div></td></tr>`).join('')}</tbody></table></div>
        <div class="bl-muted" id="st-sum" style="margin:8px 0 12px"></div>`,
      onOpen: (m) => {
        m.el.classList.add('xl');
        const sum = () => {
          const rej = [...m.el.querySelectorAll('.st-r:checked')].length;
          const ok = b.items.length - rej;
          const cents = b.items.filter(i => !m.el.querySelector(`tr[data-item="${i.id}"] .st-r`).checked).reduce((t, i) => t + i.amountCents, 0);
          m.$('#st-sum').textContent = `${plural(ok, 'prélèvement encaissé', 'prélèvements encaissés')} · ${eur(cents)} enregistrés${rej ? ` · ${plural(rej, 'rejeté', 'rejetés')}` : ''}`;
        };
        m.el.addEventListener('change', (ev) => {
          const tr = ev.target.closest('tr[data-item]');
          if (ev.target.classList.contains('st-r')) tr.querySelector('.st-why').hidden = !ev.target.checked;
          if (ev.target.classList.contains('st-sel')) { const t = tr.querySelector('.st-txt'); t.hidden = ev.target.value !== REASONS[REASONS.length - 1]; if (!t.hidden) t.focus(); }
          sum();
        });
        sum();
      },
      onSubmit: async (m) => {
        const rejections = [...m.el.querySelectorAll('tr[data-item]')].filter(tr => tr.querySelector('.st-r').checked).map(tr => {
          const sel = tr.querySelector('.st-sel').value; const txt = tr.querySelector('.st-txt').value.trim();
          return { itemId: Number(tr.dataset.item), reason: sel === REASONS[REASONS.length - 1] ? txt : sel, revokeMandate: tr.querySelector('.st-rev').checked };
        });
        const r = await Bill.post(`/sdd/batches/${b.id}/settle`, { rejections });
        Bill.toast(`${plural(r.payments, 'règlement enregistré', 'règlements enregistrés')} · ${eur(r.collectedCents)}${r.rejected ? ` · ${plural(r.rejected, 'prélèvement rejeté', 'prélèvements rejetés')}` : ''}`);
        Bill.refreshBadges();
        await done();
      },
    });
  }

  // ================= Mandats =================
  async function mandatesTab(body) {
    body.innerHTML = '<div class="bl-spin">Chargement…</div>';
    const { mandates } = await Bill.get('/sdd/mandates');
    const shown = S.showRevoked ? mandates : mandates.filter(m => m.status === 'active');
    const state = (m) => (m.status === 'revoked' ? pill('draft', 'Révoqué') : m.expired ? pill('overdue', 'Caduc') : pill('paid', 'Actif'));
    body.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <label class="bl-check"><input type="checkbox" id="md-rev" ${S.showRevoked ? 'checked' : ''}> <span>Afficher les mandats révoqués</span></label>
        <button class="bl-btn primary" id="md-new">Nouveau mandat…</button></div>
      ${shown.length ? `<div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Hôtel</th><th>Compte</th><th>Dernier prélèvement</th><th>Statut</th><th></th></tr></thead><tbody>
        ${shown.map(m => `<tr><td class="client">${e(m.clientName)}<span class="sub bl-num">${e(m.umr)} · ${m.scheme === 'B2B' ? 'B2B' : 'SEPA Core'}</span>${m.debtorName !== m.clientName ? `<span class="sub">${e(m.debtorName)}</span>` : ''}${m.status === 'revoked' ? `<span class="sub">Révoqué le ${dFr(m.revokedOn)} : ${e(m.revokedReason || '')}</span>` : ''}</td>
          <td class="bl-num">${e(m.ibanMasked)}<span class="sub">signé le ${dFr(m.signedOn)}</span></td>
          <td class="bl-num">${m.lastCollectionDate ? dFr(m.lastCollectionDate) : '—'}${m.status === 'active' ? `<span class="sub" ${m.expired ? 'style="color:var(--bl-late)"' : ''}>${m.expired ? 'caduc depuis' : "valable jusqu'au"} ${dFr(m.expiresOn)}</span>` : ''}</td>
          <td>${state(m)}</td>
          <td class="r" style="white-space:nowrap"><button class="bl-btn small" data-copy="${m.id}">Copie PDF</button>${m.status === 'active' ? ` <button class="bl-btn small danger" data-revoke="${m.id}">Révoquer</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="bl-empty"><b>Aucun mandat</b>Un mandat est l\'autorisation signée par un hôtel pour être prélevé. Créez-en un dès que vous avez reçu le formulaire signé et le RIB.</div>'}
      <p class="bl-hint" style="margin-top:12px">Un mandat n'est jamais supprimé (la loi demande de le conserver 14 mois après le dernier prélèvement) : on le révoque. Pour changer de compte bancaire, créez un nouveau mandat en remplacement de l'ancien. Un mandat sans prélèvement pendant 36 mois devient caduc.</p>`;
    body.querySelector('#md-rev').onchange = (ev) => { S.showRevoked = ev.target.checked; mandatesTab(body).catch(err => Bill.fail(err, body)); };
    body.querySelector('#md-new').onclick = () => mandateDialog({ active: mandates.filter(m => m.status === 'active') });
    body.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
      const id = Number(b.dataset.copy);
      Bill.sensitive({ title: 'Copie du mandat', scope: `sdd-copy:${id}`, okLabel: 'Télécharger', text: "La copie porte l'IBAN complet de l'hôtel.", onSubmit: async () => { await Bill.download(`/sdd/mandates/${id}/pdf`, 'mandat-sepa.pdf'); } });
    });
    body.querySelectorAll('[data-revoke]').forEach(b => b.onclick = () => {
      const m = mandates.find(x => x.id === Number(b.dataset.revoke));
      Bill.sensitive({ title: `Révoquer le mandat ${m.umr}`, scope: 'sdd-mandate', okLabel: 'Révoquer', danger: true,
        text: `${m.clientName} ne pourra plus être prélevé tant qu'un nouveau mandat n'est pas enregistré.`,
        body: '<div class="bl-field"><label for="rv-r">Motif</label><input id="rv-r" maxlength="140" placeholder="Ex. changement de banque, hôtel fermé"></div>',
        onSubmit: async (mm) => { await Bill.post(`/sdd/mandates/${m.id}/revoke`, { reason: mm.$('#rv-r').value }); Bill.toast('Mandat révoqué'); Bill.go('sdd', { tab: 'mandates' }); } });
    });
  }

  async function mandateDialog({ clientId, active } = {}) {
    let clients; let actives = active;
    try {
      clients = await Bill.clients();
      if (!actives) actives = (await Bill.get('/sdd/mandates?status=active')).mandates;
    } catch (err) { return Bill.fail(err); }
    const activeOf = (id) => actives.find(m => m.clientId === Number(id));
    let umrTouched = false; let nameTouched = false;
    Bill.sensitive({
      title: 'Nouveau mandat de prélèvement', wide: true, scope: 'sdd-mandate', okLabel: 'Enregistrer le mandat',
      body: `<p class="bl-note">Enregistrez ici un mandat que l'hôtel a <b>déjà signé</b>. Si vous n'avez pas encore de formulaire signé, choisissez l'hôtel puis imprimez le formulaire à lui faire signer.</p>
        <div class="bl-row2"><div class="bl-field"><label for="md-c">Hôtel</label><select id="md-c">${Bill.clientOptions(clients, clientId)}</select></div>
        <div class="bl-field"><label for="md-n">Titulaire du compte</label><input id="md-n" maxlength="70"></div></div>
        <div class="bl-row2"><div class="bl-field"><label for="md-i">IBAN</label><input id="md-i" autocomplete="off" placeholder="FR76 …"></div>
        <div class="bl-field"><label for="md-b">BIC (facultatif)</label><input id="md-b" autocomplete="off" maxlength="11"></div></div>
        <div class="bl-row3"><div class="bl-field"><label for="md-d">Date de signature</label><input id="md-d" type="date" max="${Bill.today()}"></div>
        <div class="bl-field"><label for="md-s">Type</label><select id="md-s"><option value="CORE">SEPA Core (usage courant)</option><option value="B2B">Interentreprises (B2B)</option></select></div>
        <div class="bl-field"><label for="md-u">Référence du mandat (RUM)</label><input id="md-u" maxlength="35" autocomplete="off"></div></div>
        <div class="bl-hint" id="md-hint">La référence est proposée automatiquement. Si le mandat signé en porte déjà une, saisissez-la telle quelle.</div>
        <label class="bl-check" id="md-rep" hidden style="margin-top:10px"><input type="checkbox" id="md-r"> <span></span></label>
        <div style="margin:12px 0 18px"><button type="button" class="bl-btn small" id="md-form">Imprimer le formulaire à faire signer</button></div>`,
      onOpen: (m) => {
        const hotel = () => m.$('#md-c').value;
        const refresh = async () => {
          const id = hotel(); if (!id) return;
          const c = clients.find(x => String(x.id) === String(id));
          if (!nameTouched && c) m.$('#md-n').value = c.societe;
          const a = activeOf(id);
          const rep = m.$('#md-rep'); rep.hidden = !a; m.$('#md-r').checked = !!a;
          if (a) rep.querySelector('span').textContent = `Remplace le mandat actuel (${a.umr}, compte ${a.ibanMasked}) : il sera révoqué. À utiliser pour un changement de compte.`;
          if (!umrTouched) { try { m.$('#md-u').value = (await Bill.get(`/sdd/mandates/suggest?clientId=${id}`)).umr; } catch (_) { /* proposition facultative */ } }
        };
        m.$('#md-c').onchange = refresh;
        m.$('#md-n').oninput = () => { nameTouched = true; };
        m.$('#md-u').oninput = () => { umrTouched = true; };
        m.$('#md-form').onclick = () => {
          if (!hotel()) return m.err('Choisissez d\'abord l\'hôtel.');
          const q = new URLSearchParams({ clientId: hotel(), scheme: m.$('#md-s').value });
          if (m.$('#md-u').value.trim()) q.set('umr', m.$('#md-u').value.trim());
          Bill.openPdf(`/sdd/mandate-form?${q}`);
        };
        refresh();
      },
      onSubmit: async (m) => {
        if (!m.$('#md-c').value) throw new Error("Choisissez l'hôtel.");
        await Bill.post('/sdd/mandates', {
          clientId: Number(m.$('#md-c').value), debtorName: m.$('#md-n').value, iban: m.$('#md-i').value, bic: m.$('#md-b').value, signedOn: m.$('#md-d').value,
          scheme: m.$('#md-s').value, umr: m.$('#md-u').value.trim(), replace: m.$('#md-r').checked,
        });
        Bill.toast('Mandat enregistré');
        S.tab = 'mandates'; Bill.go('sdd', { tab: 'mandates' });
      },
    });
  }

  // ================= Réglages =================
  function settingsDialog(cr) {
    Bill.sensitive({
      title: 'Identifiant créancier et préavis', scope: 'sdd-settings', okLabel: 'Enregistrer',
      text: `Le nom (${cr.name || 'à renseigner'}) et le compte (${cr.ibanMasked || 'à renseigner'}) qui reçoivent les prélèvements sont ceux de la page « Émetteur ».`,
      body: `<div class="bl-field"><label for="ss-i">Identifiant créancier SEPA (ICS)</label><input id="ss-i" value="${e(cr.ics || '')}" placeholder="FR72ZZZ123456" autocomplete="off">
        <div class="bl-hint">Délivré par votre banque (ou la Banque de France) : « FR », deux chiffres, « ZZZ », puis six caractères. Sans lui, aucun fichier ne sera accepté.</div></div>
        <div class="bl-field"><label for="ss-n">Préavis donné aux hôtels (jours)</label><input id="ss-n" type="number" min="1" max="60" value="${e(cr.noticeDays)}">
        <div class="bl-hint">14 jours avant le prélèvement, sauf accord différent avec l'hôtel. La facture, envoyée avec sa date d'échéance et son montant, tient lieu de préavis. L'application vous avertit si le délai n'est pas respecté.</div></div>`,
      onSubmit: async (m) => {
        const body = { noticeDays: Number(m.$('#ss-n').value) };
        if (m.$('#ss-i').value.trim()) body.ics = m.$('#ss-i').value;
        await Bill.put('/sdd/creditor', body);
        Bill.toast('Enregistré'); Bill.go('sdd');
      },
    });
  }
})();
