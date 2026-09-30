// Accueil (racine du site) — module de l'interface (organisation : public/app/README.md).
import './routage.js';
import { ROOT, libUrl, state, isAdmin } from './etat.js';
import { view, esc, gapi, go } from './utilitaires.js';
import { viewLogin } from './connexion.js';

// Non connecte : uniquement la page de connexion (les catalogues publics ont
// chacun leur adresse). Connecte : ouverture de sa bibliotheque par defaut, ou
// liste de ses bibliotheques quand on y revient depuis le menu.
async function viewHome() {
  if (!state.user) return viewLogin();
  const params = new URLSearchParams(location.search);
  const def = state.libraries.find((l) => l.id === state.user.defaultLibraryId) || state.libraries[0];
  if (def && !params.has('accueil')) { location.replace(libUrl(def.slug)); return; }
  const libs = state.libraries;
  view().innerHTML = `
    <div class="page-head"><div><h1>Mes bibliothèques</h1></div>
      ${isAdmin() ? '<a class="btn btn-primary" href="#/admin">Administration</a>' : ''}</div>
    ${libs.length ? `<div class="lib-grid">${libs.map((l) => `
      <a class="card lib-card" href="${esc(libUrl(l.slug))}">
        ${l.logoUrl ? `<img src="${esc(ROOT + '/' + l.logoUrl)}" alt="">` : `<span class="ph">${esc(l.name.charAt(0).toUpperCase())}</span>`}
        <div><strong>${esc(l.name)}</strong><div class="small muted">/${esc(l.slug)}/${l.id === state.user.defaultLibraryId ? ' · par défaut' : ''}</div></div>
      </a>`).join('')}</div>`
      : `<div class="empty">Aucune bibliothèque n'est liée à ton compte.${isAdmin() ? '<br><br><a class="btn btn-primary" href="#/admin"><span class="hide-mobile">Créer une bibliothèque</span><span class="show-mobile">Créer</span></a>' : ' Demande à un administrateur.'}</div>`}`;
}

async function viewLegacyRedirect(rest) {
  const libs = await gapi('/api/libraries');
  if (!libs.length) return go('#/');
  location.replace(`${libUrl(libs[0].slug)}#/${rest}`);
}

export { viewHome, viewLegacyRedirect };
