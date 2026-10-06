// Parcours principaux de l'application, de bout en bout par l'API : catalogue,
// exemplaires, prets, reservations, import / export, epub, archives, souhaits.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { setup, stop, DATA_DIR } = require('./helpers');
const { epub, png, koboDb } = require('./fixtures');

let ctx;
let a; // client administrateur
let api;

before(async () => {
  ctx = await setup();
  a = ctx.admin;
  api = ctx.api;
  const s = await a.put(`${api}/settings`, { features: { ebooks: true, kobo: true, readingStatus: true, stats: true, tags: true }, loanDays: 14 });
  assert.equal(s.status, 200);
});
after(stop);

const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body; };

test('livre : creation, recherche, modification, fiche publique', async () => {
  const b = ok(await a.post(`${api}/books`, {
    title: 'Les Misérables', authors: 'Victor Hugo', isbn: '978-2-07-040850-4', series: 'Classiques', seriesNumber: '1',
    categories: ['Roman', 'Classique'], tags: ['xixe'], copies: 2, location: 'Armoire A', summary: 'Jean Valjean.', notes: 'note interne',
    coverData: `data:image/png;base64,${png().toString('base64')}`,
  }));
  assert.equal(b.isbn, '9782070408504');
  assert.equal(b.copies.length, 2);
  assert.match(b.copies[0].code, /^BIB-0000\d$/);
  assert.match(b.coverUrl, /^media\/cover-[0-9a-f]+\.png$/);
  assert.deepEqual(b.categories.map((c) => c.name), ['Classique', 'Roman']);

  // Recherche sans accents ni casse, par ISBN avec tirets, par code d'exemplaire.
  for (const q of ['miserables hugo', '978-2-07-040850-4', b.copies[0].code]) {
    const r = ok(await a.get(`${api}/books?q=${encodeURIComponent(q)}`), q);
    assert.equal(r.total, 1, q);
  }
  assert.equal(ok(await a.get(`${api}/books?q=introuvable`)).total, 0);
  assert.equal(ok(await a.get(`${api}/books?status=available`)).total, 1);
  assert.equal(ok(await a.get(`${api}/books?status=onloan`)).total, 0);
  assert.equal(ok(await a.get(`${api}/books?series=classiques`)).items[0].seriesNumber, '1');

  const up = ok(await a.put(`${api}/books/${b.id}`, { title: 'Les Misérables', authors: 'Victor Hugo', publisher: 'Folio', categories: ['Roman'] }));
  assert.equal(up.publisher, 'Folio');
  assert.equal(up.categories.length, 1);
  assert.equal(up.coverUrl, b.coverUrl, 'couverture conservee');

  // Catalogue public : pas de notes internes, image servie.
  const pub = ok(await ctx.anonyme.get(`${api}/public/books/${b.id}`));
  assert.equal(pub.notes, undefined);
  assert.equal(pub.copies.length, 2);
  const img = await ctx.anonyme.get(`/${ctx.lib.slug}/${b.coverUrl}`, { buffer: true });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(ok(await ctx.anonyme.get(`${api}/public/books?q=hugo`)).total, 1);
  assert.equal(ok(await ctx.anonyme.get(`${api}/public/copies/${b.copies[0].code}`)).bookId, b.id);
});

test('pret, retard, retour, reservation', async () => {
  const b = ok(await a.post(`${api}/books`, { title: 'Livre a preter', copies: 1 }));
  const code = b.copies[0].code;
  const loan = ok(await a.post(`${api}/loans`, { code, borrowerName: 'Camille Dupont' }));
  assert.equal(loan.borrower.name, 'Camille Dupont');
  assert.match(loan.dueAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await a.post(`${api}/loans`, { code, borrowerName: 'Autre' })).status, 409);
  assert.equal((await a.del(`${api}/books/${b.id}`)).status, 409, 'livre en pret non supprimable');
  assert.equal(ok(await a.get(`${api}/loans/summary`)).open, 1);
  assert.equal(ok(await a.get(`${api}/books?status=onloan`)).total, 1);

  // Reservation au nom d'un autre emprunteur ; refusee pour celui qui a le livre.
  assert.equal((await a.post(`${api}/books/${b.id}/reservations`, { borrowerName: 'Camille Dupont' })).status, 409);
  const res = ok(await a.post(`${api}/books/${b.id}/reservations`, { borrowerName: 'Sacha Martin' }));
  assert.equal(res.length, 1);

  ok(await a.put(`${api}/loans/${loan.id}`, { dueAt: '2020-01-01' }));
  assert.equal(ok(await a.get(`${api}/loans?status=overdue`)).length, 1);
  const back = ok(await a.post(`${api}/loans/${loan.id}/return`));
  assert.equal(back.reservations[0].borrower.name, 'Sacha Martin');
  assert.equal((await a.post(`${api}/loans/${loan.id}/return`)).status, 404);

  // Exemplaire libre mais reserve : plus « disponible ».
  const pub = ok(await ctx.anonyme.get(`${api}/public/books/${b.id}`));
  assert.equal(pub.availableCopies, 0);
  assert.equal(pub.reservedCopies, 1);
  assert.equal(pub.copies[0].reserved, true);
  const borrowers = ok(await a.get(`${api}/borrowers?q=camille`));
  assert.equal(borrowers.length, 1);
  assert.equal(borrowers[0].totalLoans, 1);
  assert.equal((await a.del(`${api}/borrowers/${borrowers[0].id}`)).status, 409);
});

