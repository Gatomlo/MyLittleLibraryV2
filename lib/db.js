// Bases SQLite (module node:sqlite integre a Node >= 22.5 : aucun module natif a
// compiler sur l'hebergement mutualise), creees et migrees automatiquement :
//   data/central.db                      comptes, sessions, reglages globaux, liste des
//                                        bibliotheques (et leurs reglages), liens comptes
//                                        <-> bibliotheques, preferences par bibliotheque
//   data/libraries/<id>/library.db       livres, exemplaires, prets, emprunteurs,
//                                        categories, tags, statuts, lecteurs, liseuses
//   data/libraries/<id>/media/           couvertures et logo de la bibliotheque
//   data/libraries/<id>/ebooks/          fichiers epub (jamais servis en statique)
//   data/libraries/<id>/backups/         sauvegardes faites avant un vidage
// La base centrale est attachee (schema "core") a chaque base de bibliotheque : une
// requete peut joindre livres et comptes (SQLite cherche une table dans la base de la
// bibliotheque, puis dans la base centrale), sans cle etrangere entre les deux.
//
// `db` choisit sa connexion selon le contexte de la requete (AsyncLocalStorage) : dans
// l'API d'une bibliotheque (inLibrary), la base de cette bibliotheque ; ailleurs, la
// base centrale (une table de livres y est introuvable : erreur plutot que melange).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const legacyMigrations = require('./legacy-migrations');

const DATA_DIR = process.env.MLL_DATA_DIR || path.join(__dirname, '..', 'data');
const CENTRAL_FILE = path.join(DATA_DIR, 'central.db');
const LIBRARIES_DIR = path.join(DATA_DIR, 'libraries');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
// Ancienne base unique (avant la separation par bibliotheque).
const LEGACY_FILE = path.join(DATA_DIR, 'library.db');
fs.mkdirSync(LIBRARIES_DIR, { recursive: true });

