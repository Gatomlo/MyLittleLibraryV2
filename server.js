const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const JSZip = require('jszip');
const {
  db, tx, getSetting, setSetting, isValidSlug, uniqueSlug, inLibrary, libraryDb, libraryDir, removeLibraryFiles, removeUserData, backupTo,
} = require('./lib/db');
const auth = require('./lib/auth');
const archives = require('./lib/archives');
const { registerWishes } = require('./lib/wishes');
const { registerInvitations } = require('./lib/invitations');
const media = require('./lib/media');
const security = require('./lib/security');
const compression = require('compression');
const crypto = require('crypto');
const { createLibraryRouter, findLibrary, mediaUrl, str, intOrNull } = require('./lib/library-api');

// Erreur imprevue hors d'une requete : lance seul, le serveur la consigne et s'arrete
// (un processus dans un etat inconnu ne doit pas continuer a ecrire dans les bases).
// Charge par la passerelle, c'est elle qui decide : l'app n'installe rien de global.
if (require.main === module) {
  const fatal = (kind) => (err) => { console.error(`${kind} :`, err); process.exit(1); };
  process.on('uncaughtException', fatal('Erreur non interceptee'));
  process.on('unhandledRejection', fatal('Promesse rejetee non geree'));
}

// Organisation des adresses (prefixees par /mylittlelibrary dans la passerelle) :
//   /                        accueil : liste des bibliotheques, connexion, administration
//   /api/...                 comptes, sessions, administration (global)
//   /<bibliotheque>/         application d'une bibliotheque (catalogue, gestion)
//   /<bibliotheque>/api/...  API de cette bibliotheque (voir lib/library-api.js)
//   /<bibliotheque>/embed.js catalogue a integrer dans WordPress / Divi
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const { httpError, asyncHandler: h } = require('./lib/util');

app.disable('x-powered-by');
app.use(security.headers);
// Reponses compressees (gzip / brotli) : l'interface et les listes JSON pesent 4 a 5
// fois moins. Les fichiers deja compresses (images, epub, zip) sont laisses tels quels.
app.use(compression());
app.use(express.json({ limit: '8mb' }));

// Fichiers de l'interface (scripts, styles, polices, scanner et liseuse de
// public/vendor : aucune dependance a un CDN externe). Deux adresses :
//  - /v/<version>/... : la version fait partie de l'adresse (empreinte des fichiers), le
//    navigateur garde donc le fichier sans jamais le redemander ; une mise a jour de
//    l'app change la version (assetVersion), donc toutes les adresses ;
//  - /... (icones, sw.js, embed.js) : toujours revalides (reponse 304 si inchanges).
app.use('/v/:version', express.static(PUBLIC_DIR, { index: false, immutable: true, maxAge: '365d' }));
app.use(express.static(PUBLIC_DIR, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// Les POST/PUT doivent etre en JSON : un formulaire d'un autre site ne peut pas en
// envoyer sans CORS (protection CSRF, avec SameSite=Lax). Un DELETE d'un autre site
// declenche de toute facon une verification CORS prealable, refusee.
function jsonOnly(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || req.is('application/json')) return next();
  // Exceptions : envoi d'un fichier epub (PUT .../copies/:id/file, POST .../import/epub)
  // et base d'une liseuse Kobo (POST .../kobo/scan).
  if (req.method === 'PUT' && /\/copies\/\d+\/file$/.test(req.path) && req.is('application/epub+zip')) return next();
  if (req.method === 'POST' && /\/kobo\/scan$/.test(req.path) && req.is('application/x-sqlite3')) return next();
  if (req.method === 'POST' && /\/import\/epub$/.test(req.path) && req.is('application/epub+zip')) return next();
  // Archive d'une bibliotheque a restaurer (POST /api/admin/archives).
  if (req.method === 'POST' && req.path === '/admin/archives' && req.is('application/zip')) return next();
  res.status(415).json({ error: 'Requête JSON attendue.' });
}

function apiErrors(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err && /UNIQUE constraint failed: categories/.test(err.message)) err = httpError(409, 'Cette catégorie existe déjà.');
  if (err && /UNIQUE constraint failed: users/.test(err.message)) err = httpError(409, 'Cet identifiant est déjà utilisé.');
  if (err && /UNIQUE constraint failed: tags/.test(err.message)) err = httpError(409, 'Ce tag existe déjà.');
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Erreur interne du serveur.' : err.message });
}

