// Souhaits — module de l'interface (organisation : public/app/README.md).
import './accueil.js';
import { ROOT, LIBRARY, state, pending } from './etat.js';
import { $, $$, view, esc, hint, gapi, toast, go, imageToDataUrl } from './utilitaires.js';
import { openCoverSearch, scanIsbn } from './scanner.js';
import { icon, iconText } from './icones.js';
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
      <div class="btn-row"><button class="btn btn-primary" type="button" id="wish-add" title="Ajouter un souhait" aria-label="Ajouter un souhait">${icon('add', 16)}Ajouter<span class="hide-mobile"> un souhait</span></button></div></div>
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

  const wishes = await gapi(`/api/wishes?${q}`);
  const multi = selected.length > 1 || selected[0] !== me;
  $('#wish-list').innerHTML = wishes.length ? `<ul class="list wish-list">${wishes.map((w) => wishItemHtml(w, { me, manager, multi })).join('')}</ul>`
    : wishState.priority ? '<div class="empty">Aucun souhait « Très envie ».</div>'
      : `<div class="empty">Aucun souhait pour le moment.${selected.includes(me) ? '<br><br>Ajoute un livre par son ISBN, en le scannant ou par son titre.' : ''}</div>`;
  const byId = new Map(wishes.map((w) => [w.id, w]));
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

// Vignette d'un souhait (image en ligne ou enregistree ; retiree si elle ne charge pas).
const wishThumb = (w) => (w.coverUrl
  ? `<img class="thumb" src="${esc(wishSrc(w.coverUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-onerror="placeholder">`
  : '<span class="thumb" aria-hidden="true"></span>');

function wishItemHtml(w, { me, manager, multi }) {
  const own = w.owner.id === me;
  const meta = [w.authors, [w.publisher, w.year].filter(Boolean).join(', '), w.isbn ? `ISBN ${w.isbn}` : ''].filter(Boolean).map(esc).join(' · ');
  const acts = [];
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

export { wishState, wishSrc, viewWishes, wishDialog, wishShareSection };
