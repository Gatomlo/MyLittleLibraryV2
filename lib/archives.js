// Archives par bibliotheque (Administration › Sauvegarde) : un zip
// mylittlelibrary-<nom>.zip par bibliotheque, avec au choix sa base (library.db),
// ses epub (ebooks/) et ses couvertures et logo (media/), plus manifest.json
// (reglages de la bibliotheque, comptes cites par leur identifiant).
// Restauration : recree la bibliotheque, ou remplace les elements presents dans
// l'archive d'une bibliotheque du meme nom (apres confirmation).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { DatabaseSync } = require('node:sqlite');
const {
  db, tx, inLibrary, libraryDb, libraryDir, closeLibraryDb, sqlString, slugify, isValidSlug, uniqueSlug, setSetting,
} = require('./db');
const { httpError } = require('./media');

const FORMAT = 'mylittlelibrary-archive';
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 Go
const PENDING_TTL_MS = 60 * 60 * 1000;
const PARTS = ['db', 'ebooks', 'covers'];
// Colonnes de libraries jamais reprises d'une archive.
const FIXED_COLUMNS = new Set(['id', 'slug', 'name', 'created_at', 'logo']);

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

// Nom de fichier : mylittlelibrary-<nom de la bibliotheque> (sans caracteres interdits).
function archiveName(lib) {
  const name = String(lib.name).normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim() || lib.slug;
  return `mylittlelibrary-${name}.zip`;
}

function libraryColumns() {
  return db.prepare('PRAGMA table_info(libraries)').all().map((c) => c.name);
}

// ---------- Export ----------
// Construit l'archive (fichiers lus en flux) ; renvoie { fileName, stream, cleanup }.
function exportLibrary(libraryId, parts) {
  const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(libraryId);
  if (!lib) throw httpError(404, 'Bibliothèque introuvable.');
  const contents = Object.fromEntries(PARTS.map((p) => [p, !!parts[p]]));
  if (!PARTS.some((p) => contents[p])) throw httpError(400, 'Choisis au moins un élément à sauvegarder.');

  const zip = new JSZip();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mll-archive-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    // Comptes cites (statuts, lecteurs, liseuses, membres) : par identifiant, pour
    // les retrouver sur un autre serveur.
    const members = db.prepare(`SELECT u.username FROM user_libraries ul JOIN users u ON u.id = ul.user_id
      WHERE ul.library_id = ?`).all(libraryId).map((r) => r.username);
    const prefs = db.prepare(`SELECT u.username, p.share_stats, p.yearly_goal, p.stale_days, p.home_cards FROM user_library_prefs p
      JOIN users u ON u.id = p.user_id WHERE p.library_id = ?`).all(libraryId);
    const users = {};
    if (contents.db) {
      const conn = libraryDb(libraryId);
      const file = path.join(tmp, 'library.db');
      conn.exec(`VACUUM main INTO ${sqlString(file)}`);
      zip.file('library.db', fs.createReadStream(file), { compression: 'DEFLATE' });
      const ids = new Set();
      for (const t of userTables(conn)) conn.prepare(`SELECT DISTINCT user_id FROM main.${t.name} WHERE user_id IS NOT NULL`).all().forEach((r) => ids.add(r.user_id));
      for (const id of ids) {
        const u = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
        if (u) users[id] = u.username;
      }
    }
    const addDir = (sub, prefix) => {
      const dir = libraryDir(libraryId, sub);
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isFile()) zip.file(`${prefix}/${name}`, fs.createReadStream(full), { compression: 'STORE' });
      }
    };
    if (contents.covers) addDir('media', 'media');
    if (contents.ebooks) addDir('ebooks', 'ebooks');
    const library = { ...lib };
    delete library.id;
    zip.file('manifest.json', JSON.stringify({
      format: FORMAT, version: 1, createdAt: new Date().toISOString(), contents, library, members, prefs, users,
    }, null, 2));
    const stream = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true });
    // Une sauvegarde faite ce mois-ci : pas de rappel.
    setSetting('backupDoneMonth', monthKey());
    return { fileName: archiveName(lib), stream, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// Tables de la base d'une bibliotheque qui ont une colonne donnee.
function tablesWith(conn, column) {
  return conn.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map((t) => ({ name: t.name, col: conn.prepare(`PRAGMA main.table_info(${t.name})`).all().find((c) => c.name === column) }))
    .filter((t) => t.col);
}
const userTables = (conn) => tablesWith(conn, 'user_id');

// ---------- Import ----------
// Archive envoyee : gardee dans un dossier temporaire le temps de la confirmation.
const pending = new Map();

function purgePending() {
  for (const [token, p] of pending) {
    if (p.expires < Date.now()) { fs.rmSync(p.file, { force: true }); pending.delete(token); }
  }
}

// Enregistre le corps de la requete (zip brut) dans un fichier temporaire.
function receiveUpload(req) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `mll-restore-${crypto.randomBytes(8).toString('hex')}.zip`);
    const out = fs.createWriteStream(file);
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(file, { force: true }, () => {});
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) { req.pause(); fail(httpError(413, 'Archive trop lourde (1 Go max).')); }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (!failed) resolve(file); });
    req.pipe(out);
  });
}

