// Fiche livre — module de l'interface (organisation : public/app/README.md).
import './catalogue.js';
import { LIB, state, isMember, canManage, features, statusesOn, READING_LABELS, OPINION_LABELS } from './etat.js';
import { $, $$, view, esc, hint, fmtDate, fmtDuration, api, toast, go, coverHtml, availabilityBadge } from './utilitaires.js';
import { iconText } from './icones.js';
import { route } from './routage.js';
import { starsHtml, pickBookDialog } from './catalogue.js';
import { kobo, koboOn, koboReturn, busy, pushToKobo } from './kobo.js';

async function viewBook(id) {
  const manage = canManage();
  const member = isMember();
  const book = await api(member ? `/api/books/${id}` : `/api/public/books/${id}`);
  const facts = [
    ['Auteur(s)', esc(book.authors)],
    ['Éditeur', esc(book.publisher)],
    ['Collection', book.collection ? `<a href="#/" data-collection="${esc(book.collection)}">${esc(book.collection)}</a>` : ''],
    ['Série', book.series ? `<a href="#/" data-series="${esc(book.series)}">${esc(book.series)}</a>${book.seriesNumber ? ` · tome ${esc(book.seriesNumber)}` : ''}` : ''],
    ['Année', book.year || ''],
    ['Pages', book.pages || ''],
    ['ISBN', esc(book.isbn)],
    ['Catégories', book.categories.map((c) => `<span class="chip">${esc(c.name)}</span>`).join('')],
    ['Tags', (book.tags || []).map((t) => `<a href="#/" class="chip chip-tag" data-tag="${t.id}">#${esc(t.name)}</a>`).join('')],
  ].filter(([, v]) => v);
  // Ouverte depuis une liste qui donne un retour (resultats d'un import epub).
  let back = null;
  try { const r = JSON.parse(sessionStorage.getItem('mll-after-edit') || 'null'); if (r && r.id === book.id && r.label) back = r; } catch (e) { /* rien */ }
  view().innerHTML = `
    ${koboReturn && koboReturn.bookId === book.id
      ? `<div class="btn-row" style="margin-bottom:12px"><a class="btn btn-primary" href="#/kobo/${koboReturn.deviceId}">← Retour à la liseuse ${esc(koboReturn.name)}</a></div>`
      : `<p><a href="${esc(back ? back.hash : '#/')}">← ${esc(back ? back.label : 'Catalogue')}</a></p>`}
    <div class="book-detail">
      <div>${coverHtml(book)}</div>
      <div>
        <h1>${esc(book.title)}</h1>
        ${book.subtitle ? `<div class="subtitle">${esc(book.subtitle)}</div>` : ''}
        ${availabilityBadge(book)}
        ${member ? readersHtml(book) : ''}
        ${member && book.myStatus ? statusEditorHtml(book) : ''}
        <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        ${book.summary ? `<h3>Résumé</h3><p class="summary">${esc(book.summary)}</p>` : ''}
        ${manage && book.notes ? `<h3>Notes internes</h3><p class="summary muted">${esc(book.notes)}</p>` : ''}
        ${member ? `<div class="btn-row" style="margin-top:14px">
            ${manage ? `<a class="btn" href="#/book/${book.id}/edit">Modifier</a>` : ''}
            ${koboOn() && book.ebookFile && book.ebookFile.download ? `<button class="btn" id="push-kobo" title="Envoyer sur ${esc(kobo.device.name)}" aria-label="Envoyer sur ma liseuse">${iconText('kobo', 'Envoyer sur ma liseuse')}</button>` : ''}
            ${manage ? '<button class="btn btn-danger" id="del-book">Supprimer</button>' : ''}
          </div>` : ''}
      </div>
    </div>
    <h2>Exemplaires</h2>
    <div class="card" id="copies">${manage ? adminCopiesHtml(book) : publicCopiesHtml(book)}</div>
    ${manage ? `<div id="reservations">${reservationsHtml(book)}</div>` : ''}
    ${manage && book.history.length ? `<h2>Historique des prêts</h2><div class="card table-wrap">${historyHtml(book.history)}</div>` : ''}
    ${member && features().kobo ? '<div id="kobo-notes"></div>' : ''}`;
  if (manage) { bindAdminBook(book); bindReservations(book); }
  const push = $('#push-kobo');
  if (push) push.onclick = busy(() => pushToKobo(book.id));
  if (member) bindReaders(book);
  if (member && book.myStatus) bindStatusEditor(book);
  if ($('#kobo-notes')) loadKoboNotes(book.id);
  // Tag : catalogue filtre sur ce tag.
  $$('[data-tag]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      Object.assign(state.catalog, { q: '', category: '', collection: '', series: '', status: '', format: '', reading: '', opinion: '', rating: '', mine: false, reader: '', tag: a.dataset.tag, page: 1 });
      go('#/');
    };
  });
  // Liens "collection" et "serie" : catalogue filtre (une serie dans l'ordre des tomes).
  $$('[data-collection], [data-series]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      Object.assign(state.catalog, { q: '', category: '', tag: '', status: '', format: '', reading: '', opinion: '', rating: '', mine: false, reader: '',
        collection: a.dataset.collection || '', series: a.dataset.series || '', page: 1 });
      go('#/');
    };
  });
}

