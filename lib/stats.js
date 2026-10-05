// Statistiques d'une bibliotheque (option "Statistiques", par bibliotheque).
//
// Confidentialite :
//  - les statistiques de lecture d'un compte ne sont visibles que par ce compte,
//    sauf s'il choisit de les partager : les autres membres de la bibliotheque
//    (comptes lies a celle-ci) peuvent alors les consulter ;
//  - les administrateurs n'ont aucun acces particulier aux statistiques des lecteurs ;
//  - les statistiques de la bibliotheque ne donnent, pour la lecture, que des totaux
//    anonymes (jamais qui a lu quoi).
const { db, tx } = require('./db');
const { httpError } = require('./media');

const coverUrl = (name) => (name ? 'media/' + name : null);
const { handler: h } = require('./library/catalog');

// ================= Periodes =================
function pad(n) { return String(n).padStart(2, '0'); }
function monthKey(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; }
function monthsBetween(fromKey, toKey) {
  const out = [];
  let [y, m] = fromKey.split('-').map(Number);
  const [ty, tm] = toKey.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// { from, to } : bornes de dates (texte 'AAAA-MM-JJ', 'to' exclu ; null = sans borne),
// months : mois affiches dans les graphiques, prev : meme plage un an plus tot.
function periodRange(period, earliest) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const thisMonth = monthKey(now);
  if (period === 'last-year') {
    return { key: period, label: String(y - 1), from: `${y - 1}-01-01`, to: `${y}-01-01`, months: monthsBetween(`${y - 1}-01`, `${y - 1}-12`), compare: true };
  }
  if (period === '12m') {
    const start = new Date(Date.UTC(y, now.getUTCMonth() - 11, 1));
    return { key: period, label: '12 derniers mois', from: start.toISOString().slice(0, 10), to: null, months: monthsBetween(monthKey(start), thisMonth), compare: true };
  }
  if (period === 'all') {
    // Depuis la premiere donnee, 36 mois au plus dans les graphiques.
    let first = earliest ? earliest.slice(0, 7) : thisMonth;
    const minStart = monthKey(new Date(Date.UTC(y, now.getUTCMonth() - 35, 1)));
    if (first < minStart) first = minStart;
    return { key: period, label: 'Depuis le début', from: null, to: null, months: monthsBetween(first, thisMonth), compare: false };
  }
  return { key: 'year', label: String(y), from: `${y}-01-01`, to: `${y + 1}-01-01`, months: monthsBetween(`${y}-01`, `${y}-12`), compare: true };
}

const inRange = (r, d) => !!d && (!r.from || d >= r.from) && (!r.to || d < r.to);
const shiftYear = (key, delta) => `${Number(key.slice(0, 4)) + delta}${key.slice(4)}`;
const dayDiff = (a, b) => Math.max(1, Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000));
const round1 = (n) => Math.round(n * 10) / 10;

function topCounts(map, n = 10) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
    .map(([name, count]) => ({ name, count }));
}
function bump(map, key, by = 1) { if (key) map.set(key, (map.get(key) || 0) + by); }

// ================= Preferences et droits =================
// Objectifs de l'annee civile en plus du nombre de livres (yearly_goal) : cible et
// sens (min = atteindre au moins, max = ne pas depasser). Stockes en JSON dans
// user_library_prefs.reading_goals.
const GOALS = [
  { key: 'pages', label: 'Pages lues', kind: 'min', max: 1000000 },
  { key: 'maxToRead', label: 'Pile « À lire »', kind: 'max', max: 10000 },
  { key: 'categories', label: 'Catégories différentes', kind: 'min', max: 500 },
  { key: 'series', label: 'Séries terminées', kind: 'min', max: 500 },
];
function readGoals(json) {
  let o = {};
  try { o = JSON.parse(json || '{}') || {}; } catch (e) { /* illisible : aucun */ }
  return Object.fromEntries(GOALS.map((g) => [g.key, Number.isInteger(o[g.key]) && o[g.key] >= 0 ? o[g.key] : null]));
}

// Partage des statistiques (user_library_prefs.share_stats) : personne, tous les
// membres de la bibliotheque, ou certains (stats_shares).
const SHARE_MODES = ['none', 'all', 'some'];

