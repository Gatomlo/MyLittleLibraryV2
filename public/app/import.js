// Import de listes de livres — module de l'interface (organisation : public/app/README.md).
import './import-suivi.js';
import { LIB, ASSETS, state, features } from './etat.js';
import { $, $$, view, esc, hint, api, toast, go, loadScript, sessionStorageSet, sessionStorageTake } from './utilitaires.js';
import { decodePhoto, startCamera, isbnFromScan } from './scanner.js';
import { onLeave, leavePage } from './routage.js';
import { combo, loadMembers, memberPicker } from './catalogue.js';
import { sendRaw } from './fiche-livre.js';
import { historyAdd, historyUpdate, historyRemove, renderImportHistory } from './import-suivi.js';

// Deux modes : une liste d'ISBN (fiches completees automatiquement), ou un
// fichier (.xlsx / .csv) avec une colonne par champ. Le fichier est lu dans le
// navigateur, previsualise, puis importe livre par livre (progression visible).
const IMPORT_FIELDS = [
  { key: 'isbn', label: 'ISBN', aliases: ['isbn', 'isbn13', 'isbn10', 'ean', 'ean13', 'code barre', 'codebarres'] },
  { key: 'title', label: 'Titre', aliases: ['titre', 'title', 'intitule'] },
  { key: 'subtitle', label: 'Sous-titre', aliases: ['sous-titre', 'soustitre', 'subtitle'] },
  { key: 'authors', label: 'Auteurs', aliases: ['auteurs', 'auteur', 'author', 'authors', 'ecrivain'] },
  { key: 'publisher', label: 'Éditeur', aliases: ['editeur', 'editeurs', 'edition', 'editions', 'maison d edition', 'publisher'] },
  { key: 'year', label: 'Année', aliases: ['annee', 'an', 'date', 'year', 'parution', 'date de parution', 'annee de parution'] },
  { key: 'pages', label: 'Pages', aliases: ['pages', 'pagination', 'nombre de pages', 'nb pages', 'nbpages'] },
  { key: 'summary', label: 'Résumé', aliases: ['resume', 'summary', 'description', 'presentation'] },
  { key: 'categories', label: 'Catégories', aliases: ['categories', 'categorie', 'theme', 'themes', 'genre', 'genres', 'sujet', 'sujets'] },
  { key: 'location', label: 'Emplacement', aliases: ['emplacement', 'localisation', 'location', 'etagere', 'rayon', 'armoire'] },
  { key: 'copies', label: 'Exemplaires', aliases: ['exemplaires', 'exemplaire', 'nb exemplaires', 'quantite', 'qte', 'nombre', 'copies'] },
  { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'remarque', 'remarques', 'commentaire', 'commentaires'] },
  { key: 'coverUrl', label: 'Couverture (URL)', aliases: ['couverture', 'couverture url', 'image', 'illustration', 'cover', 'url image'] },
  { key: 'collection', label: 'Collection (éditeur)', aliases: ['collection', 'collection editeur'] },
  { key: 'series', label: 'Série', aliases: ['serie', 'series', 'saga', 'cycle'] },
  { key: 'seriesNumber', label: 'Tome', aliases: ['tome', 'n tome', 'numero de tome', 'volume', 'n dans la serie', 'numero dans la serie', 'n dans la collection', 'numero dans la collection', 'numero', 'num', 'no'] },
  { key: 'tags', label: 'Tags', aliases: ['tags', 'tag', 'mots cles', 'mots-cles', 'motscles', 'keywords', 'etiquettes libres'] },
  { key: 'readers', label: 'Lecteurs (noms des comptes)', aliases: ['lecteurs', 'lecteur', 'readers', 'reader', 'lu par', 'lecture par'] },
  { key: 'format', label: 'Type (Papier, Numérique ou Papier + numérique)', aliases: ['type', 'format', 'support', 'type de livre', 'numerique', 'version'] },
  { key: 'bookId', label: 'ID fiche (mise à jour)', aliases: ['id fiche', 'id', 'identifiant', 'id livre'] },
];
const normHeader = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function guessField(header) {
  const n = normHeader(header);
  if (!n) return '';
  for (const f of IMPORT_FIELDS) if (f.aliases.some((a) => normHeader(a) === n)) return f.key;
  for (const f of IMPORT_FIELDS) if (f.aliases.some((a) => normHeader(a).length >= 4 && n.startsWith(normHeader(a)))) return f.key;
  return '';
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return String(v.getFullYear());
  // Apostrophe de protection posee par l'export CSV devant = + - @ (formules) : retiree.
  return String(v).trim().replace(/^'(?=[=+\-@])/, '');
}

function validIsbn10(d) {
  if (!/^\d{9}[\dX]$/.test(d)) return false;
  return d.split('').reduce((acc, c, i) => acc + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11 === 0;
}

// ISBN d'une cellule : { isbn } si valide, { error } sinon ({} si vide).
function isbnFromCell(v) {
  const s = cellText(v);
  if (!s) return {};
  if (/^\d[.,]\d+E\+?\d+$/i.test(s)) {
    return { error: `ISBN abîmé par Excel (${s}) : utilise le modèle .xlsx fourni ou formate la colonne ISBN en « Texte ».` };
  }
  let d = s.toUpperCase().replace(/[^0-9X]/g, '');
  if (/^\d{9}$/.test(d)) d = '0' + d; // ISBN-10 dont Excel a retire le 0 initial
  if (isbnFromScan(d) && (d.length === 13 || validIsbn10(d))) return { isbn: d };
  return { error: `ISBN invalide : ${s}`, raw: s };
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Fichier .xlsx ou .csv/.txt -> lignes (tableaux de cellules), lignes vides retirees.
async function readTable(file) {
  let rows;
  if (/\.xlsx$/i.test(file.name)) {
    if (!window.readXlsxFile) await loadScript(ASSETS + '/vendor/read-excel-file.min.js');
    const r = await window.readXlsxFile(file);
    rows = Array.isArray(r) && r[0] && !Array.isArray(r[0]) && r[0].data ? r[0].data : r;
  } else if (/\.(xls|ods|numbers)$/i.test(file.name)) {
    throw new Error('Format non pris en charge : enregistre le fichier en .xlsx (Excel) ou .csv.');
  } else {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    // CSV enregistre par Excel sous Windows : souvent en Windows-1252, pas en UTF-8.
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
    rows = parseCsv(text.replace(/^\uFEFF/, ''));
  }
  return rows.filter((r) => r && r.some((c) => cellText(c) !== ''));
}

// Champ "pastilles" (categories, tags) : saisie avec suggestions, Entree ou
// Ajouter pour valider, x pour retirer. Renvoie la fonction d'ajout.
function chipField(prefix, list, shown = (v) => v) {
  const render = () => {
    $(`#${prefix}-chips`).innerHTML = list.map((c, i) => `<span class="chip">${esc(shown(c))}<button type="button" data-i="${i}" aria-label="Retirer">×</button></span>`).join('');
    $$(`#${prefix}-chips button`).forEach((btn) => { btn.onclick = () => { list.splice(Number(btn.dataset.i), 1); render(); }; });
  };
  const add = () => {
    const input = $(`#${prefix}-input`);
    input.value.split(',').map((v) => v.trim().replace(/^#/, '')).filter(Boolean).forEach((v) => {
      if (!list.some((c) => c.toLowerCase() === v.toLowerCase())) list.push(v);
    });
    input.value = '';
    render();
  };
  render();
  // Liste deroulante filtrante des termes existants ; un nom nouveau s'ajoute avec
  // Entree ou le bouton Ajouter.
  const input = $(`#${prefix}-input`);
  const dl = $(`#${prefix}-list`);
  const existing = dl ? Array.from(dl.options).map((o) => o.value) : [];
  combo(input, existing.map((v) => ({ label: shown(v), value: v })), (it) => { input.value = it.value; add(); },
    { emptyText: 'Nouveau : Entrée ou « Ajouter » pour le créer' });
  $(`#${prefix}-add`).onclick = add;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  return add;
}
// Pastilles de l'import (categories / tags) : meme saisie que dans la fiche du livre.
function termField(prefix, label, names, placeholder) {
  return `<div class="field"><label for="${prefix}-input">${label}</label>
    <div id="${prefix}-chips"></div>
    <div class="isbn-row"><input id="${prefix}-input" placeholder="${placeholder}" autocomplete="off">
      <button class="btn" type="button" id="${prefix}-add">Ajouter</button></div>
    <datalist id="${prefix}-list">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>`;
}

// Options communes envoyees avec chaque ligne importee.
function importOptions(extra) {
  const toRead = $('#opt-toread');
  const dup = $('#opt-dup').value;
  // Lecteurs coches (pas en mise a jour : seule la colonne "Lecteurs" compte).
  const readers = dup === 'update' ? undefined : importState.readers || [];
  return { onDuplicate: dup, markToRead: !!(toRead && toRead.checked), readers, ...extra };
}

const importState = { mode: 'scan', text: '', fileName: '', rows: null, mapping: [], items: [], results: null, running: false, stop: false, batch: [], cats: [], tags: [], toRead: false, readers: null };

// Fichiers epub en attente d'envoi : un fichier par requete, a la suite (fiche creee, ou
// fichier ajoute a la fiche existante). Une nouvelle vague s'ajoute a la file pendant
// l'envoi de la precedente ; les resultats vont dans le suivi des imports.
const epubQueue = [];
let epubRunning = false;
async function runEpubQueue() {
  if (epubRunning) return;
  epubRunning = true;
  window.addEventListener('beforeunload', warnBeforeLeaving);
  while (epubQueue.length) {
    const { file, id } = epubQueue.shift();
    historyUpdate(id, { status: 'sending' });
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('Fichier trop lourd (100 Mo max).');
      const r = await sendRaw('/api/import/epub', 'POST', file, 'application/epub+zip', { 'X-File-Name': encodeURIComponent(file.name) });
      historyUpdate(id, { status: r.status, bookId: r.bookId, title: r.title });
    } catch (err) {
      historyUpdate(id, { status: 'error', error: err.message });
    }
  }
  epubRunning = false;
  window.removeEventListener('beforeunload', warnBeforeLeaving);
  toast('Import terminé.');
}

function renderEpubImport(body) {
  body.innerHTML = `
    <div class="card">
      <div class="field"><label>Fichiers epub ${hint('Une fiche est créée pour chaque fichier d\'après ses informations (titre, auteurs, résumé, série, couverture). Si la fiche existe déjà (même ISBN, ou même titre et auteur), le fichier lui est ajouté. Tu peux ajouter d\'autres fichiers pendant l\'envoi : ils passent à la suite.')}</label>
        <input type="file" id="epub-files" accept=".epub,application/epub+zip" multiple></div>
      <div class="btn-row"><button class="btn btn-primary" id="epub-go" disabled>Importer</button></div>
    </div>`;
  const input = $('#epub-files', body);
  const goBtn = $('#epub-go', body);
  input.onchange = () => {
    const n = input.files.length;
    goBtn.disabled = !n;
    goBtn.textContent = !n ? 'Importer' : epubRunning ? `Ajouter ${n} fichier(s) à la file` : `Importer ${n} fichier(s)`;
  };
  goBtn.onclick = () => {
    const files = [...input.files];
    if (!files.length) return;
    const ids = historyAdd('epub', files.map((f) => f.name));
    files.forEach((file, n) => epubQueue.push({ file, id: ids[n] }));
    input.value = '';
    input.onchange();
    runEpubQueue();
  };
}

async function viewImport() {
  const s = importState;
  // Retour depuis une fiche ouverte dans le suivi : onglet d'ou elle a ete ouverte.
  const back = sessionStorageTake('mll-import-mode');
  if (['scan', 'isbn', 'full', 'epub'].includes(back) && !s.running) s.mode = back;
  const [locations, allCats, allTags, members] = await Promise.all([
    api('/api/locations').catch(() => []),
    api('/api/categories').catch(() => []),
    features().tags ? api('/api/tags').catch(() => []) : [],
    loadMembers().catch(() => []),
  ]);
  // Par defaut, le compte qui importe est lecteur des livres ajoutes.
  if (!s.readers) s.readers = [state.user.id];
  const tpl = (type, ext) => `${LIB}/api/import/template.${ext}${type === 'isbn' ? '?type=isbn' : ''}`;
  view().innerHTML = `
    <p><a href="#/add">← Ajouter un livre</a></p>
    <div class="page-head"><div><h1>Ajout multiple ${hint('Ajoute d\'un coup plusieurs livres. Les exemplaires et leurs codes sont créés automatiquement ; leurs étiquettes passent « en attente ».')}</h1></div>
      <a class="btn" href="#/incomplete"><span class="hide-mobile">Fiches incomplètes</span><span class="show-mobile">Incomplètes</span></a></div>
    <div class="seg seg-${features().ebooks ? 4 : 3}" style="max-width:${features().ebooks ? 820 : 640}px">
      <button type="button" data-mode="scan" class="${s.mode === 'scan' ? 'active' : ''}">Scanner en série</button>
      <button type="button" data-mode="isbn" class="${s.mode === 'isbn' ? 'active' : ''}">Liste d'ISBN</button>
      <button type="button" data-mode="full" class="${s.mode === 'full' ? 'active' : ''}">Fichier complet</button>
      ${features().ebooks ? `<button type="button" data-mode="epub" class="${s.mode === 'epub' ? 'active' : ''}">Fichiers epub</button>` : ''}
    </div>
    <div id="import-body"></div>
    <div id="import-history"></div>`;
  $$('.seg button').forEach((btn) => {
    btn.onclick = () => {
      if (s.running || btn.dataset.mode === s.mode) return;
      leavePage();
      Object.assign(s, { mode: btn.dataset.mode, rows: null, mapping: [], items: [], results: null, fileName: '' });
      viewImport();
    };
  });
  const body = $('#import-body');
  renderImportHistory($('#import-history'), { onOpen: () => sessionStorageSet('mll-import-mode', s.mode) });
  if (s.mode === 'epub' && features().ebooks) return renderEpubImport(body);

  const formatOption = features().ebooks ? `
    <div class="field"><label>Exemplaires à créer ${hint('Papier : avec code et étiquette. Numérique (epub, pdf…) : sans code ni étiquette.')}</label><select id="opt-format">
      <option value="physical">Papier</option>
      <option value="both">Papier + numérique</option>
      <option value="ebook">Numérique seul</option>
    </select></div>` : '';
  const options = `
    <div class="grid-2">
      ${s.mode !== 'full' ? `
        ${s.mode === 'isbn' ? `<div class="field"><label>Exemplaires par ISBN ${hint('Exemplaires papier. Un ISBN présent plusieurs fois dans la liste compte pour plusieurs exemplaires.')}</label><input type="number" id="opt-copies" min="1" max="50" value="1"></div>` : ''}
        ${formatOption}
        <div class="field"><label>Emplacement</label><input id="opt-location" list="loc-list" placeholder="facultatif"></div>
        ${termField('icat', 'Catégories', allCats.map((c) => c.name), 'Choisir ou créer une catégorie…')}
        ${features().tags ? termField('itag', 'Tags', allTags.map((t) => t.name), 'Choisir ou créer un tag…') : ''}` : `
        <div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" id="opt-fill" checked> Compléter via l'ISBN ${hint('Les champs vides d\'un nouveau livre sont complétés par la recherche ISBN ; les valeurs du fichier restent prioritaires.')}</label></div>
        <div class="field"><label>Emplacement par défaut ${hint('Utilisé pour les nouveaux livres quand la colonne Emplacement est vide.')}</label><input id="opt-location" list="loc-list" placeholder="facultatif"></div>`}
      <div class="field"><label>ISBN déjà au catalogue ${hint(`Ajouter les exemplaires : au livre existant (le numérique s'il manque). Ignorer : la ligne n'est pas importée. Nouvelle fiche : crée un doublon.${s.mode === 'full' ? ' Mettre à jour : les colonnes remplies du fichier écrasent celles de la fiche (repérée par la colonne « ID fiche » des exports, sinon par l\'ISBN) ; aucun exemplaire créé, l\'emplacement rempli s\'applique aux exemplaires papier.' : ''}`)}</label><select id="opt-dup">
        <option value="copy">Ajouter les exemplaires</option>
        ${s.mode === 'full' ? `<option value="update" ${s.dup === 'update' ? 'selected' : ''}>Mettre à jour la fiche</option>` : ''}
        <option value="skip">Ignorer la ligne</option>
        <option value="new">Nouvelle fiche</option>
      </select></div>
      ${features().readingStatus ? `<div class="field"><label class="check" style="margin-top:22px"><input type="checkbox" id="opt-toread" ${s.toRead ? 'checked' : ''}>
        « À lire » pour moi ${hint('Marque les nouveaux livres « À lire » dans ton statut de lecture.')}</label></div>` : ''}
      ${members.length ? `<div class="field"><label>Lecteurs ${hint(`Comptes qui lisent ou liront ces livres (ajoutés aussi aux livres déjà au catalogue).${s.mode === 'full' ? ' La colonne « Lecteurs » du fichier, si elle est remplie, est prioritaire. En mise à jour, seule la colonne compte.' : ''}`)}</label>
        <div id="import-readers"></div></div>` : ''}
    </div>
    <datalist id="loc-list">${locations.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>`;

  const bindOptions = () => {
    if ($('#icat-input')) chipField('icat', s.cats);
    if ($('#itag-input')) chipField('itag', s.tags, (t) => '#' + t);
    const toRead = $('#opt-toread');
    if (toRead) toRead.onchange = () => { s.toRead = toRead.checked; };
    if ($('#import-readers')) memberPicker($('#import-readers'), members, s.readers, { onChange: (ids) => { s.readers = ids; } });
    $('#opt-dup').onchange = (e) => { s.dup = e.target.value; };
  };
  if (s.mode === 'scan') {
    batchScan(body, options);
    bindOptions();
  } else if (s.mode === 'isbn') {
    body.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">1. La liste</h3>
        <div class="field"><label for="isbn-list">ISBN ${hint('Un par ligne, ou séparés par des espaces, virgules… Tu peux aussi charger un fichier (.xlsx, .csv, .txt).')}</label>
          <textarea id="isbn-list" placeholder="9782070612758&#10;978-2-07-036822-8&#10;…">${esc(s.text)}</textarea></div>
        <div class="btn-row">
          <label class="btn btn-small" style="margin:0">Fichier…<input type="file" id="import-file" accept=".xlsx,.csv,.txt" hidden></label>
          <span class="small muted" id="file-name">${esc(s.fileName)}</span>
          <span style="margin-left:auto" class="small">Modèle : <a href="${tpl('isbn', 'xlsx')}">Excel</a> · <a href="${tpl('isbn', 'csv')}">CSV</a></span>
        </div>
        <h3>2. Options</h3>
        ${options}
        <button class="btn btn-primary" id="analyse"><span class="hide-mobile">Analyser la liste</span><span class="show-mobile">Analyser</span></button>
      </div>
      <div id="preview"></div>`;
    bindOptions();
    $('#isbn-list').addEventListener('input', (e) => { s.text = e.target.value; });
    $('#import-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const rows = await readTable(file);
        s.text = rows.flat().map(cellText).filter((c) => c && !/^isbn/i.test(c)).join('\n');
        s.fileName = file.name;
        $('#isbn-list').value = s.text;
        $('#file-name').textContent = file.name;
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#analyse').onclick = () => {
      const perIsbn = Math.max(1, Math.min(50, parseInt($('#opt-copies').value, 10) || 1));
      const location = $('#opt-location').value.trim();
      const categories = s.cats.join(',');
      const counts = new Map();
      const errors = [];
      // Virgules : separateurs, sauf dans un ISBN en notation scientifique (9,78207E+12).
      s.text.split(/[\s;]+/).filter(Boolean)
        .flatMap((t) => (/^\d[.,]\d+E\+?\d+$/i.test(t) ? [t] : t.split(',')))
        .filter(Boolean).forEach((token) => {
        const r = isbnFromCell(token);
        if (r.isbn) counts.set(r.isbn, (counts.get(r.isbn) || 0) + perIsbn);
        else if (r.error) errors.push(r.error);
      });
      const format = $('#opt-format') ? $('#opt-format').value : 'physical';
      const tags = features().tags ? s.tags.join(',') : undefined;
      s.items = Array.from(counts).map(([isbn, copies]) => ({ data: { isbn, copies, location, categories, tags, format }, label: isbn }));
      s.items.push(...errors.map((e) => ({ error: e, label: '' })));
      s.options = importOptions({ fillFromIsbn: true });
      s.results = null;
      renderPreview();
    };
  } else {
    body.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">1. Le fichier ${hint('Une ligne par livre, une colonne par champ. Seul l\'ISBN ou le titre est obligatoire ; les autres colonnes sont facultatives, dans n\'importe quel ordre. Un export (inventaire, fiches incomplètes) peut être réimporté tel quel.')}</h3>
        <div class="btn-row">
          <label class="btn" style="margin:0">Choisir le fichier<input type="file" id="import-file" accept=".xlsx,.csv" hidden></label>
          <span class="small muted">${esc(s.fileName)}</span>
          <span style="margin-left:auto" class="small">Modèle : <a href="${tpl('full', 'xlsx')}">Excel</a> · <a href="${tpl('full', 'csv')}">CSV</a></span>
        </div>
        <div id="mapping"></div>
        <h3>2. Options</h3>
        ${options}
        <button class="btn btn-primary" id="analyse" ${s.rows ? '' : 'disabled'}><span class="hide-mobile">Analyser le fichier</span><span class="show-mobile">Analyser</span></button>
      </div>
      <div id="preview"></div>`;
    const renderMapping = () => {
      if (!s.rows) return;
      const header = s.rows[0];
      $('#mapping').innerHTML = `
        <h3>Colonnes du fichier</h3>
        <p class="small muted">${s.rows.length - 1} ligne(s) ${hint('Vérifie à quel champ correspond chaque colonne.')}</p>
        <div class="table-wrap"><table><thead><tr><th>Colonne</th><th>Exemple</th><th>Champ</th></tr></thead><tbody>
        ${header.map((hd, i) => `<tr><td><strong>${esc(cellText(hd)) || `(colonne ${i + 1})`}</strong></td>
          <td class="small muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cellText((s.rows.slice(1).find((r) => cellText(r[i])) || [])[i]))}</td>
          <td><select data-col="${i}"><option value="">— ignorer —</option>
            ${IMPORT_FIELDS.map((f) => `<option value="${f.key}" ${s.mapping[i] === f.key ? 'selected' : ''}>${f.label}</option>`).join('')}</select></td></tr>`).join('')}
        </tbody></table></div>`;
      $$('[data-col]').forEach((sel) => { sel.onchange = () => { s.mapping[Number(sel.dataset.col)] = sel.value; }; });
    };
    renderMapping();
    $('#import-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const rows = await readTable(file);
        if (rows.length < 2) throw new Error('Le fichier doit contenir une ligne de titres de colonnes puis au moins un livre.');
        s.rows = rows;
        s.fileName = file.name;
        s.mapping = rows[0].map(guessField);
        s.items = [];
        s.results = null;
        viewImport();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#analyse').onclick = () => {
      const fill = $('#opt-fill').checked;
      const update = $('#opt-dup').value === 'update';
      const defLocation = update ? '' : $('#opt-location').value.trim();
      const col = (key) => s.mapping.lastIndexOf(key);
      s.items = s.rows.slice(1).map((r, n) => {
        const get = (key) => (col(key) >= 0 ? cellText(r[col(key)]) : '');
        const d = {};
        IMPORT_FIELDS.forEach((f) => { if (f.key !== 'isbn') d[f.key] = get(f.key); });
        d.location = d.location || defLocation;
        d.copies = parseInt(d.copies, 10) || 1;
        const line = `Ligne ${n + 2}`;
        const isbnCell = col('isbn') >= 0 ? r[col('isbn')] : '';
        const ir = isbnFromCell(isbnCell);
        if (ir.error && !d.title) return { error: `${line} : ${ir.error}`, label: line };
        d.isbn = ir.isbn || ir.raw || '';
        if (!d.isbn && !d.title) return { error: `${line} : ni ISBN ni titre.`, label: line };
        if (!d.title && !fill && !update) return { error: `${line} : titre manquant (active « Compléter via l'ISBN »).`, label: line };
        return { data: d, label: d.title || d.isbn, warning: ir.error ? `ISBN non valide, importé tel quel` : '' };
      });
      s.options = importOptions({ fillFromIsbn: fill });
      s.results = null;
      renderPreview();
    };
  }
  if (s.items.length) renderPreview();
}

// Petit bip de confirmation (scan en serie), sans fichier son.
let audioCtx = null;
function beep(ok = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 1175 : 330;
    g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + (ok ? 0.09 : 0.25));
  } catch (e) { /* audio indisponible */ }
}

// Scan en serie : la camera reste ouverte, chaque code-barres lu s'ajoute a une
// liste (miniature de couverture + titre des que la recherche aboutit). Les fiches
// sont creees ensuite en une fois.
function batchScan(body, options) {
  const s = importState;
  const lastSeen = new Map();
  let camera = null;
  let queue = Promise.resolve();

  body.innerHTML = `
    <div class="card">
      <div class="batch-layout">
        <div>
          <div class="scanner-video barcode" id="batch-video-box" hidden><video playsinline muted id="batch-video"></video><div class="frame"></div></div>
          <div class="btn-row">
            <button class="btn btn-primary" type="button" id="cam-toggle"><span class="hide-mobile">Démarrer la caméra</span><span class="show-mobile">Caméra</span></button>
            <label class="btn" style="margin:0">Photo<input type="file" id="batch-photo" accept="image/*" capture="environment" hidden></label>
          </div>
          <p class="small muted" style="margin-top:8px"><span id="batch-status">Un bip confirme chaque livre scanné.</span> ${hint('Scanne les livres les uns après les autres. Un lecteur de codes-barres USB fonctionne aussi dans le champ ci-dessous.')}</p>
          <form class="isbn-row" id="batch-manual">
            <input name="isbn" placeholder="ISBN tapé ou lu par un lecteur USB" inputmode="numeric" autocomplete="off">
            <button class="btn" type="submit">Ajouter</button>
          </form>
        </div>
        <div>
          <div class="btn-row" style="justify-content:space-between"><h3 style="margin:0">Livres scannés (<span id="batch-count">0</span>)</h3>
            <button class="btn btn-small btn-danger" type="button" id="batch-clear">Vider</button></div>
          <div id="batch-list" style="margin-top:8px"></div>
        </div>
      </div>
      <h3>Options</h3>
      ${options}
      <div class="btn-row"><button class="btn btn-primary" type="button" id="batch-create"><span class="hide-mobile">Créer les fiches</span><span class="show-mobile">Créer</span></button></div>
    </div>
    <div id="preview"></div>`;

  const status = (msg) => { $('#batch-status').textContent = msg; };

  function itemHtml(it, i) {
    const f = it.found;
    const img = f && f.coverUrl ? `<img class="thumb" src="${esc(f.coverUrl)}" alt="" loading="lazy" data-onerror="hide">` : '<span class="thumb"></span>';
    const title = it.state === 'loading' ? '<span class="muted">Recherche…</span>'
      : f ? `<strong>${esc(f.title)}</strong><div class="small muted">${esc(f.authors || '')}${f.year ? ' · ' + f.year : ''}</div>`
        : '<span style="color:var(--warn)">Introuvable</span><div class="small muted">sera créé si un titre est trouvé, sinon ignoré</div>';
    return `<div class="list-item batch-item ${it.flash ? 'flash' : ''}">
      ${img}
      <div class="grow">${title}<div class="small code muted">${esc(it.isbn)}</div>
        ${it.existing && it.existing.length ? `<span class="badge badge-warn">Déjà au catalogue</span>` : ''}</div>
      <div class="qty"><button type="button" data-dec="${i}" aria-label="Un exemplaire de moins">−</button><span>${it.copies}</span><button type="button" data-inc="${i}" aria-label="Un exemplaire de plus">+</button></div>
      <button type="button" class="rm" data-rm="${i}" aria-label="Retirer">×</button>
    </div>`;
  }

  function renderList() {
    $('#batch-count').textContent = s.batch.length;
    const list = $('#batch-list');
    if (!list) return;
    list.innerHTML = s.batch.length ? `<div class="list">${s.batch.map(itemHtml).join('')}</div>`
      : '<p class="muted small">Aucun livre scanné pour le moment.</p>';
    $('#batch-create').textContent = s.batch.length ? `Créer ${s.batch.length} fiche(s)` : 'Créer les fiches';
    $('#batch-create').disabled = !s.batch.length || s.running;
    $$('[data-inc]', list).forEach((b) => { b.onclick = () => { s.batch[Number(b.dataset.inc)].copies++; renderList(); }; });
    $$('[data-dec]', list).forEach((b) => { b.onclick = () => { const it = s.batch[Number(b.dataset.dec)]; if (it.copies > 1) it.copies--; renderList(); }; });
    $$('[data-rm]', list).forEach((b) => { b.onclick = () => { s.batch.splice(Number(b.dataset.rm), 1); renderList(); }; });
    s.batch.forEach((it) => { it.flash = false; });
  }

  function lookupItem(it) {
    queue = queue.then(async () => {
      try {
        const r = await api(`/api/isbn/${it.isbn}`);
        it.found = r.found;
        it.existing = r.existing;
        it.state = r.found ? 'found' : 'notfound';
      } catch (e) { it.state = 'notfound'; }
      renderList();
    });
  }

  // Nouvel ISBN : ajoute en tete de liste ; deja present : un exemplaire de plus
  // (sauf s'il vient d'etre lu : la camera le voit encore).
  function addIsbn(isbn, fromCamera) {
    const now = Date.now();
    if (fromCamera && now - (lastSeen.get(isbn) || 0) < 2500) { lastSeen.set(isbn, now); return; }
    lastSeen.set(isbn, now);
    const existing = s.batch.find((it) => it.isbn === isbn);
    beep(true);
    if (navigator.vibrate) navigator.vibrate(60);
    if (existing) {
      existing.copies++;
      existing.flash = true;
      status(`${isbn} déjà dans la liste : ${existing.copies} exemplaires.`);
    } else {
      const it = { isbn, copies: 1, state: 'loading', flash: true };
      s.batch.unshift(it);
      status(`✓ ${isbn} ajouté.`);
      lookupItem(it);
    }
    renderList();
  }

  const accept = (raw) => isbnFromScan(raw);
  $('#cam-toggle').onclick = () => {
    if (camera) {
      camera.stop();
      camera = null;
      $('#batch-video-box').hidden = true;
      $('#cam-toggle').textContent = 'Démarrer la caméra';
      return;
    }
    $('#batch-video-box').hidden = false;
    $('#cam-toggle').textContent = 'Arrêter la caméra';
    camera = startCamera({
      video: $('#batch-video'),
      formats: ['ean_13'],
      accept,
      hint: 'Présente les codes-barres les uns après les autres.',
      onStatus: status,
      onValue: (isbn) => { addIsbn(isbn, true); return false; },
    });
  };
  onLeave(() => { if (camera) camera.stop(); });
  $('#batch-photo').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    status('Analyse de la photo…');
    try {
      const values = await decodePhoto(file, ['ean_13'], accept);
      if (values.length) values.forEach((v) => addIsbn(v, false));
      else { beep(false); status('Aucun code-barres lisible sur la photo.'); }
    } catch (err) { status('Analyse impossible : ' + err.message); }
    e.target.value = '';
  };
  $('#batch-manual').onsubmit = (e) => {
    e.preventDefault();
    const r = isbnFromCell(e.target.isbn.value);
    if (r.isbn) { addIsbn(r.isbn, false); e.target.reset(); } else { beep(false); status(r.error || 'ISBN non reconnu.'); }
  };
  $('#batch-clear').onclick = () => {
    if (s.batch.length && !confirm('Vider la liste des livres scannés ?')) return;
    s.batch = [];
    renderList();
  };
  $('#batch-create').onclick = () => {
    if (!s.batch.length) return;
    const location = $('#opt-location').value.trim();
    const categories = s.cats.join(',');
    const format = $('#opt-format') ? $('#opt-format').value : 'physical';
    // Les informations deja trouvees sont envoyees telles quelles (pas de 2e recherche).
    s.items = s.batch.slice().reverse().map((it) => {
      const f = it.found || {};
      return {
        label: f.title || it.isbn,
        data: {
          isbn: it.isbn, copies: it.copies, location, categories, format,
          tags: features().tags ? s.tags.join(',') : undefined,
          collection: f.collection || '',
          title: f.title || '', subtitle: f.subtitle || '', authors: f.authors || '', publisher: f.publisher || '',
          year: f.year || '', pages: f.pages || '', summary: f.summary || '', coverUrl: f.coverUrl || '',
        },
      };
    });
    s.options = importOptions({ fillFromIsbn: true });
    s.results = null;
    if (camera) $('#cam-toggle').click();
    renderPreview();
    runImport().then(() => { s.batch = s.batch.filter((it, i) => { const r = s.results && s.results[s.batch.length - 1 - i]; return !r || r.status === 'error'; }); renderList(); });
  };
  renderList();
}