// Surlignages et notes faits sur ses liseuses Kobo (releves a chaque scan).
async function loadKoboNotes(bookId) {
  const box = $('#kobo-notes');
  const list = await api(`/api/kobo/books/${bookId}/annotations`).catch(() => []);
  if (!box || !list.length) return;
  box.innerHTML = `<h2>Mes surlignages ${hint('Surlignages et notes faits sur ta liseuse Kobo, relevés à chaque scan.')}</h2>
    <div class="card kobo-notes">${list.map((a) => `<div class="kobo-note">
      ${a.text ? `<blockquote>${esc(a.text)}</blockquote>` : ''}
      ${a.note ? `<p class="kobo-note-text">${esc(a.note)}</p>` : ''}
      <div class="small muted">${[a.chapter ? esc(a.chapter) : '', a.createdAt ? fmtDate(a.createdAt) : '', esc(a.device)].filter(Boolean).join(' · ')}</div>
    </div>`).join('')}</div>`;
}

// Lecteurs du livre (comptes membres) avec leur statut de lecture. Sur la fiche :
// bouton "Interesse" pour soi ; les autres lecteurs se choisissent dans "Modifier".
// Le statut de lecture n'y touche jamais.
// Reservations d'un livre au nom d'emprunteurs, saisies par un compte connecte :
// possible quand tous les exemplaires papier sont pretes ; alerte au retour.
function reservationsHtml(book) {
  const list = book.reservations || [];
  const physical = book.copies.filter((c) => c.format !== 'ebook');
  const canReserve = physical.length > 0 && physical.every((c) => c.loan);
  if (!list.length && !canReserve) return '';
  return `<div class="card" style="margin-top:12px">
    <strong>Réservations ${hint('Au nom d\'un emprunteur. Quand un exemplaire revient, une alerte propose de le prêter à la première personne de la liste ; le prêt retire sa réservation.')}</strong>
    ${list.length ? `<div class="list">${list.map((r, i) => `<div class="list-item">
      <div class="grow">${i + 1}. <a href="#/borrower/${r.borrower.id}"><strong>${esc(r.borrower.name)}</strong></a> <span class="small muted">le ${fmtDate(r.createdAt)}</span></div>
      <button class="btn btn-small" type="button" data-del-res="${r.id}">Retirer</button>
    </div>`).join('')}</div>` : ''}
    ${canReserve ? `<form class="isbn-row" id="reserve-form" style="margin-top:10px">
      <input name="borrower" list="reserve-borrowers" placeholder="Emprunteur (nouveau créé automatiquement)" autocomplete="off" required>
      <datalist id="reserve-borrowers"></datalist>
      <button class="btn btn-primary" type="submit">Réserver</button>
    </form>` : ''}
  </div>`;
}

