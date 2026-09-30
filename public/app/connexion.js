// Connexion — module de l'interface (organisation : public/app/README.md).
import './exemplaire.js';
import { LIBRARY, libUrl, state, roleLabel, ROLE_HELP } from './etat.js';
import { $, view, esc, hint, gapi, toast, go, sessionStorageSet, sessionStorageTake } from './utilitaires.js';
import { renderHeader } from './entete.js';
import { showBackupReminder } from './administration.js';
import { loadStatus } from './main.js';

// Lien d'invitation : creation de son compte (identifiant, mot de passe), ou
// ajout de la bibliotheque a son compte si on est deja connecte.
async function viewInvite(token) {
  const inv = await gapi(`/api/invitations/${encodeURIComponent(token)}`);
  const open = async () => {
    await loadStatus();
    renderHeader();
    if (LIBRARY && LIBRARY.slug === inv.library.slug) go('#/home'); else location.href = `${libUrl(inv.library.slug)}#/home`;
  };
  if (inv.member) return open();
  const me = state.user;
  view().innerHTML = `
    <div class="card" style="max-width:420px;margin:24px auto">
      <h1>Invitation</h1>
      <p>Tu es invité à rejoindre <strong>${esc(inv.library.name)}</strong> <span class="badge badge-muted">${roleLabel(inv.role)}</span> ${hint(ROLE_HELP[inv.role] || ROLE_HELP.user)}</p>
      <div id="err"></div>
      <form id="invite-accept">
        ${me ? `<p class="muted">Connecté : <strong>${esc(me.username)}</strong></p>` : `
        <div class="field"><label for="iv-user">Identifiant</label><input id="iv-user" name="username" required maxlength="60" autocomplete="username"></div>
        <div class="field"><label for="iv-pass">Mot de passe ${hint('8 caractères minimum.')}</label><input id="iv-pass" name="password" type="password" required minlength="8" autocomplete="new-password"></div>`}
        <button class="btn btn-primary btn-block" type="submit">${me ? 'Rejoindre' : 'Créer mon compte'}</button>
      </form>
      ${me ? '' : `<p class="small muted" style="margin-top:12px">Déjà un compte ? <a href="#/login" id="iv-login">Connecte-toi</a>, puis rouvre ce lien.</p>`}
    </div>`;
  if ($('#iv-login')) $('#iv-login').onclick = () => sessionStorageSet('mll-after-login', location.hash);
  $('#invite-accept').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await gapi(`/api/invitations/${encodeURIComponent(token)}`, { method: 'POST', body: me ? {} : { username: f.username.value, password: f.password.value } });
      toast(`Bienvenue dans ${inv.library.name} !`);
      await open();
    } catch (err) { $('#err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  };
}

async function viewLogin() {
  if (state.user) return go(LIBRARY ? '#/home' : '#/');
  const setup = state.needsSetup;
  view().innerHTML = `
    <div class="card" style="max-width:400px;margin:24px auto">
      <h1>${setup ? 'Premier démarrage' : 'Connexion'}</h1>
      <p class="muted">${setup ? "Crée le compte administrateur et la première bibliothèque." : 'Réservé à la gestion des bibliothèques.'}</p>
      <div id="err"></div>
      <form id="login-form">
        ${setup ? '<div class="field"><label for="lib">Nom de la bibliothèque</label><input id="lib" name="libraryName" required value="Bibliothèque du bureau"></div>' : ''}
        <div class="field"><label for="u">Identifiant</label><input id="u" name="username" autocomplete="username" required></div>
        <div class="field"><label for="p">Mot de passe${setup ? ' (8 caractères min.)' : ''}</label><input id="p" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? 'minlength="8"' : ''}></div>
        <button class="btn btn-primary btn-block" type="submit">${setup ? 'Créer' : 'Se connecter'}</button>
      </form>
    </div>`;
  $('#u').focus();
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    const body = { username: e.target.username.value, password: e.target.password.value };
    if (setup) body.libraryName = e.target.libraryName.value;
    try {
      await gapi(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body });
      try { sessionStorage.removeItem('mll-backup-snooze'); } catch (e2) { /* stockage indisponible */ }
      await loadStatus();
      // Connexion acceptee mais cookie refuse (cadre d'un autre site : Teams, Safari...)
      if (!state.user) throw new Error(window.top !== window.self
        ? 'Connexion refusée par le navigateur dans ce cadre (cookies bloqués). Ouvrez l’application dans un onglet du navigateur.'
        : 'Connexion impossible : le navigateur bloque les cookies de ce site.');
      toast(`Bienvenue ${state.user.username} !`);
      setTimeout(showBackupReminder, 300);
      const after = sessionStorageTake('mll-after-login');
      if (LIBRARY) {
        renderHeader();
        go(after || (LIBRARY ? '#/home' : '#/'));
      } else {
        const def = state.libraries.find((l) => l.id === state.user.defaultLibraryId) || state.libraries[0];
        if (def && !after) location.href = libUrl(def.slug);
        else { renderHeader(); go(after || (LIBRARY ? '#/home' : '#/')); }
      }
    } catch (err) {
      $('#err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  };
}

export { viewInvite, viewLogin };