async function readArchive(file) {
  let zip;
  try { zip = await JSZip.loadAsync(fs.readFileSync(file)); } catch (e) { throw httpError(400, "Ce fichier n'est pas une archive zip valide."); }
  const entry = zip.file('manifest.json');
  let manifest = null;
  try { manifest = entry && JSON.parse(await entry.async('string')); } catch (e) { /* invalide */ }
  if (!manifest || manifest.format !== FORMAT || !manifest.library || !manifest.library.name) {
    throw httpError(400, "Ce fichier n'est pas une archive de bibliothèque MyLittleLibrary.");
  }
  manifest.contents = Object.fromEntries(PARTS.map((p) => [p, !!(manifest.contents && manifest.contents[p])]));
  if (manifest.contents.db && !zip.file('library.db')) throw httpError(400, 'Archive incomplète : base absente.');
  return { zip, manifest };
}

const findByName = (name) => db.prepare('SELECT * FROM libraries WHERE name = ? COLLATE NOCASE').get(String(name).trim());

// Etape 1 : reception et lecture de l'archive, sans rien modifier.
async function stageArchive(req) {
  purgePending();
  const file = await receiveUpload(req);
  try {
    const { manifest } = await readArchive(file);
    const token = crypto.randomBytes(16).toString('hex');
    pending.set(token, { file, expires: Date.now() + PENDING_TTL_MS, userId: req.user.id });
    const existing = findByName(manifest.library.name);
    return {
      token,
      name: manifest.library.name,
      createdAt: manifest.createdAt || null,
      contents: manifest.contents,
      existing: existing ? { id: existing.id, slug: existing.slug, name: existing.name } : null,
    };
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
}

function cancelArchive(token) {
  const p = pending.get(token);
  if (p) { fs.rmSync(p.file, { force: true }); pending.delete(token); }
}

// Fichier d'un dossier de l'archive : nom simple uniquement (pas de chemin).
function safeEntries(zip, prefix) {
  return Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith(prefix + '/'))
    .map((f) => ({ f, name: f.name.slice(prefix.length + 1) }))
    .filter(({ name }) => /^[\w][\w.-]*$/.test(name) && !name.includes('..'));
}

async function extractDir(zip, prefix, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const { f, name } of safeEntries(zip, prefix)) {
    fs.writeFileSync(path.join(dir, name), await f.async('nodebuffer'));
    n++;
  }
  return n;
}

