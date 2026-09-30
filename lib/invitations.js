// Liens d'invitation : un administrateur cree un lien pour une bibliotheque et un
// role ; la personne qui l'ouvre choisit son identifiant et son mot de passe, et
// son compte est lie a la bibliotheque avec ce role. Un compte deja connecte peut
// aussi rejoindre la bibliotheque (son role n'y est jamais abaisse ni releve s'il y
// est deja). Lien valable quelques jours, utilisable plusieurs fois, revocable.
// Routes montees sur l'API globale, voir server.js.
const crypto = require('crypto');
const { db, tx } = require('./db');
const auth = require('./auth');
const { httpError } = require('./media');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
const MAX_DAYS = 90;

// Lien encore valable (avec sa bibliotheque), sinon null.
function findInvitation(token) {
  if (!/^[\w-]{20,80}$/.test(String(token || ''))) return null;
  return db.prepare(`SELECT i.*, l.slug, l.name, l.logo FROM invitations i JOIN libraries l ON l.id = i.library_id
    WHERE i.token = ? AND i.expires_at > datetime('now')`).get(token) || null;
}

// Bibliotheque du lien (i.id est celui du lien, i.role le role propose).
const libOf = (i) => ({ id: i.library_id, slug: i.slug, name: i.name, logo: i.logo });

function rowOut(i) {
  return {
    id: i.id, token: i.token, role: auth.libraryRole(i.role), uses: i.uses, createdAt: i.created_at, expiresAt: i.expires_at,
    library: { id: i.library_id, slug: i.slug, name: i.name },
  };
}

// readUsername, readPassword, libraryInfo : ceux de server.js.
function registerInvitations(api, { readUsername, readPassword, libraryInfo }) {
  // ---------- Administration ----------
  const list = () => db.prepare(`SELECT i.*, l.slug, l.name FROM invitations i JOIN libraries l ON l.id = i.library_id
    WHERE i.expires_at > datetime('now') ORDER BY i.created_at DESC, i.id DESC`).all().map(rowOut);

  api.get('/admin/invitations', (req, res) => {
    db.prepare("DELETE FROM invitations WHERE expires_at <= datetime('now')").run();
    res.json(list());
  });

  api.post('/admin/invitations', h((req, res) => {
    const libraryId = intOrNull(req.body.libraryId);
    if (!libraryId || !db.prepare('SELECT 1 FROM libraries WHERE id = ?').get(libraryId)) throw httpError(400, 'Bibliothèque inconnue.');
    const days = Math.min(intOrNull(req.body.days) || 7, MAX_DAYS);
    db.prepare(`INSERT INTO invitations (token, library_id, role, created_by, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))`)
      .run(crypto.randomBytes(24).toString('base64url'), libraryId, auth.libraryRole(req.body.role), req.user.id, `+${days} days`);
    res.json(list());
  }));

  api.delete('/admin/invitations/:id', (req, res) => {
    db.prepare('DELETE FROM invitations WHERE id = ?').run(intOrNull(req.params.id));
    res.json(list());
  });

  // ---------- Lien ouvert (sans connexion) ----------
  api.get('/invitations/:token', h((req, res) => {
    const inv = findInvitation(req.params.token);
    if (!inv) throw httpError(404, "Ce lien d'invitation n'est plus valable.");
    res.json({
      library: libraryInfo(libOf(inv)), role: auth.libraryRole(inv.role),
      member: !!req.user && auth.isMember(req.user, inv.library_id),
    });
  }));

  // Nouveau compte (identifiant + mot de passe), ou compte connecte qui rejoint.
  api.post('/invitations/:token', h((req, res) => {
    const inv = findInvitation(req.params.token);
    if (!inv) throw httpError(404, "Ce lien d'invitation n'est plus valable.");
    const role = auth.libraryRole(inv.role);
    const link = (userId) => {
      const r = db.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id, role) VALUES (?, ?, ?)').run(userId, inv.library_id, role);
      db.prepare('UPDATE users SET default_library_id = COALESCE(default_library_id, ?) WHERE id = ?').run(inv.library_id, userId);
      if (r.changes) db.prepare('UPDATE invitations SET uses = uses + 1 WHERE id = ?').run(inv.id);
    };
    let user = req.user;
    if (user && !req.body.username) {
      tx(() => link(user.id));
    } else {
      const username = readUsername(req.body.username);
      const password = readPassword(req.body.password);
      const id = tx(() => {
        if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw httpError(409, 'Cet identifiant est déjà pris.');
        const newId = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')")
          .run(username, auth.hashPassword(password)).lastInsertRowid);
        link(newId);
        return newId;
      });
      auth.createSession(req, res, id);
      user = { id, username, role: 'user', defaultLibraryId: inv.library_id };
    }
    res.json({ user, libraries: auth.librariesOf(user).map(libraryInfo), library: libraryInfo(libOf(inv)) });
  }));
}

module.exports = { registerInvitations };
