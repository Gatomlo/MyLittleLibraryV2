// Ecriture dans la base d'une liseuse Kobo (.kobo/KoboReader.sqlite), comme le fait
// Calibre : metadonnees des livres rattaches a une fiche (titre, auteurs, resume,
// editeur, ISBN, serie et tome, SeriesID pour l'onglet Series). Option par liseuse
// (kobo_devices.write_db, Chrome seulement). Le navigateur envoie la base au scan (avec
// son journal s'il n'est pas vide) ; le serveur garde chaque base saine (sauvegarde de
// l'appli, KEEP_BACKUPS par liseuse), modifie une copie complete (journal reporte,
// comme le ferait Calibre) et la rend au navigateur, qui sauvegarde aussi l'originale
// sur la liseuse avant de la remplacer. Seules les lignes de livres (ContentType 6) ajoutes
// par fichier sont modifiees ; le schema de la base n'est jamais change.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { libraryDir } = require('./db');
const { httpError } = require('./util');

const KEEP_BACKUPS = 10;
const TOKEN_TTL = 30 * 60 * 1000;

const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Resume : paragraphes en HTML (comme les livres de la boutique Kobo).
const summaryHtml = (v) => String(v).split(/\n\s*\n|\r?\n/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${xml(p)}</p>`).join('');

// Valeurs attendues dans la table content pour une fiche (colonnes Kobo).
function koboValues(b, seriesIds) {
  const series = b.series || null;
  const num = b.series_number ? String(b.series_number) : null;
  const float = num != null && /^\d+(?:[.,]\d+)?$/.test(num) ? Number(num.replace(',', '.')) : null;
  return {
    Title: b.title || 'Sans titre',
    Subtitle: b.subtitle || null,
    Attribution: String(b.authors || '').split(',').map((a) => a.trim()).filter(Boolean).join(', ') || null,
    Description: b.summary ? summaryHtml(b.summary) : null,
    Publisher: b.publisher || null,
    ISBN: b.isbn || null,
    Series: series,
    SeriesNumber: series ? num : null,
    SeriesNumberFloat: series ? float : null,
    // Onglet Series : liste construite sur SeriesID. Serie deja connue par un livre de
    // la boutique : meme identifiant ; sinon le nom de la serie (comme Calibre).
    SeriesID: series ? (seriesIds.get(series.toLowerCase()) || series) : null,
  };
}

// Dossier des vignettes d'un livre (.kobo-images/<n1>/<n2>), d'apres son ImageId
// (meme calcul que Calibre : qHash de Qt).
function qhash(str) {
  let h = 0;
  for (const x of Buffer.from(String(str), 'utf8')) {
    h = ((h << 4) + x) >>> 0;
    h = (h ^ ((h & 0xf0000000) >>> 23)) >>> 0;
    h &= 0x0fffffff;
  }
  return h;
}
const imageDir = (imageId) => {
  const h = qhash(imageId);
  return `.kobo-images/${h & 0xff}/${(h & 0xff00) >> 8}`;
};

const isSqlite = (buffer) => Buffer.isBuffer(buffer) && buffer.subarray(0, 15).toString() === 'SQLite format 3';

// Controle rapide : [] si la base est saine, sinon les problemes trouves (20 au plus).
function quickCheck(conn) {
  const r = conn.prepare('PRAGMA quick_check(20)').all().map((x) => String(Object.values(x)[0]));
  return r.length === 1 && r[0] === 'ok' ? [] : r;
}

const tableCols = (conn, t) => new Set(conn.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name));
const kNow = () => `${new Date().toISOString().slice(0, 19)}Z`;

// Livres retires par l'appli (fichier deja efface) : lignes supprimees comme le fait
// Calibre (livre, chapitres, pages de couverture, collections, reglages de lecture),
// pour que la liseuse n'ait pas ce nettoyage a faire a son demarrage. Surlignages et
// notes gardes (retrouves si le livre revient au meme endroit).
function removeBooks(conn, contentIds) {
  const has = (t) => !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  let n = 0;
  for (const id of contentIds) {
    if (!/^file:\/\//.test(id)) continue;
    if (!conn.prepare('SELECT 1 FROM content WHERE ContentID = ? AND ContentType = 6').get(id)) continue;
    if (has('volume_shortcovers')) conn.prepare('DELETE FROM volume_shortcovers WHERE volumeId = ?').run(id);
    if (has('ShelfContent')) conn.prepare('DELETE FROM ShelfContent WHERE ContentId = ?').run(id);
    if (has('content_settings')) conn.prepare('DELETE FROM content_settings WHERE ContentID = ?').run(id);
    if (tableCols(conn, 'content').has('BookID')) conn.prepare('DELETE FROM content WHERE BookID = ? AND ContentType <> 6').run(id);
    conn.prepare('DELETE FROM content WHERE ContentID = ? AND ContentType = 6').run(id);
    n++;
  }
  return n;
}

// Collections Kobo (Shelf / ShelfContent, comme Calibre) d'apres les fiches.
// wanted : Map contentId -> noms voulus ; managed : collections creees par l'appli
// (seules ses collections sont retirees d'un livre, jamais celles faites sur la liseuse).
// Renvoie le nombre de changements et la nouvelle liste des collections de l'appli.
function syncShelves(conn, wanted, managed) {
  const shelf = tableCols(conn, 'Shelf');
  const content = tableCols(conn, 'ShelfContent');
  if (!shelf.has('Name') || !content.has('ShelfName') || !content.has('ContentId')) return { count: 0, managed };
  const now = kNow();
  const all = new Set([...wanted.values()].flatMap((names) => [...names]));
  const owned = new Set(managed);
  let count = 0;
  // Collections : creees au besoin (Id = nom, comme Calibre), reaffichees si supprimees.
  for (const name of all) {
    const row = conn.prepare('SELECT * FROM Shelf WHERE Name = ?').get(name);
    if (!row) {
      const v = { CreationDate: now, Id: name, InternalName: name, LastModified: now, Name: name, _IsDeleted: 'false', _IsVisible: 'true', _IsSynced: 'false' };
      const keys = Object.keys(v).filter((k) => shelf.has(k));
      conn.prepare(`INSERT INTO Shelf (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => v[k]));
      owned.add(name);
      count++;
    } else if (String(row._IsDeleted) === 'true') {
      conn.prepare("UPDATE Shelf SET _IsDeleted = 'false', LastModified = ? WHERE Name = ?").run(now, name);
      owned.add(name);
      count++;
    }
  }
  const linked = conn.prepare("SELECT ShelfName FROM ShelfContent WHERE ContentId = ? AND (_IsDeleted IS NULL OR _IsDeleted <> 'true')");
  const add = conn.prepare(`INSERT OR REPLACE INTO ShelfContent (ShelfName, ContentId${content.has('DateModified') ? ', DateModified' : ''}${content.has('_IsDeleted') ? ', _IsDeleted' : ''}${content.has('_IsSynced') ? ', _IsSynced' : ''})
    VALUES (?, ?${content.has('DateModified') ? ', ?' : ''}${content.has('_IsDeleted') ? ", 'false'" : ''}${content.has('_IsSynced') ? ", 'false'" : ''})`);
  const drop = conn.prepare('DELETE FROM ShelfContent WHERE ShelfName = ? AND ContentId = ?');
  for (const [id, names] of wanted) {
    const current = new Set(linked.all(id).map((r) => r.ShelfName));
    for (const name of names) {
      if (!current.has(name)) { add.run(...[name, id, ...(content.has('DateModified') ? [now] : [])]); count++; }
    }
    for (const name of current) {
      if (owned.has(name) && !names.has(name)) { drop.run(name, id); count++; }
    }
  }
  // Collections de l'appli devenues vides : supprimees (comme sur la liseuse).
  for (const name of [...owned]) {
    if (all.has(name)) continue;
    const left = conn.prepare("SELECT COUNT(*) AS n FROM ShelfContent WHERE ShelfName = ? AND (_IsDeleted IS NULL OR _IsDeleted <> 'true')").get(name).n;
    if (!left) {
      if (shelf.has('_IsDeleted')) conn.prepare("UPDATE Shelf SET _IsDeleted = 'true', LastModified = ? WHERE Name = ? AND (_IsDeleted IS NULL OR _IsDeleted <> 'true')").run(now, name);
      owned.delete(name);
      count++;
    }
  }
  return { count, managed: [...owned].sort() };
}

