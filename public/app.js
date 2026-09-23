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

  const state = {
    user: null,
    needsSetup: false,
    settings: { libraryName: 'Bibliothèque', logoUrl: null },
    catalog: { q: '', category: '', status: '', sort: 'title', page: 1 },
    labelSelection: new Set(),
  };

  // ================= Utilitaires =================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const view = () => $('#view');

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function mediaSrc(url) {
    return url ? `${BASE}/${url}` : '';
  }

  // Dates SQLite (UTC, "AAAA-MM-JJ HH:MM:SS") -> affichage local.
  function fmtDate(s, withTime) {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return withTime
      ? d.toLocaleString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* reponse vide */ }
    if (res.status === 401 && state.user) {
      state.user = null;
      renderNav();
    }
    if (!res.ok) throw new Error((data && data.error) || `Erreur ${res.status}`);
    return data;
  }

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
      await loadScript(BASE + '/vendor/barcode-detector.js');
      window.BarcodeDetectionAPI.prepareZXingModule({
        overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? BASE + '/vendor/zxing_reader.wasm' : prefix + p) },
      });
    }
    return (detectors[key] = new window.BarcodeDetectionAPI.BarcodeDetector({ formats }));
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
          if (!codes.some((c) => tryValue(c.rawValue))) status.textContent = 'Aucun code lisible sur la photo. Réessaie plus près et bien éclairé.';
        } catch (err) { status.textContent = 'Analyse impossible : ' + err.message; }
      });

      (async () => {
        let detector;
        try {
          detector = await getDetector(formats);
        } catch (err) {
          status.textContent = 'Lecteur de codes indisponible : ' + err.message;
          return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          status.textContent = 'Caméra inaccessible ici (il faut une connexion https). Utilise la saisie ou une photo.';
          return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        } catch (err) {
          status.textContent = 'Caméra refusée ou absente. Utilise la saisie manuelle ou une photo.';
          return;
        }
        if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream;
        await video.play().catch(() => {});
        const tick = async () => {
          if (done) return;
          try {
            if (video.readyState >= 2) {
              const codes = await detector.detect(video);
              for (const c of codes) if (tryValue(c.rawValue)) return;
            }
          } catch (e) { /* image suivante */ }
          timer = setTimeout(tick, 180);
        };
        tick();
      })();
    });
  }

  function isbnFromScan(raw) {
    const digits = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (/^97[89]\d{10}$/.test(digits) || /^\d{9}[\dX]$/.test(digits)) return digits;
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
      hint: 'Vise le code-barres ISBN au dos du livre (celui qui commence par 978 ou 979).',
      formats: ['ean_13'],
      accept: isbnFromScan,
      manualLabel: "ou tape l'ISBN",
    });
  }

  // ================= Navigation =================
  function renderBrand() {
    const s = state.settings;
    $('#brand-name').textContent = s.libraryName;
    document.title = s.libraryName;
    const logo = $('#brand-logo');
    logo.hidden = !s.logoUrl;
    if (s.logoUrl) logo.src = mediaSrc(s.logoUrl);
  }

  function renderNav() {
    const links = state.user
      ? [['#/', 'Catalogue'], ['#/add', 'Ajouter'], ['#/loans', 'Prêts'], ['#/borrowers', 'Emprunteurs'], ['#/labels', 'Étiquettes'], ['#/settings', 'Réglages']]
      : [['#/', 'Catalogue'], ['#/login', 'Connexion']];
    const current = '#/' + (location.hash.replace(/^#\/?/, '').split('/')[0] || '');
    $('#nav').innerHTML = links.map(([href, label]) => {
      const active = href === current || (href === '#/' && (current === '#/book' || current === '#/'));
      return `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
    }).join('') + (state.user ? '<button type="button" id="logout">Déconnexion</button>' : '');
    $('#scan-btn').hidden = !state.user;
    const logout = $('#logout');
    if (logout) logout.onclick = async () => {
      await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
      state.user = null;
      toast('Déconnecté.');
      go('#/');
      renderNav();
    };
  }

  const routes = [
    [/^\/?$/, viewCatalog],
    [/^\/book\/(\d+)$/, viewBook],
    [/^\/book\/(\d+)\/edit$/, viewBookForm, true],
    [/^\/c\/([^/]+)$/, viewCopy],
    [/^\/login$/, viewLogin],
    [/^\/add$/, viewBookForm, true],
    [/^\/loans$/, viewLoans, true],
    [/^\/borrowers$/, viewBorrowers, true],
    [/^\/borrower\/(\d+)$/, viewBorrower, true],
    [/^\/labels$/, viewLabels, true],
    [/^\/settings$/, viewSettings, true],
  ];

  let routeToken = 0;
  async function route() {
    const path = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
    renderNav();
    window.scrollTo(0, 0);
    const token = ++routeToken;
    for (const [re, fn, needsAuth] of routes) {
      const m = path.match(re);
      if (!m) continue;
      if (needsAuth && !state.user) {
        sessionStorageSet('mll-after-login', location.hash);
        return go('#/login');
      }
      view().innerHTML = '<p class="muted">Chargement…</p>';
      try {
        await fn(...m.slice(1));
      } catch (err) {
        if (token === routeToken) view().innerHTML = `<div class="error-box">${esc(err.message)}</div><a class="btn" href="#/">Retour au catalogue</a>`;
      }
      return;
    }
    view().innerHTML = '<div class="empty">Page introuvable.</div>';
  }

  function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
  function sessionStorageTake(k) {
    try { const v = sessionStorage.getItem(k); sessionStorage.removeItem(k); return v; } catch (e) { return null; }
  }

  // ================= Catalogue =================
  let categoriesCache = null;
  async function loadCategories(force) {
    if (!categoriesCache || force) categoriesCache = await api('/api/public/categories');
    return categoriesCache;
  }

  async function viewCatalog() {
    const c = state.catalog;
    const cats = await loadCategories(true);
    view().innerHTML = `
      <div class="page-head">
        <div><h1>Catalogue</h1><p class="muted" id="count"></p></div>
        ${state.user ? '<a class="btn btn-primary" href="#/add">+ Ajouter un livre</a>' : ''}
      </div>
      <div class="filters">
        <input class="search" type="search" id="q" placeholder="Titre, auteur, éditeur, ISBN${state.user ? ', code' : ''}…" value="${esc(c.q)}">
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
    const data = await api(`/api/${state.user ? 'books' : 'public/books'}?${params}`);
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
    const book = await api(state.user ? `/api/books/${id}` : `/api/public/books/${id}`);
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
          ${state.user && book.notes ? `<h3>Notes internes</h3><p class="summary muted">${esc(book.notes)}</p>` : ''}
          ${state.user ? `<div class="btn-row" style="margin-top:14px">
              <a class="btn" href="#/book/${book.id}/edit">Modifier</a>
              <button class="btn btn-danger" id="del-book">Supprimer</button>
            </div>` : ''}
        </div>
      </div>
      <h2>Exemplaires</h2>
      <div class="card" id="copies">${state.user ? adminCopiesHtml(book) : publicCopiesHtml(book)}</div>
      ${state.user && book.history.length ? `<h2>Historique des prêts</h2><div class="card table-wrap">${historyHtml(book.history)}</div>` : ''}`;
    if (state.user) bindAdminBook(book);
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
      book.copies.forEach((c) => state.labelSelection.add(c.code));
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
    if (!state.user) {
      const r = await api(`/api/public/copies/${encodeURIComponent(code)}`);
      location.replace(`#/book/${r.bookId}`);
      return;
    }
    const { copy, book } = await api(`/api/copies/by-code/${encodeURIComponent(code)}`);
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
        <h1>${setup ? 'Créer le compte administrateur' : 'Connexion'}</h1>
        <p class="muted">${setup ? "Aucun compte n'existe encore. Choisis l'identifiant et le mot de passe qui protégeront l'édition et les prêts." : 'Réservé à la gestion de la bibliothèque.'}</p>
        <div id="err"></div>
        <form id="login-form">
          <div class="field"><label for="u">Identifiant</label><input id="u" name="username" autocomplete="username" required></div>
          <div class="field"><label for="p">Mot de passe${setup ? ' (8 caractères min.)' : ''}</label><input id="p" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? 'minlength="8"' : ''}></div>
          <button class="btn btn-primary btn-block" type="submit">${setup ? 'Créer le compte' : 'Se connecter'}</button>
        </form>
      </div>`;
    $('#u').focus();
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true;
      try {
        const r = await api(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { username: e.target.username.value, password: e.target.password.value } });
        state.user = r.user;
        state.needsSetup = false;
        toast(`Bienvenue ${r.user.username} !`);
        go(sessionStorageTake('mll-after-login') || '#/');
      } catch (err) {
        $('#err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    };
  }

  // ================= Ajout / modification d'un livre =================
  async function viewBookForm(id) {
    const editing = !!id;
    const [book, cats, locations] = await Promise.all([
      editing ? api(`/api/books/${id}`) : null,
      loadCategories(true),
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
        <div class="field"><label for="summary">Résumé</label><textarea id="summary" name="summary">${esc(b.summary)}</textarea></div>
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
        <div class="field"><label for="notes">Notes internes (visibles uniquement une fois connecté)</label><textarea id="notes" name="notes" style="min-height:70px">${esc(b.notes)}</textarea></div>
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
        else {
          saved.copies.forEach((c) => state.labelSelection.add(c.code));
          toast(`Livre ajouté : ${saved.copies.map((c) => c.code).join(', ')}. Étiquette(s) à imprimer.`);
        }
        go(`#/book/${saved.id}`);
      } catch (err) {
        $('#form-err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    };
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
      $('#loan-list').innerHTML = loans.length ? `<div class="list">${loans.map(loanItemHtml).join('')}</div>`
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

  async function viewLabels() {
    const [settings, pending] = await Promise.all([api('/api/settings'), api('/api/labels/pending')]);
    const layout = Object.assign({ preset: 'L7160', showLogo: true, showName: true, showTitle: true, guides: true }, LABEL_PRESETS.L7160, settings.labelLayout || {});
    pending.forEach((p) => { if (!state.labelSelection.size || state.labelSelection.has(p.code)) state.labelSelection.add(p.code); });
    let start = 1;
    let data = null;

    view().innerHTML = `
      <div class="page-head"><div><h1>Étiquettes</h1><p class="muted">Planches A4 autocollantes, avec QR code à scanner pour les prêts et retours.</p></div></div>
      <div class="label-layout">
        <div>
          <div class="card">
            <h3 style="margin-top:0">Exemplaires à imprimer</h3>
            <div id="sel-list"></div>
            <form class="isbn-row" id="add-code" style="margin-top:10px">
              <input name="code" placeholder="Ajouter un code (BIB-…)" autocomplete="off">
              <button class="btn" type="submit">+</button>
            </form>
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
            <label class="check"><input type="checkbox" id="opt-guides" ${layout.guides ? 'checked' : ''}> Contours dans l'aperçu</label>
            <div class="btn-row" style="margin-top:14px">
              <button class="btn btn-primary" id="print">Imprimer</button>
            </div>
            <p class="small muted" style="margin-top:10px">Dans la fenêtre d'impression : format A4, marges « Aucune », échelle 100 % (« Taille réelle »).</p>
          </div>
        </div>
        <div class="sheets" id="sheets"></div>
      </div>`;

    const knownCopies = new Map(pending.map((p) => [p.code, p]));
    function renderSelection() {
      const codes = Array.from(new Set([...pending.map((p) => p.code), ...state.labelSelection]));
      $('#sel-list').innerHTML = codes.length ? `<div class="pending-list">${codes.map((code) => {
        const p = knownCopies.get(code);
        return `<label class="check"><input type="checkbox" data-code="${esc(code)}" ${state.labelSelection.has(code) ? 'checked' : ''}>
          <span><span class="code">${esc(code)}</span> ${p ? `<span class="small muted">${esc(p.title)}</span>` : ''}${p ? '' : ' <span class="small muted">(déjà imprimée)</span>'}</span></label>`;
      }).join('')}</div>
        <div class="btn-row small" style="margin-top:8px"><button class="btn btn-small" id="sel-all">Tout</button><button class="btn btn-small" id="sel-none">Aucun</button></div>`
        : '<p class="muted small">Aucune étiquette en attente. Les nouveaux exemplaires apparaissent ici automatiquement.</p>';
      $$('#sel-list input[data-code]').forEach((cb) => {
        cb.onchange = () => { if (cb.checked) state.labelSelection.add(cb.dataset.code); else state.labelSelection.delete(cb.dataset.code); refresh(); };
      });
      const all = $('#sel-all');
      if (all) {
        all.onclick = () => { codes.forEach((c) => state.labelSelection.add(c)); renderSelection(); refresh(); };
        $('#sel-none').onclick = () => { state.labelSelection.clear(); renderSelection(); refresh(); };
      }
    }

    function readLayout() {
      LAYOUT_FIELDS.forEach(([k]) => { layout[k] = parseFloat($(`[data-dim="${k}"]`).value) || 0; });
      layout.cols = Math.max(1, Math.round(layout.cols));
      layout.rows = Math.max(1, Math.round(layout.rows));
      layout.showLogo = $('#opt-logo').checked;
      layout.showName = $('#opt-name').checked;
      layout.showTitle = $('#opt-title').checked;
      layout.guides = $('#opt-guides').checked;
      start = Math.max(1, parseInt($('#start').value, 10) || 1);
    }

    const saveLayout = debounce(() => api('/api/settings', { method: 'PUT', body: { labelLayout: layout } }).catch(() => {}), 800);

    function renderSheets() {
      readLayout();
      const target = $('#sheets');
      const items = data ? data.items : [];
      if (!items.length) { target.innerHTML = '<div class="empty">Sélectionne des exemplaires pour voir l\'aperçu.</div>'; return; }
      const perSheet = layout.cols * layout.rows;
      const slots = Array(Math.min(start - 1, perSheet - 1)).fill(null).concat(items);
      const small = layout.height < 26 || layout.width < 45;
      const qrSize = Math.min(layout.height - 4, layout.width * 0.5);
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
          html += `<div class="lbl ${small ? 'small' : ''}" style="${pos}">
            <div class="qr" style="width:${qrSize}mm;height:${qrSize}mm">${item.svg}</div>
            <div class="info">
              ${showName || showLogo ? `<div class="lib">${showLogo ? `<img src="${esc(mediaSrc(data.logoUrl))}" alt="">` : ''}${showName ? `<span>${esc(data.libraryName)}</span>` : ''}</div>` : ''}
              ${layout.showTitle ? `<div class="ttl">${esc(item.title)}</div>` : ''}
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
      const codes = Array.from(state.labelSelection);
      const token = ++fetchToken;
      data = codes.length
        ? await api('/api/labels', { method: 'POST', body: { codes, baseUrl: location.origin + BASE + '/' } })
        : { items: [] };
      if (token === fetchToken) renderSheets();
    }

    $('#preset').onchange = (e) => {
      layout.preset = e.target.value;
      const p = LABEL_PRESETS[e.target.value];
      if (p) LAYOUT_FIELDS.forEach(([k]) => { $(`[data-dim="${k}"]`).value = p[k]; });
      else $('#dims').open = true;
      renderSheets();
      saveLayout();
    };
    $$('[data-dim]').forEach((input) => input.addEventListener('input', () => { layout.preset = 'custom'; $('#preset').value = 'custom'; renderSheets(); saveLayout(); }));
    ['#opt-logo', '#opt-name', '#opt-title', '#opt-guides'].forEach((sel) => { $(sel).onchange = () => { renderSheets(); saveLayout(); }; });
    $('#start').oninput = renderSheets;
    $('#add-code').onsubmit = async (e) => {
      e.preventDefault();
      const code = copyCodeFromScan(e.target.code.value.trim());
      if (!code) return toast('Code non reconnu.', 'error');
      try {
        const r = await api(`/api/copies/by-code/${encodeURIComponent(code)}`);
        knownCopies.set(r.copy.code, { code: r.copy.code, title: r.book.title });
        state.labelSelection.add(r.copy.code);
        e.target.reset();
        renderSelection();
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    };
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
        printed.forEach((c) => state.labelSelection.delete(c));
        toast('Étiquettes marquées comme imprimées.');
        route();
      }
    };

    renderSelection();
    await refresh();
  }

  // ================= Reglages =================
  async function viewSettings() {
    const [s, cats] = await Promise.all([api('/api/settings'), loadCategories(true)]);
    const embedUrl = location.origin + BASE;
    view().innerHTML = `
      <h1>Réglages</h1>
      <h2>Bibliothèque</h2>
      <form class="card" id="lib-form">
        <div class="field"><label for="lib-name">Nom de la bibliothèque</label><input id="lib-name" name="libraryName" required value="${esc(s.libraryName)}"></div>
        <div class="field">
          <label>Logo</label>
          <div class="btn-row">
            ${s.logoUrl ? `<img src="${esc(mediaSrc(s.logoUrl))}" alt="" style="height:56px;max-width:160px;object-fit:contain;background:#fff;border-radius:8px;padding:4px;border:1px solid var(--border)">` : '<span class="muted small">Aucun logo</span>'}
            <label class="btn btn-small" style="margin:0">${s.logoUrl ? 'Remplacer' : 'Choisir une image'}<input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${s.logoUrl ? '<button class="btn btn-small btn-danger" type="button" id="logo-remove">Retirer</button>' : ''}
          </div>
          <p class="small muted" style="margin-top:6px">Affiché dans l'en-tête, sur les étiquettes et dans le catalogue intégré. PNG à fond transparent conseillé.</p>
        </div>
        <div class="grid-2">
          <div class="field"><label for="prefix">Préfixe des codes d'exemplaire</label><input id="prefix" name="codePrefix" value="${esc(s.codePrefix)}" maxlength="10" style="text-transform:uppercase"></div>
          <div class="field"><label>Prochain code</label><input disabled value="${esc(s.codePrefix)}-${String(s.nextCodeNumber).padStart(5, '0')}"></div>
        </div>
        <button class="btn btn-primary" type="submit">Enregistrer</button>
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
        <div class="snippet">[bibliotheque url="${esc(embedUrl)}"]</div>
        <p style="margin-top:12px">Sans extension, colle ce code dans un module Code :</p>
        <div class="snippet">${esc(`<div class="mll-catalogue" data-url="${embedUrl}"></div>\n<script src="${embedUrl}/embed.js" defer></script>`)}</div>
      </div>

      <h2>Données</h2>
      <div class="card btn-row">
        <a class="btn" href="${BASE}/api/export/copies.csv">Exporter le catalogue (CSV / Excel)</a>
        <a class="btn" href="${BASE}/api/backup">Télécharger une sauvegarde de la base</a>
      </div>

      <h2>Mot de passe</h2>
      <form class="card" id="pwd-form">
        <div class="grid-2">
          <div class="field"><label>Mot de passe actuel</label><input name="current" type="password" autocomplete="current-password" required></div>
          <div class="field"><label>Nouveau mot de passe (8 caractères min.)</label><input name="password" type="password" autocomplete="new-password" minlength="8" required></div>
        </div>
        <button class="btn" type="submit">Changer le mot de passe</button>
      </form>`;

    $('#lib-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/settings', { method: 'PUT', body: { libraryName: e.target.libraryName.value, codePrefix: e.target.codePrefix.value } });
        await loadSettings();
        toast('Réglages enregistrés.');
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#logo-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await imageToDataUrl(file, 600, 'image/png');
        await api('/api/settings/logo', { method: 'POST', body: { dataUrl } });
        await loadSettings();
        toast('Logo enregistré.');
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
    const rm = $('#logo-remove');
    if (rm) rm.onclick = async () => { await api('/api/settings/logo', { method: 'DELETE' }); await loadSettings(); route(); };
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
    $('#pwd-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/auth/password', { method: 'POST', body: { current: e.target.current.value, password: e.target.password.value } });
        e.target.reset();
        toast('Mot de passe modifié.');
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ================= Demarrage =================
  async function loadSettings() {
    try { state.settings = await api('/api/public/settings'); } catch (e) { /* valeurs par defaut */ }
    renderBrand();
  }

  $('#scan-btn').onclick = async () => {
    const code = await scanCopy();
    if (code) go(`#/c/${encodeURIComponent(code)}`);
  };

  (async function init() {
    await loadSettings();
    try {
      const s = await api('/api/auth/status');
      state.user = s.user;
      state.needsSetup = s.needsSetup;
    } catch (e) { /* hors ligne */ }
    window.addEventListener('hashchange', route);
    route();
  })();
})();
