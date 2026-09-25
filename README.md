# MyLittleLibraryV2

Gestion de la bibliothèque du bureau : catalogue public, fiches complètes des livres,
ajout par scan du code-barres ISBN, prêts et retours, étiquettes A4 avec QR code.

Node.js (≥ 22.5) + Express + SQLite (`node:sqlite` intégré à Node : aucun module
natif à compiler). Compatible avec la passerelle [node-gateway](../node-gateway) :
`server.js` exporte l'app Express et n'appelle `app.listen()` que lancé directement.

## Fonctionnalités

- **Plusieurs bibliothèques**, chacune avec son adresse construite depuis son nom
  (`…/mylittlelibrary/bibliotheque-du-bureau/`), ses livres, exemplaires, codes,
  emprunteurs, nom, logo et réglages d'étiquettes. L'adresse est fixée à la création
  (modifiable par un administrateur ; l'ancienne reste redirigée).
- **Comptes** : administrateurs (créent bibliothèques et comptes, gèrent tout) et
  gestionnaires (gèrent les bibliothèques auxquelles ils sont liés). Bibliothèque par
  défaut ouverte à la connexion ; le menu du compte permet de basculer.
  La racine du site n'affiche que la page de connexion.
- **Catalogue public** (lecture seule, sans connexion) : recherche, filtre par
  catégorie et disponibilité, fiche détaillée.
- **Fiche livre** : titre, sous-titre, auteurs, éditeur, année, pagination, ISBN,
  résumé, couverture, catégories, notes internes (visibles une fois connecté).
- **Couvertures** : envoi d'une image / photo, ou bouton « Chercher en ligne » (Open Library,
  Google Books, Amazon par ISBN, titre et auteur ; autres éditions proposées ; collage d'une URL).
- **Ajout par ISBN** : scan du code-barres (webcam ou caméra du téléphone), saisie de
  l'ISBN ou encodage manuel. Recherche dans la BnF, Open Library et Google Books.
- **Scan en série** (page Importer) : caméra ouverte en continu (ou lecteur USB),
  chaque code-barres lu s'ajoute à une liste avec miniature et titre ; toutes les
  fiches sont créées en une fois. Dans « Ajouter », un ISBN complet lance la
  recherche tout seul.
- **Options par bibliothèque** (Réglages) : livres numériques (sans exemplaire,
  étiquette ni prêt) et statuts de lecture par compte (À lire / Lu, Aimé / Pas aimé),
  affichés et filtrables dans le catalogue de gestion.
- **Catégories** et **tags** (option par bibliothèque) : recherche, regroupement
  alphabétique repliable, fusion de plusieurs termes (les livres suivent), filtres
  avec recherche dans le catalogue.
- **Collection / série** et numéro dans la collection : récupérés via l'ISBN quand la
  BnF / Open Library les connaissent ; filtre du catalogue trié par numéro.
- **Filtres du catalogue** au choix (Réglages > Catalogue : recherche, catégories,
  collections, tags, disponibilité, papier/numérique, statuts de lecture, tri), en haut
  ou dans une colonne à gauche. Même choix pour le catalogue WordPress (générateur de
  shortcode : `filtres="..."`, `position="gauche"`). Réglages présentés en accordéon.
- **Statuts de lecture** (option) : À lire, En cours, Lu, Abandonné + Aimé / Pas aimé,
  avec dates de début, de fin et d'abandon (automatiques, corrigeables).
- **Statistiques** (option par bibliothèque, page « Statistiques ») :
  - par compte : livres lus / en cours / abandonnés, pages, rythme mensuel comparé à
    l'année précédente, objectif annuel, durées et pages par jour, lectures qui
    traînent, goûts (catégories, tags, auteurs, collections) ;
  - privées par défaut, partageables avec les membres de la bibliothèque ; les
    administrateurs n'y ont pas d'accès particulier ;
  - bibliothèque : lecture en totaux anonymes, prêts (par mois, durée, plus empruntés,
    jamais empruntés…), fonds (croissance, catégories, collections).
- **Rapport d'import** filtrable par statut (ajoutés, ignorés, erreurs, non importés),
  avec copie des ISBN en erreur et nouvel essai des erreurs.
- **ISBN** : ISBN-13 (978/979), ISBN-10, avec ou sans tirets/espaces, reconnus à la
  saisie, au scan (EAN-13), à l'import et dans la recherche du catalogue.
- **Import** (page Importer) : liste d'ISBN (fiches complétées automatiquement,
  exemplaires créés) ou fichier `.xlsx` / `.csv` avec une colonne par champ
  (correspondance des colonnes détectée et modifiable, aperçu, progression).
  Modèles à télécharger ; en `.xlsx`, la colonne ISBN est au format Texte pour
  qu'Excel ne la transforme pas en notation scientifique.
