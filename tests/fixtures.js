// Fichiers fabriques pour les tests : base de liseuse Kobo, epub, image.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { DatabaseSync } = require('node:sqlite');

// Base KoboReader.sqlite minimale. books : [{ id, title, author, isbn, status, percent }].
// withWal : base en mode journal (WAL) dont tout le contenu est encore dans le journal,
// renvoyee comme { main, wal } (fichier principal illisible seul).
function koboDb(books, { withWal = false } = {}) {
  const file = path.join(os.tmpdir(), `mll-test-kobo-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  const db = new DatabaseSync(file);
  if (withWal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  db.exec(`CREATE TABLE content (ContentID TEXT, ContentType INTEGER, Title TEXT, Attribution TEXT, ISBN TEXT, Publisher TEXT,
    Series TEXT, SeriesNumber TEXT, ReadStatus INTEGER, ___PercentRead INTEGER, DateLastRead TEXT, ___FileSize INTEGER,
    Description TEXT, SeriesID TEXT, SeriesNumberFloat REAL, ImageId TEXT);
    CREATE TABLE user (UserDisplayName TEXT);`);
  const ins = db.prepare(`INSERT INTO content (ContentID, ContentType, Title, Attribution, ISBN, ReadStatus, ___PercentRead, DateLastRead, ___FileSize, ImageId)
    VALUES (?, 6, ?, ?, ?, ?, ?, ?, 1000, ?)`);
  for (const b of books) {
    ins.run(b.id, b.title, b.author || null, b.isbn || null, b.status || 0, b.percent || 0, '2026-01-02T10:00:00Z', b.id.replace(/[^a-zA-Z0-9]/g, '_'));
  }
  if (withWal) {
    const out = { main: fs.readFileSync(file), wal: fs.readFileSync(`${file}-wal`) };
    db.close();
    ['', '-wal', '-shm'].forEach((x) => fs.rmSync(file + x, { force: true }));
    return out;
  }
  db.close();
  const buffer = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return buffer;
}

// Epub minimal valide. extra : fichiers ajoutes { nom: contenu }.
async function epub({ title = 'Epub de test', author = 'Anne Onyme', isbn = '', extra = {}, opf = null } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', opf || `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>
    ${isbn ? `<dc:identifier id="id">urn:isbn:${isbn}</dc:identifier>` : '<dc:identifier id="id">test</dc:identifier>'}<dc:language>fr</dc:language></metadata>
    <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file('OEBPS/c1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>1</title></head><body><p>Bonjour.</p></body></html>');
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// PNG 1x1 valide, complete pour depasser la taille minimale d'une couverture.
function png(size = 3000) {
  const base = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  return Buffer.concat([base, Buffer.alloc(Math.max(0, size - base.length))]);
}

module.exports = { koboDb, epub, png };
