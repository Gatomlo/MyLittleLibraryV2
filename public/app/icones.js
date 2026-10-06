// Icones — module de l'interface (organisation : public/app/README.md).
import './entete.js';
import { ROOT, LIBRARY, libUrl, state, pending, isAdmin, libRole, isMember, canManage, canConfigure, roleLabel, features } from './etat.js';
import { $, $$, view, esc, gapi, toast, go } from './utilitaires.js';
import { scanConf, SCAN_TITLES, refreshLoanBadge } from './scanner.js';
import { renderHeader } from './entete.js';
import { TOUCH_ONLY, kobo, koboOn, koboSavedInfo, reconnectKobo, scanKobo, ejectKobo, koboSettingsTarget, openKoboSettings } from './kobo.js';
import { openHomeCustomize } from './accueil.js';
import { canInstall, installApp } from './installation.js';

// Traces au style Lucide (licence ISC), 24x24, trait de 2.
const ICON_PATHS = {
  catalog: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  add: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/>',
  import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  loans: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  borrowers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  labels: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17 21h4v-3"/>',
  kobo: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 7h6"/><path d="M9 11h6"/><path d="M9 15h3"/>',
  stats: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  install: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  admin: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  edit: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  incomplete: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  wish: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  todo: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  goal: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  idea: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 8v8M12 8v8M16 8v8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  image: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  select: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="9" rx="1"/><rect x="3" y="15" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/>',
  print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
  move: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/><path d="M5 5v14"/>',
};
function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}
// Libelle de bouton : icone + texte, icone seule sur smartphone (texte masque sous
// 760 px : le bouton doit alors porter un title ou un aria-label).
const iconText = (name, text, size = 16) => `${icon(name, size)}<span class="hide-mobile">${text}</span>`;
// Couleur de chaque page (teinte, fond pastel) : navigation et pastille du titre.
const PAGE_COLORS = {
  catalog: 'accent', kobo: 'grape', add: 'coral', import: 'sky', loans: 'sun', borrowers: 'grape', labels: 'rose', stats: 'sky', settings: 'accent',
  user: 'grape', admin: 'coral', login: 'accent', library: 'accent', edit: 'coral', incomplete: 'sun', wish: 'rose', home: 'accent',
};
const colorVars = (name) => { const c = PAGE_COLORS[name] || 'accent'; return `--c:var(--${c});--cs:var(--${c}-soft)`; };

// Pastille d'icone devant le titre (h1) de chaque page, selon l'adresse.
const TITLE_ICONS = [
  [/^\/book\/\d+\/edit$/, 'edit'], [/^\/add$/, 'add'], [/^\/import$/, 'import'], [/^\/incomplete/, 'incomplete'],
  [/^\/kobo/, 'kobo'], [/^\/loans$/, 'loans'], [/^\/borrowers?(\/|$)/, 'borrowers'], [/^\/labels$/, 'labels'], [/^\/stats$/, 'stats'],
  [/^\/settings$/, 'settings'], [/^\/account$/, 'user'], [/^\/admin$/, 'admin'], [/^\/login$/, 'login'], [/^\/wishes$/, 'wish'], [/^\/home$/, 'home'],
];
function decorateTitle() {
  const h1 = view().querySelector('h1');
  if (!h1 || h1.querySelector('.h-icon')) return;
  const path = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  if (pending.loanFor && !path.startsWith('/c/') && path !== `/borrower/${pending.loanFor.id}`) pending.loanFor = null;
  let name = /^\/?$/.test(path) ? (LIBRARY ? 'catalog' : 'library') : null;
  for (const [re, n] of TITLE_ICONS) if (re.test(path)) { name = n; break; }
  if (!name) return;
  h1.insertAdjacentHTML('afterbegin', `<span class="h-icon" style="${colorVars(name)}">${icon(name, 22)}</span>`);
}
new MutationObserver(decorateTitle).observe(document.getElementById('view'), { childList: true });

