# Interface (modules ES)

L'interface est une application à page unique, sans framework ni étape de construction : le navigateur
charge directement ces fichiers (`<script type="module" src="…/app/main.js">` dans `index.html`).

| Fichier | Contenu |
|---|---|
| `etat.js` | Configuration injectée par le serveur (`window.MLL`), état (`state`), rôles, données passées d'une page à l'autre (`pending`) |
| `utilitaires.js` | `$`, `esc`, `hint`, `api` / `gapi`, `toast`, dates, images, fenêtres modales (accessibilité) |
| `scanner.js` | Caméra : QR code des étiquettes et codes-barres ISBN (`vendor/barcode-detector.js`, `vendor/quagga.min.js`) |
| `entete.js`, `icones.js` | En-tête, navigation, menu du compte ; icônes SVG (`icon(nom)`, `iconText`) |
| `routage.js` | Table des routes (`#/…`), droits par route, `onLeave` / `leavePage` |
| `accueil-site.js` | Racine du site : liste des bibliothèques |
| `accueil.js` | Accueil personnalisé d'une bibliothèque (`#/home`) |
| `catalogue.js`, `fiche-livre.js`, `livre-formulaire.js` | Catalogue et filtres (et aides partagées : `combo` liste avec recherche, `memberPicker` choix de plusieurs comptes, `accordionize` sections repliables), fiche d'un livre, ajout et modification |
| `exemplaire.js`, `prets.js`, `emprunteurs.js` | Page d'un exemplaire (cible du QR code), prêts, emprunteurs |
| `import-suivi.js`, `import.js`, `incompletes.js`, `etiquettes.js` | Suivi des imports (historique local, fiches à vérifier), ajout multiple et import de fichiers, fiches incomplètes, étiquettes |
| `kobo.js`, `liseuse-epub.js` | Liseuses Kobo (USB), lecture des epub en ligne (`vendor/epub.min.js`) |
| `souhaits.js`, `statistiques.js` | Listes de souhaits, statistiques de lecture |
| `connexion.js`, `compte.js`, `administration.js`, `reglages.js` | Connexion et invitations, mon compte (sections repliables, dont Mes partages : statistiques et liste de souhaits), administration du site, réglages d'une bibliothèque |
| `installation.js`, `main.js` | Installation sur l'écran d'accueil ; démarrage (point d'entrée) |

## Règles

- **Imports et exports** : ce qu'un module utilise d'un autre est importé en tête de fichier ; ce qu'il
  offre aux autres est listé dans `export { … }` en fin de fichier. `npm run lint` signale un import
  oublié (`no-undef`) ou inutile (`no-unused-vars`).
- **Ordre d'exécution** : la première ligne de chaque module importe celui qui le précède
  (`import './utilitaires.js';` dans `scanner.js`, etc., jusqu'à `main.js`). Les modules s'importent
  les uns les autres en cercle (une page en ouvre une autre) ; cette chaîne fixe l'ordre dans lequel ils
  s'exécutent, celui du tableau de `index.html`. **Un nouveau module s'insère dans la chaîne** : il
  importe son prédécesseur, et son successeur l'importe.
- **Variables partagées** : un module ne peut pas réaffecter une variable importée. Une valeur modifiée
  depuis plusieurs modules est une propriété d'un objet (`state`, `pending`) ou passe par une fonction
  du module qui la possède (`onLeave`, `forgetMembers`).
- **Pas de script ni de gestionnaire en ligne** (`onclick="…"`, `onerror="…"`) : la politique de contenu
  de la page (CSP, `lib/security.js`) les bloque. Utiliser `addEventListener`, ou `data-onerror` pour une
  image introuvable (voir `utilitaires.js`).
- **Tout texte venant des données passe par `esc()`** avant d'être inséré dans du HTML.
- **Fichiers servis sous `/_v/<version>/`** (gardés en cache par le navigateur) : `ASSETS` (dans `etat.js`)
  pour charger un fichier de `vendor/`. La version change dès qu'un fichier de `public/` change.
