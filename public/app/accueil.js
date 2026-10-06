// Accueil personnalise (#/home) — module de l'interface (organisation : public/app/README.md).
import './emprunteurs.js';
import { state, pending } from './etat.js';
import { $, $$, view, esc, mediaSrc, fmtDate, api, toast, fmtDay, loanCache, go, coverHtml, availabilityBadge } from './utilitaires.js';
import { icon, colorVars } from './icones.js';
import { wishState, wishSrc, wishDialog } from './souhaits.js';
import { goalRowsHtml } from './statistiques.js';

// Cartes choisies et ordonnees par chaque compte (lib/home.js). Grand ecran : cartes
// detaillees. Smartphone : tuiles resumees qui tiennent dans l'ecran, sans defilement
// (ni vertical ni horizontal) ; chaque tuile ouvre la page correspondante.
const HOME_PHONE_TILES = 6; // tuiles affichees d'emblee sur smartphone
const HOME_PHONE_QUERY = '(max-width: 599px), (max-height: 520px) and (orientation: landscape) and (pointer: coarse)';
const HOME_META = {
  todo: { icon: 'todo', color: 'sun' },
  reading: { icon: 'catalog', color: 'sky' },
  forme: { icon: 'user', color: 'grape' },
  due: { icon: 'loans', color: 'coral' },
  wishes: { icon: 'wish', color: 'rose' },
  news: { icon: 'add', color: 'accent' },
  goal: { icon: 'goal', color: 'grape' },
  series: { icon: 'layers', color: 'grape' },
  toread: { icon: 'bookmark', color: 'sun' },
  rate: { icon: 'star', color: 'sun' },
  idea: { icon: 'idea', color: 'accent' },
  topwishes: { icon: 'trophy', color: 'rose' },
  activity: { icon: 'stats', color: 'sky' },
  kobo: { icon: 'kobo', color: 'grape' },
};

const openCatalog = (patch) => { state.catalog = { q: '', category: '', status: '', sort: 'title', page: 1, ...patch }; go('#/'); };
const daysLate = (due) => Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(due)) / 86400000);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function todoItems(t) {
  if (!t) return [];
  return [
    t.reminderMode === 'auto' && [t.toRemind, 'Prêt à relancer', 'Prêts à relancer', 'remind', 'danger'],
    [t.overdue, 'Prêt en retard', 'Prêts en retard', 'overdue', 'danger'],
    [t.week, 'Retour cette semaine', 'Retours cette semaine', 'open', 'warn'],
    [t.reservations, 'Réservation prête', 'Réservations prêtes', 'reservations', 'grape'],
    [t.wishes, 'Souhait des membres', 'Souhaits des membres', '#/wishes', 'rose'],
    [t.labels, 'Étiquette à imprimer', 'Étiquettes à imprimer', '#/labels', 'sky'],
    [t.incomplete, 'Fiche incomplète', 'Fiches incomplètes', '#/incomplete', 'accent'],
  ].filter((x) => x && x[0] > 0).map(([n, one, many, target, color]) => ({ n, label: n > 1 ? many : one, target, color }));
}

