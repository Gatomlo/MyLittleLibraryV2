const express = require('express');
const path = require('path');

// Filet de securite : une erreur imprevue ne doit jamais faire tomber tout le serveur.
process.on('uncaughtException', (err) => console.error('Erreur non interceptee (ignoree) :', err));
process.on('unhandledRejection', (err) => console.error('Promesse rejetee non geree (ignoree) :', err));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API ----------
// Routes declarees sans prefixe de montage : quand la passerelle monte l'app avec
// app.use('/mylittlelibrary', app), Express retire le prefixe avant d'arriver ici.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Lance seul en developpement (node server.js) ; charge par la passerelle, on se
// contente d'exporter l'app, c'est elle qui ecoute sur le port.
if (require.main === module) {
  app.listen(PORT, () => console.log(`MyLittleLibrary disponible sur http://localhost:${PORT}`));
}

module.exports = app;
