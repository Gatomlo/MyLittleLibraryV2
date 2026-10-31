// Souhaits — module de l'interface (organisation : public/app/README.md).
import './accueil.js';
import { ROOT, LIBRARY, state, pending } from './etat.js';
import { $, $$, view, esc, hint, gapi, toast, go, imageToDataUrl } from './utilitaires.js';
import { openCoverSearch, scanIsbn, startCamera, isbnFromScan, beep, cameraTools, decodePhoto, ISBN_FORMATS } from './scanner.js';
import { icon, iconText, searchLinkHtml } from './icones.js';
import { combo, memberPicker } from './catalogue.js';
import { initials } from './statistiques.js';

// Liste de souhaits de chaque compte dans la bibliotheque ouverte (API globale /api/wishes?library=).
// Sa liste et celles partagees avec soi : pastilles (plusieurs listes a la fois).
// Bibliothecaire ou gestionnaire de la bibliotheque ouverte : listes de ses membres,
// choisies dans une liste deroulante avec recherche (un compte, ou toutes).
const wishState = { owners: null, priority: false };
// Image d'un souhait : adresse en ligne, ou chemin d'une image enregistree (relatif a la racine).
const wishSrc = (url) => (/^(https?:|data:)/i.test(url) ? url : `${ROOT}/${url}`);
const libParam = () => `library=${LIBRARY.id}`;

