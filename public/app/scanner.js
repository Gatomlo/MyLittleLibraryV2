// Scanner (webcam / camera du telephone) — module de l'interface (organisation : public/app/README.md).
import './utilitaires.js';
import { ASSETS, state, pending, canManage } from './etat.js';
import { $, $$, esc, mediaSrc, fmtDate, api, toast, fmtDay, dueHtml, dialog, go, loadScript } from './utilitaires.js';
import { icon } from './icones.js';
import { route } from './routage.js';
import { wishDialog } from './souhaits.js';

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
    await loadScript(ASSETS + '/vendor/barcode-detector.js');
    window.BarcodeDetectionAPI.prepareZXingModule({
      overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? ASSETS + '/vendor/zxing_reader.wasm' : prefix + p) },
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
  if (!quaggaPromise) quaggaPromise = loadScript(ASSETS + '/vendor/quagga.min.js');
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
      decoder: { readers: ['ean_reader', 'code_128_reader'] },
    }, (r) => { clearTimeout(timeout); resolve(r && r.codeResult ? r.codeResult.code : null); });
  });
}

// Copie d'une image reduite (cote max) et tournee (0 ou 90 degres) sur un canvas.
function scaledCanvas(bitmap, max, rotate) {
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * k);
  const h = Math.round(bitmap.height * k);
  const canvas = document.createElement('canvas');
  canvas.width = rotate ? h : w;
  canvas.height = rotate ? w : h;
  const ctx = canvas.getContext('2d');
  if (rotate) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

// Codes lus sur une photo (valeurs acceptees par `accept`), sans ouvrir la camera.
// Une photo prise avec l'appareil du telephone (mise au point et eclairage corrects)
// est plus fiable que l'image video : plusieurs tailles et le sens tourne sont essayes.
async function decodePhoto(file, formats, accept) {
  const detector = await getDetector(formats);
  const bitmap = await createImageBitmap(file);
  const read = async (src) => (await detector.detect(src)).map((c) => accept(String(c.rawValue || '').trim())).filter(Boolean);
  let values = await read(bitmap);
  if (values.length || formats.includes('qr_code')) return values;
  const tries = [[1600, false], [900, false], [1600, true], [900, true]];
  for (const [max, rotate] of tries) {
    values = await read(scaledCanvas(bitmap, max, rotate)).catch(() => []);
    if (values.length) return values;
  }
  await loadQuagga();
  for (const rotate of [false, true]) {
    const q = await quaggaDecode(scaledCanvas(bitmap, 1600, rotate));
    const v = q && accept(q);
    if (v) return [v];
  }
  return [];
}

// Boutons Lampe et curseur de zoom sous la video, selon ce que la camera accepte.
// Renvoie la fonction `onReady` a donner a startCamera.
function cameraTools(box) {
  let open = false; // reglages replies par defaut (garde l'etat quand les boutons sont redessines)
  return (caps, ctl) => {
    if (!caps.torch && !caps.zoom && !caps.focus && !caps.cameras) { box.hidden = true; return; }
    const slider = (cls, label, c) => `<label class="cam-zoom small muted">${label} <input type="range" class="${cls}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.value}"></label>`;
    box.innerHTML = `<button class="btn btn-small" type="button" data-tools aria-expanded="${open}" title="Réglages de la caméra">${icon('settings', 16)}<span class="hide-mobile">Réglages</span></button>
      <div class="cam-panel" ${open ? '' : 'hidden'}>
      ${caps.cameras ? `<button class="btn btn-small" type="button" data-cam title="Changer d'objectif (le grand-angle est flou)">${icon('scan', 16)}Objectif ${caps.cameras.index + 1}/${caps.cameras.total}</button>` : ''}
      ${caps.torch ? `<button class="btn btn-small" type="button" data-torch aria-pressed="${!!caps.torchOn}">${icon('torch', 16)}Lampe</button>` : ''}
      ${caps.zoom ? slider('zoom', 'Zoom', caps.zoom) : ''}
      ${caps.focus ? `${slider('focus', 'Netteté', caps.focus)}<button class="btn btn-small" type="button" data-autofocus aria-pressed="${!caps.focus.manual}">Auto</button>` : ''}
      <button class="btn btn-small" type="button" data-remember title="Garder ces réglages par défaut sur cet appareil">${caps.saved ? 'Mettre à jour' : 'Retenir'}</button>
      ${caps.saved ? '<button class="btn btn-small" type="button" data-forget title="Revenir aux réglages d\'origine">Oublier</button>' : ''}
      </div>`;
    box.hidden = false;
    const on = (sel, fn) => { const el = $(sel, box); if (el) el.onclick = fn; };
    on('[data-tools]', (e) => {
      open = !open;
      e.currentTarget.setAttribute('aria-expanded', String(open));
      $('.cam-panel', box).hidden = !open;
    });
    on('[data-cam]', () => ctl.switchCamera().catch(() => {}));
    on('[data-torch]', async (e) => { const t = e.currentTarget; const v = t.getAttribute('aria-pressed') !== 'true'; try { await ctl.setTorch(v); t.setAttribute('aria-pressed', String(v)); } catch (err) { /* lampe indisponible */ } });
    const z = $('input.zoom', box);
    if (z) z.oninput = () => ctl.setZoom(Number(z.value)).catch(() => {});
    const f = $('input.focus', box);
    if (f) f.oninput = () => ctl.setFocus(Number(f.value)).catch(() => {});
    on('[data-autofocus]', () => ctl.autoFocus().catch(() => {}));
    on('[data-remember]', () => { ctl.remember(); toast('Réglages du scan retenus sur cet appareil.'); });
    on('[data-forget]', () => { ctl.forget(); toast('Réglages du scan oubliés.'); });
  };
}

