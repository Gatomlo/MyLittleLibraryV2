const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { db, tx, isValidSlug, uniqueSlug, MEDIA_DIR } = require('./lib/db');
const auth = require('./lib/auth');
const media = require('./lib/media');
const { createLibraryRouter, findLibrary, mediaUrl, str, intOrNull } = require('./lib/library-api');

// Filet de securite : une erreur imprevue ne doit jamais faire tomber tout le serveur.
process.on('uncaughtException', (err) => console.error('Erreur non interceptee (ignoree) :', err));
process.on('unhandledRejection', (err) => console.error('Promesse rejetee non geree (ignoree) :', err));

// Organisation des adresses (prefixees par /mylittlelibrary dans la passerelle) :
//   /                        accueil : liste des bibliotheques, connexion, administration
//   /api/...                 comptes, sessions, administration (global)
//   /<bibliotheque>/         application d'une bibliotheque (catalogue, gestion)
//   /<bibliotheque>/api/...  API de cette bibliotheque (voir lib/library-api.js)
//   /<bibliotheque>/embed.js catalogue a integrer dans WordPress / Divi
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const { httpError } = media;
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use(express.json({ limit: '8mb' }));
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '30d', immutable: true }));

// Scanner de codes-barres/QR servi en local : aucune dependance a un CDN externe.
function nodeModuleFile(...parts) {
  const candidates = [
    path.join(__dirname, 'node_modules', ...parts),
    path.join(__dirname, 'node_modules', 'barcode-detector', 'node_modules', ...parts),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}
app.get('/vendor/barcode-detector.js', (req, res) => res.sendFile(nodeModuleFile('barcode-detector', 'dist', 'iife', 'ponyfill.js')));
app.get('/vendor/quagga.min.js', (req, res) => res.sendFile(nodeModuleFile('@ericblade', 'quagga2', 'dist', 'quagga.min.js')));
app.get('/vendor/read-excel-file.min.js', (req, res) => res.sendFile(nodeModuleFile('read-excel-file', 'bundle', 'read-excel-file.min.js')));
app.get('/vendor/zxing_reader.wasm', (req, res) => res.type('application/wasm').sendFile(nodeModuleFile('zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm')));

// Les POST/PUT doivent etre en JSON : un formulaire d'un autre site ne peut pas en
// envoyer sans CORS (protection CSRF, avec SameSite=Lax). Un DELETE d'un autre site
// declenche de toute facon une verification CORS prealable, refusee.
function jsonOnly(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || req.is('application/json')) return next();
  res.status(415).json({ error: 'Requête JSON attendue.' });
}

function apiErrors(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err && /UNIQUE constraint failed: categories/.test(err.message)) err = httpError(409, 'Cette catégorie existe déjà.');
  if (err && /UNIQUE constraint failed: users/.test(err.message)) err = httpError(409, 'Cet identifiant est déjà utilisé.');
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Erreur interne du serveur.' : err.message });
}

// ================= API globale : comptes et administration =================
const api = express.Router();
app.use('/api', api);
api.use(auth.loadUser, jsonOnly);

function libraryInfo(l) {
  return { id: l.id, slug: l.slug, name: l.name, logoUrl: mediaUrl(l.logo) };
}

// Adresses des bibliotheques (sans leurs noms) : sert uniquement a rediriger les
// etiquettes imprimees avant les bibliotheques multiples (#/c/CODE a la racine).
api.get('/libraries', (req, res) => {
  res.json(db.prepare('SELECT id, slug FROM libraries ORDER BY id').all());
});

api.get('/auth/status', (req, res) => {
  const hasUser = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  res.json({
    user: req.user || null,
    needsSetup: !hasUser,
    libraries: auth.librariesOf(req.user).map(libraryInfo),
  });
});

function readPassword(v) {
  const password = String(v || '');
  if (password.length < 8) throw httpError(400, 'Le mot de passe doit faire 8 caractères minimum.');
  return password;
}

function readUsername(v) {
  const username = str(v, 60);
  if (!username) throw httpError(400, "L'identifiant est requis.");
  return username;
}

