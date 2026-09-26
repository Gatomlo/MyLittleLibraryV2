// Recherche de couvertures en ligne, pour proposer un choix d'images a l'utilisateur.
// Sources interrogees en parallele (chacune peut echouer sans bloquer les autres) :
//  - Open Library : couverture par ISBN + recherche par titre/auteur (autres editions) ;
//  - Google Books : par ISBN et par titre/auteur ;
//  - Amazon (images publiques par ISBN-10) : souvent la meilleure pour les livres recents.
const { normalizeIsbn } = require('./isbn');

const GOOGLE_KEY = process.env.GOOGLE_BOOKS_API_KEY || '';
const UA = { 'User-Agent': 'MyLittleLibrary/2 (catalogue de bibliotheque)' };
const MAX = 24;

async function getJson(url) {
  const get = () => fetch(url, { signal: AbortSignal.timeout(8000), headers: UA });
  let res = await get();
  // Google Books limite le debit (429), frequent pendant un import multiple : une nouvelle tentative.
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await get();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Verifie qu'une URL renvoie une vraie image (pas une 404 ni une vignette "vide").
async function isImage(url, minBytes = 1000) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(6000), headers: UA });
    if (!res.ok) return false;
    if (!/^image\//.test(res.headers.get('content-type') || '')) return false;
    const len = Number(res.headers.get('content-length') || 0);
    return !len || len >= minBytes;
  } catch (e) { return false; }
}

function isbn13to10(s) {
  if (!s || !s.startsWith('978')) return null;
  const core = s.slice(3, 12);
  const sum = core.split('').reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : check);
}

function googleImage(item) {
  const links = (item.volumeInfo && item.volumeInfo.imageLinks) || {};
  const thumb = (links.thumbnail || links.smallThumbnail || '').replace(/^http:/, 'https:').replace('&edge=curl', '');
  if (!thumb) return null;
  // fife=w800 demande une version plus grande que la vignette par defaut.
  return { thumb, url: thumb.replace(/&zoom=\d/, '&zoom=1') + '&fife=w800-h1200' };
}

function describe(v) {
  const pub = Array.isArray(v.publisher) ? v.publisher[0] : v.publisher;
  const bits = [(v.authors || v.author_name || []).slice(0, 2).join(', '), pub, v.year || v.first_publish_year];
  return bits.filter(Boolean).join(' · ');
}

async function fromGoogle(q, source) {
  const data = await getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=12&printType=books${GOOGLE_KEY ? '&key=' + GOOGLE_KEY : ''}`);
  return (data.items || []).map((it) => {
    const img = googleImage(it);
    if (!img) return null;
    const v = it.volumeInfo || {};
    return { ...img, source, title: v.title || '', detail: describe({ authors: v.authors, publisher: v.publisher, year: (v.publishedDate || '').slice(0, 4) }) };
  }).filter(Boolean);
}

async function fromOpenLibrarySearch(params) {
  const qs = new URLSearchParams({ ...params, limit: '15', fields: 'cover_i,title,author_name,first_publish_year,publisher' });
  const data = await getJson(`https://openlibrary.org/search.json?${qs}`);
  return (data.docs || []).filter((d) => d.cover_i > 0).map((d) => ({
    url: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
    thumb: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
    source: 'Open Library', title: d.title || '', detail: describe(d),
  }));
}

async function byIsbnDirect(isbn) {
  const isbn10 = isbn13to10(isbn);
  const candidates = [
    { url: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`, thumb: `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`, source: 'Open Library', min: 1000 },
  ];
  if (isbn10) {
    candidates.push({
      url: `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01.LZZZZZZZ.jpg`,
      thumb: `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01.MZZZZZZZ.jpg`,
      source: 'Amazon', min: 1000,
    });
  }
  const ok = await Promise.all(candidates.map((c) => isImage(c.url, c.min)));
  return candidates.filter((c, i) => ok[i]).map(({ min, ...c }) => ({ ...c, title: 'Même ISBN', detail: '' }));
}

async function searchCovers({ isbn, title, author }) {
  const norm = normalizeIsbn(isbn);
  const t = String(title || '').trim().slice(0, 200);
  const a = String(author || '').split(/[,;]/)[0].trim().slice(0, 120);
  const jobs = [];
  if (norm) {
    jobs.push(byIsbnDirect(norm));
    jobs.push(fromGoogle(`isbn:${norm}`, 'Google Books'));
    jobs.push(fromOpenLibrarySearch({ isbn: norm }));
  }
  if (t) {
    jobs.push(fromGoogle(`intitle:${t}${a ? ' inauthor:' + a : ''}`, 'Google Books'));
    jobs.push(fromOpenLibrarySearch(a ? { title: t, author: a } : { title: t }));
  }
  const results = await Promise.allSettled(jobs);
  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const c of r.value) {
      const key = c.url.replace(/&fife=.*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out.slice(0, MAX);
}

module.exports = { searchCovers };
