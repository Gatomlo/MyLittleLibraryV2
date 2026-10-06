// Utilitaires — module de l'interface (organisation : public/app/README.md).
import './etat.js';
import { ROOT, LIB, state } from './etat.js';
import { refreshLoanBadge } from './scanner.js';
import { renderHeader } from './entete.js';
import { route } from './routage.js';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const view = () => $('#view');

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Aide contextuelle : icone "?" dont le texte s'affiche en info-bulle (survol,
// focus clavier ou toucher). Une seule bulle flottante, placee dans l'ecran.
const hint = (text) => `<span class="hint" tabindex="0" role="button" aria-label="${esc(text)}" data-tip="${esc(text)}">?</span>`;
(() => {
  let tip = null;
  let pinned = null;
  const hide = () => { if (tip) tip.hidden = true; pinned = null; };
  const show = (el) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'hint-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const top = r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8;
    tip.style.left = left + window.scrollX + 'px';
    tip.style.top = top + window.scrollY + 'px';
  };
  document.addEventListener('mouseover', (e) => { const el = e.target.closest && e.target.closest('.hint'); if (el) show(el); });
  document.addEventListener('mouseout', (e) => { const el = e.target.closest && e.target.closest('.hint'); if (el && el !== pinned) { if (tip) tip.hidden = true; } });
  document.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('hint')) show(e.target); });
  document.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('hint')) hide(); });
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('.hint');
    if (el) { e.preventDefault(); e.stopPropagation(); if (pinned === el) hide(); else { show(el); pinned = el; } return; }
    if (pinned) hide();
  }, true);
  window.addEventListener('scroll', () => { if (tip && !tip.hidden) hide(); }, { passive: true });
  window.addEventListener('hashchange', hide);
})();

// Image introuvable (couverture en ligne disparue) : reaction choisie par l'attribut
// data-onerror. Un seul ecouteur pour toute la page : la politique de contenu (CSP)
// interdit les attributs onerror="..." en ligne.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || !img.dataset.onerror) return;
  const mode = img.dataset.onerror;
  if (mode === 'hide') img.style.visibility = 'hidden';
  else if (mode === 'drop-choice') { const c = img.closest('.cover-choice'); if (c) c.remove(); }
  else if (mode === 'placeholder') {
    const span = document.createElement('span');
    span.className = 'thumb';
    span.setAttribute('aria-hidden', 'true');
    img.replaceWith(span);
  }
}, true);

// Les chemins d'images renvoyes par l'API sont relatifs a la bibliotheque (ou a la racine).
function mediaSrc(url) {
  return url ? `${LIB || ROOT}/${url}` : '';
}

// Dates SQLite (UTC, "AAAA-MM-JJ HH:MM:SS") -> affichage local.
function fmtDate(s, withTime) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return withTime
    ? d.toLocaleString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Duree en secondes -> "5 h 12", "42 min".
