// Fiches incompletes — module de l'interface (organisation : public/app/README.md).
import './import.js';
import { LIB, state } from './etat.js';
import { $, $$, view, esc, hint, mediaSrc, api, toast, go, sessionStorageSet } from './utilitaires.js';
import { warnBeforeLeaving } from './import.js';

// Livres sans une information donnee (categorie, ISBN, couverture...) : liste a
// completer une a une, ou ouverte dans le catalogue pour la selection en masse.
const MISSING_FIELDS = [
  ['category', 'Sans catégorie'], ['isbn', 'Sans ISBN'], ['cover', 'Sans couverture'], ['authors', 'Sans auteur'],
  ['publisher', 'Sans éditeur'], ['year', 'Sans année'], ['pages', 'Sans nombre de pages'], ['summary', 'Sans résumé'],
  ['location', 'Exemplaire sans emplacement'], ['tags', 'Sans tag'],
];
const missingLabel = (k) => (MISSING_FIELDS.find(([key]) => key === k) || [k, 'Information manquante'])[1];
// Informations que la recherche ISBN peut retrouver (relance en masse).
const MISSING_REFILL = ['isbn', 'category', 'cover', 'authors', 'publisher', 'year', 'pages', 'summary'];
// Informations absentes des catalogues en ligne : attribution en masse aux livres coches.
const MISSING_ASSIGN = { location: 'Emplacement (ex. Étagère A)', tags: 'Tag(s), séparés par des virgules' };
const REFILL_HINT = {
  isbn: 'ISBN cité dans le fichier epub, sinon recherche par titre + auteur (BnF) : l\'ISBN n\'est retenu que si une seule édition correspond (année, éditeur et pages de la fiche).',
  category: 'Seules tes catégories existantes sont attribuées, quand elles correspondent aux sujets trouvés en ligne.',
};

// Relance la recherche en ligne pour chaque livre sans cette information.
// Deux livres a la fois ; le champ n'est rempli que s'il est toujours vide.
async function refillMissing(key) {
  const btn = $('#missing-refill');
  const out = $('#refill-progress');
  const { ids } = await api(`/api/books/missing/${key}/ids?online=1`);
  const withWhat = key === 'isbn' ? '' : ' avec ISBN';
  if (!ids.length) { toast(`Aucun livre concerné${withWhat ? ' n\'a d\'ISBN' : ''}.`); return; }
  let done = 0, filled = 0, stop = false;
  btn.textContent = 'Arrêter';
  btn.onclick = () => { stop = true; btn.disabled = true; };
  out.hidden = false;
  window.addEventListener('beforeunload', warnBeforeLeaving);
  const show = () => { out.textContent = `Recherche en cours : ${done} / ${ids.length} · ${filled} complété${filled > 1 ? 's' : ''}`; };
  show();
  const queue = ids.slice();
  const worker = async () => {
    while (queue.length && !stop) {
      const id = queue.shift();
      try {
        const r = await api(`/api/books/${id}/refill`, { method: 'POST', body: { field: key } });
        if (r.status === 'filled') filled++;
      } catch (e) { /* livre suivant */ }
      done++;
      show();
    }
  };
  await Promise.all([worker(), worker()]);
  window.removeEventListener('beforeunload', warnBeforeLeaving);
  toast(`${filled} livre${filled > 1 ? 's' : ''} complété${filled > 1 ? 's' : ''} sur ${done} recherché${done > 1 ? 's' : ''}.`);
  if (location.hash.startsWith('#/incomplete')) viewIncomplete(key);
}

function missingPills(m, current) {
  return MISSING_FIELDS.filter(([k]) => k in m.counts).map(([k, label]) => {
    const n = m.counts[k];
    return `<a class="pill${k === current ? ' pill-current' : ''}${n ? '' : ' pill-zero'}" href="#/incomplete/${k}">${esc(label)} <strong>${n}</strong></a>`;
  }).join('');
}

