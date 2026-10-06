// Reglages de la bibliotheque — module de l'interface (organisation : public/app/README.md).
import './statistiques.js';
import { LIBRARY, LIB, state } from './etat.js';
import { $, $$, view, esc, hint, mediaSrc, api, toast, REMINDER_DEFAULT, go, debounce, imageToDataUrl } from './utilitaires.js';
import { scanConf, refreshLoanBadge } from './scanner.js';
import { renderBrand, renderHeader } from './entete.js';
import { renderNav } from './icones.js';
import { route } from './routage.js';
import {
  ALL_CATALOG_CARD, CATALOG_CARD_LABELS, DEFAULT_CATALOG_LIST, CATALOG_LIST_LABELS, ALL_CATALOG_FILTERS, CATALOG_FILTER_LABELS, accordionize, forgetMembers,
} from './catalogue.js';
import { FILE_LEVELS } from './fiche-livre.js';
import { normHeader } from './import.js';
import { missingPills } from './incompletes.js';
import { loadSettings, loadStatus } from './main.js';

async function viewSettings() {
  const s = await api('/api/settings');
  const rem = s.reminders || { mode: 'manual', offset: 0, subject: '', body: '' };
  // Options absentes : le serveur tourne encore une version precedente de l'app.
  const feat = s.features || null;
  const catalog = {
    filters: (s.catalog && s.catalog.filters) || ALL_CATALOG_FILTERS, position: (s.catalog && s.catalog.position) || 'top',
    card: (s.catalog && s.catalog.card) || ALL_CATALOG_CARD,
    list: (s.catalog && s.catalog.list) || DEFAULT_CATALOG_LIST,
  };
  const libraryUrl = location.origin + LIB;
  view().innerHTML = `
    <h1>Réglages</h1>
    <p class="muted">Bibliothèque « ${esc(s.libraryName)} » · <a href="${esc(libraryUrl)}/">${esc(libraryUrl)}/</a></p>
    <p class="settings-group">Bibliothèque</p>
    <h2>Nom, logo et en-tête</h2>
    <form class="card" id="lib-form">
      <div class="field"><label for="lib-name">Nom de la bibliothèque ${hint('Changer le nom ne change pas l\'adresse de la bibliothèque : les QR codes imprimés restent valables.')}</label><input id="lib-name" name="libraryName" required value="${esc(s.libraryName)}"></div>
      <div class="field">
        <label>Logo ${hint('Affiché dans l\'en-tête, sur les étiquettes et dans le catalogue intégré. PNG à fond transparent conseillé.')}</label>
        <div class="btn-row">
          ${s.logoUrl ? `<img src="${esc(mediaSrc(s.logoUrl))}" alt="" style="height:56px;max-width:160px;object-fit:contain;background:#fff;border-radius:8px;padding:4px;border:1px solid var(--border)">` : '<span class="muted small">Aucun logo</span>'}
          <label class="btn btn-small" style="margin:0">${s.logoUrl ? 'Remplacer' : 'Choisir une image'}<input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp" hidden></label>
          ${s.logoUrl ? '<button class="btn btn-small btn-danger" type="button" id="logo-remove">Retirer</button>' : ''}
        </div>
      </div>
      <div class="field">
        <label>En-tête de l'application ${s.logoUrl ? '' : hint('Sans logo, le nom est toujours affiché.')}</label>
        <div class="btn-row" id="brand-display">
          <label class="check"><input type="radio" name="brandDisplay" value="both" ${(s.brandDisplay || 'both') === 'both' ? 'checked' : ''}> Nom et logo</label>
          <label class="check"><input type="radio" name="brandDisplay" value="name" ${s.brandDisplay === 'name' ? 'checked' : ''}> Nom seul</label>
          <label class="check"><input type="radio" name="brandDisplay" value="logo" ${s.brandDisplay === 'logo' ? 'checked' : ''}> Logo seul</label>
        </div>
      </div>
      <button class="btn btn-primary" type="submit">Enregistrer</button>
    </form>

    <h2>Fonctionnalités</h2>
    <form class="card" id="features-form">
      ${feat ? '' : `<div class="error-box">Le serveur n'est pas à jour (options indisponibles). Vérifie que tous les fichiers de l'app ont été envoyés,
        y compris le dossier <span class="code">lib/</span>, puis redémarre l'application Node.</div>`}
      <label class="check" style="align-items:flex-start"><input type="checkbox" name="ebooks" ${feat && feat.ebooks ? 'checked' : ''} ${feat ? '' : 'disabled'} style="margin-top:4px">
        <span><strong>Livres numériques</strong> ${hint('Permet d\'ajouter à un livre un exemplaire numérique (epub, pdf…), seul ou en plus des exemplaires papier : il apparaît au catalogue avec la mention « Numérique », sans code, étiquette ni prêt.')}</span></label>
      <label class="check" style="align-items:flex-start;margin-top:12px"><input type="checkbox" name="readingStatus" ${feat && feat.readingStatus ? 'checked' : ''} ${feat ? '' : 'disabled'} style="margin-top:4px">
        <span><strong>Statuts de lecture</strong> ${hint('Chaque compte peut marquer un livre « À lire » ou « Lu », et « Aimé » ou « Pas aimé ». Visibles dans le catalogue (gestion), avec des filtres par compte. Jamais affichés sur le catalogue public.')}</span></label>
      <label class="check" style="align-items:flex-start;margin-top:12px"><input type="checkbox" name="tags" ${feat && feat.tags ? 'checked' : ''} ${feat ? '' : 'disabled'} style="margin-top:4px">
        <span><strong>Tags</strong> ${hint('Mots-clés libres en plus des catégories (ex. #incontournable, #formation-2025). Ajoutés sur la fiche d\'un livre, visibles et filtrables dans le catalogue.')}</span></label>
      <label class="check" style="align-items:flex-start;margin-top:12px"><input type="checkbox" name="stats" ${feat && feat.stats ? 'checked' : ''} ${feat ? '' : 'disabled'} style="margin-top:4px">
        <span><strong>Statistiques</strong> ${hint('Statistiques de lecture de chaque compte (privées, partageables avec les autres membres) et de la bibliothèque (lecture en totaux anonymes, prêts, fonds). Les statistiques de lecture demandent les statuts de lecture.')}</span></label>
      <label class="check" style="align-items:flex-start;margin-top:12px"><input type="checkbox" name="kobo" ${feat && feat.kobo ? 'checked' : ''} ${feat && feat.ebooks ? '' : 'disabled'} style="margin-top:4px">
        <span><strong>Liseuses Kobo</strong> ${hint('Demande les livres numériques. Liseuses branchées en USB : liste de leurs livres, rapprochement avec les fiches, statuts de lecture du propriétaire, envoi de livres (copie directe avec Chrome).')}</span></label>
    </form>
    ${feat && feat.ebooks && s.ebookAccess ? `
    <h2>Fichiers epub</h2>
    <form class="card" id="ebook-access-form">
      ${[['visible', 'Voir qu\'un fichier existe'], ['read', 'Lire en ligne'], ['download', 'Télécharger']].map(([key, label]) => `
        <div class="field"><label>${label}</label><select name="${key}">
          ${FILE_LEVELS.map(([v, l]) => `<option value="${v}" ${s.ebookAccess[key] === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}
      <p class="small muted">Pouvoir lire ou télécharger rend aussi le fichier visible.</p>
    </form>` : ''}

    <p class="settings-group">Exemplaires et prêts</p>
    <h2>Codes des exemplaires</h2>
    <form class="card" id="code-form">
      <p class="muted small">Prochain code attribué : <span class="code">${esc(s.codePrefix)}-${String(s.nextCodeNumber).padStart(5, '0')}</span></p>
      <div class="grid-2">
        <div class="field"><label for="prefix">Préfixe</label><input id="prefix" name="prefix" value="${esc(s.codePrefix)}" maxlength="10" pattern="[A-Za-z0-9]{1,10}" required style="text-transform:uppercase"></div>
        <div class="field"><label>Aperçu</label><input id="prefix-preview" disabled></div>
      </div>
      <div class="btn-row">
        <button class="btn" type="submit" title="Appliquer aux nouveaux exemplaires">Enregistrer</button>
        <button class="btn btn-danger" type="button" id="renumber">Régénérer…</button>${hint('Enregistrer : le préfixe vaut pour les prochains exemplaires. Régénérer : tous les exemplaires reçoivent un nouveau code.')}
      </div>
      <div id="renumber-panel" hidden style="margin-top:14px">
        <div class="info-box">
          Tous les exemplaires de cette bibliothèque reçoivent un code avec ce préfixe et leurs étiquettes repassent « en attente ».
          Les anciennes étiquettes restent utilisables en attendant : scannées, elles renvoient vers le bon exemplaire.
        </div>
        <label class="check"><input type="checkbox" id="compact"> Repartir de 1 ${hint('Renumérote dans l\'ordre d\'ajout, sans trous.')}</label>
        <p class="small muted" id="compact-warn" hidden>Avec le même préfixe, des numéros seront réattribués à d'autres livres : une ancienne étiquette pourrait alors ouvrir le mauvais exemplaire. Réimprime toutes les étiquettes rapidement.</p>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-danger" type="button" id="renumber-go"><span class="hide-mobile">Régénérer maintenant</span><span class="show-mobile">Régénérer</span></button>
          <button class="btn" type="button" id="renumber-cancel">Annuler</button>
        </div>
      </div>
    </form>

    <h2>Durée des prêts</h2>
    <form class="card" id="loan-days-form">
      <div class="field" style="margin:0"><label for="loan-days">Jours avant la date de retour ${hint('Date de retour proposée au moment du prêt (modifiable). 0 : pas de date de retour.')}</label>
        <input id="loan-days" name="loanDays" type="number" min="0" max="365" value="${s.loanDays == null ? 21 : s.loanDays}" style="max-width:120px"></div>
    </form>

    <h2>Rappels de retour</h2>
    <form class="card" id="reminder-form">
      <fieldset class="plain">
        <legend>Mode ${hint("Le rappel ouvre un e-mail prêt à envoyer dans ta messagerie (mailto) : rien n'est envoyé sans toi.")}</legend>
        <div class="btn-row" style="margin-bottom:14px">
          <label class="check"><input type="radio" name="mode" value="manual" ${rem.mode !== 'auto' ? 'checked' : ''}> Manuels (bouton « Relancer »)</label>
          <label class="check"><input type="radio" name="mode" value="auto" ${rem.mode === 'auto' ? 'checked' : ''}> Programmés (onglet « À relancer »)</label>
        </div>
      </fieldset>
      <div class="field" id="rem-offset-field" ${rem.mode === 'auto' ? '' : 'hidden'}><label for="rem-offset">Relancer à J + … jours de la date de retour ${hint('0 : le jour de la date de retour. Négatif : avant (-2 = deux jours avant). Ensuite, nouvelle relance tous les 7 jours tant que le livre est en retard.')}</label>
        <input id="rem-offset" name="offset" type="number" min="-60" max="365" value="${rem.offset}" style="max-width:120px"></div>
      <div class="field"><label for="rem-subject">Objet</label><input id="rem-subject" name="subject" value="${esc(rem.subject)}" placeholder="${esc(REMINDER_DEFAULT.subject)}"></div>
      <div class="field"><label for="rem-body">Message ${hint("Remplacés à l'envoi : {nom}, {livres} (liste des livres et dates), {bibliotheque}, {date_retour}. Vide : modèle par défaut.")}</label>
        <textarea id="rem-body" name="body" rows="8" placeholder="${esc(REMINDER_DEFAULT.body)}">${esc(rem.body)}</textarea></div>
      <div class="btn-row"><button class="btn btn-primary" type="submit"><span class="hide-mobile">Enregistrer le message</span><span class="show-mobile">Enregistrer</span></button><button class="btn" type="button" id="rem-reset"><span class="hide-mobile">Modèle par défaut</span><span class="show-mobile">Par défaut</span></button></div>
    </form>

    <h2>Bouton Scanner</h2>
    <form class="card" id="scan-form">
      <label>Codes lus</label>
      <div class="btn-row" style="margin-bottom:14px">
        ${[['copy', "QR code de l'étiquette"], ['isbn', 'Code-barres ISBN'], ['both', 'Les deux']].map(([v, l]) => `
          <label class="check"><input type="radio" name="codes" value="${v}" ${scanConf().codes === v ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
      <label>Page ouverte ${hint("Prêt avec un ISBN : l'exemplaire s'ouvre directement s'il est seul, sinon tu choisis parmi les exemplaires.")}</label>
      <div class="btn-row">
        ${[['loan', "Prêt / retour de l'exemplaire"], ['book', 'Fiche du livre']].map(([v, l]) => `
          <label class="check"><input type="radio" name="action" value="${v}" ${scanConf().action === v ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
    </form>

    <p class="settings-group">Catalogue</p>
    <h2>Affichage du catalogue</h2>
    <form class="card" id="catalog-form">
      <label>Filtres affichés</label>
      <div class="btn-row" style="margin-bottom:14px">
        ${CATALOG_FILTER_LABELS.map(([k, l, needs]) => {
          const off = needs && !(feat && feat[needs]);
          return `<label class="check" ${off ? 'title="Active d\'abord l\'option correspondante"' : ''}><input type="checkbox" name="f" value="${k}" ${catalog.filters.includes(k) ? 'checked' : ''}> ${l}${off ? ' <span class="small muted">(option désactivée)</span>' : ''}</label>`;
        }).join('')}
      </div>
      <label>Position des filtres</label>
      <div class="btn-row">
        <label class="check"><input type="radio" name="position" value="top" ${catalog.position !== 'left' ? 'checked' : ''}> En haut</label>
        <label class="check"><input type="radio" name="position" value="left" ${catalog.position === 'left' ? 'checked' : ''}> Colonne à gauche</label>
      </div>
      <label style="margin-top:14px">Miniature d'un livre</label>
      <div class="btn-row">
        ${CATALOG_CARD_LABELS.map(([k, l, needs]) => {
          const off = needs && !(feat && feat[needs]);
          return `<label class="check" ${off ? 'title="Active d\'abord l\'option correspondante"' : ''}><input type="checkbox" name="card" value="${k}" ${catalog.card.includes(k) ? 'checked' : ''}> ${l}${off ? ' <span class="small muted">(option désactivée)</span>' : ''}</label>`;
        }).join('')}
      </div>
      <label style="margin-top:14px">Vue liste (tableau) ${hint('Colonnes du catalogue affiché en liste, un livre par ligne (bouton à côté de Sélectionner, écrans d\'au moins 600 px). Le titre est toujours affiché ; sur un écran étroit, l\'auteur passe sous le titre et seules les colonnes Lecture et Dispo. restent.')}</label>
      <div class="btn-row">
        ${CATALOG_LIST_LABELS.map(([k, l, needs]) => {
          const off = needs && !(feat && feat[needs]);
          return `<label class="check" ${off ? 'title="Active d\'abord l\'option correspondante"' : ''}><input type="checkbox" name="list" value="${k}" ${catalog.list.includes(k) ? 'checked' : ''}> ${l}${off ? ' <span class="small muted">(option désactivée)</span>' : ''}</label>`;
        }).join('')}
      </div>
    </form>

    <h2>Classement ${hint('Rechercher, renommer, fusionner ou supprimer les catégories, tags, auteurs, séries, éditeurs et collections.')}</h2>
    <div class="card">
      <div class="tabs term-tabs">
        ${[['categories', 'Catégories'], ...(feat && feat.tags ? [['tags', 'Tags']] : []), ['authors', 'Auteurs'], ['series', 'Séries'],
          ['publishers', 'Éditeurs'], ['collections', 'Collections']].map(([k, l]) => `<button type="button" data-term-tab="${k}">${l}</button>`).join('')}
      </div>
      <div id="term-panel"></div>
    </div>

    <h2>Fiches incomplètes ${hint('Livres auxquels il manque une information. Touche un critère pour voir la liste et compléter les fiches.')}</h2>
    <div class="card">
      <div class="chips-filter" id="missing-summary"><span class="muted small">Chargement…</span></div>
    </div>

    <h2>Catalogue sur un site web ${hint('WordPress / Divi : choisis ce que le catalogue affiché sur ton site propose, puis copie le code.')}</h2>
    <div class="card" id="embed-builder">
      <label>Filtres proposés aux visiteurs</label>
      <div class="btn-row" style="margin-bottom:12px">
        ${[['recherche', 'Recherche', true], ['categories', 'Catégories', true], ['collections', 'Collections', false], ['series', 'Séries', false],
          ...(feat && feat.tags ? [['tags', 'Tags', false]] : []), ['disponibilite', 'Disponibilité', false],
          ...(feat && feat.ebooks ? [['type', 'Papier / numérique', false]] : []), ['tri', 'Tri', false], ['nombre', 'Nombre de livres', true]]
          .map(([k, l, on]) => `<label class="check"><input type="checkbox" data-filter-opt="${k}" ${on ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
      <label>Position des filtres</label>
      <div class="btn-row" style="margin-bottom:12px">
        <label class="check"><input type="radio" name="emb-pos" value="haut" checked> En haut</label>
        <label class="check"><input type="radio" name="emb-pos" value="gauche"> Colonne à gauche</label>
      </div>
      <div class="grid-2">
        <div class="field"><label>Livres par page</label><input type="number" id="emb-per" min="1" max="100" value="24"></div>
        <div class="field"><label>En-tête du catalogue</label><select id="emb-head">
          <option value="oui">Nom et logo</option>
          <option value="nom">Nom seul</option>
          <option value="logo">Logo seul</option>
          <option value="non">Rien</option>
        </select></div>
      </div>
      <label>Shortcode ${hint('Avec l\'extension fournie (dossier wordpress/ du projet), dans un module Texte ou Code de Divi.')}</label>
      <div class="snippet" id="emb-shortcode"></div>
      <button class="btn btn-small" type="button" data-copy="emb-shortcode" style="margin-top:6px">Copier</button>
      <label style="margin-top:14px">Code HTML ${hint('Sans extension, dans un module Code.')}</label>
      <div class="snippet" id="emb-html"></div>
      <button class="btn btn-small" type="button" data-copy="emb-html" style="margin-top:6px">Copier</button>
    </div>

    <p class="settings-group">Données</p>
    <h2>Exporter</h2>
    <div class="card">
      <p><strong>Inventaire des livres</strong> ${hint('Une ligne par livre avec tous les champs, le nombre d\'exemplaires et leurs codes. Mêmes colonnes que le modèle d\'import : modifiable puis réimportable (Ajout multiple › Fichier complet, option « Mettre à jour la fiche »).')}</p>
      <div class="btn-row">
        <a class="btn btn-primary" href="${LIB}/api/export/inventory.xlsx">Excel</a>
        <a class="btn" href="${LIB}/api/export/inventory.csv">CSV</a>
      </div>
      <p style="margin-top:16px"><strong>Liste des exemplaires</strong> ${hint('Une ligne par exemplaire : code, emplacement, prêt en cours.')}</p>
      <a class="btn" href="${LIB}/api/export/copies.csv">CSV</a>
    </div>

    <h2>Vider la bibliothèque</h2>
    <div class="card danger-zone">
      <p>Supprime <strong>tous les livres</strong> de « ${esc(s.libraryName)} », avec leurs exemplaires, l'historique des prêts et les statuts de lecture.
        Les réglages, le logo et les membres sont conservés. Une sauvegarde complète de la base est faite automatiquement juste avant. ${hint('Pour supprimer seulement quelques livres : Catalogue › « Sélectionner ».')}</p>
      <form id="empty-form">
        <label class="check"><input type="checkbox" name="borrowers"> Supprimer aussi les emprunteurs</label>
        <label class="check"><input type="checkbox" name="terms"> Supprimer aussi les catégories et les tags</label>
        <label class="check"><input type="checkbox" name="resetCodes"> Codes repartant de 1 ${hint('Les anciennes étiquettes ne seront plus reconnues.')}</label>
        <div class="field" style="margin-top:12px"><label for="empty-confirm">Pour confirmer, tape le nom de la bibliothèque : <strong>${esc(s.libraryName)}</strong></label>
          <input id="empty-confirm" name="confirm" autocomplete="off"></div>
        <button class="btn btn-danger" type="submit"><span class="hide-mobile">Vider la bibliothèque</span><span class="show-mobile">Vider</span></button>
      </form>
    </div>`;

  $('#empty-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.confirm.value.trim() !== s.libraryName.trim()) { toast('Tape exactement le nom de la bibliothèque pour confirmer.', 'error'); return; }
    if (!confirm(`Dernière vérification : supprimer TOUS les livres de « ${s.libraryName} » ?`)) return;
    try {
      const r = await api('/api/empty', { method: 'POST', body: { confirm: f.confirm.value, borrowers: f.borrowers.checked, terms: f.terms.checked, resetCodes: f.resetCodes.checked } });
      toast(`${r.deleted} livre(s) supprimé(s). Sauvegarde : ${r.backup}`);
      f.reset();
    } catch (err) { toast(err.message, 'error'); }
  };

  $('#lib-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/settings', { method: 'PUT', body: { libraryName: e.target.libraryName.value } });
      await loadSettings();
      await loadStatus();
      renderHeader();
      toast('Réglages enregistrés.');
      route();
    } catch (err) { toast(err.message, 'error'); }
  };
  const prefixInput = $('#prefix');
  const updatePreview = () => {
    const p = prefixInput.value.trim().toUpperCase() || '…';
    $('#prefix-preview').value = `${p}-00001, ${p}-00002…`;
    $('#compact-warn').hidden = !($('#compact').checked && p === s.codePrefix);
  };
  prefixInput.addEventListener('input', updatePreview);
  $('#compact').addEventListener('change', updatePreview);
  updatePreview();
  $('#code-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/settings', { method: 'PUT', body: { codePrefix: prefixInput.value } });
      toast('Préfixe enregistré pour les prochains exemplaires.');
      route();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#renumber').onclick = () => { $('#renumber-panel').hidden = false; };
  $('#renumber-cancel').onclick = () => { $('#renumber-panel').hidden = true; };
  $('#renumber-go').onclick = async () => {
    if (!prefixInput.reportValidity()) return;
    const prefix = prefixInput.value.trim().toUpperCase();
    if (!confirm(`Régénérer les codes de tous les exemplaires avec le préfixe ${prefix} ?\nToutes les étiquettes seront à réimprimer.`)) return;
    try {
      const r = await api('/api/copies/renumber', { method: 'POST', body: { prefix, compact: $('#compact').checked } });
      state.labels = { mode: 'pending', manual: [] };
      toast(r.changed ? `${r.changed} code(s) régénéré(s). Les nouvelles étiquettes sont en attente d'impression.` : 'Aucun code à modifier.');
      go(r.changed ? '#/labels' : '#/settings');
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#logo-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await imageToDataUrl(file, 600, 'image/png');
      await api('/api/settings/logo', { method: 'POST', body: { dataUrl } });
      await loadSettings();
      await loadStatus();
      renderHeader();
      toast('Logo enregistré.');
      route();
    } catch (err) { toast(err.message, 'error'); }
  };
  const rm = $('#logo-remove');
  if (rm) rm.onclick = async () => { await api('/api/settings/logo', { method: 'DELETE' }); await loadSettings(); renderHeader(); route(); };
  // Options : enregistrees des qu'on coche / decoche.
  $$('#features-form input').forEach((cb) => {
    cb.onchange = async () => {
      try {
        await api('/api/settings', { method: 'PUT', body: { features: { [cb.name]: cb.checked } } });
        await loadSettings();
        forgetMembers();
        toast(cb.checked ? 'Option activée.' : 'Option désactivée.');
        if (cb.name === 'tags') route(); // affiche / masque la gestion des tags
        if (cb.name === 'stats') renderNav(); // entree "Statistiques" du menu
        if (cb.name === 'ebooks' || cb.name === 'kobo') { renderNav(); route(); } // Liseuses, droits epub
      } catch (err) { cb.checked = !cb.checked; toast(err.message, 'error'); }
    };
  });
  $$('#ebook-access-form select').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api('/api/settings', { method: 'PUT', body: { ebookAccess: { [sel.name]: sel.value } } });
        toast('Droits enregistrés.');
      } catch (err) { toast(err.message, 'error'); }
    };
  });
  // Generateur du code d'integration (shortcode WordPress / HTML).
  const updateEmbed = () => {
    const filtersSel = $$('[data-filter-opt]:checked').map((cb) => cb.dataset.filterOpt);
    const filtres = filtersSel.length ? filtersSel.join(',') : 'aucun';
    const per = Math.max(1, Math.min(100, parseInt($('#emb-per').value, 10) || 24));
    const head = $('#emb-head').value; // oui (nom et logo), nom, logo, non
    const pos = ($('[name=emb-pos]:checked') || {}).value === 'gauche' ? 'gauche' : '';
    $('#emb-shortcode').textContent = `[bibliotheque url="${libraryUrl}" filtres="${filtres}"${pos ? ' position="gauche"' : ''}${per !== 24 ? ` par_page="${per}"` : ''}${head !== 'oui' ? ` entete="${head}"` : ''}]`;
    $('#emb-html').textContent = `<div class="mll-catalogue" data-url="${libraryUrl}" data-filters="${filtres}"${pos ? ' data-position="gauche"' : ''} data-per-page="${per}"${head !== 'oui' ? ` data-header="${head}"` : ''}></div>\n<script src="${libraryUrl}/embed.js" defer></script>`;
  };
  $$('#embed-builder input').forEach((i) => i.addEventListener('input', updateEmbed));
  $$('#embed-builder input, #embed-builder select').forEach((i) => i.addEventListener('change', updateEmbed));
  $$('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      const text = $(`#${btn.dataset.copy}`).textContent;
      try { await navigator.clipboard.writeText(text); toast('Copié.'); } catch (e) { prompt('Copie ce code :', text); }
    };
  });
  updateEmbed();

  // En-tete : applique tout de suite, sans bouton.
  $$('#brand-display input').forEach((r) => {
    r.onchange = async () => {
      try {
        await api('/api/settings', { method: 'PUT', body: { brandDisplay: r.value } });
        await loadSettings();
        renderBrand();
        toast('En-tête mis à jour.');
      } catch (err) { toast(err.message, 'error'); }
    };
  });

  // Duree des prets : enregistree des qu'on change.
  $('#loan-days-form').addEventListener('change', async (e) => {
    try {
      await api('/api/settings', { method: 'PUT', body: { loanDays: Number(e.target.value) } });
      toast('Durée des prêts mise à jour.');
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#loan-days-form').addEventListener('submit', (e) => e.preventDefault());

  // Rappels : mode et delai enregistres des qu'on change, message sur le bouton.
  const remForm = $('#reminder-form');
  const saveReminders = async (body, msg) => {
    try { await api('/api/settings', { method: 'PUT', body: { reminders: body } }); toast(msg); refreshLoanBadge(); } catch (err) { toast(err.message, 'error'); }
  };
  remForm.addEventListener('change', (e) => {
    if (e.target.name === 'mode') { $('#rem-offset-field').hidden = e.target.value !== 'auto'; saveReminders({ mode: e.target.value }, 'Mode des rappels enregistré.'); }
    if (e.target.name === 'offset') saveReminders({ offset: Number(e.target.value) }, 'Délai des rappels enregistré.');
  });
  remForm.onsubmit = (e) => { e.preventDefault(); saveReminders({ subject: remForm.subject.value, body: remForm.body.value }, 'Message de rappel enregistré.'); };
  $('#rem-reset').onclick = () => { remForm.subject.value = ''; remForm.body.value = ''; saveReminders({ subject: '', body: '' }, 'Modèle par défaut rétabli.'); };

  // Bouton Scanner : enregistre des qu'on change.
  $('#scan-form').addEventListener('change', async () => {
    const codes = ($('#scan-form [name=codes]:checked') || {}).value;
    const action = ($('#scan-form [name=action]:checked') || {}).value;
    try {
      await api('/api/settings', { method: 'PUT', body: { scan: { codes, action } } });
      await loadSettings();
      renderHeader();
      toast('Bouton Scanner mis à jour.');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Catalogue : filtres affiches et position, enregistres des qu'on change.
  $('#catalog-form').addEventListener('change', async () => {
    const filters = $$('#catalog-form [name=f]:checked').map((cb) => cb.value);
    const position = ($('#catalog-form [name=position]:checked') || {}).value || 'top';
    const card = $$('#catalog-form [name=card]:checked').map((cb) => cb.value);
    const list = $$('#catalog-form [name=list]:checked').map((cb) => cb.value);
    try {
      await api('/api/settings', { method: 'PUT', body: { catalog: { filters, position, card, list } } });
      await loadSettings();
      toast('Catalogue mis à jour.');
    } catch (err) { toast(err.message, 'error'); }
  });

  accordionize(view(), `mll-settings-${LIBRARY.slug}`);
  api('/api/books/missing').then((m) => {
    const box = $('#missing-summary');
    if (box) box.innerHTML = missingPills(m, null);
  }).catch(() => {
    const box = $('#missing-summary');
    if (box) box.innerHTML = '<a class="btn btn-small" href="#/incomplete"><span class="hide-mobile">Voir les fiches incomplètes</span><span class="show-mobile">Voir</span></a>';
  });
  // Classement : un onglet par liste, charge a la demande (dernier onglet memorise).
  const termKey = `mll-terms-${LIBRARY.slug}`;
  const showTerms = async (k) => {
    $$('[data-term-tab]').forEach((b) => b.classList.toggle('active', b.dataset.termTab === k));
    try { localStorage.setItem(termKey, k); } catch (e) { /* stockage indisponible */ }
    const panel = $('#term-panel');
    panel.innerHTML = '<p class="muted small">Chargement…</p>';
    try {
      const list = await api(`/api/${TERM_KINDS[k].path}`);
      if (!$(`[data-term-tab="${k}"].active`)) return; // autre onglet choisi entre-temps
      panel.innerHTML = '';
      categoryManager(panel, list, k);
    } catch (err) { panel.innerHTML = '<p class="muted small">Indisponible : le serveur n\'est pas à jour.</p>'; }
  };
  $$('[data-term-tab]').forEach((b) => { b.onclick = () => showTerms(b.dataset.termTab); });
  let lastTerms = null;
  try { lastTerms = localStorage.getItem(termKey); } catch (e) { /* stockage indisponible */ }
  showTerms($(`[data-term-tab="${lastTerms}"]`) ? lastTerms : 'categories');
}

// Gestion des categories, tags, auteurs, series, editeurs et collections : recherche,
// regroupement alphabetique repliable, renommage, suppression et fusion.
// free : valeurs libres des fiches (pas de table, l'identifiant est le nom).
const TERM_KINDS = {
  categories: { path: 'categories', one: 'catégorie', many: 'catégories', the: 'la catégorie', a: 'une catégorie', prefix: '', added: 'Nouvelle catégorie' },
  tags: { path: 'tags', one: 'tag', many: 'tags', the: 'le tag', a: 'un tag', prefix: '#', added: 'Nouveau tag' },
  authors: { path: 'values/authors', one: 'auteur', many: 'auteurs', the: "l'auteur", a: 'un auteur', none: 'Aucun auteur', prefix: '', free: true },
  series: { path: 'values/series', one: 'série', many: 'séries', the: 'la série', a: 'une série', none: 'Aucune série', prefix: '', free: true },
  publishers: { path: 'values/publishers', one: 'éditeur', many: 'éditeurs', the: "l'éditeur", a: 'un éditeur', none: 'Aucun éditeur', prefix: '', free: true },
  collections: { path: 'values/collections', one: 'collection', many: 'collections', the: 'la collection', a: 'une collection', none: 'Aucune collection', prefix: '', free: true },
};
function categoryManager(root, initial, kindName = 'categories') {
  const K = TERM_KINDS[kindName];
  const id = (x) => `${kindName}-${x}`;
  const label = (n) => K.prefix + n;
  const key = (v) => (K.free ? String(v) : Number(v));
  const find = (v) => cats.find((x) => x.id === key(v));
  let cats = initial;
  let q = '';
  const selected = new Set();
  const open = new Set();
  root.innerHTML = `
    <div class="isbn-row">
      <input type="search" id="${id('q')}" placeholder="Rechercher ${K.a}…" autocomplete="off">
    </div>
    ${K.free ? '' : `<form class="isbn-row" id="${id('new')}" style="margin-top:8px"><input name="name" placeholder="${K.added}"><button class="btn" type="submit">Ajouter</button></form>`}
    <div class="merge-bar"></div>
    <div class="term-body" style="margin-top:10px"></div>`;

  const reload = async () => { cats = await api(`/api/${K.path}`); render(); };
  const letterOf = (name) => {
    const l = normHeader(name).charAt(0).toUpperCase();
    return /[A-Z]/.test(l) ? l : '#';
  };
  const rowHtml = (c) => `
    <div class="list-item cat-row">
      <input type="checkbox" data-sel="${esc(c.id)}" ${selected.has(c.id) ? 'checked' : ''} aria-label="Sélectionner ${esc(c.name)}">
      <div class="grow">${esc(label(c.name))} <span class="small muted">(${c.count} livre${c.count > 1 ? 's' : ''})</span></div>
      <button class="btn btn-small" data-rename="${esc(c.id)}">Renommer</button>
      <button class="btn btn-small btn-danger" data-delcat="${esc(c.id)}">Supprimer</button>
    </div>`;

  function renderMergeBar() {
    const bar = $('.merge-bar', root);
    const chosen = cats.filter((c) => selected.has(c.id));
    if (!chosen.length) { bar.innerHTML = ''; return; }
    bar.innerHTML = `<div class="info-box" style="margin:10px 0 0">
      <strong>Sélection (${chosen.length})</strong> : ${chosen.map((c) => esc(label(c.name))).join(', ')}
      ${chosen.length >= 2 ? `<form class="isbn-row merge-form" style="margin-top:8px">
        <input name="name" list="${id('merge-names')}" required placeholder="Nom final" value="${esc(chosen[0].name)}">
        <datalist id="${id('merge-names')}">${chosen.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
        <button class="btn btn-primary" type="submit">Fusionner</button>
      </form>` : '<p class="small" style="margin:6px 0 0">Coche au moins deux ${K.many} pour les fusionner.</p>'}
      <button type="button" class="btn btn-small btn-merge-clear" style="margin-top:8px">Désélectionner</button>
    </div>`;
    $('.btn-merge-clear', bar).onclick = () => { selected.clear(); render(); };
    const form = $('.merge-form', bar);
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      const books = chosen.reduce((n, c) => n + c.count, 0);
      if (!confirm(`Fusionner ${chosen.map((c) => `« ${c.name} »`).join(', ')} en « ${name} » ?\nLes livres concernés (${books}) seront rangés dans « ${name} ».`)) return;
      try {
        const r = await api(`/api/${K.path}/merge`, { method: 'POST', body: { ids: chosen.map((c) => c.id), name } });
        selected.clear();
        toast(`Fusion effectuée dans « ${r.name} » (${r.books} livre(s)).`);
        reload();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  function render() {
    const body = $('.term-body', root);
    const nq = normHeader(q);
    if (!cats.length) {
      body.innerHTML = K.free ? `<p class="muted">${K.none} pour le moment : à renseigner sur la fiche des livres.</p>`
        : `<p class="muted">Rien pour le moment : ${K.many === 'tags' ? 'les tags' : 'les catégories'} se créent depuis la fiche d'un livre ou ici.</p>`;
    } else if (nq) {
      const found = cats.filter((c) => normHeader(c.name).includes(nq));
      body.innerHTML = found.length ? `<div class="list">${found.map(rowHtml).join('')}</div>` : '<p class="muted small">Aucun résultat.</p>';
    } else {
      const groups = new Map();
      cats.forEach((c) => { const l = letterOf(c.name); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(c); });
      body.innerHTML = `<p class="small muted">${cats.length} ${K.one}(s) ${hint('Clique sur une lettre pour la déplier.')}</p>` +
        Array.from(groups).sort(([a], [b]) => a.localeCompare(b)).map(([l, list]) => `
        <details class="cat-group" data-letter="${l}" ${open.has(l) ? 'open' : ''}>
          <summary><strong>${l}</strong> <span class="small muted">${list.length} ${K.one}(s)${list.some((c) => selected.has(c.id)) ? ' · sélection' : ''}</span></summary>
          <div class="list">${list.map(rowHtml).join('')}</div>
        </details>`).join('');
      $$('.cat-group', body).forEach((d) => d.addEventListener('toggle', () => { if (d.open) open.add(d.dataset.letter); else open.delete(d.dataset.letter); }));
    }
    $$('[data-sel]', body).forEach((cb) => {
      cb.onchange = () => { const id = key(cb.dataset.sel); if (cb.checked) selected.add(id); else selected.delete(id); renderMergeBar(); };
    });
    $$('[data-rename]', body).forEach((btn) => {
      btn.onclick = async () => {
        const c = find(btn.dataset.rename);
        const name = (prompt('Nouveau nom :', c.name) || '').trim();
        if (!name || name === c.name) return;
        if (K.free) {
          // Nom deja present : le renommage fusionne les deux.
          const other = cats.find((x) => x !== c && x.name.toLowerCase() === name.toLowerCase());
          if (other && !confirm(`${K.the.charAt(0).toUpperCase() + K.the.slice(1)} « ${other.name} » existe déjà. Fusionner « ${c.name} » dedans ?`)) return;
          try {
            const r = await api(`/api/${K.path}`, { method: 'PUT', body: { from: c.name, name } });
            selected.delete(c.id);
            toast(`${r.books} livre(s) mis à jour.`);
            reload();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        try { await api(`/api/${K.path}/${c.id}`, { method: 'PUT', body: { name } }); reload(); } catch (err) {
          // Nom deja pris : proposer la fusion avec la categorie existante.
          const other = cats.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (other && confirm(`${K.the.charAt(0).toUpperCase() + K.the.slice(1)} « ${other.name} » existe déjà. Fusionner « ${c.name} » dedans ?`)) {
            await api(`/api/${K.path}/merge`, { method: 'POST', body: { ids: [c.id, other.id], name: other.name } }).catch((e) => toast(e.message, 'error'));
            reload();
          } else toast(err.message, 'error');
        }
      };
    });
    $$('[data-delcat]', body).forEach((btn) => {
      btn.onclick = async () => {
        const c = find(btn.dataset.delcat);
        if (!confirm(`Supprimer ${K.the} « ${c.name} » ? ${K.free ? 'Retiré(e) des fiches, les' : 'Les'} ${c.count} livre(s) concernés restent au catalogue.`)) return;
        try {
          if (K.free) await api(`/api/${K.path}/delete`, { method: 'POST', body: { name: c.name } });
          else await api(`/api/${K.path}/${c.id}`, { method: 'DELETE' });
        } catch (err) { toast(err.message, 'error'); return; }
        selected.delete(c.id);
        reload();
      };
    });
    renderMergeBar();
  }

  $(`#${id('q')}`, root).addEventListener('input', debounce((e) => { q = e.target.value; render(); }, 150));
  if (!K.free) $(`#${id('new')}`, root).onsubmit = async (e) => {
    e.preventDefault();
    if (!e.target.name.value.trim()) return;
    try { await api(`/api/${K.path}`, { method: 'POST', body: { name: e.target.name.value } }); e.target.reset(); reload(); } catch (err) { toast(err.message, 'error'); }
  };
  render();
}

export { viewSettings };