// Reglages du scan retenus sur cet appareil (objectif, zoom, lampe, mise au point).
const SCAN_PREFS = 'mll-scan-prefs';
function scanPrefs() { try { return JSON.parse(localStorage.getItem(SCAN_PREFS)) || null; } catch (e) { return null; } }
function saveScanPrefs(v) { try { if (v) localStorage.setItem(SCAN_PREFS, JSON.stringify(v)); else localStorage.removeItem(SCAN_PREFS); } catch (e) { /* stockage indisponible */ } }
let sessionCam = ''; // objectif choisi pendant cette visite

// Moteur de lecture : camera + detection sur un element <video>. onValue(valeur)
// est appele pour chaque code accepte par `accept` ; s'il renvoie true, la lecture
// s'arrete (scan unique), sinon elle continue (scan en serie). Renvoie
// { stop(), readPhoto(file) }.
function startCamera({ video, formats, accept, onValue, onStatus, hint, onReady }) {
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
    // Objectif : un telephone en a souvent plusieurs, et l'ultra grand-angle n'a pas
    // de mise au point (image floue). Le dernier choisi est retenu.
    let devices = [];
    let current = '';
    let torchOn = false;
    async function openStream(deviceId) {
      const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      const next = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = next;
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return null; }
      const track = stream.getVideoTracks()[0];
      await tuneCamera(track, isBarcode);
      current = (track.getSettings && track.getSettings().deviceId) || deviceId || '';
      // Reglages retenus : appliques seulement a l'objectif pour lequel ils ont ete retenus.
      const pr = scanPrefs();
      torchOn = false;
      if (pr && pr.deviceId === current && track.getCapabilities) {
        const caps = track.getCapabilities();
        const adv = [];
        if (caps.zoom && pr.zoom) adv.push({ zoom: Math.min(caps.zoom.max, Math.max(caps.zoom.min, pr.zoom)) });
        if (caps.torch && pr.torch) { adv.push({ torch: true }); torchOn = true; }
        if (pr.focus != null && caps.focusDistance && (caps.focusMode || []).includes('manual')) adv.push({ focusMode: 'manual', focusDistance: pr.focus });
        for (const c of adv) await track.applyConstraints({ advanced: [c] }).catch(() => {});
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      return track;
    }
    function announce(track) {
      if (!onReady || !track || !track.getCapabilities) return;
      const caps = track.getCapabilities();
      const modes = caps.focusMode || [];
      const st = track.getSettings();
      const num = (c, v) => ({ min: c.min, max: c.max, step: c.step || (c.max - c.min) / 20, value: v });
      const set = (adv) => track.applyConstraints({ advanced: [adv] });
      const idx = devices.findIndex((d) => d.deviceId === current);
      const manual = st.focusMode === 'manual';
      onReady({
        torch: !!caps.torch,
        torchOn,
        zoom: caps.zoom ? num(caps.zoom, st.zoom || caps.zoom.min) : null,
        focus: caps.focusDistance && modes.includes('manual') ? { ...num(caps.focusDistance, st.focusDistance || caps.focusDistance.min), manual } : null,
        cameras: devices.length > 1 ? { index: Math.max(idx, 0), total: devices.length } : null,
        saved: !!scanPrefs(),
      }, {
        setTorch: async (on) => { await set({ torch: on }); torchOn = on; },
        setZoom: (z) => set({ zoom: z }),
        setFocus: (d) => set({ focusMode: 'manual', focusDistance: d }),
        autoFocus: () => set({ focusMode: 'continuous' }),
        switchCamera: async () => {
          const next = devices[(Math.max(idx, 0) + 1) % devices.length];
          sessionCam = next.deviceId;
          announce(await openStream(next.deviceId));
        },
        // Retient les reglages actuels comme reglages par defaut de cet appareil.
        remember: () => {
          const cur = track.getSettings();
          saveScanPrefs({ deviceId: current, zoom: cur.zoom || null, torch: torchOn, focus: cur.focusMode === 'manual' ? cur.focusDistance : null });
          announce(track);
        },
        forget: () => { saveScanPrefs(null); announce(track); },
      });
    }
    // Appui sur l'image : nouvelle mise au point a cet endroit (quand la camera sait le faire).
    video.onclick = async (e) => {
      const track = stream && stream.getVideoTracks()[0];
      if (!track || !track.getCapabilities) return;
      const modes = track.getCapabilities().focusMode || [];
      if (!modes.includes('single-shot')) return;
      const r = video.getBoundingClientRect();
      try {
        await track.applyConstraints({ advanced: [{ focusMode: 'single-shot', pointsOfInterest: [{ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }] }] });
        if (modes.includes('continuous')) setTimeout(() => { if (!stopped) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); }, 2000);
      } catch (err) { /* mise au point au toucher non supportee */ }
    };
    try {
      // Resolution maximale : un code-barres ISBN est petit, chaque pixel compte.
      let track = null;
      const want = sessionCam || (scanPrefs() || {}).deviceId || '';
      try { track = await openStream(want); } catch (err) { if (!want) throw err; track = await openStream(''); }
      if (!track) return;
      devices = (await navigator.mediaDevices.enumerateDevices().catch(() => []))
        .filter((d) => d.kind === 'videoinput' && !/front|avant|user|selfie/i.test(d.label));
      announce(track);
    } catch (err) {
      onStatus('Caméra refusée ou absente. Utilise la saisie manuelle ou une photo.');
      return;
    }
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
          let codes = await detector.detect(source);
          // Code hors du cadre : de temps en temps, toute l'image.
          if (isBarcode && !codes.length && frame % 3 === 2) codes = await detector.detect(video);
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
// fetchCovers(parametres) : recherche utilisee (par defaut celle de la bibliotheque).
function openCoverSearch(initial, fetchCovers = (q) => api('/api/covers?' + new URLSearchParams(q))) {
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
        const { covers } = await fetchCovers(q);
        if (my !== seq) return;
        status.textContent = covers.length ? `${covers.length} couverture(s) trouvée(s) — clique pour choisir.` : 'Aucune couverture trouvée. Essaie avec un autre titre ou colle une adresse d\'image.';
        results.innerHTML = covers.map((c, i) => `
          <button type="button" class="cover-choice" data-i="${i}" title="${esc([c.title, c.detail].filter(Boolean).join(' — '))}">
            <span class="cover-choice-img"><img src="${esc(c.thumb || c.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"
              data-onerror="drop-choice"></span>
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
        <div class="btn-row cam-tools" hidden></div>
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
      onReady: cameraTools($('.cam-tools', backdrop)),
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

// Codes-barres d'un livre : EAN-13 d'origine, ou Code 128 des etiquettes de magasin.
const ISBN_FORMATS = ['ean_13', 'code_128'];

// Cle de controle EAN-13 valide ?
const ean13Ok = (d) => d.split('').reduce((acc, c, i) => acc + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0;

// ISBN-13 (978/979 + cle de controle EAN valide) ou ISBN-10 saisi a la main. Les
// etiquettes de magasin (Code 128) donnent souvent l'ISBN precede d'un 0 (14 chiffres,
// « 09782265159075 ») ou accompagne d'autres chiffres : l'ISBN valide y est cherche.
function isbnFromScan(raw) {
  const digits = raw.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(digits)) return ean13Ok(digits) ? digits : null;
  if (/^\d{9}[\dX]$/.test(digits)) return digits;
  if (/^\d{14,24}$/.test(digits)) {
    for (let i = 0; i + 13 <= digits.length; i++) {
      const c = digits.slice(i, i + 13);
      if (/^97[89]/.test(c) && ean13Ok(c)) return c;
    }
  }
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
    formats: ISBN_FORMATS,
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
    formats: ['qr_code', ...ISBN_FORMATS],
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
        <div class="btn-row"><button class="btn btn-primary" type="button" data-v="add"><span class="hide-mobile">Ajouter à la bibliothèque</span><span class="show-mobile">Ajouter</span></button>
          <button class="btn" type="button" data-v="wish">${icon('wish', 16)}<span class="hide-mobile">Ajouter à mes souhaits</span><span class="show-mobile">Souhait</span></button>
          <button class="btn" type="button" data-close>Annuler</button></div>`);
      if (v === 'add') { pending.addIsbn = r.isbn; go('#/add'); }
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
      <button class="btn btn-ok" type="button" data-v="return"><span class="hide-mobile">Enregistrer le retour</span><span class="show-mobile">Retour</span></button>
      <button class="btn btn-primary" type="button" data-v="next" title="Retour + scanner le suivant">${icon('scan', 16)}Retour + <span class="hide-mobile">scanner le </span>suivant</button>
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
      <button class="btn" type="button" data-v="ok"><span class="hide-mobile">Mettre de côté</span><span class="show-mobile">Garder</span></button>
      <button class="btn" type="button" data-v="done"><span class="hide-mobile">Retirer la réservation</span><span class="show-mobile">Libérer</span></button>
    </div>`);
  if (v === 'done') await api(`/api/reservations/${first.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
  if (v !== 'lend') return false;
  // Le pret a l'emprunteur retire sa reservation (serveur).
  pending.loanFor = { id: first.borrower.id, name: first.borrower.name };
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

export {
  ISBN_FORMATS, beep, cameraTools, decodePhoto, startCamera, openCoverSearch, isbnFromScan, copyCodeFromScan, scanCopy, scanIsbn, scanConf, SCAN_TITLES, scanAndOpen,
  returnLoan, refreshLoanBadge,
};
