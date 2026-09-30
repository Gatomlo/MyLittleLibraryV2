// Classement : categories et tags (tables), series, auteurs, editeurs et collections
// (valeurs libres des fiches), emplacements.
const { db, tx } = require('../db');
const { httpError, str, intOrNull } = require('../util');
const { handler, idParam, TAXONOMIES, TAGS, VALUE_FIELDS, valueList, rewriteValues, termList } = require('./catalog');

module.exports = function register(api, { config }) {
  // Memes routes pour les deux classements : /categories/... et /tags/...
  for (const [path, tax] of Object.entries(TAXONOMIES)) {
    const guard = (req) => {
      if (tax === TAGS && !req.library.enable_tags) throw httpError(409, "Les tags ne sont pas activés pour cette bibliothèque.");
    };

    api.get(`/${path}`, (req, res) => res.json(termList(tax, req.library)));

    api.post(`/${path}`, handler((req, res) => {
      guard(req);
      const name = str(String(req.body.name || '').replace(/^#/, ''), 80);
      if (!name) throw httpError(400, 'Nom requis.');
      const r = db.prepare(`INSERT INTO ${tax.table} (library_id, name) VALUES (?, ?)`).run(req.library.id, name);
      res.json({ id: Number(r.lastInsertRowid), name });
    }));

    api.put(`/${path}/:id`, handler((req, res) => {
      guard(req);
      const name = str(String(req.body.name || '').replace(/^#/, ''), 80);
      if (!name) throw httpError(400, 'Nom requis.');
      db.prepare(`UPDATE ${tax.table} SET name = ? WHERE id = ? AND library_id = ?`).run(name, idParam(req), req.library.id);
      res.json({ ok: true });
    }));

    api.delete(`/${path}/:id`, handler((req, res) => {
      db.prepare(`DELETE FROM ${tax.table} WHERE id = ? AND library_id = ?`).run(idParam(req), req.library.id);
      res.json({ ok: true });
    }));

    // Fusion : les livres des termes choisis passent dans le terme cible (un des
    // termes choisis, un existant ou un nouveau), les autres disparaissent.
    api.post(`/${path}/merge`, handler((req, res) => {
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

  api.get('/values/:kind', handler((req, res) => res.json(valueList(req.library, valueCol(req)))));

  // Renommage (fusionne de fait avec une valeur existante du meme nom).
  api.put('/values/:kind', config, handler((req, res) => {
    const col = valueCol(req);
    const from = str(req.body.from, 500);
    const name = str(req.body.name, col === 'authors' ? 200 : 500);
    if (!from || !name) throw httpError(400, 'Nom requis.');
    if (col === 'authors' && name.includes(',')) throw httpError(400, 'Un nom d\'auteur ne peut pas contenir de virgule.');
    res.json({ name, books: rewriteValues(req.library, col, [from], name) });
  }));

  api.post('/values/:kind/merge', config, handler((req, res) => {
    const col = valueCol(req);
    const from = (Array.isArray(req.body.ids) ? req.body.ids : []).map((v) => str(v, 500)).filter(Boolean);
    const name = str(req.body.name, 500);
    if (!from.length || !name) throw httpError(400, 'Choisis les valeurs à fusionner et le nom final.');
    if (col === 'authors' && name.includes(',')) throw httpError(400, 'Un nom d\'auteur ne peut pas contenir de virgule.');
    res.json({ name, books: rewriteValues(req.library, col, from, name) });
  }));

  // Suppression : la valeur est retiree des fiches (les livres restent au catalogue).
  api.post('/values/:kind/delete', config, handler((req, res) => {
    const col = valueCol(req);
    const name = str(req.body.name, 500);
    if (!name) throw httpError(400, 'Nom requis.');
    res.json({ books: rewriteValues(req.library, col, [name], null) });
  }));

  api.get('/locations', (req, res) => {
    res.json(db.prepare(`SELECT DISTINCT location FROM copies WHERE library_id = ? AND location IS NOT NULL AND location <> ''
      ORDER BY location COLLATE NOCASE`).all(req.library.id).map((r) => r.location));
  });
};