// Resume de chaque carte (tuile smartphone) : lignes et page ouverte. Seul l'objectif de
// lecture garde une valeur mise en avant ; les listes de livres montrent au plus 3 titres,
// « A faire » toutes les taches en attente.
const TILE_TITLES = 3;
function homeSummary(key, d) {
  const x = d[key];
  const titles = (list, fmt = (b) => b.title) => list.slice(0, TILE_TITLES).map(fmt);
  switch (key) {
    case 'todo': {
      const items = todoItems(x);
      return { lines: items.length ? items.map((i) => `${i.n} ${i.label.toLowerCase()}`) : ['Tout est à jour'], go: items[0] ? items[0].target : 'open' };
    }
    case 'reading': return { lines: x.length ? titles(x, (b) => `${b.title}${b.percent != null ? ` · ${b.percent} %` : ''}`) : ['Aucune lecture en cours'], go: 'reading' };
    case 'forme': return { lines: x.length ? titles(x, (f) => `${f.book.title} : ${f.kind === 'back' ? 'disponible' : 'ajouté'}`) : ['Rien de neuf pour toi'], go: x[0] ? `#/book/${x[0].book.id}` : '#/' };
    case 'due': {
      const late = x.filter((l) => l.overdue).length;
      return { lines: x.length ? titles(x, (l) => `${l.book.title} · ${l.overdue ? `${daysLate(l.dueAt)} j de retard` : fmtDay(l.dueAt)}`) : ['Aucune échéance proche'], go: late ? 'overdue' : 'open' };
    }
    case 'wishes': return { lines: x.items.length ? titles(x.items) : ['Aucun souhait'], go: '#/wishes' };
    case 'news': return { lines: x.items.length ? titles(x.items) : ['Aucun livre pour le moment'], go: 'recent' };
    case 'goal': return x.goal
      ? { value: `${x.read}/${x.goal}`, lines: [x.ahead >= 0 ? `▲ ${plural(x.ahead, 'livre', 'livres')} d'avance` : `▼ ${plural(-x.ahead, 'livre', 'livres')} de retard`, `${x.pages.toLocaleString('fr-BE')} pages en ${x.year}`], go: '#/stats' }
      : { lines: [`${plural(x.read, 'livre lu', 'livres lus')} en ${x.year}`, x.others.length ? `${x.others.filter((g) => g.ok).length}/${x.others.length} objectif(s) atteint(s)` : 'Aucun objectif défini'], go: x.others.length ? '#/stats' : '#/account' };
    case 'series': return { lines: x.length ? titles(x, (b) => `${b.title} · tome ${b.number}`) : ['Aucun tome suivant'], go: x[0] ? `#/book/${x[0].id}` : '#/' };
    case 'toread': return { lines: x.length ? titles(x) : ['Pile vide'], go: 'toread' };
    case 'rate': return { lines: x.length ? titles(x) : ['Tout est noté'], go: x[0] ? `#/book/${x[0].id}` : '#/' };
    case 'idea': return x ? { lines: [x.title, x.authors].filter(Boolean), go: `#/book/${x.id}` } : { lines: ['Aucune idée pour le moment'], go: '#/' };
    case 'topwishes': return { lines: x.length ? titles(x, (g) => `${g.title} · ${plural(g.count, 'membre', 'membres')}`) : ['Aucun souhait'], go: '#/wishes' };
    case 'activity': return { lines: [`${plural(x.loans.now, 'prêt', 'prêts')} en 7 j`, `${plural(x.returns.now, 'retour', 'retours')}`, `${plural(x.books.now, 'livre ajouté', 'livres ajoutés')}`], go: 'open' };
    case 'kobo': return x.length
      ? { lines: [x[0].name, x[0].lastScanAt ? `scan du ${fmtDate(x[0].lastScanAt)}` : 'jamais scannée', ...(x[0].pending ? [`${x[0].pending} en attente`] : [])], go: `#/kobo/${x[0].id}` }
      : { lines: ['Aucune liseuse à ton nom'], go: '#/kobo' };
    default: return { lines: [], go: '#/' };
  }
}

// Destination d'une carte ou d'une ligne : page, onglet des prets ou filtre du catalogue.
function homeGo(target) {
  if (!target) return;
  if (target.startsWith('#/')) { if (target === '#/wishes') wishState.owners = 'all'; return go(target); }
  if (target === 'reading') return openCatalog({ reading: 'reading', statusUser: String(state.user.id) });
  if (target === 'recent') return openCatalog({ sort: 'recent' });
  if (target === 'toread') return openCatalog({ reading: 'to_read', statusUser: String(state.user.id) });
  pending.loansTab = target;
  go('#/loans');
}

