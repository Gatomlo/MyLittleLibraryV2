// Accueil personnalise d'une bibliotheque (#/home) : cartes choisies et ordonnees par
// chaque compte (user_library_prefs.home_cards), donnees de toutes les cartes en une
// requete. Monte dans le routeur de la bibliotheque avant la garde « gestion » :
// tout compte connecte y a acces, les cartes de gestion seulement s'il gere.
const { db } = require('./db');
const auth = require('./auth');
const { httpError } = require('./media');

// Fiches incompletes comptees sur l'accueil : seulement ces informations.
const HOME_MISSING = ['cover', 'summary', 'isbn', 'category'];

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Ordre par defaut. manage = compte lie (ou administrateur).
const CARDS = [
  { key: 'todo', label: 'À faire', when: (c) => c.manage },
  { key: 'reading', label: 'Mes lectures en cours', when: (c) => c.lib.enable_reading_status },
  { key: 'forme', label: 'Pour moi', when: () => true },
  { key: 'due', label: 'Échéances des prêts', when: (c) => c.manage },
  { key: 'wishes', label: 'Mes souhaits', when: () => true },
  { key: 'news', label: 'Nouveautés', when: () => true },
  { key: 'goal', label: 'Objectif de lecture', when: (c) => c.lib.enable_stats && c.lib.enable_reading_status },
];

function readPrefs(userId, libId) {
  const r = db.prepare('SELECT home_cards FROM user_library_prefs WHERE user_id = ? AND library_id = ?').get(userId, libId);
  try { const p = JSON.parse((r && r.home_cards) || 'null'); return p && Array.isArray(p.order) ? p : null; } catch (e) { return null; }
}

// Cartes disponibles pour ce compte, dans son ordre (les cartes ajoutees depuis son
// choix viennent a la fin, affichees), avec leur etat affiche / masque.
function cardsFor(ctx) {
  const avail = CARDS.filter((c) => c.when(ctx));
  const prefs = readPrefs(ctx.user.id, ctx.lib.id);
  if (!prefs) return avail.map((c) => ({ key: c.key, label: c.label, shown: true }));
  const rank = (k) => { const i = prefs.order.indexOf(k); return i < 0 ? 1000 + CARDS.findIndex((c) => c.key === k) : i; };
  const hidden = new Set(Array.isArray(prefs.hidden) ? prefs.hidden : []);
  return avail.sort((a, b) => rank(a.key) - rank(b.key)).map((c) => ({ key: c.key, label: c.label, shown: !hidden.has(c.key) }));
}

