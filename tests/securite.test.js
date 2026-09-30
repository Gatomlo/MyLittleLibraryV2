// Protections : en-tetes, connexion, sessions, fichiers pieges.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { app, setup, stop, client, login, PASSWORD } = require('./helpers');
const { epub } = require('./fixtures');

let ctx;
before(async () => { ctx = await setup(); });
after(stop);

test('page : politique de contenu, nonce du script, pas d\'en-tete Express', async () => {
  const r = await ctx.anonyme.get(`/${ctx.lib.slug}/`);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp);
  assert.ok(nonce, csp);
  assert.ok(r.body.includes(`<script nonce="${nonce[1]}">window.MLL = `));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
  assert.match(csp, /frame-ancestors 'self' https:\/\/teams\.microsoft\.com/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.ok(!r.body.includes('fonts.googleapis.com'), 'aucune police chargee chez Google');
  assert.ok(!/ on(error|click|load)="/.test(r.body), 'aucun gestionnaire en ligne');
  // Un autre nonce a chaque page.
  const again = await ctx.anonyme.get(`/${ctx.lib.slug}/`);
  assert.notEqual(/'nonce-([^']+)'/.exec(again.headers.get('content-security-policy'))[1], nonce[1]);
  // L'API porte aussi nosniff.
  assert.equal((await ctx.anonyme.get(`${ctx.api}/public/settings`)).headers.get('x-content-type-options'), 'nosniff');
});

test('fichiers de l\'interface : adresse versionnee gardee en cache, reponses compressees', async () => {
  const page = (await ctx.anonyme.get('/')).body;
  const assets = /href="([^"]+)\/style\.css"/.exec(page)[1];
  assert.match(assets, /^\/_v\/[0-9a-f]{10}$/);
  const css = await ctx.anonyme.get(`${assets}/style.css`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(css.status, 200);
  assert.match(css.headers.get('cache-control'), /immutable/);
  assert.match(css.headers.get('cache-control'), /max-age=31536000/);
  assert.equal(css.headers.get('content-encoding'), 'gzip');
  assert.equal((await ctx.anonyme.get(`${assets}/fonts/nunito-latin-wght-normal.woff2`, { buffer: true })).status, 200);
  assert.equal((await ctx.anonyme.get(`${assets}/vendor/jszip.min.js`)).status, 200);
  assert.equal((await ctx.anonyme.get('/sw.js')).headers.get('cache-control'), 'no-cache');
  const json = await ctx.admin.get(`${ctx.api}/books`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(json.status, 200);
});

