// Mot de passe oublie : lien de reinitialisation envoye par le SMTP d'une bibliotheque
// du compte (jamais par un autre serveur, voir lib/mail.js). Bibliotheque : celle de
// la page ou la demande est faite (si le compte en est membre), sinon la bibliotheque
// par defaut du compte, sinon sa seule bibliotheque. Pas d'envoi possible : rien.
// L'administrateur peut aussi creer un lien a transmettre lui-meme.
const crypto = require('crypto');
const { db, tx, getSetting } = require('./db');
const auth = require('./auth');
const mail = require('./mail');
const { findLibrary } = require('./library/catalog');
const { httpError, str, intOrNull, asyncHandler: h, limiter } = require('./util');

const MAIL_TTL_MS = 60 * 60 * 1000; // lien envoye par e-mail : 1 h
const ADMIN_TTL_MS = 48 * 60 * 60 * 1000; // lien cree par l'administrateur : 48 h

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Nouveau jeton (les precedents du compte ne servent plus).
function createToken(userId, libraryId, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?').run(userId, Date.now());
  db.prepare('INSERT INTO password_resets (token_hash, user_id, library_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, libraryId || null, Date.now() + ttlMs);
  return token;
}

// Adresse publique de l'app (reglee par l'administrateur) : les liens envoyes ne
// dependent jamais de l'en-tete Host de la requete.
const publicUrl = () => (getSetting('publicUrl') || '').replace(/\/+$/, '');

function libraryFor(user, slug) {
  const member = (id) => db.prepare('SELECT 1 FROM user_libraries WHERE user_id = ? AND library_id = ?').get(user.id, id);
  const byId = (id) => db.prepare('SELECT * FROM libraries WHERE id = ?').get(id) || null;
  if (slug) {
    const found = findLibrary(slug);
    return found && (user.role === 'admin' || member(found.library.id)) ? found.library : null;
  }
  if (user.default_library_id) return byId(user.default_library_id);
  const links = db.prepare('SELECT library_id FROM user_libraries WHERE user_id = ?').all(user.id);
  return links.length === 1 ? byId(links[0].library_id) : null;
}

async function sendResetMail(login, slug) {
  const user = db.prepare('SELECT id, username, email, role, default_library_id FROM users WHERE username = ?1 OR email = ?1 COLLATE NOCASE').get(login);
  if (!user || !user.email) return;
  const lib = libraryFor(user, slug);
  const base = publicUrl();
  if (!lib || !base || mail.mailStatus(lib.id) !== 'active') return;
  const token = createToken(user.id, lib.id, MAIL_TTL_MS);
  const url = `${base}/${lib.slug}/#/reset/${token}`;
  await mail.sendMail(lib.id, {
    to: user.email, kind: 'reset', userId: user.id,
    subject: `${lib.name} : réinitialisation du mot de passe`,
    text: `Bonjour ${user.username},\n\nUne réinitialisation du mot de passe de ton compte « ${user.username} » a été demandée sur ${lib.name}.\n\n`
      + `Pour choisir un nouveau mot de passe, ouvre ce lien (valable 1 heure) :\n${url}\n\n`
      + "Si tu n'es pas à l'origine de cette demande, ignore ce message : ton mot de passe reste inchangé.",
  });
}

// Demandes par identifiant (3 par heure) et au total (60 par heure).
const requests = limiter(60 * 60 * 1000);
function requestAllowed(login) {
  const key = 'f:' + login.toLowerCase();
  if (requests.count(key) >= 3 || requests.count('*') >= 60) return false;
  requests.hit(key);
  requests.hit('*');
  return true;
}

function registerPasswordReset(api, { readPassword, libraryInfo }) {
  // Toujours la meme reponse, tout de suite : elle ne revele pas si le compte existe,
  // a une adresse ou si l'envoi a reussi.
  api.post('/auth/forgot', (req, res) => {
    const login = str(req.body.login, 200);
    const slug = str(req.body.library, 60);
    res.json({ ok: true });
    if (!login || !requestAllowed(login)) return;
    sendResetMail(login, slug).catch((e) => console.error('Mot de passe oublié :', e.message));
  });

  api.post('/auth/reset', h(async (req, res) => {
    const token = String(req.body.token || '');
    const row = /^[a-f0-9]{64}$/.test(token)
      && db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?').get(sha256(token), Date.now());
    if (!row) throw httpError(400, "Ce lien de réinitialisation n'est plus valable : refais une demande.");
    const hash = await auth.hashPasswordAsync(readPassword(req.body.password));
    tx(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);
      // Toutes les sessions du compte sont fermees (appareil perdu, intrusion...).
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    });
    auth.createSession(req, res, row.user_id);
    const u = db.prepare('SELECT id, username, role, default_library_id, email FROM users WHERE id = ?').get(row.user_id);
    const user = { id: u.id, username: u.username, role: u.role, defaultLibraryId: u.default_library_id, email: u.email || '' };
    res.json({ user, libraries: auth.librariesOf(user).map(libraryInfo) });
  }));

  // Lien cree par l'administrateur (a transmettre lui-meme) : ouvert dans la
  // bibliotheque par defaut du compte.
  api.post('/admin/users/:id/reset-link', h((req, res) => {
    const user = db.prepare('SELECT id, default_library_id FROM users WHERE id = ?').get(intOrNull(req.params.id));
    if (!user) throw httpError(404, 'Compte introuvable.');
    const lib = user.default_library_id && db.prepare('SELECT slug FROM libraries WHERE id = ?').get(user.default_library_id);
    res.json({ token: createToken(user.id, user.default_library_id, ADMIN_TTL_MS), slug: lib ? lib.slug : null, hours: ADMIN_TTL_MS / 3600000 });
  }));
}

module.exports = { registerPasswordReset, publicUrl };