async function viewWishes() {
  if (!LIBRARY) {
    view().innerHTML = `<h1>Mes souhaits</h1><div class="empty">Chaque bibliothèque a sa liste de souhaits : ouvre une bibliothèque pour voir la tienne.<br><br><a class="btn" href="#/">Mes bibliothèques</a></div>`;
    return;
  }
  if (navigator.onLine && myQueue().length) await flushWishQueue();
  const { owners, manager } = await gapi(`/api/wishes/owners?${libParam()}`);
  const me = state.user.id;
  const ids = new Set(owners.map((o) => o.id));
  let selected = (wishState.owners === 'all' ? owners.map((o) => o.id) : wishState.owners || [me]).filter((id) => ids.has(id));
  if (!selected.length) selected = [me];
  wishState.owners = selected;
  const VIA = { share: 'partagée', library: 'membre' };
  const all = selected.length === owners.length;
  const allBtn = `<button type="button" class="btn btn-small" id="wish-all">${all ? 'Seulement moi' : 'Toutes'}</button>`;
  // Export : dans la barre d'outils, et en fin de page sur smartphone.
  const exportHtml = (cls) => `<div class="btn-row wish-export ${cls}"><span class="small muted hide-mobile">Exporter${selected.length > 1 ? ` les ${selected.length} listes` : ''} :</span>
    <a class="btn btn-small" data-wish-export="xlsx" download title="Exporter en Excel" aria-label="Exporter en Excel">${icon('install', 16)}Excel</a>
    <a class="btn btn-small" data-wish-export="csv" download title="Exporter en CSV" aria-label="Exporter en CSV">${icon('install', 16)}CSV</a></div>`;
  view().innerHTML = `
    <div class="page-head"><div><h1>Souhaits ${hint("Livres que tu aimerais lire ou voir acheter. Ta liste t'appartient (elle n'est dans aucune bibliothèque) ; tu peux la partager avec d'autres comptes. Les bibliothécaires et gestionnaires voient celles des membres de leur bibliothèque.")}</h1></div>
      <div class="btn-row"><button class="btn" type="button" id="wish-shop" title="Mode librairie : scanner les livres en série" aria-label="Mode librairie : scanner les livres en série">${icon('scan', 16)}<span class="hide-mobile">Mode </span>librairie</button>
        <button class="btn btn-primary" type="button" id="wish-add" title="Ajouter un souhait" aria-label="Ajouter un souhait">${icon('add', 16)}Ajouter<span class="hide-mobile"> un souhait</span></button></div></div>
    ${owners.length > 1 && manager ? `<div class="wish-owners wish-owner-pick">
      <label for="wish-owner" class="sr-only">Liste affichée</label>
      <input type="search" id="wish-owner" autocomplete="off" placeholder="${all ? `Toutes les listes (${owners.length})` : selected.length > 1 ? `${selected.length} listes` : 'Choisir un compte…'}">
      ${allBtn}
    </div>` : owners.length > 1 ? `<div class="wish-owners" role="group" aria-label="Listes affichées">
      ${owners.map((o) => `<button type="button" class="chip-toggle" data-owner="${o.id}" aria-pressed="${selected.includes(o.id)}">
        <span class="tab-avatar" aria-hidden="true">${initials(o.username)}</span>${o.id === me ? 'Mes souhaits' : esc(o.username)}
        <span class="count">${o.count}</span>${VIA[o.via] ? `<span class="sr-only"> (liste ${VIA[o.via]})</span>` : ''}</button>`).join('')}
      ${allBtn}
    </div>` : ''}
    <div class="wish-toolbar">
      <button type="button" class="chip-toggle wish-filter" id="wish-prio" aria-pressed="${wishState.priority}">${icon('wish', 16)}Très envie<span class="hide-mobile"> seulement</span></button>
      ${exportHtml('hide-mobile')}
    </div>
    ${myQueue().length ? `<p class="small muted" role="status">${icon('wish', 16)} ${myQueue().length} livre(s) en attente de réseau : ajout automatique au retour de la connexion.</p>` : ''}
    <div class="card" id="wish-list" aria-live="polite"><p class="muted">Chargement…</p></div>
    ${exportHtml('only-mobile')}
    <p class="wish-share"><a href="#/account">${icon('share', 16)}Partager ma liste</a> <span class="small muted">(Mon compte › Mes partages)</span></p>`;
  const setSelected = (list) => { wishState.owners = list; viewWishes(); };
  $$('[data-owner]').forEach((btn) => {
    btn.onclick = () => {
      const id = Number(btn.dataset.owner);
      const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
      setSelected(next.length ? next : [id]);
    };
  });
  if ($('#wish-all')) $('#wish-all').onclick = () => setSelected(all ? [me] : owners.map((o) => o.id));
  // Gestion : compte a consulter, choisi dans une liste deroulante avec recherche.
  if ($('#wish-owner')) {
    const input = $('#wish-owner');
    const ownerName = (o) => (o.id === me ? 'Mes souhaits' : o.username);
    const cur = selected.length === 1 ? owners.find((o) => o.id === selected[0]) : null;
    input.value = cur ? ownerName(cur) : '';
    combo(input, owners.map((o) => ({ id: o.id, label: ownerName(o), hint: String(o.count) })), (it) => setSelected([it.id]), { emptyText: 'Aucun compte' });
    input.addEventListener('focus', () => input.select());
  }
  $('#wish-prio').onclick = () => { wishState.priority = !wishState.priority; viewWishes(); };
  const q = `owners=${selected.join(',')}${wishState.priority ? '&priority=1' : ''}&${libParam()}`;
  $$('[data-wish-export]').forEach((a) => { a.href = `${ROOT}/api/wishes/export.${a.dataset.wishExport}?${q}`; });
  $('#wish-add').onclick = async () => { if (await wishDialog()) viewWishes(); };
  $('#wish-shop').onclick = async () => { if (await wishScanDialog()) viewWishes(); };

  const wishes = await gapi(`/api/wishes?${q}`);
  const multi = selected.length > 1 || selected[0] !== me;
  $('#wish-list').innerHTML = wishes.length ? `<ul class="list wish-list">${wishes.map((w) => wishItemHtml(w, { me, manager, multi })).join('')}</ul>`
    : wishState.priority ? '<div class="empty">Aucun souhait « Très envie ».</div>'
      : `<div class="empty">Aucun souhait pour le moment.${selected.includes(me) ? '<br><br>Ajoute un livre par son ISBN, en le scannant ou par son titre.' : ''}</div>`;
  const byId = new Map(wishes.map((w) => [w.id, w]));
  // Souhaits enregistres avec le seul ISBN (titre « ISBN 978… », recherche impossible sur le moment) :
  // completes ici des que la recherche aboutit.
  const bare = wishes.filter((w) => w.owner && w.owner.id === me && /^ISBN [0-9X]{10,13}$/.test(w.title) && w.isbn).slice(0, 6);
  if (bare.length && navigator.onLine) {
    (async () => {
      let changed = 0;
      for (const w of bare) {
        try {
          const { found: f } = await gapi(`/api/wishes/lookup/${encodeURIComponent(w.isbn)}`);
          if (!f || !f.title) continue;
          const body = { title: f.title, authors: f.authors || '', publisher: f.publisher || '', year: f.year || '' };
          if (!w.coverUrl && f.coverUrl) body.coverUrl = f.coverUrl;
          await gapi(`/api/wishes/${w.id}`, { method: 'PUT', body });
          changed++;
        } catch (err) { if (isOffline(err)) break; }
      }
      if (changed && document.body.contains($('#wish-list'))) { toast(`${changed} souhait(s) complété(s).`); viewWishes(); }
    })();
  }
  // Souhaits sans couverture : le serveur la cherche en arriere-plan ; les images
  // trouvees sont posees quelques secondes plus tard, sans recharger la liste.
  if (wishes.some((w) => !w.coverUrl)) {
    setTimeout(async () => {
      const list = $('#wish-list');
      if (!list || !document.body.contains(list)) return;
      const fresh = await gapi(`/api/wishes?${q}`).catch(() => []);
      fresh.filter((w) => w.coverUrl && byId.has(w.id) && !byId.get(w.id).coverUrl).forEach((w) => {
        byId.get(w.id).coverUrl = w.coverUrl;
        const ph = $(`[data-wish-item="${w.id}"] span.thumb`, list);
        if (ph) ph.outerHTML = wishThumb(w);
      });
    }, 7000);
  }
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
        if (act === 'add') { pending.wish = w; go('#/add'); return; }
        viewWishes();
      } catch (err) { toast(err.message, 'error'); }
    };
  });
}

