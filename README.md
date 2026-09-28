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
- **Comptes** : administrateurs (créent bibliothèques et comptes, gèrent tout),
  gestionnaires (gèrent les bibliothèques auxquelles ils sont liés, étiquettes et réglages compris)
  et utilisateurs (mêmes outils que les gestionnaires, sans les étiquettes ni les réglages). Bibliothèque par
  défaut ouverte à la connexion ; le menu du compte permet de basculer.
  La racine du site n'affiche que la page de connexion.
- **Catalogue public** (lecture seule, sans connexion) : recherche, filtre par
  catégorie et disponibilité, fiche détaillée.
- **Fiche livre** : titre, sous-titre, auteurs, éditeur, année, pagination, ISBN,
  résumé, couverture, catégories, notes internes (visibles une fois connecté).
- **Couvertures** : envoi d'une image / photo, ou bouton « Chercher en ligne » (Open Library,
  Google Books, Amazon par ISBN, titre et auteur ; autres éditions proposées ; collage d'une URL).
- **Ajout par ISBN** : scan du code-barres (webcam ou caméra du téléphone), saisie de
  l'ISBN ou encodage manuel. Recherche dans la BnF, Open Library et Google Books (résumés des livres francophones aussi via leslibraires.fr).
  Sans ISBN : titre et auteur tapés dans la recherche, ou bouton « Titre + auteur » (ceux de la fiche) →
  liste des éditions (BnF, Google Books) à choisir ; l'ISBN cité dans le fichier epub est proposé en premier.
- **Scan en série** (page Ajout multiple, depuis « Ajouter ») : caméra ouverte en continu (ou lecteur USB),
  chaque code-barres lu s'ajoute à une liste avec miniature et titre ; toutes les
  fiches sont créées en une fois. Dans « Ajouter », un ISBN complet lance la
  recherche tout seul.
- **Options par bibliothèque** (Réglages > Fonctionnalités) : livres numériques (exemplaire « numérique »
  — epub, pdf… — seul ou en plus des exemplaires papier, sans code, étiquette ni prêt ;
  à l'import : Type = Papier, Numérique ou Papier + numérique ; fichier epub facultatif, lisible dans la
  liseuse intégrée ; droits réglés pour toute la bibliothèque — voir le fichier, le lire en ligne, le
  télécharger — chacun pour tout le monde, les comptes, les gestionnaires ou les administrateurs ; import de
  plusieurs fichiers epub : Ajout multiple > Fichiers epub ; ISBN lu dans les métadonnées ou, à défaut, dans la page de copyright), **liseuses Kobo** (branchées en USB : liste
  de leurs livres avec fiche / fichier présents dans la bibliothèque, création ou rattachement de fiche avec
  copie du fichier, statuts de lecture du propriétaire, envoi de livres avec série et tome ; copie directe
  sur la liseuse avec Chrome, téléchargement avec Firefox ; suppression d'un livre de la liseuse avec Chrome) et statuts de lecture
  par compte (À lire / En cours / Lu / Abandonné, Aimé / Pas aimé, note sur 5 étoiles),
  affichés et filtrables dans le catalogue de gestion.
- **Lecteurs** d'un livre : les comptes membres qui le lisent, le liront ou l'ont lu
  (bibliothèque familiale partagée). Bouton « Intéressé » sur la fiche pour soi ; les
  autres lecteurs se cochent dans « Modifier ». Un changement de statut ne retire jamais
  un lecteur. Le compte qui ajoute un livre en devient lecteur ; l'ajout d'un livre et
  l'import proposent de cocher les lecteurs, et la colonne « Lecteurs » d'un fichier est
  prioritaire. Filtres « Mes livres » et « Lecteur » dans le catalogue, modification en
  masse, colonne dans l'export.
- **Catégories** et **tags** (option par bibliothèque) : recherche, regroupement
  alphabétique repliable, fusion de plusieurs termes (les livres suivent), filtres
  avec recherche dans le catalogue.
- **Classement** (Réglages, une page à onglets) : catégories, tags, auteurs, séries, éditeurs
  et collections — rechercher, renommer, fusionner, supprimer (les fiches sont mises à jour).
- **Collection** (de l'éditeur, récupérée via l'ISBN quand la BnF / Open Library la
  connaissent) et **Série + tome**, indépendants : « 60 jours et après » est dans la
  collection Pocket Science-fiction et tome 3 de la série Capital code. Filtre par série
  trié par tome (catalogue et WordPress : `filtres="...,series,..."`).
- **Sélection multiple** dans le catalogue (bouton Sélectionner, ou appui long sur une
  couverture ; puis clic sur les couvertures ou « Tout sélectionner » = le filtre en cours)
  pour **modifier en masse** (série, collection, catégories et tags ajoutés/retirés, version
  numérique, statut de lecture et avis, avec confirmation) ou supprimer ;
  **Réglages > Vider la bibliothèque** (sauvegarde automatique de la base avant).
- **Import** : catégories et tags choisis parmi les existants ; les nouveaux livres
  peuvent être marqués « À lire » pour soi (coché par défaut).
- **Filtres du catalogue** au choix (Réglages > Affichage du catalogue : recherche, catégories,
  collections, tags, disponibilité, papier/numérique, mes livres, lecteur, compte des statuts, statut de lecture, avis, tri — chacun indépendant), en haut
  ou dans une colonne à gauche. Même choix pour le catalogue WordPress (générateur de
  shortcode : `filtres="..."`, `position="gauche"`). Réglages présentés en accordéon.
- **Miniatures du catalogue** paramétrables (Réglages > Affichage du catalogue) : couverture, titre,
  auteurs, série et tome, collection, catégories, tags, statut de lecture, note (étoiles), disponibilité, bandeau « Numérique »
  en travers de la couverture.
- **Statuts de lecture** (option) : À lire, En cours, Lu, Abandonné + Aimé / Pas aimé
  + note de 1 à 5 étoiles (filtre « Note » du catalogue : n étoiles et plus, pas noté),
  avec dates de début, de fin et d'abandon (automatiques, corrigeables).
- **Statistiques** (option par bibliothèque, page « Statistiques ») :
  - par compte : livres lus / en cours / abandonnés, pages, rythme mensuel comparé à
    l'année précédente, objectif annuel, durées et pages par jour, lectures qui
    traînent, goûts (catégories, tags, auteurs, séries), notes (moyenne, répartition, mieux notés) ;
  - privées par défaut, partageables avec les membres de la bibliothèque ; les
    administrateurs n'y ont pas d'accès particulier ;
  - bibliothèque : lecture en totaux anonymes, prêts (par mois, durée, plus empruntés,
    jamais empruntés…), note moyenne et livres les mieux notés, fonds (croissance, catégories).
- **Rapport d'import** filtrable par statut (ajoutés, ignorés, erreurs, non importés),
  avec copie des ISBN en erreur et nouvel essai des erreurs.
- **ISBN** : ISBN-13 (978/979), ISBN-10, avec ou sans tirets/espaces, reconnus à la
  saisie, au scan (EAN-13), à l'import et dans la recherche du catalogue.
- **Import** (page Ajout multiple, depuis « Ajouter ») : liste d'ISBN (fiches complétées automatiquement,
  exemplaires créés) ou fichier `.xlsx` / `.csv` avec une colonne par champ
  (correspondance des colonnes détectée et modifiable, aperçu, progression).
  Modèles à télécharger ; en `.xlsx`, la colonne ISBN est au format Texte pour
  qu'Excel ne la transforme pas en notation scientifique.
  Option « ISBN déjà au catalogue › Mettre à jour la fiche » (fichier complet) : les
  colonnes remplies du fichier écrasent celles de la fiche existante (repérée par la
  colonne « ID fiche » des exports, sinon par l'ISBN) ; aucun exemplaire créé.
- **Export** (Réglages > Exporter) : inventaire `.xlsx` / `.csv`, une ligne par livre
  avec tous les champs, le nombre d'exemplaires et leurs codes — mêmes colonnes que
  l'import (+ « ID fiche »), donc réimportable (y compris dans une autre bibliothèque).
- **Fiches incomplètes** (Ajout multiple ou Réglages) : livres sans catégorie, ISBN,
  couverture, auteur, éditeur, année, pages, résumé, tag ou emplacement d'exemplaire,
  avec leur nombre ; bouton « Compléter » (retour à la liste après enregistrement) ou
  ouverture dans le catalogue pour une sélection en masse. Export Excel / CSV des
  fiches de l'onglet, à corriger puis réimporter en « Mettre à jour la fiche ».
  « Compléter tout » relance la recherche pour tous les livres de l'onglet (seules
  les informations vides sont complétées) : ISBN lu dans le fichier epub, sinon retrouvé par titre + auteur seulement
  si une seule édition correspond, catégorie attribuée seulement si une catégorie
  existante correspond aux sujets en ligne. Emplacement et tags : cases à cocher et
  attribution en masse.
