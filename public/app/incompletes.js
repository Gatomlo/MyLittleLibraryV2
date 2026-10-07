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
  isbn: 'ISBN cité dans le fichier epub ; s\'il est inconnu en ligne (souvent un ISBN numérique) ou absent, recherche de l\'ISBN papier par titre + auteur (BnF, puis BnF et Google Books comme dans la fiche) : retenu seulement si une seule édition correspond (année, éditeur et pages de la fiche), sinon l\'ISBN du fichier est gardé.',
  category: 'Seules tes catégories existantes sont attribuées, quand elles correspondent aux sujets trouvés en ligne (ISBN inconnu en ligne, souvent numérique : sujets d\'une édition papier de même titre et même auteur).',
};
// ISBN inconnu en ligne (souvent numerique) : autre edition reprise par le serveur.
const OTHER_EDITION_HINT = ' ISBN inconnu en ligne (souvent un ISBN numérique) : informations reprises d\'une édition papier de même titre et même auteur (la plus proche de la fiche : éditeur, année, pages), sans changer l\'ISBN de la fiche.';

// Relance la recherche en ligne pour chaque livre sans cette information.
// Deux livres a la fois ; le champ n'est rempli que s'il est toujours vide.
async function refillMissing(key) {
  const btn = $('#missing-refill');
  const out = $('#refill-progress');
  const { ids } = await api(`/api/books/missing/${key}/ids?online=1`);
  const withWhat = key === 'isbn' ? '' : ' avec ISBN';
  if (!ids.length) { toast(`Aucun livre concerné${withWhat ? ' n\'a d\'ISBN' : ''}.`); return; }
  // ISBN, mode « choisir en cas de doute » : livres a plusieurs editions possibles mis
  // de cote, puis proposes un par un a la fin.
  const ask = key === 'isbn' && refillAsk();
  // Case « Autres champs vides aussi » : memes informations en ligne pour tous les champs vides.
  const all = refillAll();
  const doubts = [];
  let done = 0, filled = 0, extra = 0, stop = false;
  btn.textContent = 'Arrêter';
  btn.onclick = () => { stop = true; btn.disabled = true; };
  out.hidden = false;
  window.addEventListener('beforeunload', warnBeforeLeaving);
  const show = () => {
    out.textContent = `Recherche en cours : ${done} / ${ids.length} · ${filled} complété${filled > 1 ? 's' : ''}`
      + (extra ? ` · ${extra} autre${extra > 1 ? 's' : ''} champ${extra > 1 ? 's' : ''} rempli${extra > 1 ? 's' : ''}` : '')
      + (doubts.length ? ` · ${doubts.length} à choisir` : '');
  };
  show();
  const queue = ids.slice();
  const worker = async () => {
    while (queue.length && !stop) {
      const id = queue.shift();
      try {
        const r = await api(`/api/books/${id}/refill`, { method: 'POST', body: { field: key, ...(ask ? { ask: true } : {}), ...(all ? { all: true } : {}) } });
        if (r.status === 'filled') filled++;
        else if (r.status === 'ambiguous') doubts.push({ id, ...r });
        extra += (r.extra || []).length;
      } catch (e) { /* livre suivant */ }
      done++;
      show();
    }
  };
  await Promise.all([worker(), worker()]);
  window.removeEventListener('beforeunload', warnBeforeLeaving);
  toast(`${filled} livre${filled > 1 ? 's' : ''} complété${filled > 1 ? 's' : ''} sur ${done} recherché${done > 1 ? 's' : ''}.`
    + (extra ? ` ${extra} autre${extra > 1 ? 's' : ''} champ${extra > 1 ? 's' : ''} vide${extra > 1 ? 's' : ''} rempli${extra > 1 ? 's' : ''}.` : '')
    + (doubts.length ? ` ${doubts.length} à choisir parmi plusieurs éditions.` : ''));
  if (doubts.length) await chooseEditions(doubts, all);
  if (location.hash.startsWith('#/incomplete')) viewIncomplete(key);
}

// Mode intermediaire de « Compléter tout » (ISBN), garde dans le navigateur.
const ASK_KEY = 'mll-refill-ask';
const refillAsk = () => { try { return localStorage.getItem(ASK_KEY) === '1'; } catch (e) { return false; } };
// « Compléter aussi les autres champs vides » (tous les onglets), garde dans le navigateur.
const ALL_KEY = 'mll-refill-all';
const refillAll = () => { try { return localStorage.getItem(ALL_KEY) === '1'; } catch (e) { return false; } };