// Texte de recherche normalise (minuscules, sans accents) : LIKE de SQLite ne gere
// la casse que pour l'ASCII et ignore les accents.
function normalize(str) {
  return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function open(file) {
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  // Cle de tri "auteur" : nom de famille (dernier mot) du premier auteur, puis prenoms.
  // "Stephen King, Peter Straub" -> "king stephen". NULL si pas d'auteur (trie en dernier).
  conn.function('author_key', { deterministic: true }, (authors) => {
    const first = String(authors || '').split(/[,;&]/)[0].trim();
    if (!first) return null;
    const words = first.split(/\s+/);
    return normalize([words.pop(), ...words].join(' '));
  });
  return conn;
}

// ---------- Connexion courante ----------
const context = new AsyncLocalStorage();
let central = null;
const current = () => context.getStore() || central;

const db = {
  prepare: (sql) => current().prepare(sql),
  exec: (sql) => current().exec(sql),
};

function tx(fn) {
  const conn = current();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Chaque entree n'est jouee qu'une fois (PRAGMA user_version). Une entree peut etre du
// SQL ou une fonction (qui utilise `db`, alors dirige vers cette connexion).
function migrate(conn, migrations) {
  const version = conn.prepare('PRAGMA main.user_version').get().user_version;
  if (version < migrations.length) {
    // Cles etrangeres desactivees le temps des reconstructions de tables (procedure
    // recommandee par SQLite), puis verifiees.
    conn.exec('PRAGMA foreign_keys = OFF');
    context.run(conn, () => {
      for (let v = version; v < migrations.length; v++) {
        tx(() => {
          const m = migrations[v];
          if (typeof m === 'function') m(); else conn.exec(m);
          conn.exec(`PRAGMA main.user_version = ${v + 1}`);
        });
      }
    });
    const problems = conn.prepare('PRAGMA main.foreign_key_check').all();
    if (problems.length) console.warn('Migration : references incoherentes detectees', problems.slice(0, 10));
  }
  conn.exec('PRAGMA foreign_keys = ON');
}

// ---------- Schemas ----------
// Base centrale.
const CENTRAL_MIGRATIONS = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE libraries (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    logo TEXT,
    code_prefix TEXT NOT NULL DEFAULT 'BIB',
    next_code_number INTEGER NOT NULL DEFAULT 1,
    label_layout TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    enable_ebooks INTEGER NOT NULL DEFAULT 0,
    enable_reading_status INTEGER NOT NULL DEFAULT 0,
    enable_tags INTEGER NOT NULL DEFAULT 0,
    catalog_filters TEXT,
    filters_position TEXT NOT NULL DEFAULT 'top',
    brand_display TEXT NOT NULL DEFAULT 'both',
    enable_stats INTEGER NOT NULL DEFAULT 0,
    catalog_card TEXT,
    enable_kobo INTEGER NOT NULL DEFAULT 0,
    ebook_visible TEXT NOT NULL DEFAULT 'admin',
    ebook_read TEXT NOT NULL DEFAULT 'admin',
    ebook_download TEXT NOT NULL DEFAULT 'admin'
  );
  -- Adresses precedentes (changement volontaire d'adresse) : redirigees.
  CREATE TABLE library_slug_history (
    slug TEXT PRIMARY KEY,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    role TEXT NOT NULL DEFAULT 'manager',
    default_library_id INTEGER REFERENCES libraries(id) ON DELETE SET NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE user_libraries (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, library_id)
  );
  -- Preferences d'un compte dans une bibliotheque : partage de ses statistiques,
  -- objectif annuel, seuil (en jours) d'une lecture "qui traine".
  CREATE TABLE user_library_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    share_stats INTEGER NOT NULL DEFAULT 0,
    yearly_goal INTEGER,
    stale_days INTEGER NOT NULL DEFAULT 60,
    PRIMARY KEY (user_id, library_id)
  );
  `,
  // v2 : bouton Scanner de l'en-tete (codes lus : copy | isbn | both ; action : loan | book).
  `
  ALTER TABLE libraries ADD COLUMN scan_codes TEXT NOT NULL DEFAULT 'copy';
  ALTER TABLE libraries ADD COLUMN scan_action TEXT NOT NULL DEFAULT 'loan';
  `,
  // v3 : duree par defaut des prets (jours, 0 = sans date de retour).
  `
  ALTER TABLE libraries ADD COLUMN loan_days INTEGER NOT NULL DEFAULT 21;
  `,
  // v4 : listes de souhaits (par compte, hors bibliotheque), partage avec d'autres
  // comptes ; rappels de retour par e-mail (mailto) : manuels ou programmes a
  // J + reminder_offset jours de la date de retour (negatif = avant).
  `
  CREATE TABLE wishes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    isbn TEXT,
    title TEXT NOT NULL,
    subtitle TEXT,
    authors TEXT,
    publisher TEXT,
    year INTEGER,
    cover_url TEXT,
    notes TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX wishes_user ON wishes(user_id);
  CREATE TABLE wish_shares (
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (owner_id, viewer_id)
  );
  ALTER TABLE libraries ADD COLUMN reminder_mode TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE libraries ADD COLUMN reminder_offset INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE libraries ADD COLUMN reminder_subject TEXT;
  ALTER TABLE libraries ADD COLUMN reminder_body TEXT;
  `,
  // v5 : cartes de l'accueil choisies par chaque compte dans chaque bibliotheque
  // (JSON {"order": [...], "hidden": [...]}, NULL = ordre par defaut).
  `
  ALTER TABLE user_library_prefs ADD COLUMN home_cards TEXT;
  `,
  // v6 : plus de souhaits « acquis » (un souhait est dans la liste, ajoute a la
  // bibliotheque et alors retire, ou supprime). Bases passees par une premiere
  // version de la v4 : souhaits acquis supprimes, colonnes status / acquired_* ignorees.
  () => {
    const cols = db.prepare('PRAGMA main.table_info(wishes)').all().map((c) => c.name);
    if (cols.includes('status')) db.prepare("DELETE FROM main.wishes WHERE status = 'acquired'").run();
  },
];

// Base d'une bibliotheque. Les colonnes library_id sont gardees (toutes les requetes
// filtrent encore dessus) mais sans cle etrangere, comme user_id : ces tables sont
// dans la base centrale (nettoyage fait par le code, voir removeUserData).
const LIBRARY_MIGRATIONS = [
  `
  CREATE TABLE books (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    isbn TEXT,
    title TEXT NOT NULL,
    subtitle TEXT,
    authors TEXT,
    publisher TEXT,
    year INTEGER,
    pages INTEGER,
    summary TEXT,
    cover TEXT,
    notes TEXT,
    search_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    format TEXT NOT NULL DEFAULT 'physical',
    collection TEXT,
    collection_number TEXT,
    series TEXT,
    series_number TEXT
  );
  CREATE INDEX books_isbn ON books(isbn);
  CREATE INDEX books_library ON books(library_id);
  CREATE INDEX books_collection ON books(library_id, collection);
  CREATE INDEX books_series ON books(library_id, series);
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (library_id, name)
  );
  CREATE INDEX categories_library ON categories(library_id);
  CREATE TABLE book_categories (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, category_id)
  );
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (library_id, name)
  );
  CREATE TABLE book_tags (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, tag_id)
  );
  CREATE INDEX book_tags_tag ON book_tags(tag_id);
  -- Exemplaire papier (code, etiquette, prets) ou numerique (sans code, un par livre,
  -- fichier epub facultatif dans ebooks/). file_visible/read/download ne servent plus.
  CREATE TABLE copies (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    code TEXT COLLATE NOCASE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    format TEXT NOT NULL DEFAULT 'physical' CHECK (format IN ('physical', 'ebook')),
    location TEXT,
    notes TEXT,
    label_printed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    file_key TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_visible TEXT NOT NULL DEFAULT 'admin',
    file_read TEXT NOT NULL DEFAULT 'admin',
    file_download TEXT NOT NULL DEFAULT 'admin',
    UNIQUE (library_id, code)
  );
  CREATE INDEX copies_book ON copies(book_id);
  -- Anciens codes d'exemplaire (apres regeneration des codes) : une etiquette pas
  -- encore reimprimee reste utilisable et renvoie vers le bon exemplaire.
  CREATE TABLE copy_code_history (
    library_id INTEGER NOT NULL,
    code TEXT NOT NULL COLLATE NOCASE,
    copy_id INTEGER NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
    replaced_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (library_id, code)
  );
  CREATE TABLE borrowers (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX borrowers_library ON borrowers(library_id);
  CREATE TABLE loans (
    id INTEGER PRIMARY KEY,
    copy_id INTEGER NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
    borrower_id INTEGER NOT NULL REFERENCES borrowers(id) ON DELETE RESTRICT,
    loaned_at TEXT NOT NULL DEFAULT (datetime('now')),
    returned_at TEXT,
    notes TEXT
  );
  CREATE INDEX loans_copy ON loans(copy_id);
  CREATE INDEX loans_borrower ON loans(borrower_id);
  CREATE INDEX loans_loaned_at ON loans(loaned_at);
  -- Un exemplaire ne peut avoir qu'un seul pret en cours.
  CREATE UNIQUE INDEX loans_open ON loans(copy_id) WHERE returned_at IS NULL;
  -- Statut de lecture, avis et note de chaque compte.
  CREATE TABLE book_user_status (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    reading TEXT CHECK (reading IN ('to_read', 'reading', 'read', 'abandoned')),
    opinion TEXT CHECK (opinion IN ('liked', 'disliked')),
    started_at TEXT,
    finished_at TEXT,
    abandoned_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    PRIMARY KEY (book_id, user_id)
  );
  CREATE INDEX book_user_status_user ON book_user_status(user_id);
  -- Lecteurs : comptes membres qui lisent, liront ou ont lu un livre.
  CREATE TABLE book_readers (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (book_id, user_id)
  );
  CREATE INDEX book_readers_user ON book_readers(user_id);
  -- Liseuses Kobo (voir lib/kobo.js) et livres presents lors du dernier scan.
  CREATE TABLE kobo_devices (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    serial TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT,
    firmware TEXT,
    user_id INTEGER,
    last_scan_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (library_id, serial)
  );
  -- manual : rattachement (ou detachement) fait a la main, conserve aux scans suivants.
  -- last_derived : statut deduit au scan precedent (applique seulement s'il change).
  -- pending : envoye depuis l'appli, en attente d'un scan qui le retrouve.
  CREATE TABLE kobo_items (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES kobo_devices(id) ON DELETE CASCADE,
    content_id TEXT NOT NULL,
    path TEXT,
    title TEXT NOT NULL,
    authors TEXT,
    isbn TEXT,
    publisher TEXT,
    series TEXT,
    series_number TEXT,
    size INTEGER,
    read_status INTEGER NOT NULL DEFAULT 0,
    percent REAL NOT NULL DEFAULT 0,
    last_read_at TEXT,
    progress_changed_at TEXT,
    book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
    manual INTEGER NOT NULL DEFAULT 0,
    last_derived TEXT,
    seen_at TEXT,
    pending INTEGER NOT NULL DEFAULT 0,
    pushed_at TEXT,
    UNIQUE (device_id, content_id)
  );
  CREATE INDEX kobo_items_book ON kobo_items(book_id);
  `,
  // v2 : date de retour prevue des prets ('YYYY-MM-DD') et reservations des livres
  // par les comptes membres (user_id sans cle etrangere : table de la base centrale).
  `
  ALTER TABLE loans ADD COLUMN due_at TEXT;
  CREATE TABLE reservations (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (book_id, user_id)
  );
  CREATE INDEX reservations_book ON reservations(book_id);
  `,
  // v3 : reservations au nom d'un emprunteur (created_by = compte qui l'a saisie).
  // Les reservations v2 (par compte membre) ne sont pas reprises.
  `
  DROP TABLE reservations;
  CREATE TABLE reservations (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    borrower_id INTEGER NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (book_id, borrower_id)
  );
  CREATE INDEX reservations_book ON reservations(book_id);
  CREATE INDEX reservations_borrower ON reservations(borrower_id);
  `,
  // v4 : relances de retour envoyees (mailto) : date de la derniere et nombre.
  `
  ALTER TABLE loans ADD COLUMN reminded_at TEXT;
  ALTER TABLE loans ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0;
  `,
];

// ---------- Adresses des bibliotheques ----------
// Mots reserves : ne peuvent pas servir d'adresse de bibliotheque (routes de l'app).
const RESERVED_SLUGS = new Set(['api', 'media', 'vendor', 'admin', 'login', 'compte', 'account', 'static', 'assets', 'public', 'embed']);

function slugify(name) {
  const s = normalize(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'bibliotheque';
}

function isValidSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

// Adresse libre derivee du nom (ajoute -2, -3... si elle est deja prise, y compris
// par une ancienne adresse d'une autre bibliotheque).
function uniqueSlug(name, exceptLibraryId = 0) {
  let base = slugify(name);
  if (RESERVED_SLUGS.has(base)) base += '-bib';
  const taken = (s) => central.prepare('SELECT 1 FROM libraries WHERE slug = ? AND id <> ?').get(s, exceptLibraryId)
    || central.prepare('SELECT 1 FROM library_slug_history WHERE slug = ? AND library_id <> ?').get(s, exceptLibraryId);
  let slug = base;
  for (let i = 2; taken(slug); i++) slug = `${base.slice(0, 55)}-${i}`;
  return slug;
}

// ISBN-10 correspondant a un ISBN-13 en 978 (les ISBN en 979 n'en ont pas).
function isbn13to10(s) {
  if (!/^978\d{10}$/.test(s)) return '';
  const core = s.slice(3, 12);
  const sum = core.split('').reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : check);
}

// Texte sur lequel porte la recherche du catalogue : titre, auteurs, editeur,
// collection, serie et ISBN sous ses deux formes (un livre se retrouve par son ISBN-13 comme par son ISBN-10).
function bookSearchText(b) {
  const isbn = String(b.isbn || '');
  return normalize([b.title, b.subtitle, b.authors, b.publisher, b.collection, b.series, isbn, isbn13to10(isbn)].join(' '));
}

// ---------- Separation de l'ancienne base unique ----------
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// Copie les lignes d'une table de l'ancienne base (attachee sous "old"), colonnes
// communes seulement.
function copyRows(conn, table, where = '', params = []) {
  const cols = conn.prepare(`PRAGMA main.table_info(${table})`).all().map((c) => c.name);
  const old = new Set(conn.prepare(`PRAGMA old.table_info(${table})`).all().map((c) => c.name));
  const list = cols.filter((c) => old.has(c)).map((c) => `"${c}"`).join(', ');
  conn.prepare(`INSERT INTO main.${table} (${list}) SELECT ${list} FROM old.${table} ${where}`).run(...params);
}

const CENTRAL_TABLES = ['settings', 'libraries', 'library_slug_history', 'users', 'sessions', 'user_libraries', 'user_library_prefs'];
// Lignes de chaque table propres a la bibliotheque ?1.
const LIBRARY_TABLES = {
  books: 'WHERE library_id = ?1',
  categories: 'WHERE library_id = ?1',
  tags: 'WHERE library_id = ?1',
  borrowers: 'WHERE library_id = ?1',
  copies: 'WHERE library_id = ?1',
  copy_code_history: 'WHERE library_id = ?1',
  book_categories: 'WHERE book_id IN (SELECT id FROM old.books WHERE library_id = ?1)',
  book_tags: 'WHERE book_id IN (SELECT id FROM old.books WHERE library_id = ?1)',
  book_user_status: 'WHERE book_id IN (SELECT id FROM old.books WHERE library_id = ?1)',
  book_readers: 'WHERE book_id IN (SELECT id FROM old.books WHERE library_id = ?1)',
  loans: 'WHERE copy_id IN (SELECT id FROM old.copies WHERE library_id = ?1)',
  kobo_devices: 'WHERE library_id = ?1',
  kobo_items: 'WHERE device_id IN (SELECT id FROM old.kobo_devices WHERE library_id = ?1)',
};

// Ancienne base data/library.db (tout dans un fichier, images dans data/media, epub
// dans data/ebooks) : mise a jour puis separee en base centrale + un dossier par
// bibliotheque. Tout est prepare dans data/.separation puis mis en place ; l'ancienne
// base est d'abord sauvegardee dans data/backups. Rejouee entierement si le serveur
// s'arrete en cours (central.db n'est cree qu'a la fin).
function separateLegacy() {
  if (fs.existsSync(CENTRAL_FILE) || !fs.existsSync(LEGACY_FILE)) return;
  console.log('Separation de la base par bibliotheque...');
  const legacy = open(LEGACY_FILE);
  migrate(legacy, legacyMigrations({ db, bookSearchText, slugify, RESERVED_SLUGS }));
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = path.join(BACKUP_DIR, `library-avant-separation-${stamp()}.db`);
  legacy.exec(`VACUUM INTO ${sqlString(backup)}`);

  const tmp = path.join(DATA_DIR, '.separation');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'libraries'), { recursive: true });
  const fill = (file, migrations, fn) => {
    const conn = open(file);
    migrate(conn, migrations);
    conn.prepare('ATTACH DATABASE ? AS old').run(LEGACY_FILE);
    conn.exec('PRAGMA foreign_keys = OFF');
    context.run(conn, () => tx(() => fn(conn)));
    conn.exec('DETACH DATABASE old');
    conn.close();
  };
  fill(path.join(tmp, 'central.db'), CENTRAL_MIGRATIONS, (conn) => CENTRAL_TABLES.forEach((t) => copyRows(conn, t)));

  const OLD_MEDIA = path.join(DATA_DIR, 'media');
  const OLD_EBOOKS = path.join(DATA_DIR, 'ebooks');
  const moved = [];
  const copyFile = (from, toDir, name) => {
    if (!name || /[\\/]/.test(name) || !fs.existsSync(path.join(from, name))) return;
    fs.copyFileSync(path.join(from, name), path.join(toDir, name));
    moved.push(path.join(from, name));
  };
  for (const lib of legacy.prepare('SELECT id, logo FROM libraries').all()) {
    const dir = path.join(tmp, 'libraries', String(lib.id));
    ['media', 'ebooks'].forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
    fill(path.join(dir, 'library.db'), LIBRARY_MIGRATIONS, (conn) => {
      Object.entries(LIBRARY_TABLES).forEach(([t, where]) => copyRows(conn, t, where, [lib.id]));
    });
    copyFile(OLD_MEDIA, path.join(dir, 'media'), lib.logo);
    legacy.prepare('SELECT cover FROM books WHERE library_id = ? AND cover IS NOT NULL').all(lib.id)
      .forEach((b) => copyFile(OLD_MEDIA, path.join(dir, 'media'), b.cover));
    legacy.prepare('SELECT file_key FROM copies WHERE library_id = ? AND file_key IS NOT NULL').all(lib.id)
      .forEach((c) => copyFile(OLD_EBOOKS, path.join(dir, 'ebooks'), c.file_key));
  }
  legacy.close();

  // Mise en place : dossiers des bibliotheques, puis base centrale (point de non-retour).
  fs.rmSync(LIBRARIES_DIR, { recursive: true, force: true });
  fs.renameSync(path.join(tmp, 'libraries'), LIBRARIES_DIR);
  fs.renameSync(path.join(tmp, 'central.db'), CENTRAL_FILE);
  // Nettoyage : ancienne base (sauvegardee), fichiers deplaces, dossiers vides.
  ['', '-wal', '-shm'].forEach((s) => fs.rmSync(LEGACY_FILE + s, { force: true }));
  moved.forEach((f) => fs.rmSync(f, { force: true }));
  [OLD_MEDIA, OLD_EBOOKS].forEach((d) => {
    try { fs.rmdirSync(d); } catch (e) { /* absent, ou fichiers orphelins laisses en place */ }
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Separation terminee (ancienne base sauvegardee : ${path.relative(DATA_DIR, backup)}).`);
}

