// Fiches de livres : ecriture. Lecture des champs saisis, statuts de lecture,
// categories et tags d'un livre, couvertures, exemplaires, mise a jour par import.
const { db, tx, normalize, bookSearchText, nextCopyCode } = require('../db');
const { httpError, str, intOrNull } = require('../util');
const { normalizeIsbn } = require('../isbn');
const { searchCovers } = require('../covers');
const media = require('../media');
const { CATEGORIES, TAGS, addReaders, getBookRow } = require('./catalog');

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
    rating: r ? r.rating : null,
    startedAt: r ? r.started_at : null,
    finishedAt: r ? r.finished_at : null,
    abandonedAt: r ? r.abandoned_at : null,
  };
}

function bookStatuses(bookId, userId) {
  const rows = db.prepare(`SELECT s.*, u.username FROM book_user_status s
    JOIN users u ON u.id = s.user_id WHERE s.book_id = ? AND (s.reading IS NOT NULL OR s.opinion IS NOT NULL OR s.rating IS NOT NULL)
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
async function importCover(libId, listUrl, found, query) {
  const tryUrl = async (url) => {
    if (!url) return null;
    try { return (await media.saveFromUrl(libId, url, 'cover')) || null; } catch (e) { return null; }
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
    const saved = await media.saveFromUrl(lib.id, coverUrl, 'cover').catch(() => null);
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
  if (cover !== old.cover) media.remove(lib.id, old.cover);
  return { status: 'updated', bookId: id, title: f.title, fields: changed.map((k) => UPDATE_LABELS[k]) };
}

// Couverture : nouvelle image envoyee (coverData), a telecharger (coverUrl), ou a retirer.
async function resolveCover(libId, body) {
  if (body.coverData) return media.saveDataUrl(libId, body.coverData, 'cover');
  if (body.coverUrl) {
    try { return await media.saveFromUrl(libId, String(body.coverUrl), 'cover'); } catch (e) {
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

module.exports = {
  readBookFields, INSERT_BOOK, statusOut, bookStatuses, nextReadingDates, setBookTerms, setBookCategories, setBookTags, importCover,
  updateFromImport, resolveCover, createCopies, createEbookCopy,
};
