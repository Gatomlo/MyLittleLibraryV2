// Base SQLite (module node:sqlite integre a Node >= 22.5 : aucun module natif a
// compiler sur l'hebergement mutualise). Un seul fichier library.db dans le dossier
// de donnees, cree et migre automatiquement au demarrage.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.MLL_DATA_DIR || path.join(__dirname, '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Texte de recherche normalise (minuscules, sans accents) : LIKE de SQLite ne gere
// la casse que pour l'ASCII et ignore les accents.
function normalize(str) {
  return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

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
  const taken = (s) => db.prepare('SELECT 1 FROM libraries WHERE slug = ? AND id <> ?').get(s, exceptLibraryId)
    || db.prepare('SELECT 1 FROM library_slug_history WHERE slug = ? AND library_id <> ?').get(s, exceptLibraryId);
  let slug = base;
  for (let i = 2; taken(slug); i++) slug = `${base.slice(0, 55)}-${i}`;
  return slug;
}

// ---------- Migrations ----------
// Chaque entree n'est jouee qu'une fois (PRAGMA user_version). Une entree peut etre du
// SQL ou une fonction (migrations qui reconstruisent des tables).
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE books (
    id INTEGER PRIMARY KEY,
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
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX books_isbn ON books(isbn);
  CREATE TABLE book_categories (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, category_id)
  );
  CREATE TABLE copies (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    location TEXT,
    notes TEXT,
    label_printed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX copies_book ON copies(book_id);
  CREATE TABLE borrowers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
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
  -- Un exemplaire ne peut avoir qu'un seul pret en cours.
  CREATE UNIQUE INDEX loans_open ON loans(copy_id) WHERE returned_at IS NULL;
  `,
  // Anciens codes d'exemplaire (apres regeneration des codes) : une etiquette pas
  // encore reimprimee reste utilisable et renvoie vers le bon exemplaire.
  `
  CREATE TABLE copy_code_history (
    code TEXT PRIMARY KEY COLLATE NOCASE,
    copy_id INTEGER NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
    replaced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // Plusieurs bibliotheques : chacune a ses livres, exemplaires, categories,
  // emprunteurs, reglages et son adresse ; les comptes sont lies a une ou plusieurs
  // bibliotheques. Les donnees existantes forment la premiere bibliotheque.
  migrateToMultiLibrary,
  // Options par bibliotheque (livres numeriques, statuts de lecture), type de livre
  // (papier / numerique) et statuts de lecture propres a chaque compte.
  `
  ALTER TABLE libraries ADD COLUMN enable_ebooks INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE libraries ADD COLUMN enable_reading_status INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE books ADD COLUMN format TEXT NOT NULL DEFAULT 'physical';
  CREATE TABLE book_user_status (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reading TEXT CHECK (reading IN ('to_read', 'read')),
    opinion TEXT CHECK (opinion IN ('liked', 'disliked')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (book_id, user_id)
  );
  CREATE INDEX book_user_status_user ON book_user_status(user_id);
  `,
  // Texte de recherche : ISBN aussi sous sa forme ISBN-10.
  () => {
    const update = db.prepare('UPDATE books SET search_text = ? WHERE id = ?');
    db.prepare('SELECT id, title, subtitle, authors, publisher, isbn FROM books').all()
      .forEach((b) => update.run(bookSearchText(b), b.id));
  },
  // Collection (ou serie) et numero du livre dans celle-ci (texte : "3", "12 bis", "T2"...).
  `
  ALTER TABLE books ADD COLUMN collection TEXT;
  ALTER TABLE books ADD COLUMN collection_number TEXT;
  CREATE INDEX books_collection ON books(library_id, collection);
  `,
  // Tags (etiquettes libres, en plus des categories), activables par bibliotheque.
  `
  ALTER TABLE libraries ADD COLUMN enable_tags INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (library_id, name)
  );
  CREATE TABLE book_tags (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, tag_id)
  );
  CREATE INDEX book_tags_tag ON book_tags(tag_id);
  `,
  // Filtres affiches dans le catalogue de l'app (liste JSON, null = tous) et leur
  // position (en haut ou dans une colonne a gauche).
  `
  ALTER TABLE libraries ADD COLUMN catalog_filters TEXT;
  ALTER TABLE libraries ADD COLUMN filters_position TEXT NOT NULL DEFAULT 'top';
  `,
  // En-tete de l'app : nom et logo, nom seul ou logo seul.
  `
  ALTER TABLE libraries ADD COLUMN brand_display TEXT NOT NULL DEFAULT 'both';
  `,
  // Statuts de lecture : ajout de "en cours" et "abandonne", et dates de debut, de
  // fin et d'abandon (pour les statistiques). Table reconstruite (nouvelle contrainte).
  `
  CREATE TABLE book_user_status_new (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reading TEXT CHECK (reading IN ('to_read', 'reading', 'read', 'abandoned')),
    opinion TEXT CHECK (opinion IN ('liked', 'disliked')),
    started_at TEXT,
    finished_at TEXT,
    abandoned_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (book_id, user_id)
  );
  -- Livres deja "lus" : date de fin approximee par la derniere modification.
  INSERT INTO book_user_status_new (book_id, user_id, reading, opinion, finished_at, updated_at)
    SELECT book_id, user_id, reading, opinion, CASE WHEN reading = 'read' THEN updated_at END, updated_at FROM book_user_status;
  DROP TABLE book_user_status;
  ALTER TABLE book_user_status_new RENAME TO book_user_status;
  CREATE INDEX book_user_status_user ON book_user_status(user_id);
  `,
];

// ISBN-10 correspondant a un ISBN-13 en 978 (les ISBN en 979 n'en ont pas).
function isbn13to10(s) {
  if (!/^978\d{10}$/.test(s)) return '';
  const core = s.slice(3, 12);
  const sum = core.split('').reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : check);
}