// ================= API globale : comptes et administration =================
const api = express.Router();
app.use('/api', api);
api.use(auth.loadUser, jsonOnly);

// Logo relatif a la racine de l'app (chaque bibliotheque sert ses images).
function libraryInfo(l) {
  // role : celui du compte dans la bibliotheque (listes de auth.librariesOf).
  return { id: l.id, slug: l.slug, name: l.name, logoUrl: l.logo ? `${l.slug}/${mediaUrl(l.logo)}` : null, ...(l.role ? { role: l.role } : {}) };
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
    // Rappel mensuel de sauvegarde (administrateurs).
    backupReminder: !!req.user && req.user.role === 'admin' && archives.reminderDue(),
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
    db.prepare("INSERT INTO user_libraries (user_id, library_id, role) VALUES (?, ?, 'manager')").run(id, lib.id);
    return { id, lib };
  });
  libraryDb(result.lib.id); // dossier et base de la bibliotheque
  auth.createSession(req, res, result.id);
  res.json({ user: { id: result.id, username, role: 'admin', defaultLibraryId: result.lib.id }, library: libraryInfo(result.lib) });
}));

api.post('/auth/login', h(async (req, res) => {
  const username = str(req.body.username, 60);
  const password = String(req.body.password || '');
  if (auth.tooManyFailures(username)) throw httpError(429, 'Trop de tentatives pour ce compte, réessaie dans 15 minutes.');
  const user = db.prepare('SELECT id, username, role, default_library_id, password_hash FROM users WHERE username = ?').get(username);
  // Meme calcul que le compte existe ou non (voir verifyPasswordAsync).
  const valid = await auth.verifyPasswordAsync(password, user && user.password_hash);
  if (!user || !valid) {
    auth.recordFailure(username);
    await new Promise((r) => setTimeout(r, auth.failureDelay()));
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

api.post('/me/password', h(async (req, res) => {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!await auth.verifyPasswordAsync(String(req.body.current || ''), user.password_hash)) throw httpError(400, 'Mot de passe actuel incorrect.');
  const hash = await auth.hashPasswordAsync(readPassword(req.body.password));
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  // Les autres appareils connectes avec l'ancien mot de passe sont deconnectes.
  auth.revokeSessions(req.user.id, req.sessionHash);
  res.json({ ok: true });
}));

api.put('/me/default-library', h((req, res) => {
  const libId = intOrNull(req.body.libraryId);
  if (libId && !auth.isMember(req.user, libId)) throw httpError(403, "Tu n'as pas accès à cette bibliothèque.");
  db.prepare('UPDATE users SET default_library_id = ? WHERE id = ?').run(libId, req.user.id);
  res.json({ ok: true });
}));

// ---------- Listes de souhaits (par compte, voir lib/wishes.js) ----------
registerWishes(api);

// ---------- Administration ----------
api.use('/admin', auth.requireAdmin);

// role : admin | user (compte ordinaire) ; libraries : ses bibliotheques et son role
// dans chacune (manager | librarian | user).
function userRow(u) {
  const libraries = db.prepare('SELECT library_id AS id, role FROM user_libraries WHERE user_id = ?').all(u.id)
    .map((l) => ({ id: l.id, role: auth.libraryRole(l.role) }));
  return {
    id: u.id,
    username: u.username,
    role: u.role === 'admin' ? 'admin' : 'user',
    defaultLibraryId: u.default_library_id,
    createdAt: u.created_at,
    libraries,
    libraryIds: libraries.map((l) => l.id),
  };
}

api.get('/admin/users', (req, res) => {
  res.json(db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(userRow));
});

// body.libraries : [{ id, role }] (role du compte dans chaque bibliotheque).
function applyUserLinks(userId, body) {
  const existing = new Set(db.prepare('SELECT id FROM libraries').all().map((l) => l.id));
  const links = (Array.isArray(body.libraries) ? body.libraries : [])
    .map((l) => ({ id: intOrNull(l && l.id), role: auth.libraryRole(l && l.role) })).filter((l) => existing.has(l.id));
  db.prepare('DELETE FROM user_libraries WHERE user_id = ?').run(userId);
  const link = db.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id, role) VALUES (?, ?, ?)');
  links.forEach((l) => link.run(userId, l.id, l.role));
  let def = intOrNull(body.defaultLibraryId);
  const linked = links.map((l) => l.id);
  if (def && !linked.includes(def) && body.role !== 'admin') def = null;
  if (!def && linked.length) def = linked[0];
  db.prepare('UPDATE users SET default_library_id = ? WHERE id = ?').run(def || null, userId);
}

function readRole(v) {
  return v === 'admin' ? 'admin' : 'user';
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
  removeUserData(id);
  res.json({ ok: true });
}));

