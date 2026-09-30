// Configuration et etat — module de l'interface (organisation : public/app/README.md).

// Configuration injectee par le serveur (window.MLL, voir sendIndex dans
// server.js) : ROOT = chemin de montage de l'app (ex. '/mylittlelibrary' dans la
// passerelle, '' seule) ; LIBRARY = bibliotheque de la page (null sur l'accueil).
const CONFIG = window.MLL || {};
const ROOT = typeof CONFIG.root === 'string' ? CONFIG.root : '';
const LIBRARY = CONFIG.library || null;
const LIB = LIBRARY ? `${ROOT}/${LIBRARY.slug}` : null;
// Fichiers de l'interface (scanner, liseuse...) : adresse versionnee, gardee en cache.
const ASSETS = typeof CONFIG.assets === 'string' ? CONFIG.assets : ROOT;
const libUrl = (slug) => `${ROOT}/${slug}/`;

const state = {
  user: null,
  needsSetup: false,
  libraries: [], // bibliotheques gerees par le compte connecte
  settings: LIBRARY ? { libraryName: LIBRARY.name, logoUrl: LIBRARY.logoUrl } : { libraryName: 'Bibliothèques', logoUrl: null },
  catalog: { q: '', category: '', status: '', sort: 'title', page: 1 },
  labels: { mode: 'pending', manual: [] },
};

// Donnees passees d'une page a la suivante. Un objet, pour que chaque module de
// l'interface puisse en modifier les proprietes (une variable importee ne se reaffecte pas).
const pending = {
  // Emprunteur choisi depuis sa fiche (« Prêter un livre ») : pre-rempli sur la page
  // de pret des exemplaires scannes ensuite ; oublie en quittant ces pages (route).
  loanFor: null,
  // ISBN scanne absent de la bibliotheque : pre-rempli sur la page Ajouter.
  addIsbn: null,
  // Souhait a ajouter a la bibliotheque (page Souhaits) : fiche pre-remplie, puis
  // souhait retire de la liste a l'enregistrement.
  wish: null,
  // Onglet ouvert par la page Prets quand on y arrive depuis l'accueil.
  loansTab: null,
};

const isAdmin = () => !!state.user && state.user.role === 'admin';
// Role du compte dans la bibliotheque de la page : admin, ou son role dans cette
// bibliotheque (manager | librarian | user) ; null si le compte n'y est pas lie.
const libRole = () => {
  if (!state.user || !LIBRARY) return null;
  if (isAdmin()) return 'admin';
  const l = state.libraries.find((x) => x.slug === LIBRARY.slug);
  return l ? l.role || 'user' : null;
};
// Compte de la bibliotheque de la page (lie a elle, ou administrateur).
const isMember = () => !!libRole();
// Gestion du catalogue, des prets et des etiquettes : tous sauf les lecteurs (role user).
const canManage = () => { const r = libRole(); return !!r && r !== 'user'; };
// Reglages de la bibliotheque : gestionnaires et administrateurs.
const canConfigure = () => ['admin', 'manager'].includes(libRole());
const LIBRARY_ROLES = ['user', 'librarian', 'manager'];
const ROLE_LABELS = { admin: 'Administrateur', manager: 'Gestionnaire', librarian: 'Bibliothécaire', user: 'Lecteur' };
const roleLabel = (r) => ROLE_LABELS[r] || ROLE_LABELS.manager;
const ROLE_HELP = {
  user: 'Lecteur : consulte le catalogue, avec ses statuts de lecture, ses souhaits, ses statistiques et sa liseuse. Ni ajout ni prêt.',
  librarian: 'Bibliothécaire : catalogue, ajouts, prêts, emprunteurs et étiquettes. Pas les réglages de la bibliothèque.',
  manager: 'Gestionnaire : tout dans ses bibliothèques, réglages compris.',
  admin: 'Administrateur : toutes les bibliothèques, les comptes et les sauvegardes.',
};
// Options de la bibliotheque (Reglages) : livres numeriques, statuts de lecture.
const features = () => (state.settings && state.settings.features) || {};
const statusesOn = () => isMember() && !!features().readingStatus;

const READING_LABELS = { to_read: 'À lire', reading: 'En cours', read: 'Lu', abandoned: 'Abandonné' };
const OPINION_LABELS = { liked: 'Aimé', disliked: 'Pas aimé' };
const OPINION_ICONS = { liked: '♥', disliked: '✕' };

export {
  ROOT, LIBRARY, LIB, ASSETS, libUrl, state, pending, isAdmin, libRole, isMember, canManage, canConfigure, LIBRARY_ROLES, roleLabel,
  ROLE_HELP, features, statusesOn, READING_LABELS, OPINION_LABELS, OPINION_ICONS,
};