test('montee sous un chemin (passerelle) : adresses et cookie prefixes', async () => {
  const parent = express();
  parent.use('/mylittlelibrary', app);
  const server = await new Promise((resolve) => { const s = parent.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/mylittlelibrary/${ctx.lib.slug}/`)).text();
    const config = JSON.parse(/window\.MLL = (.*);<\/script>/.exec(html)[1]);
    assert.equal(config.root, '/mylittlelibrary');
    assert.match(config.assets, /^\/mylittlelibrary\/_v\/[0-9a-f]{10}$/);
    for (const file of ['style.css', 'app/main.js', 'app/etat.js', 'vendor/epub.min.js']) {
      assert.equal((await fetch(`${base}${config.assets}/${file}`)).status, 200, file);
    }
    assert.ok(html.includes(`<script type="module" src="${config.assets}/app/main.js">`));
    const res = await fetch(`${base}/mylittlelibrary/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.getSetCookie().join(' '), /Path=\/mylittlelibrary\/; .*HttpOnly/);
    // Sans le prefixe, une redirection d'ancienne adresse reste sous le chemin de montage.
    const old = await fetch(`${base}/mylittlelibrary/${ctx.lib.slug}`, { redirect: 'manual' });
    assert.equal(old.headers.get('location'), `/mylittlelibrary/${ctx.lib.slug}/`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('nom de bibliotheque avec $ et balises : page intacte', async () => {
  const name = "Biblio $' et $& <script>alert(1)</script>";
  assert.equal((await ctx.admin.put(`${ctx.api}/settings`, { libraryName: name })).status, 200);
  const html = (await ctx.anonyme.get(`/${ctx.lib.slug}/`)).body;
  assert.equal(html.split('</head>').length, 2, 'un seul </head>');
  assert.ok(!html.includes('<script>alert(1)'));
  const config = JSON.parse(/window\.MLL = (.*);<\/script>/.exec(html)[1]);
  assert.equal(config.library.name, name);
  await ctx.admin.put(`${ctx.api}/settings`, { libraryName: 'Test' });
});

test('changement de mot de passe : les autres sessions sont fermees', async () => {
  const here = ctx.users.lecteur2;
  const elsewhere = await login('lecteur2');
  assert.equal((await elsewhere.get('/api/auth/status')).body.user.username, 'lecteur2');
  assert.equal((await here.post('/api/me/password', { current: 'faux', password: 'nouveau-mot-de-passe' })).status, 400);
  assert.equal((await here.post('/api/me/password', { current: PASSWORD, password: 'nouveau-mot-de-passe' })).status, 200);
  assert.equal((await here.get('/api/auth/status')).body.user.username, 'lecteur2', 'session en cours conservee');
  assert.equal((await elsewhere.get('/api/auth/status')).body.user, null);
  assert.equal((await client().post('/api/auth/login', { username: 'lecteur2', password: PASSWORD })).status, 401);
  assert.equal((await client().post('/api/auth/login', { username: 'lecteur2', password: 'nouveau-mot-de-passe' })).status, 200);
});

test('connexion : un compte attaque est bloque, pas les autres', async () => {
  const c = client();
  const attempts = await Promise.all(Array.from({ length: 8 }, () => c.post('/api/auth/login', { username: 'Lecteur', password: 'faux' })));
  assert.ok(attempts.every((r) => r.status === 401));
  assert.equal((await c.post('/api/auth/login', { username: 'lecteur', password: PASSWORD })).status, 429);
  assert.equal((await client().post('/api/auth/login', { username: 'gestionnaire', password: PASSWORD })).status, 200);
  assert.equal((await client().post('/api/auth/login', { username: 'inconnu', password: 'faux-mot-de-passe' })).status, 401);
});

test('invitation : creations de compte limitees par lien', async () => {
  const inv = (await ctx.admin.post('/api/admin/invitations', { libraryId: ctx.lib.id, role: 'user' })).body[0];
  const results = [];
  for (let i = 0; i < 21; i++) results.push((await client().post(`/api/invitations/${inv.token}`, { username: `rafale${i}`, password: 'mot-de-passe-long' })).status);
  assert.deepEqual(results.slice(0, 20), Array(20).fill(200));
  assert.equal(results[20], 429);
});

test('epub piege (contenu demesure une fois decompresse) : import sans saturer la memoire', async () => {
  await ctx.admin.put(`${ctx.api}/settings`, { features: { ebooks: true } });
  // 60 Mo de zeros : quelques dizaines de Ko dans l'archive.
  const bomb = await epub({ opf: Buffer.alloc(60 * 1024 * 1024) });
  assert.ok(bomb.length < 500 * 1024);
  const before = process.memoryUsage().rss;
  const r = await ctx.admin.call('POST', `${ctx.api}/import/epub`, undefined,
    { raw: bomb, headers: { 'Content-Type': 'application/epub+zip', 'X-File-Name': encodeURIComponent('Titre du fichier.epub') } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.title, 'Titre du fichier', 'metadonnees illisibles : nom du fichier');
  assert.ok(process.memoryUsage().rss - before < 50 * 1024 * 1024, 'le contenu n\'a pas ete decompresse en memoire');
});

test('image envoyee : type et taille verifies', async () => {
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
  assert.equal((await ctx.admin.post(`${ctx.api}/books`, { title: 'x', coverData: svg })).status, 400);
  assert.equal((await ctx.admin.post(`${ctx.api}/settings/logo`, { dataUrl: svg })).status, 400);
});
