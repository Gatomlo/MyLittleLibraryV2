// Recherche des informations d'un livre a partir de son ISBN, en combinant trois
// sources interrogees en parallele :
//  - Google Books : bons resumes. Sans cle, le quota anonyme partage est souvent
//    epuise -> definir GOOGLE_BOOKS_API_KEY (gratuite) pour un service fiable.
//  - BnF (catalogue general, SRU) : reference pour les livres francophones.
//  - Open Library : couvertures, nombre de pages, resume de l'oeuvre.
const GOOGLE_KEY = process.env.GOOGLE_BOOKS_API_KEY || '';
const UA = { 'User-Agent': 'MyLittleLibrary/2 (catalogue de bibliotheque)' };

function cleanIsbn(raw) {
  return String(raw || '').toUpperCase().replace(/[^0-9X]/g, '');
}

function isValidIsbn13(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  const sum = s.split('').reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return sum % 10 === 0;
}

function isValidIsbn10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  const sum = s.split('').reduce((acc, c, i) => acc + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
  return sum % 11 === 0;
}

function isbn10to13(s) {
  const base = '978' + s.slice(0, 9);
  const sum = base.split('').reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return base + ((10 - (sum % 10)) % 10);
}

// Renvoie l'ISBN-13 normalise, ou null si la saisie n'est pas un ISBN valide.
function normalizeIsbn(raw) {
  const s = cleanIsbn(raw);
  if (isValidIsbn13(s)) return s;
  if (isValidIsbn10(s)) return isbn10to13(s);
  return null;
}

async function get(url, type = 'json') {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return type === 'json' ? res.json() : res.text();
}

function yearOf(dateStr) {
  const m = String(dateStr || '').match(/\b(1[5-9]\d\d|20\d\d)\b/);
  return m ? Number(m[1]) : null;
}

// ---------- Google Books ----------
async function fromGoogle(isbn) {
  const data = await get(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${GOOGLE_KEY ? '&key=' + GOOGLE_KEY : ''}`);
  const v = data.items && data.items[0] && data.items[0].volumeInfo;
  if (!v) return null;
  const links = v.imageLinks || {};
  const img = links.extraLarge || links.large || links.medium || links.thumbnail || '';
  return {
    title: v.title || '',
    subtitle: v.subtitle || '',
    authors: (v.authors || []).join(', '),
    publisher: v.publisher || '',
    year: yearOf(v.publishedDate),
    pages: v.pageCount || null,
    summary: v.description || '',
    coverUrl: img.replace(/^http:/, 'https:').replace('&edge=curl', ''),
  };
}

// ---------- BnF (Dublin Core via SRU) ----------
function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');
}

function dcAll(xml, tag) {
  const re = new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)</dc:${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1].trim()));
  return out;
}

// "Saint-Exupéry, Antoine de (1900-1944). Auteur du texte" -> "Antoine de Saint-Exupéry"
function bnfPerson(s) {
  const name = s.replace(/\s*\(.*$/, '').replace(/\.\s*[A-Z][^.]*$/, '').trim();
  const [last, first] = name.split(/,\s*/);
  return first ? `${first} ${last}` : last;
}

// Les notices anterieures a 2007 sont souvent cataloguees sous l'ISBN-10.
function isbn13to10(s) {
  if (!s.startsWith('978')) return null;
  const core = s.slice(3, 12);
  const sum = core.split('').reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : check);
}

async function fromBnf(isbn) {
  const isbn10 = isbn13to10(isbn);
  const query = encodeURIComponent(`bib.isbn adj "${isbn}"${isbn10 ? ` or bib.isbn adj "${isbn10}"` : ''}`);
  const xml = await get(`https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${query}&recordSchema=dublincore&maximumRecords=1`, 'text');
  const record = xml.split('<oai_dc:dc')[1];
  if (!record) return null;
  // Titre BnF : "Titre : sous-titre / mention de responsabilite"
  const fullTitle = (dcAll(record, 'title')[0] || '').split(' / ')[0];
  const [title, ...rest] = fullTitle.split(' : ');
  // Ouvrages collectifs : pas d'auteur, seulement des directeurs de publication.
  const creators = dcAll(record, 'creator');
  const editors = dcAll(record, 'contributor').filter((c) => /Directeur de publication/i.test(c));
  const writers = creators.filter((c) => /Auteur/i.test(c));
  const names = creators.length
    ? (writers.length ? writers : creators).map(bnfPerson)
    : editors.map((e) => bnfPerson(e) + ' (dir.)');
  const format = dcAll(record, 'format').join(' ');
  const pages = format.match(/(\d+)\s*(?:p\.|pages)/);
  return {
    title: title.trim(),
    subtitle: rest.join(' : ').trim(),
    authors: names.join(', '),
    publisher: (dcAll(record, 'publisher')[0] || '').replace(/\s*\(.*\)\s*$/, ''),
    year: yearOf(dcAll(record, 'date')[0]),
    pages: pages ? Number(pages[1]) : null,
    summary: '',
    coverUrl: '',
  };
}

// ---------- Open Library ----------
async function fromOpenLibrary(isbn) {
  const ed = await get(`https://openlibrary.org/isbn/${isbn}.json`);
  const [authors, work] = await Promise.all([
    Promise.all((ed.authors || []).slice(0, 5).map((a) => get(`https://openlibrary.org${a.key}.json`).then((x) => x.name).catch(() => null))),
    ed.works && ed.works[0] ? get(`https://openlibrary.org${ed.works[0].key}.json`).catch(() => null) : null,
  ]);
  const desc = (work && work.description) || ed.description || '';
  const cover = (ed.covers || []).find((id) => id > 0);
  return {
    title: ed.title || '',
    subtitle: ed.subtitle || '',
    authors: authors.filter(Boolean).join(', '),
    publisher: (ed.publishers || []).join(', '),
    year: yearOf(ed.publish_date),
    pages: ed.number_of_pages || null,
    summary: typeof desc === 'string' ? desc : desc.value || '',
    coverUrl: cover ? `https://covers.openlibrary.org/b/id/${cover}-L.jpg` : '',
  };
}

async function lookupIsbn(isbn) {
  const settle = (p) => p.catch((err) => { console.warn('Recherche ISBN :', err.message); return null; });
  const [google, bnf, ol] = await Promise.all([settle(fromGoogle(isbn)), settle(fromBnf(isbn)), settle(fromOpenLibrary(isbn))]);
  const sources = [[google, 'Google Books'], [bnf, 'BnF'], [ol, 'Open Library']].filter(([s]) => s);
  if (!sources.length) return null;
  const result = { isbn, sources: sources.map(([, name]) => name) };
  // Pour chaque champ, la premiere source qui le renseigne (ordre : Google, BnF, Open Library).
  for (const key of ['title', 'subtitle', 'authors', 'publisher', 'year', 'pages', 'summary']) {
    const found = sources.find(([s]) => s[key]);
    result[key] = found ? found[0][key] : (key === 'year' || key === 'pages' ? null : '');
  }
  // Couverture : Open Library est souvent en meilleure resolution que Google.
  result.coverUrl = (ol && ol.coverUrl) || (google && google.coverUrl) || '';
  return result;
}

module.exports = { normalizeIsbn, lookupIsbn };
