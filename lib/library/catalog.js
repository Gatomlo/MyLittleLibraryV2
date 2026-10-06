// Catalogue d'une bibliotheque : lecture. Recherche, fiche detaillee, exemplaires et
// disponibilite, prets, classement (categories, tags, valeurs libres), reglages
// publics. Toutes les fonctions s'executent dans le contexte de la bibliotheque
// (voir inLibrary dans lib/db.js).
const { db, tx, normalize, bookSearchText, inLibrary } = require('../db');
const { httpError, str, intOrNull } = require('../util');
const { simplify } = require('../isbn');

// Colonnes du modele d'import (reconnues aussi sous d'autres noms, cote navigateur).
const IMPORT_COLUMNS = ['ISBN', 'Titre', 'Sous-titre', 'Auteurs', 'Éditeur', 'Année', 'Pages', 'Résumé',
  'Catégories', 'Emplacement', 'Exemplaires', 'Notes', 'Couverture (URL)', 'Type', 'Collection', 'Série', 'Tome', 'Tags', 'Lecteurs'];

const READING = ['to_read', 'reading', 'read', 'abandoned'];
const OPINION = ['liked', 'disliked'];
// Note (1 a 5 etoiles) : null = aucune, undefined = valeur invalide.
const ratingOf = (v) => (v === null || v === '' || Number(v) === 0 ? null
  : Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 5 ? Number(v) : undefined);

// Gestionnaire de route execute dans le contexte de la bibliotheque (base de donnees) : a
// redonner apres un analyseur de corps (express.raw), dont les rappels le perdent. Une
// erreur (ou promesse rejetee) va a next().
const handler = (fn) => (req, res, next) => inLibrary(req.library.id, () => Promise.resolve().then(() => fn(req, res, next))).catch(next);

function mediaUrl(name) {
  return name ? 'media/' + name : null;
}

function idParam(req, name = 'id') {
  const n = intOrNull(req.params[name]);
  if (!n) throw httpError(400, 'Identifiant invalide.');
  return n;
}

// Elements affichables du catalogue de l'app (filtres, puis nombre de livres), dans leur ordre.
const CATALOG_FILTERS = ['search', 'scan', 'category', 'collection', 'series', 'tag', 'mine', 'reader', 'availability', 'format',
  'statusUser', 'reading', 'opinion', 'rating', 'sort', 'count'];

// Elements affichables sur la miniature d'un livre du catalogue.
const CATALOG_CARD = ['cover', 'title', 'authors', 'series', 'collection', 'categories', 'tags', 'readers', 'status', 'rating', 'availability', 'ebook'];

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

// Bouton Scanner de l'en-tete : codes lus et page ouverte.
function scanSettings(lib) {
  return {
    codes: ['isbn', 'both'].includes(lib.scan_codes) ? lib.scan_codes : 'copy',
    action: lib.scan_action === 'book' ? 'book' : 'loan',
  };
}

// Rappels de retour (gestion) : mode, delai par rapport a la date de retour, modele
// du message (vide = modele par defaut de l'interface).
function reminderSettings(lib) {
  return { mode: lib.reminder_mode === 'auto' ? 'auto' : 'manual', offset: Number(lib.reminder_offset) || 0,
    subject: lib.reminder_subject || '', body: lib.reminder_body || '' };
}

