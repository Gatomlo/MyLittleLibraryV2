// Recherche des informations d'un livre a partir de son ISBN, en combinant trois
// sources interrogees en parallele :
//  - Google Books : bons resumes. Sans cle, le quota anonyme partage est souvent
//    epuise -> saisir une cle (gratuite) dans Administration > Google Books,
//    ou definir GOOGLE_BOOKS_API_KEY.
//  - BnF (catalogue general, SRU) : reference pour les livres francophones.
//  - Open Library : couvertures, nombre de pages, resume de l'oeuvre.
const { googleBooksKey } = require('./db');
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

// "Folio junior ; 100", "Harry Potter #2", "Que sais-je ?, n° 1234" -> { name, number }.
function parseSeries(raw) {
  const s = String(raw || '').replace(/\s*\.\s*$/, '').trim();
  if (!s) return { name: '', number: '' };
  let m = s.match(/^(.*?)\s*[;,]\s*(?:n[°o]\.?\s*|num[ée]ro\s*|vol\.?\s*|volume\s*|t\.?\s*|tome\s*)?(\d+\s*(?:bis|ter|[a-z])?)\s*$/i)
    || s.match(/^(.*?)\s*#\s*(\d+)\s*$/);
  if (m && m[1].trim()) return { name: m[1].trim(), number: m[2].replace(/\s+/g, ' ').trim() };
  m = s.match(/^(.*?)\s*[;,]\s*(.+)$/);
  return m ? { name: m[1].trim(), number: '' } : { name: s, number: '' };
}

// ---------- Google Books ----------
async function fromGoogle(isbn) {
  const data = await get(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${googleBooksKey() ? '&key=' + googleBooksKey() : ''}`);
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
    subjects: v.categories || [],
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

// Le Dublin Core n'expose ni le resume (zone UNIMARC 330 $a, souvent fourni par
// Electre) ni les sujets (606 : sujet Rameau, 608 : forme, ex. "Romans").
async function bnfUnimarc(query) {
  const xml = await get(`https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${query}&recordSchema=unimarcxchange&maximumRecords=1`, 'text');
  const subfieldsA = (tag) => {
    const out = [];
    const re = new RegExp(`<mxc:datafield tag="${tag}"[^>]*>([\\s\\S]*?)</mxc:datafield>`, 'g');
    let m;
    while ((m = re.exec(xml))) {
      const a = m[1].match(/<mxc:subfield code="a">([\s\S]*?)<\/mxc:subfield>/);
      if (a) out.push(decodeXml(a[1].trim()));
    }
    return out;
  };
  return { summary: subfieldsA('330')[0] || '', subjects: [...subfieldsA('606'), ...subfieldsA('608')] };
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
  // "Collection : Folio junior ; 100"
  const collectionLine = dcAll(record, 'description').find((d) => /^Collection\s*:/i.test(d));
  const series = parseSeries(collectionLine ? collectionLine.replace(/^Collection\s*:\s*/i, '') : '');
  const { summary, subjects } = await bnfUnimarc(query).catch(() => ({ summary: '', subjects: [] }));
  return {
    title: title.trim(),
    subtitle: rest.join(' : ').trim(),
    authors: names.join(', '),
    publisher: (dcAll(record, 'publisher')[0] || '').replace(/\s*\(.*\)\s*$/, ''),
    year: yearOf(dcAll(record, 'date')[0]),
    pages: pages ? Number(pages[1]) : null,
    summary,
    subjects: [...subjects, ...dcAll(record, 'subject')],
    coverUrl: '',
    language: dcAll(record, 'language')[0] || null,
    collection: series.name,
    collectionNumber: series.number,
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
  const series = parseSeries((ed.series || [])[0]);
  return {
    title: ed.title || '',
    subtitle: ed.subtitle || '',
    authors: authors.filter(Boolean).join(', '),
    publisher: (ed.publishers || []).join(', '),
    year: yearOf(ed.publish_date),
    pages: ed.number_of_pages || null,
    summary: typeof desc === 'string' ? desc : desc.value || '',
    coverUrl: cover ? `https://covers.openlibrary.org/b/id/${cover}-L.jpg` : '',
    language: ed.languages && ed.languages[0] ? ed.languages[0].key.split('/').pop() : null,
    collection: series.name,
    collectionNumber: series.number,
  };
}

// ---------- Place des Libraires (resume editeur, livres francophones) ----------
// La fiche /livre/<isbn> redirige vers la page du livre ; resume complet dans <p class="description">.
async function fromPlaceDesLibraires(isbn) {
  const html = await get(`https://www.placedeslibraires.fr/livre/${isbn}`, 'text');
  const m = html.match(/<p class="description">([\s\S]*?)<\/p>/);
  if (!m) return null;
  const summary = decodeXml(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' '))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return summary ? { summary } : null;
}

