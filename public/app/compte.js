// Mon compte — module de l'interface (organisation : public/app/README.md).
import './connexion.js';
import { libUrl, state, isAdmin, isMember, roleLabel, ROLE_HELP, features } from './etat.js';
import { $, $$, view, esc, hint, api, gapi, toast } from './utilitaires.js';
import { prefsHtml, bindPrefs, statsShareHtml, bindStatsShare } from './statistiques.js';
import { accordionize } from './catalogue.js';
import { wishShareSection } from './souhaits.js';

async function viewAccount() {
  const u = state.user;
  view().innerHTML = `
    <h1>Mon compte</h1>
    <p class="muted">${esc(u.username)}${isAdmin() ? ` · ${roleLabel('admin')} ${hint(ROLE_HELP.admin)}` : ''}</p>
    <h2>Bibliothèque par défaut</h2>
    <div class="card">
      <p class="small muted">Ouverte automatiquement après la connexion. Le menu du compte permet de basculer à tout moment.</p>
      ${state.libraries.length ? `
      <div class="list">${state.libraries.map((l) => `
        <label class="list-item check" style="cursor:pointer">
          <input type="radio" name="def" value="${l.id}" ${l.id === u.defaultLibraryId ? 'checked' : ''}>
          <span class="grow">${esc(l.name)} <span class="small muted">/${esc(l.slug)}/</span>
            ${isAdmin() ? '' : `<br><span class="badge badge-muted">${roleLabel(l.role)}</span> ${hint(ROLE_HELP[l.role] || ROLE_HELP.user)}`}</span>
          <a class="btn btn-small" href="${esc(libUrl(l.slug))}">Ouvrir</a>
        </label>`).join('')}</div>`
      : '<p class="muted">Aucune bibliothèque n\'est liée à ton compte. Demande à un administrateur.</p>'}
    </div>
    ${isMember() && features().stats ? '<h2>Mes lectures</h2><div id="acc-prefs"><p class="muted">Chargement…</p></div>' : ''}
    <h2>Mes partages</h2>
    <div class="card" id="acc-shares">
      ${isMember() && features().stats ? '<div id="acc-share-stats"></div>' : ''}
      <div class="field"><label>Ma liste de souhaits ${hint('Ces comptes voient ta liste de souhaits (sans la modifier), dans les bibliothèques que vous partagez.')}</label>
        <div id="acc-share-wishes"><p class="muted small">Chargement…</p></div></div>
    </div>
    <h2>Mot de passe</h2>
    <form class="card" id="pwd-form">
      <div class="grid-2">
        <div class="field"><label>Mot de passe actuel</label><input name="current" type="password" autocomplete="current-password" required></div>
        <div class="field"><label>Nouveau mot de passe (8 caractères min.)</label><input name="password" type="password" autocomplete="new-password" minlength="8" required></div>
      </div>
      <button class="btn" type="submit"><span class="hide-mobile">Changer le mot de passe</span><span class="show-mobile">Changer</span></button>
    </form>`;
  accordionize(view(), 'mll-account');
  // Reglages de lecture et partage des statistiques dans la bibliotheque ouverte (si
  // elle a les statistiques) ; partage de la liste de souhaits (tous comptes).
  if (isMember() && features().stats) {
    api('/api/stats/overview').then((ov) => {
      if (!$('#acc-prefs')) return;
      $('#acc-prefs').innerHTML = prefsHtml(ov);
      bindPrefs(ov);
      $('#acc-share-stats').innerHTML = statsShareHtml(ov);
      bindStatsShare(ov);
    }).catch(() => {});
  }
  wishShareSection($('#acc-share-wishes')).catch((err) => { $('#acc-share-wishes').innerHTML = `<p class="small error-text">${esc(err.message)}</p>`; });
  $$('input[name=def]').forEach((radio) => {
    radio.onchange = async () => {
      try {
        await gapi('/api/me/default-library', { method: 'PUT', body: { libraryId: Number(radio.value) } });
        state.user.defaultLibraryId = Number(radio.value);
        toast('Bibliothèque par défaut enregistrée.');
      } catch (err) { toast(err.message, 'error'); }
    };
  });
  $('#pwd-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await gapi('/api/me/password', { method: 'POST', body: { current: e.target.current.value, password: e.target.password.value } });
      e.target.reset();
      toast('Mot de passe modifié.');
    } catch (err) { toast(err.message, 'error'); }
  };
}

export { viewAccount };