function bindReservations(book) {
  const box = $('#reservations');
  if (!box) return;
  const update = (list) => { book.reservations = list; box.innerHTML = reservationsHtml(book); bindReservations(book); };
  const form = $('#reserve-form', box);
  if (form) {
    let borrowers = [];
    api('/api/borrowers').then((list) => {
      borrowers = list;
      $('#reserve-borrowers', box).innerHTML = list.map((b) => `<option value="${esc(b.name)}">`).join('');
    }).catch(() => {});
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = form.borrower.value.trim();
      const match = borrowers.find((b) => b.name.toLowerCase() === name.toLowerCase());
      try {
        update(await api(`/api/books/${book.id}/reservations`, { method: 'POST', body: { borrowerId: match ? match.id : null, borrowerName: name } }));
        toast(`Réservé pour ${name}.`);
      } catch (err) { toast(err.message, 'error'); }
    };
  }
  $$('[data-del-res]', box).forEach((btn) => {
    btn.onclick = async () => {
      try { update(await api(`/api/reservations/${btn.dataset.delRes}`, { method: 'DELETE' })); } catch (err) { toast(err.message, 'error'); }
    };
  });
}

function readersHtml(book) {
  const readers = book.readers || [];
  const statusOf = (u) => {
    const s = u.id === state.user.id ? book.myStatus : (book.statuses || []).find((o) => o.userId === u.id);
    return s && s.reading ? ` · ${READING_LABELS[s.reading]}` : '';
  };
  const mine = readers.some((r) => r.id === state.user.id);
  return `<div class="readers-box" id="readers">
    <button type="button" class="pill ${mine ? 'on pill-reader' : ''}" id="reader-me" title="${mine ? 'Ne plus être lecteur de ce livre' : 'Devenir lecteur de ce livre'}">${mine ? '✓ Intéressé' : 'Intéressé'}</button>
    ${readers.length ? `<span class="small muted">Lecteurs</span>
      ${readers.map((u) => `<span class="chip chip-reader">${u.id === state.user.id ? 'Moi' : esc(u.username)}${statusesOn() ? esc(statusOf(u)) : ''}</span>`).join('')}` : ''}
  </div>`;
}

function bindReaders(book) {
  $('#reader-me').onclick = async () => {
    const mine = (book.readers || []).some((r) => r.id === state.user.id);
    try {
      book.readers = await api(`/api/books/${book.id}/readers${mine ? '/' + state.user.id : ''}`,
        mine ? { method: 'DELETE' } : { method: 'POST', body: { userId: state.user.id } });
      $('#readers').outerHTML = readersHtml(book);
      bindReaders(book);
    } catch (err) { toast(err.message, 'error'); }
  };
}

// Statuts de lecture (propres a chaque compte) : A lire / En cours / Lu /
// Abandonne, et Aime / Pas aime. Un clic sur le statut actif le retire. Les dates
// (debut, fin, abandon) sont enregistrees automatiquement et corrigeables.
const day = (s) => (s ? s.slice(0, 10) : '');
const daysBetween = (a, b) => Math.max(0, Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000));

