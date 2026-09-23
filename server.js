const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const { db, tx, normalize, getSetting, setSetting, nextCopyCode, MEDIA_DIR } = require('./lib/db');
const auth = require('./lib/auth');
const media = require('./lib/media');
const { normalizeIsbn, lookupIsbn } = require('./lib/isbn');

// Filet de securite : une erreur imprevue ne doit jamais faire tomber tout le serveur.
process.on('uncaughtException', (err) => console.error('Erreur non interceptee (ignoree) :', err));
process.on('unhandledRejection', (err) => console.error('Promesse rejetee non geree (ignoree) :', err));

const app = express();
const PORT = process.env.PORT || 3000;
const { httpError } = media;

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '30d', immutable: true }));

// Scanner de codes-barres/QR (polyfill de l'API BarcodeDetector, moteur ZXing en
// WebAssembly) servi en local : aucune dependance a un CDN externe.
function nodeModuleFile(...parts) {
  const candidates = [
    path.join(__dirname, 'node_modules', ...parts),
    path.join(__dirname, 'node_modules', 'barcode-detector', 'node_modules', ...parts),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}
app.get('/vendor/barcode-detector.js', (req, res) => res.sendFile(nodeModuleFile('barcode-detector', 'dist', 'iife', 'ponyfill.js')));
app.get('/vendor/quagga.min.js', (req, res) => res.sendFile(nodeModuleFile('@ericblade', 'quagga2', 'dist', 'quagga.min.js')));
app.get('/vendor/zxing-reader.js', (req, res) => res.sendFile(nodeModuleFile('zxing-wasm', 'dist', 'iife', 'reader', 'index.js')));
app.get('/vendor/zxing_reader.wasm', (req, res) => res.type('application/wasm').sendFile(nodeModuleFile('zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm')));

// Les routes sont declarees sans prefixe de montage : quand la passerelle monte l'app
// avec app.use('/mylittlelibrary', app), Express retire le prefixe avant d'arriver ici.
const api = express.Router();
app.use('/api', api);

api.use(auth.loadUser);

// Les POST/PUT doivent etre en JSON : un formulaire d'un autre site ne peut pas en
// envoyer sans CORS (protection CSRF, avec SameSite=Lax). Un DELETE d'un autre site
// declenche de toute facon une verification CORS prealable, refusee.
api.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || req.is('application/json')) return next();
  res.status(415).json({ error: 'Requête JSON attendue.' });
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

function serializeBook(b, cats, isAdmin) {
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
  if (isAdmin) {
    out.notes = b.notes || '';
    out.createdAt = b.created_at;
    out.updatedAt = b.updated_at;
  }
  return out;
}

