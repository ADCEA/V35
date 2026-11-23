const token = new URLSearchParams(window.location.search).get('token');
const app = document.getElementById('app');

const WEATHER_ICONS = {
  clear: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="5" fill="#F5A623"/><g stroke="#F5A623" stroke-width="1.8" stroke-linecap="round"><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></g></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 18a4.5 4.5 0 010-9 5.5 5.5 0 0110.6 1.8A3.5 3.5 0 0117 18H7z" fill="#AFC0CF"/></svg>',
  rain: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 14a4.5 4.5 0 010-9 5.5 5.5 0 0110.6 1.8A3.5 3.5 0 0117 14H7z" fill="#8FB4D9"/><g stroke="#1D91FF" stroke-width="1.8" stroke-linecap="round"><path d="M8 17l-1.5 3M13 17l-1.5 3M18 17l-1.5 3"/></g></svg>',
  snow: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 13a4.5 4.5 0 010-9 5.5 5.5 0 0110.6 1.8A3.5 3.5 0 0117 13H7z" fill="#C8D9E8"/><g stroke="#1D91FF" stroke-width="1.6" stroke-linecap="round"><path d="M9 18v4M9 19l-1.5 1M9 19l1.5 1M15 18v4M15 19l-1.5 1M15 19l1.5 1"/></g></svg>',
  storm: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 13a4.5 4.5 0 010-9 5.5 5.5 0 0110.6 1.8A3.5 3.5 0 0117 13H7z" fill="#64798D"/><path d="M13 14l-3 5h2.5l-1.5 4 4.5-6h-2.5l1.5-3h-1.5z" fill="#E0574B"/></svg>',
  fog: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="#AFC0CF" stroke-width="2" stroke-linecap="round"><path d="M4 9h16M3 13h18M5 17h14"/></g></svg>',
};
function iconFor(label){
  const l = label.toLowerCase();
  if (l.includes('orage')) return WEATHER_ICONS.storm;
  if (l.includes('neige') || l.includes('verglaçante')) return WEATHER_ICONS.snow;
  if (l.includes('brouillard')) return WEATHER_ICONS.fog;
  if (l.includes('pluie') || l.includes('bruine') || l.includes('averse')) return WEATHER_ICONS.rain;
  if (l.includes('dégagé')) return WEATHER_ICONS.clear;
  return WEATHER_ICONS.cloud;
}

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// Adresse de lien acceptée : web ou chemin du site (jamais javascript: ni data:).
function safeUrl(u){ const v = String(u ?? ''); return /^(https?:\/\/|\/(?!\/))/i.test(v) ? v : '#'; }
function formatDuration(totalMinutes){
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return h > 0 ? `${h}h${String(m).padStart(2,'0')}` : `${m} min`;
}

function hhmm(iso){ return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }); }
function parisToday(){ return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); }

