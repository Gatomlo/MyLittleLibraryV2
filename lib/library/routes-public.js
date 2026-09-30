// Catalogue public (sans connexion) : reglages, listes, fiche, fichier epub selon les droits.
const { db } = require('../db');
const { httpError } = require('../util');
const ebooks = require('../ebooks');
const {
  handler, idParam, publicSettings, CATEGORIES, TAGS, categoriesFor, tagsFor, markReserved, serializeBook, searchBooks, getBookRow,
  findCopy, reservationsFor, termList,
} = require('./catalog');

module.exports = function register(api) {
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

  api.get('/public/categories', (req, res) => res.json(termList(CATEGORIES, req.library)));
  api.get('/public/tags', (req, res) => res.json(termList(TAGS, req.library)));

  api.get('/public/books', (req, res) => res.json(searchBooks(req.library, req.query)));

  api.get('/public/books/:id', handler((req, res) => {
    const b = getBookRow(req.library.id, idParam(req));
    const tags = tagsFor(req.library, [b.id]);
    const book = serializeBook(b, categoriesFor([b.id]).get(b.id), false, tags && tags.get(b.id));
    book.copies = db.prepare(`SELECT c.code, c.location,
        NOT EXISTS (SELECT 1 FROM loans l WHERE l.copy_id = c.id AND l.returned_at IS NULL) AS available
      FROM copies c WHERE c.book_id = ? AND c.format = 'physical' ORDER BY c.code`).all(b.id)
      .map((c) => ({ code: c.code, location: c.location || '', available: !!c.available }));
    markReserved(book.copies, reservationsFor(b.id)).forEach((c) => { if (c.reservedFor) { c.reserved = true; delete c.reservedFor; } });
    book.ebookFile = ebooks.accessFor(req.library, b.id, req.user);
    res.json(book);
  }));

  // Fichier epub de l'exemplaire numerique : lecture en ligne (liseuse) ou
  // telechargement (?download=1), selon les droits regles sur l'exemplaire.
  api.get('/public/books/:id/epub', handler((req, res) => {
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
    res.sendFile(ebooks.filePath(req.library.id, c.file_key));
  }));

  // Permet d'ouvrir la fiche d'un livre en scannant l'etiquette sans etre connecte.
  api.get('/public/copies/:code', handler((req, res) => {
    const c = findCopy(req.library.id, req.params.code);
    if (!c) throw httpError(404, 'Exemplaire introuvable.');
    res.json({ bookId: c.book_id, code: c.code });
  }));
};