// Applique les fiches a une copie de la base (fichier) : metadonnees des livres
// (targets : [{ contentId, book, coverRefresh, itemId, collections? }]), livres retires
// (removals : ContentID) et collections (shelves : { managed } ou null = sans collections
// gerees). Renvoie ce qui a change et les vignettes a effacer.
function applyToFile(file, targets, { removals = [], shelves = null } = {}) {
  const conn = new DatabaseSync(file);
  try {
    const problems = quickCheck(conn);
    if (problems.length) {
      console.error('Base de liseuse abimee, ecriture refusee :', problems);
      const first = problems.find((p) => !p.startsWith('***')) || problems[0];
      throw httpError(409, `La base de la liseuse semble abîmée (${first}) : rien n'y a été écrit.`);
    }
    const cols = tableCols(conn, 'content');
    if (!['ContentID', 'ContentType', 'Title', 'Attribution'].every((c) => cols.has(c))) {
      throw httpError(409, 'Base de liseuse d\'un format inconnu : rien n\'y a été écrit.');
    }
    const seriesIds = new Map();
    if (cols.has('Series') && cols.has('SeriesID')) {
      conn.prepare(`SELECT Series, SeriesID FROM content WHERE ContentType = 6 AND ContentID NOT LIKE 'file://%'
        AND Series IS NOT NULL AND Series <> '' AND SeriesID IS NOT NULL AND SeriesID <> ''`).all()
        .forEach((r) => seriesIds.set(String(r.Series).toLowerCase(), r.SeriesID));
    }
    const fields = ['Title', 'Subtitle', 'Attribution', 'Description', 'Publisher', 'ISBN', 'Series', 'SeriesNumber', 'SeriesNumberFloat', 'SeriesID']
      .filter((c) => cols.has(c));
    const get = conn.prepare(`SELECT ${fields.join(', ')}${cols.has('ImageId') ? ', ImageId' : ''} FROM content
      WHERE ContentID = ? AND ContentType = 6 AND ContentID LIKE 'file://%'`);
    const changed = [];
    const covers = [];
    let removed = 0;
    let shelfChanges = 0;
    let managed = shelves ? shelves.managed : null;
    conn.exec('BEGIN');
    try {
      removed = removeBooks(conn, removals);
      const wanted = new Map();
      for (const t of targets) {
        const row = get.get(t.contentId);
        if (!row) continue;
        if (t.collections) wanted.set(t.contentId, new Set(t.collections));
        const want = koboValues(t.book, seriesIds);
        const diff = fields.filter((f) => (row[f] ?? null) !== (want[f] ?? null) && String(row[f] ?? '') !== String(want[f] ?? ''));
        if (diff.length) {
          conn.prepare(`UPDATE content SET ${diff.map((f) => `${f} = ?`).join(', ')} WHERE ContentID = ? AND ContentType = 6`)
            .run(...diff.map((f) => want[f] ?? null), t.contentId);
          changed.push({ itemId: t.itemId, contentId: t.contentId, values: want });
        }
        if (t.coverRefresh && row.ImageId) covers.push({ itemId: t.itemId, dir: imageDir(row.ImageId), prefix: `${row.ImageId} - ` });
      }
      if (shelves) {
        const r = syncShelves(conn, wanted, shelves.managed || []);
        shelfChanges = r.count;
        managed = r.managed;
      }
      conn.exec('COMMIT');
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
    if ((changed.length || removed || shelfChanges) && quickCheck(conn).length) {
      throw httpError(500, 'Vérification de la base modifiée échouée : rien n\'a été écrit sur la liseuse.');
    }
    return { changed, covers, removed, shelfChanges, managed };
  } finally {
    conn.close();
  }
}

// ---------- Base modifiee en attente de recuperation par le navigateur ----------
const pending = new Map(); // jeton -> { file, deviceId, libraryId, expires }
// extra : donnees rendues a la confirmation de l'ecriture (collections de l'appli).
function keepModified(file, libraryId, deviceId, extra = {}) {
  for (const [k, p] of pending) {
    if (p.expires < Date.now() || (p.deviceId === deviceId && p.libraryId === libraryId)) {
      fs.rm(p.file, { force: true }, () => {});
      pending.delete(k);
    }
  }
  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, { file, libraryId, deviceId, extra, expires: Date.now() + TOKEN_TTL });
  return token;
}
function modifiedFile(token, libraryId, deviceId) {
  const p = pending.get(String(token));
  if (!p || p.libraryId !== libraryId || p.deviceId !== deviceId || p.expires < Date.now()) throw httpError(404, 'Base modifiée introuvable ou expirée : rescanne la liseuse.');
  return p.file;
}
// Ecriture confirmee (ou abandonnee) : base modifiee retiree ; renvoie ses donnees.
function dropModified(token, libraryId, deviceId) {
  const p = pending.get(String(token));
  if (!p || p.libraryId !== libraryId || p.deviceId !== deviceId) return null;
  fs.rm(p.file, { force: true }, () => {});
  pending.delete(String(token));
  return p.extra;
}