- **Export** (Réglages > Données) : inventaire `.xlsx` / `.csv`, une ligne par livre
  avec tous les champs, le nombre d'exemplaires et leurs codes — mêmes colonnes que
  l'import, donc réimportable (y compris dans une autre bibliothèque).
- **Exemplaires** : chaque exemplaire a un code unique (`BIB-00001`…), un
  emplacement et son étiquette.
- **Prêts** : scan du QR de l'étiquette → prêter (emprunteur choisi ou créé à la
  volée) ou enregistrer le retour. Historique par livre et par emprunteur.
- **Étiquettes** : planches A4 (Avery L7160, L7159, L7163, L7651, 70×37…, ou format
  personnalisé), QR code + code + titre + nom et logo de la bibliothèque, case de
  départ pour réutiliser une planche entamée.
- **Réglages** : nom et logo de la bibliothèque, préfixe des codes, catégories,
  mot de passe, export CSV, sauvegarde de la base.
- **Intégration WordPress / Divi** : shortcode `[bibliotheque]` (extension dans
  `wordpress/`) ou snippet HTML.

## Lancer seul

```bash
npm install
npm start
```

Puis ouvrir http://localhost:3000. Au premier accès, la page propose de créer le
compte administrateur et la première bibliothèque (possible uniquement tant qu'aucun
compte n'existe). Créer un compte administrateur / changer un mot de passe en ligne
de commande :

```bash
npm run set-password -- <identifiant> <mot-de-passe>
```

## Monter dans la passerelle (dev local)

```powershell
New-Item -ItemType Junction -Path "C:\Users\thoma\ClaudeIA\node-gateway\apps\mylittlelibrary" -Target "C:\Users\thoma\ClaudeIA\MyLittleLibraryV2"
```

L'app est alors servie sur `/mylittlelibrary`. Côté navigateur, tous les chemins sont
relatifs et les appels passent par la constante `BASE` de `public/app.js`. Le cookie
de session est limité à ce chemin.

## Configuration (variables d'environnement)

| Variable | Rôle |
| --- | --- |
| `PORT` | Port en mode autonome (3000 par défaut). |
| `MLL_DATA_DIR` | Dossier des données (`data/` par défaut) : `library.db` + `media/` (couvertures, logo). |
| `GOOGLE_BOOKS_API_KEY` | Clé Google Books (gratuite) : sans elle, le quota anonyme est souvent épuisé et seules BnF/Open Library répondent. |

## Scan et https

La caméra n'est accessible au navigateur qu'en **https** (ou sur `localhost`). En
production chez Infomaniak le site est en https : rien à faire. Sans caméra, le
scanner propose la saisie manuelle ou l'analyse d'une photo.

Le QR des étiquettes contient l'adresse de l'exemplaire (`…/mylittlelibrary/#/c/BIB-00001`) :
scanné avec l'appareil photo d'un téléphone, il ouvre directement la fiche (prêt/retour
si connecté). Les étiquettes doivent donc être imprimées depuis l'adresse définitive
de l'app.

## WordPress / Divi 5

1. Zipper le dossier `wordpress/mylittlelibrary-catalogue` et l'installer comme
   extension (Extensions > Ajouter > Téléverser).
2. Placer le shortcode donné dans Réglages de la bibliothèque, par ex.
   `[bibliotheque url="https://exemple.be/mylittlelibrary/bibliotheque-du-bureau"]`,
   dans un module Texte ou Code. Options : `par_page="24"`, `entete="non"`.
   (Réglages > Bibliothèque dans WordPress permet de définir une adresse par défaut.)

Le catalogue est rendu dans un Shadow DOM (le thème ne le déforme pas) et interroge
l'API publique `/api/public/*` (lecture seule, CORS ouvert).

## Données

Tout est dans `data/` (ignoré par git) : sauvegarder ce dossier, ou utiliser
Administration > Sauvegarde. La base est migrée automatiquement au démarrage
(les données d'une installation à une seule bibliothèque deviennent la première
bibliothèque ; les anciens comptes deviennent administrateurs).