test('import ligne a ligne, doublons et export', async () => {
  const first = ok(await a.post(`${api}/import/book`, { title: '=SOMME(A1:A9)', authors: 'Formule', fillFromIsbn: false, copies: 2, categories: 'Test; Import' }));
  assert.equal(first.status, 'created');
  assert.equal(first.codes.length, 2);
  const upd = ok(await a.post(`${api}/import/book`, { bookId: first.bookId, title: '=SOMME(A1:A9)', publisher: 'Maison', onDuplicate: 'update', fillFromIsbn: false }));
  assert.equal(upd.status, 'updated');
  assert.deepEqual(upd.fields, ['éditeur']);

  const csv = await a.get(`${api}/export/inventory.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.body.includes(";'=SOMME(A1:A9);"), 'formule neutralisee dans le CSV');
  assert.ok(!/(^|;)=SOMME/m.test(csv.body));
  const xlsx = await a.get(`${api}/export/inventory.xlsx`, { buffer: true });
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
  assert.equal((await a.get(`${api}/export/copies.csv`)).status, 200);
  assert.equal((await a.get(`${api}/import/template.xlsx`, { buffer: true })).status, 200);
});

test('selection : modification et suppression en masse, classement', async () => {
  const ids = [];
  for (const t of ['Masse 1', 'Masse 2']) ids.push(ok(await a.post(`${api}/books`, { title: t, authors: 'jules verne', copies: 0 })).id);
  assert.equal(ok(await a.post(`${api}/books/bulk-edit`, { ids, changes: { series: 'Voyages', categoriesAdd: ['Aventure'] } })).updated, 2);
  assert.equal(ok(await a.get(`${api}/books?series=Voyages`)).total, 2);
  assert.equal(ok(await a.put(`${api}/values/authors`, { from: 'Jules Verne', name: 'Jules Verne' })).books, 2);
  assert.ok(ok(await a.get(`${api}/values/authors`)).some((v) => v.name === 'Jules Verne'));
  const cats = ok(await a.get(`${api}/categories`));
  assert.ok(cats.find((c) => c.name === 'Aventure').count === 2);
  // Tri inverse (reverse=1) : titre Z -> A, ajout du plus ancien, tomes en ordre decroissant.
  const titles = async (qs) => ok(await a.get(`${api}/books?q=Masse&${qs}`)).items.map((b) => b.title);
  assert.deepEqual(await titles('sort=title'), ['Masse 1', 'Masse 2']);
  assert.deepEqual(await titles('sort=title&reverse=1'), ['Masse 2', 'Masse 1']);
  assert.deepEqual(await titles('sort=recent'), ['Masse 2', 'Masse 1']);
  assert.deepEqual(await titles('sort=recent&reverse=1'), ['Masse 1', 'Masse 2']);
  assert.equal(ok(await a.post(`${api}/books/bulk-delete`, { ids })).deleted, 2);
});

test('etiquettes : QR code et marquage', async () => {
  const pending = ok(await a.get(`${api}/labels/pending`));
  assert.ok(pending.length > 0);
  const labels = ok(await a.post(`${api}/labels`, { codes: [pending[0].code], baseUrl: 'https://exemple.be/test' }));
  assert.match(labels.items[0].svg, /^<svg/);
  ok(await a.post(`${api}/labels/mark-printed`, { codes: [pending[0].code] }));
  assert.equal(ok(await a.get(`${api}/labels/pending`)).length, pending.length - 1);
});

test('epub : import, droits de lecture, envoi vers une liseuse', async () => {
  const file = await epub({ title: 'Roman numérique', author: 'Ada Lovelace', isbn: '9782070368228' });
  const raw = { raw: file, headers: { 'Content-Type': 'application/epub+zip', 'X-File-Name': encodeURIComponent('roman.epub') } };
  const imp = ok(await a.call('POST', `${api}/import/epub`, undefined, raw));
  assert.equal(imp.status, 'created');
  assert.equal(imp.title, 'Roman numérique');
  const again = ok(await a.call('POST', `${api}/import/epub`, undefined, raw));
  assert.equal(again.status, 'skipped');
  const book = ok(await a.get(`${api}/books/${imp.bookId}`));
  assert.equal(book.isbn, '9782070368228');
  assert.equal(book.authors, 'Ada Lovelace');
  assert.equal(book.ebookFile.name, 'roman.epub');

  // Droits par defaut : reserves ; puis lecture publique, telechargement aux membres.
  assert.equal((await ctx.anonyme.get(`${api}/public/books/${imp.bookId}/epub`, { buffer: true })).status, 401);
  ok(await a.put(`${api}/settings`, { ebookAccess: { visible: 'public', read: 'public', download: 'members' } }));
  const read = await ctx.anonyme.get(`${api}/public/books/${imp.bookId}/epub`, { buffer: true });
  assert.equal(read.status, 200);
  assert.ok(read.body.equals(file));
  assert.equal((await ctx.anonyme.get(`${api}/public/books/${imp.bookId}/epub?download=1`, { buffer: true })).status, 401);
  assert.equal((await ctx.users.lecteur.get(`${api}/public/books/${imp.bookId}/epub?download=1`, { buffer: true })).status, 200);

  // Envoi vers une liseuse : metadonnees de la fiche reecrites dans l'epub.
  const fields = { title: 'Titre corrigé', authors: 'Ada Lovelace', series: 'Machines', isbn: '9782070368228' };
  ok(await a.put(`${api}/books/${imp.bookId}`, { ...fields, seriesNumber: '2',
    coverData: `data:image/png;base64,${png(4000).toString('base64')}` }));
  const kobo = await ctx.users.lecteur.get(`${api}/kobo/books/${imp.bookId}/epub`, { buffer: true });
  assert.equal(kobo.status, 200);
  const koboPath = decodeURIComponent(kobo.headers.get('x-kobo-path'));
  assert.match(koboPath, /^Lovelace, Ada\/Titre corrige - Ada Lovelace \[mll-\d+\.[0-9a-f]{6}\]\.epub$/);
  const koboZip = await JSZip.loadAsync(kobo.body);
  const opf = await koboZip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes('<dc:title>Titre corrigé</dc:title>'));
  assert.ok(opf.includes('name="calibre:series" content="Machines"'));
  // Couverture de la fiche ajoutee a l'epub (qui n'en avait pas).
  assert.ok(opf.includes('<meta name="cover" content="mll-cover"/>'));
  assert.ok(/<item id="mll-cover" href="mll-cover\.png" media-type="image\/png"/.test(opf));
  assert.equal((await koboZip.file('OEBPS/mll-cover.png').async('nodebuffer')).length, 4000);
  // Fiche modifiee apres l'envoi : autre nom de fichier (la liseuse ne relit pas un livre connu).
  ok(await a.put(`${api}/books/${imp.bookId}`, { ...fields, seriesNumber: '3' }));
  const kobo2 = await ctx.users.lecteur.get(`${api}/kobo/books/${imp.bookId}/epub`, { buffer: true });
  const koboPath2 = decodeURIComponent(kobo2.headers.get('x-kobo-path'));
  assert.match(koboPath2, /^Lovelace, Ada\/Titre corrige - Ada Lovelace \[mll-\d+\.[0-9a-f]{6}\]\.epub$/);
  assert.notEqual(koboPath2, koboPath); // empreinte changee avec le tome
  ok(await a.put(`${api}/books/${imp.bookId}`, { ...fields, seriesNumber: '2' }));
  const kobo3 = await ctx.users.lecteur.get(`${api}/kobo/books/${imp.bookId}/epub`, { buffer: true });
  assert.equal(decodeURIComponent(kobo3.headers.get('x-kobo-path')), koboPath);

  // Ecriture dans la base de la liseuse : informations de la fiche, sauvegarde gardee.
  const kscan = (extra = {}, raw = koboDb([{ id: `file:///mnt/onboard/${koboPath}`, title: 'Ancien titre', author: 'Vieil Auteur' }])) => a.call('POST', `${api}/kobo/scan`, undefined, {
    raw, headers: { 'Content-Type': 'application/x-sqlite3', 'X-Kobo-Version': encodeURIComponent('N9990000000001,3.0.35+,4.38.21908,3.0.35+,3.0.35+,00000000-0000-0000-0000-000000000388'), ...extra },
  });
  const dev = ok(await kscan());
  assert.equal(dev.dbUpdate, null);
  ok(await a.put(`${api}/kobo/devices/${dev.id}`, { writeDb: true }));
  assert.equal(ok(await kscan()).dbUpdate, null); // sans X-Kobo-Write (Firefox, journal en attente)
  const w = ok(await kscan({ 'X-Kobo-Write': '1' }));
  assert.equal(w.dbUpdate.changed, 1);
  assert.ok(w.dbUpdate.token);
  const backups = ok(await a.get(`${api}/kobo/devices/${dev.id}/backups`));
  assert.equal(backups.length, 1);
  assert.equal((await a.get(`${api}/kobo/devices/${dev.id}/backups/${backups[0].name}`, { buffer: true })).body.subarray(0, 15).toString(), 'SQLite format 3');
  const modified = (await a.get(`${api}/kobo/devices/${dev.id}/db/${w.dbUpdate.token}`, { buffer: true })).body;
  const tmp = path.join(DATA_DIR, 'kobo-test.sqlite');
  fs.writeFileSync(tmp, modified);
  const { DatabaseSync } = require('node:sqlite');
  const kdb = new DatabaseSync(tmp, { readOnly: true });
  const row = kdb.prepare('SELECT * FROM content').get();
  kdb.close();
  assert.equal(row.Title, 'Titre corrigé');
  assert.equal(row.Attribution, 'Ada Lovelace');
  assert.equal(row.Series, 'Machines');
  assert.equal(row.SeriesID, 'Machines');
  assert.equal(row.SeriesNumber, '2');
  assert.equal(row.SeriesNumberFloat, 2);
  assert.equal(row.ISBN, '9782070368228');
  const item = ok(await a.get(`${api}/kobo/devices/${dev.id}`)).items[0];
  assert.equal(item.series, 'Machines');
  assert.equal(item.outdated, false);
  ok(await a.post(`${api}/kobo/devices/${dev.id}/db/applied`, { token: w.dbUpdate.token }));
  // Base deja a jour : rien a ecrire ; fichier remplace sur place : vignettes a effacer.
  assert.equal(ok(await kscan({ 'X-Kobo-Write': '1' }, modified)).dbUpdate, null);
  ok(await a.post(`${api}/kobo/devices/${dev.id}/pushed`, { bookId: imp.bookId, path: koboPath }));
  const c = ok(await kscan({ 'X-Kobo-Write': '1' }, modified)).dbUpdate;
  assert.equal(c.token, null);
  assert.equal(c.covers.length, 1);
  assert.match(c.covers[0].dir, /^\.kobo-images\/\d+\/\d+$/);
  assert.ok(c.covers[0].prefix.startsWith('file____mnt_onboard_Lovelace__Ada_Titre_corrige'));
  ok(await a.post(`${api}/kobo/devices/${dev.id}/db/applied`, { covers: [c.covers[0].itemId] }));
  assert.equal(ok(await kscan({ 'X-Kobo-Write': '1' }, modified)).dbUpdate, null);

  // Collections d'apres les categories, surlignages releves, livre retire de la base.
  ok(await a.put(`${api}/books/${imp.bookId}`, { ...fields, seriesNumber: '2', categories: 'Science-fiction' }));
  const rich = koboDb([{ id: `file:///mnt/onboard/${koboPath}`, title: 'Titre corrigé', author: 'Ada Lovelace', chapters: 3,
    bookmarks: [{ text: 'Une phrase surlignée.' }, { text: 'Avec une note.', note: 'Ma note' }] }]);
  const coll = ok(await kscan({ 'X-Kobo-Write': '1' }, rich)).dbUpdate;
  assert.ok(coll.collections > 0);
  const notes = ok(await a.get(`${api}/kobo/books/${imp.bookId}/annotations`));
  assert.deepEqual(notes.map((n) => [n.kind, n.text, n.note, n.chapter]), [['highlight', 'Une phrase surlignée.', null, 'Chapitre 1'], ['note', 'Avec une note.', 'Ma note', 'Chapitre 1']]);
  fs.writeFileSync(tmp, (await a.get(`${api}/kobo/devices/${dev.id}/db/${coll.token}`, { buffer: true })).body);
  let sdb = new DatabaseSync(tmp, { readOnly: true });
  assert.deepEqual(sdb.prepare('SELECT ShelfName, ContentId FROM ShelfContent').all().map((r) => ({ ...r })), [{ ShelfName: 'Science-fiction', ContentId: `file:///mnt/onboard/${koboPath}` }]);
  assert.equal(sdb.prepare("SELECT _IsDeleted FROM Shelf WHERE Name = 'Science-fiction'").get()._IsDeleted, 'false');
  sdb.close();
  ok(await a.post(`${api}/kobo/devices/${dev.id}/db/applied`, { token: coll.token }));
  assert.deepEqual(ok(await a.get(`${api}/kobo/devices`))[0].collections, 'both');
  const richItem = ok(await a.get(`${api}/kobo/devices/${dev.id}`)).items[0];
  ok(await a.post(`${api}/kobo/items/${richItem.id}/removed`, {}));
  assert.equal(ok(await a.get(`${api}/kobo/devices/${dev.id}`)).items.length, 0);
  const rm = ok(await kscan({ 'X-Kobo-Write': '1' }, fs.readFileSync(tmp))).dbUpdate;
  assert.equal(rm.removed, 1);
  fs.writeFileSync(tmp, (await a.get(`${api}/kobo/devices/${dev.id}/db/${rm.token}`, { buffer: true })).body);
  sdb = new DatabaseSync(tmp, { readOnly: true });
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM content').get().n, 0);
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM volume_shortcovers').get().n, 0);
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM ShelfContent').get().n, 0);
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM Bookmark').get().n, 2); // gardes
  sdb.close();
  ok(await a.post(`${api}/kobo/devices/${dev.id}/db/applied`, { token: rm.token }));
  assert.equal(ok(await kscan({}, fs.readFileSync(tmp))).books, 0);

  // Envoi au format kepub : extension .kepub.epub, texte reperes koboSpan.
  const kep = await ctx.users.lecteur.get(`${api}/kobo/books/${imp.bookId}/epub?format=kepub`, { buffer: true });
  assert.match(decodeURIComponent(kep.headers.get('x-kobo-path')), /\]\.kepub\.epub$/);
  const kepZip = await JSZip.loadAsync(kep.body);
  assert.match(await kepZip.file('OEBPS/c1.xhtml').async('string'), /<span class="koboSpan" id="kobo\.1\.1">Bonjour\.<\/span>/);

  // Base avec son journal (mise a jour pas encore reportee) : lue en entier, rien n'est
  // ecrit ; base abimee : message clair, pas d'erreur serveur.
  const parts = koboDb([{ id: `file:///mnt/onboard/${koboPath}`, title: 'Titre corrigé', author: 'Ada Lovelace' },
    { id: 'file:///mnt/onboard/autre.epub', title: 'Autre livre' }], { withWal: true });
  assert.equal((await kscan({}, parts.main)).status, 400);
  const backupsBefore = ok(await a.get(`${api}/kobo/devices/${dev.id}/backups`)).length;
  const withWal = ok(await kscan({ 'X-Kobo-Write': '1', 'X-Kobo-Wal-Size': String(parts.wal.length) }, Buffer.concat([parts.main, parts.wal])));
  assert.equal(withWal.books, 2);
  // Journal reporte (comme Calibre) : base complete a ecrire, lisible sans journal.
  assert.equal(withWal.dbUpdate.merged, true);
  const merged = (await a.get(`${api}/kobo/devices/${dev.id}/db/${withWal.dbUpdate.token}`, { buffer: true })).body;
  fs.writeFileSync(tmp, merged);
  const mdb = new DatabaseSync(tmp, { readOnly: true });
  assert.equal(mdb.prepare('SELECT COUNT(*) AS n FROM content').get().n, 2);
  assert.equal(mdb.prepare('SELECT Series FROM content WHERE Title = ?').get('Titre corrigé').Series, 'Machines');
  mdb.close();
  ok(await a.post(`${api}/kobo/devices/${dev.id}/db/applied`, { token: withWal.dbUpdate.token }));
  // Base saine de chaque scan gardee (une fois par contenu), jamais une base abimee.
  const afterWal = ok(await a.get(`${api}/kobo/devices/${dev.id}/backups`));
  assert.equal(afterWal.length, backupsBefore + 1);
  assert.match(afterWal[0].name, /\.sqlite\.gz$/);
  const restored = (await a.get(`${api}/kobo/devices/${dev.id}/backups/${afterWal[0].name}`, { buffer: true })).body;
  assert.equal(restored.subarray(0, 15).toString(), 'SQLite format 3');
  ok(await kscan({ 'X-Kobo-Wal-Size': String(parts.wal.length) }, Buffer.concat([parts.main, parts.wal])));
  assert.equal(ok(await a.get(`${api}/kobo/devices/${dev.id}/backups`)).length, afterWal.length);
  const broken = Buffer.concat([modified.subarray(0, 100), Buffer.alloc(modified.length - 100, 7)]);
  const badScan = await kscan({}, broken);
  assert.equal(badScan.status, 400);
  assert.match(badScan.body.error, /illisible/);
  // Base en partie abimee (la liseuse fonctionne quand meme) : lue sans ses index, ou
  // jusqu'a la partie abimee sans retirer les livres non lus.
  const two = [{ id: `file:///mnt/onboard/${koboPath}`, title: 'Titre corrigé', author: 'Ada Lovelace' },
    { id: 'file:///mnt/onboard/autre.epub', title: 'Autre livre' }];
  const noIndex = ok(await kscan({}, koboDb(two, { corrupt: 'index' })));
  assert.equal(noIndex.books, 2);
  assert.equal(noIndex.warning, undefined);
  const backupsHealthy = ok(await a.get(`${api}/kobo/devices/${dev.id}/backups`)).length;
  const part = ok(await kscan({}, koboDb(two, { corrupt: 'table' })));
  assert.equal(part.books, 2);
  assert.match(part.warning, /abîmée/);
  assert.equal(ok(await a.get(`${api}/kobo/devices/${dev.id}/backups`)).length, backupsHealthy);
  const truncated = koboDb(two);
  const cut = await kscan({ 'X-Kobo-Db-Size': String(truncated.length + 10) }, truncated);
  assert.equal(cut.status, 400);
  assert.match(cut.body.error, /incomplète/);
  // Livre en cours : progression de la liseuse du compte sur la fiche et dans le catalogue.
  ok(await kscan({}, koboDb([{ id: `file:///mnt/onboard/${koboPath}`, title: 'Titre corrigé', author: 'Ada Lovelace', status: 1, percent: 42 }])));
  ok(await a.put(`${api}/books/${imp.bookId}/status`, { reading: 'reading' }));
  assert.equal(ok(await a.get(`${api}/books/${imp.bookId}`)).myStatus.percent, 42);
  const listed = ok(await a.get(`${api}/books?q=${encodeURIComponent('Titre corrigé')}&statusUser=${ctx.users.admin ? ctx.users.admin.id : ''}`));
  assert.equal(listed.items[0].status.percent, 42);
  ok(await a.del(`${api}/kobo/devices/${dev.id}`));
  assert.equal(ok(await a.get(`${api}/kobo/devices`)).length, 0);

  // Un fichier qui n'est pas un epub est refuse.
  const bad = await a.call('POST', `${api}/import/epub`, undefined, { raw: Buffer.from('pas un zip'), headers: raw.headers });
  assert.equal(bad.status, 400);
});

