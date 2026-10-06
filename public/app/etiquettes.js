// Etiquettes — module de l'interface (organisation : public/app/README.md).
import './souhaits.js';
import { LIB, state } from './etat.js';
import { $, $$, view, esc, hint, mediaSrc, api, toast, debounce } from './utilitaires.js';
import { scanCopy } from './scanner.js';
import { route } from './routage.js';

// Formats de planches A4 courants (dimensions en mm). Les marges peuvent etre
// ajustees a la main si l'imprimante decale legerement l'impression.
const LABEL_PRESETS = {
  L7160: { name: 'Avery L7160 · 3×7 · 63,5×38,1 mm', cols: 3, rows: 7, width: 63.5, height: 38.1, top: 15.15, left: 7.2, hPitch: 66.04, vPitch: 38.1 },
  L7159: { name: 'Avery L7159 · 3×8 · 63,5×33,9 mm', cols: 3, rows: 8, width: 63.5, height: 33.9, top: 13.1, left: 7.2, hPitch: 66.04, vPitch: 33.9 },
  L7163: { name: 'Avery L7163 · 2×7 · 99,1×38,1 mm', cols: 2, rows: 7, width: 99.1, height: 38.1, top: 15.15, left: 4.65, hPitch: 101.6, vPitch: 38.1 },
  L7651: { name: 'Avery L7651 · 5×13 · 38,1×21,2 mm', cols: 5, rows: 13, width: 38.1, height: 21.2, top: 10.7, left: 4.7, hPitch: 40.6, vPitch: 21.2 },
  A70x37: { name: 'Planche 3×8 · 70×37 mm (bord à bord)', cols: 3, rows: 8, width: 70, height: 37, top: 0.5, left: 0, hPitch: 70, vPitch: 37 },
  A70x36: { name: 'Planche 3×8 · 70×36 mm', cols: 3, rows: 8, width: 70, height: 36, top: 4.5, left: 0, hPitch: 70, vPitch: 36 },
  A70x42: { name: 'Planche 3×7 · 70×42,3 mm (bord à bord)', cols: 3, rows: 7, width: 70, height: 42.3, top: 0.4, left: 0, hPitch: 70, vPitch: 42.3 },
  A105x37: { name: 'Planche 2×8 · 105×37 mm', cols: 2, rows: 8, width: 105, height: 37, top: 0.5, left: 0, hPitch: 105, vPitch: 37 },
};
const LAYOUT_FIELDS = [['cols', 'Colonnes'], ['rows', 'Lignes'], ['width', 'Largeur (mm)'], ['height', 'Hauteur (mm)'],
  ['left', 'Marge gauche (mm)'], ['top', 'Marge haut (mm)'], ['hPitch', 'Pas horizontal (mm)'], ['vPitch', 'Pas vertical (mm)']];

