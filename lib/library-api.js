// API d'UNE bibliotheque, montee sur /<adresse-de-la-bibliotheque>/api. Toutes les
// requetes sont limitees a la bibliotheque resolue (req.library) : une bibliotheque
// ne voit jamais les livres, exemplaires ou emprunteurs d'une autre.
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { db, tx, normalize, bookSearchText, nextCopyCode, DATA_DIR } = require('./db');
const auth = require('./auth');
const media = require('./media');
const ebooks = require('./ebooks');
const { normalizeIsbn, lookupIsbn, findIsbn, simplify } = require('./isbn');
const { searchCovers } = require('./covers');
const { registerStats } = require('./stats');
const { registerKobo, matcher } = require('./kobo');
const { readEpubMeta } = require('./epub-meta');

const writeExcelFileModule = require('write-excel-file/node');
const writeExcelFile = writeExcelFileModule.default || writeExcelFileModule;

// Colonnes du modele d'import (reconnues aussi sous d'autres noms, cote navigateur).
const IMPORT_COLUMNS = ['ISBN', 'Titre', 'Sous-titre', 'Auteurs', 'Éditeur', 'Année', 'Pages', 'Résumé',
  'Catégories', 'Emplacement', 'Exemplaires', 'Notes', 'Couverture (URL)', 'Type', 'Collection', 'Série', 'Tome', 'Tags', 'Lecteurs'];

const READING = ['to_read', 'reading', 'read', 'abandoned'];
const OPINION = ['liked', 'disliked'];

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

// Elements affichables du catalogue de l'app (filtres, puis nombre de livres), dans leur ordre.
const CATALOG_FILTERS = ['search', 'category', 'collection', 'series', 'tag', 'mine', 'reader', 'availability', 'format',
  'statusUser', 'reading', 'opinion', 'sort', 'count'];

// Elements affichables sur la miniature d'un livre du catalogue.
const CATALOG_CARD = ['cover', 'title', 'authors', 'series', 'collection', 'categories', 'tags', 'readers', 'status', 'availability', 'ebook'];

function catalogSettings(lib) {
  const parse = (v, all) => {
    let list = null;
    try { list = JSON.parse(v || 'null'); } catch (e) { list = null; }
    return Array.isArray(list) ? all.filter((f) => list.includes(f)) : all;
  };
  return {
    filters: parse(lib.catalog_filters, CATALOG_FILTERS),
    position: lib.filters_position === 'left' ? 'left' : 'top',
    card: parse(lib.catalog_card, CATALOG_CARD),
  };
}

function publicSettings(lib) {
  return {
    slug: lib.slug,
    libraryName: lib.name,
    logoUrl: mediaUrl(lib.logo),
    brandDisplay: ['name', 'logo'].includes(lib.brand_display) ? lib.brand_display : 'both',
    features: { ebooks: !!lib.enable_ebooks, readingStatus: !!lib.enable_reading_status, tags: !!lib.enable_tags, stats: !!lib.enable_stats, kobo: !!(lib.enable_kobo && lib.enable_ebooks) },
    catalog: catalogSettings(lib),
  };
}

// "papier" / "numerique" (formulaires) -> valeur stockee.
function readFormat(v) {
  return /^(ebook|numerique|numérique|digital|e-book|epub|pdf)$/i.test(String(v || '').trim()) ? 'ebook' : 'physical';
}

// Type demande a l'import : "Papier", "Numérique" ou les deux ("Papier + numérique",
// "both"...) -> exemplaires a creer. Vide : papier.
function readImportFormat(v) {
  const t = normalize(String(v || '')).trim();
  if (!t) return { physical: true, ebook: false };
  if (/^(both|les deux|tous|papier et numerique|2)$/.test(t)) return { physical: true, ebook: true };
  const ebook = /num|ebook|e-book|epub|pdf|digital/.test(t);
  const physical = /papier|physi|paper|print|broch|reli/.test(t);
  return { physical: physical || !ebook, ebook };
}

function formatLabel(b) {
  if (b.ebook_copies > 0) return b.total_copies > 0 ? 'Papier + numérique' : 'Numérique';
  return 'Papier';
}

// Classements "libres" d'un livre : categories (toujours) et tags (option de la
// bibliotheque). Meme fonctionnement : table des termes + table de liaison.
const TAXONOMIES = {
  categories: { table: 'categories', link: 'book_categories', col: 'category_id', one: 'catégorie', many: 'catégories' },
  tags: { table: 'tags', link: 'book_tags', col: 'tag_id', one: 'tag', many: 'tags' },
};
const CATEGORIES = TAXONOMIES.categories;
const TAGS = TAXONOMIES.tags;

function termsFor(tax, bookIds) {
  const map = new Map(bookIds.map((id) => [id, []]));
  if (!bookIds.length) return map;
  const rows = db.prepare(`SELECT l.book_id, t.id, t.name FROM ${tax.link} l
    JOIN ${tax.table} t ON t.id = l.${tax.col}
    WHERE l.book_id IN (${bookIds.map(() => '?').join(',')}) ORDER BY t.name COLLATE NOCASE`).all(...bookIds);
  rows.forEach((r) => map.get(r.book_id).push({ id: r.id, name: r.name }));
  return map;
}

function categoriesFor(bookIds) {
  return termsFor(CATEGORIES, bookIds);
}

// Tags d'une liste de livres, ou null si l'option est desactivee (tags masques).
function tagsFor(lib, bookIds) {
  return lib.enable_tags ? termsFor(TAGS, bookIds) : null;
}

// Lecteurs : comptes membres qui lisent, liront ou ont lu un livre (gestion seulement).
// Membres possibles : comptes lies a la bibliotheque, ceux qui ont deja des statuts
// ou sont deja lecteurs d'un de ses livres, et le compte connecte.
function libraryMembers(libId, userId) {
  return db.prepare(`SELECT id, username FROM users WHERE id IN (
      SELECT user_id FROM user_libraries WHERE library_id = ?1
      UNION SELECT s.user_id FROM book_user_status s JOIN books b ON b.id = s.book_id WHERE b.library_id = ?1
      UNION SELECT r.user_id FROM book_readers r JOIN books b ON b.id = r.book_id WHERE b.library_id = ?1
      UNION SELECT ?2)
    ORDER BY username COLLATE NOCASE`).all(libId, userId);
}

function readersFor(bookIds) {
  const map = new Map(bookIds.map((id) => [id, []]));
  if (!bookIds.length) return map;
  db.prepare(`SELECT r.book_id, u.id, u.username FROM book_readers r JOIN users u ON u.id = r.user_id
    WHERE r.book_id IN (${bookIds.map(() => '?').join(',')}) ORDER BY u.username COLLATE NOCASE`).all(...bookIds)
    .forEach((r) => map.get(r.book_id).push({ id: r.id, username: r.username }));
  return map;
}

// Lecteurs demandes -> identifiants de membres. Liste d'identifiants (formulaires) ou
// de noms de comptes, ou texte "Lea, Tom" (colonne "Lecteurs" d'un fichier) ; les
// noms inconnus sont ignores. undefined : aucun changement (null renvoye).
function readerIds(libId, userId, value) {
  if (value === undefined || value === null || value === '') return null;
  const members = libraryMembers(libId, userId);
  const list = Array.isArray(value) ? value : String(value).split(/[,;|]/);
  const ids = list.map((v) => {
    const n = typeof v === 'number' ? v : /^\d+$/.test(String(v).trim()) ? Number(v) : null;
    const m = n ? members.find((x) => x.id === n) : members.find((x) => x.username.toLowerCase() === String(v).trim().toLowerCase());
    return m ? m.id : null;
  }).filter(Boolean);
  return [...new Set(ids)];
}

// Ajoute des lecteurs (jamais de retrait implicite). Renvoie le nombre d'ajouts.
function addReaders(bookId, ids) {
  const add = db.prepare('INSERT OR IGNORE INTO book_readers (book_id, user_id) VALUES (?, ?)');
  return (ids || []).reduce((n, id) => n + add.run(bookId, id).changes, 0);
}

// Exemplaires papier (total, disponibles) et numeriques (sans code ni pret).
const COPY_COUNTS = `
  (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id AND c.format = 'physical') AS total_copies,
  (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id AND c.format = 'physical'
     AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.copy_id = c.id AND l.returned_at IS NULL)) AS available_copies,
  (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id AND c.format = 'ebook') AS ebook_copies`;

// Type d'un livre d'apres ses exemplaires : papier, numerique ou les deux.
function bookFormat(b) {
  if (b.ebook_copies > 0) return b.total_copies > 0 ? 'both' : 'ebook';
  return 'physical';
}

function serializeBook(b, cats, isManager, tags) {
  const out = {
    id: b.id,
    isbn: b.isbn || '',
    title: b.title,
    subtitle: b.subtitle || '',
    authors: b.authors || '',
    publisher: b.publisher || '',
    collection: b.collection || '',
    series: b.series || '',
    seriesNumber: b.series_number || '',
    year: b.year,
    pages: b.pages,
    coverUrl: mediaUrl(b.cover),
    format: bookFormat(b),
    ebookCopies: b.ebook_copies || 0,
    categories: cats || [],
    tags: tags || [],
    totalCopies: b.total_copies,
    availableCopies: b.available_copies,
  };
  if (b.reading !== undefined) out.status = { reading: b.reading || null, opinion: b.opinion || null };
  if (b.summary !== undefined) out.summary = b.summary || '';
  if (isManager) {
    out.notes = b.notes || '';
    out.createdAt = b.created_at;
    out.updatedAt = b.updated_at;
  }
  return out;
}

// Mot de recherche : un ISBN saisi avec tirets/espaces (978-2-07-...) est ramene a
// ses chiffres ; le texte de recherche contient l'ISBN-13 et l'ISBN-10.
function searchWord(w) {
  if (/^[0-9x-]+$/i.test(w) && w.replace(/[^0-9x]/gi, '').length >= 9) return w.replace(/-/g, '');
  return w;
}

