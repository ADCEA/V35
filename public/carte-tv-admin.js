// Logistique › Carte des tournées › « Écran TV » : aperçu plein écran et lien en lecture seule pour la TV du local.
// Le lien (jeton dans la partie « # » de l'adresse) n'est montré qu'à sa création : le serveur n'en garde que l'empreinte.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (m < 2) return 'à l\'instant';
    if (m < 60) return `il y a ${m} min`;
    const h = Math.floor(m / 60);
    return h < 24 ? `il y a ${h} h` : `il y a ${Math.floor(h / 24)} j`;
  };

  let info = null;       // { active, createdAt, lastSeenAt }
  let fresh = null;      // adresse complète, juste après la création seulement
  let busy = false; let error = '';

  function render() {
    const box = $('tv-admin');
    if (!box) return;
    let state;
    if (!info) state = '<p class="tv-a-note">Chargement…</p>';
    else if (!info.active) state = '<p class="tv-a-note">Aucun lien pour la TV. Créez-le, puis ouvrez-le une fois sur l\'écran : il s\'en souvient.</p>';
    else state = `<p class="tv-a-note">Lien actif depuis le ${esc(when(info.createdAt))}. ${info.lastSeenAt ? `La TV l'a utilisé ${esc(ago(info.lastSeenAt))}.` : 'La TV ne l\'a pas encore utilisé.'}</p>`;
    const link = fresh ? `
      <div class="tv-a-link">
        <label for="tv-a-url">Lien à ouvrir sur la TV (affiché une seule fois)</label>
        <div class="tv-a-row"><input id="tv-a-url" type="text" readonly value="${esc(fresh)}"><button type="button" class="btn-secondary" data-tv="copy">Copier</button><a class="btn-secondary" href="${esc(fresh)}" target="_blank" rel="noopener">Ouvrir ici</a></div>
        <p class="tv-a-note">Gardez ce lien pour vous : il montre les tournées en direct (noms des hôtels, sans adresses) à qui l'ouvre.</p>
      </div>` : '';
    box.innerHTML = `
      <div class="tv-a-row">
        <a class="btn-secondary" href="/carte-tv" target="_blank" rel="noopener">Aperçu plein écran</a>
        <button type="button" class="btn-secondary" data-tv="create" ${busy ? 'disabled' : ''}>${info && info.active ? 'Nouveau lien' : 'Créer le lien de la TV'}</button>
        ${info && info.active ? `<button type="button" class="btn-secondary" data-tv="off" ${busy ? 'disabled' : ''}>Désactiver</button>` : ''}
      </div>
      ${state}${link}${error ? `<p class="tv-a-note bad" role="alert">${esc(error)}</p>` : ''}`;
  }

  async function load() {
    try { info = await api('GET', '/api/admin/logistics/tv'); error = ''; } catch (e) { error = e.message; }
    render();
  }

  async function run(fn) {
    if (busy) return;
    busy = true; error = ''; render();
    try { await fn(); } catch (e) { error = e.message; }
    busy = false; render();
  }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('#tv-open')) {
      const box = $('tv-admin'); const btn = $('tv-open');
      box.hidden = !box.hidden; btn.setAttribute('aria-expanded', String(!box.hidden));
      if (!box.hidden) { fresh = null; render(); load(); }
      return;
    }
    const b = e.target.closest('#tv-admin [data-tv]');
    if (!b) return;
    const act = b.dataset.tv;
    if (act === 'create') {
      if (info && info.active && !confirm('Créer un nouveau lien ? Celui de la TV cessera de fonctionner : il faudra ouvrir le nouveau sur l\'écran.')) return;
      run(async () => {
        const r = await api('POST', '/api/admin/logistics/tv', {});
        info = { active: r.active, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt };
        fresh = `${location.origin}/carte-tv#${r.token}`;
      });
    } else if (act === 'off') {
      if (!confirm('Désactiver le lien de la TV ? L\'écran n\'affichera plus rien jusqu\'à la création d\'un nouveau lien.')) return;
      run(async () => { info = await api('DELETE', '/api/admin/logistics/tv'); fresh = null; });
    } else if (act === 'copy') {
      const input = $('tv-a-url');
      try { await navigator.clipboard.writeText(input.value); b.textContent = 'Copié'; }
      catch { input.focus(); input.select(); b.textContent = 'Sélectionné : Ctrl+C'; }
      setTimeout(() => { b.textContent = 'Copier'; }, 2500);
    }
  });
})();