// ---------- Liens d'invitation (voir lib/invitations.js) ----------
registerInvitations(api, { readUsername, readPassword, libraryInfo });

api.get('/admin/libraries', (req, res) => {
  res.json(db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM user_libraries ul WHERE ul.library_id = l.id) AS users
    FROM libraries l ORDER BY l.name COLLATE NOCASE`).all()
    .map((l) => {
      // Livres et exemplaires : dans la base de la bibliotheque.
      const n = inLibrary(l.id, () => db.prepare('SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM copies) AS copies').get());
      return { ...libraryInfo(l), books: n.books, copies: n.copies, users: l.users, createdAt: l.created_at };
    }));
});

// Adresse proposee pour un nom (apercu dans le formulaire de creation).
api.get('/admin/slug', (req, res) => res.json({ slug: uniqueSlug(req.query.name || '', intOrNull(req.query.id) || 0) }));

api.post('/admin/libraries', h((req, res) => {
  const lib = tx(() => {
    const created = createLibrary(req.body.name, req.body.slug);
    // Le createur est lie a la nouvelle bibliotheque (elle apparait dans son menu).
    db.prepare("INSERT OR IGNORE INTO user_libraries (user_id, library_id, role) VALUES (?, ?, 'manager')").run(req.user.id, created.id);
    return created;
  });
  libraryDb(lib.id); // dossier et base de la bibliotheque
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
  db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
  // Base, couvertures, logo et epub : tout le dossier de la bibliotheque.
  removeLibraryFiles(id);
  res.json({ ok: true });
}));

// Cle Google Books (gratuite) : jamais renvoyee en entier, verifiee aupres de Google avant enregistrement.
function googleKeyInfo() {
  const saved = getSetting('googleBooksApiKey') || '';
  return { saved: !!saved, masked: saved ? '••••' + saved.slice(-4) : '', env: !!process.env.GOOGLE_BOOKS_API_KEY };
}

api.get('/admin/google-key', (req, res) => res.json(googleKeyInfo()));

api.put('/admin/google-key', h(async (req, res) => {
  const key = String((req.body && req.body.key) || '').trim();
  if (key) {
    if (!/^[\w-]{20,60}$/.test(key)) throw httpError(400, 'Cette clé ne ressemble pas à une clé Google (elle commence souvent par « AIza »).');
    let r;
    try {
      r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:9782070612758&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(8000) });
    } catch (e) { throw httpError(502, 'Google Books ne répond pas, réessaie plus tard.'); }
    if (!r.ok) {
      const msg = await r.json().then((d) => (d.error && d.error.message) || '').catch(() => '');
      if (r.status === 400 || r.status === 403) {
        throw httpError(400, /not been used|disabled/i.test(msg)
          ? "La clé est valide mais l'API « Books » n'est pas activée sur ce projet Google (étape 3 du guide)."
          : 'Google refuse cette clé : ' + (msg || 'clé invalide.'));
      }
      if (r.status !== 429) throw httpError(502, 'Vérification impossible (Google a répondu ' + r.status + ').');
    }
  }
  setSetting('googleBooksApiKey', key);
  res.json(googleKeyInfo());
}));

// Copie coherente de toutes les bases (centrale + une par bibliotheque) a
// telecharger, en zip (meme organisation que le dossier data, sans les fichiers).
api.get('/admin/backup', h(async (req, res) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mll-backup-'));
  try {
    backupTo(dir);
    const zip = new JSZip();
    const add = (rel) => {
      const full = path.join(dir, rel);
      if (fs.statSync(full).isDirectory()) fs.readdirSync(full).forEach((n) => add(path.join(rel, n)));
      else zip.file(rel.split(path.sep).join('/'), fs.readFileSync(full));
    };
    fs.readdirSync(dir).forEach(add);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const stamp = new Date().toISOString().slice(0, 10);
    setSetting('backupDoneMonth', stamp.slice(0, 7));
    res.attachment(`bibliotheques-${stamp}.zip`).type('application/zip').send(buffer);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

// Archive d'une bibliotheque : mylittlelibrary-<nom>.zip avec les elements choisis
// (?db=1&ebooks=1&covers=1).
api.get('/admin/libraries/:id/archive', h((req, res) => {
  const parts = Object.fromEntries(archives.PARTS.map((p) => [p, req.query[p] === '1']));
  const { fileName, stream, cleanup } = archives.exportLibrary(intOrNull(req.params.id), parts);
  res.attachment(fileName).type('application/zip');
  res.on('close', cleanup);
  stream.on('error', (err) => { console.error(err); res.destroy(err); });
  stream.pipe(res);
}));

// Restauration en deux temps : envoi (lecture de l'archive, bibliotheque du meme nom
// signalee), puis application (creation, ou remplacement confirme).
api.post('/admin/archives', h(async (req, res) => {
  if (!req.is('application/zip')) throw httpError(415, 'Archive .zip attendue.');
  res.json(await archives.stageArchive(req));
}));
api.post('/admin/archives/:token/apply', h(async (req, res) => {
  const r = await archives.applyArchive(String(req.params.token), { overwrite: req.body.overwrite === true, user: req.user });
  res.json({ ...r, library: libraryInfo(r.library) });
}));
api.delete('/admin/archives/:token', (req, res) => {
  archives.cancelArchive(String(req.params.token));
  res.json({ ok: true });
});

// Rappel mensuel passe pour ce mois-ci.
api.post('/admin/backup-reminder/skip', (req, res) => {
  archives.skipReminder();
  res.json({ ok: true });
});

api.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));
api.use(apiErrors);

// ================= Pages =================
// index.html est servi avec les chemins absolus de l'app et la bibliotheque courante
// (window.MLL) : la meme page sert l'accueil et chaque bibliotheque.
const INDEX_TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
// Version des fichiers de l'interface : empreinte de leurs noms, tailles et dates.
// Elle ne change que si un fichier de public/ change (mise a jour de l'app), pas a
// chaque redemarrage : le cache des navigateurs reste valable entre deux versions.
// Recalculee au plus toutes les 2 secondes : en developpement, un fichier modifie est
// pris en compte au rechargement de la page, sans redemarrer.
let assetVersionAt = 0;
let assetVersionValue = '';
function assetVersion() {
  if (Date.now() - assetVersionAt < 2000) return assetVersionValue;
  const hash = crypto.createHash('sha256');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    const st = fs.statSync(full);
    hash.update(`${path.relative(PUBLIC_DIR, full)}:${st.size}:${Math.floor(st.mtimeMs)};`);
  });
  walk(PUBLIC_DIR);
  assetVersionAt = Date.now();
  assetVersionValue = hash.digest('hex').slice(0, 10);
  return assetVersionValue;
}

// Page envoyee avec sa politique de contenu (voir lib/security.js). Les valeurs sont
// inserees par une fonction : un nom contenant $& ou $' n'est pas interprete par
// String.replace.
function sendIndex(req, res, library) {
  const root = auth.rootPath(req);
  const nonce = security.pagePolicy(res);
  const assets = `${root}/v/${assetVersion()}`;
  const config = JSON.stringify({
    root, assets,
    library: library ? { id: library.id, slug: library.slug, name: library.name, logoUrl: mediaUrl(library.logo) } : null,
  }).replace(/</g, '\\u003c');
  const title = library ? library.name.replace(/[<&"]/g, '') : 'Bibliothèques';
  const values = {
    MANIFEST: library ? `${root}/${library.slug}/manifest.webmanifest` : `${root}/manifest.webmanifest`,
    ROOT: root,
    ASSETS: assets,
    TITLE: title,
    NONCE: nonce,
    CONFIG: config,
  };
  const html = INDEX_TEMPLATE.replace(/\{\{([A-Z]+)\}\}/g, (m, key) => (key in values ? values[key] : m));
  res.set('Cache-Control', 'no-cache').type('html').send(html);
}

app.get('/', (req, res) => sendIndex(req, res, null));

// Manifeste d'application (installation sur l'ecran d'accueil du telephone) : un par
// bibliotheque (nom, page de depart), et un pour l'accueil. Portee = toute l'app,
// pour pouvoir passer d'une bibliotheque a l'autre sans quitter l'appli installee.
function sendManifest(req, res, library) {
  const root = auth.rootPath(req);
  const start = library ? `${root}/${library.slug}/` : `${root}/`;
  const name = library ? library.name : 'Bibliothèques';
  res.set('Cache-Control', 'no-cache').type('application/manifest+json').send(JSON.stringify({
    id: start, name, short_name: name,
    start_url: start, scope: `${root}/`, display: 'standalone', orientation: 'any',
    background_color: '#fbf8f3', theme_color: '#0f8b6d', lang: 'fr',
    icons: [
      { src: `${root}/icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${root}/icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${root}/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: `${root}/icon.svg`, sizes: 'any', type: 'image/svg+xml' },
    ],
  }));
}
app.get('/manifest.webmanifest', (req, res) => sendManifest(req, res, null));

