// Statistiques — « Répartition du linge » : grand plat, petit plat, éponge et divers, sur la période choisie en haut de la page,
// au total puis mois par mois. Les chiffres viennent de /api/admin/stats/families (linge livré, poids théorique d'après la fiche article).
(function () {
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const nf = (n, d = 0) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const dFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
  const monthName = (m) => { const s = new Date(`${m}-15T12:00:00Z`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }); return s.charAt(0).toUpperCase() + s.slice(1); };
  const kg = (n) => `${nf(n, n >= 100 ? 0 : 1)} kg`;
  const plural = (n, one, many) => `${nf(n)} ${n > 1 ? many : one}`;
  let seq = 0;   // une réponse arrivée en retard ne doit jamais écraser une demande plus récente

  function famRows(d) {
    const max = Math.max(1, ...d.families.map(f => f.weightPct));
    return `<div class="sf-head" aria-hidden="true"><span>Famille</span><span></span><span>Poids</span><span>Part du poids</span><span>Pièces</span><span>Part des pièces</span></div>
      ${d.families.map(f => `<div class="stats-row sf-row">
        <span class="sf-name">${esc(f.label)}</span>
        <span class="stats-row-bar"><span class="stats-row-bar-fill" style="width:${(f.weightPct / max) * 100}%;"></span></span>
        <span class="mono sf-num">${esc(kg(f.weightKg))}</span>
        <span class="mono stats-row-pct" title="Part du poids livré">${nf(f.weightPct, 1)} %</span>
        <span class="mono sf-num sf-pieces">${nf(f.pieces)}</span>
        <span class="mono stats-row-pct" title="Part des pièces livrées">${nf(f.piecesPct, 1)} %</span>
      </div>`).join('')}
      <div class="stats-row sf-row sf-total"><span class="sf-name">Total</span><span class="stats-row-bar" style="visibility:hidden"></span>
        <span class="mono sf-num">${esc(kg(d.totalWeightKg))}</span><span class="mono stats-row-pct">100 %</span>
        <span class="mono sf-num sf-pieces">${nf(d.totalPieces)}</span><span class="mono stats-row-pct">100 %</span></div>`;
  }

  function monthTable(d) {
    if (d.months.length < 2) return '';
    const head = d.families.map(f => `<th scope="col">${esc(f.label)}</th>`).join('');
    const body = d.months.map(m => `<tr><th scope="row">${esc(monthName(m.month))}</th>${m.families.map(f => `<td class="${f.pieces ? '' : 'z'}" title="${esc(`${nf(f.pieces)} pièces`)}">${f.pieces ? `${esc(kg(f.weightKg))} · ${nf(f.weightPct, 0)} %` : '—'}</td>`).join('')}<td>${esc(kg(m.totalWeightKg))}</td></tr>`).join('');
    return `<h5 class="sf-sub">Mois par mois <span>(poids et part du poids du mois)</span></h5>
      <div class="dd-wrap"><table class="dd-table sf-months"><thead><tr><th scope="col">Mois</th>${head}<th scope="col">Total</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  // (textes fixes + nombres ; les seuls textes saisis, les noms d'articles, passent par esc())
  function notes(d) {
    const out = [];
    if (d.inferredArticles) {
      out.push(`${plural(d.inferredArticles, 'article livré n\'a', 'articles livrés n\'ont')} pas de famille choisie : elle est proposée d'après le nom. Pour la fixer : Facturation → Articles → fiche de l'article → « Famille de linge ».`);
    }
    if (d.diversArticles.length) {
      out.push(`Rangés en Divers (à vérifier) : ${d.diversArticles.map(a => `${esc(a.name)} (${nf(a.pieces)})`).join(', ')}.`);
    }
    if (d.piecesNoWeight) out.push(`${plural(d.piecesNoWeight, 'pièce n\'a', 'pièces n\'ont')} pas de poids dans la fiche article : elles comptent dans les pièces mais pas dans le poids.`);
    out.push('Linge livré (commandes livrées, date du bon de livraison) ; reprises non comptées. Le poids est théorique : poids de la fiche article × quantité livrée.');
    return `<div class="sf-notes">${out.map(t => `<p>${t}</p>`).join('')}</div>`;
  }

  window.renderStatsFamilies = async function (host) {
    const mine = ++seq;
    const { from, to } = window.statsRange();
    host.innerHTML = `<div class="card sf" style="margin-bottom:20px;"><h4 class="card-subhead" style="margin-bottom:4px;">Répartition du linge</h4>
      <p class="sf-lead">Grand plat, petit plat, éponge et divers — du ${esc(dFr(from))} au ${esc(dFr(to))}.</p><div id="sf-body"><p class="empty-note">Chargement…</p></div></div>`;
    const body = host.querySelector('#sf-body');
    try {
      const d = await api('GET', `/api/admin/stats/families?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (mine !== seq || !body.isConnected) return;
      body.innerHTML = d.totalPieces
        ? `${famRows(d)}${monthTable(d)}${notes(d)}`
        : '<p class="empty-note">Aucun linge livré sur cette période.</p>';
    } catch (err) {
      if (mine === seq && body.isConnected) body.innerHTML = `<p class="form-error" style="display:block;">${esc(err.message)}</p>`;
    }
  };
})();