function prefsOf(userId, libId) {
  const p = db.prepare('SELECT * FROM user_library_prefs WHERE user_id = ? AND library_id = ?').get(userId, libId);
  const mode = SHARE_MODES[p ? p.share_stats : 0] || 'none';
  return {
    shareStats: mode !== 'none', shareMode: mode,
    shareWith: mode === 'some' ? db.prepare('SELECT viewer_id FROM stats_shares WHERE library_id = ? AND owner_id = ?').all(libId, userId).map((r) => r.viewer_id) : [],
    yearlyGoal: p ? p.yearly_goal : null, goals: readGoals(p && p.reading_goals), staleDays: p ? p.stale_days : 60,
  };
}

// Avancement des objectifs de l'annee en cours (livres compris), pour la page
// Statistiques et l'accueil. expected : attendu a ce jour pour un objectif « min ».
function goalProgress(userId, lib) {
  const prefs = prefsOf(userId, lib.id);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const frac = (now - Date.UTC(now.getUTCFullYear(), 0, 1)) / (Date.UTC(now.getUTCFullYear() + 1, 0, 1) - Date.UTC(now.getUTCFullYear(), 0, 1));
  const read = db.prepare(`SELECT b.id, b.pages, b.series, s.finished_at FROM book_user_status s JOIN books b ON b.id = s.book_id
    WHERE s.user_id = ? AND b.library_id = ? AND s.reading = 'read'`).all(userId, lib.id);
  const thisYear = read.filter((r) => String(r.finished_at || '').startsWith(year));
  const done = {
    books: thisYear.length,
    pages: thisYear.reduce((n, r) => n + (r.pages || 0), 0),
    maxToRead: db.prepare(`SELECT COUNT(*) AS n FROM book_user_status s JOIN books b ON b.id = s.book_id
      WHERE s.user_id = ? AND b.library_id = ? AND s.reading = 'to_read'`).get(userId, lib.id).n,
    categories: thisYear.length ? db.prepare(`SELECT COUNT(DISTINCT category_id) AS n FROM book_categories
      WHERE book_id IN (${thisYear.map(() => '?').join(',')})`).get(...thisYear.map((r) => r.id)).n : 0,
    // Serie terminee : tous ses tomes presents dans la bibliotheque sont lus, le dernier cette annee.
    series: (() => {
      const readById = new Map(read.map((r) => [r.id, r.finished_at || '']));
      const groups = new Map();
      db.prepare("SELECT id, series FROM books WHERE library_id = ? AND TRIM(COALESCE(series, '')) <> ''").all(lib.id).forEach((b) => {
        const k = b.series.trim().toLowerCase();
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(b.id);
      });
      let n = 0;
      for (const ids of groups.values()) {
        if (!ids.every((id) => readById.has(id))) continue;
        const last = ids.map((id) => readById.get(id)).sort().pop();
        if (last.startsWith(year)) n++;
      }
      return n;
    })(),
  };
  const item = (key, label, kind, target) => ({
    key, label, kind, target, done: done[key],
    expected: kind === 'min' && target ? round1(target * frac) : null,
    ok: target == null ? null : kind === 'max' ? done[key] <= target : done[key] >= target,
  });
  return {
    year,
    goals: [item('books', 'Livres lus', 'min', prefs.yearlyGoal || null),
      ...GOALS.map((g) => item(g.key, g.label, g.kind, prefs.goals[g.key]))].filter((g) => g.target != null),
  };
}

// Membre = compte lie a la bibliotheque (un administrateur non lie n'en est pas membre).
function isMember(userId, libId) {
  return !!db.prepare('SELECT 1 FROM user_libraries WHERE user_id = ? AND library_id = ?').get(userId, libId);
}

// Membres (comptes lies a la bibliotheque) qui partagent leurs statistiques avec
// viewerId : avec tous les membres, ou avec lui en particulier.
function sharingMembers(libId, viewerId) {
  return db.prepare(`SELECT u.id, u.username FROM users u
    JOIN user_libraries ul ON ul.user_id = u.id AND ul.library_id = ?1
    JOIN user_library_prefs p ON p.user_id = u.id AND p.library_id = ?1
    WHERE u.id <> ?2 AND (p.share_stats = 1 OR (p.share_stats = 2 AND EXISTS (SELECT 1 FROM stats_shares s
      WHERE s.library_id = ?1 AND s.owner_id = u.id AND s.viewer_id = ?2)))
    ORDER BY u.username COLLATE NOCASE`).all(libId, viewerId);
}