// Etape 2 : creation ou remplacement.
async function applyArchive(token, { overwrite, user }) {
  purgePending();
  const p = pending.get(token);
  if (!p || p.userId !== user.id) throw httpError(404, 'Archive expirée : envoie-la à nouveau.');
  const { zip, manifest } = await readArchive(p.file);
  const { contents } = manifest;
  const src = manifest.library;
  const existing = findByName(src.name);
  if (existing && !overwrite) throw httpError(409, `La bibliothèque « ${existing.name} » existe déjà.`);

  // Base de l'archive : verifiee avant toute modification.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mll-restore-'));
  try {
    let dbFile = null;
    if (contents.db) {
      dbFile = path.join(tmp, 'library.db');
      const buf = await zip.file('library.db').async('nodebuffer');
      if (buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw httpError(400, 'Base de l’archive invalide.');
      fs.writeFileSync(dbFile, buf);
      const check = new DatabaseSync(dbFile);
      try {
        if (!check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'books'").get()) throw httpError(400, 'Base de l’archive invalide.');
        const ok = check.prepare('PRAGMA integrity_check').get();
        if (!ok || Object.values(ok)[0] !== 'ok') throw httpError(400, 'Base de l’archive endommagée.');
      } finally { check.close(); }
    }

    // Reglages repris : colonnes connues de ce serveur.
    const cols = libraryColumns().filter((c) => !FIXED_COLUMNS.has(c) && Object.prototype.hasOwnProperty.call(src, c));
    let id;
    if (existing) {
      id = existing.id;
      // Copie de securite de la base actuelle avant remplacement.
      if (contents.db) {
        const dir = libraryDir(id, 'backups');
        fs.mkdirSync(dir, { recursive: true });
        libraryDb(id).exec(`VACUUM main INTO ${sqlString(path.join(dir, `library-avant-import-${stamp()}.db`))}`);
      }
      tx(() => {
        if (contents.db && cols.length) {
          db.prepare(`UPDATE libraries SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => src[c]), id);
        }
        if (contents.covers) db.prepare('UPDATE libraries SET logo = ? WHERE id = ?').run(src.logo || null, id);
      });
    } else {
      let slug = String(src.slug || '').toLowerCase();
      const taken = !isValidSlug(slug) || db.prepare('SELECT 1 FROM libraries WHERE slug = ?').get(slug)
        || db.prepare('SELECT 1 FROM library_slug_history WHERE slug = ?').get(slug);
      if (taken) slug = uniqueSlug(src.name || slugify(src.name));
      id = tx(() => {
        const all = ['slug', 'name', ...(contents.covers ? ['logo'] : []), ...cols];
        const values = { ...src, slug, name: String(src.name).slice(0, 120) };
        const newId = Number(db.prepare(`INSERT INTO libraries (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`)
          .run(...all.map((c) => (values[c] === undefined ? null : values[c]))).lastInsertRowid);
        db.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)').run(user.id, newId);
        return newId;
      });
    }

    // Comptes de l'archive retrouves par identifiant.
    const userId = (username) => {
      const u = username && db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      return u ? u.id : null;
    };
    tx(() => {
      for (const name of manifest.members || []) {
        const uid = userId(name);
        if (uid) db.prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id) VALUES (?, ?)').run(uid, id);
      }
      if (contents.db) {
        for (const pr of manifest.prefs || []) {
          const uid = userId(pr.username);
          if (uid) {
            db.prepare(`INSERT OR REPLACE INTO user_library_prefs (user_id, library_id, share_stats, yearly_goal, stale_days, home_cards)
              VALUES (?, ?, ?, ?, ?, ?)`).run(uid, id, pr.share_stats ? 1 : 0, pr.yearly_goal ?? null, pr.stale_days || 60, pr.home_cards ?? null);
          }
        }
      }
    });

    // Fichiers : seuls les elements presents dans l'archive sont remplaces.
    closeLibraryDb(id);
    fs.mkdirSync(libraryDir(id), { recursive: true });
    if (dbFile) {
      ['library.db', 'library.db-wal', 'library.db-shm'].forEach((n) => fs.rmSync(path.join(libraryDir(id), n), { force: true }));
      fs.copyFileSync(dbFile, path.join(libraryDir(id), 'library.db'));
    }
    const counts = {};
    if (contents.covers) counts.covers = await extractDir(zip, 'media', libraryDir(id, 'media'));
    if (contents.ebooks) counts.ebooks = await extractDir(zip, 'ebooks', libraryDir(id, 'ebooks'));
    libraryDb(id); // ouverture et mise a jour du schema

    if (dbFile) {
      inLibrary(id, () => tx(() => {
        const conn = libraryDb(id);
        // Identifiant de la bibliotheque sur ce serveur.
        for (const t of tablesWith(conn, 'library_id')) db.prepare(`UPDATE main.${t.name} SET library_id = ?`).run(id);
        // Comptes : ancien identifiant -> compte du meme nom ici, sinon retire.
        const map = new Map(Object.entries(manifest.users || {}).map(([old, name]) => [Number(old), userId(name)]).filter(([, v]) => v));
        for (const t of userTables(conn)) {
          for (const [oldId, newId] of map) db.prepare(`UPDATE main.${t.name} SET user_id = ? WHERE user_id = ?`).run(-newId, oldId);
          if (t.col.notnull) db.prepare(`DELETE FROM main.${t.name} WHERE user_id > 0`).run();
          else db.prepare(`UPDATE main.${t.name} SET user_id = NULL WHERE user_id > 0`).run();
          db.prepare(`UPDATE main.${t.name} SET user_id = -user_id WHERE user_id < 0`).run();
        }
      }));
    }
    const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
    const books = inLibrary(id, () => db.prepare('SELECT COUNT(*) AS n FROM books').get().n);
    return { library: lib, created: !existing, books, ...counts };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    cancelArchive(token);
  }
}

// ---------- Rappel mensuel ----------
// Du au premier jour de chaque mois tant qu'aucune sauvegarde n'a ete faite (ou que
// le rappel n'a pas ete passe) ce mois-ci. "Reporter" est gere par le navigateur.
function reminderDue() {
  const m = monthKey();
  const done = db.prepare("SELECT value FROM settings WHERE key = 'backupDoneMonth'").get();
  const skipped = db.prepare("SELECT value FROM settings WHERE key = 'backupSkippedMonth'").get();
  return !((done && done.value >= m) || (skipped && skipped.value >= m));
}

function skipReminder() {
  setSetting('backupSkippedMonth', monthKey());
}

module.exports = { exportLibrary, stageArchive, applyArchive, cancelArchive, reminderDue, skipReminder, archiveName, PARTS };
