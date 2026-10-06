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
- **Comptes** : administrateurs (créent bibliothèques et comptes, gèrent tout). Pour les autres comptes, le rôle
  est propre à chaque bibliothèque (on peut être gestionnaire de l'une et lecteur d'une autre) :
  gestionnaire (tout dans la bibliothèque, réglages compris),
  bibliothécaire (catalogue, ajouts, prêts, emprunteurs et étiquettes, sans les réglages)
  ou lecteur (catalogue en lecture seule, avec ses statuts de lecture, souhaits, statistiques et liseuse ;
  ni ajout ni prêt). **Liens d'invitation** (Administration › Comptes) : un lien par bibliothèque et par rôle,
  valable 7, 30 ou 90 jours ; la personne choisit son identifiant et son mot de passe (ou rejoint avec son compte). Mon compte en sections repliables : bibliothèque par défaut, Mes lectures (objectifs de l'année, délai), Mes partages (statistiques avec personne, tous ou certains membres ; liste de souhaits), mot de passe ; choix de plusieurs comptes (lecteurs d'un livre, partages) par une liste déroulante avec recherche dans « Mon compte ». Bibliothèque par
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
  télécharger — chacun pour tout le monde, les comptes, les gestionnaires ou les administrateurs ; ajout d'un livre
  depuis un fichier epub : Ajouter un livre > Depuis un epub (fiche pré-remplie à vérifier), ou fichier joint à la case Version numérique ; plusieurs fichiers : Ajout multiple > Fichiers epub, par vagues (nouveaux fichiers ajoutés à la file pendant l'envoi) ; ISBN lu dans les métadonnées ou, à défaut, dans la page de copyright), **liseuses Kobo** (branchées en USB : liste
  de leurs livres avec fiche / fichier présents dans la bibliothèque, création (une par une, ou « Créer les N fiches » pour les livres affichés, à vérifier ensuite dans le suivi des imports) ou rattachement de fiche avec
  copie du fichier, statuts de lecture du propriétaire, envoi de livres dont toutes les métadonnées et la couverture sont remplacées par celles de la fiche (série et tome compris), livres modifiés depuis l'envoi mis à jour (« Mettre à jour N livres », sauf ceux commencés sur la liseuse, dont la progression serait perdue) ; l'appli n'accède à la liseuse que pendant une action (scan, envoi, suppression) ; liseuse branchée retrouvée à l'ouverture de la page : scan et mise à jour automatiques ; « Sélectionner » sur la page de la liseuse branchée : plusieurs livres supprimés de la liseuse ou mis à jour d'après leur fiche en une fois ; paramètres d'une liseuse (nom, propriétaire, kepub, collections, écriture) dans le menu du compte, section Liseuses ; bouton « Terminer » (enregistre en une fois les changements dans la liseuse et la libère, avant de l'éjecter dans Windows) ; base lue en retard relue automatiquement avant toute écriture ; un nouveau livre reçoit sa série et ses collections au branchement suivant son import ; option par liseuse « Écrire les informations des fiches dans la liseuse » (Chrome) : titre, auteurs, résumé, série et tome écrits dans la base de la Kobo (onglet Séries), mises à jour sans perte de progression, base saine gardée à chaque scan (10 dernières, téléchargement et restauration), livres retirés aussi effacés de la base de la liseuse, collections Kobo d'après les catégories et / ou tags ; envoi au format kepub (option de la liseuse) ; surlignages et notes de la liseuse affichés sur la fiche (« Mes surlignages ») ; progression des livres en cours (pourcentage du dernier scan) à côté du statut « En cours », dans le catalogue et sur la fiche ; copie directe
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
- **Filtres du catalogue** au choix (Réglages > Affichage du catalogue : recherche, bouton « Scanner » un ISBN à côté de la recherche, catégories,
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
    l'année précédente, objectifs de l'année (livres, pages, pile « À lire » maximale, catégories différentes, séries terminées ; réglés dans Mon compte, suivis aussi dans la carte Objectif de l'accueil), durées et pages par jour, lectures qui
    traînent, goûts (catégories, tags, auteurs, séries), notes (moyenne, répartition, mieux notés) ; un clic sur « Livres lus » ou sur un statut de la répartition affiche la liste des livres concernés ;
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
- **Suivi des imports** (bas de la page Ajout multiple) : historique commun aux scans, fiches créées depuis une liseuse,
  listes d'ISBN, fichiers et epub, gardé dans le navigateur (partagé entre onglets) jusqu'à
  effacement ; on peut importer par vagues et vérifier les fiches des précédentes en même
  temps. Filtres À vérifier / En cours / Erreurs / Vérifiées, bouton Vérifier (retour au
  suivi après enregistrement, fiche cochée), ✓ pour cocher sans ouvrir, « Retirer les vérifiées ».
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
  emplacement et son étiquette. « Transférer » (fenêtre Modifier de l'exemplaire) le
  déplace, avec son code et ses prêts, vers une autre fiche (erreur d'étiquetage, fiche
  en double) ; la fiche d'origine vidée peut être supprimée dans la foulée.
- **Prêts** : scan du QR de l'étiquette → prêter (emprunteur choisi ou créé à la
  volée) ou enregistrer le retour. Historique par livre et par emprunteur.
- **Bouton Scanner** (en-tête ; Réglages > Exemplaires et prêts > Bouton Scanner) : lit le QR de
  l'étiquette, le code-barres ISBN ou les deux, et ouvre au choix le prêt de l'exemplaire ou la
  fiche du livre. ISBN + prêt : exemplaire unique ouvert directement, sinon choix parmi les
  exemplaires papier (disponibles en premier).
- **Retour express** : un exemplaire prêté scanné (ou « Retour » dans les listes) ouvre une fenêtre
  « Enregistrer le retour » / « Retour + scanner le suivant » pour enchaîner les retours.
- **Dates de retour** : durée par défaut (Réglages > Exemplaires et prêts > Durée des prêts, 0 = aucune),
  modifiable au prêt, « Prolonger » sur la page de l'exemplaire ; onglet « En retard » de la page Prêts
  et pastille rouge sur le lien Prêts de l'en-tête.
- **Rappels de retour** (Réglages > Exemplaires et prêts > Rappels de retour) : bouton « Relancer » sur chaque
  prêt en cours et sur la fiche d'un emprunteur (tous ses livres dans un message) ; il ouvre un e-mail prêt à
  envoyer dans la messagerie de l'appareil (mailto, rien n'est envoyé sans toi), puis « Noter la relance ».
  Mode « Programmés » : onglet « À relancer » de la page Prêts (un message par emprunteur) et pastille, à partir
  de la date de retour + J jours (négatif = avant), puis tous les 7 jours tant que le livre est en retard.
  Objet et message personnalisables ({nom}, {livres}, {bibliotheque}, {date_retour}). Sans e-mail : copie du message.
- **ISBN inconnu au scan** : proposition d'ajouter le livre (fiche pré-remplie par l'ISBN) ou de l'ajouter à ses souhaits.
- **Accueil personnalisé** (lien « Accueil », page d'arrivée d'un compte connecté ; visiteur : catalogue) :
  cartes À faire (prêts à relancer ou en retard, retours de la semaine, réservations prêtes, souhaits des
  membres, étiquettes, fiches incomplètes), Mes lectures en cours (progression Kobo), Pour moi (livres ajoutés
  ces 30 jours dont on est lecteur, par exemple ses souhaits, et ceux redevenus disponibles), Échéances des prêts, Mes souhaits, Nouveautés, Objectif
  de lecture, Suite de mes séries (tome suivant présent et pas encore lu), Ma pile à lire (disponibles d'abord),
  À noter (lus sans note, étoiles cliquables), Une idée de lecture (livre disponible non lu, de préférence dans ses
  catégories préférées, bouton « Autre idée »), Ma liseuse Kobo (dernier scan, envois en attente, livres non reliés) ;
  bibliothécaires et gestionnaires : Souhaits les plus demandés (regroupés par livre, « Très envie » d'abord, ajout au catalogue en un
  clic pour tous les membres concernés) et Activité de la semaine (prêts, retours, ajouts, emprunteurs vs semaine
  précédente). Chaque compte choisit ses cartes et leur ordre (menu du compte > « Personnaliser l'accueil », par bibliothèque). Sur
  smartphone : tuiles résumées sur une seule colonne (toutes les tâches à faire, au plus 3 titres par liste, chiffre seulement pour l'objectif), les 6 premières puis « Voir tout » ; une tuile ouvre la page. Catalogue sur smartphone : une fiche par ligne, couverture à gauche.
- **Souhaits** (lien « Souhaits », tout compte connecté) : liste de livres souhaités propre à chaque compte
  (hors bibliothèque) ; ajout par ISBN (tapé ou scanné) ou par titre (choix de l'édition), notes, « Très envie » (cœur cliquable dans la liste,
  filtre « Très envie seulement », aussi appliqué à l'export).
  Couverture cherchée en ligne quand la recherche par ISBN n'en donne pas ; un clic sur l'image permet d'en choisir ou d'en photographier une.
  Partage de sa liste avec d'autres comptes (lecture seule). Les bibliothécaires et gestionnaires d'une bibliothèque voient les
  souhaits de ses membres (compte choisi dans une liste déroulante avec recherche, ou toutes les listes), les ajoutent au catalogue en un clic (fiche pré-remplie, le membre coché comme
  lecteur ; à l'enregistrement, le souhait est retiré de sa liste) et exportent en .xlsx / .csv les souhaits d'un ou plusieurs membres
  (colonnes compatibles avec l'import). Pas d'état « acquis » : un souhait est dans la liste, ajouté à la
  bibliothèque (et retiré) ou supprimé. Badge « Déjà dans la bibliothèque » (même ISBN ou même titre).
- **Accessibilité** : lien « Aller au contenu », focus clavier visible, fenêtres utilisables au clavier (Échap,
  tabulation contenue, focus rendu), titre de l'onglet et focus mis à jour à chaque page, page active annoncée.
- **Réservations** : un compte connecté réserve, au nom d'un emprunteur (choisi ou créé), un livre dont tous
  les exemplaires sont prêtés (fiche du livre) ; au retour d'un exemplaire, alerte « à mettre de côté pour … »
  avec « Prêter à … » ; le prêt à cet emprunteur retire sa réservation. Réservation refusée pour un emprunteur qui a déjà un exemplaire
  de ce livre en prêt.
  Un exemplaire libre d'un livre réservé est mis de côté (un par réservation) : état « Réservé » au lieu de
  « Disponible » (catalogue, fiche, widget WordPress ; nom de l'emprunteur visible seulement en gestion), exclu du
  filtre « Disponibles », emprunteur pré-rempli sur la page de prêt de l'exemplaire. Onglet « Réservations » de la page
  Prêts, réservations visibles sur la fiche de l'emprunteur.
- **Emprunteurs** : formulaire de création ouvert à la demande, champ libre « Informations ». Fiche d'un
  emprunteur : prêts en cours (retards), historique, « Prêter un livre » (scanner avec l'emprunteur pré-rempli,
  « Prêter un autre livre à … » pour enchaîner).
- **Catalogue** : boutons flottants (icônes) Ajouter et Sélectionner, toujours sur téléphone,
  et sur ordinateur / tablette dès que l'en-tête sort de l'écran ; Ajout multiple depuis la page
  Ajouter. Vue liste au choix dès 600 px de large (ordinateur, tablette, téléphone en paysage ; bouton
  à côté de Sélectionner, gardé dans le navigateur) : tableau, un livre par ligne, colonnes
  choisies dans Réglages > Affichage du catalogue (indépendamment de la miniature), tri en
  cliquant sur l'en-tête (titre, auteur, éditeur, année, note, date d'ajout).
- **Étiquettes** (menu du compte) : planches A4 (Avery L7160, L7159, L7163, L7651, 70×37…, ou format
  personnalisé), QR code + code + titre + nom et logo de la bibliothèque, case de
  départ pour réutiliser une planche entamée ; étiquettes de tranche au choix (code seul,
  écrit verticalement, de bas en haut, de haut en bas ou une lettre par ligne, avec leur
  propre format de planche et leur propre liste d'attente, indépendante de celle des
  étiquettes complètes). « Vider la liste » (onglet En attente) retire tous les livres de
  la liste d'attente du type choisi sans imprimer. « Tout remettre à imprimer » (onglet En
  attente) remet tous les exemplaires papier dans la liste d'attente, codes inchangés
  (impression par lots de 500).
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

## Développement

```bash
npm test             # tests d'API (node:test) sur des données temporaires : droits, parcours, protections
npm run lint         # ESLint : variable inconnue, import oublié ou inutile
node scripts/demo.js # instance jetable avec comptes et livres d'exemple : http://localhost:3100/demo/
```

Les tests et la démonstration n'utilisent jamais `data/`. En production, `npm install --omit=dev`
suffit (ESLint n'y sert pas). Organisation du code : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ;
interface : [public/app/README.md](public/app/README.md).

## Monter dans la passerelle (dev local)

```powershell
New-Item -ItemType Junction -Path "C:\Users\thoma\ClaudeIA\node-gateway\apps\mylittlelibrary" -Target "C:\Users\thoma\ClaudeIA\MyLittleLibraryV2"
```

L'app est alors servie sur `/mylittlelibrary`. Côté navigateur, le chemin de montage est
fourni par le serveur (`window.MLL.root`, lu dans `public/app/etat.js`). Le cookie
de session est limité à ce chemin.

## Configuration (variables d'environnement)

| Variable | Rôle |
| --- | --- |
| `PORT` | Port en mode autonome (3000 par défaut). |
| `MLL_DATA_DIR` | Dossier des données (`data/` par défaut) : `central.db` + un dossier par bibliothèque dans `libraries/` (voir Données). |
| `MLL_FRAME_ANCESTORS` | Sites autorisés à afficher l'app dans un cadre (adresses séparées par des espaces, `*` pour tous). Par défaut : l'app elle-même et Microsoft Teams. |
| `MLL_CSP` | `report` : la politique de contenu signale les violations dans la console sans rien bloquer ; `off` : aucune politique. À n'utiliser que pour diagnostiquer. |
| `MLL_ALLOW_LOCAL_FETCH` | `1` : autorise le téléchargement de couvertures depuis `localhost` (développement : réimport d'un export local). |
| `MLL_OFFLINE` | `1` : aucune recherche en ligne (ISBN, couvertures). Utilisé par les tests. |
| `GOOGLE_BOOKS_API_KEY` | Clé Google Books (gratuite) : sans elle, le quota anonyme est souvent épuisé et seules BnF/Open Library répondent. Peut aussi être saisie dans **Administration › Google Books** (prioritaire, avec guide pas à pas). |

## Sécurité

- **Droits** : visiteur (catalogue public), lecteur, bibliothécaire, gestionnaire, administrateur. La
  matrice complète est vérifiée par `tests/droits.test.js`.
- **Sessions** : mot de passe haché (scrypt), jeton de session haché en base, cookie `HttpOnly`.
  Huit échecs de connexion bloquent le compte visé 15 minutes ; changer son mot de passe ferme les
  autres sessions.
- **Page** : politique de contenu (CSP) avec nonce, aucun script en ligne ni CDN (scanner, liseuse et
  police Nunito sont servis par l'app depuis `public/vendor/` et `public/fonts/`).
- **Fichiers reçus** : images vérifiées (type, 5 Mo), couvertures par adresse limitées aux sites
  publics, epub et archives lus avec un plafond de décompression.
- **Exports CSV** : un texte commençant par `=`, `+`, `-` ou `@` est précédé d'une apostrophe
  (retirée à l'import) pour ne pas être exécuté comme une formule.

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
**Administration › Sauvegarde** :
- une archive `mylittlelibrary-<nom>.zip` par bibliothèque choisie, avec au choix
  la base, les fichiers epub et les couvertures (et le logo) ;
- restauration d'une archive : bibliothèque recréée, ou remplacée après
  confirmation si une bibliothèque porte déjà ce nom (seuls les éléments présents
  dans l'archive sont remplacés ; copie de la base actuelle dans
  `libraries/<n°>/backups/library-avant-import-….db`). Les comptes sont retrouvés
  par leur identifiant ; statuts et lecteurs d'un compte absent sont retirés ;
- zip de toutes les bases (centrale + bibliothèques, sans les fichiers).

Chaque mois, tant qu'aucune sauvegarde n'a été faite, les administrateurs voient un
rappel : **Sauvegarder** (ouvre l'onglet), **Reporter** (reproposé à la prochaine
connexion ou ouverture de l'app) ou **Passer ce mois-ci**.

```
data/
  central.db                  comptes, sessions, réglages globaux, bibliothèques et leurs réglages
  libraries/<n°>/library.db   livres, exemplaires, prêts, emprunteurs, catégories, tags, statuts, liseuses
  libraries/<n°>/media/       couvertures et logo
  libraries/<n°>/ebooks/      fichiers epub
  libraries/<n°>/backups/     sauvegardes faites avant un vidage ou une restauration
  backups/                    sauvegarde de l'ancienne base unique
```

Le n° est l'identifiant de la bibliothèque (il ne change pas avec son adresse).
Supprimer une bibliothèque supprime son dossier.

Les bases sont migrées automatiquement au démarrage. Une ancienne base unique
(`data/library.db`, images dans `data/media`, epub dans `data/ebooks`) est
d'abord sauvegardée dans `data/backups/library-avant-separation-….db`, puis
séparée en base centrale + un dossier par bibliothèque.