// File d'attente hors connexion : les livres ajoutes sans reseau (ISBN ou titre) sont gardes
// sur l'appareil et enregistres au retour de la connexion.
const QUEUE_KEY = 'mll-wish-queue';
const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; } };
const writeQueue = (list) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list)); } catch (e) { /* stockage indisponible */ } };
const isOffline = (err) => /^Hors connexion/.test((err && err.message) || '');
const myQueue = () => readQueue().filter((e) => state.user && e.user === state.user.id);
function queueWish(entry) {
  const list = readQueue();
  if (entry.isbn && list.some((e) => e.isbn === entry.isbn && e.library === entry.library && e.user === entry.user)) return false;
  list.push(entry);
  writeQueue(list);
  return true;
}
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('Hors connexion : réseau trop lent.')), ms))]);
let flushing = null;
let onFlushed = null; // fenetre du mode librairie ouverte : mise a jour de sa liste
// Envoie les souhaits en attente du compte ; renvoie [{ key, id, found }]. S'arrete au premier echec reseau.
function flushWishQueue() {
  if (flushing) return flushing;
  flushing = (async () => {
    const done = [];
    let failed = 0;
    for (const e of myQueue()) {
      try {
        const looked = e.isbn ? (await withTimeout(gapi(`/api/wishes/lookup/${e.isbn}`), 20000).catch((err) => { if (isOffline(err)) throw err; return { found: null }; })).found : null;
        const found = looked && looked.title ? looked : null;
        const f = found || e;
        const r = await gapi('/api/wishes', { method: 'POST', body: { title: f.title || `ISBN ${e.isbn}`, authors: f.authors, publisher: f.publisher, year: f.year,
          isbn: e.isbn || f.isbn || '', coverUrl: f.coverUrl || '', library: e.library } });
        writeQueue(readQueue().filter((x) => x.key !== e.key));
        done.push({ key: e.key, id: r.id, found: f.title ? f : null });
      } catch (err) {
        if (isOffline(err)) break;
        writeQueue(readQueue().filter((x) => x.key !== e.key));
        failed++;
      }
    }
    if (done.length) toast(`${done.length} souhait(s) en attente ajouté(s).`);
    if (failed) toast(`${failed} souhait(s) en attente n'ont pas pu être ajoutés.`, 'error');
    if (done.length && onFlushed) onFlushed(done);
    return done;
  })().finally(() => { flushing = null; });
  return flushing;
}
window.addEventListener('online', () => { if (myQueue().length) flushWishQueue(); });

