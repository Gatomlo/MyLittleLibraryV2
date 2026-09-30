// Demarrage — module de l'interface (organisation : public/app/README.md).
import './installation.js';
import { LIBRARY, state } from './etat.js';
import { $, api, gapi } from './utilitaires.js';
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
  } catch (e) { /* hors ligne */ }
}

$('#install-btn').onclick = () => installApp();
$('#scan-btn').onclick = () => scanAndOpen();

(async function init() {
  await Promise.all([loadSettings(), loadStatus()]);
  renderHeader();
  if (LIBRARY && state.user && /^#?\/?$/.test(location.hash)) history.replaceState(null, '', '#/home');
  window.addEventListener('hashchange', route);
  route();
  koboRestore();
  showBackupReminder();
})();

export { loadSettings, loadStatus };
