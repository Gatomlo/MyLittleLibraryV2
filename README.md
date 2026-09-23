# MyLittleLibraryV2

Application Node.js (Express) de gestion d'une petite bibliothèque, compatible avec la
passerelle [node-gateway](../node-gateway) : `server.js` exporte l'app Express et
n'appelle `app.listen()` que lorsqu'il est lancé directement.

## Lancer seul

```bash
npm install
npm start
```

Puis ouvrir http://localhost:3000.

## Monter dans la passerelle (dev local)

```powershell
New-Item -ItemType Junction -Path "C:\Users\thoma\ClaudeIA\node-gateway\apps\mylittlelibrary" -Target "C:\Users\thoma\ClaudeIA\MyLittleLibraryV2"
```

L'app est alors servie sur `/mylittlelibrary`. Côté navigateur, tous les chemins sont
relatifs et les appels API passent par la constante `BASE` de `public/app.js`.
