// Exemplaire (cible du QR code) : pret / retour — module de l'interface (organisation : public/app/README.md).
import './liseuse-epub.js';
import { pending, canManage } from './etat.js';
import { $, view, esc, hint, mediaSrc, fmtDate, api, toast, fmtDay, dueHtml, go } from './utilitaires.js';
import { scanAndOpen, returnLoan } from './scanner.js';
import { icon } from './icones.js';
import { route } from './routage.js';

async function viewCopy(code) {
  if (!canManage()) {
    const r = await api(`/api/public/copies/${encodeURIComponent(code)}`);
    location.replace(`#/book/${r.bookId}`);
    return;
  }
  const { copy, book, oldCode, defaultDueAt } = await api(`/api/copies/by-code/${encodeURIComponent(code)}`);
  if (oldCode) {
    history.replaceState(null, '', `#/c/${encodeURIComponent(copy.code)}`);
    toast(`Ancienne étiquette ${oldCode} : cet exemplaire s'appelle maintenant ${copy.code}. Pense à réimprimer son étiquette.`);
  }
  const borrowers = copy.loan ? [] : await api('/api/borrowers');
  const reservations = book.reservations || [];
  const who = pending.loanFor;
  view().innerHTML = `
    <p>${who ? `<a href="#/borrower/${who.id}">← ${esc(who.name)}</a>` : '<a href="#/loans">← Prêts</a>'}</p>
    <div class="card">
      <div class="list-item" style="border:0;padding-top:0">
        ${book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(book.coverUrl))}" alt="">` : ''}
        <div class="grow">
          <div class="code">${esc(copy.code)}</div>
          <a href="#/book/${book.id}"><strong>${esc(book.title)}</strong></a>
          <div class="small muted">${esc(book.authors)}${copy.location ? ' · ' + esc(copy.location) : ''}</div>
        </div>
      </div>
      ${reservations.length ? `<div class="warn-box">Réservé pour ${reservations.map((r) => `<a href="#/borrower/${r.borrower.id}"><strong>${esc(r.borrower.name)}</strong></a>`).join(', ')}</div>` : ''}
      ${copy.loan ? `
        <div class="info-box">Prêté à <a href="#/borrower/${copy.loan.borrower.id}"><strong>${esc(copy.loan.borrower.name)}</strong></a> depuis le ${fmtDate(copy.loan.loanedAt)}${copy.loan.dueAt ? ` · ${dueHtml(copy.loan)}` : ''}.</div>
        <button class="btn btn-ok btn-block" id="return"><span class="hide-mobile">Enregistrer le retour</span><span class="show-mobile">Retour</span></button>
        <form class="field isbn-row" id="due-form" style="margin-top:14px">
          <input type="date" name="due" value="${esc(copy.loan.dueAt || '')}" aria-label="Date de retour">
          <button class="btn" type="submit">${copy.loan.dueAt ? 'Prolonger' : '<span class="hide-mobile">Fixer la date de retour</span><span class="show-mobile">Fixer</span>'}</button>
        </form>
      ` : `
        <div class="info-box">${copy.reservedFor ? `<span class="badge badge-reserved">Réservé</span> pour <strong>${esc(copy.reservedFor.name)}</strong>` : '<span class="badge badge-ok">Disponible</span>'}</div>
        <form id="loan-form">
          <div class="field">
            <label for="borrower">Emprunteur</label>
            <input id="borrower" name="borrower" list="borrower-list" placeholder="Nom (nouvel emprunteur créé automatiquement)" autocomplete="off" required value="${who ? esc(who.name) : copy.reservedFor ? esc(copy.reservedFor.name) : ''}">
            <datalist id="borrower-list">${borrowers.map((b) => `<option value="${esc(b.name)}">`).join('')}</datalist>
          </div>
          <div class="grid-2">
            <div class="field"><label for="due">À rendre le ${hint('Durée par défaut dans les Réglages (Exemplaires et prêts). Vide : pas de date de retour.')}</label><input id="due" name="due" type="date" value="${esc(defaultDueAt || '')}"></div>
            <div class="field"><label for="notes">Remarque (facultatif)</label><input id="notes" name="notes"></div>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Prêter</button>
        </form>`}
    </div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn" id="scan-next">${icon('scan', 16)}${who ? `<span class="hide-mobile">Prêter un </span>autre livre<span class="hide-mobile"> à ${esc(who.name)}</span>` : '<span class="hide-mobile">Scanner un </span>autre livre'}</button>
      ${who ? '<button class="btn" id="loan-for-stop">Terminer</button>' : ''}
    </div>`;
  $('#scan-next').onclick = () => scanAndOpen('loan');
  if (who) $('#loan-for-stop').onclick = () => { pending.loanFor = null; go(`#/borrower/${who.id}`); };
  if (copy.loan) {
    $('#return').onclick = async () => {
      try {
        if (!(await returnLoan(copy.loan.id, copy.code))) route();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#due-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/api/loans/${copy.loan.id}`, { method: 'PUT', body: { dueAt: e.target.due.value } });
        toast(e.target.due.value ? `À rendre le ${fmtDay(e.target.due.value)}.` : 'Date de retour retirée.');
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
  } else {
    if (!who) $('#borrower').focus();
    $('#loan-form').onsubmit = async (e) => {
      e.preventDefault();
      const name = e.target.borrower.value.trim();
      const match = borrowers.find((b) => b.name.toLowerCase() === name.toLowerCase());
      try {
        await api('/api/loans', { method: 'POST', body: { code: copy.code, borrowerId: match ? match.id : null, borrowerName: name, notes: e.target.notes.value, dueAt: e.target.due.value } });
        toast(`${copy.code} prêté à ${name}.`);
        route();
      } catch (err) { toast(err.message, 'error'); }
    };
  }
}

export { viewCopy };
