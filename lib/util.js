// Utilitaires communs aux modules du serveur : erreurs HTTP, lecture des saisies,
// cellules CSV, petit cache en memoire et limiteur de debit.

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function str(v, max = 500) {
  const s = v == null ? '' : String(v).trim();
  return s.slice(0, max);
}

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Gestionnaire de route asynchrone : une erreur (ou promesse rejetee) va a next().
const asyncHandler = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

// Cellule CSV (separateur ;). Un texte qui commence par = + - @ serait execute comme
// une formule a l'ouverture dans un tableur : il est precede d'une apostrophe (retiree
// a l'import, voir stripFormulaGuard). Les nombres (-12, +3,5) restent tels quels.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Valeur relue d'un fichier exporte : apostrophe de protection retiree.
function stripFormulaGuard(v) {
  return typeof v === 'string' && /^'[=+\-@]/.test(v) ? v.slice(1) : v;
}

// Cache en memoire a duree limitee (recherches en ligne). wrap(cle, fn) : la promesse
// en cours est partagee ; un echec n'est pas garde. Le resultat est partage entre les
// appelants : ne pas le modifier (ou le copier).
function ttlCache(ttlMs, { max = 500, keep = () => true } = {}) {
  const map = new Map();
  return {
    wrap(key, fn) {
      const hit = map.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;
      const value = Promise.resolve().then(fn);
      map.set(key, { value, expires: Date.now() + ttlMs });
      // Echec, ou resultat a ne pas garder (rien trouve : a retenter) : oublie.
      const forget = () => { if (map.get(key) && map.get(key).value === value) map.delete(key); };
      value.then((v) => { if (!keep(v)) forget(); }, forget);
      if (map.size > max) map.delete(map.keys().next().value);
      return value;
    },
    clear: () => map.clear(),
  };
}

// Compteur d'evenements par cle sur une fenetre glissante (tentatives de connexion,
// creations de compte). Les cles vides sont oubliees.
function limiter(windowMs) {
  const hits = new Map();
  const recent = (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  return {
    count: (key) => recent(key).length,
    hit: (key) => { hits.set(key, recent(key).concat(Date.now())); },
    reset: (key) => { hits.delete(key); },
    clear: () => hits.clear(),
  };
}

module.exports = { httpError, str, intOrNull, asyncHandler, csvCell, stripFormulaGuard, ttlCache, limiter };
