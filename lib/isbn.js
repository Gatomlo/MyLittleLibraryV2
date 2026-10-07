// Recherche des informations d'un livre a partir de son ISBN, en combinant trois
// sources interrogees en parallele :
//  - Google Books : bons resumes. Sans cle, le quota anonyme partage est souvent
//    epuise -> saisir une cle (gratuite) dans Administration > Google Books,
//    ou definir GOOGLE_BOOKS_API_KEY.
//  - BnF (catalogue general, SRU) : reference pour les livres francophones.
//  - Open Library : couvertures, nombre de pages, resume de l'oeuvre.
const { googleBooksKey } = require('./db');
const { ttlCache } = require('./util');
const { assertOnline } = require('./net');
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

async function get(url, type = 'json', timeout = 8000) {
  assertOnline();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: UA });
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
  // Entites nommees courantes + numeriques decimales (&#39;) et hexadecimales (&#x27;)
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&hellip;/g, '…')
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
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

// ---------- leslibraires.fr (resume editeur, livres francophones) ----------
// La recherche par ISBN redirige vers la fiche du livre ; resume dans <p itemprop="description">.
// Placedeslibraires.fr / Decitre bloquent les hebergeurs ; leslibraires.fr non, mais limite le
// debit (503 en rafale) : une requete a la fois, 3 s d'intervalle, une relance apres un 503.
const LL_INTERVAL = 3000;
let llQueue = Promise.resolve();
let llLast = 0;
function llThrottled(fn) {
  const run = llQueue.then(async () => {
    const wait = llLast + LL_INTERVAL - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { llLast = Date.now(); }
  });
  llQueue = run.catch(() => {});
  return run;
}

async function fromLesLibraires(isbn, retry = true) {
  assertOnline();
  const res = await llThrottled(() => fetch(`https://www.leslibraires.fr/recherche/?q=${isbn}`, { signal: AbortSignal.timeout(10000), headers: UA }));
  if (res.status === 503 && retry) {
    await new Promise((r) => setTimeout(r, 10000));
    return fromLesLibraires(isbn, false);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} leslibraires.fr ${isbn}`);
  if (!/\/(livre|ebook)\//.test(res.url)) return null; // pas de fiche pour cet ISBN
  const m = (await res.text()).match(/<p itemprop="description">([\s\S]*?)<\/p>/);
  const summary = m ? decodeXml(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' '))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
  // Quelques fiches n'ont qu'un nom (auteur, traducteur) en guise de presentation.
  return summary.length >= 40 ? { summary } : null;
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

// Resultats gardes quelques heures : un import en masse ou un souhait repose souvent
// les memes questions (3 ou 4 services interroges a chaque fois).
const CACHE_MS = 6 * 60 * 60 * 1000;
const lookupCache = ttlCache(CACHE_MS, { keep: (v) => !!v });
const editionsCache = ttlCache(CACHE_MS, { keep: (v) => Array.isArray(v) && v.length > 0 });

// Copie : les appelants completent parfois le resultat (couverture).
const lookupIsbn = (isbn) => lookupCache.wrap(isbn, () => lookupIsbnOnline(isbn)).then((r) => (r ? structuredClone(r) : r));

async function lookupIsbnOnline(isbn) {
  const settle = (p) => p.catch((err) => { console.warn('Recherche ISBN :', err.message); return null; });
  const [google, bnf, ol] = await Promise.all([settle(fromGoogle(isbn)), settle(fromBnf(isbn)), settle(fromOpenLibrary(isbn))]);
  const sources = [[google, 'Google Books'], [bnf, 'BnF'], [ol, 'Open Library']].filter(([s]) => s);
  // Resume : uniquement dans la langue du livre (Open Library donne souvent le
  // resume anglais de l'oeuvre). Un resume dans une autre langue est propose a part.
  const lang = bookLanguage(isbn, bnf && bnf.language, ol && ol.language);
  const summaries = sources.filter(([s]) => s.summary).map(([s, name]) => ({ text: s.summary, source: name, lang: guessLang(s.summary) }));
  let match = summaries.find((s) => !lang || !s.lang || s.lang === lang);
  // Livre francophone sans resume en francais : leslibraires.fr (debit limite, donc en dernier recours).
  const ll = !match && /^9782|^97910/.test(isbn) ? await settle(fromLesLibraires(isbn)) : null;
  if (ll) {
    match = { text: ll.summary, source: 'leslibraires.fr' };
    sources.push([ll, 'leslibraires.fr']);
  }
  if (!sources.length) return null;
  const result = { isbn, sources: sources.map(([, name]) => name) };
  // Pour chaque champ, la premiere source qui le renseigne (ordre : Google, BnF, Open Library).
  for (const key of ['title', 'subtitle', 'authors', 'publisher', 'year', 'pages', 'collection']) {
    const found = sources.find(([s]) => s[key]);
    result[key] = found ? found[0][key] : (key === 'year' || key === 'pages' ? null : '');
  }
  // Numero : celui de la source qui a fourni la collection retenue.
  const seriesSource = sources.find(([s]) => s.collection && s.collection === result.collection);
  result.collectionNumber = seriesSource ? seriesSource[0].collectionNumber || '' : '';
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

// ---------- Editions par titre + auteur (choix manuel de l'ISBN) ----------
// Google Books et BnF en parallele ; une ligne par ISBN, informations fusionnees.
// Open Library n'est pas interroge : sa recherche ne donne qu'une edition par oeuvre.
async function editionsFromGoogle({ title, author, q }) {
  const terms = title ? [`intitle:${title}`, author && `inauthor:${author}`].filter(Boolean).join(' ') : q;
  const key = googleBooksKey();
  const data = await get(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(terms)}&printType=books&maxResults=40${key ? '&key=' + key : ''}`);
  return (data.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const ids = (v.industryIdentifiers || []).filter((x) => /^ISBN/.test(x.type)).map((x) => normalizeIsbn(x.identifier)).filter(Boolean);
    const links = v.imageLinks || {};
    return {
      isbns: [...new Set(ids)], title: v.title || '', authors: (v.authors || []).join(', '), publisher: v.publisher || '',
      year: yearOf(v.publishedDate), pages: v.pageCount || null, language: v.language || null,
      coverUrl: (links.thumbnail || links.smallThumbnail || '').replace(/^http:/, 'https:'), source: 'Google Books',
    };
  });
}

