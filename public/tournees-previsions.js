// Logistique → Tournées fixes → « Prochains passages » : calendrier des tournées à venir et, pour chaque passage, la réponse à
// « le camion sera-t-il assez grand ? » (poids, volume, nombre de chariots), estimée d'après l'historique des livraisons.
// Cliquer un passage ouvre le détail : jauges, base de calcul, commandes déjà reçues, alertes et camions plus adaptés.
(function () {
  const BASE = '/api/admin/logistics/tours/forecast';
  const VERDICT = { ok: ['Large', '✓'], juste: ['Juste', '!'], depasse: ['Trop chargé', '✕'], inconnu: ['Pas assez de données', '?'] };
  const LIMIT = { weight: 'le poids', volume: 'le volume', carts: 'le nombre de chariots' };
  const WD = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
  let fc = null; let days = 28; let sel = ''; let open = true; let error = ''; let seq = 0;

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d = 1) => (n == null ? '–' : Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d }));
  const addDay = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const wdOf = (iso) => { const d = new Date(`${iso}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
  const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const shortMonth = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', { month: 'short', timeZone: 'UTC' });
  const level = (r) => (r > 1 ? 'depasse' : r > 0.85 ? 'juste' : 'ok');
  const plural = (n, one, many) => `${fmt(n, 0)} ${n > 1 ? many : one}`;

  async function fetchForecast() {
    const res = await fetch(`${BASE}?days=${days}`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  /** Une jauge : barre pleine jusqu'à la charge forte, repères « normal », « pic » et « capacité ». */
  function gauge(d, single) {
    const r = d.r || {};
    if (r.high == null || Number.isNaN(r.high)) return '';
    const unit = d.key === 'carts' ? '' : ` ${d.unit}`;
    const v = (x) => (x == null ? '–' : `${fmt(x)}${unit}`);
    const scale = Math.min(2, Math.max(1.2, (Number.isFinite(r.max) ? r.max : 1) * 1.05));
    const pc = (x) => (Number.isFinite(x) ? Math.min(100, Math.max(0, (x / scale) * 100)) : 100);
    const cap = d.key === 'carts'
      ? (d.capacity ? `${plural(d.capacity, 'place au sol', 'places au sol')}` : 'places au sol : –')
      : `capacité ${v(d.capacity)}`;
    const lvl = level(r.high);
    const vals = single
      ? `Commandé : <b>${v(d.high)}</b>`
      : `Normal <b>${v(d.typical)}</b> · Fort <b>${v(d.high)}</b> · Pic <b>${v(d.max)}</b>`;
    const aria = `${d.label} : ${single ? v(d.high) : `normal ${v(d.typical)}, fort ${v(d.high)}, pic ${v(d.max)}`}, ${cap}`;
    return `
      <div class="ft-g">
        <div class="ft-g-top"><b>${esc(d.label)}</b><span>${esc(cap)}</span></div>
        <div class="ft-g-bar" role="img" aria-label="${esc(aria)}">
          <i class="ft-g-fill ${lvl}" style="width:${pc(r.high)}%"></i>
          ${single ? '' : `<i class="ft-g-typ" style="left:${pc(r.typical)}%"></i><i class="ft-g-max" style="left:${pc(r.max)}%"></i>`}
          <i class="ft-g-cap" style="left:${pc(1)}%"></i>
        </div>
        <div class="ft-g-vals">${vals}</div>
        ${d.tooTall ? '<div class="ft-g-note">Un chariot de ce chargement ne rentre pas dans le camion.</div>' : ''}
      </div>`;
  }

  const badge = (v) => { const [label, ico] = VERDICT[v] || VERDICT.inconnu; return `<span class="ft-badge ${v}"><i aria-hidden="true">${ico}</i>${label}</span>`; };

  function calendar() {
    const byDate = {};
    for (const r of fc.runs) (byDate[r.date] = byDate[r.date] || []).push(r);
    const last = addDay(fc.from, fc.days - 1);
    let d = addDay(fc.from, -(wdOf(fc.from) - 1));
    const cells = [];
    while (d <= last || wdOf(d) !== 1) {
      const runs = byDate[d] || [];
      const past = d < fc.from; const out = d > last;
      cells.push(`
        <div class="ft-cal-d ${past || out ? 'past' : ''} ${d === fc.from ? 'today' : ''} ${runs.length ? 'has' : ''}" role="group" aria-label="${esc(longDate(d))}">
          <span class="ft-cal-n"><span class="ft-cal-wd">${WD[wdOf(d) - 1]}</span><b>${Number(d.slice(8))}</b>${d.slice(8) === '01' || d === fc.from ? `<small>${esc(shortMonth(d))}</small>` : ''}</span>
          ${runs.map(r => `<button type="button" class="ft-chip ${r.verdict} ${sel === `${r.date}|${r.tourId}` ? 'sel' : ''}" data-ft-run="${r.date}|${r.tourId}" aria-pressed="${sel === `${r.date}|${r.tourId}`}"
            title="${esc(`${r.tourName} — ${VERDICT[r.verdict][0]}${r.ratio != null ? ` (${Math.round(r.ratio * 100)} % de la capacité)` : ''}`)}">
            <i aria-hidden="true">${VERDICT[r.verdict][1]}</i><span class="ft-chip-name">${esc(r.tourName)}</span>${r.ratio != null ? `<span class="ft-chip-pct">${Math.round(r.ratio * 100)} %</span>` : ''}
          </button>`).join('')}
        </div>`);
      d = addDay(d, 1);
      if (cells.length > 70) break;
    }
    return `<div class="ft-cal-head" aria-hidden="true">${WD.map(w => `<span>${w}</span>`).join('')}</div><div class="ft-cal">${cells.join('')}</div>`;
  }

  function detail() {
    const [date, tid] = sel.split('|');
    const run = fc.runs.find(r => r.date === date && String(r.tourId) === tid);
    const tour = run && fc.tours.find(t => t.id === run.tourId);
    if (!run || !tour) return '<p class="ft-empty">Choisissez un passage dans le calendrier pour voir le détail.</p>';
    const p = tour.profiles[run.weekday];
    const sub = [tour.driverName || 'sans chauffeur', tour.truck ? `${tour.truck.name} (${fmt(tour.truck.volumeM3)} m³)` : 'camion non renseigné', `charge utile ${fmt(tour.capacity.weightKg, 0)} kg`, plural(run.clients, 'hôtel', 'hôtels')].join(' · ');
    const lim = (run.verdict === 'juste' || run.verdict === 'depasse') && run.limiting && LIMIT[run.limiting] ? `Ce qui limite : ${LIMIT[run.limiting]}.` : '';
    let body;
    if (p) {
      body = `
        <p class="ft-det-basis">Estimé d'après ${plural(p.runs, 'passage', 'passages')} ${p.scope === 'weekday' ? 'du même jour' : 'de la tournée, tous jours confondus'} sur les ${fc.settings.historyWeeks} dernières semaines. <span>Normal = moyenne · Fort = 9 passages sur 10 sont en dessous · Pic = le plus chargé observé.</span></p>
        ${p.dims.map(d => gauge(d)).join('')}
        ${p.peak ? '<p class="ft-det-note">Seul un pic isolé dépasse la capacité : cela reste rare, à anticiper les jours de forte demande.</p>' : ''}`;
    } else {
      body = '<p class="ft-det-note">Pas d\'historique de livraison pour ces hôtels : impossible d\'estimer la charge de ce passage.</p>';
    }
    const k = run.known;
    const known = k ? `
      <div class="ft-det-known">
        <h6>Déjà commandé pour ce passage ${badge(k.verdict)}</h6>
        <p>${plural(k.orders, 'commande', 'commandes')} reçue${k.orders > 1 ? 's' : ''} : ${fmt(k.linenKg)} kg de linge, ${fmt(k.volumeM3)} m³, ${plural(k.carts, 'chariot', 'chariots')} — soit ${fmt(k.weightKg)} kg avec les chariots vides.</p>
        ${k.dims.map(d => gauge(d, true)).join('')}
      </div>` : '';
    const sug = tour.suggestions.length ? `<p class="ft-det-sug">Plus adapté${tour.suggestions.length > 1 ? 's' : ''} : ${tour.suggestions.map(s => `<b>${esc(s.name)}</b> (${fmt(s.volumeM3)} m³, ${VERDICT[s.verdict][0].toLowerCase()})`).join(', ')}. À rattacher au chauffeur dans Équipement.</p>` : '';
    const warn = tour.warnings.length ? `<ul class="ft-warn">${tour.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    const clients = tour.clients.length ? `
      <details class="ft-det-cl"><summary>Historique par hôtel</summary>
        <table><thead><tr><th scope="col">Hôtel</th><th scope="col">Livraisons / semaine</th><th scope="col">Poids moyen</th><th scope="col">Volume moyen</th></tr></thead><tbody>
        ${tour.clients.map(c => `<tr><th scope="row">${esc(c.societe)}</th><td>${c.deliveries ? fmt(c.perWeek) : '–'}</td><td>${c.avgWeightKg != null ? `${fmt(c.avgWeightKg)} kg` : '–'}</td><td>${c.avgVolumeL != null ? `${fmt(c.avgVolumeL, 0)} L` : '–'}</td></tr>`).join('')}
        </tbody></table></details>` : '';
    return `
      <div class="ft-det ${run.verdict}">
        <div class="ft-det-head"><h5>${esc(longDate(run.date))} · ${esc(tour.name)}</h5>${badge(run.verdict)}</div>
        <p class="ft-det-sub">${esc(sub)}</p>
        ${lim ? `<p class="ft-det-lim">${esc(lim)}</p>` : ''}
        ${body}${known}${sug}${warn}${clients}
      </div>`;
  }

  function summary() {
    const c = { ok: 0, juste: 0, depasse: 0, inconnu: 0 };
    for (const r of fc.runs) c[r.verdict] += 1;
    const parts = [];
    if (c.depasse) parts.push(`${c.depasse} trop chargé${c.depasse > 1 ? 's' : ''}`);
    if (c.juste) parts.push(`${c.juste} juste${c.juste > 1 ? 's' : ''}`);
    if (c.inconnu) parts.push(`${c.inconnu} sans données`);
    return fc.runs.length ? `${fc.runs.length} passage${fc.runs.length > 1 ? 's' : ''}${parts.length ? ` dont ${parts.join(', ')}` : ' : tout passe'}` : 'aucune tournée active';
  }

  function render() {
    const box = document.getElementById('ft-forecast');
    if (!box) return;
    if (error) { box.innerHTML = `<p class="ft-err" role="alert">${esc(error)}</p>`; return; }
    if (!fc) { box.innerHTML = '<p class="ft-empty">Calcul des prévisions…</p>'; return; }
    if (!sel || !fc.runs.some(r => `${r.date}|${r.tourId}` === sel)) sel = fc.runs.length ? `${fc.runs[0].date}|${fc.runs[0].tourId}` : '';
    box.innerHTML = `
      <details class="ft-fc" ${open ? 'open' : ''}>
        <summary>Prochains passages et capacité du camion <span>${esc(summary())}</span></summary>
        <div class="ft-fc-bar">
          <label for="ft-fc-days">Horizon</label>
          <select id="ft-fc-days"><option value="14" ${days === 14 ? 'selected' : ''}>2 semaines</option><option value="28" ${days === 28 ? 'selected' : ''}>4 semaines</option><option value="56" ${days === 56 ? 'selected' : ''}>8 semaines</option></select>
          <span class="ft-fc-legend"><span class="ft-badge ok"><i aria-hidden="true">✓</i>Large</span><span class="ft-badge juste"><i aria-hidden="true">!</i>Juste</span><span class="ft-badge depasse"><i aria-hidden="true">✕</i>Trop chargé</span></span>
        </div>
        ${fc.runs.length ? calendar() : '<p class="ft-empty">Aucune tournée active : créez-en une ci-dessous pour voir ses prochains passages.</p>'}
        <div class="ft-fc-detail" aria-live="polite">${fc.runs.length ? detail() : ''}</div>
      </details>`;
  }

  async function refresh() {
    const mine = ++seq;
    try { const data = await fetchForecast(); if (mine !== seq) return; fc = data; error = ''; }
    catch (err) { if (mine !== seq) return; error = `Prévisions indisponibles : ${err.message}`; }
    render();
  }

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('#ft-forecast [data-ft-run]');
    if (!chip) return;
    sel = chip.dataset.ftRun; render();
    const el = document.querySelector(`#ft-forecast [data-ft-run="${sel}"]`);
    if (el) el.focus({ preventScroll: true });
  });
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'ft-fc-days') return;
    days = Number(e.target.value) || 28; refresh();
  });
  document.addEventListener('toggle', (e) => { if (e.target.matches && e.target.matches('#ft-forecast .ft-fc')) open = e.target.open; }, true);

  window.TourForecast = { refresh };
})();
