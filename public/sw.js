// Service worker minimal : rend l'application installable (ecran d'accueil du
// telephone) sans rien mettre en cache (les donnees restent toujours a jour).
// Hors connexion, une page d'explication remplace l'erreur du navigateur.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const OFFLINE_PAGE = `<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Hors connexion</title>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fbf8f3;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center">
<div><h1 style="font-size:20px">Pas de connexion</h1><p>La bibliothèque a besoin d'Internet pour fonctionner.</p>
<button onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#0f8b6d;color:#fff">Réessayer</button></div></body></html>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() =>
    new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
