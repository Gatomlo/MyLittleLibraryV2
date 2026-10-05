// Catalogue — module de l'interface (organisation : public/app/README.md).
import './accueil-site.js';
import { state, isMember, canManage, features, statusesOn, READING_LABELS, OPINION_LABELS, OPINION_ICONS } from './etat.js';
import { $, $$, view, esc, hint, api, toast, debounce, coverHtml, availabilityBadge } from './utilitaires.js';
import { scanIsbn } from './scanner.js';
import { onLeave } from './routage.js';
import { kobo, koboOn, busy, pushManyToKobo } from './kobo.js';
import { missingLabel } from './incompletes.js';

async function loadCategories() {
  return api('/api/public/categories');
}

// Liste deroulante filtrante : un clic dans le champ ouvre la liste complete, la
// saisie la restreint (sans tenir compte des accents), fleches + Entree ou clic pour
// choisir. items : [{ label, hint? }] ; onSelect(item) au choix.
// query(valeur) : texte filtrant (ex. dernier nom d'une liste a virgules) ; skip(item) : element masque.
const foldText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function combo(input, items, onSelect, { emptyText = 'Aucun résultat', showAllOnFocus = true, query = (v) => v, skip = () => false } = {}) {
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
    shown = items.filter((it) => !skip(it) && (!q || foldText(it.label).includes(q))).slice(0, 300);
    active = shown.length ? Math.max(0, Math.min(active, shown.length - 1)) : -1;
    panel.innerHTML = shown.length
      ? shown.map((it, i) => `<div class="combo-item ${i === active ? 'active' : ''}" data-i="${i}"><span>${esc(it.label)}</span>${it.hint ? `<span class="combo-hint">${esc(it.hint)}</span>` : ''}</div>`).join('')
      : `<div class="combo-empty">${esc(emptyText)}</div>`;
    const el = panel.querySelector('.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
  function open(all) {
    filterText = all ? '' : query(input.value);
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
  input.addEventListener('input', () => { filterText = query(input.value); active = 0; render(); panel.hidden = false; });
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
  return { setItems(list) { items = list; if (!panel.hidden) render(); }, close, open };
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
const forgetMembers = () => { membersCache = null; };

async function viewCatalog() {
  const c = state.catalog;
  const conf = catalogConf();
  const show = (k) => conf.filters.includes(k);
  const withStatus = statusesOn() && show('statusUser');
  const withReader = isMember() && show('reader');
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
  if (isMember() && show('mine')) {
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
      ${canManage() ? '<div class="btn-row"><a class="btn hide-mobile" href="#/import">Ajout multiple</a><a class="btn btn-primary hide-mobile" href="#/add">+ Ajouter un livre</a></div>' : koboOn() ? '<div class="btn-row"></div>' : ''}
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
  if (canManage() || koboOn()) bindSelection(reload);
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
// Lecteur (liseuse branchee) : seulement l'envoi groupe vers la liseuse.
function bindSelection(reload) {
  const head = $('.page-head .btn-row');
  if (!head) return;
  const manage = canManage();
  head.insertAdjacentHTML('afterbegin', '<button class="btn hide-mobile" type="button" id="select-toggle">Sélectionner</button>');
  document.body.insertAdjacentHTML('beforeend', `<div class="select-bar" id="select-bar" hidden>
    <strong id="select-count"></strong>
    <button class="btn btn-small" type="button" id="select-all"><span class="hide-mobile">Tout sélectionner</span><span class="show-mobile">Tout</span></button>
    <button class="btn btn-small" type="button" id="select-none">Aucun</button>
    ${manage ? '<button class="btn btn-small btn-primary" type="button" id="select-edit">Modifier</button>' : ''}
    ${koboOn() ? `<button class="btn btn-small ${manage ? '' : 'btn-primary'}" type="button" id="select-kobo"><span class="hide-mobile">Envoyer sur la liseuse</span><span class="show-mobile">Liseuse</span></button>` : ''}
    ${manage ? '<button class="btn btn-small btn-danger" type="button" id="select-delete">Supprimer</button>' : ''}
    <button class="btn btn-small" type="button" id="select-done" style="margin-left:auto">Terminer</button>
  </div>`);
  const bar = $('#select-bar');
  onLeave(() => bar.remove());
  const refreshBar = () => {
    const n = state.selected.size;
    $('#select-count').textContent = `${n} livre${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''}`;
    if (manage) { $('#select-delete').disabled = !n; $('#select-edit').disabled = !n; }
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
  if (manage) $('#select-delete').onclick = async () => {
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
  if (manage) $('#select-edit').onclick = () => bulkEditDialog(Array.from(state.selected), () => { refreshBar(); reload(); });
  const selKobo = $('#select-kobo');
  if (selKobo) selKobo.onclick = busy(async (btn) => {
    const ids = Array.from(state.selected);
    try {
      const r = await pushManyToKobo(ids, (n) => { btn.textContent = `Envoi ${n} / ${ids.length}…`; });
      toast(`${r.sent} livre(s) envoyé(s)${r.already ? `, ${r.already} déjà sur la liseuse` : ''}${r.skipped ? `, ${r.skipped} sans fichier ou sans droit` : ''}.`
        + (r.sent ? (kobo && kobo.write ? ' Éjecte la liseuse pour qu\'elle les importe.' : ' Copie les fichiers téléchargés sur la liseuse.') : ''));
      reload();
    } finally { btn.innerHTML = '<span class="hide-mobile">Envoyer sur la liseuse</span><span class="show-mobile">Liseuse</span>'; }
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
  if (isMember() && c.reader && show('reader')) params.set('reader', c.reader);
  if (isMember() && c.mine && show('mine')) params.set('mine', '1');
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
  const data = await api(`/api/${isMember() ? 'books' : 'public/books'}?${catalogParams()}`);
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

// Choix de plusieurs comptes (lecteurs d'un livre...) : pastilles retirables et liste
// deroulante avec recherche des autres comptes, lisible meme avec beaucoup de membres.
// box : conteneur vide ; selected : identifiants choisis. Renvoie { get, add }.
function memberPicker(box, members, selected, { onChange = () => {}, placeholder = 'Ajouter un lecteur…', none = 'Aucun lecteur' } = {}) {
  const ids = new Set(selected);
  const name = (m) => (m.id === state.user.id ? 'Moi' : m.username);
  box.classList.add('member-picker');
  box.innerHTML = `<div class="member-chips"></div><input type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">`;
  const chips = box.querySelector('.member-chips');
  const input = box.querySelector('input');
  const draw = () => {
    chips.innerHTML = members.filter((m) => ids.has(m.id)).map((m) => `<span class="chip chip-reader">${esc(name(m))}<button type="button" data-id="${m.id}" aria-label="Retirer ${esc(name(m))}">×</button></span>`).join('')
      || `<span class="small muted">${esc(none)}</span>`;
    chips.querySelectorAll('button').forEach((b) => { b.onclick = () => { ids.delete(Number(b.dataset.id)); draw(); onChange([...ids]); }; });
  };
  const add = (id) => { ids.add(id); draw(); onChange([...ids]); };
  combo(input, members.map((m) => ({ id: m.id, label: name(m) })), (it) => { input.value = ''; add(it.id); },
    { emptyText: 'Aucun autre compte', skip: (it) => ids.has(it.id) });
  draw();
  return { get: () => [...ids], add };
}

export {
  loadCategories, combo, searchPicker, memberPicker, ALL_CATALOG_CARD, CATALOG_CARD_LABELS, ALL_CATALOG_FILTERS, CATALOG_FILTER_LABELS, accordionize,
  loadMembers, forgetMembers, viewCatalog, starsHtml,
};
