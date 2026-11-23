// Fond de carte « Navigation » : style clair façon application de navigation (public/fonds/navigation.json), dessiné par MapLibre GL
// à partir des tuiles vectorielles d'OpenFreeMap (gratuites, sans clé), posé sous les tracés de la carte Leaflet.
// Partagé par la carte de l'administration (logistics-map.js) et la carte de la TV (carte-tv.js).
(function () {
  const STYLE = '/fonds/navigation.json';
  const WORKER = '/vendor/maplibre/maplibre-gl-csp-worker.js';   // version « CSP » : le worker est un fichier du site, pas un blob
  const TILES_WITHIN_MS = 20000;
  const TILE_ERRORS_MAX = 5;

  function webgl() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
  }

  /** Les bibliothèques sont chargées et l'appareil sait dessiner en WebGL. */
  function supported() {
    return typeof L !== 'undefined' && typeof L.maplibreGL === 'function' && typeof maplibregl !== 'undefined' && webgl();
  }

  /**
   * Crée la couche Leaflet du fond. onFail(raison) est appelé une seule fois si le fond ne s'affiche pas : style ou service
   * injoignable, aucune tuile reçue au bout de 20 s, ou 5 tuiles refusées sans qu'aucune n'arrive. L'appelant revient alors au plan.
   */
  function create(onFail) {
    maplibregl.setWorkerUrl(WORKER);
    const layer = L.maplibreGL({ style: STYLE, interactive: false });
    let styleOk = false; let tilesOk = false; let errors = 0; let done = false; let timer = null;
    const fail = (why) => { if (done || tilesOk) return; done = true; clearTimeout(timer); if (onFail) onFail(why); };
    layer.on('add', () => {
      const gl = layer.getMaplibreMap();
      timer = setTimeout(() => fail('aucune tuile reçue'), TILES_WITHIN_MS);
      gl.once('styledata', () => { styleOk = true; });
      gl.on('data', (e) => { if (e.dataType === 'source' && e.tile && !tilesOk) { tilesOk = true; clearTimeout(timer); } });
      gl.on('error', (e) => {
        if (!styleOk) return fail((e && e.error && e.error.message) || 'style illisible');
        if (e && e.sourceId && !e.tile) return fail('service des tuiles injoignable');   // description de la source (TileJSON) refusée
        if (e && e.sourceId && ++errors >= TILE_ERRORS_MAX) fail('tuiles refusées');
      });
    });
    layer.on('remove', () => { done = true; clearTimeout(timer); });
    return layer;
  }

  window.FondNavigation = { supported, create };
})();