function fmtDuration(sec) {
  const m = Math.round((Number(sec) || 0) / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`;
}

async function request(base, path, { method = 'GET', body } = {}) {
  // POST / PUT / PATCH toujours en JSON (corps vide = {}) : le serveur refuse le reste (415).
  if (body === undefined && ['POST', 'PUT', 'PATCH'].includes(method)) body = {};
  const res = await fetch(base + path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* reponse vide */ }
  if (res.status === 401 && state.user) {
    state.user = null;
    renderHeader();
  }
  if (!res.ok) throw new Error((data && data.error) || `Erreur ${res.status}`);
  return data;
}
// API de la bibliotheque courante / API globale (comptes, administration).
const api = (path, opts) => request(LIB, path, opts);
const gapi = (path, opts) => request(ROOT, path, opts);

function toast(message, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  if (type === 'error') el.setAttribute('role', 'alert');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

// Date sans heure ('YYYY-MM-DD') : date de retour prevue d'un pret.
const fmtDay = (s) => (s ? s.split('-').reverse().join('/') : '');
// Echeance d'un pret en cours ("a rendre le ...", badge rouge si depassee).
const dueHtml = (l) => (!l.dueAt ? '' : l.overdue ? `<span class="badge badge-late">En retard · ${fmtDay(l.dueAt)}</span>` : `à rendre le ${fmtDay(l.dueAt)}`);

// ---------- Rappels de retour (mailto) ----------
// Modele par defaut (reglages de la bibliotheque : objet et message personnalisables).
const REMINDER_DEFAULT = {
  subject: 'Rappel : livre(s) à rendre à {bibliotheque}',
  body: 'Bonjour {nom},\n\nPetit rappel concernant le(s) livre(s) emprunté(s) à {bibliotheque} :\n{livres}\n\n'
    + 'Merci de le(s) rapporter dès que possible. Si un délai supplémentaire est nécessaire, il suffit de répondre à ce message.\n\nBonne lecture !',
};
function reminderText(tpl, borrower, loans) {
  const due = loans.map((l) => l.dueAt).filter(Boolean).sort()[0] || '';
  const lines = loans.map((l) => `- ${l.book.title} (${l.copy.code})${l.dueAt ? ` : à rendre le ${fmtDay(l.dueAt)}${l.overdue ? ' (en retard)' : ''}` : ''}`).join('\n');
  const fill = (s) => s.replace(/\{(nom|livres|bibliotheque|date_retour)\}/g, (m, k) => ({
    nom: borrower.name, livres: lines, bibliotheque: state.settings.libraryName, date_retour: fmtDay(due) })[k]);
  return { subject: fill(tpl.subject || REMINDER_DEFAULT.subject), body: fill(tpl.body || REMINDER_DEFAULT.body) };
}
// Ouvre le message dans la messagerie de l'appareil, puis note la relance si elle est envoyee.
async function sendReminder(borrower, loans) {
  const { reminder } = await api('/api/loans/summary');
  const msg = reminderText(reminder || {}, borrower, loans);
  if (!borrower.email) {
    const v = await dialog(`<h2>Pas d'adresse e-mail</h2>
      <p><strong>${esc(borrower.name)}</strong> n'a pas d'adresse e-mail enregistrée.</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-v="mail"><span class="hide-mobile">Écrire quand même</span><span class="show-mobile">Écrire</span></button>
        <button class="btn" type="button" data-v="copy"><span class="hide-mobile">Copier le message</span><span class="show-mobile">Copier</span></button>
        <button class="btn" type="button" data-v="edit"><span class="hide-mobile">Ajouter l'adresse</span><span class="show-mobile">Adresse</span></button>
        <button class="btn" type="button" data-close>Annuler</button>
      </div>`);
    if (v === 'edit') { go(`#/borrower/${borrower.id}`); return false; }
    if (v === 'copy') {
      try { await navigator.clipboard.writeText(`${msg.subject}\n\n${msg.body}`); toast('Message copié.'); } catch (e) { toast('Copie impossible.', 'error'); return false; }
    } else if (v === 'mail') openMailto('', msg);
    else return false;
  } else openMailto(borrower.email, msg);
  const ok = await dialog(`<h2>Relance de ${esc(borrower.name)}</h2>
    <p>Le message est prêt dans ta messagerie. Une fois envoyé, note la relance pour ne pas relancer deux fois.</p>
    <div class="btn-row"><button class="btn btn-primary" type="button" data-v="yes"><span class="hide-mobile">Noter la relance</span><span class="show-mobile">Noter</span></button><button class="btn" type="button" data-close>Pas envoyé</button></div>`);
  if (ok !== 'yes') return false;
  await api('/api/loans/reminded', { method: 'POST', body: { ids: loans.map((l) => l.id) } });
  toast('Relance notée.');
  refreshLoanBadge();
  return true;
}
function openMailto(to, msg) {
  const a = document.createElement('a');
  a.href = `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(msg.subject)}&body=${encodeURIComponent(msg.body)}`;
  a.click();
}
// Prets affiches (pour le bouton « Relancer » des listes).
const loanCache = new Map();
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remind]');
  if (!btn) return;
  e.preventDefault();
  const l = loanCache.get(Number(btn.dataset.remind));
  if (!l) return;
  try { if (await sendReminder(l.borrower, [l])) route(); } catch (err) { toast(err.message, 'error'); }
});
const remindedHtml = (l) => (l.remindedAt ? `relancé le ${fmtDate(l.remindedAt)}${l.reminderCount > 1 ? ` (${l.reminderCount} fois)` : ''}` : '');

// Fenetre simple : renvoie la valeur data-v du bouton touche, ou null.
function dialog(html) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(backdrop);
    const close = (v) => { backdrop.remove(); resolve(v); };
    backdrop.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-v]');
      if (btn) close(btn.dataset.v);
      else if (e.target === backdrop || e.target.hasAttribute('data-close')) close(null);
    });
    const first = $('[data-v]', backdrop);
    if (first) first.focus();
  });
}