// Autres membres de la bibliotheque (choix des comptes avec qui partager).
function otherMembers(libId, userId) {
  return db.prepare(`SELECT u.id, u.username FROM users u JOIN user_libraries ul ON ul.user_id = u.id AND ul.library_id = ?
    WHERE u.id <> ? ORDER BY u.username COLLATE NOCASE`).all(libId, userId);
}

// Ses propres statistiques, ou celles d'un membre qui les partage (a condition
// d'etre soi-meme membre de la bibliotheque).
function canSeeUserStats(viewer, targetId, libId) {
  if (viewer.id === targetId) return true;
  if (!isMember(viewer.id, libId) || !isMember(targetId, libId)) return false;
  return sharingMembers(libId, viewer.id).some((m) => m.id === targetId);
}

// Notes (1 a 5 etoiles) : moyenne, repartition, livres les mieux notes.
function ratingStats(rated) {
  const distribution = [1, 2, 3, 4, 5].map((n) => rated.filter((r) => r.rating === n).length);
  return {
    count: rated.length,
    average: rated.length ? round1(rated.reduce((n, r) => n + r.rating, 0) / rated.length) : null,
    distribution,
    top: rated.slice().sort((a, b) => b.rating - a.rating || String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 8)
      .map((r) => ({ bookId: r.book_id, title: r.title, cover: coverUrl(r.cover), rating: r.rating })),
  };
}

