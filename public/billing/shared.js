// Composants partagés des pages : actes sensibles (ressaisie du code), liste des hôtels,
// éditeur de lignes (factures et devis), fenêtre d'envoi par e-mail.
(function () {
  const { e, eur } = Bill;

  // Acte sensible : une seule fenêtre demande le code ET confirme l'action.
  // onSubmit(modal) s'exécute après la ressaisie ; une erreur reste affichée dans la fenêtre.
  Bill.sensitive = function ({ title, text, body = '', scope, okLabel = 'Confirmer', danger, wide, onSubmit, onOpen }) {
    return Bill.modal({
      title, wide,
      body: `${text ? `<p class="bl-note" style="white-space:pre-line">${e(text)}</p>` : ''}${body}
        <div class="bl-field"><label for="bl-sc">Code de la Facturation</label><input id="bl-sc" type="password" autocomplete="off"></div>`,
      buttons: [
        { label: 'Annuler', onClick: async () => {} },
        { label: okLabel, primary: !danger, danger: !!danger, onClick: async (m) => {
          const code = m.$('#bl-sc').value;
          if (!code) throw new Error('Saisissez le code de la Facturation.');
          await Bill.post('/lock/confirm', { code, scope: typeof scope === 'function' ? scope(m) : scope });
          return onSubmit(m);
        } },
      ],
      onOpen: (m) => {
        m.$('#bl-sc').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); m.el.querySelector('.bl-foot .primary, .bl-foot .danger:last-child').click(); } });
        if (onOpen) onOpen(m);
      },
    });
  };

  // Liste des hôtels (comptes clients), mise en cache le temps de la session.
  let clientsCache = null;
  Bill.clients = async (force) => {
    if (!clientsCache || force) clientsCache = (await api('GET', '/api/admin/clients')).clients;
    return clientsCache;
  };
  Bill.clientOptions = (clients, selected) => '<option value="">Choisir un hôtel…</option>' + clients.map(c => `<option value="${c.id}" ${String(selected) === String(c.id) ? 'selected' : ''}>${e(c.societe)}</option>`).join('');

  const VAT = [20, 10, 5.5, 2.1, 8.5, 0];
  const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };

  // Éditeur de lignes. Les montants affichés ici sont indicatifs : le serveur recalcule tout à l'enregistrement.
  Bill.linesEditor = function (host, lines, { defaultVat = 20 } = {}) {
    const state = (lines && lines.length ? lines : [{ description: '', quantity: 1, unitPrice: 0, vatRate: defaultVat }]).map(l => ({
      isSection: !!l.isSection, description: l.description || '', sageCode: l.sageCode || null,
      quantity: l.quantity ?? 1, unitPrice: l.unitPrice ?? 0, vatRate: l.vatRate ?? defaultVat,
    }));
    function totals() {
      const by = new Map(); let ht = 0;
      for (const l of state) {
        if (l.isSection) continue;
        const c = Math.round(num(l.quantity) * num(l.unitPrice) * 100); ht += c;
        by.set(l.vatRate, (by.get(l.vatRate) || 0) + c);
      }
      let vat = 0; for (const [r, base] of by) vat += Math.round(base * Number(r) / 100);
      return { ht, vat, ttc: ht + vat };
    }
    function draw() {
      host.innerHTML = `<div class="bl-tablewrap"><table class="bl-table bl-lines"><thead><tr><th>Désignation</th><th style="width:80px">Qté</th><th style="width:100px">Prix HT</th><th style="width:84px">TVA</th><th class="r" style="width:100px">Total HT</th><th style="width:34px"></th></tr></thead><tbody>
        ${state.map((l, i) => l.isSection
          ? `<tr><td class="sec" colspan="5"><input data-i="${i}" data-f="description" value="${e(l.description)}" placeholder="Titre de section" aria-label="Titre de section"></td><td><button type="button" class="bl-btn link small" data-rm="${i}" aria-label="Supprimer la ligne">×</button></td></tr>`
          : `<tr><td><input data-i="${i}" data-f="description" value="${e(l.description)}" placeholder="Désignation" aria-label="Désignation"></td>
            <td><input data-i="${i}" data-f="quantity" value="${e(l.quantity)}" inputmode="decimal" aria-label="Quantité"></td>
            <td><input data-i="${i}" data-f="unitPrice" value="${e(l.unitPrice)}" inputmode="decimal" aria-label="Prix unitaire HT"></td>
            <td><select data-i="${i}" data-f="vatRate" aria-label="TVA">${VAT.map(v => `<option value="${v}" ${Number(l.vatRate) === v ? 'selected' : ''}>${String(v).replace('.', ',')} %</option>`).join('')}</select></td>
            <td class="r bl-num" data-total="${i}">${e(eur(Math.round(num(l.quantity) * num(l.unitPrice) * 100)))}</td>
            <td><button type="button" class="bl-btn link small" data-rm="${i}" aria-label="Supprimer la ligne">×</button></td></tr>`).join('')}
      </tbody></table></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-top:8px">
        <div><button type="button" class="bl-btn small" data-add="line">Ajouter une ligne</button> <button type="button" class="bl-btn small" data-add="section">Ajouter un titre</button></div>
        <div class="bl-totals" data-sum></div></div>`;
      sum();
      host.querySelectorAll('input[data-f],select[data-f]').forEach(inp => {
        inp.oninput = inp.onchange = () => {
          const l = state[Number(inp.dataset.i)]; const f = inp.dataset.f;
          l[f] = f === 'vatRate' ? Number(inp.value) : inp.value;
          const cell = host.querySelector(`[data-total="${inp.dataset.i}"]`);
          if (cell) cell.textContent = eur(Math.round(num(l.quantity) * num(l.unitPrice) * 100));
          sum();
        };
      });
      host.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { state.splice(Number(b.dataset.rm), 1); if (!state.length) state.push({ description: '', quantity: 1, unitPrice: 0, vatRate: defaultVat }); draw(); });
      host.querySelector('[data-add="line"]').onclick = () => { state.push({ description: '', quantity: 1, unitPrice: 0, vatRate: defaultVat }); draw(); const ins = host.querySelectorAll('tbody tr:last-child input'); if (ins[0]) ins[0].focus(); };
      host.querySelector('[data-add="section"]').onclick = () => { state.push({ isSection: true, description: '' }); draw(); const ins = host.querySelectorAll('tbody tr:last-child input'); if (ins[0]) ins[0].focus(); };
    }
    function sum() {
      const t = totals();
      host.querySelector('[data-sum]').innerHTML = `<div><span>Total HT</span><span class="bl-num">${e(eur(t.ht))}</span></div><div><span>TVA</span><span class="bl-num">${e(eur(t.vat))}</span></div><div class="grand"><span>Total TTC</span><span class="bl-num">${e(eur(t.ttc))}</span></div>`;
    }
    draw();
    return {
      get: () => state.map(l => l.isSection
        ? { isSection: true, description: l.description }
        : { isSection: false, description: l.description, sageCode: l.sageCode, quantity: num(l.quantity), unitPrice: num(l.unitPrice), vatRate: Number(l.vatRate) }),
    };
  };

  // Fenêtre d'envoi par e-mail. kind : 'invoice' | 'reminder-N' | 'quote'.
  Bill.mailModal = async function ({ title, previewPath, sendPath, sendExtra = {}, onDone }) {
    let pv;
    try { pv = await Bill.get(previewPath); } catch (err) { return Bill.fail(err); }
    Bill.modal({
      title, wide: true,
      body: `${pv.smtp ? '' : '<div class="bl-alert warn">L\'envoi d\'e-mails n\'est pas encore configuré sur le serveur (SMTP). Vous pouvez préparer le message, mais il ne partira pas.</div>'}
        <div class="bl-field"><label for="ml-to">Destinataire</label><input id="ml-to" value="${e(pv.to)}" placeholder="adresse@hotel.fr">
          <div class="bl-hint">Plusieurs adresses possibles, séparées par une virgule. Le PDF est joint automatiquement.</div></div>
        <div class="bl-field"><label for="ml-sub">Objet</label><input id="ml-sub" value="${e(pv.subject)}"></div>
        <div class="bl-field"><label for="ml-body">Message</label><textarea id="ml-body">${e(pv.body)}</textarea></div>`,
      buttons: [
        { label: 'Annuler', onClick: async () => {} },
        { label: 'Envoyer', primary: true, onClick: async (m) => {
          const r = await Bill.post(sendPath, { ...sendExtra, to: m.$('#ml-to').value, subject: m.$('#ml-sub').value, body: m.$('#ml-body').value });
          Bill.toast('E-mail envoyé à ' + (r.to || []).join(', '));
          if (onDone) onDone(r);
        } },
      ],
    });
  };

  // Ouvre un PDF/fichier protégé par la session (nouvel onglet).
  Bill.openPdf = (path) => window.open(Bill.base + path, '_blank', 'noopener');

  // ---------- catalogue et tarifs : aides communes ----------

  const NF3 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  Bill.num3 = (n) => (n == null ? '—' : NF3.format(n));
  Bill.price = (n) => (n == null ? '—' : NF3.format(n) + ' €');
  // Écart en % de `to` par rapport à `from` (« −10 % », « +4,5 % »).
  Bill.pct = (from, to) => {
    if (!from || to == null) return '';
    const p = ((to - from) / from) * 100;
    if (Math.abs(p) < 0.05) return '0 %';
    return (p > 0 ? '+' : '−') + Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0).replace('.', ',') + ' %';
  };
  // Saisie décimale française tolérante (« 1,35 » ou « 1.35 »). NaN si illisible.
  Bill.parsePrice = (s) => { const t = String(s ?? '').replace(/\s/g, '').replace(',', '.'); return t === '' ? NaN : Number(t); };

  // Lit un fichier CSV choisi par l'utilisateur. Excel en français enregistre souvent en Windows-1252 :
  // on essaie l'UTF-8 strict, puis ce codage, pour que les accents ne se transforment pas en « � ».
  Bill.readText = async (file) => {
    if (!file) throw new Error('Choisissez d\'abord un fichier.');
    if (file.size > 2.5 * 1024 * 1024) throw new Error('Fichier trop volumineux (2,5 Mo maximum).');
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { return new TextDecoder('windows-1252').decode(buf); }
  };
  // Enregistre un texte CSV (avec BOM pour qu'Excel reconnaisse l'UTF-8).
  Bill.saveText = (filename, text) => {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  // Petit encadré de liste (erreurs, doublons…) pour les comptes rendus d'import.
  Bill.noticeList = (title, items, cls = 'warn') => (items && items.length
    ? `<div class="bl-alert ${cls}"><b>${e(title)}</b><ul>${items.slice(0, 40).map(i => `<li>${e(i)}</li>`).join('')}${items.length > 40 ? `<li>… et ${items.length - 40} autres</li>` : ''}</ul></div>` : '');

  // Opération en deux temps : on remplit le formulaire, on VOIT d'abord le résultat (aperçu exact, rien n'est écrit),
  // puis on applique après ressaisie du code de la Facturation.
  //   preview(m) → { html, canApply, confirm }     apply() → effectue l'opération
  Bill.previewThenConfirm = function ({ title, body, previewLabel = 'Voir l\'aperçu', applyLabel = 'Appliquer', scope, preview, apply, onOpen, wide = true }) {
    let stage = 'check'; let confirmText = '';
    const setLabel = (m, t) => { m.el.querySelector('.bl-foot .primary').textContent = t; };
    return Bill.modal({
      title, wide,
      body: `${body}<div id="pv-out" style="margin-top:14px"></div>`,
      buttons: [
        { label: 'Annuler', onClick: async () => {} },
        { label: previewLabel, primary: true, onClick: async (m) => {
          if (stage === 'check') {
            const r = await preview(m);
            m.$('#pv-out').innerHTML = r.html;
            if (r.canApply) { stage = 'apply'; confirmText = r.confirm || ''; setLabel(m, applyLabel); }
            return true;
          }
          m.close();
          Bill.sensitive({ title, scope: typeof scope === 'function' ? scope() : scope, text: confirmText, okLabel: applyLabel, onSubmit: apply });
          return true;
        } },
      ],
      onOpen: (m) => {
        // Toute modification du formulaire rend l'aperçu caduc : on repart de la vérification.
        const reset = (ev) => { if (ev.target.closest('#pv-out') || stage === 'check') return; stage = 'check'; setLabel(m, previewLabel); m.$('#pv-out').innerHTML = ''; };
        m.el.addEventListener('input', reset); m.el.addEventListener('change', reset);
        // Pour un choix fait DANS l'aperçu : rend l'aperçu caduc (invalidate) ou le relance tout de suite (recheck).
        m.invalidate = () => { stage = 'check'; setLabel(m, previewLabel); };
        m.recheck = () => { m.invalidate(); m.el.querySelector('.bl-foot .primary').click(); };
        if (onOpen) onOpen(m);
      },
    });
  };

  // Import d'un fichier CSV avec aperçu, puis application après ressaisie du code.
  Bill.csvImport = function ({ title, intro, template, path, scope, extraFields = '', extraBody = () => ({}), renderPreview, onDone, onOpen }) {
    let csv = ''; let extra = {};
    return Bill.previewThenConfirm({
      title, applyLabel: 'Importer', previewLabel: 'Vérifier le fichier', scope,
      body: `<p class="bl-note">${intro}</p>${extraFields}
        <div class="bl-field"><label for="ci-f">Fichier CSV</label><input id="ci-f" type="file" accept=".csv,text/csv,text/plain">
        ${template ? `<div class="bl-hint"><button type="button" class="bl-btn link small" id="ci-tpl">Télécharger un modèle de fichier</button> — s'ouvre dans Excel ; séparateur « , » ou « ; » accepté.</div>` : ''}</div>`,
      onOpen: (m) => { if (template) m.$('#ci-tpl').onclick = () => Bill.saveText(template.name, template.text); if (onOpen) onOpen(m); },
      preview: async (m) => {
        csv = await Bill.readText(m.$('#ci-f').files[0]);
        extra = extraBody(m);   // relevé à ce moment : la fenêtre est refermée au moment d'appliquer
        const r = await Bill.post(path, { csv, ...extra });
        return renderPreview(r);
      },
      apply: async () => { const r = await Bill.post(path, { csv, ...extra, apply: true }); if (onDone) onDone(r); },
    });
  };

  // Usage d'un article par un hôtel sur 12 mois, en une phrase courte.
  Bill.usageText = (pieces, lastOrderAt) => (pieces > 0
    ? `${Bill.plural(Math.round(pieces), 'pièce', 'pièces')} sur 12 mois · dernière commande le ${Bill.dFr(lastOrderAt)}`
    : lastOrderAt ? `Rien commandé depuis 12 mois (dernière commande le ${Bill.dFr(lastOrderAt)})` : 'Jamais commandé');

  // Encadré « BL non facturés recalculés » d'un aperçu (changement de tarif) : { orders, lines, deltaCents, skippedInDraft }.
  Bill.repricedAlert = (rp) => {
    if (!rp || (!rp.orders && !rp.skippedInDraft)) return '<div class="bl-alert ok">Aucun BL non facturé à recalculer : ils sont déjà à ce tarif.</div>';
    const draft = rp.skippedInDraft ? ` ${Bill.plural(rp.skippedInDraft, 'BL est déjà dans un brouillon de facture', 'BL sont déjà dans un brouillon de facture')} : laissé tel quel — supprimez le brouillon puis refaites-le pour qu'il prenne le nouveau tarif.` : '';
    return `<div class="bl-alert ${rp.orders ? 'ok' : 'warn'}">${rp.orders
      ? `<b>${Bill.plural(rp.orders, 'BL non facturé sera recalculé', 'BL non facturés seront recalculés')}</b> au nouveau tarif (${Bill.plural(rp.lines, 'ligne', 'lignes')}) — écart total ${Bill.eur(rp.deltaCents)} HT. Les BL déjà facturés ne changent jamais.`
      : 'Aucun BL non facturé à recalculer.'}${draft}</div>`;
  };
  Bill.repricedToast = (rp) => (rp && rp.orders ? ` · ${Bill.plural(rp.orders, 'BL non facturé recalculé', 'BL non facturés recalculés')}` : '');

  // Phrase décrivant une ligne du journal des prix.
  Bill.describePriceEvent = (ev) => {
    const d = ev.detail || {}; const who = d.client ? `${d.client} — ` : '';
    const via = d.via === 'import' ? ' (import)' : '';
    switch (ev.action) {
      case 'article_price_changed': return `Prix catalogue de « ${d.name} » : ${Bill.price(d.from)} → ${Bill.price(d.to)}${via}`;
      case 'article_created': return `Article créé : ${d.name} à ${Bill.price(d.price)}${via}`;
      case 'article_deleted': return `Article supprimé : ${d.name}${d.clientPricesRemoved ? ` (${d.clientPricesRemoved} tarif(s) négocié(s) retiré(s))` : ''}`;
      case 'client_price_set': return `${who}${d.article} : ${Bill.price(d.from)} → ${Bill.price(d.to)} à partir du ${Bill.dFr(d.effective)}${via}`;
      case 'client_price_removed': return `${who}${d.article} : retour au prix catalogue (${Bill.price(d.to)}) à partir du ${Bill.dFr(d.effective)}`;
      case 'client_prices_bulk': {
        const how = d.mode === 'percent' ? `${d.percent > 0 ? '+' : '−'}${Math.abs(d.percent)} %` : d.mode === 'copy' ? 'copie des tarifs d\'un autre hôtel' : 'retour au prix catalogue';
        return `${who}${Bill.plural(d.count, 'tarif modifié', 'tarifs modifiés')} (${how}) à partir du ${Bill.dFr(d.effective)}`;
      }
      case 'orders_repriced': return `${who}${Bill.plural(d.orders, 'BL recalculé', 'BL recalculés')} depuis le ${Bill.dFr(d.from)} (écart ${Bill.eur(d.deltaCents)})${d.via ? ' — automatique, suite à un changement de tarif' : ''}`;
      case 'client_catalog_set': return `${who}${d.restricted ? `catalogue limité à ${Bill.plural(d.count, 'article', 'articles')}` : 'catalogue complet'}`;
      case 'client_article_access': return `${who}${d.article} : ${d.access ? 'de nouveau proposé' : 'retiré du catalogue'}${d.restricted ? ` (catalogue limité à ${Bill.plural(d.count, 'article', 'articles')})` : ' (catalogue complet)'}`;
      default: return ev.action;
    }
  };
  Bill.priceLogHtml = (events, empty = 'Aucun changement enregistré pour le moment.') => (events.length
    ? `<ul class="bl-timeline">${events.map(ev => `<li><b>${e(Bill.describePriceEvent(ev))}</b><small>${Bill.dtFr(ev.at)}</small></li>`).join('')}</ul>`
    : `<p class="bl-muted">${e(empty)}</p>`);
})();