test('accueil, statistiques, souhaits', async () => {
  const home = ok(await ctx.users.lecteur.get(`${api}/home`));
  assert.ok(Array.isArray(home.cards));
  ok(await a.get(`${api}/stats/overview`));
  ok(await a.get(`${api}/stats/library`));
  // Objectifs de l'annee : enregistres, puis suivis dans les statistiques et l'accueil.
  const prefs = ok(await ctx.users.lecteur.put(`${api}/stats/prefs`, { yearlyGoal: 12, goals: { pages: 3000, maxToRead: 5, categories: '', series: 2 } }));
  assert.deepEqual(prefs.goals, { pages: 3000, maxToRead: 5, categories: null, series: 2 });
  assert.equal(ok(await ctx.users.lecteur.put(`${api}/stats/prefs`, { goals: { series: null } })).goals.pages, 3000);
  const st = ok(await ctx.users.lecteur.get(`${api}/stats/user/${ctx.users.lecteur.id}`));
  assert.deepEqual(st.goals.map((g) => g.key), ['books', 'pages', 'maxToRead']);
  assert.equal(st.goals.find((g) => g.key === 'maxToRead').kind, 'max');
  // Livres derriere les chiffres : une liste par statut, de la taille du compteur.
  assert.equal(st.lists.read.length, st.counts.read);
  assert.equal(st.lists.toRead.length, st.counts.toRead);
  // Partage des statistiques : avec certains membres seulement, puis avec tous.
  const { lecteur, lecteur2, bibliothecaire } = ctx.users;
  const statsOf = (u) => u.get(`${api}/stats/user/${lecteur.id}`);
  assert.equal((await statsOf(lecteur2)).status, 403);
  const some = ok(await lecteur.put(`${api}/stats/prefs`, { shareMode: 'some', shareWith: [lecteur2.id, ctx.users.etranger.id] }));
  assert.equal(some.shareMode, 'some');
  assert.deepEqual(some.shareWith, [lecteur2.id]); // compte hors bibliotheque ignore
  ok(await statsOf(lecteur2));
  assert.equal((await statsOf(bibliothecaire)).status, 403);
  assert.ok(ok(await lecteur2.get(`${api}/stats/overview`)).shared.some((m) => m.id === lecteur.id));
  assert.ok(!ok(await bibliothecaire.get(`${api}/stats/overview`)).shared.some((m) => m.id === lecteur.id));
  ok(await lecteur.put(`${api}/stats/prefs`, { shareMode: 'all' }));
  ok(await statsOf(bibliothecaire));
  ok(await lecteur.put(`${api}/stats/prefs`, { shareMode: 'none' }));
  assert.equal((await statsOf(lecteur2)).status, 403);
  const l = ctx.users.lecteur;
  const lq = `library=${ctx.lib.id}`;
  const w = ok(await l.post('/api/wishes', { title: 'Souhait', authors: 'Un auteur', library: ctx.lib.id, coverData: `data:image/png;base64,${png().toString('base64')}` }));
  const mine = ok(await l.get(`/api/wishes?${lq}`));
  assert.equal(mine.length, 1);
  assert.match(mine[0].coverUrl, /^api\/wishes\/image\/wish-[0-9a-f]{12}\.png$/);
  assert.equal((await l.get(`/${mine[0].coverUrl}`, { buffer: true })).status, 200);
  // Sans bibliotheque, ou bibliotheque dont le compte n'est pas membre : refuse.
  assert.equal((await l.get('/api/wishes')).status, 400);
  assert.equal((await ctx.users.etranger.get(`/api/wishes?${lq}`)).status, 400);
  assert.equal((await ctx.users.etranger.post('/api/wishes', { title: 'X', library: ctx.lib.id })).status, 400);
  // Un autre lecteur ne le voit ni ne le modifie ; un gestionnaire le voit dans sa bibliotheque.
  assert.equal(ok(await ctx.users.lecteur2.get(`/api/wishes?owners=${ctx.users.lecteur.id}&${lq}`)).length, 0);
  assert.equal((await ctx.users.lecteur2.put(`/api/wishes/${w.id}`, { title: 'Vol' })).status, 403);
  assert.equal(ok(await ctx.users.gestionnaire.get(`/api/wishes?owners=${ctx.users.lecteur.id}&${lq}`)).length, 1);
  assert.match((await l.get(`/api/wishes/export.csv?${lq}`)).body, /Souhait/);
  // Souhaits propres a la bibliotheque : absents d'une autre.
  const own = ok(await a.post('/api/wishes', { title: 'Souhait admin', library: ctx.lib.id }));
  const other = ok(await a.post('/api/admin/libraries', { name: 'Autre souhaits', slug: 'autre-souhaits' }));
  assert.equal(ok(await a.get(`/api/wishes?library=${other.id}`)).length, 0);
  assert.equal(ok(await a.get(`/api/wishes?${lq}`)).length, 1);
  ok(await a.del(`/api/wishes/${own.id}`));
  ok(await a.del(`/api/admin/libraries/${other.id}?confirm=${encodeURIComponent(other.name)}`));
  ok(await l.del(`/api/wishes/${w.id}`));
});