// Vignette d'un souhait (image en ligne ou enregistree ; retiree si elle ne charge pas).
const wishThumb = (w) => (w.coverUrl
  ? `<img class="thumb" src="${esc(wishSrc(w.coverUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-onerror="placeholder">`
  : '<span class="thumb" aria-hidden="true"></span>');

function wishItemHtml(w, { me, manager, multi }) {
  const own = w.owner.id === me;
  const meta = [w.authors, [w.publisher, w.year].filter(Boolean).join(', '), w.isbn ? `ISBN ${w.isbn}` : ''].filter(Boolean).map(esc).join(' · ');
  const acts = [];
  acts.push(searchLinkHtml(w, 'wishes', 'btn btn-small'));
  if (manager && !w.inLibrary) acts.push(`<button class="btn btn-small btn-primary" type="button" data-wish-act="add" data-wish="${w.id}" title="Ajouter à la bibliothèque" aria-label="Ajouter « ${esc(w.title)} » à la bibliothèque">${iconText('add', 'Ajouter à la bibliothèque')}</button>`);
  if (own) {
    acts.push(`<button class="btn btn-small" type="button" data-wish-act="edit" data-wish="${w.id}" title="Modifier" aria-label="Modifier « ${esc(w.title)} »">${iconText('edit', 'Modifier')}</button>`);
    acts.push(`<button class="btn btn-small btn-danger" type="button" data-wish-act="delete" data-wish="${w.id}" title="Supprimer" aria-label="Supprimer « ${esc(w.title)} »">${iconText('trash', 'Supprimer')}</button>`);
  }
  const heart = own
    ? `<button type="button" class="wish-heart" data-wish-heart="${w.id}" aria-pressed="${!!w.priority}" aria-label="Très envie : ${esc(w.title)}"
        title="${w.priority ? 'Très envie (cliquer pour retirer)' : 'Marquer « Très envie »'}">${icon('wish', 20)}</button>`
    : `<span class="wish-heart${w.priority ? ' on' : ''}" aria-hidden="true">${icon('wish', 20)}</span>`;
  return `<li class="list-item wish-item" data-wish-item="${w.id}">
    ${heart}
    ${wishThumb(w)}
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

// Partage de sa liste avec d'autres comptes (section « Mes partages » de Mon compte) :
// liste deroulante a selection multiple, enregistree a chaque changement.
async function wishShareSection(box) {
  const { viewers, candidates } = await gapi('/api/wishes/shares');
  if (!candidates.length) { box.innerHTML = '<p class="small muted">Aucun autre compte dans tes bibliothèques.</p>'; return; }
  box.innerHTML = '<div id="wish-share-pick"></div>';
  memberPicker($('#wish-share-pick', box), candidates, viewers, {
    placeholder: 'Ajouter un compte…',
    none: 'Non partagée',
    onChange: async (ids) => {
      try {
        await gapi('/api/wishes/shares', { method: 'PUT', body: { viewerIds: ids } });
        toast('Partage enregistré.');
      } catch (err) { toast(err.message, 'error'); }
    },
  });
}

// Ajout ou modification d'un souhait. Recherche par ISBN (tape ou scanne) ou par
// titre (liste d'editions). Renvoie true si enregistre.
function wishDialog(w, preset) {
  const editing = !!(w && w.id);
  const v = w || { isbn: '', title: '', subtitle: '', authors: '', publisher: '', year: '', notes: '', priority: 0, coverUrl: '', ...(preset || {}) };
  let cover = v.coverUrl || '';
  let coverData = '';
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="wish-title">
      <h2 id="wish-title">${editing ? 'Modifier le souhait' : 'Ajouter un souhait'}</h2>
      <form id="wish-form">
        <div class="field"><label for="wish-q">ISBN ou titre</label>
          <div class="isbn-row">
            <input id="wish-q" autocomplete="off" placeholder="ISBN, ou titre et auteur" value="${esc(v.isbn)}">
            <button class="btn" type="button" id="wish-search" title="Rechercher" aria-label="Rechercher">${iconText('search', 'Rechercher')}</button>
            <button class="btn" type="button" id="wish-scan" title="Scanner le code-barres" aria-label="Scanner le code-barres">${iconText('scan', 'Scanner')}</button>
          </div>
          <div id="wish-found" class="small" role="status" aria-live="polite" style="margin-top:8px"></div>
        </div>
        <div class="wish-form-grid">
          <div class="wish-cover-col">
            <label class="cover cover-pick" id="wish-cover" for="wish-file" title="Choisir ou photographier une image"></label>
            <input type="file" id="wish-file" accept="image/*" hidden>
            <div class="btn-row">
              <button class="btn btn-small" type="button" id="wish-cover-online" title="Chercher une couverture en ligne" aria-label="Chercher une couverture en ligne">${icon('search', 16)}</button>
              <button class="btn btn-small btn-danger" type="button" id="wish-cover-remove" title="Retirer l'image" aria-label="Retirer l'image">${icon('trash', 16)}</button>
            </div>
          </div>
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
    const renderCover = () => {
      const box = $('#wish-cover', backdrop);
      const src = coverData || (cover ? wishSrc(cover) : '');
      box.innerHTML = (src ? `<img src="${esc(src)}" alt="Image actuelle" referrerpolicy="no-referrer">` : '<span class="cover-fallback">Ajouter une image</span>')
        + `<span class="cover-pick-badge" aria-hidden="true">${icon('image', 16)}</span>`;
      const img = $('img', box);
      if (img && !coverData) img.onerror = () => { cover = ''; renderCover(); };
      $('#wish-cover-remove', backdrop).hidden = !src;
    };
    renderCover();
    // Image choisie ou photographiee (envoyee a l'enregistrement), ou cherchee en ligne.
    let picked = false; // choix fait a la main : plus de recherche automatique
    $('#wish-file', backdrop).onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { coverData = await imageToDataUrl(file, 900, 'image/jpeg'); cover = ''; picked = true; renderCover(); } catch (err) { toast(err.message, 'error'); }
    };
    $('#wish-cover-online', backdrop).onclick = async () => {
      const url = await openCoverSearch({ isbn: f.isbn.value, title: f.title.value, author: f.authors.value },
        (q) => gapi('/api/wishes/covers?' + new URLSearchParams(q)));
      if (url) { cover = url; coverData = ''; picked = true; renderCover(); }
    };
    $('#wish-cover-remove', backdrop).onclick = () => { cover = ''; coverData = ''; picked = true; renderCover(); };
    // Couverture cherchee en ligne (ISBN, sinon titre + auteur) quand il n'y en a pas.
    let coverSeq = 0;
    const findCover = async () => {
      const isbn = f.isbn.value.trim();
      const title = f.title.value.trim();
      if (picked || cover || coverData || (!isbn && !title)) return;
      const seq = ++coverSeq;
      const r = await gapi(`/api/wishes/cover?${new URLSearchParams({ isbn, title, authors: f.authors.value })}`).catch(() => null);
      if (r && r.coverUrl && seq === coverSeq && !cover && !coverData && !picked && document.body.contains(backdrop)) { cover = r.coverUrl; renderCover(); }
    };
    const fill = (d) => {
      ['title', 'subtitle', 'authors', 'publisher', 'year', 'isbn'].forEach((k) => { if (d[k] && f[k]) f[k].value = d[k]; });
      // Une image choisie a la main est gardee.
      if (!picked) { cover = d.coverUrl || ''; renderCover(); findCover(); }
    };
    if (editing) findCover();
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
          if (r.found && r.found.title) { fill({ ...r.found, isbn: r.isbn }); found.textContent = `Trouvé : ${r.found.title}`; } else found.textContent = r.found ? 'ISBN trouvé sans titre : réessaie plus tard ou complète la fiche à la main.' : 'ISBN inconnu : complète la fiche à la main.';
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
        notes: f.notes.value, priority: f.priority.checked, coverUrl: cover, coverData: coverData || undefined, library: LIBRARY && LIBRARY.id };
      try {
        await gapi(editing ? `/api/wishes/${w.id}` : '/api/wishes', { method: editing ? 'PUT' : 'POST', body });
        toast(editing ? 'Souhait enregistré.' : 'Ajouté à tes souhaits.');
        close(true);
      } catch (err) { $('#wish-err', backdrop).innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
    };
    (editing ? f.title : $('#wish-q', backdrop)).focus();
  });
}

// Mode librairie : la camera reste ouverte, chaque code-barres lu est cherche puis
// enregistre tout de suite dans les souhaits (retrait possible dans la liste).
function wishScanDialog() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="shop-title">
      <h2 id="shop-title">Mode librairie ${hint('Scanne les codes-barres en continu, ou cherche un livre par son titre, son auteur ou son ISBN : touche l\'édition pour l\'ajouter. Chaque livre est ajouté tout de suite à tes souhaits.')}</h2>
      <form class="field isbn-row" id="shop-manual">
        <input name="q" placeholder="Titre, auteur ou ISBN" autocomplete="off" enterkeyhint="search">
        <button class="btn btn-primary" type="submit" title="Rechercher" aria-label="Rechercher">${iconText('search', 'Chercher')}</button>
        <button class="btn" type="button" id="shop-cam" title="Scanner un code-barres" aria-label="Scanner un code-barres">${icon('scan', 16)}</button>
        <label class="btn" style="margin:0" title="Photographier le code-barres" aria-label="Photographier le code-barres">${icon('image', 16)}<input type="file" id="shop-photo" accept="image/*" capture="environment" hidden></label>
      </form>
      <div class="scanner-video barcode" id="shop-video-box" hidden><video playsinline muted></video><div class="frame"></div></div>
      <div class="btn-row cam-tools" id="shop-tools" hidden></div>
      <p class="small muted" id="shop-status" role="status" aria-live="polite">Présente les codes-barres, ou tape un titre.</p>
      <div id="shop-results"></div>
      <div id="shop-list"></div>
      <div class="btn-row"><button class="btn btn-primary" type="button" data-close>Terminer</button></div>
    </div>`;
    document.body.appendChild(backdrop);
    const status = (msg) => { $('#shop-status', backdrop).textContent = msg; };
    const items = [];
    const lastSeen = new Map();
    let queue = Promise.resolve();
    let camera = null;
    const close = () => { if (camera) camera.stop(); onFlushed = null; backdrop.remove(); resolve(items.some((it) => it.state !== 'removed' && (it.id || it.state === 'queued'))); };
    const render = () => {
      const shown = items.filter((it) => it.state !== 'removed');
      $('#shop-list', backdrop).innerHTML = shown.length ? `<div class="list">${shown.map((it) => {
        const f = it.found;
        const img = f && f.coverUrl ? `<img class="thumb" src="${esc(f.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-onerror="hide">` : '<span class="thumb"></span>';
        const main = it.state === 'loading' ? '<span class="muted">Recherche…</span>'
          : it.state === 'queued' ? `<strong>${esc((f && f.title) || it.isbn || 'Livre')}</strong><div class="small muted">Hors connexion : sera ajouté au retour du réseau</div>`
          : it.state === 'error' ? `<span class="error-text">${esc(it.error)}</span>`
            : f ? `<strong>${esc(f.title)}</strong><div class="small muted">${esc(f.authors || '')}</div>`
              : '<strong>ISBN inconnu</strong><div class="small muted">ajouté tel quel : à compléter plus tard</div>';
        return `<div class="list-item batch-item">${img}<div class="grow">${main}<div class="small code muted">${esc(it.isbn)}</div></div>
          ${it.state === 'loading' ? '' : `<button type="button" class="rm" data-rm="${esc(it.key)}" aria-label="Retirer">×</button>`}</div>`;
      }).join('')}</div>` : '';
      $$('[data-rm]', backdrop).forEach((b) => {
        b.onclick = async () => {
          const it = items.find((x) => x.key === b.dataset.rm);
          if (!it) return;
          try { if (it.id) await gapi(`/api/wishes/${it.id}`, { method: 'DELETE' }); else if (it.state === 'queued') writeQueue(readQueue().filter((x) => x.key !== it.key)); it.state = 'removed'; status('Retiré.'); } catch (err) { toast(err.message, 'error'); }
          render();
        };
      });
    };
    // Enregistre un souhait : par ISBN (recherche des infos) ou depuis une edition choisie.
    const save = (src, lookup) => {
      const it = { isbn: src.isbn || '', key: src.key, state: 'loading', found: lookup ? null : src };
      items.unshift(it);
      render();
      queue = queue.then(async () => {
        try {
          const looked = lookup ? (await withTimeout(gapi(`/api/wishes/lookup/${src.isbn}`), 15000)).found : src;
          const found = looked && looked.title ? looked : null;
          const r = await gapi('/api/wishes', { method: 'POST', body: {
            title: (found && found.title) || `ISBN ${src.isbn}`, authors: found && found.authors, publisher: found && found.publisher,
            year: found && found.year, isbn: src.isbn || (found && found.isbn) || '', coverUrl: (found && found.coverUrl) || '', library: LIBRARY && LIBRARY.id } });
          it.found = found; it.id = r.id; it.state = 'ok';
          beep(true);
          status(found ? `Ajouté : ${found.title}` : `${src.isbn} ajouté (inconnu).`);
        } catch (err) {
          if (isOffline(err)) {
            // Pas de reseau : gardé sur l'appareil, ajouté au retour de la connexion.
            queueWish({ key: src.key, user: state.user.id, library: LIBRARY && LIBRARY.id, isbn: src.isbn || '',
              title: src.title || '', authors: src.authors || '', publisher: src.publisher || '', year: src.year || '', coverUrl: src.coverUrl || '' });
            it.state = 'queued'; beep(true); status('Hors connexion : enregistré sur ton appareil, il sera ajouté au retour du réseau.');
          } else { it.state = 'error'; it.error = err.message; beep(false); }
        }
        render();
      });
    };
    const add = (isbn, fromCamera) => {
      const now = Date.now();
      const seen = lastSeen.get(isbn) || 0;
      lastSeen.set(isbn, now);
      // La camera voit encore le livre qui vient d'etre lu.
      if (fromCamera && now - seen < 4000) return;
      if (items.some((it) => it.isbn === isbn && it.state !== 'removed')) { beep(false); status(`${isbn} : déjà ajouté.`); return; }
      beep(true);
      if (navigator.vibrate) navigator.vibrate(60);
      save({ isbn, key: `${now}-${items.length}` }, true);
      status(`✓ ${isbn} scanné.`);
    };
    // Recherche par titre / auteur : touche une edition pour l'ajouter ; ISBN : ajout direct.
    const results = $('#shop-results', backdrop);
    $('#shop-manual', backdrop).onsubmit = async (e) => {
      e.preventDefault();
      const input = e.target.q;
      const t = input.value.trim();
      if (!t) return;
      const isbn = isbnFromScan(t);
      if (isbn) { add(isbn, false); input.value = ''; results.innerHTML = ''; return; }
      status('Recherche…');
      results.innerHTML = '';
      try {
        const { editions } = await gapi(`/api/wishes/search?q=${encodeURIComponent(t)}`);
        status(editions.length ? 'Touche l\'édition à ajouter.' : 'Aucune édition trouvée : ajoute-le tel quel.');
        results.innerHTML = `<div class="pick-list" role="list">${editions.map((ed, i) => `<button type="button" class="pick-row" data-ed="${i}">
          <span class="pick-line">${ed.coverUrl ? `<img class="thumb" src="${esc(ed.coverUrl)}" alt="" referrerpolicy="no-referrer">` : '<span class="thumb"></span>'}
          <span class="grow"><strong>${esc(ed.title || '')}</strong><span class="small muted">${esc([ed.authors, ed.publisher, ed.year].filter(Boolean).join(' · '))}</span></span></span></button>`).join('')}
          <button type="button" class="pick-row" data-ed="raw"><span class="pick-line"><span class="thumb"></span><span class="grow"><strong>Ajouter « ${esc(t)} » tel quel</strong></span></span></button></div>`;
        $$('[data-ed]', results).forEach((btn) => {
          btn.onclick = () => {
            const ed = btn.dataset.ed === 'raw' ? { title: t } : editions[Number(btn.dataset.ed)];
            save({ ...ed, key: `s${Date.now()}-${items.length}` });
            input.value = ''; results.innerHTML = ''; input.focus();
          };
        });
      } catch (err) {
        if (!isOffline(err)) { status(err.message); return; }
        status("Hors connexion : pas de recherche, mais tu peux l'ajouter tel quel.");
        results.innerHTML = `<div class="pick-list"><button type="button" class="pick-row" data-ed="raw"><span class="pick-line"><span class="thumb"></span><span class="grow"><strong>Ajouter « ${esc(t)} » tel quel</strong></span></span></button></div>`;
        $('[data-ed]', results).onclick = () => { save({ title: t, key: `s${Date.now()}-${items.length}` }); input.value = ''; results.innerHTML = ''; input.focus(); };
      }
    };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(); });
    // Scan en continu : la camera demarre a l'ouverture (bouton pour la couper et laisser le clavier).
    const toggleCam = () => {
      const box = $('#shop-video-box', backdrop);
      if (camera) { camera.stop(); camera = null; box.hidden = true; $('#shop-tools', backdrop).hidden = true; return; }
      box.hidden = false;
      camera = startCamera({
        video: $('video', backdrop), formats: ISBN_FORMATS, accept: isbnFromScan, hint: 'Présente les codes-barres un par un.',
        onReady: cameraTools($('#shop-tools', backdrop)), onStatus: status, onValue: (isbn) => { add(isbn, true); return false; },
      });
    };
    $('#shop-cam', backdrop).onclick = toggleCam;
    $('#shop-photo', backdrop).onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      status('Analyse de la photo…');
      try {
        const values = await decodePhoto(file, ISBN_FORMATS, isbnFromScan);
        if (values.length) values.forEach((v) => add(v, false));
        else { beep(false); status('Code-barres illisible : rapproche-toi, évite les reflets, ou tape le titre.'); }
      } catch (err) { status('Analyse impossible : ' + err.message); }
    };
    onFlushed = (done) => {
      done.forEach((d) => { const it = items.find((x) => x.key === d.key); if (it) { it.id = d.id; it.found = d.found; it.state = 'ok'; } });
      render();
      status('Réseau retrouvé : livres en attente ajoutés.');
    };
    if (navigator.onLine) flushWishQueue();
    toggleCam();
  });
}

export { wishState, wishSrc, viewWishes, wishDialog, wishScanDialog, wishShareSection };
