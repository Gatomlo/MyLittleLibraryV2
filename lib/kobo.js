// Liseuses Kobo branchees en USB (option "Liseuses" de la bibliotheque, qui demande les
// livres numeriques). Le navigateur lit la liseuse et envoie sa base
// (.kobo/KoboReader.sqlite) : on n'ecrit jamais dedans. A chaque scan : liste des livres
// de la liseuse, rapprochement avec les fiches, statuts de lecture du proprietaire
// (en cours / lu / abandonne) et proprietaire ajoute comme lecteur.
// Envoi vers la liseuse : epub dont les metadonnees (titre, auteurs, ISBN, serie et
// tome) sont reecrites d'apres la fiche, range dans Bibliotheque/ avec le repere
// [mll-<id>] dans le nom du fichier (reconnu aux scans suivants).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const JSZip = require('jszip');
const { DatabaseSync } = require('node:sqlite');
const { db, tx, normalize, bookSearchText, inLibrary } = require('./db');
const { normalizeIsbn } = require('./isbn');
const { httpError } = require('./media');
const ebooks = require('./ebooks');

const MAX_DB_BYTES = 200 * 1024 * 1024;
// Contexte de la bibliotheque redonne (perdu apres express.raw), voir library-api.js.
const h = (fn) => (req, res, next) => inLibrary(req.library.id, () => Promise.resolve(fn(req, res, next))).catch(next);
const s = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// Date Kobo ("2024-03-01T10:22:33Z", "...33.000") -> "2024-03-01 10:22:33".
function sqlDate(v) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(String(v || ''));
  return m ? `${m[1]} ${m[2]}` : null;
}

// Titre compare sans accents, casse ni ponctuation ; auteur = nom de famille du premier.
const titleKey = (t) => normalize(t).replace(/[^a-z0-9]+/g, ' ').trim();
function authorKey(a) {
  const first = String(a || '').split(/[,;&]/)[0].trim();
  return first ? normalize(first.split(/\s+/).pop()) : '';
}

