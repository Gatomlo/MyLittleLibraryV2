// Ecriture dans la base d'une liseuse Kobo (.kobo/KoboReader.sqlite), comme le fait
// Calibre : metadonnees des livres rattaches a une fiche (titre, auteurs, resume,
// editeur, ISBN, serie et tome, SeriesID pour l'onglet Series). Option par liseuse
// (kobo_devices.write_db, Chrome seulement). Le navigateur envoie la base au scan ; le
// serveur en garde une copie (sauvegarde de l'appli, KEEP_BACKUPS par liseuse),
// modifie une copie et la rend au navigateur, qui sauvegarde aussi l'originale sur la
// liseuse avant de la remplacer. Seules les lignes de livres (ContentType 6) ajoutes
// par fichier sont modifiees ; le schema de la base n'est jamais change.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
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

// Applique les metadonnees des fiches a une copie de la base (fichier).
// targets : [{ contentId, book, coverRefresh, itemId }]. Renvoie les livres modifies
// et les vignettes a effacer (couverture changee dans l'epub).
function applyToFile(file, targets) {
  const conn = new DatabaseSync(file);
  try {
    const problems = quickCheck(conn);
    if (problems.length) {
      console.error('Base de liseuse abimee, ecriture refusee :', problems);
      const first = problems.find((p) => !p.startsWith('***')) || problems[0];
      throw httpError(409, `La base de la liseuse semble abîmée (${first}) : rien n'y a été écrit.`);
    }
    const cols = new Set(conn.prepare('PRAGMA table_info(content)').all().map((c) => c.name));
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
    conn.exec('BEGIN');
    try {
      for (const t of targets) {
        const row = get.get(t.contentId);
        if (!row) continue;
        const want = koboValues(t.book, seriesIds);
        const diff = fields.filter((f) => (row[f] ?? null) !== (want[f] ?? null) && String(row[f] ?? '') !== String(want[f] ?? ''));
        if (diff.length) {
          conn.prepare(`UPDATE content SET ${diff.map((f) => `${f} = ?`).join(', ')} WHERE ContentID = ? AND ContentType = 6`)
            .run(...diff.map((f) => want[f] ?? null), t.contentId);
          changed.push({ itemId: t.itemId, contentId: t.contentId, values: want });
        }
        if (t.coverRefresh && row.ImageId) covers.push({ itemId: t.itemId, dir: imageDir(row.ImageId), prefix: `${row.ImageId} - ` });
      }
      conn.exec('COMMIT');
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
    if (changed.length && quickCheck(conn).length) throw httpError(500, 'Vérification de la base modifiée échouée : rien n\'a été écrit sur la liseuse.');
    return { changed, covers };
  } finally {
    conn.close();
  }
}

// ---------- Base modifiee en attente de recuperation par le navigateur ----------
const pending = new Map(); // jeton -> { file, deviceId, libraryId, expires }
function keepModified(file, libraryId, deviceId) {
  for (const [k, p] of pending) {
    if (p.expires < Date.now() || (p.deviceId === deviceId && p.libraryId === libraryId)) {
      fs.rm(p.file, { force: true }, () => {});
      pending.delete(k);
    }
  }
  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, { file, libraryId, deviceId, expires: Date.now() + TOKEN_TTL });
  return token;
}
function modifiedFile(token, libraryId, deviceId) {
  const p = pending.get(String(token));
  if (!p || p.libraryId !== libraryId || p.deviceId !== deviceId || p.expires < Date.now()) throw httpError(404, 'Base modifiée introuvable ou expirée : rescanne la liseuse.');
  return p.file;
}
function dropModified(token) {
  const p = pending.get(String(token));
  if (p) { fs.rm(p.file, { force: true }, () => {}); pending.delete(String(token)); }
}

// ---------- Sauvegardes de l'appli (data/libraries/<id>/kobo-backups) ----------
const backupDir = (libraryId) => {
  const dir = libraryDir(libraryId, 'kobo-backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const BACKUP_RE = /^(\d+)-(\d{8}-\d{6})(?:-[0-9a-f]{4})?\.sqlite$/;

function listBackups(libraryId, deviceId) {
  let names;
  try { names = fs.readdirSync(backupDir(libraryId)); } catch (e) { return []; }
  return names.map((name) => ({ name, m: BACKUP_RE.exec(name) }))
    .filter((x) => x.m && Number(x.m[1]) === deviceId)
    .map(({ name, m }) => {
      const d = m[2];
      return { name, size: fs.statSync(path.join(backupDir(libraryId), name)).size,
        createdAt: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}` };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

function saveBackup(libraryId, deviceId, buffer) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${deviceId}-${stamp}-${crypto.randomBytes(2).toString('hex')}.sqlite`;
  fs.writeFileSync(path.join(backupDir(libraryId), name), buffer);
  listBackups(libraryId, deviceId).slice(KEEP_BACKUPS).forEach((b) => fs.rmSync(path.join(backupDir(libraryId), b.name), { force: true }));
  return name;
}

function backupFile(libraryId, deviceId, name) {
  const m = BACKUP_RE.exec(String(name));
  if (!m || Number(m[1]) !== deviceId) throw httpError(404, 'Sauvegarde introuvable.');
  const file = path.join(backupDir(libraryId), m[0]);
  if (!fs.existsSync(file)) throw httpError(404, 'Sauvegarde introuvable.');
  return file;
}

function removeBackups(libraryId, deviceId) {
  listBackups(libraryId, deviceId).forEach((b) => fs.rmSync(path.join(backupDir(libraryId), b.name), { force: true }));
}

// Scan avec ecriture : la base envoyee est sauvegardee (si elle va changer), une copie
// modifiee est preparee. Renvoie null si rien ne change.
function prepareWrite(buffer, libraryId, deviceId, targets) {
  if (!isSqlite(buffer)) throw httpError(400, "Ce fichier n'est pas une base de liseuse Kobo.");
  const file = path.join(os.tmpdir(), `kobo-write-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  fs.writeFileSync(file, buffer);
  let result;
  try {
    result = applyToFile(file, targets);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  ['-wal', '-shm', '-journal'].forEach((x) => fs.rmSync(file + x, { force: true }));
  if (!result.changed.length) {
    fs.rmSync(file, { force: true });
    return result.covers.length ? { token: null, changed: [], covers: result.covers } : null;
  }
  const backup = saveBackup(libraryId, deviceId, buffer);
  return { token: keepModified(file, libraryId, deviceId), changed: result.changed, covers: result.covers, backup };
}

module.exports = {
  prepareWrite, modifiedFile, dropModified, listBackups, backupFile, removeBackups, isSqlite, koboValues, imageDir, qhash, summaryHtml,
};
