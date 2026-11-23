// Trafic en temps réel sur le lien du livreur (chargé après tournee.js, dont il réutilise token, esc, hhmm, formatDuration, portalUrl, share).
// Rien ici ne parle à TomTom : la page n'appelle que /api/driver-portal/<jeton>/traffic* ; la clé reste sur le serveur, qui calcule
// l'itinéraire depuis la base (jamais depuis des coordonnées envoyées par la page). Sans clé TomTom, le serveur répond « désactivé » et
// rien n'apparaît sur la page.
const TR = { data: null, error: '', at: 0, tried: 0, loading: false, again: false, off: false, open: false, traffic: true, map: null, group: null, tiles: null, fitted: false, nums: {}, tileOk: 0, tileKo: 0 };
const TR_EVERY_MS = 3 * 60 * 1000;
const TR_BASEMAP = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const trKm = (n) => String(n).replace('.', ',');

// ---------- données ----------
async function trRefresh(force) {
  if (TR.off || !token) return;
  if (TR.loading) { if (force) TR.again = true; return; }
  if (!force && Date.now() - TR.tried < TR_EVERY_MS) return;
  TR.loading = true; TR.tried = Date.now();
  trPaint();
  try {
    const res = await fetch(portalUrl('/traffic'), { cache: 'no-store' });
    const out = await res.json().catch(() => ({}));
    if (res.status === 404) TR.off = true;                                    // lien révoqué : la page principale l'affichera
    else if (res.status === 429) TR.error = out.error || 'Trop de demandes de trafic. Patientez une minute.';
    else if (!res.ok) TR.error = out.error || 'Trafic indisponible pour le moment.';
    else if (out.enabled === false) { TR.off = true; TR.data = null; }       // pas de clé TomTom sur le serveur : fonction absente
    else if (out.error) TR.error = out.error;                                 // panne ou plafond : on garde les dernières heures connues
    else { TR.data = out; TR.error = ''; TR.at = Date.now(); }
  } catch (e) { TR.error = 'Trafic indisponible pour le moment.'; }
  TR.loading = false;
  trPaint();
  if (TR.map && TR.traffic && TR.tiles && !TR.error) TR.tiles.redraw();
  if (TR.again) { TR.again = false; trRefresh(true); }
}

// ---------- niveau de circulation ----------
function trLevel(t) {
  const delay = t.delayMin, ratio = delay / Math.max(t.freeFlowMin, 1);
  if (delay <= 2 || ratio < 0.1) return { key: '', label: 'Circulation fluide' };
  if (delay < 10 && ratio < 0.25) return { key: 'mid', label: 'Circulation chargée' };
  return { key: 'bad', label: 'Circulation très chargée' };
}

function trStopLine(row) {
  if (!row.driveMin && !row.km) return '<b>Sur place</b>';
  const d = row.delayMin;
  return `<b>≈ ${esc(hhmm(row.etaAt))}</b><span>${esc(formatDuration(row.driveMin))} de route · ${esc(trKm(row.km))} km</span>${d >= 3 ? `<span class="tr-delay ${d >= 10 ? 'bad' : 'mid'}">+${esc(d)} min de trafic</span>` : ''}`;
}

// ---------- affichage ----------
function trPaint() {
  const card = document.getElementById('traffic-card');
  if (!card) return;
  const d = TR.data;
  const usable = !TR.off && ((d && d.stops && d.stops.length) || TR.error);
  document.querySelectorAll('.tr-eta').forEach(el => { el.hidden = true; el.innerHTML = ''; });
  if (!usable) { card.hidden = true; if (TR.open) trCloseMap(); return; }
  card.hidden = false;

  const parts = [];
  if (d && d.stops && d.stops.length) {
    const byOrder = {};
    d.stops.forEach(st => st.items.forEach(it => { byOrder[it.orderId] = st; }));
    document.querySelectorAll('.tr-eta').forEach(el => {
      const row = byOrder[el.dataset.order];
      if (row) { el.innerHTML = trStopLine(row); el.hidden = false; }
    });
    const t = d.totals, lvl = t ? trLevel(t) : null, last = d.stops[d.stops.length - 1];
    parts.push(`<div class="tr-head">${lvl ? `<span class="tr-pill ${lvl.key}">${esc(lvl.label)}</span>` : ''}<button type="button" class="tr-refresh" id="tr-refresh" aria-label="Actualiser le trafic"${TR.loading ? ' disabled' : ''}>${TR.loading ? '…' : '↻'}</button></div>`);
    parts.push('<dl class="tr-facts">'
      + `<div><dt>Dernier arrêt</dt><dd>≈ ${esc(hhmm(last.etaAt))}</dd></div>`
      + (d.backToDepot ? `<div><dt>Retour au dépôt</dt><dd>≈ ${esc(hhmm(d.backToDepot.etaAt))}</dd></div>` : '')
      + (t ? `<div><dt>Conduite</dt><dd>${esc(formatDuration(t.driveMin))}<small>${t.delayMin >= 3 ? `+${esc(t.delayMin)} min de trafic` : 'comme d\'habitude'}</small></dd></div>` : '')
      + '</dl>');
    const notes = [];
    notes.push(`Heures estimées avec le trafic du moment, en comptant ${esc(d.dwellMin)} min sur place à chaque arrêt. Calcul de ${esc(hhmm(d.generatedAt))}.`);
    if (d.source === 'delivery' && !share.on) notes.push('Départ calculé depuis votre dernière livraison : partagez votre position pour des heures plus justes.');
    else if (d.source === 'depot' && !share.on) notes.push('Départ calculé depuis le dépôt : partagez votre position pour des heures plus justes.');
    if (d.missingAddresses) notes.push(`${esc(d.missingAddresses)} arrêt${d.missingAddresses > 1 ? 's' : ''} sans position sur la carte : heure non calculée.`);
    if (d.trimmed) notes.push('Seuls les premiers arrêts sont calculés.');
    parts.push(`<p class="tr-note">${notes.join(' ')}</p>`);
  }
  if (TR.error) parts.push(`<p class="tr-err" role="status">${esc(TR.error)}${d ? ` Les heures affichées datent de ${esc(hhmm(d.generatedAt))}.` : ''}</p>`);
  if (d && d.stops && d.stops.length) parts.push(`<button type="button" class="tr-map-btn" id="tr-map-toggle" aria-expanded="${TR.open}">${TR.open ? 'Masquer la carte' : '🗺️ Voir la carte du trafic'}</button>`);
  document.getElementById('tr-summary').innerHTML = parts.join('');
  if (TR.map) trDraw();
}