async function viewIncomplete(key) {
  const m = await api('/api/books/missing');
  const keys = MISSING_FIELDS.map(([k]) => k).filter((k) => k in m.counts);
  if (!key || !keys.includes(key)) key = keys.find((k) => m.counts[k] > 0) || keys[0];
  let page = 1;
  view().innerHTML = `
    <div class="page-head"><div><h1>Fiches incomplètes ${hint(`${m.total} livre${m.total > 1 ? 's' : ''} au catalogue. Choisis l'information manquante à rechercher.`)}</h1></div></div>
    <div class="chips-filter">${missingPills(m, key)}</div>
    <div class="card">
      <div class="btn-row" style="justify-content:space-between;margin-bottom:6px">
        <strong id="missing-count"></strong>
        <div class="btn-row" id="missing-actions">
          <span class="btn-row" style="gap:6px">Exporter
            <a class="btn btn-small" href="${LIB}/api/export/inventory.xlsx?missing=${key}">Excel</a>
            <a class="btn btn-small" href="${LIB}/api/export/inventory.csv?missing=${key}">CSV</a>
            ${hint('Exporte ces fiches pour les corriger dans Excel, puis réimporte le fichier : Ajout multiple › Fichier complet › « ISBN déjà au catalogue : Mettre à jour la fiche ». Seules les colonnes remplies écrasent les fiches.')}</span>
          <button class="btn btn-small" type="button" id="missing-catalog" title="Ouvrir dans le catalogue (sélection en masse)">Catalogue</button>
          ${MISSING_REFILL.includes(key) ? `<button class="btn btn-small btn-primary" type="button" id="missing-refill" hidden><span class="hide-mobile">Compléter tout</span><span class="show-mobile">Tout</span></button>${hint(REFILL_HINT[key] || 'Relance la recherche en ligne pour chaque livre concerné ; le champ n\'est rempli que s\'il est toujours vide.')}` : ''}
        </div>
      </div>
      <div id="refill-progress" class="small muted" hidden></div>
      ${MISSING_ASSIGN[key] ? `<form class="btn-row" id="assign-form" hidden style="margin-bottom:8px">
        <label class="small"><input type="checkbox" id="assign-all"> Tout cocher</label>
        <input name="value" placeholder="${esc(MISSING_ASSIGN[key])}" required style="flex:1;min-width:160px">
        <button class="btn btn-small btn-primary" type="submit" title="Appliquer aux livres cochés">Appliquer</button>
      </form>` : ''}
      <div class="list" id="missing-list"></div>
      <div class="more" id="missing-more"></div>
    </div>`;
  $('#missing-catalog').onclick = () => {
    state.catalog = { q: '', category: '', status: '', sort: 'title', page: 1, missing: key };
    go('#/');
  };
  $('#missing-list').addEventListener('click', (e) => {
    const a = e.target.closest('[data-edit]');
    if (a) sessionStorageSet('mll-after-edit', JSON.stringify({ id: Number(a.dataset.edit), hash: `#/incomplete/${key}` }));
  });
  async function load() {
    const data = await api(`/api/books?${new URLSearchParams({ missing: key, sort: 'title', limit: 100, page })}`);
    $('#missing-count').textContent = data.total
      ? `${data.total} livre${data.total > 1 ? 's' : ''} · ${missingLabel(key).toLowerCase()}`
      : 'Aucun livre concerné.';
    $('#missing-actions').hidden = !data.total;
    if ($('#missing-refill') && page === 1) {
      $('#missing-refill').hidden = !data.total;
      $('#missing-refill').onclick = () => refillMissing(key);
    }
    if ($('#assign-form')) $('#assign-form').hidden = !data.total;
    const check = MISSING_ASSIGN[key];
    $('#missing-list').insertAdjacentHTML('beforeend', data.items.map((b) => `
      <div class="list-item">
        ${check ? `<input type="checkbox" class="assign-check" value="${b.id}"${checkAll ? ' checked' : ''} aria-label="Sélectionner">` : ''}
        ${b.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(b.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
        <div class="grow"><a href="#/book/${b.id}"><strong>${esc(b.title)}</strong></a>
          <div class="small muted">${esc([b.authors, b.publisher, b.year].filter(Boolean).join(' · ')) || '—'}</div></div>
        <a class="btn btn-small" href="#/book/${b.id}/edit" data-edit="${b.id}">Compléter</a>
      </div>`).join(''));
    const shown = (data.page - 1) * data.limit + data.items.length;
    $('#missing-more').innerHTML = shown < data.total ? '<button class="btn" type="button">Afficher plus</button>' : '';
    const more = $('#missing-more button');
    if (more) more.onclick = () => { page++; load(); };
  }
  // Attribution en masse (emplacement, tags). "Tout cocher" vaut aussi pour les
  // livres pas encore affiches (sauf ceux decoches a la main).
  let checkAll = false;
  if ($('#assign-form')) {
    $('#assign-all').onchange = (e) => {
      checkAll = e.target.checked;
      $$('.assign-check').forEach((c) => { c.checked = checkAll; });
    };
    $('#assign-form').onsubmit = async (e) => {
      e.preventDefault();
      const value = e.target.value.value.trim();
      const boxes = $$('.assign-check');
      let ids = boxes.filter((c) => c.checked).map((c) => Number(c.value));
      if (checkAll) {
        const unchecked = new Set(boxes.filter((c) => !c.checked).map((c) => Number(c.value)));
        ids = (await api(`/api/books/missing/${key}/ids`)).ids.filter((id) => !unchecked.has(id));
      }
      if (!ids.length) { toast('Coche au moins un livre.'); return; }
      const changes = key === 'location' ? { fillLocation: value } : { tagsAdd: value };
      const r = await api('/api/books/bulk-edit', { method: 'POST', body: { ids, changes } });
      toast(`${r.updated} livre${r.updated > 1 ? 's' : ''} mis à jour.`);
      viewIncomplete(key);
    };
  }
  await load();
}

export { missingLabel, missingPills, viewIncomplete };
