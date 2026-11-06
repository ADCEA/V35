// Administration → Équipe : présence en direct, collaborateurs (rattachés à une BU / une machine), heures, machines, tablettes de badgeuse.
// Dépend de api() et escHtml() (app.js) et de Bill (fenêtres, messages) chargé avant ce fichier.
(function () {
  'use strict';
  const BASE = '/api/admin/rh';
  const e = (s) => escHtml(s == null ? '' : String(s));
  const get = (p) => api('GET', BASE + p);
  const post = (p, b) => api('POST', BASE + p, b || {});
  const put = (p, b) => api('PUT', BASE + p, b || {});
  const del = (p) => api('DELETE', BASE + p);
  const toast = (m, bad) => Bill.toast(m, bad);
  const NF1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const TIME = { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' };
  const hm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', TIME);
  const hLong = (min) => (min ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : '0 h');
  const hCell = (min) => (min ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}` : '·');
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const monday = (d) => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const dayHead = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC', weekday: 'short', day: 'numeric' });
  const dFr = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC' });
  const TABS = [['presence', 'Présence'], ['people', 'Collaborateurs'], ['hours', 'Heures'], ['machines', 'Machines'], ['terminals', 'Badgeuses']];
  const MAX_WEEK_MIN = 48 * 60;   // durée maximale légale d'une semaine de travail

  const S = { tab: 'presence', ov: null, range: null, hours: null, entries: [], toFix: [], terminals: null, showArchived: false, filterEmp: '', timer: null };
  const root = () => document.getElementById('rh-root');
  const body = () => document.getElementById('rh-body');
  const buLabel = (id) => (S.ov.bus.find(b => b.id === id) || { label: id }).label;
  const contractLabel = (id) => (S.ov.contracts.find(c => c.id === id) || { label: id }).label;
  const visible = () => { const v = document.getElementById('admin-view-rh'); return v && v.style.display !== 'none'; };

  // ---------- squelette ----------
  function shell() {
    root().innerHTML = `<div class="rh">
      <div class="rh-tabs" role="tablist">${TABS.map(([id, label]) => `<button type="button" role="tab" class="rh-tab" data-tab="${id}">${label}<span class="rh-badge" data-badge="${id}" hidden></span></button>`).join('')}</div>
      <div id="rh-body"></div></div>`;
    root().querySelector('.rh-tabs').addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-tab]');
      if (t) go(t.dataset.tab);
    });
  }

  async function load() {
    S.ov = await get('/overview');
    const b = root().querySelector('[data-badge="hours"]');
    if (b) { b.hidden = !S.ov.toFix; b.textContent = S.ov.toFix; b.title = 'Pointages à corriger'; }
  }

  async function go(tab) {
    S.tab = tab;
    root().querySelectorAll('.rh-tab').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
    body().innerHTML = '<p class="empty-note">Chargement…</p>';
    try {
      await load();
      if (tab === 'presence') paintPresence();
      else if (tab === 'people') paintPeople();
      else if (tab === 'machines') paintMachines();
      else if (tab === 'terminals') await paintTerminals();
      else await paintHours();
    } catch (err) { body().innerHTML = `<p class="rh-err">${e(err.message)}</p>`; }
  }
  const refreshTab = () => go(S.tab);

  window.renderRhView = async function () {
    if (!body()) shell();
    await go(S.tab);
    clearInterval(S.timer);
    S.timer = setInterval(async () => {
      if (!visible() || document.hidden || S.tab !== 'presence') return;
      try { await load(); paintPresence(); } catch (_) { /* on réessaie au prochain passage */ }
    }, 30000);
  };

  // ---------- présence ----------
  function chip(p, here) {
    const since = here && p.present ? ` · ${hm(p.present.since)}` : '';
    const away = !here ? ' title="Rattaché ici, pas pointé"' : '';
    return `<span class="rh-chip${here ? ' here' : ''}"${away}>${e(p.firstName)}${p.lastName ? ' ' + e(p.lastName.charAt(0)) + '.' : ''}${since}</span>`;
  }
  function paintPresence() {
    const ov = S.ov;
    const people = ov.employees.filter(p => p.active);
    const live = people.filter(p => p.present && !p.present.stale);
    const absent = people.filter(p => !(p.present && !p.present.stale));
    const attachedHere = (bu, mid) => absent.filter(p => p.bu === bu && (p.machineId || null) === mid);
    const hereAt = (bu, mid) => live.filter(p => p.present.bu === bu && (p.present.machineId || null) === mid);
    const cards = ov.bus.map(b => {
      const ms = ov.machines.filter(m => m.active && m.bu === b.id);
      const n = live.filter(p => p.present.bu === b.id).length;
      const row = (label, sub, bu, mid) => {
        const h = hereAt(bu, mid), a = attachedHere(bu, mid);
        if (!ms.length && mid === null && !h.length && !a.length) return '';
        return `<div class="rh-mrow"><div class="rh-mname">${e(label)}${sub ? `<small>${e(sub)}</small>` : ''}</div>
          <div class="rh-chips">${h.map(p => chip(p, true)).join('')}${a.map(p => chip(p, false)).join('')}${!h.length && !a.length ? '<span class="rh-none">libre</span>' : ''}</div></div>`;
      };
      const rows = ms.map(m => row(m.name, m.capacityKg ? NF1.format(m.capacityKg) + ' kg' : '', b.id, m.id)).join('');
      const general = row(ms.length ? 'Sans machine précise' : b.label, '', b.id, null);
      return `<section class="rh-card"><header><h3>${e(b.label)}</h3><span class="rh-count${n ? ' on' : ''}">${n} présent${n > 1 ? 's' : ''}</span></header>${rows}${general || (ms.length ? '' : '<p class="empty-note">Aucun collaborateur rattaché.</p>')}</section>`;
    }).join('');
    const stale = people.filter(p => p.present && p.present.stale);
    body().innerHTML = `
      <div class="rh-sum"><div><b>${live.length}</b> présent${live.length > 1 ? 's' : ''} sur ${people.length}</div>
        <div class="rh-sub">Mis à jour à ${new Date().toLocaleTimeString('fr-FR', TIME)} · se rafraîchit toutes les 30 s</div>
        ${ov.toFix ? `<button type="button" class="bl-btn small" id="rh-tofix">${ov.toFix} pointage${ov.toFix > 1 ? 's' : ''} à corriger</button>` : ''}</div>
      ${stale.length ? `<p class="rh-warn">Badge oublié hier : ${stale.map(p => e(p.name)).join(', ')}. Complétez l'heure de départ dans l'onglet Heures.</p>` : ''}
      <div class="rh-board">${cards}</div>
      ${!people.length ? '<p class="empty-note">Ajoutez vos collaborateurs dans l\'onglet « Collaborateurs » pour les voir ici.</p>' : ''}`;
    const fix = document.getElementById('rh-tofix');
    if (fix) fix.onclick = () => go('hours');
  }

  // ---------- collaborateurs ----------
  function posteSelect(id, sel, withGeneral = true) {
    const ms = S.ov.machines.filter(m => m.active);
    return `<select id="${id}">${S.ov.bus.map(b => `<optgroup label="${e(b.label)}">${withGeneral ? `<option value="b:${e(b.id)}"${sel === 'b:' + b.id ? ' selected' : ''}>${e(b.label)} — toute l'unité</option>` : ''}${ms.filter(m => m.bu === b.id).map(m => `<option value="m:${m.id}"${sel === 'm:' + m.id ? ' selected' : ''}>${e(m.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
  }
  const posteBody = (v) => (v.startsWith('m:') ? { machineId: Number(v.slice(2)) } : { machineId: null, bu: v.slice(2) });
  const attach = (p) => (p.machineName ? `${e(p.machineName)} <span class="bl-faint">· ${e(buLabel(p.bu))}</span>` : `${e(buLabel(p.bu))} <span class="bl-faint">· toute l'unité</span>`);

  function paintPeople() {
    const list = S.ov.employees.filter(p => S.showArchived || p.active);
    const archived = S.ov.employees.filter(p => !p.active).length;
    body().innerHTML = `
      <div class="rh-bar"><button type="button" class="bl-btn primary" id="rh-new">+ Nouveau collaborateur</button>
        ${archived ? `<label class="bl-check rh-chk"><input type="checkbox" id="rh-arch"${S.showArchived ? ' checked' : ''}> Afficher les ${archived} archivé${archived > 1 ? 's' : ''}</label>` : ''}</div>
      ${list.length ? `<div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Nom</th><th>Rattachement</th><th>Contrat</th><th class="r">H / sem.</th><th>Code</th><th>Badge</th><th>État</th></tr></thead><tbody>
        ${list.map(p => `<tr class="bl-row${p.active ? '' : ' rh-off'}" data-id="${p.id}" tabindex="0"><td class="client">${e(p.name)}${p.jobTitle ? `<span class="sub">${e(p.jobTitle)}</span>` : ''}</td>
          <td>${attach(p)}</td><td>${e(contractLabel(p.contract))}</td><td class="r bl-num">${NF1.format(p.weeklyHours)}</td>
          <td>${p.hasPin ? '<span class="bl-tag ok">défini</span>' : '<span class="bl-tag wait">à définir</span>'}</td>
          <td>${p.badgeHint ? `<span class="bl-mono">${e(p.badgeHint)}</span>` : '<span class="bl-faint">—</span>'}</td>
          <td>${!p.active ? '<span class="bl-tag draft">archivé</span>' : p.locked ? '<span class="bl-tag bad">code bloqué</span>' : p.present ? (p.present.stale ? '<span class="bl-tag wait">badge oublié</span>' : `<span class="bl-tag ok">présent · ${e(p.present.machineName || buLabel(p.present.bu))}</span>`) : '<span class="bl-faint">absent</span>'}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty-note">Aucun collaborateur pour le moment.</p>'}`;
    document.getElementById('rh-new').onclick = () => employeeForm(null);
    const arch = document.getElementById('rh-arch');
    if (arch) arch.onchange = () => { S.showArchived = arch.checked; paintPeople(); };
    body().querySelectorAll('tr[data-id]').forEach(tr => {
      const open = () => employeeForm(S.ov.employees.find(p => p.id === Number(tr.dataset.id)));
      tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter') open(); };
    });
  }

  function employeeForm(p) {
    const sel = p ? (p.machineId ? 'm:' + p.machineId : 'b:' + p.bu) : 'b:lavage';
    const buttons = [];
    if (p) {
      if (p.locked) buttons.push({ label: 'Débloquer le code', onClick: async (m) => { await post(`/employees/${p.id}/unlock`); toast('Code débloqué.'); m.close(); refreshTab(); } });
      buttons.push(p.active
        ? { label: 'Archiver', danger: true, onClick: async () => { if (!(await Bill.confirm('Archiver ' + p.name + ' ?', 'Il ne pourra plus pointer. Ses heures restent dans l\'historique et vous pourrez le réactiver.', 'Archiver', true))) return true; await del(`/employees/${p.id}`); toast('Collaborateur archivé.'); refreshTab(); } }
        : { label: 'Réactiver', onClick: async () => { await put(`/employees/${p.id}`, { active: true }); toast('Collaborateur réactivé.'); refreshTab(); } });
    }
    buttons.push({ label: 'Annuler' });
    buttons.push({
      label: 'Enregistrer', primary: true,
      onClick: async (m) => {
        const v = (id) => m.$('#' + id).value.trim();
        const payload = {
          firstName: v('rf-first'), lastName: v('rf-last'), jobTitle: v('rf-job'), contract: v('rf-contract'), weeklyHours: v('rf-weekly'), hourlyCost: v('rf-cost'),
          notes: v('rf-notes'), ...posteBody(v('rf-poste')),
        };
        if (v('rf-pin')) payload.pin = v('rf-pin');
        if (v('rf-badge')) payload.badgeUid = v('rf-badge');
        else if (m.$('#rf-nobadge') && m.$('#rf-nobadge').checked) payload.badgeUid = '';
        if (p) await put(`/employees/${p.id}`, payload); else await post('/employees', payload);
        toast(p ? 'Modifications enregistrées.' : 'Collaborateur ajouté.');
        refreshTab();
      },
    });
    Bill.modal({
      title: p ? p.name : 'Nouveau collaborateur', wide: true, buttons,
      body: `<div class="bl-row2"><div class="bl-field"><label for="rf-first">Prénom *</label><input id="rf-first" value="${e(p && p.firstName)}" maxlength="60"></div>
        <div class="bl-field"><label for="rf-last">Nom</label><input id="rf-last" value="${e(p && p.lastName)}" maxlength="60"></div></div>
        <div class="bl-row2"><div class="bl-field"><label for="rf-poste">Rattaché à *</label>${posteSelect('rf-poste', sel)}</div>
        <div class="bl-field"><label for="rf-job">Fonction</label><input id="rf-job" value="${e(p && p.jobTitle)}" maxlength="80" placeholder="Opérateur, chef d'atelier…"></div></div>
        <div class="bl-row2"><div class="bl-field"><label for="rf-contract">Contrat</label><select id="rf-contract">${S.ov.contracts.map(c => `<option value="${e(c.id)}"${(p ? p.contract : 'cdd') === c.id ? ' selected' : ''}>${e(c.label)}</option>`).join('')}</select></div>
        <div class="bl-field"><label for="rf-weekly">Heures par semaine</label><input id="rf-weekly" type="number" min="1" max="60" step="0.5" value="${p ? p.weeklyHours : 39}"></div></div>
        <div class="bl-field"><label for="rf-cost">Coût horaire chargé (€/h) — facultatif</label><input id="rf-cost" type="number" min="0" max="500" step="0.01" value="${p && p.hourlyCost != null ? p.hourlyCost : ''}" placeholder="Sert à calculer le coût de la main-d'œuvre par machine"></div>
        <div class="bl-row2"><div class="bl-field"><label for="rf-pin">Code personnel (badgeuse)</label><input id="rf-pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6" placeholder="${p && p.hasPin ? 'Laisser vide pour le conserver' : '4 à 6 chiffres'}"></div>
        <div class="bl-field"><label for="rf-badge">Badge${p && p.badgeHint ? ' (actuel : ' + e(p.badgeHint) + ')' : ''}</label><input id="rf-badge" autocomplete="off" placeholder="Cliquez ici, puis passez le badge sur le lecteur"></div></div>
        ${p && p.badgeHint ? '<label class="bl-check rh-chk"><input type="checkbox" id="rf-nobadge"> Retirer le badge de ce collaborateur</label>' : ''}
        <div class="bl-field" style="margin-top:12px"><label for="rf-notes">Notes</label><input id="rf-notes" value="${e(p && p.notes)}" maxlength="500"></div>
        <p class="rh-help">Le rattachement indique le poste proposé par défaut à la badgeuse ; chacun peut pointer ailleurs en changeant de poste.</p>`,
    });
  }

  // ---------- machines ----------
  function paintMachines() {
    const ms = S.ov.machines;
    const staff = (m) => S.ov.employees.filter(p => p.active && p.machineId === m.id).map(p => p.firstName);
    body().innerHTML = `
      <div class="rh-bar"><button type="button" class="bl-btn primary" id="rh-newm">+ Ajouter une machine</button></div>
      <div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Machine</th><th>Unité (BU)</th><th class="r">Capacité</th><th class="r">Cadence</th><th>Rattachés</th><th>État</th></tr></thead><tbody>
      ${ms.map(m => `<tr class="bl-row${m.active ? '' : ' rh-off'}" data-id="${m.id}" tabindex="0"><td class="client">${e(m.name)}</td><td>${e(buLabel(m.bu))}</td>
        <td class="r bl-num">${m.capacityKg ? NF1.format(m.capacityKg) + ' kg' : '—'}</td><td class="r bl-num">${m.throughputKgh ? NF1.format(m.throughputKgh) + ' kg/h' : '—'}</td><td>${staff(m).map(e).join(', ') || '<span class="bl-faint">—</span>'}</td>
        <td>${m.active ? '<span class="bl-tag ok">en service</span>' : '<span class="bl-tag draft">retirée</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="rh-help">Les machines servent à la badgeuse (où travaille chacun) et aux heures par poste. Une machine déjà utilisée est retirée sans effacer l'historique.</p>`;
    document.getElementById('rh-newm').onclick = () => machineForm(null);
    body().querySelectorAll('tr[data-id]').forEach(tr => {
      const open = () => machineForm(ms.find(m => m.id === Number(tr.dataset.id)));
      tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter') open(); };
    });
  }
  function machineForm(m) {
    const buttons = [];
    if (m) buttons.push({ label: 'Retirer', danger: true, onClick: async () => { if (!(await Bill.confirm('Retirer ' + m.name + ' ?', 'Les collaborateurs rattachés à cette machine ne le seront plus. L\'historique des heures est conservé.', 'Retirer', true))) return true; const r = await del(`/machines/${m.id}`); toast(r.archived ? 'Machine retirée (historique conservé).' : 'Machine supprimée.'); refreshTab(); } });
    buttons.push({ label: 'Annuler' });
    buttons.push({ label: 'Enregistrer', primary: true, onClick: async (box) => {
      const payload = { name: box.$('#mf-name').value, bu: box.$('#mf-bu').value, capacityKg: box.$('#mf-cap').value, throughputKgh: box.$('#mf-tph').value, ...(m ? { active: box.$('#mf-active').checked } : {}) };
      if (m) await put(`/machines/${m.id}`, payload); else await post('/machines', payload);
      toast('Machine enregistrée.'); refreshTab();
    } });
    Bill.modal({
      title: m ? m.name : 'Nouvelle machine', buttons,
      body: `<div class="bl-field"><label for="mf-name">Nom *</label><input id="mf-name" value="${e(m && m.name)}" maxlength="60" placeholder="Laveuse 4, Calandre 3…"></div>
        <div class="bl-row2"><div class="bl-field"><label for="mf-bu">Unité (BU) *</label><select id="mf-bu">${S.ov.bus.map(b => `<option value="${e(b.id)}"${m && m.bu === b.id ? ' selected' : ''}>${e(b.label)}</option>`).join('')}</select></div>
        <div class="bl-field"><label for="mf-cap">Capacité (kg)</label><input id="mf-cap" type="number" min="0" step="0.5" value="${m && m.capacityKg ? m.capacityKg : ''}"></div></div>
        <div class="bl-field"><label for="mf-tph">Cadence réelle (kg/h) — facultatif</label><input id="mf-tph" type="number" min="0" step="0.5" value="${m && m.throughputKgh ? m.throughputKgh : ''}" placeholder="Sert à prévoir la fin d'un passage (calandres)"></div>
        ${m ? `<label class="bl-check rh-chk"><input type="checkbox" id="mf-active"${m.active ? ' checked' : ''}> En service</label>` : ''}`,
    });
  }

  // ---------- heures ----------
  function presets() {
    const t = today(), mon = monday(t);
    const firstOfMonth = t.slice(0, 8) + '01';
    const lastOfMonth = addDays(addDays(firstOfMonth, 32).slice(0, 8) + '01', -1);
    const prevLast = addDays(firstOfMonth, -1);
    return [
      ['Cette semaine', mon, addDays(mon, 6)], ['Semaine dernière', addDays(mon, -7), addDays(mon, -1)],
      ['Ce mois', firstOfMonth, lastOfMonth], ['Mois dernier', prevLast.slice(0, 8) + '01', prevLast],
    ];
  }
  async function paintHours() {
    if (!S.range) { const p = presets()[0]; S.range = { from: p[1], to: p[2] }; }
    const { from, to } = S.range;
    const q = `from=${from}&to=${to}`;
    const [hours, ent, fix] = await Promise.all([get(`/hours?${q}`), get(`/entries?${q}`), get('/entries/to-fix')]);
    S.hours = hours; S.entries = ent.entries; S.toFix = fix.entries;
    const days = hours.days;
    const people = hours.employees.filter(x => x.total || x.active);
    const maxBu = Math.max(1, ...hours.byBu.map(b => b.min));
    const over = (x) => x.weeks.reduce((s, w) => s + Math.max(0, w.min - Math.round(x.weeklyHours * 60)), 0);
    const tooLong = (x) => x.weeks.some(w => w.min > MAX_WEEK_MIN);
    const showCost = hours.costCents > 0;
    const entries = S.filterEmp ? S.entries.filter(x => String(x.employeeId) === S.filterEmp) : S.entries;

    body().innerHTML = `
      <div class="bl-filters rh-filters">
        <div class="presets">${presets().map(([l, a, b], i) => `<button type="button" class="bl-btn small${a === from && b === to ? ' primary' : ''}" data-preset="${i}">${l}</button>`).join('')}</div>
        <div class="bl-field"><label for="rh-from">Du</label><input id="rh-from" type="date" value="${from}"></div>
        <div class="bl-field"><label for="rh-to">Au</label><input id="rh-to" type="date" value="${to}"></div>
        <div class="rh-grow"></div>
        <a class="bl-btn small" href="${BASE}/export.csv?${q}&kind=summary" download>Exporter les heures (CSV)</a>
        <a class="bl-btn small" href="${BASE}/export.csv?${q}&kind=detail" download>Exporter le détail (CSV)</a>
      </div>
      ${S.toFix.length ? `<section class="rh-fix"><h3>${S.toFix.length} pointage${S.toFix.length > 1 ? 's' : ''} à corriger</h3><p class="rh-help" style="margin-top:0">Départ non badgé : le temps n'est pas compté tant que l'heure de fin n'est pas renseignée.</p>
        ${S.toFix.map(x => `<div class="rh-fixrow"><span><b>${e(x.name)}</b> · ${dFr(x.date)} à partir de ${e(x.start)} · ${e(x.poste)}</span><button type="button" class="bl-btn small" data-fix="${x.id}">Compléter</button></div>`).join('')}</section>` : ''}
      <div class="rh-kpis">
        <div class="rh-kpi"><span>Total pointé</span><b>${hLong(hours.total)}</b>${showCost ? `<small>${EUR.format(hours.costCents / 100)} de main-d'œuvre</small>` : '<small>sur la période</small>'}</div>
        <div class="rh-bu">${hours.byBu.map(b => `<div class="rh-burow"><span>${e(buLabel(b.bu))}</span><i style="width:${Math.round(b.min / maxBu * 100)}%"></i><b>${hLong(b.min)}</b>${showCost && b.costCents ? `<small>${EUR.format(b.costCents / 100)}</small>` : ''}</div>`).join('')}</div>
      </div>
      <div class="bl-tablewrap rh-matrix"><table class="bl-table rh-table"><thead><tr><th class="rh-stick">Collaborateur</th>${days.map(d => `<th class="r${[0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()) ? ' rh-we' : ''}">${e(dayHead(d))}</th>`).join('')}<th class="r">Total</th><th class="r">Au-delà du contrat</th></tr></thead><tbody>
        ${people.map(x => `<tr><td class="rh-stick client">${e(x.name)}${x.open ? ' <span class="bl-tag ok">en cours</span>' : ''}${x.forgotten ? ' <span class="bl-tag wait">oubli</span>' : ''}${tooLong(x) ? ' <span class="bl-tag bad" title="Plus de 48 h sur une semaine">&gt; 48 h</span>' : ''}</td>
          ${days.map(d => `<td class="r bl-num${x.days[d] ? '' : ' bl-faint'}">${hCell(x.days[d] || 0)}</td>`).join('')}
          <td class="r bl-num"><b>${hLong(x.total)}</b></td><td class="r bl-num${over(x) ? ' rh-over' : ' bl-faint'}">${over(x) ? '+ ' + hLong(over(x)) : '·'}</td></tr>`).join('') || `<tr><td colspan="${days.length + 3}" class="empty-note">Aucun collaborateur.</td></tr>`}
      </tbody></table></div>
      <h3 class="rh-h">Par poste</h3>
      <div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Poste</th><th>Unité</th><th class="r">Heures</th>${showCost ? '<th class="r">Main-d\'œuvre</th>' : ''}</tr></thead><tbody>
        ${hours.byMachine.map(m => `<tr><td class="client">${e(m.name || buLabel(m.bu) + ' (unité entière)')}</td><td>${e(buLabel(m.bu))}</td><td class="r bl-num">${hLong(m.min)}</td>${showCost ? `<td class="r bl-num">${m.costCents ? EUR.format(m.costCents / 100) : '—'}</td>` : ''}</tr>`).join('') || `<tr><td colspan="4" class="empty-note">Aucune heure sur la période.</td></tr>`}
      </tbody></table></div>
      <div class="rh-bar rh-h"><h3 style="margin:0">Pointages</h3><div class="rh-grow"></div>
        <select id="rh-femp" aria-label="Filtrer par collaborateur"><option value="">Tous les collaborateurs</option>${S.ov.employees.map(p => `<option value="${p.id}"${String(p.id) === S.filterEmp ? ' selected' : ''}>${e(p.name)}</option>`).join('')}</select>
        <button type="button" class="bl-btn small primary" id="rh-newe">+ Ajouter un pointage</button></div>
      <div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Date</th><th>Collaborateur</th><th>Poste</th><th>Arrivée</th><th>Départ</th><th class="r">Durée</th><th>Saisie</th></tr></thead><tbody>
        ${entries.map(x => `<tr class="bl-row" data-entry="${x.id}" tabindex="0"><td>${dFr(x.date)}</td><td class="client">${e(x.name)}</td><td>${e(x.poste)}</td><td class="bl-num">${e(x.start)}</td>
          <td class="bl-num">${x.end ? e(x.end) + (x.endDate !== x.date ? ' <span class="bl-faint">(' + dFr(x.endDate) + ')</span>' : '') : x.open ? '<span class="bl-tag ok">en cours</span>' : '<span class="bl-tag wait">oubli</span>'}</td>
          <td class="r bl-num">${x.stale && !x.end ? '—' : hLong(x.minutes)}</td><td>${x.source === 'manuel' ? 'Manuelle' : 'Badgeuse'}${x.edited ? ' <span class="bl-faint">· corrigé</span>' : ''}${x.endReason === 'pause' ? ' <span class="bl-faint">· pause</span>' : ''}</td></tr>`).join('') || `<tr><td colspan="7" class="empty-note">Aucun pointage sur la période.</td></tr>`}
      </tbody></table></div>`;

    const setRange = (f, t) => { S.range = { from: f, to: t }; paintHours().catch(err => toast(err.message, true)); };
    body().querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { const p = presets()[Number(b.dataset.preset)]; setRange(p[1], p[2]); });
    const df = document.getElementById('rh-from'), dt = document.getElementById('rh-to');
    const dates = () => { if (df.value && dt.value && df.value <= dt.value) setRange(df.value, dt.value); else toast('Choisissez une période valide (du ≤ au).', true); };
    df.onchange = dates; dt.onchange = dates;
    document.getElementById('rh-femp').onchange = (ev) => { S.filterEmp = ev.target.value; paintHours().catch(err => toast(err.message, true)); };
    document.getElementById('rh-newe').onclick = () => entryForm(null);
    const find = (id) => S.entries.find(x => x.id === id) || S.toFix.find(x => x.id === id);
    body().querySelectorAll('[data-entry]').forEach(tr => { const open = () => entryForm(find(Number(tr.dataset.entry))); tr.onclick = open; tr.onkeydown = (ev) => { if (ev.key === 'Enter') open(); }; });
    body().querySelectorAll('[data-fix]').forEach(b => b.onclick = () => entryForm(find(Number(b.dataset.fix))));
  }

  function entryForm(x) {
    const sel = x ? (x.machineId ? 'm:' + x.machineId : 'b:' + x.bu) : 'b:lavage';
    const buttons = [];
    if (x) buttons.push({ label: 'Supprimer', danger: true, onClick: async () => { if (!(await Bill.confirm('Supprimer ce pointage ?', `${x.name} · ${dFr(x.date)} · ${x.start}${x.end ? '–' + x.end : ''}. Cette action est définitive.`, 'Supprimer', true))) return true; await del(`/entries/${x.id}`); toast('Pointage supprimé.'); refreshTab(); } });
    buttons.push({ label: 'Annuler' });
    buttons.push({ label: 'Enregistrer', primary: true, onClick: async (m) => {
      const payload = { date: m.$('#ef-date').value, start: m.$('#ef-start').value, end: m.$('#ef-end').value, note: m.$('#ef-note').value, ...posteBody(m.$('#ef-poste').value) };
      if (x) await put(`/entries/${x.id}`, payload); else await post('/entries', { ...payload, employeeId: Number(m.$('#ef-emp').value) });
      toast('Pointage enregistré.'); refreshTab();
    } });
    Bill.modal({
      title: x ? `Pointage de ${x.name}` : 'Ajouter un pointage', buttons,
      body: `<div class="bl-field"><label for="ef-emp">Collaborateur</label><select id="ef-emp"${x ? ' disabled' : ''}>${S.ov.employees.filter(p => p.active || (x && p.id === x.employeeId)).map(p => `<option value="${p.id}"${x && x.employeeId === p.id ? ' selected' : ''}>${e(p.name)}</option>`).join('')}</select></div>
        <div class="bl-row2"><div class="bl-field"><label for="ef-date">Date</label><input id="ef-date" type="date" max="${today()}" value="${x ? x.date : today()}"></div>
        <div class="bl-field"><label for="ef-poste">Poste</label>${posteSelect('ef-poste', sel)}</div></div>
        <div class="bl-row2"><div class="bl-field"><label for="ef-start">Arrivée</label><input id="ef-start" type="time" value="${x ? e(x.start) : ''}"></div>
        <div class="bl-field"><label for="ef-end">Départ</label><input id="ef-end" type="time" value="${x && x.end && !(x.stale && x.minutes === 0 && !x.edited) ? e(x.end) : ''}"></div></div>
        <div class="bl-field"><label for="ef-note">Note</label><input id="ef-note" maxlength="200" value="${e(x && x.note)}" placeholder="Ex. oubli de badge, rattrapage"></div>
        <p class="rh-help">Heures de Paris. Sans heure de départ, le pointage reste « en cours » (seulement pour aujourd'hui).</p>`,
    });
  }

  // ---------- badgeuses ----------
  async function paintTerminals() {
    S.terminals = (await get('/terminals')).terminals;
    body().innerHTML = `
      <div class="rh-bar"><button type="button" class="bl-btn primary" id="rh-newt">+ Nouvelle tablette</button>
        <a class="bl-btn" href="/badgeuse" target="_blank" rel="noopener">Ouvrir la page de pointage</a>
        <a class="bl-btn" href="/atelier" target="_blank" rel="noopener">Ouvrir l'écran Atelier</a></div>
      ${S.terminals.length ? `<div class="bl-tablewrap"><table class="bl-table rh-table"><thead><tr><th>Tablette</th><th>Créée le</th><th>Dernière activité</th><th>État</th><th></th></tr></thead><tbody>
        ${S.terminals.map(t => `<tr class="${t.revoked ? 'rh-off' : ''}"><td class="client">${e(t.label)}</td><td>${e(Bill.dtFr(t.createdAt))}</td><td>${t.lastSeenAt ? e(Bill.dtFr(t.lastSeenAt)) : '<span class="bl-faint">jamais</span>'}</td>
          <td>${t.revoked ? '<span class="bl-tag draft">désactivée</span>' : '<span class="bl-tag ok">active</span>'}</td>
          <td class="r">${t.revoked ? '' : `<button type="button" class="bl-btn small danger" data-revoke="${t.id}">Désactiver</button>`}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="empty-note">Aucune tablette activée. Créez-en une, puis ouvrez le lien d\'activation sur la tablette de l\'atelier.</p>'}
      <p class="rh-help">Un lecteur de badge USB (type clavier) branché sur la tablette fonctionne sans réglage : le collaborateur passe son badge, ou touche son prénom et saisit son code.</p>`;
    document.getElementById('rh-newt').onclick = newTerminal;
    body().querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => {
      const t = S.terminals.find(x => x.id === Number(b.dataset.revoke));
      if (!(await Bill.confirm('Désactiver ' + t.label + ' ?', 'Cette tablette ne pourra plus pointer. Vous pourrez en activer une autre à tout moment.', 'Désactiver', true))) return;
      try { await del(`/terminals/${t.id}`); toast('Tablette désactivée.'); refreshTab(); } catch (err) { toast(err.message, true); }
    });
  }
  function newTerminal() {
    Bill.modal({
      title: 'Nouvelle tablette', buttons: [{ label: 'Annuler' }, { label: 'Créer', primary: true, keep: true, onClick: async (m) => {
        const r = await post('/terminals', { label: m.$('#tf-label').value });
        m.close(); refreshTab();
        const url = location.origin + r.path;
        Bill.modal({
          title: 'Lien d\'activation', buttons: [{ label: 'Copier le lien', keep: true, onClick: async (mm) => {
            const input = mm.$('#tf-url'); input.select();
            try { await navigator.clipboard.writeText(url); toast('Lien copié.'); } catch (_) { document.execCommand && document.execCommand('copy'); toast('Lien sélectionné : copiez-le (Ctrl+C).'); }
            return true;
          } }, { label: 'Fermer', primary: true }],
          body: `<p class="rh-help" style="margin-top:0">Ouvrez ce lien <b>sur la tablette</b> : elle s'active et pointe aussitôt. Il ne sera plus affiché ensuite — conservez-le jusqu'à l'activation, et ne le partagez pas.</p>
            <div class="bl-field"><label for="tf-url">${e(r.terminal.label)}</label><input id="tf-url" readonly value="${e(url)}"></div>
            <p class="rh-help">La même activation sert à l'écran Atelier (lots de lavage) : une fois la tablette activée, ouvrez simplement <b>${e(location.origin)}/atelier</b>.</p>`,
        });
        return true;
      } }],
      body: '<div class="bl-field"><label for="tf-label">Nom de la tablette</label><input id="tf-label" maxlength="60" placeholder="Atelier — entrée"></div>',
    });
  }
})();
