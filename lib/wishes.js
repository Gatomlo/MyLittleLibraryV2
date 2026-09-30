// Listes de souhaits : livres qu'un compte aimerait lire ou voir acheter. Elles
// appartiennent au compte (base centrale), pas a une bibliotheque.
// Qui voit la liste d'un compte :
//  - le compte lui-meme (seul a pouvoir ajouter, modifier ou supprimer) ;
//  - les comptes avec qui il la partage (wish_shares) ;
//  - les bibliothecaires et gestionnaires (canManage) d'une bibliotheque a laquelle il est lie, quand
//    la page est ouverte dans cette bibliotheque (?library=<id>).
// Un souhait est dans la liste, ou ajoute a la bibliotheque (il est alors retire de la
// liste, le compte devient lecteur du livre), ou supprime : pas d'etat « acquis ».
// Routes montees sur l'API globale (/api/wishes...), voir server.js.
const fs = require('fs');
const path = require('path');
const { db, tx, inLibrary, DATA_DIR } = require('./db');
const auth = require('./auth');
const media = require('./media');

const { httpError } = media;
const { normalizeIsbn, lookupIsbn, searchEditions } = require('./isbn');
const { searchCovers } = require('./covers');

const writeExcelFileModule = require('write-excel-file/node');
const writeExcelFile = writeExcelFileModule.default || writeExcelFileModule;

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 500) => (v == null ? '' : String(v).trim()).slice(0, max);
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
const idList = (v) => [...new Set(String(v || '').split(',').map(intOrNull).filter(Boolean))].slice(0, 200);

// Image choisie ou photographiee pour un souhait : fichier dans data/wishes,
// cover_url = 'file:<nom>' ; servie (comptes connectes) sur /api/wishes/image/<nom>.
// Sinon cover_url est l'adresse https d'une couverture en ligne.
const WISH_DIR = path.join(DATA_DIR, 'wishes');
const FILE_RE = /^wish-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;
const fileOf = (coverUrl) => { const m = /^file:(.+)$/.exec(coverUrl || ''); return m && FILE_RE.test(m[1]) ? m[1] : null; };
// Adresse donnee au navigateur : https://..., ou chemin relatif a la racine du site.
const coverOut = (coverUrl) => (fileOf(coverUrl) ? `api/wishes/image/${fileOf(coverUrl)}` : coverUrl || '');
function dropFile(coverUrl) {
  const name = fileOf(coverUrl);
  if (name) fs.rm(path.join(WISH_DIR, name), { force: true }, () => {});
}
// Fichiers qui ne servent plus a aucun souhait (compte supprime...).
function purgeFiles() {
  try {
    const used = new Set(db.prepare("SELECT cover_url FROM wishes WHERE cover_url LIKE 'file:%'").all().map((w) => fileOf(w.cover_url)));
    fs.readdirSync(WISH_DIR).filter((f) => FILE_RE.test(f) && !used.has(f)).forEach((f) => fs.rmSync(path.join(WISH_DIR, f), { force: true }));
  } catch (e) { /* dossier absent */ }
}
// Couverture d'un souhait enregistre : image envoyee (coverData), adresse https, ou
// image deja enregistree laissee telle quelle. undefined = pas de changement.
function readCover(body, current) {
  if (body.coverData) {
    fs.mkdirSync(WISH_DIR, { recursive: true });
    return `file:${media.saveDataUrl(null, body.coverData, 'wish', WISH_DIR)}`;
  }
  if (body.coverUrl === undefined) return undefined;
  const c = str(body.coverUrl, 1000);
  if (current && fileOf(current) && c === coverOut(current)) return undefined;
  return /^https:\/\//i.test(c) ? c : null;
}

// Bibliotheque de la page (?library= ou corps library) si le compte la gere.
function managedLibrary(user, v) {
  const id = intOrNull(v);
  if (!id || !auth.canManage(user, id)) return null;
  return db.prepare('SELECT id, slug, name FROM libraries WHERE id = ?').get(id) || null;
}

// Comptes dont le compte connecte peut voir les souhaits (lui-meme en premier).
function visibleOwners(user, lib) {
  const map = new Map();
  const add = (u, via) => { if (!map.has(u.id)) map.set(u.id, { id: u.id, username: u.username, via }); };
  add({ id: user.id, username: user.username }, 'self');
  db.prepare(`SELECT u.id, u.username FROM wish_shares s JOIN users u ON u.id = s.owner_id
    WHERE s.viewer_id = ? ORDER BY u.username COLLATE NOCASE`).all(user.id).forEach((u) => add(u, 'share'));
  if (lib) {
    db.prepare(`SELECT u.id, u.username FROM user_libraries ul JOIN users u ON u.id = ul.user_id
      WHERE ul.library_id = ? ORDER BY u.username COLLATE NOCASE`).all(lib.id).forEach((u) => add(u, 'library'));
  }
  return [...map.values()];
}

