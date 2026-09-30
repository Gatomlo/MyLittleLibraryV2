// Lecture prudente des archives zip (epub, archives de bibliotheque) : un fichier
// tres compresse (« bombe zip ») ne doit pas remplir la memoire ou le disque.
const fs = require('fs');
const yauzl = require('yauzl');
const { httpError } = require('./util');

const tooBig = () => httpError(400, 'Archive invalide : contenu trop volumineux.');

// ---------- JSZip (epub, deja en memoire) ----------
// Taille annoncee d'une entree, et de toute l'archive.
const declaredSize = (file) => (file && file._data && file._data.uncompressedSize) || 0;
const totalSize = (zip) => Object.values(zip.files).reduce((n, f) => n + declaredSize(f), 0);

// Contenu d'une entree JSZip, abandonne des que maxBytes est depasse (la taille
// annoncee peut mentir : le flux decompresse est compte).
function readEntry(file, maxBytes) {
  return new Promise((resolve, reject) => {
    if (declaredSize(file) > maxBytes) return reject(tooBig());
    const chunks = [];
    let size = 0;
    const stream = file.nodeStream('nodebuffer');
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { stream.destroy(); reject(tooBig()); } else chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
const readText = async (file, maxBytes) => (await readEntry(file, maxBytes)).toString('utf8');

// ---------- yauzl (archives sur disque, lues entree par entree) ----------
// Parcourt les entrees d'un fichier zip sans le charger en memoire :
// handler(entry, open) ou open() donne le flux du contenu. yauzl refuse les noms
// dangereux (.., chemins absolus) et verifie la taille reelle de chaque entree.
function eachEntry(file, handler) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(httpError(400, "Ce fichier n'est pas une archive zip valide."));
      let done = false;
      const finish = (e) => {
        if (done) return;
        done = true;
        try { zip.close(); } catch (e2) { /* deja fermee */ }
        if (e) reject(e.status ? e : httpError(400, "Ce fichier n'est pas une archive zip valide.")); else resolve();
      };
      zip.on('error', finish);
      zip.on('end', () => finish());
      zip.on('entry', (entry) => {
        const open = () => new Promise((res, rej) => zip.openReadStream(entry, (e, stream) => (e ? rej(e) : res(stream))));
        Promise.resolve().then(() => handler(entry, open)).then(() => { if (!done) zip.readEntry(); }, finish);
      });
      zip.readEntry();
    });
  });
}

// Flux d'une entree -> memoire (petits fichiers) ou fichier, avec plafond.
function streamToBuffer(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { stream.destroy(); reject(tooBig()); } else chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function streamToFile(stream, file) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    stream.on('error', (e) => { out.destroy(); reject(e); });
    out.on('error', reject);
    out.on('finish', resolve);
    stream.pipe(out);
  });
}

module.exports = { declaredSize, totalSize, readEntry, readText, eachEntry, streamToBuffer, streamToFile, tooBig };
