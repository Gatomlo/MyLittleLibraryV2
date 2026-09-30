// Exemplaires : ajout, emplacement, fichier epub, recherche par code ou ISBN, codes.
const express = require('express');
const { db, tx } = require('../db');
const { httpError, str, intOrNull } = require('../util');
const { normalizeIsbn } = require('../isbn');
const ebooks = require('../ebooks');
const { handler, idParam, readFormat, getBookRow, findCopy, dueDate, bookDetail } = require('./catalog');
const { createCopies, createEbookCopy } = require('./fiches');

module.exports = function register(api, { config }) {
  api.post('/books/:id/copies', handler((req, res) => {
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

  api.put('/copies/:id', handler((req, res) => {
    const id = idParam(req);
    const r = db.prepare('UPDATE copies SET location = ?, notes = ? WHERE id = ? AND library_id = ?')
      .run(str(req.body.location, 120) || null, str(req.body.notes, 2000) || null, id, req.library.id);
    if (!r.changes) throw httpError(404, 'Exemplaire introuvable.');
    res.json({ ok: true });
  }));

  // Fichier epub de l'exemplaire numerique : envoye brut (application/epub+zip),
  // nom d'origine dans l'en-tete X-File-Name (encodeURIComponent). Remplace l'ancien.
  api.put('/copies/:id/file', express.raw({ type: 'application/epub+zip', limit: ebooks.MAX_BYTES }), handler((req, res) => {
    const id = idParam(req);
    const c = db.prepare("SELECT file_key FROM copies WHERE id = ? AND library_id = ? AND format = 'ebook'").get(id, req.library.id);
    if (!c) throw httpError(404, 'Exemplaire numérique introuvable.');
    let name = '';
    try { name = decodeURIComponent(String(req.get('X-File-Name') || '')); } catch (e) { /* nom illisible */ }
    name = str(name.replace(/[\\/\r\n"]/g, '_'), 200) || 'livre.epub';
    if (!/\.epub$/i.test(name)) name += '.epub';
    const key = ebooks.save(req.library.id, req.body);
    db.prepare('UPDATE copies SET file_key = ?, file_name = ?, file_size = ? WHERE id = ?').run(key, name, req.body.length, id);
    ebooks.remove(req.library.id, c.file_key);
    res.json({ file: { name, size: req.body.length } });
  }));

  api.delete('/copies/:id/file', handler((req, res) => {
    const id = idParam(req);
    const c = db.prepare("SELECT file_key FROM copies WHERE id = ? AND library_id = ? AND format = 'ebook'").get(id, req.library.id);
    if (!c) throw httpError(404, 'Exemplaire numérique introuvable.');
    db.prepare('UPDATE copies SET file_key = NULL, file_name = NULL, file_size = NULL WHERE id = ?').run(id);
    ebooks.remove(req.library.id, c.file_key);
    res.json({ ok: true });
  }));

  api.delete('/copies/:id', handler((req, res) => {
    const id = idParam(req);
    if (db.prepare('SELECT 1 FROM loans WHERE copy_id = ? AND returned_at IS NULL').get(id)) {
      throw httpError(409, 'Cet exemplaire est en prêt : enregistre son retour avant de le supprimer.');
    }
    db.prepare('DELETE FROM copies WHERE id = ? AND library_id = ?').run(id, req.library.id);
    ebooks.purgeOrphans(req.library.id);
    res.json({ ok: true });
  }));

  // Exemplaire retrouve par son code (saisi ou scanne sur l'etiquette).
  api.get('/copies/by-code/:code', handler((req, res) => {
    const code = str(req.params.code, 40);
    const c = findCopy(req.library.id, code);
    if (!c) throw httpError(404, `Aucun exemplaire avec le code ${code}.`);
    const book = bookDetail(req.library.id, c.book_id);
    res.json({ copy: book.copies.find((x) => x.id === c.id), book, oldCode: c.code.toUpperCase() !== code.toUpperCase() ? code : null,
      defaultDueAt: dueDate(undefined, req.library) });
  }));

  // Livres d'un ISBN (bouton Scanner) avec leurs exemplaires papier et leur pret en cours.
  api.get('/copies/by-isbn/:isbn', handler((req, res) => {
    const raw = str(req.params.isbn, 30).replace(/[^0-9Xx]/g, '').toUpperCase();
    const isbn = normalizeIsbn(raw) || raw;
    if (!isbn) throw httpError(400, 'ISBN invalide.');
    const books = db.prepare('SELECT id FROM books WHERE library_id = ? AND isbn IN (?, ?) ORDER BY title, id').all(req.library.id, isbn, raw);
    res.json({
      isbn,
      books: books.map(({ id }) => {
        const b = bookDetail(req.library.id, id);
        return { id: b.id, title: b.title, authors: b.authors, coverUrl: b.coverUrl, copies: b.copies.filter((c) => c.format === 'physical') };
      }),
    });
  }));

  // Regenere les codes de tous les exemplaires de la bibliotheque avec le prefixe
  // choisi, soit en gardant les numeros (seul le prefixe change), soit en
  // renumerotant a partir de 1 dans l'ordre d'ajout. Les anciens codes restent
  // reconnus (copy_code_history) ; les etiquettes modifiees repassent "a imprimer".
  api.post('/copies/renumber', config, handler((req, res) => {
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
};