// ================= Statistiques d'un compte =================
function userStats(lib, userId, periodKey) {
  const rows = db.prepare(`SELECT s.*, b.title, b.authors, b.pages, b.collection, b.series, b.cover
    FROM book_user_status s JOIN books b ON b.id = s.book_id
    WHERE b.library_id = ? AND s.user_id = ?`).all(lib.id, userId);
  const earliest = rows.map((r) => r.started_at || r.finished_at || r.abandoned_at).filter(Boolean).sort()[0];
  const range = periodRange(periodKey, earliest);
  const prefs = prefsOf(userId, lib.id);

  const read = rows.filter((r) => r.reading === 'read' && inRange(range, r.finished_at));
  const abandoned = rows.filter((r) => r.reading === 'abandoned' && inRange(range, r.abandoned_at));
  const reading = rows.filter((r) => r.reading === 'reading');
  const pages = read.reduce((n, r) => n + (r.pages || 0), 0);

  // Rythme mensuel (et meme periode un an plus tot, pour comparer).
  const allRead = rows.filter((r) => r.reading === 'read' && r.finished_at);
  const byMonth = (list, key) => list.filter((r) => r.finished_at.slice(0, 7) === key);
  const monthly = range.months.map((m) => {
    const cur = byMonth(allRead, m);
    const prev = range.compare ? byMonth(allRead, shiftYear(m, -1)) : [];
    return { month: m, books: cur.length, pages: cur.reduce((n, r) => n + (r.pages || 0), 0), prevBooks: range.compare ? prev.length : null };
  });

  // Objectif de l'annee civile en cours (independant de la periode choisie).
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const doneThisYear = allRead.filter((r) => r.finished_at.startsWith(year)).length;
  const dayOfYear = Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  const daysInYear = (now.getUTCFullYear() % 4 === 0) ? 366 : 365;
  const goal = prefs.yearlyGoal ? {
    year, target: prefs.yearlyGoal, done: doneThisYear,
    expected: round1((prefs.yearlyGoal * dayOfYear) / daysInYear),
  } : { year, target: null, done: doneThisYear };

  // Durees : livres lus avec date de debut et de fin.
  const timed = read.filter((r) => r.started_at && r.finished_at)
    .map((r) => ({ bookId: r.book_id, title: r.title, pages: r.pages, cover: coverUrl(r.cover), days: dayDiff(r.started_at, r.finished_at) }));
  const withPages = timed.filter((t) => t.pages);
  const durations = {
    count: timed.length,
    avgDays: timed.length ? round1(timed.reduce((n, t) => n + t.days, 0) / timed.length) : null,
    pagesPerDay: withPages.length ? round1(withPages.reduce((n, t) => n + t.pages, 0) / withPages.reduce((n, t) => n + t.days, 0)) : null,
    fastest: timed.length ? timed.reduce((a, b) => (b.days < a.days ? b : a)) : null,
    slowest: timed.length ? timed.reduce((a, b) => (b.days > a.days ? b : a)) : null,
    thickest: read.filter((r) => r.pages).reduce((a, r) => (!a || r.pages > a.pages ? { bookId: r.book_id, title: r.title, pages: r.pages, cover: coverUrl(r.cover) } : a), null),
  };

  // Lectures en cours, avec signal au-dela du seuil choisi.
  const today = now.toISOString().slice(0, 10);
  const current = reading.map((r) => {
    const days = r.started_at ? dayDiff(r.started_at, today) : null;
    return { bookId: r.book_id, title: r.title, pages: r.pages, cover: coverUrl(r.cover), days, stale: days != null && days > prefs.staleDays };
  }).sort((a, b) => (b.days || 0) - (a.days || 0));

  // Gouts : livres lus ou abandonnes sur la periode.
  const judged = read.concat(abandoned);
  const ids = judged.map((r) => r.book_id);
  const terms = (table, link, col) => (ids.length ? db.prepare(`SELECT l.book_id, t.name FROM ${link} l JOIN ${table} t ON t.id = l.${col}
    WHERE l.book_id IN (${ids.map(() => '?').join(',')})`).all(...ids) : []);
  const tasteBy = (pairs) => {
    const stat = new Map();
    for (const { book_id: bookId, name } of pairs) {
      const r = judged.find((x) => x.book_id === bookId);
      const s = stat.get(name) || { name, read: 0, abandoned: 0, liked: 0 };
      if (r.reading === 'read') s.read++; else s.abandoned++;
      if (r.opinion === 'liked') s.liked++;
      stat.set(name, s);
    }
    return Array.from(stat.values()).sort((a, b) => (b.read + b.abandoned) - (a.read + a.abandoned) || a.name.localeCompare(b.name)).slice(0, 10);
  };
  const authors = new Map();
  read.forEach((r) => String(r.authors || '').split(',').map((a) => a.trim()).filter(Boolean).forEach((a) => bump(authors, a)));
  const seriesMap = new Map();
  read.forEach((r) => bump(seriesMap, r.series));

  return {
    period: { key: range.key, label: range.label, compare: range.compare },
    counts: {
      read: read.length, abandoned: abandoned.length, reading: reading.length,
      toRead: rows.filter((r) => r.reading === 'to_read').length,
      liked: rows.filter((r) => r.opinion === 'liked').length, disliked: rows.filter((r) => r.opinion === 'disliked').length,
    },
    pages,
    abandonRate: read.length + abandoned.length ? Math.round((abandoned.length / (read.length + abandoned.length)) * 100) : null,
    monthly,
    goal,
    goals: goalProgress(userId, lib).goals,
    durations,
    current,
    // Coups de coeur : livres aimes (les plus recemment termines d'abord).
    favorites: rows.filter((r) => r.opinion === 'liked')
      .sort((a, b) => String(b.finished_at || b.updated_at).localeCompare(String(a.finished_at || a.updated_at))).slice(0, 8)
      .map((r) => ({ bookId: r.book_id, title: r.title, cover: coverUrl(r.cover) })),
    ratings: ratingStats(rows.filter((r) => r.rating && inRange(range, r.finished_at || r.abandoned_at || r.updated_at))),
    staleDays: prefs.staleDays,
    tastes: {
      categories: tasteBy(terms('categories', 'book_categories', 'category_id')),
      tags: lib.enable_tags ? tasteBy(terms('tags', 'book_tags', 'tag_id')) : [],
      authors: topCounts(authors),
      series: topCounts(seriesMap),
    },
  };
}

