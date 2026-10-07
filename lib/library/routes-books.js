// Livres : recherche en ligne (ISBN, couvertures), fiches incompletes, fiche, lecteurs,
// statuts de lecture, ajout, modification, actions en masse, vidage.
const fs = require('fs');
const path = require('path');
const { db, tx, bookSearchText, libraryDir, pruneBackups } = require('../db');
const { httpError, str, intOrNull } = require('../util');
const { normalizeIsbn, lookupIsbn, findIsbn, findIsbnByEditions, searchEditions, lookupOtherEdition } = require('../isbn');
const { searchCovers } = require('../covers');
const { readEpubIsbn } = require('../epub-meta');
const auth = require('../auth');
const media = require('../media');
const ebooks = require('../ebooks');
const {
  READING, OPINION, ratingOf, handler, idParam, readFormat, CATEGORIES, TAGS, termsFor, readersFor, readerIds, addReaders, MISSING,
  missingKeys, REFILL, matchCategories, searchBooks, getBookRow, bookDetail,
} = require('./catalog');
const {
  readBookFields, INSERT_BOOK, statusOut, bookStatuses, nextReadingDates, setBookTerms, setBookCategories, setBookTags, importCover,
  resolveCover, createCopies, createEbookCopy,
} = require('./fiches');

// Informations reprises d'une autre edition quand l'ISBN de la fiche est inconnu en ligne.
const OTHER_EDITION = ['summary', 'category', 'cover', 'authors', 'publisher', 'year', 'pages'];

