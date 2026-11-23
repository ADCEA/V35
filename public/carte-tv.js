// Carte des tournées plein écran pour la TV du local. Lecture seule, rien à toucher : la page se rafraîchit toute seule.
// Accès : le lien de la TV (jeton dans la partie « # » de l'adresse, retenu ensuite dans ce navigateur) ou, pour l'aperçu,
// la session administrateur. Les données viennent de GET /api/tv/map (ou /api/admin/logistics/map en aperçu), relue toutes les 15 s.
(function () {
  const POLL_MS = 15000;
  const LOST_AFTER_MS = 50000;          // sans données fraîches depuis ce délai : bandeau « connexion perdue »
  const RELOAD_EVERY_MS = 3 * 3600 * 1000;   // la page se recharge d'elle-même : elle reprend ainsi les mises à jour de l'application
  const REFIT_EVERY_MS = 5 * 60 * 1000;
  const TOKEN_KEY = 'cezanne.tv.token';

  // ---- fonds de carte (mêmes serveurs que la carte de l'administration : ils figurent déjà dans « img-src ») ----
  const IGN = (layer, format) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&FORMAT=${format}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
  const BASEMAPS = {
    plan: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
    sat: { url: IGN('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), opts: { maxZoom: 19, maxNativeZoom: 19, attribution: '© IGN' } },
  };

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const hhmmss = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });
  const unit = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;   // 1 rem en pixels

  const TRUCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h11v9H2zM13 9h4l3 3v3h-7"/><circle cx="6.5" cy="17.5" r="1.8" fill="#fff"/><circle cx="16.5" cy="17.5" r="1.8" fill="#fff"/></svg>';

  // ---- accès : lien de la TV, sinon session administrateur ----
  const store = {
    get() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
    set(v) { try { if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); } catch { /* pas de stockage : le lien doit rester dans l'adresse */ } },
  };
  let token = '';
  (function initToken() {
    const fromHash = decodeURIComponent((location.hash || '').replace(/^#/, '')).trim();
    if (fromHash.length >= 32) {
      token = fromHash; store.set(token);
      try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sans effet : l'adresse garde le jeton */ }
    } else token = store.get();
  })();
  let previewMode = !token;   // pas de lien : on essaie la session administrateur (aperçu)

  // ---- état ----
  let map = null; let layer = null; let baseLayer = null;
  let last = null; let lastSig = ''; let lastOkAt = 0; let fails = 0; let loading = false; let lastFitAt = 0; let blocked = false;
  let tvRefusal = null;   // réponse du serveur quand le lien de la TV est refusé (désactivé ou remplacé)

  function ensureMap() {
    if (map) return;
    map = L.map('tv-map', {
      zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, touchZoom: false, tap: false, zoomSnap: 0.25,
    }).setView([44.055, 5.049], 12);
    const want = new URLSearchParams(location.search).get('fond');
    setBasemap(want === 'nav' || BASEMAPS[want] ? want : 'nav');
    layer = L.layerGroup().addTo(map);
  }

  function setBasemap(id) {
    if (baseLayer) map.removeLayer(baseLayer);
    // « Navigation » : fond vectoriel clair (fond-navigation.js). Sans WebGL, ou s'il ne s'affiche pas : le plan.
    if (id === 'nav') {
      if (!(window.FondNavigation && FondNavigation.supported())) return setBasemap('plan');
      const nav = FondNavigation.create(() => { if (baseLayer === nav) setBasemap('plan'); });
      baseLayer = nav;
      nav.addTo(map);
      return;
    }
    const def = BASEMAPS[id];
    let loaded = 0; let failed = 0;
    baseLayer = L.tileLayer(def.url, { zIndex: 1, ...def.opts });
    baseLayer.on('tileload', () => { loaded++; });
    // Fond injoignable : retour au plan plutôt qu'une carte vide.
    baseLayer.on('tileerror', () => { failed++; if (id !== 'plan' && failed >= 4 && loaded === 0) setBasemap('plan'); });
    baseLayer.addTo(map).bringToBack();
  }

  const icon = (html, size) => L.divIcon({ html, className: 'tm-icon', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

  function draw(data) {
    const U = unit();
    layer.clearLayers();
    const pts = [];
    const dests = [];   // prochain arrêt de chaque chauffeur : son nom s'affiche sur la carte
    if (data.depot) {
      L.marker([data.depot.lat, data.depot.lng], { icon: icon('<div class="tv-depot">⌂</div>', Math.round(U * 2.3)), zIndexOffset: 100, interactive: false }).addTo(layer);
      pts.push([data.depot.lat, data.depot.lng]);
    }
    for (const d of data.drivers) {
      for (const leg of d.legs) {
        L.polyline(leg.points, leg.done
          ? { color: d.color, weight: U * 0.4, opacity: 0.9, interactive: false }
          : { color: d.color, weight: U * 0.3, opacity: 0.75, dashArray: `${Math.round(U * 0.5)} ${Math.round(U * 0.6)}`, interactive: false }).addTo(layer);
        leg.points.forEach(p => pts.push(p));
      }
      const next = d.stops.find(s => s.status !== 'delivered');
      d.stops.forEach((s, i) => {
        if (s.lat == null) return;
        const isNext = s === next;
        const size = Math.round(U * (isNext ? 2.5 : 1.95));
        const cls = `tv-stop${s.status === 'delivered' ? ' done' : ''}${isNext ? ' next' : ''}${s.collectOnly ? ' collect' : ''}`;
        const m = L.marker([s.lat, s.lng], { icon: icon(`<div class="${cls}" style="--c:${esc(d.color)}">${s.status === 'delivered' ? '✓' : esc(s.sequence ?? i + 1)}</div>`, size), zIndexOffset: isNext ? 400 : 200, interactive: false }).addTo(layer);
        if (isNext) dests.push({ m, name: s.societe, half: Math.round(size / 2) + 4 });
        pts.push([s.lat, s.lng]);
      });
      if (d.truck) {
        const live = d.truck.source === 'gps';
        L.marker([d.truck.lat, d.truck.lng], { icon: icon(`<div class="tv-truck${live ? ' live' : ''}" style="--c:${esc(d.color)}">${TRUCK_SVG}</div>`, Math.round(U * 3.1)), zIndexOffset: 1000, interactive: false }).addTo(layer)
          .bindTooltip(esc(d.name), { permanent: true, direction: 'bottom', offset: [0, Math.round(U * 1.4)], className: 'tv-tip' });
        pts.push([d.truck.lat, d.truck.lng]);
      }
    }
    for (const s of data.unassigned) {
      if (s.lat == null) continue;
      L.marker([s.lat, s.lng], { icon: icon('<div class="tv-stop loose">·</div>', Math.round(U * 1.4)), interactive: false }).addTo(layer);
      pts.push([s.lat, s.lng]);
    }
    fit(pts);
    // Le nom s'affiche du côté où il reste de la place (à gauche pour un arrêt vers le bord droit), après le cadrage.
    const width = map.getSize().x;
    for (const { m, name, half } of dests) {
      const left = map.latLngToContainerPoint(m.getLatLng()).x > width * 0.58;
      m.bindTooltip(esc(name), { permanent: true, direction: left ? 'left' : 'right', offset: [left ? -half : half, 0], className: 'tv-dest' });
    }
  }

  /** Recadre la carte quand un point sort de l'écran, quand tout est devenu petit, ou de temps en temps : personne n'a la main dessus. */
  function fit(pts) {
    if (!pts.length) return;
    const b = L.latLngBounds(pts);
    const v = map.getBounds();
    const area = (x) => Math.abs((x.getNorth() - x.getSouth()) * (x.getEast() - x.getWest()));
    const stale = Date.now() - lastFitAt > REFIT_EVERY_MS;
    if (lastFitAt && !stale && v.contains(b) && area(b) > area(v) * 0.15) return;
    const pad = Math.round(unit() * 4);
    map.fitBounds(b, { paddingTopLeft: [pad, pad], paddingBottomRight: [pad, pad * 1.3], maxZoom: 15, animate: false });
    lastFitAt = Date.now();
  }

  // ---- panneau des chauffeurs ----
  function panel(data) {
    const el = $('tv-panel');
    el.classList.remove('dense');
    const cards = data.drivers.filter(d => d.stops.length || d.truck).map(d => {
      const done = d.stats.done; const total = d.stats.total;
      const next = d.stops.find(s => s.status !== 'delivered');
      const lastDone = d.stops.filter(s => s.status === 'delivered' && s.deliveredAt).sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt))[0];
      const finished = total > 0 && !next;
      const pills = d.stops.map((s, i) => {
        const cls = [s.status === 'delivered' ? 'done' : (s === next ? 'next' : ''), s.collectOnly ? 'collect' : ''].filter(Boolean).join(' ');
        return `<li class="${cls}">${s.status === 'delivered' ? '✓' : esc(s.sequence ?? i + 1)}</li>`;
      }).join('');
      const nextLine = finished
        ? `<div class="tv-next fin">Tournée terminée${lastDone ? ` à ${esc(hhmm(lastDone.deliveredAt))}` : ''}</div>`
        : next ? `<div class="tv-next"><small>${next.collectOnly ? 'Collecte' : 'Prochain'}</small>${esc(next.societe)}</div>`
        : '<div class="tv-next"><small>Aucun arrêt aujourd\'hui</small></div>';
      const lastLine = lastDone && !finished ? `<div class="tv-meta">${lastDone.collectOnly ? 'Dernière collecte' : 'Dernière livraison'} : ${esc(lastDone.societe)} à ${esc(hhmm(lastDone.deliveredAt))}</div>` : '';
      const t = d.truck;
      const pos = !t ? '' : t.source === 'gps' ? '<span class="tv-live">● Position en direct</span>'
        : t.source === 'delivery' ? 'Position : dernière livraison' : 'Au dépôt';
      return `<section class="tv-drv" style="--c:${esc(d.color)}">
        <div class="tv-head">
          <span class="tv-name">${esc(d.name)}</span>${d.vehicle ? `<span class="tv-veh">${esc(d.vehicle)}</span>` : ''}
          <span class="tv-count${finished ? ' finished' : ''}">${finished ? '✓ Terminé' : `${done}<small> / ${total}</small>`}</span>
        </div>
        ${pills ? `<ul class="tv-pills">${pills}</ul>` : ''}
        ${nextLine}${lastLine}
        ${pos ? `<div class="tv-meta pos">${pos}</div>` : ''}
      </section>`;
    });
    const loose = data.unassigned.length ? `<p class="tv-loose">${data.unassigned.length} commande${data.unassigned.length > 1 ? 's' : ''} prête${data.unassigned.length > 1 ? 's' : ''} sans chauffeur</p>` : '';
    el.innerHTML = (cards.join('') || '<div class="tv-none">Aucune tournée aujourd\'hui.</div>') + loose;
    // Les cartes se partagent la hauteur : si l'une déborde (beaucoup de chauffeurs ou d'arrêts), on compacte tout le panneau.
    if ([...el.querySelectorAll('.tv-drv')].some(c => c.scrollHeight > c.clientHeight + 2)) el.classList.add('dense');
  }

  function totals(data) {
    let done = 0; let total = 0;
    for (const d of data.drivers) { done += d.stats.done; total += d.stats.total; }
    $('tv-total').innerHTML = total ? `<b>${done} / ${total}</b>arrêts faits` : '';
  }

  // ---- données ----
  function block(title, text) {
    blocked = true;
    $('tv-block-title').textContent = title; $('tv-block-text').textContent = text; $('tv-block').hidden = false;
  }
  const unblock = () => { blocked = false; $('tv-block').hidden = true; };

  async function fetchMap() {
    const res = previewMode
      ? await fetch('/api/admin/logistics/map', { credentials: 'same-origin', cache: 'no-store' })
      : await fetch('/api/tv/map', { headers: { 'x-tv-token': token }, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || 'Accès refusé.'); err.auth = true; err.code = body.code; throw err;
    }
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    return res.json();
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      ensureMap();
      const data = await fetchMap();
      const sig = JSON.stringify({ ...data, generatedAt: 0 });
      last = data; lastOkAt = Date.now(); fails = 0;
      unblock();
      if (sig !== lastSig) { lastSig = sig; draw(data); panel(data); totals(data); }
      $('tv-preview').hidden = !previewMode;
      renderBanner();
    } catch (err) {
      if (err.auth) {
        if (!previewMode) {
          // Lien remplacé ou désactivé : on l'oublie. Un administrateur connecté retombe sur l'aperçu, sinon écran explicatif.
          tvRefusal = err; store.set(''); token = ''; previewMode = true; loading = false; return await refresh();
        }
        if (tvRefusal) {
          block(tvRefusal.code === 'TV_DISABLED' ? 'Le lien de la TV est désactivé' : 'Ce lien de la TV n\'est plus valable',
            'Créez un nouveau lien dans Logistique, sous la carte des tournées (bouton « Écran TV »), puis ouvrez-le sur cet écran.');
        } else {
          block('Ouvrez cette page avec le lien de la TV',
            'Dans Logistique, sous la carte des tournées, le bouton « Écran TV » crée le lien à ouvrir sur l\'écran. Connecté en administrateur, vous pouvez y voir un aperçu.');
        }
        $('tv-preview').hidden = true;
      } else { fails++; renderBanner(); }
    } finally { loading = false; }
  }

  function renderBanner() {
    const el = $('tv-banner');
    const lost = !blocked && lastOkAt && (fails >= 2 || Date.now() - lastOkAt > LOST_AFTER_MS);
    el.hidden = !lost;
    if (lost) el.textContent = `Connexion perdue — dernières données de ${hhmmss(lastOkAt)}`;
  }

  // ---- horloge, plein écran, veille ----
  function tick() {
    const now = new Date();
    $('tv-clock').textContent = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
    $('tv-date').textContent = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
    renderBanner();
  }

  let idleTimer = null;
  function awake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  }
  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } catch { /* navigateur sans plein écran : F11 */ }
  }

  let wake = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wake && !document.hidden) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => { wake = null; });
      }
    } catch { /* facultatif : la veille de la TV se règle sur la TV */ }
  }

  document.addEventListener('mousemove', awake);
  document.addEventListener('keydown', (e) => { awake(); if (e.key === 'f' || e.key === 'F') toggleFullscreen(); });
  document.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('click', (e) => { if (e.target.closest('#tv-fs')) toggleFullscreen(); keepAwake(); });
  document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('is-fs', !!document.fullscreenElement); if (map) setTimeout(() => map.invalidateSize(), 100); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { keepAwake(); refresh(); } });
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (map) { map.invalidateSize(); lastFitAt = 0; } if (last) { lastSig = ''; refresh(); } }, 250);
  });

  tick(); setInterval(tick, 1000);
  awake(); keepAwake();
  refresh(); setInterval(refresh, POLL_MS);
  setTimeout(() => location.reload(), RELOAD_EVERY_MS);

  window.CarteTV = { refresh };
})();
