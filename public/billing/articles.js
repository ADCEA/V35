// Articles : catalogue, prix catalogue, dimensions, import. Tout est derrière le code de la Facturation.
(function () {
  const { e, plural } = Bill;
  const S = { q: '', cat: '', sort: 'name' };
  let DATA = null;

  const catLabel = (id) => (DATA.categories.find(c => c.id === id) || {}).label || id;
  const SORTS = { name: (a, b) => a.name.localeCompare(b.name, 'fr'), price: (a, b) => b.price - a.price, usage: (a, b) => b.qty90 - a.qty90 };

  function visible() {
    const q = S.q.toLowerCase();
    return DATA.articles
      .filter(a => (!S.cat || a.category === S.cat) && (!q || [a.name, a.code, a.sageCode].some(x => String(x).toLowerCase().includes(q))))
      .sort(SORTS[S.sort]);
  }

  function paintTable(main) {
    const box = main.querySelector('#ar-table');
    const list = visible();
    if (!DATA.articles.length) {
      box.innerHTML = '<div class="bl-empty"><b>Le catalogue est vide</b>Ajoutez vos articles un par un, ou importez-les d\'un coup depuis un fichier Excel (CSV).</div>';
      return;
    }
    if (!list.length) { box.innerHTML = '<div class="bl-empty"><b>Aucun résultat</b>Essayez un autre mot, ou retirez le filtre de catégorie.</div>'; return; }
    box.innerHTML = `<div class="bl-tablewrap"><table class="bl-table"><thead><tr>
      <th>Article</th><th>Catégorie</th><th class="r">Prix catalogue HT</th><th>Tarifs négociés</th><th>Proposé à</th><th class="r">Pièces sur 90 jours</th></tr></thead><tbody>
      ${list.map(a => `<tr class="bl-row" tabindex="0" data-id="${e(a.id)}">
        <td class="client">${e(a.name)}<span class="sub">${e(a.sageCode)} · badge ${e(a.code)}</span></td>
        <td>${e(catLabel(a.category))}</td>
        <td class="r bl-num"><b style="font-weight:600">${Bill.price(a.price)}</b></td>
        <td>${a.negotiatedCount ? `<span class="bl-tag info">${a.negotiatedCount} / ${DATA.clientCount} hôtels</span>` : '<span class="bl-faint">Aucun</span>'}</td>
        <td>${a.hiddenFor ? `<span class="bl-tag wait">Retiré à ${plural(a.hiddenFor, 'hôtel', 'hôtels')}</span>` : '<span class="bl-faint">Tous</span>'}</td>
        <td class="r bl-num">${a.qty90 ? Bill.num3(a.qty90).replace(/,00$/, '') : '<span class="bl-faint">0</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
    box.querySelectorAll('tr.bl-row').forEach(tr => {
      const open = () => openArticle(tr.dataset.id, () => reload(main));
      tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    });
  }

  async function reload(main) {
    try { DATA = await Bill.get('/catalog/articles'); } catch (err) { return Bill.fail(err, main.querySelector('#ar-table')); }
    paintTable(main);
    const c = main.querySelector('#ar-count'); if (c) c.textContent = plural(DATA.articles.length, 'article', 'articles');
  }

  Bill.register('articles', {
    async render(main, params = {}) {
      main.innerHTML = `<div class="bl-head"><div><h2>Articles</h2><p>Le catalogue et ses prix. Un hôtel peut avoir son propre tarif pour un article : il se règle dans « Tarifs par hôtel ».</p></div>
        <div class="bl-actions"><button class="bl-btn" id="ar-import">Importer un fichier</button><button class="bl-btn primary" id="ar-new">Nouvel article</button></div></div>
        <div class="bl-panel"><div class="bl-filters">
          <div class="bl-field grow"><label for="ar-q">Rechercher</label><input id="ar-q" type="search" value="${e(S.q)}" placeholder="Nom, code ou code Sage"></div>
          <div class="bl-field"><label for="ar-cat">Catégorie</label><select id="ar-cat"><option value="">Toutes</option></select></div>
          <div class="bl-field"><label for="ar-sort">Trier par</label><select id="ar-sort"><option value="name">Nom</option><option value="price">Prix décroissant</option><option value="usage">Les plus utilisés</option></select></div>
          <div class="bl-muted" id="ar-count" style="padding-bottom:9px"></div></div>
        <div id="ar-table"><div class="bl-spin">Chargement…</div></div></div>`;
      await reload(main);
      const cat = main.querySelector('#ar-cat');
      cat.innerHTML += DATA.categories.map(c => `<option value="${e(c.id)}">${e(c.label)}</option>`).join('');
      cat.value = S.cat; main.querySelector('#ar-sort').value = S.sort;
      let t; main.querySelector('#ar-q').oninput = (ev) => { clearTimeout(t); t = setTimeout(() => { S.q = ev.target.value.trim(); paintTable(main); }, 200); };
      cat.onchange = () => { S.cat = cat.value; paintTable(main); };
      main.querySelector('#ar-sort').onchange = (ev) => { S.sort = ev.target.value; paintTable(main); };
      main.querySelector('#ar-new').onclick = () => openArticle(null, () => reload(main));
      main.querySelector('#ar-import').onclick = () => importArticles(() => reload(main));
      if (params.open) openArticle(params.open, () => reload(main));
    },
  });

  // ---------- fiche article ----------

  async function openArticle(id, onChange) {
    let changed = false; let art = null; let log = []; let access = null;
    const d = Bill.drawer({ onClose: () => { if (changed && onChange) onChange(); } });
    d.body.innerHTML = '<div class="bl-spin">Chargement…</div>';

    async function load() {
      try {
        if (id) {
          art = (await Bill.get('/catalog/articles/' + encodeURIComponent(id))).article;
          log = (await Bill.get('/catalog/prices/log?articleId=' + encodeURIComponent(id))).events;
          access = await Bill.get('/catalog/articles/' + encodeURIComponent(id) + '/access');
        } else art = { name: '', code: '', sageCode: '', category: DATA.categories[0].id, price: '', gsm: '', widthCm: '', lengthCm: '', foldedWidthCm: '', foldedLengthCm: '', foldedHeightCm: '' };
      } catch (err) { Bill.closeDrawer(); return Bill.fail(err); }
      paint();
    }

    // Hôtels qui peuvent commander l'article. Les cases cochées = hôtels qui l'ont ; tout se règle ici en une fois.
    function paintAccess(box) {
      const cl = access.clients;
      const withAccess = cl.filter(c => c.hasAccess).length;
      box.innerHTML = `<div class="bl-panel-h"><h3>Hôtels qui peuvent le commander</h3><span class="bl-muted" id="ac-count"></span></div><div class="bl-panel-b">
        <p class="bl-note">Décochez les hôtels qui n'utilisent pas cet article : il ne leur sera plus proposé (espace client, commandes saisies, import par API). Les commandes déjà passées ne changent pas.</p>
        ${cl.length ? `<div class="bl-filters" style="margin-bottom:8px"><div class="bl-field grow"><label for="ac-q">Chercher un hôtel</label><input id="ac-q" type="search" placeholder="Nom de l'hôtel"></div></div>
        <div class="bl-actions" style="justify-content:flex-start;margin-bottom:8px">
          <button class="bl-btn small" type="button" id="ac-all">Tout cocher</button>
          <button class="bl-btn small" type="button" id="ac-none">Tout décocher</button>
          <button class="bl-btn small" type="button" id="ac-unused">Décocher ceux qui ne l'ont pas commandé depuis 12 mois</button></div>
        <div class="bl-checklist" id="ac-list">${cl.map(c => `<label class="bl-check" data-name="${e(c.societe.toLowerCase())}"><input type="checkbox" value="${c.id}" ${c.hasAccess ? 'checked' : ''}>
          <span>${e(c.societe)}${c.restricted ? ' <span class="bl-tag info" title="Cet hôtel ne voit qu\'une sélection d\'articles">catalogue sélectionné</span>' : ''}<br><span class="bl-muted">${e(Bill.usageText(c.pieces12m, c.lastOrderAt))}</span></span></label>`).join('')}</div>
        <div class="bl-actions" style="margin-top:12px"><button class="bl-btn primary" type="button" id="ac-save">Enregistrer les hôtels…</button></div>`
        : '<p class="bl-muted">Aucun hôtel pour le moment.</p>'}
        <div class="bl-err" id="ac-err" role="alert"></div></div>`;
      if (!cl.length) return;
      const boxes = () => [...box.querySelectorAll('#ac-list input')];
      const sync = () => { box.querySelector('#ac-count').textContent = `${boxes().filter(i => i.checked).length} / ${cl.length}`; };
      box.addEventListener('change', sync); sync();
      box.querySelector('#ac-q').oninput = (ev) => {
        const q = ev.target.value.trim().toLowerCase();
        box.querySelectorAll('#ac-list .bl-check').forEach(l => { l.hidden = !!q && !l.dataset.name.includes(q); });
      };
      const visibleBoxes = () => boxes().filter(i => !i.closest('.bl-check').hidden);
      box.querySelector('#ac-all').onclick = () => { visibleBoxes().forEach(i => { i.checked = true; }); sync(); };
      box.querySelector('#ac-none').onclick = () => { visibleBoxes().forEach(i => { i.checked = false; }); sync(); };
      box.querySelector('#ac-unused').onclick = () => {
        const idle = new Set(cl.filter(c => !c.pieces12m).map(c => String(c.id)));
        boxes().forEach(i => { if (idle.has(i.value)) i.checked = false; }); sync();
      };
      const errEl = box.querySelector('#ac-err');
      box.querySelector('#ac-save').onclick = async (ev) => {
        const btn = ev.currentTarget; errEl.textContent = '';
        const clientIds = boxes().filter(i => i.checked).map(i => Number(i.value));
        btn.disabled = true;
        try {
          const r = await Bill.post(`/catalog/articles/${encodeURIComponent(id)}/access`, { clientIds, apply: false });
          if (!r.changes.length) { Bill.toast('Aucun changement'); return; }
          const byId = new Map(cl.map(c => [c.id, c]));
          const lost = r.changes.filter(c => !c.access); const gained = r.changes.filter(c => c.access);
          const busy = lost.filter(c => byId.get(c.clientId).pieces12m > 0);
          const narrowed = lost.filter(c => c.becameRestricted);
          const li = (c) => `<li>${e(c.client)}${byId.get(c.clientId).pieces12m ? ` <span class="bl-muted">— ${e(Bill.usageText(byId.get(c.clientId).pieces12m, byId.get(c.clientId).lastOrderAt))}</span>` : ''}</li>`;
          Bill.modal({
            title: `Modifier les hôtels de « ${art.name} »`, wide: true,
            body: `${lost.length ? `<div class="bl-alert warn"><b>Retiré à ${plural(lost.length, 'hôtel', 'hôtels')}</b> : ils ne pourront plus le commander.<ul>${lost.map(li).join('')}</ul></div>` : ''}
              ${busy.length ? `<div class="bl-alert warn"><b>Attention :</b> ${plural(busy.length, 'de ces hôtels a', 'de ces hôtels ont')} commandé cet article ces 12 derniers mois.</div>` : ''}
              ${narrowed.length ? `<div class="bl-alert info"><b>${plural(narrowed.length, 'hôtel passe', 'hôtels passent')} en « catalogue sélectionné »</b> : ils gardent tous leurs autres articles actuels, mais les futurs articles ne leur seront pas proposés tant que vous ne les cochez pas.</div>` : ''}
              ${gained.length ? `<div class="bl-alert ok"><b>Proposé à ${plural(gained.length, 'hôtel de plus', 'hôtels de plus')}</b><ul>${gained.map(li).join('')}</ul></div>` : ''}`,
            buttons: [{ label: 'Annuler' }, { label: 'Appliquer', primary: true, onClick: async () => {
              await Bill.post(`/catalog/articles/${encodeURIComponent(id)}/access`, { clientIds, apply: true });
              changed = true; Bill.toast('Hôtels enregistrés'); await load();
            } }],
          });
        } catch (err) { Bill.fail(err, errEl); } finally { btn.disabled = false; }
      };
    }

    function impactHtml() {
      if (!id) return '';
      const im = art.impact; const n = DATA.clientCount;
      if (!n) return '';
      const nego = im.negotiated.length
        ? `<br><b>${plural(im.negotiated.length, 'hôtel a', 'hôtels ont')} un tarif négocié</b> qui ne bouge pas : ${im.negotiated.slice(0, 6).map(x => `${e(x.societe)} (${Bill.price(x.price)})`).join(', ')}${im.negotiated.length > 6 ? '…' : ''}.` : '';
      const up = im.upcoming.length ? `<br>${plural(im.upcoming.length, 'changement de tarif est déjà programmé', 'changements de tarif sont déjà programmés')}.` : '';
      return `<div class="bl-alert" id="ar-impact" style="background:var(--bl-info-bg);border-color:#B5D6F6;color:#0B3F73">
        <b id="ar-delta">Prix catalogue actuel : ${Bill.price(art.price)}</b><br>
        Un nouveau prix s'applique aux prochaines commandes de ${plural(im.onCatalogue.length, 'hôtel', 'hôtels')} au prix catalogue.
        Les commandes déjà passées gardent leur prix.${nego}${up}</div>`;
    }

    function paint() {
      d.setHead({
        title: id ? e(art.name) : 'Nouvel article',
        sub: id ? `${e(art.sageCode)} · ${e(catLabel(art.category))}` : 'Renseignez le nom, les codes et le prix catalogue.',
        actions: `<button class="bl-btn primary" data-a="save">Enregistrer</button>${id ? '<button class="bl-btn danger" data-a="delete">Supprimer…</button>' : ''}`,
      });
      const f = (k) => e(art[k] ?? '');
      d.body.innerHTML = `${impactHtml()}
        <div class="bl-panel"><div class="bl-panel-h"><h3>Identité et prix</h3></div><div class="bl-panel-b">
          <div class="bl-row2"><div class="bl-field"><label for="a-name">Nom</label><input id="a-name" value="${f('name')}" placeholder="Ex. Drap plat 2 personnes"></div>
            <div class="bl-field"><label for="a-cat">Catégorie</label><select id="a-cat">${DATA.categories.map(c => `<option value="${e(c.id)}" ${art.category === c.id ? 'selected' : ''}>${e(c.label)}</option>`).join('')}</select></div></div>
          <div class="bl-row3"><div class="bl-field"><label for="a-sage">Code Sage</label><input id="a-sage" value="${f('sageCode')}" placeholder="B-DP2"><div class="bl-hint">Unique : il sert de référence sur les factures et les imports.</div></div>
            <div class="bl-field"><label for="a-code">Badge affiché</label><input id="a-code" value="${f('code')}" placeholder="DP2"></div>
            <div class="bl-field"><label for="a-price">Prix catalogue HT (€)</label><input id="a-price" inputmode="decimal" value="${art.price === '' ? '' : e(String(art.price).replace('.', ','))}" placeholder="1,35"></div></div>
        </div></div>
        <details class="bl-panel bl-details"><summary>Dimensions et poids <span class="bl-muted">— servent au chargement des camions (Logistique)</span></summary><div class="bl-panel-b">
          <div class="bl-row3"><div class="bl-field"><label for="a-gsm">Densité du tissu (g/m²)</label><input id="a-gsm" inputmode="decimal" value="${art.gsm ? e(art.gsm) : (art.weightG && art.widthCm && art.lengthCm ? Math.round(art.weightG / (art.widthCm * art.lengthCm / 10000)) : '')}"></div>
            <div class="bl-field"><label for="a-w">Largeur à plat (cm)</label><input id="a-w" inputmode="decimal" value="${f('widthCm')}"></div>
            <div class="bl-field"><label for="a-l">Longueur à plat (cm)</label><input id="a-l" inputmode="decimal" value="${f('lengthCm')}"></div></div>
          <div class="bl-row3"><div class="bl-field"><label for="a-fw">Largeur pliée (cm)</label><input id="a-fw" inputmode="decimal" value="${f('foldedWidthCm')}"></div>
            <div class="bl-field"><label for="a-fl">Longueur pliée (cm)</label><input id="a-fl" inputmode="decimal" value="${f('foldedLengthCm')}"></div>
            <div class="bl-field"><label for="a-fh">Épaisseur pliée (cm)</label><input id="a-fh" inputmode="decimal" value="${f('foldedHeightCm')}"></div></div>
          <p class="bl-hint" id="a-calc"></p></div></details>
        ${id ? '<div class="bl-panel" id="ar-access"></div>' : ''}
        ${id ? `<div class="bl-panel"><div class="bl-panel-h"><h3>Historique des prix</h3></div><div class="bl-panel-b">${Bill.priceLogHtml(log, 'Aucun changement de prix enregistré pour cet article.')}</div></div>` : ''}
        <div class="bl-err" id="a-err" role="alert"></div>`;

      const val = (sel) => d.body.querySelector(sel).value;
      const num = (sel) => Bill.parsePrice(val(sel)) || 0;
      const calc = () => {
        const weight = Math.round(num('#a-w') * num('#a-l') / 10000 * num('#a-gsm'));
        const vol = Math.round(num('#a-fw') * num('#a-fl') * num('#a-fh') / 1000 * 100) / 100;
        d.body.querySelector('#a-calc').textContent = `Poids calculé : ${weight} g · volume plié : ${String(vol).replace('.', ',')} L`;
      };
      d.body.querySelectorAll('details input').forEach(i => i.addEventListener('input', calc)); calc();
      if (id) d.body.querySelector('#a-price').addEventListener('input', () => {
        const n = Bill.parsePrice(val('#a-price')); const el = d.body.querySelector('#ar-delta');
        if (!el) return;
        el.textContent = Number.isFinite(n) && n !== art.price ? `Prix catalogue : ${Bill.price(art.price)} → ${Bill.price(n)} (${Bill.pct(art.price, n)})` : `Prix catalogue actuel : ${Bill.price(art.price)}`;
      });

      if (id) paintAccess(d.body.querySelector('#ar-access'));

      d.head.querySelector('[data-a="save"]').onclick = async (ev) => {
        const btn = ev.currentTarget; const errEl = d.body.querySelector('#a-err'); errEl.textContent = '';
        const payload = { name: val('#a-name'), category: val('#a-cat'), sageCode: val('#a-sage'), code: val('#a-code'), price: val('#a-price'),
          gsm: val('#a-gsm'), widthCm: val('#a-w'), lengthCm: val('#a-l'), foldedWidthCm: val('#a-fw'), foldedLengthCm: val('#a-fl'), foldedHeightCm: val('#a-fh') };
        btn.disabled = true;
        try {
          const r = id ? await Bill.put('/catalog/articles/' + encodeURIComponent(id), payload) : await Bill.post('/catalog/articles', payload);
          changed = true; Bill.toast(id ? 'Article enregistré' : 'Article créé');
          if (!id) { id = r.article.id; }
          await load();
        } catch (err) { btn.disabled = false; Bill.fail(err, errEl); }
      };
      const del = d.head.querySelector('[data-a="delete"]');
      if (del) del.onclick = () => Bill.sensitive({
        title: `Supprimer « ${art.name} »`, scope: `article-delete:${id}`, okLabel: 'Supprimer', danger: true,
        text: `Les commandes et factures déjà établies ne changent pas. ${art.impact.negotiated.length || art.impact.upcoming.length ? 'Les tarifs négociés sur cet article seront supprimés. ' : ''}Un article utilisé par les règles de linge d'une chambre ne peut pas être supprimé.`,
        onSubmit: async () => { await Bill.del('/catalog/articles/' + encodeURIComponent(id)); changed = true; Bill.closeDrawer(); Bill.toast('Article supprimé'); },
      });
    }
    await load();
  }

  // ---------- import ----------

  function importArticles(done) {
    Bill.csvImport({
      title: 'Importer des articles', path: '/catalog/articles/import', scope: 'articles-import',
      intro: 'Colonnes obligatoires : <b>nom</b>, <b>code</b>, <b>code_sage</b>. Facultatives : prix, categorie (lit, toilette, service), densite_gsm, largeur_cm, longueur_cm, largeur_pliee_cm, longueur_pliee_cm, epaisseur_pliee_cm. Un article dont le code Sage existe déjà est mis à jour ; une cellule vide conserve la valeur actuelle.',
      template: { name: 'modele-articles.csv', text: 'nom,code,code_sage,prix,categorie,densite_gsm,largeur_cm,longueur_cm,largeur_pliee_cm,longueur_pliee_cm,epaisseur_pliee_cm\nDrap plat 2 personnes,DP2,B-DP2,1.35,lit,130,240,300,40,30,4\n' },
      renderPreview: (r) => {
        const s = r.summary;
        const head = `<div class="bl-alert ${s.errors ? 'warn' : 'ok'}"><b>${plural(s.total, 'ligne lue', 'lignes lues')}</b> : ${s.created} à créer, ${s.updated} prix modifié(s), ${s.unchanged} inchangé(s)${s.duplicates ? `, ${s.duplicates} doublon(s) ignoré(s)` : ''}${s.errors ? `, <b>${s.errors} en erreur</b> (non importées)` : ''}.</div>`;
        const prices = r.updated.length ? `<div class="bl-alert warn"><b>Prix catalogue qui vont changer</b><ul>${r.updated.map(u => `<li>${e(u.name)} : ${Bill.price(u.priceFrom)} → ${Bill.price(u.priceTo)} (${Bill.pct(u.priceFrom, u.priceTo)})</li>`).join('')}</ul></div>` : '';
        return {
          canApply: s.created + s.updated + s.unchanged > 0 && (s.created + s.updated) > 0,
          confirm: `${s.created} article(s) créé(s), ${s.updated} prix modifié(s). Les prix modifiés s'appliquent aux prochaines commandes ; les tarifs négociés par hôtel ne bougent pas.`,
          html: head + prices + Bill.noticeList('Erreurs — ces lignes ne seront pas importées', r.errors.map(x => `Ligne ${x.line} : ${x.error}`), 'bad')
            + Bill.noticeList('Doublons probables — créés quand même, à vérifier', r.possibleDuplicates.map(x => `Ligne ${x.line} : ${x.error}`))
            + Bill.noticeList('Doublons dans le fichier — ignorés', r.duplicates.map(x => `Ligne ${x.line} : ${x.error}`), 'warn'),
        };
      },
      onDone: (r) => { Bill.toast(`Import terminé : ${r.summary.created} créé(s), ${r.summary.updated} mis à jour`); done(); },
    });
  }
})();