separateLegacy();
central = open(CENTRAL_FILE);
migrate(central, CENTRAL_MIGRATIONS);

// ---------- Bases des bibliotheques ----------
const libraryConns = new Map();

function libraryDir(libraryId, sub = '') {
  const id = Number(libraryId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Bibliotheque invalide.');
  return path.join(LIBRARIES_DIR, String(id), sub);
}

// Connexion a la base d'une bibliotheque (creee et migree a la premiere utilisation).
function libraryDb(libraryId) {
  const id = Number(libraryId);
  let conn = libraryConns.get(id);
  if (conn) return conn;
  if (!central.prepare('SELECT 1 FROM libraries WHERE id = ?').get(id)) throw new Error(`Bibliotheque ${id} introuvable.`);
  ['media', 'ebooks'].forEach((d) => fs.mkdirSync(libraryDir(id, d), { recursive: true }));
  conn = open(path.join(libraryDir(id), 'library.db'));
  conn.prepare('ATTACH DATABASE ? AS core').run(CENTRAL_FILE);
  migrate(conn, LIBRARY_MIGRATIONS);
  libraryConns.set(id, conn);
  return conn;
}

// Execute fn avec `db` dirige vers la base de la bibliotheque (y compris dans les
// suites asynchrones de fn).
function inLibrary(libraryId, fn) {
  return context.run(libraryDb(libraryId), fn);
}

function libraryIds() {
  return central.prepare('SELECT id FROM libraries ORDER BY id').all().map((l) => l.id);
}

// Ferme la connexion a la base d'une bibliotheque (avant remplacement de ses fichiers).
function closeLibraryDb(libraryId) {
  const id = Number(libraryId);
  const conn = libraryConns.get(id);
  if (conn) { conn.close(); libraryConns.delete(id); }
}

// Ferme puis supprime la base et les fichiers d'une bibliotheque (apres sa
// suppression de la base centrale).
function removeLibraryFiles(libraryId) {
  closeLibraryDb(libraryId);
  fs.rmSync(libraryDir(libraryId), { recursive: true, force: true });
}

// Donnees d'un compte supprime dans chaque bibliotheque (pas de cle etrangere entre
// les bases) : statuts et lecteurs supprimes, liseuses gardees sans proprietaire.
function removeUserData(userId) {
  for (const id of libraryIds()) {
    inLibrary(id, () => tx(() => {
      db.prepare('DELETE FROM book_user_status WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM book_readers WHERE user_id = ?').run(userId);
      db.prepare('UPDATE reservations SET created_by = NULL WHERE created_by = ?').run(userId);
      db.prepare('UPDATE kobo_devices SET user_id = NULL WHERE user_id = ?').run(userId);
    }));
  }
}

// Copie coherente de la base centrale et de la base de chaque bibliotheque dans un
// dossier : central.db et libraries/<id>/library.db.
function backupTo(dir) {
  fs.mkdirSync(path.join(dir, 'libraries'), { recursive: true });
  central.exec(`VACUUM main INTO ${sqlString(path.join(dir, 'central.db'))}`);
  for (const id of libraryIds()) {
    fs.mkdirSync(path.join(dir, 'libraries', String(id)), { recursive: true });
    libraryDb(id).exec(`VACUUM main INTO ${sqlString(path.join(dir, 'libraries', String(id), 'library.db'))}`);
  }
}

// Identifiant unique et lisible d'un exemplaire dans sa bibliotheque (ex. BIB-00042),
// imprime sur l'etiquette avec son QR code. A appeler dans une transaction, dans le
// contexte de la bibliotheque.
function nextCopyCode(libraryId) {
  const lib = db.prepare('SELECT code_prefix, next_code_number FROM libraries WHERE id = ?').get(libraryId);
  const prefix = lib.code_prefix || 'BIB';
  let n = lib.next_code_number || 1;
  // Un code encore imprime sur une ancienne etiquette n'est jamais reattribue.
  const exists = db.prepare(`SELECT 1 FROM copies WHERE library_id = ?1 AND code = ?2
    UNION ALL SELECT 1 FROM copy_code_history WHERE library_id = ?1 AND code = ?2`);
  let code;
  do {
    code = `${prefix}-${String(n).padStart(5, '0')}`;
    n++;
  } while (exists.get(libraryId, code));
  db.prepare('UPDATE libraries SET next_code_number = ? WHERE id = ?').run(n, libraryId);
  return code;
}

// Reglages globaux (table settings, cle/valeur).
function getSetting(key) {
  const row = central.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value != null ? row.value : null;
}
function setSetting(key, value) {
  if (value == null || value === '') central.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else central.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// Cle Google Books : celle saisie dans l'administration, sinon la variable d'environnement.
function googleBooksKey() {
  return getSetting('googleBooksApiKey') || process.env.GOOGLE_BOOKS_API_KEY || '';
}

module.exports = {
  getSetting, setSetting, googleBooksKey, db, tx, normalize, bookSearchText, slugify, isValidSlug, uniqueSlug, nextCopyCode,
  inLibrary, libraryDb, libraryDir, libraryIds, removeLibraryFiles, removeUserData, backupTo, closeLibraryDb, sqlString, DATA_DIR,
};
