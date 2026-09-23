// API d'UNE bibliotheque, montee sur /<adresse-de-la-bibliotheque>/api. Toutes les
// requetes sont limitees a la bibliotheque resolue (req.library) : une bibliotheque
// ne voit jamais les livres, exemplaires ou emprunteurs d'une autre.
const express = require('express');
const QRCode = require('qrcode');
const { db, tx, normalize, nextCopyCode } = require('./db');
const auth = require('./auth');
const media = require('./media');
const { normalizeIsbn, lookupIsbn } = require('./isbn');

const writeExcelFileModule = require('write-excel-file/node');
const writeExcelFile = writeExcelFileModule.default || writeExcelFileModule;

// Colonnes du modele d'import (reconnues aussi sous d'autres noms, cote navigateur).
const IMPORT_COLUMNS = ['ISBN', 'Titre', 'Sous-titre', 'Auteurs', 'Éditeur', 'Année', 'Pages', 'Résumé',
  'Catégories', 'Emplacement', 'Exemplaires', 'Notes', 'Couverture (URL)'];

const { httpError } = media;
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ================= Utilitaires =================
function mediaUrl(name) {
  return name ? 'media/' + name : null;
}

function str(v, max = 500) {
  const s = v == null ? '' : String(v).trim();
  return s.slice(0, max);
}

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function idParam(req, name = 'id') {
  const n = intOrNull(req.params[name]);
  if (!n) throw httpError(400, 'Identifiant invalide.');
  return n;
}

function publicSettings(lib) {
  return { slug: lib.slug, libraryName: lib.name, logoUrl: mediaUrl(lib.logo) };
}

function categoriesFor(bookIds) {
  const map = new Map(bookIds.map((id) => [id, []]));
  if (!bookIds.length) return map;
  const rows = db.prepare(`SELECT bc.book_id, c.id, c.name FROM book_categories bc
    JOIN categories c ON c.id = bc.category_id
    WHERE bc.book_id IN (${bookIds.map(() => '?').join(',')}) ORDER BY c.name COLLATE NOCASE`).all(...bookIds);
  rows.forEach((r) => map.get(r.book_id).push({ id: r.id, name: r.name }));
  return map;
}

const COPY_COUNTS = `
  (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id) AS total_copies,
  (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id
     AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.copy_id = c.id AND l.returned_at IS NULL)) AS available_copies`;

function serializeBook(b, cats, isManager) {
  const out = {
    id: b.id,
    isbn: b.isbn || '',
    title: b.title,
    subtitle: b.subtitle || '',
    authors: b.authors || '',
    publisher: b.publisher || '',
    year: b.year,
    pages: b.pages,
    coverUrl: mediaUrl(b.cover),
    categories: cats || [],
    totalCopies: b.total_copies,
    availableCopies: b.available_copies,
  };
  if (b.summary !== undefined) out.summary = b.summary || '';
  if (isManager) {
    out.notes = b.notes || '';
    out.createdAt = b.created_at;
    out.updatedAt = b.updated_at;
  }
  return out;
}

