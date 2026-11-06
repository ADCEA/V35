// Tablette de pointage de l'atelier. Aucune donnée n'est gardée sur la tablette en dehors de son jeton d'activation ;
// le code personnel n'existe en mémoire que le temps d'une action, puis l'écran revient à l'accueil.
(function () {
  'use strict';
  const KEY = 'cezanne.badgeuse.token';
  const TZ = 'Europe/Paris';
  const IDLE_MS = 25000, DONE_MS = 5000, POLL_MS = 30000;
  const main = document.getElementById('bk-main');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- jeton de la tablette ----------
  let token = '';
  const store = {
    get() { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch (_) { /* navigation privée : le jeton ne survivra pas à la fermeture */ } },
    clear() { try { localStorage.removeItem(KEY); } catch (_) { /* rien */ } },
  };
  // Le lien d'activation porte le jeton après le « # » : on le range, puis on l'efface de l'adresse (ni historique, ni journaux).
  function takeHash() {
    const h = (location.hash || '').replace(/^#/, '');
    if (!h) return false;
    let got = false;
    if (/^[0-9a-f]{64}$/.test(h)) { token = h; store.set(h); got = true; }
    history.replaceState(null, '', location.pathname);
    return got;
  }
  token = store.get();
  takeHash();

  // ---------- réseau ----------
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch('/api/badgeuse' + path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-terminal-token': token }, body: body ? JSON.stringify(body) : undefined });
    } catch (_) { const e = new Error('Pas de connexion au serveur.'); e.network = true; throw e; }
    let data = null; try { data = await res.json(); } catch (_) { /* corps vide */ }
    if (!res.ok) {
      const e = new Error((data && data.error) || `Erreur ${res.status}`); e.status = res.status; e.data = data || {};
      if (res.status === 401 && /^TERMINAL_/.test(e.data.code || '')) { token = ''; store.clear(); e.terminal = true; }
      throw e;
    }
    return data;
  }

  // ---------- heure (celle du serveur) ----------
  let offset = 0;
  const nowMs = () => Date.now() + offset;
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtDate = (ms) => new Date(ms).toLocaleDateString('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`);
  function tick() {
    document.getElementById('bk-clock').textContent = fmtTime(nowMs());
    document.getElementById('bk-date').textContent = fmtDate(nowMs());
  }
  setInterval(tick, 1000); tick();

  // ---------- état ----------
  let S = null;            // /state
  let view = 'home';
  let info = null;         // résultat d'identification (collaborateur courant)
  let creds = null;        // { employeeId, pin } ou { uid } — gardé le temps de l'action seulement
  let pin = '';
  let timer = null, busy = false;

  const bu = (id) => (S && S.bus.find((b) => b.id === id)) || { id, label: id };
  const shortName = (e) => e.firstName + (e.lastName ? ' ' + e.lastName.trim().charAt(0).toUpperCase() + '.' : '');
  const posteLabel = (b, machineName) => (machineName ? `${machineName} · ${bu(b).label}` : bu(b).label);
  const defaultPoste = (e) => posteLabel(e.bu, e.machineName);

  function banner(msg) {
    const el = document.getElementById('bk-banner');
    el.hidden = !msg; el.textContent = msg || '';
  }

  function armIdle(ms) {
    clearTimeout(timer);
    if (view !== 'home' && view !== 'setup') timer = setTimeout(goHome, ms || IDLE_MS);
  }
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (view !== 'done') armIdle(); }, true));

  function goHome() {
    clearTimeout(timer);
    info = null; creds = null; pin = ''; busy = false;
    if (!token) return showSetup();
    view = 'home';
    if (S) renderHome();
    refresh();
  }

  // ---------- accueil ----------
  async function refresh() {
    try {
      S = await api('GET', '/state');
      offset = Date.parse(S.now) - Date.now();
      banner('');
    } catch (err) {
      if (err.terminal) return showSetup(err.message);
      banner(err.network ? 'Connexion perdue : aucun pointage n\'est enregistré tant qu\'elle n\'est pas rétablie.' : err.message);
      if (!S) { main.innerHTML = '<div class="bk-empty"><p class="bk-h">Connexion en cours…</p></div>'; return; }
    }
    if (view === 'home') renderHome();
  }

  function renderHome() {
    const people = S.employees;
    const here = people.filter((e) => e.present).length;
    document.getElementById('bk-count').innerHTML = `<b>${here} / ${people.length}</b>présent${here > 1 ? 's' : ''}`;
    if (!people.length) { main.innerHTML = '<div class="bk-empty"><p class="bk-h">Aucun collaborateur</p><p>Ajoutez l\'équipe dans l\'administration, onglet Équipe.</p></div>'; return; }
    const groups = S.bus.map((b) => ({ b, list: people.filter((e) => e.bu === b.id) })).filter((g) => g.list.length);
    main.innerHTML = '<div class="bk-groups">' + groups.map((g) => `
      <section class="bk-group"><h2>${esc(g.b.label)}</h2>
        <div class="bk-grid">${g.list.map((e) => {
          const sub = e.present ? `${esc(posteLabel(e.present.bu, e.present.machineName))} · depuis ${esc(fmtTime(Date.parse(e.present.since)))}`
            : (e.hasPin ? esc(defaultPoste(e)) : 'Code à définir');
          return `<button type="button" class="bk-person${e.present ? ' here' : ''}${e.hasPin ? '' : ' nopin'}" data-emp="${e.id}"><span class="n">${esc(shortName(e))}</span><span class="s">${sub}</span></button>`;
        }).join('')}</div>
      </section>`).join('') + '</div><div class="bk-hint">Touchez votre prénom, puis saisissez votre code. Un badge devant le lecteur fonctionne aussi.</div>';
  }

  main.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-emp],[data-key],[data-act],[data-poste],[data-do]');
    if (!t || busy) return;
    if (t.dataset.emp) return openPin(Number(t.dataset.emp));
    if (t.dataset.key) return pressKey(t.dataset.key);
    if (t.dataset.act) return onAction(t.dataset.act);
    if (t.dataset.poste !== undefined) return onPoste(t.dataset.poste);
    if (t.dataset.do === 'home') return goHome();
    if (t.dataset.do === 'back-action' && info) return renderAction('');
    if (t.dataset.do === 'activate') return activate();
  });

  // ---------- code personnel ----------
  let pinFor = null;
  function openPin(id) {
    const e = S.employees.find((x) => x.id === id);
    if (!e) return;
    if (!e.hasPin) { pinFor = e; view = 'pin'; renderPin('Aucun code personnel défini pour le moment : voyez le responsable.', true); armIdle(); return; }
    pinFor = e; pin = ''; view = 'pin'; renderPin(''); armIdle();
  }
  function renderPin(err, disabled) {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => `<button type="button" class="bk-key" data-key="${k}"${disabled ? ' disabled' : ''}>${k}</button>`).join('');
    main.innerHTML = `
      <div class="bk-pin">
        <h1 class="bk-h" style="text-align:center">${esc(pinFor.firstName)}, votre code</h1>
        <p class="bk-sub" style="text-align:center">4 à 6 chiffres</p>
        <div class="bk-dots" aria-label="${pin.length} chiffre${pin.length > 1 ? 's' : ''} saisi${pin.length > 1 ? 's' : ''}">${Array.from({ length: 6 }, (_, i) => (i < Math.max(4, pin.length) ? `<i class="${i < pin.length ? 'on' : ''}"></i>` : '')).join('')}</div>
        <div class="bk-err" role="alert">${esc(err || '')}</div>
        <div class="bk-pad">${keys}
          <button type="button" class="bk-key fn" data-key="back">Retour</button>
          <button type="button" class="bk-key"${disabled ? ' disabled' : ''} data-key="0">0</button>
          <button type="button" class="bk-key go" data-key="ok"${pin.length >= 4 && !disabled ? '' : ' disabled'}>Valider</button>
        </div>
      </div>`;
  }
  function pressKey(k) {
    if (view !== 'pin') return;
    if (k === 'back') return pin ? (pin = pin.slice(0, -1), renderPin('')) : goHome();
    if (k === 'ok') return submitPin();
    if (/^\d$/.test(k) && pin.length < 6) { pin += k; renderPin(''); }
  }
  async function submitPin() {
    if (pin.length < 4 || busy) return;
    busy = true;
    const attempt = { employeeId: pinFor.id, pin };
    try {
      info = await api('POST', '/identify', attempt);
      creds = attempt; pin = ''; busy = false;
      renderAction('');
    } catch (err) {
      busy = false; pin = '';
      if (err.terminal) return showSetup(err.message);
      renderPin(err.network ? 'Pas de connexion au serveur.' : err.message);
    }
    armIdle();
  }

  // ---------- badge (lecteur USB qui « tape » le numéro puis Entrée) ----------
  let buf = '', last = 0;
  document.addEventListener('keydown', (ev) => {
    if (view === 'setup' || (ev.target && ev.target.tagName === 'INPUT')) return;
    const t = Date.now();
    if (ev.key === 'Enter') { const code = buf; buf = ''; if (code.length >= 4 && !busy) scan(code); return; }
    if (ev.key && ev.key.length === 1) { if (t - last > 120) buf = ''; buf += ev.key; last = t; }
  });
  async function scan(uid) {
    if (!S || view === 'done') return;
    busy = true;
    try {
      const attempt = { uid };
      info = await api('POST', '/identify', attempt);
      creds = attempt; pin = ''; busy = false;
      renderAction('');
    } catch (err) {
      busy = false;
      if (err.terminal) return showSetup(err.message);
      view = 'home'; renderHome(); banner(err.network ? 'Pas de connexion au serveur.' : err.message);
      setTimeout(() => banner(''), 4000);
    }
    armIdle();
  }

  // ---------- actions ----------
  function renderAction(err) {
    view = 'action';
    const e = info.employee, p = info.present;
    const status = p
      ? `<div class="bk-status"><span>Pointé à</span><b>${esc(p.poste)}</b><span>depuis ${esc(fmtTime(Date.parse(p.since)))} · ${esc(dur(p.minutes))}</span></div>`
      : `<div class="bk-status out"><span>Non pointé</span>${info.minutesToday ? `<span>· aujourd'hui : ${esc(dur(info.minutesToday))}</span>` : ''}</div>`;
    const forgot = info.forgotten ? '<p class="bk-err" style="text-align:left">Votre dernier départ n\'a pas été badgé : le responsable sera prévenu.</p>' : '';
    main.innerHTML = `
      <h1 class="bk-h">Bonjour ${esc(e.firstName)}</h1>
      <p class="bk-sub">${esc(fmtDate(nowMs()))}</p>
      ${status}${forgot}
      <div class="bk-err" role="alert" style="text-align:left">${esc(err || '')}</div>
      <div class="bk-actions">${p ? `
        <button type="button" class="bk-btn main" data-act="switch"><span>Changer de poste</span><small>Je passe sur une autre machine</small></button>
        <button type="button" class="bk-btn" data-act="pause"><span>Pause</span><small>Je reviens</small></button>
        <button type="button" class="bk-btn stop" data-act="out"><span>Départ</span><small>Fin de ma journée</small></button>` : `
        <button type="button" class="bk-btn main" data-act="in"><span>Arrivée</span><small>${esc(defaultPoste(e))}</small></button>
        <button type="button" class="bk-btn" data-act="in-other"><span>Autre poste…</span><small>Choisir la machine ou l'unité</small></button>`}
      </div>
      <button type="button" class="bk-back" data-do="home">Quitter</button>`;
  }

  let pickMode = 'in';
  function onAction(act) {
    if (act === 'in') return punch('in', null);
    if (act === 'in-other') return renderPicker('in');
    if (act === 'switch') return renderPicker('switch');
    if (act === 'pause' || act === 'out') return punch(act, null);
  }

  function renderPicker(mode) {
    pickMode = mode; view = 'poste';
    const cur = info.present;
    const sections = S.bus.map((b) => {
      const ms = S.machines.filter((m) => m.bu === b.id);
      const isCur = (machineId, buId) => cur && cur.bu === buId && (cur.machineId || null) === (machineId || null);
      const btns = ms.map((m) => `<button type="button" class="bk-btn${isCur(m.id, b.id) ? ' cur' : ''}" data-poste="m${m.id}"><span>${esc(m.name)}</span>${m.capacityKg ? `<small>${esc(String(m.capacityKg).replace('.', ','))} kg</small>` : ''}</button>`);
      btns.push(`<button type="button" class="bk-btn${isCur(null, b.id) ? ' cur' : ''}" data-poste="b${esc(b.id)}"><span>${ms.length ? esc(b.label) + ' — général' : esc(b.label)}</span>${ms.length ? '<small>Sans machine précise</small>' : ''}</button>`);
      return `<section class="bk-group"><h2>${esc(b.label)}</h2><div class="bk-poste">${btns.join('')}</div></section>`;
    }).join('');
    main.innerHTML = `<h1 class="bk-h">${mode === 'switch' ? 'Nouveau poste' : 'Où commencez-vous ?'}</h1><p class="bk-sub">Touchez la machine ou l'unité.</p>${sections}<button type="button" class="bk-back" data-do="back-action">Retour</button>`;
  }
  function onPoste(v) {
    const body = v.charAt(0) === 'm' ? { machineId: Number(v.slice(1)) } : { bu: v.slice(1) };
    punch(pickMode, body);
  }

  async function punch(action, target) {
    if (busy || !creds) return;
    busy = true;
    try {
      const r = await api('POST', '/punch', { ...creds, action, ...(target || {}) });
      busy = false; creds = null; pin = '';
      renderDone(r);
    } catch (err) {
      busy = false;
      if (err.terminal) return showSetup(err.message);
      if (err.status === 409 && err.data && err.data.employee) { info = err.data; return renderAction(err.message); }
      if (err.status === 401 || err.status === 429) { creds = null; return goHome(); }
      renderAction(err.network ? 'Pas de connexion au serveur : réessayez.' : err.message);
    }
    armIdle();
  }

  function renderDone(r) {
    view = 'done';
    const out = r.action === 'out' || r.action === 'pause' || r.action === 'forgotten';
    main.innerHTML = `<div class="bk-done"><div class="ic" aria-hidden="true">✓</div>
      <p class="big">${esc(r.action === 'out' ? 'Bonne soirée' : r.action === 'pause' ? 'Bonne pause' : 'C\'est noté')}, ${esc(r.employee.firstName)}</p>
      <p>${esc(r.message)}</p>${r.minutesToday ? `<p style="color:var(--steel);font-size:16px">Aujourd'hui : ${esc(dur(r.minutesToday))}${out ? '' : ' jusqu\'ici'}</p>` : ''}
      <button type="button" class="bk-btn main" data-do="home"><span>OK</span></button></div>`;
    clearTimeout(timer);
    timer = setTimeout(goHome, DONE_MS);
  }

  // ---------- activation de la tablette ----------
  function showSetup(msg) {
    view = 'setup'; clearTimeout(timer); S = null;
    document.getElementById('bk-count').textContent = '';
    banner('');
    main.innerHTML = `<div class="bk-setup"><h1 class="bk-h">Activer cette tablette</h1>
      <p class="bk-sub">${esc(msg || 'Ouvrez le lien d\'activation donné dans l\'administration (Équipe → Badgeuses), ou collez ici le code d\'activation.')}</p>
      <label for="bk-token" class="bk-sub" style="display:block;margin-bottom:6px">Code d'activation</label>
      <input id="bk-token" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" inputmode="text">
      <button type="button" class="bk-btn main" data-do="activate"><span>Activer</span></button>
      <div class="bk-err" id="bk-setup-err" role="alert" style="text-align:left;margin-top:10px"></div></div>`;
  }
  async function activate() {
    const v = (document.getElementById('bk-token').value || '').trim();
    if (!/^[0-9a-f]{64}$/.test(v)) { document.getElementById('bk-setup-err').textContent = 'Ce code n\'est pas valide (64 caractères).'; return; }
    token = v;
    try {
      await api('GET', '/state');
      store.set(v); view = 'home'; refresh();
    } catch (err) {
      if (!err.network) { token = ''; }
      document.getElementById('bk-setup-err').textContent = err.network ? 'Pas de connexion au serveur.' : err.message;
    }
  }

  // Lien d'activation ouvert dans une page déjà affichée (même onglet) : on active sans rechargement.
  window.addEventListener('hashchange', () => { if (takeHash()) { S = null; goHome(); } });

  // ---------- démarrage ----------
  if (!token) showSetup(); else { main.innerHTML = '<div class="bk-empty"><p class="bk-h">Chargement…</p></div>'; refresh(); }
  setInterval(() => { if (view === 'home' && token) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && view === 'home' && token) refresh(); });
})();
