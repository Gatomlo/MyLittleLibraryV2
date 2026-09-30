// Authentification : un compte (ou plus) en base, mot de passe hache avec scrypt,
// sessions persistantes en base (survivent au redemarrage de la passerelle).
const crypto = require('crypto');
const { db } = require('./db');

const COOKIE_NAME = 'mll_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Toutes les valeurs du cookie de session : le navigateur peut en envoyer deux
// (ancien cookie non partitionne + cookie partitionne, voir setSessionCookie).
function sessionTokens(header) {
  const out = [];
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) {
      try { out.push(decodeURIComponent(part.slice(i + 1).trim())); } catch (e) { /* ignore */ }
    }
  });
  return out.filter(Boolean);
}

// Chemin de montage de l'app (ex. /mylittlelibrary dans la passerelle, '' seule).
function rootPath(req) {
  const m = req.app && req.app.mountpath;
  return typeof m === 'string' && m !== '/' ? m : '';
}

// Le cookie vaut pour toute l'app (toutes les bibliotheques) mais pas pour les
// autres outils de la passerelle.
function cookiePath(req) {
  return rootPath(req) + '/';
}

// En HTTPS, SameSite=None + Partitioned : le cookie est aussi envoye quand l'app
// est affichee dans un cadre d'un autre site (onglet « Site web » de Teams, etc.).
// La protection CSRF reste assuree par jsonOnly (server.js). En HTTP (local), Lax.
function setSessionCookie(req, res, token, maxAgeMs) {
  const secure = req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
  const base = [`${COOKIE_NAME}=${token}`, `Path=${cookiePath(req)}`, `Max-Age=${Math.floor(maxAgeMs / 1000)}`, 'HttpOnly'];
  if (!secure) return res.append('Set-Cookie', [...base, 'SameSite=Lax'].join('; '));
  res.append('Set-Cookie', [...base, 'SameSite=None', 'Secure', 'Partitioned'].join('; '));
  // Efface l'eventuel ancien cookie non partitionne (SameSite=Lax), distinct pour le navigateur.
  res.append('Set-Cookie', [`${COOKIE_NAME}=`, `Path=${cookiePath(req)}`, 'Max-Age=0', 'HttpOnly', 'SameSite=Lax', 'Secure'].join('; '));
}

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  setSessionCookie(req, res, token, SESSION_TTL_MS);
}

function destroySession(req, res) {
  for (const token of sessionTokens(req.headers.cookie)) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(req, res, '', 0);
}

// Renseigne req.user si la requete porte une session valide (prolongee au plus une
// fois par jour, pour ne pas ecrire en base a chaque requete).
function loadUser(req, res, next) {
  for (const token of sessionTokens(req.headers.cookie)) {
    const row = db.prepare(`SELECT u.id, u.username, u.role, u.default_library_id, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
    if (row && row.expires_at > Date.now()) {
      req.user = { id: row.id, username: row.username, role: row.role, defaultLibraryId: row.default_library_id };
      if (row.expires_at - Date.now() < SESSION_TTL_MS - 24 * 60 * 60 * 1000) {
        db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_TTL_MS, sha256(token));
        setSessionCookie(req, res, token, SESSION_TTL_MS);
      }
      break;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé aux administrateurs.' });
  next();
}

// Compte : admin (tout, toutes les bibliotheques) ou user (compte ordinaire). Le
// role d'un compte ordinaire est propre a chaque bibliotheque (user_libraries.role) :
// manager (gestionnaire : tout), librarian (bibliothecaire : tout sauf les reglages),
// user (lecteur : catalogue en lecture seule + ses statuts, souhaits, stats, liseuse).
const LIBRARY_ROLES = ['manager', 'librarian', 'user'];
const libraryRole = (v, fallback = 'user') => (LIBRARY_ROLES.includes(v) ? v : fallback);

// Role du compte dans une bibliotheque : 'admin', un role de LIBRARY_ROLES, ou null
// (compte non lie).
function roleIn(user, libraryId) {
  if (!user) return null;
  if (user.role === 'admin') return 'admin';
  const link = db.prepare('SELECT role FROM user_libraries WHERE user_id = ? AND library_id = ?').get(user.id, libraryId);
  return link ? libraryRole(link.role) : null;
}

// Compte de la bibliotheque : lie a elle, ou administrateur (quel que soit le role).
function isMember(user, libraryId) {
  return !!roleIn(user, libraryId);
}

// Gestion du catalogue, des prets et des etiquettes : tous sauf les lecteurs.
function canManage(user, libraryId) {
  const role = roleIn(user, libraryId);
  return !!role && role !== 'user';
}

// Reglages de la bibliotheque : gestionnaires et administrateurs.
function canConfigure(user, libraryId) {
  const role = roleIn(user, libraryId);
  return role === 'admin' || role === 'manager';
}

// Bibliotheques du compte, avec son role dans chacune.
function librariesOf(user) {
  if (!user) return [];
  return user.role === 'admin'
    ? db.prepare("SELECT id, slug, name, logo, 'admin' AS role FROM libraries ORDER BY name COLLATE NOCASE").all()
    : db.prepare(`SELECT l.id, l.slug, l.name, l.logo, ul.role FROM libraries l JOIN user_libraries ul ON ul.library_id = l.id
        WHERE ul.user_id = ? ORDER BY l.name COLLATE NOCASE`).all(user.id);
}

// Limite les tentatives de connexion ratees (par identifiant ET globalement : l'IP
// cliente n'est pas fiable derriere le proxy de l'hebergeur).
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function tooManyFailures(username) {
  const now = Date.now();
  for (const [k, list] of failures) failures.set(k, list.filter((t) => now - t < WINDOW_MS));
  const perUser = (failures.get('u:' + username.toLowerCase()) || []).length;
  const global = (failures.get('*') || []).length;
  return perUser >= 8 || global >= 40;
}
function recordFailure(username) {
  for (const k of ['u:' + username.toLowerCase(), '*']) {
    failures.set(k, (failures.get(k) || []).concat(Date.now()));
  }
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, loadUser, requireAuth, requireAdmin,
  LIBRARY_ROLES, libraryRole, roleIn, isMember, canManage, canConfigure, librariesOf, rootPath, tooManyFailures, recordFailure,
};
