// Ajout / modification d'un livre — module de l'interface (organisation : public/app/README.md).
import './administration.js';
import { LIBRARY, state, pending, features } from './etat.js';
import { $, $$, view, esc, hint, mediaSrc, api, gapi, toast, go, debounce, imageToDataUrl, sessionStorageTake } from './utilitaires.js';
import { openCoverSearch, scanIsbn } from './scanner.js';
import { icon, iconText } from './icones.js';
import { loadCategories, combo, loadMembers, memberPicker } from './catalogue.js';
import { isbnFromCell, chipField } from './import.js';
import { markImportChecked } from './import-suivi.js';
import { wishSrc } from './souhaits.js';
import { sendRaw, uploadEpub } from './fiche-livre.js';

async function viewBookForm(id) {
  const editing = !!id;
  const [book, cats, locations, allAuthors, publishers, collections, allSeries, allTags, members] = await Promise.all([
    editing ? api(`/api/books/${id}`) : null,
    loadCategories(),
    api('/api/locations'),
    api('/api/values/authors').catch(() => []),
    api('/api/values/publishers').catch(() => []),
    api('/api/public/collections').catch(() => []),
    api('/api/public/series').catch(() => []),
    features().tags ? api('/api/tags').catch(() => []) : [],
    loadMembers().catch(() => []),
  ]);
  const b = book || { isbn: '', title: '', subtitle: '', authors: '', publisher: '', collection: '', series: '', seriesNumber: '', year: '', pages: '', summary: '', notes: '', categories: [], coverUrl: null, format: 'physical' };
  const form = { categories: b.categories.map((c) => c.name), tags: (b.tags || []).map((t) => t.name), cover: { url: b.coverUrl ? mediaSrc(b.coverUrl) : '', remoteUrl: '', data: '', removed: false } };

  // Ouvert depuis une liste (Fiches incompletes, resultats d'un import epub) : retour a
  // cette liste ({ id, hash, label } dans sessionStorage).
  let fromIncomplete = null;
  let backLabel = 'Fiches incomplètes';
  try {
    const r = JSON.parse(sessionStorage.getItem('mll-after-edit') || 'null');
    if (editing && r && r.id === b.id) { fromIncomplete = r.hash; if (r.label) backLabel = r.label; }
  } catch (e) { /* rien */ }
  view().innerHTML = `
    <p><a href="${fromIncomplete || (editing ? `#/book/${b.id}` : '#/')}">← ${fromIncomplete ? esc(backLabel) : editing ? 'Retour à la fiche' : 'Catalogue'}</a></p>
    ${editing ? '<h1>Modifier le livre</h1>' : `<div class="page-head"><div><h1>Ajouter un livre</h1></div>
      <div class="btn-row">${features().ebooks ? `<label class="btn" title="Créer la fiche d'après les informations d'un fichier epub">
          <input type="file" id="epub-one" accept=".epub,application/epub+zip" hidden>Depuis un epub</label>` : ''}
        <a class="btn hide-mobile" href="#/import">Ajout multiple</a></div></div>`}
    <div class="card" style="margin:14px 0">
      <label for="isbn-search">Rechercher par ISBN ou titre ${hint('Scanne ou tape l\'ISBN pour pré-remplir la fiche. Sans ISBN : tape le titre et l\'auteur, ou « Titre + auteur » reprend ceux de la fiche, puis choisis l\'édition.')}</label>
      <div class="isbn-row">
        <input id="isbn-search" placeholder="ISBN, ou titre et auteur" value="${esc(b.isbn)}" autocomplete="off">
        <button class="btn" id="isbn-go" type="button" title="Rechercher" aria-label="Rechercher">${iconText('search', 'Rechercher')}</button>
        <button class="btn" id="isbn-title" type="button" title="Chercher l'édition avec le titre et l'auteur de la fiche" aria-label="Chercher avec le titre et l'auteur de la fiche">${iconText('text', 'Titre + auteur')}</button>
        <button class="btn btn-primary" id="isbn-scan" type="button" title="Scanner le code-barres" aria-label="Scanner le code-barres">${iconText('scan', 'Scanner')}</button>
      </div>
      <div id="isbn-result" class="small" style="margin-top:8px"></div>
    </div>
    <form id="book-form" class="card">
      <div class="cover-edit field">
        <label class="cover cover-pick" id="cover-preview" for="cover-file" title="Choisir ou photographier une image"></label>
        <input type="file" id="cover-file" accept="image/*" hidden>
        <div>
          <label for="cover-file">Couverture ${hint('Clique sur l\'image pour en choisir ou en photographier une. La couverture trouvée par la recherche ISBN est enregistrée automatiquement.')}</label>
          <div class="btn-row">
            <label class="btn btn-small" style="margin:0" for="cover-file" title="Choisir ou photographier une image">${iconText('image', 'Choisir / photographier')}</label>
            <button class="btn btn-small" type="button" id="cover-online" title="Chercher une couverture en ligne" aria-label="Chercher une couverture en ligne">${iconText('search', 'Chercher en ligne')}</button>
            <button class="btn btn-small btn-danger" type="button" id="cover-remove" title="Retirer la couverture" aria-label="Retirer la couverture">${iconText('trash', 'Retirer')}</button>
          </div>
        </div>
      </div>
      <div class="field"><label for="title">Titre *</label><input id="title" name="title" required value="${esc(b.title)}"></div>
      <div class="field"><label for="subtitle">Sous-titre</label><input id="subtitle" name="subtitle" value="${esc(b.subtitle)}"></div>
      <div class="field"><label for="authors">Auteur(s)</label><input id="authors" name="authors" placeholder="Séparés par des virgules" value="${esc(b.authors)}" autocomplete="off"></div>
      <div class="grid-2">
        <div class="field"><label for="publisher">Éditeur</label><input id="publisher" name="publisher" value="${esc(b.publisher)}" autocomplete="off"></div>
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
          <button class="btn" type="button" id="cat-add" title="Ajouter la catégorie" aria-label="Ajouter la catégorie">${iconText('add', 'Ajouter')}</button>
        </div>
        <datalist id="cat-list">${cats.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      </div>
      ${features().tags ? `<div class="field">
        <label for="tag-input">Tags</label>
        <div id="tag-chips"></div>
        <div class="isbn-row">
          <input id="tag-input" list="tag-list" placeholder="Ajouter un tag…" autocomplete="off">
          <button class="btn" type="button" id="tag-add" title="Ajouter le tag" aria-label="Ajouter le tag">${iconText('add', 'Ajouter')}</button>
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
        <span>Version numérique ${hint('Exemplaire numérique (epub, pdf…), sans code, étiquette ni prêt.')}</span></label></div>
      <div class="field" id="ebook-file-field" hidden><label for="ebook-file">Fichier epub ${hint('Facultatif (100 Mo max).')}</label>
        <input type="file" id="ebook-file" accept=".epub,application/epub+zip"></div>` : ''}`}
      ${members.length > 1 || editing ? `<div class="field"><label>Lecteurs ${hint('Comptes qui lisent, liront ou ont lu ce livre.')}</label>
        <div id="readers-pick"></div></div>` : ''}
      <div class="field"><label for="notes">Notes internes ${hint('Visibles uniquement par les gestionnaires.')}</label><textarea id="notes" name="notes" style="min-height:70px">${esc(b.notes)}</textarea></div>
      <div id="form-err"></div>
      <div class="btn-row"><button class="btn btn-primary" type="submit">${icon('check', 16)}${editing ? 'Enregistrer' : 'Ajouter<span class="hide-mobile"> au catalogue</span>'}</button></div>
    </form>`;

  const f = $('#book-form');
  // Lecteurs : pastilles + liste deroulante (nouveau livre : soi par defaut).
  const readersPick = $('#readers-pick') ? memberPicker($('#readers-pick'), members, editing ? (b.readers || []).map((r) => r.id) : [state.user.id]) : null;

  function renderCover() {
    const src = form.cover.data || form.cover.remoteUrl || (form.cover.removed ? '' : form.cover.url);
    $('#cover-preview').innerHTML = (src ? `<img src="${esc(src)}" alt="Couverture actuelle">` : '<span class="cover-fallback">Ajouter une image</span>')
      + `<span class="cover-pick-badge" aria-hidden="true">${icon('image', 16)}</span>`;
    $('#cover-remove').hidden = !src;
  }
  renderCover();
  // Auteurs : plusieurs noms separes par des virgules ; la liste filtre sur le nom en
  // cours de saisie (apres la derniere virgule) et masque ceux deja choisis.
  const authorParts = () => f.authors.value.split(',').map((a) => a.trim());
  const authorsCombo = combo(f.authors, allAuthors.map((c) => ({ label: c.name, hint: String(c.count) })), (it) => {
    const done = authorParts().slice(0, -1).filter(Boolean);
    f.authors.value = [...done, it.label].join(', ') + ', ';
    authorsCombo.open(true);
  }, {
    emptyText: 'Nouvel auteur',
    query: (v) => v.split(',').pop().trim(),
    skip: (it) => authorParts().slice(0, -1).some((a) => a.toLowerCase() === it.label.toLowerCase()),
  });
  // Editeur, collection, serie : liste deroulante filtrante des valeurs existantes (ou nom libre).
  combo(f.publisher, publishers.map((c) => ({ label: c.name, hint: String(c.count) })), (it) => { f.publisher.value = it.label; },
    { emptyText: 'Nouvel éditeur' });
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
            <button type="button" class="btn btn-small" id="use-alt"><span class="hide-mobile">Utiliser le résumé en ${esc(d.summaryAlt.language)}</span><span class="show-mobile">Utiliser</span></button></p>`;
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
  const wish = !editing ? pending.wish : null;
  pending.wish = null;
  if (wish) {
    ['isbn', 'title', 'subtitle', 'authors', 'publisher', 'year'].forEach((k) => { if (wish[k] && f[k]) f[k].value = wish[k]; });
    if (wish.notes && f.notes) f.notes.value = wish.notes;
    const owners = wish.owners || [wish.owner];
    owners.forEach((o) => { if (readersPick && members.some((m) => m.id === o.id)) readersPick.add(o.id); });
    // Couverture du souhait : adresse en ligne, ou image enregistree (relue puis envoyee avec la fiche).
    if (/^https?:/i.test(wish.coverUrl || '')) { form.cover.remoteUrl = wish.coverUrl; form.cover.url = wish.coverUrl; renderCover(); }
    else if (wish.coverUrl) {
      fetch(wishSrc(wish.coverUrl), { credentials: 'same-origin' }).then((r) => (r.ok ? r.blob() : null))
        .then((blob) => (blob ? imageToDataUrl(blob, 900, 'image/jpeg') : null))
        .then((data) => { if (data && document.body.contains(f)) { form.cover.data = data; form.cover.remoteUrl = ''; renderCover(); } })
        .catch(() => {});
    }
    if (wish.isbn) pending.addIsbn = wish.isbn;
    $('#isbn-result').insertAdjacentHTML('beforebegin', `<div class="info-box" style="margin-top:8px">${owners.length > 1 ? 'Souhaité par' : 'Souhait de'} <strong>${owners.map((o) => esc(o.username)).join(', ')}</strong> : retiré de ${owners.length > 1 ? 'leurs' : 'ses'} souhaits à l'enregistrement.</div>`);
  }
  // ISBN scanne absent de la bibliotheque (bouton Scanner) : recherche lancee.
  if (!editing && pending.addIsbn) {
    const isbn = pending.addIsbn;
    pending.addIsbn = null;
    $('#isbn-search').value = isbn;
    lastLookup = isbn;
    lookup(isbn);
  }

  // Un seul epub : fiche creee d'apres le fichier (comme l'ajout multiple), puis ouverte
  // en modification pour la verifier ; fiche deja presente : ouverte telle quelle.
  const epubOne = $('#epub-one');
  if (epubOne) epubOne.onchange = async () => {
    const file = epubOne.files[0];
    if (!file) return;
    const label = epubOne.parentElement;
    label.style.opacity = '.55';
    label.style.pointerEvents = 'none';
    epubOne.disabled = true;
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('Fichier trop lourd (100 Mo max).');
      const r = await sendRaw('/api/import/epub', 'POST', file, 'application/epub+zip', { 'X-File-Name': encodeURIComponent(file.name) });
      if (r.status === 'created') {
        toast('Fiche créée d’après le fichier : vérifie-la.');
        go(`#/book/${r.bookId}/edit`);
      } else {
        toast(r.status === 'attached' ? 'Livre déjà au catalogue : fichier ajouté à sa fiche.' : 'Livre déjà au catalogue avec un fichier epub.');
        go(`#/book/${r.bookId}`);
      }
    } catch (err) {
      toast(err.message, 'error');
      label.style.opacity = '';
      label.style.pointerEvents = '';
      epubOne.disabled = false;
      epubOne.value = '';
    }
  };
  if (f.ebook) f.ebook.onchange = () => { $('#ebook-file-field').hidden = !f.ebook.checked; };

  f.onsubmit = async (e) => {
    e.preventDefault();
    addCat();
    addTag();
    const btn = $('button[type=submit]', f);
    btn.disabled = true;
    const body = {
      isbn: f.isbn.value, title: f.title.value, subtitle: f.subtitle.value, authors: authorParts().filter(Boolean).join(', '),
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
    if (readersPick) body.readers = readersPick.get();
    try {
      const saved = await api(editing ? `/api/books/${b.id}` : '/api/books', { method: editing ? 'PUT' : 'POST', body });
      if (editing) toast('Fiche enregistrée.');
      else {
        const codes = saved.copies.filter((c) => c.format !== 'ebook').map((c) => c.code);
        toast(codes.length ? `Livre ajouté : ${codes.join(', ')}. Étiquette(s) en attente d'impression.` : 'Livre ajouté.');
        const file = body.ebook && $('#ebook-file').files[0];
        const ebookCopy = file && saved.copies.find((c) => c.format === 'ebook');
        if (ebookCopy) {
          btn.textContent = 'Envoi du fichier…';
          await uploadEpub(ebookCopy.id, file).catch((err) => toast(`Fichier non envoyé : ${err.message}`, 'error'));
        }
        if (wish) {
          for (const wid of wish.ids || [wish.id]) {
            await gapi(`/api/wishes/${wid}/added`, { method: 'POST', body: { library: LIBRARY.id, bookId: saved.id } })
              .catch((err) => toast(`Souhait non retiré : ${err.message}`, 'error'));
          }
        }
      }
      if (fromIncomplete) sessionStorageTake('mll-after-edit');
      if (fromIncomplete === '#/import') markImportChecked(saved.id);
      go(fromIncomplete || `#/book/${saved.id}`);
    } catch (err) {
      $('#form-err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  };
}

export { viewBookForm };
