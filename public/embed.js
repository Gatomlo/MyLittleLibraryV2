// Catalogue en lecture seule a integrer sur un autre site (WordPress / Divi...).
//
//   <div class="mll-catalogue" data-url="https://exemple.be/mylittlelibrary"></div>
//   <script src="https://exemple.be/mylittlelibrary/embed.js" defer></script>
//
// data-url est facultatif : par defaut, l'adresse de l'app est deduite de celle de ce
// script. Le widget est rendu dans un Shadow DOM : les styles du theme (Divi...) ne le
// deforment pas, et les siens ne debordent pas sur la page.
(function () {
  'use strict';

  const SCRIPT_BASE = (() => {
    try { return new URL('.', document.currentScript.src).href.replace(/\/$/, ''); } catch (e) { return ''; }
  })();

  const CSS = `
    :host { all: initial; display: block; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--mll-text, #2a2420); }
    * { box-sizing: border-box; }
    .head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .head img { height: 36px; max-width: 120px; object-fit: contain; }
    .head img.alone { height: 56px; max-width: 240px; }
    .head strong { font-size: 18px; }
    .filters { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; margin-bottom: 14px; }
    .filters[hidden] { display: none; }
    .filters > * { min-width: 0; }
    input, select { font: inherit; padding: 9px 11px; border: 1px solid #d9d2c9; border-radius: 10px; background: #fff; color: inherit; min-height: 40px; }
    input.q { grid-column: span 2; }
    @media (max-width: 420px) { input.q { grid-column: 1 / -1; } }
    .combo { position: relative; }
    .layout.left { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 18px; align-items: start; }
    .filters.side { display: flex; flex-direction: column; gap: 10px; }
    .filters.side input.q { grid-column: auto; }
    .filters.side > *, .filters.side .combo, .filters.side select, .filters.side input { width: 100%; }
    @media (max-width: 640px) { .layout.left { grid-template-columns: minmax(0, 1fr); } }
    .combo input { width: 100%; }
    .combo-list { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 10; max-height: 280px; overflow: auto; background: #fff; border: 1px solid #d9d2c9; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.15); padding: 4px; }
    .combo-list[hidden] { display: none; }
    .combo-item { display: flex; justify-content: space-between; gap: 10px; padding: 7px 10px; border-radius: 7px; cursor: pointer; font-size: 14px; }
    .combo-item:hover, .combo-item.active { background: #dfeae6; color: #2f5d50; }
    .combo-hint { color: #776c62; font-size: 12px; }
    .combo-empty { padding: 8px 10px; color: #776c62; font-size: 13px; }
    .coll { font-size: 12px; color: #2f5d50; font-weight: 600; }
    .count { font-size: 13px; color: #776c62; margin-bottom: 10px; }
    .count[hidden] { display: none; }
    .filters.side .count { margin: 4px 0 0; padding-top: 10px; border-top: 1px solid #e6dfd6; font-weight: 600; color: #2a2420; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
    .card { display: flex; flex-direction: column; text-align: left; background: #fff; border: 1px solid #e6dfd6; border-radius: 12px; overflow: hidden; cursor: pointer; padding: 0; font: inherit; color: inherit; }
    .card:hover { box-shadow: 0 4px 14px rgba(0,0,0,.08); }
    .cover { aspect-ratio: 2 / 3; background: #efebe5; display: flex; align-items: center; justify-content: center; overflow: hidden; width: 100%; }
    .cover img { width: 100%; height: 100%; object-fit: cover; }
    .cover span { padding: 10px; text-align: center; font-weight: 700; color: #776c62; font-size: 13px; }
    .meta { padding: 9px 11px 11px; display: flex; flex-direction: column; gap: 3px; flex: 1; }
    .t { font-weight: 700; font-size: 14px; line-height: 1.3; }
    .a { font-size: 13px; color: #776c62; }
    .badge { align-self: flex-start; margin-top: auto; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .ok { background: #dcefe3; color: #2e7d4f; }
    .warn { background: #f6e7d4; color: #a4611c; }
    .ebook { background: #e3e4fa; color: #3f46a8; }
    .more { text-align: center; margin-top: 16px; }
    button.btn { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 10px; border: 1px solid #d9d2c9; background: #fff; cursor: pointer; color: inherit; }
    .empty { padding: 30px; text-align: center; color: #776c62; grid-column: 1 / -1; }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; padding: 16px; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .dialog { background: #fff; color: #2a2420; border-radius: 16px; max-width: 720px; width: 100%; max-height: calc(100vh - 32px); overflow: auto; padding: 20px; position: relative; }
    .dialog .close { position: absolute; top: 10px; right: 10px; border: 0; background: #efebe5; width: 34px; height: 34px; border-radius: 50%; font-size: 20px; cursor: pointer; }
    .detail { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 18px; }
    @media (max-width: 560px) { .detail { grid-template-columns: minmax(0, 1fr); } .detail .cover { max-width: 140px; } }
    .detail h3 { margin: 0 0 2px; font-size: 20px; line-height: 1.25; padding-right: 30px; }
    .sub { color: #776c62; margin-bottom: 8px; }
    dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 12px; font-size: 14px; margin: 10px 0; }
    dt { color: #776c62; } dd { margin: 0; }
    .summary { white-space: pre-line; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
    td { padding: 6px 4px; border-top: 1px solid #eee; }
    .code { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 700; }
  `;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Filtres proposes au visiteur (attribut data-filters / shortcode filtres="...").
  // Noms acceptes en francais ou en anglais ; "aucun" = pas de barre de filtres.
  const FILTER_NAMES = {
    recherche: 'search', search: 'search',
    categories: 'category', categorie: 'category', category: 'category',
    collections: 'collection', collection: 'collection',
    tags: 'tag', tag: 'tag',
    disponibilite: 'availability', disponibilité: 'availability', availability: 'availability',
    type: 'format', format: 'format',
    tri: 'sort', sort: 'sort',
    nombre: 'count', count: 'count',
  };
  const DEFAULT_FILTERS = 'recherche,categories,nombre';

  function parseFilters(attr) {
    const raw = String(attr == null ? DEFAULT_FILTERS : attr).toLowerCase();
    if (/^\s*(aucun|none|non)\s*$/.test(raw)) return [];
    const out = [];
    raw.split(/[\s,;|]+/).forEach((n) => { const f = FILTER_NAMES[n]; if (f && !out.includes(f)) out.push(f); });
    return out;
  }

  // Listes avec recherche (categories, collections, tags) : source et libelles.
  const PICKERS = {
    category: { path: '/api/public/categories', placeholder: 'Toutes les catégories', value: (c) => String(c.id), label: (c) => c.name },
    collection: { path: '/api/public/collections', placeholder: 'Toutes les collections', value: (c) => c.name, label: (c) => c.name },
    tag: { path: '/api/public/tags', placeholder: 'Tous les tags', value: (c) => String(c.id), label: (c) => '#' + c.name },
  };

  // Liste deroulante filtrante : un clic ouvre la liste complete (avec le nombre de
  // livres), la saisie la restreint, fleches + Entree ou clic pour choisir.
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function combo(input, panel, items, onSelect) {
    let shown = [];
    let active = -1;
    let text = '';
    const render = () => {
      const q = fold(text);
      shown = items.filter((it) => !q || fold(it.label).includes(q));
      active = shown.length ? Math.max(0, Math.min(active, shown.length - 1)) : -1;
      panel.innerHTML = shown.length
        ? shown.map((it, i) => `<div class="combo-item ${i === active ? 'active' : ''}" data-i="${i}"><span>${esc(it.label)}</span><span class="combo-hint">${esc(it.hint)}</span></div>`).join('')
        : '<div class="combo-empty">Aucun résultat</div>';
      const el = panel.querySelector('.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    const open = () => { text = ''; active = -1; render(); panel.hidden = false; };
    const choose = (i) => { if (shown[i]) { panel.hidden = true; onSelect(shown[i]); } };
    input.addEventListener('focus', open);
    input.addEventListener('click', () => { if (panel.hidden) open(); });
    input.addEventListener('input', () => { text = input.value; active = 0; render(); panel.hidden = false; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (panel.hidden) open(); else { active = Math.min(active + 1, shown.length - 1); render(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === 'Enter' && !panel.hidden && active >= 0) { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') panel.hidden = true;
    });
    panel.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const item = e.target.closest('.combo-item');
      if (item) choose(Number(item.dataset.i));
    });
    input.addEventListener('blur', () => setTimeout(() => { panel.hidden = true; }, 120));
  }

  function mount(host) {
    if (host.__mll) return;
    host.__mll = true;
    const base = (host.dataset.url || SCRIPT_BASE).replace(/\/$/, '');
    const perPage = Math.min(parseInt(host.dataset.perPage, 10) || 24, 100);
    // En-tete : "oui" (nom et logo, par defaut), "nom", "logo" ou "non" (rien).
    const headerAttr = String(host.dataset.header || 'oui').toLowerCase();
    const headerMode = /^(non|false|aucun|none)$/.test(headerAttr) ? 'none'
      : /^(nom|name)$/.test(headerAttr) ? 'name'
        : headerAttr === 'logo' ? 'logo' : 'both';
    const filters = parseFilters(host.dataset.filters);
    // Position des filtres : en haut (par defaut) ou dans une colonne a gauche.
    const left = /^(gauche|left)$/i.test(host.dataset.position || '');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="head" hidden></div>
      <div class="layout ${left && filters.length ? 'left' : ''}">
        <div class="filters ${left ? 'side' : ''}" ${filters.length ? '' : 'hidden'}></div>
        <div class="main"><div class="count"></div><div class="grid"></div><div class="more"></div></div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const state = { q: '', category: '', collection: '', tag: '', status: '', format: '', sort: 'title', page: 1 };

    const get = (path) => fetch(base + path).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    const media = (u) => (u ? `${base}/${u}` : '');
    const cover = (b) => `<div class="cover">${b.coverUrl ? `<img src="${esc(media(b.coverUrl))}" alt="" loading="lazy">` : `<span>${esc(b.title)}</span>`}</div>`;
    const badge = (b) => (b.format === 'ebook' ? '<span class="badge ebook">Livre numérique</span>'
      : b.availableCopies > 0 ? '<span class="badge ok">Disponible</span>' : b.totalCopies ? '<span class="badge warn">Emprunté</span>' : '');
    const reload = () => { state.page = 1; load(false); };

    // Barre de filtres, dans l'ordre demande. Les listes vides (ex. aucune
    // collection) et les options desactivees de la bibliotheque sont masquees.
    get('/api/public/settings').then((s) => {
      if (headerMode !== 'none') {
        // Logo seul sans logo disponible : le nom est affiche a la place.
        const withLogo = s.logoUrl && headerMode !== 'name';
        const withName = headerMode !== 'logo' || !s.logoUrl;
        const head = $('.head');
        head.innerHTML = `${withLogo ? `<img src="${esc(media(s.logoUrl))}" alt="${withName ? '' : esc(s.libraryName)}" class="${withName ? '' : 'alone'}">` : ''}${withName ? `<strong>${esc(s.libraryName)}</strong>` : ''}`;
        head.hidden = false;
      }
      const features = s.features || {};
      const bar = $('.filters');
      filters.forEach((f) => {
        if (f === 'search') {
          bar.insertAdjacentHTML('beforeend', '<input class="q" type="search" placeholder="Rechercher un titre, un auteur, un ISBN…">');
          let t;
          $('.q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; reload(); }, 250); });
        } else if (PICKERS[f]) {
          if (f === 'tag' && !features.tags) return;
          const p = PICKERS[f];
          const slot = document.createElement('span');
          slot.style.display = 'contents';
          bar.appendChild(slot);
          get(p.path).then((list) => {
            const items = list.filter((c) => c.count > 0);
            if (!items.length) return;
            slot.innerHTML = `<div class="combo"><input class="pick" type="search" placeholder="${p.placeholder}" autocomplete="off"><div class="combo-list" hidden></div></div>`;
            const input = slot.querySelector('input');
            combo(input, slot.querySelector('.combo-list'), items.map((c) => ({ label: p.label(c), hint: String(c.count), value: p.value(c) })), (it) => {
              input.value = it.label;
              if (it.value !== state[f]) { state[f] = it.value; reload(); }
            });
            input.addEventListener('input', () => { if (!input.value && state[f]) { state[f] = ''; reload(); } });
          }).catch(() => {});
        } else if (f === 'availability') {
          bar.insertAdjacentHTML('beforeend', `<select data-key="status"><option value="">Tous les livres</option>
            <option value="available">Disponibles</option><option value="onloan">En prêt</option></select>`);
        } else if (f === 'format' && features.ebooks) {
          bar.insertAdjacentHTML('beforeend', `<select data-key="format"><option value="">Papier et numérique</option>
            <option value="physical">Livres papier</option><option value="ebook">Livres numériques</option></select>`);
        } else if (f === 'sort') {
          bar.insertAdjacentHTML('beforeend', `<select data-key="sort"><option value="title">Tri : titre</option>
            <option value="recent">Tri : ajout récent</option><option value="year">Tri : année</option></select>`);
        }
      });
      // Nombre de livres : sous les filtres (a la fin de la colonne de gauche), ou masque.
      const count = $('.count');
      if (!filters.includes('count')) count.hidden = true;
      else if (left) bar.appendChild(count);
      bar.querySelectorAll('select[data-key]').forEach((sel) => {
        sel.addEventListener('change', () => { state[sel.dataset.key] = sel.value; reload(); });
      });
    }).catch(() => {});

    async function load(append) {
      const params = new URLSearchParams({ q: state.q, category: state.category, collection: state.collection, tag: state.tag,
        status: state.status, format: state.format, sort: state.sort, page: state.page, limit: perPage });
      let data;
      try { data = await get('/api/public/books?' + params); } catch (e) {
        $('.grid').innerHTML = '<div class="empty">Catalogue momentanément indisponible.</div>';
        return;
      }
      const html = data.items.map((b) => `<button class="card" data-id="${b.id}">${cover(b)}<div class="meta">
        <span class="t">${esc(b.title)}</span><span class="a">${esc(b.authors)}</span>
        ${b.collection ? `<span class="coll">${esc(b.collection)}${b.collectionNumber ? ' · n° ' + esc(b.collectionNumber) : ''}</span>` : ''}${badge(b)}</div></button>`).join('');
      if (append) $('.grid').insertAdjacentHTML('beforeend', html);
      else $('.grid').innerHTML = html || '<div class="empty">Aucun livre ne correspond.</div>';
      $('.count').textContent = `${data.total} livre${data.total > 1 ? 's' : ''}`;
      const shown = (data.page - 1) * data.limit + data.items.length;
      $('.more').innerHTML = shown < data.total ? '<button class="btn">Afficher plus</button>' : '';
    }

    async function openBook(id) {
      const b = await get('/api/public/books/' + id);
      const facts = [['Auteur(s)', b.authors], ['Éditeur', b.publisher],
        ['Collection', b.collection ? b.collection + (b.collectionNumber ? ' · n° ' + b.collectionNumber : '') : ''], ['Année', b.year], ['Pages', b.pages], ['ISBN', b.isbn],
        ['Catégories', b.categories.map((c) => c.name).join(', ')], ['Tags', (b.tags || []).map((t) => '#' + t.name).join(' ')]].filter(([, v]) => v);
      // La fenetre est attachee directement a <body>, au-dessus de tout (z-index
      // maximal) : dans le catalogue, elle resterait prisonniere du contexte
      // d'empilement de la section Divi et passerait sous le menu fixe du theme.
      const layer = document.createElement('div');
      layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
      const layerRoot = layer.attachShadow({ mode: 'open' });
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.innerHTML = `<div class="dialog" role="dialog" aria-modal="true"><button class="close" aria-label="Fermer">×</button>
        <div class="detail"><div>${cover(b)}</div><div>
          <h3>${esc(b.title)}</h3>${b.subtitle ? `<div class="sub">${esc(b.subtitle)}</div>` : ''}${badge(b)}
          <dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
          ${b.summary ? `<p class="summary">${esc(b.summary)}</p>` : ''}
          ${b.copies.length ? `<table>${b.copies.map((c) => `<tr><td class="code">${esc(c.code)}</td><td>${esc(c.location)}</td>
            <td>${c.available ? '<span class="badge ok">Disponible</span>' : '<span class="badge warn">Emprunté</span>'}</td></tr>`).join('')}</table>` : ''}
        </div></div></div>`;
      const prevOverflow = document.documentElement.style.overflow;
      const close = () => {
        layer.remove();
        document.documentElement.style.overflow = prevOverflow;
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.classList.contains('close')) close(); });
      document.addEventListener('keydown', onKey);
      layerRoot.innerHTML = `<style>${CSS}</style>`;
      layerRoot.appendChild(overlay);
      document.body.appendChild(layer);
      document.documentElement.style.overflow = 'hidden'; // pas de defilement de la page derriere
      layerRoot.querySelector('.close').focus();
    }

    $('.more').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { state.page++; load(true); } });
    $('.grid').addEventListener('click', (e) => { const card = e.target.closest('.card'); if (card) openBook(card.dataset.id); });
    load(false);
  }

  function init() { document.querySelectorAll('.mll-catalogue').forEach(mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