function statusEditorHtml(book) {
  const s = book.myStatus;
  const btn = (group, value, label) => `<button type="button" class="pill ${s[group] === value ? 'on pill-' + value : ''}" data-${group}="${value}">${label}</button>`;
  const others = (book.statuses || []).map((o) => `<span class="small">${esc(o.username)} : ${[o.reading && READING_LABELS[o.reading], o.opinion && OPINION_LABELS[o.opinion]].filter(Boolean).join(', ')}${o.rating ? ' ' + starsHtml(o.rating) : ''}</span>`);
  const dateField = (field, label) => `<label class="date-field">${label} <input type="date" data-date="${field}" value="${day(s[field])}" max="${new Date().toISOString().slice(0, 10)}"></label>`;
  let dates = '';
  if (s.reading === 'reading') dates = dateField('startedAt', 'Commencé le') + (s.percent ? `<span class="small muted">${s.percent} % sur la liseuse</span>` : '');
  if (s.reading === 'read') {
    dates = dateField('startedAt', 'Commencé le') + dateField('finishedAt', 'Terminé le')
      + (s.startedAt && s.finishedAt ? `<span class="small muted">${daysBetween(s.startedAt, s.finishedAt)} jour(s) de lecture</span>` : '');
  }
  if (s.reading === 'abandoned') dates = dateField('startedAt', 'Commencé le') + dateField('abandonedAt', 'Abandonné le');
  if (s.koboSeconds) dates += `<span class="small muted">⏱ ${fmtDuration(s.koboSeconds)} de lecture sur la liseuse</span>`;
  return `<div class="status-editor">
    <div class="btn-row">
      <span class="small muted">Ma lecture</span>${btn('reading', 'to_read', 'À lire')}${btn('reading', 'reading', 'En cours')}${btn('reading', 'read', 'Lu')}${btn('reading', 'abandoned', 'Abandonné')}
    </div>
    ${dates ? `<div class="btn-row status-dates">${dates}</div>` : ''}
    <div class="btn-row" style="margin-top:6px">
      <span class="small muted">Mon avis</span>${btn('opinion', 'liked', '♥ Aimé')}${btn('opinion', 'disliked', '✕ Pas aimé')}
    </div>
    <div class="btn-row star-input" style="margin-top:6px">
      <span class="small muted">Ma note</span>${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star${s.rating >= n ? ' on' : ''}" data-rating="${n}" title="${n} / 5" aria-label="${n} étoile${n > 1 ? 's' : ''}">★</button>`).join('')}
    </div>
    ${others.length ? `<div class="others">${others.join(' · ')}</div>` : ''}
  </div>`;
}

function bindStatusEditor(book) {
  const save = async (body) => {
    try {
      book.myStatus = await api(`/api/books/${book.id}/status`, { method: 'PUT', body });
      $('.status-editor').outerHTML = statusEditorHtml(book);
      bindStatusEditor(book);
      if ($('#readers')) { $('#readers').outerHTML = readersHtml(book); bindReaders(book); }
    } catch (err) { toast(err.message, 'error'); }
  };
  $$('.status-editor [data-reading], .status-editor [data-opinion]').forEach((btn) => {
    btn.onclick = () => {
      const group = btn.dataset.reading ? 'reading' : 'opinion';
      const value = btn.dataset[group];
      const s = book.myStatus;
      save({ reading: s.reading, opinion: s.opinion, [group]: s[group] === value ? null : value });
    };
  });
  // Note : un clic sur la note actuelle la retire.
  $$('.status-editor [data-rating]').forEach((btn) => {
    btn.onclick = () => {
      const n = Number(btn.dataset.rating);
      save({ reading: book.myStatus.reading, opinion: book.myStatus.opinion, rating: book.myStatus.rating === n ? null : n });
    };
  });
  // Correction d'une date (ex. livre commence avant de l'enregistrer).
  $$('.status-editor [data-date]').forEach((input) => {
    input.onchange = () => {
      const s = book.myStatus;
      save({ reading: s.reading, opinion: s.opinion, [input.dataset.date]: input.value || null });
    };
  });
}

// Fichier epub de l'exemplaire numerique : droits (voir, lire, telecharger) regles dans
// les reglages de la bibliotheque.
const FILE_LEVELS = [['public', 'Tout le monde (même sans connexion)'], ['members', 'Comptes de la bibliothèque (lecteurs compris)'], ['managers', 'Bibliothécaires et gestionnaires'], ['admin', 'Administrateurs']];
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

// Presence du fichier et boutons selon les droits du visiteur (book.ebookFile).
function ebookFileHtml(book) {
  const f = book.ebookFile;
  if (!f) return '';
  return `<div class="ebook-file"><span class="small muted">Fichier epub · ${fmtSize(f.size)}</span>
    ${f.read ? `<a class="btn btn-small btn-primary" href="#/read/${book.id}">Lire</a>` : ''}
    ${f.download ? `<a class="btn btn-small" href="${esc(LIB)}/api/public/books/${book.id}/epub?download=1" download>Télécharger</a>` : ''}</div>`;
}

function publicCopiesHtml(book) {
  if (!book.copies.length && !book.ebookCopies) return '<p class="muted">Aucun exemplaire.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Exemplaire</th><th>Emplacement</th><th>État</th></tr></thead><tbody>
    ${book.copies.map((c) => `<tr><td class="code">${esc(c.code)}</td><td>${esc(c.location) || '<span class="muted">—</span>'}</td>
      <td>${c.reserved ? '<span class="badge badge-reserved">Réservé</span>' : c.available ? '<span class="badge badge-ok">Disponible</span>' : '<span class="badge badge-warn">Emprunté</span>'}</td></tr>`).join('')}
    ${book.ebookCopies ? `<tr><td><span class="badge badge-ebook">Numérique</span></td><td><span class="muted">—</span></td><td>${ebookFileHtml(book) || '<span class="small muted">Version numérique</span>'}</td></tr>` : ''}
  </tbody></table></div>`;
}

