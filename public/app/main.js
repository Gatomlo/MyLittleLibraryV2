// Demarrage — module de l'interface (organisation : public/app/README.md).
import './installation.js';
import { LIBRARY, state } from './etat.js';
import { $, api, gapi, toast } from './utilitaires.js';
import { scanAndOpen } from './scanner.js';
import { renderHeader } from './entete.js';
import { route } from './routage.js';
import { koboRestore } from './kobo.js';
import { showBackupReminder } from './administration.js';
import { installApp } from './installation.js';

async function loadSettings() {
  if (!LIBRARY) return;
  try { state.settings = await api('/api/public/settings'); } catch (e) { /* valeurs injectees */ }
}

async function loadStatus() {
  try {
    const s = await gapi('/api/auth/status');
    state.user = s.user;
    state.needsSetup = s.needsSetup;
    state.libraries = s.libraries || [];
    state.backupReminder = !!s.backupReminder;
    state.mailErrors = s.mailErrors || [];
  } catch (e) { /* hors ligne */ }
}

// Bandeau hors connexion : consultation des pages deja vues, ecritures impossibles.
const offlineBar = document.createElement('div');
offlineBar.className = 'offline-bar no-print';
offlineBar.setAttribute('role', 'status');
offlineBar.textContent = 'Hors connexion : lecture seule, pages déjà consultées.';
offlineBar.hidden = navigator.onLine;
document.body.prepend(offlineBar);
window.addEventListener('offline', () => { offlineBar.hidden = false; });
window.addEventListener('online', () => { offlineBar.hidden = true; refreshedAt = 0; refreshIfStale(); });

$('#install-btn').onclick = () => installApp();
$('#scan-btn').onclick = () => scanAndOpen();

// Reglages de la bibliotheque et compte relus quand l'appli revient au premier plan
// (application installee laissee ouverte sur le telephone, autre onglet) ou a chaque
// changement de page, au plus une fois toutes les 30 s : un reglage modifie depuis un
// autre appareil (bouton Scanner, options...) s'applique sans recharger. Page
// reaffichee seulement si quelque chose a change et qu'aucune saisie n'est en cours.
let refreshedAt = Date.now();
async function refreshIfStale() {
  if (Date.now() - refreshedAt < 30000) return;
  refreshedAt = Date.now();
  const before = JSON.stringify([state.settings, state.user, state.libraries]);
  await Promise.all([loadSettings(), loadStatus()]);
  if (JSON.stringify([state.settings, state.user, state.libraries]) === before) return;
  renderHeader();
  const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!typing && !$('.modal-backdrop')) route();
}

(async function init() {
  await Promise.all([loadSettings(), loadStatus()]);
  renderHeader();
  if (LIBRARY && state.user && /^#?\/?$/.test(location.hash)) history.replaceState(null, '', '#/home');
  window.addEventListener('hashchange', () => { route(); refreshIfStale(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshIfStale(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) refreshIfStale(); });
  route();
  koboRestore();
  showBackupReminder();
  showMailErrors();
})();

// Administrateur : bibliotheques dont l'envoi des e-mails est en erreur (une fois par session).
function showMailErrors() {
  const names = state.mailErrors || [];
  try {
    if (!names.length || sessionStorage.getItem('mll-mail-errors-shown')) return;
    sessionStorage.setItem('mll-mail-errors-shown', '1');
  } catch (e) { /* stockage indisponible : message affiche */ }
  if (!names.length) return;
  toast(`Envoi des e-mails en erreur : ${names.join(', ')}. Voir Administration › E-mails.`, 'error');
}

export { loadSettings, loadStatus };
