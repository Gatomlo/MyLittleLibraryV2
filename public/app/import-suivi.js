// Suivi des ajouts multiples — module de l'interface (organisation : public/app/README.md).
import './livre-formulaire.js';
import { LIB } from './etat.js';
import { $$, esc, hint, sessionStorageSet } from './utilitaires.js';

// Historique des imports (epub, scan, liste d'ISBN, fichier), garde dans le navigateur
// (localStorage : partage entre onglets, conserve jusqu'a ce qu'on l'efface). On peut
// importer par vagues et verifier les fiches au fur et a mesure. Ligne : { id, source,
// name, status, bookId, title, error, checked, tab }. Chaque ecriture relit la liste et
// ne modifie que ses propres lignes : plusieurs imports ou onglets ne s'ecrasent pas.
// status : pending | sending | created | attached | copies | updated | unchanged | skipped | error.
const KEY = `mll-import-history:${LIB}`;
const MAX_ROWS = 3000;
const SOURCES = { epub: 'Epub', scan: 'Scan', isbn: 'ISBN', full: 'Fichier' };
const STATUS = {
  created: '<span class="badge badge-ok">Ajouté</span>',
  attached: '<span class="badge badge-ok">Fichier ajouté à la fiche</span>',
  copies: '<span class="badge badge-ok">Exemplaires ajoutés</span>',
  updated: '<span class="badge badge-ok">Mis à jour</span>',
  unchanged: '<span class="badge badge-muted">Inchangé</span>',
  skipped: '<span class="badge badge-muted">Déjà présent</span>',
};
// Fiches a verifier : creees ou modifiees par l'import.
const VERIFY = new Set(['created', 'attached', 'updated']);
const running = (r) => r.status === 'pending' || r.status === 'sending';
const verifiable = (r) => r.bookId && VERIFY.has(r.status);

// Onglet courant (garde au rechargement) : ses lignes encore « en attente » au
// chargement de la page viennent d'un import interrompu.
let TAB = null;
try { TAB = sessionStorage.getItem('mll-import-tab'); } catch (e) { /* stockage indisponible */ }
if (!TAB) { TAB = Math.random().toString(36).slice(2); sessionStorageSet('mll-import-tab', TAB); }

function load() {
  try { const rows = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(rows) ? rows : []; } catch (e) { return []; }
}
let redraw = null;
function change(fn) {
  const rows = load();
  const next = fn(rows) || rows;
  try { localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX_ROWS))); } catch (e) { /* stockage plein ou indisponible */ }
  if (redraw) redraw();
}

// Ancienne liste epub (sessionStorage) reprise une fois ; imports interrompus marques.
(() => {
  let old = [];
  try { old = JSON.parse(sessionStorage.getItem(`mll-epub-import:${LIB}`) || '[]'); sessionStorage.removeItem(`mll-epub-import:${LIB}`); } catch (e) { old = []; }
  const stale = load().some((r) => r.tab === TAB && running(r));
  if (!old.length && !stale) return;
  change((rows) => {
    rows.forEach((r) => { if (r.tab === TAB && running(r)) Object.assign(r, { status: 'error', error: 'Import interrompu (page rechargée).' }); });
    return old.filter((r) => !running(r)).map((r) => ({ ...r, id: Math.random().toString(36).slice(2), source: 'epub' })).concat(rows);
  });
})();

// Nouvelles lignes (en tete), renvoie leurs identifiants.
function historyAdd(source, names) {
  const added = names.map((name) => ({ id: Math.random().toString(36).slice(2), source, name, status: 'pending', tab: TAB }));
  change((rows) => added.concat(rows));
  return added.map((r) => r.id);
}
function historyUpdate(id, patch) {
  change((rows) => { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, patch); });
}
function historyRemove(ids) {
  const set = new Set(ids);
  change((rows) => rows.filter((r) => !set.has(r.id)));
}
// Fiche enregistree depuis le suivi (formulaire du livre) : marquee verifiee.
function markImportChecked(bookId) {
  change((rows) => { rows.forEach((r) => { if (r.bookId === bookId) r.checked = true; }); });
}

const BACK = { hash: '#/import', label: 'Suivi des imports' };
const FILTERS = [
  { key: 'todo', label: 'À vérifier', test: (r) => verifiable(r) && !r.checked },
  { key: 'running', label: 'En cours', test: running },
  { key: 'error', label: 'Erreurs', test: (r) => r.status === 'error' },
  { key: 'checked', label: 'Vérifiées', test: (r) => verifiable(r) && r.checked },
  { key: 'all', label: 'Tout', test: () => true },
];
// Ordre de « Tout » : en cours, a verifier, erreurs, le reste, verifiees en dernier.
const rank = (r) => (running(r) ? 0 : verifiable(r) && !r.checked ? 1 : r.status === 'error' ? 2 : r.checked ? 4 : 3);
let filter = null;

