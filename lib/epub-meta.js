// Metadonnees d'un fichier epub (import de fichiers epub) : titre, auteurs, editeur,
// annee, resume, ISBN, serie et tome (forme Calibre ou EPUB 3), couverture.
const path = require('path');
const JSZip = require('jszip');
const { normalizeIsbn } = require('./isbn');

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };
const untag = (v) => v.replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '');
const decode = (v) => v
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] || m);
// Deux passes : les resumes contiennent souvent du HTML encode (&lt;p&gt;).
function text(v) {
  return decode(untag(decode(untag(String(v || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')))))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? text(m[1]) : ''; };

// ---------- ISBN cite dans le texte (page de copyright) ----------
// Beaucoup d'epub n'ont pas d'ISBN dans leurs metadonnees mais le citent au debut
// ou a la fin du livre, souvent deux fois (papier et numerique). On lit les premiers
// et derniers fichiers du livre, sans aucune requete en ligne. Preference a l'ISBN
// papier (mieux connu des catalogues), puis a un ISBN sans mention, puis au numerique.
const EBOOK_HINT = /num[ée]rique|epub|e-?book|pdf|[ée]lectronique|digital|kindle|mobi/i;
const PRINT_HINT = /papier|broch[ée]|imprim|poche|reli[ée]|print|paperback|hardcover/i;
const SEP = '[\\s\\u2010-\\u2015-]?';
const ISBN_RE = new RegExp(`(ISBN(?:[\\s-]*1[03])?)([^0-9]{0,40}?)((?:97[89]${SEP})?\\d(?:${SEP}\\d){8}${SEP}[\\dXx])(?![\\dXx])`, 'gi');
const BARE_RE = new RegExp(`(?<!\\d)(97[89](?:${SEP}\\d){10})(?!\\d)`, 'g');

function isbnFromText(docs) {
  const found = [];
  const add = (raw, context) => {
    const isbn = normalizeIsbn(raw);
    if (!isbn || found.some((f) => f.isbn === isbn)) return;
    found.push({ isbn, rank: PRINT_HINT.test(context) ? 0 : EBOOK_HINT.test(context) ? 2 : 1 });
  };
  const plains = docs.map((doc) => text(doc).replace(/\s+/g, ' '));
  for (const plain of plains) {
    for (const m of plain.matchAll(ISBN_RE)) {
      // Mention avant le numero ("Version numerique : ISBN ...") ou juste apres ("ISBN ... (epub)").
      const end = m.index + m[0].length;
      const after = plain.slice(end, end + 20).split(/ISBN/i)[0];
      // Avant : seulement depuis le numero precedent, sans sa mention entre parentheses.
      const before = plain.slice(Math.max(0, m.index - 30), m.index).replace(/^.*\d/, '').replace(/^\s*\([^)]*\)/, '');
      add(m[3], before + m[2] + after);
    }
  }
  // Pas de mention "ISBN" : numero EAN 978/979 seul (plus rare, meme regles).
  if (!found.length) {
    for (const plain of plains) {
      for (const m of plain.matchAll(BARE_RE)) add(m[1], plain.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20));
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  return found.length ? found[0].isbn : null;
}

// Debut et fin du texte, dans l'ordre de lecture (spine), sinon ordre de l'archive.
async function textDocs(zip, opf, opfPath) {
  const items = [...opf.matchAll(/<(?:opf:)?item\b[^>]*>/g)].map((m) => m[0]);
  const byId = new Map(items.map((t) => [attr(t, 'id'), t]));
  let hrefs = [...opf.matchAll(/<(?:opf:)?itemref\b[^>]*>/g)].map((m) => byId.get(attr(m[0], 'idref')))
    .filter(Boolean).map((t) => path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(attr(t, 'href'))));
  if (!hrefs.length) hrefs = Object.keys(zip.files).filter((n) => /\.x?html?$/i.test(n)).sort();
  const pick = hrefs.length > 8 ? [...hrefs.slice(0, 5), ...hrefs.slice(-3)] : hrefs;
  const docs = [];
  for (const h of pick) {
    const file = zip.file(h);
    if (file) docs.push((await file.async('string')).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' '));
  }
  return docs;
}

async function openEpub(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const container = zip.file('META-INF/container.xml');
  const opfPath = container && (/full-path="([^"]+)"/.exec(await container.async('string')) || [])[1];
  const opfFile = opfPath && zip.file(opfPath);
  return opfFile ? { zip, opfPath, opf: await opfFile.async('string') } : null;
}

const metadataOf = (opf) => (/<(?:opf:)?metadata\b[^>]*>([\s\S]*?)<\/(?:opf:)?metadata>/.exec(opf) || [])[1] || '';
const isbnFromIds = (ids) => ids.map((v) => normalizeIsbn(v.replace(/^urn:isbn:/i, ''))).find(Boolean) || null;

// ISBN d'un fichier epub deja enregistre : metadonnees, sinon texte du livre.
async function readEpubIsbn(buffer) {
  const epub = await openEpub(buffer);
  if (!epub) return null;
  const ids = [...metadataOf(epub.opf).matchAll(/<dc:identifier\b[^>]*>([\s\S]*?)<\/dc:identifier>/g)].map((m) => text(m[1]));
  return isbnFromIds(ids) || isbnFromText(await textDocs(epub.zip, epub.opf, epub.opfPath));
}

async function readEpubMeta(buffer) {
  const epub = await openEpub(buffer);
  if (!epub) return {};
  const { zip, opf, opfPath } = epub;
  const meta = metadataOf(opf);
  const all = (tag) => [...meta.matchAll(new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)</dc:${tag}>`, 'g'))].map((m) => text(m[1])).filter(Boolean);
  const metas = [...meta.matchAll(/<meta\b[^>]*?(?:\/>|>([\s\S]*?)<\/meta>)/g)].map((m) => ({ tag: m[0], value: text(m[1]) }));
  const named = (n) => { const x = metas.find((m) => attr(m.tag, 'name') === n); return x ? attr(x.tag, 'content') : ''; };

  const isbn = isbnFromIds(all('identifier')) || isbnFromText(await textDocs(zip, opf, opfPath).catch(() => []));
  const year = (/\b(1[5-9]\d\d|20\d\d)\b/.exec(all('date')[0] || '') || [])[1];
  let series = named('calibre:series');
  let seriesNumber = named('calibre:series_index');
  if (!series) {
    const coll = metas.find((m) => attr(m.tag, 'property') === 'belongs-to-collection');
    if (coll) {
      const id = attr(coll.tag, 'id');
      const refine = (p) => { const x = metas.find((m) => attr(m.tag, 'refines') === `#${id}` && attr(m.tag, 'property') === p); return x ? x.value : ''; };
      if (!id || !refine('collection-type') || refine('collection-type') === 'series') {
        series = coll.value;
        seriesNumber = id ? refine('group-position') : '';
      }
    }
  }
  // "3.0" -> "3" ; "2.5" garde tel quel.
  seriesNumber = String(seriesNumber || '').replace(/\.0+$/, '');

  // Couverture : EPUB 3 (properties="cover-image") ou EPUB 2 (<meta name="cover">).
  const items = [...opf.matchAll(/<(?:opf:)?item\b[^>]*>/g)].map((m) => m[0]);
  const coverId = named('cover');
  const coverItem = items.find((t) => /\bproperties="[^"]*cover-image/.test(t))
    || (coverId && items.find((t) => attr(t, 'id') === coverId))
    || items.find((t) => /image\//.test(attr(t, 'media-type')) && /cover/i.test(attr(t, 'id') + attr(t, 'href')));
  let cover = null;
  if (coverItem) {
    const href = decodeURIComponent(attr(coverItem, 'href'));
    const file = zip.file(path.posix.join(path.posix.dirname(opfPath), href));
    const mime = attr(coverItem, 'media-type');
    if (file && /^image\/(jpeg|png|webp|gif)$/.test(mime)) cover = { buffer: await file.async('nodebuffer'), mime };
  }

  return {
    title: all('title')[0] || '',
    authors: all('creator').join(', '),
    publisher: all('publisher')[0] || '',
    year: year ? Number(year) : null,
    summary: all('description')[0] || '',
    isbn,
    series: series || '',
    seriesNumber,
    cover,
  };
}

module.exports = { readEpubMeta, readEpubIsbn, isbnFromText };
