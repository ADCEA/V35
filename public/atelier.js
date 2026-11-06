// Écran Atelier (tablette). Le jeton de la tablette est le même que celui de la badgeuse ; chaque action demande le code
// personnel de la personne, gardé en mémoire 90 secondes seulement (jamais stocké).
(function () {
  'use strict';
  const KEY = 'cezanne.badgeuse.token';
  const TZ = 'Europe/Paris';
  const POLL_MS = 15000, SESSION_MS = 90000, SHEET_IDLE_MS = 180000;
  const main = document.getElementById('at-main');
  const sheetEl = document.getElementById('at-sheet');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- jeton ----------
  let token = '';
  const store = {
    get() { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch (_) { /* navigation privée */ } },
    clear() { try { localStorage.removeItem(KEY); } catch (_) { /* rien */ } },
  };
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
      res = await fetch('/api/atelier' + path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'x-terminal-token': token }, body: body ? JSON.stringify(body) : undefined });
    } catch (_) { const e = new Error('Pas de connexion au serveur.'); e.network = true; throw e; }
    let data = null; try { data = await res.json(); } catch (_) { /* corps vide */ }
    if (!res.ok) {
      const e = new Error((data && data.error) || `Erreur ${res.status}`); e.status = res.status; e.data = data || {};
      if (res.status === 401 && /^TERMINAL_/.test(e.data.code || '')) { token = ''; store.clear(); e.terminal = true; }
      throw e;
    }
    return data;
  }

  // ---------- formats ----------
  let offset = 0;
  const nowMs = () => Date.now() + offset;
  const NF = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const kgf = (n) => NF.format(Number(n) || 0);
  const hm = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const hmIso = (iso) => hm(Date.parse(iso));
  const dateLong = (ms) => new Date(ms).toLocaleDateString('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const dur = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${Math.max(0, Math.round(min))} min`);
  const ago = (iso) => { const m = Math.round((nowMs() - Date.parse(iso)) / 60000); return m < 1 ? 'moins d\'1 min' : dur(m); };
  const num = (v) => Number(v) || 0;

  // ---------- état ----------
  let S = null;                       // /state
  let creds = null, credsName = '', credsUntil = 0;   // identité courante (mémoire seulement)
  let current = null;                 // fonction qui redessine le panneau ouvert
  let F = null;                       // formulaire du panneau ouvert
  let sheetIdle = 0, busy = false;

  const machineById = (id) => (S ? S.machines.find((m) => m.id === Number(id)) : null) || null;
  const stageMachines = (stage) => (S ? S.machines.filter((m) => m.bu === stage) : []);
  const stageName = (stage) => (S && S.stages[stage]) || stage;

  function banner(msg) {
    const el = document.getElementById('at-banner');
    el.hidden = !msg; el.textContent = msg || '';
  }
  let toastTimer = null;
  function toast(msg, bad) {
    const el = document.getElementById('at-toast');
    el.textContent = msg; el.className = 'at-toast' + (bad ? ' bad' : ''); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 3000);
  }

  // ---------- horloge, barres de progression, identité ----------
  function tick() {
    document.getElementById('at-clock').textContent = hm(nowMs());
    document.getElementById('at-date').textContent = dateLong(nowMs());
    document.querySelectorAll('.at-bar[data-s]').forEach((b) => {
      const s = Number(b.dataset.s), e = Number(b.dataset.e);
      const p = Math.max(0, Math.min(1, (nowMs() - s) / (e - s)));
      b.firstElementChild.style.width = Math.round(p * 100) + '%';
      b.classList.toggle('late', nowMs() > e);
    });
    if (creds && Date.now() > credsUntil) { creds = null; credsName = ''; renderWho(); }
    if (!sheetEl.hidden && Date.now() - sheetIdle > SHEET_IDLE_MS) { closeSheet(); creds = null; credsName = ''; renderWho(); }
  }
  setInterval(tick, 1000);
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { sheetIdle = Date.now(); }, true));

  function renderWho() {
    const el = document.getElementById('at-who');
    el.innerHTML = creds ? `<button type="button" class="on" data-act="logout">${esc(credsName)} · quitter</button>` : '';
  }

  // ---------- panneau ----------
  function showSheet(render) {
    current = render; sheetIdle = Date.now();
    sheetEl.hidden = false;
    document.body.style.overflow = 'hidden';
    render();
  }
  function hideSheet() {
    current = null; busy = false;
    sheetEl.hidden = true; sheetEl.innerHTML = '';
    document.body.style.overflow = '';
  }
  function closeSheet() { F = null; hideSheet(); refresh(); }
  const pane = (html, narrow) => { sheetEl.innerHTML = `<div class="at-pane${narrow ? ' narrow' : ''}">${html}</div>`; };
  const head = (title, sub) => `<div class="at-ph"><div><h1 class="at-h">${esc(title)}</h1>${sub ? `<p class="at-sub" style="margin:0">${sub}</p>` : ''}</div><button type="button" class="at-x" data-act="close" aria-label="Fermer">✕</button></div>`;

  // ---------- chargement ----------
  async function refresh() {
    try {
      S = await api('GET', '/state');
      offset = Date.parse(S.now) - Date.now();
      banner('');
    } catch (err) {
      if (err.terminal) return showSetup(err.message);
      banner(err.network ? 'Connexion perdue : les actions ne partent pas tant qu\'elle n\'est pas rétablie.' : err.message);
      if (!S) { main.innerHTML = '<div class="at-empty"><p class="at-h">Connexion en cours…</p></div>'; return; }
    }
    if (sheetEl.hidden) renderBoard();
  }

  // ---------- tableau des machines ----------
  function renderSummary() {
    const t = S.today.totals;
    document.getElementById('at-sum').innerHTML = `<b>${num(t.lots)}</b> lot${t.lots > 1 ? 's' : ''} · <b>${kgf(t.kgLavage)}</b> kg lavés<br>${kgf(t.kgSechage)} kg séchés · ${kgf(t.kgFinition)} kg finis`;
    document.getElementById('at-new').hidden = false;
    renderWho();
  }

  function machineCard(m) {
    const cap = m.capacityKg ? `<small>${kgf(m.capacityKg)} kg</small>` : '';
    if (m.state === 'down') {
      const i = m.incident;
      return `<div class="at-m down"><div class="at-mh"><b>${esc(m.name)}</b>${cap}<span class="at-tag">À l'arrêt</span></div>
        <div class="at-why">${esc(i.reason)}</div><div class="at-eta">depuis ${esc(hmIso(i.startedAt))}${i.note ? ' · ' + esc(i.note) : ''}</div>
        <div class="at-mf"><button type="button" class="at-b main" data-act="up" data-inc="${num(i.id)}">Remettre en service</button></div></div>`;
    }
    if (m.state === 'running') {
      const st = m.step;
      const clients = st.clients.length ? st.clients.join(', ') : '';
      let eta, bar = '';
      if (st.stale) eta = '<div class="at-eta stalewarn">Fin non saisie : terminez ce passage</div>';
      else if (st.plannedEndAt) {
        const left = Math.ceil((Date.parse(st.plannedEndAt) - nowMs()) / 60000);
        bar = `<div class="at-bar${left < 0 ? ' late' : ''}" data-s="${Date.parse(st.startedAt)}" data-e="${Date.parse(st.plannedEndAt)}"><i style="width:${Math.round((st.progress || 0) * 100)}%"></i></div>`;
        eta = left >= 0 ? `<div class="at-eta">fin prévue <b>${esc(hmIso(st.plannedEndAt))}</b> · reste ${esc(dur(left))}</div>` : `<div class="at-eta late">Dépassé de ${esc(dur(-left))} (prévu ${esc(hmIso(st.plannedEndAt))})</div>`;
      } else eta = `<div class="at-eta">depuis ${esc(hmIso(st.startedAt))} · ${esc(dur(Math.round((nowMs() - Date.parse(st.startedAt)) / 60000)))}</div>`;
      const pct = m.capacityKg ? ` · ${Math.round(st.weightKg / m.capacityKg * 100)} %` : '';
      return `<div class="at-m running${st.stale ? ' stale' : ''}"><div class="at-mh"><b>${esc(m.name)}</b>${cap}<span class="at-tag">${st.stale ? 'À clôturer' : 'En marche'}</span></div>
        <div class="at-lotline"><button type="button" class="at-code" data-act="lot" data-lot="${num(st.lotId)}">${esc(st.lotCode)}</button><span class="at-cl">${esc(st.linenType || '')}${clients ? ' · ' + esc(clients) : ''}</span></div>
        <div class="at-kg">${esc(kgf(st.weightKg))} kg<small>${esc(pct.replace(' · ', ''))}${st.programName ? (pct ? ' · ' : '') + esc(st.programName) : ''}</small></div>
        ${bar}${eta}
        <div class="at-mf"><button type="button" class="at-b main" data-act="finish" data-step="${num(st.id)}">Terminer</button></div></div>`;
    }
    return `<div class="at-m"><div class="at-mh"><b>${esc(m.name)}</b>${cap}<span class="at-tag">Libre</span></div>
      <div class="at-free">${m.lastEndedAt ? 'libre depuis ' + esc(hmIso(m.lastEndedAt)) : 'libre'}${m.todayCount ? ' · aujourd\'hui ' + num(m.todayCount) + ' passage' + (m.todayCount > 1 ? 's' : '') + ', ' + esc(kgf(m.todayKg)) + ' kg' : ''}</div>
      <div class="at-mf"><button type="button" class="at-b ghost" data-act="launch" data-m="${num(m.id)}">Lancer</button><button type="button" class="at-b small stop" data-act="down" data-m="${num(m.id)}">Panne</button></div></div>`;
  }

  function lotButton(l, kind) {
    const clients = l.clients.length ? l.clients.join(', ') : '';
    if (kind === 'wait') {
      return `<button type="button" class="at-lot wait" data-act="resume" data-lot="${num(l.id)}"><span class="t"><b>${esc(l.code)}</b> · ${esc(l.linenType || '')} · ${esc(kgf(l.weightKg))} kg</span>
        <span class="s">${esc(stageName(l.lastStage))} terminé il y a ${esc(ago(l.lastEndedAt))}${clients ? ' · ' + esc(clients) : ''}</span></button>`;
    }
    return `<button type="button" class="at-lot${l.status === 'termine' ? ' done' : ''}" data-act="lot" data-lot="${num(l.id)}"><span class="t"><b>${esc(l.code)}</b> · ${esc(l.linenType || '')} · ${esc(kgf(l.weightKg))} kg</span>
      <span class="s">${esc(l.stageLabel)}${clients ? ' · ' + esc(clients) : ''}</span></button>`;
  }

  function renderBoard() {
    renderSummary();
    const cols = ['lavage', 'sechage', 'finition'].map((stage) => {
      const ms = stageMachines(stage);
      const busyN = ms.filter((m) => m.state === 'running').length;
      return `<section class="at-col"><h2>${esc(stageName(stage))}<span>${busyN} / ${ms.length} en marche</span></h2>${ms.map(machineCard).join('') || '<p class="at-none">Aucune machine.</p>'}</section>`;
    }).join('');
    const wait = S.waiting.map((l) => lotButton(l, 'wait')).join('') || '<p class="at-none">Aucun lot en attente.</p>';
    const today = S.today.lots.map((l) => lotButton(l, 'day')).join('') || '<p class="at-none">Aucun lot aujourd\'hui.</p>';
    main.innerHTML = `<div class="at-board"><div class="at-cols">${cols}</div>
      <aside class="at-rail"><section><h2>À reprendre<span>${S.waiting.length}</span></h2>${wait}</section>
      <section><h2>Lots du jour<span>${S.today.lots.length}</span></h2>${today}</section></aside></div>`;
  }

  // ---------- identification ----------
  function needAuth(then) {
    if (creds && Date.now() <= credsUntil) { credsUntil = Date.now() + SESSION_MS; return then(); }
    F_auth = { step: 'who', emp: null, pin: '', err: '', then, back: sheetEl.hidden ? null : current };
    sheetEl.hidden = false; document.body.style.overflow = 'hidden'; sheetIdle = Date.now();
    current = renderAuth; renderAuth();
  }
  let F_auth = null;
  function renderAuth() {
    const A = F_auth;
    if (A.step === 'who') {
      const people = S.employees.filter((e) => e.hasPin);
      pane(`${head('Qui êtes-vous ?', 'Touchez votre prénom, puis saisissez votre code. Un badge devant le lecteur fonctionne aussi.')}
        <div class="at-blk"><div class="at-people">${people.map((e) => `<button type="button" class="at-chip${e.present ? ' here' : ''}" data-act="who" data-emp="${num(e.id)}">${esc(e.firstName + (e.lastName ? ' ' + e.lastName.trim().charAt(0).toUpperCase() + '.' : ''))}</button>`).join('') || '<p class="at-none">Aucun collaborateur n\'a de code personnel.</p>'}</div></div>
        <div class="at-err" role="alert">${esc(A.err)}</div>`);
      return;
    }
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => `<button type="button" class="at-key" data-act="key" data-k="${k}">${k}</button>`).join('');
    pane(`${head(A.emp.firstName + ', votre code', '4 à 6 chiffres')}
      <div class="at-pin"><div class="at-dots">${Array.from({ length: 6 }, (_, i) => (i < Math.max(4, A.pin.length) ? `<i class="${i < A.pin.length ? 'on' : ''}"></i>` : '')).join('')}</div>
      <div class="at-err" role="alert" style="text-align:center">${esc(A.err)}</div>
      <div class="at-pad">${keys}<button type="button" class="at-key fn" data-act="key" data-k="back">Retour</button><button type="button" class="at-key" data-act="key" data-k="0">0</button><button type="button" class="at-key go" data-act="key" data-k="ok"${A.pin.length >= 4 ? '' : ' disabled'}>Valider</button></div></div>`, true);
  }
  function authKey(k) {
    const A = F_auth;
    if (!A || A.step !== 'pin') return;
    if (k === 'back') { if (A.pin) A.pin = A.pin.slice(0, -1); else { A.step = 'who'; A.emp = null; } A.err = ''; return renderAuth(); }
    if (k === 'ok') return submitPin();
    if (/^\d$/.test(k) && A.pin.length < 6) { A.pin += k; A.err = ''; renderAuth(); }
  }
  async function submitPin() {
    const A = F_auth;
    if (!A || A.pin.length < 4 || busy) return;
    busy = true;
    const attempt = { employeeId: A.emp.id, pin: A.pin };
    try {
      const r = await api('POST', '/identify', attempt);
      busy = false;
      creds = attempt; credsName = r.employee.name; credsUntil = Date.now() + SESSION_MS; renderWho();
      const then = A.then; F_auth = null;
      if (A.back) current = A.back; else hideSheet();
      then();
    } catch (err) {
      busy = false; A.pin = '';
      if (err.terminal) { closeSheet(); return showSetup(err.message); }
      A.err = err.network ? 'Pas de connexion au serveur.' : err.message;
      renderAuth();
    }
  }
  async function scanBadge(uid) {
    if (!F_auth || busy) return;
    busy = true;
    try {
      const attempt = { uid };
      const r = await api('POST', '/identify', attempt);
      busy = false;
      creds = attempt; credsName = r.employee.name; credsUntil = Date.now() + SESSION_MS; renderWho();
      const A = F_auth; F_auth = null;
      if (A.back) current = A.back; else hideSheet();
      A.then();
    } catch (err) { busy = false; F_auth.err = err.network ? 'Pas de connexion au serveur.' : err.message; renderAuth(); }
  }
  let buf = '', lastKey = 0;
  document.addEventListener('keydown', (ev) => {
    if (!F_auth || sheetEl.hidden || (ev.target && ev.target.tagName === 'INPUT')) return;
    const t = Date.now();
    if (ev.key === 'Enter') { const code = buf; buf = ''; if (code.length >= 4) scanBadge(code); return; }
    if (ev.key && ev.key.length === 1) { if (t - lastKey > 120) buf = ''; buf += ev.key; lastKey = t; }
  });
  function authCancel() { const A = F_auth; F_auth = null; if (A && A.back) { current = A.back; A.back(); } else hideSheet(); }

  // Envoie une action avec l'identité courante ; en cas de code refusé, on redemande l'identité.
  async function act(path, body) {
    try { return await api('POST', path, { ...creds, ...(body || {}) }); } catch (err) {
      if (err.terminal) { closeSheet(); showSetup(err.message); throw err; }
      if (err.status === 401 || err.status === 429) { creds = null; credsName = ''; renderWho(); }
      throw err;
    }
  }

  // ---------- formulaires : pièces communes ----------
  const stepper = (kg, cap, id) => `<div class="at-weight"><button type="button" data-act="kg" data-d="-5">−5</button><button type="button" data-act="kg" data-d="-0.5">−0,5</button>
    <div class="v" id="${id}">${esc(kgf(kg))}<small>kg</small></div><button type="button" data-act="kg" data-d="0.5">+0,5</button><button type="button" data-act="kg" data-d="5">+5</button>
    ${cap ? `<button type="button" data-act="kg" data-d="max">Pleine charge</button>` : ''}</div>
    <div class="at-fill${cap && kg > cap ? ' over' : ''}" id="${id}-fill">${fillText(kg, cap)}</div>`;
  function fillText(kg, cap) {
    if (!cap) return '';
    return kg > cap ? `Dépasse la capacité (${esc(kgf(cap))} kg)` : `Charge : ${Math.round(kg / cap * 100)} % de ${esc(kgf(cap))} kg`;
  }
  function setKg(d) {
    const m = machineById(F.machineId), cap = m && m.capacityKg;
    if (d === 'max') F.kg = cap || F.kg;
    else F.kg = Math.max(0, Math.round((F.kg + Number(d)) * 2) / 2);
    document.getElementById('at-kg').firstChild.nodeValue = kgf(F.kg);
    const fill = document.getElementById('at-kg-fill');
    fill.className = 'at-fill' + (cap && F.kg > cap ? ' over' : ''); fill.innerHTML = fillText(F.kg, cap);
  }
  const chips = (items, selected, act, attr) => items.map((i) => `<button type="button" class="at-chip${i.off ? ' off' : ''}${selected(i) ? ' on' : ''}" data-act="${act}" data-${attr}="${num(i.id)}">${i.html}</button>`).join('');
  const errBox = () => `<div class="at-err" role="alert" id="at-err">${esc(F.err || '')}</div>`;
  function setErr(msg) { F.err = msg; const el = document.getElementById('at-err'); if (el) el.textContent = msg; }

  function machineChips(stage) {
    const ms = stageMachines(stage).map((m) => {
      const free = m.state === 'free';
      return { id: m.id, off: !free, html: `${esc(m.name)}${m.capacityKg ? ` <small>${esc(kgf(m.capacityKg))} kg</small>` : ''}${free ? '' : ` <small>${m.state === 'down' ? 'à l\'arrêt' : 'occupée'}</small>`}` };
    });
    return chips(ms, (i) => i.id === F.machineId, 'machine', 'm');
  }
  const programChips = () => (S.programs.length ? `<div class="at-blk"><div class="l">Programme <small>facultatif</small></div><div class="at-chips">
    ${chips([{ id: 0, html: 'Aucun' }, ...S.programs.map((p) => ({ id: p.id, html: `${esc(p.name)}${p.durationMin ? ` <small>${num(p.durationMin)} min</small>` : ''}` }))], (i) => (F.programId || 0) === i.id, 'program', 'p')}</div></div>` : '');

  // ---------- nouveau lot ----------
  function openNewLot(machineId) {
    const free = stageMachines('lavage').filter((m) => m.state === 'free');
    const m = machineId ? machineById(machineId) : free[0];
    if (!m) { toast('Aucune laveuse libre pour le moment.', true); return; }
    F = { kind: 'newlot', typeId: null, clients: [], find: '', free: '', machineId: m.id, kg: m.capacityKg || 0, programId: null, err: '' };
    showSheet(renderNewLot);
  }
  function filteredClients() {
    const q = F.find.trim().toLowerCase();
    const chosen = new Set(F.clients.map((c) => c.clientId).filter(Boolean));
    return S.clients.filter((c) => !chosen.has(c.id) && (!q || c.societe.toLowerCase().includes(q))).slice(0, 60);
  }
  const pickHtml = () => filteredClients().map((c) => `<button type="button" class="at-chip" data-act="addclient" data-c="${num(c.id)}">${esc(c.societe)}</button>`).join('') || '<p class="at-none">Aucun client ne correspond.</p>';
  function selectedHtml() {
    const multi = F.clients.length > 1;
    return F.clients.map((c, i) => {
      const cl = c.clientId ? S.clients.find((x) => x.id === c.clientId) : null;
      const orders = cl && cl.orders.length ? cl.orders.map((o) => `<button type="button" class="at-chip${c.orderId === o.id ? ' on' : ''}" data-act="order" data-i="${i}" data-o="${num(o.id)}"><small>Commande</small> ${esc(o.ticket)}</button>`).join('') : '';
      return `<div class="row"><button type="button" class="at-chip on" data-act="rmclient" data-i="${i}">${esc(c.societe)} <span class="x">✕</span></button>${multi ? `<input inputmode="decimal" data-kgin="${i}" placeholder="kg" value="${esc(c.kg)}" aria-label="Kilos de ${esc(c.societe)}">` : ''}</div>${orders ? `<div class="at-chips" style="width:100%">${orders}</div>` : ''}`;
    }).join('');
  }
  function renderNewLot() {
    const m = machineById(F.machineId);
    pane(`${head('Nouveau lot', 'Lavage lancé maintenant.')}
      <div class="at-blk"><div class="l">Type de linge</div><div class="at-chips">${chips(S.linenTypes.map((t) => ({ id: t.id, html: esc(t.label) })), (i) => F.typeId === i.id, 'type', 't')}</div></div>
      <div class="at-blk"><div class="l">Client <small>plusieurs possibles si le lot est mélangé</small></div>
        <div class="at-sel" id="at-sel">${selectedHtml()}</div>
        <input class="at-find" id="at-find" type="search" placeholder="Chercher un client…" value="${esc(F.find)}" autocomplete="off">
        <div class="at-pick" id="at-pick">${pickHtml()}</div>
        <div style="display:flex;gap:8px;margin-top:8px"><input class="at-find" id="at-free" style="margin:0" placeholder="Autre client (nom libre)" value="${esc(F.free)}" autocomplete="off" maxlength="120"><button type="button" class="at-b" data-act="addfree">Ajouter</button></div></div>
      <div class="at-blk"><div class="l">Machine</div><div class="at-chips">${machineChips('lavage')}</div></div>
      <div class="at-blk"><div class="l">Poids chargé</div>${stepper(F.kg, m && m.capacityKg, 'at-kg')}</div>
      ${programChips()}
      ${errBox()}
      <div class="at-go"><button type="button" class="at-b" data-act="close">Annuler</button><button type="button" class="at-b main" data-act="submit-newlot">Démarrer le lavage</button></div>`);
  }
  function refreshClients() { document.getElementById('at-sel').innerHTML = selectedHtml(); document.getElementById('at-pick').innerHTML = pickHtml(); }
  function submitNewLot() {
    if (!F.typeId) return setErr('Choisissez le type de linge.');
    if (!F.clients.length) return setErr('Choisissez au moins un client.');
    if (!(F.kg > 0)) return setErr('Indiquez le poids chargé.');
    needAuth(async () => {
      if (busy) return; busy = true;
      try {
        const r = await act('/lots', {
          linenTypeId: F.typeId, weightKg: F.kg, machineId: F.machineId, programId: F.programId || undefined,
          clients: F.clients.map((c) => ({ clientId: c.clientId || undefined, societe: c.clientId ? undefined : c.societe, weightKg: c.kg || undefined, orderId: c.orderId || undefined })),
        });
        busy = false; const code = r.lot.code; closeSheet(); toast('Lot ' + code + ' lancé.');
      } catch (err) { busy = false; if (current) { current(); setErr(err.network ? 'Pas de connexion au serveur.' : err.message); } }
    });
  }

  const START = { lavage: 'Démarrer le lavage', sechage: 'Démarrer le séchage', finition: 'Démarrer la finition' };
  // ---------- reprendre un lot (séchage, finition, relavage) ----------
  function openResume(lotId, machineId) {
    const lot = S.waiting.find((l) => l.id === Number(lotId));
    if (!lot) { toast('Ce lot n\'est plus en attente.', true); refresh(); return; }
    const m = machineId ? machineById(machineId) : null;
    F = { kind: 'resume', lot, stage: m ? m.bu : null, machineId: m ? m.id : null, kg: lot.weightKg, programId: null, err: '' };
    if (m) F.kg = m.capacityKg ? Math.min(lot.weightKg, m.capacityKg) : lot.weightKg;
    showSheet(renderResume);
  }
  function nextStage(last) { return last === 'lavage' ? 'sechage' : last === 'sechage' ? 'finition' : 'sechage'; }
  function renderResume() {
    const lot = F.lot, clients = lot.clients.length ? ' · ' + esc(lot.clients.join(', ')) : '';
    const sub = `<b>${esc(lot.code)}</b> · ${esc(lot.linenType || '')} · ${esc(kgf(lot.weightKg))} kg${clients}`;
    if (!F.stage) {
      const sug = nextStage(lot.lastStage);
      const opt = (stage, label, small) => `<button type="button" class="at-b${stage === sug ? ' main' : ''}" data-act="stage" data-s="${esc(stage)}">${esc(label)}<small>${esc(small)}</small></button>`;
      pane(`${head('Que faire de ce lot ?', sub)}
        <div class="at-blk"><div class="at-opts">${opt('sechage', 'Séchage', 'Mettre en séchoir')}${opt('finition', 'Finition', 'Calandre')}${opt('lavage', 'Relavage', 'Repasser en laveuse')}
        <button type="button" class="at-b" data-act="closelot">Terminer le lot<small>Prêt à ranger</small></button></div></div>
        <div class="at-go"><button type="button" class="at-b" data-act="close">Annuler</button></div>`);
      return;
    }
    const m = machineById(F.machineId);
    pane(`${head(stageName(F.stage), sub)}
      <div class="at-blk"><div class="l">Machine</div><div class="at-chips">${machineChips(F.stage)}</div></div>
      <div class="at-blk"><div class="l">Poids dans cette machine<small>le lot fait ${esc(kgf(F.lot.weightKg))} kg ; le reste pourra partir dans une autre machine</small></div>${stepper(F.kg, m && m.capacityKg, 'at-kg')}</div>
      ${F.stage === 'lavage' ? programChips() : ''}
      ${errBox()}
      <div class="at-go"><button type="button" class="at-b" data-act="back-stage">Retour</button><button type="button" class="at-b main" data-act="submit-resume">${esc(START[F.stage] || 'Démarrer')}</button></div>`);
  }
  function submitResume() {
    if (!F.machineId) return setErr('Choisissez la machine.');
    if (!(F.kg > 0)) return setErr('Indiquez le poids.');
    needAuth(async () => {
      if (busy) return; busy = true;
      try {
        const r = await act(`/lots/${num(F.lot.id)}/steps`, { stage: F.stage, machineId: F.machineId, weightKg: F.kg, programId: F.programId || undefined });
        busy = false; const m = machineById(F.machineId); closeSheet(); toast(r.lot.code + ' lancé' + (m ? ' sur ' + m.name : '') + '.');
      } catch (err) { busy = false; if (current) { current(); setErr(err.network ? 'Pas de connexion au serveur.' : err.message); } }
    });
  }
  function closeLotNow(lotId) {
    needAuth(async () => {
      try { const r = await act(`/lots/${num(lotId)}/close`, {}); closeSheet(); toast('Lot ' + r.lot.code + ' terminé.'); } catch (err) { toast(err.message, true); }
    });
  }

  // ---------- lancer depuis une machine libre ----------
  function openLaunch(machineId) {
    const m = machineById(machineId);
    if (!m) return;
    if (m.bu === 'lavage') return openNewLot(m.id);
    F = { kind: 'launch', machineId: m.id };
    showSheet(() => {
      pane(`${head('Lancer ' + m.name, 'Quel lot mettre dedans ?')}
        <div class="at-blk">${S.waiting.map((l) => `<button type="button" class="at-lot wait" data-act="launchlot" data-lot="${num(l.id)}"><span class="t"><b>${esc(l.code)}</b> · ${esc(l.linenType || '')} · ${esc(kgf(l.weightKg))} kg</span><span class="s">${esc(stageName(l.lastStage))} terminé il y a ${esc(ago(l.lastEndedAt))}${l.clients.length ? ' · ' + esc(l.clients.join(', ')) : ''}</span></button>`).join('') || '<p class="at-none">Aucun lot à reprendre : lancez d\'abord un lavage.</p>'}</div>
        <div class="at-go"><button type="button" class="at-b" data-act="close">Annuler</button></div>`);
    });
  }

  // ---------- terminer un passage ----------
  function openFinish(stepId) {
    const m = S.machines.find((x) => x.step && x.step.id === Number(stepId));
    if (!m) return;
    const st = m.step;
    F = { kind: 'finish', step: st, machine: m };
    showSheet(() => {
      pane(`${head('Terminer ' + m.name + ' ?', `<b>${esc(st.lotCode)}</b> · ${esc(st.linenType || '')} · ${esc(kgf(st.weightKg))} kg`)}
        <div class="at-go" style="flex-direction:column">
          <button type="button" class="at-b ${st.stage === 'finition' ? '' : 'main'}" data-act="dofinish" data-close="0">Terminer ce passage</button>
          ${st.stage !== 'lavage' ? `<button type="button" class="at-b ${st.stage === 'finition' ? 'main' : ''}" data-act="dofinish" data-close="1">Terminer et clore le lot</button>` : ''}
          <button type="button" class="at-b" data-act="close">Annuler</button></div>
        <div class="at-err" role="alert" id="at-err"></div>`, true);
    });
  }
  function doFinish(closeLot) {
    const st = F.step;
    needAuth(async () => {
      if (busy) return; busy = true;
      try {
        const r = await act(`/steps/${num(st.id)}/finish`, { closeLot: !!closeLot });
        busy = false; closeSheet(); toast(closeLot ? 'Lot ' + r.lot.code + ' terminé.' : st.machineName + ' terminé.');
      } catch (err) { busy = false; if (current) { current(); setErr(err.network ? 'Pas de connexion au serveur.' : err.message); } }
    });
  }

  // ---------- panne ----------
  const REASONS = ['Panne', 'Entretien', 'Manque d\'eau ou d\'énergie', 'Autre'];
  function openDown(machineId) {
    const m = machineById(machineId);
    if (!m) return;
    F = { kind: 'down', machineId: m.id, reason: '', note: '', err: '' };
    showSheet(() => {
      pane(`${head(m.name + ' à l\'arrêt', 'La machine ne pourra plus être choisie tant qu\'elle n\'est pas remise en service.')}
        <div class="at-blk"><div class="l">Cause</div><div class="at-chips">${REASONS.map((r, i) => `<button type="button" class="at-chip${F.reason === r ? ' on' : ''}" data-act="reason" data-i="${i}">${esc(r)}</button>`).join('')}</div></div>
        <div class="at-blk"><div class="l">Précision <small>facultatif</small></div><input class="at-note" id="at-pnote" maxlength="300" value="${esc(F.note)}"></div>
        ${errBox()}
        <div class="at-go"><button type="button" class="at-b" data-act="close">Annuler</button><button type="button" class="at-b main" data-act="dodown">Signaler l'arrêt</button></div>`);
    });
  }
  function doDown() {
    if (!F.reason) return setErr('Indiquez la cause.');
    needAuth(async () => {
      try { await act(`/machines/${num(F.machineId)}/incidents`, { reason: F.reason, note: F.note }); closeSheet(); toast('Machine signalée à l\'arrêt.'); } catch (err) { if (current) { current(); setErr(err.message); } }
    });
  }
  function doUp(incId) {
    needAuth(async () => {
      try { await act(`/incidents/${num(incId)}/resolve`, {}); toast('Machine remise en service.'); refresh(); } catch (err) { toast(err.message, true); }
    });
  }

  // ---------- fiche d'un lot ----------
  const KINDS = [['remarque', 'Remarque'], ['probleme', 'Problème'], ['relavage', 'Relavage']];
  async function openLot(lotId) {
    F = { kind: 'lot', id: Number(lotId), lot: null, noteKind: 'remarque', text: '', err: '' };
    showSheet(() => { pane(`${head('Chargement…')}`); });
    try { const r = await api('GET', `/lots/${num(lotId)}`); if (!F || F.kind !== 'lot') return; F.lot = r.lot; showSheet(renderLot); } catch (err) { if (err.terminal) { closeSheet(); return showSetup(err.message); } toast(err.message, true); closeSheet(); }
  }
  function renderLot() {
    const l = F.lot;
    const steps = l.steps.map((s) => `<li><b>${esc(s.stageLabel)}${s.passes > 1 ? ' ' + num(s.pass) + '/' + num(s.passes) : ''}</b><span>${esc(s.machineName || '—')}</span><span>${esc(hmIso(s.startedAt))}${s.endedAt ? ' – ' + esc(hmIso(s.endedAt)) : ' → en cours'}</span><span class="m">${esc(kgf(s.weightKg))} kg${s.programName ? ' · ' + esc(s.programName) : ''}</span></li>`).join('');
    const notes = l.notes.map((n) => `<li class="${esc(n.kind)}">${esc(n.text)}<small>${esc((KINDS.find((k) => k[0] === n.kind) || [0, n.kind])[1])} · ${esc(hmIso(n.at))}${n.who ? ' · ' + esc(n.who) : ''}</small></li>`).join('');
    pane(`${head('Lot ' + l.code, `${esc(l.linenType || '')} · ${esc(kgf(l.weightKg))} kg · ${esc(l.stageLabel)}`)}
      <div class="at-blk"><div class="l">Clients</div><div class="at-chips">${l.clients.map((c) => `<span class="at-chip">${esc(c.societe)}${c.weightKg ? ` <small>${esc(kgf(c.weightKg))} kg</small>` : ''}</span>`).join('')}</div></div>
      <div class="at-blk"><div class="l">Parcours</div><ul class="at-steps">${steps}</ul></div>
      <div class="at-blk"><div class="l">Remarques et qualité</div><ul class="at-notes">${notes || '<li style="color:var(--steel)">Rien à signaler.</li>'}</ul></div>
      <div class="at-blk"><div class="at-chips">${KINDS.map(([k, label]) => `<button type="button" class="at-chip${F.noteKind === k ? ' on' : ''}" data-act="notekind" data-k="${esc(k)}">${esc(label)}</button>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:8px"><input class="at-note" id="at-ntext" maxlength="400" placeholder="Ex. 3 draps à reprendre (taches)" value="${esc(F.text)}"><button type="button" class="at-b main" data-act="addnote">Ajouter</button></div></div>
      ${errBox()}
      <div class="at-go"><button type="button" class="at-b" data-act="close">Fermer</button></div>`);
  }
  function addNote() {
    const text = (document.getElementById('at-ntext').value || '').trim();
    F.text = text;
    if (!text) return setErr('Écrivez la remarque.');
    needAuth(async () => {
      try { const r = await act(`/lots/${num(F.id)}/notes`, { kind: F.noteKind, text }); F.lot = r.lot; F.text = ''; F.err = ''; toast('Remarque ajoutée.'); showSheet(renderLot); } catch (err) { if (current) { current(); setErr(err.message); } }
    });
  }

  // ---------- clics ----------
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const d = t.dataset;
    switch (d.act) {
      case 'close': if (F_auth) return authCancel(); return closeSheet();
      case 'logout': creds = null; credsName = ''; renderWho(); return toast('Vous êtes déconnecté(e).');
      case 'lot': return openLot(d.lot);
      case 'resume': return openResume(d.lot);
      case 'launch': return openLaunch(d.m);
      case 'launchlot': return openResume(d.lot, F.machineId);
      case 'finish': return openFinish(d.step);
      case 'down': return openDown(d.m);
      case 'up': return doUp(d.inc);
      case 'who': { const e = S.employees.find((x) => x.id === Number(d.emp)); if (e) { F_auth.emp = e; F_auth.step = 'pin'; F_auth.pin = ''; F_auth.err = ''; renderAuth(); } return; }
      case 'key': return authKey(d.k);
      case 'kg': return setKg(d.d);
      case 'type': F.typeId = Number(d.t); return current();
      case 'program': F.programId = Number(d.p) || null; return current();
      case 'machine': {
        const m = machineById(d.m); if (!m || m.state !== 'free') return;
        F.machineId = m.id;
        if (m.capacityKg && F.kind === 'newlot') F.kg = m.capacityKg;
        else if (m.capacityKg && F.kind === 'resume') F.kg = Math.min(F.lot.weightKg, m.capacityKg);
        return current();
      }
      case 'addclient': { const c = S.clients.find((x) => x.id === Number(d.c)); if (c) { F.clients.push({ clientId: c.id, societe: c.societe, kg: '', orderId: null }); F.find = ''; document.getElementById('at-find').value = ''; refreshClients(); } return; }
      case 'addfree': { const v = (document.getElementById('at-free').value || '').trim(); if (v) { F.clients.push({ clientId: null, societe: v, kg: '', orderId: null }); F.free = ''; current(); } return; }
      case 'rmclient': F.clients.splice(Number(d.i), 1); return current();
      case 'order': { const c = F.clients[Number(d.i)]; c.orderId = c.orderId === Number(d.o) ? null : Number(d.o); return current(); }
      case 'submit-newlot': return submitNewLot();
      case 'stage': F.stage = d.s; { const m = stageMachines(F.stage).filter((x) => x.state === 'free'); F.machineId = m.length === 1 ? m[0].id : null; const cap = m.length === 1 ? m[0].capacityKg : null; F.kg = cap ? Math.min(F.lot.weightKg, cap) : F.lot.weightKg; } return current();
      case 'back-stage': F.stage = null; F.machineId = null; return current();
      case 'submit-resume': return submitResume();
      case 'closelot': return closeLotNow(F.lot.id);
      case 'dofinish': return doFinish(d.close === '1');
      case 'reason': F.reason = REASONS[Number(d.i)]; F.note = (document.getElementById('at-pnote') || {}).value || F.note; return current();
      case 'dodown': F.note = (document.getElementById('at-pnote').value || '').trim(); return doDown();
      case 'notekind': F.noteKind = d.k; F.text = (document.getElementById('at-ntext') || {}).value || ''; return current();
      case 'addnote': return addNote();
      default: return undefined;
    }
  });
  document.getElementById('at-new').addEventListener('click', () => openNewLot());
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!F) return;
    if (t.id === 'at-find') { F.find = t.value; document.getElementById('at-pick').innerHTML = pickHtml(); }
    else if (t.id === 'at-free') F.free = t.value;
    else if (t.dataset && t.dataset.kgin !== undefined) F.clients[Number(t.dataset.kgin)].kg = t.value;
  });

  // ---------- activation de la tablette ----------
  function showSetup(msg) {
    S = null; banner(''); document.getElementById('at-new').hidden = true; document.getElementById('at-sum').textContent = '';
    main.innerHTML = `<div class="at-empty" style="max-width:520px"><h1 class="at-h">Activer cette tablette</h1>
      <p class="at-sub">${esc(msg || 'Ouvrez le lien d\'activation donné dans l\'administration (Équipe → Badgeuses), ou collez ici le code d\'activation.')}</p>
      <input class="at-find" id="at-token" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" placeholder="Code d'activation">
      <button type="button" class="at-b main" style="width:100%" id="at-activate">Activer</button>
      <div class="at-err" id="at-setup-err" role="alert"></div></div>`;
    document.getElementById('at-activate').onclick = activate;
  }
  async function activate() {
    const v = (document.getElementById('at-token').value || '').trim();
    if (!/^[0-9a-f]{64}$/.test(v)) { document.getElementById('at-setup-err').textContent = 'Ce code n\'est pas valide (64 caractères).'; return; }
    token = v;
    try { await api('GET', '/state'); store.set(v); refresh(); } catch (err) {
      if (!err.network) token = '';
      document.getElementById('at-setup-err').textContent = err.network ? 'Pas de connexion au serveur.' : err.message;
    }
  }
  window.addEventListener('hashchange', () => { if (takeHash()) { S = null; refresh(); } });

  // ---------- démarrage ----------
  tick();
  if (!token) showSetup(); else { main.innerHTML = '<div class="at-empty"><p class="at-h">Chargement…</p></div>'; refresh(); }
  setInterval(() => { if (token && sheetEl.hidden && !document.hidden) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token && sheetEl.hidden) refresh(); });
})();
