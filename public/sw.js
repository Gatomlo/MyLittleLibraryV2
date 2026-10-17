// Service worker : application installable et consultation hors connexion.
//  - pages : reseau d'abord, copie gardee en repli (l'app s'ouvre sans reseau) ;
//  - fichiers de l'interface /_v/<version>/ : cache d'abord (adresse immuable), les
//    anciennes versions sont supprimees quand une nouvelle page est recue ;
//  - lectures de l'API (GET JSON) et couvertures : reseau d'abord, copie en repli, donc
//    seules les pages deja consultees sont disponibles hors connexion ;
//  - ecritures : jamais gardees, elles echouent hors connexion.
// Le cache des donnees est vide a la connexion et a la deconnexion (autre compte sur
// le meme appareil) et quand le serveur repond 401.
const SHELL = 'mll-shell-v1';
const DATA = 'mll-data-v1';
const MEDIA = 'mll-media-v1';
const MEDIA_MAX = 800;
const ROOT = new URL(self.registration.scope).pathname.replace(/\/$/, '');
// Jamais gardes : administration, exports, sauvegardes, liseuses, fichiers et etiquettes.
const NEVER = /\/api\/(admin|auth\/(reset|password))|\/(export|backup|backups|kobo|file|download|labels)(\/|\?|$)/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const keep = [SHELL, DATA, MEDIA];
  await Promise.all((await caches.keys()).filter((k) => k.startsWith('mll-') && !keep.includes(k)).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

const OFFLINE_PAGE = `<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Hors connexion</title>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fbf8f3;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center">
<div><h1 style="font-size:20px">Pas de connexion</h1><p>Cette page n'a pas encore été consultée sur cet appareil.</p>
<button onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#0f8b6d;color:#fff">Réessayer</button></div></body></html>`;
const offlinePage = () => new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
}

// Page : copie gardee sous son adresse sans parametres ; les fichiers d'anciennes
// versions de l'interface sont supprimes.
async function page(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      const copy = res.clone();
      const version = ((await copy.clone().text()).match(/\/_v\/([0-9a-f]+)\//) || [])[1];
      await cache.put(request.url.split('?')[0].split('#')[0], copy);
      if (version) {
        for (const k of await cache.keys()) {
          const m = new URL(k.url).pathname.match(/\/_v\/([0-9a-f]+)\//);
          if (m && m[1] !== version) await cache.delete(k);
        }
      }
    }
    return res;
  } catch (e) {
    return (await cache.match(request.url.split('?')[0].split('#')[0])) || offlinePage();
  }
}

async function asset(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

async function data(request, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(request);
    if (res.status === 401) await caches.delete(DATA);
    else if (res.ok && res.status === 200 && (name === MEDIA || (res.headers.get('content-type') || '').includes('json'))) {
      await cache.put(request, res.clone());
      if (name === MEDIA) trim(MEDIA, MEDIA_MAX);
    }
    return res;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(`${ROOT}/`)) return;
  const rel = url.pathname.slice(ROOT.length + 1);
  const isApi = /^(api|[^/]+\/api)\//.test(rel);
  if (req.method !== 'GET') {
    // Connexion, deconnexion, creation de compte...: le cache des donnees appartenait a l'ancien compte.
    if (isApi && /api\/auth\//.test(rel)) event.respondWith(fetch(req).finally(() => caches.delete(DATA)));
    return;
  }
  if (req.headers.has('range')) return;
  if (req.mode === 'navigate') return event.respondWith(page(req));
  if (rel.startsWith('_v/')) return event.respondWith(asset(req));
  if (NEVER.test(url.pathname)) return;
  if (isApi) return event.respondWith(data(req, DATA));
  if (/^[^/]+\/media\//.test(rel)) event.respondWith(data(req, MEDIA));
});