// Fiches incompletes (gestion) : condition SQL "information manquante" par champ,
// sur un livre d'alias bk. tags : seulement si l'option est active.
const MISSING = {
  category: 'NOT EXISTS (SELECT 1 FROM book_categories x WHERE x.book_id = bk.id)',
  isbn: "COALESCE(bk.isbn, '') = ''",
  cover: "COALESCE(bk.cover, '') = ''",
  authors: "TRIM(COALESCE(bk.authors, '')) = ''",
  publisher: "TRIM(COALESCE(bk.publisher, '')) = ''",
  year: "COALESCE(bk.year, '') = ''",
  pages: "COALESCE(bk.pages, '') = ''",
  summary: "TRIM(COALESCE(bk.summary, '')) = ''",
  location: "EXISTS (SELECT 1 FROM copies x WHERE x.book_id = bk.id AND x.format = 'physical' AND TRIM(COALESCE(x.location, '')) = '')",
  tags: 'NOT EXISTS (SELECT 1 FROM book_tags x WHERE x.book_id = bk.id)',
};
const missingKeys = (lib) => Object.keys(MISSING).filter((k) => k !== 'tags' || lib.enable_tags);
// Valeurs libres gerees dans les reglages : nom dans l'URL -> colonne de books.
const VALUE_FIELDS = { series: 'series', authors: 'authors', publishers: 'publisher', collections: 'collection' };
const splitAuthors = (s) => String(s || '').split(',').map((a) => a.trim()).filter(Boolean);
const valuesOf = (col, v) => (col === 'authors' ? splitAuthors(v) : [String(v || '').trim()].filter(Boolean));

