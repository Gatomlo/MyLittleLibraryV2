// En-tete : marque, navigation, menu du compte — module de l'interface (organisation : public/app/README.md).
import './scanner.js';
import { ROOT, LIBRARY, LIB, state } from './etat.js';
import { $, mediaSrc } from './utilitaires.js';
import { renderNav, renderAccount } from './icones.js';

function renderBrand() {
  const s = state.settings;
  $('#brand-name').textContent = s.libraryName;
  document.title = s.libraryName;
  const brand = $('.brand');
  brand.href = LIBRARY ? `${LIB}/#/${state.user ? 'home' : ''}` : `${ROOT}/#/`;
  // Reglage de la bibliotheque : nom et logo, nom seul ou logo seul (sans logo,
  // le nom reste affiche pour que l'en-tete ne soit jamais vide).
  const display = s.brandDisplay || 'both';
  const logo = $('#brand-logo');
  logo.hidden = !s.logoUrl || display === 'name';
  if (s.logoUrl) logo.src = mediaSrc(s.logoUrl);
  logo.alt = display === 'logo' ? s.libraryName : '';
  $('#brand-name').hidden = display === 'logo' && !!s.logoUrl;
  brand.classList.toggle('logo-only', display === 'logo' && !!s.logoUrl);
}

function renderHeader() {
  renderBrand();
  renderNav();
  renderAccount();
}

export { renderBrand, renderHeader };
