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
    .head strong { font-size: 18px; }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    input, select { font: inherit; padding: 9px 11px; border: 1px solid #d9d2c9; border-radius: 10px; background: #fff; color: inherit; min-height: 40px; }
    input.q { flex: 2 1 220px; }
    input.cat { flex: 1 1 180px; }
    .count { font-size: 13px; color: #776c62; margin-bottom: 10px; }
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

  function mount(host) {
    if (host.__mll) return;
    host.__mll = true;
    const base = (host.dataset.url || SCRIPT_BASE).replace(/\/$/, '');
    const perPage = Math.min(parseInt(host.dataset.perPage, 10) || 24, 100);
    const showHeader = host.dataset.header !== 'non' && host.dataset.header !== 'false';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="head" hidden></div>
      <div class="filters"><input class="q" type="search" placeholder="Rechercher un titre, un auteur, un ISBN…">
        <input class="cat" type="search" list="mll-cats" placeholder="Toutes les catégories" autocomplete="off"><datalist id="mll-cats"></datalist></div>
      <div class="count"></div><div class="grid"></div><div class="more"></div>`;
    const $ = (s) => root.querySelector(s);
    const state = { q: '', category: '', page: 1 };
    let categories = [];

    const get = (path) => fetch(base + path).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    const media = (u) => (u ? `${base}/${u}` : '');
    const cover = (b) => `<div class="cover">${b.coverUrl ? `<img src="${esc(media(b.coverUrl))}" alt="" loading="lazy">` : `<span>${esc(b.title)}</span>`}</div>`;
    const badge = (b) => (b.format === 'ebook' ? '<span class="badge ebook">Livre numérique</span>'
      : b.availableCopies > 0 ? '<span class="badge ok">Disponible</span>' : b.totalCopies ? '<span class="badge warn">Emprunté</span>' : '');

    if (showHeader) {
      get('/api/public/settings').then((s) => {
        const head = $('.head');
        head.innerHTML = `${s.logoUrl ? `<img src="${esc(media(s.logoUrl))}" alt="">` : ''}<strong>${esc(s.libraryName)}</strong>`;
        head.hidden = false;
      }).catch(() => {});
    }
    // Filtre de categorie avec recherche (saisie + suggestions).
    get('/api/public/categories').then((cats) => {
      categories = cats.filter((c) => c.count > 0);
      $('#mll-cats').innerHTML = categories.map((c) => `<option value="${esc(c.name)}">`).join('');
    }).catch(() => {});
    function pickCategory() {
      const v = $('.cat').value.trim().toLowerCase();
      const found = categories.find((c) => c.name.toLowerCase() === v);
      const id = v ? (found ? String(found.id) : null) : '';
      if (id === null || id === state.category) return;
      state.category = id;
      state.page = 1;
      load(false);
    }

    async function load(append) {
      const params = new URLSearchParams({ q: state.q, category: state.category, page: state.page, limit: perPage });
      let data;
      try { data = await get('/api/public/books?' + params); } catch (e) {
        $('.grid').innerHTML = '<div class="empty">Catalogue momentanément indisponible.</div>';
        return;
      }
      const html = data.items.map((b) => `<button class="card" data-id="${b.id}">${cover(b)}<div class="meta">
        <span class="t">${esc(b.title)}</span><span class="a">${esc(b.authors)}${b.year ? ' · ' + b.year : ''}</span>${badge(b)}</div></button>`).join('');
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

    let t;
    $('.q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; state.page = 1; load(false); }, 250); });
    $('.cat').addEventListener('input', pickCategory);
    $('.cat').addEventListener('change', pickCategory);
    $('.more').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { state.page++; load(true); } });
    $('.grid').addEventListener('click', (e) => { const card = e.target.closest('.card'); if (card) openBook(card.dataset.id); });
    load(false);
  }

  function init() { document.querySelectorAll('.mll-catalogue').forEach(mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
