// Installation (ecran d'accueil) — module de l'interface (organisation : public/app/README.md).
import './reglages.js';
import { ROOT } from './etat.js';
import { $, toast } from './utilitaires.js';

// Android / Chrome / Edge : invite native (beforeinstallprompt). iPhone / iPad :
// pas d'invite, on explique la marche a suivre dans Safari.
let installPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canInstall = () => !isStandalone() && (!!installPrompt || isIos());
// Bouton "Installer" de l'en-tete : seulement quand le navigateur propose l'installation.
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#install-btn').hidden = false; });
window.addEventListener('appinstalled', () => { installPrompt = null; $('#install-btn').hidden = true; toast('Application installée.'); });
async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    $('#install-btn').hidden = true;
    return;
  }
  alert('Pour installer l\'application sur cet appareil :\n\n1. Ouvre cette page dans Safari.\n2. Touche le bouton Partager (carré avec une flèche).\n3. Choisis « Sur l\'écran d\'accueil ».');
}
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${ROOT}/sw.js`, { scope: `${ROOT}/` }).catch(() => {}));
}
if (isStandalone()) document.documentElement.classList.add('standalone');

export { canInstall, installApp };
