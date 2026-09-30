// API d'UNE bibliotheque, montee sur /<adresse-de-la-bibliotheque>/api. Toutes les
// requetes sont limitees a la bibliotheque resolue (req.library) : une bibliotheque
// ne voit jamais les livres, exemplaires ou emprunteurs d'une autre.
// Ce fichier assemble le routeur : resolution de la bibliotheque, gardes d'acces, puis
// les routes de chaque domaine (lib/library/routes-*.js). Les requetes et utilitaires
// communs sont dans lib/library/catalog.js (lecture) et lib/library/fiches.js (ecriture).
const express = require('express');
const { inLibrary } = require('./db');
const auth = require('./auth');
const { registerStats } = require('./stats');
const { registerHome } = require('./home');
const { registerKobo } = require('./kobo');
const catalog = require('./library/catalog');
const fiches = require('./library/fiches');

const { findLibrary, mediaUrl } = catalog;

function createLibraryRouter() {
  const api = express.Router({ mergeParams: true });

  api.use((req, res, next) => {
    const found = findLibrary(req.params.slug);
    if (!found) return res.status(404).json({ error: 'Bibliothèque introuvable.' });
    req.library = found.library;
    // Requetes suivantes sur la base de cette bibliotheque (voir lib/db.js).
    inLibrary(req.library.id, next);
  });

  // ---------- Public ----------
  // Catalogue public en lecture seule, interrogeable depuis un autre site (shortcode WordPress).
  api.use('/public', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'GET') return res.status(405).json({ error: 'Lecture seule.' });
    next();
  });
  require('./library/routes-public')(api);

  // ---------- Accueil personnalise (tout compte connecte, voir lib/home.js) ----------
  registerHome(api, {
    mediaUrl, OVERDUE: catalog.OVERDUE, toRemindSql: catalog.toRemindSql, COPY_COUNTS: catalog.COPY_COUNTS, MISSING: catalog.MISSING, listLoans: catalog.listLoans,
  });

  // ---------- Comptes de la bibliotheque : lies a elle (ou administrateur) ----------
  api.use((req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
    if (!auth.isMember(req.user, req.library.id)) return res.status(403).json({ error: "Tu n'as pas accès à la gestion de cette bibliothèque." });
    next();
  });

  // Lecteur (role "user") : catalogue en lecture seule, ses statuts de lecture,
  // "Interesse", statistiques et liseuse. Pas d'ajout, de modification ni de pret.
  // Liste blanche : une adresse ecrite autrement (casse, / final) est refusee.
  const READER_GET = /^\/(settings|members|categories|tags|locations|values\/\w+|books|books\/\d+)$/;
  const READER_WRITE = /^\/books\/\d+\/(status|readers(\/\d+)?)$/;
  api.use((req, res, next) => {
    if (auth.canManage(req.user, req.library.id)) return next();
    const p = req.path;
    const ok = /^\/stats\//.test(p) || (/^\/kobo\//.test(p) && !/^\/kobo\/items\/\d+\/create$/.test(p))
      || (req.method === 'GET' ? READER_GET.test(p) : READER_WRITE.test(p));
    if (!ok) return res.status(403).json({ error: 'Ton compte (lecteur) consulte le catalogue sans pouvoir le modifier.' });
    next();
  });

  // Reglages (ecriture), classement, vidage et codes : reserves aux gestionnaires et
  // administrateurs (pas aux bibliothecaires, qui ont les etiquettes). Garde posee sur
  // chaque route concernee : elle ne depend pas de la facon dont l'adresse est ecrite
  // (Express ignore la casse et le / final).
  const config = (req, res, next) => {
    if (!auth.canConfigure(req.user, req.library.id)) return res.status(403).json({ error: 'Réservé aux gestionnaires de la bibliothèque.' });
    next();
  };
  // Exception : le format de planche seul, enregistre depuis la page Etiquettes.
  const configUnlessLayout = (req, res, next) => {
    if (Object.keys(req.body || {}).join() === 'labelLayout') return next();
    config(req, res, next);
  };
  const guards = { config, configUnlessLayout };

  // ---------- Statistiques et liseuses Kobo (options de la bibliotheque) ----------
  registerStats(api);
  registerKobo(api, {
    addReaders: catalog.addReaders, createEbookCopy: fiches.createEbookCopy, nextReadingDates: fiches.nextReadingDates, searchBooks: catalog.searchBooks,
  });

  // ---------- Gestion ----------
  require('./library/routes-settings')(api, guards);
  require('./library/routes-terms')(api, guards);
  require('./library/routes-books')(api, guards);
  require('./library/routes-copies')(api, guards);
  require('./library/routes-loans')(api);
  require('./library/routes-labels')(api);
  require('./library/routes-import-export')(api);

  api.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  return api;
}

module.exports = { createLibraryRouter, findLibrary, mediaUrl };
