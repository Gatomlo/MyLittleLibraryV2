# Bibliothèques du navigateur

Fichiers copiés tels quels depuis leurs paquets npm (aucune modification), servis par l'application :
ils ne sont plus des dépendances du serveur, qui n'en a pas besoin pour fonctionner.

| Fichier | Paquet | Version | Licence | Usage |
|---|---|---|---|---|
| `barcode-detector.js` | barcode-detector (`dist/iife/ponyfill.js`) | 3.2.2 | MIT | Scanner (QR, codes-barres) |
| `zxing_reader.wasm` | zxing-wasm (`dist/reader/`) | 3.1.3 | MIT | Moteur du scanner |
| `quagga.min.js` | @ericblade/quagga2 (`dist/`) | 1.12.1 | MIT | Scanner ISBN de secours |
| `read-excel-file.min.js` | read-excel-file (`bundle/`) | 9.3.10 | MIT | Import de fichiers .xlsx |
| `jszip.min.js` | jszip (`dist/`) | 3.10.2 | MIT | Liseuse epub |
| `epub.min.js` | epubjs (`dist/`) | 0.3.93 | BSD-2-Clause | Liseuse epub |

Mise à jour : `npm pack <paquet>@<version>` dans un dossier temporaire, copier le fichier indiqué,
mettre ce tableau à jour, puis vérifier le scanner, l'import Excel et la liseuse.
