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

  if (totalStops === 0) {
    app.innerHTML = `
      <header><div class="wrap">
        <div class="eyebrow">Blanchisserie Cézanne</div>
        <h1>${esc(data.driverName)}</h1>
        <div class="date">${dateLabel}</div>
      </div></header>
      <div class="wrap">${weatherHtml}${safetyHtml}
        <div class="empty">Aucun arrêt pour le moment.<br>Revenez un peu plus tard.</div>
      </div>
      <footer>Blanchisserie Cézanne</footer>
    `;
    return;
  }

  const stopsHtml = data.stops.map((s, i) => `
    <div class="stop">
      <div class="stop-num">${s.sequence || i + 1}</div>
      ${i > 0 ? '' : ''}
      <div class="stop-card">
        <div class="stop-societe">${esc(s.societe)}</div>
        <div class="stop-ticket">${esc(s.ticket)}</div>
        <div class="stop-addr">${esc(s.adresse)}</div>
        <div class="stop-actions">
          <a class="maps" href="${esc(safeUrl(s.mapsUrl))}" target="_blank" rel="noopener">🧭 Itinéraire</a>
          ${s.tel ? `<a class="call" href="tel:${esc(String(s.tel).replace(/[^\d+]/g, ''))}">📞 Appeler</a>` : ''}
        </div>
        <div class="stop-actions">
          <a class="bl" href="${esc(safeUrl(s.deliveryNoteUrl))}" target="_blank" rel="noopener">📄 Bon de livraison</a>
        </div>
        <div class="stop-items">${s.items.map(it => `<span>${esc(it.name)} ×${it.qty}</span>`).join('')}</div>
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
      ${safetyHtml}
      <div class="route-summary">
        <div class="stat"><b>${totalStops}</b><span>Arrêt${totalStops > 1 ? 's' : ''}</span></div>
        ${data.routeSummary ? `
          <div class="stat"><b>${data.routeSummary.totalDistanceKm} km</b><span>Distance</span></div>
          <div class="stat"><b>${formatDuration(data.routeSummary.estimatedMinutes)}</b><span>Durée estimée</span></div>
        ` : ''}
      </div>
      ${!data.routeSummary ? '<p style="font-size:11.5px;color:var(--steel-light);margin:-12px 0 16px;">Distance et durée non disponibles — la tournée n\'a pas encore été optimisée côté admin.</p>' : ''}
      <div class="route">${stopsHtml}</div>
    </div>
    <footer>Blanchisserie Cézanne — bonne route</footer>
  `;

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

load();
