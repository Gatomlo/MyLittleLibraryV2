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
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Migrations numerotees : chaque entree n'est jouee qu'une fois (PRAGMA user_version).
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
];

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

(function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
})();

// Texte de recherche normalise (minuscules, sans accents) : LIKE de SQLite ne gere
// la casse que pour l'ASCII et ignore les accents.
function normalize(str) {
  return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// ---------- Reglages (cle/valeur) ----------
const DEFAULT_SETTINGS = {
  libraryName: 'Bibliothèque du bureau',
  logo: '',
  codePrefix: 'BIB',
  nextCodeNumber: '1',
  labelLayout: '',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

// Identifiant unique et lisible d'un exemplaire (ex. BIB-00042), imprime sur
// l'etiquette avec son QR code. A appeler dans une transaction.
function nextCopyCode() {
  const prefix = getSetting('codePrefix') || 'BIB';
  let n = parseInt(getSetting('nextCodeNumber'), 10) || 1;
  const exists = db.prepare('SELECT 1 FROM copies WHERE code = ?');
  let code;
  do {
    code = `${prefix}-${String(n).padStart(5, '0')}`;
    n++;
  } while (exists.get(code));
  setSetting('nextCodeNumber', n);
  return code;
}

module.exports = { db, tx, normalize, getSetting, setSetting, nextCopyCode, DATA_DIR, MEDIA_DIR };
