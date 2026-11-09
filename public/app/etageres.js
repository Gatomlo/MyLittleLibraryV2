// Etageres : listes libres de livres (privees, ou partagees par un gestionnaire).
// Page #/shelves, fenetre de choix depuis une fiche ou une selection du catalogue.
// Option par bibliotheque (Reglages > Fonctionnalites) et par compte (Mon compte).
import { LIBRARY, state, canManage, shelvesOn, features } from './etat.js';
import { $, $$, view, esc, api, toast, go, mediaSrc } from './utilitaires.js';
import { icon, iconText } from './icones.js';
import { route } from './routage.js';
import { koboOn, pushManyToKobo, busy } from './kobo.js';

// Preference du compte pour les etageres (interface masquee ou non), chargee au demarrage.
async function loadShelvesPref() {
  state.shelvesPref = undefined;
  if (!LIBRARY || !state.user || !features().shelves) return;
  try { state.shelvesPref = (await api('/api/shelves/pref')).enabled; } catch (err) { /* option indisponible */ }
}

// Catalogue filtre sur une etagere.
function openShelf(id) {
  Object.assign(state.catalog, { q: '', author: '', since: '', category: '', collection: '', series: '', tag: '', status: '', format: '', reading: '', opinion: '', rating: '', mine: false, reader: '', shelf: String(id), page: 1 });
  go('#/');
}

// Fenetre modale simple : renvoie { box, close }.
function modal(html, onClose) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(backdrop);
  const close = () => { if (!backdrop.isConnected) return; backdrop.remove(); if (onClose) onClose(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close]')) close(); });
  return { box: $('.modal', backdrop), close };
}

const countLabel = (n) => `${n} livre${n > 1 ? 's' : ''}`;

// Choix des etageres pour un ou plusieurs livres.
// Un livre : cases a cocher (effet immediat). Plusieurs (selection) : bouton « Ajouter » par etagere.
// onDone() : appele a la fermeture si quelque chose a change.
async function shelfDialog({ ids, onDone }) {
  const single = ids.length === 1;
  let changed = false;
  const { box, close } = modal('<p class="muted" role="status">Chargement…</p>', () => { if (changed && onDone) onDone(); });
  async function draw() {
    let list;
    try { list = await api(single ? `/api/books/${ids[0]}/shelves` : '/api/shelves'); } catch (err) { toast(err.message, 'error'); close(); return; }
    const mine = list.filter((s) => s.mine);
    box.innerHTML = `
      <h2>${single ? 'Étagères de ce livre' : `Ajouter ${countLabel(ids.length)} à une étagère`}</h2>
      ${mine.length ? `<ul class="list shelf-pick">${mine.map((s) => `<li class="list-item">
          ${single
    ? `<label class="check grow"><input type="checkbox" data-shelf="${s.id}" ${s.has ? 'checked' : ''}> ${esc(s.name)}${s.shared ? ' <span class="badge badge-muted">partagée</span>' : ''}</label>`
    : `<span class="grow">${esc(s.name)}${s.shared ? ' <span class="badge badge-muted">partagée</span>' : ''} <span class="small muted">${countLabel(s.count)}</span></span>
              <button type="button" class="btn btn-small" data-add="${s.id}">Ajouter</button>`}</li>`).join('')}</ul>`
    : '<p class="muted">Tu n\'as pas encore d\'étagère : crée la première ci-dessous.</p>'}
      <form id="shelf-new" class="shelf-new">
        <input name="name" maxlength="60" placeholder="Nouvelle étagère…" aria-label="Nom de la nouvelle étagère" required>
        ${canManage() ? '<label class="check"><input type="checkbox" name="shared"> Partagée</label>' : ''}
        <button class="btn btn-primary" type="submit">Créer</button>
      </form>
      <div class="btn-row" style="margin-top:14px"><button class="btn" type="button" data-close>Fermer</button></div>`;
    $$('[data-shelf]', box).forEach((cb) => {
      cb.onchange = async () => {
        try {
          const path = cb.checked ? `/api/shelves/${cb.dataset.shelf}/books` : `/api/shelves/${cb.dataset.shelf}/books/remove`;
          await api(path, { method: 'POST', body: { ids } });
          changed = true;
        } catch (err) { cb.checked = !cb.checked; toast(err.message, 'error'); }
      };
    });
    $$('[data-add]', box).forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const r = await api(`/api/shelves/${btn.dataset.add}/books`, { method: 'POST', body: { ids } });
          changed = true;
          btn.textContent = '✓ Ajouté';
          toast(r.added ? `${countLabel(r.added)} ajouté${r.added > 1 ? 's' : ''}.` : 'Déjà dans cette étagère.');
        } catch (err) { btn.disabled = false; toast(err.message, 'error'); }
      };
    });
    $('#shelf-new', box).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/api/shelves', { method: 'POST', body: { name: f.name.value, shared: !!(f.shared && f.shared.checked), ids } });
        changed = true;
        toast('Étagère créée.');
        draw();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('input[name=name]', box).focus();
  }
  draw();
}

