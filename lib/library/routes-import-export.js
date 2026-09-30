// Import (fichiers epub, lignes d'un fichier, modeles) et export (inventaire, exemplaires).
const express = require('express');
const { db, tx, bookSearchText } = require('../db');
const { httpError, csvCell, str, intOrNull } = require('../util');
const { normalizeIsbn, lookupIsbn } = require('../isbn');
const { matcher } = require('../kobo');
const { readEpubMeta } = require('../epub-meta');
const auth = require('../auth');
const media = require('../media');
const ebooks = require('../ebooks');
const {
  IMPORT_COLUMNS, handler, readImportFormat, formatLabel, readerIds, addReaders, COPY_COUNTS, MISSING, missingKeys,
} = require('./catalog');
const {
  readBookFields, INSERT_BOOK, setBookCategories, setBookTags, importCover, updateFromImport, createCopies, createEbookCopy,
} = require('./fiches');
const writeExcelFileModule = require('write-excel-file/node');

const writeExcelFile = writeExcelFileModule.default || writeExcelFileModule;

module.exports = function register(api) {
  // ---------- Import ----------
  // Modeles a telecharger : liste d'ISBN, ou fiche complete (une colonne par champ).
  // En .xlsx, la colonne ISBN est au format Texte (y compris les lignes vides a
  // remplir) : Excel ne la transforme pas en nombre ni en notation scientifique.
  // Import de fichiers epub (un par requete, envoye brut, nom dans X-File-Name) : fiche
  // creee d'apres les metadonnees du fichier (couverture comprise), ou fiche existante
  // (meme ISBN, ou meme titre et auteur) completee par le fichier s'il lui manque.
  api.post('/import/epub', express.raw({ type: 'application/epub+zip', limit: ebooks.MAX_BYTES }), handler(async (req, res) => {
    const lib = req.library;
    if (!lib.enable_ebooks) throw httpError(409, 'Les livres numériques ne sont pas activés pour cette bibliothèque.');
    let name = '';
    try { name = decodeURIComponent(String(req.get('X-File-Name') || '')); } catch (e) { /* nom illisible */ }
    name = str(name.replace(/[\\/\r\n"]/g, '_'), 200) || 'livre.epub';
    const key = ebooks.save(lib.id, req.body); // verifie aussi que c'est un epub
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
      if (!attached) ebooks.remove(lib.id, key);
      return res.json({ status: attached ? 'attached' : 'skipped', bookId: b.id, title: b.title });
    }
    let cover = null;
    if (meta.cover) { try { cover = media.save(lib.id, meta.cover.buffer, meta.cover.mime, 'cover'); } catch (e) { /* couverture trop lourde */ } }
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

  api.get('/import/template.:ext', handler(async (req, res) => {
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
  api.post('/import/book', handler(async (req, res) => {
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
    const cover = await importCover(req.library.id, str(b.coverUrl, 1000), found, { isbn, title: f.title, author: f.authors });
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
  api.get('/export/inventory.:ext', handler(async (req, res) => {
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
};