function createLibrary(name, slug) {
  const libName = str(name, 120);
  if (!libName) throw httpError(400, 'Le nom de la bibliothèque est requis.');
  let finalSlug = slug ? str(slug, 60).toLowerCase() : uniqueSlug(libName);
  if (slug) checkSlugAvailable(finalSlug, 0);
  const id = Number(db.prepare('INSERT INTO libraries (slug, name) VALUES (?, ?)').run(finalSlug, libName).lastInsertRowid);
  return db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
}

function checkSlugAvailable(slug, libraryId) {
  if (!isValidSlug(slug)) throw httpError(400, 'Adresse invalide : lettres minuscules, chiffres et tirets (et pas un mot réservé comme « api » ou « admin »).');
  if (db.prepare('SELECT 1 FROM libraries WHERE slug = ? AND id <> ?').get(slug, libraryId)
    || db.prepare('SELECT 1 FROM library_slug_history WHERE slug = ? AND library_id <> ?').get(slug, libraryId)) {
    throw httpError(409, 'Cette adresse est déjà utilisée par une autre bibliothèque.');
  }
}

// Premier demarrage : creation du compte administrateur et de la premiere
// bibliotheque, possible uniquement tant qu'aucun compte n'existe.
api.post('/auth/setup', h((req, res) => {
  const username = readUsername(req.body.username);
  const password = readPassword(req.body.password);
  const result = tx(() => {
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw httpError(403, 'Un compte existe déjà.');
    const lib = db.prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get()
      || createLibrary(req.body.libraryName || 'Bibliothèque du bureau');
    const id = Number(db.prepare("INSERT INTO users (username, password_hash, role, default_library_id) VALUES (?, ?, 'admin', ?)")
      .run(username, auth.hashPassword(password), lib.id).lastInsertRowid);
    db.prepare('INSERT INTO user_libraries (user_id, library_id) VALUES (?, ?)').run(id, lib.id);
    return { id, lib };
  });
  auth.createSession(req, res, result.id);
  res.json({ user: { id: result.id, username, role: 'admin', defaultLibraryId: result.lib.id }, library: libraryInfo(result.lib) });
}));

api.post('/auth/login', h(async (req, res) => {
  const username = str(req.body.username, 60);
  const password = String(req.body.password || '');
  if (auth.tooManyFailures(username)) throw httpError(429, 'Trop de tentatives, réessaie dans 15 minutes.');
  const user = db.prepare('SELECT id, username, role, default_library_id, password_hash FROM users WHERE username = ?').get(username);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    auth.recordFailure(username);
    await new Promise((r) => setTimeout(r, 600));
    throw httpError(401, 'Identifiant ou mot de passe incorrect.');
  }
  auth.createSession(req, res, user.id);
  const u = { id: user.id, username: user.username, role: user.role, defaultLibraryId: user.default_library_id };
  res.json({ user: u, libraries: auth.librariesOf(u).map(libraryInfo) });
}));

api.post('/auth/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

// ---------- Mon compte ----------
api.use('/me', auth.requireAuth);

api.post('/me/password', h((req, res) => {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(String(req.body.current || ''), user.password_hash)) throw httpError(400, 'Mot de passe actuel incorrect.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(readPassword(req.body.password)), req.user.id);
  res.json({ ok: true });
}));

api.put('/me/default-library', h((req, res) => {
  const libId = intOrNull(req.body.libraryId);
  if (libId && !auth.canManage(req.user, libId)) throw httpError(403, "Tu n'as pas accès à cette bibliothèque.");
  db.prepare('UPDATE users SET default_library_id = ? WHERE id = ?').run(libId, req.user.id);
  res.json({ ok: true });
}));

// ---------- Administration ----------
api.use('/admin', auth.requireAdmin);

function userRow(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    defaultLibraryId: u.default_library_id,
    createdAt: u.created_at,
    libraryIds: db.prepare('SELECT library_id FROM user_libraries WHERE user_id = ?').all(u.id).map((r) => r.library_id),
  };
}

api.get('/admin/users', (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(userRow));
});