function registerHome(api, { mediaUrl, OVERDUE, toRemindSql, COPY_COUNTS, MISSING, listLoans }) {
  api.get('/home', h((req, res) => {
    if (!req.user) throw httpError(401, 'Connexion requise.');
    const lib = req.library;
    const me = req.user.id;
    const ctx = { user: req.user, lib, manage: auth.canManage(req.user, lib.id), config: auth.canConfigure(req.user, lib.id) };
    const cards = cardsFor(ctx);
    const on = new Set(cards.filter((c) => c.shown).map((c) => c.key));
    const book = (b) => ({ id: b.id, title: b.title, authors: b.authors || '', coverUrl: mediaUrl(b.cover) });
    const data = {};

    if (on.has('todo')) {
      const auto = lib.reminder_mode === 'auto';
      const loans = db.prepare(`SELECT COALESCE(SUM(${OVERDUE}), 0) AS overdue,
          COALESCE(SUM(l.due_at >= date('now', 'localtime') AND l.due_at <= date('now', 'localtime', '+7 days')), 0) AS week
        FROM loans l JOIN copies c ON c.id = l.copy_id WHERE c.library_id = ? AND l.returned_at IS NULL`).get(lib.id);
      const toRemind = auto ? db.prepare(`SELECT COUNT(*) AS n FROM loans l JOIN copies c ON c.id = l.copy_id
        WHERE c.library_id = ? AND ${toRemindSql(lib.id)}`).get(lib.id).n : 0;
      const reservations = db.prepare(`SELECT COUNT(*) AS n FROM reservations r WHERE r.library_id = ? AND EXISTS (
          SELECT 1 FROM copies c WHERE c.book_id = r.book_id AND c.format = 'physical'
          AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.copy_id = c.id AND l.returned_at IS NULL))`).get(lib.id).n;
      const incomplete = db.prepare(`SELECT COUNT(*) AS n FROM books bk WHERE bk.library_id = ?
        AND (${HOME_MISSING.map((k) => MISSING[k]).join(' OR ')})`).get(lib.id).n;
      const labels = ctx.config ? db.prepare(`SELECT COUNT(*) AS n FROM copies WHERE library_id = ? AND format = 'physical'
        AND label_printed_at IS NULL`).get(lib.id).n : 0;
      const wishes = ctx.config ? db.prepare(`SELECT COUNT(*) AS n FROM wishes w JOIN user_libraries ul ON ul.user_id = w.user_id
        WHERE ul.library_id = ? AND w.user_id <> ?`).get(lib.id, me).n : 0;
      data.todo = { reminderMode: auto ? 'auto' : 'manual', toRemind, overdue: loans.overdue, week: loans.week, reservations, incomplete, labels, wishes };
    }

    if (on.has('reading')) {
      data.reading = db.prepare(`SELECT b.id, b.title, b.authors, b.cover,
          (SELECT MAX(k.percent) FROM kobo_items k JOIN kobo_devices d ON d.id = k.device_id WHERE k.book_id = b.id AND d.user_id = ?1) AS percent
        FROM book_user_status s JOIN books b ON b.id = s.book_id
        WHERE s.user_id = ?1 AND s.reading = 'reading' AND b.library_id = ?2
        ORDER BY COALESCE(s.started_at, s.updated_at) DESC LIMIT 12`).all(me, lib.id)
        .map((b) => ({ ...book(b), percent: b.percent == null ? null : Math.round(b.percent) }));
    }

    if (on.has('forme')) {
      // Livres dont on est lecteur, rendus ces 14 derniers jours et disponibles, pas encore lus.
      const back = db.prepare(`SELECT b.id, b.title, b.authors, b.cover, ${COPY_COUNTS} FROM book_readers r JOIN books b ON b.id = r.book_id
        WHERE r.user_id = ?1 AND b.library_id = ?2
          AND NOT EXISTS (SELECT 1 FROM book_user_status s WHERE s.book_id = b.id AND s.user_id = ?1 AND s.reading = 'read')
          AND EXISTS (SELECT 1 FROM loans l JOIN copies c ON c.id = l.copy_id WHERE c.book_id = b.id
            AND l.returned_at >= datetime('now', '-14 days'))
        ORDER BY b.title COLLATE NOCASE LIMIT 10`).all(me, lib.id).filter((b) => b.available_copies > (b.reservation_count || 0))
        .map((b) => ({ kind: 'back', book: book(b) }));
      // Livres ajoutes ces 30 derniers jours dont on est lecteur (ex. un de ses souhaits
      // ajoute a la bibliotheque), pas encore lus.
      const added = db.prepare(`SELECT b.id, b.title, b.authors, b.cover, b.created_at FROM book_readers r JOIN books b ON b.id = r.book_id
        WHERE r.user_id = ?1 AND b.library_id = ?2 AND b.created_at >= datetime('now', '-30 days')
          AND NOT EXISTS (SELECT 1 FROM book_user_status s WHERE s.book_id = b.id AND s.user_id = ?1 AND s.reading = 'read')
        ORDER BY b.created_at DESC LIMIT 10`).all(me, lib.id)
        .map((b) => ({ kind: 'added', book: book(b), at: b.created_at }));
      const seen = new Set(added.map((a) => a.book.id));
      data.forme = [...added, ...back.filter((b) => !seen.has(b.book.id))];
    }

    if (on.has('due')) {
      // Prets en retard puis echeances des 14 prochains jours.
      const limit = db.prepare("SELECT date('now', 'localtime', '+14 days') AS d").get().d;
      data.due = listLoans(lib.id, { status: 'open' }).filter((l) => l.dueAt && l.dueAt <= limit)
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 8);
    }

    if (on.has('wishes')) {
      const count = db.prepare('SELECT COUNT(*) AS n FROM wishes WHERE user_id = ?').get(me).n;
      const items = db.prepare(`SELECT id, title, authors, cover_url, priority FROM wishes WHERE user_id = ?
        ORDER BY priority DESC, created_at DESC, id DESC LIMIT 5`).all(me)
        .map((w) => ({ id: w.id, title: w.title, authors: w.authors || '', coverUrl: w.cover_url || '', priority: w.priority }));
      data.wishes = { count, items };
    }

    if (on.has('news')) {
      // Livres dont on est lecteur : marques « Pour toi ».
      const mine = new Set(db.prepare('SELECT r.book_id AS id FROM book_readers r JOIN books b ON b.id = r.book_id WHERE r.user_id = ? AND b.library_id = ?')
        .all(me, lib.id).map((r) => r.id));
      const month = db.prepare("SELECT COUNT(*) AS n FROM books WHERE library_id = ? AND created_at >= datetime('now', '-30 days')").get(lib.id).n;
      data.news = { month, items: db.prepare('SELECT id, title, authors, cover FROM books WHERE library_id = ? ORDER BY created_at DESC, id DESC LIMIT 12')
        .all(lib.id).map((b) => ({ ...book(b), mine: mine.has(b.id) })) };
    }

    if (on.has('goal')) {
      const year = new Date().getFullYear();
      const p = db.prepare('SELECT yearly_goal FROM user_library_prefs WHERE user_id = ? AND library_id = ?').get(me, lib.id);
      const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(b.pages), 0) AS pages FROM book_user_status s JOIN books b ON b.id = s.book_id
        WHERE s.user_id = ? AND b.library_id = ? AND s.reading = 'read' AND substr(s.finished_at, 1, 4) = ?`).get(me, lib.id, String(year));
      const goal = p && p.yearly_goal ? p.yearly_goal : null;
      const start = new Date(year, 0, 1);
      const frac = (Date.now() - start) / (new Date(year + 1, 0, 1) - start);
      data.goal = { year, goal, read: r.n, pages: r.pages, ahead: goal ? r.n - Math.round(goal * frac) : null };
    }

    res.json({ cards, data, manage: ctx.manage, config: ctx.config });
  }));

  // Choix des cartes : ordre complet et cartes masquees ; null = ordre par defaut.
  api.put('/home/cards', h((req, res) => {
    if (!req.user) throw httpError(401, 'Connexion requise.');
    const keys = new Set(CARDS.map((c) => c.key));
    let value = null;
    if (req.body.order !== null && req.body.order !== undefined) {
      const order = (Array.isArray(req.body.order) ? req.body.order : []).filter((k) => keys.has(k));
      const hidden = (Array.isArray(req.body.hidden) ? req.body.hidden : []).filter((k) => keys.has(k));
      value = JSON.stringify({ order: [...new Set(order)], hidden: [...new Set(hidden)] });
    }
    db.prepare(`INSERT INTO user_library_prefs (user_id, library_id, home_cards) VALUES (?, ?, ?)
      ON CONFLICT(user_id, library_id) DO UPDATE SET home_cards = excluded.home_cards`).run(req.user.id, req.library.id, value);
    res.json({ ok: true });
  }));
}

module.exports = { registerHome, CARDS };
