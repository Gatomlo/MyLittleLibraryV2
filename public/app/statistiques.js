// Statistiques — module de l'interface (organisation : public/app/README.md).
import './etiquettes.js';
import { features } from './etat.js';
import { $, $$, view, esc, hint, mediaSrc, api, toast } from './utilitaires.js';
import { starsHtml, combo } from './catalogue.js';

// Tableau de bord : anneau d'objectif, cartes chiffres avec tendance, donut de
// repartition, colonnes et courbe mensuelles (infobulle au survol), podiums avec
// couvertures. Couleurs : accent pour une seule serie ; palette categorielle
// validee (4 teintes, ordre fixe) pour la repartition des statuts.
const PERIODS = [['year', 'Cette année'], ['last-year', "L'an dernier"], ['12m', '12 derniers mois'], ['all', 'Depuis le début']];
const statsState = { period: 'year', who: 'me' };

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('fr-BE'));
const monthLabel = (key, withYear) => new Date(`${key}-15T12:00:00Z`).toLocaleDateString('fr-BE', withYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
const coverSrc = (url) => (url ? mediaSrc(url) : '');
const initials = (t) => esc(String(t || '?').trim().charAt(0).toUpperCase());
const miniCover = (b, cls = '') => `<a class="mini-cover ${cls}" href="#/book/${b.bookId}" title="${esc(b.title || b.name)}">${b.cover
  ? `<img src="${esc(coverSrc(b.cover))}" alt="" loading="lazy">` : `<span>${initials(b.title || b.name)}</span>`}</a>`;

// Carte chiffre : icone, valeur, libelle, precision, et petite courbe de tendance.
function kpi(icon, value, label, hint, spark) {
  return `<div class="kpi"><div class="kpi-top"><span class="kpi-icon" aria-hidden="true">${icon}</span>${spark ? sparkline(spark) : ''}</div>
    <div class="kpi-value">${value}</div><div class="kpi-label">${esc(label)}</div>${hint ? `<div class="kpi-hint">${hint}</div>` : ''}</div>`;
}

function sparkline(values) {
  if (!values.length || values.every((v) => !v)) return '';
  const w = 90;
  const hgt = 28;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(hgt - 2 - (v / max) * (hgt - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${hgt}" width="${w}" height="${hgt}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Anneau de progression (objectif annuel).
function ring(pct, center, sub) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return `<svg class="ring" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="${p} %">
    <circle cx="64" cy="64" r="${r}" class="ring-track"/>
    <circle cx="64" cy="64" r="${r}" class="ring-value" stroke-dasharray="${((p / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 64 64)"/>
    <text x="64" y="62" text-anchor="middle" class="ring-center">${center}</text>
    <text x="64" y="82" text-anchor="middle" class="ring-sub">${sub}</text></svg>`;
}

// Donut de repartition : segments separes par un fin espace, legende avec valeurs.
function donut(segments, centerValue, centerLabel) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = 54;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const gap = total && segments.filter((s) => s.value).length > 1 ? 2 : 0;
  const arcs = total ? segments.filter((s) => s.value).map((s) => {
    const len = (s.value / total) * c;
    const arc = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="var(${s.color})" stroke-width="20"
      stroke-dasharray="${Math.max(0, len - gap).toFixed(2)} ${(c - Math.max(0, len - gap)).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 70 70)"><title>${esc(s.label)} : ${fmt(s.value)}</title></circle>`;
    offset += len;
    return arc;
  }).join('') : `<circle cx="70" cy="70" r="${r}" fill="none" class="ring-track" stroke-width="20"/>`;
  return `<div class="donut-wrap"><svg class="donut" viewBox="0 0 140 140" width="150" height="150" role="img" aria-label="${esc(centerLabel)}">${arcs}
    <text x="70" y="68" text-anchor="middle" class="ring-center">${fmt(centerValue)}</text>
    <text x="70" y="88" text-anchor="middle" class="ring-sub">${esc(centerLabel)}</text></svg>
    <ul class="donut-legend">${segments.map((s) => `<li><i style="background:var(${s.color})"></i><span>${esc(s.label)}</span>
      <strong>${fmt(s.value)}</strong><span class="muted">${total ? Math.round((s.value / total) * 100) : 0} %</span></li>`).join('')}</ul></div>`;
}

// Colonnes par mois ; comparaison optionnelle (annee precedente, en gris) avec legende.
function columns(series, { unit, compareLabel = 'Un an plus tôt' } = {}) {
  const withPrev = series.some((s) => s.prev != null && s.prev > 0);
  const max = Math.max(1, ...series.map((s) => Math.max(s.value, withPrev ? s.prev || 0 : 0)));
  const multiYear = new Set(series.map((s) => s.month.slice(0, 4))).size > 1;
  const bar = (v, cls) => `<div class="col ${cls}" style="height:${v ? Math.max(3, (v / max) * 100) : 0}%"></div>`;
  return `<div class="colchart">
    ${withPrev ? `<div class="legend"><span><i class="sw sw-cur"></i>Période</span><span><i class="sw sw-prev"></i>${esc(compareLabel)}</span></div>` : ''}
    <div class="cols">${series.map((s) => `<div class="col-slot" tabindex="0">
        <div class="col-tip">${monthLabel(s.month, true)} · <strong>${fmt(s.value)}</strong> ${esc(unit)}${withPrev ? `<br><span class="muted">un an plus tôt : ${fmt(s.prev || 0)}</span>` : ''}</div>
        <div class="col-pair">${bar(s.value, 'cur')}${withPrev ? bar(s.prev || 0, 'prev') : ''}</div>
        <div class="col-label">${monthLabel(s.month, multiYear)}</div></div>`).join('')}</div>
    ${tableView(series, unit, withPrev)}</div>`;
}

// Courbe (aire) par mois ; infobulle et reticule qui suivent la souris.
function area(series, { unit } = {}) {
  const w = 640;
  const hgt = 190;
  const pad = { l: 8, r: 8, t: 14, b: 26 };
  const max = Math.max(1, ...series.map((s) => s.value));
  const step = series.length > 1 ? (w - pad.l - pad.r) / (series.length - 1) : 0;
  const pts = series.map((s, i) => [pad.l + i * step, pad.t + (1 - s.value / max) * (hgt - pad.t - pad.b)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const fill = `${line} L${pts[pts.length - 1][0].toFixed(1)},${hgt - pad.b} L${pts[0][0].toFixed(1)},${hgt - pad.b} Z`;
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  const multiYear = new Set(series.map((s) => s.month.slice(0, 4))).size > 1;
  const labels = series.map((s, i) => ((series.length <= 12 || i % 3 === 0) ? `<text x="${pts[i][0].toFixed(1)}" y="${hgt - 8}" text-anchor="middle" class="axis-label">${monthLabel(s.month, multiYear)}</text>` : '')).join('');
  return `<div class="areachart" data-series='${esc(JSON.stringify(series.map((s, i) => ({ x: pts[i][0], y: pts[i][1], label: monthLabel(s.month, true), value: s.value }))))}' data-unit="${esc(unit)}">
    <svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" role="img" aria-label="Évolution par mois">
      <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      <line x1="${pad.l}" x2="${w - pad.r}" y1="${hgt - pad.b}" y2="${hgt - pad.b}" class="axis"/>
      <path d="${fill}" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${labels}
      <line class="crosshair" y1="${pad.t}" y2="${hgt - pad.b}" x1="0" x2="0" vector-effect="non-scaling-stroke"/>
    </svg><div class="area-dot"></div><div class="area-tip"></div>
    ${tableView(series, unit, false)}</div>`;
}

function tableView(series, unit, withPrev) {
  return `<details class="chart-table"><summary class="small muted">Voir les valeurs</summary>
    <table><thead><tr><th>Mois</th><th>${esc(unit)}</th>${withPrev ? '<th>Un an plus tôt</th>' : ''}</tr></thead><tbody>
    ${series.map((s) => `<tr><td>${monthLabel(s.month, true)}</td><td>${fmt(s.value)}</td>${withPrev ? `<td>${fmt(s.prev || 0)}</td>` : ''}</tr>`).join('')}</tbody></table></details>`;
}

// Reticule et infobulle des courbes (a lier apres affichage).
function bindAreaCharts(root) {
  $$('.areachart', root).forEach((el) => {
    const pts = JSON.parse(el.dataset.series || '[]');
    if (!pts.length) return;
    const svg = $('svg', el);
    const cross = $('.crosshair', el);
    const dot = $('.area-dot', el);
    const tip = $('.area-tip', el);
    const vb = svg.viewBox.baseVal;
    const show = (clientX) => {
      const box = svg.getBoundingClientRect();
      const x = ((clientX - box.left) / box.width) * vb.width;
      const p = pts.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
      const px = (p.x / vb.width) * box.width;
      const py = (p.y / vb.height) * box.height;
      cross.setAttribute('x1', p.x);
      cross.setAttribute('x2', p.x);
      el.classList.add('hover');
      dot.style.left = `${px}px`;
      dot.style.top = `${py}px`;
      tip.innerHTML = `${esc(p.label)} · <strong>${fmt(p.value)}</strong> ${esc(el.dataset.unit)}`;
      tip.style.left = `${Math.min(Math.max(px, 70), box.width - 70)}px`;
    };
    svg.addEventListener('mousemove', (e) => show(e.clientX));
    svg.addEventListener('mouseleave', () => el.classList.remove('hover'));
    svg.addEventListener('touchstart', (e) => show(e.touches[0].clientX), { passive: true });
  });
}

// Podium des 3 premiers (2 - 1 - 3), puis la suite en liste.
function podium(items, { unit = '', empty = 'Rien pour cette période.', covers = false } = {}) {
  if (!items || !items.length) return `<p class="muted small">${empty}</p>`;
  const top = items.slice(0, 3);
  const order = [top[1], top[0], top[2]];
  const medal = ['🥈', '🥇', '🥉'];
  const place = [2, 1, 3];
  const visual = (it) => (covers && it.bookId ? miniCover({ ...it, title: it.name }, 'podium-cover') : `<span class="podium-avatar">${initials(it.name)}</span>`);
  return `<div class="podium">${order.map((it, i) => (it ? `
      <div class="podium-slot place-${place[i]}">
        ${visual(it)}
        <div class="podium-name">${it.bookId ? `<a href="#/book/${it.bookId}">${esc(it.name)}</a>` : esc(it.name)}</div>
        <div class="podium-count">${fmt(it.count)}${unit}</div>
        <div class="podium-step"><span>${medal[i]}</span></div>
      </div>` : '<div class="podium-slot empty"></div>')).join('')}</div>
    ${items.length > 3 ? rankList(items.slice(3), { unit, start: 4 }) : ''}`;
}

// Classement en barres horizontales (a partir du rang `start`).
function rankList(items, { empty = 'Rien pour cette période.', unit = '', start = 1 } = {}) {
  if (!items || !items.length) return `<p class="muted small">${empty}</p>`;
  const max = Math.max(1, ...items.map((i) => i.count));
  return `<div class="rank">${items.map((i, n) => `
    <div class="rank-row">
      <span class="rank-pos">${start + n}</span>
      <div class="rank-main"><div class="rank-name">${i.bookId ? `<a href="#/book/${i.bookId}">${esc(i.name)}</a>` : esc(i.name)}${i.sub ? ` <span class="small muted">${esc(i.sub)}</span>` : ''}</div>
        <div class="rank-bar"><span style="width:${(i.count / max) * 100}%"></span></div></div>
      <div class="rank-count">${fmt(i.count)}${unit}</div>
    </div>`).join('')}</div>`;
}

// Notes : moyenne et repartition de 5 a 1 etoile.
function ratingsHtml(r, empty) {
  if (!r.count) return `<p class="muted small">${empty}</p>`;
  return `<div class="rating-avg"><strong>${fmt(r.average)}</strong> / 5 ${starsHtml(Math.round(r.average))} <span class="small muted">${fmt(r.count)} note(s)</span></div>`
    + `<div class="rating-dist">${[5, 4, 3, 2, 1].map((n) => {
      const v = r.distribution[n - 1];
      return `<div class="rating-row">${starsHtml(n)}<div class="rank-bar"><span style="width:${(v / Math.max(1, ...r.distribution)) * 100}%"></span></div><span class="rank-count">${fmt(v)}</span></div>`;
    }).join('')}</div>`;
}

const panel = (title, body, cls = '') => `<section class="panel ${cls}"><h3>${title}</h3>${body}</section>`;
const coverStrip = (books, empty) => (books.length
  ? `<div class="cover-strip">${books.map((b) => `<div class="strip-item">${miniCover(b)}<div class="strip-title">${esc(b.title || b.name)}</div></div>`).join('')}</div>`
  : `<p class="muted small">${empty}</p>`);

async function viewStats() {
  if (!features().stats) {
    view().innerHTML = '<div class="empty">Les statistiques ne sont pas activées pour cette bibliothèque (Réglages > Fonctionnalités).</div>';
    return;
  }
  const ov = await api('/api/stats/overview');
  if (statsState.who !== 'me' && statsState.who !== 'library' && !ov.shared.some((m) => String(m.id) === statsState.who)) statsState.who = 'me';
  const member = ov.shared.find((m) => String(m.id) === statsState.who);
  view().innerHTML = `
    <div class="stats-head">
      <div><h1>Statistiques</h1><p class="muted small" id="st-sub"></p></div>
      <div class="seg period-seg">${PERIODS.map(([k, l]) => `<button type="button" data-period="${k}" class="${statsState.period === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="stats-tabs" id="st-tabs">
      <button data-who="me" class="${statsState.who === 'me' ? 'active' : ''}"><span class="tab-avatar">${initials(ov.me.username)}</span>Mes statistiques</button>
      <button data-who="library" class="${statsState.who === 'library' ? 'active' : ''}"><span class="tab-avatar">🏛</span>Bibliothèque</button>
      ${ov.shared.length ? `<div class="stats-member-pick"><label for="st-member" class="sr-only">Statistiques partagées par un membre</label>
        <input type="search" id="st-member" class="${member ? 'active' : ''}" placeholder="Statistiques d'un membre (${ov.shared.length})…" value="${member ? esc(member.username) : ''}"></div>` : ''}
    </div>
    <div id="st-body"><p class="muted">Calcul…</p></div>`;
  $$('[data-period]').forEach((b) => {
    b.onclick = () => {
      statsState.period = b.dataset.period;
      $$('[data-period]').forEach((x) => x.classList.toggle('active', x === b));
      renderStatsBody(ov);
    };
  });
  const pick = $('#st-member');
  const show = (who) => {
    statsState.who = who;
    $$('#st-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.who === who));
    if (pick) {
      const m = ov.shared.find((x) => String(x.id) === who);
      pick.value = m ? m.username : '';
      pick.classList.toggle('active', !!m);
    }
    renderStatsBody(ov);
  };
  $$('#st-tabs [data-who]').forEach((b) => { b.onclick = () => show(b.dataset.who); });
  if (pick) {
    combo(pick, ov.shared.map((m) => ({ id: m.id, label: m.username })), (it) => show(String(it.id)), { emptyText: 'Aucun membre' });
    pick.addEventListener('focus', () => pick.select());
  }
  await renderStatsBody(ov);
}

async function renderStatsBody(ov) {
  const body = $('#st-body');
  body.classList.add('loading');
  try {
    if (statsState.who === 'library') {
      const s = await api(`/api/stats/library?period=${statsState.period}`);
      $('#st-sub').textContent = `Bibliothèque · ${s.period.label} · lecture en totaux anonymes`;
      body.innerHTML = libraryStatsHtml(s);
    } else {
      const id = statsState.who === 'me' ? ov.me.id : Number(statsState.who);
      const s = await api(`/api/stats/user/${id}?period=${statsState.period}`);
      $('#st-sub').textContent = `${statsState.who === 'me' ? 'Mes lectures' : `Lectures de ${s.user.username} (partagées)`} · ${s.period.label}`;
      body.innerHTML = userStatsHtml(s, statsState.who === 'me');
    }
    bindAreaCharts(body);
  } catch (err) { body.innerHTML = `<div class="error-box">${esc(err.message)}</div>`; }
  body.classList.remove('loading');
}

// Objectifs de l'annee (hors nombre de livres) : champ du formulaire et aide.
const GOAL_FIELDS = [
  ['pages', 'Pages à lire', 'Total des pages des livres terminés cette année (nombre de pages des fiches).'],
  ['maxToRead', 'Pile « À lire » : maximum', 'Nombre de livres marqués « À lire » à ne pas dépasser.'],
  ['categories', 'Catégories différentes', 'Nombre de catégories différentes parmi les livres terminés cette année.'],
  ['series', 'Séries à terminer', 'Séries dont tu as lu tous les tomes présents dans la bibliothèque, le dernier cette année.'],
];

// Avancement des objectifs (liste goals de goalProgress) : une ligne par objectif.
function goalRowsHtml(goals) {
  return `<ul class="goal-list">${goals.map((g) => {
    const pct = Math.min(100, Math.round((g.done / Math.max(g.target, 1)) * 100));
    const cls = g.ok ? 'goal-ok' : g.kind === 'max' ? 'goal-over' : g.expected != null && g.done < g.expected ? 'goal-late' : '';
    return `<li class="goal-row ${cls}"><div class="goal-head"><span>${g.ok ? '✓ ' : ''}${esc(g.label)}</span>
        <strong>${fmt(g.done)} <span class="muted">/ ${g.kind === 'max' ? 'max ' : ''}${fmt(g.target)}</span></strong></div>
      <div class="goal-bar" role="img" aria-label="${esc(g.label)} : ${g.done} sur ${g.target}"><span style="width:${pct}%"></span></div></li>`;
  }).join('')}</ul>`;
}

// Reglages personnels de lecture (par bibliotheque), affiches dans « Mon compte ».
function prefsHtml(ov) {
  const p = ov.prefs;
  const goals = p.goals || {};
  return `<h2>Mes lectures ${hint('Réglages propres à cette bibliothèque : partage de tes statistiques, objectifs de l\'année et délai avant de signaler une lecture qui traîne.')}</h2>
  <div class="card">
    <div class="grid-3">
      <div class="field"><label for="pf-share">Partager mes statistiques ${hint(ov.member ? 'Les membres choisis les voient dans Statistiques (sans pouvoir les modifier).' : 'Réservé aux comptes liés à cette bibliothèque.')}</label>
        <select id="pf-share" ${ov.member ? '' : 'disabled'}>${[['none', 'Avec personne'], ['all', 'Avec tous les membres'], ['some', 'Avec certains membres']]
          .map(([v, l]) => `<option value="${v}" ${p.shareMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Signaler une lecture en cours après (jours)</label><input type="number" id="pf-stale" min="1" max="3650" value="${p.staleDays}"></div>
    </div>
    <fieldset class="plain" id="pf-share-with" ${p.shareMode === 'some' ? '' : 'hidden'}><legend class="small muted">Membres qui voient mes statistiques :</legend>
      ${(ov.members || []).length ? `<div class="check-grid">${ov.members.map((m) => `<label class="check"><input type="checkbox" data-share-with="${m.id}" ${(p.shareWith || []).includes(m.id) ? 'checked' : ''}> ${esc(m.username)}</label>`).join('')}</div>`
        : '<p class="small muted">Aucun autre membre dans cette bibliothèque.</p>'}</fieldset>
    <h3>Objectifs de l'année ${hint('Laisse vide pour ne pas suivre un objectif. Ils s\'affichent dans Statistiques et dans la carte « Objectif de lecture » de l\'accueil.')}</h3>
    <div class="grid-3">
      <div class="field"><label for="pf-goal">Livres à lire</label><input type="number" id="pf-goal" min="1" max="1000" placeholder="aucun" value="${p.yearlyGoal || ''}"></div>
      ${GOAL_FIELDS.map(([k, label, help]) => `<div class="field"><label for="pf-${k}">${label} ${hint(help)}</label>
        <input type="number" id="pf-${k}" data-goal="${k}" min="0" placeholder="aucun" value="${goals[k] ?? ''}"></div>`).join('')}
    </div>
  </div>`;
}

function bindPrefs(ov) {
  const save = async (body) => {
    try {
      ov.prefs = await api('/api/stats/prefs', { method: 'PUT', body });
      toast('Réglages enregistrés.');
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#pf-share').onchange = (e) => {
    $('#pf-share-with').hidden = e.target.value !== 'some';
    save({ shareMode: e.target.value });
  };
  $$('[data-share-with]').forEach((c) => { c.onchange = () => save({ shareWith: $$('[data-share-with]:checked').map((x) => Number(x.dataset.shareWith)) }); });
  $('#pf-goal').onchange = (e) => save({ yearlyGoal: e.target.value || null });
  $$('[data-goal]').forEach((inp) => { inp.onchange = () => save({ goals: { [inp.dataset.goal]: inp.value === '' ? null : inp.value } }); });
  $('#pf-stale').onchange = (e) => save({ staleDays: e.target.value });
}

function userStatsHtml(s, mine) {
  const c = s.counts;
  const d = s.durations;
  const g = s.goal;
  const warn = features().readingStatus ? '' : '<div class="info-box">Les statuts de lecture sont désactivés : active-les (Réglages > Fonctionnalités) pour alimenter ces statistiques.</div>';

  let goalCard;
  if (g.target) {
    const pct = Math.round((g.done / g.target) * 100);
    const diff = Math.round((g.done - g.expected) * 10) / 10;
    goalCard = `<div class="goal-card">${ring(pct, `${g.done}/${g.target}`, `objectif ${g.year}`)}
      <div><div class="goal-pct">${Math.min(pct, 999)} %</div>
      <p class="small">${diff >= 0 ? `<span class="good">▲ ${fmt(Math.abs(diff))} livre(s) d'avance</span>` : `<span class="late">▼ ${fmt(Math.abs(diff))} livre(s) de retard</span>`}</p>
      <p class="small muted">${fmt(g.expected)} attendu(s) à ce jour</p></div></div>`;
  } else {
    goalCard = `<div class="goal-card">${ring(0, String(g.done), `lus en ${g.year}`)}
      <div><p class="small muted">${mine ? 'Fixe tes objectifs de l\'année dans « Mon compte » pour suivre ta progression.' : 'Pas d\'objectif annuel.'}</p></div></div>`;
  }

  const records = [
    ['🚀', 'Lecture la plus rapide', d.fastest, d.fastest && `${d.fastest.days} jour(s)`],
    ['🐢', 'Lecture la plus longue', d.slowest, d.slowest && `${d.slowest.days} jour(s)`],
    ['📚', 'Livre le plus épais', d.thickest, d.thickest && `${fmt(d.thickest.pages)} pages`],
  ];

  return `${warn}
    <div class="hero">
      ${goalCard}
      <div class="kpis">
        ${kpi('📚', fmt(c.read), 'Livres lus', '', s.monthly.map((m) => m.books))}
        ${kpi('📄', fmt(s.pages), 'Pages lues', '', s.monthly.map((m) => m.pages))}
        ${kpi('⚡', d.pagesPerDay != null ? fmt(d.pagesPerDay) : '—', 'Pages par jour', d.count ? `sur ${d.count} livre(s) daté(s)` : 'dates de lecture requises')}
        ${kpi('⏱', d.avgDays != null ? `${fmt(d.avgDays)} j` : '—', 'Durée moyenne d\'un livre')}
      </div>
    </div>

    ${(s.goals || []).some((x) => x.key !== 'books') ? panel(`Objectifs ${g.year}`, goalRowsHtml(s.goals.filter((x) => x.key !== 'books')), 'goals-panel') : ''}
    <div class="dash-grid">
      ${panel('Répartition', donut([
        { label: 'Lus', value: c.read, color: '--cat-1' },
        { label: 'En cours', value: c.reading, color: '--cat-2' },
        { label: 'À lire', value: c.toRead, color: '--cat-3' },
        { label: 'Abandonnés', value: c.abandoned, color: '--cat-4' },
      ], c.read + c.reading + c.toRead + c.abandoned, 'livres') + `<p class="small muted" style="margin-top:8px">${s.abandonRate != null ? `Taux d'abandon : <strong>${s.abandonRate} %</strong>` : ''}${c.liked ? ` · ♥ ${fmt(c.liked)} aimé(s)` : ''}${c.disliked ? ` · ✕ ${fmt(c.disliked)} pas aimé(s)` : ''}</p>`)}
      ${panel('Livres lus par mois', columns(s.monthly.map((m) => ({ month: m.month, value: m.books, prev: m.prevBooks })), { unit: 'livre(s)' }), 'span-2')}
    </div>

    ${panel('Pages lues par mois', area(s.monthly.map((m) => ({ month: m.month, value: m.pages })), { unit: 'pages' }))}

    <div class="dash-grid">
      ${panel('🏆 Auteurs favoris', podium(s.tastes.authors, { unit: ' livre(s)', empty: 'Aucun livre lu sur cette période.' }))}
      ${panel('Catégories', rankList(s.tastes.categories.map((t) => ({ name: t.name, count: t.read + t.abandoned, sub: `${t.read} lu(s)${t.abandoned ? ` · ${t.abandoned} abandonné(s)` : ''}${t.liked ? ` · ♥ ${t.liked}` : ''}` }))))}
      ${features().tags ? panel('Tags', rankList(s.tastes.tags.map((t) => ({ name: '#' + t.name, count: t.read + t.abandoned, sub: `${t.read} lu(s)${t.liked ? ` · ♥ ${t.liked}` : ''}` })))) : ''}
      ${s.ratings ? panel('⭐ Mes notes', ratingsHtml(s.ratings, 'Aucun livre noté sur cette période.')) : ''}
      ${s.tastes.series && s.tastes.series.length ? panel('Séries', rankList(s.tastes.series)) : ''}
    </div>

    ${panel('Records', `<div class="records">${records.map(([icon, label, b, val]) => `
      <div class="record">${b ? miniCover(b, 'record-cover') : '<span class="mini-cover record-cover"><span>?</span></span>'}
        <div><div class="record-label">${icon} ${label}</div>${b ? `<a href="#/book/${b.bookId}" class="record-title">${esc(b.title)}</a><div class="record-value">${val}</div>` : '<div class="muted small">Pas encore de données</div>'}</div></div>`).join('')}</div>`)}

    <div class="dash-grid">
      ${panel('📖 En cours', s.current.length ? `<div class="reading-now">${s.current.map((b) => `
        <div class="now-item">${miniCover(b)}
          <div class="now-info"><a href="#/book/${b.bookId}">${esc(b.title)}</a>
            <div class="small muted">${b.days != null ? `${b.days} jour(s)` : 'début inconnu'}${b.pages ? ` · ${fmt(b.pages)} p.` : ''}</div>
            ${b.days != null ? `<div class="now-bar ${b.stale ? 'stale' : ''}"><span style="width:${Math.min(100, (b.days / s.staleDays) * 100)}%"></span></div>` : ''}
            ${b.stale ? `<span class="badge badge-warn">Traîne (+ de ${s.staleDays} j)</span>` : ''}</div></div>`).join('')}</div>`
        : '<p class="muted small">Aucune lecture en cours.</p>', 'span-2')}
      ${panel('♥ Coups de cœur', coverStrip(s.favorites, 'Aucun livre aimé pour le moment.'))}
    </div>
    ${s.ratings && s.ratings.top.length ? panel('⭐ Les mieux notés', coverStrip(s.ratings.top.map((b) => ({ ...b, title: `${b.title} · ${'★'.repeat(b.rating)}` })), '')) : ''}`;
}

function libraryStatsHtml(s) {
  const L = s.loans;
  const F = s.fonds;
  const R = s.reading;
  return `
    <div class="kpis kpis-wide">
      ${R ? kpi('📚', fmt(R.booksRead), 'Lectures terminées') : ''}
      ${R ? kpi('👥', fmt(R.activeReaders), 'Lecteurs actifs') : ''}
      ${R && R.ratings ? kpi('⭐', R.ratings.average != null ? fmt(R.ratings.average) : '—', 'Note moyenne', `${fmt(R.ratings.count)} note(s)`) : ''}
      ${kpi('🔁', fmt(L.total), 'Prêts sur la période', '', L.perMonth.map((m) => m.count))}
      ${kpi('📤', fmt(L.open), 'Prêts en cours')}
      ${kpi('⏱', L.avgDays != null ? `${fmt(L.avgDays)} j` : '—', 'Durée moyenne d\'un prêt')}
      ${kpi('📘', fmt(F.books), 'Livres', features().ebooks ? `${fmt(F.physical)} papier · ${fmt(F.ebooks)} numérique(s)` : '', F.growth.map((m) => m.count))}
      ${kpi('🏷', fmt(F.copies), 'Exemplaires papier')}
      ${kpi('📄', fmt(F.pages), 'Pages au total')}
    </div>

    ${R ? `<div class="dash-grid">
      ${panel('🏆 Les plus lus', podium(R.mostRead, { covers: true, unit: ' lecteur(s)' }))}
      ${panel('♥ Les plus aimés', podium(R.mostLiked, { covers: true, empty: 'Aucun livre aimé.' }))}
      ${panel('Les plus abandonnés', rankList(R.mostAbandoned))}
    </div>
    ${R.ratings ? `<div class="dash-grid">
      ${panel('⭐ Les mieux notés', podium(R.bestRated, { covers: true, unit: ' ★', empty: 'Aucun livre noté.' }))}
      ${panel('⭐ Notes données', ratingsHtml(R.ratings, 'Aucune note sur cette période.'))}
    </div>` : ''}` : ''}

    <div class="dash-grid">
      ${panel('Prêts par mois', columns(L.perMonth.map((m) => ({ month: m.month, value: m.count })), { unit: 'prêt(s)' }), 'span-2')}
      ${panel('🏆 Les plus empruntés', podium(L.mostBorrowed, { covers: true, unit: ' prêt(s)' }))}
    </div>

    <div class="dash-grid">
      ${panel('Emprunteurs les plus actifs', rankList(L.topBorrowers, { unit: ' prêt(s)' }))}
      ${panel('Prêts en cours les plus anciens', L.oldestOpen.length ? `<div class="reading-now">${L.oldestOpen.map((l) => `
        <div class="now-item">${miniCover({ ...l, title: l.name })}<div class="now-info"><a href="#/book/${l.bookId}">${esc(l.name)}</a>
          <div class="small muted">${esc(l.borrower)} · ${l.days} jour(s)</div></div></div>`).join('')}</div>` : '<p class="muted small">Aucun prêt en cours.</p>')}
      ${panel(`Jamais empruntés (${fmt(L.neverBorrowedCount)})`, coverStrip(L.neverBorrowed, 'Tous les livres ont déjà été empruntés.')
        + (L.neverBorrowedCount > L.neverBorrowed.length ? `<p class="small muted">… et ${L.neverBorrowedCount - L.neverBorrowed.length} autre(s).</p>` : ''))}
    </div>

    <div class="dash-grid">
      ${panel('Livres ajoutés par mois', area(F.growth.map((m) => ({ month: m.month, value: m.count })), { unit: 'livre(s)' }), 'span-2')}
      ${features().ebooks ? panel('Papier / numérique', donut([
        { label: 'Papier seul', value: F.paperOnly, color: '--cat-1' },
        { label: 'Papier + numérique', value: F.both, color: '--cat-3' },
        { label: 'Numérique seul', value: F.ebookOnly, color: '--cat-2' },
      ], F.books, 'livres')) : panel('Catégories du fonds', rankList(F.byCategory))}
    </div>
    ${features().ebooks ? `<div class="dash-grid">${panel('Catégories du fonds', rankList(F.byCategory))}</div>` : ''}`;
}

export { initials, viewStats, prefsHtml, bindPrefs, goalRowsHtml };
