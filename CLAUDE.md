# MyLittleLibraryV2

Gestion de bibliothèques (catalogue, prêts, étiquettes QR, import/export, stats) — Node.js ≥ 22.5 + SQLite (`node:sqlite`), Express 4, front SPA sans framework ni build.
Utilisateur francophone : interface, commentaires et réponses **en français**. Commentaires de code sans accents (style existant).

## Déploiement / passerelle
- Montée dans `C:\Users\thoma\ClaudeIA\node-gateway` : jonction `apps/mylittlelibrary` → ce dossier, servie sur `http://localhost:3000/mylittlelibrary/`. Prod : Infomaniak (même passerelle).
- `server.js` exporte `app` ; `app.listen` seulement si lancé directement (`PORT`, défaut 3000).
- Redémarrer la passerelle locale : tuer le process sur le port 3000 (TaskStop ne suffit pas toujours), puis `npm start` dans node-gateway.
- Déploiement : envoyer `lib/`, `public/` (et `server.js` si modifié), **jamais `data/`**, puis redémarrer Node. Les migrations s'appliquent seules au démarrage.

## Architecture
- `server.js` : routes globales (`/api/auth/*`, `/api/me/*`, `/api/admin/*`), page `index.html` en gabarit (`{{ROOT}}`, `{{CONFIG}}`, `{{VERSION}}` = cache-busting), vendors (scanner, excel), montage `/:slug/…`.
- `lib/db.js` : base + **migrations** (`MIGRATIONS`, `PRAGMA user_version`, SQL ou fonction ; clés étrangères coupées pendant les migrations). Actuellement v15. `bookSearchText`, `nextCopyCode`, `slugify`.
- `lib/library-api.js` : API d'une bibliothèque (`/:slug/api/...`) : public (catalogue, fiche), puis garde « gestion » ; livres, exemplaires, prêts, emprunteurs, étiquettes, import, export, suppression en masse, vidage.
- PWA : `public/sw.js` (service worker sans cache, page hors connexion), manifeste dynamique par bibliothèque (`/:slug/manifest.webmanifest`, `sendManifest` dans server.js), icônes PNG dans `public/` (régénérer depuis `icon.svg` / `icon-maskable.svg` si le logo change).
- `lib/stats.js` (stats, confidentialité), `lib/auth.js` (scrypt, sessions, rôles admin/gestionnaire), `lib/isbn.js` (Google Books / BnF SRU / Open Library ; résumés FR en dernier recours via leslibraires.fr, 1 requête / 3 s — placedeslibraires.fr et Decitre bloquent l'hébergeur), `lib/covers.js` (recherche de couvertures), `lib/media.js`.
- Réglages globaux : table `settings` (clé/valeur, `getSetting`/`setSetting` dans db.js). Clé Google Books : `googleBooksKey()` = réglage `googleBooksApiKey` (Administration › Google Books), sinon `GOOGLE_BOOKS_API_KEY`.
- Interface : palette et composants dans `style.css` (variables `:root`, teintes `--sun/--coral/--sky/--grape/--rose` + `-soft`), police Nunito (Google Fonts). Textes d'aide : jamais de paragraphe explicatif, utiliser `hint(texte)` (icône « ? » + info-bulle, section Utilitaires) et des libellés courts. Icones SVG inline : section `Icones` de app.js (`icon(nom)`, `PAGE_COLORS`, `decorateTitle` ajoute la pastille des h1 selon l'adresse).
- `public/app.js` : SPA (routes en hash), sections repérables par `// ================= <Section> =================`. `public/embed.js` : widget catalogue WordPress (Shadow DOM). `wordpress/…/mylittlelibrary-catalogue.php` : plugin shortcode `[bibliotheque …]`.
- `data/` (non versionné) : `library.db`, `media/`, `backups/`.

## Modèle (points non évidents)
- Multi-bibliothèques : tout est filtré par `library_id` ; URL de bibliothèque = slug fixé à la création.
- `copies.format` = `physical` | `ebook` : l'exemplaire numérique n'a **pas de code, d'étiquette ni de prêt** (un seul par livre). `books.format` n'est plus utilisé.
- Livre : `collection` (éditeur) distincte de `series` + `series_number` (tome). `collection_number` n'est plus utilisé.
- Statuts de lecture par compte (`book_user_status`) : to_read / reading / read / abandoned + liked / disliked, avec dates.
- Lecteurs (`book_readers`, v15) : comptes membres liés à un livre, indépendants du statut (jamais retirés par un changement de statut). Tout membre peut ajouter ou retirer n'importe quel membre. Ajout d'un livre et import : le créateur par défaut, ou `readers` (identifiants, ou noms séparés par des virgules pour la colonne « Lecteurs »). En mise à jour par import, seule la colonne compte. Membres : `libraryMembers` (library-api.js). Les emprunteurs sont des personnes extérieures sans compte.
- Tags = vrais tags (thèmes libres). En v15, les tags qui portaient le nom d'un compte ont été convertis en lecteurs.
- Fiches incomplètes : `MISSING` (library-api.js, conditions SQL par champ) → `GET /books/missing` (comptes), filtre `missing=` de `/books` et de `/export/inventory.*`.
- Import `onDuplicate` : `copy` | `skip` | `new` | `update` (`updateFromImport` : colonnes non vides écrasent la fiche, repérée par `bookId` = colonne « ID fiche » de l'export, sinon ISBN).
- Auteurs, séries, éditeurs, collections : pas de table, valeurs libres des fiches (auteurs séparés par des virgules). Gestion via `/values/:kind` (`VALUE_FIELDS`, `rewriteValues`, casse ignorée) ; front : `categoryManager` (`TERM_KINDS`, `free`), onglets « Classement » des réglages.
- Options par bibliothèque : `enable_ebooks`, `enable_reading_status`, `enable_tags`, `enable_stats`, filtres et éléments des miniatures du catalogue (`catalog_filters`, `catalog_card` : JSON, NULL = tous).

## Méthode de travail
- **Avant toute migration** : tester sur une copie (`VACUUM INTO` de `data/library.db` vers un dossier temporaire, instance de test `MLL_DATA_DIR=<dossier> PORT=3100 node server.js`, compte jetable via `node scripts/set-password.js`), puis sauvegarder la vraie base dans `data/backups/library-avant-vNN.db`.
- Tester d'abord par l'API (curl avec corps JSON écrit dans un fichier : les accents passés en argument sous Git Bash sont mal encodés). Vérification visuelle seulement si l'interface change beaucoup.
- Grosses modifications de `app.js` : petits scripts Node de remplacement (texte exact) plutôt que `sed` ; `node --check` après chaque modification.
- Commit + push sur `main` après chaque fonctionnalité validée (dépôt GitHub privé Gatomlo/MyLittleLibraryV2), mettre à jour `README.md` si la fonctionnalité est visible.
- Réponses à l'utilisateur : courtes, en français, avec les instructions de déploiement quand le serveur ou la base changent.