// Recherche multi-mots dans le catalogue (chaque mot doit apparaitre quelque part).
function searchBooks(libId, query, isManager) {
  const where = ['b.library_id = ?'];
  const params = [libId];
  const words = normalize(query.q).split(/\s+/).filter(Boolean).slice(0, 8);
  for (const w of words) {
    if (isManager) {
      where.push('(b.search_text LIKE ? OR EXISTS (SELECT 1 FROM copies c WHERE c.book_id = b.id AND c.code LIKE ?))');
      params.push(`%${w}%`, `%${w}%`);
    } else {
      where.push('b.search_text LIKE ?');
      params.push(`%${w}%`);
    }
  }
  const cat = intOrNull(query.category);
  if (cat) {
    where.push('EXISTS (SELECT 1 FROM book_categories bc WHERE bc.book_id = b.id AND bc.category_id = ?)');
    params.push(cat);
  }
  if (query.status === 'available') where.push('available_copies > 0');
  if (query.status === 'onloan') where.push('available_copies < total_copies');
  const limit = Math.min(intOrNull(query.limit) || 24, 100);
  const page = intOrNull(query.page) || 1;
  const order = query.sort === 'recent' ? 'b.created_at DESC, b.id DESC'
    : query.sort === 'year' ? 'b.year DESC NULLS LAST, b.title COLLATE NOCASE'
      : 'b.title COLLATE NOCASE';
  const base = `SELECT * FROM (SELECT b.id, b.library_id, b.isbn, b.title, b.subtitle, b.authors, b.publisher, b.year, b.pages,
    b.cover, b.created_at, b.search_text, ${COPY_COUNTS} FROM books b) b WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...params).n;
  const rows = db.prepare(`${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  const cats = categoriesFor(rows.map((r) => r.id));
  return { total, page, limit, items: rows.map((r) => serializeBook(r, cats.get(r.id), false)) };
}

function getBookRow(libId, id) {
  const b = db.prepare(`SELECT b.*, ${COPY_COUNTS} FROM books b WHERE b.id = ? AND b.library_id = ?`).get(id, libId);
  if (!b) throw httpError(404, 'Livre introuvable.');
  return b;
}

// Exemplaire par son code actuel, ou par un ancien code (etiquette d'avant une
// regeneration des codes). Renvoie { id, book_id, code } avec le code actuel.
function findCopy(libId, code) {
  const c = str(code, 40);
  return db.prepare('SELECT id, book_id, code FROM copies WHERE library_id = ? AND code = ?').get(libId, c)
    || db.prepare(`SELECT c.id, c.book_id, c.code FROM copy_code_history h
      JOIN copies c ON c.id = h.copy_id WHERE h.library_id = ? AND h.code = ?`).get(libId, c);
}

function bookDetail(libId, id) {
  const b = getBookRow(libId, id);
  const book = serializeBook(b, categoriesFor([b.id]).get(b.id), true);
  book.copies = db.prepare(`SELECT c.id, c.code, c.location, c.notes, c.label_printed_at, c.created_at,
      l.id AS loan_id, l.loaned_at, br.id AS borrower_id, br.name AS borrower_name
    FROM copies c
    LEFT JOIN loans l ON l.copy_id = c.id AND l.returned_at IS NULL
    LEFT JOIN borrowers br ON br.id = l.borrower_id
    WHERE c.book_id = ? ORDER BY c.code`).all(id).map((c) => ({
    id: c.id,
    code: c.code,
    location: c.location || '',
    notes: c.notes || '',
    labelPrintedAt: c.label_printed_at,
    createdAt: c.created_at,
    loan: c.loan_id ? { id: c.loan_id, loanedAt: c.loaned_at, borrower: { id: c.borrower_id, name: c.borrower_name } } : null,
  }));
  book.history = db.prepare(`SELECT l.id, l.loaned_at, l.returned_at, c.code, br.id AS borrower_id, br.name AS borrower_name
    FROM loans l JOIN copies c ON c.id = l.copy_id JOIN borrowers br ON br.id = l.borrower_id
    WHERE c.book_id = ? ORDER BY l.loaned_at DESC, l.id DESC LIMIT 100`).all(id).map((l) => ({
    id: l.id, code: l.code, loanedAt: l.loaned_at, returnedAt: l.returned_at,
    borrower: { id: l.borrower_id, name: l.borrower_name },
  }));
  return book;
}

function readBookFields(body) {
  const title = str(body.title, 300);
  if (!title) throw httpError(400, 'Le titre est requis.');
  const isbnRaw = str(body.isbn, 20);
  const isbn = isbnRaw ? normalizeIsbn(isbnRaw) || isbnRaw.replace(/[^0-9Xx]/g, '') : '';
  const f = {
    isbn,
    title,
    subtitle: str(body.subtitle, 300),
    authors: str(body.authors, 500),
    publisher: str(body.publisher, 200),
    year: intOrNull(body.year),
    pages: intOrNull(body.pages),
    summary: str(body.summary, 20000),
    notes: str(body.notes, 5000),
  };
  f.search_text = normalize([f.title, f.subtitle, f.authors, f.publisher, f.isbn].join(' '));
  return f;
}

function setBookCategories(libId, bookId, names) {
  db.prepare('DELETE FROM book_categories WHERE book_id = ?').run(bookId);
  const find = db.prepare('SELECT id FROM categories WHERE library_id = ? AND name = ?');
  const create = db.prepare('INSERT INTO categories (library_id, name) VALUES (?, ?)');
  const link = db.prepare('INSERT OR IGNORE INTO book_categories (book_id, category_id) VALUES (?, ?)');
  for (const raw of (Array.isArray(names) ? names : []).slice(0, 30)) {
    const name = str(raw, 80);
    if (!name) continue;
    const cat = find.get(libId, name);
    link.run(bookId, cat ? cat.id : create.run(libId, name).lastInsertRowid);
  }
}

// Couverture : nouvelle image envoyee (coverData), a telecharger (coverUrl), ou a retirer.
async function resolveCover(body) {
  if (body.coverData) return media.saveDataUrl(body.coverData, 'cover');
  if (body.coverUrl) {
    try { return await media.saveFromUrl(String(body.coverUrl), 'cover'); } catch (e) {
      console.warn('Couverture non recuperee :', e.message);
      return '';
    }
  }
  return null;
}

function createCopies(libId, bookId, count, location) {
  const insert = db.prepare('INSERT INTO copies (library_id, code, book_id, location) VALUES (?, ?, ?, ?)');
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = nextCopyCode(libId);
    insert.run(libId, code, bookId, location || null);
    codes.push(code);
  }
  return codes;
}

