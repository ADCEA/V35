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
})();