// ---------- Lecture de la base de la liseuse ----------
function readKoboDb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 15).toString() !== 'SQLite format 3') {
    throw httpError(400, "Ce fichier n'est pas une base de liseuse Kobo.");
  }
  const file = path.join(os.tmpdir(), `kobo-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  fs.writeFileSync(file, buffer);
  let kdb;
  try {
    kdb = new DatabaseSync(file, { readOnly: true });
    const cols = new Set(kdb.prepare('PRAGMA table_info(content)').all().map((c) => c.name));
    if (!cols.has('ContentID')) throw httpError(400, "Ce fichier n'est pas une base de liseuse Kobo.");
    const col = (name) => (cols.has(name) ? name : `NULL AS ${name}`);
    // Nom affiche du compte Kobo connecte sur la liseuse. C'est souvent l'adresse e-mail :
    // seule la partie avant le @ est gardee (rawAccount sert a corriger les anciens noms).
    let account = '';
    let rawAccount = '';
    const userCols = new Set(kdb.prepare('PRAGMA table_info(user)').all().map((c) => c.name));
    if (userCols.has('UserDisplayName')) {
      const u = kdb.prepare("SELECT UserDisplayName FROM user WHERE UserDisplayName IS NOT NULL AND TRIM(UserDisplayName) <> '' LIMIT 1").get();
      rawAccount = u ? s(u.UserDisplayName, 60) : '';
      account = rawAccount.split('@')[0].trim();
    }
    // ContentType 6 = livre ; seuls les livres ajoutes par fichier (pas d'achat Kobo).
    const books = kdb.prepare(`SELECT ContentID, Title, ${col('Attribution')}, ${col('ISBN')}, ${col('Publisher')}, ${col('Series')},
        ${col('SeriesNumber')}, ${col('ReadStatus')}, ${col('___PercentRead')}, ${col('DateLastRead')}, ${col('___FileSize')}
      FROM content WHERE ContentType = 6 AND ContentID LIKE 'file://%'`).all().map((r) => {
      const onboard = /^file:\/\/\/mnt\/onboard\/(.+)$/.exec(r.ContentID);
      return {
        contentId: r.ContentID,
        path: onboard ? decodeURIComponent(onboard[1]) : null, // null : carte SD, inaccessible
        title: s(r.Title) || (onboard ? path.basename(onboard[1]) : 'Sans titre'),
        authors: s(r.Attribution),
        isbn: s(r.ISBN, 40),
        publisher: s(r.Publisher),
        series: s(r.Series),
        seriesNumber: s(r.SeriesNumber, 20),
        readStatus: Number(r.ReadStatus) || 0,
        percent: Math.max(0, Math.min(100, Number(r.___PercentRead) || 0)),
        lastReadAt: sqlDate(r.DateLastRead),
        size: Number(r.___FileSize) || null,
      };
    });
    return { books, account, rawAccount };
  } finally {
    try { if (kdb) kdb.close(); } catch (e) { /* deja fermee */ }
    fs.rm(file, { force: true }, () => {});
  }
}

// Modeles (fin du code materiel de .kobo/version) ; code inconnu : "Kobo".
const MODELS = {
  310: 'Kobo Touch', 320: 'Kobo Touch', 330: 'Kobo Glo', 340: 'Kobo Mini', 350: 'Kobo Aura HD', 360: 'Kobo Aura',
  370: 'Kobo Aura H2O', 371: 'Kobo Glo HD', 372: 'Kobo Touch 2.0', 373: 'Kobo Aura ONE', 374: 'Kobo Aura H2O', 375: 'Kobo Aura',
  376: 'Kobo Clara HD', 377: 'Kobo Forma', 378: 'Kobo Aura H2O', 379: 'Kobo Aura', 380: 'Kobo Forma', 381: 'Kobo Aura ONE',
  382: 'Kobo Nia', 383: 'Kobo Sage', 384: 'Kobo Libra H2O', 386: 'Kobo Clara 2E', 387: 'Kobo Elipsa', 388: 'Kobo Libra 2',
  389: 'Kobo Elipsa 2E',
};

// Fichier .kobo/version : "numero-de-serie,...,firmware,...,...,code materiel".
function readVersion(v) {
  const parts = String(v || '').split(',').map((x) => x.trim());
  if (!/^[A-Za-z0-9]{6,}$/.test(parts[0] || '')) throw httpError(400, 'Liseuse non reconnue (fichier .kobo/version illisible).');
  const code = Number((/(\d{3})$/.exec(parts[5] || '') || [])[1]);
  return { serial: parts[0], firmware: s(parts[2], 40), model: MODELS[code] || 'Kobo' };
}

// Nom propose : "Kobo Libra 2 de Thomas" (compte Kobo), sinon "Kobo Libra 2 (6789)".
const defaultName = (v, account) => (account ? `${v.model} de ${account}` : `${v.model} (${v.serial.slice(-4)})`);

// ---------- Rapprochement avec les fiches ----------
function matcher(libId) {
  const books = db.prepare('SELECT id, title, authors, isbn FROM books WHERE library_id = ?').all(libId);
  const ids = new Set(books.map((b) => b.id));
  const byIsbn = new Map();
  const byTitle = new Map();
  for (const b of books) {
    if (b.isbn) byIsbn.set(b.isbn, b.id);
    const k = titleKey(b.title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(b);
  }
  return (it) => {
    const mark = /\[mll-(\d+)\]/.exec(it.path || it.contentId);
    if (mark && ids.has(Number(mark[1]))) return Number(mark[1]);
    const isbn = normalizeIsbn(it.isbn);
    if (isbn && byIsbn.has(isbn)) return byIsbn.get(isbn);
    const same = byTitle.get(titleKey(it.title)) || [];
    const a = authorKey(it.authors);
    const hit = same.find((b) => !a || !b.authors || normalize(b.authors).includes(a));
    return hit ? hit.id : null;
  };
}

// ---------- Statuts de lecture ----------
// Statut deduit de la liseuse : lu, en cours, ou abandonne si la progression n'a pas
// bouge depuis le seuil "lecture qui traine" du proprietaire (Statistiques). Un livre
// lu a moins de ABANDON_MIN_PERCENT % n'est jamais abandonne (ouvert par erreur) : ignore.
const ABANDON_MIN_PERCENT = 5;

function derive(it, staleDays) {
  if (it.read_status === 2) return 'read';
  if (it.read_status === 1 || it.percent > 0) {
    const ref = it.progress_changed_at || it.last_read_at;
    if (ref && Date.now() - new Date(ref.replace(' ', 'T') + 'Z').getTime() > staleDays * 86400000) {
      return it.percent >= ABANDON_MIN_PERCENT ? 'abandoned' : null;
    }
    return 'reading';
  }
  return null;
}

// Applique le statut deduit seulement quand il change d'un scan a l'autre (un
// changement fait a la main dans la bibliotheque est donc respecte) ; un livre "Lu"
// n'est jamais retrograde.
function syncStatus(lib, item, userId, nextReadingDates) {
  const staleDays = (db.prepare('SELECT stale_days FROM user_library_prefs WHERE user_id = ? AND library_id = ?').get(userId, lib.id) || {}).stale_days || 60;
  const derived = derive(item, staleDays);
  if (lib.enable_reading_status && item.book_id && derived && derived !== item.last_derived) {
    const prev = db.prepare('SELECT * FROM book_user_status WHERE book_id = ? AND user_id = ?').get(item.book_id, userId);
    if (!(prev && prev.reading === 'read') && !(prev && prev.reading === derived)) {
      const d = nextReadingDates(prev, derived, {});
      if (derived === 'read' && item.last_read_at) d.finished = item.last_read_at;
      if (derived === 'reading' && !d.started && item.last_read_at) d.started = item.last_read_at;
      db.prepare(`INSERT INTO book_user_status (book_id, user_id, reading, opinion, started_at, finished_at, abandoned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(book_id, user_id) DO UPDATE SET reading = excluded.reading, started_at = excluded.started_at,
          finished_at = excluded.finished_at, abandoned_at = excluded.abandoned_at, updated_at = datetime('now')`)
        .run(item.book_id, userId, derived, prev ? prev.opinion : null, d.started, d.finished, d.abandoned);
    }
  }
  db.prepare('UPDATE kobo_items SET last_derived = ? WHERE id = ?').run(item.book_id ? derived : null, item.id);
}

// ---------- Metadonnees de l'epub envoye ----------
const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function rewriteOpf(opf, b) {
  const m = /(<(?:opf:)?metadata\b[^>]*>)([\s\S]*?)(<\/(?:opf:)?metadata>)/.exec(opf);
  if (!m) return opf;
  let meta = m[2];
  const epub3 = /<(?:opf:)?package\b[^>]*version="3/.test(opf);
  const dropIds = [];
  const drop = (re) => {
    meta = meta.replace(re, (tag) => {
      const id = /\bid="([^"]+)"/.exec(tag);
      if (id) dropIds.push(id[1]);
      return '';
    });
  };
  const add = [];
  if (b.title) {
    drop(/<dc:title\b[^>]*>[\s\S]*?<\/dc:title>|<dc:title\b[^>]*\/>/g);
    add.push(`<dc:title>${xml(b.title)}</dc:title>`);
  }
  const authors = String(b.authors || '').split(',').map((a) => a.trim()).filter(Boolean);
  if (authors.length) {
    drop(/<dc:creator\b[^>]*>[\s\S]*?<\/dc:creator>|<dc:creator\b[^>]*\/>/g);
    authors.forEach((a) => add.push(`<dc:creator>${xml(a)}</dc:creator>`));
  }
  if (b.isbn && !meta.includes(b.isbn)) add.push(`<dc:identifier>urn:isbn:${xml(b.isbn)}</dc:identifier>`);
  // Serie : forme Calibre (lue par les Kobo) et, en EPUB 3, belongs-to-collection.
  meta = meta.replace(/<meta\b[^>]*name="calibre:series(?:_index)?"[^>]*\/?>(?:\s*<\/meta>)?/g, '');
  drop(/<meta\b[^>]*property="belongs-to-collection"[^>]*>[\s\S]*?<\/meta>/g);
  if (b.series) {
    add.push(`<meta name="calibre:series" content="${xml(b.series)}"/>`);
    if (b.series_number) add.push(`<meta name="calibre:series_index" content="${xml(b.series_number)}"/>`);
    if (epub3) {
      add.push(`<meta property="belongs-to-collection" id="mll-series">${xml(b.series)}</meta>`,
        '<meta refines="#mll-series" property="collection-type">series</meta>');
      if (b.series_number) add.push(`<meta refines="#mll-series" property="group-position">${xml(b.series_number)}</meta>`);
    }
  }
  // Metadonnees rattachees (role, tri...) aux elements retires.
  dropIds.forEach((id) => {
    meta = meta.replace(new RegExp(`<meta\\b[^>]*refines="#${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[\\s\\S]*?<\\/meta>`, 'g'), '');
  });
  return opf.replace(m[0], `${m[1]}${meta.replace(/\s+$/, '')}\n    ${add.join('\n    ')}\n  ${m[3]}`);
}