// ---------- Fenetres (accessibilite clavier) ----------
// Toute fenetre .modal-backdrop : focus place dedans a l'ouverture et rendu a
// l'element d'origine a la fermeture, Tab reste dans la fenetre, Echap ferme
// (bouton data-close, sinon clic sur le fond), titre h2 relie a role=dialog.
(() => {
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  const opened = new Map();
  // Dernier element focalise hors fenetre (une fenetre prend souvent le focus
  // avant que l'observateur ne la voie).
  let lastOutside = null;
  const remember = (el) => { if (el && el.closest && !el.closest('.modal-backdrop')) lastOutside = el.closest(FOCUSABLE) || el; };
  document.addEventListener('focusin', (e) => remember(e.target));
  document.addEventListener('click', (e) => remember(e.target), true);
  const top = () => { const all = $$('.modal-backdrop'); return all[all.length - 1] || null; };
  const focusables = (el) => $$(FOCUSABLE, el).filter((x) => x.offsetParent !== null || x === document.activeElement);
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement) || !n.classList.contains('modal-backdrop')) return;
        opened.set(n, n.contains(document.activeElement) ? lastOutside : document.activeElement);
        const box = $('[role=dialog]', n) || $('.modal', n);
        if (box) {
          if (!box.hasAttribute('role')) box.setAttribute('role', 'dialog');
          box.setAttribute('aria-modal', 'true');
          const h = $('h2, h1', box);
          if (h && !box.hasAttribute('aria-labelledby') && !box.hasAttribute('aria-label')) {
            if (!h.id) h.id = 'dlg-' + Math.random().toString(36).slice(2, 8);
            box.setAttribute('aria-labelledby', h.id);
          }
        }
        // Focus deja place par la fenetre (champ, bouton) : conserve.
        setTimeout(() => { if (n.isConnected && !n.contains(document.activeElement)) { const f = focusables(n)[0]; if (f) f.focus(); } }, 0);
      });
      r.removedNodes.forEach((n) => {
        if (!opened.has(n)) return;
        const back = opened.get(n);
        opened.delete(n);
        if (back && back.isConnected && !top()) back.focus();
      });
    }
  }).observe(document.body, { childList: true });
  document.addEventListener('keydown', (e) => {
    const m = top();
    if (!m) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const c = $('[data-close]', m);
      if (c) c.click(); else m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables(m);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (!m.contains(document.activeElement)) { e.preventDefault(); first.focus(); } else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, true);
})();

// Lien « Aller au contenu » : focus sur la page sans toucher a l'adresse (routes en #).
document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('.skip-link')) return;
  e.preventDefault();
  view().focus();
});

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ribbon : bandeau pose en travers du coin de la couverture (ex. "Numerique").
function coverHtml(book, ribbon) {
  return `<div class="cover">${ribbon ? `<span class="cover-ribbon">${esc(ribbon)}</span>` : ''}${book.coverUrl
    ? `<img src="${esc(mediaSrc(book.coverUrl))}" alt="" loading="lazy">`
    : `<span class="cover-fallback">${esc(book.title)}</span>`}</div>`;
}

// withEbook = false : pas de pastille "Numerique" (affichee en bandeau sur la couverture).
function availabilityBadge(b, withEbook = true) {
  const ebook = withEbook && b.ebookCopies > 0 ? '<span class="badge badge-ebook">Numérique</span>' : '';
  if (!withEbook && !b.totalCopies && b.ebookCopies > 0) return '';
  if (!b.totalCopies) return ebook || '<span class="badge badge-muted">Aucun exemplaire</span>';
  let paper;
  if (b.availableCopies === 0) paper = b.reservedCopies > 0 ? '<span class="badge badge-reserved">Réservé</span>' : '<span class="badge badge-warn">Emprunté</span>';
  else if (b.totalCopies > 1) paper = `<span class="badge badge-ok">${b.availableCopies}/${b.totalCopies} disponibles</span>`;
  else paper = '<span class="badge badge-ok">Disponible</span>';
  return ebook ? `<span class="badges">${paper}${ebook}</span>` : paper;
}

// Redimensionne une image choisie (ou photographiee) avant envoi au serveur.
function imageToDataUrl(file, maxSize, mime) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL(mime, 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
    img.src = url;
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Chargement impossible : ' + src));
    document.head.appendChild(s);
  });
}

function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
function sessionStorageTake(k) {
  try { const v = sessionStorage.getItem(k); sessionStorage.removeItem(k); return v; } catch (e) { return null; }
}

export {
  $, $$, view, esc, hint, mediaSrc, fmtDate, fmtDuration, api, gapi, toast, fmtDay, dueHtml, REMINDER_DEFAULT, sendReminder, loanCache, remindedHtml,
  dialog, go, debounce, coverHtml, availabilityBadge, imageToDataUrl, loadScript, sessionStorageSet, sessionStorageTake,
};