function applyUserLinks(userId, body) {
  const ids = (Array.isArray(body.libraryIds) ? body.libraryIds : []).map(intOrNull).filter(Boolean);
  const existing = new Set(db.prepare('SELECT id FROM libraries').all().map((l) => l.id));
  db.prepare('DELETE FROM user_libraries WHERE user_id = ?').run(userId);
  const link = db.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)');
  ids.filter((id) => existing.has(id)).forEach((id) => link.run(userId, id));
  let def = intOrNull(body.defaultLibraryId);
  const linked = ids.filter((id) => existing.has(id));
  if (def && !linked.includes(def) && body.role !== 'admin') def = null;
  if (!def && linked.length) def = linked[0];
  db.prepare('UPDATE users SET default_library_id = ? WHERE id = ?').run(def || null, userId);
}

function readRole(v) {
  return v === 'admin' ? 'admin' : 'manager';
}

function adminCount(exceptId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id <> ?").get(exceptId).n;
}

api.post('/admin/users', h((req, res) => {
  const username = readUsername(req.body.username);
  const password = readPassword(req.body.password);
  const role = readRole(req.body.role);
  const id = tx(() => {
    const newId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, auth.hashPassword(password), role).lastInsertRowid);
    applyUserLinks(newId, { ...req.body, role });
    return newId;
  });
  res.json(userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

api.put('/admin/users/:id', h((req, res) => {
  const id = intOrNull(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw httpError(404, 'Compte introuvable.');
  const role = readRole(req.body.role);
  if (user.role === 'admin' && role !== 'admin' && adminCount(id) === 0) throw httpError(409, 'Il doit rester au moins un administrateur.');
  tx(() => {
    db.prepare('UPDATE users SET username = ?, role = ? WHERE id = ?').run(readUsername(req.body.username), role, id);
    if (req.body.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(readPassword(req.body.password)), id);
      if (id !== req.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    applyUserLinks(id, { ...req.body, role });
  });
  res.json(userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

api.delete('/admin/users/:id', h((req, res) => {
  const id = intOrNull(req.params.id);
  if (id === req.user.id) throw httpError(409, 'Tu ne peux pas supprimer ton propre compte.');
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (!user) throw httpError(404, 'Compte introuvable.');
  if (user.role === 'admin' && adminCount(id) === 0) throw httpError(409, 'Il doit rester au moins un administrateur.');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
}));

api.get('/admin/libraries', (req, res) => {
  res.json(db.prepare(`SELECT l.*,
      (SELECT COUNT(*) FROM books b WHERE b.library_id = l.id) AS books,
      (SELECT COUNT(*) FROM copies c WHERE c.library_id = l.id) AS copies,
      (SELECT COUNT(*) FROM user_libraries ul WHERE ul.library_id = l.id) AS users
    FROM libraries l ORDER BY l.name COLLATE NOCASE`).all()
    .map((l) => ({ ...libraryInfo(l), books: l.books, copies: l.copies, users: l.users, createdAt: l.created_at })));
});

// Adresse proposee pour un nom (apercu dans le formulaire de creation).
api.get('/admin/slug', (req, res) => res.json({ slug: uniqueSlug(req.query.name || '', intOrNull(req.query.id) || 0) }));

api.post('/admin/libraries', h((req, res) => {
  const lib = tx(() => {
    const created = createLibrary(req.body.name, req.body.slug);
    // Le createur est lie a la nouvelle bibliotheque (elle apparait dans son menu).
    db.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)').run(req.user.id, created.id);
    return created;
  });
  res.json(libraryInfo(lib));
}));

// Changement volontaire d'adresse : l'ancienne reste redirigee (etiquettes deja
// imprimees, shortcode WordPress) tant qu'elle n'est pas reprise.
api.put('/admin/libraries/:id', h((req, res) => {
  const id = intOrNull(req.params.id);
  const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
  if (!lib) throw httpError(404, 'Bibliothèque introuvable.');
  const name = req.body.name !== undefined ? str(req.body.name, 120) : lib.name;
  if (!name) throw httpError(400, 'Le nom de la bibliothèque est requis.');
  const slug = req.body.slug !== undefined ? str(req.body.slug, 60).toLowerCase() : lib.slug;
  tx(() => {
    if (slug !== lib.slug) {
      checkSlugAvailable(slug, id);
      db.prepare('DELETE FROM library_slug_history WHERE slug = ?').run(slug);
      db.prepare('INSERT OR REPLACE INTO library_slug_history (slug, library_id) VALUES (?, ?)').run(lib.slug, id);
    }
    db.prepare('UPDATE libraries SET name = ?, slug = ? WHERE id = ?').run(name, slug, id);
  });
  res.json(libraryInfo(db.prepare('SELECT * FROM libraries WHERE id = ?').get(id)));
}));

api.delete('/admin/libraries/:id', h((req, res) => {
  const id = intOrNull(req.params.id);
  const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
  if (!lib) throw httpError(404, 'Bibliothèque introuvable.');
  if (str(req.query.confirm, 120) !== lib.name) throw httpError(400, 'Confirme en tapant exactement le nom de la bibliothèque.');
  const covers = db.prepare('SELECT cover FROM books WHERE library_id = ? AND cover IS NOT NULL').all(id).map((r) => r.cover);
  tx(() => {
    db.prepare('DELETE FROM loans WHERE copy_id IN (SELECT id FROM copies WHERE library_id = ?)').run(id);
    db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
  });
  covers.concat(lib.logo || []).forEach((f) => media.remove(f));
  res.json({ ok: true });
}));

// Copie coherente de toute la base (toutes les bibliotheques) a telecharger.
api.get('/admin/backup', h((req, res) => {
  const file = path.join(os.tmpdir(), `mll-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const stamp = new Date().toISOString().slice(0, 10);
  res.download(file, `bibliotheques-${stamp}.db`, () => fs.rm(file, { force: true }, () => {}));
}));

api.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));
api.use(apiErrors);

// ================= Pages =================
// index.html est servi avec les chemins absolus de l'app et la bibliotheque courante
// (window.MLL) : la meme page sert l'accueil et chaque bibliotheque.
const INDEX_TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
function renderIndex(req, library) {
  const root = auth.rootPath(req);
  const config = JSON.stringify({ root, library: library ? { slug: library.slug, name: library.name, logoUrl: mediaUrl(library.logo) } : null })
    .replace(/</g, '\\u003c');
  const title = library ? library.name.replace(/[<&]/g, '') : 'Bibliothèques';
  return INDEX_TEMPLATE
    .replace(/\{\{ROOT\}\}/g, root)
    .replace('{{TITLE}}', title)
    .replace('{{CONFIG}}', config);
}

app.get('/', (req, res) => res.type('html').send(renderIndex(req, null)));

// ---------- Une bibliotheque ----------
app.use('/:slug/api', auth.loadUser, jsonOnly, createLibraryRouter(), apiErrors);
app.use('/:slug/media', express.static(MEDIA_DIR, { maxAge: '30d', immutable: true }));
app.get('/:slug/embed.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'embed.js')));

function libraryPage(req, res, next) {
  if (!isValidSlug(String(req.params.slug).toLowerCase())) return next();
  const found = findLibrary(req.params.slug);
  if (!found) return next();
  // Ancienne adresse (ou majuscules) : redirection vers l'adresse actuelle.
  if (found.moved || req.params.slug !== found.library.slug || !req.originalUrl.split('?')[0].endsWith('/')) {
    return res.redirect(301, `${auth.rootPath(req)}/${found.library.slug}/`);
  }
  res.type('html').send(renderIndex(req, found.library));
}
app.get('/:slug', libraryPage);
app.get('/:slug/', libraryPage);

app.use((req, res) => res.status(404).type('html').send(
  `<!doctype html><meta charset="utf-8"><title>Introuvable</title><p style="font-family:sans-serif;padding:24px">Page introuvable. <a href="${auth.rootPath(req)}/">Voir les bibliothèques</a></p>`));

// Lance seul en developpement (node server.js) ; charge par la passerelle, on se
// contente d'exporter l'app, c'est elle qui ecoute sur le port.
if (require.main === module) {
  app.listen(PORT, () => console.log(`MyLittleLibrary disponible sur http://localhost:${PORT}`));
}

module.exports = app;