async function epubForKobo(buffer, b) {
  const zip = await JSZip.loadAsync(buffer);
  const container = zip.file('META-INF/container.xml');
  const opfPath = container && (/full-path="([^"]+)"/.exec(await container.async('string')) || [])[1];
  const opfFile = opfPath && zip.file(opfPath);
  if (opfFile) zip.file(opfPath, rewriteOpf(await opfFile.async('string'), b));
  if (zip.file('mimetype')) zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}

// Bibliotheque/<Serie>/<03 - Titre [mll-12]>.epub ou Bibliotheque/<Auteur - Titre [mll-12]>.epub
function koboPath(b) {
  const clean = (v, max = 80) => String(v || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, max);
  const title = clean(b.title) || 'Livre';
  const author = clean(String(b.authors || '').split(',')[0], 40);
  if (b.series) {
    const n = /^\d+$/.test(b.series_number || '') ? String(b.series_number).padStart(2, '0') : clean(b.series_number, 10);
    return `Bibliotheque/${clean(b.series)}/${n ? `${n} - ` : ''}${title} [mll-${b.id}].epub`;
  }
  return `Bibliotheque/${author ? `${author} - ` : ''}${title} [mll-${b.id}].epub`;
}

// ================= Routes (gestion, comptes de la bibliotheque) =================
function registerKobo(api, { addReaders, createEbookCopy, nextReadingDates, searchBooks }) {
  api.use('/kobo', (req, res, next) => {
    if (!req.library.enable_kobo || !req.library.enable_ebooks) return res.status(409).json({ error: "La gestion des liseuses n'est pas activée pour cette bibliothèque." });
    next();
  });

  const getDevice = (req) => {
    const d = db.prepare('SELECT * FROM kobo_devices WHERE id = ? AND library_id = ?').get(Number(req.params.id), req.library.id);
    if (!d) throw httpError(404, 'Liseuse introuvable.');
    return d;
  };
  const getItem = (req) => {
    const it = db.prepare(`SELECT i.*, d.user_id AS owner_id FROM kobo_items i JOIN kobo_devices d ON d.id = i.device_id
      WHERE i.id = ? AND d.library_id = ?`).get(Number(req.params.id), req.library.id);
    if (!it) throw httpError(404, 'Livre de la liseuse introuvable.');
    return it;
  };

  function deviceOut(d) {
    const c = db.prepare(`SELECT COUNT(*) AS books, COALESCE(SUM(i.book_id IS NULL), 0) AS noBook,
        COALESCE(SUM(i.book_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM copies c WHERE c.book_id = i.book_id AND c.format = 'ebook' AND c.file_key IS NOT NULL)), 0) AS noFile
      FROM kobo_items i WHERE i.device_id = ?`).get(d.id);
    const owner = d.user_id && db.prepare('SELECT id, username FROM users WHERE id = ?').get(d.user_id);
    return {
      id: d.id, serial: d.serial, name: d.name, model: d.model, firmware: d.firmware, lastScanAt: d.last_scan_at,
      owner: owner || null, books: c.books, noBook: c.noBook, noFile: c.noFile,
    };
  }

  function itemOut(i) {
    const book = i.book_id && db.prepare(`SELECT b.id, b.title, c.id AS copy_id, c.file_key FROM books b
      LEFT JOIN copies c ON c.book_id = b.id AND c.format = 'ebook' WHERE b.id = ?`).get(i.book_id);
    return {
      id: i.id, title: i.title, authors: i.authors, isbn: i.isbn, series: i.series, seriesNumber: i.series_number,
      path: i.path, size: i.size, readStatus: i.read_status, percent: i.percent, lastReadAt: i.last_read_at,
      status: i.last_derived, manual: !!i.manual, pending: !!i.pending,
      book: book ? { id: book.id, title: book.title, copyId: book.copy_id || null, hasFile: !!book.file_key } : null,
    };
  }

  // Rattache un livre de la liseuse a une fiche : exemplaire numerique (sans fichier
  // pour l'instant : le navigateur envoie ensuite celui de la liseuse), proprietaire
  // ajoute comme lecteur, statut de lecture.
  function attach(lib, item, bookId, manual) {
    tx(() => {
      db.prepare('UPDATE kobo_items SET book_id = ?, manual = ?, last_derived = NULL WHERE id = ?').run(bookId, manual ? 1 : 0, item.id);
      if (!bookId) return;
      createEbookCopy(lib.id, bookId, null);
      if (item.owner_id) {
        addReaders(bookId, [item.owner_id]);
        syncStatus(lib, { ...item, book_id: bookId, last_derived: null }, item.owner_id, nextReadingDates);
      }
    });
  }

  api.get('/kobo/devices', (req, res) => {
    res.json(db.prepare('SELECT * FROM kobo_devices WHERE library_id = ? ORDER BY name COLLATE NOCASE').all(req.library.id).map(deviceOut));
  });

  // Livres de la liseuse, avec les filtres du catalogue : recherche (liseuse et fiche),
  // serie ; categorie, collection, tag, lecteur (livres rattaches a une fiche, via la
  // recherche du catalogue) ; lecture sur la liseuse ; tri.
  const ORDERS = {
    series: "COALESCE(NULLIF(i.series, ''), b.series) IS NULL, COALESCE(NULLIF(i.series, ''), b.series) COLLATE NOCASE, CAST(COALESCE(NULLIF(i.series_number, ''), b.series_number) AS REAL), i.title COLLATE NOCASE",
    title: 'i.title COLLATE NOCASE',
    author: 'author_key(COALESCE(b.authors, i.authors)) NULLS LAST, i.title COLLATE NOCASE',
    recent: 'i.last_read_at IS NULL, i.last_read_at DESC, i.title COLLATE NOCASE',
  };
  api.get('/kobo/devices/:id', h((req, res) => {
    const d = getDevice(req);
    const q = req.query;
    let items = db.prepare(`SELECT i.*, b.title AS b_title, b.authors AS b_authors, b.series AS b_series FROM kobo_items i
      LEFT JOIN books b ON b.id = i.book_id WHERE i.device_id = ? ORDER BY ${ORDERS[q.sort] || ORDERS.series}`).all(d.id);
    const words = normalize(s(q.q, 200)).split(/\s+/).filter(Boolean);
    if (words.length) {
      items = items.filter((i) => {
        const text = normalize([i.title, i.authors, i.series, i.b_title, i.b_authors, i.b_series].join(' '));
        return words.every((w) => text.includes(w));
      });
    }
    if (q.series) {
      const k = normalize(q.series);
      items = items.filter((i) => normalize(i.series) === k || normalize(i.b_series) === k);
    }
    if (['category', 'collection', 'tag', 'reader'].some((k) => q[k])) {
      const { ids } = searchBooks(req.library, { category: q.category, collection: q.collection, tag: q.tag, reader: q.reader, ids: '1' },
        { isManager: true, statusUserId: req.user.id });
      const set = new Set(ids);
      items = items.filter((i) => i.book_id && set.has(i.book_id));
    }
    if (q.reading) {
      const stale = d.user_id && (db.prepare('SELECT stale_days FROM user_library_prefs WHERE user_id = ? AND library_id = ?').get(d.user_id, req.library.id) || {}).stale_days;
      items = items.filter((i) => {
        if (q.reading === 'pending') return !!i.pending;
        if (i.pending) return false;
        const st = derive(i, stale || 60);
        return q.reading === 'unread' ? !st : st === q.reading;
      });
    }
    res.json({ ...deviceOut(d), items: items.map(itemOut) });
  }));

  api.put('/kobo/devices/:id', h((req, res) => {
    const d = getDevice(req);
    const name = s(req.body.name, 80) || d.name;
    let userId = req.body.userId === undefined ? d.user_id : Number(req.body.userId) || null;
    if (userId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) userId = null;
    db.prepare('UPDATE kobo_devices SET name = ?, user_id = ? WHERE id = ?').run(name, userId, d.id);
    res.json(deviceOut(getDevice(req)));
  }));

  // Livre copie sur la liseuse depuis l'appli : note "en attente" jusqu'a ce que la
  // liseuse l'importe (apres ejection) et qu'un scan le retrouve.
  api.post('/kobo/devices/:id/pushed', h((req, res) => {
    const d = getDevice(req);
    const b = db.prepare('SELECT * FROM books WHERE id = ? AND library_id = ?').get(Number(req.body.bookId), req.library.id);
    const p = s(req.body.path, 500);
    if (!b || !p) throw httpError(400, 'Livre ou chemin manquant.');
    db.prepare(`INSERT INTO kobo_items (device_id, content_id, path, title, authors, isbn, series, series_number, book_id, pending, pushed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(device_id, content_id) DO UPDATE SET book_id = excluded.book_id, pushed_at = excluded.pushed_at`)
      .run(d.id, `file:///mnt/onboard/${p}`, p, b.title, b.authors, b.isbn, b.series, b.series_number, b.id);
    res.json({ ok: true });
  }));

  api.delete('/kobo/devices/:id', h((req, res) => {
    db.prepare('DELETE FROM kobo_devices WHERE id = ?').run(getDevice(req).id);
    res.json({ ok: true });
  }));

  // Base de la liseuse envoyee brute (application/x-sqlite3) ; contenu de
  // .kobo/version dans l'en-tete X-Kobo-Version (encodeURIComponent).
  api.post('/kobo/scan', express.raw({ type: 'application/x-sqlite3', limit: MAX_DB_BYTES }), h((req, res) => {
    const lib = req.library;
    let version = '';
    try { version = decodeURIComponent(String(req.get('X-Kobo-Version') || '')); } catch (e) { /* illisible */ }
    const v = readVersion(version);
    const { books, account, rawAccount } = readKoboDb(req.body);
    const match = matcher(lib.id);
    const now = nowSql();
    const deviceId = tx(() => {
      let d = db.prepare('SELECT * FROM kobo_devices WHERE library_id = ? AND serial = ?').get(lib.id, v.serial);
      if (!d) {
        const id = db.prepare('INSERT INTO kobo_devices (library_id, serial, name, user_id) VALUES (?, ?, ?, ?)')
          .run(lib.id, v.serial, defaultName(v, account), req.user.id).lastInsertRowid;
        d = db.prepare('SELECT * FROM kobo_devices WHERE id = ?').get(id);
      } else if ([`Kobo ${v.serial.slice(-4)}`, defaultName(v, ''), defaultName(v, rawAccount)].includes(d.name) && account && d.name !== defaultName(v, account)) {
        // Nom par defaut (jamais un nom choisi a la main) : complete avec le compte Kobo
        // (ou corrige un ancien nom qui contenait l'adresse e-mail complete).
        db.prepare('UPDATE kobo_devices SET name = ? WHERE id = ?').run(defaultName(v, account), d.id);
      } else if (d.name === `Kobo ${v.serial.slice(-4)}`) {
        db.prepare('UPDATE kobo_devices SET name = ? WHERE id = ?').run(defaultName(v, ''), d.id);
      }
      db.prepare('UPDATE kobo_devices SET model = ?, firmware = ?, last_scan_at = ? WHERE id = ?').run(v.model, v.firmware, now, d.id);
      const old = new Map(db.prepare('SELECT * FROM kobo_items WHERE device_id = ?').all(d.id).map((i) => [i.content_id, i]));
      const upsert = db.prepare(`INSERT INTO kobo_items (device_id, content_id, path, title, authors, isbn, publisher, series, series_number,
          size, read_status, percent, last_read_at, progress_changed_at, book_id, seen_at)
        VALUES (@device, @contentId, @path, @title, @authors, @isbn, @publisher, @series, @seriesNumber,
          @size, @readStatus, @percent, @lastReadAt, @progress, @book, @now)
        ON CONFLICT(device_id, content_id) DO UPDATE SET path = excluded.path, title = excluded.title, authors = excluded.authors,
          isbn = excluded.isbn, publisher = excluded.publisher, series = excluded.series, series_number = excluded.series_number,
          size = excluded.size, read_status = excluded.read_status, percent = excluded.percent, last_read_at = excluded.last_read_at,
          progress_changed_at = excluded.progress_changed_at, book_id = excluded.book_id, seen_at = excluded.seen_at, pending = 0`);
      for (const b of books) {
        const prev = old.get(b.contentId);
        // Rattachement manuel (ou detachement) conserve ; sinon rapprochement automatique.
        const book = prev && prev.manual && (prev.book_id === null || db.prepare('SELECT 1 FROM books WHERE id = ?').get(prev.book_id))
          ? prev.book_id : match(b);
        const moved = !prev || prev.percent !== b.percent || prev.read_status !== b.readStatus;
        const progress = moved ? (b.lastReadAt || now) : prev.progress_changed_at;
        upsert.run({ ...b, device: d.id, progress, book, now });
        const item = db.prepare('SELECT * FROM kobo_items WHERE device_id = ? AND content_id = ?').get(d.id, b.contentId);
        if (book && d.user_id) {
          // Nouveau rattachement : proprietaire lecteur, statut recalcule.
          if (!prev || prev.pending || prev.book_id !== book) {
            addReaders(book, [d.user_id]);
            item.last_derived = null;
          }
          syncStatus(lib, item, d.user_id, nextReadingDates);
        }
      }
      // Livres retires de la liseuse. Livres envoyes depuis l'appli : gardes "en attente"
      // (30 jours au plus) jusqu'a ce que la liseuse les importe ; retires des que le
      // scan retrouve le meme livre (chemin note differemment par la liseuse).
      db.prepare(`DELETE FROM kobo_items WHERE device_id = ? AND (seen_at IS NULL OR seen_at <> ?)
        AND (pending = 0 OR pushed_at < datetime('now', '-30 days'))`).run(d.id, now);
      db.prepare(`DELETE FROM kobo_items WHERE device_id = ?1 AND pending = 1 AND book_id IN (
        SELECT book_id FROM kobo_items WHERE device_id = ?1 AND pending = 0 AND book_id IS NOT NULL)`).run(d.id);
      return d.id;
    });
    req.params.id = deviceId;
    res.json(deviceOut(getDevice(req)));
  }));

  // Nouvelle fiche d'apres les metadonnees de la liseuse.
  api.post('/kobo/items/:id/create', h((req, res) => {
    const item = getItem(req);
    if (item.book_id) throw httpError(409, 'Ce livre est déjà rattaché à une fiche.');
    const f = {
      library_id: req.library.id, isbn: normalizeIsbn(item.isbn) || null, title: item.title, authors: item.authors || null,
      publisher: item.publisher || null, series: item.series || null, series_number: item.series_number || null,
    };
    f.search_text = bookSearchText(f);
    const bookId = tx(() => {
      const id = Number(db.prepare(`INSERT INTO books (library_id, isbn, title, authors, publisher, series, series_number, search_text)
        VALUES (@library_id, @isbn, @title, @authors, @publisher, @series, @series_number, @search_text)`).run(f).lastInsertRowid);
      if (!item.owner_id) addReaders(id, [req.user.id]);
      return id;
    });
    attach(req.library, item, bookId, true);
    res.json(itemOut(db.prepare('SELECT * FROM kobo_items WHERE id = ?').get(item.id)));
  }));

  // Rattachement manuel a une fiche existante (bookId), ou detachement (bookId null).
  api.post('/kobo/items/:id/link', h((req, res) => {
    const item = getItem(req);
    const bookId = Number(req.body.bookId) || null;
    if (bookId && !db.prepare('SELECT 1 FROM books WHERE id = ? AND library_id = ?').get(bookId, req.library.id)) throw httpError(404, 'Fiche introuvable.');
    attach(req.library, item, bookId, true);
    res.json(itemOut(db.prepare('SELECT * FROM kobo_items WHERE id = ?').get(item.id)));
  }));

  // Livre supprime de la liseuse par l'appli : ligne retiree (le scan suivant la
  // recreerait si la liseuse ne l'a pas encore oublie, c'est-a-dire avant ejection).
  api.delete('/kobo/items/:id', h((req, res) => {
    db.prepare('DELETE FROM kobo_items WHERE id = ?').run(getItem(req).id);
    res.json({ ok: true });
  }));

  // Epub a copier sur la liseuse (metadonnees de la fiche) ; chemin conseille dans
  // l'en-tete X-Kobo-Path. Demande le droit de telecharger le fichier.
  api.get('/kobo/books/:id/epub', h(async (req, res) => {
    const b = db.prepare('SELECT * FROM books WHERE id = ? AND library_id = ?').get(Number(req.params.id), req.library.id);
    const c = b && db.prepare("SELECT file_key FROM copies WHERE book_id = ? AND format = 'ebook' AND file_key IS NOT NULL").get(b.id);
    if (!c) throw httpError(404, "Ce livre n'a pas de fichier epub.");
    if (!ebooks.rights(req.library, req.user).download) throw httpError(403, "Tu n'as pas le droit de télécharger ce fichier.");
    const original = fs.readFileSync(ebooks.filePath(req.library.id, c.file_key));
    let out = original;
    try { out = await epubForKobo(original, b); } catch (e) { /* epub atypique : envoye tel quel */ }
    const p = koboPath(b);
    res.set({ 'Cache-Control': 'private, no-store', 'X-Kobo-Path': encodeURIComponent(p), 'Access-Control-Expose-Headers': 'X-Kobo-Path' });
    res.type('application/epub+zip');
    res.attachment(path.basename(p));
    res.send(out);
  }));
}

module.exports = { registerKobo, matcher, rewriteOpf, koboPath, readKoboDb };