function rowHtml(r) {
  let state;
  if (r.status === 'pending') state = '<span class="small muted">En attente…</span>';
  else if (r.status === 'sending') state = '<span class="small muted">Envoi…</span>';
  else if (r.status === 'error') state = `<span class="badge badge-warn">Erreur</span> <span class="small">${esc(r.error || '')}</span>`;
  else state = `${STATUS[r.status] || ''} ${r.bookId ? `<a href="#/book/${r.bookId}" data-hist-open="${r.bookId}">${esc(r.title || r.name)}</a>` : esc(r.title || '')}`;
  const action = !verifiable(r) ? ''
    : r.checked ? `<button type="button" class="btn btn-small" data-hist-check="${r.id}" aria-pressed="true" title="Remettre à vérifier">✓ Vérifiée</button>`
      : `<a class="btn btn-small" href="#/book/${r.bookId}/edit" data-hist-open="${r.bookId}">Vérifier</a>
        <button type="button" class="btn btn-small" data-hist-check="${r.id}" aria-pressed="false" title="Marquer vérifiée sans l'ouvrir" aria-label="Marquer « ${esc(r.title || r.name)} » vérifiée">✓</button>`;
  return `<tr class="${r.checked ? 'hist-checked' : ''}"><td class="small"><span class="badge badge-muted">${SOURCES[r.source] || ''}</span> ${esc(r.name)}</td>
    <td>${state}</td><td class="hist-action">${action}</td></tr>`;
}

// Carte du suivi, redessinee a chaque changement (cet onglet ou un autre).
// onOpen : appele a l'ouverture d'une fiche (retour au bon onglet de l'import).
function renderImportHistory(box, { onOpen = () => {} } = {}) {
  const draw = () => {
    if (!box.isConnected) { if (redraw === draw) redraw = null; return; }
    const rows = load();
    if (!rows.length) { box.innerHTML = ''; return; }
    const counts = Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter(f.test).length]));
    const cur = filter && counts[filter] ? filter : counts.todo ? 'todo' : 'all';
    const shown = rows.filter(FILTERS.find((f) => f.key === cur).test);
    if (cur === 'all') shown.sort((a, b) => rank(a) - rank(b));
    const done = rows.filter((r) => !running(r) && (!verifiable(r) || r.checked)).length;
    box.innerHTML = `<h2>Suivi des imports ${hint('Tous tes ajouts multiples, gardés dans ce navigateur jusqu\'à ce que tu les effaces. Tu peux lancer un nouvel import pendant que tu vérifies les fiches des précédents. Une fiche enregistrée depuis « Vérifier » est cochée automatiquement.')}</h2>
      <div class="card">
        <div class="btn-row" style="justify-content:space-between;margin-bottom:10px">
          <div class="chips-filter" style="margin:0">${FILTERS.filter((f) => f.key === 'all' || counts[f.key]).map((f) => `
            <button type="button" class="pill ${cur === f.key ? 'on pill-read' : ''}" data-hist-filter="${f.key}" aria-pressed="${cur === f.key}">${f.label} (${counts[f.key]})</button>`).join('')}</div>
          <div class="btn-row">
            ${done ? `<button type="button" class="btn btn-small" id="hist-clear-done" title="Retirer les fiches vérifiées et les lignes sans rien à vérifier">Retirer les vérifiées</button>` : ''}
            <button type="button" class="btn btn-small btn-danger" id="hist-clear-all">Tout effacer</button>
          </div>
        </div>
        <div class="table-wrap" style="max-height:520px;overflow:auto"><table><tbody>${shown.map(rowHtml).join('')}</tbody></table></div>
      </div>`;
    $$('[data-hist-filter]', box).forEach((b) => { b.onclick = () => { filter = b.dataset.histFilter; draw(); }; });
    $$('[data-hist-open]', box).forEach((a) => {
      a.onclick = () => { sessionStorageSet('mll-after-edit', JSON.stringify({ id: Number(a.dataset.histOpen), ...BACK })); onOpen(); };
    });
    $$('[data-hist-check]', box).forEach((b) => {
      b.onclick = () => historyUpdate(b.dataset.histCheck, { checked: b.getAttribute('aria-pressed') !== 'true' });
    });
    const cd = box.querySelector('#hist-clear-done');
    if (cd) cd.onclick = () => change((list) => list.filter((r) => running(r) || (verifiable(r) && !r.checked) || r.status === 'error'));
    box.querySelector('#hist-clear-all').onclick = () => {
      if (!confirm('Effacer tout le suivi des imports ? Les fiches restent au catalogue.')) return;
      change((list) => list.filter(running));
    };
  };
  redraw = draw;
  draw();
}
window.addEventListener('storage', (e) => { if (e.key === KEY && redraw) redraw(); });

export { historyAdd, historyUpdate, historyRemove, markImportChecked, renderImportHistory };