// Pastilles des etageres d'un livre (fiche) : lien vers le catalogue filtre.
function shelfChipsHtml(list) {
  return list.filter((s) => s.has).map((s) => `<a href="#/" class="chip chip-shelf" data-shelf-open="${s.id}">${icon('shelf', 14)} ${esc(s.name)}</a>`).join('');
}

// ---------- Page « Mes etageres » ----------
async function viewShelves() {
  if (!features().shelves) {
    view().innerHTML = `<div class="empty">Les étagères ne sont pas activées pour cette bibliothèque.<br><br><a class="btn" href="#/">Retour</a></div>`;
    return;
  }
  if (!shelvesOn()) {
    view().innerHTML = `<div class="empty">Les étagères sont désactivées pour ton compte.<br><br>
      <button class="btn btn-primary" id="shelves-enable">Les activer</button> <a class="btn" href="#/">Retour</a></div>`;
    $('#shelves-enable').onclick = async () => {
      try { await api('/api/shelves/pref', { method: 'PUT', body: { enabled: true } }); await loadShelvesPref(); route(); } catch (err) { toast(err.message, 'error'); }
    };
    return;
  }
  const list = await api('/api/shelves');
  const card = (s) => `<div class="card shelf-card">
      <a class="shelf-open" href="#/" data-open="${s.id}" aria-label="Ouvrir l'étagère ${esc(s.name)}">
        <div class="shelf-collage">${s.covers.length ? s.covers.map((c) => `<img src="${esc(mediaSrc(c))}" alt="" loading="lazy">`).join('') : '<span class="muted small">Vide</span>'}</div>
        <strong>${esc(s.name)}</strong>
        <div class="small muted">${countLabel(s.count)} · ${s.shared ? `partagée${s.mine ? '' : ` par ${esc(s.owner || 'un gestionnaire')}`}` : 'privée'}</div>
      </a>
      ${s.mine || (s.shared && canManage()) || koboOn() ? `<div class="btn-row shelf-actions">
        ${koboOn() && s.count ? `<button class="btn btn-small" type="button" data-kobo="${s.id}" title="Envoyer les livres numériques de l'étagère sur la liseuse" aria-label="Envoyer l'étagère ${esc(s.name)} sur la liseuse">${iconText('kobo', 'Liseuse')}</button>` : ''}
        ${s.mine ? `<button class="btn btn-small" type="button" data-rename="${s.id}" title="Renommer" aria-label="Renommer">${iconText('edit', 'Renommer')}</button>` : ''}
        ${s.mine && canManage() ? `<button class="btn btn-small" type="button" data-share="${s.id}" data-on="${s.shared ? 1 : 0}">${s.shared ? 'Ne plus partager' : 'Partager'}</button>` : ''}
        ${s.mine || (s.shared && canManage()) ? `<button class="btn btn-small btn-danger" type="button" data-del="${s.id}" title="Supprimer" aria-label="Supprimer">${iconText('trash', 'Supprimer')}</button>` : ''}
      </div>` : ''}</div>`;
  view().innerHTML = `
    <div class="page-head"><h1>Mes étagères</h1><div class="btn-row"><button class="btn btn-primary" id="shelf-add" type="button">${iconText('add', 'Nouvelle étagère')}</button></div></div>
    ${list.length ? `<div class="shelves-grid">${list.map(card).join('')}</div>`
    : '<div class="empty">Aucune étagère pour le moment.<br>Crée-en une ici, ou depuis la fiche d\'un livre (bouton « Étagère »).</div>'}`;
  $$('[data-open]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openShelf(a.dataset.open); }; });
  $('#shelf-add').onclick = () => {
    const { box, close } = modal(`<h2>Nouvelle étagère</h2>
      <form id="shelf-create"><div class="field"><input name="name" maxlength="60" placeholder="Nom de l'étagère" aria-label="Nom" required></div>
        ${canManage() ? '<label class="check"><input type="checkbox" name="shared"> Partagée avec toute la bibliothèque</label>' : ''}
        <div class="btn-row" style="margin-top:14px"><button class="btn btn-primary" type="submit">Créer</button><button class="btn" type="button" data-close>Annuler</button></div></form>`);
    $('input[name=name]', box).focus();
    $('#shelf-create', box).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/shelves', { method: 'POST', body: { name: e.target.name.value, shared: !!(e.target.shared && e.target.shared.checked) } });
        close();
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
  };
  // Envoi des livres numeriques de l'etagere sur la liseuse branchee.
  $$('[data-kobo]').forEach((b) => {
    b.onclick = busy(async (btn) => {
      const label = btn.innerHTML;
      try {
        const { ids } = await api(`/api/books?shelf=${b.dataset.kobo}&ids=1`);
        if (!ids.length) { toast('Cette étagère est vide.'); return; }
        const r = await pushManyToKobo(ids, (n, total) => { btn.textContent = `Envoi ${n} / ${total}…`; });
        if (!r) return; // choix des livres a convertir annule
        toast(`${r.sent} livre(s) envoyé(s)${r.updated ? `, ${r.updated} mis à jour` : ''}${r.already ? `, ${r.already} déjà sur la liseuse` : ''}${r.skipped ? `, ${r.skipped} sans fichier numérique ou sans droit` : ''}. Éjecte la liseuse pour qu'elle les importe.`);
      } finally { btn.innerHTML = label; }
    });
  });
  $$('[data-rename]').forEach((b) => {
    b.onclick = async () => {
      const cur = list.find((s) => String(s.id) === b.dataset.rename);
      const name = prompt('Nouveau nom de l\'étagère :', cur ? cur.name : '');
      if (!name || (cur && name === cur.name)) return;
      try { await api(`/api/shelves/${b.dataset.rename}`, { method: 'PUT', body: { name } }); route(); } catch (err) { toast(err.message, 'error'); }
    };
  });
  $$('[data-share]').forEach((b) => {
    b.onclick = async () => {
      try { await api(`/api/shelves/${b.dataset.share}`, { method: 'PUT', body: { shared: b.dataset.on !== '1' } }); route(); } catch (err) { toast(err.message, 'error'); }
    };
  });
  $$('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const cur = list.find((s) => String(s.id) === b.dataset.del);
      if (!confirm(`Supprimer l'étagère « ${cur ? cur.name : ''} » ? Les livres ne sont pas supprimés.`)) return;
      try { await api(`/api/shelves/${b.dataset.del}`, { method: 'DELETE' }); route(); } catch (err) { toast(err.message, 'error'); }
    };
  });
}

export { viewShelves, shelfDialog, shelfChipsHtml, openShelf, loadShelvesPref };
