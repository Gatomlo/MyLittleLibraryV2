// Images (couvertures, logo) stockees dans le dossier de leur bibliotheque
// (data/libraries/<id>/media) et servies sur /<bibliotheque>/media/<fichier>.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { libraryDir } = require('./db');

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function save(libraryId, buffer, mime, prefix) {
  const ext = TYPES[mime];
  if (!ext) throw httpError(400, "Format d'image non supporté (JPEG, PNG, WebP ou GIF).");
  if (buffer.length > MAX_BYTES) throw httpError(400, 'Image trop lourde (5 Mo max).');
  const name = `${prefix}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(libraryDir(libraryId, 'media'), name), buffer);
  return name;
}

// Image envoyee par le navigateur sous forme de data URL (deja redimensionnee cote client).
function saveDataUrl(libraryId, dataUrl, prefix) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw httpError(400, 'Image invalide.');
  return save(libraryId, Buffer.from(m[2], 'base64'), m[1], prefix);
}

// Couverture proposee par la recherche ISBN : telechargee et gardee en local pour ne
// pas dependre du service externe.
async function saveFromUrl(libraryId, url, prefix) {
  if (!/^https?:\/\//i.test(url)) throw httpError(400, "URL d'image invalide.");
  // Une nouvelle tentative : les services de couvertures sont parfois lents.
  const get = () => fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
  const res = await get().catch(() => get());
  if (!res.ok) throw new Error(`Téléchargement de la couverture impossible (HTTP ${res.status}).`);
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  const buffer = Buffer.from(await res.arrayBuffer());
  // Google Books renvoie parfois une minuscule image "pas de couverture" plutot qu'une 404.
  if (buffer.length < 2000) return '';
  return save(libraryId, buffer, mime, prefix);
}

function remove(libraryId, name) {
  if (!name || name.includes('/') || name.includes('\\')) return;
  fs.rm(path.join(libraryDir(libraryId, 'media'), name), { force: true }, () => {});
}

module.exports = { save, saveDataUrl, saveFromUrl, remove, httpError };
