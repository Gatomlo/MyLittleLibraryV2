(function () {
  'use strict';

  // Configuration injectee par le serveur (window.MLL, voir renderIndex dans
  // server.js) : ROOT = chemin de montage de l'app (ex. '/mylittlelibrary' dans la
  // passerelle, '' seule) ; LIBRARY = bibliotheque de la page (null sur l'accueil).
  const CONFIG = window.MLL || {};
  const ROOT = typeof CONFIG.root === 'string' ? CONFIG.root : (() => {
    try { return new URL('.', document.currentScript.src).pathname.replace(/\/$/, ''); } catch (e) { return ''; }
  })();
  const LIBRARY = CONFIG.library || null;
  const LIB = LIBRARY ? `${ROOT}/${LIBRARY.slug}` : null;
  const libUrl = (slug) => `${ROOT}/${slug}/`;

  const state = {
    user: null,
    needsSetup: false,
    libraries: [], // bibliotheques gerees par le compte connecte
    settings: LIBRARY ? { libraryName: LIBRARY.name, logoUrl: LIBRARY.logoUrl } : { libraryName: 'Bibliothèques', logoUrl: null },
    catalog: { q: '', category: '', status: '', sort: 'title', page: 1 },
    labels: { mode: 'pending', manual: [] },
  };

  const isAdmin = () => !!state.user && state.user.role === 'admin';
  // Le compte connecte peut-il gerer la bibliotheque de la page ?
  const canManage = () => !!state.user && !!LIBRARY && (isAdmin() || state.libraries.some((l) => l.slug === LIBRARY.slug));

  // ================= Utilitaires =================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const view = () => $('#view');

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Les chemins d'images renvoyes par l'API sont relatifs a la bibliotheque (ou a la racine).
  function mediaSrc(url) {
    return url ? `${LIB || ROOT}/${url}` : '';
  }

  // Dates SQLite (UTC, "AAAA-MM-JJ HH:MM:SS") -> affichage local.
  function fmtDate(s, withTime) {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return withTime
      ? d.toLocaleString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  async function request(base, path, { method = 'GET', body } = {}) {
    const res = await fetch(base + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* reponse vide */ }
    if (res.status === 401 && state.user) {
      state.user = null;
      renderHeader();
    }
    if (!res.ok) throw new Error((data && data.error) || `Erreur ${res.status}`);
    return data;
  }
  // API de la bibliotheque courante / API globale (comptes, administration).
  const api = (path, opts) => request(LIB, path, opts);
  const gapi = (path, opts) => request(ROOT, path, opts);

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function coverHtml(book) {
    return `<div class="cover">${book.coverUrl
      ? `<img src="${esc(mediaSrc(book.coverUrl))}" alt="" loading="lazy">`
      : `<span class="cover-fallback">${esc(book.title)}</span>`}</div>`;
  }

  function availabilityBadge(b) {
    if (!b.totalCopies) return '<span class="badge badge-muted">Aucun exemplaire</span>';
    if (b.availableCopies === 0) return '<span class="badge badge-warn">Emprunté</span>';
    if (b.totalCopies > 1) return `<span class="badge badge-ok">${b.availableCopies}/${b.totalCopies} disponibles</span>`;
    return '<span class="badge badge-ok">Disponible</span>';
  }

  // Redimensionne une image choisie (ou photographiee) avant envoi au serveur.
  function imageToDataUrl(file, maxSize, mime) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL(mime, 0.86));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
      img.src = url;
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Chargement impossible : ' + src));
      document.head.appendChild(s);
    });
  }

  function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
  function sessionStorageTake(k) {
    try { const v = sessionStorage.getItem(k); sessionStorage.removeItem(k); return v; } catch (e) { return null; }
  }

  // ================= Scanner (webcam / camera du telephone) =================
  // API BarcodeDetector native quand le navigateur la fournit (Chrome Android...),
  // sinon polyfill ZXing/WebAssembly servi par l'app (Safari iOS, Firefox...).
  const detectors = {};
  async function getDetector(formats) {
    const key = formats.join(',');
    if (detectors[key]) return detectors[key];
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        if (formats.every((f) => supported.includes(f))) return (detectors[key] = new window.BarcodeDetector({ formats }));
      } catch (e) { /* on bascule sur le polyfill */ }
    }
    if (!window.BarcodeDetectionAPI) {
      await loadScript(ROOT + '/vendor/barcode-detector.js');
      window.BarcodeDetectionAPI.prepareZXingModule({
        overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? ROOT + '/vendor/zxing_reader.wasm' : prefix + p) },
      });
    }
    return (detectors[key] = new window.BarcodeDetectionAPI.BarcodeDetector({ formats }));
  }

  // Reglages de la camera quand elle les accepte : mise au point continue et, pour un
  // code-barres sur telephone, un leger zoom (permet de tenir le livre assez loin
  // pour que la mise au point se fasse).
  async function tuneCamera(track, isBarcode) {
    if (!track || !track.getCapabilities) return;
    try {
      const caps = track.getCapabilities();
      const advanced = [];
      if (caps.focusMode && caps.focusMode.includes('continuous')) advanced.push({ focusMode: 'continuous' });
      if (isBarcode && caps.zoom && caps.zoom.max >= 1.8) advanced.push({ zoom: Math.min(2, caps.zoom.max) });
      if (advanced.length) await track.applyConstraints({ advanced });
    } catch (e) { /* reglages non supportes : on garde ceux par defaut */ }
  }

  let quaggaPromise = null;
  function loadQuagga() {
    if (!quaggaPromise) quaggaPromise = loadScript(ROOT + '/vendor/quagga.min.js');
    return quaggaPromise;
  }

  // Lecture EAN-13 avec Quagga2 sur un canvas ; null si rien n'est lu (ou apres 3 s).
  function quaggaDecode(canvas) {
    const Q = window.Quagga && (window.Quagga.default || window.Quagga);
    if (!Q) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      Q.decodeSingle({
        src: canvas.toDataURL('image/jpeg', 0.92),
        numOfWorkers: 0,
        inputStream: { size: Math.min(1600, canvas.width) },
        locate: true,
        locator: { patchSize: 'medium', halfSample: false },
        decoder: { readers: ['ean_reader'] },
      }, (r) => { clearTimeout(timeout); resolve(r && r.codeResult ? r.codeResult.code : null); });
    });
  }

  // Ouvre la camera et renvoie la premiere valeur lue acceptee par `accept`
  // (ou null si l'utilisateur ferme). Saisie manuelle et photo en secours.
  function openScanner({ title, hint, formats, accept, manualLabel }) {
    return new Promise((resolve) => {
      const isBarcode = !formats.includes('qr_code');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h2>${esc(title)}</h2>
          <div class="scanner-video ${isBarcode ? 'barcode' : ''}"><video playsinline muted></video><div class="frame"></div></div>
          <p class="scanner-status">${esc(hint)}</p>
          <form class="field isbn-row manual">
            <input name="manual" placeholder="${esc(manualLabel)}" autocomplete="off" ${isBarcode ? 'inputmode="numeric"' : ''}>
            <button class="btn btn-primary" type="submit">OK</button>
          </form>
          <div class="btn-row">
            <label class="btn" style="margin:0">Photo<input type="file" accept="image/*" capture="environment" hidden></label>
            <button class="btn" type="button" data-close style="margin-left:auto">Fermer</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      const video = $('video', backdrop);
      const status = $('.scanner-status', backdrop);
      let stream = null;
      let done = false;
      let timer = null;

      function finish(value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (stream) stream.getTracks().forEach((t) => t.stop());
        backdrop.remove();
        resolve(value);
      }

      function tryValue(raw) {
        const value = accept(String(raw || '').trim());
        if (value) {
          if (navigator.vibrate) navigator.vibrate(80);
          finish(value);
          return true;
        }
        return false;
      }

      backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) finish(null); });
      $('form.manual', backdrop).addEventListener('submit', (e) => {
        e.preventDefault();
        const v = e.target.manual.value;
        if (!tryValue(v)) status.textContent = 'Valeur non reconnue, vérifie la saisie.';
      });
      $('input[type=file]', backdrop).addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        status.textContent = 'Analyse de la photo…';
        try {
          const detector = await getDetector(formats);
          const bitmap = await createImageBitmap(file);
          const codes = await detector.detect(bitmap);
          if (codes.some((c) => tryValue(c.rawValue))) return;
          if (isBarcode) {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
            await loadQuagga();
            if (tryValue(await quaggaDecode(canvas))) return;
          }
          status.textContent = 'Aucun code lisible sur la photo. Réessaie plus près et bien éclairé.';
        } catch (err) { status.textContent = 'Analyse impossible : ' + err.message; }
      });

      (async () => {
        let detector;
        try {
          detector = await getDetector(formats);
          if (isBarcode) await loadQuagga().catch(() => null);
        } catch (err) {
          status.textContent = 'Lecteur de codes indisponible : ' + err.message;
          return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          status.textContent = 'Caméra inaccessible ici (il faut une connexion https). Utilise la saisie ou une photo.';
          return;
        }
        try {
          // Resolution maximale : un code-barres ISBN est petit, chaque pixel compte.
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: false,
          });
        } catch (err) {
          status.textContent = 'Caméra refusée ou absente. Utilise la saisie manuelle ou une photo.';
          return;
        }
        if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
        await tuneCamera(stream.getVideoTracks()[0], isBarcode);
        video.srcObject = stream;
        await video.play().catch(() => {});
        if (isBarcode) {
          status.textContent = `${hint} Tiens le livre à 15-25 cm, bien éclairé, le code-barres net et à plat dans le cadre.`;
        }

        // Code-barres : on n'analyse que la bande centrale (zone du cadre) en pleine
        // resolution, avec deux moteurs complementaires : ZXing (rapide) et Quagga2
        // (plus tolerant au flou des webcams). Une lecture Quagga doit etre confirmee
        // deux fois pour ecarter les erreurs de lecture.
        const band = document.createElement('canvas');
        const quaggaHits = new Map();
        let frame = 0;
        const tick = async () => {
          if (done) return;
          try {
            if (video.readyState >= 2 && video.videoWidth) {
              let source = video;
              if (isBarcode) {
                const vw = video.videoWidth;
                const vh = video.videoHeight;
                band.width = Math.round(vw * 0.9);
                band.height = Math.round(vh * 0.6);
                band.getContext('2d').drawImage(video, vw * 0.05, vh * 0.2, band.width, band.height, 0, 0, band.width, band.height);
                source = band;
              }
              const codes = await detector.detect(source);
              for (const c of codes) if (tryValue(c.rawValue)) return;
              if (isBarcode && window.Quagga && ++frame % 2 === 0) {
                const q = accept(String((await quaggaDecode(band)) || ''));
                if (q) {
                  const hits = (quaggaHits.get(q) || 0) + 1;
                  quaggaHits.set(q, hits);
                  if (hits >= 2 && tryValue(q)) return;
                }
              }
            }
          } catch (e) { /* image suivante */ }
          timer = setTimeout(tick, 120);
        };
        tick();
      })();
    });
  }

  // ISBN-13 (978/979 + cle de controle EAN valide) ou ISBN-10 saisi a la main.
  function isbnFromScan(raw) {
    const digits = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (/^97[89]\d{10}$/.test(digits)) {
      const sum = digits.split('').reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
      return sum % 10 === 0 ? digits : null;
    }
    if (/^\d{9}[\dX]$/.test(digits)) return digits;
    return null;
  }

  // Code d'exemplaire : soit brut (BIB-00042), soit l'adresse encodee dans le QR (…#/c/BIB-00042).
  function copyCodeFromScan(raw) {
    const m = raw.match(/#\/c\/([^/?#\s]+)/);
    const code = m ? decodeURIComponent(m[1]) : raw;
    return /^[A-Za-z0-9]{1,10}-\d{1,8}$/.test(code) ? code.toUpperCase() : null;
  }

  function scanCopy() {
    return openScanner({
      title: 'Scanner une étiquette',
      hint: "Vise le QR code de l'étiquette du livre.",
      formats: ['qr_code'],
      accept: copyCodeFromScan,
      manualLabel: 'ou tape le code (ex. BIB-00042)',
    });
  }

  function scanIsbn() {
    return openScanner({
      title: 'Scanner le code-barres',
      hint: 'Vise le code-barres ISBN au dos du livre (978… ou 979…).',
      formats: ['ean_13'],
      accept: isbnFromScan,
      manualLabel: "ou tape l'ISBN",
    });
  }

  // ================= En-tete : marque, navigation, menu du compte =================
  function renderBrand() {
    const s = state.settings;
    $('#brand-name').textContent = s.libraryName;
    document.title = s.libraryName;
    const brand = $('.brand');
    brand.href = LIBRARY ? `${LIB}/#/` : `${ROOT}/#/`;
    const logo = $('#brand-logo');
    logo.hidden = !s.logoUrl;
    if (s.logoUrl) logo.src = mediaSrc(s.logoUrl);
  }

  function renderHeader() {
    renderBrand();
    renderNav();
    renderAccount();
  }

  function renderNav() {
    let links = [];
    if (LIBRARY) {
      links = canManage()
        ? [['#/', 'Catalogue'], ['#/add', 'Ajouter'], ['#/import', 'Importer'], ['#/loans', 'Prêts'], ['#/borrowers', 'Emprunteurs'], ['#/labels', 'Étiquettes'], ['#/settings', 'Réglages']]
        : [['#/', 'Catalogue']];
    }
    const current = '#/' + (location.hash.replace(/^#\/?/, '').split('/')[0] || '');
    $('#nav').innerHTML = links.map(([href, label]) => {
      const active = href === current || (href === '#/' && (current === '#/book' || current === '#/'));
      return `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
    }).join('');
    $('#nav').hidden = links.length <= 1;
    $('#scan-btn').hidden = !canManage();
  }

  const USER_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function renderAccount() {
    const box = $('#account');
    if (!state.user) {
      // Sur l'accueil, la page est deja celle de connexion.
      box.innerHTML = LIBRARY ? `<a class="btn btn-small account-btn" href="#/login">${USER_ICON}<span class="name">Connexion</span></a>` : '';
      return;
    }
    box.innerHTML = `<button class="btn btn-small account-btn" type="button" id="account-btn" aria-haspopup="true" aria-expanded="false">
      ${USER_ICON}<span class="name">${esc(state.user.username)}</span><span aria-hidden="true">▾</span></button>`;
    $('#account-btn').onclick = (e) => {
      e.stopPropagation();
      const open = $('#account .menu');
      if (open) { closeMenu(); return; }
      openMenu();
    };
  }

  function closeMenu() {
    const m = $('#account .menu');
    if (m) m.remove();
    const b = $('#account-btn');
    if (b) b.setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    const u = state.user;
    const def = u.defaultLibraryId;
    const libs = state.libraries.map((l) => `
      <div class="menu-item ${LIBRARY && l.slug === LIBRARY.slug ? 'current' : ''}" style="padding:0 4px 0 0">
        <a class="menu-item" href="${esc(libUrl(l.slug))}" style="flex:1;min-width:0">
          ${l.logoUrl ? `<img src="${esc(ROOT + '/' + l.logoUrl)}" alt="">` : ''}<span class="grow">${esc(l.name)}</span></a>
        <button class="star ${l.id === def ? 'on' : ''}" data-default="${l.id}" title="${l.id === def ? 'Bibliothèque par défaut' : 'Définir comme bibliothèque par défaut'}">${l.id === def ? '★' : '☆'}</button>
      </div>`).join('');
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = `
      <div class="menu-head"><strong>${esc(u.username)}</strong>${u.role === 'admin' ? 'Administrateur' : 'Gestionnaire'}</div>
      <div class="menu-sep"></div>
      <div class="menu-title">Mes bibliothèques</div>
      ${libs || '<p class="small muted" style="padding:4px 10px">Aucune bibliothèque liée à ce compte.</p>'}
      <div class="menu-sep"></div>
      <a class="menu-item" href="#/account">Mon compte</a>
      ${u.role === 'admin' ? '<a class="menu-item" href="#/admin">Administration</a>' : ''}
      <button class="menu-item" type="button" id="logout">Déconnexion</button>`;
    $('#account').appendChild(menu);
    $('#account-btn').setAttribute('aria-expanded', 'true');
    menu.addEventListener('click', (e) => e.stopPropagation());
    $$('a', menu).forEach((a) => a.addEventListener('click', closeMenu));
    $$('[data-default]', menu).forEach((btn) => {
      btn.onclick = async () => {
        const id = Number(btn.dataset.default);
        try {
          await gapi('/api/me/default-library', { method: 'PUT', body: { libraryId: id } });
          state.user.defaultLibraryId = id;
          closeMenu();
          openMenu();
          toast('Bibliothèque par défaut enregistrée.');
        } catch (err) { toast(err.message, 'error'); }
      };
    });
    $('#logout').onclick = async () => {
      closeMenu();
      await gapi('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
      state.user = null;
      state.libraries = [];
      toast('Déconnecté.');
      renderHeader();
      go('#/');
    };
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // ================= Routage =================
  // needs : 'manage' (gerer cette bibliotheque), 'user' (etre connecte), 'admin'.
  const LIBRARY_ROUTES = [
    [/^\/?$/, viewCatalog],
    [/^\/book\/(\d+)$/, viewBook],
    [/^\/book\/(\d+)\/edit$/, viewBookForm, 'manage'],
    [/^\/c\/([^/]+)$/, viewCopy],
    [/^\/login$/, viewLogin],
    [/^\/add$/, viewBookForm, 'manage'],
    [/^\/import$/, viewImport, 'manage'],
    [/^\/loans$/, viewLoans, 'manage'],
    [/^\/borrowers$/, viewBorrowers, 'manage'],
    [/^\/borrower\/(\d+)$/, viewBorrower, 'manage'],
    [/^\/labels$/, viewLabels, 'manage'],
    [/^\/settings$/, viewSettings, 'manage'],
    [/^\/account$/, viewAccount, 'user'],
    [/^\/admin$/, viewAdmin, 'admin'],
  ];
  const HOME_ROUTES = [
    [/^\/?$/, viewHome],
    [/^\/login$/, viewLogin],
    [/^\/account$/, viewAccount, 'user'],
    [/^\/admin$/, viewAdmin, 'admin'],
    // Anciennes etiquettes (d'avant les bibliotheques multiples) : #/c/CODE a la racine.
    [/^\/(c\/[^/]+|book\/\d+)$/, viewLegacyRedirect],
  ];

  async function route() {
    closeMenu();
    const path = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
    renderNav();
    window.scrollTo(0, 0);
    for (const [re, fn, needs] of (LIBRARY ? LIBRARY_ROUTES : HOME_ROUTES)) {
      const m = path.match(re);
      if (!m) continue;
      if (needs && !state.user) {
        sessionStorageSet('mll-after-login', location.hash);
        return go('#/login');
      }
      if ((needs === 'manage' && !canManage()) || (needs === 'admin' && !isAdmin())) {
        view().innerHTML = `<div class="empty">Ton compte n'a pas accès à cette page.<br><br><a class="btn" href="#/">Retour</a></div>`;
        return;
      }
      view().innerHTML = '<p class="muted">Chargement…</p>';
      try {
        await fn(...m.slice(1));
      } catch (err) {
        view().innerHTML = `<div class="error-box">${esc(err.message)}</div><a class="btn" href="#/">Retour</a>`;
      }
      return;
    }
    view().innerHTML = '<div class="empty">Page introuvable.</div>';
  }

  // ================= Accueil (racine du site) =================
  // Non connecte : uniquement la page de connexion (les catalogues publics ont
  // chacun leur adresse). Connecte : ouverture de sa bibliotheque par defaut, ou
  // liste de ses bibliotheques quand on y revient depuis le menu.
  async function viewHome() {
    if (!state.user) return viewLogin();
    const params = new URLSearchParams(location.search);
    const def = state.libraries.find((l) => l.id === state.user.defaultLibraryId) || state.libraries[0];
    if (def && !params.has('accueil')) { location.replace(libUrl(def.slug)); return; }
    const libs = state.libraries;
    view().innerHTML = `
      <div class="page-head"><div><h1>Mes bibliothèques</h1></div>
        ${isAdmin() ? '<a class="btn btn-primary" href="#/admin">Administration</a>' : ''}</div>
      ${libs.length ? `<div class="lib-grid">${libs.map((l) => `
        <a class="card lib-card" href="${esc(libUrl(l.slug))}">
          ${l.logoUrl ? `<img src="${esc(ROOT + '/' + l.logoUrl)}" alt="">` : `<span class="ph">${esc(l.name.charAt(0).toUpperCase())}</span>`}
          <div><strong>${esc(l.name)}</strong><div class="small muted">/${esc(l.slug)}/${l.id === state.user.defaultLibraryId ? ' · par défaut' : ''}</div></div>
        </a>`).join('')}</div>`
        : `<div class="empty">Aucune bibliothèque n'est liée à ton compte.${isAdmin() ? '<br><br><a class="btn btn-primary" href="#/admin">Créer une bibliothèque</a>' : ' Demande à un administrateur.'}</div>`}`;
  }

  async function viewLegacyRedirect(rest) {
    const libs = await gapi('/api/libraries');
    if (!libs.length) return go('#/');
    location.replace(`${libUrl(libs[0].slug)}#/${rest}`);
  }

  // ================= Catalogue =================
  async function loadCategories() {
    return api('/api/public/categories');
  }

  async function viewCatalog() {
    const c = state.catalog;
    const cats = await loadCategories();
    view().innerHTML = `
      <div class="page-head">
        <div><h1>Catalogue</h1><p class="muted" id="count"></p></div>
        ${canManage() ? '<div class="btn-row"><a class="btn" href="#/import">Importer une liste</a><a class="btn btn-primary" href="#/add">+ Ajouter un livre</a></div>' : ''}
      </div>
      <div class="filters">
        <input class="search" type="search" id="q" placeholder="Titre, auteur, éditeur, ISBN${canManage() ? ', code' : ''}…" value="${esc(c.q)}">
        <select id="cat"><option value="">Toutes les catégories</option>
          ${cats.filter((x) => x.count > 0).map((x) => `<option value="${x.id}" ${String(x.id) === c.category ? 'selected' : ''}>${esc(x.name)} (${x.count})</option>`).join('')}
        </select>
        <select id="status">
          <option value="">Tous</option>
          <option value="available" ${c.status === 'available' ? 'selected' : ''}>Disponibles</option>
          <option value="onloan" ${c.status === 'onloan' ? 'selected' : ''}>En prêt</option>
        </select>
        <select id="sort">
          <option value="title">Tri : titre</option>
          <option value="recent" ${c.sort === 'recent' ? 'selected' : ''}>Tri : ajout récent</option>
          <option value="year" ${c.sort === 'year' ? 'selected' : ''}>Tri : année</option>
        </select>
      </div>
      <div class="books" id="books"></div>
      <div class="more" id="more"></div>`;
    const reload = () => { c.page = 1; loadBooks(false); };
    $('#q').addEventListener('input', debounce((e) => { c.q = e.target.value; reload(); }, 250));
    $('#cat').addEventListener('change', (e) => { c.category = e.target.value; reload(); });
    $('#status').addEventListener('change', (e) => { c.status = e.target.value; reload(); });
    $('#sort').addEventListener('change', (e) => { c.sort = e.target.value; reload(); });
    await loadBooks(false);
  }

  async function loadBooks(append) {
    const c = state.catalog;
    const params = new URLSearchParams({ q: c.q, category: c.category, status: c.status, sort: c.sort, page: c.page, limit: 48 });
    const data = await api(`/api/${canManage() ? 'books' : 'public/books'}?${params}`);
    const list = $('#books');
    if (!list) return;
    const html = data.items.map((b) => `
      <a class="book-card" href="#/book/${b.id}">
        ${coverHtml(b)}
        <div class="meta">
          <span class="t">${esc(b.title)}</span>
          <span class="a">${esc(b.authors)}${b.year ? ' · ' + b.year : ''}</span>
          ${availabilityBadge(b)}
        </div>
      </a>`).join('');
    if (append) list.insertAdjacentHTML('beforeend', html);
    else list.innerHTML = html || `<div class="empty" style="grid-column:1/-1">${c.q || c.category || c.status ? 'Aucun livre ne correspond.' : 'Le catalogue est vide pour le moment.'}</div>`;
    $('#count').textContent = `${data.total} livre${data.total > 1 ? 's' : ''}`;
    const shown = (data.page - 1) * data.limit + data.items.length;
    $('#more').innerHTML = shown < data.total ? '<button class="btn" id="more-btn">Afficher plus</button>' : '';
    const more = $('#more-btn');
    if (more) more.onclick = () => { c.page++; loadBooks(true); };
  }

  // ================= Fiche livre =================
  async function viewBook(id) {
    const manage = canManage();
    const book = await api(manage ? `/api/books/${id}` : `/api/public/books/${id}`);
    const facts = [
      ['Auteur(s)', esc(book.authors)],
      ['Éditeur', esc(book.publisher)],
      ['Année', book.year || ''],
      ['Pages', book.pages || ''],
      ['ISBN', esc(book.isbn)],
      ['Catégories', book.categories.map((c) => `<span class="chip">${esc(c.name)}</span>`).join('')],
    ].filter(([, v]) => v);
    view().innerHTML = `
      <p><a href="#/">← Catalogue</a></p>
      <div class="book-detail">
        <div>${coverHtml(book)}</div>
        <div>
          <h1>${esc(book.title)}</h1>
          ${book.subtitle ? `<div class="subtitle">${esc(book.subtitle)}</div>` : ''}
          ${availabilityBadge(book)}
          <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
          ${book.summary ? `<h3>Résumé</h3><p class="summary">${esc(book.summary)}</p>` : ''}
          ${manage && book.notes ? `<h3>Notes internes</h3><p class="summary muted">${esc(book.notes)}</p>` : ''}
          ${manage ? `<div class="btn-row" style="margin-top:14px">
              <a class="btn" href="#/book/${book.id}/edit">Modifier</a>
              <button class="btn btn-danger" id="del-book">Supprimer</button>
            </div>` : ''}
        </div>
      </div>
      <h2>Exemplaires</h2>
      <div class="card" id="copies">${manage ? adminCopiesHtml(book) : publicCopiesHtml(book)}</div>
      ${manage && book.history.length ? `<h2>Historique des prêts</h2><div class="card table-wrap">${historyHtml(book.history)}</div>` : ''}`;
    if (manage) bindAdminBook(book);
  }

  function publicCopiesHtml(book) {
    if (!book.copies.length) return '<p class="muted">Aucun exemplaire.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Emplacement</th><th>État</th></tr></thead><tbody>
      ${book.copies.map((c) => `<tr><td class="code">${esc(c.code)}</td><td>${esc(c.location) || '<span class="muted">—</span>'}</td>
        <td>${c.available ? '<span class="badge badge-ok">Disponible</span>' : '<span class="badge badge-warn">Emprunté</span>'}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function adminCopiesHtml(book) {
    const rows = book.copies.map((c) => `
      <tr>
        <td class="code"><a href="#/c/${encodeURIComponent(c.code)}">${esc(c.code)}</a></td>
        <td>${esc(c.location) || '<span class="muted">—</span>'}</td>
        <td>${c.loan
          ? `<span class="badge badge-warn">Prêté</span> à <a href="#/borrower/${c.loan.borrower.id}">${esc(c.loan.borrower.name)}</a><div class="small muted">depuis le ${fmtDate(c.loan.loanedAt)}</div>`
          : '<span class="badge badge-ok">Disponible</span>'}</td>
        <td>${c.labelPrintedAt ? '<span class="small muted">imprimée</span>' : '<span class="badge badge-muted">à imprimer</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          <a class="btn btn-small ${c.loan ? 'btn-ok' : 'btn-primary'}" href="#/c/${encodeURIComponent(c.code)}">${c.loan ? 'Retour' : 'Prêter'}</a>
          <button class="btn btn-small" data-edit-copy="${c.id}">Modifier</button>
        </td>
      </tr>`).join('');
    return `
      ${book.copies.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Code</th><th>Emplacement</th><th>État</th><th>Étiquette</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Aucun exemplaire.</p>'}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" id="add-copy">+ Ajouter un exemplaire</button>
        ${book.copies.length ? '<button class="btn" id="print-labels">Imprimer les étiquettes</button>' : ''}
      </div>`;
  }

  function historyHtml(history) {
    return `<table><thead><tr><th>Exemplaire</th><th>Emprunteur</th><th>Prêté le</th><th>Rendu le</th></tr></thead><tbody>
      ${history.map((l) => `<tr><td class="code">${esc(l.code)}</td><td><a href="#/borrower/${l.borrower.id}">${esc(l.borrower.name)}</a></td>
        <td>${fmtDate(l.loanedAt)}</td><td>${l.returnedAt ? fmtDate(l.returnedAt) : '<span class="badge badge-warn">en cours</span>'}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function bindAdminBook(book) {
    $('#del-book').onclick = async () => {
      if (!confirm(`Supprimer définitivement « ${book.title} », ses ${book.copies.length} exemplaire(s) et leur historique de prêts ?`)) return;
      try {
        await api(`/api/books/${book.id}`, { method: 'DELETE' });
        toast('Livre supprimé.');
        go('#/');
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#add-copy').onclick = async () => {
      const location = prompt("Emplacement du nouvel exemplaire (facultatif) :", (book.copies[0] && book.copies[0].location) || '');
      if (location === null) return;
      try {
        const r = await api(`/api/books/${book.id}/copies`, { method: 'POST', body: { count: 1, location } });
        toast(`Exemplaire ${r.codes[0]} créé.`);
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
    const print = $('#print-labels');
    if (print) print.onclick = () => {
      state.labels = { mode: 'manual', manual: book.copies.map((c) => ({ code: c.code, title: book.title })) };
      go('#/labels');
    };
    $$('[data-edit-copy]').forEach((btn) => {
      btn.onclick = () => editCopyDialog(book.copies.find((c) => c.id === Number(btn.dataset.editCopy)));
    });
  }

  async function editCopyDialog(copy) {
    const locations = await api('/api/locations').catch(() => []);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <form class="modal">
        <h2>Exemplaire <span class="code">${esc(copy.code)}</span></h2>
        <div class="field"><label>Emplacement</label><input name="location" list="loc-list" value="${esc(copy.location)}">
          <datalist id="loc-list">${locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></div>
        <div class="field"><label>Notes (état, provenance…)</label><textarea name="notes" style="min-height:80px">${esc(copy.notes)}</textarea></div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Enregistrer</button>
          <button class="btn" type="button" data-close>Annuler</button>
          <button class="btn btn-danger" type="button" data-delete style="margin-left:auto">Supprimer</button>
        </div>
      </form>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(); });
    $('[data-delete]', backdrop).onclick = async () => {
      if (!confirm(`Supprimer l'exemplaire ${copy.code} et son historique de prêts ?`)) return;
      try { await api(`/api/copies/${copy.id}`, { method: 'DELETE' }); close(); toast('Exemplaire supprimé.'); route(); } catch (err) { toast(err.message, 'error'); }
    };
    $('form', backdrop).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/copies/${copy.id}`, { method: 'PUT', body: { location: e.target.location.value, notes: e.target.notes.value } });
        close();
        toast('Exemplaire mis à jour.');
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ================= Exemplaire (cible du QR code) : pret / retour =================
  async function viewCopy(code) {
    if (!canManage()) {
      const r = await api(`/api/public/copies/${encodeURIComponent(code)}`);
      location.replace(`#/book/${r.bookId}`);
      return;
    }
    const { copy, book, oldCode } = await api(`/api/copies/by-code/${encodeURIComponent(code)}`);
    if (oldCode) {
      history.replaceState(null, '', `#/c/${encodeURIComponent(copy.code)}`);
      toast(`Ancienne étiquette ${oldCode} : cet exemplaire s'appelle maintenant ${copy.code}. Pense à réimprimer son étiquette.`);
    }
    const borrowers = copy.loan ? [] : await api('/api/borrowers');
    view().innerHTML = `
      <p><a href="#/loans">← Prêts</a></p>
      <div class="card">
        <div class="list-item" style="border:0;padding-top:0">
          ${book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(book.coverUrl))}" alt="">` : ''}
          <div class="grow">
            <div class="code">${esc(copy.code)}</div>
            <a href="#/book/${book.id}"><strong>${esc(book.title)}</strong></a>
            <div class="small muted">${esc(book.authors)}${copy.location ? ' · ' + esc(copy.location) : ''}</div>
          </div>
        </div>
        ${copy.loan ? `
          <div class="info-box">Prêté à <strong>${esc(copy.loan.borrower.name)}</strong> depuis le ${fmtDate(copy.loan.loanedAt)}.</div>
          <button class="btn btn-ok btn-block" id="return">Enregistrer le retour</button>
        ` : `
          <div class="info-box"><span class="badge badge-ok">Disponible</span></div>
          <form id="loan-form">
            <div class="field">
              <label for="borrower">Emprunteur</label>
              <input id="borrower" name="borrower" list="borrower-list" placeholder="Nom (nouvel emprunteur créé automatiquement)" autocomplete="off" required>
              <datalist id="borrower-list">${borrowers.map((b) => `<option value="${esc(b.name)}">`).join('')}</datalist>
            </div>
            <div class="field"><label for="notes">Remarque (facultatif)</label><input id="notes" name="notes"></div>
            <button class="btn btn-primary btn-block" type="submit">Prêter</button>
          </form>`}
      </div>
      <div class="btn-row" style="margin-top:14px"><button class="btn" id="scan-next">Scanner un autre livre</button></div>`;
    $('#scan-next').onclick = async () => { const c = await scanCopy(); if (c) go(`#/c/${encodeURIComponent(c)}`); };
    if (copy.loan) {
      $('#return').onclick = async () => {
        try {
          await api(`/api/loans/${copy.loan.id}/return`, { method: 'POST', body: {} });
          toast(`Retour de ${copy.code} enregistré.`);
          route();
        } catch (err) { toast(err.message, 'error'); }
      };
    } else {
      $('#borrower').focus();
      $('#loan-form').onsubmit = async (e) => {
        e.preventDefault();
        const name = e.target.borrower.value.trim();
        const match = borrowers.find((b) => b.name.toLowerCase() === name.toLowerCase());
        try {
          await api('/api/loans', { method: 'POST', body: { code: copy.code, borrowerId: match ? match.id : null, borrowerName: name, notes: e.target.notes.value } });
          toast(`${copy.code} prêté à ${name}.`);
          route();
        } catch (err) { toast(err.message, 'error'); }
      };
    }
  }

  // ================= Connexion =================
  async function viewLogin() {
    if (state.user) return go('#/');
    const setup = state.needsSetup;
    view().innerHTML = `
      <div class="card" style="max-width:400px;margin:24px auto">
        <h1>${setup ? 'Premier démarrage' : 'Connexion'}</h1>
        <p class="muted">${setup ? "Crée le compte administrateur et la première bibliothèque." : 'Réservé à la gestion des bibliothèques.'}</p>
        <div id="err"></div>
        <form id="login-form">
          ${setup ? '<div class="field"><label for="lib">Nom de la bibliothèque</label><input id="lib" name="libraryName" required value="Bibliothèque du bureau"></div>' : ''}
          <div class="field"><label for="u">Identifiant</label><input id="u" name="username" autocomplete="username" required></div>
          <div class="field"><label for="p">Mot de passe${setup ? ' (8 caractères min.)' : ''}</label><input id="p" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? 'minlength="8"' : ''}></div>
          <button class="btn btn-primary btn-block" type="submit">${setup ? 'Créer' : 'Se connecter'}</button>
        </form>
      </div>`;
    $('#u').focus();
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true;
      const body = { username: e.target.username.value, password: e.target.password.value };
      if (setup) body.libraryName = e.target.libraryName.value;
      try {
        await gapi(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body });
        await loadStatus();
        toast(`Bienvenue ${state.user.username} !`);
        const after = sessionStorageTake('mll-after-login');
        if (LIBRARY) {
          renderHeader();
          go(after || '#/');
        } else {
          const def = state.libraries.find((l) => l.id === state.user.defaultLibraryId) || state.libraries[0];
          if (def && !after) location.href = libUrl(def.slug);
          else { renderHeader(); go(after || '#/'); }
        }
      } catch (err) {
        $('#err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    };
  }

  // ================= Mon compte =================
  async function viewAccount() {
    const u = state.user;
    view().innerHTML = `
      <h1>Mon compte</h1>
      <p class="muted">${esc(u.username)} · ${u.role === 'admin' ? 'Administrateur (gère toutes les bibliothèques)' : 'Gestionnaire'}</p>
      <h2>Bibliothèque par défaut</h2>
      <div class="card">
        ${state.libraries.length ? `<p class="small muted">Ouverte automatiquement après la connexion. Le menu du compte permet de basculer à tout moment.</p>
        <div class="list">${state.libraries.map((l) => `
          <label class="list-item check" style="cursor:pointer">
            <input type="radio" name="def" value="${l.id}" ${l.id === u.defaultLibraryId ? 'checked' : ''}>
            <span class="grow">${esc(l.name)} <span class="small muted">/${esc(l.slug)}/</span></span>
            <a class="btn btn-small" href="${esc(libUrl(l.slug))}">Ouvrir</a>
          </label>`).join('')}</div>`
        : '<p class="muted">Aucune bibliothèque n\'est liée à ton compte. Demande à un administrateur.</p>'}
      </div>
      <h2>Mot de passe</h2>
      <form class="card" id="pwd-form">
        <div class="grid-2">
          <div class="field"><label>Mot de passe actuel</label><input name="current" type="password" autocomplete="current-password" required></div>
          <div class="field"><label>Nouveau mot de passe (8 caractères min.)</label><input name="password" type="password" autocomplete="new-password" minlength="8" required></div>
        </div>
        <button class="btn" type="submit">Changer le mot de passe</button>
      </form>`;
    $$('input[name=def]').forEach((radio) => {
      radio.onchange = async () => {
        try {
          await gapi('/api/me/default-library', { method: 'PUT', body: { libraryId: Number(radio.value) } });
          state.user.defaultLibraryId = Number(radio.value);
          toast('Bibliothèque par défaut enregistrée.');
        } catch (err) { toast(err.message, 'error'); }
      };
    });
    $('#pwd-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await gapi('/api/me/password', { method: 'POST', body: { current: e.target.current.value, password: e.target.password.value } });
        e.target.reset();
        toast('Mot de passe modifié.');
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ================= Administration =================
  let adminTab = 'libraries';
  async function viewAdmin() {
    view().innerHTML = `
      <div class="page-head"><h1>Administration</h1></div>
      <div class="tabs">
        <button data-tab="libraries" class="${adminTab === 'libraries' ? 'active' : ''}">Bibliothèques</button>
        <button data-tab="users" class="${adminTab === 'users' ? 'active' : ''}">Comptes</button>
        <button data-tab="data" class="${adminTab === 'data' ? 'active' : ''}">Sauvegarde</button>
      </div>
      <div id="admin-body"></div>`;
    $$('.tabs button').forEach((btn) => { btn.onclick = () => { adminTab = btn.dataset.tab; viewAdmin(); }; });
    if (adminTab === 'libraries') await adminLibraries();
    else if (adminTab === 'users') await adminUsers();
    else {
      $('#admin-body').innerHTML = `<div class="card">
        <p>Copie complète de la base (toutes les bibliothèques, comptes, prêts). Les images (couvertures, logos) sont dans le dossier <span class="code">data/media</span> du serveur.</p>
        <a class="btn" href="${ROOT}/api/admin/backup">Télécharger une sauvegarde de la base</a></div>`;
    }
  }

  async function refreshMyLibraries() {
    await loadStatus();
    renderHeader();
  }

  async function adminLibraries() {
    const libs = await gapi('/api/admin/libraries');
    const origin = location.origin + ROOT + '/';
    $('#admin-body').innerHTML = `
      <form class="card" id="new-lib" style="margin-bottom:18px">
        <h3 style="margin-top:0">Nouvelle bibliothèque</h3>
        <div class="grid-2">
          <div class="field"><label>Nom *</label><input name="name" required placeholder="ex. Bibliothèque de l'accueil"></div>
          <div class="field"><label>Adresse</label><input name="slug" placeholder="calculée depuis le nom" pattern="[a-z0-9][a-z0-9-]*"></div>
        </div>
        <p class="small muted" id="slug-preview"></p>
        <button class="btn btn-primary" type="submit">Créer</button>
      </form>
      <div class="card">${libs.length ? `<div class="list">${libs.map((l) => `
        <div class="list-item">
          <div class="grow">
            <strong>${esc(l.name)}</strong>
            <div class="small"><a href="${esc(libUrl(l.slug))}">${esc(origin + l.slug)}/</a></div>
            <div class="small muted">${l.books} livre(s) · ${l.copies} exemplaire(s) · ${l.users} compte(s) lié(s)</div>
          </div>
          <button class="btn btn-small" data-edit-lib="${l.id}">Modifier</button>
          <button class="btn btn-small btn-danger" data-del-lib="${l.id}">Supprimer</button>
        </div>`).join('')}</div>` : '<p class="muted">Aucune bibliothèque.</p>'}</div>`;

    const f = $('#new-lib');
    let userEditedSlug = false;
    const preview = debounce(async () => {
      if (userEditedSlug) { $('#slug-preview').textContent = `Adresse : ${origin}${f.slug.value}/`; return; }
      if (!f.name.value.trim()) { $('#slug-preview').textContent = ''; return; }
      const r = await gapi(`/api/admin/slug?name=${encodeURIComponent(f.name.value)}`).catch(() => null);
      if (r) { f.slug.placeholder = r.slug; $('#slug-preview').textContent = `Adresse : ${origin}${r.slug}/`; }
    }, 250);
    f.name.addEventListener('input', preview);
    f.slug.addEventListener('input', () => { userEditedSlug = !!f.slug.value; preview(); });
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const lib = await gapi('/api/admin/libraries', { method: 'POST', body: { name: f.name.value, slug: f.slug.value || undefined } });
        toast(`Bibliothèque créée : ${origin}${lib.slug}/`);
        await refreshMyLibraries();
        viewAdmin();
      } catch (err) { toast(err.message, 'error'); }
    };
    $$('[data-edit-lib]').forEach((btn) => {
      btn.onclick = () => editLibraryDialog(libs.find((l) => l.id === Number(btn.dataset.editLib)), origin);
    });
    $$('[data-del-lib]').forEach((btn) => {
      btn.onclick = async () => {
        const lib = libs.find((l) => l.id === Number(btn.dataset.delLib));
        const typed = prompt(`Supprimer « ${lib.name} » avec ses ${lib.books} livre(s), ${lib.copies} exemplaire(s), emprunteurs et prêts ?\nCette action est définitive.\n\nPour confirmer, tape exactement le nom de la bibliothèque :`);
        if (typed === null) return;
        try {
          await gapi(`/api/admin/libraries/${lib.id}?confirm=${encodeURIComponent(typed)}`, { method: 'DELETE' });
          toast('Bibliothèque supprimée.');
          await refreshMyLibraries();
          if (LIBRARY && LIBRARY.slug === lib.slug) location.href = `${ROOT}/?accueil=1`;
          else viewAdmin();
        } catch (err) { toast(err.message, 'error'); }
      };
    });
  }

  function editLibraryDialog(lib, origin) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <form class="modal">
        <h2>Modifier la bibliothèque</h2>
        <div class="field"><label>Nom</label><input name="name" required value="${esc(lib.name)}"></div>
        <div class="field"><label>Adresse</label><input name="slug" required value="${esc(lib.slug)}" pattern="[a-z0-9][a-z0-9-]*"></div>
        <div class="info-box small">Changer l'adresse : l'ancienne reste redirigée vers la nouvelle (étiquettes déjà imprimées, shortcode WordPress). Pense tout de même à mettre à jour le shortcode.</div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Enregistrer</button>
          <button class="btn" type="button" data-close>Annuler</button>
        </div>
      </form>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(); });
    $('form', backdrop).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await gapi(`/api/admin/libraries/${lib.id}`, { method: 'PUT', body: { name: e.target.name.value, slug: e.target.slug.value } });
        close();
        toast(`Enregistré : ${origin}${r.slug}/`);
        await refreshMyLibraries();
        if (LIBRARY && LIBRARY.slug === lib.slug && r.slug !== lib.slug) location.href = `${libUrl(r.slug)}#/admin`;
        else viewAdmin();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  async function adminUsers() {
    const [users, libs] = await Promise.all([gapi('/api/admin/users'), gapi('/api/admin/libraries')]);
    const libName = (id) => (libs.find((l) => l.id === id) || {}).name || '?';
    $('#admin-body').innerHTML = `
      <div class="btn-row" style="margin-bottom:12px"><button class="btn btn-primary" id="new-user">+ Nouveau compte</button></div>
      <div class="card">${users.length ? `<div class="list">${users.map((u) => `
        <div class="list-item">
          <div class="grow">
            <strong>${esc(u.username)}</strong> ${u.role === 'admin' ? '<span class="badge badge-ok">Administrateur</span>' : '<span class="badge badge-muted">Gestionnaire</span>'}
            ${u.id === state.user.id ? '<span class="small muted">(toi)</span>' : ''}
            <div class="small muted">${u.role === 'admin' ? 'Toutes les bibliothèques' : (u.libraryIds.map((id) => esc(libName(id)) + (id === u.defaultLibraryId ? ' ★' : '')).join(', ') || 'Aucune bibliothèque')}</div>
          </div>
          <button class="btn btn-small" data-edit-user="${u.id}">Modifier</button>
          ${u.id === state.user.id ? '' : `<button class="btn btn-small btn-danger" data-del-user="${u.id}">Supprimer</button>`}
        </div>`).join('')}</div>` : ''}</div>`;
    $('#new-user').onclick = () => userDialog(null, libs);
    $$('[data-edit-user]').forEach((btn) => { btn.onclick = () => userDialog(users.find((u) => u.id === Number(btn.dataset.editUser)), libs); });
    $$('[data-del-user]').forEach((btn) => {
      btn.onclick = async () => {
        const u = users.find((x) => x.id === Number(btn.dataset.delUser));
        if (!confirm(`Supprimer le compte ${u.username} ?`)) return;
        try { await gapi(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('Compte supprimé.'); viewAdmin(); } catch (err) { toast(err.message, 'error'); }
      };
    });
  }

  function userDialog(user, libs) {
    const u = user || { username: '', role: 'manager', libraryIds: LIBRARY ? libs.filter((l) => l.slug === LIBRARY.slug).map((l) => l.id) : [], defaultLibraryId: null };
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <form class="modal">
        <h2>${user ? `Compte ${esc(user.username)}` : 'Nouveau compte'}</h2>
        <div class="field"><label>Identifiant *</label><input name="username" required value="${esc(u.username)}" autocomplete="off"></div>
        <div class="field"><label>${user ? 'Nouveau mot de passe (laisser vide pour ne pas changer)' : 'Mot de passe * (8 caractères min.)'}</label>
          <input name="password" type="password" autocomplete="new-password" minlength="8" ${user ? '' : 'required'}></div>
        <div class="field"><label>Rôle</label><select name="role">
          <option value="manager" ${u.role !== 'admin' ? 'selected' : ''}>Gestionnaire : gère les bibliothèques cochées ci-dessous</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrateur : toutes les bibliothèques, comptes et réglages</option>
        </select></div>
        <div class="field"><label>Bibliothèques gérées (★ = par défaut)</label>
          <div class="sel-list">${libs.map((l) => `
            <div class="sel-row">
              <input type="checkbox" name="lib" value="${l.id}" ${u.libraryIds.includes(l.id) ? 'checked' : ''} id="lib-${l.id}">
              <label for="lib-${l.id}" class="grow" style="margin:0;font-weight:500;color:var(--text);font-size:14px">${esc(l.name)}</label>
              <label class="small" style="margin:0;display:flex;align-items:center;gap:4px" title="Bibliothèque par défaut"><input type="radio" name="def" value="${l.id}" ${u.defaultLibraryId === l.id ? 'checked' : ''} style="width:auto;min-height:0"> ★</label>
            </div>`).join('') || '<p class="muted small" style="padding:8px">Crée d\'abord une bibliothèque.</p>'}</div>
        </div>
        <div id="dlg-err"></div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">${user ? 'Enregistrer' : 'Créer le compte'}</button>
          <button class="btn" type="button" data-close>Annuler</button>
        </div>
      </form>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(); });
    // Choisir une bibliotheque par defaut la coche automatiquement.
    $$('input[name=def]', backdrop).forEach((r) => {
      r.onchange = () => { const cb = $(`#lib-${r.value}`, backdrop); if (cb) cb.checked = true; };
    });
    $('form', backdrop).onsubmit = async (e) => {
      e.preventDefault();
      const t = e.target;
      const libraryIds = $$('input[name=lib]:checked', backdrop).map((x) => Number(x.value));
      const def = $('input[name=def]:checked', backdrop);
      const body = { username: t.username.value, role: t.role.value, libraryIds, defaultLibraryId: def ? Number(def.value) : null };
      if (t.password.value) body.password = t.password.value;
      try {
        await gapi(user ? `/api/admin/users/${user.id}` : '/api/admin/users', { method: user ? 'PUT' : 'POST', body });
        close();
        toast(user ? 'Compte enregistré.' : 'Compte créé.');
        if (user && user.id === state.user.id) await refreshMyLibraries();
        viewAdmin();
      } catch (err) { $('#dlg-err', backdrop).innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
    };
  }

  // ================= Ajout / modification d'un livre =================
  async function viewBookForm(id) {
    const editing = !!id;
    const [book, cats, locations] = await Promise.all([
      editing ? api(`/api/books/${id}`) : null,
      loadCategories(),
      api('/api/locations'),
    ]);
    const b = book || { isbn: '', title: '', subtitle: '', authors: '', publisher: '', year: '', pages: '', summary: '', notes: '', categories: [], coverUrl: null };
    const form = { categories: b.categories.map((c) => c.name), cover: { url: b.coverUrl ? mediaSrc(b.coverUrl) : '', remoteUrl: '', data: '', removed: false } };

    view().innerHTML = `
      <p><a href="${editing ? `#/book/${b.id}` : '#/'}">← ${editing ? 'Retour à la fiche' : 'Catalogue'}</a></p>
      <h1>${editing ? 'Modifier le livre' : 'Ajouter un livre'}</h1>
      <div class="card" style="margin:14px 0">
        <label for="isbn-search">Rechercher par ISBN</label>
        <div class="isbn-row">
          <input id="isbn-search" inputmode="numeric" placeholder="978…" value="${esc(b.isbn)}" autocomplete="off">
          <button class="btn" id="isbn-go" type="button">Rechercher</button>
          <button class="btn btn-primary" id="isbn-scan" type="button">Scanner</button>
        </div>
        <div id="isbn-result" class="small" style="margin-top:8px">${editing ? '' : '<span class="muted">Scanne ou tape l\'ISBN pour pré-remplir la fiche, ou remplis-la directement ci-dessous.</span>'}</div>
      </div>
      <form id="book-form" class="card">
        <div class="cover-edit field">
          <div class="cover" id="cover-preview"></div>
          <div>
            <label>Illustration (couverture)</label>
            <div class="btn-row">
              <label class="btn btn-small" style="margin:0">Choisir / photographier<input type="file" id="cover-file" accept="image/*" hidden></label>
              <button class="btn btn-small btn-danger" type="button" id="cover-remove">Retirer</button>
            </div>
            <p class="small muted" style="margin-top:8px">La couverture trouvée par la recherche ISBN est enregistrée automatiquement.</p>
          </div>
        </div>
        <div class="field"><label for="title">Titre *</label><input id="title" name="title" required value="${esc(b.title)}"></div>
        <div class="field"><label for="subtitle">Sous-titre</label><input id="subtitle" name="subtitle" value="${esc(b.subtitle)}"></div>
        <div class="field"><label for="authors">Auteur(s)</label><input id="authors" name="authors" placeholder="Séparés par des virgules" value="${esc(b.authors)}"></div>
        <div class="grid-2">
          <div class="field"><label for="publisher">Éditeur</label><input id="publisher" name="publisher" value="${esc(b.publisher)}"></div>
          <div class="field"><label for="isbn">ISBN</label><input id="isbn" name="isbn" inputmode="numeric" value="${esc(b.isbn)}"></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="year">Année</label><input id="year" name="year" type="number" min="1400" max="2100" value="${esc(b.year || '')}"></div>
          <div class="field"><label for="pages">Pagination (nombre de pages)</label><input id="pages" name="pages" type="number" min="1" value="${esc(b.pages || '')}"></div>
        </div>
        <div class="field"><label for="summary">Résumé</label><textarea id="summary" name="summary">${esc(b.summary)}</textarea>
          <div id="summary-alt"></div></div>
        <div class="field">
          <label for="cat-input">Catégories</label>
          <div id="cat-chips"></div>
          <div class="isbn-row">
            <input id="cat-input" list="cat-list" placeholder="Ajouter une catégorie…" autocomplete="off">
            <button class="btn" type="button" id="cat-add">Ajouter</button>
          </div>
          <datalist id="cat-list">${cats.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
        </div>
        ${editing ? '' : `
        <div class="grid-2">
          <div class="field"><label for="copies">Nombre d'exemplaires</label><input id="copies" name="copies" type="number" min="1" max="50" value="1"></div>
          <div class="field"><label for="location">Emplacement</label><input id="location" name="location" list="loc-list" placeholder="Étagère, armoire…">
            <datalist id="loc-list">${locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></div>
        </div>`}
        <div class="field"><label for="notes">Notes internes (visibles uniquement par les gestionnaires)</label><textarea id="notes" name="notes" style="min-height:70px">${esc(b.notes)}</textarea></div>
        <div id="form-err"></div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">${editing ? 'Enregistrer' : 'Ajouter au catalogue'}</button></div>
      </form>`;

    const f = $('#book-form');

    function renderCover() {
      const src = form.cover.data || form.cover.remoteUrl || (form.cover.removed ? '' : form.cover.url);
      $('#cover-preview').innerHTML = src ? `<img src="${esc(src)}" alt="">` : '<span class="cover-fallback">Pas d\'image</span>';
      $('#cover-remove').hidden = !src;
    }
    function renderCats() {
      $('#cat-chips').innerHTML = form.categories.map((c, i) => `<span class="chip">${esc(c)}<button type="button" data-i="${i}" aria-label="Retirer">×</button></span>`).join('');
      $$('#cat-chips button').forEach((btn) => { btn.onclick = () => { form.categories.splice(Number(btn.dataset.i), 1); renderCats(); }; });
    }
    function addCat() {
      const v = $('#cat-input').value.trim();
      if (v && !form.categories.some((c) => c.toLowerCase() === v.toLowerCase())) form.categories.push(v);
      $('#cat-input').value = '';
      renderCats();
    }
    renderCover();
    renderCats();
    $('#cat-add').onclick = addCat;
    $('#cat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCat(); } });
    $('#cat-input').addEventListener('change', addCat);

    $('#cover-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        form.cover.data = await imageToDataUrl(file, 900, 'image/jpeg');
        form.cover.remoteUrl = '';
        renderCover();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#cover-remove').onclick = () => { form.cover = { url: '', remoteUrl: '', data: '', removed: true }; renderCover(); };

    async function lookup(raw) {
      const out = $('#isbn-result');
      out.innerHTML = '<span class="muted">Recherche…</span>';
      $('#summary-alt').innerHTML = '';
      try {
        const r = await api(`/api/isbn/${encodeURIComponent(raw)}`);
        $('#isbn-search').value = r.isbn;
        f.isbn.value = r.isbn;
        let html = '';
        const others = r.existing.filter((x) => !editing || x.id !== b.id);
        if (others.length) {
          html += `<div class="info-box">Déjà au catalogue : ${others.map((x) => `<a href="#/book/${x.id}">${esc(x.title)}</a>`).join(', ')}.
            Pour un exemplaire supplémentaire, ouvre la fiche et utilise « Ajouter un exemplaire ».</div>`;
        }
        if (r.found) {
          const d = r.found;
          const fill = (name, value) => { if (value && (!editing || !f[name].value)) f[name].value = value; };
          fill('title', d.title); fill('subtitle', d.subtitle); fill('authors', d.authors); fill('publisher', d.publisher);
          fill('year', d.year); fill('pages', d.pages); fill('summary', d.summary);
          if (d.coverUrl && !form.cover.data && (!editing || !form.cover.url || form.cover.removed)) {
            form.cover.remoteUrl = d.coverUrl;
            form.cover.removed = false;
            renderCover();
          }
          // Resume trouve seulement dans une autre langue que celle du livre : propose, pas impose.
          if (d.summaryAlt && !f.summary.value) {
            $('#summary-alt').innerHTML = `<p class="small muted" style="margin-top:6px">Aucun résumé dans la langue du livre. Un résumé en ${esc(d.summaryAlt.language)} est disponible (${esc(d.summaryAlt.source)}).
              <button type="button" class="btn btn-small" id="use-alt">Utiliser le résumé en ${esc(d.summaryAlt.language)}</button></p>`;
            $('#use-alt').onclick = () => { f.summary.value = d.summaryAlt.text; $('#summary-alt').innerHTML = ''; };
          }
          html += `<span style="color:var(--ok)">✓ Fiche pré-remplie (${esc(d.sources.join(', '))}). Vérifie et complète avant d'enregistrer.</span>`;
        } else {
          html += '<span class="muted">Aucune information trouvée pour cet ISBN : complète la fiche à la main.</span>';
        }
        out.innerHTML = html;
        if (!editing) f.title.focus();
      } catch (err) {
        out.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
      }
    }
    $('#isbn-go').onclick = () => lookup($('#isbn-search').value);
    $('#isbn-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(e.target.value); } });
    $('#isbn-scan').onclick = async () => {
      const isbn = await scanIsbn();
      if (isbn) { $('#isbn-search').value = isbn; lookup(isbn); }
    };

    f.onsubmit = async (e) => {
      e.preventDefault();
      addCat();
      const btn = $('button[type=submit]', f);
      btn.disabled = true;
      const body = {
        isbn: f.isbn.value, title: f.title.value, subtitle: f.subtitle.value, authors: f.authors.value,
        publisher: f.publisher.value, year: f.year.value, pages: f.pages.value, summary: f.summary.value,
        notes: f.notes.value, categories: form.categories,
        coverData: form.cover.data || undefined,
        coverUrl: !form.cover.data && form.cover.remoteUrl ? form.cover.remoteUrl : undefined,
        removeCover: form.cover.removed || undefined,
      };
      if (!editing) { body.copies = Number(f.copies.value) || 1; body.location = f.location.value; }
      try {
        const saved = await api(editing ? `/api/books/${b.id}` : '/api/books', { method: editing ? 'PUT' : 'POST', body });
        if (editing) toast('Fiche enregistrée.');
        else toast(`Livre ajouté : ${saved.copies.map((c) => c.code).join(', ')}. Étiquette(s) en attente d'impression.`);
        go(`#/book/${saved.id}`);
      } catch (err) {
        $('#form-err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    };
  }

  // ================= Import de listes de livres =================
  // Deux modes : une liste d'ISBN (fiches completees automatiquement), ou un
  // fichier (.xlsx / .csv) avec une colonne par champ. Le fichier est lu dans le
  // navigateur, previsualise, puis importe livre par livre (progression visible).
  const IMPORT_FIELDS = [
    { key: 'isbn', label: 'ISBN', aliases: ['isbn', 'isbn13', 'isbn10', 'ean', 'ean13', 'code barre', 'codebarres'] },
    { key: 'title', label: 'Titre', aliases: ['titre', 'title', 'intitule'] },
    { key: 'subtitle', label: 'Sous-titre', aliases: ['sous-titre', 'soustitre', 'subtitle'] },
    { key: 'authors', label: 'Auteurs', aliases: ['auteurs', 'auteur', 'author', 'authors', 'ecrivain'] },
    { key: 'publisher', label: 'Éditeur', aliases: ['editeur', 'editeurs', 'edition', 'editions', 'maison d edition', 'publisher'] },
    { key: 'year', label: 'Année', aliases: ['annee', 'an', 'date', 'year', 'parution', 'date de parution', 'annee de parution'] },
    { key: 'pages', label: 'Pages', aliases: ['pages', 'pagination', 'nombre de pages', 'nb pages', 'nbpages'] },
    { key: 'summary', label: 'Résumé', aliases: ['resume', 'summary', 'description', 'presentation'] },
    { key: 'categories', label: 'Catégories', aliases: ['categories', 'categorie', 'theme', 'themes', 'genre', 'genres', 'sujet', 'sujets'] },
    { key: 'location', label: 'Emplacement', aliases: ['emplacement', 'localisation', 'location', 'etagere', 'rayon', 'armoire'] },
    { key: 'copies', label: 'Exemplaires', aliases: ['exemplaires', 'exemplaire', 'nb exemplaires', 'quantite', 'qte', 'nombre', 'copies'] },
    { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'remarque', 'remarques', 'commentaire', 'commentaires'] },
    { key: 'coverUrl', label: 'Couverture (URL)', aliases: ['couverture', 'couverture url', 'image', 'illustration', 'cover', 'url image'] },
  ];
  const normHeader = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function guessField(header) {
    const n = normHeader(header);
    if (!n) return '';
    for (const f of IMPORT_FIELDS) if (f.aliases.some((a) => normHeader(a) === n)) return f.key;
    for (const f of IMPORT_FIELDS) if (f.aliases.some((a) => normHeader(a).length >= 4 && n.startsWith(normHeader(a)))) return f.key;
    return '';
  }

  function cellText(v) {
    if (v == null) return '';
    if (v instanceof Date) return String(v.getFullYear());
    return String(v).trim();
  }

  function validIsbn10(d) {
    if (!/^\d{9}[\dX]$/.test(d)) return false;
    return d.split('').reduce((acc, c, i) => acc + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11 === 0;
  }

  // ISBN d'une cellule : { isbn } si valide, { error } sinon ({} si vide).
  function isbnFromCell(v) {
    const s = cellText(v);
    if (!s) return {};
    if (/^\d[.,]\d+E\+?\d+$/i.test(s)) {
      return { error: `ISBN abîmé par Excel (${s}) : utilise le modèle .xlsx fourni ou formate la colonne ISBN en « Texte ».` };
    }
    let d = s.toUpperCase().replace(/[^0-9X]/g, '');
    if (/^\d{9}$/.test(d)) d = '0' + d; // ISBN-10 dont Excel a retire le 0 initial
    if (isbnFromScan(d) && (d.length === 13 || validIsbn10(d))) return { isbn: d };
    return { error: `ISBN invalide : ${s}`, raw: s };
  }

  function parseCsv(text) {
    const firstLine = text.split(/\r?\n/)[0] || '';
    const delim = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
      } else if (c === '"' && cell === '') quoted = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Fichier .xlsx ou .csv/.txt -> lignes (tableaux de cellules), lignes vides retirees.
  async function readTable(file) {
    let rows;
    if (/\.xlsx$/i.test(file.name)) {
      if (!window.readXlsxFile) await loadScript(ROOT + '/vendor/read-excel-file.min.js');
      const r = await window.readXlsxFile(file);
      rows = Array.isArray(r) && r[0] && !Array.isArray(r[0]) && r[0].data ? r[0].data : r;
    } else if (/\.(xls|ods|numbers)$/i.test(file.name)) {
      throw new Error('Format non pris en charge : enregistre le fichier en .xlsx (Excel) ou .csv.');
    } else {
      const buf = await file.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      // CSV enregistre par Excel sous Windows : souvent en Windows-1252, pas en UTF-8.
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
      rows = parseCsv(text.replace(/^﻿/, ''));
    }
    return rows.filter((r) => r && r.some((c) => cellText(c) !== ''));
  }

  const importState = { mode: 'isbn', text: '', fileName: '', rows: null, mapping: [], items: [], results: null, running: false, stop: false };

  async function viewImport() {
    const s = importState;
    const locations = await api('/api/locations').catch(() => []);
    const tpl = (type, ext) => `${LIB}/api/import/template.${ext}${type === 'isbn' ? '?type=isbn' : ''}`;
    view().innerHTML = `
      <div class="page-head"><div><h1>Importer des livres</h1>
        <p class="muted">Ajoute d'un coup une liste de livres à « ${esc(state.settings.libraryName)} ». Les exemplaires et leurs codes sont créés automatiquement ; leurs étiquettes passent « en attente ».</p></div></div>
      <div class="seg" style="max-width:520px">
        <button type="button" data-mode="isbn" class="${s.mode === 'isbn' ? 'active' : ''}">Liste d'ISBN</button>
        <button type="button" data-mode="full" class="${s.mode === 'full' ? 'active' : ''}">Fichier complet (tous les champs)</button>
      </div>
      <div id="import-body"></div>`;
    $$('.seg button').forEach((btn) => {
      btn.onclick = () => {
        if (s.running) return;
        Object.assign(s, { mode: btn.dataset.mode, rows: null, mapping: [], items: [], results: null, fileName: '' });
        viewImport();
      };
    });
    const body = $('#import-body');

    const options = `
      <div class="grid-2">
        ${s.mode === 'isbn' ? `
          <div class="field"><label>Exemplaires par ISBN</label><input type="number" id="opt-copies" min="1" max="50" value="1">
            <p class="small muted" style="margin-top:4px">Un ISBN présent plusieurs fois dans la liste compte pour plusieurs exemplaires.</p></div>
          <div class="field"><label>Emplacement</label><input id="opt-location" list="loc-list" placeholder="facultatif"></div>
          <div class="field"><label>Catégories</label><input id="opt-cats" placeholder="facultatif, séparées par des virgules"></div>` : `
          <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" id="opt-fill" checked> Compléter les champs vides grâce à l'ISBN</label>
            <p class="small muted" style="margin-top:4px">Les valeurs du fichier restent prioritaires.</p></div>
          <div class="field"><label>Emplacement par défaut</label><input id="opt-location" list="loc-list" placeholder="si la colonne est vide"></div>`}
        <div class="field"><label>Si l'ISBN est déjà au catalogue</label><select id="opt-dup">
          <option value="copy">Ajouter un exemplaire au livre existant</option>
          <option value="skip">Ignorer la ligne</option>
          <option value="new">Créer quand même une nouvelle fiche</option>
        </select></div>
      </div>
      <datalist id="loc-list">${locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>`;

    if (s.mode === 'isbn') {
      body.innerHTML = `
        <div class="card">
          <h3 style="margin-top:0">1. La liste</h3>
          <div class="field"><label for="isbn-list">Colle les ISBN (un par ligne, ou séparés par des espaces, virgules…)</label>
            <textarea id="isbn-list" placeholder="9782070612758&#10;978-2-07-036822-8&#10;…">${esc(s.text)}</textarea></div>
          <div class="btn-row">
            <label class="btn btn-small" style="margin:0">Ou choisir un fichier (.xlsx, .csv, .txt)<input type="file" id="import-file" accept=".xlsx,.csv,.txt" hidden></label>
            <span class="small muted" id="file-name">${esc(s.fileName)}</span>
            <span style="margin-left:auto" class="small">Modèle : <a href="${tpl('isbn', 'xlsx')}">Excel (.xlsx)</a> · <a href="${tpl('isbn', 'csv')}">CSV</a></span>
          </div>
          <h3>2. Options</h3>
          ${options}
          <button class="btn btn-primary" id="analyse">Analyser la liste</button>
        </div>
        <div id="preview"></div>`;
      $('#isbn-list').addEventListener('input', (e) => { s.text = e.target.value; });
      $('#import-file').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const rows = await readTable(file);
          s.text = rows.flat().map(cellText).filter((c) => c && !/^isbn/i.test(c)).join('\n');
          s.fileName = file.name;
          $('#isbn-list').value = s.text;
          $('#file-name').textContent = file.name;
        } catch (err) { toast(err.message, 'error'); }
      };
      $('#analyse').onclick = () => {
        const perIsbn = Math.max(1, Math.min(50, parseInt($('#opt-copies').value, 10) || 1));
        const location = $('#opt-location').value.trim();
        const categories = $('#opt-cats').value;
        const counts = new Map();
        const errors = [];
        // Virgules : separateurs, sauf dans un ISBN en notation scientifique (9,78207E+12).
        s.text.split(/[\s;]+/).filter(Boolean)
          .flatMap((t) => (/^\d[.,]\d+E\+?\d+$/i.test(t) ? [t] : t.split(',')))
          .filter(Boolean).forEach((token) => {
          const r = isbnFromCell(token);
          if (r.isbn) counts.set(r.isbn, (counts.get(r.isbn) || 0) + perIsbn);
          else if (r.error) errors.push(r.error);
        });
        s.items = Array.from(counts).map(([isbn, copies]) => ({ data: { isbn, copies, location, categories }, label: isbn }));
        s.items.push(...errors.map((e) => ({ error: e, label: '' })));
        s.options = { onDuplicate: $('#opt-dup').value, fillFromIsbn: true };
        s.results = null;
        renderPreview();
      };
    } else {
      body.innerHTML = `
        <div class="card">
          <h3 style="margin-top:0">1. Le fichier</h3>
          <p class="small">Une ligne par livre, une colonne par champ. Télécharge le modèle : <a href="${tpl('full', 'xlsx')}">Excel (.xlsx)</a> · <a href="${tpl('full', 'csv')}">CSV</a>.
            Seul l'ISBN <em>ou</em> le titre est obligatoire ; les autres colonnes sont facultatives et peuvent être dans n'importe quel ordre.</p>
          <div class="btn-row">
            <label class="btn" style="margin:0">Choisir le fichier (.xlsx ou .csv)<input type="file" id="import-file" accept=".xlsx,.csv" hidden></label>
            <span class="small muted">${esc(s.fileName)}</span>
          </div>
          <div id="mapping"></div>
          <h3>2. Options</h3>
          ${options}
          <button class="btn btn-primary" id="analyse" ${s.rows ? '' : 'disabled'}>Analyser le fichier</button>
        </div>
        <div id="preview"></div>`;
      const renderMapping = () => {
        if (!s.rows) return;
        const header = s.rows[0];
        $('#mapping').innerHTML = `
          <h3>Colonnes du fichier</h3>
          <p class="small muted">${s.rows.length - 1} ligne(s). Vérifie à quel champ correspond chaque colonne.</p>
          <div class="table-wrap"><table><thead><tr><th>Colonne</th><th>Exemple</th><th>Champ</th></tr></thead><tbody>
          ${header.map((hd, i) => `<tr><td><strong>${esc(cellText(hd)) || `(colonne ${i + 1})`}</strong></td>
            <td class="small muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cellText((s.rows.slice(1).find((r) => cellText(r[i])) || [])[i]))}</td>
            <td><select data-col="${i}"><option value="">— ignorer —</option>
              ${IMPORT_FIELDS.map((f) => `<option value="${f.key}" ${s.mapping[i] === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}</select></td></tr>`).join('')}
          </tbody></table></div>`;
        $$('[data-col]').forEach((sel) => { sel.onchange = () => { s.mapping[Number(sel.dataset.col)] = sel.value; }; });
      };
      renderMapping();
      $('#import-file').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const rows = await readTable(file);
          if (rows.length < 2) throw new Error('Le fichier doit contenir une ligne de titres de colonnes puis au moins un livre.');
          s.rows = rows;
          s.fileName = file.name;
          s.mapping = rows[0].map(guessField);
          s.items = [];
          s.results = null;
          viewImport();
        } catch (err) { toast(err.message, 'error'); }
      };
      $('#analyse').onclick = () => {
        const fill = $('#opt-fill').checked;
        const defLocation = $('#opt-location').value.trim();
        const col = (key) => s.mapping.lastIndexOf(key);
        s.items = s.rows.slice(1).map((r, n) => {
          const get = (key) => (col(key) >= 0 ? cellText(r[col(key)]) : '');
          const d = {};
          IMPORT_FIELDS.forEach((f) => { if (f.key !== 'isbn') d[f.key] = get(f.key); });
          d.location = d.location || defLocation;
          d.copies = parseInt(d.copies, 10) || 1;
          const line = `Ligne ${n + 2}`;
          const isbnCell = col('isbn') >= 0 ? r[col('isbn')] : '';
          const ir = isbnFromCell(isbnCell);
          if (ir.error && !d.title) return { error: `${line} : ${ir.error}`, label: line };
          d.isbn = ir.isbn || ir.raw || '';
          if (!d.isbn && !d.title) return { error: `${line} : ni ISBN ni titre.`, label: line };
          if (!d.title && !fill) return { error: `${line} : titre manquant (active « Compléter grâce à l'ISBN »).`, label: line };
          return { data: d, label: d.title || d.isbn, warning: ir.error ? `ISBN non valide, importé tel quel` : '' };
        });
        s.options = { onDuplicate: $('#opt-dup').value, fillFromIsbn: fill };
        s.results = null;
        renderPreview();
      };
    }
    if (s.items.length) renderPreview();
  }

  function renderPreview() {
    const s = importState;
    const ok = s.items.filter((i) => i.data);
    const bad = s.items.filter((i) => i.error);
    const copies = ok.reduce((n, i) => n + (i.data.copies || 1), 0);
    const statusHtml = (r) => {
      if (!r) return '<span class="small muted">en attente</span>';
      if (r.status === 'created') return `<span class="badge badge-ok">Ajouté</span> <a href="#/book/${r.bookId}">${esc(r.title)}</a> <span class="small muted code">${esc(r.codes.join(', '))}</span>`;
      if (r.status === 'copies') return `<span class="badge badge-ok">+ ${r.codes.length} ex.</span> <a href="#/book/${r.bookId}">${esc(r.title)}</a> <span class="small muted code">${esc(r.codes.join(', '))}</span>`;
      if (r.status === 'skipped') return `<span class="badge badge-muted">Ignoré</span> déjà au catalogue : <a href="#/book/${r.bookId}">${esc(r.title)}</a>`;
      return `<span class="badge badge-warn">Erreur</span> <span class="small">${esc(r.error)}</span>`;
    };
    const done = s.results ? s.results.filter(Boolean).length : 0;
    const summary = s.results && !s.running ? (() => {
      const c = (st) => s.results.filter((r) => r && r.status === st).length;
      return `<div class="info-box"><strong>Import terminé${s.stop ? ' (arrêté)' : ''}.</strong> ${c('created')} livre(s) ajouté(s), ${c('copies')} exemplaire(s) ajouté(s) à des livres existants, ${c('skipped')} ignoré(s), ${c('error')} erreur(s).</div>
        <div class="btn-row" style="margin-bottom:12px"><button class="btn btn-primary" id="go-labels">Imprimer les étiquettes en attente</button><a class="btn" href="#/">Voir le catalogue</a></div>`;
    })() : '';
    $('#preview').innerHTML = `
      <h2>3. ${s.results ? 'Import' : 'Vérification'}</h2>
      <div class="card">
        ${summary}
        <p><strong>${ok.length} livre(s)</strong> à importer (${copies} exemplaire(s))${bad.length ? `, <span style="color:var(--danger)">${bad.length} ligne(s) en erreur ignorée(s)</span>` : ''}.
          ${s.mode === 'isbn' || s.options.fillFromIsbn ? '<span class="small muted">La recherche des informations prend 1 à 2 secondes par ISBN.</span>' : ''}</p>
        ${bad.length ? `<details ${ok.length ? '' : 'open'}><summary class="small" style="cursor:pointer">Voir les erreurs</summary><ul class="small">${bad.map((b) => `<li>${esc(b.error)}</li>`).join('')}</ul></details>` : ''}
        ${s.running || s.results ? `<div style="background:var(--surface-2);border-radius:999px;height:10px;overflow:hidden;margin:12px 0"><div style="height:100%;width:${ok.length ? Math.round((done / ok.length) * 100) : 0}%;background:var(--accent);transition:width .2s"></div></div>
          <p class="small muted">${done} / ${ok.length}</p>` : ''}
        <div class="btn-row" style="margin:12px 0">
          ${s.running ? '<button class="btn btn-danger" id="stop">Arrêter</button>'
            : (!s.results && ok.length ? `<button class="btn btn-primary" id="run">Importer ${ok.length} livre(s)</button>` : '')}
        </div>
        ${ok.length ? `<div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>#</th><th>ISBN</th><th>Titre</th><th>Ex.</th><th>Résultat</th></tr></thead><tbody>
          ${ok.map((it, i) => `<tr><td class="small muted">${i + 1}</td><td class="code small">${esc(it.data.isbn || '—')}</td>
            <td>${it.data.title ? esc(it.data.title) : '<span class="muted small">(complété via l\'ISBN)</span>'}${it.warning ? `<div class="small" style="color:var(--warn)">${esc(it.warning)}</div>` : ''}</td>
            <td>${it.data.copies || 1}</td><td>${statusHtml(s.results && s.results[i])}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      </div>`;
    const run = $('#run');
    if (run) run.onclick = runImport;
    const stop = $('#stop');
    if (stop) stop.onclick = () => { s.stop = true; stop.disabled = true; stop.textContent = 'Arrêt après le livre en cours…'; };
    const gl = $('#go-labels');
    if (gl) gl.onclick = () => { state.labels = { mode: 'pending', manual: [] }; go('#/labels'); };
  }

  function warnBeforeLeaving(e) { e.preventDefault(); e.returnValue = ''; }

  async function runImport() {
    const s = importState;
    const ok = s.items.filter((i) => i.data);
    s.results = new Array(ok.length).fill(null);
    s.running = true;
    s.stop = false;
    window.addEventListener('beforeunload', warnBeforeLeaving);
    renderPreview();
    for (let i = 0; i < ok.length && !s.stop; i++) {
      try {
        s.results[i] = await api('/api/import/book', { method: 'POST', body: { ...ok[i].data, ...s.options } });
      } catch (err) {
        s.results[i] = { status: 'error', error: err.message };
      }
      if ($('#preview')) renderPreview();
    }
    s.running = false;
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    if ($('#preview')) renderPreview();
    toast('Import terminé.');
  }

  // ================= Prets =================
  async function viewLoans() {
    let tab = 'open';
    view().innerHTML = `
      <div class="page-head"><h1>Prêts</h1></div>
      <div class="card" style="margin-bottom:18px">
        <p>Pour prêter ou enregistrer un retour, scanne le QR code de l'étiquette ou tape le code de l'exemplaire.</p>
        <form class="isbn-row" id="code-form">
          <input name="code" placeholder="Code (ex. BIB-00042)" autocomplete="off" style="text-transform:uppercase">
          <button class="btn" type="submit">Ouvrir</button>
          <button class="btn btn-primary" type="button" id="scan">Scanner</button>
        </form>
      </div>
      <div class="tabs"><button data-tab="open" class="active">En cours</button><button data-tab="returned">Historique</button></div>
      <div class="card" id="loan-list"></div>`;
    $('#scan').onclick = async () => { const c = await scanCopy(); if (c) go(`#/c/${encodeURIComponent(c)}`); };
    $('#code-form').onsubmit = (e) => {
      e.preventDefault();
      const code = copyCodeFromScan(e.target.code.value.trim());
      if (code) go(`#/c/${encodeURIComponent(code)}`);
      else toast('Code non reconnu.', 'error');
    };
    async function load() {
      const loans = await api(`/api/loans?status=${tab}`);
      $('#loan-list').innerHTML = loans.length ? `<div class="list">${loans.map((l) => loanItemHtml(l)).join('')}</div>`
        : `<div class="empty">${tab === 'open' ? 'Aucun prêt en cours.' : 'Aucun prêt terminé.'}</div>`;
    }
    $$('.tabs button').forEach((btn) => {
      btn.onclick = () => {
        tab = btn.dataset.tab;
        $$('.tabs button').forEach((x) => x.classList.toggle('active', x === btn));
        load();
      };
    });
    await load();
  }

  function loanItemHtml(l, hideBorrower) {
    return `<div class="list-item">
      ${l.book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(l.book.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
      <div class="grow">
        <a href="#/book/${l.book.id}"><strong>${esc(l.book.title)}</strong></a>
        <div class="small muted"><span class="code">${esc(l.copy.code)}</span>${hideBorrower ? '' : ` · <a href="#/borrower/${l.borrower.id}">${esc(l.borrower.name)}</a>`}</div>
        <div class="small muted">Prêté le ${fmtDate(l.loanedAt)}${l.returnedAt ? ` · rendu le ${fmtDate(l.returnedAt)}` : ''}${l.notes ? ' · ' + esc(l.notes) : ''}</div>
      </div>
      ${l.returnedAt ? '' : `<a class="btn btn-small btn-ok" href="#/c/${encodeURIComponent(l.copy.code)}">Retour</a>`}
    </div>`;
  }

  // ================= Emprunteurs =================
  async function viewBorrowers() {
    view().innerHTML = `
      <div class="page-head"><h1>Emprunteurs</h1></div>
      <div class="card" style="margin-bottom:18px">
        <form id="new-borrower" class="grid-3">
          <div class="field"><label>Nom *</label><input name="name" required></div>
          <div class="field"><label>E-mail</label><input name="email" type="email"></div>
          <div class="field"><label>Téléphone</label><input name="phone" type="tel"></div>
          <div><button class="btn btn-primary" type="submit">Ajouter</button></div>
        </form>
      </div>
      <input type="search" id="bq" placeholder="Rechercher…" style="margin-bottom:12px">
      <div class="card" id="borrower-list"></div>`;
    async function load() {
      const list = await api(`/api/borrowers?q=${encodeURIComponent($('#bq').value)}`);
      $('#borrower-list').innerHTML = list.length ? `<div class="list">${list.map((b) => `
        <a class="list-item" href="#/borrower/${b.id}" style="text-decoration:none;color:inherit">
          <div class="grow"><strong>${esc(b.name)}</strong><div class="small muted">${esc([b.email, b.phone].filter(Boolean).join(' · '))}</div></div>
          ${b.openLoans ? `<span class="badge badge-warn">${b.openLoans} en cours</span>` : ''}
          <span class="small muted">${b.totalLoans} prêt${b.totalLoans > 1 ? 's' : ''}</span>
        </a>`).join('')}</div>` : '<div class="empty">Aucun emprunteur.</div>';
    }
    $('#bq').addEventListener('input', debounce(load, 200));
    $('#new-borrower').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/borrowers', { method: 'POST', body: { name: e.target.name.value, email: e.target.email.value, phone: e.target.phone.value } });
        e.target.reset();
        toast('Emprunteur ajouté.');
        load();
      } catch (err) { toast(err.message, 'error'); }
    };
    await load();
  }

  async function viewBorrower(id) {
    const b = await api(`/api/borrowers/${id}`);
    const open = b.loans.filter((l) => !l.returnedAt);
    const past = b.loans.filter((l) => l.returnedAt);
    view().innerHTML = `
      <p><a href="#/borrowers">← Emprunteurs</a></p>
      <h1>${esc(b.name)}</h1>
      <form class="card" id="borrower-form" style="margin-top:14px">
        <div class="grid-3">
          <div class="field"><label>Nom *</label><input name="name" required value="${esc(b.name)}"></div>
          <div class="field"><label>E-mail</label><input name="email" type="email" value="${esc(b.email)}"></div>
          <div class="field"><label>Téléphone</label><input name="phone" type="tel" value="${esc(b.phone)}"></div>
        </div>
        <div class="field"><label>Notes</label><textarea name="notes" style="min-height:60px">${esc(b.notes)}</textarea></div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Enregistrer</button>
          ${b.loans.length ? '' : '<button class="btn btn-danger" type="button" id="del">Supprimer</button>'}
        </div>
      </form>
      <h2>En cours (${open.length})</h2>
      <div class="card">${open.length ? `<div class="list">${open.map((l) => loanItemHtml(l, true)).join('')}</div>` : '<p class="muted">Aucun livre emprunté.</p>'}</div>
      <h2>Historique (${past.length})</h2>
      <div class="card">${past.length ? `<div class="list">${past.map((l) => loanItemHtml(l, true)).join('')}</div>` : '<p class="muted">Aucun prêt terminé.</p>'}</div>`;
    $('#borrower-form').onsubmit = async (e) => {
      e.preventDefault();
      const t = e.target;
      try {
        await api(`/api/borrowers/${id}`, { method: 'PUT', body: { name: t.name.value, email: t.email.value, phone: t.phone.value, notes: t.notes.value } });
        toast('Enregistré.');
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
    const del = $('#del');
    if (del) del.onclick = async () => {
      if (!confirm(`Supprimer ${b.name} ?`)) return;
      try { await api(`/api/borrowers/${id}`, { method: 'DELETE' }); go('#/borrowers'); } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ================= Etiquettes =================
  // Formats de planches A4 courants (dimensions en mm). Les marges peuvent etre
  // ajustees a la main si l'imprimante decale legerement l'impression.
  const LABEL_PRESETS = {
    L7160: { name: 'Avery L7160 · 3×7 · 63,5×38,1 mm', cols: 3, rows: 7, width: 63.5, height: 38.1, top: 15.15, left: 7.2, hPitch: 66.04, vPitch: 38.1 },
    L7159: { name: 'Avery L7159 · 3×8 · 63,5×33,9 mm', cols: 3, rows: 8, width: 63.5, height: 33.9, top: 13.1, left: 7.2, hPitch: 66.04, vPitch: 33.9 },
    L7163: { name: 'Avery L7163 · 2×7 · 99,1×38,1 mm', cols: 2, rows: 7, width: 99.1, height: 38.1, top: 15.15, left: 4.65, hPitch: 101.6, vPitch: 38.1 },
    L7651: { name: 'Avery L7651 · 5×13 · 38,1×21,2 mm', cols: 5, rows: 13, width: 38.1, height: 21.2, top: 10.7, left: 4.7, hPitch: 40.6, vPitch: 21.2 },
    A70x37: { name: 'Planche 3×8 · 70×37 mm (bord à bord)', cols: 3, rows: 8, width: 70, height: 37, top: 0.5, left: 0, hPitch: 70, vPitch: 37 },
    A70x36: { name: 'Planche 3×8 · 70×36 mm', cols: 3, rows: 8, width: 70, height: 36, top: 4.5, left: 0, hPitch: 70, vPitch: 36 },
    A70x42: { name: 'Planche 3×7 · 70×42,3 mm (bord à bord)', cols: 3, rows: 7, width: 70, height: 42.3, top: 0.4, left: 0, hPitch: 70, vPitch: 42.3 },
    A105x37: { name: 'Planche 2×8 · 105×37 mm', cols: 2, rows: 8, width: 105, height: 37, top: 0.5, left: 0, hPitch: 105, vPitch: 37 },
  };
  const LAYOUT_FIELDS = [['cols', 'Colonnes'], ['rows', 'Lignes'], ['width', 'Largeur (mm)'], ['height', 'Hauteur (mm)'],
    ['left', 'Marge gauche (mm)'], ['top', 'Marge haut (mm)'], ['hPitch', 'Pas horizontal (mm)'], ['vPitch', 'Pas vertical (mm)']];

  // Selection des etiquettes : par defaut toutes celles en attente (nouveaux
  // exemplaires, codes regeneres) ; sinon une selection manuelle construite par
  // recherche (titre, auteur, code) ou par scan, sans longue liste a cocher.
  async function viewLabels() {
    const [settings, pending] = await Promise.all([api('/api/settings'), api('/api/labels/pending')]);
    const layout = Object.assign({ preset: 'L7160', showLogo: true, showName: true, showTitle: true, showAuthor: true, guides: true }, LABEL_PRESETS.L7160, settings.labelLayout || {});
    const sel = state.labels;
    let start = 1;
    let data = null;

    view().innerHTML = `
      <div class="page-head"><div><h1>Étiquettes</h1><p class="muted">Planches A4 autocollantes, avec QR code à scanner pour les prêts et retours.</p></div></div>
      <div class="label-layout">
        <div>
          <div class="card">
            <h3 style="margin-top:0">Quoi imprimer ?</h3>
            <div class="seg">
              <button type="button" data-mode="pending">En attente (${pending.length})</button>
              <button type="button" data-mode="manual">Sélection (<span id="manual-count">0</span>)</button>
            </div>
            <div id="mode-body"></div>
            <p class="summary-line" id="summary"></p>
          </div>
          <div class="card">
            <h3 style="margin-top:0">Format de planche</h3>
            <div class="field"><select id="preset">
              ${Object.entries(LABEL_PRESETS).map(([k, p]) => `<option value="${k}" ${layout.preset === k ? 'selected' : ''}>${p.name}</option>`).join('')}
              <option value="custom" ${layout.preset === 'custom' ? 'selected' : ''}>Personnalisé</option>
            </select></div>
            <details id="dims"><summary class="small" style="cursor:pointer;margin-bottom:10px">Dimensions et marges</summary>
              <div class="grid-2">${LAYOUT_FIELDS.map(([k, label]) => `<div class="field"><label>${label}</label><input type="number" step="0.01" data-dim="${k}" value="${layout[k]}"></div>`).join('')}</div>
            </details>
            <div class="field"><label>Commencer à la case n°</label><input type="number" id="start" min="1" value="1">
              <p class="small muted" style="margin-top:4px">Pour réutiliser une planche déjà entamée.</p></div>
            <label class="check"><input type="checkbox" id="opt-logo" ${layout.showLogo ? 'checked' : ''}> Logo</label>
            <label class="check"><input type="checkbox" id="opt-name" ${layout.showName ? 'checked' : ''}> Nom de la bibliothèque</label>
            <label class="check"><input type="checkbox" id="opt-title" ${layout.showTitle ? 'checked' : ''}> Titre du livre</label>
            <label class="check"><input type="checkbox" id="opt-author" ${layout.showAuthor ? 'checked' : ''}> Auteur(s)</label>
            <label class="check"><input type="checkbox" id="opt-guides" ${layout.guides ? 'checked' : ''}> Contours dans l'aperçu</label>
            <div class="btn-row" style="margin-top:14px">
              <button class="btn btn-primary" id="print">Imprimer</button>
            </div>
            <p class="small muted" style="margin-top:10px">Dans la fenêtre d'impression : format A4, marges « Aucune », échelle 100 % (« Taille réelle »).</p>
          </div>
        </div>
        <div class="sheets" id="sheets"></div>
      </div>`;

    function selectedCodes() {
      return sel.mode === 'pending' ? pending.map((p) => p.code) : sel.manual.map((m) => m.code);
    }

    function addManual(items) {
      let added = 0;
      for (const it of items) {
        if (!sel.manual.some((m) => m.code === it.code)) { sel.manual.push({ code: it.code, title: it.title }); added++; }
      }
      return added;
    }

    // Liste compacte des etiquettes en attente, regroupees par livre.
    function groupedHtml(list) {
      const groups = new Map();
      list.forEach((p) => { if (!groups.has(p.title)) groups.set(p.title, []); groups.get(p.title).push(p.code); });
      return Array.from(groups).map(([title, codes]) => `<div class="sel-row"><span class="grow">${esc(title)}</span><span class="small muted code">${codes.map(esc).join(', ')}</span></div>`).join('');
    }

    function renderMode() {
      $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === sel.mode));
      $('#manual-count').textContent = sel.manual.length;
      const body = $('#mode-body');
      if (sel.mode === 'pending') {
        body.innerHTML = pending.length ? `
          <p class="small muted">Nouveaux exemplaires et codes régénérés, pas encore imprimés.</p>
          <details><summary class="small" style="cursor:pointer;margin-bottom:8px">Voir le détail</summary>
            <div class="sel-list">${groupedHtml(pending)}</div></details>
          <div class="btn-row" style="margin-top:10px"><button class="btn btn-small" type="button" id="customize">Personnaliser cette sélection</button></div>`
          : '<p class="muted small">Aucune étiquette en attente. Utilise « Sélection » pour réimprimer des étiquettes.</p>';
        const cz = $('#customize');
        if (cz) cz.onclick = () => { sel.manual = []; addManual(pending); sel.mode = 'manual'; renderMode(); refresh(); };
        return;
      }
      body.innerHTML = `
        <div class="isbn-row">
          <input type="search" id="lbl-q" placeholder="Titre, auteur ou code…" autocomplete="off">
          <button class="btn" type="button" id="lbl-scan" title="Scanner une étiquette">Scanner</button>
        </div>
        <div id="lbl-results"></div>
        <div class="btn-row small" style="margin:10px 0 8px">
          ${pending.length ? `<button class="btn btn-small" type="button" id="add-pending">+ Les ${pending.length} en attente</button>` : ''}
          ${sel.manual.length ? '<button class="btn btn-small btn-danger" type="button" id="clear">Vider</button>' : ''}
        </div>
        ${sel.manual.length ? `<div class="sel-list">${sel.manual.map((m, i) => `
          <div class="sel-row"><span class="code">${esc(m.code)}</span><span class="grow muted">${esc(m.title || '')}</span>
            <button type="button" data-rm="${i}" aria-label="Retirer">×</button></div>`).join('')}</div>`
          : '<p class="muted small">Recherche un livre (titre, auteur) ou un code pour l\'ajouter, ou scanne une étiquette existante.</p>'}`;
      const q = $('#lbl-q');
      q.addEventListener('input', debounce(async () => {
        const out = $('#lbl-results');
        if (!q.value.trim()) { out.innerHTML = ''; return; }
        const results = await api(`/api/labels/search?q=${encodeURIComponent(q.value)}`).catch(() => []);
        out.innerHTML = results.length ? `<div class="search-results">${results.map((b, i) => `
          <div class="sel-row"><span class="grow"><strong>${esc(b.title)}</strong> <span class="muted">${esc(b.authors)}</span></span>
            <button type="button" class="add" data-add-book="${i}">+ ${b.copies.length > 1 ? `${b.copies.length} ex.` : esc(b.copies[0].code)}</button></div>
          ${b.copies.length > 1 ? b.copies.map((c, j) => `<div class="sel-row" style="padding-left:22px"><span class="grow code small">${esc(c.code)}${c.location ? ` <span class="muted">· ${esc(c.location)}</span>` : ''}</span>
            <button type="button" class="add" data-add-copy="${i}:${j}">+</button></div>`).join('') : ''}`).join('')}</div>`
          : '<p class="small muted" style="margin-top:6px">Aucun résultat.</p>';
        $$('[data-add-book]', out).forEach((btn) => {
          btn.onclick = () => { const b = results[Number(btn.dataset.addBook)]; addManual(b.copies.map((c) => ({ code: c.code, title: b.title }))); renderMode(); refresh(); };
        });
        $$('[data-add-copy]', out).forEach((btn) => {
          btn.onclick = () => { const [i, j] = btn.dataset.addCopy.split(':').map(Number); addManual([{ code: results[i].copies[j].code, title: results[i].title }]); renderMode(); refresh(); };
        });
      }, 250));
      $('#lbl-scan').onclick = async () => {
        const code = await scanCopy();
        if (!code) return;
        try {
          const r = await api(`/api/copies/by-code/${encodeURIComponent(code)}`);
          addManual([{ code: r.copy.code, title: r.book.title }]);
          renderMode();
          refresh();
        } catch (err) { toast(err.message, 'error'); }
      };
      const ap = $('#add-pending');
      if (ap) ap.onclick = () => { addManual(pending); renderMode(); refresh(); };
      const cl = $('#clear');
      if (cl) cl.onclick = () => { sel.manual = []; renderMode(); refresh(); };
      $$('[data-rm]').forEach((btn) => { btn.onclick = () => { sel.manual.splice(Number(btn.dataset.rm), 1); renderMode(); refresh(); }; });
    }

    function readLayout() {
      LAYOUT_FIELDS.forEach(([k]) => { layout[k] = parseFloat($(`[data-dim="${k}"]`).value) || 0; });
      layout.cols = Math.max(1, Math.round(layout.cols));
      layout.rows = Math.max(1, Math.round(layout.rows));
      layout.showLogo = $('#opt-logo').checked;
      layout.showName = $('#opt-name').checked;
      layout.showTitle = $('#opt-title').checked;
      layout.showAuthor = $('#opt-author').checked;
      layout.guides = $('#opt-guides').checked;
      start = Math.max(1, parseInt($('#start').value, 10) || 1);
    }

    const saveLayout = debounce(() => api('/api/settings', { method: 'PUT', body: { labelLayout: layout } }).catch(() => {}), 800);

    function renderSheets() {
      readLayout();
      const target = $('#sheets');
      const items = data ? data.items : [];
      const perSheet = layout.cols * layout.rows;
      const offset = Math.min(start - 1, perSheet - 1);
      const sheets = items.length ? Math.ceil((items.length + offset) / perSheet) : 0;
      $('#summary').textContent = items.length ? `${items.length} étiquette${items.length > 1 ? 's' : ''} · ${sheets} planche${sheets > 1 ? 's' : ''}` : '';
      if (!items.length) { target.innerHTML = '<div class="empty">Rien à imprimer pour le moment.</div>'; return; }
      const slots = Array(offset).fill(null).concat(items);
      const small = layout.height < 26 || layout.width < 45;
      const qrSize = Math.min(layout.height - 4, layout.width * 0.45);
      // Echelle du texte et du logo : suit la place laissee a cote du QR code
      // (reference : etiquette 63,5×38 mm), bornee pour rester lisible.
      const k = Math.max(0.6, Math.min(2.5, Math.min(layout.height / 38, (layout.width - qrSize) / 35)));
      const showName = layout.showName && data.libraryName;
      const showLogo = layout.showLogo && data.logoUrl;
      let html = '';
      for (let s = 0; s < slots.length; s += perSheet) {
        html += `<div class="sheet ${layout.guides ? 'show-guides' : ''}">`;
        slots.slice(s, s + perSheet).forEach((item, i) => {
          const col = i % layout.cols;
          const row = Math.floor(i / layout.cols);
          const pos = `left:${layout.left + col * layout.hPitch}mm;top:${layout.top + row * layout.vPitch}mm;width:${layout.width}mm;height:${layout.height}mm`;
          if (!item) { html += `<div class="lbl blank" style="${pos}"></div>`; return; }
          html += `<div class="lbl ${small ? 'small' : ''}" style="${pos};--k:${k.toFixed(3)}">
            <div class="qr" style="width:${qrSize}mm;height:${qrSize}mm">${item.svg}</div>
            <div class="info">
              ${showName || showLogo ? `<div class="lib">${showLogo ? `<img src="${esc(mediaSrc(data.logoUrl))}" alt="">` : ''}${showName ? `<span>${esc(data.libraryName)}</span>` : ''}</div>` : ''}
              ${layout.showTitle ? `<div class="ttl">${esc(item.title)}</div>` : ''}
              ${layout.showAuthor && item.authors ? `<div class="aut">${esc(item.authors)}</div>` : ''}
              <div class="cd">${esc(item.code)}</div>
            </div>
          </div>`;
        });
        html += '</div>';
      }
      target.innerHTML = html;
    }

    let fetchToken = 0;
    async function refresh() {
      const codes = selectedCodes();
      const token = ++fetchToken;
      const result = codes.length
        ? await api('/api/labels', { method: 'POST', body: { codes, baseUrl: location.origin + LIB + '/' } })
        : { items: [] };
      if (token === fetchToken) { data = result; renderSheets(); }
    }

    $$('.seg button').forEach((btn) => {
      btn.onclick = () => { sel.mode = btn.dataset.mode; renderMode(); refresh(); };
    });
    $('#preset').onchange = (e) => {
      layout.preset = e.target.value;
      const p = LABEL_PRESETS[e.target.value];
      if (p) LAYOUT_FIELDS.forEach(([k]) => { $(`[data-dim="${k}"]`).value = p[k]; });
      else $('#dims').open = true;
      renderSheets();
      saveLayout();
    };
    $$('[data-dim]').forEach((input) => input.addEventListener('input', () => { layout.preset = 'custom'; $('#preset').value = 'custom'; renderSheets(); saveLayout(); }));
    ['#opt-logo', '#opt-name', '#opt-title', '#opt-author', '#opt-guides'].forEach((s) => { $(s).onchange = () => { renderSheets(); saveLayout(); }; });
    $('#start').oninput = renderSheets;
    $('#print').onclick = async () => {
      if (!data || !data.items.length) return toast('Aucune étiquette sélectionnée.', 'error');
      // Les planches sont copiees dans un conteneur enfant direct de <body> : la
      // feuille de style d'impression masque tout le reste de la page.
      let root = $('#print-root');
      if (!root) { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
      root.innerHTML = $('#sheets').innerHTML;
      await Promise.all($$('img', root).map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
      window.print();
      root.innerHTML = '';
      const printed = data.items.map((i) => i.code);
      if (confirm(`Les ${printed.length} étiquette(s) se sont-elles bien imprimées ?\nElles seront retirées de la liste d'attente.`)) {
        await api('/api/labels/mark-printed', { method: 'POST', body: { codes: printed } });
        if (sel.mode === 'manual') sel.manual = [];
        sel.mode = 'pending';
        toast('Étiquettes marquées comme imprimées.');
        route();
      }
    };

    // Rien en attente et rien de choisi : on ouvre directement la selection manuelle.
    if (sel.mode === 'pending' && !pending.length) sel.mode = 'manual';
    renderMode();
    await refresh();
  }

  // ================= Reglages de la bibliotheque =================
  async function viewSettings() {
    const [s, cats] = await Promise.all([api('/api/settings'), api('/api/categories')]);
    const libraryUrl = location.origin + LIB;
    view().innerHTML = `
      <h1>Réglages</h1>
      <p class="muted">Bibliothèque « ${esc(s.libraryName)} » · <a href="${esc(libraryUrl)}/">${esc(libraryUrl)}/</a></p>
      <h2>Bibliothèque</h2>
      <form class="card" id="lib-form">
        <div class="field"><label for="lib-name">Nom de la bibliothèque</label><input id="lib-name" name="libraryName" required value="${esc(s.libraryName)}">
          <p class="small muted" style="margin-top:4px">Changer le nom ne change pas l'adresse de la bibliothèque (les QR codes imprimés restent valables).</p></div>
        <div class="field">
          <label>Logo</label>
          <div class="btn-row">
            ${s.logoUrl ? `<img src="${esc(mediaSrc(s.logoUrl))}" alt="" style="height:56px;max-width:160px;object-fit:contain;background:#fff;border-radius:8px;padding:4px;border:1px solid var(--border)">` : '<span class="muted small">Aucun logo</span>'}
            <label class="btn btn-small" style="margin:0">${s.logoUrl ? 'Remplacer' : 'Choisir une image'}<input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${s.logoUrl ? '<button class="btn btn-small btn-danger" type="button" id="logo-remove">Retirer</button>' : ''}
          </div>
          <p class="small muted" style="margin-top:6px">Affiché dans l'en-tête, sur les étiquettes et dans le catalogue intégré. PNG à fond transparent conseillé.</p>
        </div>
        <button class="btn btn-primary" type="submit">Enregistrer</button>
      </form>

      <h2>Codes des exemplaires</h2>
      <form class="card" id="code-form">
        <p class="muted small">Prochain code attribué : <span class="code">${esc(s.codePrefix)}-${String(s.nextCodeNumber).padStart(5, '0')}</span></p>
        <div class="grid-2">
          <div class="field"><label for="prefix">Préfixe</label><input id="prefix" name="prefix" value="${esc(s.codePrefix)}" maxlength="10" pattern="[A-Za-z0-9]{1,10}" required style="text-transform:uppercase"></div>
          <div class="field"><label>Aperçu</label><input id="prefix-preview" disabled></div>
        </div>
        <div class="btn-row">
          <button class="btn" type="submit">Appliquer aux nouveaux exemplaires</button>
          <button class="btn btn-danger" type="button" id="renumber">Régénérer tous les codes…</button>
        </div>
        <div id="renumber-panel" hidden style="margin-top:14px">
          <div class="info-box">
            Tous les exemplaires de cette bibliothèque reçoivent un code avec ce préfixe et leurs étiquettes repassent « en attente ».
            Les anciennes étiquettes restent utilisables en attendant : scannées, elles renvoient vers le bon exemplaire.
          </div>
          <label class="check"><input type="checkbox" id="compact"> Renuméroter à partir de 1 (dans l'ordre d'ajout, sans trous)</label>
          <p class="small muted" id="compact-warn" hidden>Avec le même préfixe, des numéros seront réattribués à d'autres livres : une ancienne étiquette pourrait alors ouvrir le mauvais exemplaire. Réimprime toutes les étiquettes rapidement.</p>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn btn-danger" type="button" id="renumber-go">Régénérer maintenant</button>
            <button class="btn" type="button" id="renumber-cancel">Annuler</button>
          </div>
        </div>
      </form>

      <h2>Catégories</h2>
      <div class="card">
        <div class="list" id="cat-list">${cats.length ? cats.map((c) => `
          <div class="list-item"><div class="grow">${esc(c.name)} <span class="small muted">(${c.count})</span></div>
            <button class="btn btn-small" data-rename="${c.id}" data-name="${esc(c.name)}">Renommer</button>
            <button class="btn btn-small btn-danger" data-delcat="${c.id}" data-name="${esc(c.name)}">Supprimer</button></div>`).join('') : '<p class="muted">Aucune catégorie. Elles se créent depuis la fiche d\'un livre ou ici.</p>'}</div>
        <form class="isbn-row" id="new-cat" style="margin-top:10px"><input name="name" placeholder="Nouvelle catégorie"><button class="btn" type="submit">Ajouter</button></form>
      </div>

      <h2>Intégration WordPress / Divi</h2>
      <div class="card">
        <p>Avec l'extension fournie (dossier <span class="code">wordpress/</span> du projet), place ce shortcode dans un module Texte ou Code de Divi :</p>
        <div class="snippet">[bibliotheque url="${esc(libraryUrl)}"]</div>
        <p style="margin-top:12px">Sans extension, colle ce code dans un module Code :</p>
        <div class="snippet">${esc(`<div class="mll-catalogue" data-url="${libraryUrl}"></div>\n<script src="${libraryUrl}/embed.js" defer></script>`)}</div>
      </div>

      <h2>Données</h2>
      <div class="card">
        <p><strong>Inventaire des livres</strong> — une ligne par livre avec tous les champs, le nombre d'exemplaires et leurs codes.
          Mêmes colonnes que le modèle d'import : il peut être modifié puis réimporté (<a href="#/import">Importer</a>).</p>
        <div class="btn-row">
          <a class="btn btn-primary" href="${LIB}/api/export/inventory.xlsx">Inventaire Excel (.xlsx)</a>
          <a class="btn" href="${LIB}/api/export/inventory.csv">Inventaire CSV</a>
        </div>
        <p style="margin-top:16px"><strong>Liste des exemplaires</strong> — une ligne par exemplaire (code, emplacement, prêt en cours).</p>
        <a class="btn" href="${LIB}/api/export/copies.csv">Exemplaires CSV</a>
      </div>`;

    $('#lib-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/settings', { method: 'PUT', body: { libraryName: e.target.libraryName.value } });
        await loadSettings();
        await loadStatus();
        renderHeader();
        toast('Réglages enregistrés.');
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
    const prefixInput = $('#prefix');
    const updatePreview = () => {
      const p = prefixInput.value.trim().toUpperCase() || '…';
      $('#prefix-preview').value = `${p}-00001, ${p}-00002…`;
      $('#compact-warn').hidden = !($('#compact').checked && p === s.codePrefix);
    };
    prefixInput.addEventListener('input', updatePreview);
    $('#compact').addEventListener('change', updatePreview);
    updatePreview();
    $('#code-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/settings', { method: 'PUT', body: { codePrefix: prefixInput.value } });
        toast('Préfixe enregistré pour les prochains exemplaires.');
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#renumber').onclick = () => { $('#renumber-panel').hidden = false; };
    $('#renumber-cancel').onclick = () => { $('#renumber-panel').hidden = true; };
    $('#renumber-go').onclick = async () => {
      if (!prefixInput.reportValidity()) return;
      const prefix = prefixInput.value.trim().toUpperCase();
      if (!confirm(`Régénérer les codes de tous les exemplaires avec le préfixe ${prefix} ?\nToutes les étiquettes seront à réimprimer.`)) return;
      try {
        const r = await api('/api/copies/renumber', { method: 'POST', body: { prefix, compact: $('#compact').checked } });
        state.labels = { mode: 'pending', manual: [] };
        toast(r.changed ? `${r.changed} code(s) régénéré(s). Les nouvelles étiquettes sont en attente d'impression.` : 'Aucun code à modifier.');
        go(r.changed ? '#/labels' : '#/settings');
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#logo-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await imageToDataUrl(file, 600, 'image/png');
        await api('/api/settings/logo', { method: 'POST', body: { dataUrl } });
        await loadSettings();
        await loadStatus();
        renderHeader();
        toast('Logo enregistré.');
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
    const rm = $('#logo-remove');
    if (rm) rm.onclick = async () => { await api('/api/settings/logo', { method: 'DELETE' }); await loadSettings(); renderHeader(); route(); };
    $$('[data-rename]').forEach((btn) => {
      btn.onclick = async () => {
        const name = prompt('Nouveau nom :', btn.dataset.name);
        if (!name) return;
        try { await api(`/api/categories/${btn.dataset.rename}`, { method: 'PUT', body: { name } }); route(); } catch (err) { toast(err.message, 'error'); }
      };
    });
    $$('[data-delcat]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`Supprimer la catégorie « ${btn.dataset.name} » ? Les livres ne sont pas supprimés.`)) return;
        await api(`/api/categories/${btn.dataset.delcat}`, { method: 'DELETE' });
        route();
      };
    });
    $('#new-cat').onsubmit = async (e) => {
      e.preventDefault();
      if (!e.target.name.value.trim()) return;
      try { await api('/api/categories', { method: 'POST', body: { name: e.target.name.value } }); route(); } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ================= Demarrage =================
  async function loadSettings() {
    if (!LIBRARY) return;
    try { state.settings = await api('/api/public/settings'); } catch (e) { /* valeurs injectees */ }
  }

  async function loadStatus() {
    try {
      const s = await gapi('/api/auth/status');
      state.user = s.user;
      state.needsSetup = s.needsSetup;
      state.libraries = s.libraries || [];
    } catch (e) { /* hors ligne */ }
  }

  $('#scan-btn').onclick = async () => {
    const code = await scanCopy();
    if (code) go(`#/c/${encodeURIComponent(code)}`);
  };

  (async function init() {
    await Promise.all([loadSettings(), loadStatus()]);
    renderHeader();
    window.addEventListener('hashchange', route);
    route();
  })();
})();
