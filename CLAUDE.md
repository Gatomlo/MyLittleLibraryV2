# MyLittleLibraryV2

Gestion de bibliothèques (catalogue, prêts, étiquettes QR, import/export, stats, epub, liseuses Kobo) — Node.js ≥ 22.5 + SQLite (`node:sqlite`), Express 4, front SPA en modules ES sans framework ni build.
Utilisateur francophone : interface, commentaires et réponses **en français**. Commentaires de code sans accents (style existant).

**Détail complet : `docs/ARCHITECTURE.md`** (architecture, modèle, points non évidents, sécurité) et `public/app/README.md` (interface). Ne lire que la partie utile à la tâche.

## Déploiement / passerelle
- Montée dans `C:\Users\thoma\ClaudeIA\node-gateway` : jonction `apps/mylittlelibrary` → ce dossier, servie sur `http://localhost:3000/mylittlelibrary/`. Prod : Infomaniak (même passerelle).
- `server.js` exporte `app` ; `app.listen` seulement si lancé directement (`PORT`, défaut 3000).
- Redémarrer la passerelle locale : tuer le process sur le port 3000 (TaskStop ne suffit pas toujours), puis `npm start` dans node-gateway.
- Déploiement : envoyer `lib/`, `public/` (et `server.js`, `package.json`, `package-lock.json` si modifiés, puis `npm install --omit=dev`), **jamais `data/`**, puis redémarrer Node. Les migrations s'appliquent seules au démarrage.

## Fichiers clés
- `server.js` : en-têtes de sécurité, compression, fichiers versionnés `/_v/<empreinte>/`, API globale (`/api/auth`, `/api/me`, `/api/admin`), page `index.html` (`sendIndex`), montage `/:slug/…`.
- `lib/db.js` : base **centrale** `data/central.db` (comptes, sessions, bibliothèques et leurs réglages) + **une base par bibliothèque** `data/libraries/<id>/library.db` (centrale attachée, pas de clé étrangère entre bases). `db` suit le contexte `inLibrary(id, fn)`. Migrations : `CENTRAL_MIGRATIONS` / `LIBRARY_MIGRATIONS` (`PRAGMA user_version`).
- `lib/library-api.js` : routeur d'une bibliothèque et **gardes d'accès** ; `lib/library/catalog.js` (lecture), `fiches.js` (écriture), `routes-*.js` (une par domaine).
- `lib/auth.js` (scrypt, sessions, rôles `admin` / par bibliothèque `manager` · `librarian` · `user`), `lib/security.js` (CSP), `lib/net.js` (téléchargements sûrs), `lib/zip.js` (zip plafonnés), `lib/util.js`.
- Autres domaines : `lib/wishes.js`, `home.js`, `stats.js`, `kobo.js`, `ebooks.js`, `epub-meta.js`, `archives.js`, `invitations.js`, `isbn.js`, `covers.js`, `media.js`.
- `public/app/*.js` (interface, entrée `main.js`), `public/style.css`, `public/vendor/` (scanner, Excel, liseuse epub), `public/embed.js` + `wordpress/` (widget catalogue).

## Règles à respecter
- Droits : route de gestion derrière les gardes ; réservée aux gestionnaires → middleware `config` **sur la route** (jamais un test sur le chemin) ; ouverte aux lecteurs → `READER_GET` / `READER_WRITE`. Ajouter la route à `tests/droits.test.js`.
- Adresse fournie par un utilisateur : `fetchPublic` + `readBody`. Zip reçu : `lib/zip.js`. Texte affiché : `esc()`. Pas de script ni de `onclick="…"` en ligne (CSP).
- Interface : jamais de paragraphe explicatif → `hint(texte)` ; boutons courts sur smartphone (`iconText`, `hide-mobile` / `show-mobile`).
- `copies.format` = `physical` | `ebook` : le numérique n'a ni code, ni étiquette, ni prêt. Auteurs, séries, éditeurs, collections : valeurs libres des fiches (pas de table).

## Commandes
- `npm test` (API sur données temporaires) · `npm run lint` · `node scripts/demo.js` (instance jetable, port 3100, `/demo/`) · `npm run set-password -- <identifiant> <mot de passe>`.

## Méthode de travail
- **Avant toute migration** : tester sur une copie (`VACUUM INTO` de `data/central.db` et des `data/libraries/*/library.db` vers un dossier temporaire, instance `MLL_DATA_DIR=<dossier> PORT=3100 node server.js`), puis sauvegarder les vraies bases dans `data/backups/` ou `data/libraries/<id>/backups/`.
- Ne jamais lancer l'app sur `data/` pour un essai : `node scripts/demo.js` ou `MLL_DATA_DIR`.
- Tester d'abord par l'API (`npm test`, ou curl avec corps JSON écrit dans un fichier : les accents passés en argument sous Git Bash sont mal encodés, et les `\\` des heredocs sont divisés par deux). Vérification visuelle seulement si l'interface change beaucoup.
- Après chaque modification : `npm run lint` et `npm test`.
- Commit + push après chaque fonctionnalité validée (dépôt GitHub privé Gatomlo/MyLittleLibraryV2), mettre à jour `README.md` si la fonctionnalité est visible, `docs/ARCHITECTURE.md` si l'architecture change.
- Réponses à l'utilisateur : courtes, en français, avec les instructions de déploiement quand le serveur ou la base changent.
