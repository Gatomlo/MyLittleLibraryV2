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
        <div class="field"><label for="iv-pass">Mot de passe ${hint('8 caractères minimum.')}</label><input id="iv-pass" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="field"><label for="iv-mail">Adresse e-mail ${hint('Facultative : sert uniquement à recevoir un lien si tu oublies ton mot de passe.')}</label><input id="iv-mail" name="email" type="email" maxlength="200" autocomplete="email"></div>`}
        <button class="btn btn-primary btn-block" type="submit">${me ? 'Rejoindre' : 'Créer mon compte'}</button>
      </form>
      ${me ? '' : `<p class="small muted" style="margin-top:12px">Déjà un compte ? <a href="#/login" id="iv-login">Connecte-toi</a>, puis rouvre ce lien.</p>`}
    </div>`;
  if ($('#iv-login')) $('#iv-login').onclick = () => sessionStorageSet('mll-after-login', location.hash);
  $('#invite-accept').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await gapi(`/api/invitations/${encodeURIComponent(token)}`, { method: 'POST', body: me ? {} : { username: f.username.value, password: f.password.value, email: f.email.value } });
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
      ${setup ? '' : '<p class="small" style="margin:12px 0 0"><a href="#/login" id="forgot-link">Mot de passe oublié ?</a></p>'}
    </div>`;
  $('#u').focus();
  if ($('#forgot-link')) $('#forgot-link').onclick = (e) => { e.preventDefault(); viewForgot($('#u').value); };
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

// Mot de passe oublie : lien envoye par la bibliotheque ouverte (sinon la bibliotheque
// par defaut du compte), si elle a un envoi d'e-mails actif. Meme reponse dans tous
// les cas (le serveur ne dit pas si le compte existe).
function viewForgot(login = '') {
  view().innerHTML = `
    <div class="card" style="max-width:400px;margin:24px auto">
      <h1>Mot de passe oublié</h1>
      <form id="forgot-form">
        <div class="field"><label for="fg-login">Identifiant ou adresse e-mail</label><input id="fg-login" name="login" required maxlength="200" autocomplete="username" value="${esc(login)}"></div>
        <button class="btn btn-primary btn-block" type="submit"><span class="hide-mobile">Recevoir un lien par e-mail</span><span class="show-mobile">Recevoir un lien</span></button>
      </form>
      <p class="small" style="margin:12px 0 0"><a href="#/login" id="fg-back">Retour à la connexion</a></p>
    </div>`;
  $('#fg-login').focus();
  $('#fg-back').onclick = (e) => { e.preventDefault(); viewLogin(); };
  $('#forgot-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      await gapi('/api/auth/forgot', { method: 'POST', body: { login: e.target.login.value, library: LIBRARY ? LIBRARY.slug : '' } });
      $('#forgot-form').outerHTML = `<div class="info-box">Si ce compte a une adresse e-mail enregistrée et que la bibliothèque peut envoyer des e-mails, un lien vient d'être envoyé (valable 1 heure). Pense à vérifier les indésirables.</div>
        <p class="small muted">Rien reçu ? Demande à un administrateur de te créer un lien de réinitialisation.</p>`;
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  };
}

// Lien de reinitialisation (e-mail ou administrateur) : nouveau mot de passe, puis
// connexion (les autres appareils sont deconnectes).
function viewReset(token) {
  view().innerHTML = `
    <div class="card" style="max-width:400px;margin:24px auto">
      <h1>Nouveau mot de passe</h1>
      <div id="err"></div>
      <form id="reset-form">
        <div class="field"><label for="rs-pass">Nouveau mot de passe ${hint('8 caractères minimum.')}</label><input id="rs-pass" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="field"><label for="rs-pass2">Confirmation</label><input id="rs-pass2" name="password2" type="password" required minlength="8" autocomplete="new-password"></div>
        <button class="btn btn-primary btn-block" type="submit">Enregistrer</button>
      </form>
    </div>`;
  $('#rs-pass').focus();
  $('#reset-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.password.value !== f.password2.value) { $('#err').innerHTML = '<div class="error-box">Les deux mots de passe sont différents.</div>'; return; }
    try {
      await gapi('/api/auth/reset', { method: 'POST', body: { token, password: f.password.value } });
      await loadStatus();
      renderHeader();
      toast('Mot de passe modifié.');
      history.replaceState(null, '', LIBRARY ? '#/home' : '#/');
      go(LIBRARY ? '#/home' : '#/');
    } catch (err) { $('#err').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  };
}

export { viewInvite, viewLogin, viewReset };
