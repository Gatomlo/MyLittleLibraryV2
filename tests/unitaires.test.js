// Fonctions isolees (sans serveur) : adresses autorisees, plafonds, CSV, cache.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { isPrivateAddress, assertPublicUrl, readBody } = require('../lib/net');
const { csvCell, ttlCache, limiter } = require('../lib/util');
const { readEntry, totalSize } = require('../lib/zip');

test('adresses privees reconnues', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'pas-une-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '193.190.1.1', '2a00:1450:4007:80e::200e', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('telechargement : seules les adresses http(s) publiques sont acceptees', async () => {
  for (const url of ['http://127.0.0.1:3000/x.png', 'http://localhost/x.png', 'http://[::1]/x.png', 'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'ftp://exemple.be/x', 'https://user:pass@8.8.8.8/x', 'pas une adresse']) {
    await assert.rejects(assertPublicUrl(url), (e) => e.status === 400, url);
  }
  assert.equal((await assertPublicUrl('https://8.8.8.8/x.png')).hostname, '8.8.8.8');
});

test('corps d\'une reponse : refuse au-dela du plafond', async () => {
  assert.equal((await readBody(new Response(Buffer.alloc(1000)), 1000)).length, 1000);
  await assert.rejects(readBody(new Response(Buffer.alloc(1001)), 1000), (e) => e.status === 400);
  await assert.rejects(readBody(new Response('x', { headers: { 'content-length': '999999' } }), 1000), (e) => e.status === 400);
});

test('entree zip : lecture plafonnee', async () => {
  const zip = new JSZip();
  zip.file('petit.txt', 'bonjour');
  zip.file('gros.bin', Buffer.alloc(3 * 1024 * 1024));
  const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  assert.equal((await readEntry(loaded.file('petit.txt'), 100)).toString(), 'bonjour');
  await assert.rejects(readEntry(loaded.file('gros.bin'), 1024 * 1024), (e) => e.status === 400);
  assert.equal(totalSize(loaded), 3 * 1024 * 1024 + 7);
});

test('cellule CSV : guillemets et formules', () => {
  assert.equal(csvCell('simple'), 'simple');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('dit "oui"'), '"dit ""oui"""');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(12), '12');
  assert.equal(csvCell('-12'), '-12');
  assert.equal(csvCell('+3,5'), '+3,5');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-cmd|x'), "'-cmd|x");
  assert.equal(csvCell('978-2-07-040850-4'), '978-2-07-040850-4');
});

test('cache : resultat partage, echec et resultat vide non gardes', async () => {
  const cache = ttlCache(1000, { keep: (v) => !!v });
  let calls = 0;
  const fn = async () => { calls++; return { n: calls }; };
  const [a, b] = await Promise.all([cache.wrap('k', fn), cache.wrap('k', fn)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  await cache.wrap('k', fn);
  assert.equal(calls, 1);
  let empty = 0;
  await cache.wrap('vide', async () => { empty++; return null; });
  await cache.wrap('vide', async () => { empty++; return null; });
  assert.equal(empty, 2);
  let fails = 0;
  await assert.rejects(cache.wrap('ko', async () => { fails++; throw new Error('x'); }));
  await assert.rejects(cache.wrap('ko', async () => { fails++; throw new Error('x'); }));
  assert.equal(fails, 2);
});

test('limiteur : fenetre glissante par cle', async () => {
  const l = limiter(40);
  l.hit('a'); l.hit('a'); l.hit('b');
  assert.equal(l.count('a'), 2);
  assert.equal(l.count('b'), 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(l.count('a'), 0);
});

test('kepub : phrases et images reperees, corps entoure, en-tete intact', () => {
  const { convertDocument } = require('../lib/kepub');
  const html = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Titre. Ici</title></head>'
    + '<body><h1>Chapitre</h1><p>Une phrase. Une autre ! <em>Mot</em></p><p><img src="a.jpg" alt="a > b"/></p></body></html>';
  const out = convertDocument(html);
  assert.ok(out.includes('<title>Titre. Ici</title>'));
  assert.ok(out.includes('<body><div id="book-columns"><div id="book-inner"><h1><span class="koboSpan" id="kobo.1.1">Chapitre</span></h1>'));
  assert.ok(out.includes('<span class="koboSpan" id="kobo.2.1">Une phrase.</span> <span class="koboSpan" id="kobo.2.2">Une autre !</span>'));
  assert.ok(out.includes('<em><span class="koboSpan" id="kobo.2.3">Mot</span></em>'));
  assert.ok(out.includes('<span class="koboSpan" id="kobo.3.1"><img src="a.jpg" alt="a > b"/></span>'));
  assert.ok(out.endsWith('</div></div></body></html>'));
  const ids = [...out.matchAll(/id="(kobo\.\d+\.\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(convertDocument(out), out); // deja converti : inchange
});