// Texte sur lequel porte la recherche du catalogue : titre, auteurs, editeur,
// collection et ISBN sous ses deux formes (un livre se retrouve par son ISBN-13 comme par son ISBN-10).
function bookSearchText(b) {
  const isbn = String(b.isbn || '');
  return normalize([b.title, b.subtitle, b.authors, b.publisher, b.collection, isbn, isbn13to10(isbn)].join(' '));
}

function migrateToMultiLibrary() {
  db.exec(`
    CREATE TABLE libraries (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      logo TEXT,
      code_prefix TEXT NOT NULL DEFAULT 'BIB',
      next_code_number INTEGER NOT NULL DEFAULT 1,
      label_layout TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Adresses precedentes (changement volontaire d'adresse) : redirigees.
    CREATE TABLE library_slug_history (
      slug TEXT PRIMARY KEY,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE
    );
    CREATE TABLE user_libraries (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, library_id)
    );
    ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'manager';
    ALTER TABLE users ADD COLUMN default_library_id INTEGER REFERENCES libraries(id) ON DELETE SET NULL;
    ALTER TABLE books ADD COLUMN library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE;
    ALTER TABLE borrowers ADD COLUMN library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE;
    CREATE INDEX books_library ON books(library_id);
    CREATE INDEX borrowers_library ON borrowers(library_id);

    CREATE TABLE categories_new (
      id INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      UNIQUE (library_id, name)
    );
    CREATE TABLE copies_new (
      id INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      code TEXT NOT NULL COLLATE NOCASE,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      location TEXT,
      notes TEXT,
      label_printed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (library_id, code)
    );
    CREATE TABLE copy_code_history_new (
      library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      code TEXT NOT NULL COLLATE NOCASE,
      copy_id INTEGER NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
      replaced_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (library_id, code)
    );
  `);

  const hasData = db.prepare('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM books) AS n').get().n > 0;
  if (hasData) {
    const setting = (key, fallback) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row && row.value != null ? row.value : fallback;
    };
    const name = setting('libraryName', 'Bibliothèque du bureau');
    let slug = slugify(name);
    if (RESERVED_SLUGS.has(slug)) slug += '-bib';
    const libId = Number(db.prepare(`INSERT INTO libraries (slug, name, logo, code_prefix, next_code_number, label_layout)
      VALUES (?, ?, ?, ?, ?, ?)`).run(slug, name, setting('logo', '') || null, setting('codePrefix', 'BIB'),
      parseInt(setting('nextCodeNumber', '1'), 10) || 1, setting('labelLayout', '') || null).lastInsertRowid);
    db.prepare('UPDATE books SET library_id = ?').run(libId);
    db.prepare('UPDATE borrowers SET library_id = ?').run(libId);
    db.prepare('INSERT INTO categories_new (id, library_id, name) SELECT id, ?, name FROM categories').run(libId);
    db.prepare(`INSERT INTO copies_new (id, library_id, code, book_id, location, notes, label_printed_at, created_at)
      SELECT id, ?, code, book_id, location, notes, label_printed_at, created_at FROM copies`).run(libId);
    db.prepare(`INSERT INTO copy_code_history_new (library_id, code, copy_id, replaced_at)
      SELECT ?, code, copy_id, replaced_at FROM copy_code_history`).run(libId);
    // Les comptes existants (d'avant les roles) deviennent administrateurs.
    db.prepare("UPDATE users SET role = 'admin', default_library_id = ?").run(libId);
    db.prepare('INSERT INTO user_libraries (user_id, library_id) SELECT id, ? FROM users').run(libId);
  }

  db.exec(`
    DROP TABLE categories;
    ALTER TABLE categories_new RENAME TO categories;
    DROP TABLE copy_code_history;
    DROP TABLE copies;
    ALTER TABLE copies_new RENAME TO copies;
    ALTER TABLE copy_code_history_new RENAME TO copy_code_history;
    CREATE INDEX copies_book ON copies(book_id);
    CREATE INDEX categories_library ON categories(library_id);
  `);
}

(function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current < MIGRATIONS.length) {
    // Cles etrangeres desactivees le temps des reconstructions de tables (procedure
    // recommandee par SQLite), puis verifiees.
    db.exec('PRAGMA foreign_keys = OFF');
    for (let v = current; v < MIGRATIONS.length; v++) {
      tx(() => {
        const m = MIGRATIONS[v];
        if (typeof m === 'function') m(); else db.exec(m);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    const problems = db.prepare('PRAGMA foreign_key_check').all();
    if (problems.length) console.warn('Migration : references incoherentes detectees', problems.slice(0, 10));
  }
  db.exec('PRAGMA foreign_keys = ON');
})();

// Identifiant unique et lisible d'un exemplaire dans sa bibliotheque (ex. BIB-00042),
// imprime sur l'etiquette avec son QR code. A appeler dans une transaction.
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

module.exports = { db, tx, normalize, bookSearchText, slugify, isValidSlug, uniqueSlug, nextCopyCode, DATA_DIR, MEDIA_DIR };