// Recherche multi-mots dans le catalogue (chaque mot doit apparaitre quelque part).
function searchBooks(query, isAdmin) {
  const where = [];
  const params = [];
  const words = normalize(query.q).split(/\s+/).filter(Boolean).slice(0, 8);
  for (const w of words) {
    if (isAdmin) {
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
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const base = `SELECT * FROM (SELECT b.id, b.isbn, b.title, b.subtitle, b.authors, b.publisher, b.year, b.pages,
    b.cover, b.created_at, b.search_text, ${COPY_COUNTS} FROM books b) b ${whereSql}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...params).n;
  const rows = db.prepare(`${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  const cats = categoriesFor(rows.map((r) => r.id));
  return { total, page, limit, items: rows.map((r) => serializeBook(r, cats.get(r.id), false)) };
}

function getBookRow(id) {
  const b = db.prepare(`SELECT b.*, ${COPY_COUNTS} FROM books b WHERE b.id = ?`).get(id);
  if (!b) throw httpError(404, 'Livre introuvable.');
  return b;
}

// Exemplaire par son code actuel, ou par un ancien code (etiquette d'avant une
// regeneration des codes). Renvoie { id, book_id, code } avec le code actuel.
function findCopy(code) {
  const c = str(code, 40);
  return db.prepare('SELECT id, book_id, code FROM copies WHERE code = ?').get(c)
    || db.prepare(`SELECT c.id, c.book_id, c.code FROM copy_code_history h
      JOIN copies c ON c.id = h.copy_id WHERE h.code = ?`).get(c);
}

function publicSettings() {
  return { libraryName: getSetting('libraryName'), logoUrl: mediaUrl(getSetting('logo')) };
}

// ================= API publique (lecture seule) =================
api.get('/public/settings', (req, res) => res.json(publicSettings()));

api.get('/public/categories', (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.name, COUNT(bc.book_id) AS count FROM categories c
    LEFT JOIN book_categories bc ON bc.category_id = c.id GROUP BY c.id ORDER BY c.name COLLATE NOCASE`).all());
});

api.get('/public/books', (req, res) => res.json(searchBooks(req.query, false)));

api.get('/public/books/:id', h((req, res) => {
  const b = getBookRow(idParam(req));
  const book = serializeBook(b, categoriesFor([b.id]).get(b.id), false);
  book.copies = db.prepare(`SELECT c.code, c.location,
      NOT EXISTS (SELECT 1 FROM loans l WHERE l.copy_id = c.id AND l.returned_at IS NULL) AS available
    FROM copies c WHERE c.book_id = ? ORDER BY c.code`).all(b.id)
    .map((c) => ({ code: c.code, location: c.location || '', available: !!c.available }));
  res.json(book);
}));

// Permet d'ouvrir la fiche d'un livre en scannant l'etiquette sans etre connecte.
api.get('/public/copies/:code', h((req, res) => {
  const c = findCopy(req.params.code);
  if (!c) throw httpError(404, 'Exemplaire introuvable.');
  res.json({ bookId: c.book_id, code: c.code });
}));

// ================= Authentification =================
api.get('/auth/status', (req, res) => {
  const hasUser = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  res.json({ user: req.user || null, needsSetup: !hasUser });
});

// Creation du premier compte depuis le navigateur, possible uniquement tant
// qu'aucun compte n'existe (sinon : npm run set-password).
api.post('/auth/setup', h((req, res) => {
  const username = str(req.body.username, 60);
  const password = String(req.body.password || '');
  if (!username || password.length < 8) throw httpError(400, 'Identifiant requis et mot de passe de 8 caractères minimum.');
  const id = tx(() => {
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw httpError(403, 'Un compte existe déjà.');
    return db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, auth.hashPassword(password)).lastInsertRowid;
  });
  auth.createSession(req, res, id);
  res.json({ user: { id: Number(id), username } });
}));

api.post('/auth/login', h(async (req, res) => {
  const username = str(req.body.username, 60);
  const password = String(req.body.password || '');
  if (auth.tooManyFailures(username)) throw httpError(429, 'Trop de tentatives, réessaie dans 15 minutes.');
  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    auth.recordFailure(username);
    await new Promise((r) => setTimeout(r, 600));
    throw httpError(401, 'Identifiant ou mot de passe incorrect.');
  }
  auth.createSession(req, res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
}));

api.post('/auth/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

// Tout ce qui suit necessite d'etre connecte.
api.use((req, res, next) => (req.path.startsWith('/public/') ? next() : auth.requireAuth(req, res, next)));

api.post('/auth/password', h((req, res) => {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(String(req.body.current || ''), user.password_hash)) throw httpError(400, 'Mot de passe actuel incorrect.');
  const next = String(req.body.password || '');
  if (next.length < 8) throw httpError(400, 'Le nouveau mot de passe doit faire 8 caractères minimum.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), req.user.id);
  res.json({ ok: true });
}));

// ================= Reglages =================
function parseLabelLayout() {
  try { return JSON.parse(getSetting('labelLayout') || 'null'); } catch (e) { return null; }
}

api.get('/settings', (req, res) => {
  res.json({
    ...publicSettings(),
    codePrefix: getSetting('codePrefix'),
    nextCodeNumber: Number(getSetting('nextCodeNumber')),
    labelLayout: parseLabelLayout(),
  });
});

api.put('/settings', h((req, res) => {
  const b = req.body;
  if (b.libraryName !== undefined) {
    const name = str(b.libraryName, 120);
    if (!name) throw httpError(400, 'Le nom de la bibliothèque est requis.');
    setSetting('libraryName', name);
  }
  if (b.codePrefix !== undefined) {
    const prefix = str(b.codePrefix, 10).toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(prefix)) throw httpError(400, 'Préfixe : lettres et chiffres uniquement (10 max).');
    setSetting('codePrefix', prefix);
  }
  if (b.labelLayout !== undefined) setSetting('labelLayout', JSON.stringify(b.labelLayout).slice(0, 2000));
  res.json({ ok: true });
}));

api.post('/settings/logo', h((req, res) => {
  const name = media.saveDataUrl(req.body.dataUrl, 'logo');
  media.remove(getSetting('logo'));
  setSetting('logo', name);
  res.json(publicSettings());
}));

api.delete('/settings/logo', (req, res) => {
  media.remove(getSetting('logo'));
  setSetting('logo', '');
  res.json(publicSettings());
});

// ================= Categories et emplacements =================
api.get('/categories', (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.name, COUNT(bc.book_id) AS count FROM categories c
    LEFT JOIN book_categories bc ON bc.category_id = c.id GROUP BY c.id ORDER BY c.name COLLATE NOCASE`).all());
});

api.post('/categories', h((req, res) => {
  const name = str(req.body.name, 80);
  if (!name) throw httpError(400, 'Nom requis.');
  const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
  res.json({ id: Number(r.lastInsertRowid), name });
}));

api.put('/categories/:id', h((req, res) => {
  const name = str(req.body.name, 80);
  if (!name) throw httpError(400, 'Nom requis.');
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, idParam(req));
  res.json({ ok: true });
}));

