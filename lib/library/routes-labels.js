// Etiquettes : exemplaires a imprimer, QR codes, marquage.
const QRCode = require('qrcode');
const { db, tx, normalize } = require('../db');
const { httpError, str } = require('../util');
const { handler, publicSettings, findCopy } = require('./catalog');

module.exports = function register(api) {
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
  api.post('/labels', handler(async (req, res) => {
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

  api.post('/labels/mark-printed', handler((req, res) => {
    const codes = (Array.isArray(req.body.codes) ? req.body.codes : []).slice(0, 500).map((c) => str(c, 40));
    const stmt = db.prepare("UPDATE copies SET label_printed_at = datetime('now') WHERE library_id = ? AND code = ?");
    tx(() => codes.forEach((c) => stmt.run(req.library.id, c)));
    res.json({ ok: true });
  }));

  // Toutes les etiquettes papier remises en attente (planches perdues, nouveau
  // format...) : codes inchanges. Imprimees ensuite par lots de 500.
  api.post('/labels/reset', handler((req, res) => {
    const r = db.prepare("UPDATE copies SET label_printed_at = NULL WHERE library_id = ? AND format = 'physical' AND label_printed_at IS NOT NULL")
      .run(req.library.id);
    res.json({ reset: Number(r.changes) });
  }));
};