// ================= Statistiques de la bibliotheque =================
function libraryStats(lib, periodKey) {
  const earliest = (db.prepare('SELECT MIN(created_at) AS d FROM books WHERE library_id = ?').get(lib.id) || {}).d;
  const range = periodRange(periodKey, earliest);
  const dateCond = (col) => [range.from ? `${col} >= ?` : '1', range.to ? `${col} < ?` : '1'].join(' AND ');
  const dateArgs = [range.from, range.to].filter(Boolean);

  // Lecture collective : totaux anonymes uniquement.
  let reading = null;
  if (lib.enable_reading_status) {
    const top = (sql, args) => db.prepare(sql).all(lib.id, ...args).map((r) => ({ bookId: r.id, name: r.title, cover: coverUrl(r.cover), count: r.n }));
    reading = {
      booksRead: db.prepare(`SELECT COUNT(*) AS n FROM book_user_status s JOIN books b ON b.id = s.book_id
        WHERE b.library_id = ? AND s.reading = 'read' AND ${dateCond('s.finished_at')}`).get(lib.id, ...dateArgs).n,
      activeReaders: db.prepare(`SELECT COUNT(DISTINCT s.user_id) AS n FROM book_user_status s JOIN books b ON b.id = s.book_id
        WHERE b.library_id = ? AND ((${dateCond('s.started_at')} AND s.started_at IS NOT NULL) OR (${dateCond('s.finished_at')} AND s.finished_at IS NOT NULL)
          OR (${dateCond('s.abandoned_at')} AND s.abandoned_at IS NOT NULL))`).get(lib.id, ...dateArgs, ...dateArgs, ...dateArgs).n,
      mostRead: top(`SELECT b.id, b.title, b.cover, COUNT(*) AS n FROM book_user_status s JOIN books b ON b.id = s.book_id
        WHERE b.library_id = ? AND s.reading = 'read' AND ${dateCond('s.finished_at')} GROUP BY b.id ORDER BY n DESC, b.title LIMIT 10`, dateArgs),
      mostLiked: top(`SELECT b.id, b.title, b.cover, COUNT(*) AS n FROM book_user_status s JOIN books b ON b.id = s.book_id
        WHERE b.library_id = ? AND s.opinion = 'liked' GROUP BY b.id ORDER BY n DESC, b.title LIMIT 10`, []),
      ratings: (() => {
        const rated = db.prepare(`SELECT s.rating FROM book_user_status s JOIN books b ON b.id = s.book_id
          WHERE b.library_id = ? AND s.rating IS NOT NULL AND ${dateCond('COALESCE(s.finished_at, s.abandoned_at, s.updated_at)')}`).all(lib.id, ...dateArgs);
        return ratingStats(rated);
      })(),
      bestRated: db.prepare(`SELECT b.id, b.title, b.cover, AVG(s.rating) AS avg, COUNT(*) AS n FROM book_user_status s JOIN books b ON b.id = s.book_id
        WHERE b.library_id = ? AND s.rating IS NOT NULL GROUP BY b.id ORDER BY avg DESC, n DESC, b.title LIMIT 10`).all(lib.id)
        .map((r) => ({ bookId: r.id, name: r.title, cover: coverUrl(r.cover), count: round1(r.avg), votes: r.n })),
      mostAbandoned: top(`SELECT b.id, b.title, b.cover, COUNT(*) AS n FROM book_user_status s JOIN books b ON b.id = s.book_id
        WHERE b.library_id = ? AND s.reading = 'abandoned' AND ${dateCond('s.abandoned_at')} GROUP BY b.id ORDER BY n DESC, b.title LIMIT 10`, dateArgs),
    };
  }

  // Prets (donnees de gestion de la bibliotheque).
  const loans = db.prepare(`SELECT l.*, b.id AS book_id, b.title, b.cover, br.name AS borrower FROM loans l
    JOIN copies c ON c.id = l.copy_id JOIN books b ON b.id = c.book_id JOIN borrowers br ON br.id = l.borrower_id
    WHERE c.library_id = ?`).all(lib.id);
  const loansIn = loans.filter((l) => inRange(range, l.loaned_at));
  const returnedIn = loans.filter((l) => l.returned_at && inRange(range, l.returned_at));
  const byBook = new Map();
  const byBorrower = new Map();
  const bookInfo = new Map();
  loansIn.forEach((l) => { bump(byBook, l.book_id); bookInfo.set(l.book_id, l); bump(byBorrower, l.borrower); });
  const today = new Date().toISOString().slice(0, 10);
  const neverBorrowed = db.prepare(`SELECT b.id, b.title, b.cover FROM books b WHERE b.library_id = ?
    AND EXISTS (SELECT 1 FROM copies c WHERE c.book_id = b.id AND c.format = 'physical')
    AND NOT EXISTS (SELECT 1 FROM loans l JOIN copies c ON c.id = l.copy_id WHERE c.book_id = b.id)
    ORDER BY b.created_at, b.title`).all(lib.id);
  const loanStats = {
    total: loansIn.length,
    open: loans.filter((l) => !l.returned_at).length,
    perMonth: range.months.map((m) => ({ month: m, count: loans.filter((l) => l.loaned_at.slice(0, 7) === m).length })),
    avgDays: returnedIn.length ? round1(returnedIn.reduce((n, l) => n + dayDiff(l.loaned_at, l.returned_at), 0) / returnedIn.length) : null,
    mostBorrowed: Array.from(byBook.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, count]) => ({ bookId: id, name: bookInfo.get(id).title, cover: coverUrl(bookInfo.get(id).cover), count })),
    topBorrowers: topCounts(byBorrower),
    neverBorrowedCount: neverBorrowed.length,
    neverBorrowed: neverBorrowed.slice(0, 10).map((b) => ({ bookId: b.id, name: b.title, cover: coverUrl(b.cover) })),
    oldestOpen: loans.filter((l) => !l.returned_at).sort((a, b) => a.loaned_at.localeCompare(b.loaned_at)).slice(0, 10)
      .map((l) => ({ bookId: l.book_id, name: l.title, cover: coverUrl(l.cover), borrower: l.borrower, days: dayDiff(l.loaned_at, today) })),
  };

  // Fonds.
  // Type d'apres les exemplaires : papier seul, numerique seul, ou les deux.
  const t = db.prepare(`SELECT COUNT(*) AS books, COALESCE(SUM(pages), 0) AS pages,
      COALESCE(SUM(p > 0 AND e = 0), 0) AS paperOnly, COALESCE(SUM(p = 0 AND e > 0), 0) AS ebookOnly, COALESCE(SUM(p > 0 AND e > 0), 0) AS both
    FROM (SELECT b.pages,
      (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id AND c.format = 'physical') AS p,
      (SELECT COUNT(*) FROM copies c WHERE c.book_id = b.id AND c.format = 'ebook') AS e
      FROM books b WHERE b.library_id = ?)`).get(lib.id);
  const copies = db.prepare("SELECT COUNT(*) AS n FROM copies WHERE library_id = ? AND format = 'physical'").get(lib.id).n;
  const created = db.prepare('SELECT created_at FROM books WHERE library_id = ?').all(lib.id);
  const fonds = {
    books: t.books, physical: t.paperOnly + t.both, ebooks: t.ebookOnly + t.both, paperOnly: t.paperOnly, ebookOnly: t.ebookOnly, both: t.both, copies, pages: t.pages,
    added: created.filter((b) => inRange(range, b.created_at)).length,
    growth: range.months.map((m) => ({ month: m, count: created.filter((b) => b.created_at.slice(0, 7) === m).length })),
    byCategory: db.prepare(`SELECT c.name, COUNT(bc.book_id) AS count FROM categories c JOIN book_categories bc ON bc.category_id = c.id
      WHERE c.library_id = ? GROUP BY c.id ORDER BY count DESC, c.name LIMIT 10`).all(lib.id),
    bySeries: db.prepare(`SELECT series AS name, COUNT(*) AS count FROM books WHERE library_id = ? AND series IS NOT NULL AND series <> ''
      GROUP BY series COLLATE NOCASE ORDER BY count DESC, name LIMIT 10`).all(lib.id),
  };

  return { period: { key: range.key, label: range.label }, reading, loans: loanStats, fonds };
}

