// Liseuses Kobo (USB) — module de l'interface (organisation : public/app/README.md).
import './fiche-livre.js';
import { state, LIBRARY, LIB, isMember, canManage, features } from './etat.js';
import { $, $$, view, esc, hint, fmtDate, api, toast, go, debounce } from './utilitaires.js';
import { iconText, renderNav } from './icones.js';
import { route } from './routage.js';
import { searchPicker, loadMembers } from './catalogue.js';
import { uploadEpub } from './fiche-livre.js';

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
const koboOn = () => isMember() && features().kobo && !!kobo && !!kobo.device;
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
  if (!KOBO_FS || !LIBRARY || !isMember() || !features().kobo || kobo) return;
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
        for await (const _ of d.keys()) return;
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
      <button class="btn btn-primary" id="kobo-scan"><span class="hide-mobile">Scanner une Kobo</span><span class="show-mobile">Scanner</span></button></div>
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
      <div class="field" ${canManage() ? '' : 'hidden'}><label>Propriétaire ${hint('Ses statuts de lecture suivent la liseuse, et il est ajouté comme lecteur des livres présents dessus.')}</label><select name="userId">
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
  // Modifier la liseuse et ses livres : son proprietaire, ou un compte qui gere la
  // bibliotheque (les autres la consultent ; le serveur applique la meme regle).
  const mine = canManage() || (!!d.owner && !!state.user && d.owner.id === state.user.id);
  const canRemove = mine && connected() && !!kobo.remove;
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
        <button class="btn btn-primary" id="kobo-rescan">${connected() ? 'Rescanner' : '<span class="hide-mobile">Brancher et scanner</span><span class="show-mobile">Brancher</span>'}</button>
        ${toCopy.length && canManage() ? `<button class="btn" id="kobo-copy-all"><span class="hide-mobile">Copier les ${toCopy.length} fichier(s) manquant(s)</span><span class="show-mobile">Copier (${toCopy.length})</span></button>` : ''}
        ${mine ? '<button class="btn" id="kobo-edit">Modifier</button>' : ''}
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
      ${filtered ? '<button class="btn" type="button" id="kclear"><span class="hide-mobile">Effacer les filtres</span><span class="show-mobile">Effacer</span></button>' : ''}
    </div>
    <div class="seg seg-3" style="max-width:560px">
      ${seg('all', 'Tous', d.items.length)}${seg('nobook', 'Sans fiche', d.items.filter((i) => !i.book).length)}${seg('nofile', 'Sans fichier', d.items.filter((i) => i.book && !i.book.hasFile).length)}
    </div>
    ${items.length ? `<div class="card table-wrap"><table class="stack"><thead><tr><th>Livre sur la liseuse</th><th>Lecture</th><th>Fiche</th><th>Fichier dans la biblio</th></tr></thead><tbody>
      ${items.map((i) => `<tr>
        <td><strong>${esc(i.title)}</strong><div class="small muted">${esc(i.authors || '')}${i.series ? ` · ${esc(i.series)}${i.seriesNumber ? ` #${esc(i.seriesNumber)}` : ''}` : ''}</div>
          ${canRemove && i.path ? `<button class="btn btn-small btn-danger" data-remove="${i.id}" title="Supprimer le fichier de la liseuse" aria-label="Supprimer de la liseuse">${iconText('trash', 'Supprimer de la liseuse')}</button>` : ''}</td>
        <td>${reading(i)}</td>
        <td>${i.book
          ? `<a href="#/book/${i.book.id}">${esc(i.book.title)}</a>${mine ? ` <button class="btn btn-small" data-unlink="${i.id}" title="Détacher de cette fiche">✕</button>` : ''}`
          : `<span class="btn-row">${canManage() ? `<button class="btn btn-small btn-primary" data-create="${i.id}">Créer la fiche</button>` : ''}${mine ? `<button class="btn btn-small" data-link="${i.id}">Rattacher…</button>` : '<span class="muted">—</span>'}</span>`}</td>
        <td>${!i.book ? '<span class="muted">—</span>' : i.book.hasFile ? '<span class="badge badge-ok">Oui</span>'
          : !canManage() ? '<span class="badge badge-muted">Non</span>'
          : `<button class="btn btn-small" data-copy="${i.id}" ${i.path && !i.pending ? '' : 'disabled title="Fichier inaccessible (carte SD ou pas encore importé)"'}><span class="hide-mobile">Copier depuis la Kobo</span><span class="show-mobile">Copier</span></button>`}</td>
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
  if (mine) $('#kobo-edit').onclick = () => editKoboDialog(d, members);
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
      if (canManage()) await copyFile(i, out);
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

export {
  TOUCH_ONLY, kobo, koboOn, koboReturn, koboSavedInfo, koboRestore, reconnectKobo, progressBox, sendRawProgress, scanKobo, busy,
  pushToKobo, pushManyToKobo, viewKobo, viewKoboDevice,
};