// ---------- Sauvegardes de l'appli (data/libraries/<id>/kobo-backups) ----------
// Base saine gardee a chaque scan (compressee, une seule fois par contenu : empreinte
// dans le nom), les KEEP_BACKUPS dernieres par liseuse. Anciennes sauvegardes .sqlite
// (non compressees) toujours lues.
const backupDir = (libraryId) => {
  const dir = libraryDir(libraryId, 'kobo-backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const BACKUP_RE = /^(\d+)-(\d{8}-\d{6})(?:-([0-9a-f]{4,12}))?\.sqlite(\.gz)?$/;
const sha = (buffer) => crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);

function listBackups(libraryId, deviceId) {
  let names;
  try { names = fs.readdirSync(backupDir(libraryId)); } catch (e) { return []; }
  return names.map((name) => ({ name, m: BACKUP_RE.exec(name) }))
    .filter((x) => x.m && Number(x.m[1]) === deviceId)
    .map(({ name, m }) => {
      const d = m[2];
      return { name, hash: m[4] ? m[3] : null, size: fs.statSync(path.join(backupDir(libraryId), name)).size,
        createdAt: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}` };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : (a.name < b.name ? 1 : -1)));
}

// Sauvegarde d'une base (saine) ; rien si la derniere a le meme contenu.
function saveBackup(libraryId, deviceId, buffer) {
  const hash = sha(buffer);
  const list = listBackups(libraryId, deviceId);
  if (list[0] && list[0].hash === hash) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${deviceId}-${stamp}-${hash}.sqlite.gz`;
  fs.writeFileSync(path.join(backupDir(libraryId), name), zlib.gzipSync(buffer, { level: 6 }));
  listBackups(libraryId, deviceId).slice(KEEP_BACKUPS).forEach((b) => fs.rmSync(path.join(backupDir(libraryId), b.name), { force: true }));
  return name;
}

// Fichier d'une sauvegarde et s'il est compresse.
function backupFile(libraryId, deviceId, name) {
  const m = BACKUP_RE.exec(String(name));
  if (!m || Number(m[1]) !== deviceId) throw httpError(404, 'Sauvegarde introuvable.');
  const file = path.join(backupDir(libraryId), m[0]);
  if (!fs.existsSync(file)) throw httpError(404, 'Sauvegarde introuvable.');
  return { file, gzip: !!m[4] };
}

function removeBackups(libraryId, deviceId) {
  listBackups(libraryId, deviceId).forEach((b) => fs.rmSync(path.join(backupDir(libraryId), b.name), { force: true }));
}

// Scan avec ecriture : copie de la base (complete, journal compris) modifiee d'apres
// les fiches. force : base a reecrire meme sans changement (journal de la liseuse a
// reporter). Renvoie null si rien n'est a ecrire.
function prepareWrite(buffer, libraryId, deviceId, targets, { force = false, removals = [], shelves = null } = {}) {
  if (!isSqlite(buffer)) throw httpError(400, "Ce fichier n'est pas une base de liseuse Kobo.");
  const file = path.join(os.tmpdir(), `kobo-write-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  fs.writeFileSync(file, buffer);
  let result;
  try {
    result = applyToFile(file, targets, { removals, shelves });
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  ['-wal', '-shm', '-journal'].forEach((x) => fs.rmSync(file + x, { force: true }));
  const { changed, covers, removed, shelfChanges, managed } = result;
  if (!changed.length && !removed && !shelfChanges && !force) {
    fs.rmSync(file, { force: true });
    return covers.length ? { token: null, changed: [], covers, removed: 0, shelfChanges: 0, managed } : null;
  }
  return { token: keepModified(file, libraryId, deviceId, { managed }), changed, covers, removed, shelfChanges, managed };
}

module.exports = {
  prepareWrite, modifiedFile, dropModified, listBackups, saveBackup, backupFile, removeBackups, isSqlite, koboValues, imageDir, qhash, summaryHtml,
};
