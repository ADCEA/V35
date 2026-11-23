// Carte des tournées (onglet Logistique) : le dépôt, l'itinéraire de chaque chauffeur, ses arrêts (faits / à faire, avec
// l'heure de validation) et son camion. Le camion est à la position partagée par le livreur si elle est récente, sinon à
// sa dernière livraison validée. Les données viennent de GET /api/admin/logistics/map, relue toutes les 15 secondes tant
// que l'onglet est affiché.
(function () {
  const POLL_MS = 15000;
  let map = null; let layer = null; let timer = null; let loading = false; let firstFit = true;
  let last = null; const markers = new Map();   // orderId -> marqueur d'arrêt
  let focus = null;                              // chauffeur dont on suit la tournée (null = toutes)

  // ---- fonds de carte : changer d'un clic (choix retenu dans ce navigateur) ----
  // Chaque serveur de tuiles doit aussi figurer dans « img-src » de la politique de contenu (src/middleware/security.js) :
  // test/fonds-de-carte.test.js le vérifie. Les tuiles IGN sont servies sans clé par la Géoplateforme (WMTS, grille « PM » = Web Mercator).
  const IGN = (layer, format) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&FORMAT=${format}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
  const IGN_ATTR = '© <a href="https://www.ign.fr/" target="_blank" rel="noopener">IGN</a>';
  // « Navigation » : fond vectoriel clair (public/fonds/navigation.json, tuiles OpenFreeMap) dessiné par MapLibre : voir fond-navigation.js.
  const BASEMAPS = [
    { id: 'nav', label: 'Navigation', gl: true },
    { id: 'plan', label: 'Plan', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' } },
    { id: 'sat', label: 'Satellite', url: IGN('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), opts: { maxZoom: 19, maxNativeZoom: 19, attribution: IGN_ATTR } },
  ];
  const BASE = { id: null, layer: null, loaded: 0, failed: 0 };
  const baseStore = {
    get() { try { const v = localStorage.getItem('cezanne.basemap'); return BASEMAPS.some(b => b.id === v) ? v : 'nav'; } catch { return 'nav'; } },
    set(v) { try { localStorage.setItem('cezanne.basemap', v); } catch { /* pas de stockage : le choix n'est pas retenu */ } },
  };

  function setBasemap(id, { save = true } = {}) {
    const def = BASEMAPS.find(b => b.id === id) || BASEMAPS[0];
    if (!map) return;
    if (def.gl && !(window.FondNavigation && FondNavigation.supported())) {
      status('Le fond « Navigation » ne peut pas s\'afficher sur cet appareil : retour au plan.', true);
      return setBasemap('plan', { save: false });
    }
    if (BASE.layer) map.removeLayer(BASE.layer);
    BASE.id = def.id; BASE.loaded = 0; BASE.failed = 0;
    if (def.gl) {
      // Style ou tuiles injoignables : retour au plan plutôt qu'une carte vide, avec l'explication.
      BASE.layer = FondNavigation.create(() => {
        if (BASE.id !== def.id) return;
        status('Fond « Navigation » indisponible : retour au plan.', true);
        setBasemap('plan', { save: false });
      });
      BASE.layer.addTo(map);
    } else {
      BASE.layer = L.tileLayer(def.url, { zIndex: 1, ...def.opts });
      BASE.layer.on('tileload', () => { BASE.loaded++; });
      // Un fond qui ne s'affiche pas du tout (service injoignable) : retour au plan plutôt qu'une carte vide, avec l'explication.
      BASE.layer.on('tileerror', () => {
        if (def.id === 'plan' || BASE.id !== def.id) return;
        BASE.failed++;
        if (BASE.failed >= 4 && BASE.loaded === 0) { status(`Fond « ${def.label} » indisponible : retour au plan.`, true); setBasemap('plan', { save: false }); }
      });
      BASE.layer.addTo(map).bringToBack();
    }
    if (save) baseStore.set(def.id);
    document.querySelectorAll('#tours-basemaps [data-basemap]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.basemap === def.id)));
  }

  // ---- trafic en temps réel : tout passe par le serveur (/api/admin/traffic), la page ne connaît aucune clé ----
  const TRAFFIC = { status: null, on: false, layer: null, eta: new Map(), loading: false, errTimer: null, restored: false };
  const ETA_TTL_MS = 5 * 60 * 1000;   // un itinéraire n'est recalculé qu'après 5 min (chaque calcul compte dans le plafond quotidien)
  const FATAL = ['budget', 'key_rejected', 'paused', 'disabled', 'key_invalid', 'bad_config'];
  const remember = {
    get() { try { return localStorage.getItem('cezanne.traffic') === '1'; } catch { return false; } },
    set(v) { try { localStorage.setItem('cezanne.traffic', v ? '1' : '0'); } catch { /* pas de stockage : le choix n'est pas retenu */ } },
  };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const hhmmss = (d) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ago = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return `il y a ${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  };
  const duration = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);

  const TRUCK_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h11v9H2zM13 9h4l3 3v3h-7"/><circle cx="6.5" cy="17.5" r="1.8" fill="#fff"/><circle cx="16.5" cy="17.5" r="1.8" fill="#fff"/></svg>';

  function icon(html, size) {
    return L.divIcon({ html, className: 'tm-icon', iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
  }
  const depotIcon = () => icon('<div class="tm-depot" title="Dépôt">⌂</div>', 30);
  const stopIcon = (n, color, done) => icon(
    `<div class="tm-stop ${done ? 'done' : ''}" style="--c:${esc(color)}">${done ? '✓' : esc(n)}</div>`, 26);
  const looseIcon = () => icon('<div class="tm-stop loose">·</div>', 18);
  const truckIcon = (color, live) => icon(`<div class="tm-truck ${live ? 'live' : ''}" style="--c:${esc(color)}">${TRUCK_SVG}</div>`, 38);

  function ensureMap() {
    if (map) return true;
    const el = document.getElementById('tours-map');
    if (!el || typeof L === 'undefined') return false;
    map = L.map(el, { zoomControl: true, attributionControl: true }).setView([44.055, 5.049], 11);
    setBasemap(baseStore.get(), { save: false });
    layer = L.layerGroup().addTo(map);
    map.on('click', onMapClick);
    return true;
  }

  function renderTrafficNote() {
    const el = document.getElementById('tours-traffic-note');
    if (!el) return;
    const st = TRAFFIC.status;
    if (!st || !st.enabled || !TRAFFIC.on) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    if (st.message) { el.className = 'tm-tnote bad'; el.textContent = st.message; return; }
    el.className = 'tm-tnote';
    el.innerHTML = `<span>Circulation en direct :</span><span>fluide</span><i class="tm-grad" aria-hidden="true"></i><span>bouché</span>
      <span>Cliquez sur la carte pour la vitesse à cet endroit.</span>
      <span class="tm-mute">Aujourd'hui : ${esc(st.usage.tiles.used)}/${esc(st.usage.tiles.limit)} tuiles, ${esc(st.usage.api.used)}/${esc(st.usage.api.limit)} calculs.</span>`;
  }

  async function loadTrafficStatus() {
    try {
      const res = await fetch('/api/admin/traffic/status', { credentials: 'same-origin' });
      TRAFFIC.status = res.ok ? await res.json() : null;
    } catch { TRAFFIC.status = null; }
    const btn = document.getElementById('tours-traffic');
    const available = !!(TRAFFIC.status && TRAFFIC.status.enabled);
    if (btn) btn.hidden = !available;
    if (available && !TRAFFIC.restored) { TRAFFIC.restored = true; if (remember.get()) setTraffic(true); }
    if (!available && TRAFFIC.on) setTraffic(false);
    renderTrafficNote();
  }

  function setTraffic(on) {
    TRAFFIC.on = !!on && !!(TRAFFIC.status && TRAFFIC.status.enabled);
    const btn = document.getElementById('tours-traffic');
    if (btn) btn.setAttribute('aria-pressed', String(TRAFFIC.on));
    if (map) {
      if (TRAFFIC.on && !TRAFFIC.layer) {
        TRAFFIC.layer = L.tileLayer('/api/admin/traffic/tiles/relative0/{z}/{x}/{y}.png', {
          minZoom: 6, maxZoom: 19, maxNativeZoom: 18, opacity: 0.85, zIndex: 5,
          attribution: '© <a href="https://www.tomtom.com/" target="_blank" rel="noopener">TomTom</a>',
        });
        // Tuiles refusées (clé, plafond, panne) : on relit l'état pour dire pourquoi au lieu de laisser une carte sans couche.
        TRAFFIC.layer.on('tileerror', () => { clearTimeout(TRAFFIC.errTimer); TRAFFIC.errTimer = setTimeout(loadTrafficStatus, 1500); });
      }
      if (TRAFFIC.on) TRAFFIC.layer.addTo(map); else if (TRAFFIC.layer) map.removeLayer(TRAFFIC.layer);
    }
    renderTrafficNote();
    if (TRAFFIC.on) loadEtas(); else if (last) side(last);
  }

  async function onMapClick(e) {
    if (!TRAFFIC.on) return;
    const at = e.latlng.wrap();
    const pop = L.popup({ maxWidth: 240 }).setLatLng(at).setContent('<div class="tm-speed tm-mute">Mesure de la vitesse…</div>').openOn(map);
    try {
      const res = await fetch(`/api/admin/traffic/speed?lat=${at.lat.toFixed(5)}&lng=${at.lng.toFixed(5)}`, { credentials: 'same-origin' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Erreur ${res.status}`);
      const pct = d.ratio != null ? Math.round(d.ratio * 100) : null;
      pop.setContent(d.closed ? '<div class="tm-speed"><b>Route fermée</b></div>'
        : `<div class="tm-speed"><b>${esc(d.currentKmh)} km/h</b> en ce moment<br><span class="tm-mute">Habituellement ${esc(d.freeFlowKmh)} km/h${pct != null ? ` · ${esc(pct)} % de la normale` : ''}</span></div>`);
    } catch (err) { pop.setContent(`<div class="tm-speed tm-mute">${esc(err.message)}</div>`); }
  }

  /** Heures de passage avec le trafic du moment, par chauffeur (rechargées au plus toutes les 5 min). */
  async function loadEtas() {
    if (!TRAFFIC.on || !last || TRAFFIC.loading) return;
    const due = last.drivers.filter(d => d.stats.total > d.stats.done).filter(d => { const e = TRAFFIC.eta.get(d.id); return !e || Date.now() - e.at > ETA_TTL_MS; });
    if (!due.length) return;
    TRAFFIC.loading = true;
    try {
      for (let i = 0; i < due.length; i++) {
        const d = due[i]; const e = { at: Date.now() };
        try {
          const res = await fetch(`/api/admin/traffic/driver/${encodeURIComponent(d.id)}/eta`, { credentials: 'same-origin' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { e.error = data.error || `Erreur ${res.status}`; e.fatal = FATAL.includes(data.code); }
          else { e.data = data; e.byOrder = new Map(); for (const st of data.stops) for (const it of st.items || []) if (it.orderId != null) e.byOrder.set(it.orderId, st); }
        } catch { e.error = 'Trafic indisponible.'; }
        TRAFFIC.eta.set(d.id, e);
        if (e.fatal) { for (const rest of due.slice(i + 1)) TRAFFIC.eta.set(rest.id, { at: e.at, error: e.error, fatal: true }); break; }   // inutile d'insister
      }
    } finally { TRAFFIC.loading = false; }
    if (last) side(last);
    loadTrafficStatus();   // met à jour le compteur d'appels du jour
  }

  function etaHtml(d) {
    if (!TRAFFIC.on || d.stats.total <= d.stats.done) return '';
    const e = TRAFFIC.eta.get(d.id);
    if (!e) return '<div class="tm-eta tm-mute">Calcul du trafic…</div>';
    if (e.error) return e.fatal ? `<div class="tm-eta bad">${esc(e.error)}</div>` : '';
    const x = e.data;
    if (!x.stops.length || !x.totals) return x.note ? `<div class="tm-eta">${esc(x.note)}</div>` : '';
    const lastStop = x.stops[x.stops.length - 1]; const t = x.totals;
    return `<div class="tm-eta" title="Calculé à ${esc(hhmmss(new Date(e.at)))} avec le trafic du moment. Conduite seule : le temps passé chez chaque hôtel n'est pas compté.">
      Dernier arrêt vers <b>${esc(hhmm(lastStop.etaAt))}</b>${x.backToDepot ? ` · retour au dépôt <b>${esc(hhmm(x.backToDepot.etaAt))}</b>` : ''}<br>
      ${esc(duration(t.driveMin))} de route${t.delayMin >= 2 ? ` <span class="late">dont +${esc(t.delayMin)} min de trafic</span>` : ' · circulation fluide'}</div>`;
  }

  function stopEta(d, s) {
    const e = TRAFFIC.on ? TRAFFIC.eta.get(d.id) : null;
    const st = e && e.byOrder ? e.byOrder.get(s.orderId) : null;
    return st ? `<small class="eta">≈ ${esc(hhmm(st.etaAt))}</small>` : '<small>à faire</small>';
  }

  function stopPopup(d, s) {
    const state = s.status === 'delivered'
      ? `<b class="tm-ok">Livré à ${hhmm(s.deliveredAt)}</b>${s.minutesSincePrev != null ? ` · ${duration(s.minutesSincePrev)} après la précédente` : ''}`
      : '<b>À livrer</b>';
    return `<div class="tm-pop"><b>${esc(s.societe)}</b><br>${esc(s.adresse)}<br><span class="tm-mute">${esc(s.ticket)}${d ? ` · ${esc(d.name)}` : ''}</span><br>${state}</div>`;
  }

  function truckPopup(d) {
    const t = d.truck;
    const where = t.source === 'gps' ? `Position partagée ${ago(t.at)}${t.accuracyM ? ` (± ${t.accuracyM} m)` : ''}`
      : t.source === 'delivery' ? `Dernière livraison validée : ${esc(t.label)} à ${hhmm(t.at)}`
      : 'Au dépôt';
    return `<div class="tm-pop"><b>${esc(d.name)}</b>${d.vehicle ? ` · ${esc(d.vehicle)}` : ''}<br>${where}<br><span class="tm-mute">${d.stats.done}/${d.stats.total} livraisons</span></div>`;
  }

  function draw(data) {
    layer.clearLayers(); markers.clear();
    const pts = [];
    if (data.depot) {
      L.marker([data.depot.lat, data.depot.lng], { icon: depotIcon(), zIndexOffset: 100 }).addTo(layer)
        .bindPopup(`<div class="tm-pop"><b>Dépôt</b><br>${esc(data.depot.address || '')}</div>`);
      pts.push([data.depot.lat, data.depot.lng]);
    }
    const shown = data.drivers.filter(d => focus == null || d.id === focus);
    for (const d of shown) {
      for (const leg of d.legs) {
        L.polyline(leg.points, leg.done
          ? { color: d.color, weight: 5, opacity: 0.9 }
          : { color: d.color, weight: 4, opacity: 0.7, dashArray: '8 10' }).addTo(layer);
        leg.points.forEach(p => pts.push(p));
      }
      d.stops.forEach((s, i) => {
        if (s.lat == null) return;
        const m = L.marker([s.lat, s.lng], { icon: stopIcon(s.sequence ?? i + 1, d.color, s.status === 'delivered') }).addTo(layer).bindPopup(stopPopup(d, s));
        markers.set(s.orderId, m);
        pts.push([s.lat, s.lng]);
      });
      if (d.truck) {
        const live = d.truck.source === 'gps';
        L.marker([d.truck.lat, d.truck.lng], { icon: truckIcon(d.color, live), zIndexOffset: 1000 }).addTo(layer)
          .bindPopup(truckPopup(d))
          .bindTooltip(esc(d.name), { permanent: true, direction: 'bottom', offset: [0, 14], className: 'tm-tip' });
        pts.push([d.truck.lat, d.truck.lng]);
      }
    }
    if (focus == null) {
      for (const s of data.unassigned) {
        if (s.lat == null) continue;
        const m = L.marker([s.lat, s.lng], { icon: looseIcon() }).addTo(layer).bindPopup(stopPopup(null, s) + '<br><span class="tm-mute">Pas encore affectée à un chauffeur</span>');
        markers.set(s.orderId, m); pts.push([s.lat, s.lng]);
      }
    }
    if (pts.length && firstFit) { map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 }); firstFit = false; }
  }

  function side(data) {
    const box = document.getElementById('tours-side');
    if (!box) return;
    const cards = data.drivers.map(d => {
      const pct = d.stats.total ? Math.round(100 * d.stats.done / d.stats.total) : 0;
      const t = d.truck;
      const where = !t ? 'Position inconnue'
        : t.source === 'gps' ? `<span class="tm-live">● Position partagée</span> · ${ago(t.at)}`
        : t.source === 'delivery' ? `Dernière livraison : ${esc(t.label)} à ${hhmm(t.at)}`
        : 'Au dépôt';
      const timing = d.stats.done
        ? `1ʳᵉ livraison ${hhmm(d.stats.firstDeliveryAt)} · dernière ${hhmm(d.stats.lastDeliveryAt)}${d.stats.avgMinutesBetween != null ? ` · ${duration(d.stats.avgMinutesBetween)} en moyenne entre deux` : ''}` : '';
      const lost = d.stops.filter(s => s.lat == null).length;
      return `
        <section class="tm-driver ${focus === d.id ? 'sel' : ''}" data-driver="${d.id}">
          <button type="button" class="tm-driver-head" data-focus="${d.id}" aria-pressed="${focus === d.id}">
            <span class="tm-dot" style="background:${esc(d.color)}"></span>
            <span class="tm-name">${esc(d.name)}${d.vehicle ? `<small>${esc(d.vehicle)}</small>` : ''}</span>
            <span class="tm-count">${d.stats.done}/${d.stats.total}</span>
          </button>
          <div class="tm-bar" aria-hidden="true"><i style="width:${pct}%;background:${esc(d.color)}"></i></div>
          <div class="tm-where">${where}</div>
          ${etaHtml(d)}
          ${timing ? `<div class="tm-timing">${timing}</div>` : ''}
          ${d.stops.length ? `<ol class="tm-stops">${d.stops.map((s, i) => `
            <li class="${s.status}" data-order="${s.orderId}">
              <span class="tm-n">${s.status === 'delivered' ? '✓' : esc(s.sequence ?? i + 1)}</span>
              <span class="tm-s">${esc(s.societe)}</span>
              <span class="tm-t">${s.status === 'delivered' ? `${hhmm(s.deliveredAt)}${s.minutesSincePrev != null ? `<small>+${duration(s.minutesSincePrev)}</small>` : ''}` : stopEta(d, s)}</span>
            </li>`).join('')}</ol>` : '<div class="tm-none">Aucun arrêt aujourd\'hui.</div>'}
          ${lost ? `<div class="tm-lost">${lost} adresse${lost > 1 ? 's' : ''} pas encore localisée${lost > 1 ? 's' : ''}.</div>` : ''}
        </section>`;
    });
    const loose = data.unassigned.length ? `<div class="tm-loose">${data.unassigned.length} commande${data.unassigned.length > 1 ? 's' : ''} prête${data.unassigned.length > 1 ? 's' : ''} sans chauffeur (points gris sur la carte).</div>` : '';
    box.innerHTML = (cards.join('') || '<div class="tm-none">Aucun chauffeur. Ajoutez-en un plus haut.</div>') + loose;
  }

  function status(text, bad) {
    const el = document.getElementById('tours-status');
    if (el) { el.textContent = text; el.classList.toggle('bad', !!bad); }
  }

  async function refresh() {
    if (loading) return;
    const view = document.getElementById('admin-view-logistics');
    if (!view || view.style.display === 'none' || !ensureMap()) return;
    loading = true;
    try {
      const res = await fetch('/api/admin/logistics/map', { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erreur ${res.status}`);
      const data = await res.json();
      last = data;
      draw(data); side(data);
      if (TRAFFIC.on) loadEtas();
      status(`Mis à jour à ${hhmmss(new Date())}${data.geocoding ? ' · localisation des adresses en cours…' : ''}`);
    } catch (err) {
      status(`Carte indisponible : ${err.message}`, true);
    } finally { loading = false; }
  }

  function start() {
    if (!document.getElementById('tours-map')) return;
    map && setTimeout(() => map.invalidateSize(), 0);
    loadTrafficStatus();
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  }

  document.addEventListener('click', (e) => {
    const head = e.target.closest('#tours-side [data-focus]');
    if (head) {
      const id = Number(head.dataset.focus);
      focus = focus === id ? null : id; firstFit = true;
      if (last) { draw(last); side(last); }
      return;
    }
    const li = e.target.closest('#tours-side li[data-order]');
    if (li) {
      const m = markers.get(Number(li.dataset.order));
      if (m) { map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 14), { duration: 0.6 }); m.openPopup(); }
      return;
    }
    if (e.target.closest('#tours-refit')) { firstFit = true; focus = null; if (last) { draw(last); side(last); } }
    const bm = e.target.closest('#tours-basemaps [data-basemap]');
    if (bm) { setBasemap(bm.dataset.basemap); return; }
    if (e.target.closest('#tours-refresh')) refresh();
    if (e.target.closest('#tours-traffic')) { const on = !TRAFFIC.on; remember.set(on); setTraffic(on); }
  });

  window.ToursMap = { show: start, refresh };
})();