// Exemplaires papier (code, etiquette, pret) puis numerique (sans code ni pret).
function adminCopiesHtml(book) {
  const physical = book.copies.filter((c) => c.format !== 'ebook');
  const hasEbook = book.copies.some((c) => c.format === 'ebook');
  const rows = book.copies.map((c) => (c.format === 'ebook' ? `
    <tr class="copy-ebook">
      <td><span class="badge badge-ebook">Numérique</span></td>
      <td>${esc(c.location) || '<span class="muted">—</span>'}${c.notes ? `<div class="small muted">${esc(c.notes)}</div>` : ''}</td>
      <td>${c.file ? ebookFileHtml(book) || `<span class="small muted">Fichier epub · ${fmtSize(c.file.size)}</span>`
        : '<span class="small muted">Pas de fichier</span>'}</td>
      <td><span class="small muted">Pas d'étiquette</span></td>
      <td style="text-align:right;white-space:nowrap"><button class="btn btn-small" data-edit-copy="${c.id}">Modifier</button></td>
    </tr>` : `
    <tr>
      <td class="code"><a href="#/c/${encodeURIComponent(c.code)}">${esc(c.code)}</a></td>
      <td>${esc(c.location) || '<span class="muted">—</span>'}</td>
      <td>${c.loan
        ? `<span class="badge badge-warn">Prêté</span> à <a href="#/borrower/${c.loan.borrower.id}">${esc(c.loan.borrower.name)}</a><div class="small muted">depuis le ${fmtDate(c.loan.loanedAt)}</div>`
        : c.reservedFor ? `<span class="badge badge-reserved">Réservé</span> pour <a href="#/borrower/${c.reservedFor.id}">${esc(c.reservedFor.name)}</a>`
        : '<span class="badge badge-ok">Disponible</span>'}</td>
      <td>${c.labelPrintedAt ? '<span class="small muted">imprimée</span>' : '<span class="badge badge-muted">à imprimer</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <a class="btn btn-small ${c.loan ? 'btn-ok' : 'btn-primary'}" href="#/c/${encodeURIComponent(c.code)}">${c.loan ? 'Retour' : 'Prêter'}</a>
        <button class="btn btn-small" data-edit-copy="${c.id}">Modifier</button>
      </td>
    </tr>`)).join('');
  return `
    ${book.copies.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>Code</th><th>Emplacement</th><th>État</th><th>Étiquette</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Aucun exemplaire.</p>'}
    <div class="btn-row" style="margin-top:12px">
      <button class="btn" id="add-copy">+ <span class="hide-mobile">Exemplaire </span>papier</button>
      ${features().ebooks && !hasEbook ? '<button class="btn" id="add-ebook">+ <span class="hide-mobile">Exemplaire </span>numérique</button>' : ''}
      ${physical.length ? `<button class="btn" id="print-labels" title="Imprimer les étiquettes" aria-label="Imprimer les étiquettes">${iconText('print', 'Imprimer les étiquettes')}</button>` : ''}
    </div>`;
}

