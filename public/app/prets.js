// Prets — module de l'interface (organisation : public/app/README.md).
import './incompletes.js';
import { pending } from './etat.js';
import {
  $, $$, view, esc, hint, mediaSrc, fmtDate, api, toast, dueHtml, sendReminder, loanCache, remindedHtml, go,
} from './utilitaires.js';
import { copyCodeFromScan, scanAndOpen } from './scanner.js';
import { icon } from './icones.js';

async function viewLoans() {
  let tab = pending.loansTab || 'open';
  pending.loansTab = null;
  view().innerHTML = `
    <div class="page-head"><h1>Prêts ${hint('Pour prêter ou enregistrer un retour, scanne le QR code de l\'étiquette ou tape le code de l\'exemplaire.')}</h1></div>
    <div class="card" style="margin-bottom:18px">
      <form class="isbn-row" id="code-form">
        <input name="code" placeholder="Code (ex. BIB-00042)" autocomplete="off" style="text-transform:uppercase">
        <button class="btn" type="submit">Ouvrir</button>
        <button class="btn btn-primary" type="button" id="scan">Scanner</button>
      </form>
    </div>
    <div class="tabs" id="loan-tabs"></div>
    <div class="card" id="loan-list"></div>`;
  $('#scan').onclick = () => scanAndOpen('loan');
  $('#code-form').onsubmit = (e) => {
    e.preventDefault();
    const code = copyCodeFromScan(e.target.code.value.trim());
    if (code) go(`#/c/${encodeURIComponent(code)}`);
    else toast('Code non reconnu.', 'error');
  };
  async function tabs() {
    const s = await api('/api/loans/summary');
    const auto = s.reminder && s.reminder.mode === 'auto';
    if (!auto && tab === 'remind') tab = 'open';
    $('#loan-tabs').innerHTML = [['open', `En cours (${s.open})`], ['overdue', `En retard (${s.overdue})`],
      ...(auto ? [['remind', `À relancer (${s.toRemind})`]] : []),
      ['reservations', `Réservations (${s.reservations})`], ['returned', 'Historique']]
      .map(([k, l]) => `<button type="button" data-tab="${k}" class="${k === tab ? 'active' : ''}" aria-pressed="${k === tab}">${l}</button>`).join('');
    $$('#loan-tabs button').forEach((btn) => {
      btn.onclick = () => { tab = btn.dataset.tab; tabs(); load(); };
    });
  }
  async function load() {
    if (tab === 'reservations') {
      const list = await api('/api/reservations');
      $('#loan-list').innerHTML = list.length ? `<div class="list">${list.map((r) => `<div class="list-item">
          ${r.book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(r.book.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
          <div class="grow">
            <a href="#/book/${r.book.id}"><strong>${esc(r.book.title)}</strong></a>
            <div class="small muted">Pour <a href="#/borrower/${r.borrower.id}">${esc(r.borrower.name)}</a> · le ${fmtDate(r.createdAt)}</div>
            <div>${r.available ? '<span class="badge badge-ok">Exemplaire disponible</span>' : '<span class="badge badge-muted">Tous prêtés</span>'}</div>
          </div>
          <button class="btn btn-small" type="button" data-del-res="${r.id}">Retirer</button>
        </div>`).join('')}</div>` : '<div class="empty">Aucune réservation.</div>';
      $$('[data-del-res]', $('#loan-list')).forEach((btn) => {
        btn.onclick = async () => {
          try { await api(`/api/reservations/${btn.dataset.delRes}`, { method: 'DELETE' }); tabs(); load(); } catch (err) { toast(err.message, 'error'); }
        };
      });
      return;
    }
    const loans = await api(`/api/loans?status=${tab}`);
    if (tab === 'remind') {
      // Un message par emprunteur, avec tous ses livres a relancer.
      const groups = new Map();
      loans.forEach((l) => { if (!groups.has(l.borrower.id)) groups.set(l.borrower.id, []); groups.get(l.borrower.id).push(l); });
      const list = [...groups.values()];
      $('#loan-list').innerHTML = list.length ? list.map((ls, i) => `<section class="remind-group" aria-labelledby="rg-${i}">
          <div class="remind-head"><h3 id="rg-${i}"><a href="#/borrower/${ls[0].borrower.id}">${esc(ls[0].borrower.name)}</a></h3>
            <span class="small muted grow">${esc(ls[0].borrower.email || "pas d'e-mail")}</span>
            <button class="btn btn-small btn-primary" type="button" data-remind-group="${i}">${icon('mail', 16)}Relancer (${ls.length} livre${ls.length > 1 ? 's' : ''})</button></div>
          <div class="list">${ls.map((l) => loanItemHtml(l, true)).join('')}</div></section>`).join('')
        : '<div class="empty">Aucun prêt à relancer.</div>';
      $$('[data-remind-group]').forEach((btn) => {
        btn.onclick = async () => {
          const ls = list[Number(btn.dataset.remindGroup)];
          try { if (await sendReminder(ls[0].borrower, ls)) { tabs(); load(); } } catch (err) { toast(err.message, 'error'); }
        };
      });
      return;
    }
    $('#loan-list').innerHTML = loans.length ? `<div class="list">${loans.map((l) => loanItemHtml(l)).join('')}</div>`
      : `<div class="empty">${{ open: 'Aucun prêt en cours.', overdue: 'Aucun prêt en retard.' }[tab] || 'Aucun prêt terminé.'}</div>`;
  }
  await Promise.all([tabs(), load()]);
}

function loanItemHtml(l, hideBorrower) {
  loanCache.set(l.id, l);
  return `<div class="list-item">
    ${l.book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(l.book.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb"></span>'}
    <div class="grow">
      <a href="#/book/${l.book.id}"><strong>${esc(l.book.title)}</strong></a>
      <div class="small muted"><span class="code">${esc(l.copy.code)}</span>${hideBorrower ? '' : ` · <a href="#/borrower/${l.borrower.id}">${esc(l.borrower.name)}</a>`}</div>
      <div class="small muted">Prêté le ${fmtDate(l.loanedAt)}${l.returnedAt ? ` · rendu le ${fmtDate(l.returnedAt)}` : l.dueAt ? ` · ${dueHtml(l)}` : ''}${l.notes ? ' · ' + esc(l.notes) : ''}${!l.returnedAt && l.remindedAt ? ` · ${remindedHtml(l)}` : ''}</div>
    </div>
    ${l.returnedAt ? '' : `<div class="btn-row loan-actions">
      <button class="btn btn-small" type="button" data-remind="${l.id}" aria-label="Relancer ${esc(l.borrower.name)} pour « ${esc(l.book.title)} »">${icon('mail', 16)}<span>Relancer</span></button>
      <a class="btn btn-small btn-ok" href="#/c/${encodeURIComponent(l.copy.code)}" data-quick-return="${esc(l.copy.code)}" aria-label="Retour de « ${esc(l.book.title)} »">Retour</a></div>`}
  </div>`;
}

export { viewLoans, loanItemHtml };