// Langue probable d'un texte (fr / en / nl), d'apres ses mots courants.
const STOPWORDS = {
  fr: ['le', 'la', 'les', 'des', 'une', 'est', 'dans', 'pour', 'qui', 'que', 'avec', 'sur', 'pas', 'plus', 'son', 'aux', 'du', 'et', 'il', 'elle'],
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'with', 'for', 'his', 'her', 'this', 'from', 'by', 'an', 'as', 'are', 'was', 'on', 'it'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'op', 'te', 'zijn', 'met', 'voor', 'niet', 'hij', 'zij', 'aan', 'ook', 'als', 'bij', 'om'],
};
function guessLang(text) {
  const words = String(text || '').toLowerCase().match(/[a-zàâçéèêëîïôûùüÿœ']+/g) || [];
  if (words.length < 8) return null;
  let best = null;
  let bestScore = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = words.filter((w) => set.has(w)).length / words.length;
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  return bestScore > 0.04 ? best : null;
}

// Langue du livre : notice BnF / Open Library, sinon groupe de l'ISBN
// (978-2 et 979-10 : francophone ; 978-90/94 : neerlandophone ; 978-0/1 : anglophone).
const LANG_CODES = { fre: 'fr', fra: 'fr', eng: 'en', dut: 'nl', nld: 'nl' };
function bookLanguage(isbn, ...codes) {
  for (const c of codes) if (c && LANG_CODES[c]) return LANG_CODES[c];
  if (/^9782|^97910/.test(isbn)) return 'fr';
  if (/^97890|^97894/.test(isbn)) return 'nl';
  if (/^978[01]/.test(isbn)) return 'en';
  return null;
}

const LANG_NAMES = { fr: 'français', en: 'anglais', nl: 'néerlandais' };

async function lookupIsbn(isbn) {
  const settle = (p) => p.catch((err) => { console.warn('Recherche ISBN :', err.message); return null; });
  const [google, bnf, ol, pdl] = await Promise.all([settle(fromGoogle(isbn)), settle(fromBnf(isbn)), settle(fromOpenLibrary(isbn)),
    /^9782|^97910/.test(isbn) ? settle(fromPlaceDesLibraires(isbn)) : null]);
  const sources = [[google, 'Google Books'], [bnf, 'BnF'], [ol, 'Open Library']].filter(([s]) => s);
  if (!sources.length && !pdl) return null;
  const result = { isbn, sources: [...sources.map(([, name]) => name), ...(pdl ? ['Place des Libraires'] : [])] };
  // Pour chaque champ, la premiere source qui le renseigne (ordre : Google, BnF, Open Library).
  for (const key of ['title', 'subtitle', 'authors', 'publisher', 'year', 'pages', 'collection']) {
    const found = sources.find(([s]) => s[key]);
    result[key] = found ? found[0][key] : (key === 'year' || key === 'pages' ? null : '');
  }
  // Numero : celui de la source qui a fourni la collection retenue.
  const seriesSource = sources.find(([s]) => s.collection && s.collection === result.collection);
  result.collectionNumber = seriesSource ? seriesSource[0].collectionNumber || '' : '';
  // Resume : uniquement dans la langue du livre (Open Library donne souvent le
  // resume anglais de l'oeuvre). Un resume dans une autre langue est propose a part.
  const lang = bookLanguage(isbn, bnf && bnf.language, ol && ol.language);
  // Place des Libraires (resume seulement) passe avant Open Library.
  const summaries = [[google, 'Google Books'], [bnf, 'BnF'], [pdl, 'Place des Libraires'], [ol, 'Open Library']]
    .filter(([s]) => s && s.summary).map(([s, name]) => ({ text: s.summary, source: name, lang: guessLang(s.summary) }));
  const match = summaries.find((s) => !lang || !s.lang || s.lang === lang);
  result.language = lang;
  result.summary = match ? match.text : '';
  const other = !match && summaries[0];
  result.summaryAlt = other ? { text: other.text, source: other.source, language: LANG_NAMES[other.lang] || other.lang || 'autre langue' } : null;
  // Couverture : Open Library est souvent en meilleure resolution que Google.
  result.coverUrl = (ol && ol.coverUrl) || (google && google.coverUrl) || '';
  // Sujets (BnF, categories Google) : pour proposer une categorie existante.
  result.subjects = [...new Set(sources.flatMap(([s]) => s.subjects || []))];
  return result;
}

// ---------- ISBN d'un livre qui n'en a pas ----------
// Recherche BnF par titre + auteur, puis tri par annee, editeur et nombre de pages
// (quand la fiche les renseigne). L'ISBN n'est retenu que s'il ne reste qu'une
// seule edition imprimee possible : plusieurs editions -> null (pas de risque).
const simplify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

async function findIsbn(book) {
  const title = simplify(book.title);
  const author = simplify(String(book.authors || '').split(',')[0]).split(' ').pop();
  if (!title) return null;
  const clauses = [`bib.title all "${title}"`];
  if (author) clauses.push(`bib.author all "${author}"`);
  const query = encodeURIComponent(clauses.join(' and '));
  const xml = await get(`https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${query}&recordSchema=dublincore&maximumRecords=50`, 'text');
  const isbns = new Set();
  for (const record of xml.split('<oai_dc:dc').slice(1)) {
    if (!dcAll(record, 'type').some((t) => /texte imprim/i.test(t))) continue;
    // Meme titre (hors sous-titre et mention de responsabilite).
    const t = simplify((dcAll(record, 'title')[0] || '').split(' / ')[0].split(' : ')[0]);
    if (t !== simplify(String(book.title).split(' : ')[0])) continue;
    if (book.year && yearOf(dcAll(record, 'date')[0]) !== Number(book.year)) continue;
    if (book.publisher) {
      const pub = simplify(dcAll(record, 'publisher').join(' '));
      if (!simplify(book.publisher).split(' ').filter((w) => w.length > 2).every((w) => pub.includes(w))) continue;
    }
    if (book.pages) {
      const p = dcAll(record, 'format').join(' ').match(/(\d+)\s*(?:p\.|pages)/);
      if (p && Math.abs(Number(p[1]) - Number(book.pages)) > 4) continue;
    }
    const found = dcAll(record, 'identifier').map((id) => id.match(/^ISBN\s+([\dX-]+)/i)).filter(Boolean)
      .map((m) => normalizeIsbn(m[1])).filter(Boolean);
    found.forEach((i) => isbns.add(i));
  }
  return isbns.size === 1 ? [...isbns][0] : null;
}

module.exports = { normalizeIsbn, lookupIsbn, findIsbn, simplify };