function historyHtml(history) {
  return `<div class="table-wrap"><table class="stack"><thead><tr><th>Exemplaire</th><th>Emprunteur</th><th>Prêté le</th><th>Rendu le</th></tr></thead><tbody>
    ${history.map((l) => `<tr><td class="code">${esc(l.code)}</td><td><a href="#/borrower/${l.borrower.id}">${esc(l.borrower.name)}</a></td>
      <td>${fmtDate(l.loanedAt)}</td><td>${l.returnedAt ? fmtDate(l.returnedAt) : '<span class="badge badge-warn">en cours</span>'}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function bindAdminBook(book) {
  $('#del-book').onclick = async () => {
    if (!confirm(`Supprimer définitivement « ${book.title} », ses ${book.copies.length} exemplaire(s) et leur historique de prêts ?`)) return;
    try {
      await api(`/api/books/${book.id}`, { method: 'DELETE' });
      toast('Livre supprimé.');
      go('#/');
    } catch (err) { toast(err.message, 'error'); }
  };
  const physical = book.copies.filter((c) => c.format !== 'ebook');
  const addCopy = $('#add-copy');
  if (addCopy) addCopy.onclick = async () => {
    const location = prompt("Emplacement du nouvel exemplaire papier (facultatif) :", (physical[0] && physical[0].location) || '');
    if (location === null) return;
    try {
      const r = await api(`/api/books/${book.id}/copies`, { method: 'POST', body: { count: 1, location } });
      toast(`Exemplaire ${r.codes[0]} créé.`);
      route();
    } catch (err) { toast(err.message, 'error'); }
  };
  const addEbook = $('#add-ebook');
  if (addEbook) addEbook.onclick = () => editCopyDialog({
    id: null, bookId: book.id, format: 'ebook', location: '', notes: '', file: null,
  });
  const print = $('#print-labels');
  if (print) print.onclick = () => {
    state.labels = { mode: 'manual', manual: physical.map((c) => ({ code: c.code, title: book.title })) };
    go('#/labels');
  };
  $$('[data-edit-copy]').forEach((btn) => {
    btn.onclick = () => editCopyDialog(book.copies.find((c) => c.id === Number(btn.dataset.editCopy)), book);
  });
}

// Envoi brut du fichier (hors JSON) : nom d'origine dans l'en-tete X-File-Name.
async function sendRaw(path, method, body, type, headers = {}) {
  const res = await fetch(LIB + path, { method, credentials: 'same-origin', body, headers: { 'Content-Type': type, ...headers } });
  let data = null;
  try { data = await res.json(); } catch (e) { /* reponse vide */ }
  if (!res.ok) throw new Error((data && data.error) || (res.status === 413 ? 'Fichier trop lourd.' : `Erreur ${res.status}`));
  return data;
}

async function uploadEpub(copyId, file) {
  if (file.size > 100 * 1024 * 1024) throw new Error('Fichier trop lourd (100 Mo max).');
  return sendRaw(`/api/copies/${copyId}/file`, 'PUT', file, 'application/epub+zip', { 'X-File-Name': encodeURIComponent(file.name) });
}

async function editCopyDialog(copy, book = null) {
  const locations = await api('/api/locations').catch(() => []);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal">
      <h2>${copy.format === 'ebook' ? (copy.id ? 'Exemplaire numérique' : 'Nouvel exemplaire numérique') : `Exemplaire <span class="code">${esc(copy.code)}</span>`}</h2>
      <div class="field"><label>${copy.format === 'ebook' ? 'Emplacement du fichier' : 'Emplacement'}</label><input name="location" list="loc-list" value="${esc(copy.location)}">
        <datalist id="loc-list">${locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist></div>
      <div class="field"><label>Notes (état, provenance…)</label><textarea name="notes" style="min-height:80px">${esc(copy.notes)}</textarea></div>
      ${copy.format === 'ebook' ? `
      <div class="field"><label>Fichier epub ${hint('Facultatif (100 Mo max). Un nouveau fichier remplace le précédent.')}</label>
        ${copy.file ? `<div class="small" style="margin-bottom:6px">${esc(copy.file.name)} · ${fmtSize(copy.file.size)}
          <label class="check" style="display:inline-flex;margin-left:10px"><input type="checkbox" name="removeFile"> Retirer</label></div>` : ''}
        <input type="file" name="file" accept=".epub,application/epub+zip"></div>` : ''}
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Enregistrer</button>
        <button class="btn" type="button" data-close>Annuler</button>
        ${copy.id && book ? `<button class="btn" type="button" data-move style="margin-left:auto" title="Transférer vers une autre fiche">${iconText('move', 'Transférer')}</button>` : ''}
        ${copy.id ? `<button class="btn btn-danger" type="button" data-delete ${book ? '' : 'style="margin-left:auto"'}>Supprimer</button>` : ''}
      </div>
    </form>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(); });
  if (copy.id) $('[data-delete]', backdrop).onclick = async () => {
    if (!confirm(copy.format === 'ebook' ? "Supprimer l'exemplaire numérique ?" : `Supprimer l'exemplaire ${copy.code} et son historique de prêts ?`)) return;
    try { await api(`/api/copies/${copy.id}`, { method: 'DELETE' }); close(); toast('Exemplaire supprimé.'); route(); } catch (err) { toast(err.message, 'error'); }
  };
  if (copy.id && book) $('[data-move]', backdrop).onclick = () => moveCopy(copy, book, close);
  $('form', backdrop).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const submit = $('[type=submit]', f);
    submit.disabled = true;
    try {
      let id = copy.id;
      if (!id) {
        const r = await api(`/api/books/${copy.bookId}/copies`, { method: 'POST', body: { format: 'ebook', location: f.location.value } });
        id = r.book.copies.find((c) => c.format === 'ebook').id;
      }
      await api(`/api/copies/${id}`, { method: 'PUT', body: { location: f.location.value, notes: f.notes.value } });
      const file = f.file && f.file.files[0];
      if (file) {
        submit.textContent = 'Envoi du fichier…';
        await uploadEpub(id, file);
      } else if (f.removeFile && f.removeFile.checked) {
        await api(`/api/copies/${id}/file`, { method: 'DELETE' });
      }
      close();
      toast(copy.id ? 'Exemplaire mis à jour.' : 'Exemplaire numérique ajouté.');
      route();
    } catch (err) {
      toast(err.message, 'error');
      submit.disabled = false;
      submit.textContent = 'Enregistrer';
    }
  };
}

