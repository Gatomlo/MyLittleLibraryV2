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
  // Utilisateur : outils de la bibliotheque, sans les etiquettes ni les reglages.
  const canConfigure = () => canManage() && state.user.role !== 'user';
  const roleLabel = (r) => (r === 'admin' ? 'Administrateur' : r === 'user' ? 'Utilisateur' : 'Gestionnaire');
  // Options de la bibliotheque (Reglages) : livres numeriques, statuts de lecture.
  const features = () => (state.settings && state.settings.features) || {};
  const statusesOn = () => canManage() && !!features().readingStatus;

  const READING_LABELS = { to_read: 'À lire', reading: 'En cours', read: 'Lu', abandoned: 'Abandonné' };
  const OPINION_LABELS = { liked: 'Aimé', disliked: 'Pas aimé' };
  const OPINION_ICONS = { liked: '♥', disliked: '✕' };

  // ================= Utilitaires =================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const view = () => $('#view');

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Aide contextuelle : icone "?" dont le texte s'affiche en info-bulle (survol,
  // focus clavier ou toucher). Une seule bulle flottante, placee dans l'ecran.
  const hint = (text) => `<span class="hint" tabindex="0" role="button" aria-label="${esc(text)}" data-tip="${esc(text)}">?</span>`;
  (() => {
    let tip = null;
    let pinned = null;
    const hide = () => { if (tip) tip.hidden = true; pinned = null; };
    const show = (el) => {
      if (!tip) { tip = document.createElement('div'); tip.className = 'hint-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      const top = r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8;
      tip.style.left = left + window.scrollX + 'px';
      tip.style.top = top + window.scrollY + 'px';
    };
    document.addEventListener('mouseover', (e) => { const el = e.target.closest && e.target.closest('.hint'); if (el) show(el); });
    document.addEventListener('mouseout', (e) => { const el = e.target.closest && e.target.closest('.hint'); if (el && el !== pinned) { if (tip) tip.hidden = true; } });
    document.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('hint')) show(e.target); });
    document.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('hint')) hide(); });
    document.addEventListener('click', (e) => {
      const el = e.target.closest && e.target.closest('.hint');
      if (el) { e.preventDefault(); e.stopPropagation(); if (pinned === el) hide(); else { show(el); pinned = el; } return; }
      if (pinned) hide();
    }, true);
    window.addEventListener('scroll', () => { if (tip && !tip.hidden) hide(); }, { passive: true });
    window.addEventListener('hashchange', hide);
  })();

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
    if (type === 'error') el.setAttribute('role', 'alert');
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  }

  // Date sans heure ('YYYY-MM-DD') : date de retour prevue d'un pret.
  const fmtDay = (s) => (s ? s.split('-').reverse().join('/') : '');
  // Echeance d'un pret en cours ("a rendre le ...", badge rouge si depassee).
  const dueHtml = (l) => (!l.dueAt ? '' : l.overdue ? `<span class="badge badge-late">En retard · ${fmtDay(l.dueAt)}</span>` : `à rendre le ${fmtDay(l.dueAt)}`);

  // ---------- Rappels de retour (mailto) ----------
  // Modele par defaut (reglages de la bibliotheque : objet et message personnalisables).
  const REMINDER_DEFAULT = {
    subject: 'Rappel : livre(s) à rendre à {bibliotheque}',
    body: 'Bonjour {nom},\n\nPetit rappel concernant le(s) livre(s) emprunté(s) à {bibliotheque} :\n{livres}\n\n'
      + 'Merci de le(s) rapporter dès que possible. Si un délai supplémentaire est nécessaire, il suffit de répondre à ce message.\n\nBonne lecture !',
  };
  function reminderText(tpl, borrower, loans) {
    const due = loans.map((l) => l.dueAt).filter(Boolean).sort()[0] || '';
    const lines = loans.map((l) => `- ${l.book.title} (${l.copy.code})${l.dueAt ? ` : à rendre le ${fmtDay(l.dueAt)}${l.overdue ? ' (en retard)' : ''}` : ''}`).join('\n');
    const fill = (s) => s.replace(/\{(nom|livres|bibliotheque|date_retour)\}/g, (m, k) => ({
      nom: borrower.name, livres: lines, bibliotheque: state.settings.libraryName, date_retour: fmtDay(due) })[k]);
    return { subject: fill(tpl.subject || REMINDER_DEFAULT.subject), body: fill(tpl.body || REMINDER_DEFAULT.body) };
  }
  // Ouvre le message dans la messagerie de l'appareil, puis note la relance si elle est envoyee.
  async function sendReminder(borrower, loans) {
    const { reminder } = await api('/api/loans/summary');
    const msg = reminderText(reminder || {}, borrower, loans);
    if (!borrower.email) {
      const v = await dialog(`<h2>Pas d'adresse e-mail</h2>
        <p><strong>${esc(borrower.name)}</strong> n'a pas d'adresse e-mail enregistrée.</p>
        <div class="btn-row">
          <button class="btn btn-primary" type="button" data-v="mail">Écrire quand même</button>
          <button class="btn" type="button" data-v="copy">Copier le message</button>
          <button class="btn" type="button" data-v="edit">Ajouter l'adresse</button>
          <button class="btn" type="button" data-close>Annuler</button>
        </div>`);
      if (v === 'edit') { go(`#/borrower/${borrower.id}`); return false; }
      if (v === 'copy') {
        try { await navigator.clipboard.writeText(`${msg.subject}\n\n${msg.body}`); toast('Message copié.'); } catch (e) { toast('Copie impossible.', 'error'); return false; }
      } else if (v === 'mail') openMailto('', msg);
      else return false;
    } else openMailto(borrower.email, msg);
    const ok = await dialog(`<h2>Relance de ${esc(borrower.name)}</h2>
      <p>Le message est prêt dans ta messagerie. Une fois envoyé, note la relance pour ne pas relancer deux fois.</p>
      <div class="btn-row"><button class="btn btn-primary" type="button" data-v="yes">Noter la relance</button><button class="btn" type="button" data-close>Pas envoyé</button></div>`);
    if (ok !== 'yes') return false;
    await api('/api/loans/reminded', { method: 'POST', body: { ids: loans.map((l) => l.id) } });
    toast('Relance notée.');
    refreshLoanBadge();
    return true;
  }
  function openMailto(to, msg) {
    const a = document.createElement('a');
    a.href = `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(msg.subject)}&body=${encodeURIComponent(msg.body)}`;
    a.click();
  }
  // Prets affiches (pour le bouton « Relancer » des listes).
  const loanCache = new Map();
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remind]');
    if (!btn) return;
    e.preventDefault();
    const l = loanCache.get(Number(btn.dataset.remind));
    if (!l) return;
    try { if (await sendReminder(l.borrower, [l])) route(); } catch (err) { toast(err.message, 'error'); }
  });
  const remindedHtml = (l) => (l.remindedAt ? `relancé le ${fmtDate(l.remindedAt)}${l.reminderCount > 1 ? ` (${l.reminderCount} fois)` : ''}` : '');

  // Fenetre simple : renvoie la valeur data-v du bouton touche, ou null.
  function dialog(html) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
      document.body.appendChild(backdrop);
      const close = (v) => { backdrop.remove(); resolve(v); };
      backdrop.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-v]');
        if (btn) close(btn.dataset.v);
        else if (e.target === backdrop || e.target.hasAttribute('data-close')) close(null);
      });
      const first = $('[data-v]', backdrop);
      if (first) first.focus();
    });
  }

  // ---------- Fenetres (accessibilite clavier) ----------
  // Toute fenetre .modal-backdrop : focus place dedans a l'ouverture et rendu a
  // l'element d'origine a la fermeture, Tab reste dans la fenetre, Echap ferme
  // (bouton data-close, sinon clic sur le fond), titre h2 relie a role=dialog.
  (() => {
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
    const opened = new Map();
    // Dernier element focalise hors fenetre (une fenetre prend souvent le focus
    // avant que l'observateur ne la voie).
    let lastOutside = null;
    const remember = (el) => { if (el && el.closest && !el.closest('.modal-backdrop')) lastOutside = el.closest(FOCUSABLE) || el; };
    document.addEventListener('focusin', (e) => remember(e.target));
    document.addEventListener('click', (e) => remember(e.target), true);
    const top = () => { const all = $$('.modal-backdrop'); return all[all.length - 1] || null; };
    const focusables = (el) => $$(FOCUSABLE, el).filter((x) => x.offsetParent !== null || x === document.activeElement);
    new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement) || !n.classList.contains('modal-backdrop')) return;
          opened.set(n, n.contains(document.activeElement) ? lastOutside : document.activeElement);
          const box = $('[role=dialog]', n) || $('.modal', n);
          if (box) {
            if (!box.hasAttribute('role')) box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            const h = $('h2, h1', box);
            if (h && !box.hasAttribute('aria-labelledby') && !box.hasAttribute('aria-label')) {
              if (!h.id) h.id = 'dlg-' + Math.random().toString(36).slice(2, 8);
              box.setAttribute('aria-labelledby', h.id);
            }
          }
          // Focus deja place par la fenetre (champ, bouton) : conserve.
          setTimeout(() => { if (n.isConnected && !n.contains(document.activeElement)) { const f = focusables(n)[0]; if (f) f.focus(); } }, 0);
        });
        r.removedNodes.forEach((n) => {
          if (!opened.has(n)) return;
          const back = opened.get(n);
          opened.delete(n);
          if (back && back.isConnected && !top()) back.focus();
        });
      }
    }).observe(document.body, { childList: true });
    document.addEventListener('keydown', (e) => {
      const m = top();
      if (!m) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const c = $('[data-close]', m);
        if (c) c.click(); else m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables(m);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (!m.contains(document.activeElement)) { e.preventDefault(); first.focus(); } else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }, true);
  })();

  // Lien « Aller au contenu » : focus sur la page sans toucher a l'adresse (routes en #).
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.skip-link')) return;
    e.preventDefault();
    view().focus();
  });

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ribbon : bandeau pose en travers du coin de la couverture (ex. "Numerique").
  function coverHtml(book, ribbon) {
    return `<div class="cover">${ribbon ? `<span class="cover-ribbon">${esc(ribbon)}</span>` : ''}${book.coverUrl
      ? `<img src="${esc(mediaSrc(book.coverUrl))}" alt="" loading="lazy">`
      : `<span class="cover-fallback">${esc(book.title)}</span>`}</div>`;
  }

  // withEbook = false : pas de pastille "Numerique" (affichee en bandeau sur la couverture).
  function availabilityBadge(b, withEbook = true) {
    const ebook = withEbook && b.ebookCopies > 0 ? '<span class="badge badge-ebook">Numérique</span>' : '';
    if (!withEbook && !b.totalCopies && b.ebookCopies > 0) return '';
    if (!b.totalCopies) return ebook || '<span class="badge badge-muted">Aucun exemplaire</span>';
    let paper;
    if (b.availableCopies === 0) paper = b.reservedCopies > 0 ? '<span class="badge badge-reserved">Réservé</span>' : '<span class="badge badge-warn">Emprunté</span>';
    else if (b.totalCopies > 1) paper = `<span class="badge badge-ok">${b.availableCopies}/${b.totalCopies} disponibles</span>`;
    else paper = '<span class="badge badge-ok">Disponible</span>';
    return ebook ? `<span class="badges">${paper}${ebook}</span>` : paper;
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

  // Codes lus sur une photo (valeurs acceptees par `accept`), sans ouvrir la camera.
  async function decodePhoto(file, formats, accept) {
    const detector = await getDetector(formats);
    const bitmap = await createImageBitmap(file);
    const values = (await detector.detect(bitmap)).map((c) => accept(String(c.rawValue || '').trim())).filter(Boolean);
    if (values.length || formats.includes('qr_code')) return values;
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    await loadQuagga();
    const q = await quaggaDecode(canvas);
    const v = q && accept(q);
    return v ? [v] : [];
  }

  // Moteur de lecture : camera + detection sur un element <video>. onValue(valeur)
  // est appele pour chaque code accepte par `accept` ; s'il renvoie true, la lecture
  // s'arrete (scan unique), sinon elle continue (scan en serie). Renvoie
  // { stop(), readPhoto(file) }.
  function startCamera({ video, formats, accept, onValue, onStatus, hint }) {
    const isBarcode = !formats.includes('qr_code');
    let stream = null;
    let stopped = false;
    let timer = null;

    function stop() {
      stopped = true;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }

    function tryValue(raw) {
      const value = accept(String(raw || '').trim());
      if (!value) return false;
      if (onValue(value)) { stop(); return true; }
      return false;
    }

    async function readPhoto(file) {
      onStatus('Analyse de la photo…');
      try {
        const values = await decodePhoto(file, formats, accept);
        if (values.length) { values.some((v) => onValue(v)); return true; }
        onStatus('Aucun code lisible sur la photo. Réessaie plus près et bien éclairé.');
      } catch (err) { onStatus('Analyse impossible : ' + err.message); }
      return false;
    }

    (async () => {
      let detector;
      try {
        detector = await getDetector(formats);
        if (isBarcode) await loadQuagga().catch(() => null);
      } catch (err) {
        onStatus('Lecteur de codes indisponible : ' + err.message);
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        onStatus('Caméra inaccessible ici (il faut une connexion https). Utilise la saisie ou une photo.');
        return;
      }
      try {
        // Resolution maximale : un code-barres ISBN est petit, chaque pixel compte.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch (err) {
        onStatus('Caméra refusée ou absente. Utilise la saisie manuelle ou une photo.');
        return;
      }
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      await tuneCamera(stream.getVideoTracks()[0], isBarcode);
      video.srcObject = stream;
      await video.play().catch(() => {});
      if (isBarcode) onStatus(`${hint} Tiens le livre à 15-25 cm, bien éclairé, le code-barres net et à plat dans le cadre.`);

      // Code-barres : on n'analyse que la bande centrale (zone du cadre) en pleine
      // resolution, avec deux moteurs complementaires : ZXing (rapide) et Quagga2
      // (plus tolerant au flou des webcams). Une lecture Quagga doit etre confirmee
      // deux fois pour ecarter les erreurs de lecture.
      const band = document.createElement('canvas');
      const quaggaHits = new Map();
      let frame = 0;
      const tick = async () => {
        if (stopped) return;
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
                if (hits >= 2) {
                  quaggaHits.delete(q);
                  if (tryValue(q)) return;
                }
              }
            }
          }
        } catch (e) { /* image suivante */ }
        if (!stopped) timer = setTimeout(tick, 120);
      };
      tick();
    })();

    return { stop, readPhoto };
  }

  // Recherche de couvertures en ligne : grille de propositions (meme ISBN, autres
  // editions...), recherche modifiable et collage d'une URL. Renvoie l'URL choisie ou null.
  function openCoverSearch(initial) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="cs-title">
          <h2 id="cs-title">Chercher une couverture</h2>
          <form class="cover-search-form">
            <input name="isbn" placeholder="ISBN" inputmode="numeric" value="${esc(initial.isbn || '')}" autocomplete="off">
            <input name="title" placeholder="Titre" value="${esc(initial.title || '')}" autocomplete="off">
            <input name="author" placeholder="Auteur" value="${esc(initial.author || '')}" autocomplete="off">
            <button class="btn btn-primary" type="submit">Chercher</button>
          </form>
          <p class="small muted" id="cs-status"></p>
          <div class="cover-results" id="cs-results"></div>
          <form class="isbn-row cover-url-form" style="margin-top:12px">
            <input name="url" type="url" placeholder="…ou colle l'adresse d'une image (https://…)" autocomplete="off">
            <button class="btn" type="submit">Utiliser</button>
          </form>
          <div class="btn-row" style="margin-top:12px"><button class="btn" type="button" data-close style="margin-left:auto">Fermer</button></div>
        </div>`;
      document.body.appendChild(backdrop);
      const finish = (value) => { backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
      const onKey = (e) => { if (e.key === 'Escape') finish(null); };
      document.addEventListener('keydown', onKey);
      $('[data-close]', backdrop).onclick = () => finish(null);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(null); });
      const searchForm = $('.cover-search-form', backdrop);
      const status = $('#cs-status', backdrop);
      const results = $('#cs-results', backdrop);
      let seq = 0;
      async function run() {
        const q = Object.fromEntries(new FormData(searchForm));
        if (!q.isbn.trim() && !q.title.trim()) { status.textContent = 'Indique un ISBN ou un titre.'; return; }
        const my = ++seq;
        status.textContent = 'Recherche en cours…';
        results.innerHTML = '';
        try {
          const { covers } = await api('/api/covers?' + new URLSearchParams(q));
          if (my !== seq) return;
          status.textContent = covers.length ? `${covers.length} couverture(s) trouvée(s) — clique pour choisir.` : 'Aucune couverture trouvée. Essaie avec un autre titre ou colle une adresse d\'image.';
          results.innerHTML = covers.map((c, i) => `
            <button type="button" class="cover-choice" data-i="${i}" title="${esc([c.title, c.detail].filter(Boolean).join(' — '))}">
              <span class="cover-choice-img"><img src="${esc(c.thumb || c.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"
                onerror="this.closest('.cover-choice').remove()"></span>
              <span class="cover-choice-src">${esc(c.source)}${c.loose ? ' · à vérifier' : ''}</span>
              <span class="cover-choice-title">${esc(c.title)}</span>
            </button>`).join('');
          $$('.cover-choice', results).forEach((btn) => { btn.onclick = () => finish(covers[Number(btn.dataset.i)].url); });
        } catch (err) {
          if (my === seq) status.textContent = err.message;
        }
      }
      searchForm.onsubmit = (e) => { e.preventDefault(); run(); };
      $('.cover-url-form', backdrop).onsubmit = (e) => {
        e.preventDefault();
        const url = e.target.elements.url.value.trim();
        if (!/^https?:\/\//i.test(url)) { toast('Adresse d\'image invalide.', 'error'); return; }
        finish(url);
      };
      run();
    });
  }

  // Ouvre la camera dans une fenetre et renvoie la premiere valeur lue acceptee par
  // `accept` (ou null si l'utilisateur ferme). Saisie manuelle et photo en secours.
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
      const status = $('.scanner-status', backdrop);
      let done = false;
      function finish(value) {
        if (done) return;
        done = true;
        camera.stop();
        backdrop.remove();
        resolve(value);
      }
      const camera = startCamera({
        video: $('video', backdrop),
        formats,
        accept,
        hint,
        onStatus: (msg) => { status.textContent = msg; },
        onValue: (value) => {
          if (navigator.vibrate) navigator.vibrate(80);
          finish(value);
          return true;
        },
      });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) finish(null); });
      $('form.manual', backdrop).addEventListener('submit', (e) => {
        e.preventDefault();
        const value = accept(e.target.manual.value.trim());
        if (value) finish(value); else status.textContent = 'Valeur non reconnue, vérifie la saisie.';
      });
      $('input[type=file]', backdrop).addEventListener('change', (e) => {
        if (e.target.files[0]) camera.readPhoto(e.target.files[0]);
      });
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

  // Bouton Scanner (en-tete, page Prets) : codes lus et page ouverte selon les
  // reglages de la bibliotheque (Reglages › Exemplaires et prets).
  const scanConf = () => (state.settings && state.settings.scan) || { codes: 'copy', action: 'loan' };
  const SCAN_TITLES = { copy: 'Scanner une étiquette', isbn: 'Scanner un ISBN', both: 'Scanner une étiquette ou un ISBN' };

  // Renvoie { copy } ou { isbn }, ou null si la fenetre est fermee.
  async function scanCopyOrIsbn() {
    const { codes } = scanConf();
    if (codes === 'copy') { const copy = await scanCopy(); return copy && { copy }; }
    if (codes === 'isbn') { const isbn = await scanIsbn(); return isbn && { isbn }; }
    const v = await openScanner({
      title: 'Scanner un livre',
      hint: "Vise le QR code de l'étiquette ou le code-barres ISBN.",
      formats: ['qr_code', 'ean_13'],
      accept: (raw) => {
        const copy = copyCodeFromScan(raw);
        // Adresse du QR ou code avec des lettres : etiquette ; sinon ISBN d'abord.
        if (copy && (raw.includes('#/c/') || /[A-WYZa-wyz]/.test(raw))) return 'c:' + copy;
        const isbn = isbnFromScan(raw);
        return isbn ? 'i:' + isbn : copy ? 'c:' + copy : null;
      },
      manualLabel: "ou tape le code ou l'ISBN",
    });
    return v && (v.startsWith('i:') ? { isbn: v.slice(2) } : { copy: v.slice(2) });
  }

  // Liste de choix (exemplaire ou livre) ; renvoie la valeur choisie ou null.
  function pickDialog(title, subtitle, rows) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h2>${esc(title)}</h2>
          ${subtitle ? `<p class="small muted">${esc(subtitle)}</p>` : ''}
          <div class="pick-list">${rows.map((r, i) => `<button type="button" class="pick-row" data-pick="${i}">${r.html}</button>`).join('')}</div>
          <div class="btn-row"><button class="btn" type="button" data-close>Annuler</button></div>
        </div>`;
      document.body.appendChild(backdrop);
      const close = (v) => { backdrop.remove(); resolve(v); };
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(null); });
      $$('[data-pick]', backdrop).forEach((btn) => { btn.onclick = () => close(rows[Number(btn.dataset.pick)].value); });
    });
  }

  // Emprunteur choisi depuis sa fiche (« Prêter un livre ») : pre-rempli sur la page
  // de pret des exemplaires scannes ensuite ; oublie en quittant ces pages (route).
  let loanFor = null;
  // ISBN scanne absent de la bibliotheque : pre-rempli sur la page Ajouter.
  let pendingAddIsbn = null;
  // Souhait a ajouter a la bibliotheque (page Souhaits) : fiche pre-remplie, puis
  // souhait retire de la liste a l'enregistrement.
  let pendingWish = null;

  // Ligne d'une liste de choix : couverture, texte principal, detail.
  const pickLine = (coverUrl, main, sub) => `<span class="pick-line">${coverUrl ? `<img class="thumb" src="${esc(mediaSrc(coverUrl))}" alt="">` : '<span class="thumb"></span>'}
    <span class="grow">${main}${sub ? `<span class="small muted">${sub}</span>` : ''}</span></span>`;

  // Scan puis ouverture du pret de l'exemplaire ou de la fiche du livre.
  // ISBN + pret : exemplaire papier unique ouvert directement, sinon choix.
  async function scanAndOpen(action = scanConf().action) {
    const r = await scanCopyOrIsbn();
    if (!r) return;
    try {
      if (r.copy) {
        if (action === 'loan') return await openCopy(r.copy);
        const c = await api(`/api/public/copies/${encodeURIComponent(r.copy)}`);
        return go(`#/book/${c.bookId}`);
      }
      const { books } = await api(`/api/copies/by-isbn/${encodeURIComponent(r.isbn)}`);
      if (!books.length) {
        const v = await dialog(`<h2>ISBN ${esc(r.isbn)} inconnu</h2>
          <p>Aucun livre avec cet ISBN dans cette bibliothèque.</p>
          <div class="btn-row"><button class="btn btn-primary" type="button" data-v="add">Ajouter à la bibliothèque</button>
            <button class="btn" type="button" data-v="wish">${icon('wish', 16)}Ajouter à mes souhaits</button>
            <button class="btn" type="button" data-close>Annuler</button></div>`);
        if (v === 'add') { pendingAddIsbn = r.isbn; go('#/add'); }
        if (v === 'wish' && await wishDialog(null, { isbn: r.isbn })) go('#/wishes');
        return;
      }
      if (action === 'book') {
        const id = books.length === 1 ? books[0].id
          : await pickDialog('Choisir le livre', `ISBN ${r.isbn}`, books.map((b) => ({
            value: b.id, html: pickLine(b.coverUrl, `<strong>${esc(b.title)}</strong>`, esc(b.authors || '')) })));
        if (id) go(`#/book/${id}`);
        return;
      }
      // Exemplaires disponibles en premier.
      const copies = books.flatMap((b) => b.copies.map((c) => ({ ...c, book: b }))).sort((a, b) => !!a.loan - !!b.loan);
      if (!copies.length) {
        toast("Ce livre n'a aucun exemplaire papier à prêter.", 'error');
        if (books.length === 1) go(`#/book/${books[0].id}`);
        return;
      }
      const code = copies.length === 1 ? copies[0].code
        : await pickDialog("Choisir l'exemplaire", books.length === 1 ? books[0].title : `ISBN ${r.isbn}`, copies.map((c) => ({
          value: c.code,
          html: pickLine(c.book.coverUrl,
            `<span><strong class="code">${esc(c.code)}</strong> ${c.loan ? (c.loan.overdue ? '<span class="badge badge-late">En retard</span>' : '<span class="badge badge-warn">Prêté</span>') : c.reservedFor ? '<span class="badge badge-reserved">Réservé</span>' : '<span class="badge badge-ok">Disponible</span>'}</span>`,
            [books.length > 1 ? esc(c.book.title) : '', c.reservedFor ? `pour ${esc(c.reservedFor.name)}` : '', c.loan ? `${esc(c.loan.borrower.name)} depuis le ${fmtDate(c.loan.loanedAt)}${c.loan.dueAt ? `, à rendre le ${fmtDay(c.loan.dueAt)}` : ''}` : '', esc(c.location)]
              .filter(Boolean).join(' · ')),
        })));
      if (code) await openCopy(code);
    } catch (err) { toast(err.message, 'error'); }
  }

  // Exemplaire scanne : page de pret, ou retour express s'il est prete (sans quitter
  // la page ; « Retour + suivant » relance le scanner pour enchainer les retours).
  async function openCopy(code) {
    const { copy, book } = await api(`/api/copies/by-code/${encodeURIComponent(code)}`);
    if (!copy.loan) return go(`#/c/${encodeURIComponent(copy.code)}`);
    const choice = await dialog(`
      <h2>Retour</h2>
      <div class="list-item" style="border:0;padding-top:0">
        ${book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(book.coverUrl))}" alt="">` : ''}
        <div class="grow">
          <div class="code">${esc(copy.code)}</div>
          <strong>${esc(book.title)}</strong>
          <div class="small muted">Prêté à ${esc(copy.loan.borrower.name)} depuis le ${fmtDate(copy.loan.loanedAt)}</div>
          ${copy.loan.dueAt ? `<div class="small muted">${dueHtml(copy.loan)}</div>` : ''}
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-ok" type="button" data-v="return">Enregistrer le retour</button>
        <button class="btn btn-primary" type="button" data-v="next">Retour + scanner le suivant</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" type="button" data-v="open">Voir le prêt</button>
        <button class="btn" type="button" data-close style="margin-left:auto">Annuler</button>
      </div>`);
    if (choice === 'open') return go(`#/c/${encodeURIComponent(copy.code)}`);
    if (choice !== 'return' && choice !== 'next') return;
    if (await returnLoan(copy.loan.id, copy.code)) return;
    route();
    if (choice === 'next') await scanAndOpen('loan');
  }

  // Retour d'un pret, puis alerte si le livre est reserve (au nom d'un emprunteur).
  // Renvoie true si l'on part preter l'exemplaire a cet emprunteur (page changee).
  async function returnLoan(loanId, code) {
    const r = await api(`/api/loans/${loanId}/return`, { method: 'POST', body: {} });
    toast(`Retour de ${code} enregistré.`);
    if (!r.reservations || !r.reservations.length) return false;
    const [first, ...others] = r.reservations;
    const v = await dialog(`
      <h2>Livre réservé</h2>
      <div class="warn-box">Mets « ${esc(r.book.title)} » de côté pour <strong>${esc(first.borrower.name)}</strong> (réservé le ${fmtDate(first.createdAt)}).</div>
      ${others.length ? `<p class="small muted">Ensuite : ${others.map((x) => esc(x.borrower.name)).join(', ')}</p>` : ''}
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-v="lend">Prêter à ${esc(first.borrower.name)}</button>
        <button class="btn" type="button" data-v="ok">Mettre de côté</button>
        <button class="btn" type="button" data-v="done">Retirer la réservation</button>
      </div>`);
    if (v === 'done') await api(`/api/reservations/${first.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
    if (v !== 'lend') return false;
    // Le pret a l'emprunteur retire sa reservation (serveur).
    loanFor = { id: first.borrower.id, name: first.borrower.name };
    go(`#/c/${encodeURIComponent(code)}`);
    return true;
  }

  // Bouton « Retour » des listes de prets : retour express.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick-return]');
    if (!btn) return;
    e.preventDefault();
    openCopy(btn.dataset.quickReturn).catch((err) => toast(err.message, 'error'));
  });

  // Pastille des prets en retard sur le lien Prets (et le bouton menu sur telephone).
  function refreshLoanBadge() {
    const link = $('#nav a[href="#/loans"]');
    if (!link || !canManage()) { $('#menu-btn').classList.remove('has-alert'); return; }
    api('/api/loans/summary').then((s) => {
      const old = $('.nav-badge', link);
      if (old) old.remove();
      // Rappels programmes : prets a relancer ; sinon prets en retard.
      const auto = s.reminder && s.reminder.mode === 'auto';
      const n = auto ? s.toRemind : s.overdue;
      const label = auto ? 'Prêts à relancer' : 'Prêts en retard';
      if (n) link.insertAdjacentHTML('beforeend', `<span class="nav-badge" title="${label}"><span class="sr-only">${label} : </span>${n}</span>`);
      $('#menu-btn').classList.toggle('has-alert', n > 0);
    }).catch(() => {});
  }

  // ================= En-tete : marque, navigation, menu du compte =================
  function renderBrand() {
    const s = state.settings;
    $('#brand-name').textContent = s.libraryName;
    document.title = s.libraryName;
    const brand = $('.brand');
    brand.href = LIBRARY ? `${LIB}/#/${state.user ? 'home' : ''}` : `${ROOT}/#/`;
    // Reglage de la bibliotheque : nom et logo, nom seul ou logo seul (sans logo,
    // le nom reste affiche pour que l'en-tete ne soit jamais vide).
    const display = s.brandDisplay || 'both';
    const logo = $('#brand-logo');
    logo.hidden = !s.logoUrl || display === 'name';
    if (s.logoUrl) logo.src = mediaSrc(s.logoUrl);
    logo.alt = display === 'logo' ? s.libraryName : '';
    $('#brand-name').hidden = display === 'logo' && !!s.logoUrl;
    brand.classList.toggle('logo-only', display === 'logo' && !!s.logoUrl);
  }

  function renderHeader() {
    renderBrand();
    renderNav();
    renderAccount();
  }

  // ================= Icones =================
  // Traces au style Lucide (licence ISC), 24x24, trait de 2.
  const ICON_PATHS = {
    catalog: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
    add: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/>',
    import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    loans: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    borrowers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    labels: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17 21h4v-3"/>',
    kobo: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 7h6"/><path d="M9 11h6"/><path d="M9 15h3"/>',
    stats: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    install: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    admin: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
    edit: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    incomplete: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    wish: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
    todo: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    goal: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
  };
  function icon(name, size = 18) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  }
  // Couleur de chaque page (teinte, fond pastel) : navigation et pastille du titre.
  const PAGE_COLORS = {
    catalog: 'accent', kobo: 'grape', add: 'coral', import: 'sky', loans: 'sun', borrowers: 'grape', labels: 'rose', stats: 'sky', settings: 'accent',
    user: 'grape', admin: 'coral', login: 'accent', library: 'accent', edit: 'coral', incomplete: 'sun', wish: 'rose', home: 'accent',
  };
  const colorVars = (name) => { const c = PAGE_COLORS[name] || 'accent'; return `--c:var(--${c});--cs:var(--${c}-soft)`; };

  // Pastille d'icone devant le titre (h1) de chaque page, selon l'adresse.
  const TITLE_ICONS = [
    [/^\/book\/\d+\/edit$/, 'edit'], [/^\/add$/, 'add'], [/^\/import$/, 'import'], [/^\/incomplete/, 'incomplete'],
    [/^\/kobo/, 'kobo'], [/^\/loans$/, 'loans'], [/^\/borrowers?(\/|$)/, 'borrowers'], [/^\/labels$/, 'labels'], [/^\/stats$/, 'stats'],
    [/^\/settings$/, 'settings'], [/^\/account$/, 'user'], [/^\/admin$/, 'admin'], [/^\/login$/, 'login'], [/^\/wishes$/, 'wish'], [/^\/home$/, 'home'],
  ];
  function decorateTitle() {
    const h1 = view().querySelector('h1');
    if (!h1 || h1.querySelector('.h-icon')) return;
    const path = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
    if (loanFor && !path.startsWith('/c/') && path !== `/borrower/${loanFor.id}`) loanFor = null;
    let name = /^\/?$/.test(path) ? (LIBRARY ? 'catalog' : 'library') : null;
    for (const [re, n] of TITLE_ICONS) if (re.test(path)) { name = n; break; }
    if (!name) return;
    h1.insertAdjacentHTML('afterbegin', `<span class="h-icon" style="${colorVars(name)}">${icon(name, 22)}</span>`);
  }
  new MutationObserver(decorateTitle).observe(document.getElementById('view'), { childList: true });

  function renderNav() {
    let links = [];
    if (LIBRARY) {
      links = canManage()
        ? [['#/', 'Catalogue', 'catalog'], ['#/add', 'Ajouter', 'add'], ['#/loans', 'Prêts', 'loans'], ['#/borrowers', 'Emprunteurs', 'borrowers'], ...(features().stats ? [['#/stats', 'Statistiques', 'stats']] : []), ...(koboOn() ? [[`#/kobo/${kobo.device.id}`, kobo.device.name, 'kobo']] : [])]
        : [['#/', 'Catalogue', 'catalog']];
      if (state.user) {
        links.splice(canManage() ? 4 : 1, 0, ['#/wishes', 'Souhaits', 'wish']);
        links.unshift(['#/home', 'Accueil', 'home']);
      }
    }
    let current = '#/' + (location.hash.replace(/^#\/?/, '').split('/')[0] || '');
    if (current === '#/import') current = '#/add'; // ajout multiple : sous-page de Ajouter
    $('#nav').innerHTML = links.map(([href, label, ic]) => {
      const active = href === current || href.startsWith(current + '/') || (href === '#/' && (current === '#/book' || current === '#/'));
      return `<a href="${href}" class="${active ? 'active' : ''}"${active ? ' aria-current="page"' : ''} style="${colorVars(ic)}">${icon(ic)}<span>${esc(label)}</span></a>`;
    }).join('');
    // Etiquettes et reglages : seulement dans le menu du compte (tous les ecrans).
    $('#nav').hidden = links.length <= 1;
    // Petit ecran : pages regroupees derriere le bouton menu (hamburger).
    $('#menu-btn').classList.toggle('has-links', links.length > 1);
    const activeLink = $('#nav a.active');
    $('#menu-btn').title = activeLink ? activeLink.textContent : 'Menu';
    $('#scan-btn').hidden = !canManage();
    $('#scan-btn').title = SCAN_TITLES[scanConf().codes];
    refreshLoanBadge();
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
      <div class="menu-head"><strong>${esc(u.username)}</strong>${roleLabel(u.role)}</div>
      <div class="menu-sep"></div>
      <div class="menu-title">Mes bibliothèques</div>
      ${libs || '<p class="small muted" style="padding:4px 10px">Aucune bibliothèque liée à ce compte.</p>'}
      ${LIBRARY && canConfigure() ? `<div class="menu-sep"></div>
      <div class="menu-title">${esc(state.settings.libraryName)}</div>
      <a class="menu-item" href="#/labels">${icon('labels')}Étiquettes</a>
      <a class="menu-item" href="#/settings">${icon('settings')}Réglages</a>` : ''}
      ${canManage() && features().kobo && !TOUCH_ONLY ? `<div class="menu-sep"></div>
      <div class="menu-title">Liseuses</div>
      ${koboSavedInfo && !koboOn() ? `<button class="menu-item" type="button" id="menu-kobo-reconnect">${icon('kobo')}Reconnecter ${esc(koboSavedInfo.name)}</button>` : ''}
      <button class="menu-item" type="button" id="menu-kobo-connect">${icon('kobo')}${koboOn() ? `Rescanner ${esc(kobo.device.name)}` : koboSavedInfo ? 'Brancher une autre liseuse' : 'Brancher une liseuse'}</button>
      <a class="menu-item" href="#/kobo">${icon('kobo')}Toutes les liseuses</a>` : ''}
      <div class="menu-sep"></div>
      <a class="menu-item" href="#/account">${icon('user')}Mon compte</a>
      <a class="menu-item" href="#/wishes">${icon('wish')}Mes souhaits</a>
      ${LIBRARY ? `<button class="menu-item" type="button" id="menu-home-custom">${icon('home')}Personnaliser l'accueil</button>` : ''}
      ${canInstall() ? `<button class="menu-item" type="button" id="install-app">${icon('install')}Installer l'application</button>` : ''}
      ${u.role === 'admin' ? `<a class="menu-item" href="#/admin">${icon('admin')}Administration</a>` : ''}
      <button class="menu-item" type="button" id="logout">${icon('logout')}Déconnexion</button>`;
    $('#account').appendChild(menu);
    $('#account-btn').setAttribute('aria-expanded', 'true');
    menu.addEventListener('click', (e) => e.stopPropagation());
    $$('a', menu).forEach((a) => a.addEventListener('click', closeMenu));
    const koboMenuAction = (btn, fn) => { if (btn) btn.onclick = async () => {
      closeMenu();
      try {
        const d = await fn();
        toast(`Liseuse « ${d.name} » branchée.`);
        go(`#/kobo/${d.id}`);
      } catch (err) { if (err.name !== 'AbortError') toast(err.message, 'error'); }
    }; };
    // Rescanner la liseuse branchee : sans repasser par le choix du dossier.
    koboMenuAction($('#menu-kobo-connect', menu), () => (koboOn() && kobo.root ? scanKobo(kobo.root) : scanKobo()));
    koboMenuAction($('#menu-kobo-reconnect', menu), reconnectKobo);
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
    if ($('#install-app')) $('#install-app').onclick = () => { closeMenu(); installApp(); };
    if ($('#menu-home-custom')) $('#menu-home-custom').onclick = () => { closeMenu(); openHomeCustomize(); };
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

  // Menu hamburger (petit ecran) : ouvre / ferme la liste des pages.
  function setNavOpen(open) {
    $('#nav').classList.toggle('open', open);
    $('#menu-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('nav-open', open);
  }
  $('#menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    setNavOpen(!$('#nav').classList.contains('open'));
  });
  $('#nav').addEventListener('click', (e) => { e.stopPropagation(); if (e.target.closest('a')) setNavOpen(false); });
  document.addEventListener('click', () => setNavOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNavOpen(false); });
  window.addEventListener('hashchange', () => setNavOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // ================= Routage =================
  // needs : 'manage' (gerer cette bibliotheque), 'user' (etre connecte), 'admin'.
  const LIBRARY_ROUTES = [
    [/^\/?$/, viewCatalog],
    [/^\/home$/, viewDashboard, 'user'],
    [/^\/book\/(\d+)$/, viewBook],
    [/^\/read\/(\d+)$/, viewReader],
    [/^\/kobo$/, viewKobo, 'manage'],
    [/^\/kobo\/(\d+)$/, viewKoboDevice, 'manage'],
    [/^\/book\/(\d+)\/edit$/, viewBookForm, 'manage'],
    [/^\/c\/([^/]+)$/, viewCopy],
    [/^\/login$/, viewLogin],
    [/^\/add$/, viewBookForm, 'manage'],
    [/^\/import$/, viewImport, 'manage'],
    [/^\/incomplete(?:\/(\w+))?$/, viewIncomplete, 'manage'],
    [/^\/loans$/, viewLoans, 'manage'],
    [/^\/borrowers$/, viewBorrowers, 'manage'],
    [/^\/borrower\/(\d+)$/, viewBorrower, 'manage'],
    [/^\/labels$/, viewLabels, 'config'],
    [/^\/stats$/, viewStats, 'manage'],
    [/^\/settings$/, viewSettings, 'config'],
    [/^\/account$/, viewAccount, 'user'],
    [/^\/wishes$/, viewWishes, 'user'],
    [/^\/admin$/, viewAdmin, 'admin'],
  ];
  const HOME_ROUTES = [
    [/^\/?$/, viewHome],
    [/^\/login$/, viewLogin],
    [/^\/account$/, viewAccount, 'user'],
    [/^\/wishes$/, viewWishes, 'user'],
    [/^\/admin$/, viewAdmin, 'admin'],
    // Anciennes etiquettes (d'avant les bibliotheques multiples) : #/c/CODE a la racine.
    [/^\/(c\/[^/]+|book\/\d+)$/, viewLegacyRedirect],
  ];

  // Apres un changement de page : titre de l'onglet = titre de la page, et focus
  // sur le contenu (sauf au premier affichage), pour les lecteurs d'ecran et le clavier.
  let firstPage = true;
  function announcePage() {
    const h1 = $('h1', view());
    const name = state.settings && state.settings.libraryName;
    const t = h1 ? h1.textContent.replace(/\?/g, '').trim() : '';
    document.title = t && t !== name ? `${t} – ${name || 'Bibliothèques'}` : (name || 'Bibliothèques');
    if (firstPage) { firstPage = false; return; }
    if (!view().contains(document.activeElement)) view().focus({ preventScroll: true });
  }

  // Nettoyage de la page quittee (ex. couper la camera du scan en serie).
  let pageCleanup = null;
  function onLeave(fn) { pageCleanup = fn; }

  async function route() {
    closeMenu();
    if (pageCleanup) { try { pageCleanup(); } catch (e) { /* rien */ } pageCleanup = null; }
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
      if ((needs === 'manage' && !canManage()) || (needs === 'config' && !canConfigure()) || (needs === 'admin' && !isAdmin())) {
        view().innerHTML = `<div class="empty">Ton compte n'a pas accès à cette page.<br><br><a class="btn" href="#/">Retour</a></div>`;
        return;
      }
      view().innerHTML = '<p class="muted" role="status">Chargement…</p>';
      try {
        await fn(...m.slice(1));
        announcePage();
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

  // Liste deroulante filtrante : un clic dans le champ ouvre la liste complete, la
  // saisie la restreint (sans tenir compte des accents), fleches + Entree ou clic pour
  // choisir. items : [{ label, hint? }] ; onSelect(item) au choix.
  const foldText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function combo(input, items, onSelect, { emptyText = 'Aucun résultat', showAllOnFocus = true } = {}) {
    input.removeAttribute('list');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    const wrap = document.createElement('div');
    wrap.className = 'combo';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const panel = document.createElement('div');
    panel.className = 'combo-list';
    panel.hidden = true;
    wrap.appendChild(panel);
    let shown = [];
    let active = -1;
    let filterText = '';

    function render() {
      const q = foldText(filterText);
      shown = items.filter((it) => !q || foldText(it.label).includes(q)).slice(0, 300);
      active = shown.length ? Math.max(0, Math.min(active, shown.length - 1)) : -1;
      panel.innerHTML = shown.length
        ? shown.map((it, i) => `<div class="combo-item ${i === active ? 'active' : ''}" data-i="${i}"><span>${esc(it.label)}</span>${it.hint ? `<span class="combo-hint">${esc(it.hint)}</span>` : ''}</div>`).join('')
        : `<div class="combo-empty">${esc(emptyText)}</div>`;
      const el = panel.querySelector('.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function open(all) {
      filterText = all ? '' : input.value;
      active = -1;
      render();
      panel.hidden = false;
    }
    function close() { panel.hidden = true; }
    function choose(i) {
      const it = shown[i];
      if (!it) return;
      close();
      onSelect(it);
    }
    input.addEventListener('focus', () => open(showAllOnFocus));
    input.addEventListener('click', () => { if (panel.hidden) open(showAllOnFocus); });
    input.addEventListener('input', () => { filterText = input.value; active = 0; render(); panel.hidden = false; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (panel.hidden) open(true); else { active = Math.min(active + 1, shown.length - 1); render(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === 'Enter' && !panel.hidden && active >= 0 && filterText) { e.preventDefault(); e.stopImmediatePropagation(); choose(active); }
      else if (e.key === 'Escape') close();
    });
    panel.addEventListener('mousedown', (e) => {
      e.preventDefault(); // garde le focus dans le champ
      const item = e.target.closest('.combo-item');
      if (item) choose(Number(item.dataset.i));
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
    return { setItems(list) { items = list; if (!panel.hidden) render(); }, close };
  }

  // Filtre avec liste deroulante filtrante (categories, collections, tags du
  // catalogue). onPick(id|'') est appele au choix / a l'effacement.
  function searchPicker({ input, items, value, onPick }) {
    const current = items.find((i) => String(i.id) === String(value));
    input.value = current ? current.name : '';
    combo(input, items.map((i) => ({ ...i, label: i.name, hint: i.count != null ? String(i.count) : '' })), (it) => {
      input.value = it.name;
      onPick(String(it.id));
    });
    input.addEventListener('input', () => { if (!input.value) onPick(''); });
  }

  // Filtres du catalogue : choisis dans les Reglages (liste + position en haut ou
  // dans une colonne a gauche). Sans reglage : tous, en haut.
  const ALL_CATALOG_CARD = ['cover', 'title', 'authors', 'series', 'collection', 'categories', 'tags', 'readers', 'status', 'rating', 'availability', 'ebook'];
  // Elements de la miniature d'un livre : [cle, libelle, option de la bibliotheque necessaire]
  const CATALOG_CARD_LABELS = [
    ['cover', 'Couverture'], ['title', 'Titre'], ['authors', 'Auteurs'], ['series', 'Série et tome'], ['collection', 'Collection'],
    ['categories', 'Catégories'], ['tags', 'Tags', 'tags'], ['readers', 'Lecteurs (gestion)'], ['status', 'Statut de lecture et avis', 'readingStatus'], ['rating', 'Note (étoiles)', 'readingStatus'], ['availability', 'Disponibilité'], ['ebook', 'Bandeau « Numérique »', 'ebooks'],
  ];
  const ALL_CATALOG_FILTERS = ['search', 'scan', 'category', 'collection', 'series', 'tag', 'mine', 'reader', 'availability', 'format',
    'statusUser', 'reading', 'opinion', 'rating', 'sort', 'count'];
  const catalogConf = () => {
    const conf = (state.settings && state.settings.catalog) || {};
    return {
      filters: Array.isArray(conf.filters) ? conf.filters : ALL_CATALOG_FILTERS, position: conf.position === 'left' ? 'left' : 'top',
      card: Array.isArray(conf.card) ? conf.card : ALL_CATALOG_CARD,
    };
  };

  // [cle, libelle, option de la bibliotheque necessaire]
  const CATALOG_FILTER_LABELS = [
    ['search', 'Recherche'], ['scan', 'Scanner un ISBN (recherche)'], ['category', 'Catégories'], ['collection', 'Collections'], ['series', 'Séries'], ['tag', 'Tags', 'tags'], ['mine', 'Mes livres (gestion)'], ['reader', 'Lecteurs (gestion)'],
    ['availability', 'Disponibilité'], ['format', 'Papier / numérique', 'ebooks'],
    ['statusUser', 'Statuts de… (choix du compte)', 'readingStatus'], ['reading', 'Statut de lecture', 'readingStatus'], ['opinion', 'Avis', 'readingStatus'], ['rating', 'Note', 'readingStatus'],
    ['sort', 'Tri'], ['count', 'Nombre de livres'],
  ];

  // Transforme une page "titre h2 + contenu" en sections repliables (accordeon) ;
  // les sections ouvertes sont memorisees (par navigateur).
  function accordionize(container, storageKey) {
    let open = null;
    try { open = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (e) { open = null; }
    const save = () => {
      const titles = $$('.settings-section[open]', container).map((d) => d.dataset.title);
      try { localStorage.setItem(storageKey, JSON.stringify(titles)); } catch (e) { /* stockage indisponible */ }
    };
    $$(':scope > h2', container).forEach((h2, i) => {
      const title = h2.textContent.trim();
      const details = document.createElement('details');
      details.className = 'settings-section';
      details.dataset.title = title;
      // Par defaut, seule la premiere section est ouverte.
      if (open ? open.includes(title) : i === 0) details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = title;
      const body = document.createElement('div');
      body.className = 'section-body';
      details.append(summary, body);
      h2.replaceWith(details);
      while (details.nextElementSibling && details.nextElementSibling.tagName !== 'H2' && !details.nextElementSibling.classList.contains('settings-group')) body.appendChild(details.nextElementSibling);
      details.addEventListener('toggle', save);
    });
  }

  // Comptes membres de la bibliotheque (statuts de lecture, lecteurs).
  let membersCache = null;
  const loadMembers = () => (membersCache ? Promise.resolve(membersCache) : api('/api/members').then((m) => (membersCache = m)));

  async function viewCatalog() {
    const c = state.catalog;
    const conf = catalogConf();
    const show = (k) => conf.filters.includes(k);
    const withStatus = statusesOn() && show('statusUser');
    const withReader = canManage() && show('reader');
    state.selecting = false;
    state.selected = new Set();
    const [cats, collections, seriesList, tags, members] = await Promise.all([
      show('category') ? loadCategories() : [],
      show('collection') ? api('/api/public/collections').catch(() => []) : [],
      show('series') ? api('/api/public/series').catch(() => []) : [],
      show('tag') && features().tags ? api('/api/public/tags').catch(() => []) : [],
      withStatus || withReader ? loadMembers() : [],
    ]);
    if (withStatus && !c.statusUser) c.statusUser = String(state.user.id);
    const left = conf.position === 'left';
    const sel = (v, x) => (v === x ? 'selected' : '');

    // [cle, libelle (colonne de gauche), html]
    const controls = [];
    if (show('search')) {
      const input = `<input ${show('scan') ? '' : 'class="search" '}type="search" id="q" placeholder="Titre, auteur, éditeur, ISBN${canManage() ? ', code' : ''}…" value="${esc(c.q)}">`;
      // Bouton de scan du code-barres ISBN a cote de la recherche (au choix dans les Reglages).
      controls.push(['search', 'Recherche', show('scan')
        ? `<span class="search search-scan">${input}<button class="btn" type="button" id="q-scan" title="Scanner le code-barres ISBN">Scan ISBN</button></span>`
        : input]);
    }
    if (show('category') && cats.some((x) => x.count > 0)) controls.push(['category', 'Catégorie', '<input type="search" id="cat" placeholder="Toutes les catégories">']);
    if (show('collection') && collections.length) controls.push(['collection', 'Collection', '<input type="search" id="coll" placeholder="Toutes les collections">']);
    if (show('series') && seriesList.length) controls.push(['series', 'Série', '<input type="search" id="seriesf" placeholder="Toutes les séries">']);
    if (show('tag') && tags.some((t) => t.count)) controls.push(['tag', 'Tag', '<input type="search" id="tagf" placeholder="Tous les tags">']);
    if (canManage() && show('mine')) {
      controls.push(['mine', '', `<label class="check filter-check"><input type="checkbox" id="mine" ${c.mine ? 'checked' : ''}> Mes livres</label>`]);
    }
    if (withReader && members.length) {
      controls.push(['reader', 'Lecteur', `<select id="reader">
        <option value="">Tous les lecteurs</option>
        ${members.map((m) => `<option value="${m.id}" ${sel(c.reader, String(m.id))}>Lecteur : ${m.id === state.user.id ? 'moi' : esc(m.username)}</option>`).join('')}</select>`]);
    }
    if (show('availability')) {
      controls.push(['availability', 'Disponibilité', `<select id="status">
        <option value="">Tous les livres</option>
        <option value="available" ${sel(c.status, 'available')}>Disponibles</option>
        <option value="onloan" ${sel(c.status, 'onloan')}>En prêt</option></select>`]);
    }
    if (show('format') && features().ebooks) {
      controls.push(['format', 'Type', `<select id="format">
        <option value="">Papier et numérique</option>
        <option value="physical" ${sel(c.format, 'physical')}>Livres papier</option>
        <option value="ebook" ${sel(c.format, 'ebook')}>Livres numériques</option></select>`]);
    }
    if (withStatus) {
      controls.push(['status-user', 'Statuts de lecture', `<select id="status-user" title="Statuts de lecture de…">
        ${members.map((m) => `<option value="${m.id}" ${String(m.id) === c.statusUser ? 'selected' : ''}>${m.id === state.user.id ? 'Mes statuts' : 'Statuts de ' + esc(m.username)}</option>`).join('')}</select>`]);
    }
    if (statusesOn() && show('reading')) {
      controls.push(['reading', withStatus ? '' : 'Lecture', `<select id="reading">
        <option value="">Lecture : tous</option>
        <option value="to_read" ${sel(c.reading, 'to_read')}>À lire</option>
        <option value="reading" ${sel(c.reading, 'reading')}>En cours</option>
        <option value="read" ${sel(c.reading, 'read')}>Lu</option>
        <option value="abandoned" ${sel(c.reading, 'abandoned')}>Abandonné</option>
        <option value="none" ${sel(c.reading, 'none')}>Sans statut</option></select>`]);
    }
    if (statusesOn() && show('opinion')) {
      controls.push(['opinion', withStatus || show('reading') ? '' : 'Avis', `<select id="opinion">
        <option value="">Avis : tous</option>
        <option value="liked" ${sel(c.opinion, 'liked')}>Aimé</option>
        <option value="disliked" ${sel(c.opinion, 'disliked')}>Pas aimé</option></select>`]);
    }
    if (statusesOn() && show('rating')) {
      controls.push(['rating', withStatus || show('reading') || show('opinion') ? '' : 'Note', `<select id="rating">
        <option value="">Note : toutes</option>
        ${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${sel(c.rating, String(n))}>${'★'.repeat(n)}${n < 5 ? ' et plus' : ''}</option>`).join('')}
        <option value="none" ${sel(c.rating, 'none')}>Pas noté</option></select>`]);
    }
    // Liseuse : filtre disponible quand une Kobo est branchee (scannee dans cette session).
    if (koboOn()) {
      controls.push(['kobo', 'Liseuse', `<select id="kobo-filter">
            <option value="">Liseuse : tous les livres</option>
            <option value="on" ${sel(c.kobo, 'on')}>Déjà sur ${esc(kobo.device.name)}</option>
            <option value="off" ${sel(c.kobo, 'off')}>Pas encore sur ${esc(kobo.device.name)}</option></select>`]);
    }
    if (show('sort')) {
      controls.push(['sort', 'Tri', `<select id="sort">
        <option value="title">Tri : titre</option>
        <option value="author" ${sel(c.sort, 'author')}>Tri : auteur</option>
        <option value="recent" ${sel(c.sort, 'recent')}>Tri : ajout récent</option>
        <option value="year" ${sel(c.sort, 'year')}>Tri : année</option></select>`]);
    }

    const toggle = controls.some(([k]) => k !== 'search') ? '<button class="btn filters-toggle" type="button" id="filters-toggle" aria-expanded="false">Filtres</button>' : '';
    const filtersHtml = (left
      ? controls.map(([k, label, html]) => `<div class="fgroup${k === 'search' ? ' fgroup-search' : ''}">${label ? `<label>${label}</label>` : ''}${html}</div>`)
      : controls.map(([, , html]) => html)).join('').replace(/^(<div class="fgroup fgroup-search">.*?<\/div>|<input class="search"[^>]*>|<span class="search search-scan">.*?<\/span>)?/, (m) => m + toggle);
    const results = '<div class="books" id="books"></div><div class="more" id="more"></div>';
    // Nombre de livres (au choix) : sous les filtres, en haut comme dans la colonne.
    const countHtml = show('count') ? '<p class="catalog-count" id="count"></p>' : '';
    let body = countHtml + results;
    if (left && (controls.length || countHtml)) body = `<div class="catalog-layout"><aside class="filters-side">${filtersHtml}${countHtml}</aside><div>${results}</div></div>`;
    else if (controls.length) body = `<div class="filters">${filtersHtml}</div>${countHtml}${results}`;
    view().innerHTML = `
      <div class="page-head">
        <div><h1>Catalogue</h1></div>
        ${canManage() ? '<div class="btn-row"><a class="btn hide-mobile" href="#/import">Ajout multiple</a><a class="btn btn-primary hide-mobile" href="#/add">+ Ajouter un livre</a></div>' : ''}
      </div>
      <div id="active-filters"></div>
      ${body}`;

    const reload = () => { c.page = 1; renderActive(); renderToggle(); loadBooks(false); };
    // Bouton "Filtres" (telephone) : nombre de filtres actifs.
    function renderToggle() {
      const btn = $('#filters-toggle');
      if (!btn) return;
      const n = ['category', 'collection', 'series', 'tag', 'mine', 'reader', 'status', 'format', 'reading', 'opinion', 'rating', 'kobo'].filter((k) => c[k]).length + (c.sort && c.sort !== 'title' ? 1 : 0);
      btn.textContent = n ? `Filtres · ${n}` : 'Filtres';
      btn.classList.toggle('btn-primary', n > 0);
    }
    if ($('#filters-toggle')) {
      renderToggle();
      $('#filters-toggle').onclick = () => {
        const box = $('#filters-toggle').parentNode;
        const open = box.classList.toggle('open');
        $('#filters-toggle').setAttribute('aria-expanded', String(open));
      };
    }
    // Filtre actif sans champ visible (ex. collection choisie depuis une fiche alors
    // que ce filtre est masque) : affiche en pastille pour pouvoir le retirer.
    function renderActive() {
      const chips = [];
      if (c.collection && !$('#coll')) chips.push(['collection', 'Collection : ' + c.collection]);
      if (c.series && !$('#seriesf')) chips.push(['series', 'Série : ' + c.series]);
      if (c.tag && !$('#tagf')) chips.push(['tag', 'Filtré par tag']);
      if (c.category && !$('#cat')) chips.push(['category', 'Filtré par catégorie']);
      if (c.missing && canManage()) chips.push(['missing', missingLabel(c.missing)]);
      $('#active-filters').innerHTML = chips.length
        ? `<div class="btn-row" style="margin-bottom:12px">${chips.map(([k, l]) => `<span class="chip">${esc(l)}<button type="button" data-clear="${k}" aria-label="Retirer">×</button></span>`).join('')}</div>`
        : '';
      $$('[data-clear]').forEach((b) => { b.onclick = () => { c[b.dataset.clear] = ''; reload(); }; });
    }
    renderActive();

    if ($('#q')) $('#q').addEventListener('input', debounce((e) => { c.q = e.target.value; reload(); }, 250));
    if ($('#q-scan')) {
      $('#q-scan').onclick = async () => {
        const isbn = await scanIsbn();
        if (!isbn || !$('#q')) return;
        $('#q').value = isbn;
        c.q = isbn;
        reload();
      };
    }
    if ($('#cat')) {
      searchPicker({
        input: $('#cat'),
        items: cats.filter((x) => x.count > 0).map((x) => ({ id: x.id, name: x.name, count: x.count })),
        value: c.category,
        onPick: (id) => { if (id !== (c.category || '')) { c.category = id; reload(); } },
      });
    }
    if ($('#tagf')) {
      searchPicker({
        input: $('#tagf'),
        items: tags.filter((t) => t.count > 0).map((t) => ({ id: t.id, name: '#' + t.name, count: t.count })),
        value: c.tag,
        onPick: (id) => { if (id !== (c.tag || '')) { c.tag = id; reload(); } },
      });
    }
    if ($('#coll')) {
      searchPicker({
        input: $('#coll'),
        items: collections.map((x) => ({ id: x.name, name: x.name, count: x.count })),
        value: c.collection,
        onPick: (name) => { if (name !== (c.collection || '')) { c.collection = name; reload(); } },
      });
    }
    if ($('#seriesf')) {
      searchPicker({
        input: $('#seriesf'),
        items: seriesList.map((x) => ({ id: x.name, name: x.name, count: x.count })),
        value: c.series,
        onPick: (name) => { if (name !== (c.series || '')) { c.series = name; reload(); } },
      });
    }
    if (canManage()) bindSelection(reload);
    if ($('#mine')) $('#mine').onchange = (e) => { c.mine = e.target.checked; reload(); };
    [['#kobo-filter', 'kobo'], ['#status', 'status'], ['#sort', 'sort'], ['#format', 'format'], ['#reader', 'reader'], ['#status-user', 'statusUser'], ['#reading', 'reading'], ['#opinion', 'opinion'], ['#rating', 'rating']].forEach(([selector, key]) => {
      const el = $(selector);
      if (el) el.addEventListener('change', (e) => { c[key] = e.target.value; reload(); });
    });
    await loadBooks(false);
  }

  // Selection de plusieurs livres (gestion) : bouton "Selectionner" (grand ecran) ou
  // appui long sur une couverture, puis clic sur les couvertures, ou "Tout
  // sélectionner" = tous les livres du filtre en cours ; puis modification ou
  // suppression en masse.
  function bindSelection(reload) {
    const head = $('.page-head .btn-row');
    if (!head) return;
    head.insertAdjacentHTML('afterbegin', '<button class="btn hide-mobile" type="button" id="select-toggle">Sélectionner</button>');
    document.body.insertAdjacentHTML('beforeend', `<div class="select-bar" id="select-bar" hidden>
      <strong id="select-count"></strong>
      <button class="btn btn-small" type="button" id="select-all">Tout sélectionner</button>
      <button class="btn btn-small" type="button" id="select-none">Aucun</button>
      <button class="btn btn-small btn-primary" type="button" id="select-edit">Modifier</button>
      ${koboOn() ? '<button class="btn btn-small" type="button" id="select-kobo">Envoyer sur la liseuse</button>' : ''}
      <button class="btn btn-small btn-danger" type="button" id="select-delete">Supprimer</button>
      <button class="btn btn-small" type="button" id="select-done" style="margin-left:auto">Terminer</button>
    </div>`);
    const bar = $('#select-bar');
    pageCleanup = () => bar.remove();
    const refreshBar = () => {
      const n = state.selected.size;
      $('#select-count').textContent = `${n} livre${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`;
      $('#select-delete').disabled = !n;
      $('#select-edit').disabled = !n;
      if ($('#select-kobo')) $('#select-kobo').disabled = !n;
    };
    const setMode = (on, firstId) => {
      state.selecting = on;
      if (!on) state.selected.clear();
      if (on && firstId) state.selected.add(firstId);
      bar.hidden = !on;
      document.body.classList.toggle('selecting', on);
      $('#select-toggle').classList.toggle('btn-primary', on);
      refreshBar();
      loadBooks(false);
    };
    $('#select-toggle').onclick = () => setMode(!state.selecting);
    $('#select-done').onclick = () => setMode(false);
    $('#select-none').onclick = () => { state.selected.clear(); refreshBar(); loadBooks(false); };
    $('#select-all').onclick = async () => {
      try {
        const { ids } = await api(`/api/books?${catalogParams({ ids: '1' })}`);
        ids.forEach((id) => state.selected.add(id));
        refreshBar();
        loadBooks(false);
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#select-delete').onclick = async () => {
      const n = state.selected.size;
      if (!n || !confirm(`Supprimer définitivement ${n} livre(s), leurs exemplaires et leur historique de prêts ?\nLes livres dont un exemplaire est en prêt seront conservés.`)) return;
      try {
        const r = await api('/api/books/bulk-delete', { method: 'POST', body: { ids: Array.from(state.selected) } });
        toast(`${r.deleted} livre(s) supprimé(s).${r.onLoan ? ` ${r.onLoan} conservé(s) : exemplaire en prêt.` : ''}`);
        state.selected.clear();
        refreshBar();
        reload();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#select-edit').onclick = () => bulkEditDialog(Array.from(state.selected), () => { refreshBar(); reload(); });
    const selKobo = $('#select-kobo');
    if (selKobo) selKobo.onclick = busy(async (btn) => {
      const ids = Array.from(state.selected);
      try {
        const r = await pushManyToKobo(ids, (n) => { btn.textContent = `Envoi ${n} / ${ids.length}…`; });
        toast(`${r.sent} livre(s) envoyé(s)${r.already ? `, ${r.already} déjà sur la liseuse` : ''}${r.skipped ? `, ${r.skipped} sans fichier ou sans droit` : ''}.`
          + (r.sent ? (kobo && kobo.write ? ' Éjecte la liseuse pour qu\'elle les importe.' : ' Copie les fichiers téléchargés sur la liseuse.') : ''));
        reload();
      } finally { btn.textContent = 'Envoyer sur la liseuse'; }
    });
    // Appui long sur une couverture : active la selection avec ce livre (le clic
    // qui suit est ignore). Menu contextuel du navigateur neutralise sur les couvertures.
    let pressTimer = null;
    let pressed = false;
    const books = $('#books');
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
    books.addEventListener('pointerdown', (e) => {
      const card = e.target.closest('.book-card');
      if (!card || state.selecting || (e.pointerType === 'mouse' && e.button !== 0)) return;
      pressed = false;
      cancelPress();
      const x = e.clientX;
      const y = e.clientY;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        pressed = true;
        if (navigator.vibrate) navigator.vibrate(30);
        setMode(true, Number(card.dataset.id));
      }, 550);
      card.addEventListener('pointermove', function move(ev) {
        if (Math.abs(ev.clientX - x) > 10 || Math.abs(ev.clientY - y) > 10) { cancelPress(); card.removeEventListener('pointermove', move); }
      });
    });
    // Le clic qui suit l'appui long arrive juste apres le relachement : au-dela, il n'est plus ignore.
    ['pointerup', 'pointercancel'].forEach((t) => books.addEventListener(t, () => { cancelPress(); if (pressed) setTimeout(() => { pressed = false; }, 400); }));
    books.addEventListener('contextmenu', (e) => { if (e.target.closest('.book-card')) e.preventDefault(); });
    // En mode selection, un clic sur une couverture la (de)selectionne au lieu d'ouvrir la fiche.
    $('#books').addEventListener('click', (e) => {
      if (pressed) { pressed = false; e.preventDefault(); return; }
      if (!state.selecting) return;
      const card = e.target.closest('.book-card');
      if (!card) return;
      e.preventDefault();
      const id = Number(card.dataset.id);
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      card.classList.toggle('selected', state.selected.has(id));
      refreshBar();
    });
  }

  // Modification en masse des livres selectionnes : seuls les champs coches ou
  // choisis sont appliques, apres confirmation recapitulative.
  async function bulkEditDialog(ids, done) {
    if (!ids.length) return;
    const f = features();
    const [cats, tags, seriesList, collections, members] = await Promise.all([
      loadCategories().catch(() => []),
      f.tags ? api('/api/public/tags').catch(() => []) : [],
      api('/api/public/series').catch(() => []),
      api('/api/public/collections').catch(() => []),
      loadMembers().catch(() => []),
    ]);
    const memberOptions = members.map((m) => [m.id, m.id === state.user.id ? 'Moi' : esc(m.username)]);
    const dl = (id, list) => `<datalist id="${id}">${list.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>`;
    const text = (key, label, list, hint) => `<div class="bulk-row">
        <label class="bulk-check"><input type="checkbox" data-on="${key}"> <strong>${label}</strong></label>
        <input name="${key}" list="bl-${key}" disabled placeholder="${hint}">${dl('bl-' + key, list)}</div>`;
    const choice = (key, label, options) => `<div class="bulk-row">
        <label for="bk-${key}"><strong>${label}</strong></label>
        <select name="${key}" id="bk-${key}"><option value="">Ne pas modifier</option>${options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>`;
    const n = ids.length;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <form class="modal bulk-edit">
        <h2>Modifier ${n} livre${n > 1 ? 's' : ''} ${hint('Coche ou choisis seulement ce qui doit changer. Série ou collection cochée et laissée vide : retirée.')}</h2>
        ${text('series', 'Série', seriesList, 'Nom de la série (vide = retirer)')}
        ${text('collection', 'Collection', collections, 'Nom de la collection (vide = retirer)')}
        ${text('categoriesAdd', 'Ajouter des catégories', cats, 'Séparées par des virgules')}
        ${text('categoriesRemove', 'Retirer des catégories', cats, 'Séparées par des virgules')}
        ${f.tags ? text('tagsAdd', 'Ajouter des tags', tags, 'Séparés par des virgules') + text('tagsRemove', 'Retirer des tags', tags, 'Séparés par des virgules') : ''}
        ${members.length ? choice('readersAdd', 'Ajouter un lecteur', memberOptions) + choice('readersRemove', 'Retirer un lecteur', memberOptions) : ''}
        ${f.ebooks ? choice('ebook', 'Type', [['add', 'Ajouter la version numérique'], ['remove', 'Retirer la version numérique']]) : ''}
        ${statusesOn() ? choice('reading', 'Mon statut de lecture', [['none', 'Aucun'], ...Object.entries(READING_LABELS)])
          + choice('opinion', 'Mon avis', [['none', 'Aucun'], ...Object.entries(OPINION_LABELS)]) : ''}
        <div class="btn-row" style="margin-top:14px">
          <button class="btn btn-primary" type="submit">Appliquer…</button>
          <button class="btn" type="button" data-close>Annuler</button>
        </div>
      </form>`;
    document.body.appendChild(backdrop);
    const form = $('form', backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(); });
    $$('[data-on]', form).forEach((cb) => {
      cb.onchange = () => { const input = form[cb.dataset.on]; input.disabled = !cb.checked; if (cb.checked) input.focus(); };
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const changes = {};
      const lines = [];
      const list = (v) => v.split(/[,;|]/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean);
      $$('[data-on]', form).forEach((cb) => {
        if (!cb.checked) return;
        const key = cb.dataset.on;
        const v = form[key].value.trim();
        const label = cb.parentNode.textContent.trim();
        if (key === 'series' || key === 'collection') {
          changes[key] = v;
          lines.push(`• ${label} : ${v ? `« ${v} »` : 'retirée'}`);
        } else if (list(v).length) {
          changes[key] = list(v);
          lines.push(`• ${label} : ${list(v).join(', ')}`);
        }
      });
      $$('select', form).forEach((sel) => {
        if (!sel.value) return;
        changes[sel.name] = sel.value === 'none' ? '' : sel.value;
        lines.push(`• ${sel.previousElementSibling.textContent.trim()} : ${sel.options[sel.selectedIndex].text}`);
      });
      if (!lines.length) { toast('Aucune modification choisie.', 'error'); return; }
      if (!confirm(`Appliquer ces modifications à ${n} livre${n > 1 ? 's' : ''} ?\n\n${lines.join('\n')}`)) return;
      try {
        const r = await api('/api/books/bulk-edit', { method: 'POST', body: { ids, changes } });
        close();
        toast(`${r.updated} livre${r.updated > 1 ? 's' : ''} modifié${r.updated > 1 ? 's' : ''}.`);
        done();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // Note sur 5 etoiles (lecture seule).
  const starsHtml = (n) => `<span class="stars" title="${n} / 5">${'★'.repeat(n)}<span class="stars-off">${'★'.repeat(5 - n)}</span></span>`;

  function statusIcons(s) {
    if (!s || (!s.reading && !s.opinion)) return '';
    return `<span class="status-icons">${s.reading ? `<span class="st st-${s.reading}">${READING_LABELS[s.reading]}</span>` : ''}${s.opinion ? `<span class="st st-${s.opinion}" title="${OPINION_LABELS[s.opinion]}">${OPINION_ICONS[s.opinion]}</span>` : ''}</span>`;
  }

  // Parametres de recherche du catalogue (filtres en cours) ; extra : ex. ids=1.
  function catalogParams(extra = {}) {
    const c = state.catalog;
    const withStatus = statusesOn();
    // Un filtre masque dans les Reglages ne filtre plus (sauf collection / tag /
    // categorie choisis depuis une fiche : affiches en pastille, retirables).
    const show = (k) => catalogConf().filters.includes(k);
    const params = new URLSearchParams({
      q: show('search') ? c.q : '', category: c.category || '', status: show('availability') ? c.status || '' : '',
      sort: show('sort') ? c.sort : 'title', page: c.page, limit: 48,
    });
    if (c.collection) params.set('collection', c.collection);
    if (c.series) params.set('series', c.series);
    if (c.missing && canManage()) params.set('missing', c.missing);
    if (features().tags && c.tag) params.set('tag', c.tag);
    if (canManage() && c.reader && show('reader')) params.set('reader', c.reader);
    if (canManage() && c.mine && show('mine')) params.set('mine', '1');
    if (features().ebooks && c.format && show('format')) params.set('format', c.format);
    if (koboOn() && c.kobo) {
      params.set('kobo', c.kobo);
      params.set('koboDevice', kobo.device.id);
    }
    if (withStatus) {
      // Statuts affiches sur les couvertures : ceux du compte choisi (le sien par defaut).
      params.set('statusUser', show('statusUser') ? c.statusUser || '' : String(state.user.id));
      if (show('reading') && c.reading) params.set('reading', c.reading);
      if (show('opinion') && c.opinion) params.set('opinion', c.opinion);
      if (show('rating') && c.rating) params.set('rating', c.rating);
    }
    Object.entries(extra).forEach(([k, v]) => params.set(k, v));
    return params;
  }

  async function loadBooks(append) {
    const c = state.catalog;
    const withStatus = statusesOn();
    const data = await api(`/api/${canManage() ? 'books' : 'public/books'}?${catalogParams()}`);
    const list = $('#books');
    if (!list) return;
    // Elements de la miniature choisis dans les Reglages.
    const card = new Set(catalogConf().card);
    const has = (k) => card.has(k);
    const ribbon = (b) => has('ebook') && features().ebooks && b.ebookCopies > 0 ? 'Numérique' : '';
    const html = data.items.map((b) => {
      const meta = [
        has('title') ? `<span class="t">${esc(b.title)}</span>` : '',
        has('authors') ? `<span class="a">${esc(b.authors)}</span>` : '',
        has('series') && b.series ? `<span class="coll">${esc(b.series)}${b.seriesNumber ? ' · tome ' + esc(b.seriesNumber) : ''}</span>` : '',
        has('collection') && b.collection ? `<span class="coll coll-muted">${esc(b.collection)}</span>` : '',
        has('categories') && b.categories && b.categories.length ? `<span class="card-terms">${b.categories.map((t) => `<span class="term">${esc(t.name)}</span>`).join('')}</span>` : '',
        has('tags') && features().tags && b.tags && b.tags.length ? `<span class="card-terms">${b.tags.map((t) => `<span class="term term-tag">#${esc(t.name)}</span>`).join('')}</span>` : '',
        has('readers') && b.readers && b.readers.length ? `<span class="card-terms">${b.readers.map((u) => `<span class="term term-reader">${esc(u.username)}</span>`).join('')}</span>` : '',
        withStatus && has('status') ? statusIcons(b.status) : '',
        withStatus && has('rating') && b.status && b.status.rating ? starsHtml(b.status.rating) : '',
        has('availability') ? availabilityBadge(b, false) : '',
      ].join('');
      // Sans couverture, le bandeau "Numerique" passe en pastille.
      const ebookBadge = !has('cover') && ribbon(b) ? '<span class="badge badge-ebook">Numérique</span>' : '';
      return `
      <a class="book-card${state.selecting ? ' selectable' : ''}${state.selecting && state.selected.has(b.id) ? ' selected' : ''}" href="#/book/${b.id}" data-id="${b.id}">
        ${state.selecting ? '<span class="select-check" aria-hidden="true"></span>' : ''}
        ${has('cover') ? coverHtml(b, ribbon(b)) : ''}
        ${meta || ebookBadge ? `<div class="meta">${meta}${ebookBadge}</div>` : ''}
      </a>`;
    }).join('');
    const filtered = c.missing || c.q || c.category || c.tag || c.mine || c.reader || c.collection || c.series || c.status || c.format || c.reading || c.opinion || c.rating;
    if (append) list.insertAdjacentHTML('beforeend', html);
    else list.innerHTML = html || `<div class="empty" style="grid-column:1/-1">${filtered ? 'Aucun livre ne correspond.' : 'Le catalogue est vide pour le moment.'}</div>`;
    if ($('#count')) $('#count').textContent = `${data.total} livre${data.total > 1 ? 's' : ''}`;
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
      ['Collection', book.collection ? `<a href="#/" data-collection="${esc(book.collection)}">${esc(book.collection)}</a>` : ''],
      ['Série', book.series ? `<a href="#/" data-series="${esc(book.series)}">${esc(book.series)}</a>${book.seriesNumber ? ` · tome ${esc(book.seriesNumber)}` : ''}` : ''],
      ['Année', book.year || ''],
      ['Pages', book.pages || ''],
      ['ISBN', esc(book.isbn)],
      ['Catégories', book.categories.map((c) => `<span class="chip">${esc(c.name)}</span>`).join('')],
      ['Tags', (book.tags || []).map((t) => `<a href="#/" class="chip chip-tag" data-tag="${t.id}">#${esc(t.name)}</a>`).join('')],
    ].filter(([, v]) => v);
    view().innerHTML = `
      ${koboReturn && koboReturn.bookId === book.id
        ? `<div class="btn-row" style="margin-bottom:12px"><a class="btn btn-primary" href="#/kobo/${koboReturn.deviceId}">← Retour à la liseuse ${esc(koboReturn.name)}</a></div>`
        : '<p><a href="#/">← Catalogue</a></p>'}
      <div class="book-detail">
        <div>${coverHtml(book)}</div>
        <div>
          <h1>${esc(book.title)}</h1>
          ${book.subtitle ? `<div class="subtitle">${esc(book.subtitle)}</div>` : ''}
          ${availabilityBadge(book)}
          ${manage ? readersHtml(book) : ''}
          ${manage && book.myStatus ? statusEditorHtml(book) : ''}
          <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
          ${book.summary ? `<h3>Résumé</h3><p class="summary">${esc(book.summary)}</p>` : ''}
          ${manage && book.notes ? `<h3>Notes internes</h3><p class="summary muted">${esc(book.notes)}</p>` : ''}
          ${manage ? `<div class="btn-row" style="margin-top:14px">
              <a class="btn" href="#/book/${book.id}/edit">Modifier</a>
              ${koboOn() && book.ebookFile && book.ebookFile.download ? `<button class="btn" id="push-kobo" title="${esc(kobo.device.name)}">Envoyer sur ma liseuse</button>` : ''}
              <button class="btn btn-danger" id="del-book">Supprimer</button>
            </div>` : ''}
        </div>
      </div>
      <h2>Exemplaires</h2>
      <div class="card" id="copies">${manage ? adminCopiesHtml(book) : publicCopiesHtml(book)}</div>
      ${manage ? `<div id="reservations">${reservationsHtml(book)}</div>` : ''}
      ${manage && book.history.length ? `<h2>Historique des prêts</h2><div class="card table-wrap">${historyHtml(book.history)}</div>` : ''}`;
    if (manage) { bindAdminBook(book); bindReservations(book); }
    const push = $('#push-kobo');
    if (push) push.onclick = busy(() => pushToKobo(book.id));
    if (manage) bindReaders(book);
    if (manage && book.myStatus) bindStatusEditor(book);
    // Tag : catalogue filtre sur ce tag.
    $$('[data-tag]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        Object.assign(state.catalog, { q: '', category: '', collection: '', series: '', status: '', format: '', reading: '', opinion: '', rating: '', mine: false, reader: '', tag: a.dataset.tag, page: 1 });
        go('#/');
      };
    });
    // Liens "collection" et "serie" : catalogue filtre (une serie dans l'ordre des tomes).
    $$('[data-collection], [data-series]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        Object.assign(state.catalog, { q: '', category: '', tag: '', status: '', format: '', reading: '', opinion: '', rating: '', mine: false, reader: '',
          collection: a.dataset.collection || '', series: a.dataset.series || '', page: 1 });
        go('#/');
      };
    });
  }

  // Lecteurs du livre (comptes membres) avec leur statut de lecture. Sur la fiche :
  // bouton "Interesse" pour soi ; les autres lecteurs se choisissent dans "Modifier".
  // Le statut de lecture n'y touche jamais.
  // Reservations d'un livre au nom d'emprunteurs, saisies par un compte connecte :
  // possible quand tous les exemplaires papier sont pretes ; alerte au retour.
  function reservationsHtml(book) {
    const list = book.reservations || [];
    const physical = book.copies.filter((c) => c.format !== 'ebook');
    const canReserve = physical.length > 0 && physical.every((c) => c.loan);
    if (!list.length && !canReserve) return '';
    return `<div class="card" style="margin-top:12px">
      <strong>Réservations ${hint('Au nom d\'un emprunteur. Quand un exemplaire revient, une alerte propose de le prêter à la première personne de la liste ; le prêt retire sa réservation.')}</strong>
      ${list.length ? `<div class="list">${list.map((r, i) => `<div class="list-item">
        <div class="grow">${i + 1}. <a href="#/borrower/${r.borrower.id}"><strong>${esc(r.borrower.name)}</strong></a> <span class="small muted">le ${fmtDate(r.createdAt)}</span></div>
        <button class="btn btn-small" type="button" data-del-res="${r.id}">Retirer</button>
      </div>`).join('')}</div>` : ''}
      ${canReserve ? `<form class="isbn-row" id="reserve-form" style="margin-top:10px">
        <input name="borrower" list="reserve-borrowers" placeholder="Emprunteur (nouveau créé automatiquement)" autocomplete="off" required>
        <datalist id="reserve-borrowers"></datalist>
        <button class="btn btn-primary" type="submit">Réserver</button>
      </form>` : ''}
    </div>`;
  }

  function bindReservations(book) {
    const box = $('#reservations');
    if (!box) return;
    const update = (list) => { book.reservations = list; box.innerHTML = reservationsHtml(book); bindReservations(book); };
    const form = $('#reserve-form', box);
    if (form) {
      let borrowers = [];
      api('/api/borrowers').then((list) => {
        borrowers = list;
        $('#reserve-borrowers', box).innerHTML = list.map((b) => `<option value="${esc(b.name)}">`).join('');
      }).catch(() => {});
      form.onsubmit = async (e) => {
        e.preventDefault();
        const name = form.borrower.value.trim();
        const match = borrowers.find((b) => b.name.toLowerCase() === name.toLowerCase());
        try {
          update(await api(`/api/books/${book.id}/reservations`, { method: 'POST', body: { borrowerId: match ? match.id : null, borrowerName: name } }));
          toast(`Réservé pour ${name}.`);
        } catch (err) { toast(err.message, 'error'); }
      };
    }
    $$('[data-del-res]', box).forEach((btn) => {
      btn.onclick = async () => {
        try { update(await api(`/api/reservations/${btn.dataset.delRes}`, { method: 'DELETE' })); } catch (err) { toast(err.message, 'error'); }
      };
    });
  }

  function readersHtml(book) {
    const readers = book.readers || [];
    const statusOf = (u) => {
      const s = u.id === state.user.id ? book.myStatus : (book.statuses || []).find((o) => o.userId === u.id);
      return s && s.reading ? ` · ${READING_LABELS[s.reading]}` : '';
    };
    const mine = readers.some((r) => r.id === state.user.id);
    return `<div class="readers-box" id="readers">
      <button type="button" class="pill ${mine ? 'on pill-reader' : ''}" id="reader-me" title="${mine ? 'Ne plus être lecteur de ce livre' : 'Devenir lecteur de ce livre'}">${mine ? '✓ Intéressé' : 'Intéressé'}</button>
      ${readers.length ? `<span class="small muted">Lecteurs</span>
        ${readers.map((u) => `<span class="chip chip-reader">${u.id === state.user.id ? 'Moi' : esc(u.username)}${statusesOn() ? esc(statusOf(u)) : ''}</span>`).join('')}` : ''}
    </div>`;
  }

  function bindReaders(book) {
    $('#reader-me').onclick = async () => {
      const mine = (book.readers || []).some((r) => r.id === state.user.id);
      try {
        book.readers = await api(`/api/books/${book.id}/readers${mine ? '/' + state.user.id : ''}`,
          mine ? { method: 'DELETE' } : { method: 'POST', body: { userId: state.user.id } });
        $('#readers').outerHTML = readersHtml(book);
        bindReaders(book);
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // Statuts de lecture (propres a chaque compte) : A lire / En cours / Lu /
  // Abandonne, et Aime / Pas aime. Un clic sur le statut actif le retire. Les dates
  // (debut, fin, abandon) sont enregistrees automatiquement et corrigeables.
  const day = (s) => (s ? s.slice(0, 10) : '');
  const daysBetween = (a, b) => Math.max(0, Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000));

  function statusEditorHtml(book) {
    const s = book.myStatus;
    const btn = (group, value, label) => `<button type="button" class="pill ${s[group] === value ? 'on pill-' + value : ''}" data-${group}="${value}">${label}</button>`;
    const others = (book.statuses || []).map((o) => `<span class="small">${esc(o.username)} : ${[o.reading && READING_LABELS[o.reading], o.opinion && OPINION_LABELS[o.opinion]].filter(Boolean).join(', ')}${o.rating ? ' ' + starsHtml(o.rating) : ''}</span>`);
    const dateField = (field, label) => `<label class="date-field">${label} <input type="date" data-date="${field}" value="${day(s[field])}" max="${new Date().toISOString().slice(0, 10)}"></label>`;
    let dates = '';
    if (s.reading === 'reading') dates = dateField('startedAt', 'Commencé le');
    if (s.reading === 'read') {
      dates = dateField('startedAt', 'Commencé le') + dateField('finishedAt', 'Terminé le')
        + (s.startedAt && s.finishedAt ? `<span class="small muted">${daysBetween(s.startedAt, s.finishedAt)} jour(s) de lecture</span>` : '');
    }
    if (s.reading === 'abandoned') dates = dateField('startedAt', 'Commencé le') + dateField('abandonedAt', 'Abandonné le');
    return `<div class="status-editor">
      <div class="btn-row">
        <span class="small muted">Ma lecture</span>${btn('reading', 'to_read', 'À lire')}${btn('reading', 'reading', 'En cours')}${btn('reading', 'read', 'Lu')}${btn('reading', 'abandoned', 'Abandonné')}
      </div>
      ${dates ? `<div class="btn-row status-dates">${dates}</div>` : ''}
      <div class="btn-row" style="margin-top:6px">
        <span class="small muted">Mon avis</span>${btn('opinion', 'liked', '♥ Aimé')}${btn('opinion', 'disliked', '✕ Pas aimé')}
      </div>
      <div class="btn-row star-input" style="margin-top:6px">
        <span class="small muted">Ma note</span>${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star${s.rating >= n ? ' on' : ''}" data-rating="${n}" title="${n} / 5" aria-label="${n} étoile${n > 1 ? 's' : ''}">★</button>`).join('')}
      </div>
      ${others.length ? `<div class="others">${others.join(' · ')}</div>` : ''}
    </div>`;
  }

  function bindStatusEditor(book) {
    const save = async (body) => {
      try {
        book.myStatus = await api(`/api/books/${book.id}/status`, { method: 'PUT', body });
        $('.status-editor').outerHTML = statusEditorHtml(book);
        bindStatusEditor(book);
        if ($('#readers')) { $('#readers').outerHTML = readersHtml(book); bindReaders(book); }
      } catch (err) { toast(err.message, 'error'); }
    };
    $$('.status-editor [data-reading], .status-editor [data-opinion]').forEach((btn) => {
      btn.onclick = () => {
        const group = btn.dataset.reading ? 'reading' : 'opinion';
        const value = btn.dataset[group];
        const s = book.myStatus;
        save({ reading: s.reading, opinion: s.opinion, [group]: s[group] === value ? null : value });
      };
    });
    // Note : un clic sur la note actuelle la retire.
    $$('.status-editor [data-rating]').forEach((btn) => {
      btn.onclick = () => {
        const n = Number(btn.dataset.rating);
        save({ reading: book.myStatus.reading, opinion: book.myStatus.opinion, rating: book.myStatus.rating === n ? null : n });
      };
    });
    // Correction d'une date (ex. livre commence avant de l'enregistrer).
    $$('.status-editor [data-date]').forEach((input) => {
      input.onchange = () => {
        const s = book.myStatus;
        save({ reading: s.reading, opinion: s.opinion, [input.dataset.date]: input.value || null });
      };
    });
  }

  // Fichier epub de l'exemplaire numerique : droits (voir, lire, telecharger) regles dans
  // les reglages de la bibliotheque.
  const FILE_LEVELS = [['public', 'Tout le monde (même sans connexion)'], ['members', 'Comptes de la bibliothèque'], ['managers', 'Gestionnaires'], ['admin', 'Administrateurs']];
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

  // Presence du fichier et boutons selon les droits du visiteur (book.ebookFile).
  function ebookFileHtml(book) {
    const f = book.ebookFile;
    if (!f) return '';
    return `<div class="ebook-file"><span class="small muted">Fichier epub · ${fmtSize(f.size)}</span>
      ${f.read ? `<a class="btn btn-small btn-primary" href="#/read/${book.id}">Lire</a>` : ''}
      ${f.download ? `<a class="btn btn-small" href="${esc(LIB)}/api/public/books/${book.id}/epub?download=1" download>Télécharger</a>` : ''}</div>`;
  }

  function publicCopiesHtml(book) {
    if (!book.copies.length && !book.ebookCopies) return '<p class="muted">Aucun exemplaire.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>Exemplaire</th><th>Emplacement</th><th>État</th></tr></thead><tbody>
      ${book.copies.map((c) => `<tr><td class="code">${esc(c.code)}</td><td>${esc(c.location) || '<span class="muted">—</span>'}</td>
        <td>${c.reserved ? '<span class="badge badge-reserved">Réservé</span>' : c.available ? '<span class="badge badge-ok">Disponible</span>' : '<span class="badge badge-warn">Emprunté</span>'}</td></tr>`).join('')}
      ${book.ebookCopies ? `<tr><td><span class="badge badge-ebook">Numérique</span></td><td><span class="muted">—</span></td><td>${ebookFileHtml(book) || '<span class="small muted">Version numérique</span>'}</td></tr>` : ''}
    </tbody></table></div>`;
  }

  // Exemplaires papier (code, etiquette, pret) puis numerique (sans code ni pret).
  function adminCopiesHtml(book) {
    const physical = book.copies.filter((c) => c.format !== 'ebook');
    const hasEbook = book.copies.some((c) => c.format === 'ebook');
    const rows = book.copies.map((c) => (c.format === 'ebook' ? `
      <tr class="copy-ebook">
        <td><span class="badge badge-ebook">Numérique</span></td>
        <td>${esc(c.location) || '<span class="muted">—</span>'}${c.notes ? `<div class="small muted">${esc(c.notes)}</div>` : ''}</td>
        <td>${c.file ? ebookFileHtml(book) || `<span class="small muted">Fichier epub · ${fmtSize(c.file.size)}</span>`
          : '<span class="small muted">Pas de fichier</span>'}</td>
        <td><span class="small muted">Pas d'étiquette</span></td>
        <td style="text-align:right;white-space:nowrap"><button class="btn btn-small" data-edit-copy="${c.id}">Modifier</button></td>
      </tr>` : `
      <tr>
        <td class="code"><a href="#/c/${encodeURIComponent(c.code)}">${esc(c.code)}</a></td>
        <td>${esc(c.location) || '<span class="muted">—</span>'}</td>
        <td>${c.loan
          ? `<span class="badge badge-warn">Prêté</span> à <a href="#/borrower/${c.loan.borrower.id}">${esc(c.loan.borrower.name)}</a><div class="small muted">depuis le ${fmtDate(c.loan.loanedAt)}</div>`
          : c.reservedFor ? `<span class="badge badge-reserved">Réservé</span> pour <a href="#/borrower/${c.reservedFor.id}">${esc(c.reservedFor.name)}</a>`
          : '<span class="badge badge-ok">Disponible</span>'}</td>
        <td>${c.labelPrintedAt ? '<span class="small muted">imprimée</span>' : '<span class="badge badge-muted">à imprimer</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          <a class="btn btn-small ${c.loan ? 'btn-ok' : 'btn-primary'}" href="#/c/${encodeURIComponent(c.code)}">${c.loan ? 'Retour' : 'Prêter'}</a>
          <button class="btn btn-small" data-edit-copy="${c.id}">Modifier</button>
        </td>
      </tr>`)).join('');
    return `
      ${book.copies.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Code</th><th>Emplacement</th><th>État</th><th>Étiquette</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Aucun exemplaire.</p>'}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" id="add-copy">+ Exemplaire papier</button>
        ${features().ebooks && !hasEbook ? '<button class="btn" id="add-ebook">+ Exemplaire numérique</button>' : ''}
        ${physical.length && canConfigure() ? '<button class="btn" id="print-labels">Imprimer les étiquettes</button>' : ''}
      </div>`;
  }

  function historyHtml(history) {
    return `<div class="table-wrap"><table class="stack"><thead><tr><th>Exemplaire</th><th>Emprunteur</th><th>Prêté le</th><th>Rendu le</th></tr></thead><tbody>
      ${history.map((l) => `<tr><td class="code">${esc(l.code)}</td><td><a href="#/borrower/${l.borrower.id}">${esc(l.borrower.name)}</a></td>
        <td>${fmtDate(l.loanedAt)}</td><td>${l.returnedAt ? fmtDate(l.returnedAt) : '<span class="badge badge-warn">en cours</span>'}</td></tr>`).join('')}
    </tbody></table></div>`;
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
    const physical = book.copies.filter((c) => c.format !== 'ebook');
    const addCopy = $('#add-copy');
    if (addCopy) addCopy.onclick = async () => {
      const location = prompt("Emplacement du nouvel exemplaire papier (facultatif) :", (physical[0] && physical[0].location) || '');
      if (location === null) return;
      try {
        const r = await api(`/api/books/${book.id}/copies`, { method: 'POST', body: { count: 1, location } });
        toast(`Exemplaire ${r.codes[0]} créé.`);
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
    const addEbook = $('#add-ebook');
    if (addEbook) addEbook.onclick = () => editCopyDialog({
      id: null, bookId: book.id, format: 'ebook', location: '', notes: '', file: null,
    });
    const print = $('#print-labels');
    if (print) print.onclick = () => {
      state.labels = { mode: 'manual', manual: physical.map((c) => ({ code: c.code, title: book.title })) };
      go('#/labels');
    };
    $$('[data-edit-copy]').forEach((btn) => {
      btn.onclick = () => editCopyDialog(book.copies.find((c) => c.id === Number(btn.dataset.editCopy)));
    });
  }

  // Envoi brut du fichier (hors JSON) : nom d'origine dans l'en-tete X-File-Name.
  async function sendRaw(path, method, body, type, headers = {}) {
    const res = await fetch(LIB + path, { method, credentials: 'same-origin', body, headers: { 'Content-Type': type, ...headers } });
    let data = null;
    try { data = await res.json(); } catch (e) { /* reponse vide */ }
    if (!res.ok) throw new Error((data && data.error) || (res.status === 413 ? 'Fichier trop lourd.' : `Erreur ${res.status}`));
    return data;
  }

  async function uploadEpub(copyId, file) {
    if (file.size > 100 * 1024 * 1024) throw new Error('Fichier trop lourd (100 Mo max).');
    return sendRaw(`/api/copies/${copyId}/file`, 'PUT', file, 'application/epub+zip', { 'X-File-Name': encodeURIComponent(file.name) });
  }

  async function editCopyDialog(copy) {
    const locations = await api('/api/locations').catch(() => []);
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <form class="modal">
        <h2>${copy.format === 'ebook' ? (copy.id ? 'Exemplaire numérique' : 'Nouvel exemplaire numérique') : `Exemplaire <span class="code">${esc(copy.code)}</span>`}</h2>
        <div class="field"><label>${copy.format === 'ebook' ? 'Emplacement du fichier' : 'Emplacement'}</label><input name="location" list="loc-list" value="${esc(copy.location)}">
          <datalist id="loc-list">${locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></div>
        <div class="field"><label>Notes (état, provenance…)</label><textarea name="notes" style="min-height:80px">${esc(copy.notes)}</textarea></div>
        ${copy.format === 'ebook' ? `
        <div class="field"><label>Fichier epub ${hint('Facultatif (100 Mo max). Un nouveau fichier remplace le précédent.')}</label>
          ${copy.file ? `<div class="small" style="margin-bottom:6px">${esc(copy.file.name)} · ${fmtSize(copy.file.size)}
            <label class="check" style="display:inline-flex;margin-left:10px"><input type="checkbox" name="removeFile"> Retirer</label></div>` : ''}
          <input type="file" name="file" accept=".epub,application/epub+zip"></div>` : ''}
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Enregistrer</button>
          <button class="btn" type="button" data-close>Annuler</button>
          ${copy.id ? '<button class="btn btn-danger" type="button" data-delete style="margin-left:auto">Supprimer</button>' : ''}
        </div>
      </form>`;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(); });
    if (copy.id) $('[data-delete]', backdrop).onclick = async () => {
      if (!confirm(copy.format === 'ebook' ? "Supprimer l'exemplaire numérique ?" : `Supprimer l'exemplaire ${copy.code} et son historique de prêts ?`)) return;
      try { await api(`/api/copies/${copy.id}`, { method: 'DELETE' }); close(); toast('Exemplaire supprimé.'); route(); } catch (err) { toast(err.message, 'error'); }
    };
    $('form', backdrop).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const submit = $('[type=submit]', f);
      submit.disabled = true;
      try {
        let id = copy.id;
        if (!id) {
          const r = await api(`/api/books/${copy.bookId}/copies`, { method: 'POST', body: { format: 'ebook', location: f.location.value } });
          id = r.book.copies.find((c) => c.format === 'ebook').id;
        }
        await api(`/api/copies/${id}`, { method: 'PUT', body: { location: f.location.value, notes: f.notes.value } });
        const file = f.file && f.file.files[0];
        if (file) {
          submit.textContent = 'Envoi du fichier…';
          await uploadEpub(id, file);
        } else if (f.removeFile && f.removeFile.checked) {
          await api(`/api/copies/${id}/file`, { method: 'DELETE' });
        }
        close();
        toast(copy.id ? 'Exemplaire mis à jour.' : 'Exemplaire numérique ajouté.');
        route();
      } catch (err) {
        toast(err.message, 'error');
        submit.disabled = false;
        submit.textContent = 'Enregistrer';
      }
    };
  }

  // ================= Liseuses Kobo (USB) =================
  // La liseuse branchee est lue par le navigateur. Chrome (et Edge) : dossier ouvert en
  // lecture/ecriture (File System Access). Ailleurs (Firefox) : dossier choisi par un
  // champ "repertoire", en lecture seule ; les envois deviennent des telechargements.
  const KOBO_FS = typeof window.showDirectoryPicker === 'function';
  // Smartphone (ecran tactile sans souris, petit cote < 600 px) : pas de liseuse
  // branchee en USB. Les tablettes gardent le menu des liseuses.
  const TOUCH_ONLY = window.matchMedia('(hover: none) and (pointer: coarse)').matches
    && Math.min(screen.width, screen.height) < 600;
  let kobo = null; // liseuse branchee : { serial, version, file(chemin), write(chemin, blob) | null }
  // Filtres de la page d'une liseuse (memes criteres que le catalogue, plus la lecture).
  const koboState = { filter: 'all', q: '', category: '', series: '', tag: '', reading: '', sort: 'series', focus: false };
  // Liseuse branchee (et connue de la bibliotheque) : onglet, filtre du catalogue et
  // boutons d'envoi n'apparaissent qu'a cette condition.
  const koboOn = () => canManage() && features().kobo && !!kobo && !!kobo.device;
  let koboReturn = null; // fiche creee depuis une liseuse : { deviceId, name, bookId }

  const koboWarning = () => (KOBO_FS ? '' : `<div class="warn-box">Ce navigateur ne peut pas écrire sur la liseuse : le scan fonctionne, mais les livres envoyés sont téléchargés et doivent être copiés à la main sur la Kobo. <strong>Utilise de préférence Chrome</strong> (Windows, Linux, Chromebook).</div>`);

  function pickDirectoryFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.onchange = () => resolve([...input.files]);
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  // Chrome : dossier de la liseuse memorise (IndexedDB, par bibliotheque) pour la
  // retrouver apres un rechargement ; si le navigateur a garde l'autorisation, elle est
  // reconnectee seule, sinon un clic sur "Reconnecter" suffit (le navigateur l'exige).
  let koboSavedInfo = null; // liseuse memorisee a reconnecter : { root, name }
  function koboStore(mode, fn) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('mll-kobo', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('handles');
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const tx = req.result.transaction('handles', mode);
          const r = fn(tx.objectStore('handles'));
          tx.oncomplete = () => resolve(r ? r.result : null);
          tx.onerror = () => resolve(null);
        };
      } catch (e) { resolve(null); }
    });
  }
  const koboRemember = (src) => (src.root && LIBRARY
    ? koboStore('readwrite', (st) => st.put({ root: src.root, name: src.device ? src.device.name : 'la liseuse' }, LIBRARY.slug)) : null);

  async function koboRestore() {
    if (!KOBO_FS || !LIBRARY || !canManage() || !features().kobo || kobo) return;
    const info = await koboStore('readonly', (st) => st.get(LIBRARY.slug));
    if (!info || !info.root) return;
    const perm = await info.root.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
    if (perm === 'granted') {
      try { await connectKobo(info.root); route(); return; } catch (e) { /* liseuse debranchee */ }
    }
    koboSavedInfo = info;
  }

  // Liseuse memorisee : l'autorisation est redemandee (doit suivre un clic).
  async function reconnectKobo() {
    const info = koboSavedInfo;
    if (!info) return scanKobo();
    const perm = await info.root.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw Object.assign(new Error('Accès refusé.'), { name: 'AbortError' });
    return scanKobo(info.root);
  }

  // Debranchement : verification toutes les 5 s ; onglet, filtre et boutons retires.
  let koboTimer = null;
  function watchKobo() {
    clearInterval(koboTimer);
    koboTimer = setInterval(async () => {
      if (!kobo) { clearInterval(koboTimer); return; }
      if (await kobo.alive()) return;
      const name = kobo.device ? kobo.device.name : 'La liseuse';
      if (kobo.root) koboSavedInfo = { root: kobo.root, name };
      kobo = null;
      clearInterval(koboTimer);
      renderNav();
      toast(`${name} a été débranchée.`);
      if (/^#?\/?(book\/\d+|kobo(\/\d+)?)?$/.test(location.hash) && !$('.modal-backdrop')) route();
    }, 5000);
  }

  // Doit etre appele directement depuis un clic (le navigateur l'exige), sauf avec un
  // dossier deja autorise (root).
  async function connectKobo(root = null) {
    const remembered = !!root;
    let src;
    if (KOBO_FS) {
      if (!root) root = await window.showDirectoryPicker({ id: 'kobo', mode: 'readwrite' });
      const dirOf = async (parts, create) => {
        let d = root;
        for (const p of parts) d = await d.getDirectoryHandle(p, { create });
        return d;
      };
      src = {
        root,
        file: async (p) => {
          try {
            const parts = p.split('/');
            const d = await dirOf(parts.slice(0, -1), false);
            return await (await d.getFileHandle(parts[parts.length - 1])).getFile();
          } catch (e) { return null; }
        },
        write: async (p, blob) => {
          const parts = p.split('/');
          const d = await dirOf(parts.slice(0, -1), true);
          const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
          await w.write(blob);
          await w.close();
        },
        // Suppression d'un livre ; dossier parent retire s'il est vide (auteur, serie).
        remove: async (p) => {
          const parts = p.split('/');
          const d = await dirOf(parts.slice(0, -1), false);
          await d.removeEntry(parts[parts.length - 1]);
          if (parts.length < 2) return;
          for await (const _ of d.keys()) return; // eslint-disable-line no-unused-vars
          const parent = await dirOf(parts.slice(0, -2), false);
          await parent.removeEntry(parts[parts.length - 2]).catch(() => {});
        },
      };
      src.alive = async () => !!(await src.file('.kobo/version'));
    } else {
      const files = await pickDirectoryFiles();
      if (!files || !files.length) throw Object.assign(new Error('Aucun dossier choisi.'), { name: 'AbortError' });
      // Chemins relatifs a la racine choisie ("KOBOeReader/.kobo/version" -> ".kobo/version").
      const map = new Map(files.map((f) => [f.webkitRelativePath.split('/').slice(1).join('/'), f]));
      src = { file: async (p) => map.get(p) || null, write: null, remove: null };
      // Fichier choisi illisible une fois la liseuse retiree.
      src.alive = async () => { try { await map.get('.kobo/version').slice(0, 1).text(); return true; } catch (e) { return false; } };
    }
    const version = await src.file('.kobo/version');
    if (!version) {
      throw new Error(remembered ? 'Liseuse introuvable : vérifie qu\'elle est bien branchée, sinon utilise « Brancher une liseuse ».'
        : "Ce dossier n'est pas une liseuse Kobo : choisis la racine de la liseuse (le lecteur « KOBOeReader »).");
    }
    src.version = (await version.text()).trim();
    src.serial = src.version.split(',')[0].trim();
    // Liseuse deja connue de la bibliotheque (filtres du catalogue, envois).
    src.device = (await api('/api/kobo/devices').catch(() => [])).find((d) => d.serial === src.serial) || null;
    kobo = src;
    koboSavedInfo = null;
    koboRemember(src);
    watchKobo();
    renderNav();
    return src;
  }

  // Fenetre d'avancement (etape + barre ; pct null = barre animee sans pourcentage).
  function progressBox(title) {
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal progress-modal" role="status" aria-live="polite"><h2>${esc(title)}</h2>
      <p class="small muted" data-step>…</p><div class="progress indeterminate"><span data-bar></span></div></div>`;
    document.body.appendChild(el);
    return {
      step(text, pct = null) {
        $('[data-step]', el).textContent = text;
        $('[data-bar]', el).style.width = pct == null ? '' : `${pct}%`;
        $('.progress', el).classList.toggle('indeterminate', pct == null);
      },
      close() { el.remove(); },
    };
  }

  // Envoi brut avec suivi de l'envoi (fetch ne le permet pas).
  function sendRawProgress(path, body, type, headers, onProgress, base = LIB) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', base + path);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', type);
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.upload.onload = () => onProgress(1);
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* reponse vide */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error((data && data.error) || (xhr.status === 413 ? 'Base de la liseuse trop lourde.' : `Erreur ${xhr.status}`)));
      };
      xhr.onerror = () => reject(new Error('Connexion au serveur impossible.'));
      xhr.send(body);
    });
  }

  async function scanKobo(root = null) {
    const src = await connectKobo(root);
    const box = progressBox(`Scan de ${src.device ? src.device.name : 'la liseuse'}`);
    try {
      box.step('Lecture de la liseuse…');
      const dbFile = await src.file('.kobo/KoboReader.sqlite');
      if (!dbFile) throw new Error('Base de la liseuse introuvable (.kobo/KoboReader.sqlite).');
      const mb = `${(dbFile.size / 1048576).toFixed(1).replace('.', ',')} Mo`;
      box.step(`Envoi de la base de la liseuse (${mb})…`, 0);
      src.device = await sendRawProgress('/api/kobo/scan', dbFile, 'application/x-sqlite3', { 'X-Kobo-Version': encodeURIComponent(src.version) }, (p) => {
        if (p < 1) box.step(`Envoi de la base de la liseuse (${mb})… ${Math.round(p * 100)} %`, Math.round(p * 100));
        else box.step('Analyse des livres et rapprochement avec les fiches…');
      });
    } finally { box.close(); }
    koboRemember(src);
    renderNav();
    return src.device;
  }

  // Bouton desactive pendant l'action ; annulation du choix de dossier ignoree.
  const busy = (fn) => async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await fn(btn); } catch (err) { if (err.name !== 'AbortError') toast(err.message, 'error'); } finally { btn.disabled = false; }
  };

  // Livres de la liseuse branchee (dernier scan et envois en attente).
  async function koboBookIds() {
    if (!kobo || !kobo.device) return new Set();
    const d = await api(`/api/kobo/devices/${kobo.device.id}`);
    return new Set(d.items.filter((i) => i.book).map((i) => i.book.id));
  }

  // Envoi d'un livre sur la liseuse : copie directe (Chrome) ou telechargement.
  // Avec Chrome, la liseuse est scannee au premier envoi de la session.
  async function pushToKobo(bookId, { quiet = false } = {}) {
    if (KOBO_FS && !kobo) await (koboSavedInfo ? reconnectKobo() : scanKobo());
    if (!quiet && (await koboBookIds()).has(bookId) && !confirm('Ce livre est déjà sur la liseuse. L\'envoyer quand même ?')) return false;
    const res = await fetch(`${LIB}/api/kobo/books/${bookId}/epub`, { credentials: 'same-origin' });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (e) { /* reponse vide */ }
      throw new Error((data && data.error) || `Erreur ${res.status}`);
    }
    const p = decodeURIComponent(res.headers.get('X-Kobo-Path') || 'Bibliotheque/livre.epub');
    const blob = await res.blob();
    if (kobo && kobo.write) {
      await kobo.write(p, blob);
      if (kobo.device) await api(`/api/kobo/devices/${kobo.device.id}/pushed`, { method: 'POST', body: { bookId, path: p } });
      if (!quiet) toast(`Copié sur la liseuse (${p}). Éjecte-la pour qu'elle l'importe.`);
      return true;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = p.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    if (!quiet) toast('Fichier téléchargé : copie-le sur la liseuse (dossier Bibliotheque).');
    return true;
  }

  // Envoi de plusieurs livres (selection du catalogue) : ceux deja sur la liseuse sont
  // ignores, comme ceux sans fichier ou sans droit de telechargement.
  async function pushManyToKobo(ids, progress) {
    if (KOBO_FS && !kobo) await (koboSavedInfo ? reconnectKobo() : scanKobo());
    const already = await koboBookIds();
    const out = { sent: 0, already: 0, skipped: 0 };
    for (const [n, id] of ids.entries()) {
      progress(n + 1);
      if (already.has(id)) { out.already++; continue; }
      try { if (await pushToKobo(id, { quiet: true })) out.sent++; } catch (e) { out.skipped++; }
    }
    return out;
  }

  async function viewKobo() {
    const devices = await api('/api/kobo/devices');
    view().innerHTML = `
      <div class="page-head"><div><h1>Liseuses ${hint('Branche une Kobo en USB puis « Scanner une Kobo » et choisis le lecteur de la liseuse (KOBOeReader). Rien n\'est modifié sur la liseuse.')}</h1></div>
        <button class="btn btn-primary" id="kobo-scan">Scanner une Kobo</button></div>
      ${koboWarning()}
      ${devices.length ? `<div class="lib-grid">${devices.map((d) => `
        <a class="card kobo-card" href="#/kobo/${d.id}">
          <strong>${esc(d.name)}</strong>
          <div class="small muted">${d.owner ? esc(d.owner.username) : 'Sans propriétaire'} · ${d.books} livre(s) · scan du ${d.lastScanAt ? fmtDate(d.lastScanAt) : '—'}</div>
          ${d.noBook || d.noFile ? `<div class="badges">${d.noBook ? `<span class="badge badge-warn">${d.noBook} sans fiche</span>` : ''}${d.noFile ? `<span class="badge badge-muted">${d.noFile} sans fichier</span>` : ''}</div>` : ''}
        </a>`).join('')}</div>`
        : '<div class="empty">Aucune liseuse pour le moment : branche une Kobo et clique sur « Scanner une Kobo ».</div>'}`;
    $('#kobo-scan').onclick = busy(async () => {
      const d = await scanKobo();
      toast('Liseuse scannée.');
      go(`#/kobo/${d.id}`);
    });
  }

  // Choix d'une fiche existante (recherche dans le catalogue).
  function pickBookDialog(item) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal">
          <h2>Rattacher à une fiche</h2>
          <p class="small muted">${esc(item.title)}${item.authors ? ` · ${esc(item.authors)}` : ''}</p>
          <div class="field"><input type="search" id="pick-q" value="${esc(item.title)}" placeholder="Titre, auteur, ISBN…"></div>
          <div id="pick-results" class="pick-list"></div>
          <div class="btn-row"><button class="btn" type="button" data-close>Annuler</button></div>
        </div>`;
      document.body.appendChild(backdrop);
      const close = (v) => { backdrop.remove(); resolve(v); };
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(null); });
      const search = async () => {
        const q = $('#pick-q', backdrop).value.trim();
        const r = await api(`/api/books?q=${encodeURIComponent(q)}&limit=20`).catch(() => ({ items: [] }));
        $('#pick-results', backdrop).innerHTML = r.items.length ? r.items.map((b) => `
          <button type="button" class="pick-row" data-pick="${b.id}"><strong>${esc(b.title)}</strong>
            <span class="small muted">${esc(b.authors || '')}${b.series ? ` · ${esc(b.series)}${b.seriesNumber ? ` #${esc(b.seriesNumber)}` : ''}` : ''}</span></button>`).join('')
          : '<p class="small muted">Aucune fiche trouvée.</p>';
        $$('[data-pick]', backdrop).forEach((btn) => { btn.onclick = () => close(Number(btn.dataset.pick)); });
      };
      $('#pick-q', backdrop).oninput = debounce(search, 250);
      search();
      $('#pick-q', backdrop).focus();
    });
  }

  function editKoboDialog(d, members) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <form class="modal">
        <h2>Liseuse</h2>
        <div class="field"><label>Nom</label><input name="name" required maxlength="80" value="${esc(d.name)}"></div>
        <div class="field"><label>Propriétaire ${hint('Ses statuts de lecture suivent la liseuse, et il est ajouté comme lecteur des livres présents dessus.')}</label><select name="userId">
          <option value="">Aucun</option>
          ${members.map((m) => `<option value="${m.id}" ${d.owner && d.owner.id === m.id ? 'selected' : ''}>${esc(m.username)}</option>`).join('')}
        </select></div>
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
      if (!confirm(`Retirer la liseuse « ${d.name} » de la bibliothèque ? (Rien n'est effacé sur la liseuse ni dans les fiches.)`)) return;
      try {
        await api(`/api/kobo/devices/${d.id}`, { method: 'DELETE' });
        if (kobo && kobo.device && kobo.device.id === d.id) { kobo.device = null; renderNav(); }
        close();
        go('#/kobo');
      } catch (err) { toast(err.message, 'error'); }
    };
    $('form', backdrop).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api(`/api/kobo/devices/${d.id}`, { method: 'PUT', body: { name: e.target.name.value, userId: e.target.userId.value || null } });
        if (kobo && kobo.device && kobo.device.id === r.id) { kobo.device = r; renderNav(); }
        close();
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  async function viewKoboDevice(id) {
    const k = koboState;
    const qs = new URLSearchParams(['q', 'category', 'series', 'tag', 'reading', 'sort'].filter((key) => k[key]).map((key) => [key, k[key]]));
    const [d, members, cats, seriesList, tags] = await Promise.all([
      api(`/api/kobo/devices/${id}?${qs}`), loadMembers().catch(() => []),
      api('/api/public/categories').catch(() => []),
      api('/api/public/series').catch(() => []), features().tags ? api('/api/public/tags').catch(() => []) : [],
    ]);
    const filtered = ['q', 'category', 'series', 'tag', 'reading'].some((key) => k[key]);
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
    const connected = () => !!kobo && kobo.serial === d.serial;
    const canRemove = connected() && !!kobo.remove;
    const f = koboState.filter;
    const items = d.items.filter((i) => f === 'all' || (f === 'nobook' && !i.book) || (f === 'nofile' && i.book && !i.book.hasFile));
    const toCopy = d.items.filter((i) => i.book && !i.book.hasFile && i.path && !i.pending);
    const reading = (i) => {
      if (i.pending) return '<span class="badge badge-muted">Envoyé, en attente d\'import</span>';
      const main = i.readStatus === 2 ? '<span class="badge badge-ok">Lu</span>'
        : i.readStatus === 1 || i.percent > 0 ? `<span class="badge badge-muted">${Math.round(i.percent)} %</span>`
          : '<span class="small muted">Pas commencé</span>';
      return main + (i.status === 'abandoned' ? ' <span class="badge badge-warn">Abandonné</span>' : '')
        + (i.lastReadAt ? `<div class="small muted">${fmtDate(i.lastReadAt)}</div>` : '');
    };
    const seg = (key, label, n) => `<button type="button" data-filter="${key}" class="${f === key ? 'active' : ''}">${label} (${n})</button>`;
    view().innerHTML = `
      <p><a href="#/kobo">← Liseuses</a></p>
      <div class="page-head"><div><h1>${esc(d.name)}</h1>
        <p class="small muted">${d.owner ? `Propriétaire : ${esc(d.owner.username)}` : 'Sans propriétaire'} · ${d.books} livre(s) · scan du ${d.lastScanAt ? fmtDate(d.lastScanAt) : '—'}${d.firmware ? ` · firmware ${esc(d.firmware)}` : ''}</p></div>
        <div class="btn-row">
          <button class="btn btn-primary" id="kobo-rescan">${connected() ? 'Rescanner' : 'Brancher et scanner'}</button>
          ${toCopy.length ? `<button class="btn" id="kobo-copy-all">Copier les ${toCopy.length} fichier(s) manquant(s)</button>` : ''}
          <button class="btn" id="kobo-edit">Modifier</button>
        </div></div>
      ${koboWarning()}
      <div class="filters filters-search-row" id="kobo-filters">
        <input class="search" type="search" id="kq" placeholder="Titre, auteur, série…" value="${esc(k.q)}">
        <button class="btn filters-toggle" type="button" id="kfilters-toggle">${filtered ? 'Filtres · actifs' : 'Filtres'}</button>
        ${cats.some((x) => x.count > 0) ? '<input type="search" id="kcat" placeholder="Toutes les catégories">' : ''}
        ${seriesList.length ? '<input type="search" id="kseries" placeholder="Toutes les séries">' : ''}
        ${tags.some((t) => t.count) ? '<input type="search" id="ktag" placeholder="Tous les tags">' : ''}
        <select id="kreading">${[['', 'Lecture : toutes'], ['unread', 'Pas commencés'], ['reading', 'En cours'], ['read', 'Lus'], ['abandoned', 'Abandonnés'], ['pending', 'En attente d’import']].map(([v, l]) => opt(v, l, k.reading)).join('')}</select>
        <select id="ksort">${[['series', 'Tri : série'], ['title', 'Tri : titre'], ['author', 'Tri : auteur'], ['recent', 'Tri : dernière lecture']].map(([v, l]) => opt(v, l, k.sort)).join('')}</select>
        ${filtered ? '<button class="btn" type="button" id="kclear">Effacer les filtres</button>' : ''}
      </div>
      <div class="seg seg-3" style="max-width:560px">
        ${seg('all', 'Tous', d.items.length)}${seg('nobook', 'Sans fiche', d.items.filter((i) => !i.book).length)}${seg('nofile', 'Sans fichier', d.items.filter((i) => i.book && !i.book.hasFile).length)}
      </div>
      ${items.length ? `<div class="card table-wrap"><table class="stack"><thead><tr><th>Livre sur la liseuse</th><th>Lecture</th><th>Fiche</th><th>Fichier dans la biblio</th></tr></thead><tbody>
        ${items.map((i) => `<tr>
          <td><strong>${esc(i.title)}</strong><div class="small muted">${esc(i.authors || '')}${i.series ? ` · ${esc(i.series)}${i.seriesNumber ? ` #${esc(i.seriesNumber)}` : ''}` : ''}</div>
            ${canRemove && i.path ? `<button class="btn btn-small btn-danger" data-remove="${i.id}" title="Supprimer le fichier de la liseuse">Supprimer de la liseuse</button>` : ''}</td>
          <td>${reading(i)}</td>
          <td>${i.book
            ? `<a href="#/book/${i.book.id}">${esc(i.book.title)}</a> <button class="btn btn-small" data-unlink="${i.id}" title="Détacher de cette fiche">✕</button>`
            : `<span class="btn-row"><button class="btn btn-small btn-primary" data-create="${i.id}">Créer la fiche</button><button class="btn btn-small" data-link="${i.id}">Rattacher…</button></span>`}</td>
          <td>${!i.book ? '<span class="muted">—</span>' : i.book.hasFile ? '<span class="badge badge-ok">Oui</span>'
            : `<button class="btn btn-small" data-copy="${i.id}" ${i.path && !i.pending ? '' : 'disabled title="Fichier inaccessible (carte SD ou pas encore importé)"'}>Copier depuis la Kobo</button>`}</td>
        </tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">Aucun livre dans cette liste.</div>'}`;

    const item = (btn, key) => d.items.find((i) => i.id === Number(btn.dataset[key]));
    $$('[data-remove]').forEach((btn) => {
      btn.onclick = busy(async () => {
        const i = item(btn, 'remove');
        if (!confirm(`Supprimer « ${i.title} » de la liseuse ? Le fichier sera effacé de la Kobo (la fiche et le fichier de la bibliothèque sont conservés).`)) return;
        if (!connected()) throw new Error('Liseuse débranchée.');
        try { await kobo.remove(i.path); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
        await api(`/api/kobo/items/${i.id}`, { method: 'DELETE' });
        toast('Livre supprimé. Éjecte la liseuse pour qu’elle mette sa bibliothèque à jour.');
        route();
      });
    });
    // Fichier de la liseuse envoye dans l'exemplaire numerique de la fiche.
    const copyFile = async (i, out) => {
      if (!out.book || out.book.hasFile || !i.path) return;
      if (!connected()) { toast('Fiche enregistrée. Branche la liseuse (Brancher et scanner) pour copier le fichier.'); return; }
      const file = await kobo.file(i.path);
      if (!file) throw new Error('Fichier introuvable sur la liseuse.');
      // Fiche rapprochee automatiquement : exemplaire numerique cree au besoin.
      let copyId = out.book.copyId;
      if (!copyId) {
        const r = await api(`/api/books/${out.book.id}/copies`, { method: 'POST', body: { format: 'ebook' } });
        copyId = r.book.copies.find((c) => c.format === 'ebook').id;
      }
      await uploadEpub(copyId, new File([file], i.path.split('/').pop(), { type: 'application/epub+zip' }));
    };
    $$('[data-filter]').forEach((btn) => { btn.onclick = () => { koboState.filter = btn.dataset.filter; route(); }; });
    // Filtres : page redessinee (la recherche garde le focus).
    const refilter = () => { k.focus = document.activeElement && document.activeElement.id === 'kq'; route(); };
    $('#kq').addEventListener('input', debounce((e) => { k.q = e.target.value; refilter(); }, 300));
    if (k.focus) { const input = $('#kq'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); k.focus = false; }
    [['#kcat', 'category', cats.filter((x) => x.count > 0).map((x) => ({ id: x.id, name: x.name, count: x.count }))],
      ['#kseries', 'series', seriesList.map((x) => ({ id: x.name, name: x.name, count: x.count }))],
      ['#ktag', 'tag', tags.filter((t) => t.count > 0).map((t) => ({ id: t.id, name: '#' + t.name, count: t.count }))],
    ].forEach(([sel, key, list]) => {
      if ($(sel)) searchPicker({ input: $(sel), items: list, value: k[key], onPick: (v) => { if (v !== String(k[key] || '')) { k[key] = v; refilter(); } } });
    });
    [['#kreading', 'reading'], ['#ksort', 'sort']].forEach(([sel, key]) => {
      if ($(sel)) $(sel).onchange = (e) => { k[key] = e.target.value; refilter(); };
    });
    $('#kfilters-toggle').onclick = () => $('#kobo-filters').classList.toggle('open');
    if ($('#kclear')) $('#kclear').onclick = () => { Object.assign(k, { q: '', category: '', series: '', tag: '', reading: '' }); refilter(); };
    $('#kobo-edit').onclick = () => editKoboDialog(d, members);
    $('#kobo-rescan').onclick = busy(async () => {
      const r = await (connected() && kobo.root ? scanKobo(kobo.root) : koboSavedInfo ? reconnectKobo() : scanKobo());
      if (r.id !== d.id) { toast(`C'est une autre liseuse : ${r.name}.`); go(`#/kobo/${r.id}`); return; }
      toast('Liseuse scannée.');
      route();
    });
    $$('[data-create]').forEach((btn) => {
      btn.onclick = busy(async () => {
        const i = item(btn, 'create');
        const out = await api(`/api/kobo/items/${i.id}/create`, { method: 'POST', body: {} });
        await copyFile(i, out).catch((err) => toast(err.message, 'error'));
        toast('Fiche créée.');
        // Fiche affichee, avec un bouton de retour a la liste de la liseuse.
        koboReturn = { deviceId: d.id, name: d.name, bookId: out.book.id };
        go(`#/book/${out.book.id}`);
      });
    });
    const copyAll = $('#kobo-copy-all');
    if (copyAll) copyAll.onclick = busy(async (btn) => {
      if (!connected()) await (koboSavedInfo ? reconnectKobo() : connectKobo());
      if (!connected()) throw new Error("Ce n'est pas la bonne liseuse.");
      let ok = 0;
      let failed = 0;
      for (const [n, i] of toCopy.entries()) {
        btn.textContent = `Copie ${n + 1} / ${toCopy.length}…`;
        try { await copyFile(i, i); ok++; } catch (e) { failed++; }
      }
      toast(`${ok} fichier(s) copié(s) dans la bibliothèque${failed ? `, ${failed} échec(s)` : ''}.`, failed ? 'error' : undefined);
      route();
    });
    $$('[data-link]').forEach((btn) => {
      btn.onclick = busy(async () => {
        const i = item(btn, 'link');
        const bookId = await pickBookDialog(i);
        if (!bookId) return;
        const out = await api(`/api/kobo/items/${i.id}/link`, { method: 'POST', body: { bookId } });
        await copyFile(i, out);
        toast('Livre rattaché.');
        route();
      });
    });
    $$('[data-unlink]').forEach((btn) => {
      btn.onclick = busy(async () => {
        const i = item(btn, 'unlink');
        if (!confirm(`Détacher « ${i.title} » de la fiche « ${i.book.title} » ? (La fiche est conservée.)`)) return;
        await api(`/api/kobo/items/${i.id}/link`, { method: 'POST', body: { bookId: null } });
        route();
      });
    });
    $$('[data-copy]').forEach((btn) => {
      btn.onclick = busy(async () => {
        const i = item(btn, 'copy');
        if (!connected()) await (koboSavedInfo ? reconnectKobo() : connectKobo());
        if (!connected()) throw new Error("Ce n'est pas la bonne liseuse.");
        await copyFile(i, i);
        toast('Fichier copié dans la bibliothèque.');
        route();
      });
    });
  }

  // ================= Liseuse epub (epub.js) =================
  // Position de lecture gardee dans le navigateur (localStorage, par livre).
  async function viewReader(id) {
    const book = await api(canManage() ? `/api/books/${id}` : `/api/public/books/${id}`);
    if (!book.ebookFile || !book.ebookFile.read) {
      throw new Error(state.user ? "Ton compte n'a pas accès à la lecture de ce livre." : 'Connecte-toi pour lire ce livre.');
    }
    if (!window.JSZip) await loadScript(ROOT + '/vendor/jszip.min.js');
    if (!window.ePub) await loadScript(ROOT + '/vendor/epub.min.js');
    const res = await fetch(`${LIB}/api/public/books/${id}/epub`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Lecture du fichier impossible.');
    const data = await res.arrayBuffer();
    view().innerHTML = `
      <div class="reader">
        <div class="reader-bar">
          <a href="#/book/${id}" class="reader-title">← ${esc(book.title)}</a>
          <select id="reader-toc"><option value="">Sommaire</option></select>
          <span class="small muted" id="reader-pos"></span>
          <span class="btn-row">
            <button class="btn btn-small" id="reader-prev" aria-label="Page précédente">‹</button>
            <button class="btn btn-small" id="reader-next" aria-label="Page suivante">›</button>
          </span>
        </div>
        <div id="reader-area" class="reader-area"></div>
      </div>`;
    const epub = window.ePub(data);
    const rendition = epub.renderTo('reader-area', { width: '100%', height: '100%', spread: 'auto' });
    const key = `mll-read-${LIBRARY.slug}-${id}`;
    let start;
    try { start = localStorage.getItem(key) || undefined; } catch (e) { /* stockage indisponible */ }
    await rendition.display(start).catch(() => rendition.display());
    const prev = () => rendition.prev();
    const next = () => rendition.next();
    $('#reader-prev').onclick = prev;
    $('#reader-next').onclick = next;
    const onKey = (e) => { if (e.key === 'ArrowLeft') prev(); if (e.key === 'ArrowRight') next(); };
    document.addEventListener('keyup', onKey);
    rendition.on('keyup', onKey);
    // Balayage sur mobile
    let x0 = null;
    rendition.on('touchstart', (e) => { x0 = e.changedTouches[0].screenX; });
    rendition.on('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].screenX - x0;
      if (Math.abs(dx) > 50) (dx < 0 ? next : prev)();
      x0 = null;
    });
    const pos = $('#reader-pos');
    const showPos = (loc) => {
      if (!loc || !loc.start) return;
      try { localStorage.setItem(key, loc.start.cfi); } catch (e) { /* stockage indisponible */ }
      if (epub.locations.length()) pos.textContent = `${Math.round(epub.locations.percentageFromCfi(loc.start.cfi) * 100)} %`;
    };
    rendition.on('relocated', showPos);
    epub.locations.generate(1600).then(() => showPos(rendition.currentLocation())).catch(() => {});
    epub.loaded.navigation.then((nav) => {
      const opts = [];
      const walk = (items, depth) => items.forEach((it) => {
        opts.push(`<option value="${esc(it.href)}">${'  '.repeat(depth)}${esc(it.label.trim())}</option>`);
        if (it.subitems && it.subitems.length) walk(it.subitems, depth + 1);
      });
      walk(nav.toc, 0);
      const toc = $('#reader-toc');
      if (!toc) return;
      if (!opts.length) { toc.remove(); return; }
      toc.insertAdjacentHTML('beforeend', opts.join(''));
      toc.onchange = () => { if (toc.value) rendition.display(toc.value); toc.value = ''; };
    }).catch(() => {});
    pageCleanup = () => {
      document.removeEventListener('keyup', onKey);
      try { epub.destroy(); } catch (e) { /* deja detruit */ }
    };
  }

  // ================= Exemplaire (cible du QR code) : pret / retour =================
  async function viewCopy(code) {
    if (!canManage()) {
      const r = await api(`/api/public/copies/${encodeURIComponent(code)}`);
      location.replace(`#/book/${r.bookId}`);
      return;
    }
    const { copy, book, oldCode, defaultDueAt } = await api(`/api/copies/by-code/${encodeURIComponent(code)}`);
    if (oldCode) {
      history.replaceState(null, '', `#/c/${encodeURIComponent(copy.code)}`);
      toast(`Ancienne étiquette ${oldCode} : cet exemplaire s'appelle maintenant ${copy.code}. Pense à réimprimer son étiquette.`);
    }
    const borrowers = copy.loan ? [] : await api('/api/borrowers');
    const reservations = book.reservations || [];
    const who = loanFor;
    view().innerHTML = `
      <p>${who ? `<a href="#/borrower/${who.id}">← ${esc(who.name)}</a>` : '<a href="#/loans">← Prêts</a>'}</p>
      <div class="card">
        <div class="list-item" style="border:0;padding-top:0">
          ${book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(book.coverUrl))}" alt="">` : ''}
          <div class="grow">
            <div class="code">${esc(copy.code)}</div>
            <a href="#/book/${book.id}"><strong>${esc(book.title)}</strong></a>
            <div class="small muted">${esc(book.authors)}${copy.location ? ' · ' + esc(copy.location) : ''}</div>
          </div>
        </div>
        ${reservations.length ? `<div class="warn-box">Réservé pour ${reservations.map((r) => `<a href="#/borrower/${r.borrower.id}"><strong>${esc(r.borrower.name)}</strong></a>`).join(', ')}</div>` : ''}
        ${copy.loan ? `
          <div class="info-box">Prêté à <a href="#/borrower/${copy.loan.borrower.id}"><strong>${esc(copy.loan.borrower.name)}</strong></a> depuis le ${fmtDate(copy.loan.loanedAt)}${copy.loan.dueAt ? ` · ${dueHtml(copy.loan)}` : ''}.</div>
          <button class="btn btn-ok btn-block" id="return">Enregistrer le retour</button>
          <form class="field isbn-row" id="due-form" style="margin-top:14px">
            <input type="date" name="due" value="${esc(copy.loan.dueAt || '')}" aria-label="Date de retour">
            <button class="btn" type="submit">${copy.loan.dueAt ? 'Prolonger' : 'Fixer la date de retour'}</button>
          </form>
        ` : `
          <div class="info-box">${copy.reservedFor ? `<span class="badge badge-reserved">Réservé</span> pour <strong>${esc(copy.reservedFor.name)}</strong>` : '<span class="badge badge-ok">Disponible</span>'}</div>
          <form id="loan-form">
            <div class="field">
              <label for="borrower">Emprunteur</label>
              <input id="borrower" name="borrower" list="borrower-list" placeholder="Nom (nouvel emprunteur créé automatiquement)" autocomplete="off" required value="${who ? esc(who.name) : copy.reservedFor ? esc(copy.reservedFor.name) : ''}">
              <datalist id="borrower-list">${borrowers.map((b) => `<option value="${esc(b.name)}">`).join('')}</datalist>
            </div>
            <div class="grid-2">
              <div class="field"><label for="due">À rendre le ${hint('Durée par défaut dans les Réglages (Exemplaires et prêts). Vide : pas de date de retour.')}</label><input id="due" name="due" type="date" value="${esc(defaultDueAt || '')}"></div>
              <div class="field"><label for="notes">Remarque (facultatif)</label><input id="notes" name="notes"></div>
            </div>
            <button class="btn btn-primary btn-block" type="submit">Prêter</button>
          </form>`}
      </div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn" id="scan-next">${who ? `Prêter un autre livre à ${esc(who.name)}` : 'Scanner un autre livre'}</button>
        ${who ? '<button class="btn" id="loan-for-stop">Terminer</button>' : ''}
      </div>`;
    $('#scan-next').onclick = () => scanAndOpen('loan');
    if (who) $('#loan-for-stop').onclick = () => { loanFor = null; go(`#/borrower/${who.id}`); };
    if (copy.loan) {
      $('#return').onclick = async () => {
        try {
          if (!(await returnLoan(copy.loan.id, copy.code))) route();
        } catch (err) { toast(err.message, 'error'); }
      };
      $('#due-form').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api(`/api/loans/${copy.loan.id}`, { method: 'PUT', body: { dueAt: e.target.due.value } });
          toast(e.target.due.value ? `À rendre le ${fmtDay(e.target.due.value)}.` : 'Date de retour retirée.');
          route();
        } catch (err) { toast(err.message, 'error'); }
      };
    } else {
      if (!who) $('#borrower').focus();
      $('#loan-form').onsubmit = async (e) => {
        e.preventDefault();
        const name = e.target.borrower.value.trim();
        const match = borrowers.find((b) => b.name.toLowerCase() === name.toLowerCase());
        try {
          await api('/api/loans', { method: 'POST', body: { code: copy.code, borrowerId: match ? match.id : null, borrowerName: name, notes: e.target.notes.value, dueAt: e.target.due.value } });
          toast(`${copy.code} prêté à ${name}.`);
          route();
        } catch (err) { toast(err.message, 'error'); }
      };
    }
  }

  // ================= Connexion =================
  async function viewLogin() {
    if (state.user) return go(LIBRARY ? '#/home' : '#/');
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
        try { sessionStorage.removeItem('mll-backup-snooze'); } catch (e2) { /* stockage indisponible */ }
        await loadStatus();
        // Connexion acceptee mais cookie refuse (cadre d'un autre site : Teams, Safari...)
        if (!state.user) throw new Error(window.top !== window.self
          ? 'Connexion refusée par le navigateur dans ce cadre (cookies bloqués). Ouvrez l’application dans un onglet du navigateur.'
          : 'Connexion impossible : le navigateur bloque les cookies de ce site.');
        toast(`Bienvenue ${state.user.username} !`);
        setTimeout(showBackupReminder, 300);
        const after = sessionStorageTake('mll-after-login');
        if (LIBRARY) {
          renderHeader();
          go(after || (LIBRARY ? '#/home' : '#/'));
        } else {
          const def = state.libraries.find((l) => l.id === state.user.defaultLibraryId) || state.libraries[0];
          if (def && !after) location.href = libUrl(def.slug);
          else { renderHeader(); go(after || (LIBRARY ? '#/home' : '#/')); }
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
      <p class="muted">${esc(u.username)} · ${u.role === 'admin' ? 'Administrateur (gère toutes les bibliothèques)' : roleLabel(u.role)}</p>
      <h2>Bibliothèque par défaut ${hint('Ouverte automatiquement après la connexion. Le menu du compte permet de basculer à tout moment.')}</h2>
      <div class="card">
        ${state.libraries.length ? `
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
        <button data-tab="google" class="${adminTab === 'google' ? 'active' : ''}">Google Books</button>
        <button data-tab="data" class="${adminTab === 'data' ? 'active' : ''}">Sauvegarde</button>
      </div>
      <div id="admin-body"></div>`;
    $$('.tabs button').forEach((btn) => { btn.onclick = () => { adminTab = btn.dataset.tab; viewAdmin(); }; });
    if (adminTab === 'libraries') await adminLibraries();
    else if (adminTab === 'users') await adminUsers();
    else if (adminTab === 'google') await adminGoogleKey();
    else await adminBackup();
  }

  // Sauvegarde : une archive par bibliotheque (elements au choix), restauration
  // d'une archive, et copie de toutes les bases.
  const BACKUP_PARTS = [['db', 'Base (livres, prêts, statuts…)'], ['ebooks', 'Fichiers epub'], ['covers', 'Couvertures et logo']];
  async function adminBackup() {
    const libs = await gapi('/api/admin/libraries');
    $('#admin-body').innerHTML = `
      <form class="card" id="bk-form" style="margin-bottom:18px">
        <h3 style="margin-top:0">Sauvegarder ${hint('Une archive par bibliothèque : mylittlelibrary-<nom>.zip.')}</h3>
        <div class="field"><label>Bibliothèques</label>
          <label class="check"><input type="checkbox" id="bk-all" checked> <strong>Toutes</strong></label>
          ${libs.map((l) => `<label class="check"><input type="checkbox" data-lib="${l.id}" checked> ${esc(l.name)} <span class="small muted">${l.books} livre(s)</span></label>`).join('')}</div>
        <div class="field"><label>Contenu</label>
          ${BACKUP_PARTS.map(([k, label]) => `<label class="check"><input type="checkbox" data-part="${k}" checked> ${label}</label>`).join('')}</div>
        <button class="btn btn-primary" type="submit">Télécharger</button>
      </form>
      <form class="card" id="rs-form" style="margin-bottom:18px">
        <h3 style="margin-top:0">Restaurer ${hint('Archive mylittlelibrary-<nom>.zip. Bibliothèque recréée, ou remplacée (après confirmation) si une bibliothèque porte déjà ce nom : seuls les éléments présents dans l’archive sont remplacés.')}</h3>
        <div class="field"><input type="file" name="file" accept=".zip,application/zip" required></div>
        <button class="btn btn-primary" type="submit">Importer</button>
      </form>
      <div class="card">
        <h3 style="margin-top:0">Toutes les bases ${hint('Base centrale (comptes, réglages) et base de chaque bibliothèque, sans epub ni couvertures.')}</h3>
        <a class="btn" href="${ROOT}/api/admin/backup" id="bk-full">Télécharger</a></div>`;
    const libBoxes = $$('[data-lib]');
    $('#bk-all').onchange = (e) => libBoxes.forEach((b) => { b.checked = e.target.checked; });
    libBoxes.forEach((b) => { b.onchange = () => { $('#bk-all').checked = libBoxes.every((x) => x.checked); }; });
    $('#bk-full').onclick = () => backupDone();
    $('#bk-form').onsubmit = async (e) => {
      e.preventDefault();
      const ids = libBoxes.filter((b) => b.checked).map((b) => b.dataset.lib);
      const parts = $$('[data-part]').filter((b) => b.checked).map((b) => b.dataset.part);
      if (!ids.length) { toast('Choisis au moins une bibliothèque.', 'error'); return; }
      if (!parts.length) { toast('Choisis au moins un élément à sauvegarder.', 'error'); return; }
      const query = parts.map((p) => `${p}=1`).join('&');
      // Un lien par archive (telechargement direct, sans passer par la memoire de la page).
      for (let i = 0; i < ids.length; i++) {
        const a = document.createElement('a');
        a.href = `${ROOT}/api/admin/libraries/${ids[i]}/archive?${query}`;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 1200));
      }
      backupDone();
      toast(ids.length > 1 ? `${ids.length} archives en cours de téléchargement.` : 'Archive en cours de téléchargement.');
    };
    $('#rs-form').onsubmit = async (e) => {
      e.preventDefault();
      const file = e.target.file.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024 * 1024) { toast('Archive trop lourde (1 Go max).', 'error'); return; }
      const box = progressBox('Restauration');
      try {
        box.step('Envoi de l’archive…', 0);
        const info = await sendRawProgress('/api/admin/archives', file, 'application/zip', {},
          (pct) => box.step(pct < 1 ? 'Envoi de l’archive…' : 'Lecture de l’archive…', pct < 1 ? Math.round(pct * 100) : null), ROOT);
        const what = BACKUP_PARTS.filter(([k]) => info.contents[k]).map(([, label]) => label.replace(/ \(.*\)/, '').toLowerCase()).join(', ');
        if (info.existing) {
          box.close();
          const ok = confirm(`La bibliothèque « ${info.existing.name} » existe déjà.\n\nRemplacer ses éléments par ceux de l’archive (${what}) ?\nLa base actuelle est copiée dans ses sauvegardes avant remplacement.`);
          if (!ok) { gapi(`/api/admin/archives/${info.token}`, { method: 'DELETE' }).catch(() => {}); return; }
        }
        const pb = info.existing ? progressBox('Restauration') : box;
        pb.step(`${info.existing ? 'Remplacement' : 'Création'} de « ${info.name} »…`);
        try {
          const r = await gapi(`/api/admin/archives/${info.token}/apply`, { method: 'POST', body: { overwrite: !!info.existing } });
          toast(`« ${r.library.name} » ${r.created ? 'créée' : 'restaurée'} : ${r.books} livre(s).`);
          await loadStatus();
          renderHeader();
          adminBackup();
        } finally { pb.close(); }
      } catch (err) {
        box.close();
        toast(err.message, 'error');
      }
    };
  }

  // Rappel mensuel de sauvegarde (administrateurs) : Sauvegarder, Reporter (jusqu'a
  // la prochaine connexion ou ouverture de l'app), Passer (rien ce mois-ci).
  function backupDone() {
    state.backupReminder = false;
    const el = $('#backup-reminder');
    if (el) el.remove();
  }
  function showBackupReminder() {
    if (!state.backupReminder || !isAdmin() || $('#backup-reminder')) return;
    try { if (sessionStorage.getItem('mll-backup-snooze')) return; } catch (e) { /* stockage indisponible */ }
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.id = 'backup-reminder';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="br-title">
        <h2 id="br-title">Sauvegarde du mois</h2>
        <p>Aucune sauvegarde n’a encore été faite ce mois-ci.</p>
        <div class="btn-row">
          <button class="btn btn-primary" type="button" data-act="go">Sauvegarder</button>
          <button class="btn" type="button" data-act="later">Reporter</button>
          <button class="btn" type="button" data-act="skip">Passer ce mois-ci</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    $('[data-act=go]', backdrop).onclick = () => {
      backdrop.remove();
      adminTab = 'data';
      if (/^#\/admin$/.test(location.hash)) viewAdmin();
      else go('#/admin');
    };
    $('[data-act=later]', backdrop).onclick = () => {
      sessionStorageSet('mll-backup-snooze', '1');
      backdrop.remove();
    };
    $('[data-act=skip]', backdrop).onclick = async () => {
      try {
        await gapi('/api/admin/backup-reminder/skip', { method: 'POST', body: {} });
        backupDone();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // Cle Google Books (gratuite) : fiabilise la recherche par ISBN et la recherche de couvertures.
  async function adminGoogleKey() {
    const info = await gapi('/api/admin/google-key');
    const stateHtml = info.saved
      ? `<span class="badge badge-ok">Clé enregistrée (${esc(info.masked)})</span>`
      : info.env ? '<span class="badge badge-ok">Clé définie sur le serveur (variable d\'environnement)</span>'
        : '<span class="badge badge-muted">Aucune clé</span>';
    $('#admin-body').innerHTML = `
      <form class="card" id="gkey-form" style="margin-bottom:18px">
        <h3 style="margin-top:0">Clé Google Books ${hint('Sans clé, Google limite fortement les recherches : beaucoup de livres restent sans résumé ni couverture. Avec une clé (gratuite, environ 1 000 recherches par jour), les recherches par ISBN et de couverture sont bien plus fiables. La clé est gardée sur le serveur et jamais affichée en entier.')}</h3>
        <p>${stateHtml}</p>
        <div class="field"><label>${info.saved ? 'Remplacer la clé' : 'Coller la clé'}</label>
          <input name="key" placeholder="AIza…" autocomplete="off" spellcheck="false"></div>
        <button class="btn btn-primary" type="submit">Vérifier et enregistrer</button>
        ${info.saved ? '<button class="btn btn-danger" type="button" id="gkey-del">Retirer la clé</button>' : ''}
      </form>
      <div class="card">
        <h3 style="margin-top:0">Obtenir une clé gratuite (5 min)</h3>
        <ol>
          <li>Ouvre la <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console Google Cloud</a> et connecte-toi avec un compte Google (Gmail). Accepte les conditions si c'est la première fois. <strong>Aucune carte bancaire n'est nécessaire.</strong></li>
          <li>En haut, clique sur le sélecteur de projet, puis <em>Nouveau projet</em>. Nomme-le par exemple « Bibliothèque » et clique sur <em>Créer</em>. Vérifie ensuite qu'il est bien sélectionné.</li>
          <li>Active l'API : ouvre la page <a href="https://console.cloud.google.com/apis/library/books.googleapis.com" target="_blank" rel="noopener">Books API</a> et clique sur <em>Activer</em>.</li>
          <li>Va dans <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">API et services › Identifiants</a>, clique sur <em>Créer des identifiants</em> › <em>Clé API</em>.</li>
          <li>Copie la clé affichée (elle commence par <span class="code">AIza</span>) et colle-la ci-dessus.</li>
          <li>Conseillé : clique sur <em>Modifier la clé</em> › <em>Restrictions relatives aux API</em> › <em>Restreindre la clé</em>, coche uniquement <em>Books API</em> et enregistre.</li>
        </ol>
        <p class="small muted">API non activée à la vérification ? Refais l'étape 3 puis patiente une minute.</p>
      </div>`;
    const form = $('#gkey-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const key = form.key.value.trim();
      if (!key) { toast('Colle d\'abord une clé.', 'error'); return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        await gapi('/api/admin/google-key', { method: 'PUT', body: { key } });
        toast('Clé vérifiée et enregistrée.');
        adminGoogleKey();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    };
    const del = $('#gkey-del');
    if (del) del.onclick = async () => {
      if (!confirm('Retirer la clé Google Books ?')) return;
      try { await gapi('/api/admin/google-key', { method: 'PUT', body: { key: '' } }); toast('Clé retirée.'); adminGoogleKey(); } catch (err) { toast(err.message, 'error'); }
    };
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
            <strong>${esc(u.username)}</strong> ${u.role === 'admin' ? '<span class="badge badge-ok">Administrateur</span>' : `<span class="badge badge-muted">${roleLabel(u.role)}</span>`}
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
        <div class="field"><label>${user ? `Nouveau mot de passe ${hint('Laisser vide pour ne pas changer.')}` : `Mot de passe * ${hint('8 caractères minimum.')}`}</label>
          <input name="password" type="password" autocomplete="new-password" minlength="8" ${user ? '' : 'required'}></div>
        <div class="field"><label>Rôle ${hint('Utilisateur : utilise les outils des bibliothèques cochées ci-dessous (catalogue, ajouts, prêts, liseuses…). Gestionnaire : en plus, étiquettes et réglages de ces bibliothèques. Administrateur : toutes les bibliothèques, comptes et réglages.')}</label><select name="role">
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>Utilisateur</option>
          <option value="manager" ${u.role === 'manager' || !u.role ? 'selected' : ''}>Gestionnaire</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrateur</option>
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
    const [book, cats, locations, collections, allSeries, allTags, members] = await Promise.all([
      editing ? api(`/api/books/${id}`) : null,
      loadCategories(),
      api('/api/locations'),
      api('/api/public/collections').catch(() => []),
      api('/api/public/series').catch(() => []),
      features().tags ? api('/api/tags').catch(() => []) : [],
      loadMembers().catch(() => []),
    ]);
    const b = book || { isbn: '', title: '', subtitle: '', authors: '', publisher: '', collection: '', series: '', seriesNumber: '', year: '', pages: '', summary: '', notes: '', categories: [], coverUrl: null, format: 'physical' };
    const form = { categories: b.categories.map((c) => c.name), tags: (b.tags || []).map((t) => t.name), cover: { url: b.coverUrl ? mediaSrc(b.coverUrl) : '', remoteUrl: '', data: '', removed: false } };

    // Ouvert depuis "Fiches incompletes" : retour a cette liste.
    let fromIncomplete = null;
    try { const r = JSON.parse(sessionStorage.getItem('mll-after-edit') || 'null'); if (editing && r && r.id === b.id) fromIncomplete = r.hash; } catch (e) { /* rien */ }
    view().innerHTML = `
      <p><a href="${fromIncomplete || (editing ? `#/book/${b.id}` : '#/')}">← ${fromIncomplete ? 'Fiches incomplètes' : editing ? 'Retour à la fiche' : 'Catalogue'}</a></p>
      ${editing ? '<h1>Modifier le livre</h1>' : `<div class="page-head"><div><h1>Ajouter un livre</h1></div>
        <div class="btn-row"><a class="btn hide-mobile" href="#/import">Ajout multiple</a></div></div>`}
      <div class="card" style="margin:14px 0">
        <label for="isbn-search">Rechercher par ISBN ou titre ${hint('Scanne ou tape l\'ISBN pour pré-remplir la fiche. Sans ISBN : tape le titre et l\'auteur, ou « Titre + auteur » reprend ceux de la fiche, puis choisis l\'édition.')}</label>
        <div class="isbn-row">
          <input id="isbn-search" placeholder="ISBN, ou titre et auteur" value="${esc(b.isbn)}" autocomplete="off">
          <button class="btn" id="isbn-go" type="button">Rechercher</button>
          <button class="btn" id="isbn-title" type="button" title="Chercher l'édition avec le titre et l'auteur de la fiche">Titre + auteur</button>
          <button class="btn btn-primary" id="isbn-scan" type="button">Scanner</button>
        </div>
        <div id="isbn-result" class="small" style="margin-top:8px"></div>
      </div>
      <form id="book-form" class="card">
        <div class="cover-edit field">
          <div class="cover" id="cover-preview"></div>
          <div>
            <label>Couverture ${hint('La couverture trouvée par la recherche ISBN est enregistrée automatiquement.')}</label>
            <div class="btn-row">
              <label class="btn btn-small" style="margin:0">Choisir / photographier<input type="file" id="cover-file" accept="image/*" hidden></label>
              <button class="btn btn-small" type="button" id="cover-online">Chercher en ligne</button>
              <button class="btn btn-small btn-danger" type="button" id="cover-remove">Retirer</button>
            </div>
          </div>
        </div>
        <div class="field"><label for="title">Titre *</label><input id="title" name="title" required value="${esc(b.title)}"></div>
        <div class="field"><label for="subtitle">Sous-titre</label><input id="subtitle" name="subtitle" value="${esc(b.subtitle)}"></div>
        <div class="field"><label for="authors">Auteur(s)</label><input id="authors" name="authors" placeholder="Séparés par des virgules" value="${esc(b.authors)}"></div>
        <div class="grid-2">
          <div class="field"><label for="publisher">Éditeur</label><input id="publisher" name="publisher" value="${esc(b.publisher)}"></div>
          <div class="field"><label for="isbn">ISBN</label><input id="isbn" name="isbn" inputmode="numeric" value="${esc(b.isbn)}"></div>
        </div>
        <div class="field"><label for="collection">Collection ${hint('Collection de l\'éditeur : Folio, Pocket Science-fiction…')}</label><input id="collection" name="collection" placeholder="facultatif" value="${esc(b.collection || '')}" autocomplete="off"></div>
        <div class="grid-collection">
          <div class="field"><label for="series">Série <span class="small muted">(saga, cycle…)</span></label><input id="series" name="series" placeholder="facultatif" value="${esc(b.series || '')}" autocomplete="off"></div>
          <div class="field"><label for="seriesNumber">Tome</label><input id="seriesNumber" name="seriesNumber" placeholder="ex. 3" value="${esc(b.seriesNumber || '')}"></div>
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
        ${features().tags ? `<div class="field">
          <label for="tag-input">Tags</label>
          <div id="tag-chips"></div>
          <div class="isbn-row">
            <input id="tag-input" list="tag-list" placeholder="Ajouter un tag…" autocomplete="off">
            <button class="btn" type="button" id="tag-add">Ajouter</button>
          </div>
          <datalist id="tag-list">${allTags.map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist>
        </div>` : ''}
        ${editing ? '' : `
        <div class="grid-2" id="copies-block">
          <div class="field"><label for="copies">Exemplaires papier ${hint('Chacun reçoit un code et une étiquette.')}</label><input id="copies" name="copies" type="number" min="0" max="50" value="1"></div>
          <div class="field"><label for="location">Emplacement</label><input id="location" name="location" list="loc-list" placeholder="Étagère, armoire…">
            <datalist id="loc-list">${locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></div>
        </div>
        ${features().ebooks ? `<div class="field"><label class="check"><input type="checkbox" name="ebook" id="ebook">
          <span>Version numérique ${hint('Exemplaire numérique (epub, pdf…), sans code, étiquette ni prêt.')}</span></label></div>` : ''}`}
        ${members.length > 1 || editing ? `<div class="field"><label>Lecteurs ${hint('Comptes qui lisent, liront ou ont lu ce livre.')}</label>
          <div class="btn-row">${members.map((m) => `<label class="check"><input type="checkbox" data-reader="${m.id}" ${(editing ? (b.readers || []).some((r) => r.id === m.id) : m.id === state.user.id) ? 'checked' : ''}> ${m.id === state.user.id ? 'Moi' : esc(m.username)}</label>`).join('')}</div></div>` : ''}
        <div class="field"><label for="notes">Notes internes ${hint('Visibles uniquement par les gestionnaires.')}</label><textarea id="notes" name="notes" style="min-height:70px">${esc(b.notes)}</textarea></div>
        <div id="form-err"></div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">${editing ? 'Enregistrer' : 'Ajouter au catalogue'}</button></div>
      </form>`;

    const f = $('#book-form');

    function renderCover() {
      const src = form.cover.data || form.cover.remoteUrl || (form.cover.removed ? '' : form.cover.url);
      $('#cover-preview').innerHTML = src ? `<img src="${esc(src)}" alt="">` : '<span class="cover-fallback">Pas d\'image</span>';
      $('#cover-remove').hidden = !src;
    }
    renderCover();
    // Collection : liste deroulante filtrante des collections existantes (ou nom libre).
    combo(f.collection, collections.map((c) => ({ label: c.name, hint: String(c.count) })), (it) => { f.collection.value = it.label; },
      { emptyText: 'Nouvelle collection' });
    combo(f.series, allSeries.map((c) => ({ label: c.name, hint: String(c.count) })), (it) => { f.series.value = it.label; },
      { emptyText: 'Nouvelle série' });
    const addCat = chipField('cat', form.categories);
    const addTag = $('#tag-input') ? chipField('tag', form.tags, (t) => '#' + t) : () => {};

    $('#cover-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        form.cover.data = await imageToDataUrl(file, 900, 'image/jpeg');
        form.cover.remoteUrl = '';
        renderCover();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#cover-online').onclick = async () => {
      const url = await openCoverSearch({ isbn: f.elements.isbn.value || $('#isbn-search').value, title: f.elements.title.value, author: f.elements.authors.value });
      if (!url) return;
      form.cover = { url: form.cover.url, remoteUrl: url, data: '', removed: false };
      renderCover();
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
          fill('collection', d.collection);
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
          // Modification : les champs deja remplis sont gardes ; bouton pour tout
          // remplacer par les informations du nouvel ISBN (champs absents vides).
          const OVERWRITE = ['title', 'subtitle', 'authors', 'publisher', 'collection', 'year', 'pages', 'summary'];
          const differs = OVERWRITE.some((k) => String(d[k] || '') !== f[k].value) || (d.coverUrl && form.cover.remoteUrl !== d.coverUrl);
          if (editing && differs) {
            html += ` <button type="button" class="btn btn-small" id="isbn-overwrite">Écraser la fiche</button>${hint('Remplace titre, auteurs, éditeur, année, pages, résumé, couverture… par les informations de cet ISBN. Les champs inconnus pour cet ISBN sont vidés (le titre est gardé).')}`;
          }
          out.innerHTML = html;
          const ow = $('#isbn-overwrite');
          if (ow) ow.onclick = () => {
            OVERWRITE.forEach((k) => { if (d[k] || k !== 'title') f[k].value = d[k] || ''; });
            if (d.coverUrl) { form.cover.remoteUrl = d.coverUrl; form.cover.data = ''; form.cover.removed = false; renderCover(); }
            ow.remove();
            toast('Fiche remplacée : vérifie puis enregistre.');
          };
          if (!editing) f.title.focus();
          return;
        } else {
          html += '<span class="muted">Aucune information trouvée pour cet ISBN : complète la fiche à la main.</span>';
        }
        out.innerHTML = html;
        if (!editing) f.title.focus();
      } catch (err) {
        out.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
      }
    }
    // Pas d'ISBN : editions trouvees par titre + auteur (ou texte libre), a choisir.
    // Fiche avec fichier epub : l'ISBN cite dans le fichier est propose en premier.
    async function searchEditions(params) {
      const out = $('#isbn-result');
      out.innerHTML = '<span class="muted">Recherche des éditions…</span>';
      try {
        if (editing) params.bookId = b.id;
        const r = await api(`/api/isbn-search?${new URLSearchParams(params)}`);
        const row = (e) => `<li>
            <div class="cover">${e.coverUrl ? `<img src="${esc(e.coverUrl)}" alt="" loading="lazy">` : ''}</div>
            <div><strong>${esc(e.title || 'Sans titre')}</strong>${e.authors ? ` — ${esc(e.authors)}` : ''}
              <div class="small muted">${[e.publisher, e.year, e.pages ? `${e.pages} p.` : '', e.isbn, (e.sources || []).join(', ')].filter(Boolean).map(esc).join(' · ')}</div></div>
            <button class="btn btn-small" type="button" data-pick="${e.isbn}">Choisir</button></li>`;
        let html = '';
        if (r.fromFile) html += `<div class="info-box">ISBN cité dans le fichier epub : <strong>${esc(r.fromFile)}</strong> <button class="btn btn-small btn-primary" type="button" data-pick="${r.fromFile}">Utiliser</button></div>`;
        html += r.editions.length
          ? `<ul class="edition-list">${r.editions.map(row).join('')}</ul>`
          : '<span class="muted">Aucune édition trouvée : essaie un titre plus court ou sans l\'auteur.</span>';
        out.innerHTML = html;
        $$('[data-pick]', out).forEach((btn) => { btn.onclick = () => { const isbn = btn.dataset.pick; $('#isbn-search').value = isbn; lastLookup = isbn; lookup(isbn); }; });
      } catch (err) {
        out.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
      }
    }
    // Saisie libre : un ISBN -> fiche ; sinon recherche d'editions.
    const searchInput = (raw) => {
      const isbn = isbnFromCell(raw).isbn;
      if (isbn) { lastLookup = isbn; lookup(isbn); } else if (/\d{9,}/.test(raw.replace(/[\s-]/g, ''))) lookup(raw);
      else if (raw.trim()) searchEditions({ q: raw.trim() });
    };
    // Recherche automatique des qu'un ISBN complet et valide est saisi (scan, frappe,
    // collage ou lecteur de codes-barres USB) : pas besoin de cliquer sur Rechercher.
    let lastLookup = '';
    const autoLookup = (raw, force) => {
      const isbn = isbnFromCell(raw).isbn;
      if (!isbn || (!force && isbn === lastLookup)) return;
      lastLookup = isbn;
      lookup(isbn);
    };
    $('#isbn-go').onclick = () => { lastLookup = ''; searchInput($('#isbn-search').value); };
    $('#isbn-title').onclick = () => {
      if (!f.title.value.trim()) { toast('Indique d\'abord le titre dans la fiche.'); f.title.focus(); return; }
      searchEditions({ title: f.title.value.trim(), author: f.authors.value.split(',')[0].trim() });
    };
    $('#isbn-search').addEventListener('input', debounce((e) => autoLookup(e.target.value), 300));
    $('#isbn-search').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      searchInput(e.target.value);
    });
    $('#isbn-scan').onclick = async () => {
      const isbn = await scanIsbn();
      if (isbn) { $('#isbn-search').value = isbn; lastLookup = isbn; lookup(isbn); }
    };
    // Souhait ajoute a la bibliotheque : champs repris, son auteur coche comme lecteur.
    const wish = !editing ? pendingWish : null;
    pendingWish = null;
    if (wish) {
      ['isbn', 'title', 'subtitle', 'authors', 'publisher', 'year'].forEach((k) => { if (wish[k] && f[k]) f[k].value = wish[k]; });
      if (wish.notes && f.notes) f.notes.value = wish.notes;
      const reader = $(`[data-reader="${wish.owner.id}"]`, f);
      if (reader) reader.checked = true;
      if (wish.coverUrl && !wish.isbn) { form.cover.remoteUrl = wish.coverUrl; form.cover.url = wish.coverUrl; renderCover(); }
      if (wish.isbn) pendingAddIsbn = wish.isbn;
      $('#isbn-result').insertAdjacentHTML('beforebegin', `<div class="info-box" style="margin-top:8px">Souhait de <strong>${esc(wish.owner.username)}</strong> : il sera retiré de ses souhaits à l'enregistrement.</div>`);
    }
    // ISBN scanne absent de la bibliotheque (bouton Scanner) : recherche lancee.
    if (!editing && pendingAddIsbn) {
      const isbn = pendingAddIsbn;
      pendingAddIsbn = null;
      $('#isbn-search').value = isbn;
      lastLookup = isbn;
      lookup(isbn);
    }

    f.onsubmit = async (e) => {
      e.preventDefault();
      addCat();
      addTag();
      const btn = $('button[type=submit]', f);
      btn.disabled = true;
      const body = {
        isbn: f.isbn.value, title: f.title.value, subtitle: f.subtitle.value, authors: f.authors.value,
        publisher: f.publisher.value, collection: f.collection.value, series: f.series.value, seriesNumber: f.seriesNumber.value, year: f.year.value, pages: f.pages.value, summary: f.summary.value,
        notes: f.notes.value, categories: form.categories,
        tags: features().tags ? form.tags : undefined,
        coverData: form.cover.data || undefined,
        coverUrl: !form.cover.data && form.cover.remoteUrl ? form.cover.remoteUrl : undefined,
        removeCover: form.cover.removed || undefined,
      };
      if (!editing) {
        body.copies = Math.max(0, Number(f.copies.value) || 0);
        body.location = f.location.value;
        body.ebook = !!(f.ebook && f.ebook.checked);
      }
      if ($$('[data-reader]', f).length) body.readers = $$('[data-reader]', f).filter((x) => x.checked).map((x) => Number(x.dataset.reader));
      try {
        const saved = await api(editing ? `/api/books/${b.id}` : '/api/books', { method: editing ? 'PUT' : 'POST', body });
        if (editing) toast('Fiche enregistrée.');
        else {
          const codes = saved.copies.filter((c) => c.format !== 'ebook').map((c) => c.code);
          toast(codes.length ? `Livre ajouté : ${codes.join(', ')}. Étiquette(s) en attente d'impression.` : 'Livre ajouté.');
          if (wish) {
            await gapi(`/api/wishes/${wish.id}/added`, { method: 'POST', body: { library: LIBRARY.id, bookId: saved.id } })
              .catch((err) => toast(`Souhait non retiré : ${err.message}`, 'error'));
          }
        }
        if (fromIncomplete) sessionStorageTake('mll-after-edit');
        go(fromIncomplete || `#/book/${saved.id}`);
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
    { key: 'collection', label: 'Collection (éditeur)', aliases: ['collection', 'collection editeur'] },
    { key: 'series', label: 'Série', aliases: ['serie', 'series', 'saga', 'cycle'] },
    { key: 'seriesNumber', label: 'Tome', aliases: ['tome', 'n tome', 'numero de tome', 'volume', 'n dans la serie', 'numero dans la serie', 'n dans la collection', 'numero dans la collection', 'numero', 'num', 'no'] },
    { key: 'tags', label: 'Tags', aliases: ['tags', 'tag', 'mots cles', 'mots-cles', 'motscles', 'keywords', 'etiquettes libres'] },
    { key: 'readers', label: 'Lecteurs (noms des comptes)', aliases: ['lecteurs', 'lecteur', 'readers', 'reader', 'lu par', 'lecture par'] },
    { key: 'format', label: 'Type (Papier, Numérique ou Papier + numérique)', aliases: ['type', 'format', 'support', 'type de livre', 'numerique', 'version'] },
    { key: 'bookId', label: 'ID fiche (mise à jour)', aliases: ['id fiche', 'id', 'identifiant', 'id livre'] },
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

  // Champ "pastilles" (categories, tags) : saisie avec suggestions, Entree ou
  // Ajouter pour valider, x pour retirer. Renvoie la fonction d'ajout.
  function chipField(prefix, list, shown = (v) => v) {
    const render = () => {
      $(`#${prefix}-chips`).innerHTML = list.map((c, i) => `<span class="chip">${esc(shown(c))}<button type="button" data-i="${i}" aria-label="Retirer">×</button></span>`).join('');
      $$(`#${prefix}-chips button`).forEach((btn) => { btn.onclick = () => { list.splice(Number(btn.dataset.i), 1); render(); }; });
    };
    const add = () => {
      const input = $(`#${prefix}-input`);
      input.value.split(',').map((v) => v.trim().replace(/^#/, '')).filter(Boolean).forEach((v) => {
        if (!list.some((c) => c.toLowerCase() === v.toLowerCase())) list.push(v);
      });
      input.value = '';
      render();
    };
    render();
    // Liste deroulante filtrante des termes existants ; un nom nouveau s'ajoute avec
    // Entree ou le bouton Ajouter.
    const input = $(`#${prefix}-input`);
    const dl = $(`#${prefix}-list`);
    const existing = dl ? Array.from(dl.options).map((o) => o.value) : [];
    combo(input, existing.map((v) => ({ label: shown(v), value: v })), (it) => { input.value = it.value; add(); },
      { emptyText: 'Nouveau : Entrée ou « Ajouter » pour le créer' });
    $(`#${prefix}-add`).onclick = add;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    return add;
  }
  // Pastilles de l'import (categories / tags) : meme saisie que dans la fiche du livre.
  function termField(prefix, label, names, placeholder) {
    return `<div class="field"><label for="${prefix}-input">${label}</label>
      <div id="${prefix}-chips"></div>
      <div class="isbn-row"><input id="${prefix}-input" placeholder="${placeholder}" autocomplete="off">
        <button class="btn" type="button" id="${prefix}-add">Ajouter</button></div>
      <datalist id="${prefix}-list">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>`;
  }

  // Options communes envoyees avec chaque ligne importee.
  function importOptions(extra) {
    const toRead = $('#opt-toread');
    const dup = $('#opt-dup').value;
    // Lecteurs coches (pas en mise a jour : seule la colonne "Lecteurs" compte).
    const readers = dup === 'update' ? undefined : importState.readers || [];
    return { onDuplicate: dup, markToRead: !!(toRead && toRead.checked), readers, ...extra };
  }

  const importState = { mode: 'scan', text: '', fileName: '', rows: null, mapping: [], items: [], results: null, running: false, stop: false, batch: [], cats: [], tags: [], toRead: true, readers: null };

  // Import de fichiers epub : un fichier par requete, a la suite (fiche creee, ou fichier
  // ajoute a la fiche existante).
  function renderEpubImport(body) {
    body.innerHTML = `
      <div class="card">
        <div class="field"><label>Fichiers epub ${hint('Une fiche est créée pour chaque fichier d\'après ses informations (titre, auteurs, résumé, série, couverture). Si la fiche existe déjà (même ISBN, ou même titre et auteur), le fichier lui est ajouté.')}</label>
          <input type="file" id="epub-files" accept=".epub,application/epub+zip" multiple></div>
        <div class="btn-row"><button class="btn btn-primary" id="epub-go" disabled>Importer</button></div>
      </div>
      <div id="epub-results"></div>`;
    const input = $('#epub-files', body);
    const goBtn = $('#epub-go', body);
    input.onchange = () => {
      goBtn.disabled = !input.files.length;
      goBtn.textContent = input.files.length ? `Importer ${input.files.length} fichier(s)` : 'Importer';
    };
    goBtn.onclick = async () => {
      const files = [...input.files];
      goBtn.disabled = true;
      input.disabled = true;
      importState.running = true;
      const out = $('#epub-results', body);
      const LABELS = {
        created: '<span class="badge badge-ok">Ajouté</span>',
        attached: '<span class="badge badge-ok">Fichier ajouté à la fiche</span>',
        skipped: '<span class="badge badge-muted">Déjà présent</span>',
      };
      const rows = files.map((f) => ({ name: f.name, html: '<span class="small muted">En attente…</span>' }));
      const draw = () => {
        out.innerHTML = `<div class="card table-wrap"><table><tbody>${rows.map((r) => `<tr><td class="small">${esc(r.name)}</td><td>${r.html}</td></tr>`).join('')}</tbody></table></div>`;
      };
      for (const [n, f] of files.entries()) {
        rows[n].html = '<span class="small muted">Envoi…</span>';
        draw();
        try {
          if (f.size > 100 * 1024 * 1024) throw new Error('Fichier trop lourd (100 Mo max).');
          const r = await sendRaw('/api/import/epub', 'POST', f, 'application/epub+zip', { 'X-File-Name': encodeURIComponent(f.name) });
          rows[n].html = `${LABELS[r.status] || ''} <a href="#/book/${r.bookId}">${esc(r.title)}</a>`;
        } catch (err) {
          rows[n].html = `<span class="badge badge-warn">Erreur</span> <span class="small">${esc(err.message)}</span>`;
        }
        draw();
      }
      importState.running = false;
      input.value = '';
      input.disabled = false;
      goBtn.textContent = 'Importer';
      toast('Import terminé.');
    };
  }

  async function viewImport() {
    const s = importState;
    const [locations, allCats, allTags, members] = await Promise.all([
      api('/api/locations').catch(() => []),
      api('/api/categories').catch(() => []),
      features().tags ? api('/api/tags').catch(() => []) : [],
      loadMembers().catch(() => []),
    ]);
    // Par defaut, le compte qui importe est lecteur des livres ajoutes.
    if (!s.readers) s.readers = [state.user.id];
    const tpl = (type, ext) => `${LIB}/api/import/template.${ext}${type === 'isbn' ? '?type=isbn' : ''}`;
    view().innerHTML = `
      <p><a href="#/add">← Ajouter un livre</a></p>
      <div class="page-head"><div><h1>Ajout multiple ${hint('Ajoute d\'un coup plusieurs livres. Les exemplaires et leurs codes sont créés automatiquement ; leurs étiquettes passent « en attente ».')}</h1></div>
        <a class="btn" href="#/incomplete">Fiches incomplètes</a></div>
      <div class="seg seg-${features().ebooks ? 4 : 3}" style="max-width:${features().ebooks ? 820 : 640}px">
        <button type="button" data-mode="scan" class="${s.mode === 'scan' ? 'active' : ''}">Scanner en série</button>
        <button type="button" data-mode="isbn" class="${s.mode === 'isbn' ? 'active' : ''}">Liste d'ISBN</button>
        <button type="button" data-mode="full" class="${s.mode === 'full' ? 'active' : ''}">Fichier complet</button>
        ${features().ebooks ? `<button type="button" data-mode="epub" class="${s.mode === 'epub' ? 'active' : ''}">Fichiers epub</button>` : ''}
      </div>
      <div id="import-body"></div>`;
    $$('.seg button').forEach((btn) => {
      btn.onclick = () => {
        if (s.running || btn.dataset.mode === s.mode) return;
        if (pageCleanup) { pageCleanup(); pageCleanup = null; }
        Object.assign(s, { mode: btn.dataset.mode, rows: null, mapping: [], items: [], results: null, fileName: '' });
        viewImport();
      };
    });
    const body = $('#import-body');
    if (s.mode === 'epub' && features().ebooks) return renderEpubImport(body);

    const formatOption = features().ebooks ? `
      <div class="field"><label>Exemplaires à créer ${hint('Papier : avec code et étiquette. Numérique (epub, pdf…) : sans code ni étiquette.')}</label><select id="opt-format">
        <option value="physical">Papier</option>
        <option value="both">Papier + numérique</option>
        <option value="ebook">Numérique seul</option>
      </select></div>` : '';
    const options = `
      <div class="grid-2">
        ${s.mode !== 'full' ? `
          ${s.mode === 'isbn' ? `<div class="field"><label>Exemplaires par ISBN ${hint('Exemplaires papier. Un ISBN présent plusieurs fois dans la liste compte pour plusieurs exemplaires.')}</label><input type="number" id="opt-copies" min="1" max="50" value="1"></div>` : ''}
          ${formatOption}
          <div class="field"><label>Emplacement</label><input id="opt-location" list="loc-list" placeholder="facultatif"></div>
          ${termField('icat', 'Catégories', allCats.map((c) => c.name), 'Choisir ou créer une catégorie…')}
          ${features().tags ? termField('itag', 'Tags', allTags.map((t) => t.name), 'Choisir ou créer un tag…') : ''}` : `
          <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" id="opt-fill" checked> Compléter via l'ISBN ${hint('Les champs vides d\'un nouveau livre sont complétés par la recherche ISBN ; les valeurs du fichier restent prioritaires.')}</label></div>
          <div class="field"><label>Emplacement par défaut ${hint('Utilisé pour les nouveaux livres quand la colonne Emplacement est vide.')}</label><input id="opt-location" list="loc-list" placeholder="facultatif"></div>`}
        <div class="field"><label>ISBN déjà au catalogue ${hint(`Ajouter les exemplaires : au livre existant (le numérique s'il manque). Ignorer : la ligne n'est pas importée. Nouvelle fiche : crée un doublon.${s.mode === 'full' ? ' Mettre à jour : les colonnes remplies du fichier écrasent celles de la fiche (repérée par la colonne « ID fiche » des exports, sinon par l\'ISBN) ; aucun exemplaire créé, l\'emplacement rempli s\'applique aux exemplaires papier.' : ''}`)}</label><select id="opt-dup">
          <option value="copy">Ajouter les exemplaires</option>
          ${s.mode === 'full' ? `<option value="update" ${s.dup === 'update' ? 'selected' : ''}>Mettre à jour la fiche</option>` : ''}
          <option value="skip">Ignorer la ligne</option>
          <option value="new">Nouvelle fiche</option>
        </select></div>
        ${features().readingStatus ? `<div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" id="opt-toread" ${s.toRead ? 'checked' : ''}>
          « À lire » pour moi ${hint('Marque les nouveaux livres « À lire » dans ton statut de lecture.')}</label></div>` : ''}
        ${members.length ? `<div class="field"><label>Lecteurs ${hint(`Comptes qui lisent ou liront ces livres (ajoutés aussi aux livres déjà au catalogue).${s.mode === 'full' ? ' La colonne « Lecteurs » du fichier, si elle est remplie, est prioritaire. En mise à jour, seule la colonne compte.' : ''}`)}</label>
          <div class="btn-row">${members.map((m) => `<label class="check"><input type="checkbox" data-reader="${m.id}" ${s.readers.includes(m.id) ? 'checked' : ''}> ${m.id === state.user.id ? 'Moi' : esc(m.username)}</label>`).join('')}</div></div>` : ''}
      </div>
      <datalist id="loc-list">${locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>`;

    const bindOptions = () => {
      if ($('#icat-input')) chipField('icat', s.cats);
      if ($('#itag-input')) chipField('itag', s.tags, (t) => '#' + t);
      const toRead = $('#opt-toread');
      if (toRead) toRead.onchange = () => { s.toRead = toRead.checked; };
      $$('[data-reader]').forEach((cb) => {
        cb.onchange = () => { s.readers = $$('[data-reader]').filter((x) => x.checked).map((x) => Number(x.dataset.reader)); };
      });
      $('#opt-dup').onchange = (e) => { s.dup = e.target.value; };
    };
    if (s.mode === 'scan') {
      batchScan(body, options);
      bindOptions();
    } else if (s.mode === 'isbn') {
      body.innerHTML = `
        <div class="card">
          <h3 style="margin-top:0">1. La liste</h3>
          <div class="field"><label for="isbn-list">ISBN ${hint('Un par ligne, ou séparés par des espaces, virgules… Tu peux aussi charger un fichier (.xlsx, .csv, .txt).')}</label>
            <textarea id="isbn-list" placeholder="9782070612758&#10;978-2-07-036822-8&#10;…">${esc(s.text)}</textarea></div>
          <div class="btn-row">
            <label class="btn btn-small" style="margin:0">Fichier…<input type="file" id="import-file" accept=".xlsx,.csv,.txt" hidden></label>
            <span class="small muted" id="file-name">${esc(s.fileName)}</span>
            <span style="margin-left:auto" class="small">Modèle : <a href="${tpl('isbn', 'xlsx')}">Excel</a> · <a href="${tpl('isbn', 'csv')}">CSV</a></span>
          </div>
          <h3>2. Options</h3>
          ${options}
          <button class="btn btn-primary" id="analyse">Analyser la liste</button>
        </div>
        <div id="preview"></div>`;
      bindOptions();
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
        const categories = s.cats.join(',');
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
        const format = $('#opt-format') ? $('#opt-format').value : 'physical';
        const tags = features().tags ? s.tags.join(',') : undefined;
        s.items = Array.from(counts).map(([isbn, copies]) => ({ data: { isbn, copies, location, categories, tags, format }, label: isbn }));
        s.items.push(...errors.map((e) => ({ error: e, label: '' })));
        s.options = importOptions({ fillFromIsbn: true });
        s.results = null;
        renderPreview();
      };
    } else {
      body.innerHTML = `
        <div class="card">
          <h3 style="margin-top:0">1. Le fichier ${hint('Une ligne par livre, une colonne par champ. Seul l\'ISBN ou le titre est obligatoire ; les autres colonnes sont facultatives, dans n\'importe quel ordre. Un export (inventaire, fiches incomplètes) peut être réimporté tel quel.')}</h3>
          <div class="btn-row">
            <label class="btn" style="margin:0">Choisir le fichier<input type="file" id="import-file" accept=".xlsx,.csv" hidden></label>
            <span class="small muted">${esc(s.fileName)}</span>
            <span style="margin-left:auto" class="small">Modèle : <a href="${tpl('full', 'xlsx')}">Excel</a> · <a href="${tpl('full', 'csv')}">CSV</a></span>
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
          <p class="small muted">${s.rows.length - 1} ligne(s) ${hint('Vérifie à quel champ correspond chaque colonne.')}</p>
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
        const update = $('#opt-dup').value === 'update';
        const defLocation = update ? '' : $('#opt-location').value.trim();
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
          if (!d.title && !fill && !update) return { error: `${line} : titre manquant (active « Compléter via l'ISBN »).`, label: line };
          return { data: d, label: d.title || d.isbn, warning: ir.error ? `ISBN non valide, importé tel quel` : '' };
        });
        s.options = importOptions({ fillFromIsbn: fill });
        s.results = null;
        renderPreview();
      };
    }
    if (s.items.length) renderPreview();
  }

  // Petit bip de confirmation (scan en serie), sans fichier son.
  let audioCtx = null;
  function beep(ok = true) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = ok ? 1175 : 330;
      g.gain.value = 0.08;
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + (ok ? 0.09 : 0.25));
    } catch (e) { /* audio indisponible */ }
  }

  // Scan en serie : la camera reste ouverte, chaque code-barres lu s'ajoute a une
  // liste (miniature de couverture + titre des que la recherche aboutit). Les fiches
  // sont creees ensuite en une fois.
  function batchScan(body, options) {
    const s = importState;
    const lastSeen = new Map();
    let camera = null;
    let queue = Promise.resolve();

    body.innerHTML = `
      <div class="card">
        <div class="batch-layout">
          <div>
            <div class="scanner-video barcode" id="batch-video-box" hidden><video playsinline muted id="batch-video"></video><div class="frame"></div></div>
            <div class="btn-row">
              <button class="btn btn-primary" type="button" id="cam-toggle">Démarrer la caméra</button>
              <label class="btn" style="margin:0">Photo<input type="file" id="batch-photo" accept="image/*" capture="environment" hidden></label>
            </div>
            <p class="small muted" style="margin-top:8px"><span id="batch-status">Un bip confirme chaque livre scanné.</span> ${hint('Scanne les livres les uns après les autres. Un lecteur de codes-barres USB fonctionne aussi dans le champ ci-dessous.')}</p>
            <form class="isbn-row" id="batch-manual">
              <input name="isbn" placeholder="ISBN tapé ou lu par un lecteur USB" inputmode="numeric" autocomplete="off">
              <button class="btn" type="submit">Ajouter</button>
            </form>
          </div>
          <div>
            <div class="btn-row" style="justify-content:space-between"><h3 style="margin:0">Livres scannés (<span id="batch-count">0</span>)</h3>
              <button class="btn btn-small btn-danger" type="button" id="batch-clear">Vider</button></div>
            <div id="batch-list" style="margin-top:8px"></div>
          </div>
        </div>
        <h3>Options</h3>
        ${options}
        <div class="btn-row"><button class="btn btn-primary" type="button" id="batch-create">Créer les fiches</button></div>
      </div>
      <div id="preview"></div>`;

    const status = (msg) => { $('#batch-status').textContent = msg; };

    function itemHtml(it, i) {
      const f = it.found;
      const img = f && f.coverUrl ? `<img class="thumb" src="${esc(f.coverUrl)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<span class="thumb"></span>';
      const title = it.state === 'loading' ? '<span class="muted">Recherche…</span>'
        : f ? `<strong>${esc(f.title)}</strong><div class="small muted">${esc(f.authors || '')}${f.year ? ' · ' + f.year : ''}</div>`
          : '<span style="color:var(--warn)">Introuvable</span><div class="small muted">sera créé si un titre est trouvé, sinon ignoré</div>';
      return `<div class="list-item batch-item ${it.flash ? 'flash' : ''}">
        ${img}
        <div class="grow">${title}<div class="small code muted">${esc(it.isbn)}</div>
          ${it.existing && it.existing.length ? `<span class="badge badge-warn">Déjà au catalogue</span>` : ''}</div>
        <div class="qty"><button type="button" data-dec="${i}" aria-label="Un exemplaire de moins">−</button><span>${it.copies}</span><button type="button" data-inc="${i}" aria-label="Un exemplaire de plus">+</button></div>
        <button type="button" class="rm" data-rm="${i}" aria-label="Retirer">×</button>
      </div>`;
    }

    function renderList() {
      $('#batch-count').textContent = s.batch.length;
      const list = $('#batch-list');
      if (!list) return;
      list.innerHTML = s.batch.length ? `<div class="list">${s.batch.map(itemHtml).join('')}</div>`
        : '<p class="muted small">Aucun livre scanné pour le moment.</p>';
      $('#batch-create').textContent = s.batch.length ? `Créer ${s.batch.length} fiche(s)` : 'Créer les fiches';
      $('#batch-create').disabled = !s.batch.length || s.running;
      $$('[data-inc]', list).forEach((b) => { b.onclick = () => { s.batch[Number(b.dataset.inc)].copies++; renderList(); }; });
      $$('[data-dec]', list).forEach((b) => { b.onclick = () => { const it = s.batch[Number(b.dataset.dec)]; if (it.copies > 1) it.copies--; renderList(); }; });
      $$('[data-rm]', list).forEach((b) => { b.onclick = () => { s.batch.splice(Number(b.dataset.rm), 1); renderList(); }; });
      s.batch.forEach((it) => { it.flash = false; });
    }

    function lookupItem(it) {
      queue = queue.then(async () => {
        try {
          const r = await api(`/api/isbn/${it.isbn}`);
          it.found = r.found;
          it.existing = r.existing;
          it.state = r.found ? 'found' : 'notfound';
        } catch (e) { it.state = 'notfound'; }
        renderList();
      });
    }

    // Nouvel ISBN : ajoute en tete de liste ; deja present : un exemplaire de plus
    // (sauf s'il vient d'etre lu : la camera le voit encore).
    function addIsbn(isbn, fromCamera) {
      const now = Date.now();
      if (fromCamera && now - (lastSeen.get(isbn) || 0) < 2500) { lastSeen.set(isbn, now); return; }
      lastSeen.set(isbn, now);
      const existing = s.batch.find((it) => it.isbn === isbn);
      beep(true);
      if (navigator.vibrate) navigator.vibrate(60);
      if (existing) {
        existing.copies++;
        existing.flash = true;
        status(`${isbn} déjà dans la liste : ${existing.copies} exemplaires.`);
      } else {
        const it = { isbn, copies: 1, state: 'loading', flash: true };
        s.batch.unshift(it);
        status(`✓ ${isbn} ajouté.`);
        lookupItem(it);
      }
      renderList();
    }

    const accept = (raw) => isbnFromScan(raw);
    $('#cam-toggle').onclick = () => {
      if (camera) {
        camera.stop();
        camera = null;
        $('#batch-video-box').hidden = true;
        $('#cam-toggle').textContent = 'Démarrer la caméra';
        return;
      }
      $('#batch-video-box').hidden = false;
      $('#cam-toggle').textContent = 'Arrêter la caméra';
      camera = startCamera({
        video: $('#batch-video'),
        formats: ['ean_13'],
        accept,
        hint: 'Présente les codes-barres les uns après les autres.',
        onStatus: status,
        onValue: (isbn) => { addIsbn(isbn, true); return false; },
      });
    };
    onLeave(() => { if (camera) camera.stop(); });
    $('#batch-photo').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      status('Analyse de la photo…');
      try {
        const values = await decodePhoto(file, ['ean_13'], accept);
        if (values.length) values.forEach((v) => addIsbn(v, false));
        else { beep(false); status('Aucun code-barres lisible sur la photo.'); }
      } catch (err) { status('Analyse impossible : ' + err.message); }
      e.target.value = '';
    };
    $('#batch-manual').onsubmit = (e) => {
      e.preventDefault();
      const r = isbnFromCell(e.target.isbn.value);
      if (r.isbn) { addIsbn(r.isbn, false); e.target.reset(); } else { beep(false); status(r.error || 'ISBN non reconnu.'); }
    };
    $('#batch-clear').onclick = () => {
      if (s.batch.length && !confirm('Vider la liste des livres scannés ?')) return;
      s.batch = [];
      renderList();
    };
    $('#batch-create').onclick = () => {
      if (!s.batch.length) return;
      const location = $('#opt-location').value.trim();
      const categories = s.cats.join(',');
      const format = $('#opt-format') ? $('#opt-format').value : 'physical';
      // Les informations deja trouvees sont envoyees telles quelles (pas de 2e recherche).
      s.items = s.batch.slice().reverse().map((it) => {
        const f = it.found || {};
        return {
          label: f.title || it.isbn,
          data: {
            isbn: it.isbn, copies: it.copies, location, categories, format,
            tags: features().tags ? s.tags.join(',') : undefined,
            collection: f.collection || '',
            title: f.title || '', subtitle: f.subtitle || '', authors: f.authors || '', publisher: f.publisher || '',
            year: f.year || '', pages: f.pages || '', summary: f.summary || '', coverUrl: f.coverUrl || '',
          },
        };
      });
      s.options = importOptions({ fillFromIsbn: true });
      s.results = null;
      if (camera) $('#cam-toggle').click();
      renderPreview();
      runImport().then(() => { s.batch = s.batch.filter((it, i) => { const r = s.results && s.results[s.batch.length - 1 - i]; return !r || r.status === 'error'; }); renderList(); });
    };
    renderList();
  }

  function renderPreview() {
    const s = importState;
    const ok = s.items.filter((i) => i.data);
    const bad = s.items.filter((i) => i.error);
    const copies = ok.reduce((n, i) => n + (i.data.copies || 1), 0);
    const statusHtml = (r) => {
      if (!r) return '<span class="small muted">en attente</span>';
      if (r.status === 'created') return `<span class="badge badge-ok">Ajouté</span> <a href="#/book/${r.bookId}">${esc(r.title)}</a> <span class="small muted code">${esc(r.codes.join(', '))}</span> ${r.ebook ? '<span class="badge badge-ebook">+ numérique</span>' : ''}`;
      if (r.status === 'copies') return `${r.codes.length ? `<span class="badge badge-ok">+ ${r.codes.length} ex.</span> ` : ''}<a href="#/book/${r.bookId}">${esc(r.title)}</a> <span class="small muted code">${esc(r.codes.join(', '))}</span> ${r.ebook ? '<span class="badge badge-ebook">+ numérique</span>' : ''}`;
      if (r.status === 'skipped') return `<span class="badge badge-muted">Ignoré</span> déjà au catalogue : <a href="#/book/${r.bookId}">${esc(r.title)}</a>`;
      if (r.status === 'updated') return `<span class="badge badge-ok">Mis à jour</span> <a href="#/book/${r.bookId}">${esc(r.title)}</a> <span class="small muted">${esc(r.fields.join(', '))}</span>`;
      if (r.status === 'unchanged') return `<span class="badge badge-muted">Inchangé</span> <a href="#/book/${r.bookId}">${esc(r.title)}</a>`;
      return `<span class="badge badge-warn">Erreur</span> <span class="small">${esc(r.error)}</span>`;
    };
    const done = s.results ? s.results.filter(Boolean).length : 0;

    // Rapport filtrable : chaque ligne a un statut (lignes non valides de la liste
    // comprises), pour retrouver d'un coup ce qui n'a pas ete importe.
    const rows = ok.map((it, i) => ({ it, i, r: s.results ? s.results[i] : null }))
      .concat(bad.map((it) => ({ it, bad: true })));
    const keyOf = (row) => (row.bad ? 'invalid' : row.r ? row.r.status : 'pending');
    const notImported = (k) => k === 'error' || k === 'invalid' || k === 'skipped' || (k === 'pending' && s.results && !s.running);
    const count = (pred) => rows.filter((row) => pred(keyOf(row))).length;
    const filters = [
      { key: 'all', label: 'Tous', count: rows.length, test: () => true },
      { key: 'created', label: 'Ajoutés', count: count((k) => k === 'created'), test: (k) => k === 'created' },
      { key: 'copies', label: 'Exemplaires ajoutés', count: count((k) => k === 'copies'), test: (k) => k === 'copies' },
      { key: 'updated', label: 'Mis à jour', count: count((k) => k === 'updated'), test: (k) => k === 'updated' },
      { key: 'unchanged', label: 'Inchangés', count: count((k) => k === 'unchanged'), test: (k) => k === 'unchanged' },
      { key: 'skipped', label: 'Ignorés', count: count((k) => k === 'skipped'), test: (k) => k === 'skipped' },
      { key: 'error', label: 'Erreurs', count: count((k) => k === 'error' || k === 'invalid'), test: (k) => k === 'error' || k === 'invalid' },
      { key: 'not', label: 'Non importés', count: count(notImported), test: notImported },
      { key: 'pending', label: 'En attente', count: count((k) => k === 'pending'), test: (k) => k === 'pending' },
    ];
    let filter = s.filter || 'all';
    if (!filters.some((f) => f.key === filter && (f.count || f.key === 'all'))) filter = 'all';
    const shown = rows.filter((row) => filters.find((f) => f.key === filter).test(keyOf(row)));
    const errorRows = rows.filter((row) => !row.bad && keyOf(row) === 'error');
    const failedIsbns = errorRows.map((row) => row.it.data.isbn).filter(Boolean);
    const retryable = errorRows.map((row) => row.i);
    const summary = s.results && !s.running ? (() => {
      const c = (st) => s.results.filter((r) => r && r.status === st).length;
      return `<div class="info-box"><strong>Import terminé${s.stop ? ' (arrêté)' : ''}.</strong> ${c('created')} livre(s) ajouté(s), ${c('copies')} exemplaire(s) ajouté(s) à des livres existants${c('updated') || c('unchanged') ? `, ${c('updated')} fiche(s) mise(s) à jour, ${c('unchanged')} inchangée(s)` : ''}, ${c('skipped')} ignoré(s), ${c('error')} erreur(s).</div>
        <div class="btn-row" style="margin-bottom:12px"><button class="btn btn-primary" id="go-labels">Imprimer les étiquettes en attente</button><a class="btn" href="#/">Voir le catalogue</a></div>`;
    })() : '';
    $('#preview').innerHTML = `
      <h2>3. ${s.results ? 'Import' : 'Vérification'}</h2>
      <div class="card">
        ${summary}
        <p><strong>${ok.length} livre(s)</strong> à importer (${copies} exemplaire(s))${bad.length ? `, <span style="color:var(--danger)">${bad.length} ligne(s) en erreur ignorée(s)</span>` : ''}.
          ${s.mode === 'isbn' || s.options.fillFromIsbn ? hint('La recherche des informations prend 1 à 2 secondes par ISBN.') : ''}</p>
        ${s.running || s.results ? `<div style="background:var(--surface-2);border-radius:999px;height:10px;overflow:hidden;margin:12px 0"><div style="height:100%;width:${ok.length ? Math.round((done / ok.length) * 100) : 0}%;background:var(--accent);transition:width .2s"></div></div>
          <p class="small muted">${done} / ${ok.length}</p>` : ''}
        <div class="btn-row" style="margin:12px 0">
          ${s.running ? '<button class="btn btn-danger" id="stop">Arrêter</button>'
            : (!s.results && ok.length ? `<button class="btn btn-primary" id="run">Importer ${ok.length} livre(s)</button>` : '')}
          ${!s.running && failedIsbns.length ? `<button class="btn" id="copy-failed">Copier les ${failedIsbns.length} ISBN en erreur</button>` : ''}
          ${!s.running && retryable.length ? `<button class="btn" id="retry">Réessayer les ${retryable.length} erreur(s)</button>` : ''}
        </div>
        ${rows.length ? `
          <div class="chips-filter">${filters.filter((f) => f.key === 'all' || f.count).map((f) => `
            <button type="button" class="pill ${filter === f.key ? 'on pill-read' : ''}" data-filter="${f.key}">${f.label} (${f.count})</button>`).join('')}</div>
          <div class="table-wrap" style="max-height:460px;overflow:auto"><table><thead><tr><th>#</th><th>ISBN</th><th>Titre</th><th>Ex.</th><th>Résultat</th></tr></thead><tbody>
          ${shown.map((row) => row.bad
            ? `<tr><td class="small muted">—</td><td class="code small">—</td><td colspan="2" class="small">${esc(row.it.error)}</td><td><span class="badge badge-warn">Non valide</span></td></tr>`
            : `<tr><td class="small muted">${row.i + 1}</td><td class="code small">${esc(row.it.data.isbn || '—')}</td>
              <td>${row.it.data.title ? esc(row.it.data.title) : '<span class="muted small">(complété via l\'ISBN)</span>'}${row.it.warning ? `<div class="small" style="color:var(--warn)">${esc(row.it.warning)}</div>` : ''}</td>
              <td>${row.it.data.copies || 1}</td><td>${statusHtml(row.r)}</td></tr>`).join('')
            || '<tr><td colspan="5" class="muted small">Aucune ligne pour ce filtre.</td></tr>'}
          </tbody></table></div>` : ''}
      </div>`;
    $$('[data-filter]').forEach((btn) => { btn.onclick = () => { s.filter = btn.dataset.filter; renderPreview(); }; });
    const cf = $('#copy-failed');
    if (cf) cf.onclick = async () => {
      try { await navigator.clipboard.writeText(failedIsbns.join('\n')); toast('ISBN copiés : colle-les dans « Liste d\'ISBN » pour les réessayer plus tard.'); } catch (e) { prompt('ISBN en erreur :', failedIsbns.join(' ')); }
    };
    const rt = $('#retry');
    if (rt) rt.onclick = () => runImport(retryable);
    const run = $('#run');
    if (run) run.onclick = () => runImport();
    const stop = $('#stop');
    if (stop) stop.onclick = () => { s.stop = true; stop.disabled = true; stop.textContent = 'Arrêt après le livre en cours…'; };
    const gl = $('#go-labels');
    if (gl && !canConfigure()) gl.remove();
    else if (gl) gl.onclick = () => { state.labels = { mode: 'pending', manual: [] }; go('#/labels'); };
  }

  function warnBeforeLeaving(e) { e.preventDefault(); e.returnValue = ''; }

  // Import de toutes les lignes, ou seulement de celles indiquees (nouvel essai des erreurs).
  async function runImport(onlyIndexes) {
    const s = importState;
    const ok = s.items.filter((i) => i.data);
    if (!onlyIndexes || !s.results) { s.results = new Array(ok.length).fill(null); s.filter = 'all'; }
    const indexes = onlyIndexes || ok.map((_, i) => i);
    indexes.forEach((i) => { s.results[i] = null; });
    s.running = true;
    s.stop = false;
    window.addEventListener('beforeunload', warnBeforeLeaving);
    renderPreview();
    for (const i of indexes) {
      if (s.stop) break;
      try {
        // Lecteurs : colonne du fichier si remplie, sinon le choix des options.
        const body = { ...ok[i].data, ...s.options };
        if (ok[i].data.readers) body.readers = ok[i].data.readers; else if (!s.options.readers) delete body.readers;
        s.results[i] = await api('/api/import/book', { method: 'POST', body });
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

  // ================= Fiches incompletes =================
  // Livres sans une information donnee (categorie, ISBN, couverture...) : liste a
  // completer une a une, ou ouverte dans le catalogue pour la selection en masse.
  const MISSING_FIELDS = [
    ['category', 'Sans catégorie'], ['isbn', 'Sans ISBN'], ['cover', 'Sans couverture'], ['authors', 'Sans auteur'],
    ['publisher', 'Sans éditeur'], ['year', 'Sans année'], ['pages', 'Sans nombre de pages'], ['summary', 'Sans résumé'],
    ['location', 'Exemplaire sans emplacement'], ['tags', 'Sans tag'],
  ];
  const missingLabel = (k) => (MISSING_FIELDS.find(([key]) => key === k) || [k, 'Information manquante'])[1];
  // Informations que la recherche ISBN peut retrouver (relance en masse).
  const MISSING_REFILL = ['isbn', 'category', 'cover', 'authors', 'publisher', 'year', 'pages', 'summary'];
  // Informations absentes des catalogues en ligne : attribution en masse aux livres coches.
  const MISSING_ASSIGN = { location: 'Emplacement (ex. Étagère A)', tags: 'Tag(s), séparés par des virgules' };
  const REFILL_HINT = {
    isbn: 'ISBN cité dans le fichier epub, sinon recherche par titre + auteur (BnF) : l\'ISBN n\'est retenu que si une seule édition correspond (année, éditeur et pages de la fiche).',
    category: 'Seules tes catégories existantes sont attribuées, quand elles correspondent aux sujets trouvés en ligne.',
  };

  // Relance la recherche en ligne pour chaque livre sans cette information.
  // Deux livres a la fois ; le champ n'est rempli que s'il est toujours vide.
  async function refillMissing(key) {
    const btn = $('#missing-refill');
    const out = $('#refill-progress');
    const { ids } = await api(`/api/books/missing/${key}/ids?online=1`);
    const withWhat = key === 'isbn' ? '' : ' avec ISBN';
    if (!ids.length) { toast(`Aucun livre concerné${withWhat ? ' n\'a d\'ISBN' : ''}.`); return; }
    let done = 0, filled = 0, stop = false;
    btn.textContent = 'Arrêter';
    btn.onclick = () => { stop = true; btn.disabled = true; };
    out.hidden = false;
    window.addEventListener('beforeunload', warnBeforeLeaving);
    const show = () => { out.textContent = `Recherche en cours : ${done} / ${ids.length} · ${filled} complété${filled > 1 ? 's' : ''}`; };
    show();
    const queue = ids.slice();
    const worker = async () => {
      while (queue.length && !stop) {
        const id = queue.shift();
        try {
          const r = await api(`/api/books/${id}/refill`, { method: 'POST', body: { field: key } });
          if (r.status === 'filled') filled++;
        } catch (e) { /* livre suivant */ }
        done++;
        show();
      }
    };
    await Promise.all([worker(), worker()]);
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    toast(`${filled} livre${filled > 1 ? 's' : ''} complété${filled > 1 ? 's' : ''} sur ${done} recherché${done > 1 ? 's' : ''}.`);
    if (location.hash.startsWith('#/incomplete')) viewIncomplete(key);
  }

  function missingPills(m, current) {
    return MISSING_FIELDS.filter(([k]) => k in m.counts).map(([k, label]) => {
      const n = m.counts[k];
      return `<a class="pill${k === current ? ' pill-current' : ''}${n ? '' : ' pill-zero'}" href="#/incomplete/${k}">${esc(label)} <strong>${n}</strong></a>`;
    }).join('');
  }

  async function viewIncomplete(key) {
    const m = await api('/api/books/missing');
    const keys = MISSING_FIELDS.map(([k]) => k).filter((k) => k in m.counts);
    if (!key || !keys.includes(key)) key = keys.find((k) => m.counts[k] > 0) || keys[0];
    let page = 1;
    view().innerHTML = `
      <div class="page-head"><div><h1>Fiches incomplètes ${hint(`${m.total} livre${m.total > 1 ? 's' : ''} au catalogue. Choisis l'information manquante à rechercher.`)}</h1></div></div>
      <div class="chips-filter">${missingPills(m, key)}</div>
      <div class="card">
        <div class="btn-row" style="justify-content:space-between;margin-bottom:6px">
          <strong id="missing-count"></strong>
          <div class="btn-row" id="missing-actions">
            <span class="btn-row" style="gap:6px">Exporter
              <a class="btn btn-small" href="${LIB}/api/export/inventory.xlsx?missing=${key}">Excel</a>
              <a class="btn btn-small" href="${LIB}/api/export/inventory.csv?missing=${key}">CSV</a>
              ${hint('Exporte ces fiches pour les corriger dans Excel, puis réimporte le fichier : Ajout multiple › Fichier complet › « ISBN déjà au catalogue : Mettre à jour la fiche ». Seules les colonnes remplies écrasent les fiches.')}</span>
            <button class="btn btn-small" type="button" id="missing-catalog" title="Ouvrir dans le catalogue (sélection en masse)">Catalogue</button>
            ${MISSING_REFILL.includes(key) ? `<button class="btn btn-small btn-primary" type="button" id="missing-refill" hidden>Compléter tout</button>${hint(REFILL_HINT[key] || 'Relance la recherche en ligne pour chaque livre concerné ; le champ n\'est rempli que s\'il est toujours vide.')}` : ''}
          </div>
        </div>
        <div id="refill-progress" class="small muted" hidden></div>
        ${MISSING_ASSIGN[key] ? `<form class="btn-row" id="assign-form" hidden style="margin-bottom:8px">
          <label class="small"><input type="checkbox" id="assign-all"> Tout cocher</label>
          <input name="value" placeholder="${esc(MISSING_ASSIGN[key])}" required style="flex:1;min-width:160px">
          <button class="btn btn-small btn-primary" type="submit" title="Appliquer aux livres cochés">Appliquer</button>
        </form>` : ''}
        <div class="list" id="missing-list"></div>
        <div class="more" id="missing-more"></div>
      </div>`;
    $('#missing-catalog').onclick = () => {
      state.catalog = { q: '', category: '', status: '', sort: 'title', page: 1, missing: key };
      go('#/');
    };
    $('#missing-list').addEventListener('click', (e) => {
      const a = e.target.closest('[data-edit]');
      if (a) sessionStorageSet('mll-after-edit', JSON.stringify({ id: Number(a.dataset.edit), hash: `#/incomplete/${key}` }));
    });
    async function load() {
      const data = await api(`/api/books?${new URLSearchParams({ missing: key, sort: 'title', limit: 100, page })}`);
      $('#missing-count').textContent = data.total
        ? `${data.total} livre${data.total > 1 ? 's' : ''} · ${missingLabel(key).toLowerCase()}`
        : 'Aucun livre concerné.';
      $('#missing-actions').hidden = !data.total;
      if ($('#missing-refill') && page === 1) {
        $('#missing-refill').hidden = !data.total;
        $('#missing-refill').onclick = () => refillMissing(key);
      }
      if ($('#assign-form')) $('#assign-form').hidden = !data.total;
      const check = MISSING_ASSIGN[key];
      $('#missing-list').insertAdjacentHTML('beforeend', data.items.map((b) => `
        <div class="list-item">
          ${check ? `<input type="checkbox" class="assign-check" value="${b.id}"${checkAll ? ' checked' : ''} aria-label="Sélectionner">` : ''}
          ${b.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(b.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
          <div class="grow"><a href="#/book/${b.id}"><strong>${esc(b.title)}</strong></a>
            <div class="small muted">${esc([b.authors, b.publisher, b.year].filter(Boolean).join(' · ')) || '—'}</div></div>
          <a class="btn btn-small" href="#/book/${b.id}/edit" data-edit="${b.id}">Compléter</a>
        </div>`).join(''));
      const shown = (data.page - 1) * data.limit + data.items.length;
      $('#missing-more').innerHTML = shown < data.total ? '<button class="btn" type="button">Afficher plus</button>' : '';
      const more = $('#missing-more button');
      if (more) more.onclick = () => { page++; load(); };
    }
    // Attribution en masse (emplacement, tags). "Tout cocher" vaut aussi pour les
    // livres pas encore affiches (sauf ceux decoches a la main).
    let checkAll = false;
    if ($('#assign-form')) {
      $('#assign-all').onchange = (e) => {
        checkAll = e.target.checked;
        $$('.assign-check').forEach((c) => { c.checked = checkAll; });
      };
      $('#assign-form').onsubmit = async (e) => {
        e.preventDefault();
        const value = e.target.value.value.trim();
        const boxes = $$('.assign-check');
        let ids = boxes.filter((c) => c.checked).map((c) => Number(c.value));
        if (checkAll) {
          const unchecked = new Set(boxes.filter((c) => !c.checked).map((c) => Number(c.value)));
          ids = (await api(`/api/books/missing/${key}/ids`)).ids.filter((id) => !unchecked.has(id));
        }
        if (!ids.length) { toast('Coche au moins un livre.'); return; }
        const changes = key === 'location' ? { fillLocation: value } : { tagsAdd: value };
        const r = await api('/api/books/bulk-edit', { method: 'POST', body: { ids, changes } });
        toast(`${r.updated} livre${r.updated > 1 ? 's' : ''} mis à jour.`);
        viewIncomplete(key);
      };
    }
    await load();
  }

  // ================= Prets =================
  async function viewLoans() {
    let tab = loansTabNext || 'open';
    loansTabNext = null;
    view().innerHTML = `
      <div class="page-head"><h1>Prêts ${hint('Pour prêter ou enregistrer un retour, scanne le QR code de l\'étiquette ou tape le code de l\'exemplaire.')}</h1></div>
      <div class="card" style="margin-bottom:18px">
        <form class="isbn-row" id="code-form">
          <input name="code" placeholder="Code (ex. BIB-00042)" autocomplete="off" style="text-transform:uppercase">
          <button class="btn" type="submit">Ouvrir</button>
          <button class="btn btn-primary" type="button" id="scan">Scanner</button>
        </form>
      </div>
      <div class="tabs" id="loan-tabs"></div>
      <div class="card" id="loan-list"></div>`;
    $('#scan').onclick = () => scanAndOpen('loan');
    $('#code-form').onsubmit = (e) => {
      e.preventDefault();
      const code = copyCodeFromScan(e.target.code.value.trim());
      if (code) go(`#/c/${encodeURIComponent(code)}`);
      else toast('Code non reconnu.', 'error');
    };
    async function tabs() {
      const s = await api('/api/loans/summary');
      const auto = s.reminder && s.reminder.mode === 'auto';
      if (!auto && tab === 'remind') tab = 'open';
      $('#loan-tabs').innerHTML = [['open', `En cours (${s.open})`], ['overdue', `En retard (${s.overdue})`],
        ...(auto ? [['remind', `À relancer (${s.toRemind})`]] : []),
        ['reservations', `Réservations (${s.reservations})`], ['returned', 'Historique']]
        .map(([k, l]) => `<button type="button" data-tab="${k}" class="${k === tab ? 'active' : ''}" aria-pressed="${k === tab}">${l}</button>`).join('');
      $$('#loan-tabs button').forEach((btn) => {
        btn.onclick = () => { tab = btn.dataset.tab; tabs(); load(); };
      });
    }
    async function load() {
      if (tab === 'reservations') {
        const list = await api('/api/reservations');
        $('#loan-list').innerHTML = list.length ? `<div class="list">${list.map((r) => `<div class="list-item">
            ${r.book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(r.book.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
            <div class="grow">
              <a href="#/book/${r.book.id}"><strong>${esc(r.book.title)}</strong></a>
              <div class="small muted">Pour <a href="#/borrower/${r.borrower.id}">${esc(r.borrower.name)}</a> · le ${fmtDate(r.createdAt)}</div>
              <div>${r.available ? '<span class="badge badge-ok">Exemplaire disponible</span>' : '<span class="badge badge-muted">Tous prêtés</span>'}</div>
            </div>
            <button class="btn btn-small" type="button" data-del-res="${r.id}">Retirer</button>
          </div>`).join('')}</div>` : '<div class="empty">Aucune réservation.</div>';
        $$('[data-del-res]', $('#loan-list')).forEach((btn) => {
          btn.onclick = async () => {
            try { await api(`/api/reservations/${btn.dataset.delRes}`, { method: 'DELETE' }); tabs(); load(); } catch (err) { toast(err.message, 'error'); }
          };
        });
        return;
      }
      const loans = await api(`/api/loans?status=${tab}`);
      if (tab === 'remind') {
        // Un message par emprunteur, avec tous ses livres a relancer.
        const groups = new Map();
        loans.forEach((l) => { if (!groups.has(l.borrower.id)) groups.set(l.borrower.id, []); groups.get(l.borrower.id).push(l); });
        const list = [...groups.values()];
        $('#loan-list').innerHTML = list.length ? list.map((ls, i) => `<section class="remind-group" aria-labelledby="rg-${i}">
            <div class="remind-head"><h3 id="rg-${i}"><a href="#/borrower/${ls[0].borrower.id}">${esc(ls[0].borrower.name)}</a></h3>
              <span class="small muted grow">${esc(ls[0].borrower.email || "pas d'e-mail")}</span>
              <button class="btn btn-small btn-primary" type="button" data-remind-group="${i}">${icon('mail', 16)}Relancer (${ls.length} livre${ls.length > 1 ? 's' : ''})</button></div>
            <div class="list">${ls.map((l) => loanItemHtml(l, true)).join('')}</div></section>`).join('')
          : '<div class="empty">Aucun prêt à relancer.</div>';
        $$('[data-remind-group]').forEach((btn) => {
          btn.onclick = async () => {
            const ls = list[Number(btn.dataset.remindGroup)];
            try { if (await sendReminder(ls[0].borrower, ls)) { tabs(); load(); } } catch (err) { toast(err.message, 'error'); }
          };
        });
        return;
      }
      $('#loan-list').innerHTML = loans.length ? `<div class="list">${loans.map((l) => loanItemHtml(l)).join('')}</div>`
        : `<div class="empty">${{ open: 'Aucun prêt en cours.', overdue: 'Aucun prêt en retard.' }[tab] || 'Aucun prêt terminé.'}</div>`;
    }
    await Promise.all([tabs(), load()]);
  }

  function loanItemHtml(l, hideBorrower) {
    loanCache.set(l.id, l);
    return `<div class="list-item">
      ${l.book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(l.book.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
      <div class="grow">
        <a href="#/book/${l.book.id}"><strong>${esc(l.book.title)}</strong></a>
        <div class="small muted"><span class="code">${esc(l.copy.code)}</span>${hideBorrower ? '' : ` · <a href="#/borrower/${l.borrower.id}">${esc(l.borrower.name)}</a>`}</div>
        <div class="small muted">Prêté le ${fmtDate(l.loanedAt)}${l.returnedAt ? ` · rendu le ${fmtDate(l.returnedAt)}` : l.dueAt ? ` · ${dueHtml(l)}` : ''}${l.notes ? ' · ' + esc(l.notes) : ''}${!l.returnedAt && l.remindedAt ? ` · ${remindedHtml(l)}` : ''}</div>
      </div>
      ${l.returnedAt ? '' : `<div class="btn-row loan-actions">
        <button class="btn btn-small" type="button" data-remind="${l.id}" aria-label="Relancer ${esc(l.borrower.name)} pour « ${esc(l.book.title)} »">${icon('mail', 16)}<span>Relancer</span></button>
        <a class="btn btn-small btn-ok" href="#/c/${encodeURIComponent(l.copy.code)}" data-quick-return="${esc(l.copy.code)}" aria-label="Retour de « ${esc(l.book.title)} »">Retour</a></div>`}
    </div>`;
  }

  // ================= Emprunteurs =================
  async function viewBorrowers() {
    view().innerHTML = `
      <div class="page-head"><div><h1>Emprunteurs</h1></div>
        <div class="btn-row"><button class="btn btn-primary" type="button" id="show-new-borrower">+ Nouvel emprunteur</button></div></div>
      <form class="card" id="new-borrower" style="margin-bottom:18px" hidden>
        <div class="grid-3">
          <div class="field"><label>Nom *</label><input name="name" required></div>
          <div class="field"><label>E-mail</label><input name="email" type="email"></div>
          <div class="field"><label>Téléphone</label><input name="phone" type="tel"></div>
        </div>
        <div class="field"><label>Informations</label><textarea name="notes" style="min-height:60px" placeholder="Adresse, classe, remarques…"></textarea></div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Ajouter</button><button class="btn" type="button" id="cancel-new-borrower">Annuler</button></div>
      </form>
      <input type="search" id="bq" placeholder="Rechercher…" style="margin-bottom:12px">
      <div class="card" id="borrower-list"></div>`;
    async function load() {
      const list = await api(`/api/borrowers?q=${encodeURIComponent($('#bq').value)}`);
      $('#borrower-list').innerHTML = list.length ? `<div class="list">${list.map((b) => `
        <a class="list-item" href="#/borrower/${b.id}" style="text-decoration:none;color:inherit">
          <div class="grow"><strong>${esc(b.name)}</strong><div class="small muted">${esc([b.email, b.phone].filter(Boolean).join(' · '))}</div>${b.notes ? `<div class="small muted borrower-notes">${esc(b.notes)}</div>` : ''}</div>
          ${b.openLoans ? `<span class="badge badge-warn">${b.openLoans} en cours</span>` : ''}
          <span class="small muted">${b.totalLoans} prêt${b.totalLoans > 1 ? 's' : ''}</span>
        </a>`).join('')}</div>` : '<div class="empty">Aucun emprunteur.</div>';
    }
    $('#bq').addEventListener('input', debounce(load, 200));
    // Formulaire de creation : affiche a la demande seulement.
    const showForm = (on) => {
      $('#new-borrower').hidden = !on;
      $('#show-new-borrower').hidden = on;
      if (on) $('#new-borrower').name.focus(); else $('#new-borrower').reset();
    };
    $('#show-new-borrower').onclick = () => showForm(true);
    $('#cancel-new-borrower').onclick = () => showForm(false);
    $('#new-borrower').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/borrowers', { method: 'POST', body: { name: e.target.name.value, email: e.target.email.value, phone: e.target.phone.value, notes: e.target.notes.value } });
        showForm(false);
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
    const late = open.filter((l) => l.overdue).length;
    view().innerHTML = `
      <p><a href="#/borrowers">← Emprunteurs</a></p>
      <div class="page-head"><h1>${esc(b.name)}</h1>
        <div class="btn-row">${open.length ? `<button class="btn" type="button" id="remind-all">${icon('mail', 16)}Relancer (${open.length} livre${open.length > 1 ? 's' : ''})</button>` : ''}
        <button class="btn btn-primary" type="button" id="lend">Prêter un livre</button></div></div>
      <form class="card" id="borrower-form" style="margin-top:14px">
        <div class="grid-3">
          <div class="field"><label>Nom *</label><input name="name" required value="${esc(b.name)}"></div>
          <div class="field"><label>E-mail</label><input name="email" type="email" value="${esc(b.email)}"></div>
          <div class="field"><label>Téléphone</label><input name="phone" type="tel" value="${esc(b.phone)}"></div>
        </div>
        <div class="field"><label>Informations</label><textarea name="notes" style="min-height:60px" placeholder="Adresse, classe, remarques…">${esc(b.notes)}</textarea></div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Enregistrer</button>
          ${b.loans.length ? '' : '<button class="btn btn-danger" type="button" id="del">Supprimer</button>'}
        </div>
      </form>
      <h2>En cours (${open.length})${late ? ` <span class="badge badge-late">${late} en retard</span>` : ''}</h2>
      <div class="card">${open.length ? `<div class="list">${open.map((l) => loanItemHtml(l, true)).join('')}</div>` : '<p class="muted">Aucun livre emprunté.</p>'}</div>
      ${b.reservations.length ? `<h2>Réservations (${b.reservations.length})</h2>
      <div class="card"><div class="list">${b.reservations.map((r) => `<div class="list-item">
        ${r.book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(r.book.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
        <div class="grow"><a href="#/book/${r.book.id}"><strong>${esc(r.book.title)}</strong></a><div class="small muted">Réservé le ${fmtDate(r.createdAt)}</div></div>
        <button class="btn btn-small" type="button" data-del-res="${r.id}">Retirer</button>
      </div>`).join('')}</div></div>` : ''}
      <h2>Historique (${past.length})</h2>
      <div class="card">${past.length ? `<div class="list">${past.map((l) => loanItemHtml(l, true)).join('')}</div>` : '<p class="muted">Aucun prêt terminé.</p>'}</div>`;
    // Emprunteur retenu pour les exemplaires scannes ensuite (voir loanFor).
    $('#lend').onclick = () => { loanFor = { id: b.id, name: b.name }; scanAndOpen('loan'); };
    if ($('#remind-all')) $('#remind-all').onclick = async () => {
      try { if (await sendReminder({ id: b.id, name: b.name, email: b.email }, open)) route(); } catch (err) { toast(err.message, 'error'); }
    };
    $$('[data-del-res]').forEach((btn) => {
      btn.onclick = async () => {
        try { await api(`/api/reservations/${btn.dataset.delRes}`, { method: 'DELETE' }); route(); } catch (err) { toast(err.message, 'error'); }
      };
    });
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

  // ================= Accueil personnalise (#/home) =================
  // Cartes choisies et ordonnees par chaque compte (lib/home.js). Grand ecran : cartes
  // detaillees. Smartphone : tuiles resumees qui tiennent dans l'ecran, sans defilement
  // (ni vertical ni horizontal) ; chaque tuile ouvre la page correspondante.
  const HOME_PHONE_QUERY = '(max-width: 599px), (max-height: 520px) and (orientation: landscape) and (pointer: coarse)';
  const HOME_META = {
    todo: { icon: 'todo', color: 'sun' },
    reading: { icon: 'catalog', color: 'sky' },
    forme: { icon: 'user', color: 'grape' },
    due: { icon: 'loans', color: 'coral' },
    wishes: { icon: 'wish', color: 'rose' },
    news: { icon: 'add', color: 'accent' },
    goal: { icon: 'goal', color: 'grape' },
  };
  // Onglet ouvert par la page Prets quand on y arrive depuis l'accueil.
  let loansTabNext = null;

  const openCatalog = (patch) => { state.catalog = { q: '', category: '', status: '', sort: 'title', page: 1, ...patch }; go('#/'); };
  const daysLate = (due) => Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(due)) / 86400000);
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  function todoItems(t) {
    if (!t) return [];
    return [
      t.reminderMode === 'auto' && [t.toRemind, 'Prêt à relancer', 'Prêts à relancer', 'remind', 'danger'],
      [t.overdue, 'Prêt en retard', 'Prêts en retard', 'overdue', 'danger'],
      [t.week, 'Retour cette semaine', 'Retours cette semaine', 'open', 'warn'],
      [t.reservations, 'Réservation prête', 'Réservations prêtes', 'reservations', 'grape'],
      [t.wishes, 'Souhait des membres', 'Souhaits des membres', '#/wishes', 'rose'],
      [t.labels, 'Étiquette à imprimer', 'Étiquettes à imprimer', '#/labels', 'sky'],
      [t.incomplete, 'Fiche incomplète', 'Fiches incomplètes', '#/incomplete', 'accent'],
    ].filter((x) => x && x[0] > 0).map(([n, one, many, target, color]) => ({ n, label: n > 1 ? many : one, target, color }));
  }

  // Resume de chaque carte : valeur mise en avant, lignes, page ouverte (tuile smartphone).
  function homeSummary(key, d) {
    const x = d[key];
    switch (key) {
      case 'todo': {
        const items = todoItems(x);
        return { value: items.length ? String(items.reduce((s, i) => s + i.n, 0)) : '✓', lines: items.length ? items.map((i) => `${i.n} · ${i.label.toLowerCase()}`) : ['Tout est à jour'], go: items[0] ? items[0].target : 'open' };
      }
      case 'reading': return { value: String(x.length), lines: x.length ? x.map((b) => `${b.title}${b.percent != null ? ` · ${b.percent} %` : ''}`) : ['Aucune lecture en cours'], go: 'reading' };
      case 'forme': return { value: String(x.length), lines: x.length ? x.map((f) => `${f.book.title} : ${f.kind === 'back' ? 'disponible' : 'ajouté'}`) : ['Rien de neuf pour toi'], go: x[0] ? `#/book/${x[0].book.id}` : '#/' };
      case 'due': {
        const late = x.filter((l) => l.overdue).length;
        return { value: String(late || x.length), sub: late ? 'en retard' : 'à venir', lines: x.length ? x.map((l) => `${l.book.title} · ${l.overdue ? `${daysLate(l.dueAt)} j de retard` : fmtDay(l.dueAt)}`) : ['Aucune échéance proche'], go: late ? 'overdue' : 'open' };
      }
      case 'wishes': return { value: String(x.count), lines: x.items.length ? x.items.map((w) => w.title) : ['Aucun souhait'], go: '#/wishes' };
      case 'news': return { value: String(x.month), sub: 'ce mois-ci', lines: x.items.map((b) => b.title), go: 'recent' };
      case 'goal': return x.goal
        ? { value: `${x.read}/${x.goal}`, lines: [x.ahead >= 0 ? `▲ ${plural(x.ahead, 'livre', 'livres')} d'avance` : `▼ ${plural(-x.ahead, 'livre', 'livres')} de retard`, `${x.pages.toLocaleString('fr-BE')} pages en ${x.year}`], go: '#/stats' }
        : { value: String(x.read), sub: `lu${x.read > 1 ? 's' : ''} en ${x.year}`, lines: ['Aucun objectif défini'], go: '#/stats' };
      default: return { value: '', lines: [], go: '#/' };
    }
  }

  // Destination d'une carte ou d'une ligne : page, onglet des prets ou filtre du catalogue.
  function homeGo(target) {
    if (!target) return;
    if (target.startsWith('#/')) { if (target === '#/wishes') wishState.owners = 'all'; return go(target); }
    if (target === 'reading') return openCatalog({ reading: 'reading', statusUser: String(state.user.id) });
    if (target === 'recent') return openCatalog({ sort: 'recent' });
    loansTabNext = target;
    go('#/loans');
  }

  const shelfHtml = (books, empty) => (books.length ? `<ul class="home-shelf" role="list">${books.map((b) => `<li><a class="home-book" href="#/book/${b.id}">
      ${coverHtml(b, b.mine ? 'Pour toi' : '')}<span class="t">${esc(b.title)}</span><span class="a">${esc(b.authors)}</span>
      ${b.percent != null && b.percent !== undefined ? `<span class="bar" role="img" aria-label="${b.percent} % lus"><span style="width:${b.percent}%"></span></span>` : ''}</a></li>`).join('')}</ul>`
    : `<p class="muted">${empty}</p>`);

  function homeCardBody(key, d) {
    const x = d[key];
    switch (key) {
      case 'todo': {
        const items = todoItems(x);
        return items.length ? `<div class="home-todo">${items.map((i) => `<button type="button" class="home-todo-item" data-home-go="${esc(i.target)}" style="${colorVars(i.color === 'danger' ? 'coral' : i.color === 'warn' ? 'sun' : i.color)}">
            <span class="n">${i.n}</span><span class="l">${i.label}</span></button>`).join('')}</div>`
          : '<p class="muted">Rien à faire : tout est à jour.</p>';
      }
      case 'reading': return shelfHtml(x, 'Aucune lecture en cours. Choisis « En cours » sur la fiche d\'un livre.');
      case 'forme': return x.length ? `<ul class="list">${x.map((f) => (f.kind === 'back'
        ? `<li class="list-item"><div class="grow"><a href="#/book/${f.book.id}"><strong>« ${esc(f.book.title)} » est disponible</strong></a><div class="small muted">Tu en es lecteur</div></div><span class="badge badge-ok">Disponible</span></li>`
        : `<li class="list-item"><div class="grow"><a href="#/book/${f.book.id}"><strong>« ${esc(f.book.title)} » a été ajouté</strong></a><div class="small muted">Le ${fmtDate(f.at)}, tu en es lecteur</div></div><span class="badge badge-wish">Nouveau</span></li>`)).join('')}</ul>`
        : '<p class="muted">Rien de neuf pour toi : les livres ajoutés pour toi (tes souhaits par exemple) et ceux dont tu es lecteur redevenus disponibles apparaîtront ici.</p>';
      case 'due': return x.length ? `<ul class="list">${x.map((l) => { loanCache.set(l.id, l); return `<li class="list-item">
          ${l.book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(l.book.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb" aria-hidden="true"></span>'}
          <div class="grow"><a href="#/book/${l.book.id}"><strong>${esc(l.book.title)}</strong></a><div class="small muted"><a href="#/borrower/${l.borrower.id}">${esc(l.borrower.name)}</a> · <span class="code">${esc(l.copy.code)}</span></div></div>
          ${l.overdue ? `<span class="badge badge-late">${plural(daysLate(l.dueAt), 'jour', 'jours')} de retard</span>` : `<span class="badge badge-warn">${fmtDay(l.dueAt)}</span>`}
          <button class="btn btn-small" type="button" data-remind="${l.id}" aria-label="Relancer ${esc(l.borrower.name)} pour « ${esc(l.book.title)} »">${icon('mail', 16)}<span class="hide-mobile">Relancer</span></button></li>`; }).join('')}</ul>`
        : '<p class="muted">Aucune échéance dans les 14 prochains jours.</p>';
      case 'wishes': return `${x.items.length ? `<ul class="list">${x.items.map((w) => `<li class="list-item">
          ${w.coverUrl ? `<img class="thumb" src="${esc(w.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="thumb" aria-hidden="true"></span>'}
          <div class="grow"><strong>${esc(w.title)}</strong><div class="small muted">${esc(w.authors)}</div></div>${w.priority ? `<span class="badge badge-wish">Très envie</span>` : ''}</li>`).join('')}</ul>`
        : '<p class="muted">Aucun souhait pour le moment.</p>'}<button class="btn btn-small" type="button" id="home-wish-add" style="margin-top:8px">${icon('add', 16)}Ajouter un souhait</button>`;
      case 'news': return shelfHtml(x.items, 'Aucun livre pour le moment.');
      case 'goal': {
        if (!x.goal) return `<p><strong>${plural(x.read, 'livre lu', 'livres lus')} en ${x.year}</strong></p><p class="muted">Aucun objectif défini. <a href="#/stats">Définir mon objectif</a></p>`;
        const p = Math.min(1, x.read / x.goal);
        const c = 2 * Math.PI * 40;
        return `<div class="home-goal"><svg class="ring" viewBox="0 0 100 100" width="92" height="92" role="img" aria-label="${x.read} livres lus sur ${x.goal}">
            <circle cx="50" cy="50" r="40" class="track"/><circle cx="50" cy="50" r="40" class="val" stroke-dasharray="${(p * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/>
            <text x="50" y="57" text-anchor="middle">${x.read}</text></svg>
          <div><p><strong>${x.read} livre${x.read > 1 ? 's' : ''} lu${x.read > 1 ? 's' : ''} sur ${x.goal}</strong></p>
            <p class="${x.ahead >= 0 ? 'good' : 'bad'}">${x.ahead >= 0 ? `▲ ${plural(x.ahead, 'livre', 'livres')} d'avance` : `▼ ${plural(-x.ahead, 'livre', 'livres')} de retard`}</p>
            <p class="small muted">${x.pages.toLocaleString('fr-BE')} pages en ${x.year}</p></div></div>`;
      }
      default: return '';
    }
  }
  const HOME_LINKS = { reading: ['reading', 'Tout voir'], due: ['open', 'Page Prêts'], wishes: ['#/wishes', 'Tout voir'], news: ['recent', 'Catalogue'], goal: ['#/stats', 'Statistiques'] };

  async function viewDashboard() {
    const home = await api('/api/home');
    const shown = home.cards.filter((c) => c.shown);
    const d = home.data;
    const now = new Date().toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });
    const alerts = d.todo ? todoItems(d.todo).filter((i) => ['remind', 'overdue'].includes(i.target)).reduce((s, i) => s + i.n, 0) : 0;
    const sub = alerts ? `${now} · ${plural(alerts, 'prêt demande', 'prêts demandent')} ton attention` : now;
    view().innerHTML = `<div class="home">
      <div class="home-head">
        <div class="home-hello"><h1>Bonjour ${esc(state.user.username)}</h1><p class="muted">${esc(sub.charAt(0).toUpperCase() + sub.slice(1))}</p></div>
        <form class="home-search" role="search" id="home-search">
          <label for="home-q" class="sr-only">Rechercher dans le catalogue</label>
          <input type="search" id="home-q" placeholder="Titre, auteur, ISBN…" autocomplete="off">
          <button class="btn btn-primary" type="submit" aria-label="Rechercher">${icon('search', 16)}<span class="hide-phone">Rechercher</span></button>
        </form>
      </div>
      ${shown.length ? `
      <div class="home-cards">${shown.map((c) => `<section class="card home-card" aria-labelledby="hc-${c.key}">
          <div class="home-card-head"><span class="h-icon" style="${colorVars(HOME_META[c.key].color)}" aria-hidden="true">${icon(HOME_META[c.key].icon, 18)}</span>
            <h2 id="hc-${c.key}">${esc(c.label)}${c.key === 'wishes' && d.wishes.count ? ` <span class="muted">(${d.wishes.count})</span>` : ''}</h2>
            ${HOME_LINKS[c.key] ? `<button type="button" class="link-btn" data-home-go="${HOME_LINKS[c.key][0]}">${HOME_LINKS[c.key][1]}</button>` : ''}</div>
          ${homeCardBody(c.key, d)}</section>`).join('')}</div>
      <nav class="home-tiles" id="home-tiles" aria-label="Accueil">${shown.map((c) => { const s = homeSummary(c.key, d); return `
          <button type="button" class="home-tile" data-home-go="${esc(s.go)}" style="${colorVars(HOME_META[c.key].color)}">
            <span class="tile-head"><span class="h-icon" aria-hidden="true">${icon(HOME_META[c.key].icon, 16)}</span><span class="tile-label">${esc(c.label)}</span></span>
            <span class="tile-value">${esc(s.value)}${s.sub ? ` <small>${esc(s.sub)}</small>` : ''}</span>
            <span class="tile-lines">${s.lines.map((l) => `<span>${esc(l)}</span>`).join('')}</span>
          </button>`; }).join('')}</nav>`
      : `<div class="empty">Toutes les cartes sont masquées.<br><br><button class="btn" type="button" id="home-custom-2">Choisir les cartes</button></div>`}
    </div>`;
    $('#home-search').onsubmit = (e) => { e.preventDefault(); openCatalog({ q: $('#home-q').value.trim() }); };
    if ($('#home-custom-2')) $('#home-custom-2').onclick = openHomeCustomize;
    $$('[data-home-go]').forEach((b) => { b.onclick = () => homeGo(b.dataset.homeGo); });
    if ($('#home-wish-add')) $('#home-wish-add').onclick = async () => { if (await wishDialog()) viewDashboard(); };
    fitHome();
    // Apres la pastille du titre (ajoutee juste apres) : nouvelle mesure.
    requestAnimationFrame(fitHome);
  }

  // Smartphone : la page tient dans l'ecran. Hauteur des tuiles = place restante sous
  // l'en-tete, grille calculee selon le nombre de cartes et l'orientation.
  function fitHome() {
    const tiles = $('#home-tiles');
    const phone = window.matchMedia(HOME_PHONE_QUERY).matches;
    document.body.classList.toggle('home-fit', phone && !!$('.home'));
    if (!tiles || !phone) { if (tiles) tiles.style.height = ''; return; }
    const n = tiles.children.length;
    const landscape = window.innerWidth > window.innerHeight;
    const cols = landscape ? Math.min(n, 4) : (n <= 3 ? 1 : 2);
    tiles.style.setProperty('--cols', cols);
    tiles.style.setProperty('--rows', Math.ceil(n / cols));
    tiles.classList.toggle('odd', cols === 2 && n % 2 === 1);
    const h = (window.visualViewport ? window.visualViewport.height : window.innerHeight) - tiles.getBoundingClientRect().top - 12;
    tiles.style.height = `${Math.max(120, Math.floor(h))}px`;
  }
  const refitHome = () => { if ($('#home-tiles')) fitHome(); };
  window.addEventListener('resize', refitHome);
  window.addEventListener('orientationchange', () => setTimeout(refitHome, 150));
  [HOME_PHONE_QUERY, '(orientation: landscape)'].forEach((q) => { const m = window.matchMedia(q); if (m.addEventListener) m.addEventListener('change', refitHome); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if ($('#home-tiles')) fitHome(); });
  window.addEventListener('hashchange', () => { if (!/^#\/home$/.test(location.hash)) document.body.classList.remove('home-fit'); });

  // Menu du compte « Personnaliser l'accueil » : depuis n'importe quelle page, puis accueil.
  async function openHomeCustomize() {
    try {
      const { cards } = await api('/api/home');
      if (!await homeCustomize(cards)) return;
      if (location.hash === '#/home') viewDashboard(); else go('#/home');
    } catch (err) { toast(err.message, 'error'); }
  }

  // Choix et ordre des cartes (cases a cocher, boutons Monter / Descendre).
  function homeCustomize(cards) {
    let list = cards.map((c) => ({ ...c }));
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="hcust-title">
        <h2 id="hcust-title">Personnaliser l'accueil</h2>
        <p class="small muted">Coche les cartes à afficher et règle leur ordre.</p>
        <ol class="home-order" id="home-order"></ol>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn btn-primary" type="button" id="hcust-save">Enregistrer</button>
          <button class="btn" type="button" id="hcust-reset">Ordre par défaut</button>
          <button class="btn" type="button" data-close>Annuler</button>
        </div></div>`;
      document.body.appendChild(backdrop);
      const close = (v) => { backdrop.remove(); resolve(v); };
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(false); });
      const box = $('#home-order', backdrop);
      const render = (focus) => {
        box.innerHTML = list.map((c, i) => `<li class="home-order-row">
          <label class="check grow"><input type="checkbox" data-shown="${i}" ${c.shown ? 'checked' : ''}> <span class="h-icon" style="${colorVars(HOME_META[c.key].color)}" aria-hidden="true">${icon(HOME_META[c.key].icon, 16)}</span>${esc(c.label)}</label>
          <button type="button" class="btn btn-small" data-move="${i}" data-dir="-1" aria-label="Monter ${esc(c.label)}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn btn-small" data-move="${i}" data-dir="1" aria-label="Descendre ${esc(c.label)}" ${i === list.length - 1 ? 'disabled' : ''}>↓</button></li>`).join('');
        if (focus) { const b = $(`[data-move="${focus[0]}"][data-dir="${focus[1]}"]`, box) || $(`[data-move="${focus[0]}"]:not([disabled])`, box); if (b) b.focus(); }
      };
      box.addEventListener('change', (e) => { const i = e.target.dataset.shown; if (i !== undefined) list[Number(i)].shown = e.target.checked; });
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-move]');
        if (!b) return;
        const i = Number(b.dataset.move);
        const j = i + Number(b.dataset.dir);
        [list[i], list[j]] = [list[j], list[i]];
        render([j, b.dataset.dir]);
      });
      render();
      const save = async (body) => {
        try { await api('/api/home/cards', { method: 'PUT', body }); toast('Accueil enregistré.'); close(true); } catch (err) { toast(err.message, 'error'); }
      };
      $('#hcust-save', backdrop).onclick = () => save({ order: list.map((c) => c.key), hidden: list.filter((c) => !c.shown).map((c) => c.key) });
      $('#hcust-reset', backdrop).onclick = () => save({ order: null });
    });
  }

  // ================= Souhaits =================
  // Liste de souhaits de chaque compte (hors bibliotheque, API globale /api/wishes).
  // Onglets : sa liste, celles partagees avec soi et, pour un gestionnaire de la
  // bibliotheque ouverte, celles de ses membres. Plusieurs listes peuvent etre
  // selectionnees a la fois (affichage et export).
  const wishState = { owners: null, priority: false };
  const libParam = () => (LIBRARY && canConfigure() ? `library=${LIBRARY.id}` : '');

  async function viewWishes() {
    const { owners, manager } = await gapi(`/api/wishes/owners?${libParam()}`);
    const me = state.user.id;
    const ids = new Set(owners.map((o) => o.id));
    let selected = (wishState.owners === 'all' ? owners.map((o) => o.id) : wishState.owners || [me]).filter((id) => ids.has(id));
    if (!selected.length) selected = [me];
    wishState.owners = selected;
    const VIA = { share: 'partagée', library: 'membre' };
    view().innerHTML = `
      <div class="page-head"><div><h1>Souhaits ${hint("Livres que tu aimerais lire ou voir acheter. Ta liste t'appartient (elle n'est dans aucune bibliothèque) ; tu peux la partager avec d'autres comptes. Les gestionnaires voient celles des membres de leur bibliothèque.")}</h1></div>
        <div class="btn-row"><button class="btn btn-primary" type="button" id="wish-add">${icon('add', 16)}Ajouter un souhait</button></div></div>
      ${owners.length > 1 ? `<div class="wish-owners" role="group" aria-label="Listes affichées">
        ${owners.map((o) => `<button type="button" class="chip-toggle" data-owner="${o.id}" aria-pressed="${selected.includes(o.id)}">
          <span class="tab-avatar" aria-hidden="true">${initials(o.username)}</span>${o.id === me ? 'Mes souhaits' : esc(o.username)}
          <span class="count">${o.count}</span>${VIA[o.via] ? `<span class="sr-only"> (liste ${VIA[o.via]})</span>` : ''}</button>`).join('')}
        <button type="button" class="btn btn-small" id="wish-all">${selected.length === owners.length ? 'Seulement moi' : 'Toutes'}</button>
      </div>` : ''}
      <div class="wish-toolbar">
        <button type="button" class="chip-toggle wish-filter" id="wish-prio" aria-pressed="${wishState.priority}">${icon('wish', 16)}Très envie seulement</button>
        <div class="btn-row"><span class="small muted">Exporter${selected.length > 1 ? ` les ${selected.length} listes` : ''} :</span>
          <a class="btn btn-small" id="wish-xlsx" download>Excel</a><a class="btn btn-small" id="wish-csv" download>CSV</a></div>
      </div>
      <div class="card" id="wish-list" aria-live="polite"><p class="muted">Chargement…</p></div>
      <details class="card wish-share" id="wish-share">
        <summary>${icon('share', 16)}<strong>Partager ma liste</strong> <span class="small muted" id="share-sum"></span></summary>
        <div id="share-body" style="margin-top:12px"></div>
      </details>`;
    const setSelected = (list) => { wishState.owners = list; viewWishes(); };
    $$('[data-owner]').forEach((btn) => {
      btn.onclick = () => {
        const id = Number(btn.dataset.owner);
        const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
        setSelected(next.length ? next : [id]);
      };
    });
    if ($('#wish-all')) $('#wish-all').onclick = () => setSelected(selected.length === owners.length ? [me] : owners.map((o) => o.id));
    $('#wish-prio').onclick = () => { wishState.priority = !wishState.priority; viewWishes(); };
    const q = `owners=${selected.join(',')}${wishState.priority ? '&priority=1' : ''}${libParam() ? '&' + libParam() : ''}`;
    $('#wish-xlsx').href = `${ROOT}/api/wishes/export.xlsx?${q}`;
    $('#wish-csv').href = `${ROOT}/api/wishes/export.csv?${q}`;
    $('#wish-add').onclick = async () => { if (await wishDialog()) viewWishes(); };

    const wishes = await gapi(`/api/wishes?${q}`);
    const multi = selected.length > 1 || selected[0] !== me;
    $('#wish-list').innerHTML = wishes.length ? `<ul class="list wish-list">${wishes.map((w) => wishItemHtml(w, { me, manager, multi })).join('')}</ul>`
      : wishState.priority ? '<div class="empty">Aucun souhait « Très envie ».</div>'
        : `<div class="empty">Aucun souhait pour le moment.${selected.includes(me) ? '<br><br>Ajoute un livre par son ISBN, en le scannant ou par son titre.' : ''}</div>`;
    const byId = new Map(wishes.map((w) => [w.id, w]));
    // Coeur « Tres envie » : bascule immediate (proprietaire).
    $$('[data-wish-heart]', $('#wish-list')).forEach((btn) => {
      btn.onclick = async () => {
        const w = byId.get(Number(btn.dataset.wishHeart));
        const on = !w.priority;
        try {
          await gapi(`/api/wishes/${w.id}`, { method: 'PUT', body: { priority: on } });
          w.priority = on ? 1 : 0;
          if (wishState.priority && !on) return viewWishes();
          btn.setAttribute('aria-pressed', String(on));
          btn.title = on ? 'Très envie (cliquer pour retirer)' : 'Marquer « Très envie »';
        } catch (err) { toast(err.message, 'error'); }
      };
    });
    $$('[data-wish-act]', $('#wish-list')).forEach((btn) => {
      btn.onclick = async () => {
        const w = byId.get(Number(btn.dataset.wish));
        const act = btn.dataset.wishAct;
        try {
          if (act === 'edit') { if (await wishDialog(w)) viewWishes(); return; }
          if (act === 'delete') {
            if (!confirm(`Supprimer « ${w.title} » de tes souhaits ?`)) return;
            await gapi(`/api/wishes/${w.id}`, { method: 'DELETE' });
            toast('Souhait supprimé.');
          }
          if (act === 'add') { pendingWish = w; go('#/add'); return; }
          viewWishes();
        } catch (err) { toast(err.message, 'error'); }
      };
    });
    shareSection();
  }

  function wishItemHtml(w, { me, manager, multi }) {
    const own = w.owner.id === me;
    const meta = [w.authors, [w.publisher, w.year].filter(Boolean).join(', '), w.isbn ? `ISBN ${w.isbn}` : ''].filter(Boolean).map(esc).join(' · ');
    const acts = [];
    if (manager && !w.inLibrary) acts.push(`<button class="btn btn-small btn-primary" type="button" data-wish-act="add" data-wish="${w.id}">${icon('add', 16)}Ajouter à la bibliothèque</button>`);
    if (own) {
      acts.push(`<button class="btn btn-small" type="button" data-wish-act="edit" data-wish="${w.id}" aria-label="Modifier « ${esc(w.title)} »">Modifier</button>`);
      acts.push(`<button class="btn btn-small btn-danger" type="button" data-wish-act="delete" data-wish="${w.id}" aria-label="Supprimer « ${esc(w.title)} »">Supprimer</button>`);
    }
    const heart = own
      ? `<button type="button" class="wish-heart" data-wish-heart="${w.id}" aria-pressed="${!!w.priority}" aria-label="Très envie : ${esc(w.title)}"
          title="${w.priority ? 'Très envie (cliquer pour retirer)' : 'Marquer « Très envie »'}">${icon('wish', 20)}</button>`
      : `<span class="wish-heart${w.priority ? ' on' : ''}" aria-hidden="true">${icon('wish', 20)}</span>`;
    return `<li class="list-item wish-item">
      ${heart}
      ${w.coverUrl ? `<img class="thumb" src="${esc(w.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="thumb" aria-hidden="true"></span>'}
      <div class="grow">
        <strong>${esc(w.title)}</strong>${!own && w.priority ? '<span class="sr-only"> (très envie)</span>' : ''}${w.subtitle ? ` <span class="muted">— ${esc(w.subtitle)}</span>` : ''}
        ${meta ? `<div class="small muted">${meta}</div>` : ''}
        ${w.notes ? `<div class="small wish-notes">${esc(w.notes)}</div>` : ''}
        <div class="badges">
          ${multi ? `<span class="badge badge-muted">${own ? 'Moi' : esc(w.owner.username)}</span>` : ''}
          ${w.inLibrary ? `<a class="badge badge-ok" href="#/book/${w.inLibrary.id}">Déjà dans la bibliothèque</a>` : ''}
        </div>
      </div>
      ${acts.length ? `<div class="btn-row wish-actions">${acts.join('')}</div>` : ''}
    </li>`;
  }

  // Partage de sa liste avec d'autres comptes (cases a cocher, enregistre a chaque changement).
  async function shareSection() {
    const box = $('#share-body');
    if (!box) return;
    const { viewers, candidates } = await gapi('/api/wishes/shares');
    const sum = () => { const n = $$('[data-viewer]:checked', box).length; $('#share-sum').textContent = n ? `avec ${n} compte${n > 1 ? 's' : ''}` : 'non partagée'; };
    box.innerHTML = candidates.length ? `<fieldset class="plain"><legend class="small muted">Ces comptes pourront voir ta liste (sans la modifier) :</legend>
        <div class="check-grid">${candidates.map((c) => `<label class="check"><input type="checkbox" data-viewer="${c.id}" ${viewers.includes(c.id) ? 'checked' : ''}> ${esc(c.username)}</label>`).join('')}</div></fieldset>`
      : '<p class="small muted">Aucun autre compte dans tes bibliothèques.</p>';
    sum();
    box.onchange = async () => {
      try {
        await gapi('/api/wishes/shares', { method: 'PUT', body: { viewerIds: $$('[data-viewer]:checked', box).map((x) => Number(x.dataset.viewer)) } });
        sum();
        toast('Partage enregistré.');
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // Ajout ou modification d'un souhait. Recherche par ISBN (tape ou scanne) ou par
  // titre (liste d'editions). Renvoie true si enregistre.
  function wishDialog(w, preset) {
    const editing = !!(w && w.id);
    const v = w || { isbn: '', title: '', subtitle: '', authors: '', publisher: '', year: '', notes: '', priority: 0, coverUrl: '', ...(preset || {}) };
    let cover = v.coverUrl || '';
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `<div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="wish-title">
        <h2 id="wish-title">${editing ? 'Modifier le souhait' : 'Ajouter un souhait'}</h2>
        <form id="wish-form">
          <div class="field"><label for="wish-q">ISBN ou titre</label>
            <div class="isbn-row">
              <input id="wish-q" autocomplete="off" placeholder="ISBN, ou titre et auteur" value="${esc(v.isbn)}">
              <button class="btn" type="button" id="wish-search">Rechercher</button>
              <button class="btn" type="button" id="wish-scan">Scanner</button>
            </div>
            <div id="wish-found" class="small" role="status" aria-live="polite" style="margin-top:8px"></div>
          </div>
          <div class="wish-form-grid">
            <div class="cover" id="wish-cover" aria-hidden="true"></div>
            <div>
              <div class="field"><label for="wf-title">Titre *</label><input id="wf-title" name="title" required value="${esc(v.title)}"></div>
              <div class="field"><label for="wf-authors">Auteur(s)</label><input id="wf-authors" name="authors" value="${esc(v.authors)}"></div>
              <div class="grid-3">
                <div class="field"><label for="wf-publisher">Éditeur</label><input id="wf-publisher" name="publisher" value="${esc(v.publisher)}"></div>
                <div class="field"><label for="wf-year">Année</label><input id="wf-year" name="year" inputmode="numeric" value="${esc(v.year || '')}"></div>
                <div class="field"><label for="wf-isbn">ISBN</label><input id="wf-isbn" name="isbn" inputmode="numeric" value="${esc(v.isbn)}"></div>
              </div>
            </div>
          </div>
          <div class="field"><label for="wf-notes">Notes</label><textarea id="wf-notes" name="notes" style="min-height:60px" placeholder="Édition souhaitée, où l'acheter, pour qui…">${esc(v.notes)}</textarea></div>
          <label class="check"><input type="checkbox" name="priority" ${v.priority ? 'checked' : ''}> Très envie</label>
          <div id="wish-err" role="alert"></div>
          <div class="btn-row" style="margin-top:14px"><button class="btn btn-primary" type="submit">Enregistrer</button><button class="btn" type="button" data-close>Annuler</button></div>
        </form></div>`;
      document.body.appendChild(backdrop);
      const f = $('#wish-form', backdrop);
      const close = (ok) => { backdrop.remove(); resolve(ok); };
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(false); });
      const renderCover = () => { $('#wish-cover', backdrop).innerHTML = cover ? `<img src="${esc(cover)}" alt="" referrerpolicy="no-referrer">` : '<span class="cover-fallback">Pas d\'image</span>'; };
      renderCover();
      const fill = (d) => {
        ['title', 'subtitle', 'authors', 'publisher', 'year', 'isbn'].forEach((k) => { if (d[k] && f[k]) f[k].value = d[k]; });
        if (d.coverUrl) { cover = d.coverUrl; renderCover(); }
      };
      const found = $('#wish-found', backdrop);
      const search = async (text) => {
        const t = String(text || '').trim();
        if (!t) return;
        const digits = t.replace(/[\s-]/g, '');
        found.textContent = 'Recherche…';
        try {
          if (/^(97[89])?\d{9}[\dXx]$/.test(digits)) {
            const r = await gapi(`/api/wishes/lookup/${encodeURIComponent(digits)}`);
            f.isbn.value = r.isbn;
            if (r.found) { fill({ ...r.found, isbn: r.isbn }); found.textContent = `Trouvé : ${r.found.title}`; } else found.textContent = 'ISBN inconnu : complète la fiche à la main.';
            return;
          }
          const { editions } = await gapi(`/api/wishes/search?q=${encodeURIComponent(t)}`);
          if (!editions.length) { found.textContent = 'Aucune édition trouvée.'; if (!f.title.value) f.title.value = t; return; }
          found.innerHTML = `<div class="pick-list" role="list">${editions.map((ed, i) => `<button type="button" class="pick-row" data-ed="${i}">
            <span class="pick-line">${ed.coverUrl ? `<img class="thumb" src="${esc(ed.coverUrl)}" alt="" referrerpolicy="no-referrer">` : '<span class="thumb"></span>'}
            <span class="grow"><strong>${esc(ed.title || '')}</strong><span class="small muted">${esc([ed.authors, ed.publisher, ed.year, ed.isbn].filter(Boolean).join(' · '))}</span></span></span></button>`).join('')}</div>`;
          $$('[data-ed]', found).forEach((btn) => {
            btn.onclick = () => { const ed = editions[Number(btn.dataset.ed)]; fill(ed); found.textContent = `Édition choisie : ${ed.title || ''}`; f.title.focus(); };
          });
        } catch (err) { found.innerHTML = `<span class="error-text">${esc(err.message)}</span>`; }
      };
      $('#wish-search', backdrop).onclick = () => search($('#wish-q', backdrop).value);
      $('#wish-q', backdrop).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(e.target.value); } });
      $('#wish-scan', backdrop).onclick = async () => {
        const isbn = await scanIsbn();
        if (isbn) { $('#wish-q', backdrop).value = isbn; search(isbn); }
      };
      if (!editing && v.isbn && !v.title) search(v.isbn);
      f.onsubmit = async (e) => {
        e.preventDefault();
        const body = { title: f.title.value, authors: f.authors.value, publisher: f.publisher.value, year: f.year.value, isbn: f.isbn.value,
          notes: f.notes.value, priority: f.priority.checked, coverUrl: cover };
        try {
          await gapi(editing ? `/api/wishes/${w.id}` : '/api/wishes', { method: editing ? 'PUT' : 'POST', body });
          toast(editing ? 'Souhait enregistré.' : 'Ajouté à tes souhaits.');
          close(true);
        } catch (err) { $('#wish-err', backdrop).innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
      };
      (editing ? f.title : $('#wish-q', backdrop)).focus();
    });
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
      <div class="page-head"><div><h1>Étiquettes ${hint('Planches A4 autocollantes, avec QR code à scanner pour les prêts et retours.')}</h1></div></div>
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
            <div class="field"><label>Commencer à la case n° ${hint('Pour réutiliser une planche déjà entamée.')}</label><input type="number" id="start" min="1" value="1"></div>
            <label class="check"><input type="checkbox" id="opt-logo" ${layout.showLogo ? 'checked' : ''}> Logo</label>
            <label class="check"><input type="checkbox" id="opt-name" ${layout.showName ? 'checked' : ''}> Nom de la bibliothèque</label>
            <label class="check"><input type="checkbox" id="opt-title" ${layout.showTitle ? 'checked' : ''}> Titre du livre</label>
            <label class="check"><input type="checkbox" id="opt-author" ${layout.showAuthor ? 'checked' : ''}> Auteur(s)</label>
            <label class="check"><input type="checkbox" id="opt-guides" ${layout.guides ? 'checked' : ''}> Contours dans l'aperçu</label>
            <div class="btn-row" style="margin-top:14px">
              <button class="btn btn-primary" id="print">Imprimer</button>${hint('Dans la fenêtre d\'impression : format A4, marges « Aucune », échelle 100 % (« Taille réelle »).')}
            </div>
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
          <details><summary class="small" style="cursor:pointer;margin-bottom:8px">Voir le détail</summary>
            <div class="sel-list">${groupedHtml(pending)}</div></details>
          <div class="btn-row" style="margin-top:10px"><button class="btn btn-small" type="button" id="customize">Personnaliser</button>${hint('Nouveaux exemplaires et codes régénérés, pas encore imprimés. Personnaliser : copie cette liste dans « Sélection » pour la modifier.')}</div>`
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

  // ================= Statistiques =================
  // Tableau de bord : anneau d'objectif, cartes chiffres avec tendance, donut de
  // repartition, colonnes et courbe mensuelles (infobulle au survol), podiums avec
  // couvertures. Couleurs : accent pour une seule serie ; palette categorielle
  // validee (4 teintes, ordre fixe) pour la repartition des statuts.
  const PERIODS = [['year', 'Cette année'], ['last-year', "L'an dernier"], ['12m', '12 derniers mois'], ['all', 'Depuis le début']];
  const statsState = { period: 'year', who: 'me' };

  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('fr-BE'));
  const monthLabel = (key, withYear) => new Date(`${key}-15T12:00:00Z`).toLocaleDateString('fr-BE', withYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
  const coverSrc = (url) => (url ? mediaSrc(url) : '');
  const initials = (t) => esc(String(t || '?').trim().charAt(0).toUpperCase());
  const miniCover = (b, cls = '') => `<a class="mini-cover ${cls}" href="#/book/${b.bookId}" title="${esc(b.title || b.name)}">${b.cover
    ? `<img src="${esc(coverSrc(b.cover))}" alt="" loading="lazy">` : `<span>${initials(b.title || b.name)}</span>`}</a>`;

  // Carte chiffre : icone, valeur, libelle, precision, et petite courbe de tendance.
  function kpi(icon, value, label, hint, spark) {
    return `<div class="kpi"><div class="kpi-top"><span class="kpi-icon" aria-hidden="true">${icon}</span>${spark ? sparkline(spark) : ''}</div>
      <div class="kpi-value">${value}</div><div class="kpi-label">${esc(label)}</div>${hint ? `<div class="kpi-hint">${hint}</div>` : ''}</div>`;
  }

  function sparkline(values) {
    if (!values.length || values.every((v) => !v)) return '';
    const w = 90;
    const hgt = 28;
    const max = Math.max(1, ...values);
    const step = values.length > 1 ? w / (values.length - 1) : w;
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(hgt - 2 - (v / max) * (hgt - 4)).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${hgt}" width="${w}" height="${hgt}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  // Anneau de progression (objectif annuel).
  function ring(pct, center, sub) {
    const r = 52;
    const c = 2 * Math.PI * r;
    const p = Math.max(0, Math.min(100, pct));
    return `<svg class="ring" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="${p} %">
      <circle cx="64" cy="64" r="${r}" class="ring-track"/>
      <circle cx="64" cy="64" r="${r}" class="ring-value" stroke-dasharray="${((p / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 64 64)"/>
      <text x="64" y="62" text-anchor="middle" class="ring-center">${center}</text>
      <text x="64" y="82" text-anchor="middle" class="ring-sub">${sub}</text></svg>`;
  }

  // Donut de repartition : segments separes par un fin espace, legende avec valeurs.
  function donut(segments, centerValue, centerLabel) {
    const total = segments.reduce((n, s) => n + s.value, 0);
    const r = 54;
    const c = 2 * Math.PI * r;
    let offset = 0;
    const gap = total && segments.filter((s) => s.value).length > 1 ? 2 : 0;
    const arcs = total ? segments.filter((s) => s.value).map((s) => {
      const len = (s.value / total) * c;
      const arc = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="var(${s.color})" stroke-width="20"
        stroke-dasharray="${Math.max(0, len - gap).toFixed(2)} ${(c - Math.max(0, len - gap)).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 70 70)"><title>${esc(s.label)} : ${fmt(s.value)}</title></circle>`;
      offset += len;
      return arc;
    }).join('') : `<circle cx="70" cy="70" r="${r}" fill="none" class="ring-track" stroke-width="20"/>`;
    return `<div class="donut-wrap"><svg class="donut" viewBox="0 0 140 140" width="150" height="150" role="img" aria-label="${esc(centerLabel)}">${arcs}
      <text x="70" y="68" text-anchor="middle" class="ring-center">${fmt(centerValue)}</text>
      <text x="70" y="88" text-anchor="middle" class="ring-sub">${esc(centerLabel)}</text></svg>
      <ul class="donut-legend">${segments.map((s) => `<li><i style="background:var(${s.color})"></i><span>${esc(s.label)}</span>
        <strong>${fmt(s.value)}</strong><span class="muted">${total ? Math.round((s.value / total) * 100) : 0} %</span></li>`).join('')}</ul></div>`;
  }

  // Colonnes par mois ; comparaison optionnelle (annee precedente, en gris) avec legende.
  function columns(series, { unit, compareLabel = 'Un an plus tôt' } = {}) {
    const withPrev = series.some((s) => s.prev != null && s.prev > 0);
    const max = Math.max(1, ...series.map((s) => Math.max(s.value, withPrev ? s.prev || 0 : 0)));
    const multiYear = new Set(series.map((s) => s.month.slice(0, 4))).size > 1;
    const bar = (v, cls) => `<div class="col ${cls}" style="height:${v ? Math.max(3, (v / max) * 100) : 0}%"></div>`;
    return `<div class="colchart">
      ${withPrev ? `<div class="legend"><span><i class="sw sw-cur"></i>Période</span><span><i class="sw sw-prev"></i>${esc(compareLabel)}</span></div>` : ''}
      <div class="cols">${series.map((s) => `<div class="col-slot" tabindex="0">
          <div class="col-tip">${monthLabel(s.month, true)} · <strong>${fmt(s.value)}</strong> ${esc(unit)}${withPrev ? `<br><span class="muted">un an plus tôt : ${fmt(s.prev || 0)}</span>` : ''}</div>
          <div class="col-pair">${bar(s.value, 'cur')}${withPrev ? bar(s.prev || 0, 'prev') : ''}</div>
          <div class="col-label">${monthLabel(s.month, multiYear)}</div></div>`).join('')}</div>
      ${tableView(series, unit, withPrev)}</div>`;
  }

  // Courbe (aire) par mois ; infobulle et reticule qui suivent la souris.
  function area(series, { unit } = {}) {
    const w = 640;
    const hgt = 190;
    const pad = { l: 8, r: 8, t: 14, b: 26 };
    const max = Math.max(1, ...series.map((s) => s.value));
    const step = series.length > 1 ? (w - pad.l - pad.r) / (series.length - 1) : 0;
    const pts = series.map((s, i) => [pad.l + i * step, pad.t + (1 - s.value / max) * (hgt - pad.t - pad.b)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const fill = `${line} L${pts[pts.length - 1][0].toFixed(1)},${hgt - pad.b} L${pts[0][0].toFixed(1)},${hgt - pad.b} Z`;
    const id = 'g' + Math.random().toString(36).slice(2, 8);
    const multiYear = new Set(series.map((s) => s.month.slice(0, 4))).size > 1;
    const labels = series.map((s, i) => ((series.length <= 12 || i % 3 === 0) ? `<text x="${pts[i][0].toFixed(1)}" y="${hgt - 8}" text-anchor="middle" class="axis-label">${monthLabel(s.month, multiYear)}</text>` : '')).join('');
    return `<div class="areachart" data-series='${esc(JSON.stringify(series.map((s, i) => ({ x: pts[i][0], y: pts[i][1], label: monthLabel(s.month, true), value: s.value }))))}' data-unit="${esc(unit)}">
      <svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" role="img" aria-label="Évolution par mois">
        <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
        <line x1="${pad.l}" x2="${w - pad.r}" y1="${hgt - pad.b}" y2="${hgt - pad.b}" class="axis"/>
        <path d="${fill}" fill="url(#${id})"/>
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        ${labels}
        <line class="crosshair" y1="${pad.t}" y2="${hgt - pad.b}" x1="0" x2="0" vector-effect="non-scaling-stroke"/>
      </svg><div class="area-dot"></div><div class="area-tip"></div>
      ${tableView(series, unit, false)}</div>`;
  }

  function tableView(series, unit, withPrev) {
    return `<details class="chart-table"><summary class="small muted">Voir les valeurs</summary>
      <table><thead><tr><th>Mois</th><th>${esc(unit)}</th>${withPrev ? '<th>Un an plus tôt</th>' : ''}</tr></thead><tbody>
      ${series.map((s) => `<tr><td>${monthLabel(s.month, true)}</td><td>${fmt(s.value)}</td>${withPrev ? `<td>${fmt(s.prev || 0)}</td>` : ''}</tr>`).join('')}</tbody></table></details>`;
  }

  // Reticule et infobulle des courbes (a lier apres affichage).
  function bindAreaCharts(root) {
    $$('.areachart', root).forEach((el) => {
      const pts = JSON.parse(el.dataset.series || '[]');
      if (!pts.length) return;
      const svg = $('svg', el);
      const cross = $('.crosshair', el);
      const dot = $('.area-dot', el);
      const tip = $('.area-tip', el);
      const vb = svg.viewBox.baseVal;
      const show = (clientX) => {
        const box = svg.getBoundingClientRect();
        const x = ((clientX - box.left) / box.width) * vb.width;
        const p = pts.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
        const px = (p.x / vb.width) * box.width;
        const py = (p.y / vb.height) * box.height;
        cross.setAttribute('x1', p.x);
        cross.setAttribute('x2', p.x);
        el.classList.add('hover');
        dot.style.left = `${px}px`;
        dot.style.top = `${py}px`;
        tip.innerHTML = `${esc(p.label)} · <strong>${fmt(p.value)}</strong> ${esc(el.dataset.unit)}`;
        tip.style.left = `${Math.min(Math.max(px, 70), box.width - 70)}px`;
      };
      svg.addEventListener('mousemove', (e) => show(e.clientX));
      svg.addEventListener('mouseleave', () => el.classList.remove('hover'));
      svg.addEventListener('touchstart', (e) => show(e.touches[0].clientX), { passive: true });
    });
  }

  // Podium des 3 premiers (2 - 1 - 3), puis la suite en liste.
  function podium(items, { unit = '', empty = 'Rien pour cette période.', covers = false } = {}) {
    if (!items || !items.length) return `<p class="muted small">${empty}</p>`;
    const top = items.slice(0, 3);
    const order = [top[1], top[0], top[2]];
    const medal = ['🥈', '🥇', '🥉'];
    const place = [2, 1, 3];
    const visual = (it) => (covers && it.bookId ? miniCover({ ...it, title: it.name }, 'podium-cover') : `<span class="podium-avatar">${initials(it.name)}</span>`);
    return `<div class="podium">${order.map((it, i) => (it ? `
        <div class="podium-slot place-${place[i]}">
          ${visual(it)}
          <div class="podium-name">${it.bookId ? `<a href="#/book/${it.bookId}">${esc(it.name)}</a>` : esc(it.name)}</div>
          <div class="podium-count">${fmt(it.count)}${unit}</div>
          <div class="podium-step"><span>${medal[i]}</span></div>
        </div>` : '<div class="podium-slot empty"></div>')).join('')}</div>
      ${items.length > 3 ? rankList(items.slice(3), { unit, start: 4 }) : ''}`;
  }

  // Classement en barres horizontales (a partir du rang `start`).
  function rankList(items, { empty = 'Rien pour cette période.', unit = '', start = 1 } = {}) {
    if (!items || !items.length) return `<p class="muted small">${empty}</p>`;
    const max = Math.max(1, ...items.map((i) => i.count));
    return `<div class="rank">${items.map((i, n) => `
      <div class="rank-row">
        <span class="rank-pos">${start + n}</span>
        <div class="rank-main"><div class="rank-name">${i.bookId ? `<a href="#/book/${i.bookId}">${esc(i.name)}</a>` : esc(i.name)}${i.sub ? ` <span class="small muted">${esc(i.sub)}</span>` : ''}</div>
          <div class="rank-bar"><span style="width:${(i.count / max) * 100}%"></span></div></div>
        <div class="rank-count">${fmt(i.count)}${unit}</div>
      </div>`).join('')}</div>`;
  }

  // Notes : moyenne et repartition de 5 a 1 etoile.
  function ratingsHtml(r, empty) {
    if (!r.count) return `<p class="muted small">${empty}</p>`;
    return `<div class="rating-avg"><strong>${fmt(r.average)}</strong> / 5 ${starsHtml(Math.round(r.average))} <span class="small muted">${fmt(r.count)} note(s)</span></div>`
      + `<div class="rating-dist">${[5, 4, 3, 2, 1].map((n) => {
        const v = r.distribution[n - 1];
        return `<div class="rating-row">${starsHtml(n)}<div class="rank-bar"><span style="width:${(v / Math.max(1, ...r.distribution)) * 100}%"></span></div><span class="rank-count">${fmt(v)}</span></div>`;
      }).join('')}</div>`;
  }

  const panel = (title, body, cls = '') => `<section class="panel ${cls}"><h3>${title}</h3>${body}</section>`;
  const coverStrip = (books, empty) => (books.length
    ? `<div class="cover-strip">${books.map((b) => `<div class="strip-item">${miniCover(b)}<div class="strip-title">${esc(b.title || b.name)}</div></div>`).join('')}</div>`
    : `<p class="muted small">${empty}</p>`);

  async function viewStats() {
    if (!features().stats) {
      view().innerHTML = '<div class="empty">Les statistiques ne sont pas activées pour cette bibliothèque (Réglages > Fonctionnalités).</div>';
      return;
    }
    const ov = await api('/api/stats/overview');
    if (statsState.who !== 'me' && statsState.who !== 'library' && !ov.shared.some((m) => String(m.id) === statsState.who)) statsState.who = 'me';
    view().innerHTML = `
      <div class="stats-head">
        <div><h1>Statistiques</h1><p class="muted small" id="st-sub"></p></div>
        <div class="seg period-seg">${PERIODS.map(([k, l]) => `<button type="button" data-period="${k}" class="${statsState.period === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      </div>
      <div class="stats-tabs" id="st-tabs">
        <button data-who="me" class="${statsState.who === 'me' ? 'active' : ''}"><span class="tab-avatar">${initials(ov.me.username)}</span>Mes statistiques</button>
        ${ov.shared.map((m) => `<button data-who="${m.id}" class="${statsState.who === String(m.id) ? 'active' : ''}"><span class="tab-avatar">${initials(m.username)}</span>${esc(m.username)}</button>`).join('')}
        <button data-who="library" class="${statsState.who === 'library' ? 'active' : ''}"><span class="tab-avatar">🏛</span>Bibliothèque</button>
      </div>
      <div id="st-body"><p class="muted">Calcul…</p></div>`;
    $$('[data-period]').forEach((b) => {
      b.onclick = () => {
        statsState.period = b.dataset.period;
        $$('[data-period]').forEach((x) => x.classList.toggle('active', x === b));
        renderStatsBody(ov);
      };
    });
    $$('#st-tabs [data-who]').forEach((b) => {
      b.onclick = () => {
        statsState.who = b.dataset.who;
        $$('#st-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        renderStatsBody(ov);
      };
    });
    await renderStatsBody(ov);
  }

  async function renderStatsBody(ov) {
    const body = $('#st-body');
    body.classList.add('loading');
    try {
      if (statsState.who === 'library') {
        const s = await api(`/api/stats/library?period=${statsState.period}`);
        $('#st-sub').textContent = `Bibliothèque · ${s.period.label} · lecture en totaux anonymes`;
        body.innerHTML = libraryStatsHtml(s);
      } else {
        const id = statsState.who === 'me' ? ov.me.id : Number(statsState.who);
        const s = await api(`/api/stats/user/${id}?period=${statsState.period}`);
        $('#st-sub').textContent = `${statsState.who === 'me' ? 'Mes lectures' : `Lectures de ${s.user.username} (partagées)`} · ${s.period.label}`;
        body.innerHTML = (statsState.who === 'me' ? prefsHtml(ov) : '') + userStatsHtml(s, statsState.who === 'me');
        if (statsState.who === 'me') bindPrefs(ov);
      }
      bindAreaCharts(body);
    } catch (err) { body.innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
    body.classList.remove('loading');
  }

  function prefsHtml(ov) {
    const p = ov.prefs;
    return `<details class="stat-prefs"><summary>⚙️ <strong>Mes réglages</strong> <span class="small muted">partage ${p.shareStats ? 'activé' : 'désactivé'}${p.yearlyGoal ? ` · objectif ${p.yearlyGoal} livres` : ''}</span></summary>
      <div class="grid-3" style="margin-top:12px">
        <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" id="pf-share" ${p.shareStats ? 'checked' : ''} ${ov.member ? '' : 'disabled'}> Partager mes statistiques avec les membres de la bibliothèque</label>${ov.member ? '' : hint('Réservé aux comptes liés à cette bibliothèque.')}</div>
        <div class="field"><label>Objectif de l'année (livres)</label><input type="number" id="pf-goal" min="1" max="1000" placeholder="aucun" value="${p.yearlyGoal || ''}"></div>
        <div class="field"><label>Signaler une lecture en cours après (jours)</label><input type="number" id="pf-stale" min="1" max="3650" value="${p.staleDays}"></div>
      </div>
    </details>`;
  }

  function bindPrefs(ov) {
    const save = async (body) => {
      try {
        ov.prefs = await api('/api/stats/prefs', { method: 'PUT', body });
        toast('Réglages enregistrés.');
        renderStatsBody(ov);
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#pf-share').onchange = (e) => save({ shareStats: e.target.checked });
    $('#pf-goal').onchange = (e) => save({ yearlyGoal: e.target.value || null });
    $('#pf-stale').onchange = (e) => save({ staleDays: e.target.value });
  }

  function userStatsHtml(s, mine) {
    const c = s.counts;
    const d = s.durations;
    const g = s.goal;
    const warn = features().readingStatus ? '' : '<div class="info-box">Les statuts de lecture sont désactivés : active-les (Réglages > Fonctionnalités) pour alimenter ces statistiques.</div>';

    let goalCard;
    if (g.target) {
      const pct = Math.round((g.done / g.target) * 100);
      const diff = Math.round((g.done - g.expected) * 10) / 10;
      goalCard = `<div class="goal-card">${ring(pct, `${g.done}/${g.target}`, `objectif ${g.year}`)}
        <div><div class="goal-pct">${Math.min(pct, 999)} %</div>
        <p class="small">${diff >= 0 ? `<span class="good">▲ ${fmt(Math.abs(diff))} livre(s) d'avance</span>` : `<span class="late">▼ ${fmt(Math.abs(diff))} livre(s) de retard</span>`}</p>
        <p class="small muted">${fmt(g.expected)} attendu(s) à ce jour</p></div></div>`;
    } else {
      goalCard = `<div class="goal-card">${ring(0, String(g.done), `lus en ${g.year}`)}
        <div><p class="small muted">${mine ? 'Fixe un objectif annuel dans « Mes réglages » pour suivre ta progression.' : 'Pas d\'objectif annuel.'}</p></div></div>`;
    }

    const records = [
      ['🚀', 'Lecture la plus rapide', d.fastest, d.fastest && `${d.fastest.days} jour(s)`],
      ['🐢', 'Lecture la plus longue', d.slowest, d.slowest && `${d.slowest.days} jour(s)`],
      ['📚', 'Livre le plus épais', d.thickest, d.thickest && `${fmt(d.thickest.pages)} pages`],
    ];

    return `${warn}
      <div class="hero">
        ${goalCard}
        <div class="kpis">
          ${kpi('📚', fmt(c.read), 'Livres lus', '', s.monthly.map((m) => m.books))}
          ${kpi('📄', fmt(s.pages), 'Pages lues', '', s.monthly.map((m) => m.pages))}
          ${kpi('⚡', d.pagesPerDay != null ? fmt(d.pagesPerDay) : '—', 'Pages par jour', d.count ? `sur ${d.count} livre(s) daté(s)` : 'dates de lecture requises')}
          ${kpi('⏱', d.avgDays != null ? `${fmt(d.avgDays)} j` : '—', 'Durée moyenne d\'un livre')}
        </div>
      </div>

      <div class="dash-grid">
        ${panel('Répartition', donut([
          { label: 'Lus', value: c.read, color: '--cat-1' },
          { label: 'En cours', value: c.reading, color: '--cat-2' },
          { label: 'À lire', value: c.toRead, color: '--cat-3' },
          { label: 'Abandonnés', value: c.abandoned, color: '--cat-4' },
        ], c.read + c.reading + c.toRead + c.abandoned, 'livres') + `<p class="small muted" style="margin-top:8px">${s.abandonRate != null ? `Taux d'abandon : <strong>${s.abandonRate} %</strong>` : ''}${c.liked ? ` · ♥ ${fmt(c.liked)} aimé(s)` : ''}${c.disliked ? ` · ✕ ${fmt(c.disliked)} pas aimé(s)` : ''}</p>`)}
        ${panel('Livres lus par mois', columns(s.monthly.map((m) => ({ month: m.month, value: m.books, prev: m.prevBooks })), { unit: 'livre(s)' }), 'span-2')}
      </div>

      ${panel('Pages lues par mois', area(s.monthly.map((m) => ({ month: m.month, value: m.pages })), { unit: 'pages' }))}

      <div class="dash-grid">
        ${panel('🏆 Auteurs favoris', podium(s.tastes.authors, { unit: ' livre(s)', empty: 'Aucun livre lu sur cette période.' }))}
        ${panel('Catégories', rankList(s.tastes.categories.map((t) => ({ name: t.name, count: t.read + t.abandoned, sub: `${t.read} lu(s)${t.abandoned ? ` · ${t.abandoned} abandonné(s)` : ''}${t.liked ? ` · ♥ ${t.liked}` : ''}` }))))}
        ${features().tags ? panel('Tags', rankList(s.tastes.tags.map((t) => ({ name: '#' + t.name, count: t.read + t.abandoned, sub: `${t.read} lu(s)${t.liked ? ` · ♥ ${t.liked}` : ''}` })))) : ''}
        ${s.ratings ? panel('⭐ Mes notes', ratingsHtml(s.ratings, 'Aucun livre noté sur cette période.')) : ''}
        ${s.tastes.series && s.tastes.series.length ? panel('Séries', rankList(s.tastes.series)) : ''}
      </div>

      ${panel('Records', `<div class="records">${records.map(([icon, label, b, val]) => `
        <div class="record">${b ? miniCover(b, 'record-cover') : '<span class="mini-cover record-cover"><span>?</span></span>'}
          <div><div class="record-label">${icon} ${label}</div>${b ? `<a href="#/book/${b.bookId}" class="record-title">${esc(b.title)}</a><div class="record-value">${val}</div>` : '<div class="muted small">Pas encore de données</div>'}</div></div>`).join('')}</div>`)}

      <div class="dash-grid">
        ${panel('📖 En cours', s.current.length ? `<div class="reading-now">${s.current.map((b) => `
          <div class="now-item">${miniCover(b)}
            <div class="now-info"><a href="#/book/${b.bookId}">${esc(b.title)}</a>
              <div class="small muted">${b.days != null ? `${b.days} jour(s)` : 'début inconnu'}${b.pages ? ` · ${fmt(b.pages)} p.` : ''}</div>
              ${b.days != null ? `<div class="now-bar ${b.stale ? 'stale' : ''}"><span style="width:${Math.min(100, (b.days / s.staleDays) * 100)}%"></span></div>` : ''}
              ${b.stale ? `<span class="badge badge-warn">Traîne (+ de ${s.staleDays} j)</span>` : ''}</div></div>`).join('')}</div>`
          : '<p class="muted small">Aucune lecture en cours.</p>', 'span-2')}
        ${panel('♥ Coups de cœur', coverStrip(s.favorites, 'Aucun livre aimé pour le moment.'))}
      </div>
      ${s.ratings && s.ratings.top.length ? panel('⭐ Les mieux notés', coverStrip(s.ratings.top.map((b) => ({ ...b, title: `${b.title} · ${'★'.repeat(b.rating)}` })), '')) : ''}`;
  }

  function libraryStatsHtml(s) {
    const L = s.loans;
    const F = s.fonds;
    const R = s.reading;
    return `
      <div class="kpis kpis-wide">
        ${R ? kpi('📚', fmt(R.booksRead), 'Lectures terminées') : ''}
        ${R ? kpi('👥', fmt(R.activeReaders), 'Lecteurs actifs') : ''}
        ${R && R.ratings ? kpi('⭐', R.ratings.average != null ? fmt(R.ratings.average) : '—', 'Note moyenne', `${fmt(R.ratings.count)} note(s)`) : ''}
        ${kpi('🔁', fmt(L.total), 'Prêts sur la période', '', L.perMonth.map((m) => m.count))}
        ${kpi('📤', fmt(L.open), 'Prêts en cours')}
        ${kpi('⏱', L.avgDays != null ? `${fmt(L.avgDays)} j` : '—', 'Durée moyenne d\'un prêt')}
        ${kpi('📘', fmt(F.books), 'Livres', features().ebooks ? `${fmt(F.physical)} papier · ${fmt(F.ebooks)} numérique(s)` : '', F.growth.map((m) => m.count))}
        ${kpi('🏷', fmt(F.copies), 'Exemplaires papier')}
        ${kpi('📄', fmt(F.pages), 'Pages au total')}
      </div>

      ${R ? `<div class="dash-grid">
        ${panel('🏆 Les plus lus', podium(R.mostRead, { covers: true, unit: ' lecteur(s)' }))}
        ${panel('♥ Les plus aimés', podium(R.mostLiked, { covers: true, empty: 'Aucun livre aimé.' }))}
        ${panel('Les plus abandonnés', rankList(R.mostAbandoned))}
      </div>
      ${R.ratings ? `<div class="dash-grid">
        ${panel('⭐ Les mieux notés', podium(R.bestRated, { covers: true, unit: ' ★', empty: 'Aucun livre noté.' }))}
        ${panel('⭐ Notes données', ratingsHtml(R.ratings, 'Aucune note sur cette période.'))}
      </div>` : ''}` : ''}

      <div class="dash-grid">
        ${panel('Prêts par mois', columns(L.perMonth.map((m) => ({ month: m.month, value: m.count })), { unit: 'prêt(s)' }), 'span-2')}
        ${panel('🏆 Les plus empruntés', podium(L.mostBorrowed, { covers: true, unit: ' prêt(s)' }))}
      </div>

      <div class="dash-grid">
        ${panel('Emprunteurs les plus actifs', rankList(L.topBorrowers, { unit: ' prêt(s)' }))}
        ${panel('Prêts en cours les plus anciens', L.oldestOpen.length ? `<div class="reading-now">${L.oldestOpen.map((l) => `
          <div class="now-item">${miniCover({ ...l, title: l.name })}<div class="now-info"><a href="#/book/${l.bookId}">${esc(l.name)}</a>
            <div class="small muted">${esc(l.borrower)} · ${l.days} jour(s)</div></div></div>`).join('')}</div>` : '<p class="muted small">Aucun prêt en cours.</p>')}
        ${panel(`Jamais empruntés (${fmt(L.neverBorrowedCount)})`, coverStrip(L.neverBorrowed, 'Tous les livres ont déjà été empruntés.')
          + (L.neverBorrowedCount > L.neverBorrowed.length ? `<p class="small muted">… et ${L.neverBorrowedCount - L.neverBorrowed.length} autre(s).</p>` : ''))}
      </div>

      <div class="dash-grid">
        ${panel('Livres ajoutés par mois', area(F.growth.map((m) => ({ month: m.month, value: m.count })), { unit: 'livre(s)' }), 'span-2')}
        ${features().ebooks ? panel('Papier / numérique', donut([
          { label: 'Papier seul', value: F.paperOnly, color: '--cat-1' },
          { label: 'Papier + numérique', value: F.both, color: '--cat-3' },
          { label: 'Numérique seul', value: F.ebookOnly, color: '--cat-2' },
        ], F.books, 'livres')) : panel('Catégories du fonds', rankList(F.byCategory))}
      </div>
      ${features().ebooks ? `<div class="dash-grid">${panel('Catégories du fonds', rankList(F.byCategory))}</div>` : ''}`;
  }

  // ================= Reglages de la bibliotheque =================
  async function viewSettings() {
    const s = await api('/api/settings');
    const rem = s.reminders || { mode: 'manual', offset: 0, subject: '', body: '' };
    // Options absentes : le serveur tourne encore une version precedente de l'app.
    const feat = s.features || null;
    const catalog = {
      filters: (s.catalog && s.catalog.filters) || ALL_CATALOG_FILTERS, position: (s.catalog && s.catalog.position) || 'top',
      card: (s.catalog && s.catalog.card) || ALL_CATALOG_CARD,
    };
    const libraryUrl = location.origin + LIB;
    view().innerHTML = `
      <h1>Réglages</h1>
      <p class="muted">Bibliothèque « ${esc(s.libraryName)} » · <a href="${esc(libraryUrl)}/">${esc(libraryUrl)}/</a></p>
      <p class="settings-group">Bibliothèque</p>
      <h2>Nom, logo et en-tête</h2>
      <form class="card" id="lib-form">
        <div class="field"><label for="lib-name">Nom de la bibliothèque ${hint('Changer le nom ne change pas l\'adresse de la bibliothèque : les QR codes imprimés restent valables.')}</label><input id="lib-name" name="libraryName" required value="${esc(s.libraryName)}"></div>
        <div class="field">
          <label>Logo ${hint('Affiché dans l\'en-tête, sur les étiquettes et dans le catalogue intégré. PNG à fond transparent conseillé.')}</label>
          <div class="btn-row">
            ${s.logoUrl ? `<img src="${esc(mediaSrc(s.logoUrl))}" alt="" style="height:56px;max-width:160px;object-fit:contain;background:#fff;border-radius:8px;padding:4px;border:1px solid var(--border)">` : '<span class="muted small">Aucun logo</span>'}
            <label class="btn btn-small" style="margin:0">${s.logoUrl ? 'Remplacer' : 'Choisir une image'}<input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${s.logoUrl ? '<button class="btn btn-small btn-danger" type="button" id="logo-remove">Retirer</button>' : ''}
          </div>
        </div>
        <div class="field">
          <label>En-tête de l'application ${s.logoUrl ? '' : hint('Sans logo, le nom est toujours affiché.')}</label>
          <div class="btn-row" id="brand-display">
            <label class="check"><input type="radio" name="brandDisplay" value="both" ${(s.brandDisplay || 'both') === 'both' ? 'checked' : ''}> Nom et logo</label>
            <label class="check"><input type="radio" name="brandDisplay" value="name" ${s.brandDisplay === 'name' ? 'checked' : ''}> Nom seul</label>
            <label class="check"><input type="radio" name="brandDisplay" value="logo" ${s.brandDisplay === 'logo' ? 'checked' : ''}> Logo seul</label>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">Enregistrer</button>
      </form>

      <h2>Fonctionnalités</h2>
      <form class="card" id="features-form">
        ${feat ? '' : `<div class="error-box">Le serveur n'est pas à jour (options indisponibles). Vérifie que tous les fichiers de l'app ont été envoyés,
          y compris le dossier <span class="code">lib/</span>, puis redémarre l'application Node.</div>`}
        <label class="check" style="align-items:flex-start"><input type="checkbox" name="ebooks" ${feat && feat.ebooks ? 'checked' : ''} ${feat ? '' : 'disabled'} style="margin-top:4px">
          <span><strong>Livres numériques</strong> ${hint('Permet d\'ajouter à un livre un exemplaire numérique (epub, pdf…), seul ou en plus des exemplaires papier : il apparaît au catalogue avec la mention « Numérique », sans code, étiquette ni prêt.')}</span></label>
        <label class="check" style="align-items:flex-start;margin-top:12px"><input type="checkbox" name="readingStatus" ${feat && feat.readingStatus ? 'checked' : ''} ${feat ? '' : 'disabled'} style="margin-top:4px">
          <span><strong>Statuts de lecture</strong> ${hint('Chaque compte peut marquer un livre « À lire » ou « Lu », et « Aimé » ou « Pas aimé ». Visibles dans le catalogue (gestion), avec des filtres par compte. Jamais affichés sur le catalogue public.')}</span></label>
        <label class="check" style="align-items:flex-start;margin-top:12px"><input type="checkbox" name="tags" ${feat && feat.tags ? 'checked' : ''} ${feat ? '' : 'disabled'} style="margin-top:4px">
          <span><strong>Tags</strong> ${hint('Mots-clés libres en plus des catégories (ex. #incontournable, #formation-2025). Ajoutés sur la fiche d\'un livre, visibles et filtrables dans le catalogue.')}</span></label>
        <label class="check" style="align-items:flex-start;margin-top:12px"><input type="checkbox" name="stats" ${feat && feat.stats ? 'checked' : ''} ${feat ? '' : 'disabled'} style="margin-top:4px">
          <span><strong>Statistiques</strong> ${hint('Statistiques de lecture de chaque compte (privées, partageables avec les autres membres) et de la bibliothèque (lecture en totaux anonymes, prêts, fonds). Les statistiques de lecture demandent les statuts de lecture.')}</span></label>
        <label class="check" style="align-items:flex-start;margin-top:12px"><input type="checkbox" name="kobo" ${feat && feat.kobo ? 'checked' : ''} ${feat && feat.ebooks ? '' : 'disabled'} style="margin-top:4px">
          <span><strong>Liseuses Kobo</strong> ${hint('Demande les livres numériques. Liseuses branchées en USB : liste de leurs livres, rapprochement avec les fiches, statuts de lecture du propriétaire, envoi de livres (copie directe avec Chrome).')}</span></label>
      </form>
      ${feat && feat.ebooks && s.ebookAccess ? `
      <h2>Fichiers epub</h2>
      <form class="card" id="ebook-access-form">
        ${[['visible', 'Voir qu\'un fichier existe'], ['read', 'Lire en ligne'], ['download', 'Télécharger']].map(([key, label]) => `
          <div class="field"><label>${label}</label><select name="${key}">
            ${FILE_LEVELS.map(([v, l]) => `<option value="${v}" ${s.ebookAccess[key] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}
        <p class="small muted">Pouvoir lire ou télécharger rend aussi le fichier visible.</p>
      </form>` : ''}

      <p class="settings-group">Exemplaires et prêts</p>
      <h2>Codes des exemplaires</h2>
      <form class="card" id="code-form">
        <p class="muted small">Prochain code attribué : <span class="code">${esc(s.codePrefix)}-${String(s.nextCodeNumber).padStart(5, '0')}</span></p>
        <div class="grid-2">
          <div class="field"><label for="prefix">Préfixe</label><input id="prefix" name="prefix" value="${esc(s.codePrefix)}" maxlength="10" pattern="[A-Za-z0-9]{1,10}" required style="text-transform:uppercase"></div>
          <div class="field"><label>Aperçu</label><input id="prefix-preview" disabled></div>
        </div>
        <div class="btn-row">
          <button class="btn" type="submit" title="Appliquer aux nouveaux exemplaires">Enregistrer</button>
          <button class="btn btn-danger" type="button" id="renumber">Régénérer…</button>${hint('Enregistrer : le préfixe vaut pour les prochains exemplaires. Régénérer : tous les exemplaires reçoivent un nouveau code.')}
        </div>
        <div id="renumber-panel" hidden style="margin-top:14px">
          <div class="info-box">
            Tous les exemplaires de cette bibliothèque reçoivent un code avec ce préfixe et leurs étiquettes repassent « en attente ».
            Les anciennes étiquettes restent utilisables en attendant : scannées, elles renvoient vers le bon exemplaire.
          </div>
          <label class="check"><input type="checkbox" id="compact"> Repartir de 1 ${hint('Renumérote dans l\'ordre d\'ajout, sans trous.')}</label>
          <p class="small muted" id="compact-warn" hidden>Avec le même préfixe, des numéros seront réattribués à d'autres livres : une ancienne étiquette pourrait alors ouvrir le mauvais exemplaire. Réimprime toutes les étiquettes rapidement.</p>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn btn-danger" type="button" id="renumber-go">Régénérer maintenant</button>
            <button class="btn" type="button" id="renumber-cancel">Annuler</button>
          </div>
        </div>
      </form>

      <h2>Durée des prêts</h2>
      <form class="card" id="loan-days-form">
        <div class="field" style="margin:0"><label for="loan-days">Jours avant la date de retour ${hint('Date de retour proposée au moment du prêt (modifiable). 0 : pas de date de retour.')}</label>
          <input id="loan-days" name="loanDays" type="number" min="0" max="365" value="${s.loanDays == null ? 21 : s.loanDays}" style="max-width:120px"></div>
      </form>

      <h2>Rappels de retour</h2>
      <form class="card" id="reminder-form">
        <fieldset class="plain">
          <legend>Mode ${hint("Le rappel ouvre un e-mail prêt à envoyer dans ta messagerie (mailto) : rien n'est envoyé sans toi.")}</legend>
          <div class="btn-row" style="margin-bottom:14px">
            <label class="check"><input type="radio" name="mode" value="manual" ${rem.mode !== 'auto' ? 'checked' : ''}> Manuels (bouton « Relancer »)</label>
            <label class="check"><input type="radio" name="mode" value="auto" ${rem.mode === 'auto' ? 'checked' : ''}> Programmés (onglet « À relancer »)</label>
          </div>
        </fieldset>
        <div class="field" id="rem-offset-field" ${rem.mode === 'auto' ? '' : 'hidden'}><label for="rem-offset">Relancer à J + … jours de la date de retour ${hint('0 : le jour de la date de retour. Négatif : avant (-2 = deux jours avant). Ensuite, nouvelle relance tous les 7 jours tant que le livre est en retard.')}</label>
          <input id="rem-offset" name="offset" type="number" min="-60" max="365" value="${rem.offset}" style="max-width:120px"></div>
        <div class="field"><label for="rem-subject">Objet</label><input id="rem-subject" name="subject" value="${esc(rem.subject)}" placeholder="${esc(REMINDER_DEFAULT.subject)}"></div>
        <div class="field"><label for="rem-body">Message ${hint("Remplacés à l'envoi : {nom}, {livres} (liste des livres et dates), {bibliotheque}, {date_retour}. Vide : modèle par défaut.")}</label>
          <textarea id="rem-body" name="body" rows="8" placeholder="${esc(REMINDER_DEFAULT.body)}">${esc(rem.body)}</textarea></div>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Enregistrer le message</button><button class="btn" type="button" id="rem-reset">Modèle par défaut</button></div>
      </form>

      <h2>Bouton Scanner</h2>
      <form class="card" id="scan-form">
        <label>Codes lus</label>
        <div class="btn-row" style="margin-bottom:14px">
          ${[['copy', "QR code de l'étiquette"], ['isbn', 'Code-barres ISBN'], ['both', 'Les deux']].map(([v, l]) => `
            <label class="check"><input type="radio" name="codes" value="${v}" ${scanConf().codes === v ? 'checked' : ''}> ${l}</label>`).join('')}
        </div>
        <label>Page ouverte ${hint("Prêt avec un ISBN : l'exemplaire s'ouvre directement s'il est seul, sinon tu choisis parmi les exemplaires.")}</label>
        <div class="btn-row">
          ${[['loan', "Prêt / retour de l'exemplaire"], ['book', 'Fiche du livre']].map(([v, l]) => `
            <label class="check"><input type="radio" name="action" value="${v}" ${scanConf().action === v ? 'checked' : ''}> ${l}</label>`).join('')}
        </div>
      </form>

      <p class="settings-group">Catalogue</p>
      <h2>Affichage du catalogue</h2>
      <form class="card" id="catalog-form">
        <label>Filtres affichés</label>
        <div class="btn-row" style="margin-bottom:14px">
          ${CATALOG_FILTER_LABELS.map(([k, l, needs]) => {
            const off = needs && !(feat && feat[needs]);
            return `<label class="check" ${off ? 'title="Active d\'abord l\'option correspondante"' : ''}><input type="checkbox" name="f" value="${k}" ${catalog.filters.includes(k) ? 'checked' : ''}> ${l}${off ? ' <span class="small muted">(option désactivée)</span>' : ''}</label>`;
          }).join('')}
        </div>
        <label>Position des filtres</label>
        <div class="btn-row">
          <label class="check"><input type="radio" name="position" value="top" ${catalog.position !== 'left' ? 'checked' : ''}> En haut</label>
          <label class="check"><input type="radio" name="position" value="left" ${catalog.position === 'left' ? 'checked' : ''}> Colonne à gauche</label>
        </div>
        <label style="margin-top:14px">Miniature d'un livre</label>
        <div class="btn-row">
          ${CATALOG_CARD_LABELS.map(([k, l, needs]) => {
            const off = needs && !(feat && feat[needs]);
            return `<label class="check" ${off ? 'title="Active d\'abord l\'option correspondante"' : ''}><input type="checkbox" name="card" value="${k}" ${catalog.card.includes(k) ? 'checked' : ''}> ${l}${off ? ' <span class="small muted">(option désactivée)</span>' : ''}</label>`;
          }).join('')}
        </div>
      </form>

      <h2>Classement ${hint('Rechercher, renommer, fusionner ou supprimer les catégories, tags, auteurs, séries, éditeurs et collections.')}</h2>
      <div class="card">
        <div class="tabs term-tabs">
          ${[['categories', 'Catégories'], ...(feat && feat.tags ? [['tags', 'Tags']] : []), ['authors', 'Auteurs'], ['series', 'Séries'],
            ['publishers', 'Éditeurs'], ['collections', 'Collections']].map(([k, l]) => `<button type="button" data-term-tab="${k}">${l}</button>`).join('')}
        </div>
        <div id="term-panel"></div>
      </div>

      <h2>Fiches incomplètes ${hint('Livres auxquels il manque une information. Touche un critère pour voir la liste et compléter les fiches.')}</h2>
      <div class="card">
        <div class="chips-filter" id="missing-summary"><span class="muted small">Chargement…</span></div>
      </div>

      <h2>Catalogue sur un site web ${hint('WordPress / Divi : choisis ce que le catalogue affiché sur ton site propose, puis copie le code.')}</h2>
      <div class="card" id="embed-builder">
        <label>Filtres proposés aux visiteurs</label>
        <div class="btn-row" style="margin-bottom:12px">
          ${[['recherche', 'Recherche', true], ['categories', 'Catégories', true], ['collections', 'Collections', false], ['series', 'Séries', false],
            ...(feat && feat.tags ? [['tags', 'Tags', false]] : []), ['disponibilite', 'Disponibilité', false],
            ...(feat && feat.ebooks ? [['type', 'Papier / numérique', false]] : []), ['tri', 'Tri', false], ['nombre', 'Nombre de livres', true]]
            .map(([k, l, on]) => `<label class="check"><input type="checkbox" data-filter-opt="${k}" ${on ? 'checked' : ''}> ${l}</label>`).join('')}
        </div>
        <label>Position des filtres</label>
        <div class="btn-row" style="margin-bottom:12px">
          <label class="check"><input type="radio" name="emb-pos" value="haut" checked> En haut</label>
          <label class="check"><input type="radio" name="emb-pos" value="gauche"> Colonne à gauche</label>
        </div>
        <div class="grid-2">
          <div class="field"><label>Livres par page</label><input type="number" id="emb-per" min="1" max="100" value="24"></div>
          <div class="field"><label>En-tête du catalogue</label><select id="emb-head">
            <option value="oui">Nom et logo</option>
            <option value="nom">Nom seul</option>
            <option value="logo">Logo seul</option>
            <option value="non">Rien</option>
          </select></div>
        </div>
        <label>Shortcode ${hint('Avec l\'extension fournie (dossier wordpress/ du projet), dans un module Texte ou Code de Divi.')}</label>
        <div class="snippet" id="emb-shortcode"></div>
        <button class="btn btn-small" type="button" data-copy="emb-shortcode" style="margin-top:6px">Copier</button>
        <label style="margin-top:14px">Code HTML ${hint('Sans extension, dans un module Code.')}</label>
        <div class="snippet" id="emb-html"></div>
        <button class="btn btn-small" type="button" data-copy="emb-html" style="margin-top:6px">Copier</button>
      </div>

      <p class="settings-group">Données</p>
      <h2>Exporter</h2>
      <div class="card">
        <p><strong>Inventaire des livres</strong> ${hint('Une ligne par livre avec tous les champs, le nombre d\'exemplaires et leurs codes. Mêmes colonnes que le modèle d\'import : modifiable puis réimportable (Ajout multiple › Fichier complet, option « Mettre à jour la fiche »).')}</p>
        <div class="btn-row">
          <a class="btn btn-primary" href="${LIB}/api/export/inventory.xlsx">Excel</a>
          <a class="btn" href="${LIB}/api/export/inventory.csv">CSV</a>
        </div>
        <p style="margin-top:16px"><strong>Liste des exemplaires</strong> ${hint('Une ligne par exemplaire : code, emplacement, prêt en cours.')}</p>
        <a class="btn" href="${LIB}/api/export/copies.csv">CSV</a>
      </div>

      <h2>Vider la bibliothèque</h2>
      <div class="card danger-zone">
        <p>Supprime <strong>tous les livres</strong> de « ${esc(s.libraryName)} », avec leurs exemplaires, l'historique des prêts et les statuts de lecture.
          Les réglages, le logo et les membres sont conservés. Une sauvegarde complète de la base est faite automatiquement juste avant. ${hint('Pour supprimer seulement quelques livres : Catalogue › « Sélectionner ».')}</p>
        <form id="empty-form">
          <label class="check"><input type="checkbox" name="borrowers"> Supprimer aussi les emprunteurs</label>
          <label class="check"><input type="checkbox" name="terms"> Supprimer aussi les catégories et les tags</label>
          <label class="check"><input type="checkbox" name="resetCodes"> Codes repartant de 1 ${hint('Les anciennes étiquettes ne seront plus reconnues.')}</label>
          <div class="field" style="margin-top:12px"><label for="empty-confirm">Pour confirmer, tape le nom de la bibliothèque : <strong>${esc(s.libraryName)}</strong></label>
            <input id="empty-confirm" name="confirm" autocomplete="off"></div>
          <button class="btn btn-danger" type="submit">Vider la bibliothèque</button>
        </form>
      </div>`;

    $('#empty-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.confirm.value.trim() !== s.libraryName.trim()) { toast('Tape exactement le nom de la bibliothèque pour confirmer.', 'error'); return; }
      if (!confirm(`Dernière vérification : supprimer TOUS les livres de « ${s.libraryName} » ?`)) return;
      try {
        const r = await api('/api/empty', { method: 'POST', body: { confirm: f.confirm.value, borrowers: f.borrowers.checked, terms: f.terms.checked, resetCodes: f.resetCodes.checked } });
        toast(`${r.deleted} livre(s) supprimé(s). Sauvegarde : ${r.backup}`);
        f.reset();
      } catch (err) { toast(err.message, 'error'); }
    };

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
    // Options : enregistrees des qu'on coche / decoche.
    $$('#features-form input').forEach((cb) => {
      cb.onchange = async () => {
        try {
          await api('/api/settings', { method: 'PUT', body: { features: { [cb.name]: cb.checked } } });
          await loadSettings();
          membersCache = null;
          toast(cb.checked ? 'Option activée.' : 'Option désactivée.');
          if (cb.name === 'tags') route(); // affiche / masque la gestion des tags
          if (cb.name === 'stats') renderNav(); // entree "Statistiques" du menu
          if (cb.name === 'ebooks' || cb.name === 'kobo') { renderNav(); route(); } // Liseuses, droits epub
        } catch (err) { cb.checked = !cb.checked; toast(err.message, 'error'); }
      };
    });
    $$('#ebook-access-form select').forEach((sel) => {
      sel.onchange = async () => {
        try {
          await api('/api/settings', { method: 'PUT', body: { ebookAccess: { [sel.name]: sel.value } } });
          toast('Droits enregistrés.');
        } catch (err) { toast(err.message, 'error'); }
      };
    });
    // Generateur du code d'integration (shortcode WordPress / HTML).
    const updateEmbed = () => {
      const filtersSel = $$('[data-filter-opt]:checked').map((cb) => cb.dataset.filterOpt);
      const filtres = filtersSel.length ? filtersSel.join(',') : 'aucun';
      const per = Math.max(1, Math.min(100, parseInt($('#emb-per').value, 10) || 24));
      const head = $('#emb-head').value; // oui (nom et logo), nom, logo, non
      const pos = ($('[name=emb-pos]:checked') || {}).value === 'gauche' ? 'gauche' : '';
      $('#emb-shortcode').textContent = `[bibliotheque url="${libraryUrl}" filtres="${filtres}"${pos ? ' position="gauche"' : ''}${per !== 24 ? ` par_page="${per}"` : ''}${head !== 'oui' ? ` entete="${head}"` : ''}]`;
      $('#emb-html').textContent = `<div class="mll-catalogue" data-url="${libraryUrl}" data-filters="${filtres}"${pos ? ' data-position="gauche"' : ''} data-per-page="${per}"${head !== 'oui' ? ` data-header="${head}"` : ''}></div>\n<script src="${libraryUrl}/embed.js" defer></script>`;
    };
    $$('#embed-builder input').forEach((i) => i.addEventListener('input', updateEmbed));
    $$('#embed-builder input, #embed-builder select').forEach((i) => i.addEventListener('change', updateEmbed));
    $$('[data-copy]').forEach((btn) => {
      btn.onclick = async () => {
        const text = $(`#${btn.dataset.copy}`).textContent;
        try { await navigator.clipboard.writeText(text); toast('Copié.'); } catch (e) { prompt('Copie ce code :', text); }
      };
    });
    updateEmbed();

    // En-tete : applique tout de suite, sans bouton.
    $$('#brand-display input').forEach((r) => {
      r.onchange = async () => {
        try {
          await api('/api/settings', { method: 'PUT', body: { brandDisplay: r.value } });
          await loadSettings();
          renderBrand();
          toast('En-tête mis à jour.');
        } catch (err) { toast(err.message, 'error'); }
      };
    });

    // Duree des prets : enregistree des qu'on change.
    $('#loan-days-form').addEventListener('change', async (e) => {
      try {
        await api('/api/settings', { method: 'PUT', body: { loanDays: Number(e.target.value) } });
        toast('Durée des prêts mise à jour.');
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#loan-days-form').addEventListener('submit', (e) => e.preventDefault());

    // Rappels : mode et delai enregistres des qu'on change, message sur le bouton.
    const remForm = $('#reminder-form');
    const saveReminders = async (body, msg) => {
      try { await api('/api/settings', { method: 'PUT', body: { reminders: body } }); toast(msg); refreshLoanBadge(); } catch (err) { toast(err.message, 'error'); }
    };
    remForm.addEventListener('change', (e) => {
      if (e.target.name === 'mode') { $('#rem-offset-field').hidden = e.target.value !== 'auto'; saveReminders({ mode: e.target.value }, 'Mode des rappels enregistré.'); }
      if (e.target.name === 'offset') saveReminders({ offset: Number(e.target.value) }, 'Délai des rappels enregistré.');
    });
    remForm.onsubmit = (e) => { e.preventDefault(); saveReminders({ subject: remForm.subject.value, body: remForm.body.value }, 'Message de rappel enregistré.'); };
    $('#rem-reset').onclick = () => { remForm.subject.value = ''; remForm.body.value = ''; saveReminders({ subject: '', body: '' }, 'Modèle par défaut rétabli.'); };

    // Bouton Scanner : enregistre des qu'on change.
    $('#scan-form').addEventListener('change', async () => {
      const codes = ($('#scan-form [name=codes]:checked') || {}).value;
      const action = ($('#scan-form [name=action]:checked') || {}).value;
      try {
        await api('/api/settings', { method: 'PUT', body: { scan: { codes, action } } });
        await loadSettings();
        renderHeader();
        toast('Bouton Scanner mis à jour.');
      } catch (err) { toast(err.message, 'error'); }
    });

    // Catalogue : filtres affiches et position, enregistres des qu'on change.
    $('#catalog-form').addEventListener('change', async () => {
      const filters = $$('#catalog-form [name=f]:checked').map((cb) => cb.value);
      const position = ($('#catalog-form [name=position]:checked') || {}).value || 'top';
      const card = $$('#catalog-form [name=card]:checked').map((cb) => cb.value);
      try {
        await api('/api/settings', { method: 'PUT', body: { catalog: { filters, position, card } } });
        await loadSettings();
        toast('Catalogue mis à jour.');
      } catch (err) { toast(err.message, 'error'); }
    });

    accordionize(view(), `mll-settings-${LIBRARY.slug}`);
    api('/api/books/missing').then((m) => {
      const box = $('#missing-summary');
      if (box) box.innerHTML = missingPills(m, null);
    }).catch(() => {
      const box = $('#missing-summary');
      if (box) box.innerHTML = '<a class="btn btn-small" href="#/incomplete">Voir les fiches incomplètes</a>';
    });
    // Classement : un onglet par liste, charge a la demande (dernier onglet memorise).
    const termKey = `mll-terms-${LIBRARY.slug}`;
    const showTerms = async (k) => {
      $$('[data-term-tab]').forEach((b) => b.classList.toggle('active', b.dataset.termTab === k));
      try { localStorage.setItem(termKey, k); } catch (e) { /* stockage indisponible */ }
      const panel = $('#term-panel');
      panel.innerHTML = '<p class="muted small">Chargement…</p>';
      try {
        const list = await api(`/api/${TERM_KINDS[k].path}`);
        if (!$(`[data-term-tab="${k}"].active`)) return; // autre onglet choisi entre-temps
        panel.innerHTML = '';
        categoryManager(panel, list, k);
      } catch (err) { panel.innerHTML = '<p class="muted small">Indisponible : le serveur n\'est pas à jour.</p>'; }
    };
    $$('[data-term-tab]').forEach((b) => { b.onclick = () => showTerms(b.dataset.termTab); });
    let lastTerms = null;
    try { lastTerms = localStorage.getItem(termKey); } catch (e) { /* stockage indisponible */ }
    showTerms($(`[data-term-tab="${lastTerms}"]`) ? lastTerms : 'categories');
  }

  // Gestion des categories, tags, auteurs, series, editeurs et collections : recherche,
  // regroupement alphabetique repliable, renommage, suppression et fusion.
  // free : valeurs libres des fiches (pas de table, l'identifiant est le nom).
  const TERM_KINDS = {
    categories: { path: 'categories', one: 'catégorie', many: 'catégories', the: 'la catégorie', a: 'une catégorie', prefix: '', added: 'Nouvelle catégorie' },
    tags: { path: 'tags', one: 'tag', many: 'tags', the: 'le tag', a: 'un tag', prefix: '#', added: 'Nouveau tag' },
    authors: { path: 'values/authors', one: 'auteur', many: 'auteurs', the: "l'auteur", a: 'un auteur', none: 'Aucun auteur', prefix: '', free: true },
    series: { path: 'values/series', one: 'série', many: 'séries', the: 'la série', a: 'une série', none: 'Aucune série', prefix: '', free: true },
    publishers: { path: 'values/publishers', one: 'éditeur', many: 'éditeurs', the: "l'éditeur", a: 'un éditeur', none: 'Aucun éditeur', prefix: '', free: true },
    collections: { path: 'values/collections', one: 'collection', many: 'collections', the: 'la collection', a: 'une collection', none: 'Aucune collection', prefix: '', free: true },
  };
  function categoryManager(root, initial, kindName = 'categories') {
    const K = TERM_KINDS[kindName];
    const id = (x) => `${kindName}-${x}`;
    const label = (n) => K.prefix + n;
    const key = (v) => (K.free ? String(v) : Number(v));
    const find = (v) => cats.find((x) => x.id === key(v));
    let cats = initial;
    let q = '';
    const selected = new Set();
    const open = new Set();
    root.innerHTML = `
      <div class="isbn-row">
        <input type="search" id="${id('q')}" placeholder="Rechercher ${K.a}…" autocomplete="off">
      </div>
      ${K.free ? '' : `<form class="isbn-row" id="${id('new')}" style="margin-top:8px"><input name="name" placeholder="${K.added}"><button class="btn" type="submit">Ajouter</button></form>`}
      <div class="merge-bar"></div>
      <div class="term-body" style="margin-top:10px"></div>`;

    const reload = async () => { cats = await api(`/api/${K.path}`); render(); };
    const letterOf = (name) => {
      const l = normHeader(name).charAt(0).toUpperCase();
      return /[A-Z]/.test(l) ? l : '#';
    };
    const rowHtml = (c) => `
      <div class="list-item cat-row">
        <input type="checkbox" data-sel="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''} aria-label="Sélectionner ${esc(c.name)}">
        <div class="grow">${esc(label(c.name))} <span class="small muted">(${c.count} livre${c.count > 1 ? 's' : ''})</span></div>
        <button class="btn btn-small" data-rename="${esc(c.id)}">Renommer</button>
        <button class="btn btn-small btn-danger" data-delcat="${esc(c.id)}">Supprimer</button>
      </div>`;

    function renderMergeBar() {
      const bar = $('.merge-bar', root);
      const chosen = cats.filter((c) => selected.has(c.id));
      if (!chosen.length) { bar.innerHTML = ''; return; }
      bar.innerHTML = `<div class="info-box" style="margin:10px 0 0">
        <strong>Sélection (${chosen.length})</strong> : ${chosen.map((c) => esc(label(c.name))).join(', ')}
        ${chosen.length >= 2 ? `<form class="isbn-row merge-form" style="margin-top:8px">
          <input name="name" list="${id('merge-names')}" required placeholder="Nom final" value="${esc(chosen[0].name)}">
          <datalist id="${id('merge-names')}">${chosen.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
          <button class="btn btn-primary" type="submit">Fusionner</button>
        </form>` : '<p class="small" style="margin:6px 0 0">Coche au moins deux ${K.many} pour les fusionner.</p>'}
        <button type="button" class="btn btn-small btn-merge-clear" style="margin-top:8px">Désélectionner</button>
      </div>`;
      $('.btn-merge-clear', bar).onclick = () => { selected.clear(); render(); };
      const form = $('.merge-form', bar);
      if (form) form.onsubmit = async (e) => {
        e.preventDefault();
        const name = e.target.name.value.trim();
        const books = chosen.reduce((n, c) => n + c.count, 0);
        if (!confirm(`Fusionner ${chosen.map((c) => `« ${c.name} »`).join(', ')} en « ${name} » ?\nLes livres concernés (${books}) seront rangés dans « ${name} ».`)) return;
        try {
          const r = await api(`/api/${K.path}/merge`, { method: 'POST', body: { ids: chosen.map((c) => c.id), name } });
          selected.clear();
          toast(`Fusion effectuée dans « ${r.name} » (${r.books} livre(s)).`);
          reload();
        } catch (err) { toast(err.message, 'error'); }
      };
    }

    function render() {
      const body = $('.term-body', root);
      const nq = normHeader(q);
      if (!cats.length) {
        body.innerHTML = K.free ? `<p class="muted">${K.none} pour le moment : à renseigner sur la fiche des livres.</p>`
          : `<p class="muted">Rien pour le moment : ${K.many === 'tags' ? 'les tags' : 'les catégories'} se créent depuis la fiche d'un livre ou ici.</p>`;
      } else if (nq) {
        const found = cats.filter((c) => normHeader(c.name).includes(nq));
        body.innerHTML = found.length ? `<div class="list">${found.map(rowHtml).join('')}</div>` : '<p class="muted small">Aucun résultat.</p>';
      } else {
        const groups = new Map();
        cats.forEach((c) => { const l = letterOf(c.name); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(c); });
        body.innerHTML = `<p class="small muted">${cats.length} ${K.one}(s) ${hint('Clique sur une lettre pour la déplier.')}</p>` +
          Array.from(groups).sort(([a], [b]) => a.localeCompare(b)).map(([l, list]) => `
          <details class="cat-group" data-letter="${l}" ${open.has(l) ? 'open' : ''}>
            <summary><strong>${l}</strong> <span class="small muted">${list.length} ${K.one}(s)${list.some((c) => selected.has(c.id)) ? ' · sélection' : ''}</span></summary>
            <div class="list">${list.map(rowHtml).join('')}</div>
          </details>`).join('');
        $$('.cat-group', body).forEach((d) => d.addEventListener('toggle', () => { if (d.open) open.add(d.dataset.letter); else open.delete(d.dataset.letter); }));
      }
      $$('[data-sel]', body).forEach((cb) => {
        cb.onchange = () => { const id = key(cb.dataset.sel); if (cb.checked) selected.add(id); else selected.delete(id); renderMergeBar(); };
      });
      $$('[data-rename]', body).forEach((btn) => {
        btn.onclick = async () => {
          const c = find(btn.dataset.rename);
          const name = (prompt('Nouveau nom :', c.name) || '').trim();
          if (!name || name === c.name) return;
          if (K.free) {
            // Nom deja present : le renommage fusionne les deux.
            const other = cats.find((x) => x !== c && x.name.toLowerCase() === name.toLowerCase());
            if (other && !confirm(`${K.the.charAt(0).toUpperCase() + K.the.slice(1)} « ${other.name} » existe déjà. Fusionner « ${c.name} » dedans ?`)) return;
            try {
              const r = await api(`/api/${K.path}`, { method: 'PUT', body: { from: c.name, name } });
              selected.delete(c.id);
              toast(`${r.books} livre(s) mis à jour.`);
              reload();
            } catch (err) { toast(err.message, 'error'); }
            return;
          }
          try { await api(`/api/${K.path}/${c.id}`, { method: 'PUT', body: { name } }); reload(); } catch (err) {
            // Nom deja pris : proposer la fusion avec la categorie existante.
            const other = cats.find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (other && confirm(`${K.the.charAt(0).toUpperCase() + K.the.slice(1)} « ${other.name} » existe déjà. Fusionner « ${c.name} » dedans ?`)) {
              await api(`/api/${K.path}/merge`, { method: 'POST', body: { ids: [c.id, other.id], name: other.name } }).catch((e) => toast(e.message, 'error'));
              reload();
            } else toast(err.message, 'error');
          }
        };
      });
      $$('[data-delcat]', body).forEach((btn) => {
        btn.onclick = async () => {
          const c = find(btn.dataset.delcat);
          if (!confirm(`Supprimer ${K.the} « ${c.name} » ? ${K.free ? 'Retiré(e) des fiches, les' : 'Les'} ${c.count} livre(s) concernés restent au catalogue.`)) return;
          try {
            if (K.free) await api(`/api/${K.path}/delete`, { method: 'POST', body: { name: c.name } });
            else await api(`/api/${K.path}/${c.id}`, { method: 'DELETE' });
          } catch (err) { toast(err.message, 'error'); return; }
          selected.delete(c.id);
          reload();
        };
      });
      renderMergeBar();
    }

    $(`#${id('q')}`, root).addEventListener('input', debounce((e) => { q = e.target.value; render(); }, 150));
    if (!K.free) $(`#${id('new')}`, root).onsubmit = async (e) => {
      e.preventDefault();
      if (!e.target.name.value.trim()) return;
      try { await api(`/api/${K.path}`, { method: 'POST', body: { name: e.target.name.value } }); e.target.reset(); reload(); } catch (err) { toast(err.message, 'error'); }
    };
    render();
  }

  // ================= Installation (ecran d'accueil) =================
  // Android / Chrome / Edge : invite native (beforeinstallprompt). iPhone / iPad :
  // pas d'invite, on explique la marche a suivre dans Safari.
  let installPrompt = null;
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const canInstall = () => !isStandalone() && (!!installPrompt || isIos());
  // Bouton "Installer" de l'en-tete : seulement quand le navigateur propose l'installation.
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#install-btn').hidden = false; });
  window.addEventListener('appinstalled', () => { installPrompt = null; $('#install-btn').hidden = true; toast('Application installée.'); });
  async function installApp() {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      $('#install-btn').hidden = true;
      return;
    }
    alert('Pour installer l\'application sur cet appareil :\n\n1. Ouvre cette page dans Safari.\n2. Touche le bouton Partager (carré avec une flèche).\n3. Choisis « Sur l\'écran d\'accueil ».');
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register(`${ROOT}/sw.js`, { scope: `${ROOT}/` }).catch(() => {}));
  }
  if (isStandalone()) document.documentElement.classList.add('standalone');

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
      state.backupReminder = !!s.backupReminder;
    } catch (e) { /* hors ligne */ }
  }

  $('#install-btn').onclick = () => installApp();
  $('#scan-btn').onclick = () => scanAndOpen();

  (async function init() {
    await Promise.all([loadSettings(), loadStatus()]);
    renderHeader();
    if (LIBRARY && state.user && /^#?\/?$/.test(location.hash)) history.replaceState(null, '', '#/home');
    window.addEventListener('hashchange', route);
    route();
    koboRestore();
    showBackupReminder();
  })();
})();