function renderPreview() {
  const s = importState;
  const ok = s.items.filter((i) => i.data);
  const bad = s.items.filter((i) => i.error);
  const copies = ok.reduce((n, i) => n + (i.data.copies || 1), 0);
  const statusHtml = (r) => {
    if (!r) return '<span class="small muted">en attente</span>';
    if (r.status === 'created') return `<span class="badge badge-ok">Ajouté</span> <a href="#/book/${r.bookId}">${esc(r.title)}</a> <span class="small muted code">${esc(r.codes.join(', '))}</span> ${r.ebook ? '<span class="badge badge-ebook">+ numérique</span>' : ''}`;
    if (r.status === 'copies') return `${r.codes.length ? `<span class="badge badge-ok">+ ${r.codes.length} ex.</span> ` : ''}<a href="#/book/${r.bookId}">${esc(r.title)}</a> <span class="small muted code">${esc(r.codes.join(', '))}</span> ${r.ebook ? '<span class="badge badge-ebook">+ numérique</span>' : ''}`;
    if (r.status === 'skipped') return `<span class="badge badge-muted">Ignoré</span> déjà au catalogue : <a href="#/book/${r.bookId}">${esc(r.title)}</a>`;
    if (r.status === 'updated') return `<span class="badge badge-ok">Mis à jour</span> <a href="#/book/${r.bookId}">${esc(r.title)}</a> <span class="small muted">${esc(r.fields.join(', '))}</span>`;
    if (r.status === 'unchanged') return `<span class="badge badge-muted">Inchangé</span> <a href="#/book/${r.bookId}">${esc(r.title)}</a>`;
    return `<span class="badge badge-warn">Erreur</span> <span class="small">${esc(r.error)}</span>`;
  };
  const done = s.results ? s.results.filter(Boolean).length : 0;

  // Rapport filtrable : chaque ligne a un statut (lignes non valides de la liste
  // comprises), pour retrouver d'un coup ce qui n'a pas ete importe.
  const rows = ok.map((it, i) => ({ it, i, r: s.results ? s.results[i] : null }))
    .concat(bad.map((it) => ({ it, bad: true })));
  const keyOf = (row) => (row.bad ? 'invalid' : row.r ? row.r.status : 'pending');
  const notImported = (k) => k === 'error' || k === 'invalid' || k === 'skipped' || (k === 'pending' && s.results && !s.running);
  const count = (pred) => rows.filter((row) => pred(keyOf(row))).length;
  const filters = [
    { key: 'all', label: 'Tous', count: rows.length, test: () => true },
    { key: 'created', label: 'Ajoutés', count: count((k) => k === 'created'), test: (k) => k === 'created' },
    { key: 'copies', label: 'Exemplaires ajoutés', count: count((k) => k === 'copies'), test: (k) => k === 'copies' },
    { key: 'updated', label: 'Mis à jour', count: count((k) => k === 'updated'), test: (k) => k === 'updated' },
    { key: 'unchanged', label: 'Inchangés', count: count((k) => k === 'unchanged'), test: (k) => k === 'unchanged' },
    { key: 'skipped', label: 'Ignorés', count: count((k) => k === 'skipped'), test: (k) => k === 'skipped' },
    { key: 'error', label: 'Erreurs', count: count((k) => k === 'error' || k === 'invalid'), test: (k) => k === 'error' || k === 'invalid' },
    { key: 'not', label: 'Non importés', count: count(notImported), test: notImported },
    { key: 'pending', label: 'En attente', count: count((k) => k === 'pending'), test: (k) => k === 'pending' },
  ];
  let filter = s.filter || 'all';
  if (!filters.some((f) => f.key === filter && (f.count || f.key === 'all'))) filter = 'all';
  const shown = rows.filter((row) => filters.find((f) => f.key === filter).test(keyOf(row)));
  const errorRows = rows.filter((row) => !row.bad && keyOf(row) === 'error');
  const failedIsbns = errorRows.map((row) => row.it.data.isbn).filter(Boolean);
  const retryable = errorRows.map((row) => row.i);
  const summary = s.results && !s.running ? (() => {
    const c = (st) => s.results.filter((r) => r && r.status === st).length;
    return `<div class="info-box"><strong>Import terminé${s.stop ? ' (arrêté)' : ''}.</strong> ${c('created')} livre(s) ajouté(s), ${c('copies')} exemplaire(s) ajouté(s) à des livres existants${c('updated') || c('unchanged') ? `, ${c('updated')} fiche(s) mise(s) à jour, ${c('unchanged')} inchangée(s)` : ''}, ${c('skipped')} ignoré(s), ${c('error')} erreur(s).</div>
      <div class="btn-row" style="margin-bottom:12px"><button class="btn btn-primary" id="go-labels"><span class="hide-mobile">Imprimer les étiquettes en attente</span><span class="show-mobile">Étiquettes</span></button><a class="btn" href="#/"><span class="hide-mobile">Voir le catalogue</span><span class="show-mobile">Catalogue</span></a></div>`;
  })() : '';
  $('#preview').innerHTML = `
    <h2>3. ${s.results ? 'Import' : 'Vérification'}</h2>
    <div class="card">
      ${summary}
      <p><strong>${ok.length} livre(s)</strong> à importer (${copies} exemplaire(s))${bad.length ? `, <span style="color:var(--danger)">${bad.length} ligne(s) en erreur ignorée(s)</span>` : ''}.
        ${s.mode === 'isbn' || s.options.fillFromIsbn ? hint('La recherche des informations prend 1 à 2 secondes par ISBN.') : ''}</p>
      ${s.running || s.results ? `<div style="background:var(--surface-2);border-radius:999px;height:10px;overflow:hidden;margin:12px 0"><div style="height:100%;width:${ok.length ? Math.round((done / ok.length) * 100) : 0}%;background:var(--accent);transition:width .2s"></div></div>
        <p class="small muted">${done} / ${ok.length}</p>` : ''}
      <div class="btn-row" style="margin:12px 0">
        ${s.running ? '<button class="btn btn-danger" id="stop">Arrêter</button>'
          : (!s.results && ok.length ? `<button class="btn btn-primary" id="run">Importer ${ok.length} livre(s)</button>` : '')}
        ${!s.running && failedIsbns.length ? `<button class="btn" id="copy-failed">Copier les ${failedIsbns.length} ISBN en erreur</button>` : ''}
        ${!s.running && retryable.length ? `<button class="btn" id="retry">Réessayer les ${retryable.length} erreur(s)</button>` : ''}
      </div>
      ${rows.length ? `
        <div class="chips-filter">${filters.filter((f) => f.key === 'all' || f.count).map((f) => `
          <button type="button" class="pill ${filter === f.key ? 'on pill-read' : ''}" data-filter="${f.key}">${f.label} (${f.count})</button>`).join('')}</div>
        <div class="table-wrap" style="max-height:460px;overflow:auto"><table><thead><tr><th>#</th><th>ISBN</th><th>Titre</th><th>Ex.</th><th>Résultat</th></tr></thead><tbody>
        ${shown.map((row) => row.bad
          ? `<tr><td class="small muted">—</td><td class="code small">—</td><td colspan="2" class="small">${esc(row.it.error)}</td><td><span class="badge badge-warn">Non valide</span></td></tr>`
          : `<tr><td class="small muted">${row.i + 1}</td><td class="code small">${esc(row.it.data.isbn || '—')}</td>
            <td>${row.it.data.title ? esc(row.it.data.title) : '<span class="muted small">(complété via l\'ISBN)</span>'}${row.it.warning ? `<div class="small" style="color:var(--warn)">${esc(row.it.warning)}</div>` : ''}</td>
            <td>${row.it.data.copies || 1}</td><td>${statusHtml(row.r)}</td></tr>`).join('')
          || '<tr><td colspan="5" class="muted small">Aucune ligne pour ce filtre.</td></tr>'}
        </tbody></table></div>` : ''}
    </div>`;
  $$('[data-filter]').forEach((btn) => { btn.onclick = () => { s.filter = btn.dataset.filter; renderPreview(); }; });
  const cf = $('#copy-failed');
  if (cf) cf.onclick = async () => {
    try { await navigator.clipboard.writeText(failedIsbns.join('\n')); toast('ISBN copiés : colle-les dans « Liste d\'ISBN » pour les réessayer plus tard.'); } catch (e) { prompt('ISBN en erreur :', failedIsbns.join(' ')); }
  };
  const rt = $('#retry');
  if (rt) rt.onclick = () => runImport(retryable);
  const run = $('#run');
  if (run) run.onclick = () => runImport();
  const stop = $('#stop');
  if (stop) stop.onclick = () => { s.stop = true; stop.disabled = true; stop.textContent = 'Arrêt après le livre en cours…'; };
  const gl = $('#go-labels');
  if (gl) gl.onclick = () => { state.labels = { mode: 'pending', manual: [] }; go('#/labels'); };
}