test('sauvegarde et archive : export, restauration dans une nouvelle bibliotheque, remplacement', async () => {
  const before = ok(await a.get(`${api}/books`)).total;
  const backup = await a.get('/api/admin/backup', { buffer: true });
  assert.equal(backup.status, 200);
  assert.ok((await JSZip.loadAsync(backup.body)).file('central.db'));

  const arch = await a.get(`/api/admin/libraries/${ctx.lib.id}/archive?db=1&ebooks=1&covers=1`, { buffer: true });
  assert.equal(arch.status, 200);
  const zip = await JSZip.loadAsync(arch.body);
  assert.ok(zip.file('manifest.json') && zip.file('library.db'));
  const media = Object.keys(zip.files).filter((n) => /^media\/./.test(n));
  const ebooks = Object.keys(zip.files).filter((n) => /^ebooks\/./.test(n));
  assert.ok(media.length >= 1 && ebooks.length === 1, JSON.stringify(Object.keys(zip.files)));

  const send = (buffer) => a.call('POST', '/api/admin/archives', undefined, { raw: buffer, headers: { 'Content-Type': 'application/zip' } });
  // Meme nom : remplacement a confirmer.
  const staged = ok(await send(arch.body));
  assert.equal(staged.existing.id, ctx.lib.id);
  assert.equal((await a.post(`/api/admin/archives/${staged.token}/apply`, {})).status, 409);
  const again = ok(await send(arch.body));
  ok(await a.post(`${api}/books`, { title: 'Ajoute apres la sauvegarde', copies: 0 }));
  const over = ok(await a.post(`/api/admin/archives/${again.token}/apply`, { overwrite: true }));
  assert.equal(over.created, false);
  assert.equal(over.books, before);
  assert.equal(over.covers, media.length);
  assert.equal(ok(await a.get(`${api}/books`)).total, before, 'base remplacee par celle de l\'archive');
  assert.equal(ok(await a.get(`${api}/members`)).length >= 5, true, 'membres conserves');

  // Autre nom : nouvelle bibliotheque, fichiers compris.
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  manifest.library.name = 'Copie restaurée';
  zip.file('manifest.json', JSON.stringify(manifest));
  const st2 = ok(await send(await zip.generateAsync({ type: 'nodebuffer' })));
  assert.equal(st2.existing, null);
  const created = ok(await a.post(`/api/admin/archives/${st2.token}/apply`, {}));
  assert.equal(created.created, true);
  assert.equal(created.books, before);
  const slug = created.library.slug;
  assert.notEqual(slug, ctx.lib.slug);
  const list = ok(await a.get(`/${slug}/api/books?q=miserables`));
  assert.equal(list.total, 1);
  assert.equal((await ctx.anonyme.get(`/${slug}/${list.items[0].coverUrl}`, { buffer: true })).status, 200);
  const eb = ok(await a.get(`/${slug}/api/books?format=ebook`));
  assert.equal((await a.get(`/${slug}/api/public/books/${eb.items[0].id}/epub`, { buffer: true })).status, 200);

  // Entree piegee (chemin qui sort du dossier) : archive refusee, ou entree ignoree ;
  // dans les deux cas rien n'est ecrit hors du dossier de la bibliotheque.
  manifest.library.name = 'Copie piégée';
  zip.file('manifest.json', JSON.stringify(manifest));
  const trap = await zip.generateAsync({ type: 'nodebuffer' });
  const at = trap.indexOf('media/cover-');
  const evil = Buffer.from('media/../../x.png'.padEnd(28, '_').slice(0, 28)); // meme longueur que media/cover-<12 hex>.png
  let patched = trap;
  if (at > 0) {
    patched = Buffer.from(trap);
    for (let i = patched.indexOf('media/cover-'); i >= 0; i = patched.indexOf('media/cover-', i + 1)) evil.copy(patched, i);
  }
  const st3 = await send(patched);
  if (st3.status === 200) await a.post(`/api/admin/archives/${st3.body.token}/apply`, {});
  else assert.equal(st3.status, 400);
  const outside = fs.readdirSync(path.join(DATA_DIR, 'libraries')).concat(fs.readdirSync(DATA_DIR));
  assert.ok(!outside.some((n) => /x\.png/.test(n)), 'rien hors du dossier media');

  assert.equal((await send(Buffer.from('pas une archive'))).status, 400);
  const noManifest = new JSZip();
  noManifest.file('library.db', 'x');
  assert.equal((await send(await noManifest.generateAsync({ type: 'nodebuffer' }))).status, 400);
});