// Transfert d'un exemplaire (et de son code, ses prets) vers une autre fiche : erreur
// d'etiquetage ou fiche en double. Fiche d'origine vide : sa suppression est proposee.
async function moveCopy(copy, book, closeDialog) {
  const label = copy.format === 'ebook' ? "l'exemplaire numérique" : `l'exemplaire ${copy.code}`;
  const target = await pickBookDialog({ heading: `Transférer ${label}`, subtitle: `Depuis « ${book.title} »`, query: book.title, exclude: book.id });
  if (!target) return;
  try {
    const r = await api(`/api/copies/${copy.id}/move`, { method: 'POST', body: { bookId: target } });
    closeDialog();
    toast(`${copy.format === 'ebook' ? 'Exemplaire numérique' : `Exemplaire ${copy.code}`} transféré vers « ${r.book.title} ».`);
    if (!r.sourceCopies && confirm(`« ${book.title} » n'a plus d'exemplaire. Supprimer cette fiche ?`)) {
      await api(`/api/books/${book.id}`, { method: 'DELETE' });
      toast('Fiche vide supprimée.');
    }
    go(`#/book/${r.book.id}`);
  } catch (err) { toast(err.message, 'error'); }
}
export { viewBook, FILE_LEVELS, sendRaw, uploadEpub };
