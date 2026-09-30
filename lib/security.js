// En-tetes de securite. Sur toutes les reponses : pas de deduction du type de contenu,
// pas d'adresse d'origine envoyee aux sites des couvertures. Sur les pages HTML : une
// politique de contenu (CSP) qui n'autorise que les scripts de l'application, filet de
// securite si une donnee etait un jour affichee sans echappement.
const crypto = require('crypto');

// Sites autorises a afficher l'application dans un cadre : elle-meme et Microsoft
// Teams (onglet « Site web »). MLL_FRAME_ANCESTORS remplace la liste (adresses
// separees par des espaces, ou * pour tout autoriser).
const DEFAULT_ANCESTORS = "'self' https://teams.microsoft.com https://*.teams.microsoft.com https://teams.live.com "
  + 'https://*.cloud.microsoft https://*.office.com https://*.microsoft365.com https://*.sharepoint.com';

function frameAncestors() {
  const custom = String(process.env.MLL_FRAME_ANCESTORS || '').trim();
  return custom && /^[\w'*:./ -]+$/.test(custom) ? custom : DEFAULT_ANCESTORS;
}

function headers(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  next();
}

// Politique de la page : a appeler avant d'envoyer du HTML. Renvoie le nonce a poser
// sur le script en ligne (configuration window.MLL). MLL_CSP=report : violations
// seulement signalees dans la console ; MLL_CSP=off : aucune politique.
function pagePolicy(res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const mode = process.env.MLL_CSP;
  if (mode === 'off') return nonce;
  const policy = [
    "default-src 'self'",
    // wasm-unsafe-eval : lecteur de codes-barres (zxing, WebAssembly).
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    // Styles en ligne de l'interface ; blob: = feuilles de style des epub (liseuse).
    "style-src 'self' 'unsafe-inline' blob:",
    // Couvertures proposees par les recherches en ligne : n'importe quel site https.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: blob:",
    "connect-src 'self' blob: data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors()}`,
  ].join('; ');
  res.set(mode === 'report' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', policy);
  return nonce;
}

module.exports = { headers, pagePolicy, frameAncestors };
