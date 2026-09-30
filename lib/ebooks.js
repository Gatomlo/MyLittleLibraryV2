// Fichiers epub joints aux exemplaires numeriques. Stockes dans le dossier de leur
// bibliotheque (data/libraries/<id>/ebooks, jamais
// servis en statique) : l'acces passe par l'API, selon trois droits reglés pour toute
// la bibliotheque : voir la presence du fichier (libraries.ebook_visible), le lire en
// ligne (ebook_read), le telecharger (ebook_download). Lire ou telecharger rend visible.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, libraryDb, libraryDir } = require('./db');
const auth = require('./auth');
const { httpError } = require('./util');


const MAX_BYTES = 100 * 1024 * 1024;
// public : tout le monde, meme sans connexion ; members : comptes de la bibliotheque
// (lecteurs compris) ; managers : bibliothecaires, gestionnaires et administrateurs ;
// admin : administrateurs du site.
const LEVELS = ['public', 'members', 'managers', 'admin'];

function level(v, fallback = 'admin') {
  return LEVELS.includes(v) ? v : fallback;
}

function allowed(lvl, user, libId) {
  if (lvl === 'public') return true;
  if (lvl === 'members') return auth.isMember(user, libId);
  if (lvl === 'managers') return auth.canManage(user, libId);
  return !!user && user.role === 'admin';
}

function filePath(libraryId, key) {
  if (!/^[a-z0-9-]+\.epub$/.test(String(key || ''))) throw httpError(404, 'Fichier introuvable.');
  return path.join(libraryDir(libraryId, 'ebooks'), key);
}

// Un epub est une archive zip avec META-INF/container.xml. Pas d'exigence sur
// "mimetype" (premier fichier, non compresse) : beaucoup d'epub du commerce ou
// convertis ne la respectent pas et les liseuses les ouvrent quand meme.
function save(libraryId, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, 'Fichier vide.');
  if (buffer.length > MAX_BYTES) throw httpError(400, 'Fichier trop lourd (100 Mo max).');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50 || !buffer.includes('META-INF/container.xml')) {
    throw httpError(400, "Ce fichier n'est pas un epub valide.");
  }
  const key = `epub-${crypto.randomBytes(8).toString('hex')}.epub`;
  fs.writeFileSync(path.join(libraryDir(libraryId, 'ebooks'), key), buffer);
  return key;
}

function remove(libraryId, key) {
  if (!key) return;
  try { fs.rm(filePath(libraryId, key), { force: true }, () => {}); } catch (e) { /* nom invalide */ }
}

// Supprime les fichiers qui ne sont plus rattaches a aucun exemplaire (apres
// suppression d'exemplaires ou de livres).
function purgeOrphans(libraryId) {
  const used = new Set(libraryDb(libraryId).prepare('SELECT file_key FROM copies WHERE file_key IS NOT NULL').all().map((r) => r.file_key));
  for (const name of fs.readdirSync(libraryDir(libraryId, 'ebooks'))) {
    if (name.endsWith('.epub') && !used.has(name)) remove(libraryId, name);
  }
}

// Fichier du livre tel que le voit ce visiteur : null s'il n'y a pas de fichier ou
// si le visiteur n'a aucun droit dessus.
function rights(lib, user) {
  const read = allowed(lib.ebook_read, user, lib.id);
  const download = allowed(lib.ebook_download, user, lib.id);
  return { visible: read || download || allowed(lib.ebook_visible, user, lib.id), read, download };
}

function accessFor(lib, bookId, user) {
  if (!lib.enable_ebooks) return null;
  const c = db.prepare("SELECT file_name, file_size FROM copies WHERE book_id = ? AND format = 'ebook' AND file_key IS NOT NULL").get(bookId);
  if (!c) return null;
  const { visible, read, download } = rights(lib, user);
  if (!visible) return null;
  return { name: c.file_name, size: c.file_size, read, download };
}

module.exports = { LEVELS, level, allowed, rights, filePath, save, remove, purgeOrphans, accessFor, MAX_BYTES };
