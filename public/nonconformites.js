// Administration → Non-conformités : les signalements des hôtels sur leurs livraisons. L'équipe lit, change l'état et écrit une
// réponse que l'hôtel voit dans son espace client. Le nombre de signalements à traiter s'affiche sur l'onglet.
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATES = [['ouverte', 'Reçu'], ['en_cours', 'En cours de traitement'], ['resolue', 'Traité']];
  let filter = 'open';

  const getJson = async (url, init) => {
    const res = await fetch(url, { credentials: 'same-origin', ...init });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  };
  const when = (iso) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

  function badge(open) {
    const b = document.getElementById('nav-nonconf');
    if (!b) return;
    b.textContent = open > 0 ? `Non-conformités (${open})` : 'Non-conformités';
    b.classList.toggle('has-alert', open > 0);
  }

  function cardHtml(n) {
    return `
      <article class="ncadm-card ${n.status}" data-nc="${n.id}">
        <header>
          <div>
            <strong>${esc(n.client.societe)}</strong>
            <span class="ncadm-meta">Livraison ${esc(n.ticket || '')} · ${esc(when(n.createdAt))}${n.client.tel ? ` · ${esc(n.client.tel)}` : ''}</span>
          </div>
          <span class="ncadm-kind">${esc(n.kindLabel)}</span>
        </header>
        ${n.lines.length ? `<p class="ncadm-lines">${n.lines.map(l => `${esc(l.name)} <b>×${l.qty}</b>`).join(' · ')}</p>` : ''}
        ${n.comment ? `<p class="ncadm-comment">« ${esc(n.comment)} »</p>` : ''}
        <div class="ncadm-form">
          <div class="field"><label for="ncs-${n.id}">État</label>
            <select id="ncs-${n.id}" data-nc-status>${STATES.map(([k, l]) => `<option value="${k}" ${k === n.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field ncadm-note"><label for="ncn-${n.id}">Réponse à l'hôtel (visible dans son espace client)</label>
            <textarea id="ncn-${n.id}" rows="2" maxlength="1000" data-nc-note placeholder="Ex. Les 2 draps vous sont livrés demain.">${esc(n.teamNote)}</textarea></div>
          <button type="button" class="btn-secondary" data-nc-save="${n.id}" style="width:auto;">Enregistrer</button>
          <span class="ncadm-saved" role="status"></span>
        </div>
      </article>`;
  }

  async function render() {
    const root = document.getElementById('nonconf-root');
    if (!root) return;
    const data = await getJson(`/api/admin/non-conformities?status=${filter === 'open' ? 'open' : 'all'}`);
    badge(data.open);
    const chips = [['open', `À traiter · ${data.open}`], ['all', 'Tous']].map(([k, l]) => `<button type="button" class="ncadm-chip" data-nc-filter="${k}" aria-pressed="${k === filter}">${l}</button>`).join('');
    root.innerHTML = `
      <div class="ncadm-bar" role="group" aria-label="Filtrer les signalements">${chips}</div>
      ${data.nonConformities.length ? data.nonConformities.map(cardHtml).join('') : `<p class="empty-note">${filter === 'open' ? 'Aucun signalement à traiter.' : 'Aucun signalement pour le moment.'}</p>`}`;
  }

  window.renderNonConfView = () => render().catch(err => {
    const root = document.getElementById('nonconf-root');
    if (root) root.innerHTML = `<p style="color:var(--rust);font-size:12.5px;">${esc(err.message)}</p>`;
  });

  document.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-nc-filter]');
    if (f) { filter = f.dataset.ncFilter; window.renderNonConfView(); return; }
    const save = e.target.closest('[data-nc-save]');
    if (!save) return;
    const card = save.closest('[data-nc]'); const note = card.querySelector('.ncadm-saved');
    save.disabled = true; note.textContent = '';
    try {
      await getJson(`/api/admin/non-conformities/${save.dataset.ncSave}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: card.querySelector('[data-nc-status]').value, teamNote: card.querySelector('[data-nc-note]').value }),
      });
      note.textContent = 'Enregistré ✓';
      const open = await getJson('/api/admin/non-conformities?status=open'); badge(open.open);
    } catch (err) { note.textContent = err.message; note.classList.add('bad'); }
    finally { save.disabled = false; }
  });

  // Le nombre à traiter reste visible sur l'onglet, vue ouverte ou non (relevé toutes les 60 s tant que l'administration est affichée).
  async function poll() {
    const dash = document.getElementById('admin-dashboard');
    if (!dash || dash.style.display === 'none' || document.hidden) return;
    try { badge((await getJson('/api/admin/non-conformities?status=open')).open); } catch (_) { /* onglet inchangé */ }
  }
  setInterval(poll, 60000);
  window.addEventListener('load', () => setTimeout(poll, 2500));
})();
