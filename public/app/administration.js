// Administration — module de l'interface (organisation : public/app/README.md).
import './compte.js';
import { ROOT, LIBRARY, libUrl, state, isAdmin, LIBRARY_ROLES, roleLabel, ROLE_HELP } from './etat.js';
import { $, $$, view, esc, hint, fmtDate, gapi, toast, go, debounce, sessionStorageSet } from './utilitaires.js';
import { renderHeader } from './entete.js';
import { icon, iconText } from './icones.js';
import { progressBox, sendRawProgress } from './kobo.js';
import { loadStatus } from './main.js';

let adminTab = 'libraries';
async function viewAdmin() {
  view().innerHTML = `
    <div class="page-head"><h1>Administration</h1></div>
    <div class="tabs">
      <button data-tab="libraries" class="${adminTab === 'libraries' ? 'active' : ''}">Bibliothèques</button>
      <button data-tab="users" class="${adminTab === 'users' ? 'active' : ''}">Comptes</button>
      <button data-tab="google" class="${adminTab === 'google' ? 'active' : ''}">Google Books</button>
      <button data-tab="data" class="${adminTab === 'data' ? 'active' : ''}">Sauvegarde</button>
    </div>
    <div id="admin-body"></div>`;
  $$('.tabs button').forEach((btn) => { btn.onclick = () => { adminTab = btn.dataset.tab; viewAdmin(); }; });
  if (adminTab === 'libraries') await adminLibraries();
  else if (adminTab === 'users') await adminUsers();
  else if (adminTab === 'google') await adminGoogleKey();
  else await adminBackup();
}

