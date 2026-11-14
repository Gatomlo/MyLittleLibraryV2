// Pont avec la connexion centralisee de node-gateway : req.gateway (pose par la passerelle) ouvre une
// session locale COURTE pour le compte de meme e-mail (sinon meme identifiant), sans jamais creer de
// compte. Hors passerelle : inchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { start, stop, client, PASSWORD } = require('./helpers');
const express = require('express');
const app = require('../server');

let bridge, base;
const gw = (login, email, role = 'member') => ({ 'x-test-gateway': JSON.stringify({ app: 'bibliotheque', role, user: { login, name: login, email, isSuper: false } }) });
const status = (headers = {}) => fetch(base + '/api/auth/status', { headers });

test.before(async () => {
  await start();
  try {
    const r = await client().post('/api/auth/setup', { username: 'admin', password: PASSWORD, libraryName: 'Test' });
    assert.ok(r.status < 300, 'setup ' + r.status);
    const outer = express();
    outer.use((req, res, next) => { const h = req.get('x-test-gateway'); if (h) req.gateway = JSON.parse(h); next(); });
    outer.use('/biblio', app);
    bridge = http.createServer(outer);
    await new Promise((r2) => bridge.listen(0, r2));
    base = `http://127.0.0.1:${bridge.address().port}/biblio`;
  } catch (e) { await stop(); throw e; }
});
test.after(async () => { if (bridge) bridge.close(); await stop(); });

test('identifiant de la passerelle -> compte local de meme identifiant (session courte, limitee au chemin)', async () => {
  const r = await status(gw('ADMIN', null));
  assert.equal(r.status, 200);
  assert.equal(((await r.json()).user || {}).username, 'admin');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /Path=\/biblio\//);
  assert.match(cookie, /Max-Age=7200\b/);
  assert.match(cookie, /HttpOnly/);
});

test('aucun compte cree : inconnu, anonyme ou sans droit => pas connecte', async () => {
  for (const h of [gw('inconnu', 'inconnu@exemple.be'), {}, { 'x-test-gateway': JSON.stringify({ app: 'bibliotheque', role: null, user: { login: 'admin', email: null } }) }]) {
    assert.equal((await (await status(h)).json()).user, null);
  }
  assert.equal(require('../lib/db').db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
});

test('crochet gatewayAccounts : liste des comptes pour l\'administration de la passerelle, sans aucun secret', () => {
  const list = app.gatewayAccounts();
  assert.ok(Array.isArray(list) && list.length >= 1, 'au moins un compte');
  for (const a of list) {
    assert.ok(a.key, 'cle a saisir dans « compte local »');
    assert.doesNotMatch(JSON.stringify(a), /hash|passw|token|secret|scrypt|bcrypt/i);
  }
});