module.exports = function register(api, { config }) {
  api.get('/isbn/:isbn', handler(async (req, res) => {
    const isbn = normalizeIsbn(req.params.isbn);
    if (!isbn) throw httpError(400, 'ISBN invalide.');
    const existing = db.prepare('SELECT id, title FROM books WHERE isbn = ? AND library_id = ?').all(isbn, req.library.id);
    const found = await lookupIsbn(isbn);
    res.json({ isbn, found, existing });
  }));

  // ISBN lu dans le fichier epub d'un livre (metadonnees, sinon texte), ou null.
  async function fileIsbn(libId, bookId) {
    const c = db.prepare("SELECT file_key FROM copies WHERE book_id = ? AND format = 'ebook' AND file_key IS NOT NULL").get(bookId);
    if (!c) return null;
    try { return await readEpubIsbn(fs.readFileSync(ebooks.filePath(libId, c.file_key))); } catch (e) { return null; }
  }

  // Editions trouvees par titre + auteur (ou texte libre), pour choisir l'ISBN.
  // bookId : l'ISBN cite dans son fichier epub est propose en premier.
  api.get('/isbn-search', handler(async (req, res) => {
    const q = { title: str(req.query.title, 300), author: str(req.query.author, 300), q: str(req.query.q, 300) };
    if (!q.title && !q.q) throw httpError(400, 'Indique un titre.');
    const bookId = Number(req.query.bookId) || 0;
    if (bookId) getBookRow(req.library.id, bookId);
    const [fromFile, editions] = await Promise.all([bookId ? fileIsbn(req.library.id, bookId) : null, searchEditions(q)]);
    res.json({ fromFile, editions });
  }));

  // Couvertures proposees en ligne (par ISBN et/ou titre + auteur).
  api.get('/covers', handler(async (req, res) => {
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
  api.post('/books/:id/refill', handler(async (req, res) => {
    const field = String(req.body.field || '');
    if (!REFILL.includes(field)) throw httpError(400, 'Information non recherchable en ligne.');
    const libId = req.library.id;
    const b = getBookRow(libId, idParam(req));
    const notFound = () => res.json({ status: 'notfound' });
    if (field === 'isbn') {
      if (b.isbn) return notFound();
      // ISBN choisi parmi les editions proposees (mode « choisir en cas de doute »).
      if (req.body.value !== undefined) {
        const chosen = normalizeIsbn(req.body.value);
        if (!chosen) throw httpError(400, 'ISBN invalide.');
        db.prepare("UPDATE books SET isbn = ?, search_text = ?, updated_at = datetime('now') WHERE id = ?")
          .run(chosen, bookSearchText({ ...b, isbn: chosen }), b.id);
        return res.json({ status: 'filled', value: chosen });
      }
      // D'abord l'ISBN cite dans le fichier epub. S'il est inconnu en ligne (souvent
      // l'ISBN numerique), ISBN papier retrouve quand une seule edition correspond (BnF,
      // puis editions BnF + Google Books comme dans la fiche) ; a defaut, celui du fichier.
      // ask : plusieurs editions possibles -> rien n'est enregistre, elles sont renvoyees.
      const fromFile = await fileIsbn(libId, b.id);
      const known = fromFile && await lookupIsbn(fromFile).catch(() => null);
      let isbn = known ? fromFile : await findIsbn(b).catch(() => null);
      if (!isbn) {
        const r = await findIsbnByEditions({ ...b, isbn: fromFile }).catch(() => ({ isbn: null, candidates: [] }));
        if (!r.isbn && req.body.ask === true && r.candidates.length) {
          return res.json({
            status: 'ambiguous', fromFile,
            book: { title: b.title, authors: b.authors, publisher: b.publisher, year: b.year, pages: b.pages },
            candidates: r.candidates.slice(0, 15).map((e) => ({
              isbn: e.isbn, title: e.title, authors: e.authors, publisher: e.publisher, year: e.year, pages: e.pages, coverUrl: e.coverUrl, sources: e.sources,
            })),
          });
        }
        isbn = r.isbn || fromFile;
      }
      if (!isbn) return notFound();
      db.prepare("UPDATE books SET isbn = ?, search_text = ?, updated_at = datetime('now') WHERE id = ?")
        .run(isbn, bookSearchText({ ...b, isbn }), b.id);
      return res.json({ status: 'filled', value: isbn });
    }
    const isbn = normalizeIsbn(b.isbn);
    let found = isbn ? await lookupIsbn(isbn).catch(() => null) : null;
    // ISBN inconnu en ligne (souvent numerique) : informations de l'edition du meme
    // livre la plus proche de la fiche (lookupOtherEdition).
    if (!found && OTHER_EDITION.includes(field)) {
      const other = await lookupOtherEdition(b, field).catch(() => null);
      if (other) found = other.found;
    }
    if (field === 'category') {
      if (termsFor(CATEGORIES, [b.id]).get(b.id).length) return notFound();
      const names = matchCategories(libId, found ? found.subjects : []);
      if (!names.length) return notFound();
      setBookTerms(CATEGORIES, libId, b.id, names);
      return res.json({ status: 'filled', value: names.join(', ') });
    }
    let value = null;
    if (field === 'cover') {
      if (!b.cover) value = await importCover(libId, '', found, { isbn, title: b.title, author: b.authors });
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
    // Lecteur : exemplaires comme dans le catalogue public (ni emprunteurs, ni historique).
    if (!auth.canManage(req.user, req.library.id)) {
      book.copies = book.copies.filter((c) => c.format !== 'ebook')
        .map((c) => ({ code: c.code, location: c.location, available: !c.loan, ...(c.reservedFor ? { reserved: true } : {}) }));
      delete book.history;
      delete book.reservations;
      delete book.notes;
    }
    if (req.library.enable_reading_status) Object.assign(book, bookStatuses(id, req.user.id));
    if (req.library.enable_tags) book.tags = termsFor(TAGS, [id]).get(id);
    book.readers = readersFor([id]).get(id);
    book.ebookFile = ebooks.accessFor(req.library, id, req.user);
    return book;
  }

  api.get('/books/:id', handler((req, res) => res.json(fullBook(req, idParam(req)))));

  // Lecteurs d'un livre : bouton "Interesse" de la fiche (le compte connecte) ; les
  // autres membres se choisissent dans le formulaire de modification (PUT /books/:id).
  // Le statut de lecture n'y touche jamais.
  api.post('/books/:id/readers', handler((req, res) => {
    const id = idParam(req);
    getBookRow(req.library.id, id);
    const self = !auth.canManage(req.user, req.library.id);
    const ids = readerIds(req.library.id, req.user.id, [self ? req.user.id : req.body.userId]);
    if (!ids.length) throw httpError(400, 'Membre inconnu.');
    addReaders(id, ids);
    res.json(readersFor([id]).get(id));
  }));

  api.delete('/books/:id/readers/:userId', handler((req, res) => {
    const id = idParam(req);
    getBookRow(req.library.id, id);
    if (idParam(req, 'userId') !== req.user.id && !auth.canManage(req.user, req.library.id)) throw httpError(403, 'Tu ne peux retirer que ton propre compte.');
    db.prepare('DELETE FROM book_readers WHERE book_id = ? AND user_id = ?').run(id, idParam(req, 'userId'));
    res.json(readersFor([id]).get(id));
  }));

  // Statut de lecture du compte connecte pour un livre (null = aucun).
  api.put('/books/:id/status', handler((req, res) => {
    if (!req.library.enable_reading_status) throw httpError(409, 'Les statuts de lecture ne sont pas activés pour cette bibliothèque.');
    const id = idParam(req);
    getBookRow(req.library.id, id);
    const reading = READING.includes(req.body.reading) ? req.body.reading : null;
    const opinion = OPINION.includes(req.body.opinion) ? req.body.opinion : null;
    const prev = db.prepare('SELECT * FROM book_user_status WHERE book_id = ? AND user_id = ?').get(id, req.user.id);
    // Note : conservee si absente de la requete.
    let rating = prev ? prev.rating : null;
    if (req.body.rating !== undefined) {
      rating = ratingOf(req.body.rating);
      if (rating === undefined) throw httpError(400, 'Note invalide (1 à 5 étoiles).');
    }
    if (!reading && !opinion && !rating) {
      db.prepare('DELETE FROM book_user_status WHERE book_id = ? AND user_id = ?').run(id, req.user.id);
      return res.json(statusOut(null));
    }
    const d = nextReadingDates(prev, reading, req.body);
    db.prepare(`INSERT INTO book_user_status (book_id, user_id, reading, opinion, rating, started_at, finished_at, abandoned_at)
      VALUES (@book, @user, @reading, @opinion, @rating, @started, @finished, @abandoned)
      ON CONFLICT(book_id, user_id) DO UPDATE SET reading = excluded.reading, opinion = excluded.opinion, rating = excluded.rating,
        started_at = excluded.started_at, finished_at = excluded.finished_at, abandoned_at = excluded.abandoned_at,
        updated_at = datetime('now')`)
      .run({ book: id, user: req.user.id, reading, opinion, rating, ...d });
    res.json(statusOut(db.prepare('SELECT * FROM book_user_status WHERE book_id = ? AND user_id = ?').get(id, req.user.id)));
  }));

  api.post('/books', handler(async (req, res) => {
    const libId = req.library.id;
    const f = readBookFields(req.body);
    const cover = await resolveCover(libId, req.body);
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

  api.put('/books/:id', handler(async (req, res) => {
    const libId = req.library.id;
    const id = idParam(req);
    const old = getBookRow(libId, id);
    const f = readBookFields(req.body);
    const newCover = await resolveCover(libId, req.body);
    let cover = old.cover;
    if (newCover !== null || req.body.removeCover) {
      media.remove(libId, old.cover);
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
  api.post('/books/bulk-delete', handler((req, res) => {
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
    covers.forEach((c) => media.remove(libId, c));
    ebooks.purgeOrphans(libId);
    res.json({ deleted, onLoan: onLoanCount });
  }));

  // Modification en masse (selection du catalogue). Seules les cles presentes dans
  // "changes" sont appliquees : serie / collection ('' = vider), categories, tags et
  // lecteurs ajoutes ou retires, version numerique ajoutee ou retiree, statut de lecture et
  // avis du compte connecte ('' = retirer).
  api.post('/books/bulk-edit', handler((req, res) => {
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
        if (!reading && !opinion && !(prev && prev.rating)) delStatus.run(id, req.user.id);
        else putStatus.run({ book: id, user: req.user.id, reading, opinion, ...nextReadingDates(prev, reading, {}) });
      }
      updated++;
    }));
    if (ebook === 'remove') ebooks.purgeOrphans(lib.id);
    res.json({ updated });
  }));

  // Vide la bibliotheque : tous les livres, exemplaires, prets et statuts de lecture ;
  // en option les emprunteurs, categories et tags, et la numerotation des codes.
  // Reglages, logo et membres sont conserves. Une sauvegarde de la base est faite avant.
  api.post('/empty', config, handler((req, res) => {
    const lib = req.library;
    if (String(req.body.confirm || '').trim() !== lib.name.trim()) {
      throw httpError(400, 'Confirmation incorrecte : tape exactement le nom de la bibliothèque.');
    }
    const dir = libraryDir(lib.id, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const backup = `library-avant-vidage-${lib.slug}-${stamp}.db`;
    db.exec(`VACUUM INTO '${path.join(dir, backup).replace(/'/g, "''")}'`);
    pruneBackups(dir, 'library-avant-vidage-');
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
    covers.forEach((c) => media.remove(lib.id, c));
    ebooks.purgeOrphans(lib.id);
    res.json({ deleted, backup });
  }));

  api.delete('/books/:id', handler((req, res) => {
    const id = idParam(req);
    const b = getBookRow(req.library.id, id);
    if (b.available_copies < b.total_copies) throw httpError(409, 'Un exemplaire est en prêt : enregistre son retour avant de supprimer le livre.');
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    media.remove(req.library.id, b.cover);
    ebooks.purgeOrphans(req.library.id);
    res.json({ ok: true });
  }));
};