// ---------- carte ----------
let trLeaflet = null;
function trLoadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (trLeaflet) return trLeaflet;
  trLeaflet = new Promise((resolve, reject) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = '/vendor/leaflet/leaflet.js';
    js.onload = () => (window.L ? resolve(window.L) : reject(new Error('leaflet')));
    js.onerror = () => { trLeaflet = null; reject(new Error('leaflet')); };
    document.head.appendChild(js);
  });
  return trLeaflet;
}

function trPopup(lines) {                                  // contenu construit en texte brut : aucune donnée n'est interprétée comme du HTML
  const box = document.createElement('div'); box.className = 'tr-pop';
  lines.forEach(([txt, cls]) => { const p = document.createElement('div'); if (cls) p.className = cls; p.textContent = txt; box.appendChild(p); });
  return box;
}

async function trOpenMap() {
  const box = document.getElementById('tr-mapbox');
  if (!box) return;
  TR.open = true; TR.fitted = false; TR.tileOk = 0; TR.tileKo = 0;
  box.hidden = false;
  box.innerHTML = '<div class="tr-mapbar"><label class="tr-chk"><input type="checkbox" id="tr-layer"' + (TR.traffic ? ' checked' : '') + '> Afficher le trafic</label><span class="tr-legend" aria-hidden="true"><i></i>fluide → bouché</span></div>'
    + '<div id="tr-map" role="application" aria-label="Carte de la tournée avec le trafic"></div>'
    + '<p class="tr-note" id="tr-mapnote">Touchez la carte pour voir la vitesse à cet endroit. Pointillés : ordre de passage.</p>';
  trPaintButton();
  let L;
  try { L = await trLoadLeaflet(); } catch (e) { box.innerHTML = '<p class="tr-err">La carte n\'a pas pu se charger. Vérifiez la connexion et réessayez.</p>'; TR.open = false; trPaintButton(); return; }
  const el = document.getElementById('tr-map');
  if (!el || !TR.open) return;                             // la page a été redessinée ou la carte refermée pendant le chargement
  if (TR.map) { TR.map.remove(); TR.map = null; }
  TR.map = L.map(el, { zoomControl: true, maxZoom: 18 }).setView([44.055, 5.049], 11);
  L.tileLayer(TR_BASEMAP, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(TR.map);
  TR.tiles = L.tileLayer(portalUrl('/traffic/tiles/relative0/{z}/{x}/{y}.png'), { minZoom: 6, maxZoom: 18, opacity: 0.85, attribution: '© <a href="https://www.tomtom.com/" target="_blank" rel="noopener">TomTom</a>' });
  TR.tiles.on('tileload', () => { TR.tileOk++; });
  TR.tiles.on('tileerror', () => {
    TR.tileKo++;
    const note = document.getElementById('tr-mapnote');
    if (note && TR.tileKo >= 3 && !TR.tileOk) note.textContent = 'La couche trafic n\'est pas disponible pour le moment (limite du jour atteinte ou service interrompu). Les heures de passage restent valables.';
  });
  if (TR.traffic) TR.tiles.addTo(TR.map);
  TR.group = L.layerGroup().addTo(TR.map);
  TR.map.on('click', trSpeedAt);
  trDraw();
}

function trCloseMap() {
  TR.open = false;
  if (TR.map) { TR.map.remove(); TR.map = null; }
  TR.group = null; TR.tiles = null;
  const box = document.getElementById('tr-mapbox');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  trPaintButton();
}

function trPaintButton() {
  const b = document.getElementById('tr-map-toggle');
  if (b) { b.textContent = TR.open ? 'Masquer la carte' : '🗺️ Voir la carte du trafic'; b.setAttribute('aria-expanded', String(TR.open)); }
}

function trSetLayer(on) {
  TR.traffic = on;
  if (!TR.map || !TR.tiles) return;
  if (on) TR.tiles.addTo(TR.map); else TR.map.removeLayer(TR.tiles);
}

function trDraw() {
  if (!TR.map || !TR.group || !window.L) return;
  const L = window.L, d = TR.data;
  TR.group.clearLayers();
  if (!d || !d.stops) return;
  const pts = [];
  const pin = (lat, lng, cls, label, lines, z = 0) => {
    const m = L.marker([lat, lng], { icon: L.divIcon({ className: cls, html: `<span>${esc(label)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }), keyboard: false, zIndexOffset: z });
    if (lines) m.bindPopup(trPopup(lines));
    m.addTo(TR.group); pts.push([lat, lng]);
    return m;
  };
  const path = [];
  if (d.start) {
    path.push([d.start.lat, d.start.lng]);
    if (d.source === 'gps') pin(d.start.lat, d.start.lng, 'tr-pin tr-me', '', [['Vous êtes ici']], 400);
    else if (d.source === 'delivery') pin(d.start.lat, d.start.lng, 'tr-pin tr-from', '•', [['Dernière livraison validée']]);
  }
  d.stops.forEach((st) => {
    const first = st.items[0] || {};
    const num = TR.nums[first.orderId] || '';
    path.push([st.lat, st.lng]);
    pin(st.lat, st.lng, 'tr-pin', String(num), [
      ...st.items.map(it => [it.societe || '', 'tr-pop-name']),
      [`Arrivée ≈ ${hhmm(st.etaAt)}`],
      [st.driveMin ? `${formatDuration(st.driveMin)} de route · ${trKm(st.km)} km${st.delayMin >= 3 ? ` · +${st.delayMin} min de trafic` : ''}` : 'Sur place', 'tr-mute'],
    ]);
  });
  if (d.depot) {
    pin(d.depot.lat, d.depot.lng, 'tr-pin tr-depot', 'D', [['Dépôt', 'tr-pop-name'], ...(d.backToDepot ? [[`Retour ≈ ${hhmm(d.backToDepot.etaAt)}`]] : [])], -500);   // sous les arrêts numérotés quand ils se superposent
    if (d.backToDepot) path.push([d.depot.lat, d.depot.lng]);
  }
  if (path.length > 1) L.polyline(path, { color: '#16324F', weight: 3, opacity: 0.55, dashArray: '2 8', lineCap: 'round' }).addTo(TR.group);
  if (!TR.fitted && pts.length) { TR.fitted = true; TR.map.fitBounds(pts, { padding: [28, 28], maxZoom: 15 }); }
}

async function trSpeedAt(ev) {
  if (!TR.traffic || TR.map.getZoom() < 10 || TR.off) return;
  const L = window.L, at = ev.latlng;
  const pop = L.popup({ maxWidth: 220 }).setLatLng(at).setContent(trPopup([['Mesure de la vitesse…', 'tr-mute']])).openOn(TR.map);
  try {
    const res = await fetch(portalUrl(`/traffic/speed?lat=${at.lat.toFixed(5)}&lng=${at.lng.toFixed(5)}`), { cache: 'no-store' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Vitesse indisponible ici.');
    if (out.closed) { pop.setContent(trPopup([['Route fermée', 'tr-pop-name']])); return; }
    const pct = out.ratio != null ? Math.round(out.ratio * 100) : null;
    pop.setContent(trPopup([[`${out.currentKmh} km/h en ce moment`, 'tr-pop-name'], [`Habituellement ${out.freeFlowKmh} km/h${pct != null ? ` · ${pct} % de la normale` : ''}`, 'tr-mute']]));
  } catch (err) { pop.setContent(trPopup([[err.message, 'tr-mute']])); }
}

// ---------- liaison avec tournee.js ----------
function trBeforeRender() {                                // la page est redessinée entière : la carte est détruite avant, refaite après
  if (TR.map) { TR.map.remove(); TR.map = null; }
  TR.group = null; TR.tiles = null;
}

function trAfterRender(data) {
  TR.nums = {};
  data.stops.forEach((s, i) => { TR.nums[s.orderId] = s.sequence || i + 1; });
  const card = document.getElementById('traffic-card');
  if (card && !card.dataset.bound) {
    card.dataset.bound = '1';
    card.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'tr-refresh') trRefresh(true);
      else if (b.id === 'tr-map-toggle') (TR.open ? trCloseMap() : trOpenMap());
    });
    card.addEventListener('change', (e) => { if (e.target.id === 'tr-layer') trSetLayer(e.target.checked); });
  }
  trPaint();
  if (TR.open && !TR.off) trOpenMap();
  trRefresh(true);                                         // un arrêt vient d'être livré (ou la page vient de s'ouvrir) : on recalcule
}

setInterval(() => { if (document.visibilityState === 'visible') trRefresh(false); }, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') trRefresh(false); });