// Selection des etiquettes : par defaut toutes celles en attente (nouveaux
// exemplaires, codes regeneres) ; sinon une selection manuelle construite par
// recherche (titre, auteur, code) ou par scan, sans longue liste a cocher.
// Une liste d'attente par type d'etiquette (completes / de tranche), independantes.
async function viewLabels() {
  const [settings, pendingFull, pendingSpine] = await Promise.all([api('/api/settings'),
    api('/api/labels/pending'), api('/api/labels/pending?kind=spine')]);
  const pendings = { full: pendingFull, spine: pendingSpine };
  // Deux types d'etiquettes, chacun avec son format de planche : completes (QR code,
  // titre, code) et de tranche (code seul, ecrit verticalement). Enregistres ensemble
  // (labelLayout = format complet + kind + spine).
  const saved = settings.labelLayout || {};
  const { spine: savedSpine, kind: savedKind, ...savedFull } = saved;
  const layouts = {
    full: Object.assign({ preset: 'L7160', showLogo: true, showName: true, showTitle: true, showAuthor: true, guides: true }, LABEL_PRESETS.L7160, savedFull),
    spine: Object.assign({ preset: 'L7651', guides: true, direction: 'up' }, LABEL_PRESETS.L7651, savedSpine || {}),
  };
  let kind = savedKind === 'spine' ? 'spine' : 'full';
  let layout = layouts[kind];
  let pending = pendings[kind];
  const sel = state.labels;
  let start = 1;
  let data = null;

  view().innerHTML = `
    <div class="page-head"><div><h1>Étiquettes ${hint('Planches A4 autocollantes, avec QR code à scanner pour les prêts et retours.')}</h1></div></div>
    <div class="label-layout">
      <div>
        <div class="card">
          <h3 style="margin-top:0">Type d'étiquette</h3>
          <div class="seg" id="kind-seg">
            <button type="button" data-kind="full">Complètes</button>
            <button type="button" data-kind="spine">De tranche</button>
          </div>
          <p class="small muted" id="kind-help" style="margin:8px 0 0"></p>
        </div>
        <div class="card">
          <h3 style="margin-top:0">Quoi imprimer ?</h3>
          <div class="seg">
            <button type="button" data-mode="pending">En attente (<span id="pending-count">${pending.length}</span>)</button>
            <button type="button" data-mode="manual">Sélection (<span id="manual-count">0</span>)</button>
          </div>
          <div id="mode-body"></div>
          <p class="summary-line" id="summary"></p>
        </div>
        <div class="card">
          <h3 style="margin-top:0">Format de planche</h3>
          <div class="field"><select id="preset">
            ${Object.entries(LABEL_PRESETS).map(([k, p]) => `<option value="${k}" ${layout.preset === k ? 'selected' : ''}>${p.name}</option>`).join('')}
            <option value="custom" ${layout.preset === 'custom' ? 'selected' : ''}>Personnalisé</option>
          </select></div>
          <details id="dims"><summary class="small" style="cursor:pointer;margin-bottom:10px">Dimensions et marges</summary>
            <div class="grid-2">${LAYOUT_FIELDS.map(([k, label]) => `<div class="field"><label>${label}</label><input type="number" step="0.01" data-dim="${k}" value="${layout[k]}"></div>`).join('')}</div>
          </details>
          <div class="field"><label>Commencer à la case n° ${hint('Pour réutiliser une planche déjà entamée.')}</label><input type="number" id="start" min="1" value="1"></div>
          <div id="full-opts">
            <label class="check"><input type="checkbox" id="opt-logo"> Logo</label>
            <label class="check"><input type="checkbox" id="opt-name"> Nom de la bibliothèque</label>
            <label class="check"><input type="checkbox" id="opt-title"> Titre du livre</label>
            <label class="check"><input type="checkbox" id="opt-author"> Auteur(s)</label>
          </div>
          <div class="field" id="spine-opts"><label>Sens du code ${hint('De bas en haut : sens habituel des tranches de livres en français. De haut en bas : sens anglo-saxon. Une lettre par ligne : lettres droites, empilées.')}</label>
            <select id="opt-direction"><option value="up">De bas en haut</option><option value="down">De haut en bas</option>
              <option value="stack">Une lettre par ligne</option></select></div>
          <label class="check"><input type="checkbox" id="opt-guides"> Contours dans l'aperçu</label>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn btn-primary" id="print">Imprimer</button>${hint('Dans la fenêtre d\'impression : format A4, marges « Aucune », échelle 100 % (« Taille réelle »).')}
          </div>
        </div>
      </div>
      <div class="sheets" id="sheets"></div>
    </div>`;

  function selectedCodes() {
    return sel.mode === 'pending' ? pending.map((p) => p.code) : sel.manual.map((m) => m.code);
  }

  function addManual(items) {
    let added = 0;
    for (const it of items) {
      if (!sel.manual.some((m) => m.code === it.code)) { sel.manual.push({ code: it.code, title: it.title }); added++; }
    }
    return added;
  }

  // Liste compacte des etiquettes en attente, regroupees par livre.
  function groupedHtml(list) {
    const groups = new Map();
    list.forEach((p) => { if (!groups.has(p.title)) groups.set(p.title, []); groups.get(p.title).push(p.code); });
    return Array.from(groups).map(([title, codes]) => `<div class="sel-row"><span class="grow">${esc(title)}</span><span class="small muted code">${codes.map(esc).join(', ')}</span></div>`).join('');
  }

  const kindName = () => (kind === 'spine' ? 'de tranche' : 'complètes');

  async function resetAll() {
    if (!confirm(`Remettre les étiquettes ${kindName()} de tous les exemplaires papier dans la liste d'attente ?\nLes codes ne changent pas.`)) return;
    try {
      const r = await api('/api/labels/reset', { method: 'POST', body: { kind } });
      sel.mode = 'pending';
      toast(r.reset ? `${r.reset} étiquette(s) remise(s) en attente.` : 'Toutes les étiquettes étaient déjà en attente.');
      route();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function clearPending() {
    if (!confirm(`Vider la liste d'attente des étiquettes ${kindName()} (${pending.length}) sans les imprimer ?`)) return;
    try {
      await api('/api/labels/clear', { method: 'POST', body: { kind } });
      sel.mode = 'pending';
      toast('Liste d\'attente vidée.');
      route();
    } catch (err) { toast(err.message, 'error'); }
  }

  function renderMode() {
    $('#pending-count').textContent = pending.length;
    $$('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === sel.mode));
    $('#manual-count').textContent = sel.manual.length;
    const body = $('#mode-body');
    if (sel.mode === 'pending') {
      body.innerHTML = pending.length ? `
        <details><summary class="small" style="cursor:pointer;margin-bottom:8px">Voir le détail</summary>
          <div class="sel-list">${groupedHtml(pending)}</div></details>
        <div class="btn-row" style="margin-top:10px"><button class="btn btn-small" type="button" id="customize">Personnaliser</button>${hint('Nouveaux exemplaires et codes régénérés, pas encore imprimés. Personnaliser : copie cette liste dans « Sélection » pour la modifier.')}
          <button class="btn btn-small btn-danger" type="button" id="clear-pending">Vider la liste</button>${hint('Retire tous les livres de cette liste d\'attente sans imprimer (étiquettes déjà posées…).')}
          <button class="btn btn-small" type="button" id="reset-all">Tout remettre à imprimer</button></div>`
        : `<p class="muted small">Aucune étiquette en attente. Utilise « Sélection » pour réimprimer des étiquettes.</p>
          <div class="btn-row"><button class="btn btn-small" type="button" id="reset-all">Tout remettre à imprimer</button>${hint('Remet les étiquettes de tous les exemplaires papier dans « En attente », sans changer leurs codes.')}</div>`;
      $('#reset-all').onclick = resetAll;
      const cp = $('#clear-pending');
      if (cp) cp.onclick = clearPending;
      const cz = $('#customize');
      if (cz) cz.onclick = () => { sel.manual = []; addManual(pending); sel.mode = 'manual'; renderMode(); refresh(); };
      return;
    }
    body.innerHTML = `
      <div class="isbn-row">
        <input type="search" id="lbl-q" placeholder="Titre, auteur ou code…" autocomplete="off">
        <button class="btn" type="button" id="lbl-scan" title="Scanner une étiquette">Scanner</button>
      </div>
      <div id="lbl-results"></div>
      <div class="btn-row small" style="margin:10px 0 8px">
        ${pending.length ? `<button class="btn btn-small" type="button" id="add-pending">+ Les ${pending.length} en attente</button>` : ''}
        ${sel.manual.length ? '<button class="btn btn-small btn-danger" type="button" id="clear">Vider</button>' : ''}
      </div>
      ${sel.manual.length ? `<div class="sel-list">${sel.manual.map((m, i) => `
        <div class="sel-row"><span class="code">${esc(m.code)}</span><span class="grow muted">${esc(m.title || '')}</span>
          <button type="button" data-rm="${i}" aria-label="Retirer">×</button></div>`).join('')}</div>`
        : '<p class="muted small">Recherche un livre (titre, auteur) ou un code pour l\'ajouter, ou scanne une étiquette existante.</p>'}`;
    const q = $('#lbl-q');
    q.addEventListener('input', debounce(async () => {
      const out = $('#lbl-results');
      if (!q.value.trim()) { out.innerHTML = ''; return; }
      const results = await api(`/api/labels/search?kind=${kind}&q=${encodeURIComponent(q.value)}`).catch(() => []);
      out.innerHTML = results.length ? `<div class="search-results">${results.map((b, i) => `
        <div class="sel-row"><span class="grow"><strong>${esc(b.title)}</strong> <span class="muted">${esc(b.authors)}</span></span>
          <button type="button" class="add" data-add-book="${i}">+ ${b.copies.length > 1 ? `${b.copies.length} ex.` : esc(b.copies[0].code)}</button></div>
        ${b.copies.length > 1 ? b.copies.map((c, j) => `<div class="sel-row" style="padding-left:22px"><span class="grow code small">${esc(c.code)}${c.location ? ` <span class="muted">· ${esc(c.location)}</span>` : ''}</span>
          <button type="button" class="add" data-add-copy="${i}:${j}">+</button></div>`).join('') : ''}`).join('')}</div>`
        : '<p class="small muted" style="margin-top:6px">Aucun résultat.</p>';
      $$('[data-add-book]', out).forEach((btn) => {
        btn.onclick = () => { const b = results[Number(btn.dataset.addBook)]; addManual(b.copies.map((c) => ({ code: c.code, title: b.title }))); renderMode(); refresh(); };
      });
      $$('[data-add-copy]', out).forEach((btn) => {
        btn.onclick = () => { const [i, j] = btn.dataset.addCopy.split(':').map(Number); addManual([{ code: results[i].copies[j].code, title: results[i].title }]); renderMode(); refresh(); };
      });
    }, 250));
    $('#lbl-scan').onclick = async () => {
      const code = await scanCopy();
      if (!code) return;
      try {
        const r = await api(`/api/copies/by-code/${encodeURIComponent(code)}`);
        addManual([{ code: r.copy.code, title: r.book.title }]);
        renderMode();
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    };
    const ap = $('#add-pending');
    if (ap) ap.onclick = () => { addManual(pending); renderMode(); refresh(); };
    const cl = $('#clear');
    if (cl) cl.onclick = () => { sel.manual = []; renderMode(); refresh(); };
    $$('[data-rm]').forEach((btn) => { btn.onclick = () => { sel.manual.splice(Number(btn.dataset.rm), 1); renderMode(); refresh(); }; });
  }

  function readLayout() {
    LAYOUT_FIELDS.forEach(([k]) => { layout[k] = parseFloat($(`[data-dim="${k}"]`).value) || 0; });
    layout.cols = Math.max(1, Math.round(layout.cols));
    layout.rows = Math.max(1, Math.round(layout.rows));
    if (kind === 'full') {
      layout.showLogo = $('#opt-logo').checked;
      layout.showName = $('#opt-name').checked;
      layout.showTitle = $('#opt-title').checked;
      layout.showAuthor = $('#opt-author').checked;
    } else {
      layout.direction = $('#opt-direction').value;
    }
    layout.guides = $('#opt-guides').checked;
    start = Math.max(1, parseInt($('#start').value, 10) || 1);
  }

  const saveLayout = debounce(() => api('/api/settings', { method: 'PUT', body: { labelLayout: { ...layouts.full, kind, spine: layouts.spine } } }).catch(() => {}), 800);

  // Champs du formulaire d'apres le type choisi (format et options propres a chacun).
  function showKind() {
    layout = layouts[kind];
    pending = pendings[kind];
    $$('#kind-seg button').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
    $('#kind-help').textContent = kind === 'spine'
      ? 'Code du livre seul, écrit verticalement, à coller sur la tranche. Choisis des étiquettes étroites (format personnalisé au besoin).'
      : 'QR code à scanner pour les prêts et retours, avec le titre et le code.';
    $('#preset').value = LABEL_PRESETS[layout.preset] ? layout.preset : 'custom';
    LAYOUT_FIELDS.forEach(([k]) => { $(`[data-dim="${k}"]`).value = layout[k]; });
    $('#full-opts').hidden = kind !== 'full';
    $('#spine-opts').hidden = kind !== 'spine';
    $('#opt-logo').checked = !!layout.showLogo;
    $('#opt-name').checked = !!layout.showName;
    $('#opt-title').checked = !!layout.showTitle;
    $('#opt-author').checked = !!layout.showAuthor;
    $('#opt-direction').value = layout.direction || 'up';
    $('#opt-guides').checked = !!layout.guides;
  }

  function renderSheets() {
    readLayout();
    const target = $('#sheets');
    const items = data ? data.items : [];
    const perSheet = layout.cols * layout.rows;
    const offset = Math.min(start - 1, perSheet - 1);
    const sheets = items.length ? Math.ceil((items.length + offset) / perSheet) : 0;
    const more = selectedCodes().length - items.length;
    $('#summary').textContent = items.length ? `${items.length} étiquette${items.length > 1 ? 's' : ''} · ${sheets} planche${sheets > 1 ? 's' : ''}`
      + (more > 0 ? ` · ${more} autre(s) au prochain lot` : '') : '';
    if (!items.length) { target.innerHTML = '<div class="empty">Rien à imprimer pour le moment.</div>'; return; }
    const slots = Array(offset).fill(null).concat(items);
    const small = layout.height < 26 || layout.width < 45;
    const qrSize = Math.min(layout.height - 4, layout.width * 0.45);
    // Echelle du texte et du logo : suit la place laissee a cote du QR code
    // (reference : etiquette 63,5×38 mm), bornee pour rester lisible.
    const k = Math.max(0.6, Math.min(2.5, Math.min(layout.height / 38, (layout.width - qrSize) / 35)));
    const showName = layout.showName && data.libraryName;
    const showLogo = layout.showLogo && data.logoUrl;
    let html = '';
    for (let s = 0; s < slots.length; s += perSheet) {
      html += `<div class="sheet ${layout.guides ? 'show-guides' : ''}">`;
      slots.slice(s, s + perSheet).forEach((item, i) => {
        const col = i % layout.cols;
        const row = Math.floor(i / layout.cols);
        const pos = `left:${layout.left + col * layout.hPitch}mm;top:${layout.top + row * layout.vPitch}mm;width:${layout.width}mm;height:${layout.height}mm`;
        if (!item) { html += `<div class="lbl blank" style="${pos}"></div>`; return; }
        if (kind === 'spine') {
          // Taille du code : la plus grande qui tient dans la longueur et la largeur de
          // l'etiquette (police a chasse fixe : ~0,6 em par caractere).
          // Une lettre par ligne : ~1 em de haut et 0,6 em de large par caractere.
          const len = Math.max(1, String(item.code).length);
          const stack = layout.direction === 'stack';
          const size = stack
            ? Math.max(1.5, Math.min((layout.width - 1.5) / 0.7, (layout.height - 3) / (len * 1.1)))
            : Math.max(1.5, Math.min((layout.width - 1.5) * 0.85, (layout.height - 2) / (len * 0.62)));
          const dir = { up: 'up', down: '', stack: 'stack' }[layout.direction] ?? 'up';
          html += `<div class="lbl spine" style="${pos}"><span class="spine-code ${dir}" style="font-size:${size.toFixed(2)}mm">${esc(item.code)}</span></div>`;
          return;
        }
        html += `<div class="lbl ${small ? 'small' : ''}" style="${pos};--k:${k.toFixed(3)}">
          <div class="qr" style="width:${qrSize}mm;height:${qrSize}mm">${item.svg}</div>
          <div class="info">
            ${showName || showLogo ? `<div class="lib">${showLogo ? `<img src="${esc(mediaSrc(data.logoUrl))}" alt="">` : ''}${showName ? `<span>${esc(data.libraryName)}</span>` : ''}</div>` : ''}
            ${layout.showTitle ? `<div class="ttl">${esc(item.title)}</div>` : ''}
            ${layout.showAuthor && item.authors ? `<div class="aut">${esc(item.authors)}</div>` : ''}
            <div class="cd">${esc(item.code)}</div>
          </div>
        </div>`;
      });
      html += '</div>';
    }
    target.innerHTML = html;
  }

  let fetchToken = 0;
  async function refresh() {
    const codes = selectedCodes();
    const token = ++fetchToken;
    const result = codes.length
      ? await api('/api/labels', { method: 'POST', body: { codes, baseUrl: location.origin + LIB + '/' } })
      : { items: [] };
    if (token === fetchToken) { data = result; renderSheets(); }
  }

  $$('[data-mode]').forEach((btn) => {
    btn.onclick = () => { sel.mode = btn.dataset.mode; renderMode(); refresh(); };
  });
  $('#preset').onchange = (e) => {
    layout.preset = e.target.value;
    const p = LABEL_PRESETS[e.target.value];
    if (p) LAYOUT_FIELDS.forEach(([k]) => { $(`[data-dim="${k}"]`).value = p[k]; });
    else $('#dims').open = true;
    renderSheets();
    saveLayout();
  };
  $$('[data-dim]').forEach((input) => input.addEventListener('input', () => { layout.preset = 'custom'; $('#preset').value = 'custom'; renderSheets(); saveLayout(); }));
  ['#opt-logo', '#opt-name', '#opt-title', '#opt-author', '#opt-guides', '#opt-direction'].forEach((s) => { $(s).onchange = () => { renderSheets(); saveLayout(); }; });
  $$('#kind-seg button').forEach((btn) => {
    btn.onclick = () => { kind = btn.dataset.kind; showKind(); renderMode(); refresh(); saveLayout(); };
  });
  $('#start').oninput = renderSheets;
  $('#print').onclick = async () => {
    if (!data || !data.items.length) return toast('Aucune étiquette sélectionnée.', 'error');
    // Les planches sont copiees dans un conteneur enfant direct de <body> : la
    // feuille de style d'impression masque tout le reste de la page.
    let root = $('#print-root');
    if (!root) { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
    root.innerHTML = $('#sheets').innerHTML;
    await Promise.all($$('img', root).map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
    window.print();
    root.innerHTML = '';
    const printed = data.items.map((i) => i.code);
    if (confirm(`Les ${printed.length} étiquette(s) ${kindName()} se sont-elles bien imprimées ?\nElles seront retirées de la liste d'attente des étiquettes ${kindName()}.`)) {
      await api('/api/labels/mark-printed', { method: 'POST', body: { codes: printed, kind } });
      if (sel.mode === 'manual') sel.manual = [];
      sel.mode = 'pending';
      toast('Étiquettes marquées comme imprimées.');
      route();
    }
  };

  // Rien en attente et rien de choisi : on ouvre directement la selection manuelle.
  if (sel.mode === 'pending' && !pending.length) sel.mode = 'manual';
  showKind();
  renderMode();
  await refresh();
}

export { viewLabels };