api.delete('/categories/:id', h((req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(idParam(req));
  res.json({ ok: true });
}));

api.get('/locations', (req, res) => {
  res.json(db.prepare(`SELECT DISTINCT location FROM copies WHERE location IS NOT NULL AND location <> ''
    ORDER BY location COLLATE NOCASE`).all().map((r) => r.location));
});

// ================= Livres =================
api.get('/isbn/:isbn', h(async (req, res) => {
  const isbn = normalizeIsbn(req.params.isbn);
  if (!isbn) throw httpError(400, 'ISBN invalide.');
  const existing = db.prepare('SELECT id, title FROM books WHERE isbn = ?').all(isbn);
  const found = await lookupIsbn(isbn);
  res.json({ isbn, found, existing });
}));

api.get('/books', (req, res) => {
  const result = searchBooks(req.query, true);
  res.json(result);
});

function bookDetail(id) {
  const b = getBookRow(id);
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

api.get('/books/:id', h((req, res) => res.json(bookDetail(idParam(req)))));

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

function setBookCategories(bookId, names) {
  db.prepare('DELETE FROM book_categories WHERE book_id = ?').run(bookId);
  const find = db.prepare('SELECT id FROM categories WHERE name = ?');
  const create = db.prepare('INSERT INTO categories (name) VALUES (?)');
  const link = db.prepare('INSERT OR IGNORE INTO book_categories (book_id, category_id) VALUES (?, ?)');
  for (const raw of (Array.isArray(names) ? names : []).slice(0, 30)) {
    const name = str(raw, 80);
    if (!name) continue;
    const cat = find.get(name);
    link.run(bookId, cat ? cat.id : create.run(name).lastInsertRowid);
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

function createCopies(bookId, count, location) {
  const insert = db.prepare('INSERT INTO copies (code, book_id, location) VALUES (?, ?, ?)');
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = nextCopyCode();
    insert.run(code, bookId, location || null);
    codes.push(code);
  }
  return codes;
}

api.post('/books', h(async (req, res) => {
  const f = readBookFields(req.body);
  const cover = await resolveCover(req.body);
  const count = Math.min(intOrNull(req.body.copies) ?? 1, 50);
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO books (isbn, title, subtitle, authors, publisher, year, pages, summary, notes, search_text, cover)
      VALUES (@isbn, @title, @subtitle, @authors, @publisher, @year, @pages, @summary, @notes, @search_text, @cover)`)
      .run({ ...f, cover: cover || null });
    const bookId = Number(r.lastInsertRowid);
    setBookCategories(bookId, req.body.categories);
    createCopies(bookId, req.body.copies === 0 ? 0 : count, str(req.body.location, 120));
    return bookId;
  });
  res.json(bookDetail(id));
}));

api.put('/books/:id', h(async (req, res) => {
  const id = idParam(req);
  const old = getBookRow(id);
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
    setBookCategories(id, req.body.categories);
  });
  res.json(bookDetail(id));
}));

api.delete('/books/:id', h((req, res) => {
  const id = idParam(req);
  const b = getBookRow(id);
  if (b.available_copies < b.total_copies) throw httpError(409, 'Un exemplaire est en prêt : enregistre son retour avant de supprimer le livre.');
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  media.remove(b.cover);
  res.json({ ok: true });
}));

// ================= Exemplaires =================
api.post('/books/:id/copies', h((req, res) => {
  const id = idParam(req);
  getBookRow(id);
  const count = Math.min(intOrNull(req.body.count) || 1, 50);
  const codes = tx(() => createCopies(id, count, str(req.body.location, 120)));
  res.json({ codes, book: bookDetail(id) });
}));

api.put('/copies/:id', h((req, res) => {
  const id = idParam(req);
  const r = db.prepare('UPDATE copies SET location = ?, notes = ? WHERE id = ?')
    .run(str(req.body.location, 120) || null, str(req.body.notes, 2000) || null, id);
  if (!r.changes) throw httpError(404, 'Exemplaire introuvable.');
  res.json({ ok: true });
}));

api.delete('/copies/:id', h((req, res) => {
  const id = idParam(req);
  if (db.prepare('SELECT 1 FROM loans WHERE copy_id = ? AND returned_at IS NULL').get(id)) {
    throw httpError(409, 'Cet exemplaire est en prêt : enregistre son retour avant de le supprimer.');
  }
  db.prepare('DELETE FROM copies WHERE id = ?').run(id);
  res.json({ ok: true });
}));

// Exemplaire retrouve par son code (saisi ou scanne sur l'etiquette).
api.get('/copies/by-code/:code', h((req, res) => {
  const code = str(req.params.code, 40);
  const c = findCopy(code);
  if (!c) throw httpError(404, `Aucun exemplaire avec le code ${code}.`);
  const book = bookDetail(c.book_id);
  res.json({ copy: book.copies.find((x) => x.id === c.id), book, oldCode: c.code.toUpperCase() !== code.toUpperCase() ? code : null });
}));

// Regenere les codes de tous les exemplaires avec le prefixe choisi, soit en gardant
// les numeros (seul le prefixe change), soit en renumerotant a partir de 1 dans
// l'ordre d'ajout (supprime les trous laisses par les suppressions). Les anciens
// codes restent reconnus (copy_code_history) ; toutes les etiquettes repassent
// "a imprimer".
api.post('/copies/renumber', h((req, res) => {
  const prefix = str(req.body.prefix, 10).toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(prefix)) throw httpError(400, 'Préfixe : lettres et chiffres uniquement (10 max).');
  const compact = !!req.body.compact;
  const count = tx(() => {
    const copies = db.prepare('SELECT id, code FROM copies ORDER BY created_at, id').all();
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
    const remember = db.prepare(`INSERT INTO copy_code_history (code, copy_id) VALUES (?, ?)
      ON CONFLICT(code) DO UPDATE SET copy_id = excluded.copy_id, replaced_at = datetime('now')`);
    const setCode = db.prepare('UPDATE copies SET code = ?, label_printed_at = NULL WHERE id = ?');
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
        remember.run(c.code, c.id);
        changed++;
      } else {
        // Code inchange : l'etiquette actuelle reste valable.
        db.prepare("UPDATE copies SET label_printed_at = datetime('now') WHERE id = ?").run(c.id);
      }
    }
    // Un ancien code redevenu code actuel d'un exemplaire n'a plus a etre redirige.
    db.exec('DELETE FROM copy_code_history WHERE code IN (SELECT code FROM copies)');
    setSetting('codePrefix', prefix);
    setSetting('nextCodeNumber', max + 1);
    return changed;
  });
  res.json({ changed: count });
}));

// ================= Emprunteurs =================
api.get('/borrowers', (req, res) => {
  const q = normalize(req.query.q).trim();
  const rows = db.prepare(`SELECT br.*,
      (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = br.id AND l.returned_at IS NULL) AS open_loans,
      (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = br.id) AS total_loans
    FROM borrowers br ORDER BY br.name COLLATE NOCASE`).all();
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
  const r = db.prepare('INSERT INTO borrowers (name, email, phone, notes) VALUES (@name, @email, @phone, @notes)').run(b);
  res.json({ id: Number(r.lastInsertRowid), ...b });
}));

api.get('/borrowers/:id', h((req, res) => {
  const id = idParam(req);
  const b = db.prepare('SELECT * FROM borrowers WHERE id = ?').get(id);
  if (!b) throw httpError(404, 'Emprunteur introuvable.');
  res.json({
    id: b.id, name: b.name, email: b.email || '', phone: b.phone || '', notes: b.notes || '',
    loans: listLoans({ borrowerId: id, status: 'all' }),
  });
}));

api.put('/borrowers/:id', h((req, res) => {
  const r = db.prepare('UPDATE borrowers SET name = @name, email = @email, phone = @phone, notes = @notes WHERE id = @id')
    .run({ ...readBorrower(req.body), id: idParam(req) });
  if (!r.changes) throw httpError(404, 'Emprunteur introuvable.');
  res.json({ ok: true });
}));

api.delete('/borrowers/:id', h((req, res) => {
  const id = idParam(req);
  if (db.prepare('SELECT 1 FROM loans WHERE borrower_id = ?').get(id)) {
    throw httpError(409, "Cet emprunteur a un historique de prêts : il ne peut pas être supprimé (l'historique serait perdu).");
  }
  db.prepare('DELETE FROM borrowers WHERE id = ?').run(id);
  res.json({ ok: true });
}));

// ================= Prets =================
function listLoans({ status = 'open', borrowerId = null, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (status === 'open') where.push('l.returned_at IS NULL');
  if (status === 'returned') where.push('l.returned_at IS NOT NULL');
  if (borrowerId) { where.push('l.borrower_id = ?'); params.push(borrowerId); }
  return db.prepare(`SELECT l.id, l.loaned_at, l.returned_at, l.notes, c.id AS copy_id, c.code,
      b.id AS book_id, b.title, b.authors, b.cover, br.id AS borrower_id, br.name AS borrower_name
    FROM loans l JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id
    JOIN borrowers br ON br.id = l.borrower_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY l.returned_at IS NOT NULL, COALESCE(l.returned_at, l.loaned_at) DESC, l.id DESC LIMIT ?`).all(...params, limit)
    .map((l) => ({
      id: l.id, loanedAt: l.loaned_at, returnedAt: l.returned_at, notes: l.notes || '',
      copy: { id: l.copy_id, code: l.code },
      book: { id: l.book_id, title: l.title, authors: l.authors || '', coverUrl: mediaUrl(l.cover) },
      borrower: { id: l.borrower_id, name: l.borrower_name },
    }));
}

api.get('/loans', (req, res) => {
  res.json(listLoans({ status: ['open', 'returned', 'all'].includes(req.query.status) ? req.query.status : 'open' }));
});

api.post('/loans', h((req, res) => {
  const code = str(req.body.code, 40);
  const loanId = tx(() => {
    const copy = findCopy(code);
    if (!copy) throw httpError(404, `Aucun exemplaire avec le code ${code}.`);
    if (db.prepare('SELECT 1 FROM loans WHERE copy_id = ? AND returned_at IS NULL').get(copy.id)) {
      throw httpError(409, 'Cet exemplaire est déjà en prêt.');
    }
    let borrowerId = intOrNull(req.body.borrowerId);
    if (borrowerId && !db.prepare('SELECT 1 FROM borrowers WHERE id = ?').get(borrowerId)) borrowerId = null;
    if (!borrowerId) {
      const name = str(req.body.borrowerName, 120);
      if (!name) throw httpError(400, "Choisis ou saisis l'emprunteur.");
      const existing = db.prepare('SELECT id FROM borrowers WHERE name = ? COLLATE NOCASE').get(name);
      borrowerId = existing ? existing.id : Number(db.prepare('INSERT INTO borrowers (name) VALUES (?)').run(name).lastInsertRowid);
    }
    return db.prepare('INSERT INTO loans (copy_id, borrower_id, notes) VALUES (?, ?, ?)')
      .run(copy.id, borrowerId, str(req.body.notes, 1000) || null).lastInsertRowid;
  });
  res.json(listLoans({ status: 'all' }).find((l) => l.id === Number(loanId)));
}));

api.post('/loans/:id/return', h((req, res) => {
  const r = db.prepare("UPDATE loans SET returned_at = datetime('now') WHERE id = ? AND returned_at IS NULL").run(idParam(req));
  if (!r.changes) throw httpError(404, 'Prêt introuvable ou déjà clôturé.');
  res.json({ ok: true });
}));

// ================= Etiquettes =================
api.get('/labels/pending', (req, res) => {
  res.json(db.prepare(`SELECT c.id, c.code, c.location, c.created_at, b.id AS book_id, b.title, b.authors
    FROM copies c JOIN books b ON b.id = c.book_id WHERE c.label_printed_at IS NULL ORDER BY c.code`).all()
    .map((c) => ({ id: c.id, code: c.code, location: c.location || '', bookId: c.book_id, title: c.title, authors: c.authors || '' })));
});

// Donnees a imprimer : un QR code (SVG) par exemplaire. Le QR contient l'adresse de
// la fiche de l'exemplaire dans l'app (baseUrl + #/c/CODE) : scanne avec l'appareil
// photo d'un telephone, il ouvre directement la bonne page ; scanne depuis l'app, le
// code est extrait de l'adresse.
api.post('/labels', h(async (req, res) => {
  const codes = (Array.isArray(req.body.codes) ? req.body.codes : []).slice(0, 500).map((c) => str(c, 40));
  let baseUrl = str(req.body.baseUrl, 300);
  if (!/^https?:\/\/[^\s#]+$/.test(baseUrl)) throw httpError(400, 'Adresse de base invalide.');
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  const find = db.prepare(`SELECT c.code, c.location, b.title, b.authors FROM copies c
    JOIN books b ON b.id = c.book_id WHERE c.code = ?`);
  const items = [];
  for (const code of codes) {
    const current = findCopy(code);
    const c = current && find.get(current.code);
    if (!c || items.some((i) => i.code === c.code)) continue;
    const svg = await QRCode.toString(`${baseUrl}#/c/${encodeURIComponent(c.code)}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    items.push({ code: c.code, title: c.title, authors: c.authors || '', location: c.location || '', svg });
  }
  res.json({ ...publicSettings(), items });
}));

api.post('/labels/mark-printed', h((req, res) => {
  const codes = (Array.isArray(req.body.codes) ? req.body.codes : []).slice(0, 500).map((c) => str(c, 40));
  const stmt = db.prepare("UPDATE copies SET label_printed_at = datetime('now') WHERE code = ?");
  tx(() => codes.forEach((c) => stmt.run(c)));
  res.json({ ok: true });
}));

// ================= Export et sauvegarde =================
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

api.get('/export/copies.csv', (req, res) => {
  const rows = db.prepare(`SELECT c.code, b.isbn, b.title, b.subtitle, b.authors, b.publisher, b.year, b.pages,
      (SELECT group_concat(cat.name, ', ') FROM book_categories bc JOIN categories cat ON cat.id = bc.category_id WHERE bc.book_id = b.id) AS categories,
      c.location, br.name AS borrower, l.loaned_at
    FROM copies c JOIN books b ON b.id = c.book_id
    LEFT JOIN loans l ON l.copy_id = c.id AND l.returned_at IS NULL
    LEFT JOIN borrowers br ON br.id = l.borrower_id ORDER BY b.title COLLATE NOCASE, c.code`).all();
  const header = ['Code', 'ISBN', 'Titre', 'Sous-titre', 'Auteurs', 'Éditeur', 'Année', 'Pages', 'Catégories', 'Emplacement', 'Emprunté par', 'Prêté le'];
  const lines = [header, ...rows.map((r) => [r.code, r.isbn, r.title, r.subtitle, r.authors, r.publisher, r.year, r.pages, r.categories, r.location, r.borrower, r.loaned_at])];
  res.set('Content-Disposition', 'attachment; filename="bibliotheque.csv"');
  // BOM + point-virgule : ouverture directe correcte dans Excel (reglages belges/francais).
  res.type('text/csv; charset=utf-8').send('﻿' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n'));
});

// Copie coherente de la base (VACUUM INTO) a telecharger.
api.get('/backup', h((req, res) => {
  const file = path.join(os.tmpdir(), `mll-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const stamp = new Date().toISOString().slice(0, 10);
  res.download(file, `bibliotheque-${stamp}.db`, () => fs.rm(file, { force: true }, () => {}));
}));

// ================= Erreurs =================
api.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (err && /UNIQUE constraint failed: categories/.test(err.message)) err = httpError(409, 'Cette catégorie existe déjà.');
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Erreur interne du serveur.' : err.message });
});

// Lance seul en developpement (node server.js) ; charge par la passerelle, on se
// contente d'exporter l'app, c'est elle qui ecoute sur le port.
if (require.main === module) {
  app.listen(PORT, () => console.log(`MyLittleLibrary disponible sur http://localhost:${PORT}`));
}

module.exports = app;
