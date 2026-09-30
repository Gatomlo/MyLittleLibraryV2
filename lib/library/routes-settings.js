// Reglages de la bibliotheque, membres, logo.
const { db, tx } = require('../db');
const { httpError, str } = require('../util');
const media = require('../media');
const ebooks = require('../ebooks');
const { handler, CATALOG_FILTERS, CATALOG_CARD, reminderSettings, publicSettings, libraryMembers } = require('./catalog');

module.exports = function register(api, { config, configUnlessLayout }) {
  function parseLabelLayout(lib) {
    try { return JSON.parse(lib.label_layout || 'null'); } catch (e) { return null; }
  }

  api.get('/settings', (req, res) => {
    const lib = req.library;
    res.json({ ...publicSettings(lib), codePrefix: lib.code_prefix, nextCodeNumber: lib.next_code_number, labelLayout: parseLabelLayout(lib),
      ebookAccess: { visible: lib.ebook_visible, read: lib.ebook_read, download: lib.ebook_download }, loanDays: lib.loan_days,
      reminders: reminderSettings(lib) });
  });

  // Applique les reglages envoyes (seules les cles presentes). A appeler dans une
  // transaction : une valeur refusee n'enregistre pas la moitie du formulaire.
  function applySettings(lib, b) {
    if (b.libraryName !== undefined) {
      const name = str(b.libraryName, 120);
      if (!name) throw httpError(400, 'Le nom de la bibliothèque est requis.');
      db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(name, lib.id);
    }
    if (b.codePrefix !== undefined) {
      const prefix = str(b.codePrefix, 10).toUpperCase();
      if (!/^[A-Z0-9]{1,10}$/.test(prefix)) throw httpError(400, 'Préfixe : lettres et chiffres uniquement (10 max).');
      db.prepare('UPDATE libraries SET code_prefix = ? WHERE id = ?').run(prefix, lib.id);
    }
    if (b.labelLayout !== undefined) {
      db.prepare('UPDATE libraries SET label_layout = ? WHERE id = ?').run(JSON.stringify(b.labelLayout).slice(0, 2000), lib.id);
    }
    // Options : livres numeriques, statuts de lecture par compte.
    if (b.features && typeof b.features === 'object') {
      if (b.features.ebooks !== undefined) db.prepare('UPDATE libraries SET enable_ebooks = ? WHERE id = ?').run(b.features.ebooks ? 1 : 0, lib.id);
      if (b.features.readingStatus !== undefined) db.prepare('UPDATE libraries SET enable_reading_status = ? WHERE id = ?').run(b.features.readingStatus ? 1 : 0, lib.id);
      if (b.features.tags !== undefined) db.prepare('UPDATE libraries SET enable_tags = ? WHERE id = ?').run(b.features.tags ? 1 : 0, lib.id);
      if (b.features.stats !== undefined) db.prepare('UPDATE libraries SET enable_stats = ? WHERE id = ?').run(b.features.stats ? 1 : 0, lib.id);
      if (b.features.kobo !== undefined) db.prepare('UPDATE libraries SET enable_kobo = ? WHERE id = ?').run(b.features.kobo ? 1 : 0, lib.id);
    }
    // Droits sur les fichiers epub (voir, lire en ligne, telecharger).
    if (b.ebookAccess && typeof b.ebookAccess === 'object') {
      for (const [key, col] of [['visible', 'ebook_visible'], ['read', 'ebook_read'], ['download', 'ebook_download']]) {
        if (b.ebookAccess[key] !== undefined) db.prepare(`UPDATE libraries SET ${col} = ? WHERE id = ?`).run(ebooks.level(b.ebookAccess[key]), lib.id);
      }
    }
    if (b.brandDisplay !== undefined) {
      db.prepare('UPDATE libraries SET brand_display = ? WHERE id = ?').run(['name', 'logo'].includes(b.brandDisplay) ? b.brandDisplay : 'both', lib.id);
    }
    if (b.loanDays !== undefined) {
      const days = Math.round(Number(b.loanDays));
      if (!(days >= 0 && days <= 365)) throw httpError(400, 'Durée des prêts : de 0 à 365 jours.');
      db.prepare('UPDATE libraries SET loan_days = ? WHERE id = ?').run(days, lib.id);
    }
    // Rappels de retour : manuels ou programmes (J + offset de la date de retour), modele du message.
    if (b.reminders && typeof b.reminders === 'object') {
      const r = b.reminders;
      if (r.mode !== undefined) db.prepare('UPDATE libraries SET reminder_mode = ? WHERE id = ?').run(r.mode === 'auto' ? 'auto' : 'manual', lib.id);
      if (r.offset !== undefined) {
        const n = Math.round(Number(r.offset));
        if (!(n >= -60 && n <= 365)) throw httpError(400, 'Délai du rappel : de -60 à 365 jours.');
        db.prepare('UPDATE libraries SET reminder_offset = ? WHERE id = ?').run(n, lib.id);
      }
      if (r.subject !== undefined) db.prepare('UPDATE libraries SET reminder_subject = ? WHERE id = ?').run(str(r.subject, 200) || null, lib.id);
      if (r.body !== undefined) db.prepare('UPDATE libraries SET reminder_body = ? WHERE id = ?').run(str(r.body, 4000) || null, lib.id);
    }
    if (b.scan && typeof b.scan === 'object') {
      if (b.scan.codes !== undefined) db.prepare('UPDATE libraries SET scan_codes = ? WHERE id = ?').run(['isbn', 'both'].includes(b.scan.codes) ? b.scan.codes : 'copy', lib.id);
      if (b.scan.action !== undefined) db.prepare('UPDATE libraries SET scan_action = ? WHERE id = ?').run(b.scan.action === 'book' ? 'book' : 'loan', lib.id);
    }
    // Catalogue : filtres affiches et position de la barre de filtres.
    if (b.catalog && typeof b.catalog === 'object') {
      if (Array.isArray(b.catalog.filters)) {
        const filters = CATALOG_FILTERS.filter((f) => b.catalog.filters.includes(f));
        db.prepare('UPDATE libraries SET catalog_filters = ? WHERE id = ?').run(JSON.stringify(filters), lib.id);
      }
      if (Array.isArray(b.catalog.card)) {
        const card = CATALOG_CARD.filter((f) => b.catalog.card.includes(f));
        db.prepare('UPDATE libraries SET catalog_card = ? WHERE id = ?').run(JSON.stringify(card), lib.id);
      }
      if (b.catalog.position !== undefined) {
        db.prepare('UPDATE libraries SET filters_position = ? WHERE id = ?').run(b.catalog.position === 'left' ? 'left' : 'top', lib.id);
      }
    }
  }

  api.put('/settings', configUnlessLayout, handler((req, res) => {
    tx(() => applySettings(req.library, req.body));
    res.json({ ok: true });
  }));

  // Comptes dont on peut afficher/filtrer les statuts de lecture, et lecteurs possibles.
  api.get('/members', (req, res) => res.json(libraryMembers(req.library.id, req.user.id)));

  api.post('/settings/logo', config, handler((req, res) => {
    const name = media.saveDataUrl(req.library.id, req.body.dataUrl, 'logo');
    media.remove(req.library.id, req.library.logo);
    db.prepare('UPDATE libraries SET logo = ? WHERE id = ?').run(name, req.library.id);
    res.json(publicSettings({ ...req.library, logo: name }));
  }));

  api.delete('/settings/logo', config, (req, res) => {
    media.remove(req.library.id, req.library.logo);
    db.prepare('UPDATE libraries SET logo = NULL WHERE id = ?').run(req.library.id);
    res.json(publicSettings({ ...req.library, logo: null }));
  });
};