async function editionsFromBnf({ title, author, q }) {
  const clauses = title
    ? [`bib.title all "${simplify(title)}"`, author && `bib.author all "${simplify(author)}"`].filter(Boolean)
    : [`bib.anywhere all "${simplify(q)}"`];
  const query = encodeURIComponent(clauses.join(' and '));
  const xml = await get(`https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=${query}&recordSchema=dublincore&maximumRecords=30`, 'text', 15000);
  return xml.split('<oai_dc:dc').slice(1).filter((r) => dcAll(r, 'type').some((t) => /texte imprim/i.test(t))).map((r) => {
    const isbns = dcAll(r, 'identifier').map((id) => id.match(/^ISBN\s+([\dX-]+)/i)).filter(Boolean).map((m) => normalizeIsbn(m[1])).filter(Boolean);
    const creators = dcAll(r, 'creator');
    const writers = creators.filter((c) => /Auteur/i.test(c));
    const pages = dcAll(r, 'format').join(' ').match(/(\d+)\s*(?:p\.|pages)/);
    return {
      isbns: [...new Set(isbns)], title: (dcAll(r, 'title')[0] || '').split(' / ')[0].split(' : ')[0].trim(),
      authors: (writers.length ? writers : creators).map(bnfPerson).join(', '),
      publisher: (dcAll(r, 'publisher')[0] || '').replace(/\s*\(.*\)\s*$/, ''), year: yearOf(dcAll(r, 'date')[0]),
      pages: pages ? Number(pages[1]) : null, language: dcAll(r, 'language')[0] || null, coverUrl: '', source: 'BnF',
    };
  });
}

const searchEditions = (query) => editionsCache.wrap(JSON.stringify([query.title, query.author, query.q]), () => searchEditionsOnline(query))
  .then((list) => structuredClone(list));