test('vidage de la bibliotheque avec copie de securite', async () => {
  assert.equal((await a.post(`${api}/empty`, { confirm: 'autre' })).status, 400);
  const r = ok(await a.post(`${api}/empty`, { confirm: 'Test', borrowers: true, terms: true, resetCodes: true }));
  assert.ok(r.deleted > 0);
  assert.match(r.backup, /^library-avant-vidage-test-/);
  assert.equal(ok(await a.get(`${api}/books`)).total, 0);
  assert.equal(ok(await a.get(`${api}/borrowers`)).length, 0);
  const b = ok(await a.post(`${api}/books`, { title: 'Premier apres vidage', copies: 1 }));
  assert.equal(b.copies[0].code, 'BIB-00001');
});

test('envoi vers une liseuse : toutes les metadonnees de l\'epub remplacees par la fiche', () => {
  const { rewriteOpf } = require('../lib/kobo');
  const opf = `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:isbn:9780000000002</dc:identifier><dc:identifier>calibre:123</dc:identifier>
    <dc:title id="t">Ancien titre</dc:title><meta refines="#t" property="file-as">Titre, Ancien</meta>
    <dc:creator id="c1">Vieil Auteur</dc:creator><meta refines="#c1" property="role">aut</meta><dc:contributor>calibre (7.0)</dc:contributor>
    <dc:publisher>Ancien éditeur</dc:publisher><dc:date>1999-01-01</dc:date><dc:description>Ancien résumé</dc:description>
    <dc:subject>Vieux sujet</dc:subject><dc:language>fr</dc:language>
    <meta name="calibre:series" content="Ancienne série"/><meta name="calibre:rating" content="8"/><meta name="cover" content="img"/>
    <meta property="dcterms:modified">2020-01-01T00:00:00Z</meta><meta property="rendition:layout">reflowable</meta>
  </metadata><manifest/></package>`;
  const out = rewriteOpf(opf, { id: 7, title: 'Nouveau $& titre', subtitle: 'Sous-titre', authors: 'Ada Lovelace, Alan Turing', publisher: 'Éditeur',
    year: 2021, summary: 'Ligne 1\nLigne <2>', isbn: '9782070368228', series: 'Machines', series_number: '2', categories: ['Roman', 'SF'] });
  for (const old of ['Ancien', 'Vieil', 'Vieux', '1999', 'calibre:123', 'calibre (7.0)', 'calibre:rating', '9780000000002', 'file-as']) assert.ok(!out.includes(old), old);
  for (const kept of ['<dc:language>fr</dc:language>', '<meta name="cover" content="img"/>', 'dcterms:modified', 'rendition:layout',
    '<dc:identifier id="uid">urn:isbn:9782070368228</dc:identifier>', '<dc:title id="mll-title">Nouveau $&amp; titre</dc:title>',
    '<dc:title id="mll-subtitle">Sous-titre</dc:title>', '>Ada Lovelace</dc:creator>', '>Alan Turing</dc:creator>', '<dc:publisher>Éditeur</dc:publisher>',
    '<dc:date>2021</dc:date>', '<dc:description>&lt;p&gt;Ligne 1&lt;/p&gt;&lt;p&gt;Ligne &amp;lt;2&amp;gt;&lt;/p&gt;</dc:description>',
    '<dc:subject>Roman</dc:subject>', '<dc:subject>SF</dc:subject>', 'name="calibre:series" content="Machines"', 'name="calibre:series_index" content="2"']) {
    assert.ok(out.includes(kept), kept);
  }
  assert.equal((out.match(/9782070368228/g) || []).length, 1);
  // Champ vide dans la fiche : retire de l'epub.
  const bare = rewriteOpf(opf, { id: 7, title: 'Seul' });
  assert.ok(!/dc:creator|dc:publisher|dc:description|calibre:series/.test(bare));
  assert.ok(bare.includes('<dc:identifier id="uid">urn:mll:7</dc:identifier>'));
});
