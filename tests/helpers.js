// Outils des tests d'API : une instance de l'app sur des donnees temporaires (jamais
// data/), et un petit client HTTP qui garde le cookie de session.
// A charger AVANT tout module de l'app : MLL_DATA_DIR est lu au chargement de lib/db.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mll-test-'));
process.env.MLL_DATA_DIR = DATA_DIR;
process.env.MLL_TEST = '1';

const app = require('../server');

let server = null;
let base = '';

async function start() {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  // Bases encore ouvertes (Windows) : le dossier temporaire est supprime si possible.
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* fichiers verrouilles */ }
}

// Client avec cookie de session. call(method, path, body, { headers, raw }) renvoie
// { status, body, headers } ; body est l'objet JSON (ou le texte si ce n'en est pas).
function client() {
  let cookie = '';
  async function call(method, url, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (opts.raw !== undefined) payload = opts.raw;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      if (pair.startsWith('mll_session=')) cookie = pair.endsWith('=') ? '' : pair;
    }
    let out;
    if (opts.buffer) out = Buffer.from(await res.arrayBuffer());
    else {
      const text = await res.text();
      try { out = JSON.parse(text); } catch (e) { out = text; }
    }
    return { status: res.status, body: out, headers: res.headers };
  }
  return {
    get: (url, opts) => call('GET', url, undefined, opts),
    post: (url, body, opts) => call('POST', url, body === undefined ? {} : body, opts),
    put: (url, body, opts) => call('PUT', url, body === undefined ? {} : body, opts),
    del: (url, opts) => call('DELETE', url, undefined, opts),
    call,
  };
}

const PASSWORD = 'mot-de-passe-test';

// Premier demarrage : administrateur + bibliotheque « Test » (adresse /test), puis un
// compte par role de bibliotheque. Renvoie les clients connectes.
async function setup() {
  await start();
  const admin = client();
  const r = await admin.post('/api/auth/setup', { username: 'admin', password: PASSWORD, libraryName: 'Test' });
  if (r.status !== 200) throw new Error(`setup : ${r.status} ${JSON.stringify(r.body)}`);
  const lib = r.body.library;
  const users = {};
  for (const [name, role] of [['gestionnaire', 'manager'], ['bibliothecaire', 'librarian'], ['lecteur', 'user'], ['lecteur2', 'user']]) {
    const c = await admin.post('/api/admin/users', { username: name, password: PASSWORD, role: 'user', libraries: [{ id: lib.id, role }] });
    if (c.status !== 200) throw new Error(`compte ${name} : ${c.status}`);
    users[name] = { id: c.body.id, ...(await login(name)) };
  }
  // Compte sans lien avec la bibliotheque.
  const c = await admin.post('/api/admin/users', { username: 'etranger', password: PASSWORD, role: 'user', libraries: [] });
  users.etranger = { id: c.body.id, ...(await login('etranger')) };
  return { admin, lib, api: `/${lib.slug}/api`, users, anonyme: client() };
}

async function login(username, password = PASSWORD) {
  const c = client();
  const r = await c.post('/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`connexion ${username} : ${r.status}`);
  return c;
}

module.exports = { app, DATA_DIR, PASSWORD, start, stop, client, setup, login, base: () => base };