function warnBeforeLeaving(e) { e.preventDefault(); e.returnValue = ''; }

// Import de toutes les lignes, ou seulement de celles indiquees (nouvel essai des erreurs).
async function runImport(onlyIndexes) {
  const s = importState;
  const ok = s.items.filter((i) => i.data);
  if (!onlyIndexes || !s.results) { s.results = new Array(ok.length).fill(null); s.filter = 'all'; }
  const indexes = onlyIndexes || ok.map((_, i) => i);
  indexes.forEach((i) => { s.results[i] = null; });
  // Lignes du suivi des imports (reprises telles quelles pour un nouvel essai).
  const fresh = indexes.filter((i) => !ok[i].hid);
  historyAdd(s.mode, fresh.map((i) => ok[i].data.isbn || ok[i].label)).forEach((id, n) => { ok[fresh[n]].hid = id; });
  indexes.forEach((i) => { if (!fresh.includes(i)) historyUpdate(ok[i].hid, { status: 'pending', error: '' }); });
  s.running = true;
  s.stop = false;
  window.addEventListener('beforeunload', warnBeforeLeaving);
  renderPreview();
  for (const i of indexes) {
    if (s.stop) break;
    try {
      // Lecteurs : colonne du fichier si remplie, sinon le choix des options.
      const body = { ...ok[i].data, ...s.options };
      if (ok[i].data.readers) body.readers = ok[i].data.readers; else if (!s.options.readers) delete body.readers;
      s.results[i] = await api('/api/import/book', { method: 'POST', body });
    } catch (err) {
      s.results[i] = { status: 'error', error: err.message };
    }
    const r = s.results[i];
    historyUpdate(ok[i].hid, { status: r.status, bookId: r.bookId, title: r.title || ok[i].data.title || '', error: r.error || '' });
    if ($('#preview')) renderPreview();
  }
  s.running = false;
  // Import arrete : les lignes non envoyees sortent du suivi.
  historyRemove(indexes.filter((i) => !s.results[i]).map((i) => ok[i].hid));
  window.removeEventListener('beforeunload', warnBeforeLeaving);
  if ($('#preview')) renderPreview();
  toast('Import terminé.');
}

export { normHeader, isbnFromCell, chipField, viewImport, warnBeforeLeaving };
