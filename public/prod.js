// Administration → Atelier : l'atelier du jour, les lots, les machines, les heures par poste, le tableau de bord et les réglages.
// Dépend de api() et escHtml() (app.js) et de Bill (fenêtres, messages) chargé avant ce fichier.
(function () {
  'use strict';
  const BASE = '/api/admin/atelier';
  const e = (s) => escHtml(s == null ? '' : String(s));
  const get = (p) => api('GET', BASE + p);
  const post = (p, b) => api('POST', BASE + p, b || {});
  const put = (p, b) => api('PUT', BASE + p, b || {});
  const del = (p) => api('DELETE', BASE + p);
  const toast = (m, bad) => Bill.toast(m, bad);
  const NF1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const NF0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const EUR2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const EUR0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const TIME = { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' };
  const hm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', TIME);
  const nowHm = () => new Date().toLocaleTimeString('fr-FR', TIME);
  const hLong = (min) => (min ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : '0 h');
  const dur = (min) => (min >= 60 ? hLong(min) : `${min} min`);
  const cents = (c) => (c == null ? '—' : EUR2.format(c / 100));
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const monday = (d) => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const dFr = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC' });
  const dLong = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  const dShort = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'numeric' });
  const TABS = [['today', 'Aujourd\'hui'], ['lots', 'Lots'], ['machines', 'Machines'], ['hours', 'Heures'], ['dash', 'Tableau de bord'], ['settings', 'Réglages']];
  const STAGE_ORDER = ['lavage', 'sechage', 'finition'];

  const S = { tab: 'today', day: null, ov: null, ref: null, range: null, status: '', q: '', timer: null };
  const root = () => document.getElementById('atelier-root');
  const body = () => document.getElementById('pr-body');
  const visible = () => { const v = document.getElementById('admin-view-atelier'); return v && v.style.display !== 'none'; };
  const stageName = (s) => ({ lavage: 'Lavage', sechage: 'Séchage', finition: 'Finition' }[s] || s);

  function shell() {
    root().innerHTML = `<div class="rh pr">
      <div class="rh-tabs" role="tablist">${TABS.map(([id, label]) => `<button type="button" role="tab" class="rh-tab" data-tab="${id}">${label}</button>`).join('')}</div>
      <div id="pr-body"></div></div>`;
    root().querySelector('.rh-tabs').addEventListener('click', (ev) => { const t = ev.target.closest('[data-tab]'); if (t) go(t.dataset.tab); });
  }

  async function go(tab) {
    S.tab = tab;
    root().querySelectorAll('.rh-tab').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
    body().innerHTML = '<p class="empty-note">Chargement…</p>';
    try {
      if (tab === 'today') await paintToday();
      else if (tab === 'lots') await paintLots();
      else if (tab === 'machines') await paintMachines();
      else if (tab === 'hours') await paintHours();
      else if (tab === 'dash') await paintDash();
      else await paintSettings();
    } catch (err) { body().innerHTML = `<p class="rh-err">${e(err.message)}</p>`; }
  }
  const refreshTab = () => go(S.tab);

  window.renderAtelierView = async function () {
    if (!body()) shell();
    if (!S.day) S.day = today();
    await go(S.tab);
    clearInterval(S.timer);
    S.timer = setInterval(async () => {
      if (!visible() || document.hidden || S.tab !== 'today' || S.day !== today() || document.querySelector('.bl-modal-back')) return;
      try { await paintToday(true); } catch (_) { /* on réessaie au prochain passage */ }
    }, 30000);
  };

  /** Machines, types, programmes : chargés une fois, rafraîchis au besoin. */
  async function refData(force) {
    if (!S.ref || force || Date.now() - S.ref.at > 60000) { const o = await get('/overview'); S.ref = { at: Date.now(), machines: o.machines, linenTypes: o.linenTypes, programs: o.programs, settings: o.settings }; }
    return S.ref;
  }
  const opt = (v, label, sel) => `<option value="${e(v)}"${sel ? ' selected' : ''}>${e(label)}</option>`;

  // ---------- étiquettes ----------
  const statusTag = (st) => (st === 'termine' ? '<span class="bl-tag ok">terminé</span>' : st === 'annule' ? '<span class="bl-tag draft">annulé</span>' : '<span class="bl-tag wait">en cours</span>');
  const clientsText = (l) => l.clients.map(c => c.societe).join(', ');
  function stagePills(l) {
    return STAGE_ORDER.map(st => {
      const steps = l.steps.filter(s => s.stage === st);
      if (!steps.length) return `<span class="pr-pill off">${e(stageName(st))}</span>`;
      const open = steps.some(s => s.open);
      return `<span class="pr-pill ${open ? 'run' : 'done'}">${e(stageName(st))}${steps.length > 1 ? ' ×' + steps.length : ''}</span>`;
    }).join('');
  }

  // ---------- aujourd'hui ----------
  async function paintToday(quiet) {
    const o = await get('/overview?day=' + S.day);
    S.ov = o; S.ref = { at: Date.now(), machines: o.machines, linenTypes: o.linenTypes, programs: o.programs, settings: o.settings };
    const isToday = S.day === o.today;
    const t = o.view.totals;
    const machineCard = (m) => {
      const st = m.step;
      if (m.state === 'down') return `<div class="pr-m down"><div class="pr-mh"><b>${e(m.name)}</b><span class="bl-tag bad">à l'arrêt</span></div><div class="pr-why">${e(m.incident.reason)}</div>
        <div class="pr-sub">depuis ${e(hm(m.incident.startedAt))}${m.incident.note ? ' · ' + e(m.incident.note) : ''}</div><button type="button" class="bl-btn small" data-up="${m.incident.id}">Remettre en service</button></div>`;
      if (m.state === 'running') {
        const bar = st.progress != null ? `<div class="pr-bar"><i style="width:${Math.round(st.progress * 100)}%"></i></div>` : '';
        const eta = st.stale ? '<div class="pr-sub late">Fin non saisie</div>' : st.plannedEndAt ? `<div class="pr-sub">fin prévue ${e(hm(st.plannedEndAt))}${st.remainingMin != null ? ' · reste ' + e(dur(st.remainingMin)) : ''}</div>` : `<div class="pr-sub">depuis ${e(hm(st.startedAt))}</div>`;
        return `<div class="pr-m run"><div class="pr-mh"><b>${e(m.name)}</b><span class="bl-tag wait">${st.stale ? 'à clôturer' : 'en marche'}</span></div>
          <div><button type="button" class="pr-code" data-lot="${st.lotId}">${e(st.lotCode)}</button> <span class="pr-sub">${e(st.linenType || '')}</span></div>
          <div class="pr-sub">${e(st.clients.join(', '))}</div><div class="pr-kg">${e(NF1.format(st.weightKg))} kg${m.capacityKg ? `<small>${Math.round(st.weightKg / m.capacityKg * 100)} %</small>` : ''}</div>${bar}${eta}</div>`;
      }
      return `<div class="pr-m"><div class="pr-mh"><b>${e(m.name)}</b><span class="bl-tag ok">libre</span></div>
        <div class="pr-sub">${m.todayCount ? e(m.todayCount + ' passage' + (m.todayCount > 1 ? 's' : '') + ' · ' + NF1.format(m.todayKg) + ' kg') : 'pas encore utilisée'}</div>
        <button type="button" class="bl-btn small" data-down="${m.id}">Signaler un arrêt</button></div>`;
    };
    const cols = isToday ? `<div class="pr-cols">${STAGE_ORDER.map(st => {
      const ms = o.machines.filter(m => m.bu === st);
      return `<section><h3 class="rh-h" style="margin-top:0">${e(stageName(st))} <span class="pr-sub">${ms.filter(m => m.state === 'running').length} / ${ms.length} en marche</span></h3>${ms.map(machineCard).join('') || '<p class="rh-none">Aucune machine.</p>'}</section>`;
    }).join('')}</div>` : '';
    const wait = isToday && o.waiting.length ? `<h3 class="rh-h">À reprendre <span class="pr-sub">lavage ou séchage terminé, étape suivante pas lancée</span></h3>
      <div class="rh-chips">${o.waiting.map(l => `<button type="button" class="pr-lotchip" data-lot="${l.id}"><b>${e(l.code)}</b> ${e(l.linenType || '')} · ${e(NF1.format(l.weightKg))} kg<small>${e(stageName(l.lastStage))} terminé · ${e(l.clients.join(', '))}</small></button>`).join('')}</div>` : '';
    const lots = o.view.lots;
    const table = lots.length ? `<div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Lot</th><th>Début</th><th>Type</th><th>Clients</th><th class="r">Kg</th><th>Parcours</th><th>État</th></tr></thead><tbody>
      ${lots.map(l => `<tr class="bl-row${l.status === 'annule' ? ' rh-off' : ''}" data-lot="${l.id}" tabindex="0"><td class="bl-mono">${e(l.code)}</td><td>${e(hm(l.steps.length ? l.steps[0].startedAt : l.createdAt))}</td><td>${e(l.linenType || '—')}</td>
        <td class="client">${e(clientsText(l))}</td><td class="r bl-num">${e(NF1.format(l.weightKg))}</td><td>${stagePills(l)}</td><td>${statusTag(l.status)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty-note">Aucun lot ce jour-là.</p>';
    body().innerHTML = `
      <div class="rh-bar"><button type="button" class="bl-btn" data-day="-1" aria-label="Jour précédent">‹</button>
        <input type="date" id="pr-day" value="${S.day}" aria-label="Jour affiché" style="height:34px;border:1px solid #C5D3E0;border-radius:6px;padding:0 8px">
        <button type="button" class="bl-btn" data-day="1" aria-label="Jour suivant"${isToday ? ' disabled' : ''}>›</button>
        ${isToday ? '' : '<button type="button" class="bl-btn small" data-day="0">Aujourd\'hui</button>'}
        <span class="rh-sub" style="margin-left:6px">${e(dLong(S.day))}${isToday ? ' · mis à jour à ' + e(nowHm()) : ''}</span><span class="rh-grow"></span>
        <button type="button" class="bl-btn primary" id="pr-newlot">+ Saisir un lot</button></div>
      <div class="pr-kpis">
        <div class="rh-kpi"><span>Lots</span><b>${NF0.format(t.lots)}</b></div>
        <div class="rh-kpi"><span>Kg lavés</span><b>${e(NF1.format(t.kgLavage))}</b></div>
        <div class="rh-kpi"><span>Kg séchés</span><b>${e(NF1.format(t.kgSechage))}</b></div>
        <div class="rh-kpi"><span>Kg en finition</span><b>${e(NF1.format(t.kgFinition))}</b></div></div>
      ${cols}${wait}<h3 class="rh-h">Lots du jour</h3>${table}
      <p class="rh-help">Les lots sont lancés depuis la tablette de l'atelier (Équipe → Badgeuses pour l'activer) ; ici on peut aussi les saisir ou les corriger après coup.</p>`;
    wireToday();
  }
  function wireToday() {
    const b = body();
    b.querySelectorAll('[data-day]').forEach(x => x.onclick = () => { const d = Number(x.dataset.day); S.day = d === 0 ? today() : addDays(S.day, d); if (S.day > today()) S.day = today(); refreshTab(); });
    const day = document.getElementById('pr-day');
    day.onchange = () => { if (day.value && day.value <= today()) { S.day = day.value; refreshTab(); } };
    document.getElementById('pr-newlot').onclick = () => lotForm();
    b.querySelectorAll('[data-lot]').forEach(x => { x.onclick = () => openLot(Number(x.dataset.lot)); if (x.tagName === 'TR') x.onkeydown = (ev) => { if (ev.key === 'Enter') openLot(Number(x.dataset.lot)); }; });
    b.querySelectorAll('[data-down]').forEach(x => x.onclick = () => downForm(Number(x.dataset.down)));
    b.querySelectorAll('[data-up]').forEach(x => x.onclick = async () => { try { await post(`/incidents/${x.dataset.up}/resolve`); toast('Machine remise en service.'); refreshTab(); } catch (err) { toast(err.message, true); } });
  }

  function downForm(machineId) {
    const m = S.ov.machines.find(x => x.id === machineId);
    Bill.modal({
      title: (m ? m.name : 'Machine') + ' à l\'arrêt', buttons: [{ label: 'Annuler' }, { label: 'Signaler l\'arrêt', primary: true, onClick: async (box) => {
        await post(`/machines/${machineId}/incidents`, { reason: box.$('#df-reason').value, note: box.$('#df-note').value });
        toast('Arrêt enregistré.'); refreshTab();
      } }],
      body: `<div class="bl-field"><label for="df-reason">Cause *</label><select id="df-reason">${['Panne', 'Entretien', 'Manque d\'eau ou d\'énergie', 'Autre'].map(r => opt(r, r)).join('')}</select></div>
        <div class="bl-field"><label for="df-note">Précision</label><input id="df-note" maxlength="300"></div>`,
    });
  }

  // ---------- saisie d'un lot / d'un passage ----------
  const machOpts = (ref, stage, sel) => ref.machines.filter(m => m.bu === stage).map(m => opt(m.id, m.name + (m.capacityKg ? ` (${NF1.format(m.capacityKg)} kg)` : ''), Number(sel) === m.id)).join('');
  const progOpts = (ref, sel) => opt('', '— aucun —', !sel) + ref.programs.filter(p => p.active || p.id === sel).map(p => opt(p.id, p.name + (p.durationMin ? ` · ${p.durationMin} min` : ''), p.id === sel)).join('');

  /** Lignes de clients (liste ou nom libre, kilos facultatifs, commande liée) — état tenu en mémoire, formulaire redessiné à chaque changement. */
  function clientRows(box, choices, initial) {
    const rows = initial.length ? initial.map(c => ({ ...c })) : [{ clientId: '', societe: '', kg: '', orderId: '' }];
    const host = box.$('#lf-clients');
    const draw = () => {
      host.innerHTML = rows.map((r, i) => {
        const cl = r.clientId ? choices.find(c => c.id === Number(r.clientId)) : null;
        const orders = cl && cl.orders.length ? `<select data-f="orderId" data-i="${i}">${opt('', '— commande —', !r.orderId)}${cl.orders.map(o => opt(o.id, o.ticket, Number(r.orderId) === o.id)).join('')}</select>` : '';
        return `<div class="pr-crow"><select data-f="clientId" data-i="${i}" aria-label="Client">${opt('', '— autre client (nom libre) —', !r.clientId)}${choices.map(c => opt(c.id, c.societe, Number(r.clientId) === c.id)).join('')}</select>
          ${r.clientId ? '' : `<input data-f="societe" data-i="${i}" placeholder="Nom du client" maxlength="120" value="${e(r.societe)}">`}${orders}
          <input data-f="kg" data-i="${i}" inputmode="decimal" placeholder="kg" style="width:80px" value="${e(r.kg)}" aria-label="Kilos de ce client">
          ${rows.length > 1 ? `<button type="button" class="bl-btn small" data-rm="${i}" aria-label="Retirer ce client">✕</button>` : ''}</div>`;
      }).join('') + '<button type="button" class="bl-btn small" id="lf-addc">+ Ajouter un client</button>';
      host.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { rows.splice(Number(b.dataset.rm), 1); draw(); });
      host.querySelector('#lf-addc').onclick = () => { rows.push({ clientId: '', societe: '', kg: '', orderId: '' }); draw(); };
      host.querySelectorAll('select[data-f]').forEach(s => s.onchange = () => { const r = rows[Number(s.dataset.i)]; r[s.dataset.f] = s.value; if (s.dataset.f === 'clientId') r.orderId = ''; draw(); });
      host.querySelectorAll('input[data-f]').forEach(inp => inp.oninput = () => { rows[Number(inp.dataset.i)][inp.dataset.f] = inp.value; });
    };
    draw();
    return () => rows.filter(r => r.clientId || r.societe.trim()).map(r => ({ clientId: r.clientId ? Number(r.clientId) : undefined, societe: r.clientId ? undefined : r.societe.trim(), weightKg: r.kg || undefined, orderId: r.orderId ? Number(r.orderId) : undefined }));
  }

  async function lotForm(lot) {
    const [ref, ch] = await Promise.all([refData(), get('/choices')]);
    const choices = ch.clients;
    const editing = !!lot;
    let getClients;
    const buttons = [{ label: 'Annuler' }, { label: editing ? 'Enregistrer' : 'Créer le lot', primary: true, onClick: async (box) => {
      if (editing) {
        await put(`/lots/${lot.id}`, { linenTypeId: Number(box.$('#lf-type').value), note: box.$('#lf-note').value, clients: getClients() });
        toast('Lot modifié.'); box.close(); await openLot(lot.id); refreshTab(); return true;
      }
      const date = box.$('#lf-date').value, start = box.$('#lf-start').value, end = box.$('#lf-end').value;
      const r = await post('/lots', { linenTypeId: Number(box.$('#lf-type').value), clients: getClients(), weightKg: box.$('#lf-kg').value, machineId: Number(box.$('#lf-machine').value),
        programId: box.$('#lf-prog').value || undefined, note: box.$('#lf-note').value, date, start, end });
      toast('Lot ' + r.lot.code + ' créé.'); box.close(); refreshTab(); openLot(r.lot.id); return true;
    } }];
    const types = ref.linenTypes.filter(t => t.active || (lot && t.id === lot.linenTypeId));
    Bill.modal({
      title: editing ? 'Modifier le lot ' + lot.code : 'Saisir un lot', wide: true, buttons,
      body: `<div class="bl-row2"><div class="bl-field"><label for="lf-type">Type de linge *</label><select id="lf-type">${types.map(t => opt(t.id, t.label, lot && t.id === lot.linenTypeId)).join('')}</select></div>
        <div class="bl-field"><label for="lf-note">Remarque</label><input id="lf-note" maxlength="300" value="${e(lot && lot.note)}"></div></div>
        <div class="bl-field"><label>Clients * <span class="bl-faint">— plusieurs si le lot est mélangé ; les kilos par client sont facultatifs</span></label><div id="lf-clients"></div></div>
        ${editing ? '' : `<div class="bl-row2"><div class="bl-field"><label for="lf-machine">Laveuse *</label><select id="lf-machine">${machOpts(ref, 'lavage')}</select></div>
          <div class="bl-field"><label for="lf-kg">Poids chargé (kg) *</label><input id="lf-kg" inputmode="decimal" placeholder="24,5"></div></div>
          <div class="bl-field"><label for="lf-prog">Programme</label><select id="lf-prog">${progOpts(ref, null)}</select></div>
          <div class="bl-row2"><div class="bl-field"><label for="lf-date">Jour *</label><input id="lf-date" type="date" value="${S.day || today()}" max="${today()}"></div>
          <div class="bl-field"><label>Début * / fin</label><div style="display:flex;gap:8px"><input id="lf-start" type="time" value="${nowHm()}" aria-label="Début"><input id="lf-end" type="time" aria-label="Fin"></div></div></div>
          <p class="rh-help">Sans heure de fin, le lavage est « en cours » (possible seulement aujourd'hui).</p>`}`,
      onOpen: (box) => {
        getClients = clientRows(box, choices, lot ? lot.clients.map(c => ({ clientId: c.clientId || '', societe: c.societe, kg: c.weightAuto ? '' : (c.weightKg || ''), orderId: c.orderId || '' })) : []);
        if (!editing) {
          const sync = () => { const m = ref.machines.find(x => x.id === Number(box.$('#lf-machine').value)); if (m && m.capacityKg && !box.$('#lf-kg').value) box.$('#lf-kg').placeholder = NF1.format(m.capacityKg); };
          box.$('#lf-machine').onchange = sync; sync();
        }
      },
    });
  }

  async function stepForm(lot, step) {
    const ref = await refData();
    const editing = !!step;
    const stage0 = step ? step.stage : (lot.lastStage === 'lavage' ? 'sechage' : lot.lastStage === 'sechage' ? 'finition' : 'sechage');
    const sd = step ? new Date(step.startedAt).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }) : today();
    Bill.modal({
      title: editing ? 'Corriger le passage' : 'Ajouter un passage', wide: false,
      buttons: [{ label: 'Annuler' }, { label: 'Enregistrer', primary: true, onClick: async (box) => {
        const date = box.$('#sf-date').value, start = box.$('#sf-start').value, end = box.$('#sf-end').value;
        const stage = editing ? step.stage : box.$('#sf-stage').value;
        const payload = { machineId: Number(box.$('#sf-machine').value), weightKg: box.$('#sf-kg').value, date, start, end, ...(stage === 'lavage' ? { programId: box.$('#sf-prog').value || null } : {}) };
        const r = editing ? await put(`/steps/${step.id}`, payload) : await post(`/lots/${lot.id}/steps`, { ...payload, stage });
        toast('Passage enregistré.'); box.close(); lotModal(r.lot); refreshTab(); return true;
      } }],
      body: `${editing ? `<p class="rh-help" style="margin-top:0">${e(stageName(step.stage))} — lot ${e(lot.code)}</p>` : `<div class="bl-field"><label for="sf-stage">Étape *</label><select id="sf-stage">${STAGE_ORDER.map(s => opt(s, stageName(s), s === stage0)).join('')}</select></div>`}
        <div class="bl-field"><label for="sf-machine">Machine *</label><select id="sf-machine"></select></div>
        <div class="bl-row2"><div class="bl-field"><label for="sf-kg">Poids (kg) *</label><input id="sf-kg" inputmode="decimal" value="${e(step ? step.weightKg : lot.weightKg)}"></div>
        <div class="bl-field" id="sf-progbox"><label for="sf-prog">Programme</label><select id="sf-prog">${progOpts(ref, step ? step.programId : null)}</select></div></div>
        <div class="bl-row2"><div class="bl-field"><label for="sf-date">Jour *</label><input id="sf-date" type="date" value="${sd}" max="${today()}"></div>
        <div class="bl-field"><label>Début * / fin</label><div style="display:flex;gap:8px"><input id="sf-start" type="time" value="${step ? hm(step.startedAt) : nowHm()}" aria-label="Début"><input id="sf-end" type="time" value="${step && step.endedAt ? hm(step.endedAt) : ''}" aria-label="Fin"></div></div></div>
        <p class="rh-help">Sans heure de fin, le passage est « en cours » (possible seulement aujourd'hui).</p>`,
      onOpen: (box) => {
        const draw = () => {
          const stage = editing ? step.stage : box.$('#sf-stage').value;
          box.$('#sf-machine').innerHTML = machOpts(ref, stage, step ? step.machineId : null);
          box.$('#sf-progbox').style.display = stage === 'lavage' ? '' : 'none';
        };
        if (!editing) box.$('#sf-stage').onchange = draw;
        draw();
      },
    });
  }

  // ---------- fiche d'un lot ----------
  async function openLot(id) {
    try { lotModal((await get('/lots/' + id)).lot); } catch (err) { toast(err.message, true); }
  }
  function lotModal(lot) {
    const c = lot.cost, content = lot.content;
    const steps = lot.steps.map(s => `<tr><td>${e(s.stageLabel)}${s.passes > 1 ? ` <span class="bl-faint">${s.pass}/${s.passes}</span>` : ''}</td><td>${e(s.machineName || '—')}</td>
      <td>${e(hm(s.startedAt))}${s.endedAt ? ' – ' + e(hm(s.endedAt)) : ' → <span class="bl-tag wait">' + (s.stale ? 'à clôturer' : 'en cours') + '</span>'}</td><td class="r bl-num">${e(dur(s.minutes))}</td>
      <td class="r bl-num">${e(NF1.format(s.weightKg))} kg</td><td>${e(s.programName || '')}</td>
      <td class="r"><button type="button" class="bl-btn small" data-editstep="${s.id}">Corriger</button>${s.open ? ` <button type="button" class="bl-btn small primary" data-endstep="${s.id}">Terminer</button>` : ''}</td></tr>`).join('');
    const gap = content.gap ? `<span class="bl-tag ${content.gap.withinTolerance ? 'ok' : 'bad'}">${content.gap.pct > 0 ? '+' : ''}${content.gap.pct} % vs théorique (tolérance ±${content.gap.tolerancePct} %)</span>` : '';
    const orders = content.orders.length ? content.orders.map(o => `<div class="pr-order"><b>${e(o.ticket)}</b>${o.deliveryDate ? ` <span class="bl-faint">livraison prévue ${e(dFr(o.deliveryDate))}</span>` : ''}
      <table class="bl-table rh-table" style="margin-top:6px"><tbody>${o.items.map(i => `<tr><td class="client">${e(i.name)}</td><td class="r bl-num">× ${i.qty}</td><td class="r bl-num">${i.totalKg != null ? e(NF1.format(i.totalKg)) + ' kg' : '<span class="bl-faint">poids non renseigné</span>'}</td></tr>`).join('')}</tbody></table></div>`).join('')
      : '<p class="rh-none">Aucune commande liée : rattachez-en une (Modifier) pour comparer le poids pesé au poids attendu.</p>';
    const kinds = { remarque: 'Remarque', probleme: 'Problème', relavage: 'Relavage' };
    const notes = lot.notes.map(n => `<li class="pr-note ${e(n.kind)}">${e(n.text)}<small>${e(kinds[n.kind] || n.kind)} · ${e(hm(n.at))}${n.who ? ' · ' + e(n.who) : ''}</small></li>`).join('');
    const costBox = c.totalCents || c.waterCents != null ? `<dl class="pr-dl"><dt>Eau</dt><dd>${cents(c.waterCents)}</dd><dt>Énergie</dt><dd>${cents(c.energyCents)}</dd><dt>Lessive</dt><dd>${cents(c.detergentCents)}</dd>
      <dt><b>Total estimé</b></dt><dd><b>${cents(c.totalCents)}</b>${c.perKgCents != null ? ` · ${cents(c.perKgCents)}/kg` : ''}</dd></dl>${c.complete ? '' : '<p class="rh-help">Estimation incomplète : renseignez les consommations du programme et les prix dans Réglages.</p>'}`
      : '<p class="rh-none">Pas d\'estimation : choisissez un programme de lavage (consommations et prix à renseigner dans Réglages).</p>';
    const canClose = lot.status === 'en_cours' && !lot.steps.some(s => s.open);
    Bill.modal({
      title: `Lot ${lot.code}`, wide: true, buttons: [{ label: 'Fermer' }],
      body: `<div class="pr-lothead">${statusTag(lot.status)} <span>${e(dLong(lot.day))}</span> <span class="bl-faint">${lot.createdBy ? 'lancé par ' + e(lot.createdBy) : 'saisi à la main'}</span></div>
        <div class="pr-two"><div><h4 class="rh-h" style="margin-top:6px">Contenu</h4>
          <dl class="pr-dl"><dt>Type de linge</dt><dd>${e(lot.linenType || '—')}</dd><dt>Poids lavé</dt><dd>${e(NF1.format(lot.weightKg))} kg</dd>
          <dt>Clients</dt><dd>${lot.clients.map(cl => `${e(cl.societe)}${cl.weightKg ? ` <span class="bl-faint">${e(NF1.format(cl.weightKg))} kg${cl.weightAuto ? '' : ''}</span>` : ''}${cl.orderTicket ? ` <span class="bl-tag draft">${e(cl.orderTicket)}</span>` : ''}`).join('<br>')}</dd>
          ${lot.note ? `<dt>Remarque</dt><dd>${e(lot.note)}</dd>` : ''}</dl></div>
          <div><h4 class="rh-h" style="margin-top:6px">Coût du lavage <span class="bl-faint" style="font-weight:400">estimé</span></h4>${costBox}</div></div>
        <h4 class="rh-h">Parcours</h4>
        <div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Étape</th><th>Machine</th><th>Heures</th><th class="r">Durée</th><th class="r">Poids</th><th>Programme</th><th></th></tr></thead><tbody>${steps}</tbody></table></div>
        <div class="rh-bar" style="margin-top:10px"><button type="button" class="bl-btn small" id="lm-addstep">+ Ajouter un passage</button></div>
        <h4 class="rh-h">Poids attendu ${gap}</h4>
        ${content.theoreticalKg ? `<p class="rh-help" style="margin-top:0">Poids des articles commandés (catalogue) : <b>${e(NF1.format(content.theoreticalKg))} kg</b> pour ${e(NF1.format(lot.weightKg))} kg pesés au lavage.</p>` : ''}${orders}
        <h4 class="rh-h">Remarques et qualité</h4>
        <ul class="pr-notes">${notes || '<li class="rh-none" style="list-style:none">Rien à signaler.</li>'}</ul>
        <div class="rh-bar"><select id="lm-kind" aria-label="Type de remarque">${Object.entries(kinds).map(([k, v]) => opt(k, v)).join('')}</select>
          <input id="lm-text" maxlength="400" placeholder="Ex. 3 draps à reprendre (taches)" style="flex:1;min-width:200px;height:34px;border:1px solid #C5D3E0;border-radius:6px;padding:0 8px"><button type="button" class="bl-btn small primary" id="lm-addnote">Ajouter</button></div>
        <div class="rh-bar" style="margin-top:18px;border-top:1px solid var(--line);padding-top:12px">
          <button type="button" class="bl-btn small" id="lm-edit">Modifier le lot</button>
          ${canClose ? '<button type="button" class="bl-btn small" id="lm-close">Terminer le lot</button>' : ''}${lot.status === 'termine' ? '<button type="button" class="bl-btn small" id="lm-reopen">Rouvrir</button>' : ''}
          ${lot.status !== 'annule' ? '<button type="button" class="bl-btn small danger" id="lm-cancel">Annuler le lot</button>' : ''}</div>`,
      onOpen: (box) => {
        const reload = async () => { box.close(); await openLot(lot.id); refreshTab(); };
        const run = (fn) => async () => { try { await fn(); } catch (err) { box.err(err.message); } };
        box.$('#lm-addstep').onclick = () => { box.close(); stepForm(lot, null); };
        box.el.querySelectorAll('[data-editstep]').forEach(b => b.onclick = () => { box.close(); stepForm(lot, lot.steps.find(s => s.id === Number(b.dataset.editstep))); });
        box.el.querySelectorAll('[data-endstep]').forEach(b => b.onclick = run(async () => { await post(`/steps/${b.dataset.endstep}/finish`); toast('Passage terminé.'); await reload(); }));
        box.$('#lm-addnote').onclick = run(async () => { await post(`/lots/${lot.id}/notes`, { kind: box.$('#lm-kind').value, text: box.$('#lm-text').value }); toast('Remarque ajoutée.'); await reload(); });
        box.$('#lm-edit').onclick = () => { box.close(); lotForm(lot); };
        const c1 = box.$('#lm-close'); if (c1) c1.onclick = run(async () => { await post(`/lots/${lot.id}/close`); toast('Lot terminé.'); await reload(); });
        const r1 = box.$('#lm-reopen'); if (r1) r1.onclick = run(async () => { await post(`/lots/${lot.id}/reopen`); toast('Lot rouvert.'); await reload(); });
        const x1 = box.$('#lm-cancel'); if (x1) x1.onclick = run(async () => {
          if (!(await Bill.confirm('Annuler le lot ' + lot.code + ' ?', 'Le lot sort des chiffres et libère ses machines. Utile pour une saisie faite par erreur.', 'Annuler le lot', true))) return;
          await post(`/lots/${lot.id}/cancel`); toast('Lot annulé.'); box.close(); refreshTab();
        });
      },
    });
  }

  // ---------- période ----------
  function presets() {
    const t = today(), mon = monday(t);
    const first = t.slice(0, 8) + '01';
    const prevLast = addDays(first, -1);
    return [['Aujourd\'hui', t, t], ['7 derniers jours', addDays(t, -6), t], ['Cette semaine', mon, t], ['Ce mois', first, t], ['Mois dernier', prevLast.slice(0, 8) + '01', prevLast]];
  }
  function rangeBar(extra) {
    if (!S.range) { const p = presets()[1]; S.range = { from: p[1], to: p[2] }; }
    const { from, to } = S.range;
    return `<div class="bl-filters rh-filters"><div class="presets">${presets().map(([l, a, b], i) => `<button type="button" class="bl-btn small${a === from && b === to ? ' primary' : ''}" data-preset="${i}">${e(l)}</button>`).join('')}</div>
      <div class="bl-field"><label for="pr-from">Du</label><input id="pr-from" type="date" value="${from}" max="${today()}"></div>
      <div class="bl-field"><label for="pr-to">Au</label><input id="pr-to" type="date" value="${to}" max="${today()}"></div>${extra || ''}</div>`;
  }
  function wireRange() {
    const b = body();
    b.querySelectorAll('[data-preset]').forEach(x => x.onclick = () => { const p = presets()[Number(x.dataset.preset)]; S.range = { from: p[1], to: p[2] }; refreshTab(); });
    const f = document.getElementById('pr-from'), t = document.getElementById('pr-to');
    const apply = () => { if (f.value && t.value && f.value <= t.value) { S.range = { from: f.value, to: t.value }; refreshTab(); } else toast('La fin de période précède le début.', true); };
    f.onchange = apply; t.onchange = apply;
  }

  // ---------- lots ----------
  async function paintLots() {
    const range = rangeBar(`<div class="bl-field"><label for="pr-status">État</label><select id="pr-status">${[['', 'Tous'], ['en_cours', 'En cours'], ['termine', 'Terminés'], ['annule', 'Annulés']].map(([v, l]) => opt(v, l, S.status === v)).join('')}</select></div>
      <div class="bl-field"><label for="pr-q">Recherche</label><input id="pr-q" type="search" placeholder="Code, client, type…" value="${e(S.q)}"></div>`);
    const { from, to } = S.range;
    const r = await get(`/lots?from=${from}&to=${to}&status=${S.status}&q=${encodeURIComponent(S.q)}`);
    const kg = r.lots.filter(l => l.status !== 'annule').reduce((a, l) => a + l.weightKg, 0);
    body().innerHTML = `${range}
      <p class="rh-sub" style="margin:0 0 10px">${r.lots.length} lot${r.lots.length > 1 ? 's' : ''} · ${e(NF1.format(kg))} kg lavés${r.truncated ? ' · liste tronquée, affinez la période' : ''}</p>
      ${r.lots.length ? `<div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Lot</th><th>Jour</th><th>Type</th><th>Clients</th><th class="r">Kg</th><th>Parcours</th><th>État</th></tr></thead><tbody>
        ${r.lots.map(l => `<tr class="bl-row${l.status === 'annule' ? ' rh-off' : ''}" data-lot="${l.id}" tabindex="0"><td class="bl-mono">${e(l.code)}</td><td>${e(dFr(l.day))}</td><td>${e(l.linenType || '—')}</td>
          <td class="client">${e(clientsText(l))}</td><td class="r bl-num">${e(NF1.format(l.weightKg))}</td><td>${stagePills(l)}</td><td>${statusTag(l.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-note">Aucun lot sur cette période.</p>'}`;
    wireRange();
    document.getElementById('pr-status').onchange = (ev) => { S.status = ev.target.value; refreshTab(); };
    let tm = null;
    document.getElementById('pr-q').oninput = (ev) => { clearTimeout(tm); tm = setTimeout(() => { S.q = ev.target.value; refreshTab(); }, 400); };
    body().querySelectorAll('tr[data-lot]').forEach(tr => { tr.onclick = () => openLot(Number(tr.dataset.lot)); tr.onkeydown = (ev) => { if (ev.key === 'Enter') openLot(Number(tr.dataset.lot)); }; });
  }

  // ---------- machines ----------
  async function paintMachines() {
    const t = today(), from = addDays(t, -29);
    const [st, ov, inc] = await Promise.all([get(`/stats?from=${from}&to=${t}`), get('/overview'), get(`/incidents?from=${from}&to=${t}`)]);
    S.ov = ov; S.ref = { at: Date.now(), machines: ov.machines, linenTypes: ov.linenTypes, programs: ov.programs, settings: ov.settings };
    const state = (m) => (m.state === 'down' ? '<span class="bl-tag bad">à l\'arrêt</span>' : m.state === 'running' ? '<span class="bl-tag wait">en marche</span>' : '<span class="bl-tag ok">libre</span>');
    const rows = ov.machines.map(m => {
      const s = st.machines.find(x => x.id === m.id) || {};
      return `<tr><td class="client">${e(m.name)}</td><td>${e(stageName(m.bu))}</td><td>${state(m)}</td><td class="r bl-num">${m.capacityKg ? e(NF1.format(m.capacityKg)) + ' kg' : '—'}</td>
        <td class="r bl-num">${s.passes || 0}</td><td class="r bl-num">${e(NF1.format(s.kg || 0))} kg</td><td class="r bl-num">${s.avgLoadPct != null ? s.avgLoadPct + ' %' : '—'}</td>
        <td class="r bl-num">${s.utilization != null ? Math.round(s.utilization * 100) + ' %' : '—'}</td><td class="r bl-num">${s.realKgh != null ? e(NF1.format(s.realKgh)) + ' kg/h' : '—'}${m.throughputKgh ? ` <span class="bl-faint">(prévu ${e(NF1.format(m.throughputKgh))})</span>` : ''}</td>
        <td class="r bl-num">${s.incidents ? s.incidents + ' · ' + e(dur(s.downMin)) : '—'}</td>
        <td class="r">${m.state === 'down' ? `<button type="button" class="bl-btn small" data-up="${m.incident.id}">Remettre en service</button>` : `<button type="button" class="bl-btn small" data-down="${m.id}">Signaler un arrêt</button>`}</td></tr>`;
    }).join('');
    body().innerHTML = `<p class="rh-sub" style="margin:0 0 10px">Chiffres des 30 derniers jours (${e(dFr(from))} – ${e(dFr(t))}). L'utilisation compte les heures de marche sur les jours où l'atelier a tourné, dans les horaires d'ouverture (${e(ov.settings.openFrom)}–${e(ov.settings.openTo)}).</p>
      <div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Machine</th><th>Étape</th><th>État</th><th class="r">Capacité</th><th class="r">Passages</th><th class="r">Kilos</th><th class="r">Charge moy.</th><th class="r">Utilisation</th><th class="r">Cadence réelle</th><th class="r">Arrêts</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="rh-help">Capacités et cadences (kg/h) se règlent dans Équipe → Machines. La cadence réelle est calculée sur les passages terminés.</p>
      <h3 class="rh-h">Arrêts et pannes</h3>
      ${inc.incidents.length ? `<div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Machine</th><th>Début</th><th>Fin</th><th class="r">Durée</th><th>Cause</th></tr></thead><tbody>
        ${inc.incidents.map(i => `<tr><td class="client">${e(i.machineName)}</td><td>${e(Bill.dtFr(i.startedAt))}</td><td>${i.endedAt ? e(Bill.dtFr(i.endedAt)) : '<span class="bl-tag bad">en cours</span>'}</td><td class="r bl-num">${e(dur(i.minutes))}</td><td>${e(i.reason)}${i.note ? ` <span class="bl-faint">· ${e(i.note)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-note">Aucun arrêt signalé sur 30 jours.</p>'}`;
    body().querySelectorAll('[data-down]').forEach(x => x.onclick = () => downForm(Number(x.dataset.down)));
    body().querySelectorAll('[data-up]').forEach(x => x.onclick = async () => { try { await post(`/incidents/${x.dataset.up}/resolve`); toast('Machine remise en service.'); refreshTab(); } catch (err) { toast(err.message, true); } });
  }

  // ---------- heures par poste ----------
  async function paintHours() {
    const range = rangeBar();
    const { from, to } = S.range;
    const h = await get(`/hours?from=${from}&to=${to}`);
    const priced = h.costCents > 0;
    const row = (label, sub, x) => `<tr><td class="client">${e(label)}${sub ? ` <span class="bl-faint">${e(sub)}</span>` : ''}</td><td class="r bl-num">${e(hLong(x.min))}</td>
      <td class="r bl-num">${x.kg ? e(NF1.format(x.kg)) + ' kg' : '—'}</td><td class="r bl-num">${x.kgPerHour != null ? e(NF1.format(x.kgPerHour)) + ' kg/h' : '—'}</td>
      <td class="r bl-num">${priced ? e(EUR0.format(x.costCents / 100)) : '—'}</td><td class="r bl-num">${x.costPerKgCents != null ? cents(x.costPerKgCents) : '—'}</td></tr>`;
    const bus = { lavage: 'Lavage', sechage: 'Séchage', finition: 'Finition', logistique: 'Logistique', admin: 'Administration' };
    body().innerHTML = `${range}
      <div class="pr-kpis"><div class="rh-kpi"><span>Heures pointées</span><b>${e(hLong(h.totalMin))}</b></div><div class="rh-kpi"><span>Coût de main-d'œuvre</span><b>${priced ? e(EUR0.format(h.costCents / 100)) : '—'}</b>${priced ? '' : '<small>Coût horaire à saisir dans Équipe</small>'}</div></div>
      <h3 class="rh-h">Par unité</h3>
      <div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Unité</th><th class="r">Heures</th><th class="r">Kilos traités</th><th class="r">Rendement</th><th class="r">Coût</th><th class="r">Coût au kilo</th></tr></thead><tbody>
        ${h.byBu.map(b => row(bus[b.bu] || b.bu, '', b)).join('')}</tbody></table></div>
      <h3 class="rh-h">Par poste</h3>
      <div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Poste</th><th class="r">Heures</th><th class="r">Kilos de la machine</th><th class="r">Rendement</th><th class="r">Coût</th><th class="r">Coût au kilo</th></tr></thead><tbody>
        ${h.byMachine.map(m => row(m.name || (bus[m.bu] || m.bu) + ' — toute l\'unité', m.name ? bus[m.bu] : '', m)).join('') || '<tr><td colspan="6" class="rh-none">Aucune heure pointée sur la période.</td></tr>'}</tbody></table></div>
      <p class="rh-help">Les heures viennent des pointages de la badgeuse. Le rendement rapporte les kilos passés sur l'unité ou la machine aux heures pointées dessus. Les corrections de pointages se font dans Équipe → Heures.</p>`;
    wireRange();
  }

  // ---------- tableau de bord ----------
  async function paintDash() {
    const range = rangeBar();
    const { from, to } = S.range;
    const s = await get(`/stats?from=${from}&to=${to}`);
    const target = s.targetCentsPerKg;
    const total = s.costPerKgCents != null ? s.costPerKgCents + (s.consumablesPerKgCents || 0) : null;
    const costCard = `<div class="rh-kpi"><span>Coût par kilo lavé</span><b>${total != null ? cents(total) : '—'}</b>
      <small>${total == null ? 'Saisissez le coût horaire des collaborateurs (Équipe) pour le calculer' : `${cents(s.costPerKgCents)} de main-d'œuvre${s.consumablesPerKgCents != null ? ` + ${cents(s.consumablesPerKgCents)} d'eau, d'énergie et de lessive` : ''}`}</small>
      ${total != null && target ? `<div class="pr-target ${total <= target ? 'ok' : 'late'}">${total <= target ? 'Sous' : 'Au-dessus de'} l'objectif de ${cents(target)}/kg</div>` : ''}</div>`;
    const maxKg = Math.max(1, ...s.daily.map(d => d.kgLavage));
    const chart = s.daily.some(d => d.kgLavage) ? `<div class="pr-chart" role="img" aria-label="Kilos lavés par jour">${s.daily.map(d => `<div class="pr-colw" title="${e(dFr(d.day))} : ${e(NF1.format(d.kgLavage))} kg lavés, ${e(NF1.format(d.kgSechage))} séchés, ${e(NF1.format(d.kgFinition))} en finition"><div class="pr-col" style="height:${Math.round(d.kgLavage / maxKg * 100)}%"></div><span>${s.days <= 31 ? e(dShort(d.day)) : ''}</span></div>`).join('')}</div>` : '<p class="empty-note">Aucun lot sur cette période.</p>';
    const bars = (list, unit, max) => list.map(x => `<div class="rh-burow"><span>${e(x.label)}</span><i style="width:${Math.max(2, Math.round(x.value / max * 100))}%"></i><b>${e(x.text)}</b><small>${unit ? e(unit(x)) : ''}</small></div>`).join('');
    const util = s.machines.filter(m => m.utilization != null);
    const maxType = Math.max(1, ...s.byType.map(x => x.kg)), maxCl = Math.max(1, ...s.byClient.map(x => x.kg));
    const labourRows = s.labour.map(l => `<tr><td class="client">${e(stageName(l.bu))}</td><td class="r bl-num">${e(hLong(l.minutes))}</td><td class="r bl-num">${e(NF1.format(l.kg))} kg</td><td class="r bl-num">${l.kgPerHour != null ? e(NF1.format(l.kgPerHour)) + ' kg/h' : '—'}</td><td class="r bl-num">${l.costCents ? e(EUR0.format(l.costCents / 100)) : '—'}</td><td class="r bl-num">${l.costPerKgCents != null ? cents(l.costPerKgCents) : '—'}</td></tr>`).join('');
    body().innerHTML = `${range}
      <div class="pr-kpis">${costCard}
        <div class="rh-kpi"><span>Kilos lavés</span><b>${e(NF1.format(s.kg.lavage))}</b><small>${s.lots} lot${s.lots > 1 ? 's' : ''} · ${s.activeDays} jour${s.activeDays > 1 ? 's' : ''} d'activité</small></div>
        <div class="rh-kpi"><span>Séchés · en finition</span><b>${e(NF0.format(s.kg.sechage))} · ${e(NF0.format(s.kg.finition))}</b><small>kg</small></div>
        <div class="rh-kpi"><span>Relavages · problèmes</span><b>${s.rewashes} · ${s.problems}</b><small>signalés sur les lots</small></div></div>
      <h3 class="rh-h">Kilos lavés par jour</h3>${chart}
      <h3 class="rh-h">Main-d'œuvre par étape</h3>
      <div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Étape</th><th class="r">Heures</th><th class="r">Kilos</th><th class="r">Rendement</th><th class="r">Coût</th><th class="r">Coût au kilo</th></tr></thead><tbody>${labourRows}</tbody></table></div>
      ${s.unpricedEmployees ? `<p class="rh-warn" style="margin-top:10px">${s.unpricedEmployees} collaborateur${s.unpricedEmployees > 1 ? 's' : ''} sans coût horaire : leur temps n'est pas valorisé (Équipe → Collaborateurs).</p>` : ''}
      <div class="pr-two" style="margin-top:6px"><div><h3 class="rh-h">Utilisation des machines</h3>${util.length ? bars(util.map(m => ({ label: m.name, value: m.utilization * 100, text: Math.round(m.utilization * 100) + ' %' })), null, 100) : '<p class="rh-none">Pas encore de passage sur la période.</p>'}</div>
        <div><h3 class="rh-h">Kilos par type de linge</h3>${s.byType.length ? bars(s.byType.map(x => ({ label: x.label, value: x.kg, text: NF1.format(x.kg) + ' kg' })), null, maxType) : '<p class="rh-none">—</p>'}</div></div>
      <h3 class="rh-h">Kilos par client</h3>${s.byClient.length ? bars(s.byClient.map(x => ({ label: x.label, value: x.kg, text: NF1.format(x.kg) + ' kg' })), null, maxCl) : '<p class="rh-none">—</p>'}
      ${s.unassignedKg ? `<p class="rh-help">${e(NF1.format(s.unassignedKg))} kg de lots mélangés ne sont pas répartis entre les clients (kilos par client non saisis).</p>` : ''}
      <p class="rh-help">${e(s.note)}</p>`;
    wireRange();
  }

  // ---------- réglages ----------
  async function paintSettings() {
    const ref = await refData(true);
    const st = ref.settings;
    const eur = (c) => (c == null ? '' : String(c / 100).replace('.', ','));
    body().innerHTML = `
      <h3 class="rh-h" style="margin-top:0">Objectif et prix</h3>
      <div class="pr-set">
        <div class="bl-field"><label for="st-target">Objectif de coût (€ par kg)</label><input id="st-target" inputmode="decimal" value="${e(eur(st.targetCentsPerKg))}" placeholder="1,30"></div>
        <div class="bl-field"><label for="st-water">Prix de l'eau (€ par m³)</label><input id="st-water" inputmode="decimal" value="${e(eur(st.waterCentsPerM3))}" placeholder="à renseigner"></div>
        <div class="bl-field"><label for="st-energy">Prix de l'énergie (€ par kWh)</label><input id="st-energy" inputmode="decimal" value="${e(eur(st.energyCentsPerKwh))}" placeholder="à renseigner"></div>
        <div class="bl-field"><label for="st-tol">Tolérance de poids (±&nbsp;%)</label><input id="st-tol" inputmode="decimal" value="${e(st.tolerancePct)}"></div>
        <div class="bl-field"><label for="st-from">Ouverture</label><input id="st-from" type="time" value="${e(st.openFrom)}"></div>
        <div class="bl-field"><label for="st-to">Fermeture</label><input id="st-to" type="time" value="${e(st.openTo)}"></div></div>
      <div class="rh-bar"><button type="button" class="bl-btn primary" id="st-save">Enregistrer</button><span class="rh-sub" id="st-msg"></span></div>
      <p class="rh-help">Les prix servent à estimer le coût de l'eau et de l'énergie de chaque lavage (consommations moyennes du programme × prix). Laissés vides, aucun coût n'est inventé : la ligne reste « à renseigner ». L'ouverture sert au calcul de l'utilisation des machines.</p>

      <h3 class="rh-h">Programmes de lavage</h3>
      <div class="rh-bar"><button type="button" class="bl-btn" id="pg-new">+ Nouveau programme</button></div>
      ${ref.programs.length ? `<div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Programme</th><th class="r">Température</th><th class="r">Durée</th><th class="r">Eau</th><th class="r">Énergie</th><th class="r">Lessive</th><th>État</th></tr></thead><tbody>
        ${ref.programs.map(p => `<tr class="bl-row${p.active ? '' : ' rh-off'}" data-pg="${p.id}" tabindex="0"><td class="client">${e(p.name)}</td><td class="r bl-num">${p.tempC != null ? p.tempC + ' °C' : '—'}</td><td class="r bl-num">${p.durationMin ? p.durationMin + ' min' : '—'}</td>
          <td class="r bl-num">${p.waterL != null ? e(NF0.format(p.waterL)) + ' L' : '—'}</td><td class="r bl-num">${p.energyKwh != null ? e(NF1.format(p.energyKwh)) + ' kWh' : '—'}</td><td class="r bl-num">${p.detergentCost != null ? EUR2.format(p.detergentCost) : '—'}</td>
          <td>${p.active ? '<span class="bl-tag ok">proposé</span>' : '<span class="bl-tag draft">retiré</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty-note">Aucun programme. Sans programme, l\'écran de l\'atelier lance le lavage sans durée prévue ni coût estimé.</p>'}
      <p class="rh-help">La durée donne l'heure de fin prévue d'un lavage ; l'eau, l'énergie et la lessive (par charge) servent à estimer son coût. Reportez les valeurs de vos fiches machine.</p>

      <h3 class="rh-h">Types de linge</h3>
      <div class="rh-chips">${ref.linenTypes.map(t => `<button type="button" class="pr-lotchip${t.active ? '' : ' off'}" data-lt="${t.id}">${e(t.label)}${t.active ? '' : '<small>retiré</small>'}</button>`).join('')}
        <button type="button" class="bl-btn small" id="lt-new">+ Ajouter</button></div>

      <h3 class="rh-h">Tablette de l'atelier</h3>
      <p class="rh-help" style="margin-top:0">L'écran de l'atelier s'ouvre sur <b>${e(location.origin)}/atelier</b>. Il utilise la même activation que la badgeuse : créez la tablette dans Équipe → Badgeuses, ouvrez le lien d'activation une fois, puis passez de « Pointage » à « Atelier » selon l'usage.</p>
      <div class="rh-bar"><a class="bl-btn" href="/atelier" target="_blank" rel="noopener">Ouvrir l'écran Atelier</a></div>`;
    document.getElementById('st-save').onclick = async () => {
      const msg = document.getElementById('st-msg');
      try {
        await put('/settings', { targetCostPerKg: document.getElementById('st-target').value, waterPrice: document.getElementById('st-water').value, energyPrice: document.getElementById('st-energy').value,
          tolerancePct: document.getElementById('st-tol').value, openFrom: document.getElementById('st-from').value, openTo: document.getElementById('st-to').value });
        S.ref = null; toast('Réglages enregistrés.'); refreshTab();
      } catch (err) { msg.textContent = err.message; msg.style.color = 'var(--rust)'; }
    };
    document.getElementById('pg-new').onclick = () => programForm(null);
    body().querySelectorAll('tr[data-pg]').forEach(tr => { const open = () => programForm(ref.programs.find(p => p.id === Number(tr.dataset.pg))); tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter') open(); }; });
    document.getElementById('lt-new').onclick = () => typeForm(null);
    body().querySelectorAll('[data-lt]').forEach(b => b.onclick = () => typeForm(ref.linenTypes.find(t => t.id === Number(b.dataset.lt))));
  }

  function programForm(p) {
    const buttons = [];
    if (p) buttons.push({ label: 'Retirer', danger: true, onClick: async () => {
      if (!(await Bill.confirm('Retirer « ' + p.name + ' » ?', 'Un programme déjà utilisé reste dans l\'historique des lots ; il n\'est plus proposé à la tablette.', 'Retirer', true))) return true;
      const r = await del(`/programs/${p.id}`); toast(r.archived ? 'Programme retiré (historique conservé).' : 'Programme supprimé.'); S.ref = null; refreshTab();
    } });
    buttons.push({ label: 'Annuler' });
    buttons.push({ label: 'Enregistrer', primary: true, onClick: async (box) => {
      const payload = { name: box.$('#pf-name').value, tempC: box.$('#pf-temp').value, durationMin: box.$('#pf-dur').value, waterL: box.$('#pf-water').value, energyKwh: box.$('#pf-energy').value, detergentCost: box.$('#pf-det').value, ...(p ? { active: box.$('#pf-active').checked } : {}) };
      if (p) await put(`/programs/${p.id}`, payload); else await post('/programs', payload);
      toast('Programme enregistré.'); S.ref = null; refreshTab();
    } });
    const v = (x) => (x == null ? '' : String(x).replace('.', ','));
    Bill.modal({
      title: p ? p.name : 'Nouveau programme', buttons,
      body: `<div class="bl-field"><label for="pf-name">Nom *</label><input id="pf-name" maxlength="60" value="${e(p && p.name)}" placeholder="Draps 60°, Éponge 40°…"></div>
        <div class="bl-row2"><div class="bl-field"><label for="pf-temp">Température (°C)</label><input id="pf-temp" inputmode="decimal" value="${e(v(p && p.tempC))}"></div>
        <div class="bl-field"><label for="pf-dur">Durée (min)</label><input id="pf-dur" inputmode="numeric" value="${e(v(p && p.durationMin))}"></div></div>
        <div class="bl-row2"><div class="bl-field"><label for="pf-water">Eau par charge (L)</label><input id="pf-water" inputmode="decimal" value="${e(v(p && p.waterL))}"></div>
        <div class="bl-field"><label for="pf-energy">Énergie par charge (kWh)</label><input id="pf-energy" inputmode="decimal" value="${e(v(p && p.energyKwh))}"></div></div>
        <div class="bl-field"><label for="pf-det">Lessive et produits par charge (€)</label><input id="pf-det" inputmode="decimal" value="${e(v(p && p.detergentCost))}"></div>
        ${p ? `<label class="bl-check rh-chk"><input type="checkbox" id="pf-active"${p.active ? ' checked' : ''}> Proposé à la tablette</label>` : ''}
        <p class="rh-help">Tout est facultatif sauf le nom. Une valeur vide reste « à renseigner » dans le coût du lot.</p>`,
    });
  }

  function typeForm(t) {
    const buttons = [];
    if (t) buttons.push({ label: 'Retirer', danger: true, onClick: async () => {
      const r = await del(`/linen-types/${t.id}`); toast(r.archived ? 'Type retiré (historique conservé).' : 'Type supprimé.'); S.ref = null; refreshTab();
    } });
    buttons.push({ label: 'Annuler' });
    buttons.push({ label: 'Enregistrer', primary: true, onClick: async (box) => {
      const payload = { label: box.$('#tf-label').value, ...(t ? { active: box.$('#tf-active').checked } : {}) };
      if (t) await put(`/linen-types/${t.id}`, payload); else await post('/linen-types', payload);
      toast('Type de linge enregistré.'); S.ref = null; refreshTab();
    } });
    Bill.modal({
      title: t ? t.label : 'Nouveau type de linge', buttons,
      body: `<div class="bl-field"><label for="tf-label">Nom *</label><input id="tf-label" maxlength="40" value="${e(t && t.label)}" placeholder="Grand plat, Éponge, Nappes…"></div>
        ${t ? `<label class="bl-check rh-chk"><input type="checkbox" id="tf-active"${t.active ? ' checked' : ''}> Proposé à la tablette</label>` : ''}`,
    });
  }
})();
