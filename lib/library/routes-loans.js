// Emprunteurs, prets et reservations.
const { db, tx, normalize } = require('../db');
const { httpError, str } = require('../util');
const {
  handler, mediaUrl, idParam, reminderSettings, getBookRow, findCopy, OVERDUE, toRemindSql, reservationsFor, resolveBorrower, dueDate,
  listLoans,
} = require('./catalog');

module.exports = function register(api) {
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

  api.post('/borrowers', handler((req, res) => {
    const b = readBorrower(req.body);
    const r = db.prepare('INSERT INTO borrowers (library_id, name, email, phone, notes) VALUES (@library_id, @name, @email, @phone, @notes)')
      .run({ ...b, library_id: req.library.id });
    res.json({ id: Number(r.lastInsertRowid), ...b });
  }));

  api.get('/borrowers/:id', handler((req, res) => {
    const id = idParam(req);
    const b = db.prepare('SELECT * FROM borrowers WHERE id = ? AND library_id = ?').get(id, req.library.id);
    if (!b) throw httpError(404, 'Emprunteur introuvable.');
    res.json({
      id: b.id, name: b.name, email: b.email || '', phone: b.phone || '', notes: b.notes || '',
      loans: listLoans(req.library.id, { borrowerId: id, status: 'all' }),
      reservations: db.prepare(`SELECT r.id, r.created_at, b.id AS book_id, b.title, b.cover FROM reservations r
        JOIN books b ON b.id = r.book_id WHERE r.borrower_id = ? ORDER BY r.created_at, r.id`).all(id)
        .map((r) => ({ id: r.id, createdAt: r.created_at, book: { id: r.book_id, title: r.title, coverUrl: mediaUrl(r.cover) } })),
    });
  }));

  api.put('/borrowers/:id', handler((req, res) => {
    const r = db.prepare('UPDATE borrowers SET name = @name, email = @email, phone = @phone, notes = @notes WHERE id = @id AND library_id = @library_id')
      .run({ ...readBorrower(req.body), id: idParam(req), library_id: req.library.id });
    if (!r.changes) throw httpError(404, 'Emprunteur introuvable.');
    res.json({ ok: true });
  }));

  api.delete('/borrowers/:id', handler((req, res) => {
    const id = idParam(req);
    if (db.prepare('SELECT 1 FROM loans WHERE borrower_id = ?').get(id)) {
      throw httpError(409, "Cet emprunteur a un historique de prêts : il ne peut pas être supprimé (l'historique serait perdu).");
    }
    db.prepare('DELETE FROM borrowers WHERE id = ? AND library_id = ?').run(id, req.library.id);
    res.json({ ok: true });
  }));

  // ---------- Prets ----------
  api.get('/loans', (req, res) => {
    res.json(listLoans(req.library.id, { status: ['open', 'overdue', 'remind', 'returned', 'all'].includes(req.query.status) ? req.query.status : 'open' }));
  });

  // Compteurs pour l'en-tete et les onglets de la page Prets.
  api.get('/loans/summary', (req, res) => {
    const libId = req.library.id;
    const r = db.prepare(`SELECT COUNT(*) AS open, COALESCE(SUM(${OVERDUE}), 0) AS overdue
      FROM loans l JOIN copies c ON c.id = l.copy_id WHERE c.library_id = ? AND l.returned_at IS NULL`).get(libId);
    const reservations = db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE library_id = ?').get(libId).n;
    const auto = req.library.reminder_mode === 'auto';
    const toRemind = auto ? db.prepare(`SELECT COUNT(*) AS n FROM loans l JOIN copies c ON c.id = l.copy_id
      WHERE c.library_id = ? AND ${toRemindSql(libId)}`).get(libId).n : 0;
    res.json({ open: r.open, overdue: r.overdue, reservations, toRemind, reminder: reminderSettings(req.library) });
  });

  // Relance envoyee (le navigateur a ouvert le message mailto) : date et nombre de relances.
  api.post('/loans/reminded', handler((req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
    if (!ids.length) throw httpError(400, 'Aucun prêt indiqué.');
    const r = db.prepare(`UPDATE loans SET reminded_at = datetime('now'), reminder_count = reminder_count + 1
      WHERE returned_at IS NULL AND id IN (${ids.map(() => '?').join(',')})
      AND copy_id IN (SELECT id FROM copies WHERE library_id = ?)`).run(...ids, req.library.id);
    res.json({ ok: true, updated: r.changes });
  }));

  // Date de retour prevue d'un pret en cours (prolongation).
  api.put('/loans/:id', handler((req, res) => {
    const r = db.prepare(`UPDATE loans SET due_at = ? WHERE id = ? AND returned_at IS NULL
      AND copy_id IN (SELECT id FROM copies WHERE library_id = ?)`).run(dueDate(req.body.dueAt || '', req.library), idParam(req), req.library.id);
    if (!r.changes) throw httpError(404, 'Prêt introuvable ou déjà clôturé.');
    res.json({ ok: true });
  }));

  api.post('/loans', handler((req, res) => {
    const libId = req.library.id;
    const code = str(req.body.code, 40);
    const loanId = tx(() => {
      const copy = findCopy(libId, code);
      if (!copy) throw httpError(404, `Aucun exemplaire avec le code ${code}.`);
      if (db.prepare('SELECT 1 FROM loans WHERE copy_id = ? AND returned_at IS NULL').get(copy.id)) {
        throw httpError(409, 'Cet exemplaire est déjà en prêt.');
      }
      const borrowerId = resolveBorrower(libId, req.body);
      // Reservation de cet emprunteur pour ce livre : satisfaite par le pret.
      db.prepare('DELETE FROM reservations WHERE book_id = ? AND borrower_id = ?').run(copy.book_id, borrowerId);
      return db.prepare('INSERT INTO loans (copy_id, borrower_id, notes, due_at) VALUES (?, ?, ?, ?)')
        .run(copy.id, borrowerId, str(req.body.notes, 1000) || null, dueDate(req.body.dueAt, req.library)).lastInsertRowid;
    });
    res.json(listLoans(libId, { status: 'all', id: Number(loanId) })[0]);
  }));

  api.post('/loans/:id/return', handler((req, res) => {
    const r = db.prepare(`UPDATE loans SET returned_at = datetime('now') WHERE id = ? AND returned_at IS NULL
      AND copy_id IN (SELECT id FROM copies WHERE library_id = ?)`).run(idParam(req), req.library.id);
    if (!r.changes) throw httpError(404, 'Prêt introuvable ou déjà clôturé.');
    // Reservations du livre rendu : alerte "a mettre de cote" dans l'interface.
    const book = db.prepare('SELECT b.id, b.title FROM loans l JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id WHERE l.id = ?').get(idParam(req));
    res.json({ ok: true, book: { id: book.id, title: book.title }, reservations: reservationsFor(book.id) });
  }));

  // ---------- Reservations (comptes membres) ----------
  api.get('/reservations', (req, res) => {
    res.json(db.prepare(`SELECT r.id, r.created_at, br.id AS borrower_id, br.name, b.id AS book_id, b.title, b.authors, b.cover,
        (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id AND c.format = 'physical'
          AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.copy_id = c.id AND l.returned_at IS NULL)) AS available
      FROM reservations r JOIN borrowers br ON br.id = r.borrower_id JOIN books b ON b.id = r.book_id
      WHERE r.library_id = ? ORDER BY r.created_at, r.id`).all(req.library.id)
      .map((r) => ({
        id: r.id, createdAt: r.created_at, available: r.available, borrower: { id: r.borrower_id, name: r.name },
        book: { id: r.book_id, title: r.title, authors: r.authors || '', coverUrl: mediaUrl(r.cover) },
      })));
  });

  // Reserver un livre au nom d'un emprunteur (choisi, ou cree comme au pret).
  api.post('/books/:id/reservations', handler((req, res) => {
    const id = idParam(req);
    getBookRow(req.library.id, id);
    tx(() => {
      const borrowerId = resolveBorrower(req.library.id, req.body);
      // Pas de reservation pour quelqu'un qui a deja un exemplaire de ce livre en pret.
      if (db.prepare(`SELECT 1 FROM loans l JOIN copies c ON c.id = l.copy_id
        WHERE c.book_id = ? AND l.borrower_id = ? AND l.returned_at IS NULL`).get(id, borrowerId)) {
        throw httpError(409, 'Cet emprunteur a déjà un exemplaire de ce livre en prêt : il ne peut pas le réserver.');
      }
      db.prepare('INSERT OR IGNORE INTO reservations (library_id, book_id, borrower_id, created_by) VALUES (?, ?, ?, ?)')
        .run(req.library.id, id, borrowerId, req.user.id);
    });
    res.json(reservationsFor(id));
  }));

  api.delete('/reservations/:id', handler((req, res) => {
    const r = db.prepare('SELECT * FROM reservations WHERE id = ? AND library_id = ?').get(idParam(req), req.library.id);
    if (!r) throw httpError(404, 'Réservation introuvable.');
    db.prepare('DELETE FROM reservations WHERE id = ?').run(r.id);
    res.json(reservationsFor(r.book_id));
  }));
};