function canView(user, ownerId, lib) {
  return visibleOwners(user, lib).some((o) => o.id === ownerId);
}

// Souhait deja present dans la bibliotheque de la page : meme ISBN, sinon meme titre.
function inLibraryMatches(lib, wishes) {
  if (!lib || !wishes.length) return new Map();
  return inLibrary(lib.id, () => {
    const byIsbn = db.prepare('SELECT id, title FROM books WHERE library_id = ? AND isbn = ? LIMIT 1');
    const byTitle = db.prepare('SELECT id, title FROM books WHERE library_id = ? AND title = ? COLLATE NOCASE LIMIT 1');
    return new Map(wishes.map((w) => [w.id, (w.isbn && byIsbn.get(lib.id, w.isbn)) || byTitle.get(lib.id, w.title) || null]));
  });
}

function rowOut(w, found) {
  return {
    id: w.id, isbn: w.isbn || '', title: w.title, subtitle: w.subtitle || '', authors: w.authors || '', publisher: w.publisher || '',
    year: w.year || null, coverUrl: coverOut(w.cover_url), notes: w.notes || '', priority: w.priority, createdAt: w.created_at,
    owner: { id: w.user_id, username: w.username },
    inLibrary: found ? { id: found.id, title: found.title } : null,
  };
}

