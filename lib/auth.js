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

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
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

function setSessionCookie(req, res, token, maxAgeMs) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', [
    `${COOKIE_NAME}=${token}`,
    `Path=${cookiePath(req)}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; '));
}

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  setSessionCookie(req, res, token, SESSION_TTL_MS);
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(req, res, '', 0);
}

// Renseigne req.user si la requete porte une session valide (prolongee au plus une
// fois par jour, pour ne pas ecrire en base a chaque requete).
function loadUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) {
    const row = db.prepare(`SELECT u.id, u.username, u.role, u.default_library_id, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
    if (row && row.expires_at > Date.now()) {
      req.user = { id: row.id, username: row.username, role: row.role, defaultLibraryId: row.default_library_id };
      if (row.expires_at - Date.now() < SESSION_TTL_MS - 24 * 60 * 60 * 1000) {
        db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_TTL_MS, sha256(token));
        setSessionCookie(req, res, token, SESSION_TTL_MS);
      }
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

// Un administrateur gere toutes les bibliotheques ; un gestionnaire, celles
// auxquelles il est lie.
function canManage(user, libraryId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!db.prepare('SELECT 1 FROM user_libraries WHERE user_id = ? AND library_id = ?').get(user.id, libraryId);
}

// Reglages et etiquettes : gestionnaires et administrateurs (pas les utilisateurs).
function canConfigure(user, libraryId) {
  return canManage(user, libraryId) && user.role !== 'user';
}

// Bibliotheques accessibles en gestion pour un compte.
function librariesOf(user) {
  if (!user) return [];
  return user.role === 'admin'
    ? db.prepare('SELECT id, slug, name, logo FROM libraries ORDER BY name COLLATE NOCASE').all()
    : db.prepare(`SELECT l.id, l.slug, l.name, l.logo FROM libraries l JOIN user_libraries ul ON ul.library_id = l.id
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
  canManage, canConfigure, librariesOf, rootPath, tooManyFailures, recordFailure,
};