function publicSettings(lib) {
  return {
    slug: lib.slug,
    libraryName: lib.name,
    logoUrl: mediaUrl(lib.logo),
    brandDisplay: ['name', 'logo'].includes(lib.brand_display) ? lib.brand_display : 'both',
    features: { ebooks: !!lib.enable_ebooks, readingStatus: !!lib.enable_reading_status, tags: !!lib.enable_tags, stats: !!lib.enable_stats, kobo: !!(lib.enable_kobo && lib.enable_ebooks) },
    catalog: catalogSettings(lib),
    scan: scanSettings(lib),
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
  (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id AND c.format = 'ebook') AS ebook_copies,
  (SELECT COUNT(*) FROM reservations r WHERE r.book_id = b.id) AS reservation_count`;

// Reservations : chaque exemplaire papier libre est mis de cote pour une reservation
// (dans l'ordre). availableCopies = exemplaires libres et non reserves ; reservedCopies =
// exemplaires libres mis de cote. Filtre « Disponibles » : available_copies > reservation_count.
const FREE_COPIES = 'available_copies > reservation_count';
function markReserved(copies, reservations) {
  let i = 0;
  copies.forEach((c) => {
    if (c.format === 'ebook' || c.loan || c.available === false || i >= reservations.length) return;
    c.reservedFor = reservations[i].borrower;
    i += 1;
  });
  return copies;
}

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
    availableCopies: Math.max(0, b.available_copies - (b.reservation_count || 0)),
    reservedCopies: Math.min(b.available_copies, b.reservation_count || 0),
  };
  if (b.reading !== undefined) out.status = { reading: b.reading || null, opinion: b.opinion || null, rating: b.rating || null };
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
  if (query.status === 'available') where.push(FREE_COPIES);
  if (query.status === 'onloan') where.push('available_copies < total_copies');
  if (lib.enable_ebooks && query.format === 'physical') where.push('total_copies > 0');
  if (lib.enable_ebooks && query.format === 'ebook') where.push('ebook_copies > 0');
  // Liseuse branchee : livres deja dessus (dernier scan ou envoyes depuis l'appli), ou
  // pas encore dessus mais avec un fichier epub.
  const koboDevice = isManager && lib.enable_kobo ? intOrNull(query.koboDevice) : null;
  if (koboDevice && ['on', 'off'].includes(query.kobo)) {
    const onDevice = `b.id IN (SELECT ki.book_id FROM kobo_items ki JOIN kobo_devices kd ON kd.id = ki.device_id AND ki.removed = 0
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
    // Note : "n" = au moins n etoiles, "none" = pas notes.
    if (/^[1-5]$/.test(query.rating || '')) { where.push('b.rating >= ?'); params.push(Number(query.rating)); }
    if (query.rating === 'none') where.push('b.rating IS NULL');
  }
  const statusCols = withStatus ? ', s.reading, s.opinion, s.rating' : '';
  const statusJoin = withStatus ? 'LEFT JOIN book_user_status s ON s.book_id = b.id AND s.user_id = ?' : '';
  const limit = Math.min(intOrNull(query.limit) || 24, 100);
  const page = intOrNull(query.page) || 1;
  // Tri : sens naturel (titre, auteur, tomes : croissant ; ajout, annee : plus recents
  // d'abord), inverse avec reverse=1. Les valeurs vides restent a la fin.
  const rev = query.reverse === '1';
  const dir = (asc) => (asc !== rev ? 'ASC' : 'DESC');
  const order = series && (!query.sort || query.sort === 'title' || query.sort === 'series')
    ? `b.series_number IS NULL OR b.series_number = '', CAST(b.series_number AS INTEGER) ${dir(true)}, b.series_number ${dir(true)}, b.title COLLATE NOCASE`
    : query.sort === 'recent' ? `b.created_at ${dir(false)}, b.id ${dir(false)}`
    : query.sort === 'year' ? `b.year ${dir(false)} NULLS LAST, b.title COLLATE NOCASE`
    : query.sort === 'author' ? `author_key(b.authors) ${dir(true)} NULLS LAST, b.series COLLATE NOCASE, b.series_number IS NULL OR b.series_number = '', CAST(b.series_number AS INTEGER), b.title COLLATE NOCASE`
      : `b.title COLLATE NOCASE ${dir(true)}`;
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

// Pret en retard : date de retour prevue depassee (jour local du serveur).
const OVERDUE = "(l.due_at IS NOT NULL AND l.due_at < date('now', 'localtime'))";

// Rappels programmes (reminder_mode = 'auto') : pret en cours a relancer a partir de
// la date de retour + reminder_offset jours (negatif = avant l'echeance), s'il n'a pas
// encore ete relance depuis ; puis de nouveau tous les 7 jours tant qu'il est en retard.
const REMINDER_REPEAT_DAYS = 7;
function reminderOffset(libId) {
  const r = db.prepare('SELECT reminder_offset FROM libraries WHERE id = ?').get(libId);
  const n = Math.round(Number(r && r.reminder_offset) || 0);
  return Math.max(-60, Math.min(365, n));
}
function toRemindSql(libId) {
  const n = reminderOffset(libId);
  const start = `date(l.due_at, '${n >= 0 ? '+' : ''}${n} days')`;
  return `(l.returned_at IS NULL AND l.due_at IS NOT NULL AND ${start} <= date('now', 'localtime')
    AND (l.reminded_at IS NULL OR date(l.reminded_at, 'localtime') < ${start}
      OR (${OVERDUE} AND date(l.reminded_at, 'localtime') <= date('now', 'localtime', '-${REMINDER_REPEAT_DAYS} days'))))`;
}

// Reservations d'un livre (au nom d'emprunteurs), les plus anciennes d'abord.
function reservationsFor(bookId) {
  return db.prepare(`SELECT r.id, r.created_at, br.id AS borrower_id, br.name FROM reservations r
    JOIN borrowers br ON br.id = r.borrower_id WHERE r.book_id = ? ORDER BY r.created_at, r.id`).all(bookId)
    .map((r) => ({ id: r.id, createdAt: r.created_at, borrower: { id: r.borrower_id, name: r.name } }));
}

// Emprunteur choisi (borrowerId) ou saisi (borrowerName, cree s'il n'existe pas).
function resolveBorrower(libId, body) {
  const id = intOrNull(body.borrowerId);
  if (id && db.prepare('SELECT 1 FROM borrowers WHERE id = ? AND library_id = ?').get(id, libId)) return id;
  const name = str(body.borrowerName, 120);
  if (!name) throw httpError(400, "Choisis ou saisis l'emprunteur.");
  const existing = db.prepare('SELECT id FROM borrowers WHERE library_id = ? AND name = ? COLLATE NOCASE').get(libId, name);
  return existing ? existing.id : Number(db.prepare('INSERT INTO borrowers (library_id, name) VALUES (?, ?)').run(libId, name).lastInsertRowid);
}

// Date de retour : 'YYYY-MM-DD' valide, '' ou null = aucune, absente = duree par defaut.
function dueDate(v, lib) {
  if (v === undefined) {
    const days = Number(lib.loan_days) || 0;
    return days > 0 ? db.prepare("SELECT date('now', 'localtime', ?) AS d").get(`+${days} days`).d : null;
  }
  const s = String(v || '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw httpError(400, 'Date de retour invalide.');
  return s;
}

function bookDetail(libId, id) {
  const b = getBookRow(libId, id);
  const book = serializeBook(b, categoriesFor([b.id]).get(b.id), true);
  book.copies = db.prepare(`SELECT c.id, c.code, c.format, c.location, c.notes, c.label_printed_at, c.created_at,
      c.file_key, c.file_name, c.file_size, l.id AS loan_id, l.loaned_at, l.due_at, ${OVERDUE} AS overdue, br.id AS borrower_id, br.name AS borrower_name
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
    loan: c.loan_id ? { id: c.loan_id, loanedAt: c.loaned_at, dueAt: c.due_at, overdue: !!c.overdue, borrower: { id: c.borrower_id, name: c.borrower_name } } : null,
  }));
  book.reservations = reservationsFor(id);
  markReserved(book.copies, book.reservations);
  book.history = db.prepare(`SELECT l.id, l.loaned_at, l.returned_at, c.code, br.id AS borrower_id, br.name AS borrower_name
    FROM loans l JOIN copies c ON c.id = l.copy_id JOIN borrowers br ON br.id = l.borrower_id
    WHERE c.book_id = ? ORDER BY l.loaned_at DESC, l.id DESC LIMIT 100`).all(id).map((l) => ({
    id: l.id, code: l.code, loanedAt: l.loaned_at, returnedAt: l.returned_at,
    borrower: { id: l.borrower_id, name: l.borrower_name },
  }));
  return book;
}

// Categories et tags avec leur nombre de livres (tags : vide si l'option est desactivee).
function termList(tax, lib) {
  if (tax === TAGS && !lib.enable_tags) return [];
  return db.prepare(`SELECT t.id, t.name, COUNT(l.book_id) AS count FROM ${tax.table} t
    LEFT JOIN ${tax.link} l ON l.${tax.col} = t.id WHERE t.library_id = ?
    GROUP BY t.id ORDER BY t.name COLLATE NOCASE`).all(lib.id);
}

function listLoans(libId, { status = 'open', borrowerId = null, id = null, limit = 500 } = {}) {
  const where = ['c.library_id = ?'];
  const params = [libId];
  if (status === 'open') where.push('l.returned_at IS NULL');
  if (status === 'returned') where.push('l.returned_at IS NOT NULL');
  if (status === 'overdue') where.push(`l.returned_at IS NULL AND ${OVERDUE}`);
  if (status === 'remind') where.push(toRemindSql(libId));
  if (borrowerId) { where.push('l.borrower_id = ?'); params.push(borrowerId); }
  if (id) { where.push('l.id = ?'); params.push(id); }
  return db.prepare(`SELECT l.id, l.loaned_at, l.returned_at, l.due_at, l.returned_at IS NULL AND ${OVERDUE} AS overdue, l.notes, c.id AS copy_id, c.code,
      l.reminded_at, l.reminder_count, ${toRemindSql(libId)} AS to_remind,
      b.id AS book_id, b.title, b.authors, b.cover, br.id AS borrower_id, br.name AS borrower_name, br.email AS borrower_email
    FROM loans l JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id
    JOIN borrowers br ON br.id = l.borrower_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.returned_at IS NOT NULL, COALESCE(l.returned_at, l.loaned_at) DESC, l.id DESC LIMIT ?`).all(...params, limit)
    .map((l) => ({
      id: l.id, loanedAt: l.loaned_at, returnedAt: l.returned_at, dueAt: l.due_at, overdue: !!l.overdue, notes: l.notes || '',
      remindedAt: l.reminded_at, reminderCount: l.reminder_count, toRemind: !!l.to_remind,
      copy: { id: l.copy_id, code: l.code },
      book: { id: l.book_id, title: l.title, authors: l.authors || '', coverUrl: mediaUrl(l.cover) },
      borrower: { id: l.borrower_id, name: l.borrower_name, email: l.borrower_email || '' },
    }));
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

module.exports = {
  IMPORT_COLUMNS, READING, OPINION, ratingOf, handler, mediaUrl, idParam, CATALOG_FILTERS, CATALOG_CARD, reminderSettings,
  publicSettings, readFormat, readImportFormat, formatLabel, TAXONOMIES, CATEGORIES, TAGS, termsFor, categoriesFor, tagsFor,
  libraryMembers, readersFor, readerIds, addReaders, COPY_COUNTS, markReserved, serializeBook, MISSING, missingKeys, VALUE_FIELDS,
  valueList, rewriteValues, REFILL, matchCategories, searchBooks, getBookRow, findCopy, OVERDUE, toRemindSql, reservationsFor,
  resolveBorrower, dueDate, bookDetail, termList, listLoans, findLibrary,
};
