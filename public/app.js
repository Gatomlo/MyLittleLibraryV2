(function () {
  'use strict';

  // Chemin de montage de l'app (ex. '/mylittlelibrary' quand la passerelle Node monte
  // plusieurs outils sous des sous-dossiers, '' si servie a la racine). Deduit de
  // l'URL reelle utilisee pour charger ce script (via la balise <script src="app.js">,
  // volontairement relative) : fonctionne sans configuration a coder en dur.
  const BASE = (() => {
    try {
      const scriptUrl = document.currentScript && document.currentScript.src;
      if (!scriptUrl) return '';
      return new URL('.', scriptUrl).pathname.replace(/\/$/, '');
    } catch (e) { return ''; }
  })();

  async function api(path, options) {
    const res = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    return res.json();
  }

  api('/api/health')
    .then(() => { document.getElementById('status').textContent = 'Serveur OK.'; })
    .catch((err) => { document.getElementById('status').textContent = 'Serveur injoignable : ' + err.message; });
})();
