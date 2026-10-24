// Tarifs par hôtel : grille articles × hôtels, modification d'un tarif, import, journal.
(function () {
  const { e, dFr, plural } = Bill;
  const S = { q: '', cat: '', mode: 'price' };
  let M = null;
  let CATS = [];

  const firstOfNextMonth = () => {
    const t = new Date(Bill.today() + 'T00:00:00Z');
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  };
  const firstOfMonth = () => Bill.today().slice(0, 8) + '01';

  // ---------- modification d'un tarif (utilisée aussi par la fiche d'un hôtel) ----------
  // info : { clientId, clientName, articleId, articleName, catalogPrice, price, negotiatedPrice, negotiatedSince, upcoming }
  Bill.editClientPrice = function (info, onDone) {
    const nego = info.negotiatedPrice != null;
    Bill.modal({
      title: `${info.articleName}`,
      body: `<p class="bl-note"><b>${e(info.clientName)}</b><br>Prix catalogue : ${Bill.price(info.catalogPrice)}.
          ${nego ? `Tarif négocié en cours : <b>${Bill.price(info.negotiatedPrice)}</b> depuis le ${dFr(info.negotiatedSince)}.` : 'Cet hôtel paie le prix catalogue.'}
          ${info.upcoming ? `<br>Déjà programmé : ${Bill.price(info.upcoming.price)} à partir du ${dFr(info.upcoming.from)} (il sera remplacé si vous enregistrez une date antérieure ou égale).` : ''}</p>
        <div class="bl-row2">
          <div class="bl-field"><label for="ep-price">Nouveau prix HT (€)</label><input id="ep-price" inputmode="decimal" value="${e(String(nego ? info.negotiatedPrice : info.catalogPrice).replace('.', ','))}"><div class="bl-hint" id="ep-delta"></div></div>
          <div class="bl-field"><label for="ep-date">À partir du</label><input id="ep-date" type="date" value="${Bill.today()}">
            <div class="bl-hint"><button type="button" class="bl-btn link small" data-d="today">Aujourd'hui</button> · <button type="button" class="bl-btn link small" data-d="som">1er du mois</button> · <button type="button" class="bl-btn link small" data-d="nom">1er du mois prochain</button></div></div>
        </div>
        <p class="bl-hint">Les commandes déjà passées gardent le prix auquel elles ont été saisies. Pour corriger celles qui ne sont pas encore facturées, utilisez « Réappliquer aux BL non facturés » dans la fiche de l'hôtel.</p>`,
      buttons: [
        { label: 'Annuler', onClick: async () => {} },
        ...(nego || info.upcoming ? [{ label: 'Revenir au prix catalogue', danger: true, onClick: async (m) => {
          const from = m.$('#ep-date').value || Bill.today();
          await Bill.del(`/catalog/clients/${info.clientId}/prices/${encodeURIComponent(info.articleId)}?from=${from}`);
          Bill.toast('Prix catalogue rétabli'); if (onDone) onDone();
        } }] : []),
        { label: 'Enregistrer', primary: true, onClick: async (m) => {
          const price = m.$('#ep-price').value;
          if (!Number.isFinite(Bill.parsePrice(price))) throw new Error('Saisissez un prix, par exemple 1,35.');
          const r = await Bill.put(`/catalog/clients/${info.clientId}/prices/${encodeURIComponent(info.articleId)}`, { price, dateDebut: m.$('#ep-date').value || undefined });
          Bill.toast(r.changed ? `Tarif enregistré — à partir du ${dFr(r.effective)}` : 'Ce tarif est déjà en vigueur'); if (onDone) onDone();
        } },
      ],
      onOpen: (m) => {
        const upd = () => {
          const n = Bill.parsePrice(m.$('#ep-price').value);
          m.$('#ep-delta').textContent = Number.isFinite(n) ? (n === info.catalogPrice ? 'Identique au prix catalogue.' : `${Bill.pct(info.catalogPrice, n)} par rapport au catalogue`) : '';
        };
        m.$('#ep-price').addEventListener('input', upd); upd();
        m.el.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { m.$('#ep-date').value = b.dataset.d === 'today' ? Bill.today() : b.dataset.d === 'som' ? firstOfMonth() : firstOfNextMonth(); });
      },
    });
  };

  // ---------- grille ----------

  function cellHtml(c, a) {
    if (c.restricted && !c.articleIds.includes(a.id)) return '<td class="x" title="Cet article n\'est pas proposé à cet hôtel"><span aria-label="Non proposé">—</span></td>';
    const x = (M.cells[c.id] || {})[a.id];
    const nego = !!(x && x.price != null);
    const price = nego ? x.price : a.price;
    const tip = `${c.societe} — ${a.name} : ${Bill.price(price)}${nego ? ` (catalogue ${Bill.price(a.price)})` : ' (prix catalogue)'}${x && x.upcoming ? ` · ${Bill.price(x.upcoming.price)} à partir du ${dFr(x.upcoming.from)}` : ''}`;
    const main = S.mode === 'delta' ? (nego ? Bill.pct(a.price, price) : '—') : Bill.num3(price);
    const sub = S.mode === 'price' && nego ? `<small>${Bill.pct(a.price, price)}</small>` : '';
    return `<td class="${nego ? 'neg' : ''}"><button type="button" class="bl-cell" data-c="${c.id}" data-a="${e(a.id)}" title="${e(tip)}">${x && x.upcoming ? '<i class="up" aria-label="Changement programmé"></i>' : ''}<span>${main}</span>${sub}</button></td>`;
  }

  function matrixHtml() {
    const q = S.q.toLowerCase();
    const arts = M.articles.filter(a => (!S.cat || a.category === S.cat) && (!q || [a.name, a.code, a.sageCode].some(x => String(x).toLowerCase().includes(q))));
    if (!arts.length) return '<div class="bl-empty"><b>Aucun article</b>Aucun article ne correspond à ce filtre.</div>';
    const span = M.clients.length + 2;
    let html = `<div class="bl-matrixwrap"><table class="bl-matrix"><thead><tr><th class="art" scope="col">Article</th><th class="cat" scope="col">Catalogue</th>
      ${M.clients.map(c => `<th class="cl" scope="col"><button type="button" data-client="${c.id}" title="Ouvrir la fiche de ${e(c.societe)}">${e(c.societe)}</button></th>`).join('')}</tr></thead><tbody>`;
    let cat = null;
    for (const a of arts) {
      if (a.category !== cat) { cat = a.category; html += `<tr class="grp"><th colspan="${span}" scope="colgroup">${e((CATS.find(c => c.id === cat) || {}).label || cat)}</th></tr>`; }
      html += `<tr><th class="art" scope="row"><button type="button" class="bl-linkbtn" data-article="${e(a.id)}">${e(a.name)}</button><small>${e(a.sageCode)}</small></th><td class="cat bl-num">${Bill.num3(a.price)}</td>${M.clients.map(c => cellHtml(c, a)).join('')}</tr>`;
    }
    return html + '</tbody></table></div>';
  }

  function paintMatrix(main) {
    const box = main.querySelector('#pr-matrix');
    if (!M.articles.length) { box.innerHTML = '<div class="bl-empty"><b>Aucun article</b>Créez d\'abord votre catalogue dans « Articles ».</div>'; return; }
    if (!M.clients.length) { box.innerHTML = '<div class="bl-empty"><b>Aucun hôtel</b>Ajoutez vos hôtels dans « Hôtels » pour leur donner des tarifs.</div>'; return; }
    box.innerHTML = matrixHtml();
    box.querySelectorAll('.bl-cell').forEach(b => b.onclick = () => {
      const c = M.clients.find(x => x.id === Number(b.dataset.c)); const a = M.articles.find(x => x.id === b.dataset.a);
      const x = (M.cells[c.id] || {})[a.id] || {};
      Bill.editClientPrice({ clientId: c.id, clientName: c.societe, articleId: a.id, articleName: a.name, catalogPrice: a.price, price: x.price ?? a.price,
        negotiatedPrice: x.price ?? null, negotiatedSince: x.since ?? null, upcoming: x.upcoming || null }, () => reload(main));
    });
    box.querySelectorAll('[data-client]').forEach(b => b.onclick = () => Bill.go('clients', { open: Number(b.dataset.client), tab: 'prices' }));
    box.querySelectorAll('[data-article]').forEach(b => b.onclick = () => Bill.go('articles', { open: b.dataset.article }));
  }

  async function reload(main) {
    try {
      M = await Bill.get('/catalog/prices/matrix');
      CATS = (await Bill.get('/catalog/articles')).categories;
    } catch (err) { return Bill.fail(err, main.querySelector('#pr-matrix')); }
    paintMatrix(main);
    loadLog(main);
    const negotiated = Object.values(M.cells).reduce((s, row) => s + Object.values(row).filter(x => x.price != null).length, 0);
    main.querySelector('#pr-count').textContent = `${plural(negotiated, 'tarif négocié', 'tarifs négociés')} · ${plural(M.clients.length, 'hôtel', 'hôtels')}`;
  }

  async function loadLog(main) {
    const box = main.querySelector('#pr-log'); if (!box) return;
    try { box.innerHTML = Bill.priceLogHtml((await Bill.get('/catalog/prices/log')).events.slice(0, 12)); } catch (err) { Bill.fail(err, box); }
  }

  Bill.register('prices', {
    async render(main) {
      main.innerHTML = `<div class="bl-head"><div><h2>Tarifs par hôtel</h2><p>Chaque hôtel paie le prix catalogue, sauf là où vous avez négocié un tarif. Cliquez sur une case pour le modifier.</p></div>
        <div class="bl-actions"><button class="bl-btn" id="pr-export">Exporter la grille</button><button class="bl-btn primary" id="pr-import">Importer des tarifs</button></div></div>
        <div class="bl-panel"><div class="bl-filters">
          <div class="bl-field grow"><label for="pr-q">Rechercher un article</label><input id="pr-q" type="search" value="${e(S.q)}" placeholder="Nom, code ou code Sage"></div>
          <div class="bl-field"><label for="pr-cat">Catégorie</label><select id="pr-cat"><option value="">Toutes</option></select></div>
          <div class="bl-field"><label for="pr-mode">Afficher</label><select id="pr-mode"><option value="price">Les prix</option><option value="delta">L'écart avec le catalogue</option></select></div>
          <div class="bl-muted" id="pr-count" style="padding-bottom:9px"></div></div>
        <div id="pr-matrix"><div class="bl-spin">Chargement…</div></div>
        <div class="bl-legend-line"><span><i class="k neg"></i>Tarif négocié</span><span><i class="k up"></i>Changement programmé</span><span><i class="k x"></i>Article non proposé à l'hôtel</span><span>Prix HT, en euros</span></div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Derniers changements</h3></div><div class="bl-panel-b" id="pr-log"><div class="bl-spin">Chargement…</div></div></div>`;
      await reload(main);
      const cat = main.querySelector('#pr-cat');
      cat.innerHTML += CATS.map(c => `<option value="${e(c.id)}">${e(c.label)}</option>`).join('');
      cat.value = S.cat; main.querySelector('#pr-mode').value = S.mode;
      let t; main.querySelector('#pr-q').oninput = (ev) => { clearTimeout(t); t = setTimeout(() => { S.q = ev.target.value.trim(); paintMatrix(main); }, 200); };
      cat.onchange = () => { S.cat = cat.value; paintMatrix(main); };
      main.querySelector('#pr-mode').onchange = (ev) => { S.mode = ev.target.value; paintMatrix(main); };
      main.querySelector('#pr-export').onclick = async () => { try { await Bill.download('/catalog/prices/export.csv', 'grille-tarifaire.csv'); } catch (err) { Bill.fail(err); } };
      main.querySelector('#pr-import').onclick = () => importPrices(() => reload(main));
    },
  });

  // ---------- import de tarifs ----------

  const STATUS = { ok: ['info', 'Sera enregistré'], same: ['draft', 'Déjà en vigueur'], error: ['bad', 'Erreur'] };

  async function importPrices(done) {
    const clients = await Bill.clients();
    const clientMap = {};   // nom écrit dans le fichier → fiche choisie, conservé d'un aperçu à l'autre
    Bill.csvImport({
      title: 'Importer des tarifs', path: '/catalog/prices/import', scope: 'prices-import',
      intro: 'Deux présentations au choix. <b>En grille</b> : partez de « Exporter la grille », modifiez les prix dans Excel puis réimportez — seules les cases changées sont prises en compte, une case vide est ignorée, et un prix égal au catalogue retire le tarif négocié. <b>En liste</b> : colonnes <b>client</b> (nom de l\'hôtel), <b>code_sage</b> (ou code), <b>prix</b> HT et, facultativement, <b>date_debut</b> (AAAA-MM-JJ) et <b>siret</b> (pour retrouver l\'hôtel quand son nom est écrit autrement) ; sans colonne « client », choisissez l\'hôtel ci-dessous. Les hôtels non reconnus se rapprochent d\'une fiche dans l\'aperçu.',
      template: { name: 'modele-tarifs.csv', text: 'client,code_sage,prix,date_debut\nHôtel Exemple,B-DP2,1.20,2027-01-01\n' },
      extraFields: `<div class="bl-row2"><div class="bl-field"><label for="ip-c">Hôtel (si le fichier n'a pas de colonne client)</label><select id="ip-c">${Bill.clientOptions(clients)}</select></div>
        <div class="bl-field"><label for="ip-d">Date d'effet par défaut</label><input id="ip-d" type="date" value="${Bill.today()}"><div class="bl-hint">Utilisée pour les lignes sans date_debut.</div></div></div>`,
      extraBody: (m) => ({ clientId: m.$('#ip-c').value || undefined, defaultDate: m.$('#ip-d').value || undefined, clientMap: { ...clientMap } }),
      onOpen: (m) => {
        // Choix d'une fiche pour un hôtel du fichier : l'aperçu devient caduc, « Revérifier » le recalcule.
        m.el.addEventListener('change', (ev) => {
          const sel = ev.target.closest && ev.target.closest('select.ip-map');
          if (!sel) return;
          if (sel.value) clientMap[sel.dataset.name] = sel.value; else delete clientMap[sel.dataset.name];
          m.invalidate();
          const b = m.$('#ip-recheck'); if (b) { b.classList.add('primary'); b.textContent = 'Revérifier avec ces choix'; }
        });
        m.el.addEventListener('click', (ev) => { if (ev.target.closest && ev.target.closest('#ip-recheck')) m.recheck(); });
      },
      renderPreview: (r) => {
        const s = r.summary;
        const shown = r.lines.length > 30 ? r.lines.filter(l => l.status !== 'same') : r.lines;
        const hidden = r.lines.length - shown.length;
        const unknown = r.unknownClients || [];
        const options = (u) => {
          const sug = u.suggestions.map(x => x.id);
          const rest = clients.filter(c => !sug.includes(c.id));
          const chosen = clientMap[u.name] || '';
          const opt = (c, tag) => `<option value="${c.id}" ${String(c.id) === String(chosen) ? 'selected' : ''}>${e(c.societe)}${tag}</option>`;
          return `<option value="">— ignorer cet hôtel —</option>${u.suggestions.map(x => opt({ id: x.id, societe: x.societe }, ' (proposé)')).join('')}${rest.map(c => opt(c, '')).join('')}`;
        };
        const unknownHtml = unknown.length ? `<div class="bl-alert warn"><b>${plural(unknown.length, 'hôtel du fichier n\'est pas reconnu', 'hôtels du fichier ne sont pas reconnus')}.</b>
            Choisissez la fiche qui correspond (les plus proches sont proposées en premier), puis « Revérifier ». Un hôtel laissé sur « ignorer » n'est pas importé.
            <div class="bl-tablewrap" style="max-height:220px;overflow:auto;margin-top:8px"><table class="bl-table"><thead><tr><th>Dans le fichier</th><th class="r">Lignes</th><th>Fiche hôtel</th></tr></thead><tbody>
            ${unknown.map(u => `<tr><td>${e(u.name || '—')}${u.siret ? `<div class="bl-muted">SIRET ${e(u.siret)}</div>` : ''}</td><td class="r bl-num">${u.lines}</td><td><select class="ip-map" data-name="${e(u.name)}" aria-label="Fiche pour ${e(u.name)}">${options(u)}</select></td></tr>`).join('')}</tbody></table></div>
            <div style="margin-top:8px"><button type="button" class="bl-btn" id="ip-recheck">Revérifier avec ces choix</button></div></div>` : '';
        const matched = r.matchedBy || {};
        const matchedHtml = (matched.siret || matched.choix) ? `<p class="bl-hint">${matched.siret ? `${plural(matched.siret, 'ligne rapprochée', 'lignes rapprochées')} par le SIRET. ` : ''}${matched.choix ? `${plural(matched.choix, 'ligne rapprochée', 'lignes rapprochées')} d'après votre choix.` : ''}</p>` : '';
        return {
          canApply: s.changed > 0,
          confirm: `${plural(s.changed, 'tarif sera enregistré', 'tarifs seront enregistrés')}. Les commandes déjà passées ne changent pas.`,
          html: `${unknownHtml}<div class="bl-alert ${s.errors ? 'warn' : 'ok'}"><b>${plural(s.total, 'ligne lue', 'lignes lues')}</b> : ${s.changed} à enregistrer, ${s.same} déjà en vigueur${s.errors ? `, <b>${s.errors} en erreur</b> (non importées)` : ''}.</div>
            <div class="bl-tablewrap" style="max-height:260px;overflow:auto"><table class="bl-table"><thead><tr><th>Ligne</th><th>Hôtel</th><th>Article</th><th class="r">Avant</th><th class="r">Après</th><th>Dès le</th><th></th></tr></thead><tbody>
            ${shown.map(l => `<tr><td class="bl-num">${l.line}</td><td>${e(l.client || '—')}${l.via === 'siret' ? ' <span class="bl-tag draft" title="Hôtel retrouvé grâce au SIRET du fichier">SIRET</span>' : l.via === 'choix' ? ' <span class="bl-tag draft" title="Hôtel choisi par vous">choisi</span>' : ''}</td><td>${e(l.article || '—')}</td><td class="r bl-num">${Bill.num3(l.from)}</td><td class="r bl-num"><b>${Bill.num3(l.to)}</b></td><td class="bl-num">${l.effective ? dFr(l.effective) : '—'}</td>
              <td>${l.status === 'error' ? `<span class="bl-tag bad">${e(l.error)}</span>` : `<span class="bl-tag ${STATUS[l.status][0]}">${STATUS[l.status][1]}</span>`}</td></tr>`).join('')}</tbody></table></div>${hidden ? `<p class="bl-hint">${plural(hidden, 'ligne inchangée non affichée', 'lignes inchangées non affichées')}.</p>` : ''}${matchedHtml}`,
        };
      },
      onDone: (r) => { Bill.toast(`${plural(r.summary.changed, 'tarif enregistré', 'tarifs enregistrés')}`); done(); },
    });
  }
})();