// ================= Routes (montees dans l'API de gestion d'une bibliotheque) =================
function registerStats(api) {
  const guard = (req) => {
    if (!req.library.enable_stats) throw httpError(409, "Les statistiques ne sont pas activées pour cette bibliothèque.");
  };

  // Ce que le compte peut consulter : ses statistiques, celles des membres qui les
  // partagent, et ses preferences.
  api.get('/stats/overview', h((req, res) => {
    guard(req);
    res.json({
      me: { id: req.user.id, username: req.user.username },
      member: isMember(req.user.id, req.library.id),
      prefs: prefsOf(req.user.id, req.library.id),
      shared: isMember(req.user.id, req.library.id) ? sharingMembers(req.library.id, req.user.id) : [],
      members: isMember(req.user.id, req.library.id) ? otherMembers(req.library.id, req.user.id) : [],
    });
  }));

  api.put('/stats/prefs', h((req, res) => {
    guard(req);
    const cur = prefsOf(req.user.id, req.library.id);
    const b = req.body;
    const goal = b.yearlyGoal === undefined ? cur.yearlyGoal : (parseInt(b.yearlyGoal, 10) > 0 ? Math.min(parseInt(b.yearlyGoal, 10), 1000) : null);
    const stale = b.staleDays === undefined ? cur.staleDays : Math.max(1, Math.min(parseInt(b.staleDays, 10) || 60, 3650));
    // shareMode : none | all | some (shareStats true/false : all / none) ; shareWith : comptes
    // choisis parmi les membres (remplace la liste).
    let share = cur.shareMode;
    if (SHARE_MODES.includes(b.shareMode)) share = b.shareMode;
    else if (b.shareStats !== undefined) share = b.shareStats ? 'all' : 'none';
    const members = new Set(otherMembers(req.library.id, req.user.id).map((m) => m.id));
    const shareWith = Array.isArray(b.shareWith) ? [...new Set(b.shareWith.map(Number))].filter((id) => members.has(id)) : null;
    // goals : objectifs modifies seulement ({pages: 5000, series: null...}).
    const goals = { ...cur.goals };
    if (b.goals && typeof b.goals === 'object') {
      for (const g of GOALS) {
        if (b.goals[g.key] === undefined) continue;
        const v = parseInt(b.goals[g.key], 10);
        goals[g.key] = Number.isFinite(v) && v >= 0 && b.goals[g.key] !== '' && b.goals[g.key] !== null ? Math.min(v, g.max) : null;
      }
    }
    if (share !== 'none' && !isMember(req.user.id, req.library.id)) {
      throw httpError(409, "Seuls les membres de la bibliothèque (comptes liés) peuvent partager leurs statistiques.");
    }
    db.prepare(`INSERT INTO user_library_prefs (user_id, library_id, share_stats, yearly_goal, reading_goals, stale_days) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, library_id) DO UPDATE SET share_stats = excluded.share_stats, yearly_goal = excluded.yearly_goal,
        reading_goals = excluded.reading_goals, stale_days = excluded.stale_days`)
      .run(req.user.id, req.library.id, SHARE_MODES.indexOf(share), goal, JSON.stringify(goals), stale);
    if (shareWith) {
      tx(() => {
        db.prepare('DELETE FROM stats_shares WHERE library_id = ? AND owner_id = ?').run(req.library.id, req.user.id);
        const ins = db.prepare('INSERT INTO stats_shares (library_id, owner_id, viewer_id) VALUES (?, ?, ?)');
        shareWith.forEach((id) => ins.run(req.library.id, req.user.id, id));
      });
    }
    res.json(prefsOf(req.user.id, req.library.id));
  }));

  api.get('/stats/user/:id', h((req, res) => {
    guard(req);
    const target = parseInt(req.params.id, 10);
    if (!canSeeUserStats(req.user, target, req.library.id)) throw httpError(403, "Ces statistiques ne sont pas partagées.");
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(target);
    if (!user) throw httpError(404, 'Compte introuvable.');
    res.json({ user, ...userStats(req.library, target, req.query.period) });
  }));

  api.get('/stats/library', h((req, res) => {
    guard(req);
    res.json(libraryStats(req.library, req.query.period));
  }));
}

module.exports = { registerStats, periodRange, goalProgress };