const shelfHtml = (books, empty, opts = {}) => (books.length ? `<ul class="home-shelf" role="list">${books.map((b) => `<li><a class="home-book" href="#/book/${b.id}">
    ${coverHtml(b, b.mine ? 'Pour toi' : '')}<span class="t">${esc(b.title)}</span><span class="a">${esc(opts.sub ? opts.sub(b) : b.authors)}</span>
    ${opts.avail ? availabilityBadge(b) : ''}
    ${b.percent != null ? `<span class="home-progress"><span class="bar" aria-hidden="true"><span style="width:${b.percent}%"></span></span>
      <strong>${b.percent} %</strong></span>${b.lastReadAt ? `<span class="small muted">Lu le ${fmtDate(b.lastReadAt)}</span>` : ''}` : ''}</a></li>`).join('')}</ul>`
  : `<p class="muted">${empty}</p>`);

function homeCardBody(key, d) {
  const x = d[key];
  switch (key) {
    case 'todo': {
      const items = todoItems(x);
      return items.length ? `<div class="home-todo">${items.map((i) => `<button type="button" class="home-todo-item" data-home-go="${esc(i.target)}" style="${colorVars(i.color === 'danger' ? 'coral' : i.color === 'warn' ? 'sun' : i.color)}">
          <span class="n">${i.n}</span><span class="l">${i.label}</span></button>`).join('')}</div>`
        : '<p class="muted">Rien à faire : tout est à jour.</p>';
    }
    case 'reading': return shelfHtml(x, 'Aucune lecture en cours. Choisis « En cours » sur la fiche d\'un livre.');
    case 'forme': return x.length ? `<ul class="list">${x.map((f) => (f.kind === 'back'
      ? `<li class="list-item"><div class="grow"><a href="#/book/${f.book.id}"><strong>« ${esc(f.book.title)} » est disponible</strong></a><div class="small muted">Tu en es lecteur</div></div><span class="badge badge-ok">Disponible</span></li>`
      : `<li class="list-item"><div class="grow"><a href="#/book/${f.book.id}"><strong>« ${esc(f.book.title)} » a été ajouté</strong></a><div class="small muted">Le ${fmtDate(f.at)}, tu en es lecteur</div></div><span class="badge badge-wish">Nouveau</span></li>`)).join('')}</ul>`
      : '<p class="muted">Rien de neuf pour toi : les livres ajoutés pour toi (tes souhaits par exemple) et ceux dont tu es lecteur redevenus disponibles apparaîtront ici.</p>';
    case 'due': return x.length ? `<ul class="list">${x.map((l) => { loanCache.set(l.id, l); return `<li class="list-item">
        ${l.book.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(l.book.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb" aria-hidden="true"></span>'}
        <div class="grow"><a href="#/book/${l.book.id}"><strong>${esc(l.book.title)}</strong></a><div class="small muted"><a href="#/borrower/${l.borrower.id}">${esc(l.borrower.name)}</a> · <span class="code">${esc(l.copy.code)}</span></div></div>
        ${l.overdue ? `<span class="badge badge-late">${plural(daysLate(l.dueAt), 'jour', 'jours')} de retard</span>` : `<span class="badge badge-warn">${fmtDay(l.dueAt)}</span>`}
        <button class="btn btn-small" type="button" data-remind="${l.id}" aria-label="Relancer ${esc(l.borrower.name)} pour « ${esc(l.book.title)} »">${icon('mail', 16)}<span class="hide-mobile">Relancer</span></button></li>`; }).join('')}</ul>`
      : '<p class="muted">Aucune échéance dans les 14 prochains jours.</p>';
    case 'wishes': return `${x.items.length ? `<ul class="list">${x.items.map((w) => `<li class="list-item">
        ${w.coverUrl ? `<img class="thumb" src="${esc(wishSrc(w.coverUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="thumb" aria-hidden="true"></span>'}
        <div class="grow"><strong>${esc(w.title)}</strong><div class="small muted">${esc(w.authors)}</div></div>${w.priority ? `<span class="badge badge-wish">Très envie</span>` : ''}</li>`).join('')}</ul>`
      : '<p class="muted">Aucun souhait pour le moment.</p>'}<button class="btn btn-small" type="button" id="home-wish-add" style="margin-top:8px">${icon('add', 16)}Ajouter un souhait</button>`;
    case 'news': return shelfHtml(x.items, 'Aucun livre pour le moment.');
    case 'goal': {
      const others = x.others.length ? goalRowsHtml(x.others) : '';
      if (!x.goal) return `<p><strong>${plural(x.read, 'livre lu', 'livres lus')} en ${x.year}</strong></p>${others || '<p class="muted">Aucun objectif défini. <a href="#/account">Définir mes objectifs</a></p>'}`;
      const p = Math.min(1, x.read / x.goal);
      const c = 2 * Math.PI * 40;
      return `<div class="home-goal"><svg class="ring" viewBox="0 0 100 100" width="92" height="92" role="img" aria-label="${x.read} livres lus sur ${x.goal}">
          <circle cx="50" cy="50" r="40" class="track"/><circle cx="50" cy="50" r="40" class="val" stroke-dasharray="${(p * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/>
          <text x="50" y="57" text-anchor="middle">${x.read}</text></svg>
        <div><p><strong>${x.read} livre${x.read > 1 ? 's' : ''} lu${x.read > 1 ? 's' : ''} sur ${x.goal}</strong></p>
          <p class="${x.ahead >= 0 ? 'good' : 'bad'}">${x.ahead >= 0 ? `▲ ${plural(x.ahead, 'livre', 'livres')} d'avance` : `▼ ${plural(-x.ahead, 'livre', 'livres')} de retard`}</p>
          <p class="small muted">${x.pages.toLocaleString('fr-BE')} pages en ${x.year}</p></div></div>${others}`;
    }
    case 'series': return shelfHtml(x, 'Aucun tome suivant : les séries que tu lis ou as lues apparaîtront ici quand leur tome suivant est dans la bibliothèque.',
      { avail: true, sub: (b) => `${b.series} · tome ${b.number}` });
    case 'toread': return shelfHtml(x, 'Ta pile à lire est vide. Choisis « À lire » sur la fiche d\'un livre.', { avail: true });
    case 'rate': return x.length ? `<ul class="list">${x.map((b) => `<li class="list-item" data-rate-row="${b.id}">
        ${b.coverUrl ? `<img class="thumb" src="${esc(mediaSrc(b.coverUrl))}" alt="" loading="lazy">` : '<span class="thumb" aria-hidden="true"></span>'}
        <div class="grow"><a href="#/book/${b.id}"><strong>${esc(b.title)}</strong></a><div class="small muted">Lu${b.finishedAt ? ` le ${fmtDate(b.finishedAt)}` : ''}</div></div>
        <span class="home-stars" role="group" aria-label="Noter « ${esc(b.title)} »">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star" data-rate-book="${b.id}" data-rating="${n}" aria-label="${n} étoile${n > 1 ? 's' : ''}">★</button>`).join('')}</span>
      </li>`).join('')}</ul>` : '<p class="muted">Tous tes livres lus récemment ont une note.</p>';
    case 'idea': return `<div id="home-idea">${ideaHtml(x)}</div>`;
    case 'topwishes': return x.length ? `<ul class="list">${x.map((g, i) => `<li class="list-item">
        ${g.coverUrl ? `<img class="thumb" src="${esc(wishSrc(g.coverUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="thumb" aria-hidden="true"></span>'}
        <div class="grow"><strong>${esc(g.title)}</strong>${g.authors ? `<div class="small muted">${esc(g.authors)}</div>` : ''}
          <div class="small">${plural(g.count, 'membre', 'membres')} : ${g.owners.map((o) => esc(o.username)).join(', ')}${g.priority ? ` <span class="badge badge-wish">${icon('wish', 12)}${g.priority} très envie</span>` : ''}</div></div>
        <button class="btn btn-small btn-primary" type="button" data-top-add="${i}">${icon('add', 16)}<span class="hide-mobile">Ajouter</span></button></li>`).join('')}</ul>`
      : '<p class="muted">Aucun souhait des membres en attente.</p>';
    case 'activity': return `<div class="home-kpis">${[['loans', 'Prêts'], ['returns', 'Retours'], ['books', 'Livres ajoutés'], ['borrowers', 'Nouveaux emprunteurs']].map(([k, l]) => {
        const diff = x[k].now - x[k].before;
        return `<div class="home-kpi"><span class="n">${x[k].now}</span><span class="l">${l}</span>
          <span class="small ${diff > 0 ? 'good' : diff < 0 ? 'bad' : 'muted'}">${diff > 0 ? `▲ +${diff}` : diff < 0 ? `▼ ${diff}` : '='} <span class="muted">vs 7 j avant (${x[k].before})</span></span></div>`;
      }).join('')}</div><p class="small muted" style="margin:8px 0 0">7 derniers jours.</p>`;
    case 'kobo': return x.length ? `<ul class="list">${x.map((k) => `<li class="list-item"><div class="grow">
        <a href="#/kobo/${k.id}"><strong>${esc(k.name)}</strong></a>
        <div class="small muted">${k.lastScanAt ? `Dernier scan le ${fmtDate(k.lastScanAt, true)}` : 'Jamais scannée'} · ${plural(k.books, 'livre', 'livres')}</div>
        <div class="badges">${k.pending ? `<span class="badge badge-warn">${k.pending} envoyé${k.pending > 1 ? 's' : ''}, en attente d'un scan</span>` : ''}${k.unmatched ? `<span class="badge badge-muted">${k.unmatched} non relié${k.unmatched > 1 ? 's' : ''} à une fiche</span>` : ''}</div>
      </div></li>`).join('')}</ul>`
      : '<p class="muted">Aucune liseuse à ton nom. Branche ta Kobo depuis le menu du compte (« Brancher une liseuse »).</p>';
    default: return '';
  }
}
function ideaHtml(b) {
  if (!b) return '<p class="muted">Aucun livre disponible que tu n\'aies pas déjà lu.</p>';
  return `<div class="home-idea"><a href="#/book/${b.id}" class="home-idea-cover">${coverHtml(b)}</a>
    <div class="grow"><a href="#/book/${b.id}"><strong>${esc(b.title)}</strong></a>${b.authors ? `<div class="small muted">${esc(b.authors)}</div>` : ''}
      <div class="badges" style="margin:4px 0">${availabilityBadge(b)}${b.categories.map((c) => `<span class="badge badge-muted">${esc(c)}</span>`).join('')}</div>
      ${b.summary ? `<p class="small">${esc(b.summary)}</p>` : ''}
      <p class="small muted">${esc(b.reason)}</p>
      <button class="btn btn-small" type="button" id="home-idea-next" data-current="${b.id}">${icon('idea', 16)}Autre idée</button></div></div>`;
}
// Actions des cartes : notation, autre idee, ajout d'un souhait demande.
function bindHomeCards(d) {
  $$('[data-rate-book]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.rateBook);
      const b = (d.rate || []).find((x) => x.id === id);
      try {
        await api(`/api/books/${id}/status`, { method: 'PUT', body: { reading: 'read', opinion: b ? b.opinion : null, rating: Number(btn.dataset.rating) } });
        toast(`« ${b ? b.title : 'Livre'} » : ${btn.dataset.rating} / 5`);
        const row = $(`[data-rate-row="${id}"]`);
        if (row) row.remove();
        d.rate = (d.rate || []).filter((x) => x.id !== id);
        if (!d.rate.length) viewDashboard();
      } catch (err) { toast(err.message, 'error'); }
    };
  });
  const bindIdea = () => {
    const next = $('#home-idea-next');
    if (!next) return;
    next.onclick = async () => {
      next.disabled = true;
      try {
        const b = await api(`/api/home/idea?exclude=${next.dataset.current}`);
        d.idea = b;
        $('#home-idea').innerHTML = ideaHtml(b);
        bindIdea();
        const n = $('#home-idea-next');
        if (n) n.focus();
      } catch (err) { toast(err.message, 'error'); next.disabled = false; }
    };
  };
  bindIdea();
  $$('[data-top-add]').forEach((btn) => {
    btn.onclick = () => {
      const g = d.topwishes[Number(btn.dataset.topAdd)];
      pending.wish = { ...g, id: g.ids[0], owner: g.owners[0] };
      go('#/add');
    };
  });
}
const HOME_LINKS = { reading: ['reading', 'Tout voir'], due: ['open', 'Page Prêts'], wishes: ['#/wishes', 'Tout voir'], news: ['recent', 'Catalogue'], goal: ['#/stats', 'Statistiques'],
  toread: ['toread', 'Tout voir'], topwishes: ['#/wishes', 'Tous les souhaits'], activity: ['open', 'Page Prêts'], kobo: ['#/kobo', 'Toutes les liseuses'] };

async function viewDashboard() {
  const home = await api('/api/home');
  const shown = home.cards.filter((c) => c.shown);
  const d = home.data;
  const now = new Date().toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long' });
  const alerts = d.todo ? todoItems(d.todo).filter((i) => ['remind', 'overdue'].includes(i.target)).reduce((s, i) => s + i.n, 0) : 0;
  const sub = alerts ? `${now} · ${plural(alerts, 'prêt demande', 'prêts demandent')} ton attention` : now;
  // Smartphone : les premieres tuiles (dans l'ordre choisi), les autres derriere « Voir tout ».
  const foldTiles = shown.length > HOME_PHONE_TILES + 1;
  view().innerHTML = `<div class="home">
    <div class="home-head">
      <div class="home-hello"><h1>Bonjour ${esc(state.user.username)}</h1><p class="muted">${esc(sub.charAt(0).toUpperCase() + sub.slice(1))}</p></div>
    </div>
    ${shown.length ? `
    <div class="home-cards">${shown.map((c) => `<section class="card home-card" aria-labelledby="hc-${c.key}">
        <div class="home-card-head"><span class="h-icon" style="${colorVars(HOME_META[c.key].color)}" aria-hidden="true">${icon(HOME_META[c.key].icon, 18)}</span>
          <h2 id="hc-${c.key}">${esc(c.label)}${c.key === 'wishes' && d.wishes.count ? ` <span class="muted">(${d.wishes.count})</span>` : ''}</h2>
          ${HOME_LINKS[c.key] ? `<button type="button" class="link-btn" data-home-go="${HOME_LINKS[c.key][0]}">${HOME_LINKS[c.key][1]}</button>` : ''}</div>
        ${homeCardBody(c.key, d)}</section>`).join('')}</div>
    <nav class="home-tiles" id="home-tiles" aria-label="Accueil">${shown.map((c, i) => { const s = homeSummary(c.key, d); return `
        <button type="button" class="home-tile" data-home-go="${esc(s.go)}" data-lines="${s.lines.length}"${s.value ? ' data-value' : ''} style="${colorVars(HOME_META[c.key].color)}" ${foldTiles && i >= HOME_PHONE_TILES ? 'data-extra hidden' : ''}>
          <span class="tile-head"><span class="h-icon" aria-hidden="true">${icon(HOME_META[c.key].icon, 16)}</span><span class="tile-label">${esc(c.label)}</span></span>
          ${s.value ? `<span class="tile-value">${esc(s.value)}${s.sub ? ` <small>${esc(s.sub)}</small>` : ''}</span>` : ''}
          <span class="tile-lines">${s.lines.map((l) => `<span>${esc(l)}</span>`).join('')}</span>
        </button>`; }).join('')}
        ${foldTiles ? '<button type="button" class="home-tile home-more" id="home-more" aria-expanded="false"></button>' : ''}</nav>`
    : `<div class="empty">Toutes les cartes sont masquées.<br><br><button class="btn" type="button" id="home-custom-2"><span class="hide-mobile">Choisir les cartes</span><span class="show-mobile">Choisir</span></button></div>`}
  </div>`;
  if ($('#home-custom-2')) $('#home-custom-2').onclick = openHomeCustomize;
  $$('[data-home-go]').forEach((b) => { b.onclick = () => homeGo(b.dataset.homeGo); });
  if ($('#home-wish-add')) $('#home-wish-add').onclick = async () => { if (await wishDialog()) viewDashboard(); };
  bindHomeCards(d);
  if (foldTiles) {
    const more = $('#home-more');
    const setAll = (all) => {
      $$('#home-tiles [data-extra]').forEach((t) => { t.hidden = !all; });
      more.setAttribute('aria-expanded', String(all));
      more.innerHTML = `<span class="tile-head"><span class="tile-label">${all ? 'Réduire' : `Voir tout (${shown.length - HOME_PHONE_TILES} de plus)`}</span></span>`;
    };
    let all = false;
    try { all = localStorage.getItem('mll-home-all') === '1'; } catch (e) { /* stockage indisponible */ }
    setAll(all);
    more.onclick = () => {
      all = !all;
      try { localStorage.setItem('mll-home-all', all ? '1' : '0'); } catch (e) { /* stockage indisponible */ }
      setAll(all);
      fitHome();
    };
  }
  fitHome();
  // Apres la pastille du titre (ajoutee juste apres) : nouvelle mesure.
  requestAnimationFrame(fitHome);
}

// Smartphone : la page tient dans l'ecran. Hauteur des tuiles = place restante sous
// l'en-tete, grille calculee selon le nombre de cartes et l'orientation.
function fitHome() {
  const tiles = $('#home-tiles');
  const phone = window.matchMedia(HOME_PHONE_QUERY).matches;
  if (!tiles || !phone) { document.body.classList.remove('home-fit'); if (tiles) tiles.style.height = ''; return; }
  // Une seule colonne. Chaque tuile a la hauteur de toutes ses lignes (au moins MIN) ;
  // si tout tient, la place restante est partagee, sinon la page defile.
  const visible = Array.from(tiles.children).filter((t) => !t.hidden);
  const n = visible.length;
  const MIN = 68;
  const GAP = 8;
  const LINE = 16.2; // 12px x 1.35 (.tile-lines)
  const more = $('#home-more');
  const mins = visible.map((t) => (t === more ? 40 : Math.max(MIN, Math.ceil(46 + (t.hasAttribute('data-value') ? 26 : 0) + Number(t.dataset.lines || 0) * LINE))));
  const h = (window.visualViewport ? window.visualViewport.height : window.innerHeight) - (tiles.getBoundingClientRect().top + window.scrollY) - 12;
  const needed = mins.reduce((a, b) => a + b, 0) + (n - 1) * GAP;
  const fits = needed <= h;
  document.body.classList.toggle('home-fit', fits && !!$('.home'));
  tiles.style.setProperty('--cols', 1);
  // « Voir tout » : une ligne basse fixe, les tuiles se partagent le reste.
  tiles.style.gridTemplateRows = visible.map((t, i) => (t === more ? '40px' : `minmax(${mins[i]}px, 1fr)`)).join(' ');
  tiles.style.height = `${fits ? Math.max(120, Math.floor(h)) : needed}px`;
  // Petites tuiles : chiffre a cote du titre, pour garder des lignes de detail.
  tiles.classList.remove('compact');
  if (tiles.firstElementChild && tiles.firstElementChild.getBoundingClientRect().height < 104) tiles.classList.add('compact');
  // Lignes de detail : seulement des lignes entieres (jamais une ligne coupee).
  $$('.tile-lines', tiles).forEach((el) => {
    el.style.maxHeight = '';
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
    el.style.maxHeight = `${Math.floor(el.getBoundingClientRect().height / lh) * lh}px`;
  });
}
const refitHome = () => { if ($('#home-tiles')) fitHome(); };
window.addEventListener('resize', refitHome);
window.addEventListener('orientationchange', () => setTimeout(refitHome, 150));
[HOME_PHONE_QUERY, '(orientation: landscape)'].forEach((q) => { const m = window.matchMedia(q); if (m.addEventListener) m.addEventListener('change', refitHome); });
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { if ($('#home-tiles')) fitHome(); });
window.addEventListener('hashchange', () => { if (!/^#\/home$/.test(location.hash)) document.body.classList.remove('home-fit'); });

// Menu du compte « Personnaliser l'accueil » : depuis n'importe quelle page, puis accueil.
async function openHomeCustomize() {
  try {
    const { cards } = await api('/api/home');
    if (!await homeCustomize(cards)) return;
    if (location.hash === '#/home') viewDashboard(); else go('#/home');
  } catch (err) { toast(err.message, 'error'); }
}

// Choix et ordre des cartes (cases a cocher, boutons Monter / Descendre).
function homeCustomize(cards) {
  let list = cards.map((c) => ({ ...c }));
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="hcust-title">
      <h2 id="hcust-title">Personnaliser l'accueil</h2>
      <p class="small muted">Coche les cartes à afficher et règle leur ordre.</p>
      <ol class="home-order" id="home-order"></ol>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn btn-primary" type="button" id="hcust-save">Enregistrer</button>
        <button class="btn" type="button" id="hcust-reset"><span class="hide-mobile">Ordre par défaut</span><span class="show-mobile">Par défaut</span></button>
        <button class="btn" type="button" data-close>Annuler</button>
      </div></div>`;
    document.body.appendChild(backdrop);
    const close = (v) => { backdrop.remove(); resolve(v); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.hasAttribute('data-close')) close(false); });
    const box = $('#home-order', backdrop);
    const render = (focus) => {
      box.innerHTML = list.map((c, i) => `<li class="home-order-row">
        <label class="check grow"><input type="checkbox" data-shown="${i}" ${c.shown ? 'checked' : ''}> <span class="h-icon" style="${colorVars(HOME_META[c.key].color)}" aria-hidden="true">${icon(HOME_META[c.key].icon, 16)}</span>${esc(c.label)}</label>
        <button type="button" class="btn btn-small" data-move="${i}" data-dir="-1" aria-label="Monter ${esc(c.label)}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn btn-small" data-move="${i}" data-dir="1" aria-label="Descendre ${esc(c.label)}" ${i === list.length - 1 ? 'disabled' : ''}>↓</button></li>`).join('');
      if (focus) { const b = $(`[data-move="${focus[0]}"][data-dir="${focus[1]}"]`, box) || $(`[data-move="${focus[0]}"]:not([disabled])`, box); if (b) b.focus(); }
    };
    box.addEventListener('change', (e) => { const i = e.target.dataset.shown; if (i !== undefined) list[Number(i)].shown = e.target.checked; });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-move]');
      if (!b) return;
      const i = Number(b.dataset.move);
      const j = i + Number(b.dataset.dir);
      [list[i], list[j]] = [list[j], list[i]];
      render([j, b.dataset.dir]);
    });
    render();
    const save = async (body) => {
      try { await api('/api/home/cards', { method: 'PUT', body }); toast('Accueil enregistré.'); close(true); } catch (err) { toast(err.message, 'error'); }
    };
    $('#hcust-save', backdrop).onclick = () => save({ order: list.map((c) => c.key), hidden: list.filter((c) => !c.shown).map((c) => c.key) });
    $('#hcust-reset', backdrop).onclick = () => save({ order: null });
  });
}

export { viewDashboard, openHomeCustomize };
