// Routage — module de l'interface (organisation : public/app/README.md).
import './icones.js';
import { LIBRARY, state, isAdmin, isMember, canManage, canConfigure } from './etat.js';
import { $, view, esc, go, sessionStorageSet } from './utilitaires.js';
import { renderNav, closeMenu } from './icones.js';
import { viewHome, viewLegacyRedirect } from './accueil-site.js';
import { viewCatalog } from './catalogue.js';
import { viewBook } from './fiche-livre.js';
import { viewKobo, viewKoboDevice } from './kobo.js';
import { viewReader } from './liseuse-epub.js';
import { viewCopy } from './exemplaire.js';
import { viewInvite, viewLogin } from './connexion.js';
import { viewAccount } from './compte.js';
import { viewAdmin } from './administration.js';
import { viewBookForm } from './livre-formulaire.js';
import { viewImport } from './import.js';
import { viewIncomplete } from './incompletes.js';
import { viewLoans } from './prets.js';
import { viewBorrowers, viewBorrower } from './emprunteurs.js';
import { viewDashboard } from './accueil.js';
import { viewWishes } from './souhaits.js';
import { viewLabels } from './etiquettes.js';
import { viewStats } from './statistiques.js';
import { viewSettings } from './reglages.js';

// needs : 'user' (etre connecte), 'member' (compte de cette bibliotheque), 'manage'
// (la gerer : pas les lecteurs), 'config' (ses reglages), 'admin'.
const LIBRARY_ROUTES = [
  [/^\/?$/, viewCatalog],
  [/^\/invite\/([\w-]+)$/, viewInvite],
  [/^\/home$/, viewDashboard, 'user'],
  [/^\/book\/(\d+)$/, viewBook],
  [/^\/read\/(\d+)$/, viewReader],
  [/^\/kobo$/, viewKobo, 'member'],
  [/^\/kobo\/(\d+)$/, viewKoboDevice, 'member'],
  [/^\/book\/(\d+)\/edit$/, viewBookForm, 'manage'],
  [/^\/c\/([^/]+)$/, viewCopy],
  [/^\/login$/, viewLogin],
  [/^\/add$/, viewBookForm, 'manage'],
  [/^\/import$/, viewImport, 'manage'],
  [/^\/incomplete(?:\/(\w+))?$/, viewIncomplete, 'manage'],
  [/^\/loans$/, viewLoans, 'manage'],
  [/^\/borrowers$/, viewBorrowers, 'manage'],
  [/^\/borrower\/(\d+)$/, viewBorrower, 'manage'],
  [/^\/labels$/, viewLabels, 'manage'],
  [/^\/stats$/, viewStats, 'member'],
  [/^\/settings$/, viewSettings, 'config'],
  [/^\/account$/, viewAccount, 'user'],
  [/^\/wishes$/, viewWishes, 'user'],
  [/^\/admin$/, viewAdmin, 'admin'],
];
const HOME_ROUTES = [
  [/^\/?$/, viewHome],
  [/^\/invite\/([\w-]+)$/, viewInvite],
  [/^\/login$/, viewLogin],
  [/^\/account$/, viewAccount, 'user'],
  [/^\/wishes$/, viewWishes, 'user'],
  [/^\/admin$/, viewAdmin, 'admin'],
  // Anciennes etiquettes (d'avant les bibliotheques multiples) : #/c/CODE a la racine.
  [/^\/(c\/[^/]+|book\/\d+)$/, viewLegacyRedirect],
];

// Apres un changement de page : titre de l'onglet = titre de la page, et focus
// sur le contenu (sauf au premier affichage), pour les lecteurs d'ecran et le clavier.
let firstPage = true;
function announcePage() {
  const h1 = $('h1', view());
  const name = state.settings && state.settings.libraryName;
  const t = h1 ? h1.textContent.replace(/\?/g, '').trim() : '';
  document.title = t && t !== name ? `${t} – ${name || 'Bibliothèques'}` : (name || 'Bibliothèques');
  if (firstPage) { firstPage = false; return; }
  if (!view().contains(document.activeElement)) view().focus({ preventScroll: true });
}

// Nettoyage de la page quittee (ex. couper la camera du scan en serie).
let pageCleanup = null;
function onLeave(fn) { pageCleanup = fn; }
function leavePage() {
  if (pageCleanup) { try { pageCleanup(); } catch (e) { /* rien */ } pageCleanup = null; }
}

async function route() {
  closeMenu();
  leavePage();
  const path = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  renderNav();
  window.scrollTo(0, 0);
  for (const [re, fn, needs] of (LIBRARY ? LIBRARY_ROUTES : HOME_ROUTES)) {
    const m = path.match(re);
    if (!m) continue;
    if (needs && !state.user) {
      sessionStorageSet('mll-after-login', location.hash);
      return go('#/login');
    }
    if ((needs === 'member' && !isMember()) || (needs === 'manage' && !canManage()) || (needs === 'config' && !canConfigure()) || (needs === 'admin' && !isAdmin())) {
      view().innerHTML = `<div class="empty">Ton compte n'a pas accès à cette page.<br><br><a class="btn" href="#/">Retour</a></div>`;
      return;
    }
    view().innerHTML = '<p class="muted" role="status">Chargement…</p>';
    try {
      await fn(...m.slice(1));
      announcePage();
    } catch (err) {
      view().innerHTML = `<div class="error-box">${esc(err.message)}</div><a class="btn" href="#/">Retour</a>`;
    }
    return;
  }
  view().innerHTML = '<div class="empty">Page introuvable.</div>';
}

export { onLeave, leavePage, route };
