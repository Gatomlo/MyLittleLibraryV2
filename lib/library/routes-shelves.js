// Etageres : listes libres de livres, privees (a leur proprietaire) ou partagees avec
// toute la bibliotheque (gestionnaires). Option par bibliotheque (enable_shelves) et
// preference par compte (user_library_prefs.shelves_off : interface masquee, donnees gardees).
// Ouvert aux lecteurs (voir READER_GET / READER_WRITE de library-api.js) : chacun gere les siennes.
const { db, tx, normalize } = require('../db');
const { httpError, str } = require('../util');
const auth = require('../auth');
const { handler, idParam, mediaUrl } = require('./catalog');

module.exports = function register(api) {
  const needShelves = (req) => {
    if (!req.library.enable_shelves) throw httpError(409, "Les étagères ne sont pas activées pour cette bibliothèque.");
  };
  const canManage = (req) => auth.canManage(req.user, req.library.id);

  // Etageres visibles : les siennes et les partagees. Avec nombre de livres et quelques couvertures.
  const VISIBLE = '(s.user_id = ? OR s.shared = 1)';
  function shelfRows(req, extraWhere = '', extraParams = []) {
    const libId = req.library.id;
    const rows = db.prepare(`SELECT s.id, s.name, s.shared, s.user_id, u.username AS owner,
        (SELECT COUNT(*) FROM shelf_books sb WHERE sb.shelf_id = s.id) AS count
      FROM shelves s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.library_id = ? AND ${VISIBLE} ${extraWhere}
      ORDER BY (s.user_id = ?) DESC, s.position, s.name COLLATE NOCASE`).all(libId, req.user.id, ...extraParams, req.user.id);
    const covers = db.prepare(`SELECT b.cover FROM shelf_books sb JOIN books b ON b.id = sb.book_id
      WHERE sb.shelf_id = ? AND b.cover IS NOT NULL ORDER BY sb.added_at DESC, b.id DESC LIMIT 4`);
    return rows.map((r) => ({
      id: r.id, name: r.name, shared: !!r.shared, mine: r.user_id === req.user.id, owner: r.owner || '', count: r.count,
      covers: covers.all(r.id).map((c) => mediaUrl(c.cover)),
    }));
  }

  // Etageres modifiables par le compte : les siennes ; un gestionnaire peut aussi retirer une partagee.
  function ownShelf(req, id, { allowManagerShared = false } = {}) {
    const s = db.prepare('SELECT id, user_id, shared FROM shelves WHERE id = ? AND library_id = ?').get(id, req.library.id);
    if (!s || !(s.user_id === req.user.id || s.shared)) throw httpError(404, 'Étagère introuvable.');
    if (s.user_id !== req.user.id && !(allowManagerShared && canManage(req))) throw httpError(403, "Cette étagère appartient à un autre compte.");
    return s;
  }

  function bookIds(req) {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
    if (!ids.length) throw httpError(400, 'Aucun livre indiqué.');
    return ids;
  }

  // Nom valide et unique parmi les etageres du compte (sans tenir compte des accents ni de la casse).
  function nameOf(req, exceptId = 0) {
    const name = str(req.body.name, 60);
    if (!name) throw httpError(400, "Donne un nom à l'étagère.");
    const key = normalize(name);
    const taken = db.prepare('SELECT name FROM shelves WHERE user_id = ? AND library_id = ? AND id <> ?').all(req.user.id, req.library.id, exceptId);
    if (taken.some((r) => normalize(r.name) === key)) throw httpError(409, 'Tu as déjà une étagère de ce nom.');
    return name;
  }
  const dupName = (e) => (/UNIQUE/i.test(String(e.message)) ? httpError(409, 'Tu as déjà une étagère de ce nom.') : e);

  // Preference du compte : interface des etageres affichee (par defaut) ou masquee.
  api.get('/shelves/pref', handler((req, res) => {
    const p = db.prepare('SELECT shelves_off FROM user_library_prefs WHERE user_id = ? AND library_id = ?').get(req.user.id, req.library.id);
    res.json({ enabled: !(p && p.shelves_off) });
  }));
  api.put('/shelves/pref', handler((req, res) => {
    const off = req.body.enabled === false ? 1 : 0;
    db.prepare(`INSERT INTO user_library_prefs (user_id, library_id, shelves_off) VALUES (?, ?, ?)
      ON CONFLICT(user_id, library_id) DO UPDATE SET shelves_off = excluded.shelves_off`).run(req.user.id, req.library.id, off);
    res.json({ enabled: !off });
  }));

  api.get('/shelves', handler((req, res) => {
    needShelves(req);
    res.json(shelfRows(req));
  }));

  // Etageres visibles avec, pour un livre, celles qui le contiennent.
  api.get('/books/:id/shelves', handler((req, res) => {
    needShelves(req);
    const id = idParam(req);
    const has = new Set(db.prepare('SELECT shelf_id FROM shelf_books WHERE book_id = ?').all(id).map((r) => r.shelf_id));
    res.json(shelfRows(req).map((s) => ({ ...s, has: has.has(s.id) })));
  }));

  api.post('/shelves', handler((req, res) => {
    needShelves(req);
    const name = nameOf(req);
    const shared = req.body.shared && canManage(req) ? 1 : 0;
    try {
      const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM shelves WHERE user_id = ? AND library_id = ?').get(req.user.id, req.library.id).n;
      const r = db.prepare('INSERT INTO shelves (library_id, user_id, name, shared, position) VALUES (?, ?, ?, ?, ?)').run(req.library.id, req.user.id, name, shared, pos);
      const created = shelfRows(req, 'AND s.id = ?', [Number(r.lastInsertRowid)])[0];
      const ids = Array.isArray(req.body.ids) ? bookIds(req) : [];
      if (ids.length) addBooks(req.library.id, created.id, ids);
      res.json(shelfRows(req, 'AND s.id = ?', [created.id])[0]);
    } catch (e) { throw dupName(e); }
  }));

  api.put('/shelves/:id', handler((req, res) => {
    needShelves(req);
    const id = idParam(req);
    ownShelf(req, id);
    try {
      if (req.body.name !== undefined) db.prepare('UPDATE shelves SET name = ? WHERE id = ?').run(nameOf(req, id), id);
      if (req.body.shared !== undefined && canManage(req)) db.prepare('UPDATE shelves SET shared = ? WHERE id = ?').run(req.body.shared ? 1 : 0, id);
    } catch (e) { throw dupName(e); }
    res.json(shelfRows(req, 'AND s.id = ?', [id])[0]);
  }));

  api.delete('/shelves/:id', handler((req, res) => {
    needShelves(req);
    const id = idParam(req);
    ownShelf(req, id, { allowManagerShared: true });
    db.prepare('DELETE FROM shelves WHERE id = ?').run(id);
    res.json({ ok: true });
  }));

  function addBooks(libId, shelfId, ids) {
    const exists = db.prepare('SELECT 1 FROM books WHERE id = ? AND library_id = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO shelf_books (shelf_id, book_id) VALUES (?, ?)');
    let added = 0;
    for (const id of ids) if (exists.get(id, libId)) added += Number(ins.run(shelfId, id).changes);
    return added;
  }

  api.post('/shelves/:id/books', handler((req, res) => {
    needShelves(req);
    const id = idParam(req);
    ownShelf(req, id);
    const added = tx(() => addBooks(req.library.id, id, bookIds(req)));
    res.json({ added });
  }));

  api.post('/shelves/:id/books/remove', handler((req, res) => {
    needShelves(req);
    const id = idParam(req);
    ownShelf(req, id);
    const del = db.prepare('DELETE FROM shelf_books WHERE shelf_id = ? AND book_id = ?');
    const removed = tx(() => bookIds(req).reduce((n, b) => n + Number(del.run(id, b).changes), 0));
    res.json({ removed });
  }));
};