// Choix de l'edition pour chaque livre en doute : une seule fenetre, qui passe tout de
// suite au livre suivant ; chaque choix est enregistre en arriere-plan (avec « Autres
// champs vides aussi », l'enregistrement fait des recherches en ligne et prend du temps).
// Choisir, garder l'ISBN du fichier epub, Passer ou Arrêter.
async function chooseEditions(doubts, all = false) {
  const saves = [];
  let chosen = 0, saving = 0;
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = '<div class="modal modal-wide" role="dialog" aria-modal="true"></div>';
  const box = $('.modal', el);
  const status = () => (saving ? `<p class="small muted" data-saving>Enregistrement en cours : ${saving} choix…</p>` : '<p class="small muted" data-saving></p>');
  const render = (n) => {
    const d = doubts[n];
    const b = d.book;
    box.innerHTML = `<h2>Choisir l'édition (${n + 1} / ${doubts.length})</h2>
      <p><strong>${esc(b.title)}</strong>${b.authors ? ` — ${esc(b.authors)}` : ''}
        <span class="small muted">${esc([b.publisher, b.year, b.pages ? `${b.pages} p.` : ''].filter(Boolean).join(' · '))}</span></p>
      ${d.fromFile ? `<div class="info-box small">ISBN du fichier epub (sans doute numérique) : <strong>${esc(d.fromFile)}</strong>
        <button class="btn btn-small" type="button" data-pick="${esc(d.fromFile)}">Garder celui-ci</button></div>` : ''}
      <ul class="edition-list">${d.candidates.map((e) => `<li>
        <div class="ed-cover">${e.coverUrl ? `<img src="${esc(e.coverUrl)}" alt="" loading="lazy">` : ''}</div>
        <div><strong>${esc(e.title || 'Sans titre')}</strong>${e.authors ? ` — ${esc(e.authors)}` : ''}
          <div class="small muted">${[e.publisher, e.year, e.pages ? `${e.pages} p.` : '', e.isbn, (e.sources || []).join(', ')].filter(Boolean).map(esc).join(' · ')}</div></div>
        <button class="btn btn-small btn-primary" type="button" data-pick="${esc(e.isbn)}">Choisir</button></li>`).join('')}</ul>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn" type="button" data-skip>Passer</button>
        <button class="btn" type="button" data-close>Arrêter</button>
      </div>${status()}`;
    box.scrollTop = 0;
    const first = $('[data-pick]', box);
    if (first) first.focus();
  };
  const showSaving = () => { const p = $('[data-saving]', box); if (p) p.outerHTML = status(); };
  const save = (d, isbn) => {
    saving++;
    saves.push(api(`/api/books/${d.id}/refill`, { method: 'POST', body: { field: 'isbn', value: isbn, ...(all ? { all: true } : {}) } })
      .then(() => { chosen++; }, (e) => toast(`${d.book.title} : ${e.message}`, 'error'))
      .finally(() => { saving--; showSaving(); }));
  };
  await new Promise((resolve) => {
    let n = 0;
    const done = () => { el.remove(); resolve(); };
    el.addEventListener('click', (e) => {
      const p = e.target.closest('[data-pick]');
      if (p) save(doubts[n], p.dataset.pick);
      else if (!e.target.closest('[data-skip]')) {
        if (e.target === el || e.target.closest('[data-close]')) done();
        return;
      }
      n++;
      if (n < doubts.length) render(n); else done();
    });
    document.body.appendChild(el);
    render(0);
  });
  if (saving) toast(`Enregistrement des ${saving} dernier${saving > 1 ? 's' : ''} choix…`);
  await Promise.all(saves);
  if (chosen) toast(`${chosen} ISBN choisi${chosen > 1 ? 's' : ''}${all ? ', autres champs vides complétés' : ''}.`);
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
          ${MISSING_REFILL.includes(key) ? `<button class="btn btn-small btn-primary" type="button" id="missing-refill" hidden><span class="hide-mobile">Compléter tout</span><span class="show-mobile">Tout</span></button>${hint(REFILL_HINT[key] || `Relance la recherche en ligne pour chaque livre concerné ; le champ n'est rempli que s'il est toujours vide.${key !== 'isbn' ? OTHER_EDITION_HINT : ''}`)}` : ''}
          ${MISSING_REFILL.includes(key) ? `<label class="small" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" id="refill-all"${refillAll() ? ' checked' : ''}> Autres champs vides aussi</label>${hint('Coché : pour chaque fiche, les autres champs vides (auteurs, éditeur, année, pages, résumé, couverture, catégorie) sont aussi remplis avec les informations trouvées en ligne. Un champ déjà rempli n\'est jamais modifié.')}` : ''}
          ${key === 'isbn' ? `<label class="small" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" id="refill-ask"${refillAsk() ? ' checked' : ''}> Choisir en cas de doute</label>${hint('Coché : quand plusieurs éditions correspondent, le livre est mis de côté puis proposé à la fin pour que tu choisisses l\'ISBN. Décoché : tout est automatique (seuls les ISBN sûrs sont enregistrés).')}` : ''}
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
  if ($('#refill-all')) $('#refill-all').onchange = (e) => { try { localStorage.setItem(ALL_KEY, e.target.checked ? '1' : '0'); } catch (err) { /* choix non garde */ } };
  if ($('#refill-ask')) $('#refill-ask').onchange = (e) => { try { localStorage.setItem(ASK_KEY, e.target.checked ? '1' : '0'); } catch (err) { /* choix non garde */ } };
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