- **Fiche livre** : après changement d'ISBN, bouton « Écraser la fiche » pour remplacer
  toutes les informations par celles du nouvel ISBN.
- **Aides** : les explications de l'interface sont dans des info-bulles (icône « ? »).
- **Téléphone** : interface adaptée (menu, filtres du catalogue repliables, zones
  tactiles), installable sur l'écran d'accueil en application plein écran
  (bouton « Installer » de l'en-tête quand le navigateur le propose, ou menu du compte >
  « Installer l'application » ; sur iPhone : Safari > Partager > « Sur l'écran d'accueil »).
  Nécessite **https** : depuis un téléphone sur le réseau local en http, le navigateur
  ne fait qu'un raccourci qui s'ouvre dans un onglet.
- **Interface** : thème coloré (police Nunito, couleur par page, icônes dans le menu et
  devant les titres), clair ou sombre selon l'appareil. Un manifeste par bibliothèque (nom et page de départ).
- **Exemplaires** : chaque exemplaire a un code unique (`BIB-00001`…), un
  emplacement et son étiquette.
- **Prêts** : scan du QR de l'étiquette → prêter (emprunteur choisi ou créé à la
  volée) ou enregistrer le retour. Historique par livre et par emprunteur.
- **Emprunteurs** : formulaire de création ouvert à la demande, champ libre « Informations ».
- **Téléphone** : Sélectionner, Ajout multiple et Ajouter un livre masqués dans le catalogue
  (ajout via le menu, sélection par appui long).
- **Étiquettes** (menu du compte) : planches A4 (Avery L7160, L7159, L7163, L7651, 70×37…, ou format
  personnalisé), QR code + code + titre + nom et logo de la bibliothèque, case de
  départ pour réutiliser une planche entamée.
- **Réglages** (menu du compte), en trois groupes :
  *Bibliothèque* (nom, logo et en-tête ; fonctionnalités ; codes des exemplaires),
  *Catalogue* (affichage, catégories, tags, fiches incomplètes, intégration site web),
  *Données* (export, vider la bibliothèque).
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
| `GOOGLE_BOOKS_API_KEY` | Clé Google Books (gratuite) : sans elle, le quota anonyme est souvent épuisé et seules BnF/Open Library répondent. Peut aussi être saisie dans **Administration › Google Books** (prioritaire, avec guide pas à pas). |

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