// Valeurs distinctes (casse ignoree) avec leur nombre de livres.
function valueList(lib, col) {
  const map = new Map();
  db.prepare(`SELECT ${col} AS v FROM books WHERE library_id = ? AND TRIM(COALESCE(${col}, '')) <> ''`).all(lib.id).forEach((r) => {
    new Map(valuesOf(col, r.v).map((n) => [n.toLowerCase(), n])).forEach((name, key) => {
      if (!map.has(key)) map.set(key, { id: name, name, count: 0 });
      map.get(key).count++;
    });
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
}

// Remplace les valeurs `from` par `to` (null = retirer) dans les fiches ; renvoie le nombre de livres modifies.
function rewriteValues(lib, col, from, to) {
  const keys = new Set(from.map((n) => n.trim().toLowerCase()));
  const rows = db.prepare(`SELECT * FROM books WHERE library_id = ? AND TRIM(COALESCE(${col}, '')) <> ''`).all(lib.id);
  // Serie retiree : le numero de tome n'a plus de sens.
  const upd = db.prepare(`UPDATE books SET ${col} = ?, search_text = ?, updated_at = datetime('now')
    ${col === 'series' ? ', series_number = CASE WHEN ? IS NULL THEN NULL ELSE series_number END' : ''} WHERE id = ?`);
  return tx(() => {
    let n = 0;
    rows.forEach((b) => {
      const list = valuesOf(col, b[col]);
      if (!list.some((v) => keys.has(v.toLowerCase()))) return;
      const out = [];
      list.forEach((v) => {
        const w = keys.has(v.toLowerCase()) ? to : v;
        if (w && !out.some((o) => o.toLowerCase() === w.toLowerCase())) out.push(w);
      });
      const next = out.join(', ') || null;
      if (next === b[col]) return;
      const args = [next, bookSearchText({ ...b, [col]: next })];
      if (col === 'series') args.push(next);
      upd.run(...args, b.id);
      n++;
    });
    return n;
  });
}

// Informations que la recherche en ligne peut retrouver (relance en masse).
const REFILL =['isbn', 'category', 'cover', 'authors', 'publisher', 'year', 'pages', 'summary'];

// Categories Google Books (anglais) -> termes francais, pour la correspondance.
const GOOGLE_CATEGORIES = {
  'fiction': 'roman', 'juvenile fiction': 'jeunesse', 'young adult fiction': 'jeunesse', 'juvenile nonfiction': 'jeunesse',
  'comics graphic novels': 'bande dessinee', 'cooking': 'cuisine', 'history': 'histoire', 'biography autobiography': 'biographie',
  'poetry': 'poesie', 'drama': 'theatre', 'science': 'sciences', 'travel': 'voyage', 'philosophy': 'philosophie',
  'psychology': 'psychologie', 'health fitness': 'sante', 'self help': 'developpement personnel', 'religion': 'religion',
  'art': 'art', 'music': 'musique', 'nature': 'nature', 'sports recreation': 'sport', 'education': 'education',
  'true crime': 'policier', 'humor': 'humour', 'gardening': 'jardinage', 'family relationships': 'famille',
};
// Mots simplifies et au singulier ("Romans" -> "roman").
const stems = (s) => simplify(s).split(' ').filter(Boolean).map((w) => (w.length > 3 ? w.replace(/[sx]$/, '') : w));

// Categories EXISTANTES de la bibliotheque dont le nom apparait dans les sujets
// trouves en ligne (jamais de nouvelle categorie).
function matchCategories(libId, subjects) {
  const terms = subjects.flatMap((s) => {
    const parts = String(s).split(/\s*(?:\/|--)\s*/);
    return [...parts, ...parts.map((p) => GOOGLE_CATEGORIES[simplify(p)]).filter(Boolean), GOOGLE_CATEGORIES[simplify(s)] || ''];
  }).filter(Boolean).map((t) => ` ${stems(t).join(' ')} `);
  return db.prepare('SELECT name FROM categories WHERE library_id = ?').all(libId).map((c) => c.name)
    .filter((name) => {
      const n = stems(name).join(' ');
      return n && terms.some((t) => t.includes(` ${n} `));
    });
}

// Recherche multi-mots dans le catalogue (chaque mot doit apparaitre quelque part).
// ctx.isManager : gestion (recherche aussi par code d'exemplaire, statuts de lecture
// du compte ctx.statusUserId).
function searchBooks(lib, query, ctx = {}) {
  const isManager = !!ctx.isManager;
  const where = ['b.library_id = ?'];
  const params = [lib.id];
  // Recherche composee uniquement d'un ISBN ecrit avec espaces (978 2 07 ...) : un seul mot.
  let q = normalize(query.q).trim();
  if (/^[\dx][\dx\s-]+$/i.test(q) && q.replace(/[^\dx]/gi, '').length >= 10) q = q.replace(/[\s-]/g, '');
  const words = q.split(/\s+/).filter(Boolean).slice(0, 8).map(searchWord);
  for (const w of words) {
    if (isManager) {
      where.push('(b.search_text LIKE ? OR EXISTS (SELECT 1 FROM copies c WHERE c.book_id = b.id AND c.code LIKE ?))');
      params.push(`%${w}%`, `%${w}%`);
    } else {
      where.push('b.search_text LIKE ?');
      params.push(`%${w}%`);
    }
  }
  const collection = str(query.collection, 200);
  if (collection) { where.push('b.collection = ? COLLATE NOCASE'); params.push(collection); }
  // Filtre par serie : livres tries par tome (1, 2, ..., 10, puis sans tome).
  const series = str(query.series, 200);
  if (series) { where.push('b.series = ? COLLATE NOCASE'); params.push(series); }
  const cat = intOrNull(query.category);
  if (cat) {
    where.push('EXISTS (SELECT 1 FROM book_categories bc WHERE bc.book_id = b.id AND bc.category_id = ?)');
    params.push(cat);
  }
  const tag = lib.enable_tags ? intOrNull(query.tag) : null;
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND bt.tag_id = ?)');
    params.push(tag);
  }
  // Lecteur choisi, et/ou "Mes livres" (le compte connecte est lecteur).
  const readerFilters = [isManager ? intOrNull(query.reader) : null, isManager && query.mine === '1' ? ctx.statusUserId : null];
  readerFilters.filter(Boolean).forEach((u) => {
    where.push('EXISTS (SELECT 1 FROM book_readers br WHERE br.book_id = b.id AND br.user_id = ?)');
    params.push(u);
  });
  if (isManager && missingKeys(lib).includes(query.missing)) {
    where.push(`b.id IN (SELECT bk.id FROM books bk WHERE bk.library_id = ? AND ${MISSING[query.missing]})`);
    params.push(lib.id);
  }
  if (query.status === 'available') where.push('available_copies > 0');
  if (query.status === 'onloan') where.push('available_copies < total_copies');
  if (lib.enable_ebooks && query.format === 'physical') where.push('total_copies > 0');
  if (lib.enable_ebooks && query.format === 'ebook') where.push('ebook_copies > 0');
  // Liseuse branchee : livres deja dessus (dernier scan ou envoyes depuis l'appli), ou
  // pas encore dessus mais avec un fichier epub.
  const koboDevice = isManager && lib.enable_kobo ? intOrNull(query.koboDevice) : null;
  if (koboDevice && ['on', 'off'].includes(query.kobo)) {
    const onDevice = `b.id IN (SELECT ki.book_id FROM kobo_items ki JOIN kobo_devices kd ON kd.id = ki.device_id
      WHERE kd.id = ? AND kd.library_id = ? AND ki.book_id IS NOT NULL)`;
    where.push(query.kobo === 'on' ? onDevice
      : `NOT ${onDevice} AND EXISTS (SELECT 1 FROM copies cf WHERE cf.book_id = b.id AND cf.format = 'ebook' AND cf.file_key IS NOT NULL)`);
    params.push(koboDevice, lib.id);
  }

  // Statuts de lecture d'un compte (le sien par defaut) : affiches et filtrables.
  const withStatus = isManager && lib.enable_reading_status;
  const statusUser = withStatus ? (intOrNull(query.statusUser) || ctx.statusUserId) : null;
  if (withStatus) {
    if (READING.includes(query.reading)) { where.push('b.reading = ?'); params.push(query.reading); }
    if (query.reading === 'none') where.push('b.reading IS NULL');
    if (OPINION.includes(query.opinion)) { where.push('b.opinion = ?'); params.push(query.opinion); }
  }
  const statusCols = withStatus ? ', s.reading, s.opinion' : '';
  const statusJoin = withStatus ? 'LEFT JOIN book_user_status s ON s.book_id = b.id AND s.user_id = ?' : '';
  const limit = Math.min(intOrNull(query.limit) || 24, 100);
  const page = intOrNull(query.page) || 1;
  const order = series && (!query.sort || query.sort === 'title' || query.sort === 'series')
    ? "b.series_number IS NULL OR b.series_number = '', CAST(b.series_number AS INTEGER), b.series_number, b.title COLLATE NOCASE"
    : query.sort === 'recent' ? 'b.created_at DESC, b.id DESC'
    : query.sort === 'year' ? 'b.year DESC NULLS LAST, b.title COLLATE NOCASE'
    : query.sort === 'author' ? "author_key(b.authors) NULLS LAST, b.series COLLATE NOCASE, b.series_number IS NULL OR b.series_number = '', CAST(b.series_number AS INTEGER), b.title COLLATE NOCASE"
      : 'b.title COLLATE NOCASE';
  const base = `SELECT * FROM (SELECT b.id, b.library_id, b.isbn, b.title, b.subtitle, b.authors, b.publisher, b.year, b.pages,
    b.cover, b.format, b.collection, b.series, b.series_number, b.created_at, b.search_text, ${COPY_COUNTS}${statusCols} FROM books b ${statusJoin}) b WHERE ${where.join(' AND ')}`;
  const allParams = withStatus ? [statusUser, ...params] : params;
  // Tous les identifiants du filtre en cours (selection "Tout selectionner").
  if (isManager && query.ids === '1') return { ids: db.prepare(`SELECT id FROM (${base})`).all(...allParams).map((r) => r.id) };
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...allParams).n;
  const rows = db.prepare(`${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...allParams, limit, (page - 1) * limit);
  const cats = categoriesFor(rows.map((r) => r.id));
  const tags = tagsFor(lib, rows.map((r) => r.id));
  const readers = isManager ? readersFor(rows.map((r) => r.id)) : null;
  return { total, page, limit, items: rows.map((r) => {
    const out = serializeBook(r, cats.get(r.id), false, tags && tags.get(r.id));
    if (readers) out.readers = readers.get(r.id);
    return out;
  }) };
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
  book.copies = db.prepare(`SELECT c.id, c.code, c.format, c.location, c.notes, c.label_printed_at, c.created_at,
      c.file_key, c.file_name, c.file_size, l.id AS loan_id, l.loaned_at, br.id AS borrower_id, br.name AS borrower_name
    FROM copies c
    LEFT JOIN loans l ON l.copy_id = c.id AND l.returned_at IS NULL
    LEFT JOIN borrowers br ON br.id = l.borrower_id
    WHERE c.book_id = ? ORDER BY c.format = 'ebook', c.code, c.id`).all(id).map((c) => ({
    id: c.id,
    code: c.code || '',
    format: c.format,
    location: c.location || '',
    notes: c.notes || '',
    labelPrintedAt: c.label_printed_at,
    createdAt: c.created_at,
    ...(c.format === 'ebook' ? {
      file: c.file_key ? { name: c.file_name, size: c.file_size } : null,
    } : {}),
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
  const isbnRaw = str(body.isbn, 30);
  const isbn = isbnRaw ? normalizeIsbn(isbnRaw) || isbnRaw.replace(/[^0-9Xx]/g, '') : '';
  const f = {
    isbn,
    title,
    subtitle: str(body.subtitle, 300),
    authors: str(body.authors, 500),
    publisher: str(body.publisher, 200),
    collection: str(body.collection, 200),
    series: str(body.series, 200),
    series_number: str(body.seriesNumber, 20),
    year: intOrNull(body.year),
    pages: intOrNull(body.pages),
    summary: str(body.summary, 20000),
    notes: str(body.notes, 5000),
  };
  f.search_text = bookSearchText(f);
  return f;
}

const INSERT_BOOK = `INSERT INTO books (library_id, isbn, title, subtitle, authors, publisher, collection, series, series_number, year, pages, summary, notes, search_text, cover)
  VALUES (@library_id, @isbn, @title, @subtitle, @authors, @publisher, @collection, @series, @series_number, @year, @pages, @summary, @notes, @search_text, @cover)`;

// Statuts de lecture d'un livre : le mien, et ceux des autres comptes.
function statusOut(r) {
  return {
    reading: r ? r.reading : null,
    opinion: r ? r.opinion : null,
    startedAt: r ? r.started_at : null,
    finishedAt: r ? r.finished_at : null,
    abandonedAt: r ? r.abandoned_at : null,
  };
}

function bookStatuses(bookId, userId) {
  const rows = db.prepare(`SELECT s.*, u.username FROM book_user_status s
    JOIN users u ON u.id = s.user_id WHERE s.book_id = ? AND (s.reading IS NOT NULL OR s.opinion IS NOT NULL)
    ORDER BY u.username COLLATE NOCASE`).all(bookId);
  const mine = rows.find((r) => r.user_id === userId);
  return {
    myStatus: statusOut(mine),
    statuses: rows.filter((r) => r.user_id !== userId)
      .map((r) => ({ userId: r.user_id, username: r.username, ...statusOut(r) })),
  };
}

// Date saisie (AAAA-MM-JJ) -> date stockee ; undefined si absente, null si videe.
function readDay(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (!m) throw httpError(400, 'Date invalide.');
  return `${m[1]}-${m[2]}-${m[3]} 12:00:00`;
}

// Dates de lecture apres un changement de statut : debut au passage a "en cours",
// fin au passage a "lu", abandon au passage a "abandonne" ; conservees tant que le
// statut ne change pas, effacees au retour a "a lire". Une date saisie a la main
// (correction) remplace la date automatique.
function nextReadingDates(prev, reading, body) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const same = prev && prev.reading === reading;
  let started = prev ? prev.started_at : null;
  let finished = null;
  let abandoned = null;
  if (reading === 'reading') started = same ? started : now;
  else if (reading === 'read') finished = same ? prev.finished_at : now;
  else if (reading === 'abandoned') abandoned = same ? prev.abandoned_at : now;
  else started = null; // a lire, ou plus de statut de lecture
  const manual = { started: readDay(body.startedAt), finished: readDay(body.finishedAt), abandoned: readDay(body.abandonedAt) };
  if (manual.started !== undefined && reading && reading !== 'to_read') started = manual.started;
  if (manual.finished !== undefined && reading === 'read') finished = manual.finished;
  if (manual.abandoned !== undefined && reading === 'abandoned') abandoned = manual.abandoned;
  return { started, finished, abandoned };
}

// Liste de noms (tableau, ou texte separe par , ; |) -> termes du livre (crees au besoin).
function setBookTerms(tax, libId, bookId, names) {
  const list = Array.isArray(names) ? names : String(names || '').split(/[,;|]/);
  db.prepare(`DELETE FROM ${tax.link} WHERE book_id = ?`).run(bookId);
  const find = db.prepare(`SELECT id FROM ${tax.table} WHERE library_id = ? AND name = ?`);
  const create = db.prepare(`INSERT INTO ${tax.table} (library_id, name) VALUES (?, ?)`);
  const link = db.prepare(`INSERT OR IGNORE INTO ${tax.link} (book_id, ${tax.col}) VALUES (?, ?)`);
  for (const raw of list.slice(0, 30)) {
    const name = str(String(raw).replace(/^#/, ''), 80);
    if (!name) continue;
    const term = find.get(libId, name);
    link.run(bookId, term ? term.id : create.run(libId, name).lastInsertRowid);
  }
}

function setBookCategories(libId, bookId, names) {
  setBookTerms(CATEGORIES, libId, bookId, names);
}

// Les tags ne sont modifies que si l'option est active et qu'ils sont fournis.
function setBookTags(lib, bookId, names) {
  if (lib.enable_tags && names !== undefined) setBookTerms(TAGS, lib.id, bookId, names);
}

// Couverture a l'import : URL de la liste, puis celle de la recherche ISBN, puis
// (si rien n'a abouti) la premiere image valable de la recherche en ligne ("Chercher en ligne").
async function importCover(listUrl, found, query) {
  const tryUrl = async (url) => {
    if (!url) return null;
    try { return (await media.saveFromUrl(url, 'cover')) || null; } catch (e) { return null; }
  };
  for (const url of [listUrl, found && found.coverUrl]) {
    const saved = await tryUrl(url);
    if (saved) return saved;
  }
  if (!query.isbn && !query.title) return null;
  const candidates = await searchCovers(query).catch(() => []);
  // Les resultats elargis ("loose") peuvent etre une autre oeuvre : jamais choisis automatiquement.
  for (const c of candidates.filter((x) => !x.loose).slice(0, 5)) {
    const saved = await tryUrl(c.url);
    if (saved) return saved;
  }
  return null;
}

// Import en mode "mettre a jour" : seules les colonnes remplies du fichier ecrasent
// la fiche existante. Les exemplaires ne sont pas crees ; un emplacement rempli est
// applique aux exemplaires papier. Renvoie les libelles des champs modifies.
const UPDATE_LABELS = { isbn: 'ISBN', title: 'titre', subtitle: 'sous-titre', authors: 'auteurs', publisher: 'éditeur', collection: 'collection',
  series: 'série', seriesNumber: 'tome', year: 'année', pages: 'pages', summary: 'résumé', notes: 'notes', cover: 'couverture',
  categories: 'catégories', tags: 'tags', location: 'emplacement', readers: 'lecteurs' };
async function updateFromImport(lib, id, b, isbn, readers) {
  const old = getBookRow(lib.id, id);
  const filled = (k) => b[k] !== undefined && b[k] !== null && String(b[k]).trim() !== '';
  const cur = { isbn: old.isbn, title: old.title, subtitle: old.subtitle, authors: old.authors, publisher: old.publisher, collection: old.collection,
    series: old.series, seriesNumber: old.series_number, year: old.year, pages: old.pages, summary: old.summary, notes: old.notes };
  const changed = [];
  for (const k of Object.keys(cur).filter((x) => x !== 'isbn')) {
    if (filled(k) && String(b[k]).trim() !== String(cur[k] == null ? '' : cur[k])) { cur[k] = b[k]; changed.push(k); }
  }
  if (isbn && isbn !== old.isbn) { cur.isbn = isbn; changed.push('isbn'); }
  const f = readBookFields(cur);
  // Couverture : l'URL exportee (media de la bibliotheque) designe l'image actuelle.
  let cover = old.cover;
  const coverUrl = str(b.coverUrl, 1000);
  if (coverUrl && !(old.cover && coverUrl.endsWith('/media/' + old.cover))) {
    const saved = await media.saveFromUrl(coverUrl, 'cover').catch(() => null);
    if (saved) { cover = saved; changed.push('cover'); }
  }
  const termNames = (tax) => db.prepare(`SELECT t.name FROM ${tax.link} x JOIN ${tax.table} t ON t.id = x.${tax.col} WHERE x.book_id = ?`).all(id).map((r) => r.name);
  const sameList = (a, list) => {
    const n = (v) => v.map((x) => normalize(String(x).replace(/^#/, '')).trim()).filter(Boolean).sort().join('|');
    return n(String(a).split(/[,;|]/)) === n(list);
  };
  const setCats = filled('categories') && !sameList(b.categories, termNames(CATEGORIES));
  const setTags = lib.enable_tags && filled('tags') && !sameList(b.tags, termNames(TAGS));
  if (setCats) changed.push('categories');
  if (setTags) changed.push('tags');
  const location = str(b.location, 120);
  const locs = db.prepare("SELECT DISTINCT location FROM copies WHERE book_id = ? AND format = 'physical' AND location <> '' ORDER BY location").all(id).map((r) => r.location);
  const setLoc = location && location !== locs.join(', ') && db.prepare("SELECT 1 FROM copies WHERE book_id = ? AND format = 'physical' AND COALESCE(location, '') <> ?").get(id, location);
  if (setLoc) changed.push('location');
  // Lecteurs : seulement ajoutes (colonne remplie ou choix de l'import).
  if (readers && readers.some((u) => !db.prepare('SELECT 1 FROM book_readers WHERE book_id = ? AND user_id = ?').get(id, u))) changed.push('readers');
  if (!changed.length) return { status: 'unchanged', bookId: id, title: old.title };
  tx(() => {
    if (readers) addReaders(id, readers);
    db.prepare(`UPDATE books SET isbn = @isbn, title = @title, subtitle = @subtitle, authors = @authors,
      publisher = @publisher, collection = @collection, series = @series, series_number = @series_number, year = @year, pages = @pages, summary = @summary, notes = @notes,
      search_text = @search_text, cover = @cover, updated_at = datetime('now') WHERE id = @id`).run({ ...f, cover, id });
    if (setCats) setBookCategories(lib.id, id, b.categories);
    if (setTags) setBookTags(lib, id, b.tags);
    if (setLoc) db.prepare("UPDATE copies SET location = ? WHERE book_id = ? AND format = 'physical'").run(location, id);
  });
  if (cover !== old.cover) media.remove(old.cover);
  return { status: 'updated', bookId: id, title: f.title, fields: changed.map((k) => UPDATE_LABELS[k]) };
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

// Exemplaire numerique (epub...) : sans code, donc sans etiquette ni pret. Un seul par livre.
function createEbookCopy(libId, bookId, location) {
  if (db.prepare("SELECT 1 FROM copies WHERE book_id = ? AND format = 'ebook'").get(bookId)) return false;
  db.prepare("INSERT INTO copies (library_id, book_id, format, location) VALUES (?, ?, 'ebook', ?)").run(libId, bookId, location || null);
  return true;
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

  api.get('/public/series', (req, res) => {
    res.json(db.prepare(`SELECT series AS name, COUNT(*) AS count FROM books
      WHERE library_id = ? AND series IS NOT NULL AND series <> ''
      GROUP BY series COLLATE NOCASE ORDER BY series COLLATE NOCASE`).all(req.library.id));
  });

  api.get('/public/collections', (req, res) => {
    res.json(db.prepare(`SELECT collection AS name, COUNT(*) AS count FROM books
      WHERE library_id = ? AND collection IS NOT NULL AND collection <> ''
      GROUP BY collection COLLATE NOCASE ORDER BY collection COLLATE NOCASE`).all(req.library.id));
  });

  // Categories et tags avec leur nombre de livres (tags : vide si l'option est desactivee).
  function termList(tax, lib) {
    if (tax === TAGS && !lib.enable_tags) return [];
    return db.prepare(`SELECT t.id, t.name, COUNT(l.book_id) AS count FROM ${tax.table} t
      LEFT JOIN ${tax.link} l ON l.${tax.col} = t.id WHERE t.library_id = ?
      GROUP BY t.id ORDER BY t.name COLLATE NOCASE`).all(lib.id);
  }
  api.get('/public/categories', (req, res) => res.json(termList(CATEGORIES, req.library)));
  api.get('/public/tags', (req, res) => res.json(termList(TAGS, req.library)));

  api.get('/public/books', (req, res) => res.json(searchBooks(req.library, req.query)));

  api.get('/public/books/:id', h((req, res) => {
    const b = getBookRow(req.library.id, idParam(req));
    const tags = tagsFor(req.library, [b.id]);
    const book = serializeBook(b, categoriesFor([b.id]).get(b.id), false, tags && tags.get(b.id));
    book.copies = db.prepare(`SELECT c.code, c.location,
        NOT EXISTS (SELECT 1 FROM loans l WHERE l.copy_id = c.id AND l.returned_at IS NULL) AS available
      FROM copies c WHERE c.book_id = ? AND c.format = 'physical' ORDER BY c.code`).all(b.id)
      .map((c) => ({ code: c.code, location: c.location || '', available: !!c.available }));
    book.ebookFile = ebooks.accessFor(req.library, b.id, req.user);
    res.json(book);
  }));

  // Fichier epub de l'exemplaire numerique : lecture en ligne (liseuse) ou
  // telechargement (?download=1), selon les droits regles sur l'exemplaire.
  api.get('/public/books/:id/epub', h((req, res) => {
    const b = getBookRow(req.library.id, idParam(req));
    const c = db.prepare("SELECT file_key, file_name FROM copies WHERE book_id = ? AND format = 'ebook' AND file_key IS NOT NULL").get(b.id);
    if (!c || !req.library.enable_ebooks) throw httpError(404, 'Pas de fichier pour ce livre.');
    const download = req.query.download === '1';
    if (!ebooks.rights(req.library, req.user)[download ? 'download' : 'read']) {
      throw httpError(req.user ? 403 : 401, download ? "Tu n'as pas le droit de télécharger ce fichier." : "Tu n'as pas le droit de lire ce fichier.");
    }
    res.set('Cache-Control', 'private, no-store');
    res.type('application/epub+zip');
    if (download) res.attachment(c.file_name || 'livre.epub');
    res.sendFile(ebooks.filePath(c.file_key));
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

  // Reglages (ecriture), classement, vidage, codes et etiquettes : reserves aux
  // gestionnaires et administrateurs (pas au role "utilisateur").
  api.use((req, res, next) => {
    const write = req.method !== 'GET';
    const p = req.path;
    const config = /^\/labels(\/|$)/.test(p) || /^\/(empty|copies\/renumber)$/.test(p)
      || (write && (/^\/settings(\/|$)/.test(p) || /^\/values\//.test(p)));
    if (config && !auth.canConfigure(req.user, req.library.id)) return res.status(403).json({ error: 'Réservé aux gestionnaires de la bibliothèque.' });
    next();
  });

  // ---------- Statistiques (option de la bibliotheque, voir lib/stats.js) ----------
  registerStats(api);

  // ---------- Liseuses Kobo (option de la bibliotheque, voir lib/kobo.js) ----------
  registerKobo(api, { addReaders, createEbookCopy, nextReadingDates, searchBooks });

  // ---------- Reglages de la bibliotheque ----------
  function parseLabelLayout(lib) {
    try { return JSON.parse(lib.label_layout || 'null'); } catch (e) { return null; }
  }

  api.get('/settings', (req, res) => {
    const lib = req.library;
    res.json({ ...publicSettings(lib), codePrefix: lib.code_prefix, nextCodeNumber: lib.next_code_number, labelLayout: parseLabelLayout(lib),
      ebookAccess: { visible: lib.ebook_visible, read: lib.ebook_read, download: lib.ebook_download } });
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
    // Options : livres numeriques, statuts de lecture par compte.
    if (b.features && typeof b.features === 'object') {
      if (b.features.ebooks !== undefined) db.prepare('UPDATE libraries SET enable_ebooks = ? WHERE id = ?').run(b.features.ebooks ? 1 : 0, lib.id);
      if (b.features.readingStatus !== undefined) db.prepare('UPDATE libraries SET enable_reading_status = ? WHERE id = ?').run(b.features.readingStatus ? 1 : 0, lib.id);
      if (b.features.tags !== undefined) db.prepare('UPDATE libraries SET enable_tags = ? WHERE id = ?').run(b.features.tags ? 1 : 0, lib.id);
      if (b.features.stats !== undefined) db.prepare('UPDATE libraries SET enable_stats = ? WHERE id = ?').run(b.features.stats ? 1 : 0, lib.id);
      if (b.features.kobo !== undefined) db.prepare('UPDATE libraries SET enable_kobo = ? WHERE id = ?').run(b.features.kobo ? 1 : 0, lib.id);
    }
    // Droits sur les fichiers epub (voir, lire en ligne, telecharger).
    if (b.ebookAccess && typeof b.ebookAccess === 'object') {
      for (const [key, col] of [['visible', 'ebook_visible'], ['read', 'ebook_read'], ['download', 'ebook_download']]) {
        if (b.ebookAccess[key] !== undefined) db.prepare(`UPDATE libraries SET ${col} = ? WHERE id = ?`).run(ebooks.level(b.ebookAccess[key]), lib.id);
      }
    }
    if (b.brandDisplay !== undefined) {
      db.prepare('UPDATE libraries SET brand_display = ? WHERE id = ?').run(['name', 'logo'].includes(b.brandDisplay) ? b.brandDisplay : 'both', lib.id);
    }
    // Catalogue : filtres affiches et position de la barre de filtres.
    if (b.catalog && typeof b.catalog === 'object') {
      if (Array.isArray(b.catalog.filters)) {
        const filters = CATALOG_FILTERS.filter((f) => b.catalog.filters.includes(f));
        db.prepare('UPDATE libraries SET catalog_filters = ? WHERE id = ?').run(JSON.stringify(filters), lib.id);
      }
      if (Array.isArray(b.catalog.card)) {
        const card = CATALOG_CARD.filter((f) => b.catalog.card.includes(f));
        db.prepare('UPDATE libraries SET catalog_card = ? WHERE id = ?').run(JSON.stringify(card), lib.id);
      }
      if (b.catalog.position !== undefined) {
        db.prepare('UPDATE libraries SET filters_position = ? WHERE id = ?').run(b.catalog.position === 'left' ? 'left' : 'top', lib.id);
      }
    }
    res.json({ ok: true });
  }));

  // Comptes dont on peut afficher/filtrer les statuts de lecture, et lecteurs possibles.
  api.get('/members', (req, res) => res.json(libraryMembers(req.library.id, req.user.id)));

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

  // ---------- Categories, tags et emplacements ----------
  // Memes routes pour les deux classements : /categories/... et /tags/...
  for (const [path, tax] of Object.entries(TAXONOMIES)) {
    const guard = (req) => {
      if (tax === TAGS && !req.library.enable_tags) throw httpError(409, "Les tags ne sont pas activés pour cette bibliothèque.");
    };

    api.get(`/${path}`, (req, res) => res.json(termList(tax, req.library)));

    api.post(`/${path}`, h((req, res) => {
      guard(req);
      const name = str(String(req.body.name || '').replace(/^#/, ''), 80);
      if (!name) throw httpError(400, 'Nom requis.');
      const r = db.prepare(`INSERT INTO ${tax.table} (library_id, name) VALUES (?, ?)`).run(req.library.id, name);
      res.json({ id: Number(r.lastInsertRowid), name });
    }));

    api.put(`/${path}/:id`, h((req, res) => {
      guard(req);
      const name = str(String(req.body.name || '').replace(/^#/, ''), 80);
      if (!name) throw httpError(400, 'Nom requis.');
      db.prepare(`UPDATE ${tax.table} SET name = ? WHERE id = ? AND library_id = ?`).run(name, idParam(req), req.library.id);
      res.json({ ok: true });
    }));

    api.delete(`/${path}/:id`, h((req, res) => {
      db.prepare(`DELETE FROM ${tax.table} WHERE id = ? AND library_id = ?`).run(idParam(req), req.library.id);
      res.json({ ok: true });
    }));

    // Fusion : les livres des termes choisis passent dans le terme cible (un des
    // termes choisis, un existant ou un nouveau), les autres disparaissent.
    api.post(`/${path}/merge`, h((req, res) => {
      guard(req);
      const libId = req.library.id;
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(intOrNull).filter(Boolean);
      const name = str(String(req.body.name || '').replace(/^#/, ''), 80);
      if (ids.length < 1 || !name) throw httpError(400, `Choisis les ${tax.many} à fusionner et le nom final.`);
      const result = tx(() => {
        const owned = ids.filter((id) => db.prepare(`SELECT 1 FROM ${tax.table} WHERE id = ? AND library_id = ?`).get(id, libId));
        if (!owned.length) throw httpError(404, `${tax.many} introuvables.`);
        // Cible : terme existant portant ce nom (choisi ou non), sinon le premier choisi, renomme.
        let target = db.prepare(`SELECT id FROM ${tax.table} WHERE library_id = ? AND name = ?`).get(libId, name);
        if (!target) {
          db.prepare(`UPDATE ${tax.table} SET name = ? WHERE id = ?`).run(name, owned[0]);
          target = { id: owned[0] };
        }
        const others = owned.filter((id) => id !== target.id);
        const move = db.prepare(`INSERT OR IGNORE INTO ${tax.link} (book_id, ${tax.col}) SELECT book_id, ? FROM ${tax.link} WHERE ${tax.col} = ?`);
        const del = db.prepare(`DELETE FROM ${tax.table} WHERE id = ?`);
        others.forEach((id) => { move.run(target.id, id); del.run(id); });
        const books = db.prepare(`SELECT COUNT(*) AS n FROM ${tax.link} WHERE ${tax.col} = ?`).get(target.id).n;
        return { id: target.id, name, merged: others.length, books };
      });
      res.json(result);
    }));
  }

  // ---------- Series, auteurs, editeurs et collections ----------
  // Pas de table : ces valeurs vivent dans les colonnes des fiches (auteurs : liste
  // separee par des virgules). Renommer, fusionner ou supprimer reecrit les fiches
  // concernees ; la casse est ignoree ("victor hugo" = "Victor Hugo").
  const valueCol = (req) => {
    const col = VALUE_FIELDS[req.params.kind];
    if (!col) throw httpError(404, 'Liste inconnue.');
    return col;
  };

  api.get('/values/:kind', h((req, res) => res.json(valueList(req.library, valueCol(req)))));

  // Renommage (fusionne de fait avec une valeur existante du meme nom).
  api.put('/values/:kind', h((req, res) => {
    const col = valueCol(req);
    const from = str(req.body.from, 500);
    const name = str(req.body.name, col === 'authors' ? 200 : 500);
    if (!from || !name) throw httpError(400, 'Nom requis.');
    if (col === 'authors' && name.includes(',')) throw httpError(400, 'Un nom d\'auteur ne peut pas contenir de virgule.');
    res.json({ name, books: rewriteValues(req.library, col, [from], name) });
  }));

  api.post('/values/:kind/merge', h((req, res) => {
    const col = valueCol(req);
    const from = (Array.isArray(req.body.ids) ? req.body.ids : []).map((v) => str(v, 500)).filter(Boolean);
    const name = str(req.body.name, 500);
    if (!from.length || !name) throw httpError(400, 'Choisis les valeurs à fusionner et le nom final.');
    if (col === 'authors' && name.includes(',')) throw httpError(400, 'Un nom d\'auteur ne peut pas contenir de virgule.');
    res.json({ name, books: rewriteValues(req.library, col, from, name) });
  }));

  // Suppression : la valeur est retiree des fiches (les livres restent au catalogue).
  api.post('/values/:kind/delete', h((req, res) => {
    const col = valueCol(req);
    const name = str(req.body.name, 500);
    if (!name) throw httpError(400, 'Nom requis.');
    res.json({ books: rewriteValues(req.library, col, [name], null) });
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

  // Couvertures proposees en ligne (par ISBN et/ou titre + auteur).
  api.get('/covers', h(async (req, res) => {
    const q = { isbn: String(req.query.isbn || ''), title: String(req.query.title || ''), author: String(req.query.author || '') };
    if (!normalizeIsbn(q.isbn) && !q.title.trim()) throw httpError(400, 'Indique un ISBN ou un titre.');
    res.json({ covers: await searchCovers(q) });
  }));

  // Nombre de livres sans chaque information (fiches incompletes).
  api.get('/books/missing', (req, res) => {
    const keys = missingKeys(req.library);
    const row = db.prepare(`SELECT COUNT(*) AS total, ${keys.map((k) => `SUM(CASE WHEN ${MISSING[k]} THEN 1 ELSE 0 END) AS ${k}`).join(', ')}
      FROM books bk WHERE bk.library_id = ?`).get(req.library.id);
    res.json({ total: row.total, counts: Object.fromEntries(keys.map((k) => [k, row[k] || 0])) });
  });

  // Livres concernes par une information manquante (ids), pour les actions en masse
  // des fiches incompletes. online=1 : seulement ceux que la recherche en ligne peut
  // completer (avec ISBN ; pour l'ISBN lui-meme : avec un titre).
  api.get('/books/missing/:key/ids', (req, res) => {
    const key = String(req.params.key);
    if (!missingKeys(req.library).includes(key)) throw httpError(400, 'Information inconnue.');
    const online = req.query.online === '1';
    if (online && !REFILL.includes(key)) throw httpError(400, 'Information non recherchable en ligne.');
    const extra = !online ? '' : key === 'isbn' ? "AND TRIM(COALESCE(bk.title, '')) <> ''" : "AND COALESCE(bk.isbn, '') <> ''";
    const ids = db.prepare(`SELECT bk.id FROM books bk WHERE bk.library_id = ? AND ${MISSING[key]} ${extra}
      ORDER BY bk.title COLLATE NOCASE`).all(req.library.id).map((r) => r.id);
    res.json({ ids });
  });

  // Relance de la recherche en ligne pour un livre et une information vide.
  // Rien n'est ecrase : l'information n'est ecrite que si elle est toujours vide.
  api.post('/books/:id/refill', h(async (req, res) => {
    const field = String(req.body.field || '');
    if (!REFILL.includes(field)) throw httpError(400, 'Information non recherchable en ligne.');
    const libId = req.library.id;
    const b = getBookRow(libId, idParam(req));
    const notFound = () => res.json({ status: 'notfound' });
    if (field === 'isbn') {
      if (b.isbn) return notFound();
      const isbn = await findIsbn(b).catch(() => null);
      if (!isbn) return notFound();
      db.prepare("UPDATE books SET isbn = ?, search_text = ?, updated_at = datetime('now') WHERE id = ?")
        .run(isbn, bookSearchText({ ...b, isbn }), b.id);
      return res.json({ status: 'filled', value: isbn });
    }
    const isbn = normalizeIsbn(b.isbn);
    const found = isbn ? await lookupIsbn(isbn).catch(() => null) : null;
    if (field === 'category') {
      if (termsFor(CATEGORIES, [b.id]).get(b.id).length) return notFound();
      const names = matchCategories(libId, found ? found.subjects : []);
      if (!names.length) return notFound();
      setBookTerms(CATEGORIES, libId, b.id, names);
      return res.json({ status: 'filled', value: names.join(', ') });
    }
    let value = null;
    if (field === 'cover') {
      if (!b.cover) value = await importCover('', found, { isbn, title: b.title, author: b.authors });
    } else if (found && found[field] && !String(b[field] ?? '').trim()) {
      value = field === 'year' || field === 'pages' ? intOrNull(found[field]) : String(found[field]).trim();
    }
    if (!value) return notFound();
    db.prepare(`UPDATE books SET ${field} = ?, search_text = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(value, bookSearchText({ ...b, [field]: value }), b.id);
    res.json({ status: 'filled' });
  }));

  api.get('/books', (req, res) => res.json(searchBooks(req.library, req.query, { isManager: true, statusUserId: req.user.id })));

  // Fiche complete (gestion) ; avec les statuts de lecture si l'option est active.
  function fullBook(req, id) {
    const book = bookDetail(req.library.id, id);
    if (req.library.enable_reading_status) Object.assign(book, bookStatuses(id, req.user.id));
    if (req.library.enable_tags) book.tags = termsFor(TAGS, [id]).get(id);
    book.readers = readersFor([id]).get(id);
    book.ebookFile = ebooks.accessFor(req.library, id, req.user);
    return book;
  }

  api.get('/books/:id', h((req, res) => res.json(fullBook(req, idParam(req)))));

  // Lecteurs d'un livre : bouton "Interesse" de la fiche (le compte connecte) ; les
  // autres membres se choisissent dans le formulaire de modification (PUT /books/:id).
  // Le statut de lecture n'y touche jamais.
  api.post('/books/:id/readers', h((req, res) => {
    const id = idParam(req);
    getBookRow(req.library.id, id);
    const ids = readerIds(req.library.id, req.user.id, [req.body.userId]);
    if (!ids.length) throw httpError(400, 'Membre inconnu.');
    addReaders(id, ids);
    res.json(readersFor([id]).get(id));
  }));

  api.delete('/books/:id/readers/:userId', h((req, res) => {
    const id = idParam(req);
    getBookRow(req.library.id, id);
    db.prepare('DELETE FROM book_readers WHERE book_id = ? AND user_id = ?').run(id, idParam(req, 'userId'));
    res.json(readersFor([id]).get(id));
  }));

  // Statut de lecture du compte connecte pour un livre (null = aucun).
  api.put('/books/:id/status', h((req, res) => {
    if (!req.library.enable_reading_status) throw httpError(409, 'Les statuts de lecture ne sont pas activés pour cette bibliothèque.');
    const id = idParam(req);
    getBookRow(req.library.id, id);
    const reading = READING.includes(req.body.reading) ? req.body.reading : null;
    const opinion = OPINION.includes(req.body.opinion) ? req.body.opinion : null;
    const prev = db.prepare('SELECT * FROM book_user_status WHERE book_id = ? AND user_id = ?').get(id, req.user.id);
    if (!reading && !opinion) {
      db.prepare('DELETE FROM book_user_status WHERE book_id = ? AND user_id = ?').run(id, req.user.id);
      return res.json(statusOut(null));
    }
    const d = nextReadingDates(prev, reading, req.body);
    db.prepare(`INSERT INTO book_user_status (book_id, user_id, reading, opinion, started_at, finished_at, abandoned_at)
      VALUES (@book, @user, @reading, @opinion, @started, @finished, @abandoned)
      ON CONFLICT(book_id, user_id) DO UPDATE SET reading = excluded.reading, opinion = excluded.opinion,
        started_at = excluded.started_at, finished_at = excluded.finished_at, abandoned_at = excluded.abandoned_at,
        updated_at = datetime('now')`)
      .run({ book: id, user: req.user.id, reading, opinion, ...d });
    res.json(statusOut(db.prepare('SELECT * FROM book_user_status WHERE book_id = ? AND user_id = ?').get(id, req.user.id)));
  }));

  api.post('/books', h(async (req, res) => {
    const libId = req.library.id;
    const f = readBookFields(req.body);
    const cover = await resolveCover(req.body);
    // Exemplaires papier (0 possible) et, si l'option est active, un exemplaire numerique.
    // (Ancien format d'appel : format = 'ebook' -> numerique seul.)
    const ebook = !!req.library.enable_ebooks && (req.body.ebook === true || readFormat(req.body.format) === 'ebook');
    const count = req.body.copies === undefined ? (readFormat(req.body.format) === 'ebook' ? 0 : 1)
      : Math.min(intOrNull(req.body.copies) || 0, 50);
    const id = tx(() => {
      const r = db.prepare(INSERT_BOOK).run({ ...f, library_id: libId, cover: cover || null });
      const bookId = Number(r.lastInsertRowid);
      setBookCategories(libId, bookId, req.body.categories);
      setBookTags(req.library, bookId, req.body.tags);
      // Lecteurs choisis, sinon le compte qui ajoute le livre.
      addReaders(bookId, readerIds(libId, req.user.id, req.body.readers) || [req.user.id]);
      createCopies(libId, bookId, count, str(req.body.location, 120));
      if (ebook) createEbookCopy(libId, bookId, str(req.body.ebookLocation, 120));
      return bookId;
    });
    res.json(fullBook(req, id));
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
        publisher = @publisher, collection = @collection, series = @series, series_number = @series_number, year = @year, pages = @pages, summary = @summary, notes = @notes,
        search_text = @search_text, cover = @cover, updated_at = datetime('now') WHERE id = @id`).run({ ...f, cover, id });
      setBookCategories(libId, id, req.body.categories);
      setBookTags(req.library, id, req.body.tags);
      // Lecteurs (formulaire de modification) : la liste envoyee remplace l'actuelle.
      const readers = Array.isArray(req.body.readers) ? readerIds(libId, req.user.id, req.body.readers) : null;
      if (readers) {
        db.prepare(`DELETE FROM book_readers WHERE book_id = ?${readers.length ? ` AND user_id NOT IN (${readers.map(() => '?').join(',')})` : ''}`).run(id, ...readers);
        addReaders(id, readers);
      }
    });
    res.json(fullBook(req, id));
  }));

  // Suppression en masse (selection du catalogue). Les livres dont un exemplaire est
  // en pret sont conserves (retour a enregistrer d'abord).
  api.post('/books/bulk-delete', h((req, res) => {
    const libId = req.library.id;
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(intOrNull).filter(Boolean).slice(0, 10000);
    if (!ids.length) throw httpError(400, 'Aucun livre sélectionné.');
    const get = db.prepare('SELECT id, cover FROM books WHERE id = ? AND library_id = ?');
    const onLoan = db.prepare('SELECT 1 FROM copies c JOIN loans l ON l.copy_id = c.id AND l.returned_at IS NULL WHERE c.book_id = ?');
    const del = db.prepare('DELETE FROM books WHERE id = ?');
    const covers = [];
    let deleted = 0;
    let onLoanCount = 0;
    tx(() => ids.forEach((id) => {
      const b = get.get(id, libId);
      if (!b) return;
      if (onLoan.get(id)) { onLoanCount++; return; }
      del.run(id);
      deleted++;
      if (b.cover) covers.push(b.cover);
    }));
    covers.forEach((c) => media.remove(c));
    ebooks.purgeOrphans();
    res.json({ deleted, onLoan: onLoanCount });
  }));

  // Modification en masse (selection du catalogue). Seules les cles presentes dans
  // "changes" sont appliquees : serie / collection ('' = vider), categories, tags et
  // lecteurs ajoutes ou retires, version numerique ajoutee ou retiree, statut de lecture et
  // avis du compte connecte ('' = retirer).
  api.post('/books/bulk-edit', h((req, res) => {
    const lib = req.library;
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(intOrNull).filter(Boolean).slice(0, 10000);
    if (!ids.length) throw httpError(400, 'Aucun livre sélectionné.');
    const ch = req.body.changes || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(ch, k);
    const names = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;|]/))
      .map((x) => str(String(x).replace(/^#/, ''), 80)).filter(Boolean).slice(0, 30);
    const terms = [];
    if (has('categoriesAdd') || has('categoriesRemove')) terms.push([CATEGORIES, names(ch.categoriesAdd), names(ch.categoriesRemove)]);
    if (lib.enable_tags && (has('tagsAdd') || has('tagsRemove'))) terms.push([TAGS, names(ch.tagsAdd), names(ch.tagsRemove)]);
    const ebook = lib.enable_ebooks && ['add', 'remove'].includes(ch.ebook) ? ch.ebook : null;
    const statusOn = !!lib.enable_reading_status && (has('reading') || has('opinion'));
    const readersAdd = has('readersAdd') ? readerIds(lib.id, req.user.id, ch.readersAdd) : [];
    const readersRemove = has('readersRemove') ? readerIds(lib.id, req.user.id, ch.readersRemove) : [];
    const delReader = db.prepare('DELETE FROM book_readers WHERE book_id = ? AND user_id = ?');
    // Emplacement : seulement pour les exemplaires papier qui n'en ont pas.
    const fillLocation = has('fillLocation') ? str(ch.fillLocation, 120) : null;
    const setLocation = db.prepare(`UPDATE copies SET location = ? WHERE book_id = ? AND format = 'physical'
      AND TRIM(COALESCE(location, '')) = ''`);
    if (has('reading') && ch.reading && !READING.includes(ch.reading)) throw httpError(400, 'Statut de lecture invalide.');
    if (has('opinion') && ch.opinion && !OPINION.includes(ch.opinion)) throw httpError(400, 'Avis invalide.');

    const get = db.prepare('SELECT * FROM books WHERE id = ? AND library_id = ?');
    const upd = db.prepare(`UPDATE books SET collection = @collection, series = @series, search_text = @search_text,
      updated_at = datetime('now') WHERE id = @id`);
    const getStatus = db.prepare('SELECT * FROM book_user_status WHERE book_id = ? AND user_id = ?');
    const delStatus = db.prepare('DELETE FROM book_user_status WHERE book_id = ? AND user_id = ?');
    const putStatus = db.prepare(`INSERT INTO book_user_status (book_id, user_id, reading, opinion, started_at, finished_at, abandoned_at)
      VALUES (@book, @user, @reading, @opinion, @started, @finished, @abandoned)
      ON CONFLICT(book_id, user_id) DO UPDATE SET reading = excluded.reading, opinion = excluded.opinion,
        started_at = excluded.started_at, finished_at = excluded.finished_at, abandoned_at = excluded.abandoned_at,
        updated_at = datetime('now')`);
    let updated = 0;
    tx(() => ids.forEach((id) => {
      const b = get.get(id, lib.id);
      if (!b) return;
      if (has('series') || has('collection')) {
        const f = { ...b };
        if (has('series')) f.series = str(ch.series, 200) || null;
        if (has('collection')) f.collection = str(ch.collection, 200) || null;
        upd.run({ id, collection: f.collection, series: f.series, search_text: bookSearchText(f) });
      }
      for (const [tax, add, remove] of terms) {
        const current = termsFor(tax, [id]).get(id).map((t) => t.name);
        const drop = new Set(remove.map((n) => n.toLowerCase()));
        const next = current.filter((n) => !drop.has(n.toLowerCase()));
        add.forEach((n) => { if (!next.some((x) => x.toLowerCase() === n.toLowerCase())) next.push(n); });
        setBookTerms(tax, lib.id, id, next);
      }
      addReaders(id, readersAdd);
      readersRemove.forEach((u) => delReader.run(id, u));
      if (fillLocation) setLocation.run(fillLocation, id);
      if (ebook === 'add') createEbookCopy(lib.id, id, null);
      if (ebook === 'remove') db.prepare("DELETE FROM copies WHERE book_id = ? AND format = 'ebook'").run(id);
      if (statusOn) {
        const prev = getStatus.get(id, req.user.id);
        const reading = has('reading') ? ch.reading || null : prev ? prev.reading : null;
        const opinion = has('opinion') ? ch.opinion || null : prev ? prev.opinion : null;
        if (!reading && !opinion) delStatus.run(id, req.user.id);
        else putStatus.run({ book: id, user: req.user.id, reading, opinion, ...nextReadingDates(prev, reading, {}) });
      }
      updated++;
    }));
    if (ebook === 'remove') ebooks.purgeOrphans();
    res.json({ updated });
  }));

  // Vide la bibliotheque : tous les livres, exemplaires, prets et statuts de lecture ;
  // en option les emprunteurs, categories et tags, et la numerotation des codes.
  // Reglages, logo et membres sont conserves. Une sauvegarde de la base est faite avant.
  api.post('/empty', h((req, res) => {
    const lib = req.library;
    if (String(req.body.confirm || '').trim() !== lib.name.trim()) {
      throw httpError(400, 'Confirmation incorrecte : tape exactement le nom de la bibliothèque.');
    }
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const backup = `library-avant-vidage-${lib.slug}-${stamp}.db`;
    db.exec(`VACUUM INTO '${path.join(dir, backup).replace(/'/g, "''")}'`);
    const covers = db.prepare('SELECT cover FROM books WHERE library_id = ? AND cover IS NOT NULL').all(lib.id).map((r) => r.cover);
    const deleted = tx(() => {
      const n = db.prepare('DELETE FROM books WHERE library_id = ?').run(lib.id).changes;
      if (req.body.borrowers) db.prepare('DELETE FROM borrowers WHERE library_id = ?').run(lib.id);
      if (req.body.terms) {
        db.prepare('DELETE FROM categories WHERE library_id = ?').run(lib.id);
        db.prepare('DELETE FROM tags WHERE library_id = ?').run(lib.id);
      }
      if (req.body.resetCodes) {
        db.prepare('DELETE FROM copy_code_history WHERE library_id = ?').run(lib.id);
        db.prepare('UPDATE libraries SET next_code_number = 1 WHERE id = ?').run(lib.id);
      }
      return n;
    });
    covers.forEach((c) => media.remove(c));
    ebooks.purgeOrphans();
    res.json({ deleted, backup });
  }));

  api.delete('/books/:id', h((req, res) => {
    const id = idParam(req);
    const b = getBookRow(req.library.id, id);
    if (b.available_copies < b.total_copies) throw httpError(409, 'Un exemplaire est en prêt : enregistre son retour avant de supprimer le livre.');
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    media.remove(b.cover);
    ebooks.purgeOrphans();
    res.json({ ok: true });
  }));

  // ---------- Exemplaires ----------
  api.post('/books/:id/copies', h((req, res) => {
    const libId = req.library.id;
    const id = idParam(req);
    getBookRow(libId, id);
    if (readFormat(req.body.format) === 'ebook') {
      if (!req.library.enable_ebooks) throw httpError(409, 'Les livres numériques ne sont pas activés pour cette bibliothèque.');
      if (!createEbookCopy(libId, id, str(req.body.location, 120))) throw httpError(409, 'Ce livre a déjà un exemplaire numérique.');
      return res.json({ codes: [], book: bookDetail(libId, id) });
    }
    const count = Math.min(intOrNull(req.body.count) || 1, 50);
    const codes = tx(() => createCopies(libId, id, count, str(req.body.location, 120)));
    res.json({ codes, book: bookDetail(libId, id) });
  }));

  api.put('/copies/:id', h((req, res) => {
    const id = idParam(req);
    const r = db.prepare('UPDATE copies SET location = ?, notes = ? WHERE id = ? AND library_id = ?')
      .run(str(req.body.location, 120) || null, str(req.body.notes, 2000) || null, id, req.library.id);
    if (!r.changes) throw httpError(404, 'Exemplaire introuvable.');
    res.json({ ok: true });
  }));

  // Fichier epub de l'exemplaire numerique : envoye brut (application/epub+zip),
  // nom d'origine dans l'en-tete X-File-Name (encodeURIComponent). Remplace l'ancien.
  api.put('/copies/:id/file', express.raw({ type: 'application/epub+zip', limit: ebooks.MAX_BYTES }), h((req, res) => {
    const id = idParam(req);
    const c = db.prepare("SELECT file_key FROM copies WHERE id = ? AND library_id = ? AND format = 'ebook'").get(id, req.library.id);
    if (!c) throw httpError(404, 'Exemplaire numérique introuvable.');
    let name = '';
    try { name = decodeURIComponent(String(req.get('X-File-Name') || '')); } catch (e) { /* nom illisible */ }
    name = str(name.replace(/[\\/\r\n"]/g, '_'), 200) || 'livre.epub';
    if (!/\.epub$/i.test(name)) name += '.epub';
    const key = ebooks.save(req.body);
    db.prepare('UPDATE copies SET file_key = ?, file_name = ?, file_size = ? WHERE id = ?').run(key, name, req.body.length, id);
    ebooks.remove(c.file_key);
    res.json({ file: { name, size: req.body.length } });
  }));

  api.delete('/copies/:id/file', h((req, res) => {
    const id = idParam(req);
    const c = db.prepare("SELECT file_key FROM copies WHERE id = ? AND library_id = ? AND format = 'ebook'").get(id, req.library.id);
    if (!c) throw httpError(404, 'Exemplaire numérique introuvable.');
    db.prepare('UPDATE copies SET file_key = NULL, file_name = NULL, file_size = NULL WHERE id = ?').run(id);
    ebooks.remove(c.file_key);
    res.json({ ok: true });
  }));

  api.delete('/copies/:id', h((req, res) => {
    const id = idParam(req);
    if (db.prepare('SELECT 1 FROM loans WHERE copy_id = ? AND returned_at IS NULL').get(id)) {
      throw httpError(409, 'Cet exemplaire est en prêt : enregistre son retour avant de le supprimer.');
    }
    db.prepare('DELETE FROM copies WHERE id = ? AND library_id = ?').run(id, req.library.id);
    ebooks.purgeOrphans();
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
      const copies = db.prepare("SELECT id, code FROM copies WHERE library_id = ? AND format = 'physical' ORDER BY created_at, id").all(libId);
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
      .filter((b) => !q || normalize(`${b.name} ${b.email} ${b.phone} ${b.notes}`).includes(q))
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
      FROM copies c JOIN books b ON b.id = c.book_id WHERE c.library_id = ? AND c.format = 'physical' AND c.label_printed_at IS NULL ORDER BY c.code`)
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
    const copies = db.prepare("SELECT code, location, label_printed_at FROM copies WHERE book_id = ? AND format = 'physical' ORDER BY code");
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
  // Import de fichiers epub (un par requete, envoye brut, nom dans X-File-Name) : fiche
  // creee d'apres les metadonnees du fichier (couverture comprise), ou fiche existante
  // (meme ISBN, ou meme titre et auteur) completee par le fichier s'il lui manque.
  api.post('/import/epub', express.raw({ type: 'application/epub+zip', limit: ebooks.MAX_BYTES }), h(async (req, res) => {
    const lib = req.library;
    if (!lib.enable_ebooks) throw httpError(409, 'Les livres numériques ne sont pas activés pour cette bibliothèque.');
    let name = '';
    try { name = decodeURIComponent(String(req.get('X-File-Name') || '')); } catch (e) { /* nom illisible */ }
    name = str(name.replace(/[\\/\r\n"]/g, '_'), 200) || 'livre.epub';
    const key = ebooks.save(req.body); // verifie aussi que c'est un epub
    let meta = {};
    try { meta = await readEpubMeta(req.body); } catch (e) { /* metadonnees illisibles : nom du fichier */ }
    const title = str(meta.title, 300) || name.replace(/(\.kepub)?\.epub$/i, '');
    const found = matcher(lib.id)({ title, authors: meta.authors, isbn: meta.isbn });
    const attachFile = (bookId) => {
      createEbookCopy(lib.id, bookId, null);
      const c = db.prepare("SELECT id, file_key FROM copies WHERE book_id = ? AND format = 'ebook'").get(bookId);
      if (c.file_key) return false;
      db.prepare('UPDATE copies SET file_key = ?, file_name = ?, file_size = ? WHERE id = ?').run(key, name, req.body.length, c.id);
      return true;
    };
    if (found) {
      const b = db.prepare('SELECT id, title FROM books WHERE id = ?').get(found);
      const attached = tx(() => attachFile(b.id));
      if (!attached) ebooks.remove(key);
      return res.json({ status: attached ? 'attached' : 'skipped', bookId: b.id, title: b.title });
    }
    let cover = null;
    if (meta.cover) { try { cover = media.save(meta.cover.buffer, meta.cover.mime, 'cover'); } catch (e) { /* couverture trop lourde */ } }
    const f = {
      isbn: meta.isbn || null, title, subtitle: null, authors: str(meta.authors, 500) || null, publisher: str(meta.publisher, 200) || null,
      collection: null, series: str(meta.series, 200) || null, series_number: str(meta.seriesNumber, 20) || null,
      year: meta.year || null, pages: null, summary: str(meta.summary, 10000) || null, notes: null,
    };
    f.search_text = bookSearchText(f);
    const bookId = tx(() => {
      const id = Number(db.prepare(INSERT_BOOK).run({ ...f, library_id: lib.id, cover }).lastInsertRowid);
      addReaders(id, [req.user.id]);
      attachFile(id);
      return id;
    });
    res.json({ status: 'created', bookId, title });
  }));

  api.get('/import/template.:ext', h(async (req, res) => {
    const ext = req.params.ext === 'csv' ? 'csv' : 'xlsx';
    const isbnOnly = req.query.type === 'isbn';
    const header = isbnOnly ? ['ISBN'] : IMPORT_COLUMNS;
    const examples = isbnOnly
      ? [['9782070612758'], ['9782070368228'], ['978-2-253-08327-6']]
      : [
        ['9782070612758', '', '', '', '', '', '', '', 'Roman', 'Armoire A', '2', "Exemple : seul l'ISBN est rempli, le reste est complété automatiquement.", '', 'Papier', '', '', '', ''],
        ['', 'Guide interne des procédures', 'Édition 2024', 'Service RH', 'Bureau', '2024', '48',
          'Document interne sans ISBN : tous les champs sont saisis à la main.', 'Procédures, RH', 'Bureau 2', '1', '', '', 'Papier', 'Guides RH', '', '', 'interne, à jour'],
        ['', 'Guide numérique de l\'enseignant', '', 'Collectif', '', '2023', '', '', 'Pédagogie', '', '',
          'Type « Numérique » : exemplaire numérique seul, sans code ni étiquette (si les livres numériques sont activés).', '', 'Numérique', '', '', '', ''],
        ['9782253083276', '', '', '', '', '', '', '', 'Roman', 'Armoire B', '1',
          'Type « Papier + numérique » : 1 exemplaire papier (étiquette) + 1 exemplaire numérique (epub). Série « Bill Hodges », tome 2.', '', 'Papier + numérique', 'Le Livre de poche', 'Bill Hodges', '2', ''],
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
    // Exemplaires a creer : papier (nombre) et/ou numerique (un seul, sans code).
    const want = readImportFormat(b.format);
    if (!req.library.enable_ebooks) Object.assign(want, { physical: true, ebook: false });
    const copies = want.physical ? Math.max(1, Math.min(intOrNull(b.copies) || 1, 50)) : 0;
    const location = str(b.location, 120);
    // Lecteurs : colonne "Lecteurs" (noms) ou choix de l'import (identifiants) ;
    // a defaut, le compte qui importe (sauf mise a jour). Toujours ajoutes, jamais retires.
    const chosenReaders = readerIds(libId, req.user.id, b.readers);
    const readers = chosenReaders || [req.user.id];

    // Mise a jour : fiche reperee par sa colonne "ID fiche" (export), sinon par l'ISBN.
    if (b.onDuplicate === 'update') {
      const byId = intOrNull(b.bookId) && db.prepare('SELECT id FROM books WHERE id = ? AND library_id = ?').get(intOrNull(b.bookId), libId);
      const existing = byId || (isbn && db.prepare('SELECT id FROM books WHERE library_id = ? AND isbn = ? ORDER BY id LIMIT 1').get(libId, isbn));
      if (existing) return res.json(await updateFromImport(req.library, existing.id, b, isbn, chosenReaders));
    }
    if (isbn && b.onDuplicate !== 'new' && b.onDuplicate !== 'update') {
      const existing = db.prepare('SELECT id, title FROM books WHERE library_id = ? AND isbn = ? ORDER BY id LIMIT 1').get(libId, isbn);
      if (existing) {
        if (b.onDuplicate === 'skip') return res.json({ status: 'skipped', bookId: existing.id, title: existing.title });
        // Livre deja present : ajout des exemplaires demandes (le numerique seulement s'il manque).
        const added = tx(() => {
          addReaders(existing.id, readers);
          return {
            codes: createCopies(libId, existing.id, copies, location),
            ebook: want.ebook && createEbookCopy(libId, existing.id, want.physical ? null : location),
          };
        });
        if (!added.codes.length && !added.ebook) return res.json({ status: 'skipped', bookId: existing.id, title: existing.title });
        return res.json({ status: 'copies', bookId: existing.id, title: existing.title, codes: added.codes, ebook: added.ebook });
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
      publisher: pick('publisher'), collection: pick('collection'), series: pick('series'), seriesNumber: pick('seriesNumber'), year: pick('year'), pages: pick('pages'), summary: pick('summary'), notes: b.notes,
    });
    const cover = await importCover(str(b.coverUrl, 1000), found, { isbn, title: f.title, author: f.authors });
    const categories = Array.isArray(b.categories) ? b.categories : String(b.categories || '').split(/[,;|]/);
    const result = tx(() => {
      const r = db.prepare(INSERT_BOOK).run({ ...f, library_id: libId, cover });
      const bookId = Number(r.lastInsertRowid);
      setBookCategories(libId, bookId, categories);
      setBookTags(req.library, bookId, b.tags);
      addReaders(bookId, readers);
      const codes = createCopies(libId, bookId, copies, location);
      const ebook = want.ebook && createEbookCopy(libId, bookId, want.physical ? null : location);
      // Nouveau livre : "A lire" pour le compte qui importe (option de l'import).
      if (b.markToRead && req.library.enable_reading_status) {
        db.prepare("INSERT OR IGNORE INTO book_user_status (book_id, user_id, reading) VALUES (?, ?, 'to_read')").run(bookId, req.user.id);
      }
      return { bookId, codes, ebook };
    });
    res.json({ status: 'created', ...result, title: f.title, sources: found ? found.sources : [] });
  }));

  // ---------- Export ----------
  // Inventaire : une ligne par livre, avec les memes colonnes que le modele d'import
  // (reimportable tel quel, y compris dans une autre bibliotheque) + nombre
  // d'exemplaires, disponibles et codes de tous les exemplaires. ?missing=<cle> : seulement
  // les fiches incompletes pour cette information (a corriger puis reimporter en mise a jour).
  api.get('/export/inventory.:ext', h(async (req, res) => {
    const lib = req.library;
    const missing = missingKeys(lib).includes(req.query.missing) ? req.query.missing : null;
    const ext = req.params.ext === 'csv' ? 'csv' : 'xlsx';
    const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0];
    const mediaBase = `${proto}://${req.get('host')}${auth.rootPath(req)}/${lib.slug}/media/`;
    const books = db.prepare(`SELECT b.*,
        (SELECT group_concat(name, ', ') FROM (SELECT cat.name FROM book_categories bc JOIN categories cat ON cat.id = bc.category_id
          WHERE bc.book_id = b.id ORDER BY cat.name COLLATE NOCASE)) AS categories,
        (SELECT group_concat(name, ', ') FROM (SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
          WHERE bt.book_id = b.id ORDER BY t.name COLLATE NOCASE)) AS tags,
        (SELECT group_concat(username, ', ') FROM (SELECT u.username FROM book_readers br JOIN users u ON u.id = br.user_id
          WHERE br.book_id = b.id ORDER BY u.username COLLATE NOCASE)) AS readers,
        (SELECT group_concat(location, ', ') FROM (SELECT DISTINCT location FROM copies c WHERE c.book_id = b.id AND location <> '' ORDER BY location)) AS locations,
        (SELECT group_concat(code, ', ') FROM (SELECT code FROM copies c WHERE c.book_id = b.id AND c.format = 'physical' ORDER BY code)) AS codes,
        ${COPY_COUNTS}
      FROM books b WHERE b.library_id = ?
      ${missing ? `AND b.id IN (SELECT bk.id FROM books bk WHERE bk.library_id = b.library_id AND ${MISSING[missing]})` : ''}
      ORDER BY b.title COLLATE NOCASE`).all(lib.id);
    const header = ['ISBN', 'Titre', 'Sous-titre', 'Auteurs', 'Éditeur', 'Année', 'Pages', 'Résumé', 'Catégories',
      'Emplacement', 'Exemplaires', 'Disponibles', 'Codes des exemplaires', 'Notes', 'Couverture (URL)', 'Type', 'Collection', 'Série', 'Tome', 'Tags', 'Lecteurs', 'ID fiche'];
    const rows = books.map((b) => [b.isbn || '', b.title, b.subtitle || '', b.authors || '', b.publisher || '', b.year || '', b.pages || '',
      b.summary || '', b.categories || '', b.locations || '', b.total_copies, b.available_copies, b.codes || '', b.notes || '',
      b.cover ? mediaBase + b.cover : '', formatLabel(b), b.collection || '', b.series || '', b.series_number || '', lib.enable_tags ? b.tags || '' : '', b.readers || '', b.id]);
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `${missing ? `incompletes-${missing}` : 'inventaire'}-${lib.slug}-${stamp}`;
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
    const rows = db.prepare(`SELECT c.code, c.format, b.isbn, b.title, b.subtitle, b.authors, b.publisher, b.year, b.pages,
        (SELECT group_concat(cat.name, ', ') FROM book_categories bc JOIN categories cat ON cat.id = bc.category_id WHERE bc.book_id = b.id) AS categories,
        c.location, br.name AS borrower, l.loaned_at
      FROM copies c JOIN books b ON b.id = c.book_id
      LEFT JOIN loans l ON l.copy_id = c.id AND l.returned_at IS NULL
      LEFT JOIN borrowers br ON br.id = l.borrower_id
      WHERE c.library_id = ? ORDER BY b.title COLLATE NOCASE, c.format = 'ebook', c.code`).all(req.library.id);
    const header = ['Code', 'Type', 'ISBN', 'Titre', 'Sous-titre', 'Auteurs', 'Éditeur', 'Année', 'Pages', 'Catégories', 'Emplacement', 'Emprunté par', 'Prêté le'];
    const lines = [header, ...rows.map((r) => [r.code || '', r.format === 'ebook' ? 'Numérique' : 'Papier', r.isbn, r.title, r.subtitle, r.authors, r.publisher, r.year, r.pages, r.categories, r.location, r.borrower, r.loaned_at])];
    res.set('Content-Disposition', `attachment; filename="${req.library.slug}.csv"`);
    // BOM + point-virgule : ouverture directe correcte dans Excel (reglages belges/francais).
    res.type('text/csv; charset=utf-8').send('﻿' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n'));
  });

  api.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  return api;
}

module.exports = { createLibraryRouter, findLibrary, mediaUrl, str, intOrNull };
