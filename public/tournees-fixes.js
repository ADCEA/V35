// Logistique → Tournées fixes : le chef planifie à l'avance ses tournées (jours, chauffeur, hôtels dans l'ordre de passage).
// Chaque changement est enregistré tout de suite ; le serveur refuse un hôtel présent dans deux tournées le même jour.
// En dessous, le planning d'un jour (demain par défaut) montre qui passe où et quelles commandes sont déjà rattachées.
(function () {
  const BASE = '/api/admin/logistics/tours';
  const DAYS = [[1, 'L', 'lundi'], [2, 'M', 'mardi'], [3, 'M', 'mercredi'], [4, 'J', 'jeudi'], [5, 'V', 'vendredi'], [6, 'S', 'samedi'], [7, 'D', 'dimanche']];
  const STATUS = { recue: 'reçue', traitement: 'en traitement', prete: 'prête' };
  let state = { tours: [], clients: [], drivers: [], today: '' };
  let planDate = ''; let errors = {}; let busy = false;
  let trafficOn = false;     // le trafic en temps réel est-il activé sur le serveur ? (clé TomTom présente)
  const eta = {};            // tournée -> { date, time, loading, error, data } : dernier calcul « durée avec trafic »

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function req(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }
  const status = (text, bad) => { const el = document.getElementById('ft-status'); if (el) { el.textContent = text; el.classList.toggle('bad', !!bad); } };
  const addDay = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  const hm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);
  /** Prochain jour de passage de la tournée (aujourd'hui compris), sinon demain. */
  function nextRun(t) {
    const late = new Date().getHours() >= 7;   // l'heure proposée (7 h) est déjà passée aujourd'hui
    for (let i = late ? 1 : 0; i < 9; i++) {
      const iso = addDay(state.today, i);
      const wd = (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;   // 1 = lundi … 7 = dimanche
      if (t.weekdays.includes(wd)) return iso;
    }
    return addDay(state.today, 1);
  }

  function etaResult(d, askedAt) {
    const t = d.totals;
    const nowNote = askedAt && askedAt < Date.now() - 10 * 60000 ? ' <em>(l\'heure choisie est passée : calcul au départ de maintenant)</em>' : '';
    const head = t ? `<p class="ft-eta-sum">Départ <b>${esc(hm(d.departAt))}</b>${nowNote} · ${esc(dur(t.driveMin))} de route (${esc(String(t.km).replace('.', ','))} km)${t.delayMin >= 2 ? ` <span class="late">dont +${esc(t.delayMin)} min de trafic</span>` : ' · circulation fluide'} · ${d.forecast ? 'trafic prévu à cette heure' : 'trafic en direct'}</p>` : '';
    const rows = d.stops.map((s, i) => `<li><span>${i + 1}. ${esc(s.items.map(it => it.societe).join(', '))}</span><b>${esc(hm(s.etaAt))}</b></li>`).join('')
      + (d.backToDepot ? `<li><span>Retour au dépôt</span><b>${esc(hm(d.backToDepot.etaAt))}</b></li>` : '');
    return `${head}${rows ? `<ol>${rows}</ol>` : ''}${d.note ? `<p class="ft-empty">${esc(d.note)}</p>` : ''}
      ${d.missing && d.missing.length ? `<p class="miss">Adresse pas encore localisée, hôtel non compté : ${esc(d.missing.map(m => m.societe).join(', '))}.</p>` : ''}
      ${d.trimmed ? '<p class="miss">Tournée très longue : seuls les premiers hôtels sont calculés.</p>' : ''}
      <p class="ft-empty">Conduite seule : le temps passé chez chaque hôtel n'est pas compté. Adresses d'après les dernières commandes.</p>`;
  }

  function etaHtml(t) {
    if (!trafficOn || !t.clients.length) return '';
    const f = eta[t.id] || (eta[t.id] = { date: nextRun(t), time: '07:00', loading: false, error: '', data: null });
    return `<div class="ft-eta">
      <div class="ft-eta-bar"><span>Durée avec le trafic, départ du dépôt</span>
        <input type="date" value="${esc(f.date)}" data-ft-eta-date aria-label="Date de départ">
        <input type="time" value="${esc(f.time)}" data-ft-eta-time aria-label="Heure de départ">
        <button type="button" class="btn-secondary" data-ft-eta ${f.loading ? 'disabled' : ''} style="width:auto;padding:6px 12px;font-size:12px;">${f.loading ? 'Calcul…' : 'Calculer'}</button></div>
      ${f.error ? `<p class="ft-err" role="alert">${esc(f.error)}</p>` : ''}
      ${f.data ? `<div class="ft-eta-out">${etaResult(f.data, f.askedAt)}</div>` : ''}
    </div>`;
  }

  async function runEta(t) {
    const f = eta[t.id];
    if (!f || f.loading) return;
    const when = f.date && f.time ? new Date(`${f.date}T${f.time}:00`) : null;
    if (!when || Number.isNaN(when.getTime())) { f.error = 'Choisissez la date et l\'heure de départ.'; return renderTours(); }
    f.loading = true; f.error = ''; f.askedAt = when.getTime(); renderTours();
    try { f.data = await req('GET', `/api/admin/traffic/tour/${encodeURIComponent(t.id)}/eta?departAt=${encodeURIComponent(when.toISOString())}`); }
    catch (err) { f.error = err.message; f.data = null; }
    f.loading = false; renderTours();
  }

  function warnings(t) {
    const w = [];
    if (!t.driverId) w.push('Choisissez un chauffeur : sans chauffeur, aucune commande n\'est affectée.');
    if (!t.weekdays.length) w.push('Cochez au moins un jour de passage.');
    if (!t.clients.length) w.push('Ajoutez les hôtels de cette tournée.');
    return w;
  }

  function tourHtml(t) {
    const used = new Set(t.clients.map(c => c.id));
    const free = state.clients.filter(c => !used.has(c.id));
    const warn = warnings(t);
    return `
      <section class="ft-tour ${t.active ? '' : 'off'}" data-tour="${t.id}">
        <div class="ft-row">
          <div class="field ft-name"><label for="ft-name-${t.id}">Nom</label><input id="ft-name-${t.id}" maxlength="60" value="${esc(t.name)}" data-ft-name></div>
          <div class="field ft-driver"><label for="ft-drv-${t.id}">Chauffeur</label>
            <select id="ft-drv-${t.id}" data-ft-driver><option value="">— Aucun —</option>${state.drivers.map(d => `<option value="${d.id}" ${d.id === t.driverId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
          <label class="ft-active"><input type="checkbox" data-ft-active ${t.active ? 'checked' : ''}> Active</label>
          <button type="button" class="ft-del" data-ft-delete aria-label="Supprimer la tournée ${esc(t.name)}" title="Supprimer la tournée">Supprimer</button>
        </div>
        <div class="ft-days" role="group" aria-label="Jours de passage">
          ${DAYS.map(([n, letter, full]) => `<button type="button" class="ft-day" data-ft-day="${n}" aria-pressed="${t.weekdays.includes(n)}" aria-label="${full}" title="${full}">${letter}</button>`).join('')}
          <span class="ft-days-note">${t.weekdays.length ? DAYS.filter(d => t.weekdays.includes(d[0])).map(d => d[2]).join(', ') : 'aucun jour choisi'}</span>
        </div>
        ${t.clients.length ? `<ol class="ft-clients">${t.clients.map((c, i) => `
          <li data-client="${c.id}">
            <span class="ft-n">${i + 1}</span>
            <span class="ft-c"><b>${esc(c.societe)}</b><small>${esc(c.adresse)}</small></span>
            <button type="button" data-ft-up aria-label="Passer ${esc(c.societe)} avant" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" data-ft-down aria-label="Passer ${esc(c.societe)} après" ${i === t.clients.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" data-ft-remove aria-label="Retirer ${esc(c.societe)} de la tournée">✕</button>
          </li>`).join('')}</ol>` : '<p class="ft-empty">Aucun hôtel dans cette tournée.</p>'}
        <div class="ft-add">
          <select aria-label="Hôtel à ajouter" data-ft-pick><option value="">Ajouter un hôtel…</option>${free.map(c => `<option value="${c.id}">${esc(c.societe)}</option>`).join('')}</select>
          <button type="button" class="btn-secondary" data-ft-add style="width:auto;padding:6px 12px;font-size:12px;">Ajouter</button>
          <span class="ft-count">${t.pendingOrders ? `${t.pendingOrders} commande${t.pendingOrders > 1 ? 's' : ''} en cours affectée${t.pendingOrders > 1 ? 's' : ''}` : ''}</span>
        </div>
        ${etaHtml(t)}
        ${warn.length && t.active ? `<ul class="ft-warn">${warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${errors[t.id] ? `<p class="ft-err" role="alert">${esc(errors[t.id])}</p>` : ''}
      </section>`;
  }

  function renderTours() {
    const root = document.getElementById('ft-root');
    if (!root) return;
    root.innerHTML = state.tours.length ? state.tours.map(tourHtml).join('') : '<p class="ft-empty">Aucune tournée fixe pour le moment. Créez-en une ci-dessous.</p>';
  }

  async function renderPlan() {
    const box = document.getElementById('ft-plan');
    if (!box) return;
    if (!planDate) planDate = addDay(state.today, 1);
    let plan;
    try { plan = await req('GET', `${BASE}/plan?date=${encodeURIComponent(planDate)}`); }
    catch (err) { box.innerHTML = `<p class="ft-err">${esc(err.message)}</p>`; return; }
    const rows = plan.tours.map(t => `
      <div class="ft-plan-tour">
        <div class="ft-plan-head"><b>${esc(t.name)}</b><span>${t.driverName ? esc(t.driverName) : '<em>sans chauffeur</em>'}</span></div>
        ${t.stops.length ? `<ol>${t.stops.map(s => `
          <li><span class="ft-n">${s.position}</span><span class="ft-c"><b>${esc(s.societe)}</b></span>
            <span class="ft-orders">${s.orders.length ? s.orders.map(o => `<i class="ft-o ${o.status}">${esc(o.ticket)} · ${STATUS[o.status] || o.status}</i>`).join('') : '<small>pas de commande en cours</small>'}</span></li>`).join('')}</ol>` : '<p class="ft-empty">Aucun hôtel.</p>'}
      </div>`).join('');
    box.innerHTML = `
      <details class="ft-plan" ${plan.tours.length ? 'open' : ''}>
        <summary>Planning du ${esc(longDate(plan.date))} <span>${plan.tours.length ? `${plan.tours.length} tournée${plan.tours.length > 1 ? 's' : ''}` : 'aucune tournée ce jour-là'}</span></summary>
        <div class="ft-plan-bar">
          <button type="button" class="btn-secondary" data-ft-date="-1" aria-label="Jour précédent">‹</button>
          <input type="date" id="ft-plan-date" value="${esc(plan.date)}" aria-label="Date du planning">
          <button type="button" class="btn-secondary" data-ft-date="1" aria-label="Jour suivant">›</button>
          <button type="button" class="btn-secondary" data-ft-date="tomorrow">Demain</button>
          <button type="button" class="btn-secondary" id="ft-apply" title="Affecte tout de suite les commandes en attente à leur tournée">Affecter les commandes</button>
        </div>
        ${rows || '<p class="ft-empty">Aucune tournée active ne roule ce jour-là.</p>'}
      </details>`;
  }

  async function load() {
    try { trafficOn = !!(await req('GET', '/api/admin/traffic/status')).enabled; } catch { trafficOn = false; }
    try {
      state = await req('GET', BASE);
      status(state.tours.length ? `${state.tours.filter(t => t.active).length} active${state.tours.filter(t => t.active).length > 1 ? 's' : ''} sur ${state.tours.length}` : '');
      renderTours(); await renderPlan();
    } catch (err) { status(`Tournées indisponibles : ${err.message}`, true); }
  }

  async function save(id, patch) {
    if (busy) return;
    busy = true; delete errors[id];
    try {
      const out = await req('PUT', `${BASE}/${id}`, patch);
      const i = state.tours.findIndex(t => t.id === id);
      if (i >= 0) state.tours[i] = out.tour;
      if (eta[id]) eta[id].data = null;
      status('Enregistré');
    } catch (err) {
      errors[id] = err.message; status('Non enregistré', true);
    } finally { busy = false; }
    renderTours(); renderPlan();
  }

  const tourOf = (el) => { const sec = el.closest('[data-tour]'); return sec ? state.tours.find(t => t.id === Number(sec.dataset.tour)) : null; };

  document.addEventListener('click', async (e) => {
    const root = e.target.closest('#ft-root, #ft-plan, .ft-new');
    if (!root) return;
    const date = e.target.closest('[data-ft-date]');
    if (date) {
      const v = date.dataset.ftDate;
      planDate = v === 'tomorrow' ? addDay(state.today, 1) : addDay(planDate || addDay(state.today, 1), Number(v));
      return renderPlan();
    }
    if (e.target.closest('#ft-apply')) {
      try { const r = await req('POST', `${BASE}/apply`); status(r.assigned ? `${r.assigned} commande${r.assigned > 1 ? 's' : ''} affectée${r.assigned > 1 ? 's' : ''}` : 'Rien à affecter'); await load(); }
      catch (err) { status(err.message, true); }
      return;
    }
    if (e.target.closest('#ft-new-btn')) {
      const input = document.getElementById('ft-new-name');
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      try { await req('POST', BASE, { name, active: true }); input.value = ''; await load(); }
      catch (err) { status(err.message, true); }
      return;
    }
    const t = tourOf(e.target);
    if (!t) return;
    if (e.target.closest('[data-ft-eta]')) return runEta(t);
    const li = e.target.closest('li[data-client]');
    const ids = t.clients.map(c => c.id);
    const day = e.target.closest('[data-ft-day]');
    if (day) {
      const n = Number(day.dataset.ftDay);
      return save(t.id, { weekdays: t.weekdays.includes(n) ? t.weekdays.filter(d => d !== n) : [...t.weekdays, n] });
    }
    if (e.target.closest('[data-ft-delete]')) {
      const msg = `Supprimer la tournée « ${t.name} » ? Les commandes qu'elle avait affectées redeviennent « non assigné ».`;
      if (!confirm(msg)) return;
      try { await req('DELETE', `${BASE}/${t.id}`); await load(); } catch (err) { status(err.message, true); }
      return;
    }
    if (e.target.closest('[data-ft-add]')) {
      const sel = e.target.closest('.ft-add').querySelector('[data-ft-pick]');
      if (!sel.value) { sel.focus(); return; }
      return save(t.id, { clientIds: [...ids, Number(sel.value)] });
    }
    if (li) {
      const cid = Number(li.dataset.client); const i = ids.indexOf(cid);
      if (e.target.closest('[data-ft-remove]')) return save(t.id, { clientIds: ids.filter(x => x !== cid) });
      const to = e.target.closest('[data-ft-up]') ? i - 1 : e.target.closest('[data-ft-down]') ? i + 1 : null;
      if (to != null && to >= 0 && to < ids.length) { const next = ids.slice(); [next[i], next[to]] = [next[to], next[i]]; return save(t.id, { clientIds: next }); }
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'ft-plan-date') { if (e.target.value) { planDate = e.target.value; renderPlan(); } return; }
    const t = tourOf(e.target);
    if (!t || !e.target.closest('#ft-root')) return;
    if (e.target.matches('[data-ft-name]')) { const v = e.target.value.trim(); if (v && v !== t.name) save(t.id, { name: v }); else e.target.value = t.name; }
    else if (e.target.matches('[data-ft-driver]')) save(t.id, { driverId: e.target.value ? Number(e.target.value) : null });
    else if (e.target.matches('[data-ft-active]')) save(t.id, { active: e.target.checked });
    else if (e.target.matches('[data-ft-eta-date]') && eta[t.id]) eta[t.id].date = e.target.value;
    else if (e.target.matches('[data-ft-eta-time]') && eta[t.id]) eta[t.id].time = e.target.value;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'ft-new-name') { e.preventDefault(); document.getElementById('ft-new-btn').click(); }
  });

  window.FixedTours = { show: load };
})();
