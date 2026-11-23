// Statistiques — « Coûts de livraison » : ce que coûtent les livraisons de la période choisie en haut de la page.
// Les chiffres viennent de /api/admin/stats/delivery-costs : carburant et usure (km × coût au km), chauffeur (temps de tournée × coût horaire),
// entretien des véhicules (dépenses saisies dans le Garage) et frais fixes au prorata. Les trois réglages (€/km, €/h, frais fixes par mois)
// se saisissent ici ; un poste sans réglage n'est pas compté et le total est alors signalé comme partiel.
(function () {
  const esc = (s) => (typeof escHtml === 'function' ? escHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const nf = (n, d = 0) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const dFr = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
  const eur = (c) => (c == null ? '—' : `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);
  const eur0 = (c) => (c == null ? '—' : `${Math.round(c / 100).toLocaleString('fr-FR')} €`);
  const hrs = (h) => { const m = Math.round(h * 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };
  const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  let seq = 0;   // une réponse arrivée en retard ne doit jamais écraser une demande plus récente

  const tile = (label, value, title) => `<div class="stats-card" ${title ? `title="${esc(title)}"` : ''}><div class="eyebrow">${esc(label)}</div><strong>${value}</strong></div>`;

  function breakdown(d) {
    const s = d.settings, c = d.components, total = d.totalCents || 0;
    const rows = [
      { label: 'Carburant, pneus, usure', cents: c.perKm, detail: s.perKm == null ? 'coût au km à renseigner' : `${nf(d.km, 1)} km × ${nf(s.perKm, 2)} €/km` },
      { label: 'Chauffeur', cents: c.driver, detail: s.driverHourly == null ? 'coût horaire à renseigner' : `${hrs(d.hours)} × ${nf(s.driverHourly, 2)} €/h` },
      { label: 'Entretien des véhicules', cents: c.maintenance, detail: d.maintenanceEntries ? `${nf(d.maintenanceEntries)} entretien${d.maintenanceEntries > 1 ? 's' : ''} saisi${d.maintenanceEntries > 1 ? 's' : ''} dans le Garage` : 'aucun entretien chiffré dans le Garage' },
      { label: 'Frais fixes (assurance, crédit, location)', cents: c.fixed, detail: s.fixedMonthly == null ? 'montant mensuel à renseigner' : `${nf(s.fixedMonthly, 2)} €/mois au prorata de ${nf(d.period.days)} jour${d.period.days > 1 ? 's' : ''}` },
    ];
    const max = Math.max(1, ...rows.map(r => r.cents || 0));
    return rows.map(r => `<div class="stats-row sc-row${r.cents == null ? ' sc-off' : ''}">
        <span class="sc-name">${esc(r.label)}<small>${esc(r.detail)}</small></span>
        <span class="stats-row-bar"><span class="stats-row-bar-fill" style="width:${r.cents ? (r.cents / max) * 100 : 0}%;"></span></span>
        <span class="mono sc-num">${r.cents == null ? '—' : esc(eur(r.cents))}</span>
        <span class="mono stats-row-pct">${r.cents && total ? `${nf((r.cents / total) * 100, 0)} %` : ''}</span>
      </div>`).join('');
  }

  function drivers(d) {
    if (!d.byDriver.length) return '';
    return `<h5 class="sf-sub">Par chauffeur <span>(carburant, usure et temps de tournée ; sans entretien ni frais fixes)</span></h5>
      <div class="dd-wrap"><table class="dd-table"><thead><tr><th scope="col">Chauffeur</th><th scope="col">Jours</th><th scope="col">Arrêts</th><th scope="col">Km</th><th scope="col">Temps estimé</th><th scope="col">Coût</th></tr></thead><tbody>
      ${d.byDriver.map(x => `<tr><th scope="row">${esc(x.driver)}</th><td>${nf(x.days)}</td><td>${nf(x.stops)}</td><td>${nf(x.km, 1)}</td><td>${esc(hrs(x.hours))}</td><td>${esc(eur(x.cents))}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function days(d) {
    if (!d.byDay.length) return '';
    return `<details class="sc-days"><summary>Jour par jour (${nf(d.byDay.length)} jour${d.byDay.length > 1 ? 's' : ''} de livraison)</summary>
      <div class="dd-wrap"><table class="dd-table"><thead><tr><th scope="col">Jour</th><th scope="col">Arrêts</th><th scope="col">Km</th><th scope="col">Temps estimé</th><th scope="col">Coût</th></tr></thead><tbody>
      ${d.byDay.map(x => `<tr><th scope="row">${esc(dayName(x.date))}</th><td>${nf(x.stops)}</td><td>${nf(x.km, 1)}</td><td>${esc(hrs(x.hours))}</td><td>${esc(eur(x.cents))}</td></tr>`).join('')}
      </tbody></table></div></details>`;
  }

  function form(d) {
    const s = d.settings, v = (x) => (x == null ? '' : String(x).replace('.', ','));
    return `<form class="sc-form" id="sc-form" autocomplete="off">
      <h5 class="sf-sub">Réglages du calcul <span>(en euros ; laissez vide pour ne pas compter le poste)</span></h5>
      <div class="sc-fields">
        <label>Carburant, pneus, usure<span>€ par km</span><input name="perKm" inputmode="decimal" placeholder="ex. 0,25" value="${esc(v(s.perKm))}"></label>
        <label>Chauffeur, coût chargé<span>€ par heure</span><input name="driverHourly" inputmode="decimal" placeholder="ex. 22" value="${esc(v(s.driverHourly))}"></label>
        <label>Frais fixes des véhicules<span>€ par mois</span><input name="fixedMonthly" inputmode="decimal" placeholder="ex. 650" value="${esc(v(s.fixedMonthly))}"></label>
      </div>
      <div class="sc-actions"><button type="submit" class="btn-secondary" id="sc-save">Enregistrer et recalculer</button><span class="sc-saved" id="sc-msg" role="status"></span></div>
    </form>`;
  }

  function notes(d) {
    const out = [`Livraisons validées sur la période (date du bon de livraison). Temps de tournée estimé comme sur le lien du livreur : kilomètres ÷ ${nf(d.assumptions.avgSpeedKmh)} km/h + ${nf(d.assumptions.minutesPerStop)} min par arrêt, pour chaque chauffeur et chaque jour (réglages de la Logistique).`];
    if (d.withoutDistance) out.push(`${nf(d.withoutDistance)} livraison${d.withoutDistance > 1 ? 's' : ''} sans distance (tournée jamais optimisée) : elles comptent dans les arrêts mais pas dans les kilomètres, donc le coût est un peu sous-estimé.`);
    out.push('L\'entretien vient du Garage (dépenses saisies à la date de l\'entretien) ; il ne sépare pas ce qui concerne les livraisons des autres usages du véhicule.');
    return `<div class="sf-notes">${out.map(t => `<p>${esc(t)}</p>`).join('')}</div>`;
  }

  async function save(host, form) {
    const msg = form.querySelector('#sc-msg'), btn = form.querySelector('#sc-save');
    const body = {}; for (const el of form.elements) if (el.name) body[el.name] = el.value.trim();
    btn.disabled = true; msg.textContent = 'Enregistrement…'; msg.classList.remove('err');
    try { await api('PUT', '/api/admin/stats/delivery-costs/settings', body); await window.renderStatsDeliveryCosts(host); }
    catch (err) { msg.textContent = err.message; msg.classList.add('err'); btn.disabled = false; }
  }

  window.renderStatsDeliveryCosts = async function (host) {
    const mine = ++seq;
    const { from, to } = window.statsRange();
    host.innerHTML = `<div class="card sc" style="margin-bottom:20px;"><h4 class="card-subhead" style="margin-bottom:4px;">Coûts de livraison</h4>
      <p class="sf-lead">Du ${esc(dFr(from))} au ${esc(dFr(to))} — carburant et usure, chauffeur, entretien des véhicules et frais fixes.</p><div id="sc-body"><p class="empty-note">Chargement…</p></div></div>`;
    const body = host.querySelector('#sc-body');
    try {
      const d = await api('GET', `/api/admin/stats/delivery-costs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (mine !== seq || !body.isConnected) return;
      const partial = d.partial ? `<div class="sc-warn" role="note"><b>Total partiel.</b> ${d.missing.length === 3 ? 'Aucun réglage n\'est renseigné : seul l\'entretien du Garage est compté.' : 'Il manque des réglages (en bas de ce bloc) : les postes concernés ne sont pas comptés.'}</div>` : '';
      body.innerHTML = `
        <div class="stats-grid sc-tiles">
          ${tile(d.partial ? 'Coût (partiel)' : 'Coût total', esc(eur0(d.totalCents)), 'Somme des postes renseignés ci-dessous')}
          ${tile('Par livraison', esc(eur(d.perDeliveryCents)), `${nf(d.deliveries)} livraison${d.deliveries > 1 ? 's' : ''} sur la période`)}
          ${tile('Au kilomètre', esc(eur(d.perKmCents)), `${nf(d.km, 1)} km parcourus`)}
          ${tile('Au kilo livré', esc(eur(d.perKgCents)), `${nf(d.weightKg, 1)} kg de linge livré`)}
        </div>${partial}
        <div class="sc-rows">${breakdown(d)}</div>
        ${drivers(d)}${days(d)}${form(d)}${notes(d)}`;
      body.querySelector('#sc-form').addEventListener('submit', (e) => { e.preventDefault(); save(host, e.target); });
    } catch (err) {
      if (mine === seq && body.isConnected) body.innerHTML = `<p class="form-error" style="display:block;">${esc(err.message)}</p>`;
    }
  };
})();