function listLoans(libId, { status = 'open', borrowerId = null, limit = 500 } = {}) {
  const where = ['c.library_id = ?'];
  const params = [libId];
  if (status === 'open') where.push('l.returned_at IS NULL');
  if (status === 'returned') where.push('l.returned_at IS NOT NULL');
  if (borrowerId) { where.push('l.borrower_id = ?'); params.push(borrowerId); }
  return db.prepare(`SELECT l.id, l.loaned_at, l.returned_at, l.notes, c.id AS copy_id, c.code,
      b.id AS book_id, b.title, b.authors, b.cover, br.id AS borrower_id, br.name AS borrower_name
    FROM loans l JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id
    JOIN borrowers br ON br.id = l.borrower_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.returned_at IS NOT NULL, COALESCE(l.returned_at, l.loaned_at) DESC, l.id DESC LIMIT ?`).all(...params, limit)
    .map((l) => ({
      id: l.id, loanedAt: l.loaned_at, returnedAt: l.returned_at, notes: l.notes || '',
      copy: { id: l.copy_id, code: l.code },
      book: { id: l.book_id, title: l.title, authors: l.authors || '', coverUrl: mediaUrl(l.cover) },
      borrower: { id: l.borrower_id, name: l.borrower_name },
    }));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Bibliotheque designee par l'adresse (/:slug/...), ou par une ancienne adresse.
function findLibrary(slug) {
  const s = String(slug || '').toLowerCase();
  const lib = db.prepare('SELECT * FROM libraries WHERE slug = ?').get(s);
  if (lib) return { library: lib, moved: false };
  const old = db.prepare(`SELECT l.* FROM library_slug_history h JOIN libraries l ON l.id = h.library_id
    WHERE h.slug = ?`).get(s);
  return old ? { library: old, moved: true } : null;
}

// ================= Routeur =================
function createLibraryRouter() {
  const api = express.Router({ mergeParams: true });

  api.use((req, res, next) => {
    const found = findLibrary(req.params.slug);
    if (!found) return res.status(404).json({ error: 'Bibliothèque introuvable.' });
    req.library = found.library;
    next();
  });

  // Catalogue public en lecture seule, interrogeable depuis un autre site (shortcode WordPress).
  api.use('/public', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'GET') return res.status(405).json({ error: 'Lecture seule.' });
    next();
  });

  // ---------- Public ----------
  api.get('/public/settings', (req, res) => res.json(publicSettings(req.library)));

  api.get('/public/categories', (req, res) => {
    res.json(db.prepare(`SELECT c.id, c.name, COUNT(bc.book_id) AS count FROM categories c
      LEFT JOIN book_categories bc ON bc.category_id = c.id WHERE c.library_id = ?
      GROUP BY c.id ORDER BY c.name COLLATE NOCASE`).all(req.library.id));
  });

  api.get('/public/books', (req, res) => res.json(searchBooks(req.library.id, req.query, false)));

  api.get('/public/books/:id', h((req, res) => {
    const b = getBookRow(req.library.id, idParam(req));
    const book = serializeBook(b, categoriesFor([b.id]).get(b.id), false);
    book.copies = db.prepare(`SELECT c.code, c.location,
        NOT EXISTS (SELECT 1 FROM loans l WHERE l.copy_id = c.id AND l.returned_at IS NULL) AS available
      FROM copies c WHERE c.book_id = ? ORDER BY c.code`).all(b.id)
      .map((c) => ({ code: c.code, location: c.location || '', available: !!c.available }));
    res.json(book);
  }));

  // Permet d'ouvrir la fiche d'un livre en scannant l'etiquette sans etre connecte.
  api.get('/public/copies/:code', h((req, res) => {
    const c = findCopy(req.library.id, req.params.code);
    if (!c) throw httpError(404, 'Exemplaire introuvable.');
    res.json({ bookId: c.book_id, code: c.code });
  }));

  // ---------- Gestion : compte lie a la bibliotheque (ou administrateur) ----------
  api.use((req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
    if (!auth.canManage(req.user, req.library.id)) return res.status(403).json({ error: "Tu n'as pas accès à la gestion de cette bibliothèque." });
    next();
  });

  // ---------- Reglages de la bibliotheque ----------
  function parseLabelLayout(lib) {
    try { return JSON.parse(lib.label_layout || 'null'); } catch (e) { return null; }
  }

  api.get('/settings', (req, res) => {
    const lib = req.library;
    res.json({ ...publicSettings(lib), codePrefix: lib.code_prefix, nextCodeNumber: lib.next_code_number, labelLayout: parseLabelLayout(lib) });
  });

  api.put('/settings', h((req, res) => {
    const b = req.body;
    const lib = req.library;
    if (b.libraryName !== undefined) {
      const name = str(b.libraryName, 120);
      if (!name) throw httpError(400, 'Le nom de la bibliothèque est requis.');
      db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(name, lib.id);
    }
    if (b.codePrefix !== undefined) {
      const prefix = str(b.codePrefix, 10).toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(prefix)) throw httpError(400, 'Préfixe : lettres et chiffres uniquement (10 max).');
      db.prepare('UPDATE libraries SET code_prefix = ? WHERE id = ?').run(prefix, lib.id);
    }
    if (b.labelLayout !== undefined) {
      db.prepare('UPDATE libraries SET label_layout = ? WHERE id = ?').run(JSON.stringify(b.labelLayout).slice(0, 2000), lib.id);
    }
    res.json({ ok: true });
  }));

  api.post('/settings/logo', h((req, res) => {
    const name = media.saveDataUrl(req.body.dataUrl, 'logo');
    media.remove(req.library.logo);
    db.prepare('UPDATE libraries SET logo = ? WHERE id = ?').run(name, req.library.id);
    res.json(publicSettings({ ...req.library, logo: name }));
  }));

  api.delete('/settings/logo', (req, res) => {
    media.remove(req.library.logo);
    db.prepare('UPDATE libraries SET logo = NULL WHERE id = ?').run(req.library.id);
    res.json(publicSettings({ ...req.library, logo: null }));
  });

  // ---------- Categories et emplacements ----------
  api.get('/categories', (req, res) => {
    res.json(db.prepare(`SELECT c.id, c.name, COUNT(bc.book_id) AS count FROM categories c
      LEFT JOIN book_categories bc ON bc.category_id = c.id WHERE c.library_id = ?
      GROUP BY c.id ORDER BY c.name COLLATE NOCASE`).all(req.library.id));
  });

  api.post('/categories', h((req, res) => {
    const name = str(req.body.name, 80);
    if (!name) throw httpError(400, 'Nom requis.');
    const r = db.prepare('INSERT INTO categories (library_id, name) VALUES (?, ?)').run(req.library.id, name);
    res.json({ id: Number(r.lastInsertRowid), name });
  }));

  api.put('/categories/:id', h((req, res) => {
    const name = str(req.body.name, 80);
    if (!name) throw httpError(400, 'Nom requis.');
    db.prepare('UPDATE categories SET name = ? WHERE id = ? AND library_id = ?').run(name, idParam(req), req.library.id);
    res.json({ ok: true });
  }));

  api.delete('/categories/:id', h((req, res) => {
    db.prepare('DELETE FROM categories WHERE id = ? AND library_id = ?').run(idParam(req), req.library.id);
    res.json({ ok: true });
  }));

  api.get('/locations', (req, res) => {
    res.json(db.prepare(`SELECT DISTINCT location FROM copies WHERE library_id = ? AND location IS NOT NULL AND location <> ''
      ORDER BY location COLLATE NOCASE`).all(req.library.id).map((r) => r.location));
  });

  // ---------- Livres ----------
  api.get('/isbn/:isbn', h(async (req, res) => {
    const isbn = normalizeIsbn(req.params.isbn);
    if (!isbn) throw httpError(400, 'ISBN invalide.');
    const existing = db.prepare('SELECT id, title FROM books WHERE isbn = ? AND library_id = ?').all(isbn, req.library.id);
    const found = await lookupIsbn(isbn);
    res.json({ isbn, found, existing });
  }));

  api.get('/books', (req, res) => res.json(searchBooks(req.library.id, req.query, true)));

  api.get('/books/:id', h((req, res) => res.json(bookDetail(req.library.id, idParam(req)))));

  api.post('/books', h(async (req, res) => {
    const libId = req.library.id;
    const f = readBookFields(req.body);
    const cover = await resolveCover(req.body);
    const count = Math.min(intOrNull(req.body.copies) ?? 1, 50);
    const id = tx(() => {
      const r = db.prepare(`INSERT INTO books (library_id, isbn, title, subtitle, authors, publisher, year, pages, summary, notes, search_text, cover)
        VALUES (@library_id, @isbn, @title, @subtitle, @authors, @publisher, @year, @pages, @summary, @notes, @search_text, @cover)`)
        .run({ ...f, library_id: libId, cover: cover || null });
      const bookId = Number(r.lastInsertRowid);
      setBookCategories(libId, bookId, req.body.categories);
      createCopies(libId, bookId, req.body.copies === 0 ? 0 : count, str(req.body.location, 120));
      return bookId;
    });
    res.json(bookDetail(libId, id));
  }));

  api.put('/books/:id', h(async (req, res) => {
    const libId = req.library.id;
    const id = idParam(req);
    const old = getBookRow(libId, id);
    const f = readBookFields(req.body);
    const newCover = await resolveCover(req.body);
    let cover = old.cover;
    if (newCover !== null || req.body.removeCover) {
      media.remove(old.cover);
      cover = newCover || null;
    }
    tx(() => {
      db.prepare(`UPDATE books SET isbn = @isbn, title = @title, subtitle = @subtitle, authors = @authors,
        publisher = @publisher, year = @year, pages = @pages, summary = @summary, notes = @notes,
        search_text = @search_text, cover = @cover, updated_at = datetime('now') WHERE id = @id`).run({ ...f, cover, id });
      setBookCategories(libId, id, req.body.categories);
    });
    res.json(bookDetail(libId, id));
  }));

  api.delete('/books/:id', h((req, res) => {
    const id = idParam(req);
    const b = getBookRow(req.library.id, id);
    if (b.available_copies < b.total_copies) throw httpError(409, 'Un exemplaire est en prêt : enregistre son retour avant de supprimer le livre.');
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    media.remove(b.cover);
    res.json({ ok: true });
  }));

  // ---------- Exemplaires ----------
  api.post('/books/:id/copies', h((req, res) => {
    const libId = req.library.id;
    const id = idParam(req);
    getBookRow(libId, id);
    const count = Math.min(intOrNull(req.body.count) || 1, 50);
    const codes = tx(() => createCopies(libId, id, count, str(req.body.location, 120)));
    res.json({ codes, book: bookDetail(libId, id) });
  }));

  api.put('/copies/:id', h((req, res) => {
    const r = db.prepare('UPDATE copies SET location = ?, notes = ? WHERE id = ? AND library_id = ?')
      .run(str(req.body.location, 120) || null, str(req.body.notes, 2000) || null, idParam(req), req.library.id);
    if (!r.changes) throw httpError(404, 'Exemplaire introuvable.');
    res.json({ ok: true });
  }));

  api.delete('/copies/:id', h((req, res) => {
    const id = idParam(req);
    if (db.prepare('SELECT 1 FROM loans WHERE copy_id = ? AND returned_at IS NULL').get(id)) {
      throw httpError(409, 'Cet exemplaire est en prêt : enregistre son retour avant de le supprimer.');
    }
    db.prepare('DELETE FROM copies WHERE id = ? AND library_id = ?').run(id, req.library.id);
    res.json({ ok: true });
  }));

  // Exemplaire retrouve par son code (saisi ou scanne sur l'etiquette).
  api.get('/copies/by-code/:code', h((req, res) => {
    const code = str(req.params.code, 40);
    const c = findCopy(req.library.id, code);
    if (!c) throw httpError(404, `Aucun exemplaire avec le code ${code}.`);
    const book = bookDetail(req.library.id, c.book_id);
    res.json({ copy: book.copies.find((x) => x.id === c.id), book, oldCode: c.code.toUpperCase() !== code.toUpperCase() ? code : null });
  }));

  // Regenere les codes de tous les exemplaires de la bibliotheque avec le prefixe
  // choisi, soit en gardant les numeros (seul le prefixe change), soit en
  // renumerotant a partir de 1 dans l'ordre d'ajout. Les anciens codes restent
  // reconnus (copy_code_history) ; les etiquettes modifiees repassent "a imprimer".
  api.post('/copies/renumber', h((req, res) => {
    const libId = req.library.id;
    const prefix = str(req.body.prefix, 10).toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(prefix)) throw httpError(400, 'Préfixe : lettres et chiffres uniquement (10 max).');
    const compact = !!req.body.compact;
    const count = tx(() => {
      const copies = db.prepare('SELECT id, code FROM copies WHERE library_id = ? ORDER BY created_at, id').all(libId);
      const numbers = new Map();
      const used = new Set();
      if (compact) {
        copies.forEach((c, i) => numbers.set(c.id, i + 1));
      } else {
        // Numero actuel conserve ; en cas de doublon (anciens prefixes melanges), le
        // suivant libre est attribue apres les autres.
        const pending = [];
        for (const c of copies) {
          const m = /(\d+)$/.exec(c.code);
          const n = m ? Number(m[1]) : 0;
          if (n > 0 && !used.has(n)) { used.add(n); numbers.set(c.id, n); } else pending.push(c);
        }
        let next = Math.max(0, ...used) + 1;
        pending.forEach((c) => numbers.set(c.id, next++));
      }
      const remember = db.prepare(`INSERT INTO copy_code_history (library_id, code, copy_id) VALUES (?, ?, ?)
        ON CONFLICT(library_id, code) DO UPDATE SET copy_id = excluded.copy_id, replaced_at = datetime('now')`);
      const setCode = db.prepare('UPDATE copies SET code = ?, label_printed_at = NULL WHERE id = ?');
      const keepLabel = db.prepare("UPDATE copies SET label_printed_at = datetime('now') WHERE id = ?");
      // Codes temporaires d'abord, pour ne jamais violer l'unicite pendant l'echange.
      copies.forEach((c) => setCode.run(`TMP${c.id}-0`, c.id));
      let changed = 0;
      let max = 0;
      for (const c of copies) {
        const n = numbers.get(c.id);
        max = Math.max(max, n);
        const code = `${prefix}-${String(n).padStart(5, '0')}`;
        setCode.run(code, c.id);
        if (code.toUpperCase() !== c.code.toUpperCase()) {
          remember.run(libId, c.code, c.id);
          changed++;
        } else {
          keepLabel.run(c.id); // code inchange : l'etiquette actuelle reste valable
        }
      }
      // Un ancien code redevenu code actuel d'un exemplaire n'a plus a etre redirige.
      db.prepare('DELETE FROM copy_code_history WHERE library_id = ?1 AND code IN (SELECT code FROM copies WHERE library_id = ?1)').run(libId);
      db.prepare('UPDATE libraries SET code_prefix = ?, next_code_number = ? WHERE id = ?').run(prefix, max + 1, libId);
      return changed;
    });
    res.json({ changed: count });
  }));

  // ---------- Emprunteurs ----------
  api.get('/borrowers', (req, res) => {
    const q = normalize(req.query.q).trim();
    const rows = db.prepare(`SELECT br.*,
        (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = br.id AND l.returned_at IS NULL) AS open_loans,
        (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = br.id) AS total_loans
      FROM borrowers br WHERE br.library_id = ? ORDER BY br.name COLLATE NOCASE`).all(req.library.id);
    res.json(rows
      .filter((b) => !q || normalize(`${b.name} ${b.email} ${b.phone}`).includes(q))
      .map((b) => ({ id: b.id, name: b.name, email: b.email || '', phone: b.phone || '', notes: b.notes || '', openLoans: b.open_loans, totalLoans: b.total_loans })));
  });

  function readBorrower(body) {
    const name = str(body.name, 120);
    if (!name) throw httpError(400, 'Le nom est requis.');
    return { name, email: str(body.email, 200), phone: str(body.phone, 60), notes: str(body.notes, 2000) };
  }

  api.post('/borrowers', h((req, res) => {
    const b = readBorrower(req.body);
    const r = db.prepare('INSERT INTO borrowers (library_id, name, email, phone, notes) VALUES (@library_id, @name, @email, @phone, @notes)')
      .run({ ...b, library_id: req.library.id });
    res.json({ id: Number(r.lastInsertRowid), ...b });
  }));

  api.get('/borrowers/:id', h((req, res) => {
    const id = idParam(req);
    const b = db.prepare('SELECT * FROM borrowers WHERE id = ? AND library_id = ?').get(id, req.library.id);
    if (!b) throw httpError(404, 'Emprunteur introuvable.');
    res.json({
      id: b.id, name: b.name, email: b.email || '', phone: b.phone || '', notes: b.notes || '',
      loans: listLoans(req.library.id, { borrowerId: id, status: 'all' }),
    });
  }));

  api.put('/borrowers/:id', h((req, res) => {
    const r = db.prepare('UPDATE borrowers SET name = @name, email = @email, phone = @phone, notes = @notes WHERE id = @id AND library_id = @library_id')
      .run({ ...readBorrower(req.body), id: idParam(req), library_id: req.library.id });
    if (!r.changes) throw httpError(404, 'Emprunteur introuvable.');
    res.json({ ok: true });
  }));

  api.delete('/borrowers/:id', h((req, res) => {
    const id = idParam(req);
    if (db.prepare('SELECT 1 FROM loans WHERE borrower_id = ?').get(id)) {
      throw httpError(409, "Cet emprunteur a un historique de prêts : il ne peut pas être supprimé (l'historique serait perdu).");
    }
    db.prepare('DELETE FROM borrowers WHERE id = ? AND library_id = ?').run(id, req.library.id);
    res.json({ ok: true });
  }));

  // ---------- Prets ----------
  api.get('/loans', (req, res) => {
    res.json(listLoans(req.library.id, { status: ['open', 'returned', 'all'].includes(req.query.status) ? req.query.status : 'open' }));
  });

  api.post('/loans', h((req, res) => {
    const libId = req.library.id;
    const code = str(req.body.code, 40);
    const loanId = tx(() => {
      const copy = findCopy(libId, code);
      if (!copy) throw httpError(404, `Aucun exemplaire avec le code ${code}.`);
      if (db.prepare('SELECT 1 FROM loans WHERE copy_id = ? AND returned_at IS NULL').get(copy.id)) {
        throw httpError(409, 'Cet exemplaire est déjà en prêt.');
      }
      let borrowerId = intOrNull(req.body.borrowerId);
      if (borrowerId && !db.prepare('SELECT 1 FROM borrowers WHERE id = ? AND library_id = ?').get(borrowerId, libId)) borrowerId = null;
      if (!borrowerId) {
        const name = str(req.body.borrowerName, 120);
        if (!name) throw httpError(400, "Choisis ou saisis l'emprunteur.");
        const existing = db.prepare('SELECT id FROM borrowers WHERE library_id = ? AND name = ? COLLATE NOCASE').get(libId, name);
        borrowerId = existing ? existing.id
          : Number(db.prepare('INSERT INTO borrowers (library_id, name) VALUES (?, ?)').run(libId, name).lastInsertRowid);
      }
      return db.prepare('INSERT INTO loans (copy_id, borrower_id, notes) VALUES (?, ?, ?)')
        .run(copy.id, borrowerId, str(req.body.notes, 1000) || null).lastInsertRowid;
    });
    res.json(listLoans(libId, { status: 'all' }).find((l) => l.id === Number(loanId)));
  }));

  api.post('/loans/:id/return', h((req, res) => {
    const r = db.prepare(`UPDATE loans SET returned_at = datetime('now') WHERE id = ? AND returned_at IS NULL
      AND copy_id IN (SELECT id FROM copies WHERE library_id = ?)`).run(idParam(req), req.library.id);
    if (!r.changes) throw httpError(404, 'Prêt introuvable ou déjà clôturé.');
    res.json({ ok: true });
  }));

  // ---------- Etiquettes ----------
  api.get('/labels/pending', (req, res) => {
    res.json(db.prepare(`SELECT c.id, c.code, c.location, b.id AS book_id, b.title, b.authors
      FROM copies c JOIN books b ON b.id = c.book_id WHERE c.library_id = ? AND c.label_printed_at IS NULL ORDER BY c.code`)
      .all(req.library.id)
      .map((c) => ({ id: c.id, code: c.code, location: c.location || '', bookId: c.book_id, title: c.title, authors: c.authors || '' })));
  });

  // Recherche pour composer une selection d'etiquettes : livres (titre, auteur...) ou
  // code d'exemplaire, avec leurs exemplaires.
  api.get('/labels/search', (req, res) => {
    const libId = req.library.id;
    const words = normalize(req.query.q).split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return res.json([]);
    const where = ['b.library_id = ?'];
    const params = [libId];
    for (const w of words) {
      where.push('(b.search_text LIKE ? OR EXISTS (SELECT 1 FROM copies c WHERE c.book_id = b.id AND c.code LIKE ?))');
      params.push(`%${w}%`, `%${w}%`);
    }
    const books = db.prepare(`SELECT b.id, b.title, b.authors FROM books b WHERE ${where.join(' AND ')}
      ORDER BY b.title COLLATE NOCASE LIMIT 12`).all(...params);
    const copies = db.prepare('SELECT code, location, label_printed_at FROM copies WHERE book_id = ? ORDER BY code');
    res.json(books.map((b) => ({
      id: b.id,
      title: b.title,
      authors: b.authors || '',
      copies: copies.all(b.id).map((c) => ({ code: c.code, location: c.location || '', printed: !!c.label_printed_at })),
    })).filter((b) => b.copies.length));
  });

  // Donnees a imprimer : un QR code (SVG) par exemplaire. Le QR contient l'adresse de
  // la fiche de l'exemplaire dans la bibliotheque (baseUrl + #/c/CODE) : scanne avec
  // l'appareil photo d'un telephone, il ouvre directement la bonne page ; scanne
  // depuis l'app, le code est extrait de l'adresse.
  api.post('/labels', h(async (req, res) => {
    const libId = req.library.id;
    const codes = (Array.isArray(req.body.codes) ? req.body.codes : []).slice(0, 500).map((c) => str(c, 40));
    let baseUrl = str(req.body.baseUrl, 300);
    if (!/^https?:\/\/[^\s#]+$/.test(baseUrl)) throw httpError(400, 'Adresse de base invalide.');
    if (!baseUrl.endsWith('/')) baseUrl += '/';
    const find = db.prepare(`SELECT c.code, c.location, b.title, b.authors FROM copies c
      JOIN books b ON b.id = c.book_id WHERE c.library_id = ? AND c.code = ?`);
    const items = [];
    for (const code of codes) {
      const current = findCopy(libId, code);
      const c = current && find.get(libId, current.code);
      if (!c || items.some((i) => i.code === c.code)) continue;
      const svg = await QRCode.toString(`${baseUrl}#/c/${encodeURIComponent(c.code)}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
      items.push({ code: c.code, title: c.title, authors: c.authors || '', location: c.location || '', svg });
    }
    res.json({ ...publicSettings(req.library), items });
  }));

  api.post('/labels/mark-printed', h((req, res) => {
    const codes = (Array.isArray(req.body.codes) ? req.body.codes : []).slice(0, 500).map((c) => str(c, 40));
    const stmt = db.prepare("UPDATE copies SET label_printed_at = datetime('now') WHERE library_id = ? AND code = ?");
    tx(() => codes.forEach((c) => stmt.run(req.library.id, c)));
    res.json({ ok: true });
  }));

  // ---------- Import ----------
  // Modeles a telecharger : liste d'ISBN, ou fiche complete (une colonne par champ).
  // En .xlsx, la colonne ISBN est au format Texte (y compris les lignes vides a
  // remplir) : Excel ne la transforme pas en nombre ni en notation scientifique.
  api.get('/import/template.:ext', h(async (req, res) => {
    const ext = req.params.ext === 'csv' ? 'csv' : 'xlsx';
    const isbnOnly = req.query.type === 'isbn';
    const header = isbnOnly ? ['ISBN'] : IMPORT_COLUMNS;
    const examples = isbnOnly
      ? [['9782070612758'], ['9782070368228'], ['978-2-253-08327-6']]
      : [
        ['9782070612758', '', '', '', '', '', '', '', 'Roman', 'Armoire A', '2', "Exemple : seul l'ISBN est rempli, le reste est complété automatiquement.", ''],
        ['', 'Guide interne des procédures', 'Édition 2024', 'Service RH', 'Bureau', '2024', '48',
          'Document interne sans ISBN : tous les champs sont saisis à la main.', 'Procédures, RH', 'Bureau 2', '1', '', ''],
      ];
    const name = `modele-import-${isbnOnly ? 'isbn' : 'livres'}`;
    if (ext === 'csv') {
      const lines = [header, ...examples].map((l) => l.map(csvCell).join(';'));
      res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
      return res.type('text/csv; charset=utf-8').send('﻿' + lines.join('\r\n'));
    }
    const text = (v) => ({ value: String(v), type: String, format: '@' });
    const rows = [header.map((v) => ({ value: v, fontWeight: 'bold' }))];
    examples.forEach((l) => rows.push(l.map((v, i) => (i === 0 ? text(v) : (v ? { value: v } : null)))));
    for (let i = 0; i < 500; i++) rows.push([{ value: '', type: String, format: '@' }]);
    const buffer = await writeExcelFile(rows, {
      columns: header.map((hd) => ({ width: { ISBN: 18, Titre: 36, 'Résumé': 50, Notes: 30, Auteurs: 26, 'Couverture (URL)': 30 }[hd] || 14 })),
      sheet: 'Livres',
    }).toBuffer();
    res.set('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
  }));

  // Import d'un livre (une ligne de liste ou de fichier). Appele ligne par ligne par
  // le navigateur, qui affiche la progression. Les valeurs fournies ont priorite ;
  // les champs vides sont completes par la recherche ISBN si demande.
  api.post('/import/book', h(async (req, res) => {
    const libId = req.library.id;
    const b = req.body;
    const rawIsbn = str(b.isbn, 30);
    const isbn = rawIsbn ? normalizeIsbn(rawIsbn) : null;
    if (rawIsbn && !isbn && !str(b.title)) throw httpError(400, `ISBN invalide : ${rawIsbn}`);
    const copies = Math.max(1, Math.min(intOrNull(b.copies) || 1, 50));
    const location = str(b.location, 120);

    if (isbn && b.onDuplicate !== 'new') {
      const existing = db.prepare('SELECT id, title FROM books WHERE library_id = ? AND isbn = ? ORDER BY id LIMIT 1').get(libId, isbn);
      if (existing) {
        if (b.onDuplicate === 'skip') return res.json({ status: 'skipped', bookId: existing.id, title: existing.title });
        const codes = tx(() => createCopies(libId, existing.id, copies, location));
        return res.json({ status: 'copies', bookId: existing.id, title: existing.title, codes });
      }
    }

    const found = isbn && b.fillFromIsbn !== false ? await lookupIsbn(isbn).catch(() => null) : null;
    const pick = (k) => {
      const v = b[k];
      return v !== undefined && v !== null && String(v).trim() !== '' ? v : (found ? found[k] : '');
    };
    if (!str(pick('title'))) {
      throw httpError(422, isbn ? `Aucune information trouvée pour l'ISBN ${isbn} et pas de titre dans la liste.` : 'Titre manquant.');
    }
    const f = readBookFields({
      isbn: isbn || rawIsbn, title: pick('title'), subtitle: pick('subtitle'), authors: pick('authors'),
      publisher: pick('publisher'), year: pick('year'), pages: pick('pages'), summary: pick('summary'), notes: b.notes,
    });
    let cover = null;
    const coverUrl = str(b.coverUrl, 1000) || (found && found.coverUrl) || '';
    if (coverUrl) {
      try { cover = (await media.saveFromUrl(coverUrl, 'cover')) || null; } catch (e) { cover = null; }
    }
    const categories = Array.isArray(b.categories) ? b.categories : String(b.categories || '').split(/[,;|]/);
    const result = tx(() => {
      const r = db.prepare(`INSERT INTO books (library_id, isbn, title, subtitle, authors, publisher, year, pages, summary, notes, search_text, cover)
        VALUES (@library_id, @isbn, @title, @subtitle, @authors, @publisher, @year, @pages, @summary, @notes, @search_text, @cover)`)
        .run({ ...f, library_id: libId, cover });
      const bookId = Number(r.lastInsertRowid);
      setBookCategories(libId, bookId, categories);
      return { bookId, codes: createCopies(libId, bookId, copies, location) };
    });
    res.json({ status: 'created', ...result, title: f.title, sources: found ? found.sources : [] });
  }));

  // ---------- Export ----------
  // Inventaire : une ligne par livre, avec les memes colonnes que le modele d'import
  // (reimportable tel quel, y compris dans une autre bibliotheque) + nombre
  // d'exemplaires, disponibles et codes de tous les exemplaires.
  api.get('/export/inventory.:ext', h(async (req, res) => {
    const lib = req.library;
    const ext = req.params.ext === 'csv' ? 'csv' : 'xlsx';
    const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0];
    const mediaBase = `${proto}://${req.get('host')}${auth.rootPath(req)}/${lib.slug}/media/`;
    const books = db.prepare(`SELECT b.*,
        (SELECT group_concat(name, ', ') FROM (SELECT cat.name FROM book_categories bc JOIN categories cat ON cat.id = bc.category_id
          WHERE bc.book_id = b.id ORDER BY cat.name COLLATE NOCASE)) AS categories,
        (SELECT group_concat(location, ', ') FROM (SELECT DISTINCT location FROM copies c WHERE c.book_id = b.id AND location <> '' ORDER BY location)) AS locations,
        (SELECT group_concat(code, ', ') FROM (SELECT code FROM copies c WHERE c.book_id = b.id ORDER BY code)) AS codes,
        ${COPY_COUNTS}
      FROM books b WHERE b.library_id = ? ORDER BY b.title COLLATE NOCASE`).all(lib.id);
    const header = ['ISBN', 'Titre', 'Sous-titre', 'Auteurs', 'Éditeur', 'Année', 'Pages', 'Résumé', 'Catégories',
      'Emplacement', 'Exemplaires', 'Disponibles', 'Codes des exemplaires', 'Notes', 'Couverture (URL)'];
    const rows = books.map((b) => [b.isbn || '', b.title, b.subtitle || '', b.authors || '', b.publisher || '', b.year || '', b.pages || '',
      b.summary || '', b.categories || '', b.locations || '', b.total_copies, b.available_copies, b.codes || '', b.notes || '',
      b.cover ? mediaBase + b.cover : '']);
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `inventaire-${lib.slug}-${stamp}`;
    if (ext === 'csv') {
      res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
      return res.type('text/csv; charset=utf-8').send('﻿' + [header, ...rows].map((l) => l.map(csvCell).join(';')).join('\r\n'));
    }
    const sheet = [header.map((v) => ({ value: v, fontWeight: 'bold' }))].concat(rows.map((r) => r.map((v, i) => {
      if (i === 0) return { value: String(v), type: String, format: '@' }; // ISBN en texte
      if (v === '' || v == null) return null;
      return typeof v === 'number' ? { value: v, type: Number } : { value: String(v), type: String };
    })));
    const widths = { ISBN: 18, Titre: 36, 'Sous-titre': 24, Auteurs: 26, 'Éditeur': 18, 'Résumé': 50, 'Catégories': 20, Emplacement: 16, 'Codes des exemplaires': 28, Notes: 30, 'Couverture (URL)': 40 };
    const buffer = await writeExcelFile(sheet, { columns: header.map((hd) => ({ width: widths[hd] || 12 })), sheet: 'Inventaire' }).toBuffer();
    res.set('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
  }));

  // Liste des exemplaires : une ligne par exemplaire, avec son pret en cours.
  api.get('/export/copies.csv', (req, res) => {
    const rows = db.prepare(`SELECT c.code, b.isbn, b.title, b.subtitle, b.authors, b.publisher, b.year, b.pages,
        (SELECT group_concat(cat.name, ', ') FROM book_categories bc JOIN categories cat ON cat.id = bc.category_id WHERE bc.book_id = b.id) AS categories,
        c.location, br.name AS borrower, l.loaned_at
      FROM copies c JOIN books b ON b.id = c.book_id
      LEFT JOIN loans l ON l.copy_id = c.id AND l.returned_at IS NULL
      LEFT JOIN borrowers br ON br.id = l.borrower_id
      WHERE c.library_id = ? ORDER BY b.title COLLATE NOCASE, c.code`).all(req.library.id);
    const header = ['Code', 'ISBN', 'Titre', 'Sous-titre', 'Auteurs', 'Éditeur', 'Année', 'Pages', 'Catégories', 'Emplacement', 'Emprunté par', 'Prêté le'];
    const lines = [header, ...rows.map((r) => [r.code, r.isbn, r.title, r.subtitle, r.authors, r.publisher, r.year, r.pages, r.categories, r.location, r.borrower, r.loaned_at])];
    res.set('Content-Disposition', `attachment; filename="${req.library.slug}.csv"`);
    // BOM + point-virgule : ouverture directe correcte dans Excel (reglages belges/francais).
    res.type('text/csv; charset=utf-8').send('﻿' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n'));
  });

  api.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  return api;
}

module.exports = { createLibraryRouter, findLibrary, mediaUrl, str, intOrNull };
