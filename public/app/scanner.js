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

export {
  decodePhoto, startCamera, openCoverSearch, isbnFromScan, copyCodeFromScan, scanCopy, scanIsbn, scanConf, SCAN_TITLES, scanAndOpen,
  returnLoan, refreshLoanBadge,
};
