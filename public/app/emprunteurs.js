// Emprunteurs — module de l'interface (organisation : public/app/README.md).
import './prets.js';
import { pending } from './etat.js';
import { $, $$, view, esc, mediaSrc, fmtDate, api, toast, sendReminder, go, debounce } from './utilitaires.js';
import { scanAndOpen } from './scanner.js';
import { icon, iconText } from './icones.js';
import { route } from './routage.js';
import { loanItemHtml } from './prets.js';

async function viewBorrowers() {
  view().innerHTML = `
    <div class="page-head"><div><h1>Emprunteurs</h1></div>
      <div class="btn-row"><button class="btn btn-primary" type="button" id="show-new-borrower" title="Nouvel emprunteur" aria-label="Nouvel emprunteur">${iconText('add', 'Nouvel emprunteur')}</button></div></div>
    <form class="card" id="new-borrower" style="margin-bottom:18px" hidden>
      <div class="grid-3">
        <div class="field"><label>Nom *</label><input name="name" required></div>
        <div class="field"><label>E-mail</label><input name="email" type="email"></div>
        <div class="field"><label>Téléphone</label><input name="phone" type="tel"></div>
      </div>
      <div class="field"><label>Informations</label><textarea name="notes" style="min-height:60px" placeholder="Adresse, classe, remarques…"></textarea></div>
      <div class="btn-row"><button class="btn btn-primary" type="submit">Ajouter</button><button class="btn" type="button" id="cancel-new-borrower">Annuler</button></div>
    </form>
    <input type="search" id="bq" placeholder="Rechercher…" style="margin-bottom:12px">
    <div class="card" id="borrower-list"></div>`;
  async function load() {
    const list = await api(`/api/borrowers?q=${encodeURIComponent($('#bq').value)}`);
    $('#borrower-list').innerHTML = list.length ? `<div class="list">${list.map((b) => `
      <a class="list-item" href="#/borrower/${b.id}" style="text-decoration:none;color:inherit">
        <div class="grow"><strong>${esc(b.name)}</strong><div class="small muted">${esc([b.email, b.phone].filter(Boolean).join(' · '))}</div>${b.notes ? `<div class="small muted borrower-notes">${esc(b.notes)}</div>` : ''}</div>
        ${b.openLoans ? `<span class="badge badge-warn">${b.openLoans} en cours</span>` : ''}
        <span class="small muted">${b.totalLoans} prêt${b.totalLoans > 1 ? 's' : ''}</span>
      </a>`).join('')}</div>` : '<div class="empty">Aucun emprunteur.</div>';
  }
  $('#bq').addEventListener('input', debounce(load, 200));
  // Formulaire de creation : affiche a la demande seulement.
  const showForm = (on) => {
    $('#new-borrower').hidden = !on;
    $('#show-new-borrower').hidden = on;
    if (on) $('#new-borrower').name.focus(); else $('#new-borrower').reset();
  };
  $('#show-new-borrower').onclick = () => showForm(true);
  $('#cancel-new-borrower').onclick = () => showForm(false);
  $('#new-borrower').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/borrowers', { method: 'POST', body: { name: e.target.name.value, email: e.target.email.value, phone: e.target.phone.value, notes: e.target.notes.value } });
      showForm(false);
      toast('Emprunteur ajouté.');
      load();
    } catch (err) { toast(err.message, 'error'); }
  };
  await load();
}

async function viewBorrower(id) {
  const b = await api(`/api/borrowers/${id}`);
  const open = b.loans.filter((l) => !l.returnedAt);
  const past = b.loans.filter((l) => l.returnedAt);
  const late = open.filter((l) => l.overdue).length;
  view().innerHTML = `
    <p><a href="#/borrowers">← Emprunteurs</a></p>
    <div class="page-head"><h1>${esc(b.name)}</h1>
      <div class="btn-row">${open.length ? `<button class="btn" type="button" id="remind-all">${icon('mail', 16)}Relancer (${open.length} livre${open.length > 1 ? 's' : ''})</button>` : ''}
      <button class="btn btn-primary" type="button" id="lend" title="Prêter un livre">${icon('scan', 16)}Prêter<span class="hide-mobile"> un livre</span></button></div></div>
    <form class="card" id="borrower-form" style="margin-top:14px">
      <div class="grid-3">
        <div class="field"><label>Nom *</label><input name="name" required value="${esc(b.name)}"></div>
        <div class="field"><label>E-mail</label><input name="email" type="email" value="${esc(b.email)}"></div>
        <div class="field"><label>Téléphone</label><input name="phone" type="tel" value="${esc(b.phone)}"></div>
      </div>
      <div class="field"><label>Informations</label><textarea name="notes" style="min-height:60px" placeholder="Adresse, classe, remarques…">${esc(b.notes)}</textarea></div>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Enregistrer</button>
        ${b.loans.length ? '' : '<button class="btn btn-danger" type="button" id="del">Supprimer</button>'}
      </div>
    </form>
    <h2>En cours (${open.length})${late ? ` <span class="badge badge-late">${late} en retard</span>` : ''}</h2>
    <div class="card">${open.length ? `<div class="list">${open.map((l) => loanItemHtml(l, true)).join('')}</div>` : '<p class="muted">Aucun livre emprunté.</p>'}</div>
    ${b.reservations.length ? `<h2>Réservations (${b.reservations.length})</h2>
    <div class="card"><div class="list">${b.reservations.map((r) => `<div class="list-item">
      ${r.book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(r.book.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
      <div class="grow"><a href="#/book/${r.book.id}"><strong>${esc(r.book.title)}</strong></a><div class="small muted">Réservé le ${fmtDate(r.createdAt)}</div></div>
      <button class="btn btn-small" type="button" data-del-res="${r.id}">Retirer</button>
    </div>`).join('')}</div></div>` : ''}
    <h2>Historique (${past.length})</h2>
    <div class="card">${past.length ? `<div class="list">${past.map((l) => loanItemHtml(l, true)).join('')}</div>` : '<p class="muted">Aucun prêt terminé.</p>'}</div>`;
  // Emprunteur retenu pour les exemplaires scannes ensuite (voir loanFor).
  $('#lend').onclick = () => { pending.loanFor = { id: b.id, name: b.name }; scanAndOpen('loan'); };
  if ($('#remind-all')) $('#remind-all').onclick = async () => {
    try { if (await sendReminder({ id: b.id, name: b.name, email: b.email }, open)) route(); } catch (err) { toast(err.message, 'error'); }
  };
  $$('[data-del-res]').forEach((btn) => {
    btn.onclick = async () => {
      try { await api(`/api/reservations/${btn.dataset.delRes}`, { method: 'DELETE' }); route(); } catch (err) { toast(err.message, 'error'); }
    };
  });
  $('#borrower-form').onsubmit = async (e) => {
    e.preventDefault();
    const t = e.target;
    try {
      await api(`/api/borrowers/${id}`, { method: 'PUT', body: { name: t.name.value, email: t.email.value, phone: t.phone.value, notes: t.notes.value } });
      toast('Enregistré.');
      route();
    } catch (err) { toast(err.message, 'error'); }
  };
  const del = $('#del');
  if (del) del.onclick = async () => {
    if (!confirm(`Supprimer ${b.name} ?`)) return;
    try { await api(`/api/borrowers/${id}`, { method: 'DELETE' }); go('#/borrowers'); } catch (err) { toast(err.message, 'error'); }
  };
}

export { viewBorrowers, viewBorrower };