// ---------- partage de position (choisi par le livreur, jamais automatique) ----------
// Tant que la page est ouverte et le partage actif, la position du téléphone est envoyée à l'atelier toutes les 20 secondes.
// Une seule position est conservée côté serveur ; elle est effacée à l'arrêt et à la dernière livraison.
const SHARE_KEY = 'cezanne-partage-position';
const share = { on: false, watchId: null, last: null, lastSentAt: 0, wake: null, error: '' };
const portalUrl = (path) => `/api/driver-portal/${encodeURIComponent(token)}${path}`;
const postJson = (path, body) => fetch(portalUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

function remember(on){ try { if (on) localStorage.setItem(SHARE_KEY, parisToday()); else localStorage.removeItem(SHARE_KEY); } catch (e) { /* stockage indisponible : pas de reprise automatique */ } }
function wasSharingToday(){ try { return localStorage.getItem(SHARE_KEY) === parisToday(); } catch (e) { return false; } }

async function holdScreen(){
  try { if ('wakeLock' in navigator && !share.wake) { share.wake = await navigator.wakeLock.request('screen'); share.wake.addEventListener('release', () => { share.wake = null; }); } } catch (e) { /* facultatif */ }
}
document.addEventListener('visibilitychange', () => { if (share.on && document.visibilityState === 'visible') holdScreen(); });

function startSharing(){
  if (!('geolocation' in navigator)) { share.error = 'Ce téléphone ne permet pas de partager la position depuis cette page.'; paintShare(); return; }
  if (share.watchId != null) return;
  share.on = true; share.error = '';
  share.watchId = navigator.geolocation.watchPosition((pos) => {
    share.last = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: Date.now() };
    share.error = '';
    if (Date.now() - share.lastSentAt >= 20000) {
      share.lastSentAt = Date.now();
      postJson('/position', { lat: share.last.lat, lng: share.last.lng, accuracy: share.last.accuracy }).catch(() => {});
    }
    paintShare();
  }, (err) => {
    if (err.code === 1) { share.error = 'Position refusée. Autorisez la localisation pour ce site dans les réglages du téléphone, puis relancez le partage.'; stopSharing(); }
    else { share.error = 'Position indisponible pour le moment (pas de signal GPS ?). Le partage reprend dès qu\'il revient.'; paintShare(); }
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  remember(true);
  holdScreen();
  paintShare();
}

function stopSharing(){
  if (share.watchId != null) navigator.geolocation.clearWatch(share.watchId);
  const wasOn = share.on;
  share.watchId = null; share.on = false; share.last = null; share.lastSentAt = 0;
  if (share.wake) { share.wake.release().catch(() => {}); share.wake = null; }
  remember(false);
  if (wasOn) postJson('/position/stop').catch(() => {});
  paintShare();
}

function paintShare(){
  const box = document.getElementById('share-card');
  if (!box) return;
  const fix = share.last ? `Dernière position envoyée il y a ${Math.max(0, Math.round((Date.now() - share.lastSentAt) / 1000))} s${share.last.accuracy ? ` · précision ≈ ${Math.round(share.last.accuracy)} m` : ''}.` : 'En attente du signal GPS…';
  box.className = 'share-card' + (share.on ? ' on' : '');
  box.innerHTML = share.on ? `
    <div class="share-head"><span class="share-dot" aria-hidden="true"></span><b>Position partagée avec l'atelier</b></div>
    <p>${esc(fix)} Gardez cette page ouverte et l'écran allumé.</p>
    ${share.error ? `<p class="share-error">${esc(share.error)}</p>` : ''}
    <button type="button" class="share-btn stop" id="share-toggle">Arrêter le partage</button>`
  : `
    <div class="share-head"><b>📍 Partager ma position</b></div>
    <p>L'atelier voit où vous en êtes sur la carte. Rien n'est envoyé tant que vous n'appuyez pas ; le partage s'arrête quand vous cliquez sur « Arrêter » ou après votre dernière livraison. Seule votre dernière position est conservée.</p>
    ${share.error ? `<p class="share-error">${esc(share.error)}</p>` : ''}
    <button type="button" class="share-btn" id="share-toggle">Partager ma position</button>`;
  document.getElementById('share-toggle').addEventListener('click', () => (share.on ? stopSharing() : startSharing()));
}

async function resumeSharing(){
  if (share.on || !wasSharingToday() || !navigator.permissions?.query) return;
  try { const st = await navigator.permissions.query({ name: 'geolocation' }); if (st.state === 'granted') startSharing(); } catch (e) { /* pas de reprise */ }
}

// ---------- validation d'une livraison ----------
async function deliver(orderId, btn){
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Validation…';
  const fresh = share.on && share.last && Date.now() - share.last.at < 2 * 60 * 1000;
  try {
    const res = await postJson(`/orders/${encodeURIComponent(orderId)}/deliver`, fresh ? { lat: share.last.lat, lng: share.last.lng, accuracy: share.last.accuracy } : {});
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'La validation a échoué.');
    if (out.remaining === 0 && share.on) stopSharing();
    await load();
  } catch (err) {
    alert(err.message);
    btn.disabled = false; btn.textContent = label;
  }
}

async function load(){
  if (!token) {
    app.innerHTML = '<div class="error">Lien invalide — il manque le jeton d\'accès dans l\'adresse.</div>';
    return;
  }
  let data;
  try {
    const res = await fetch(`/api/driver-portal/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error((await res.json()).error || 'Erreur de chargement.');
    data = await res.json();
  } catch (err) {
    app.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    return;
  }
  render(data);
}

function render(data){
  if (typeof trBeforeRender === 'function') trBeforeRender();   // trafic (tournee-trafic.js) : la carte est détruite avant que la page soit redessinée
  const dateLabel = new Date(data.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  const w = data.weather;
  const weatherHtml = w ? `
    <div class="weather-card">
      <div class="weather-main">
        <div class="weather-icon">${iconFor(w.conditionLabel)}</div>
        <div class="weather-info">
          <div class="weather-cond">${esc(w.conditionLabel)}</div>
          <div class="weather-range">${w.tempMin}° – ${w.tempMax}°C</div>
          <div class="weather-detail">Pluie : ${w.precipitationMm} mm · Vent max : ${w.windMaxKmh} km/h</div>
        </div>
      </div>
      ${w.dangers.length > 0 ? `
        <div class="weather-danger">
          <div class="dtitle">⚠ Vigilance conduite</div>
          ${w.dangers.map(d => `<div>${esc(d)}</div>`).join('')}
        </div>
      ` : '<div class="weather-ok">✓ Rien à signaler côté météo aujourd\'hui.</div>'}
    </div>
  ` : '';

  const safetyHtml = `
    <div class="safety-strip">
      <h3>Rappels avant de démarrer</h3>
      <ul>${data.safetyTips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>
  `;

  const totalStops = data.stops.length;

  const doneList = data.deliveredToday || [];
  const doneHtml = doneList.length ? `
    <section class="done-box" aria-label="Arrêts validés aujourd'hui">
      <h3>Fait aujourd'hui · ${doneList.length}</h3>
      <ul>${doneList.map(d => `
        <li>
          <span class="done-check" aria-hidden="true">✓</span>
          <span class="done-name">${esc(d.societe)}<small>${d.collectOnly ? '🧺 collecte · ' : ''}${esc(d.ticket)}</small></span>
          <span class="done-time">${hhmm(d.deliveredAt)}${d.minutesSincePrev != null ? `<small>+${formatDuration(d.minutesSincePrev)}</small>` : ''}</span>
        </li>`).join('')}
      </ul>
    </section>` : '';

  if (totalStops === 0) {
    app.innerHTML = `
      <header><div class="wrap">
        <div class="eyebrow">Blanchisserie Cézanne</div>
        <h1>${esc(data.driverName)}</h1>
        <div class="date">${dateLabel}</div>
      </div></header>
      <div class="wrap">${weatherHtml}${safetyHtml}
        ${doneList.length ? '<div class="finished">Tournée terminée. Merci !</div>' : '<div class="empty">Aucun arrêt pour le moment.<br>Revenez un peu plus tard.</div>'}
        ${doneHtml}
      </div>
      <footer>Blanchisserie Cézanne</footer>
    `;
    if (share.on) stopSharing();
    return;
  }

  const stopsHtml = data.stops.map((s, i) => `
    <div class="stop">
      <div class="stop-num">${s.sequence || i + 1}</div>
      ${i > 0 ? '' : ''}
      <div class="stop-card">
        <div class="stop-societe">${esc(s.societe)}</div>
        <div class="stop-ticket">${esc(s.ticket)}</div>
        ${s.collectOnly ? `<div class="stop-collect">🧺 Collecte du linge sale — rien à livrer</div>${s.notes ? `<div class="stop-note">${esc(s.notes)}</div>` : ''}` : ''}
        <div class="stop-addr">${esc(s.adresse)}</div>
        <div class="tr-eta" data-order="${esc(s.orderId)}" hidden></div>
        <div class="stop-actions">
          <a class="maps" href="${esc(safeUrl(s.mapsUrl))}" target="_blank" rel="noopener">🧭 Itinéraire</a>
          ${s.tel ? `<a class="call" href="tel:${esc(String(s.tel).replace(/[^\d+]/g, ''))}">📞 Appeler</a>` : ''}
        </div>
        ${s.collectOnly ? '' : `<div class="stop-actions">
          <a class="bl" href="${esc(safeUrl(s.deliveryNoteUrl))}" target="_blank" rel="noopener">📄 Bon de livraison</a>
        </div>
        <div class="stop-items">${s.items.map(it => `<span>${esc(it.name)} ×${it.qty}</span>`).join('')}</div>`}
        <div class="deliver-zone" id="deliver-zone-${s.orderId}">
          <button type="button" class="deliver-btn" data-deliver-ask="${s.orderId}">${s.collectOnly ? '✓ Collecte effectuée' : '✓ Livraison effectuée'}</button>
          <div class="deliver-confirm" hidden>
            <p>${s.collectOnly ? 'Confirmer la collecte' : 'Confirmer la livraison'} chez <b>${esc(s.societe)}</b> ?</p>
            <div class="deliver-row">
              <button type="button" class="deliver-yes" data-deliver-yes="${s.orderId}">${s.collectOnly ? 'Oui, c\'est collecté' : 'Oui, c\'est livré'}</button>
              <button type="button" class="deliver-no" data-deliver-no="${s.orderId}">Annuler</button>
            </div>
          </div>
        </div>
        <button type="button" class="comment-toggle" data-comment-toggle="${s.orderId}">💬 Laisser un commentaire</button>
        <div class="comment-box" id="comment-box-${s.orderId}">
          <textarea id="comment-text-${s.orderId}" placeholder="Ex. Client absent, linge laissé à la réception. Ou : demande plus de serviettes la prochaine fois."></textarea>
          <button type="button" data-comment-send="${s.orderId}">Envoyer à l'équipe</button>
          <div class="comment-sent" id="comment-sent-${s.orderId}">✓ Message envoyé.</div>
        </div>
      </div>
    </div>
  `).join('');

  app.innerHTML = `
    <header><div class="wrap">
      <div class="eyebrow">Blanchisserie Cézanne</div>
      <h1>${esc(data.driverName)}</h1>
      <div class="date">${dateLabel}${data.vehicle ? ' · ' + esc(data.vehicle) : ''}</div>
    </div></header>
    <div class="wrap">
      ${weatherHtml}
      <div id="share-card" class="share-card"></div>
      ${safetyHtml}
      <div class="route-summary">
        <div class="stat"><b>${totalStops}</b><span>Arrêt${totalStops > 1 ? 's' : ''}</span></div>
        ${data.routeSummary ? `
          <div class="stat"><b>${data.routeSummary.totalDistanceKm} km</b><span>Distance</span></div>
          <div class="stat"><b>${formatDuration(data.routeSummary.estimatedMinutes)}</b><span>Durée estimée</span></div>
        ` : ''}
      </div>
      ${!data.routeSummary ? '<p style="font-size:11.5px;color:var(--steel-light);margin:-12px 0 16px;">Distance et durée non disponibles — la tournée n\'a pas encore été optimisée côté admin.</p>' : ''}
      <div id="traffic-card" class="tr-card" hidden><div id="tr-summary"></div><div id="tr-mapbox" hidden></div></div>
      <div class="route">${stopsHtml}</div>
      ${doneHtml}
    </div>
    <footer>Blanchisserie Cézanne — bonne route</footer>
  `;

  paintShare();
  if (typeof trAfterRender === 'function') trAfterRender(data);
  document.querySelectorAll('[data-deliver-ask]').forEach(btn => {
    btn.addEventListener('click', () => {
      const zone = document.getElementById(`deliver-zone-${btn.dataset.deliverAsk}`);
      btn.hidden = true; zone.querySelector('.deliver-confirm').hidden = false;
    });
  });
  document.querySelectorAll('[data-deliver-no]').forEach(btn => {
    btn.addEventListener('click', () => {
      const zone = document.getElementById(`deliver-zone-${btn.dataset.deliverNo}`);
      zone.querySelector('.deliver-confirm').hidden = true; zone.querySelector('.deliver-btn').hidden = false;
    });
  });
  document.querySelectorAll('[data-deliver-yes]').forEach(btn => {
    btn.addEventListener('click', () => deliver(btn.dataset.deliverYes, btn));
  });
  document.querySelectorAll('[data-comment-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(`comment-box-${btn.dataset.commentToggle}`).classList.toggle('open');
    });
  });
  document.querySelectorAll('[data-comment-send]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const orderId = btn.dataset.commentSend;
      const textarea = document.getElementById(`comment-text-${orderId}`);
      const text = textarea.value.trim();
      if (!text) return;
      btn.disabled = true;
      btn.textContent = 'Envoi…';
      try {
        const res = await fetch(`/api/driver-portal/${encodeURIComponent(token)}/orders/${encodeURIComponent(orderId)}/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Échec de l\'envoi.');
        textarea.value = '';
        const sentNote = document.getElementById(`comment-sent-${orderId}`);
        sentNote.classList.add('show');
        setTimeout(() => sentNote.classList.remove('show'), 3000);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Envoyer à l'équipe";
      }
    });
  });
}

load().then(resumeSharing);
