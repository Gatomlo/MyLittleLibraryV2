// Liseuse epub (epub.js) — module de l'interface (organisation : public/app/README.md).
import './kobo.js';
import { LIBRARY, LIB, ASSETS, state, isMember } from './etat.js';
import { $, view, esc, api, loadScript } from './utilitaires.js';
import { onLeave } from './routage.js';

// Position de lecture gardee dans le navigateur (localStorage, par livre).
async function viewReader(id) {
  const book = await api(isMember() ? `/api/books/${id}` : `/api/public/books/${id}`);
  if (!book.ebookFile || !book.ebookFile.read) {
    throw new Error(state.user ? "Ton compte n'a pas accès à la lecture de ce livre." : 'Connecte-toi pour lire ce livre.');
  }
  if (!window.JSZip) await loadScript(ASSETS + '/vendor/jszip.min.js');
  if (!window.ePub) await loadScript(ASSETS + '/vendor/epub.min.js');
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
  onLeave(() => {
    document.removeEventListener('keyup', onKey);
    try { epub.destroy(); } catch (e) { /* deja detruit */ }
  });
}

export { viewReader };
