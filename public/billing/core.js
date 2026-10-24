// Espace Facturation — noyau : outils d'affichage, appels API, fenêtres, tiroir, verrou, navigation.
// Dépend de api() et escHtml() (app.js). Les pages s'enregistrent avec Bill.register().

(function () {
  const Bill = window.Bill = { pages: {}, state: { page: 'dashboard', params: {}, badges: {}, idleMs: 600000 } };
  const BASE = '/api/admin/billing';

  // ---------- affichage ----------
  const e = (s) => escHtml(s == null ? '' : String(s));
  const NF2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const NF0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const eur = (c) => (c == null ? '—' : NF2.format(c / 100) + ' €');
  const eur0 = (c) => (c == null ? '—' : NF0.format(Math.round(c / 100)) + ' €');
  const dFr = (iso) => (iso ? new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—');
  const dtFr = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  const plural = (n, one, many) => `${NF0.format(n)} ${n > 1 ? many : one}`;
  Object.assign(Bill, { e, eur, eur0, dFr, dtFr, today, plural });

  const PILL = {
    draft: 'Brouillon', credit_draft: 'Avoir brouillon', unpaid: 'À encaisser', partial: 'Partielle', paid: 'Payée',
    overdue: 'En retard', credited: 'Annulée par avoir', credit_note: 'Avoir',
  };
  Bill.pill = (display) => `<span class="bl-pill ${e(display)}">${e(PILL[display] || display)}</span>`;

  Bill.toast = (msg, bad) => {
    document.querySelectorAll('.bl-toast').forEach(x => x.remove());
    const t = document.createElement('div'); t.className = 'bl-toast' + (bad ? ' bad' : ''); t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), bad ? 6000 : 3200);
  };

  // ---------- appels API ----------
  async function call(method, path, body) {
    try {
      return await api(method, BASE + path, body);
    } catch (err) {
      const code = err.data && err.data.code;
      if (err.status === 423 || code === 'LOCKED' || code === 'LOCK_SETUP_REQUIRED') { err.locked = true; Bill.showLock(); }
      throw err;
    }
  }
  Bill.get = (p) => call('GET', p); Bill.post = (p, b) => call('POST', p, b || {});
  Bill.put = (p, b) => call('PUT', p, b || {}); Bill.del = (p) => call('DELETE', p);
  Bill.base = BASE;
  // Évite le bruit quand l'erreur est « verrouillé » (l'écran de verrouillage est déjà affiché).
  Bill.fail = (err, el) => { if (err.locked) return; if (el) { el.textContent = err.message; } else Bill.toast(err.message, true); };

  // ---------- fenêtres ----------
  Bill.modal = function ({ title, body = '', wide, buttons = [], onOpen }) {
    const back = document.createElement('div'); back.className = 'bl-modal-back';
    back.innerHTML = `<div class="bl-modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${e(title)}"><h3>${e(title)}</h3><div class="bl-modal-body">${body}</div><div class="bl-err" role="alert"></div><div class="bl-foot"></div></div>`;
    document.body.appendChild(back);
    const box = back.querySelector('.bl-modal'); const foot = back.querySelector('.bl-foot'); const errEl = back.querySelector('.bl-err');
    const prevFocus = document.activeElement;
    const api_ = {
      el: box, close() { back.remove(); document.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (_) { /* focus perdu */ } },
      err(msg) { errEl.textContent = msg || ''; }, $: (sel) => box.querySelector(sel),
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); api_.close(); } };
    document.addEventListener('keydown', onKey, true);
    buttons.forEach(b => {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'bl-btn ' + (b.primary ? 'primary' : b.danger ? 'danger' : '');
      btn.textContent = b.label;
      btn.onclick = async () => {
        if (b.keep === undefined && !b.onClick) return api_.close();
        btn.disabled = true; api_.err('');
        try { const keep = await b.onClick(api_); if (!keep) api_.close(); else btn.disabled = false; }
        catch (err) { btn.disabled = false; Bill.fail(err, errEl); }
      };
      foot.appendChild(btn);
    });
    if (onOpen) onOpen(api_);
    const first = box.querySelector('input,select,textarea'); if (first) setTimeout(() => first.focus(), 20);
    return api_;
  };

  Bill.confirm = (title, text, okLabel = 'Confirmer', danger) => new Promise(resolve => {
    Bill.modal({ title, body: `<p class="bl-note" style="white-space:pre-line">${e(text)}</p>`, buttons: [
      { label: 'Annuler', onClick: async () => { resolve(false); } },
      { label: okLabel, primary: !danger, danger: !!danger, onClick: async () => { resolve(true); } },
    ] });
  });

  // Ressaisie du code Facturation avant un acte sensible. Résout true une fois le feu vert obtenu.
  Bill.confirmCode = (scope, title, text) => new Promise(resolve => {
    let done = false;
    const m = Bill.modal({
      title, body: `<p class="bl-note">${e(text || 'Pour continuer, saisissez à nouveau le code de la Facturation.')}</p>
        <div class="bl-field"><label for="bl-cc">Code de la Facturation</label><input id="bl-cc" type="password" autocomplete="off" inputmode="text"></div>`,
      buttons: [
        { label: 'Annuler', onClick: async () => { done = true; resolve(false); } },
        { label: 'Confirmer', primary: true, onClick: async (mm) => {
          try { await Bill.post('/lock/confirm', { code: mm.$('#bl-cc').value, scope }); done = true; resolve(true); return false; }
          catch (err) { if (err.locked) { done = true; resolve(false); return false; } throw err; }
        } },
      ],
      onOpen: (mm) => mm.$('#bl-cc').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') mm.el.querySelector('.bl-foot .primary').click(); }),
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });

  // ---------- tiroir ----------
  let drawer = null;
  Bill.closeDrawer = () => { if (drawer) { drawer.scrim.remove(); drawer.el.remove(); document.removeEventListener('keydown', drawer.onKey); const cb = drawer.onClose; drawer = null; if (cb) cb(); } };
  Bill.drawer = function ({ onClose } = {}) {
    Bill.closeDrawer();
    const scrim = document.createElement('div'); scrim.className = 'bl-scrim';
    const el = document.createElement('aside'); el.className = 'bl-drawer'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    el.innerHTML = '<div class="bl-drawer-h"></div><div class="bl-drawer-body"></div>';
    document.body.appendChild(scrim); document.body.appendChild(el);
    const onKey = (ev) => { if (ev.key === 'Escape' && !document.querySelector('.bl-modal-back')) Bill.closeDrawer(); };
    document.addEventListener('keydown', onKey);
    scrim.onclick = Bill.closeDrawer;
    drawer = { scrim, el, onKey, onClose };
    const d = {
      el, head: el.querySelector('.bl-drawer-h'), body: el.querySelector('.bl-drawer-body'),
      setHead({ title, sub, actions }) {
        d.head.innerHTML = `<div class="top"><div><h3>${title}</h3>${sub ? `<div class="sub">${sub}</div>` : ''}</div><button class="bl-close" aria-label="Fermer">×</button></div>${actions ? `<div class="bl-actions">${actions}</div>` : ''}`;
        d.head.querySelector('.bl-close').onclick = Bill.closeDrawer;
      },
      close: Bill.closeDrawer,
    };
    return d;
  };

  // ---------- pages et navigation ----------
  Bill.register = (key, def) => { Bill.pages[key] = def; };
  const NAV = [
    { key: 'dashboard', label: 'Tableau de bord' },
    { group: 'Ventes' },
    { key: 'invoices', label: 'Factures', badge: 'overdue', hot: true },
    { key: 'deliveries', label: 'Bons de livraison' },
    { key: 'quotes', label: 'Devis' },
    { key: 'month', label: 'Facturer le mois', badge: 'toInvoiceClients' },
    { group: 'Encaissements' },
    { key: 'payments', label: 'Règlements' },
    { key: 'sdd', label: 'Prélèvements SEPA' },
    { key: 'reconcile', label: 'Rapprochement bancaire' },
    { key: 'reminders', label: 'Relances', badge: 'remindersDue' },
    { group: 'Hôtels et tarifs' },
    { key: 'clients', label: 'Hôtels' },
    { key: 'articles', label: 'Articles' },
    { key: 'prices', label: 'Tarifs par hôtel' },
    { group: 'Configuration' },
    { key: 'issuer', label: 'Émetteur' },
    { key: 'security', label: 'Sécurité et sauvegardes' },
    { key: 'pennylane', label: 'Pennylane' },
    { key: 'controls', label: 'Contrôle et FEC' },
  ];

  const root = () => document.getElementById('billing-root');
  const main = () => document.getElementById('bl-main');

  Bill.refreshBadges = async () => {
    try {
      const d = await Bill.get('/dashboard');
      Bill.state.dash = d;
      Bill.state.badges = { overdue: d.overdue.count, toInvoiceClients: d.toInvoice.clients, remindersDue: d.reminders ? d.reminders.due : 0 };
      document.querySelectorAll('[data-badge]').forEach(b => {
        const n = Bill.state.badges[b.dataset.badge] || 0; b.textContent = n; b.style.display = n ? '' : 'none';
      });
      return d;
    } catch (err) { if (!err.locked) console.warn('[facturation] badges', err.message); return null; }
  };

  function railHtml() {
    return NAV.map(n => n.group ? `<div class="bl-rail-group">${e(n.group)}</div>`
      : `<button class="bl-navlink ${Bill.state.page === n.key ? 'active' : ''}" data-go="${n.key}">${e(n.label)}${n.badge ? `<span class="bl-count ${n.hot ? 'hot' : ''}" data-badge="${n.badge}" style="display:none"></span>` : ''}</button>`).join('');
  }

  Bill.go = async function (key, params = {}) {
    if (!Bill.pages[key]) key = 'dashboard';
    Bill.closeDrawer();
    Bill.state.page = key; Bill.state.params = params;
    document.querySelectorAll('.bl-navlink').forEach(b => b.classList.toggle('active', b.dataset.go === key));
    const m = main(); if (!m) return;
    const top = root().getBoundingClientRect().top + window.scrollY - 84;   // sous l'en-tête fixe du site
    if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top) });
    m.innerHTML = '<div class="bl-spin">Chargement…</div>';
    try { await Bill.pages[key].render(m, params); }
    catch (err) { if (!err.locked) m.innerHTML = `<div class="bl-alert bad">${e(err.message)}</div>`; }
    Bill.refreshBadges();
  };

  function shell() {
    root().innerHTML = `<div class="bl">
      <nav class="bl-rail" aria-label="Facturation">${railHtml()}
        <div class="bl-lockbox"><b>Facturation déverrouillée</b><span id="bl-countdown">Verrouillage dans —</span><button class="bl-btn small" id="bl-lock-now">Verrouiller maintenant</button></div>
      </nav>
      <section class="bl-main" id="bl-main" aria-live="polite"></section></div>`;
    root().querySelectorAll('[data-go]').forEach(b => b.onclick = () => Bill.go(b.dataset.go));
    document.getElementById('bl-lock-now').onclick = async () => { try { await Bill.post('/lock/lock'); } catch (_) { /* déjà verrouillé */ } Bill.showLock(); };
  }

  // ---------- verrou : écrans et minuteur d'inactivité ----------
  let idleDeadline = 0; let lastTouch = 0; let timer = null;
  const PADLOCK = '<svg class="bl-padlock" viewBox="0 0 54 54" aria-hidden="true"><rect x="11" y="24" width="32" height="24" rx="5" fill="#16324F"/><path d="M18 24v-6a9 9 0 0 1 18 0v6" fill="none" stroke="#16324F" stroke-width="4.5" stroke-linecap="round"/><circle cx="27" cy="35" r="3.2" fill="#fff"/><rect x="25.7" y="36" width="2.6" height="6" rx="1.3" fill="#fff"/></svg>';

  function stopIdle() { if (timer) { clearInterval(timer); timer = null; } document.removeEventListener('pointerdown', onActivity, true); document.removeEventListener('keydown', onActivity, true); }
  function onActivity() {
    if (!document.getElementById('bl-main')) return;
    const now = Date.now(); idleDeadline = now + Bill.state.idleMs;
    if (now - lastTouch > 30000) { lastTouch = now; Bill.post('/lock/touch').catch(() => {}); }
  }
  function startIdle() {
    stopIdle(); lastTouch = Date.now(); idleDeadline = lastTouch + Bill.state.idleMs;
    document.addEventListener('pointerdown', onActivity, true); document.addEventListener('keydown', onActivity, true);
    const tick = () => {
      const left = idleDeadline - Date.now(); const el = document.getElementById('bl-countdown');
      if (left <= 0) { Bill.post('/lock/lock').catch(() => {}); Bill.showLock('Verrouillée après une période d\'inactivité.'); return; }
      if (el) { const s = Math.ceil(left / 1000); el.textContent = `Verrouillage dans ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
    };
    tick(); timer = setInterval(tick, 1000);
  }

  function lockScreen(kind, info) {
    stopIdle(); Bill.closeDrawer();
    document.querySelectorAll('.bl-modal-back').forEach(m => m.remove());
    const setup = kind === 'setup';
    root().innerHTML = `<div class="bl"><div class="bl-lockscreen"><div class="bl-panel"><div class="bl-panel-b">
      ${PADLOCK}
      <h2>${setup ? 'Protégez la Facturation' : 'Facturation verrouillée'}</h2>
      <p>${setup
        ? 'Choisissez un code propre à la Facturation, différent du mot de passe administrateur. Il sera redemandé après une période d\'inactivité et avant chaque émission de facture, avoir, export ou changement des coordonnées bancaires.'
        : (info || 'Saisissez le code de la Facturation pour continuer.')}</p>
      <form id="bl-lockform" autocomplete="off">
        <div class="bl-field"><label for="bl-code">${setup ? 'Nouveau code (6 caractères minimum)' : 'Code de la Facturation'}</label><input id="bl-code" type="password" autocomplete="${setup ? 'new-password' : 'off'}" required></div>
        ${setup ? '<div class="bl-field"><label for="bl-code2">Saisissez-le une seconde fois</label><input id="bl-code2" type="password" autocomplete="new-password" required></div>' : ''}
        <button class="bl-btn primary" style="width:100%" type="submit">${setup ? 'Définir le code et ouvrir' : 'Déverrouiller'}</button>
        <div class="bl-err" id="bl-lockerr" role="alert"></div>
      </form>
      ${setup ? '<p class="bl-hint" style="margin-top:12px">Notez ce code en lieu sûr. En cas d\'oubli, il se réinitialise depuis l\'hébergeur (voir « Sécurité et sauvegardes »).</p>' : ''}
    </div></div></div></div>`;
    const form = document.getElementById('bl-lockform'); const err = document.getElementById('bl-lockerr');
    document.getElementById('bl-code').focus();
    form.onsubmit = async (ev) => {
      ev.preventDefault(); err.textContent = '';
      try {
        const code = document.getElementById('bl-code').value;
        const r = setup ? await api('POST', BASE + '/lock/setup', { code, confirm: document.getElementById('bl-code2').value }) : await api('POST', BASE + '/lock/unlock', { code });
        Bill.state.idleMs = r.idleMs || Bill.state.idleMs;
        Bill.open();
      } catch (ex) { err.textContent = ex.message; if (ex.data && ex.data.retryAfterSec) form.querySelector('button').disabled = true; }
    };
  }

  Bill.showLock = async (info) => {
    let st; try { st = await api('GET', BASE + '/lock/status'); } catch (_) { st = { configured: true }; }
    lockScreen(st.configured ? 'locked' : 'setup', info);
  };

  // Point d'entrée appelé par app.js quand on ouvre l'onglet Facturation.
  Bill.open = async function () {
    const st = await api('GET', BASE + '/lock/status');
    Bill.state.idleMs = st.idleMs || Bill.state.idleMs;
    if (!st.configured) return lockScreen('setup');
    if (!st.unlocked) return lockScreen('locked', st.retryAfterSec ? `Trop d'essais : réessayez dans ${Math.ceil(st.retryAfterSec / 60)} min.` : null);
    shell(); startIdle();
    Bill.go(Bill.state.page || 'dashboard', Bill.state.params);
  };
  window.renderBillingTab = Bill.open;
})();
