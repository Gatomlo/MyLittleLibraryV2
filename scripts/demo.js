// Instance de demonstration jetable : l'application sur des donnees temporaires (jamais
// data/), avec des comptes et quelques livres d'exemple. Pour essayer une modification
// ou verifier l'interface sans toucher aux vraies bibliotheques.
//   node scripts/demo.js          -> http://localhost:3100/demo/
//   PORT=3200 node scripts/demo.js
// Comptes (mot de passe commun ci-dessous) : admin, gestionnaire, bibliothecaire, lecteur.
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const PASSWORD = 'demo-demo-demo';
const PORT = Number(process.env.PORT) || 3100;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mll-demo-'));
process.env.MLL_DATA_DIR = dir;

const app = require('../server');

const BOOKS = [
  { title: 'Les Misérables', authors: 'Victor Hugo', isbn: '9782070408504', series: 'Classiques', seriesNumber: '1', year: 1862, categories: ['Roman'], copies: 2, location: 'Armoire A', summary: 'Le destin de Jean Valjean.' },
  { title: 'Notre-Dame de Paris', authors: 'Victor Hugo', series: 'Classiques', seriesNumber: '2', year: 1831, categories: ['Roman'], copies: 1, location: 'Armoire A' },
  { title: 'Vingt mille lieues sous les mers', authors: 'Jules Verne', year: 1870, categories: ['Aventure'], copies: 1, location: 'Armoire B' },
  { title: 'Le Petit Prince', authors: 'Antoine de Saint-Exupéry', isbn: '9782070612758', year: 1943, categories: ['Jeunesse'], copies: 3, location: 'Armoire B' },
  { title: 'L\'Étranger', authors: 'Albert Camus', year: 1942, categories: ['Roman'], copies: 1 },
  { title: 'Guide interne', authors: 'Collectif', categories: ['Documentation'], copies: 0 },
];

async function epub(title, author) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
    + '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>
    <dc:identifier id="id">demo</dc:identifier><dc:language>fr</dc:language></metadata>
    <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>
    <spine toc="ncx"><itemref idref="c1"/></spine></package>`);
  zip.file('OEBPS/toc.ncx', '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>Demo</text></docTitle>'
    + '<navMap><navPoint id="n1" playOrder="1"><navLabel><text>Chapitre 1</text></navLabel><content src="c1.xhtml"/></navPoint></navMap></ncx>');
  zip.file('OEBPS/c1.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapitre 1</title>'
    + '<style>p { text-indent: 1em; }</style></head><body><h1>Chapitre 1</h1><p>Il était une fois un livre de démonstration.</p></body></html>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function seed(base) {
  let cookie = '';
  const call = async (method, url, body, raw) => {
    const headers = { ...(raw ? raw.headers : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) };
    const res = await fetch(base + url, { method, headers, body: raw ? raw.body : JSON.stringify(body || {}) });
    for (const c of res.headers.getSetCookie()) if (c.startsWith('mll_session=') && !c.startsWith('mll_session=;')) cookie = c.split(';')[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url} : ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  const { library } = await call('POST', '/api/auth/setup', { username: 'admin', password: PASSWORD, libraryName: 'Demo' });
  const api = `/${library.slug}/api`;
  for (const [username, role] of [['gestionnaire', 'manager'], ['bibliothecaire', 'librarian'], ['lecteur', 'user']]) {
    await call('POST', '/api/admin/users', { username, password: PASSWORD, role: 'user', libraries: [{ id: library.id, role }] });
  }
  await call('PUT', `${api}/settings`, {
    features: { ebooks: true, kobo: true, readingStatus: true, tags: true, stats: true }, loanDays: 21,
    ebookAccess: { visible: 'public', read: 'members', download: 'members' },
  });
  const created = [];
  for (const b of BOOKS) created.push(await call('POST', `${api}/books`, b));
  await call('POST', `${api}/loans`, { code: created[0].copies[0].code, borrowerName: 'Camille Dupont' });
  await call('POST', `${api}/books/${created[0].id}/reservations`, { borrowerName: 'Sacha Martin' });
  await call('PUT', `${api}/books/${created[3].id}/status`, { reading: 'read', opinion: 'liked', rating: 5 });
  await call('POST', `${api}/import/epub`, null, {
    headers: { 'Content-Type': 'application/epub+zip', 'X-File-Name': encodeURIComponent('demonstration.epub') },
    body: await epub('Livre numérique de démonstration', 'Ada Lovelace'),
  });
  await call('POST', '/api/wishes', { title: 'Un livre souhaité', authors: 'Quelqu\'un', priority: true, library: library.id });
  return library.slug;
}

const server = app.listen(PORT, async () => {
  const base = `http://localhost:${PORT}`;
  try {
    const slug = await seed(base);
    console.log(`Demonstration : ${base}/${slug}/  (comptes admin, gestionnaire, bibliothecaire, lecteur ; mot de passe dans scripts/demo.js)`);
    console.log(`Donnees temporaires : ${dir}`);
  } catch (err) {
    console.error('Preparation de la demonstration impossible :', err.message);
    process.exit(1);
  }
});

const stop = () => { server.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* fichiers verrouilles */ } process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
