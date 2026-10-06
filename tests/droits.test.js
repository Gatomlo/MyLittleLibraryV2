// Matrice des droits : visiteur, compte etranger, lecteur, bibliothecaire,
// gestionnaire, administrateur. Chaque ligne = une requete et le statut attendu.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, stop, client } = require('./helpers');
const { koboDb } = require('./fixtures');

let ctx;
let bookId;

before(async () => {
  ctx = await setup();
  const r = await ctx.admin.post(`${ctx.api}/books`, { title: 'Livre de test', authors: 'Anne Onyme', copies: 1 });
  assert.equal(r.status, 200);
  bookId = r.body.id;
  const s = await ctx.admin.put(`${ctx.api}/settings`, { features: { ebooks: true, kobo: true, readingStatus: true, stats: true } });
  assert.equal(s.status, 200);
});
after(stop);

// [qui, methode, chemin, corps, statut attendu]
const who = (name) => (name === 'anonyme' ? ctx.anonyme : name === 'admin' ? ctx.admin : ctx.users[name]);

async function check(name, method, path, body, expected) {
  const r = await who(name).call(method, `${ctx.api}${path}`, method === 'GET' || method === 'DELETE' ? undefined : body || {});
  assert.equal(r.status, expected, `${name} ${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  return r;
}

test('catalogue public lisible sans connexion, gestion fermee', async () => {
  await check('anonyme', 'GET', '/public/settings', null, 200);
  await check('anonyme', 'GET', '/public/books', null, 200);
  await check('anonyme', 'GET', `/public/books/${bookId}`, null, 200);
  await check('anonyme', 'GET', '/books', null, 401);
  await check('anonyme', 'POST', '/books', { title: 'x' }, 401);
  await check('anonyme', 'GET', '/borrowers', null, 401);
  await check('anonyme', 'GET', '/home', null, 401);
  await check('anonyme', 'POST', '/public/books', { title: 'x' }, 405);
});

test('compte sans lien avec la bibliotheque : refuse', async () => {
  await check('etranger', 'GET', '/books', null, 403);
  await check('etranger', 'GET', '/settings', null, 403);
  await check('etranger', 'POST', '/books', { title: 'x' }, 403);
});

test('lecteur : catalogue en lecture seule et ses statuts', async () => {
  await check('lecteur', 'GET', '/books', null, 200);
  await check('lecteur', 'GET', `/books/${bookId}`, null, 200);
  await check('lecteur', 'GET', '/settings', null, 200);
  await check('lecteur', 'GET', '/members', null, 200);
  await check('lecteur', 'PUT', `/books/${bookId}/status`, { reading: 'to_read' }, 200);
  await check('lecteur', 'POST', `/books/${bookId}/readers`, {}, 200);
  await check('lecteur', 'GET', '/stats/overview', null, 200);
  await check('lecteur', 'GET', '/kobo/devices', null, 200);
  for (const [method, path, body] of [
    ['POST', '/books', { title: 'x' }], ['PUT', `/books/${bookId}`, { title: 'x' }], ['DELETE', `/books/${bookId}`],
    ['GET', '/borrowers'], ['GET', '/loans'], ['POST', '/loans', { code: 'BIB-00001', borrowerName: 'x' }],
    ['GET', '/export/copies.csv'], ['POST', '/books/bulk-delete', { ids: [bookId] }], ['POST', '/categories', { name: 'x' }],
    ['PUT', '/settings', { loanDays: 5 }], ['POST', '/empty', { confirm: 'Test' }], ['GET', '/Borrowers'], ['GET', '/borrowers/'],
  ]) await check('lecteur', method, path, body, 403);
  const b = await check('lecteur', 'GET', `/books/${bookId}`, null, 200);
  assert.equal(b.body.history, undefined, 'pas d\'historique des prets pour un lecteur');
  assert.equal(b.body.notes, undefined);
});

test('bibliothecaire : catalogue et prets, pas les reglages', async () => {
  await check('bibliothecaire', 'GET', '/borrowers', null, 200);
  await check('bibliothecaire', 'GET', '/loans', null, 200);
  const b = await check('bibliothecaire', 'POST', '/books', { title: 'Ajout du bibliothecaire' }, 200);
  await check('bibliothecaire', 'DELETE', `/books/${b.body.id}`, null, 200);
  // Seule exception aux reglages : le format de planche des etiquettes.
  await check('bibliothecaire', 'PUT', '/settings', { labelLayout: { cols: 3 } }, 200);
  for (const [method, path, body] of [
    ['PUT', '/settings', { loanDays: 5 }],
    ['PUT', '/settings', { labelLayout: { cols: 3 }, loanDays: 5 }],
    ['POST', '/settings/logo', { dataUrl: 'data:image/png;base64,AAAA' }],
    ['DELETE', '/settings/logo'],
    ['POST', '/empty', { confirm: 'Test' }],
    ['POST', '/copies/renumber', { prefix: 'X' }],
    ['PUT', '/values/series', { from: 'a', name: 'b' }],
    ['POST', '/values/series/merge', { ids: ['a'], name: 'b' }],
    ['POST', '/values/series/delete', { name: 'a' }],
  ]) await check('bibliothecaire', method, path, body, 403);
});

test('reglages : la casse et le / final ne contournent pas la garde', async () => {
  for (const [method, path, body] of [
    ['PUT', '/Settings', { loanDays: 7 }], ['PUT', '/settings/', { loanDays: 7 }], ['PUT', '/SETTINGS', { loanDays: 7 }],
    ['POST', '/Empty', { confirm: 'Test' }], ['POST', '/empty/', { confirm: 'Test' }],
    ['POST', '/Copies/Renumber', { prefix: 'X' }], ['POST', '/copies/renumber/', { prefix: 'X' }],
    ['PUT', '/Values/series', { from: 'a', name: 'b' }], ['POST', '/Settings/Logo', { dataUrl: 'x' }],
  ]) {
    const r = await who('bibliothecaire').call(method, `${ctx.api}${path}`, body);
    assert.ok([403, 404].includes(r.status), `bibliothecaire ${method} ${path} -> ${r.status}`);
  }
  const s = await check('admin', 'GET', '/settings', null, 200);
  assert.notEqual(s.body.loanDays, 7);
  const n = await check('admin', 'GET', '/books', null, 200);
  assert.ok(n.body.total >= 1, 'la bibliotheque n\'a pas ete videe');
});

test('gestionnaire : reglages de sa bibliotheque, pas l\'administration', async () => {
  await check('gestionnaire', 'PUT', '/settings', { loanDays: 21 }, 200);
  await check('gestionnaire', 'POST', '/empty', { confirm: 'mauvais nom' }, 400);
  await check('gestionnaire', 'PUT', '/values/series', { from: 'a', name: 'b' }, 200);
  const r = await ctx.users.gestionnaire.get('/api/admin/users');
  assert.equal(r.status, 403);
  assert.equal((await ctx.anonyme.get('/api/admin/users')).status, 401);
  assert.equal((await ctx.admin.get('/api/admin/users')).status, 200);
});

test('CSRF : un formulaire classique est refuse', async () => {
  const r = await ctx.admin.call('POST', `${ctx.api}/books`, undefined,
    { raw: 'title=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
  const t = await ctx.admin.call('POST', `${ctx.api}/books`, undefined, { raw: '{"title":"x"}', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(t.status, 415);
});

test('liseuses : un lecteur ne gere que la sienne', async () => {
  const scan = (c, serial) => c.call('POST', `${ctx.api}/kobo/scan`, undefined, {
    raw: koboDb([{ id: 'file:///mnt/onboard/livre.epub', title: 'Livre de test', author: 'Anne Onyme', status: 2, percent: 100 }]),
    headers: { 'Content-Type': 'application/x-sqlite3', 'X-Kobo-Version': encodeURIComponent(`${serial},3.0.35+,4.38.21908,3.0.35+,3.0.35+,00000000-0000-0000-0000-000000000388`) },
  });
  const mine = await scan(ctx.users.lecteur, 'N4181234567890');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const id = mine.body.id;
  assert.equal(mine.body.owner.id, ctx.users.lecteur.id);
  const item = (await check('lecteur', 'GET', `/kobo/devices/${id}`, null, 200)).body.items[0];

  // Un autre lecteur : lecture possible, aucune modification.
  await check('lecteur2', 'GET', `/kobo/devices/${id}`, null, 200);
  await check('lecteur2', 'PUT', `/kobo/devices/${id}`, { name: 'Vol' }, 403);
  await check('lecteur2', 'POST', `/kobo/devices/${id}/pushed`, { bookId, path: 'x.epub' }, 403);
  await check('lecteur2', 'POST', `/kobo/items/${item.id}/link`, { bookId: null }, 403);
  await check('lecteur2', 'DELETE', `/kobo/items/${item.id}`, null, 403);
  await check('lecteur2', 'DELETE', `/kobo/devices/${id}`, null, 403);
  await check('lecteur2', 'GET', `/kobo/devices/${id}/backups`, null, 403);
  await check('lecteur2', 'GET', `/kobo/devices/${id}/backups/${id}-20260101-120000.sqlite`, null, 403);
  await check('lecteur2', 'GET', `/kobo/devices/${id}/db/0123456789abcdef`, null, 403);
  await check('lecteur2', 'POST', `/kobo/devices/${id}/db/applied`, { covers: [item.id] }, 403);
  await check('lecteur2', 'POST', `/kobo/items/${item.id}/removed`, {}, 403);
  await check('lecteur', 'GET', `/kobo/books/${bookId}/annotations`, null, 200);
  await check('lecteur', 'GET', `/kobo/devices/${id}/backups`, null, 200);
  await check('lecteur', 'GET', `/kobo/devices/${id}/db/0123456789abcdef`, null, 404);
  assert.equal((await scan(ctx.users.lecteur2, 'N4181234567890')).status, 403);

  // Le proprietaire renomme sa liseuse mais ne la donne pas a un autre compte.
  await check('lecteur', 'PUT', `/kobo/devices/${id}`, { name: 'Ma liseuse', userId: ctx.users.lecteur2.id }, 200);
  const d = (await check('lecteur', 'GET', `/kobo/devices/${id}`, null, 200)).body;
  assert.equal(d.name, 'Ma liseuse');
  assert.equal(d.owner.id, ctx.users.lecteur.id);

  // Le statut « Lu » de la liseuse est celui du proprietaire, pas d'un autre compte.
  const st = (await check('lecteur2', 'GET', `/books/${bookId}`, null, 200)).body;
  assert.equal(st.myStatus.reading, null);

  // Bibliothecaire : gestion de toutes les liseuses.
  await check('bibliothecaire', 'PUT', `/kobo/devices/${id}`, { userId: ctx.users.lecteur2.id }, 200);
  await check('bibliothecaire', 'DELETE', `/kobo/devices/${id}`, null, 200);
});

test('invitation : role du lien, jamais administrateur', async () => {
  const inv = await ctx.admin.post('/api/admin/invitations', { libraryId: ctx.lib.id, role: 'admin', days: 2 });
  assert.equal(inv.status, 200);
  assert.equal(inv.body[0].role, 'user');
  const c = client();
  const r = await c.post(`/api/invitations/${inv.body[0].token}`, { username: 'invite', password: 'mot-de-passe-invite' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'user');
  assert.equal((await c.get(`${ctx.api}/books`)).status, 200);
  assert.equal((await c.post(`${ctx.api}/books`, { title: 'x' })).status, 403);
  assert.equal((await client().post('/api/invitations/jeton-inconnu-0123456789', { username: 'a', password: 'mot-de-passe' })).status, 404);
});