// Sauvegarde : une archive par bibliotheque (elements au choix), restauration
// d'une archive, et copie de toutes les bases.
const BACKUP_PARTS = [['db', 'Base (livres, prêts, statuts…)'], ['ebooks', 'Fichiers epub'], ['covers', 'Couvertures et logo']];
async function adminBackup() {
  const libs = await gapi('/api/admin/libraries');
  $('#admin-body').innerHTML = `
    <form class="card" id="bk-form" style="margin-bottom:18px">
      <h3 style="margin-top:0">Sauvegarder ${hint('Une archive par bibliothèque : mylittlelibrary-<nom>.zip.')}</h3>
      <div class="field"><label>Bibliothèques</label>
        <label class="check"><input type="checkbox" id="bk-all" checked> <strong>Toutes</strong></label>
        ${libs.map((l) => `<label class="check"><input type="checkbox" data-lib="${l.id}" checked> ${esc(l.name)} <span class="small muted">${l.books} livre(s)</span></label>`).join('')}</div>
      <div class="field"><label>Contenu</label>
        ${BACKUP_PARTS.map(([k, label]) => `<label class="check"><input type="checkbox" data-part="${k}" checked> ${label}</label>`).join('')}</div>
      <button class="btn btn-primary" type="submit">Télécharger</button>
    </form>
    <form class="card" id="rs-form" style="margin-bottom:18px">
      <h3 style="margin-top:0">Restaurer ${hint('Archive mylittlelibrary-<nom>.zip. Bibliothèque recréée, ou remplacée (après confirmation) si une bibliothèque porte déjà ce nom : seuls les éléments présents dans l’archive sont remplacés.')}</h3>
      <div class="field"><input type="file" name="file" accept=".zip,application/zip" required></div>
      <button class="btn btn-primary" type="submit">Importer</button>
    </form>
    <div class="card">
      <h3 style="margin-top:0">Toutes les bases ${hint('Base centrale (comptes, réglages) et base de chaque bibliothèque, sans epub ni couvertures.')}</h3>
      <a class="btn" href="${ROOT}/api/admin/backup" id="bk-full">Télécharger</a></div>`;
  const libBoxes = $$('[data-lib]');
  $('#bk-all').onchange = (e) => libBoxes.forEach((b) => { b.checked = e.target.checked; });
  libBoxes.forEach((b) => { b.onchange = () => { $('#bk-all').checked = libBoxes.every((x) => x.checked); }; });
  $('#bk-full').onclick = () => backupDone();
  $('#bk-form').onsubmit = async (e) => {
    e.preventDefault();
    const ids = libBoxes.filter((b) => b.checked).map((b) => b.dataset.lib);
    const parts = $$('[data-part]').filter((b) => b.checked).map((b) => b.dataset.part);
    if (!ids.length) { toast('Choisis au moins une bibliothèque.', 'error'); return; }
    if (!parts.length) { toast('Choisis au moins un élément à sauvegarder.', 'error'); return; }
    const query = parts.map((p) => `${p}=1`).join('&');
    // Un lien par archive (telechargement direct, sans passer par la memoire de la page).
    for (let i = 0; i < ids.length; i++) {
      const a = document.createElement('a');
      a.href = `${ROOT}/api/admin/libraries/${ids[i]}/archive?${query}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
    backupDone();
    toast(ids.length > 1 ? `${ids.length} archives en cours de téléchargement.` : 'Archive en cours de téléchargement.');
  };
  $('#rs-form').onsubmit = async (e) => {
    e.preventDefault();
    const file = e.target.file.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024 * 1024) { toast('Archive trop lourde (1 Go max).', 'error'); return; }
    const box = progressBox('Restauration');
    try {
      box.step('Envoi de l’archive…', 0);
      const info = await sendRawProgress('/api/admin/archives', file, 'application/zip', {},
        (pct) => box.step(pct < 1 ? 'Envoi de l’archive…' : 'Lecture de l’archive…', pct < 1 ? Math.round(pct * 100) : null), ROOT);
      const what = BACKUP_PARTS.filter(([k]) => info.contents[k]).map(([, label]) => label.replace(/ \(.*\)/, '').toLowerCase()).join(', ');
      if (info.existing) {
        box.close();
        const ok = confirm(`La bibliothèque « ${info.existing.name} » existe déjà.\n\nRemplacer ses éléments par ceux de l’archive (${what}) ?\nLa base actuelle est copiée dans ses sauvegardes avant remplacement.`);
        if (!ok) { gapi(`/api/admin/archives/${info.token}`, { method: 'DELETE' }).catch(() => {}); return; }
      }
      const pb = info.existing ? progressBox('Restauration') : box;
      pb.step(`${info.existing ? 'Remplacement' : 'Création'} de « ${info.name} »…`);
      try {
        const r = await gapi(`/api/admin/archives/${info.token}/apply`, { method: 'POST', body: { overwrite: !!info.existing } });
        toast(`« ${r.library.name} » ${r.created ? 'créée' : 'restaurée'} : ${r.books} livre(s).`);
        await loadStatus();
        renderHeader();
        adminBackup();
      } finally { pb.close(); }
    } catch (err) {
      box.close();
      toast(err.message, 'error');
    }
  };
}

// Rappel mensuel de sauvegarde (administrateurs) : Sauvegarder, Reporter (jusqu'a
// la prochaine connexion ou ouverture de l'app), Passer (rien ce mois-ci).
function backupDone() {
  state.backupReminder = false;
  const el = $('#backup-reminder');
  if (el) el.remove();
}
function showBackupReminder() {
  if (!state.backupReminder || !isAdmin() || $('#backup-reminder')) return;
  try { if (sessionStorage.getItem('mll-backup-snooze')) return; } catch (e) { /* stockage indisponible */ }
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'backup-reminder';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="br-title">
      <h2 id="br-title">Sauvegarde du mois</h2>
      <p>Aucune sauvegarde n’a encore été faite ce mois-ci.</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-act="go">Sauvegarder</button>
        <button class="btn" type="button" data-act="later">Reporter</button>
        <button class="btn" type="button" data-act="skip"><span class="hide-mobile">Passer ce mois-ci</span><span class="show-mobile">Passer</span></button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  $('[data-act=go]', backdrop).onclick = () => {
    backdrop.remove();
    adminTab = 'data';
    if (/^#\/admin$/.test(location.hash)) viewAdmin();
    else go('#/admin');
  };
  $('[data-act=later]', backdrop).onclick = () => {
    sessionStorageSet('mll-backup-snooze', '1');
    backdrop.remove();
  };
  $('[data-act=skip]', backdrop).onclick = async () => {
    try {
      await gapi('/api/admin/backup-reminder/skip', { method: 'POST', body: {} });
      backupDone();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// Cle Google Books (gratuite) : fiabilise la recherche par ISBN et la recherche de couvertures.
async function adminGoogleKey() {
  const info = await gapi('/api/admin/google-key');
  const stateHtml = info.saved
    ? `<span class="badge badge-ok">Clé enregistrée (${esc(info.masked)})</span>`
    : info.env ? '<span class="badge badge-ok">Clé définie sur le serveur (variable d\'environnement)</span>'
      : '<span class="badge badge-muted">Aucune clé</span>';
  $('#admin-body').innerHTML = `
    <form class="card" id="gkey-form" style="margin-bottom:18px">
      <h3 style="margin-top:0">Clé Google Books ${hint('Sans clé, Google limite fortement les recherches : beaucoup de livres restent sans résumé ni couverture. Avec une clé (gratuite, environ 1 000 recherches par jour), les recherches par ISBN et de couverture sont bien plus fiables. La clé est gardée sur le serveur et jamais affichée en entier.')}</h3>
      <p>${stateHtml}</p>
      <div class="field"><label>${info.saved ? 'Remplacer la clé' : 'Coller la clé'}</label>
        <input name="key" placeholder="AIza…" autocomplete="off" spellcheck="false"></div>
      <button class="btn btn-primary" type="submit"><span class="hide-mobile">Vérifier et enregistrer</span><span class="show-mobile">Enregistrer</span></button>
      ${info.saved ? '<button class="btn btn-danger" type="button" id="gkey-del"><span class="hide-mobile">Retirer la clé</span><span class="show-mobile">Retirer</span></button>' : ''}
    </form>
    <div class="card">
      <h3 style="margin-top:0">Obtenir une clé gratuite (5 min)</h3>
      <ol>
        <li>Ouvre la <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console Google Cloud</a> et connecte-toi avec un compte Google (Gmail). Accepte les conditions si c'est la première fois. <strong>Aucune carte bancaire n'est nécessaire.</strong></li>
        <li>En haut, clique sur le sélecteur de projet, puis <em>Nouveau projet</em>. Nomme-le par exemple « Bibliothèque » et clique sur <em>Créer</em>. Vérifie ensuite qu'il est bien sélectionné.</li>
        <li>Active l'API : ouvre la page <a href="https://console.cloud.google.com/apis/library/books.googleapis.com" target="_blank" rel="noopener">Books API</a> et clique sur <em>Activer</em>.</li>
        <li>Va dans <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">API et services › Identifiants</a>, clique sur <em>Créer des identifiants</em> › <em>Clé API</em>.</li>
        <li>Copie la clé affichée (elle commence par <span class="code">AIza</span>) et colle-la ci-dessus.</li>
        <li>Conseillé : clique sur <em>Modifier la clé</em> › <em>Restrictions relatives aux API</em> › <em>Restreindre la clé</em>, coche uniquement <em>Books API</em> et enregistre.</li>
      </ol>
      <p class="small muted">API non activée à la vérification ? Refais l'étape 3 puis patiente une minute.</p>
    </div>`;
  const form = $('#gkey-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const key = form.key.value.trim();
    if (!key) { toast('Colle d\'abord une clé.', 'error'); return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await gapi('/api/admin/google-key', { method: 'PUT', body: { key } });
      toast('Clé vérifiée et enregistrée.');
      adminGoogleKey();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  };
  const del = $('#gkey-del');
  if (del) del.onclick = async () => {
    if (!confirm('Retirer la clé Google Books ?')) return;
    try { await gapi('/api/admin/google-key', { method: 'PUT', body: { key: '' } }); toast('Clé retirée.'); adminGoogleKey(); } catch (err) { toast(err.message, 'error'); }
  };
}

async function refreshMyLibraries() {
  await loadStatus();
  renderHeader();
}

async function adminLibraries() {
  const libs = await gapi('/api/admin/libraries');
  const origin = location.origin + ROOT + '/';
  $('#admin-body').innerHTML = `
    <form class="card" id="new-lib" style="margin-bottom:18px">
      <h3 style="margin-top:0">Nouvelle bibliothèque</h3>
      <div class="grid-2">
        <div class="field"><label>Nom *</label><input name="name" required placeholder="ex. Bibliothèque de l'accueil"></div>
        <div class="field"><label>Adresse</label><input name="slug" placeholder="calculée depuis le nom" pattern="[a-z0-9][a-z0-9-]*"></div>
      </div>
      <p class="small muted" id="slug-preview"></p>
      <button class="btn btn-primary" type="submit">Créer</button>
    </form>
    <div class="card">${libs.length ? `<div class="list">${libs.map((l) => `
      <div class="list-item">
        <div class="grow">
          <strong>${esc(l.name)}</strong>
          <div class="small"><a href="${esc(libUrl(l.slug))}">${esc(origin + l.slug)}/</a></div>
          <div class="small muted">${l.books} livre(s) · ${l.copies} exemplaire(s) · ${l.users} compte(s) lié(s)</div>
        </div>
        <button class="btn btn-small" data-edit-lib="${l.id}">Modifier</button>
        <button class="btn btn-small btn-danger" data-del-lib="${l.id}">Supprimer</button>
      </div>`).join('')}</div>` : '<p class="muted">Aucune bibliothèque.</p>'}</div>`;

  const f = $('#new-lib');
  let userEditedSlug = false;
  const preview = debounce(async () => {
    if (userEditedSlug) { $('#slug-preview').textContent = `Adresse : ${origin}${f.slug.value}/`; return; }
    if (!f.name.value.trim()) { $('#slug-preview').textContent = ''; return; }
    const r = await gapi(`/api/admin/slug?name=${encodeURIComponent(f.name.value)}`).catch(() => null);
    if (r) { f.slug.placeholder = r.slug; $('#slug-preview').textContent = `Adresse : ${origin}${r.slug}/`; }
  }, 250);
  f.name.addEventListener('input', preview);
  f.slug.addEventListener('input', () => { userEditedSlug = !!f.slug.value; preview(); });
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const lib = await gapi('/api/admin/libraries', { method: 'POST', body: { name: f.name.value, slug: f.slug.value || undefined } });
      toast(`Bibliothèque créée : ${origin}${lib.slug}/`);
      await refreshMyLibraries();
      viewAdmin();
    } catch (err) { toast(err.message, 'error'); }
  };
  $$('[data-edit-lib]').forEach((btn) => {
    btn.onclick = () => editLibraryDialog(libs.find((l) => l.id === Number(btn.dataset.editLib)), origin);
  });
  $$('[data-del-lib]').forEach((btn) => {
    btn.onclick = async () => {
      const lib = libs.find((l) => l.id === Number(btn.dataset.delLib));
      const typed = prompt(`Supprimer « ${lib.name} » avec ses ${lib.books} livre(s), ${lib.copies} exemplaire(s), emprunteurs et prêts ?\nCette action est définitive.\n\nPour confirmer, tape exactement le nom de la bibliothèque :`);
      if (typed === null) return;
      try {
        await gapi(`/api/admin/libraries/${lib.id}?confirm=${encodeURIComponent(typed)}`, { method: 'DELETE' });
        toast('Bibliothèque supprimée.');
        await refreshMyLibraries();
        if (LIBRARY && LIBRARY.slug === lib.slug) location.href = `${ROOT}/?accueil=1`;
        else viewAdmin();
      } catch (err) { toast(err.message, 'error'); }
    };
  });
}

function editLibraryDialog(lib, origin) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal">
      <h2>Modifier la bibliothèque</h2>
      <div class="field"><label>Nom</label><input name="name" required value="${esc(lib.name)}"></div>
      <div class="field"><label>Adresse</label><input name="slug" required value="${esc(lib.slug)}" pattern="[a-z0-9][a-z0-9-]*"></div>
      <div class="info-box small">Changer l'adresse : l'ancienne reste redirigée vers la nouvelle (étiquettes déjà imprimées, shortcode WordPress). Pense tout de même à mettre à jour le shortcode.</div>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Enregistrer</button>
        <button class="btn" type="button" data-close>Annuler</button>
      </div>
    </form>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(); });
  $('form', backdrop).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await gapi(`/api/admin/libraries/${lib.id}`, { method: 'PUT', body: { name: e.target.name.value, slug: e.target.slug.value } });
      close();
      toast(`Enregistré : ${origin}${r.slug}/`);
      await refreshMyLibraries();
      if (LIBRARY && LIBRARY.slug === lib.slug && r.slug !== lib.slug) location.href = `${libUrl(r.slug)}#/admin`;
      else viewAdmin();
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function adminUsers() {
  const [users, libs] = await Promise.all([gapi('/api/admin/users'), gapi('/api/admin/libraries')]);
  const libName = (id) => (libs.find((l) => l.id === id) || {}).name || '?';
  $('#admin-body').innerHTML = `
    <div class="btn-row" style="margin-bottom:12px"><button class="btn btn-primary" id="new-user">+ <span class="hide-mobile">Nouveau </span>compte</button></div>
    <div class="card">${users.length ? `<div class="list">${users.map((u) => `
      <div class="list-item">
        <div class="grow">
          <strong>${esc(u.username)}</strong> ${u.role === 'admin' ? '<span class="badge badge-ok">Administrateur</span>' : ''}
          ${u.id === state.user.id ? '<span class="small muted">(toi)</span>' : ''}
          <div class="small muted">${u.role === 'admin' ? 'Toutes les bibliothèques' : (u.libraries.map((l) => `${esc(libName(l.id))} (${roleLabel(l.role)})${l.id === u.defaultLibraryId ? ' ★' : ''}`).join(', ') || 'Aucune bibliothèque')}</div>
        </div>
        <button class="btn btn-small" data-edit-user="${u.id}" title="Modifier" aria-label="Modifier ${esc(u.username)}">${iconText('edit', 'Modifier')}</button>
        ${u.id === state.user.id ? '' : `<button class="btn btn-small btn-danger" data-del-user="${u.id}" title="Supprimer" aria-label="Supprimer ${esc(u.username)}">${iconText('trash', 'Supprimer')}</button>`}
      </div>`).join('')}</div>` : ''}</div>
    <h2>Liens d'invitation ${hint('La personne qui ouvre le lien choisit son identifiant et son mot de passe ; son compte est lié à la bibliothèque avec le rôle choisi. Un lien sert à plusieurs personnes, jusqu\'à son expiration ou sa suppression.')}</h2>
    <div class="card">
      <form class="invite-form" id="invite-form">
        <select name="library" aria-label="Bibliothèque" required>${libs.map((l) => `<option value="${l.id}" ${LIBRARY && l.slug === LIBRARY.slug ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
        <select name="role" aria-label="Rôle">${LIBRARY_ROLES.map((r) => `<option value="${r}">${roleLabel(r)}</option>`).join('')}</select>
        <select name="days" aria-label="Durée de validité"><option value="7">7 jours</option><option value="30">30 jours</option><option value="90">90 jours</option></select>
        <button class="btn btn-primary" type="submit" ${libs.length ? '' : 'disabled'}>${icon('add', 16)}Créer<span class="hide-mobile"> un lien</span></button>
      </form>
      <div id="invite-list" class="list" style="margin-top:10px"></div>
    </div>`;
  // Liens d'invitation en cours : copier l'adresse, supprimer.
  const inviteUrl = (i) => `${location.origin}${libUrl(i.library.slug)}#/invite/${i.token}`;
  const renderInvites = (list) => {
    const box = $('#invite-list');
    box.innerHTML = list.length ? list.map((i) => `<div class="list-item">
        <div class="grow"><strong>${esc(i.library.name)}</strong> <span class="badge badge-muted">${roleLabel(i.role)}</span>
          <div class="small muted">Jusqu'au ${fmtDate(i.expiresAt)} · ${i.uses} compte${i.uses > 1 ? 's' : ''}</div></div>
        <button class="btn btn-small" type="button" data-copy-invite="${i.id}" title="Copier le lien" aria-label="Copier le lien">${iconText('share', 'Copier le lien')}</button>
        <button class="btn btn-small btn-danger" type="button" data-del-invite="${i.id}" title="Supprimer le lien" aria-label="Supprimer le lien">${iconText('trash', 'Supprimer')}</button>
      </div>`).join('') : '<p class="small muted" style="margin:0">Aucun lien en cours.</p>';
    $$('[data-copy-invite]', box).forEach((btn) => {
      btn.onclick = async () => {
        const url = inviteUrl(list.find((i) => i.id === Number(btn.dataset.copyInvite)));
        try { await navigator.clipboard.writeText(url); toast('Lien copié.'); } catch (e) { prompt('Lien d\'invitation :', url); }
      };
    });
    $$('[data-del-invite]', box).forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Supprimer ce lien ? Il ne fonctionnera plus (les comptes déjà créés sont gardés).')) return;
        try { renderInvites(await gapi(`/api/admin/invitations/${btn.dataset.delInvite}`, { method: 'DELETE' })); } catch (err) { toast(err.message, 'error'); }
      };
    });
  };
  gapi('/api/admin/invitations').then(renderInvites).catch(() => {});
  $('#invite-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const list = await gapi('/api/admin/invitations', { method: 'POST', body: { libraryId: Number(f.library.value), role: f.role.value, days: Number(f.days.value) } });
      renderInvites(list);
      try { await navigator.clipboard.writeText(inviteUrl(list[0])); toast('Lien créé et copié.'); } catch (err) { toast('Lien créé.'); }
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#new-user').onclick = () => userDialog(null, libs);
  $$('[data-edit-user]').forEach((btn) => { btn.onclick = () => userDialog(users.find((u) => u.id === Number(btn.dataset.editUser)), libs); });
  $$('[data-del-user]').forEach((btn) => {
    btn.onclick = async () => {
      const u = users.find((x) => x.id === Number(btn.dataset.delUser));
      if (!confirm(`Supprimer le compte ${u.username} ?`)) return;
      try { await gapi(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast('Compte supprimé.'); viewAdmin(); } catch (err) { toast(err.message, 'error'); }
    };
  });
}

function userDialog(user, libs) {
  // Nouveau compte : lecteur de la bibliotheque ouverte.
  const u = user || { username: '', role: 'user', libraries: LIBRARY ? libs.filter((l) => l.slug === LIBRARY.slug).map((l) => ({ id: l.id, role: 'user' })) : [], defaultLibraryId: null };
  const linkOf = (id) => u.libraries.find((l) => l.id === id);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <form class="modal">
      <h2>${user ? `Compte ${esc(user.username)}` : 'Nouveau compte'}</h2>
      <div class="field"><label>Identifiant *</label><input name="username" required value="${esc(u.username)}" autocomplete="off"></div>
      <div class="field"><label>${user ? `Nouveau mot de passe ${hint('Laisser vide pour ne pas changer.')}` : `Mot de passe * ${hint('8 caractères minimum.')}`}</label>
        <input name="password" type="password" autocomplete="new-password" minlength="8" ${user ? '' : 'required'}></div>
      <div class="field"><label class="check"><input type="checkbox" name="admin" ${u.role === 'admin' ? 'checked' : ''}>
        <span>Administrateur ${hint(ROLE_HELP.admin)}</span></label></div>
      <div class="field"><label>Bibliothèques et rôle dans chacune (★ = par défaut) ${hint(LIBRARY_ROLES.map((r) => ROLE_HELP[r]).join(' '))}</label>
        <div class="sel-list">${libs.map((l) => `
          <div class="sel-row">
            <input type="checkbox" name="lib" value="${l.id}" ${linkOf(l.id) ? 'checked' : ''} id="lib-${l.id}">
            <label for="lib-${l.id}" class="grow" style="margin:0;font-weight:500;color:var(--text);font-size:14px">${esc(l.name)}</label>
            <select data-lib-role="${l.id}" aria-label="Rôle dans ${esc(l.name)}" class="sel-role">${LIBRARY_ROLES.map((r) => `<option value="${r}" ${(linkOf(l.id) || {}).role === r ? 'selected' : ''}>${roleLabel(r)}</option>`).join('')}</select>
            <label class="small" style="margin:0;display:flex;align-items:center;gap:4px" title="Bibliothèque par défaut"><input type="radio" name="def" value="${l.id}" ${u.defaultLibraryId === l.id ? 'checked' : ''} style="width:auto;min-height:0"> ★</label>
          </div>`).join('') || '<p class="muted small" style="padding:8px">Crée d\'abord une bibliothèque.</p>'}</div>
      </div>
      <div id="dlg-err"></div>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">${user ? 'Enregistrer' : 'Créer le compte'}</button>
        <button class="btn" type="button" data-close>Annuler</button>
      </div>
    </form>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(); });
  // Choisir une bibliotheque par defaut la coche automatiquement.
  $$('input[name=def]', backdrop).forEach((r) => {
    r.onchange = () => { const cb = $(`#lib-${r.value}`, backdrop); if (cb) cb.checked = true; };
  });
  // Choisir un role coche la bibliotheque ; un administrateur a tous les droits partout.
  const adminBox = $('input[name=admin]', backdrop);
  const syncRoles = () => $$('[data-lib-role]', backdrop).forEach((s) => { s.disabled = adminBox.checked; });
  adminBox.onchange = syncRoles;
  syncRoles();
  $$('[data-lib-role]', backdrop).forEach((s) => { s.onchange = () => { $(`#lib-${s.dataset.libRole}`, backdrop).checked = true; }; });
  $('form', backdrop).onsubmit = async (e) => {
    e.preventDefault();
    const t = e.target;
    const libraries = $$('input[name=lib]:checked', backdrop).map((x) => ({ id: Number(x.value), role: $(`[data-lib-role="${x.value}"]`, backdrop).value }));
    const def = $('input[name=def]:checked', backdrop);
    const body = { username: t.username.value, role: t.admin.checked ? 'admin' : 'user', libraries, defaultLibraryId: def ? Number(def.value) : null };
    if (t.password.value) body.password = t.password.value;
    try {
      await gapi(user ? `/api/admin/users/${user.id}` : '/api/admin/users', { method: user ? 'PUT' : 'POST', body });
      close();
      toast(user ? 'Compte enregistré.' : 'Compte créé.');
      if (user && user.id === state.user.id) await refreshMyLibraries();
      viewAdmin();
    } catch (err) { $('#dlg-err', backdrop).innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  };
}

export { viewAdmin, showBackupReminder };