async function searchEditionsOnline(query) {
  const settle = (p) => p.catch((err) => { console.warn('Recherche d\'editions :', err.message, err.cause || ''); return []; });
  const lists = await Promise.all([settle(editionsFromBnf(query)), settle(editionsFromGoogle(query))]);
  const byIsbn = new Map();
  for (const ed of lists.flat()) {
    // Une notice BnF peut porter plusieurs ISBN (broche, relie) : une ligne chacun.
    for (const isbn of ed.isbns) {
      const cur = byIsbn.get(isbn);
      if (!cur) { byIsbn.set(isbn, { ...ed, isbn, isbns: undefined, sources: [ed.source], source: undefined }); continue; }
      for (const k of ['title', 'authors', 'publisher', 'year', 'pages', 'language', 'coverUrl']) if (!cur[k] && ed[k]) cur[k] = ed[k];
      if (!cur.sources.includes(ed.source)) cur.sources.push(ed.source);
    }
  }
  // Titre identique d'abord, puis francais, puis les plus recentes.
  const wanted = simplify(query.title || query.q);
  const score = (e) => (simplify(e.title) === wanted ? 0 : simplify(e.title).includes(wanted) ? 1 : 2) * 2
    + (/^(fr|fre|fra)$/i.test(e.language || '') || /^9782|^97910/.test(e.isbn) ? 0 : 1);
  return [...byIsbn.values()].sort((a, b) => score(a) - score(b) || (b.year || 0) - (a.year || 0)).slice(0, 40);
}

// Editions du meme livre (recherche par titre + auteur, comme le choix de l'ISBN dans
// la fiche : BnF et Google Books) : titre identique hors sous-titre, meme nom d'auteur,
// hors ISBN de la fiche.
async function sameBookEditions(book) {
  const title = String(book.title || '').split(' : ')[0];
  const author = String(book.authors || '').split(',')[0].trim();
  const wanted = simplify(title);
  const lastName = simplify(author).split(' ').pop();
  if (!wanted) return [];
  const own = normalizeIsbn(book.isbn);
  return (await searchEditions({ title, author }).catch(() => []))
    .filter((e) => e.isbn !== own && simplify(String(e.title || '').split(' : ')[0]) === wanted
      && (!lastName || simplify(e.authors).split(' ').includes(lastName)));
}

// ISBN retrouve parmi ces editions (en complement de findIsbn, BnF seule) : retenu
// seulement s'il n'en reste qu'un une fois ecartees les editions qui contredisent la
// fiche (editeur, annee, pages a 4 pres ; une information absente ne contredit rien).
async function findIsbnByEditions(book) {
  const pub = simplify(book.publisher).split(' ').filter((w) => w.length > 2);
  const left = (await sameBookEditions(book)).filter((e) => (!pub.length || !e.publisher || pub.every((w) => simplify(e.publisher).includes(w)))
    && (!book.year || !e.year || Number(e.year) === Number(book.year))
    && (!book.pages || !e.pages || Math.abs(Number(e.pages) - Number(book.pages)) <= 4));
  const isbns = new Set(left.map((e) => e.isbn));
  // candidates : editions restantes quand il y en a plusieurs (choix a faire).
  return { isbn: isbns.size === 1 ? [...isbns][0] : null, candidates: isbns.size > 1 ? left : [] };
}

// ISBN sans resultat en ligne (souvent l'ISBN numerique, que les catalogues ignorent) :
// informations d'une autre edition du meme livre, trouvee par titre + auteur (titre
// identique hors sous-titre, meme nom d'auteur). Editions les plus proches de la fiche
// d'abord (meme editeur, meme annee, pages a 4 pres), sinon l'ordre de searchEditions.
// field : edition suivante si celle-ci ne donne pas cette information.
async function lookupOtherEdition(book, field = null) {
  const editions = await sameBookEditions(book);
  if (!editions.length) return null;
  const pub = simplify(book.publisher);
  const close = (e) => (pub && simplify(e.publisher).includes(pub) ? 4 : 0)
    + (book.year && Number(e.year) === Number(book.year) ? 2 : 0)
    + (book.pages && e.pages && Math.abs(Number(e.pages) - Number(book.pages)) <= 4 ? 1 : 0);
  editions.sort((a, b) => close(b) - close(a));
  for (const e of editions.slice(0, 3)) {
    const found = await lookupIsbn(e.isbn).catch(() => null);
    if (found && (!field || found[field] || (field === 'cover' && found.coverUrl) || (field === 'category' && found.subjects && found.subjects.length))) {
      return { found, isbn: e.isbn };
    }
  }
  return null;
}

module.exports = { normalizeIsbn, lookupIsbn, findIsbn, findIsbnByEditions, searchEditions, lookupOtherEdition, simplify };
