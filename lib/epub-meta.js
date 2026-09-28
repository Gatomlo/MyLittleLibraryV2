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

async function readEpubMeta(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const container = zip.file('META-INF/container.xml');
  const opfPath = container && (/full-path="([^"]+)"/.exec(await container.async('string')) || [])[1];
  const opfFile = opfPath && zip.file(opfPath);
  if (!opfFile) return {};
  const opf = await opfFile.async('string');
  const meta = (/<(?:opf:)?metadata\b[^>]*>([\s\S]*?)<\/(?:opf:)?metadata>/.exec(opf) || [])[1] || '';
  const all = (tag) => [...meta.matchAll(new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)</dc:${tag}>`, 'g'))].map((m) => text(m[1])).filter(Boolean);
  const metas = [...meta.matchAll(/<meta\b[^>]*?(?:\/>|>([\s\S]*?)<\/meta>)/g)].map((m) => ({ tag: m[0], value: text(m[1]) }));
  const named = (n) => { const x = metas.find((m) => attr(m.tag, 'name') === n); return x ? attr(x.tag, 'content') : ''; };

  const isbn = all('identifier').map((v) => normalizeIsbn(v.replace(/^urn:isbn:/i, ''))).find(Boolean) || null;
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

module.exports = { readEpubMeta };