// Couverture en ligne (meme recherche que pour les fiches : Open Library, Amazon,
// Decitre, Google Books), car la recherche par ISBN en donne rarement une. Les
// resultats approximatifs (titre simplifie) sont ecartes. '' si rien.
async function findCover({ isbn, title, authors }) {
  try {
    const list = await searchCovers({ isbn: isbn || '', title: title || '', author: authors || '' });
    const c = list.find((x) => !x.loose && /^https:\/\//i.test(x.url));
    return c ? c.url : '';
  } catch (e) { return ''; }
}

// Souhaits enregistres sans couverture : cherchee en arriere-plan a l'affichage de la
// liste, quelques-uns a la fois. cover_url NULL = jamais cherchee, '' = introuvable.
let filling = false;
async function fillCovers(ids) {
  if (filling || !ids.length) return;
  filling = true;
  try {
    for (const id of ids.slice(0, 6)) {
      const w = db.prepare('SELECT isbn, title, authors FROM wishes WHERE id = ? AND cover_url IS NULL').get(id);
      if (!w) continue;
      const url = await findCover(w);
      db.prepare('UPDATE wishes SET cover_url = ? WHERE id = ? AND cover_url IS NULL').run(url, id);
    }
  } catch (e) { /* prochaine fois */ } finally { filling = false; }
}

// priority : seulement les souhaits « Tres envie ».
function listWishes(user, { owners, lib, priority }) {
  const allowed = new Set(visibleOwners(user, lib).map((o) => o.id));
  const ids = (owners.length ? owners : [user.id]).filter((id) => allowed.has(id));
  if (!ids.length) return [];
  const where = [`w.user_id IN (${ids.map(() => '?').join(',')})`];
  if (priority) where.push('w.priority = 1');
  const rows = db.prepare(`SELECT w.*, u.username FROM wishes w JOIN users u ON u.id = w.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY w.priority DESC, w.created_at DESC, w.id DESC`).all(...ids);
  const found = inLibraryMatches(lib, rows);
  fillCovers(rows.filter((w) => w.cover_url === null).map((w) => w.id));
  return rows.map((w) => rowOut(w, found.get(w.id)));
}

function readWish(body, partial) {
  const out = {};
  const set = (k, v) => { if (!partial || body[k] !== undefined) out[k] = v; };
  set('title', str(body.title, 300));
  set('subtitle', str(body.subtitle, 300) || null);
  set('authors', str(body.authors, 300) || null);
  set('publisher', str(body.publisher, 200) || null);
  set('year', intOrNull(body.year) && intOrNull(body.year) < 3000 ? intOrNull(body.year) : null);
  set('notes', str(body.notes, 2000) || null);
  set('priority', body.priority ? 1 : 0);
  if (!partial || body.isbn !== undefined) {
    const raw = str(body.isbn, 40);
    out.isbn = raw ? normalizeIsbn(raw) || raw.replace(/[^0-9Xx]/g, '') || null : null;
  }
  if (out.title !== undefined && !out.title) throw httpError(400, 'Le titre est requis.');
  return out;
}

function getWish(id) {
  const w = db.prepare('SELECT * FROM wishes WHERE id = ?').get(id);
  if (!w) throw httpError(404, 'Souhait introuvable.');
  return w;
}

const EXPORT_HEADER = ['Membre', 'Titre', 'Sous-titre', 'Auteurs', 'Éditeur', 'Année', 'ISBN', 'Priorité', 'Notes', 'Ajouté le',
  'Dans la bibliothèque', 'Couverture (URL)', 'Lecteurs'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function registerWishes(api) {
  purgeFiles();
  api.use('/wishes', auth.requireAuth);

  // Comptes visibles (onglets de la page), avec le nombre de souhaits en attente.
  api.get('/wishes/owners', (req, res) => {
    const lib = managedLibrary(req.user, req.query.library);
    const owners = visibleOwners(req.user, lib);
    const count = db.prepare('SELECT COUNT(*) AS n FROM wishes WHERE user_id = ?');
    res.json({ owners: owners.map((o) => ({ ...o, count: count.get(o.id).n })), manager: !!lib });
  });

  api.get('/wishes', (req, res) => {
    const lib = managedLibrary(req.user, req.query.library);
    res.json(listWishes(req.user, { owners: idList(req.query.owners), lib, priority: req.query.priority === '1' }));
  });

  // Recherche d'informations : par ISBN, ou editions par titre / texte libre.
  api.get('/wishes/lookup/:isbn', h(async (req, res) => {
    const isbn = normalizeIsbn(req.params.isbn);
    if (!isbn) throw httpError(400, 'ISBN invalide.');
    const found = await lookupIsbn(isbn);
    if (found && !found.coverUrl) found.coverUrl = await findCover({ isbn, title: found.title, authors: found.authors });
    res.json({ isbn, found });
  }));
  // Image choisie ou photographiee pour un souhait.
  api.get('/wishes/image/:name', (req, res) => {
    if (!FILE_RE.test(req.params.name)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=604800').sendFile(path.join(WISH_DIR, req.params.name), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });
  // Couvertures proposees en ligne (fenetre « Chercher une couverture »).
  api.get('/wishes/covers', h(async (req, res) => {
    const q = { isbn: String(req.query.isbn || ''), title: String(req.query.title || ''), author: String(req.query.author || '') };
    if (!normalizeIsbn(q.isbn) && !q.title.trim()) throw httpError(400, 'Indique un ISBN ou un titre.');
    res.json({ covers: await searchCovers(q) });
  }));
  // Couverture d'une edition choisie par son titre, ou d'un souhait qui n'en a pas.
  api.get('/wishes/cover', h(async (req, res) => {
    const isbn = normalizeIsbn(str(req.query.isbn, 40)) || '';
    const title = str(req.query.title, 300);
    if (!isbn && !title) throw httpError(400, 'Indique un ISBN ou un titre.');
    res.json({ coverUrl: await findCover({ isbn, title, authors: str(req.query.authors, 300) }) });
  }));
  api.get('/wishes/search', h(async (req, res) => {
    const q = str(req.query.q, 300);
    if (!q) throw httpError(400, 'Indique un titre.');
    res.json({ editions: (await searchEditions({ q })).slice(0, 12) });
  }));

  // Partage de sa liste : comptes choisis parmi ceux des memes bibliotheques
  // (tous les comptes pour un administrateur).
  api.get('/wishes/shares', (req, res) => {
    const u = req.user;
    const candidates = u.role === 'admin'
      ? db.prepare('SELECT id, username FROM users WHERE id <> ? ORDER BY username COLLATE NOCASE').all(u.id)
      : db.prepare(`SELECT DISTINCT u.id, u.username FROM users u JOIN user_libraries a ON a.user_id = u.id
          JOIN user_libraries b ON b.library_id = a.library_id AND b.user_id = ?
          WHERE u.id <> ? ORDER BY u.username COLLATE NOCASE`).all(u.id, u.id);
    const viewers = db.prepare(`SELECT u.id, u.username FROM wish_shares s JOIN users u ON u.id = s.viewer_id
      WHERE s.owner_id = ? ORDER BY u.username COLLATE NOCASE`).all(u.id);
    // Un compte deja choisi reste propose meme s'il ne partage plus de bibliotheque.
    viewers.forEach((v) => { if (!candidates.some((c) => c.id === v.id)) candidates.push(v); });
    res.json({ viewers: viewers.map((v) => v.id), candidates });
  });
  api.put('/wishes/shares', h((req, res) => {
    const ids = (Array.isArray(req.body.viewerIds) ? req.body.viewerIds : []).map(intOrNull).filter((id) => id && id !== req.user.id);
    tx(() => {
      db.prepare('DELETE FROM wish_shares WHERE owner_id = ?').run(req.user.id);
      const ins = db.prepare('INSERT OR IGNORE INTO wish_shares (owner_id, viewer_id) SELECT ?, id FROM users WHERE id = ?');
      ids.forEach((id) => ins.run(req.user.id, id));
    });
    res.json({ ok: true });
  }));

  api.post('/wishes', h((req, res) => {
    const w = readWish(req.body, false);
    w.cover_url = readCover(req.body) || null;
    const id = db.prepare(`INSERT INTO wishes (user_id, isbn, title, subtitle, authors, publisher, year, cover_url, notes, priority)
      VALUES (@user_id, @isbn, @title, @subtitle, @authors, @publisher, @year, @cover_url, @notes, @priority)`).run({ ...w, user_id: req.user.id }).lastInsertRowid;
    res.json({ id: Number(id) });
  }));

  // Modification : le proprietaire seulement.
  api.put('/wishes/:id', h((req, res) => {
    const w = getWish(intOrNull(req.params.id));
    if (w.user_id !== req.user.id) throw httpError(403, 'Seul le propriétaire peut modifier ce souhait.');
    const f = readWish(req.body, true);
    const cover = readCover(req.body, w.cover_url);
    if (cover !== undefined) { f.cover_url = cover; dropFile(w.cover_url); }
    const cols = Object.keys(f);
    if (cols.length) db.prepare(`UPDATE wishes SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...f, id: w.id });
    res.json({ ok: true });
  }));

  // Souhait ajoute a la bibliotheque (fiche creee depuis la page Ajouter) : retire de
  // la liste. Par le proprietaire ou un gestionnaire de cette bibliotheque qui voit ses
  // souhaits ; le livre doit exister dans cette bibliotheque.
  api.post('/wishes/:id/added', h((req, res) => {
    const w = getWish(intOrNull(req.params.id));
    const lib = managedLibrary(req.user, req.body.library);
    if (!lib || !canView(req.user, w.user_id, lib)) throw httpError(403, 'Ce souhait ne peut pas être retiré par ton compte.');
    const bookId = intOrNull(req.body.bookId);
    if (!bookId || !inLibrary(lib.id, () => db.prepare('SELECT 1 FROM books WHERE id = ? AND library_id = ?').get(bookId, lib.id))) {
      throw httpError(400, 'Livre introuvable dans cette bibliothèque.');
    }
    db.prepare('DELETE FROM wishes WHERE id = ?').run(w.id);
    dropFile(w.cover_url);
    res.json({ ok: true });
  }));

  api.delete('/wishes/:id', h((req, res) => {
    const w = getWish(intOrNull(req.params.id));
    if (w.user_id !== req.user.id) throw httpError(403, 'Seul le propriétaire peut supprimer ce souhait.');
    db.prepare('DELETE FROM wishes WHERE id = ?').run(w.id);
    dropFile(w.cover_url);
    res.json({ ok: true });
  }));

  // Export des souhaits d'un ou plusieurs comptes. Colonnes compatibles avec l'import
  // de livres (Titre, Auteurs, ISBN... ; « Lecteurs » = le membre qui le souhaite).
  api.get('/wishes/export.:ext', h(async (req, res) => {
    const lib = managedLibrary(req.user, req.query.library);
    const list = listWishes(req.user, { owners: idList(req.query.owners), lib, priority: req.query.priority === '1' });
    const rows = list.map((w) => [w.owner.username, w.title, w.subtitle, w.authors, w.publisher, w.year || '', w.isbn,
      w.priority ? 'Très envie' : '', w.notes, (w.createdAt || '').slice(0, 10), w.inLibrary ? 'Oui' : '', /^https:/i.test(w.coverUrl) ? w.coverUrl : '', w.owner.username]);
    const name = `souhaits-${new Date().toISOString().slice(0, 10)}`;
    if (req.params.ext === 'csv') {
      res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
      return res.type('text/csv; charset=utf-8').send('﻿' + [EXPORT_HEADER, ...rows].map((l) => l.map(csvCell).join(';')).join('\r\n'));
    }
    const sheet = [EXPORT_HEADER.map((v) => ({ value: v, fontWeight: 'bold' }))].concat(rows.map((r) => r.map((v, i) => {
      if (i === 6) return { value: String(v), type: String, format: '@' }; // ISBN en texte
      if (v === '' || v == null) return null;
      return typeof v === 'number' ? { value: v, type: Number } : { value: String(v), type: String };
    })));
    const widths = { Membre: 16, Titre: 36, 'Sous-titre': 24, Auteurs: 26, 'Éditeur': 18, ISBN: 18, Notes: 34, 'Couverture (URL)': 40 };
    const buffer = await writeExcelFile(sheet, { columns: EXPORT_HEADER.map((hd) => ({ width: widths[hd] || 12 })), sheet: 'Souhaits' }).toBuffer();
    res.set('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
  }));
}

module.exports = { coverOut, registerWishes };