// ---------- Une bibliotheque ----------
app.use('/:slug/api', auth.loadUser, jsonOnly, createLibraryRouter(), apiErrors);
// Images (couvertures, logo) : dossier media de la bibliotheque.
const mediaStatic = new Map();
app.use('/:slug/media', (req, res, next) => {
  const found = findLibrary(req.params.slug);
  if (!found) return next();
  const id = found.library.id;
  if (!mediaStatic.has(id)) mediaStatic.set(id, express.static(libraryDir(id, 'media'), { maxAge: '30d', immutable: true }));
  mediaStatic.get(id)(req, res, next);
});
// Toujours revalide par le navigateur : une mise a jour de l'app est prise en compte
// tout de suite sur les sites qui integrent le catalogue (WordPress...).
app.get('/:slug/embed.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'embed.js'));
});

app.get('/:slug/manifest.webmanifest', (req, res, next) => {
  const found = findLibrary(req.params.slug);
  if (!found) return next();
  sendManifest(req, res, found.library);
});

function libraryPage(req, res, next) {
  if (!isValidSlug(String(req.params.slug).toLowerCase())) return next();
  const found = findLibrary(req.params.slug);
  if (!found) return next();
  // Ancienne adresse (ou majuscules) : redirection vers l'adresse actuelle.
  if (found.moved || req.params.slug !== found.library.slug || !req.originalUrl.split('?')[0].endsWith('/')) {
    return res.redirect(301, `${auth.rootPath(req)}/${found.library.slug}/`);
  }
  sendIndex(req, res, found.library);
}
app.get('/:slug', libraryPage);
app.get('/:slug/', libraryPage);

app.use((req, res) => { security.pagePolicy(res); res.status(404).type('html').send(
  `<!doctype html><meta charset="utf-8"><title>Introuvable</title><p style="font-family:sans-serif;padding:24px">Page introuvable. <a href="${auth.rootPath(req)}/">Voir les bibliothèques</a></p>`);
});

// Lance seul en developpement (node server.js) ; charge par la passerelle, on se
// contente d'exporter l'app, c'est elle qui ecoute sur le port.
if (require.main === module) {
  app.listen(PORT, () => console.log(`MyLittleLibrary disponible sur http://localhost:${PORT}`));
}

module.exports = app;
