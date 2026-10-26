// Hôtels : liste, fiche (coordonnées et facturation, tarifs, catalogue accessible, intégration).
// Tout est derrière le code de la Facturation : SIRET, tarifs négociés, jetons d'API et webhook ne se voient qu'ici.
(function () {
  const { e, dFr, plural } = Bill;
  const S = { q: '', filter: 'all' };
  let LIST = null;
  const CAT_LABELS = { lit: 'Linge de lit', toilette: 'Linge de toilette', service: 'Entretien et service' };
  const LEVELS = [['detail', 'Une ligne par article et par bon de livraison'], ['per_bl', 'Une ligne par bon de livraison'], ['aggregated', 'Une ligne par article sur toute la période']];
  const firstOfMonth = () => Bill.today().slice(0, 8) + '01';

  // ---------- liste ----------

  function visible() {
    const q = S.q.toLowerCase();
    return LIST.clients.filter(c => {
      if (S.filter === 'incomplete' && !c.issues.length) return false;
      if (S.filter === 'negotiated' && !c.negotiatedCount && !c.upcomingCount) return false;
      return !q || [c.societe, c.contact, c.ville, c.email].some(x => String(x || '').toLowerCase().includes(q));
    });
  }

  function paintTable(main) {
    const box = main.querySelector('#cl-table');
    if (!LIST.clients.length) { box.innerHTML = '<div class="bl-empty"><b>Aucun hôtel pour le moment</b>Ajoutez vos hôtels un par un, ou importez-les depuis un fichier Excel (CSV).</div>'; return; }
    const list = visible();
    if (!list.length) { box.innerHTML = '<div class="bl-empty"><b>Aucun résultat</b>Essayez un autre mot, ou changez de filtre.</div>'; return; }
    box.innerHTML = `<div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Hôtel</th><th>Facturation</th><th>Tarifs négociés</th><th>Catalogue</th><th>Dernière commande</th></tr></thead><tbody>
      ${list.map(c => `<tr class="bl-row" tabindex="0" data-id="${c.id}">
        <td class="client">${e(c.societe)}${c.clientType === 'particulier' ? ' <span class="bl-tag draft">Particulier</span>' : ''}<span class="sub">${e([c.contact, c.ville].filter(Boolean).join(' · ') || '—')}</span></td>
        <td>${c.issues.length ? c.issues.map(i => `<span class="bl-tag bad">${e(i)}</span>`).join(' ') : '<span class="bl-tag ok">Prêt à facturer</span>'}</td>
        <td>${c.negotiatedCount ? `<span class="bl-tag info">${c.negotiatedCount} / ${LIST.articleCount} articles</span>` : '<span class="bl-faint">Prix catalogue</span>'}${c.upcomingCount ? ` <span class="bl-tag">${c.upcomingCount} programmé(s)</span>` : ''}</td>
        <td>${c.assignedCount ? `${c.assignedCount} / ${LIST.articleCount} articles` : '<span class="bl-muted">Complet</span>'}</td>
        <td class="bl-num">${c.lastOrderAt ? dFr(c.lastOrderAt) : '<span class="bl-faint">—</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
    box.querySelectorAll('tr.bl-row').forEach(tr => {
      const open = () => openClient(Number(tr.dataset.id), {}, () => reload(main));
      tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    });
  }

  async function reload(main) {
    try { LIST = await Bill.get('/catalog/clients'); } catch (err) { return Bill.fail(err, main.querySelector('#cl-table')); }
    Bill.clients(true).catch(() => {});   // les sélecteurs d'hôtels des autres pages restent à jour
    paintTable(main);
    const incomplete = LIST.clients.filter(c => c.issues.length).length;
    main.querySelector('#cl-count').textContent = `${plural(LIST.clients.length, 'hôtel', 'hôtels')}${incomplete ? ` · ${incomplete} à compléter` : ''}`;
  }

  Bill.register('clients', {
    async render(main, params = {}) {
      main.innerHTML = `<div class="bl-head"><div><h2>Hôtels</h2><p>Coordonnées, informations de facturation, tarifs négociés et catalogue accessible de chaque hôtel.</p></div>
        <div class="bl-actions"><button class="bl-btn" id="cl-import">Importer un fichier</button><button class="bl-btn primary" id="cl-new">Nouveau client</button></div></div>
        <div class="bl-panel"><div class="bl-filters">
          <div class="bl-field grow"><label for="cl-q">Rechercher</label><input id="cl-q" type="search" value="${e(S.q)}" placeholder="Nom, contact, ville ou e-mail"></div>
          <div class="bl-field"><label for="cl-f">Afficher</label><select id="cl-f"><option value="all">Tous les hôtels</option><option value="incomplete">À compléter pour facturer</option><option value="negotiated">Avec des tarifs négociés</option></select></div>
          <div class="bl-muted" id="cl-count" style="padding-bottom:9px"></div></div>
        <div id="cl-table"><div class="bl-spin">Chargement…</div></div></div>`;
      await reload(main);
      main.querySelector('#cl-f').value = S.filter;
      let t; main.querySelector('#cl-q').oninput = (ev) => { clearTimeout(t); t = setTimeout(() => { S.q = ev.target.value.trim(); paintTable(main); }, 200); };
      main.querySelector('#cl-f').onchange = (ev) => { S.filter = ev.target.value; paintTable(main); };
      main.querySelector('#cl-new').onclick = () => newClient(main);
      main.querySelector('#cl-import').onclick = () => importClients(main);
      if (params.open) openClient(Number(params.open), { tab: params.tab }, () => reload(main));
    },
  });

  // ---------- création et import ----------

  function newClient(main) {
    Bill.modal({
      title: 'Nouveau client',
      body: `<p class="bl-note">Seul le nom est obligatoire ; le reste peut être complété ensuite dans la fiche.</p>
        <div class="bl-field"><label for="nc-ty">Type de client</label><select id="nc-ty"><option value="pro">Professionnel (hôtel, entreprise, collectivité…)</option><option value="particulier">Particulier (sans SIRET)</option></select></div>
        <div class="bl-row2"><div class="bl-field"><label for="nc-s">Nom du client</label><input id="nc-s" placeholder="Ex. Hôtel Verlaine"></div>
          <div class="bl-field"><label for="nc-c">Contact</label><input id="nc-c"></div></div>
        <div class="bl-row2"><div class="bl-field"><label for="nc-t">Téléphone</label><input id="nc-t" inputmode="tel"></div>
          <div class="bl-field"><label for="nc-m">E-mail</label><input id="nc-m" type="email" placeholder="contact@hotel.fr"></div></div>
        <div class="bl-field"><label for="nc-a">Adresse</label><input id="nc-a"></div>
        <div class="bl-row2"><div class="bl-field"><label for="nc-p">Code postal</label><input id="nc-p" inputmode="numeric"></div><div class="bl-field"><label for="nc-v">Ville</label><input id="nc-v"></div></div>
        <div class="bl-field"><label for="nc-k">Code d'accès à l'espace client (facultatif)</label><input id="nc-k" inputmode="numeric" maxlength="8" placeholder="4 à 8 chiffres"><div class="bl-hint">Sans code, l'hôtel n'a pas d'accès à son espace ; vous pourrez en définir un plus tard.</div></div>`,
      buttons: [{ label: 'Annuler', onClick: async () => {} }, { label: 'Créer le client', primary: true, onClick: async (m) => {
        const r = await Bill.post('/catalog/clients', { societe: m.$('#nc-s').value, contact: m.$('#nc-c').value, tel: m.$('#nc-t').value, email: m.$('#nc-m').value,
          adresse: m.$('#nc-a').value, codePostal: m.$('#nc-p').value, ville: m.$('#nc-v').value, code: m.$('#nc-k').value || undefined, clientType: m.$('#nc-ty').value });
        Bill.toast('Client créé'); await reload(main); openClient(r.client.id, {}, () => reload(main));
      } }],
    });
  }

  function importClients(main) {
    Bill.csvImport({
      title: 'Importer des hôtels', path: '/catalog/clients/import', scope: 'clients-import',
      intro: 'Colonnes obligatoires : <b>societe</b>, <b>contact</b>, <b>tel</b>, <b>adresse</b>, <b>email</b>. Facultatives : code_postal, ville, code (4 à 8 chiffres), type (<b>professionnel</b> ou <b>particulier</b> ; professionnel si la cellule est vide). Un hôtel dont l\'e-mail existe déjà est mis à jour ; son code d\'accès ne change que si la colonne « code » est remplie.',
      template: { name: 'modele-hotels.csv', text: 'societe,contact,tel,adresse,code_postal,ville,email,code\nHotel Exemple,Jean Dupont,0490000000,12 rue de la Paix,84200,Carpentras,contact@hotel-exemple.fr,\n' },
      renderPreview: (r) => {
        const s = r.summary;
        return {
          canApply: s.created + s.updated > 0,
          confirm: `${s.created} hôtel(s) créé(s), ${s.updated} mis à jour. Les codes d'accès générés vous seront affichés une seule fois.`,
          html: `<div class="bl-alert ${s.errors ? 'warn' : 'ok'}"><b>${plural(s.total, 'ligne lue', 'lignes lues')}</b> : ${s.created} à créer, ${s.updated} à mettre à jour${s.duplicates ? `, ${s.duplicates} doublon(s) ignoré(s)` : ''}${s.errors ? `, <b>${s.errors} en erreur</b> (non importées)` : ''}.</div>`
            + Bill.noticeList('Erreurs — ces lignes ne seront pas importées', r.errors.map(x => `Ligne ${x.line} : ${x.error}`), 'bad')
            + Bill.noticeList('Doublons probables — créés quand même, à vérifier', r.possibleDuplicates.map(x => `Ligne ${x.line} : ${x.error}`))
            + Bill.noticeList('Doublons dans le fichier — ignorés', r.duplicates.map(x => `Ligne ${x.line} : ${x.error}`)),
        };
      },
      onDone: async (r) => {
        Bill.toast(`Import terminé : ${r.summary.created} créé(s), ${r.summary.updated} mis à jour`);
        await reload(main);
        const withCodes = r.created.filter(c => c.code);
        if (withCodes.length) Bill.modal({
          title: 'Codes d\'accès générés',
          body: `<p class="bl-note">À transmettre à chaque hôtel. Ils ne sont enregistrés que sous forme chiffrée : cette fenêtre est la seule occasion de les relever.</p>
            <div class="bl-tablewrap"><table class="bl-table"><tbody>${withCodes.map(c => `<tr><td>${e(c.societe)}</td><td class="bl-mono">${e(c.code)}</td></tr>`).join('')}</tbody></table></div>`,
          buttons: [{ label: 'Copier la liste', onClick: async () => { try { await navigator.clipboard.writeText(withCodes.map(c => `${c.societe}\t${c.code}`).join('\n')); Bill.toast('Liste copiée'); } catch (_) { Bill.toast('Copie impossible : relevez les codes à la main', true); } return true; } }, { label: 'J\'ai noté les codes', primary: true, onClick: async () => {} }],
        });
      },
    });
  }

  // ---------- fiche ----------

  async function openClient(id, opts, onChange) {
    let changed = false; let C = null; let stats = null; let tokens = []; let G = null; let tab = opts.tab || 'info';
    const d = Bill.drawer({ onClose: () => { if (changed && onChange) onChange(); } });
    d.body.innerHTML = '<div class="bl-spin">Chargement…</div>';
    const TABS = [['info', 'Informations'], ['prices', 'Tarifs'], ['catalog', 'Catalogue accessible'], ['integration', 'Intégration']];

    async function loadClient() {
      const r = await Bill.get('/catalog/clients/' + id); C = r.client; stats = r.stats; tokens = r.tokens;
    }
    async function loadGrid() { G = await Bill.get(`/catalog/clients/${id}/prices`); }
    async function refresh() { await loadClient(); if (tab === 'prices' || tab === 'catalog') await loadGrid(); paint(); }

    function paint() {
      d.setHead({
        title: e(C.societe),
        sub: C.issues.length ? `<span class="bl-tag bad">À compléter pour facturer</span>` : '<span class="bl-tag ok">Prêt à facturer</span>',
        actions: '',
      });
      d.body.innerHTML = `<div class="bl-tabs" style="margin:-4px 0 16px">${TABS.map(([k, l]) => `<button class="bl-tab ${tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="cl-tab"></div>`;
      d.body.querySelectorAll('[data-tab]').forEach(b => b.onclick = async () => {
        tab = b.dataset.tab;
        try { if ((tab === 'prices' || tab === 'catalog') && !G) await loadGrid(); } catch (err) { return Bill.fail(err); }
        paint();
      });
      const box = d.body.querySelector('#cl-tab');
      ({ info: paintInfo, prices: paintPrices, catalog: paintCatalog, integration: paintIntegration })[tab](box);
    }

    // ----- informations -----
    function paintInfo(box) {
      const v = (k) => e(C[k] ?? '');
      box.innerHTML = `${C.issues.length
        ? `<div class="bl-alert warn"><b>À compléter avant de facturer cet hôtel</b><ul>${C.issues.map(i => `<li>${e(i)}</li>`).join('')}</ul></div>`
        : '<div class="bl-alert ok">Toutes les informations nécessaires à la facture sont renseignées.</div>'}
        <div class="bl-panel"><div class="bl-panel-h"><h3>Coordonnées</h3></div><div class="bl-panel-b">
          <div class="bl-row2"><div class="bl-field"><label for="i-s">Nom</label><input id="i-s" value="${v('societe')}"></div><div class="bl-field"><label for="i-c">Contact</label><input id="i-c" value="${v('contact')}"></div></div>
          <div class="bl-row2"><div class="bl-field"><label for="i-t">Téléphone</label><input id="i-t" inputmode="tel" value="${v('tel')}"></div><div class="bl-field"><label for="i-m">E-mail</label><input id="i-m" type="email" value="${v('email')}"><div class="bl-hint">Sert aussi à l'envoi des factures et à l'accès à l'espace client.</div></div></div>
          <div class="bl-field"><label for="i-a">Adresse</label><input id="i-a" value="${v('adresse')}"></div>
          <div class="bl-row2"><div class="bl-field"><label for="i-p">Code postal</label><input id="i-p" inputmode="numeric" value="${v('codePostal')}"><div class="bl-hint">Indispensable pour localiser l'hôtel dans les tournées.</div></div><div class="bl-field"><label for="i-v">Ville</label><input id="i-v" value="${v('ville')}"></div></div>
        </div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Facturation</h3></div><div class="bl-panel-b">
          <div class="bl-field"><label for="i-ty">Type de client</label><select id="i-ty"><option value="pro" ${C.clientType !== 'particulier' ? 'selected' : ''}>Professionnel</option><option value="particulier" ${C.clientType === 'particulier' ? 'selected' : ''}>Particulier</option></select><div class="bl-hint" id="i-ty-hint"></div></div>
          <div class="bl-row2" id="i-pro-ids"><div class="bl-field"><label for="i-siret">SIRET</label><input id="i-siret" inputmode="numeric" maxlength="17" value="${v('siret')}" placeholder="14 chiffres"><div class="bl-hint">Obligatoire sur les factures depuis le 1er septembre 2026.</div></div>
            <div class="bl-field"><label for="i-tva">N° de TVA intracommunautaire</label><input id="i-tva" value="${v('tvaNumber')}" placeholder="FR12345678901"></div></div>
          <div class="bl-field"><label for="i-af">Adresse de facturation</label><input id="i-af" value="${v('adresseFacturation')}" placeholder="Laisser vide pour utiliser l'adresse ci-dessus"></div>
          <div class="bl-field"><label for="i-lv">Détail des lignes sur la facture</label><select id="i-lv">${LEVELS.map(([k, l]) => `<option value="${k}" ${C.invoiceDetailLevel === k ? 'selected' : ''}>${e(l)}</option>`).join('')}</select></div>
          <div class="bl-field"><label for="i-esc">Escompte pour règlement anticipé</label><select id="i-esc">${[['', 'Selon le réglage général'], ['on', 'Toujours proposé à cet hôtel'], ['off', 'Jamais proposé à cet hôtel']].map(([k, l]) => `<option value="${k}" ${(C.escompte || '') === k ? 'selected' : ''}>${e(l)}</option>`).join('')}</select><div class="bl-hint">Taux et délai se règlent dans « Coordonnées de l'émetteur ». S'applique aux prochaines factures émises, pas à celles déjà émises.</div></div>
        </div></div>
        <div class="bl-actions" style="margin:16px 0 6px"><button class="bl-btn primary" id="i-save">Enregistrer les informations</button></div><div class="bl-err" id="i-err" role="alert"></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Activité</h3></div><div class="bl-panel-b"><p class="bl-note">${plural(stats.orders, 'commande', 'commandes')}${stats.lastOrderAt ? `, la dernière le ${dFr(stats.lastOrderAt)}` : ''} · ${plural(stats.invoices, 'facture émise', 'factures émises')}.</p>
          <div class="bl-actions"><button class="bl-btn" id="i-bls">Voir ses bons de livraison</button><button class="bl-btn" id="i-invs">Voir ses factures</button></div></div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Accès et suppression</h3></div><div class="bl-panel-b">
          <p class="bl-note">Le code d'accès actuel n'est jamais visible (il est chiffré). Définissez-en un nouveau si l'hôtel l'a oublié.</p>
          <div class="bl-actions"><button class="bl-btn" id="i-code">Définir un nouveau code d'accès…</button><button class="bl-btn danger" id="i-del">Supprimer cet hôtel…</button></div></div></div>`;

      // Un particulier n'a ni SIRET ni n° de TVA, et l'indemnité de recouvrement de 40 € (entre professionnels) ne figure pas sur ses documents.
      const syncType = () => {
        const part = box.querySelector('#i-ty').value === 'particulier';
        box.querySelector('#i-pro-ids').style.display = part ? 'none' : '';
        box.querySelector('#i-ty-hint').textContent = part ? 'Pas de SIRET ni de TVA sur ses factures, pas d\'indemnité de recouvrement de 40 €, escompte proposé seulement si vous le choisissez ci-dessous.' : '';
      };
      box.querySelector('#i-ty').onchange = syncType; syncType();
      box.querySelector('#i-save').onclick = async (ev) => {
        const btn = ev.currentTarget; const errEl = box.querySelector('#i-err'); errEl.textContent = ''; btn.disabled = true;
        const q = (s) => box.querySelector(s).value;
        try {
          await Bill.put('/catalog/clients/' + id, { societe: q('#i-s'), contact: q('#i-c'), tel: q('#i-t'), email: q('#i-m'), adresse: q('#i-a'), codePostal: q('#i-p'), ville: q('#i-v'),
            siret: q('#i-siret'), tvaNumber: q('#i-tva'), adresseFacturation: q('#i-af'), invoiceDetailLevel: q('#i-lv'), escompte: q('#i-esc'), clientType: q('#i-ty') });
          changed = true; Bill.toast('Informations enregistrées'); await refresh();
        } catch (err) { btn.disabled = false; Bill.fail(err, errEl); }
      };
      box.querySelector('#i-bls').onclick = () => { Bill.closeDrawer(); Bill.go('deliveries', { clientId: id }); };
      box.querySelector('#i-invs').onclick = () => { Bill.closeDrawer(); Bill.go('invoices', { clientId: id }); };
      box.querySelector('#i-code').onclick = () => Bill.sensitive({
        title: 'Nouveau code d\'accès de l\'hôtel', scope: `client-code:${id}`, okLabel: 'Enregistrer le code',
        text: `Ce code ouvre l'espace client de « ${C.societe} » (suivi de commandes). L'ancien code cesse de fonctionner immédiatement.`,
        body: '<div class="bl-field"><label for="nk-c">Nouveau code (4 à 8 chiffres)</label><input id="nk-c" inputmode="numeric" maxlength="8" autocomplete="off"></div>',
        onSubmit: async (m) => { await Bill.put(`/catalog/clients/${id}/access-code`, { code: m.$('#nk-c').value }); Bill.toast('Code d\'accès enregistré'); },
      });
      box.querySelector('#i-del').onclick = () => Bill.sensitive({
        title: `Supprimer « ${C.societe} »`, scope: `client-delete:${id}`, okLabel: 'Supprimer l\'hôtel', danger: true,
        text: 'Ses commandes passées sont conservées. Un hôtel qui a des factures, des avoirs ou des devis ne peut pas être supprimé (obligation de conservation).',
        onSubmit: async () => { await Bill.del('/catalog/clients/' + id); changed = true; Bill.closeDrawer(); Bill.toast('Hôtel supprimé'); },
      });
    }

    // ----- tarifs -----
    function paintPrices(box) {
      const nego = G.articles.filter(a => a.negotiatedPrice != null || a.upcoming).length;
      box.innerHTML = `<p class="bl-note">${nego ? `${plural(nego, 'article a', 'articles ont')} un tarif négocié ou programmé.` : 'Cet hôtel paie le prix catalogue pour tous les articles.'} Pour ajuster un tarif, cliquez sur « Modifier ».</p>
        <div class="bl-actions" style="margin-bottom:14px">
          <button class="bl-btn" data-bulk="percent">Appliquer un pourcentage…</button><button class="bl-btn" data-bulk="copy">Copier d'un autre hôtel…</button>
          <button class="bl-btn" data-bulk="reset" ${nego ? '' : 'disabled'}>Tout remettre au catalogue…</button><button class="bl-btn" id="p-reprice">Réappliquer aux BL non facturés…</button></div>
        <div class="bl-tablewrap"><table class="bl-table bl-prices"><thead><tr><th>Article</th><th class="r">Catalogue</th><th class="r">Tarif de l'hôtel</th><th>Depuis</th><th></th></tr></thead><tbody>
          ${G.articles.map(a => `<tr class="${a.negotiatedPrice != null ? 'neg' : ''} ${a.attributed ? '' : 'off'}">
            <td class="client">${e(a.name)}<span class="sub">${e(a.sageCode)}${a.attributed ? '' : ' · non proposé à cet hôtel'}</span></td>
            <td class="r bl-num">${Bill.num3(a.catalogPrice)}</td>
            <td class="r bl-num"><b>${Bill.num3(a.price)}</b>${a.negotiatedPrice != null ? `<span class="sub">${Bill.pct(a.catalogPrice, a.price)}</span>` : ''}${a.upcoming ? `<span class="sub">puis ${Bill.num3(a.upcoming.price)} dès le ${dFr(a.upcoming.from)}</span>` : ''}</td>
            <td class="bl-num">${a.negotiatedSince ? dFr(a.negotiatedSince) : '<span class="bl-faint">—</span>'}</td>
            <td class="r"><button class="bl-btn small" data-edit="${e(a.id)}">Modifier</button></td></tr>`).join('')}</tbody></table></div>
        <details class="bl-panel bl-details" style="margin-top:16px" id="p-log"><summary>Historique des changements de cet hôtel</summary><div class="bl-panel-b" id="p-log-body"><div class="bl-spin">Chargement…</div></div></details>`;
      box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
        const a = G.articles.find(x => x.id === b.dataset.edit);
        Bill.editClientPrice({ clientId: id, clientName: C.societe, articleId: a.id, articleName: a.name, catalogPrice: a.catalogPrice, price: a.price,
          negotiatedPrice: a.negotiatedPrice, negotiatedSince: a.negotiatedSince, upcoming: a.upcoming }, async () => { changed = true; await loadClient(); await loadGrid(); paint(); });
      });
      box.querySelectorAll('[data-bulk]').forEach(b => b.onclick = () => bulk(b.dataset.bulk));
      box.querySelector('#p-reprice').onclick = reprice;
      box.querySelector('#p-log').addEventListener('toggle', async (ev) => {
        if (!ev.target.open) return; const body = box.querySelector('#p-log-body');
        try { body.innerHTML = Bill.priceLogHtml((await Bill.get('/catalog/prices/log?clientId=' + id)).events, 'Aucun changement enregistré pour cet hôtel.'); } catch (err) { Bill.fail(err, body); }
      });
    }

    const afterWrite = async () => { changed = true; await loadClient(); await loadGrid(); paint(); };

    async function bulk(mode) {
      const others = (await Bill.clients()).filter(c => c.id !== id);
      const TITLES = { percent: 'Appliquer un pourcentage', copy: 'Copier les tarifs d\'un autre hôtel', reset: 'Tout remettre au prix catalogue' };
      const fields = {
        percent: `<p class="bl-note">Augmente ou baisse les prix de cet hôtel d'un même pourcentage. Saisissez par exemple <b>−5</b> pour une remise de 5 %, ou <b>+3</b> pour une hausse de 3 %.</p>
          <div class="bl-row3"><div class="bl-field"><label for="b-pct">Pourcentage</label><input id="b-pct" inputmode="decimal" placeholder="−5"></div>
            <div class="bl-field"><label for="b-base">Calculé sur</label><select id="b-base"><option value="applicable">Le prix actuel de l'hôtel</option><option value="catalogue">Le prix catalogue</option></select></div>
            <div class="bl-field"><label for="b-from">À partir du</label><input id="b-from" type="date" value="${Bill.today()}"></div></div>
          <details class="bl-details"><summary>Limiter à certains articles <span class="bl-muted">— par défaut, tous</span></summary><div class="bl-checklist">
            ${G.articles.filter(a => a.attributed).map(a => `<label class="bl-check"><input type="checkbox" class="b-art" value="${e(a.id)}"><span>${e(a.name)}</span></label>`).join('')}</div></details>`,
        copy: `<p class="bl-note">Reprend les tarifs négociés en cours d'un autre hôtel (utile pour un second établissement du même groupe). Les autres tarifs de cet hôtel ne changent pas.</p>
          <div class="bl-row2"><div class="bl-field"><label for="b-src">Copier depuis</label><select id="b-src">${Bill.clientOptions(others)}</select></div>
            <div class="bl-field"><label for="b-from">À partir du</label><input id="b-from" type="date" value="${Bill.today()}"></div></div>`,
        reset: `<p class="bl-note">Retire tous les tarifs négociés de cet hôtel : il retombe au prix catalogue à la date choisie. L'historique reste consultable.</p>
          <div class="bl-field" style="max-width:240px"><label for="b-from">À partir du</label><input id="b-from" type="date" value="${Bill.today()}"></div>`,
      }[mode];
      let payload = null;
      Bill.previewThenConfirm({
        title: TITLES[mode], body: fields, applyLabel: 'Appliquer', scope: () => `prices-bulk:${id}`,
        preview: async (m) => {
          payload = { mode, from: m.$('#b-from').value };
          if (mode === 'percent') {
            const p = Bill.parsePrice(m.$('#b-pct').value.replace('−', '-'));
            if (!Number.isFinite(p) || p === 0) throw new Error('Saisissez un pourcentage, par exemple −5 ou +3.');
            payload.percent = p; payload.base = m.$('#b-base').value;
            const ids = [...m.el.querySelectorAll('.b-art:checked')].map(x => x.value); if (ids.length) payload.articleIds = ids;
          }
          if (mode === 'copy') { payload.sourceClientId = Number(m.$('#b-src').value); if (!payload.sourceClientId) throw new Error('Choisissez l\'hôtel à copier.'); }
          const r = await Bill.post(`/catalog/clients/${id}/prices/bulk`, payload);
          return {
            canApply: r.count > 0,
            confirm: `${plural(r.count, 'tarif sera modifié', 'tarifs seront modifiés')} pour « ${C.societe} » à partir du ${dFr(r.effective)}${r.repriced && r.repriced.orders ? `, et ${plural(r.repriced.orders, 'BL non facturé sera recalculé', 'BL non facturés seront recalculés')} (écart ${Bill.eur(r.repriced.deltaCents)} HT)` : ''}. Les BL déjà facturés ne changent pas.`,
            html: r.count
              ? `<div class="bl-alert ok"><b>${plural(r.count, 'tarif sera modifié', 'tarifs seront modifiés')}</b> à partir du ${dFr(r.effective)}.</div>${Bill.repricedAlert(r.repriced)}
                 <div class="bl-tablewrap" style="max-height:260px;overflow:auto"><table class="bl-table"><thead><tr><th>Article</th><th class="r">Avant</th><th class="r">Après</th><th class="r">Écart</th></tr></thead><tbody>
                 ${r.changes.map(c => `<tr><td>${e(c.article)}</td><td class="r bl-num">${Bill.num3(c.from)}</td><td class="r bl-num"><b>${Bill.num3(c.to)}</b></td><td class="r bl-num">${Bill.pct(c.from, c.to)}</td></tr>`).join('')}</tbody></table></div>`
              : '<div class="bl-alert warn">Rien à modifier avec ces réglages : les prix sont déjà ceux-là.</div>',
          };
        },
        apply: async () => { const r = await Bill.post(`/catalog/clients/${id}/prices/bulk`, { ...payload, apply: true }); Bill.toast(`${plural(r.count, 'tarif modifié', 'tarifs modifiés')}${Bill.repricedToast(r.repriced)}`); await afterWrite(); },
        // « Utiliser le jj/mm » dans l'aperçu : reprend la date du plus ancien BL non facturé et relance l'aperçu.
        onOpen: (m) => m.el.addEventListener('click', (ev) => {
          const b = ev.target.closest && ev.target.closest('[data-older]');
          if (b && m.$('#b-from')) { m.$('#b-from').value = b.dataset.older; m.recheck(); }
        }),
      });
    }

    function reprice() {
      let payload = null;
      Bill.previewThenConfirm({
        title: 'Réappliquer les tarifs aux BL non facturés', applyLabel: 'Recalculer les BL', scope: () => `reprice:${id}`,
        body: `<p class="bl-note">Les changements de tarif recalculent déjà automatiquement les BL non facturés à partir de leur date d'effet ; cette action sert pour un recalcul à une autre date, ou après un changement de prix catalogue. Recalcule, au tarif en vigueur à leur date, les BL de « ${e(C.societe)} » (livrés ou en cours) qui ne figurent dans aucune facture ni aucun brouillon. Les BL déjà facturés ne sont jamais modifiés.</p>
          <div class="bl-field" style="max-width:300px"><label for="rp-from">BL datés à partir du</label><input id="rp-from" type="date" value="${firstOfMonth()}"><div class="bl-hint" id="rp-old"></div></div>`,
        onOpen: (m) => Bill.get(`/catalog/clients/${id}/unbilled`).then((u) => {
          if (!u || !u.orders || !u.oldest || !m.$('#rp-old')) return;
          m.$('#rp-old').innerHTML = `${plural(u.orders, 'BL non facturé', 'BL non facturés')}, le plus ancien du ${dFr(u.oldest)} : <button type="button" class="bl-btn link small" id="rp-oldest">partir de cette date</button>`;
          m.$('#rp-oldest').onclick = () => { m.$('#rp-from').value = u.oldest; m.invalidate && m.invalidate(); m.$('#pv-out').innerHTML = ''; };
        }).catch(() => {}),
        preview: async (m) => {
          payload = { from: m.$('#rp-from').value };
          const r = await Bill.post(`/catalog/clients/${id}/reprice`, payload);
          const lines = r.orders.reduce((s, o) => s + o.lines.length, 0);
          const draft = r.skippedInDraft ? `<div class="bl-alert warn">${plural(r.skippedInDraft, 'BL est déjà dans un brouillon de facture', 'BL sont déjà dans un brouillon de facture')} : il n'est pas modifié. Supprimez le brouillon puis refaites-le pour qu'il prenne le bon tarif.</div>` : '';
          if (!r.orders.length) return { canApply: false, html: `<div class="bl-alert ok">Tous les BL non facturés de cet hôtel sont déjà au bon tarif.</div>${draft}` };
          return {
            canApply: true,
            confirm: `${plural(r.orders.length, 'BL', 'BL')} (${plural(lines, 'ligne', 'lignes')}) seront recalculés, pour un écart total de ${Bill.eur(r.deltaCents)} HT.`,
            html: `<div class="bl-alert ok"><b>${plural(r.orders.length, 'BL sera recalculé', 'BL seront recalculés')}</b> — écart total ${Bill.eur(r.deltaCents)} HT.</div>${draft}
              <div class="bl-tablewrap" style="max-height:260px;overflow:auto"><table class="bl-table"><thead><tr><th>BL</th><th>Date</th><th>Lignes modifiées</th><th class="r">Écart HT</th></tr></thead><tbody>
              ${r.orders.map(o => `<tr><td class="bl-num">${e(o.ticket)}</td><td class="bl-num">${dFr(o.date)}</td><td>${o.lines.map(l => `${e(l.name)} ${Bill.num3(l.from)} → <b>${Bill.num3(l.to)}</b> × ${l.qty}`).join('<br>')}</td><td class="r bl-num">${Bill.eur(o.deltaCents)}</td></tr>`).join('')}</tbody></table></div>`,
          };
        },
        apply: async () => { const r = await Bill.post(`/catalog/clients/${id}/reprice`, { ...payload, apply: true }); Bill.toast(`${plural(r.orders.length, 'BL recalculé', 'BL recalculés')}`); changed = true; },
      });
    }

    // ----- catalogue accessible -----
    function paintCatalog(box) {
      const groups = {};
      for (const a of G.articles) (groups[a.category] ||= []).push(a);
      // Sans sélection existante, passer en « sélection » part de tout le catalogue coché : on décoche ce qui ne sert pas.
      const checked = (a) => (G.hasRestriction ? a.attributed : true);
      box.innerHTML = `<div class="bl-panel"><div class="bl-panel-b">
        <p class="bl-note">Détermine les articles que l'hôtel peut commander (espace client, commandes saisies, import par API).</p>
        <label class="bl-check"><input type="radio" name="cm" value="all" ${G.hasRestriction ? '' : 'checked'}><span><b>Tout le catalogue</b><br><span class="bl-muted">Y compris les articles que vous ajouterez plus tard.</span></span></label>
        <label class="bl-check" style="margin-top:12px"><input type="radio" name="cm" value="some" ${G.hasRestriction ? 'checked' : ''}><span><b>Seulement une sélection</b><br><span class="bl-muted">Les nouveaux articles ne lui sont pas proposés tant que vous ne les cochez pas.</span></span></label>
        <div id="cm-tools" ${G.hasRestriction ? '' : 'hidden'}>
          <div class="bl-actions" style="justify-content:flex-start;margin-top:12px">
            <button class="bl-btn small" type="button" id="cm-all">Tout cocher</button>
            <button class="bl-btn small" type="button" id="cm-none">Tout décocher</button>
            <button class="bl-btn small" type="button" id="cm-unused">Décocher les articles jamais commandés (12 mois)</button>
            <span class="bl-muted" id="cm-count"></span></div>
          <div class="bl-field" style="margin-top:8px"><label for="cm-q">Chercher un article</label><input id="cm-q" type="search" placeholder="Nom ou code Sage"></div></div>
        <div id="cm-list" class="bl-checklist" ${G.hasRestriction ? '' : 'hidden'}>
          ${Object.entries(groups).map(([k, list]) => `<div class="bl-checkgroup" data-group="${e(k)}">${e(CAT_LABELS[k] || k)}</div>${list.map(a => `<label class="bl-check" data-cat="${e(k)}" data-name="${e((a.name + ' ' + a.sageCode).toLowerCase())}"><input type="checkbox" value="${e(a.id)}" ${checked(a) ? 'checked' : ''}><span>${e(a.name)} <span class="bl-muted">${e(a.sageCode)}</span><br><span class="bl-muted">${e(Bill.usageText(a.pieces12m, a.lastOrderAt))}</span></span></label>`).join('')}`).join('')}</div>
      </div></div><div class="bl-actions"><button class="bl-btn primary" id="cm-save">Enregistrer</button></div><div class="bl-err" id="cm-err" role="alert"></div>`;
      const list = box.querySelector('#cm-list'); const tools = box.querySelector('#cm-tools');
      const boxes = () => [...list.querySelectorAll('input[type=checkbox]')];
      const sync = () => { box.querySelector('#cm-count').textContent = `${boxes().filter(i => i.checked).length} / ${G.articles.length} articles`; };
      list.addEventListener('change', sync); sync();
      box.querySelectorAll('[name=cm]').forEach(r => r.onchange = () => { const all = box.querySelector('[name=cm]:checked').value === 'all'; list.hidden = all; tools.hidden = all; });
      const visibleBoxes = () => boxes().filter(i => !i.closest('.bl-check').hidden);
      box.querySelector('#cm-all').onclick = () => { visibleBoxes().forEach(i => { i.checked = true; }); sync(); };
      box.querySelector('#cm-none').onclick = () => { visibleBoxes().forEach(i => { i.checked = false; }); sync(); };
      box.querySelector('#cm-unused').onclick = () => {
        const idle = new Set(G.articles.filter(a => !a.pieces12m && !a.lastOrderAt).map(a => a.id));
        boxes().forEach(i => { if (idle.has(i.value)) i.checked = false; }); sync();
      };
      box.querySelector('#cm-q').oninput = (ev) => {
        const q = ev.target.value.trim().toLowerCase();
        list.querySelectorAll('.bl-check').forEach(l => { l.hidden = !!q && !l.dataset.name.includes(q); });
        list.querySelectorAll('.bl-checkgroup').forEach(g => { g.hidden = !!q && ![...list.querySelectorAll('.bl-check')].some(l => l.dataset.cat === g.dataset.group && !l.hidden); });
      };
      box.querySelector('#cm-save').onclick = async (ev) => {
        const btn = ev.currentTarget; const errEl = box.querySelector('#cm-err'); errEl.textContent = '';
        const some = box.querySelector('[name=cm]:checked').value === 'some';
        const ids = some ? boxes().filter(i => i.checked).map(i => i.value) : [];
        if (some && !ids.length) { errEl.textContent = 'Cochez au moins un article, ou choisissez « Tout le catalogue ».'; return; }
        if (some) {
          const dropped = G.articles.filter(x => checked(x) && !ids.includes(x.id) && x.pieces12m > 0);
          if (dropped.length && !await Bill.confirm('Retirer des articles récemment commandés ?', `${plural(dropped.length, 'article retiré a', 'articles retirés ont')} été commandé(s) ces 12 derniers mois par cet hôtel :\n${dropped.slice(0, 8).map(x => '• ' + x.name).join('\n')}${dropped.length > 8 ? '\n…' : ''}`, 'Enregistrer quand même')) return;
        }
        btn.disabled = true;
        try { await Bill.put(`/catalog/clients/${id}/assignment`, { articleIds: ids }); changed = true; Bill.toast('Catalogue enregistré'); await loadClient(); await loadGrid(); paint(); }
        catch (err) { btn.disabled = false; Bill.fail(err, errEl); }
      };
    }

    // ----- intégration -----
    function paintIntegration(box) {
      box.innerHTML = `<div class="bl-panel"><div class="bl-panel-h"><h3>Jetons d'API</h3></div><div class="bl-panel-b">
          <p class="bl-note">Permettent au logiciel de commande de cet hôtel de créer ses commandes automatiquement. Un jeton donne accès aux commandes de cet hôtel : ne le transmettez qu'à lui.</p>
          ${tokens.length ? tokens.map(t => `<div class="bl-token"><div><b>${e(t.label || '(sans libellé)')}</b><div class="bl-mono bl-tokenval">${e(t.token)}</div>
            <small class="bl-muted">Créé le ${dFr(t.createdAt)}${t.lastUsedAt ? ` · dernier appel le ${dFr(t.lastUsedAt)}` : ' · jamais utilisé'}</small></div>
            <div class="bl-actions"><button class="bl-btn small" data-copy="${e(t.token)}">Copier</button><button class="bl-btn small danger" data-revoke="${t.id}">Révoquer</button></div></div>`).join('') : '<p class="bl-muted">Aucun jeton pour le moment.</p>'}
          <div class="bl-row2" style="margin-top:12px;align-items:end"><div class="bl-field" style="margin:0"><label for="t-l">Libellé (facultatif)</label><input id="t-l" placeholder="Ex. Logiciel de commande interne"></div><div><button class="bl-btn" id="t-new">Générer un jeton</button></div></div>
        </div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Notification de livraison (webhook)</h3></div><div class="bl-panel-b">
          <p class="bl-note">Adresse du logiciel de l'hôtel, prévenue automatiquement des quantités définitives dès qu'une de ses commandes passe à « Livrée ».</p>
          <div class="bl-field"><label for="w-u">Adresse (URL)</label><input id="w-u" value="${e(C.webhookUrl || '')}" placeholder="https://logiciel-client.exemple.com/webhook"></div>
          <div class="bl-actions"><button class="bl-btn" id="w-save">Enregistrer</button></div>
          ${C.webhookSecret ? `<p class="bl-hint" style="margin-top:12px">Secret envoyé dans l'en-tête <span class="bl-code">X-Cezanne-Webhook-Secret</span> pour que l'hôtel vérifie l'origine des appels :</p>
            <div class="bl-mono bl-tokenval">${e(C.webhookSecret)}</div><div class="bl-actions" style="margin-top:8px"><button class="bl-btn small" data-copy="${e(C.webhookSecret)}">Copier</button><button class="bl-btn small danger" id="w-regen">Régénérer le secret…</button></div>` : ''}
        </div></div><div class="bl-err" id="in-err" role="alert"></div>`;
      const errEl = box.querySelector('#in-err');
      const run = async (fn, ok) => { errEl.textContent = ''; try { await fn(); if (ok) Bill.toast(ok); await loadClient(); paint(); } catch (err) { Bill.fail(err, errEl); } };
      box.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); Bill.toast('Copié'); } catch (_) { Bill.toast('Copie impossible : sélectionnez le texte à la main', true); } });
      box.querySelector('#t-new').onclick = () => run(() => Bill.post(`/catalog/clients/${id}/tokens`, { label: box.querySelector('#t-l').value }), 'Jeton généré');
      box.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
        if (await Bill.confirm('Révoquer ce jeton ?', 'Toute intégration qui l\'utilise cessera immédiatement de fonctionner.', 'Révoquer', true)) run(() => Bill.del(`/catalog/clients/${id}/tokens/${b.dataset.revoke}`), 'Jeton révoqué');
      });
      box.querySelector('#w-save').onclick = () => run(() => Bill.put(`/catalog/clients/${id}/webhook`, { webhookUrl: box.querySelector('#w-u').value }), 'Webhook enregistré');
      const regen = box.querySelector('#w-regen');
      if (regen) regen.onclick = () => Bill.sensitive({
        title: 'Régénérer le secret du webhook', scope: `client-webhook:${id}`, okLabel: 'Régénérer', danger: true,
        text: 'L\'ancien secret cesse de fonctionner immédiatement : transmettez le nouveau à l\'hôtel aussitôt après.',
        onSubmit: async () => { await Bill.put(`/catalog/clients/${id}/webhook`, { webhookUrl: C.webhookUrl || '', regenerateSecret: true }); Bill.toast('Nouveau secret généré'); await loadClient(); paint(); },
      });
    }

    try {
      await loadClient();
      if (tab === 'prices' || tab === 'catalog') await loadGrid();
    } catch (err) { Bill.closeDrawer(); return Bill.fail(err); }
    paint();
  }
})();