function renderNav() {
  let links = [];
  if (LIBRARY) {
    // Lecteur : catalogue, statistiques et liseuse, sans les outils de gestion.
    const own = isMember() ? [...(features().stats ? [['#/stats', 'Statistiques', 'stats']] : []), ...(koboOn() ? [[`#/kobo/${kobo.device.id}`, kobo.device.name, 'kobo']] : [])] : [];
    links = canManage()
      ? [['#/', 'Catalogue', 'catalog'], ['#/add', 'Ajouter', 'add'], ['#/loans', 'Prêts', 'loans'], ['#/borrowers', 'Emprunteurs', 'borrowers'], ...own]
      : [['#/', 'Catalogue', 'catalog'], ...own];
    if (state.user) {
      links.splice(canManage() ? 4 : 1, 0, ['#/wishes', 'Souhaits', 'wish']);
      links.unshift(['#/home', 'Accueil', 'home']);
    }
  }
  let current = '#/' + (location.hash.replace(/^#\/?/, '').split('/')[0] || '');
  if (current === '#/import') current = '#/add'; // ajout multiple : sous-page de Ajouter
  $('#nav').innerHTML = links.map(([href, label, ic]) => {
    const active = href === current || href.startsWith(current + '/') || (href === '#/' && (current === '#/book' || current === '#/'));
    return `<a href="${href}" class="${active ? 'active' : ''}"${active ? ' aria-current="page"' : ''} style="${colorVars(ic)}">${icon(ic)}<span>${esc(label)}</span></a>`;
  }).join('');
  // Etiquettes et reglages : seulement dans le menu du compte (tous les ecrans).
  $('#nav').hidden = links.length <= 1;
  // Petit ecran : pages regroupees derriere le bouton menu (hamburger).
  $('#menu-btn').classList.toggle('has-links', links.length > 1);
  const activeLink = $('#nav a.active');
  $('#menu-btn').title = activeLink ? activeLink.textContent : 'Menu';
  $('#scan-btn').hidden = !canManage();
  $('#scan-btn').title = SCAN_TITLES[scanConf().codes];
  refreshLoanBadge();
}

const USER_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function renderAccount() {
  const box = $('#account');
  if (!state.user) {
    // Sur l'accueil, la page est deja celle de connexion.
    box.innerHTML = LIBRARY ? `<a class="btn btn-small account-btn" href="#/login">${USER_ICON}<span class="name">Connexion</span></a>` : '';
    return;
  }
  box.innerHTML = `<button class="btn btn-small account-btn" type="button" id="account-btn" aria-haspopup="true" aria-expanded="false">
    ${USER_ICON}<span class="name">${esc(state.user.username)}</span><span aria-hidden="true">▾</span></button>`;
  $('#account-btn').onclick = (e) => {
    e.stopPropagation();
    const open = $('#account .menu');
    if (open) { closeMenu(); return; }
    openMenu();
  };
}

function closeMenu() {
  const m = $('#account .menu');
  if (m) m.remove();
  const b = $('#account-btn');
  if (b) b.setAttribute('aria-expanded', 'false');
}

function openMenu() {
  const u = state.user;
  const def = u.defaultLibraryId;
  const libs = state.libraries.map((l) => `
    <div class="menu-item ${LIBRARY && l.slug === LIBRARY.slug ? 'current' : ''}" style="padding:0 4px 0 0">
      <a class="menu-item" href="${esc(libUrl(l.slug))}" style="flex:1;min-width:0">
        ${l.logoUrl ? `<img src="${esc(ROOT + '/' + l.logoUrl)}" alt="">` : ''}<span class="grow">${esc(l.name)}${isAdmin() ? '' : ` <span class="small muted">${roleLabel(l.role)}</span>`}</span></a>
      <button class="star ${l.id === def ? 'on' : ''}" data-default="${l.id}" title="${l.id === def ? 'Bibliothèque par défaut' : 'Définir comme bibliothèque par défaut'}">${l.id === def ? '★' : '☆'}</button>
    </div>`).join('');
  const koboDev = isMember() && features().kobo ? koboSettingsTarget() : null;
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = `
    <div class="menu-head"><strong>${esc(u.username)}</strong>${libRole() ? roleLabel(libRole()) : isAdmin() ? roleLabel('admin') : ''}</div>
    <div class="menu-sep"></div>
    <div class="menu-title">Mes bibliothèques</div>
    ${libs || '<p class="small muted" style="padding:4px 10px">Aucune bibliothèque liée à ce compte.</p>'}
    ${LIBRARY && canManage() ? `<div class="menu-sep"></div>
    <div class="menu-title">${esc(state.settings.libraryName)}</div>
    <a class="menu-item" href="#/labels">${icon('labels')}Étiquettes</a>
    ${canConfigure() ? `<a class="menu-item" href="#/settings">${icon('settings')}Réglages</a>` : ''}` : ''}
    ${isMember() && features().kobo && (!TOUCH_ONLY || koboDev) ? `<div class="menu-sep"></div>
    <div class="menu-title">Liseuses</div>
    ${!TOUCH_ONLY && koboSavedInfo && !koboOn() ? `<button class="menu-item" type="button" id="menu-kobo-reconnect">${icon('kobo')}Reconnecter ${esc(koboSavedInfo.name)}</button>` : ''}
    ${!TOUCH_ONLY ? `<button class="menu-item" type="button" id="menu-kobo-connect">${icon('kobo')}${koboOn() ? `Rescanner ${esc(kobo.device.name)}` : koboSavedInfo ? 'Brancher une autre liseuse' : 'Brancher une liseuse'}</button>` : ''}
    ${koboOn() && kobo.write ? `<button class="menu-item" type="button" id="menu-kobo-eject">${icon('kobo')}Terminer avec ${esc(kobo.device.name)}</button>` : ''}
    ${koboDev ? `<button class="menu-item" type="button" id="menu-kobo-settings">${icon('settings')}Paramètres de ${esc(koboDev.name)}</button>` : ''}
    <a class="menu-item" href="#/kobo">${icon('kobo')}Toutes les liseuses</a>` : ''}
    <div class="menu-sep"></div>
    <a class="menu-item" href="#/account">${icon('user')}Mon compte</a>
    ${LIBRARY ? `<a class="menu-item" href="#/wishes">${icon('wish')}Mes souhaits</a>` : ''}
    ${LIBRARY ? `<button class="menu-item" type="button" id="menu-home-custom">${icon('home')}Personnaliser l'accueil</button>` : ''}
    ${canInstall() ? `<button class="menu-item" type="button" id="install-app">${icon('install')}Installer l'application</button>` : ''}
    ${u.role === 'admin' ? `<a class="menu-item" href="#/admin">${icon('admin')}Administration</a>` : ''}
    <button class="menu-item" type="button" id="logout">${icon('logout')}Déconnexion</button>`;
  $('#account').appendChild(menu);
  $('#account-btn').setAttribute('aria-expanded', 'true');
  menu.addEventListener('click', (e) => e.stopPropagation());
  $$('a', menu).forEach((a) => a.addEventListener('click', closeMenu));
  const koboMenuAction = (btn, fn) => { if (btn) btn.onclick = async () => {
    closeMenu();
    try {
      const d = await fn();
      toast(`Liseuse « ${d.name} » scannée. Quand tu as fini, clique sur « Terminer ».`);
      go(`#/kobo/${d.id}`);
    } catch (err) { if (err.name !== 'AbortError') toast(err.message, 'error'); }
  }; };
  // Rescanner la liseuse branchee : sans repasser par le choix du dossier.
  koboMenuAction($('#menu-kobo-connect', menu), () => (koboOn() && kobo.root ? scanKobo(kobo.root) : scanKobo()));
  koboMenuAction($('#menu-kobo-reconnect', menu), reconnectKobo);
  const eject = $('#menu-kobo-eject', menu);
  if (eject) eject.onclick = () => { closeMenu(); ejectKobo(); };
  const koboSettings = $('#menu-kobo-settings', menu);
  if (koboSettings) koboSettings.onclick = () => { closeMenu(); openKoboSettings(koboDev.id).catch((err) => toast(err.message, 'error')); };
  $$('[data-default]', menu).forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.default);
      try {
        await gapi('/api/me/default-library', { method: 'PUT', body: { libraryId: id } });
        state.user.defaultLibraryId = id;
        closeMenu();
        openMenu();
        toast('Bibliothèque par défaut enregistrée.');
      } catch (err) { toast(err.message, 'error'); }
    };
  });
  if ($('#install-app')) $('#install-app').onclick = () => { closeMenu(); installApp(); };
  if ($('#menu-home-custom')) $('#menu-home-custom').onclick = () => { closeMenu(); openHomeCustomize(); };
  $('#logout').onclick = async () => {
    closeMenu();
    await gapi('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    state.user = null;
    state.libraries = [];
    toast('Déconnecté.');
    renderHeader();
    go('#/');
  };
}
document.addEventListener('click', closeMenu);

// Menu hamburger (petit ecran) : ouvre / ferme la liste des pages.
function setNavOpen(open) {
  $('#nav').classList.toggle('open', open);
  $('#menu-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
  document.body.classList.toggle('nav-open', open);
}
$('#menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  closeMenu();
  setNavOpen(!$('#nav').classList.contains('open'));
});
$('#nav').addEventListener('click', (e) => { e.stopPropagation(); if (e.target.closest('a')) setNavOpen(false); });
document.addEventListener('click', () => setNavOpen(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNavOpen(false); });
window.addEventListener('hashchange', () => setNavOpen(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

export { icon, iconText, colorVars, renderNav, renderAccount, closeMenu };
