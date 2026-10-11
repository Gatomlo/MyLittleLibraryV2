// Rappels de retour envoyes par e-mail (SMTP de la bibliotheque, voir lib/mail.js) :
// a la demande (un emprunteur, ou tous les prets « a relancer ») et automatiquement
// une fois par jour pour les bibliotheques qui l'ont active (rappels programmes +
// envoi automatique). Sans SMTP operationnel, l'interface garde le mailto.
const { db, inLibrary } = require('./db');
const { httpError } = require('./util');
const mail = require('./mail');
const { listLoans } = require('./library/catalog');

// Meme modele par defaut que REMINDER_DEFAULT (public/app/utilitaires.js).
const REMINDER_DEFAULT = {
  subject: 'Rappel : livre(s) à rendre à {bibliotheque}',
  body: 'Bonjour {nom},\n\nPetit rappel concernant le(s) livre(s) emprunté(s) à {bibliotheque} :\n{livres}\n\n'
    + 'Merci de le(s) rapporter dès que possible. Si un délai supplémentaire est nécessaire, il suffit de répondre à ce message.\n\nBonne lecture !',
};
// Heure locale a partir de laquelle part l'envoi automatique du jour.
const AUTO_HOUR = Number(process.env.MLL_REMINDER_HOUR) || 9;
// Pause entre deux messages d'une serie (serveurs SMTP qui limitent le debit).
const GAP_MS = process.env.MLL_MAIL_OUTBOX ? 0 : 1000;

const fmtDay = (s) => (s ? s.split('-').reverse().join('/') : '');
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function reminderMessage(lib, borrower, loans) {
  const due = loans.map((l) => l.dueAt).filter(Boolean).sort()[0] || '';
  const lines = loans.map((l) => `- ${l.book.title} (${l.copy.code})${l.dueAt ? ` : à rendre le ${fmtDay(l.dueAt)}${l.overdue ? ' (en retard)' : ''}` : ''}`).join('\n');
  const fill = (s) => s.replace(/\{(nom|livres|bibliotheque|date_retour)\}/g, (m, k) => ({
    nom: borrower.name, livres: lines, bibliotheque: lib.name, date_retour: fmtDay(due) })[k]);
  return { subject: fill(lib.reminder_subject || REMINDER_DEFAULT.subject), text: fill(lib.reminder_body || REMINDER_DEFAULT.body) };
}

// Un message pour un emprunteur et ses prets ; relance notee si l'envoi reussit.
// A appeler dans le contexte de la bibliotheque.
async function sendToBorrower(lib, borrower, loans, { origin = 'manual', userId = null } = {}) {
  if (!borrower.email) throw httpError(409, `${borrower.name} n'a pas d'adresse e-mail.`);
  const msg = reminderMessage(lib, borrower, loans);
  const ids = loans.map((l) => l.id);
  await mail.sendMail(lib.id, { ...msg, to: borrower.email, kind: 'reminder', origin, borrowerId: borrower.id, loanIds: ids, userId });
  db.prepare(`UPDATE loans SET reminded_at = datetime('now'), reminder_count = reminder_count + 1
    WHERE returned_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

// Rappel d'un emprunteur pour certains de ses prets en cours (bouton « Relancer »).
async function sendBorrowerReminder(lib, borrowerId, loanIds, userId) {
  const wanted = new Set(loanIds);
  const loans = listLoans(lib.id, { status: 'open', borrowerId }).filter((l) => wanted.has(l.id));
  if (!loans.length) throw httpError(404, 'Aucun prêt en cours à relancer.');
  await sendToBorrower(lib, loans[0].borrower, loans, { userId });
  return { sent: 1 };
}

// Tous les prets « a relancer », un message par emprunteur. Emprunteurs sans adresse :
// ignores (signales). Premier echec : la serie s'arrete (serveur en panne, inutile
// d'insister). A appeler dans le contexte de la bibliotheque.
async function sendDueReminders(lib, { origin = 'manual', userId = null } = {}) {
  const groups = new Map();
  listLoans(lib.id, { status: 'remind' }).forEach((l) => {
    if (!groups.has(l.borrower.id)) groups.set(l.borrower.id, []);
    groups.get(l.borrower.id).push(l);
  });
  const out = { sent: 0, skipped: [], failed: 0, remaining: 0, error: '' };
  const list = [...groups.values()];
  for (let i = 0; i < list.length; i++) {
    const loans = list[i];
    const borrower = loans[0].borrower;
    if (!borrower.email) { out.skipped.push(borrower.name); continue; }
    if (out.sent && GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
    try {
      await sendToBorrower(lib, borrower, loans, { origin, userId });
      out.sent++;
    } catch (e) {
      out.failed++;
      out.error = e.message;
      out.remaining = list.slice(i + 1).filter((ls) => ls[0].borrower.email).length;
      break;
    }
  }
  return out;
}

// Envoi automatique du jour : bibliotheques en rappels programmes avec l'envoi
// automatique et un SMTP operationnel, une fois par jour a partir de AUTO_HOUR. Les
// prets deja relances ne sont pas repris (toRemindSql) : un jour manque (serveur
// arrete) est rattrape au passage suivant, sans doublon.
let running = false;
async function runAutoReminders({ now = new Date(), force = false } = {}) {
  if (running) return [];
  running = true;
  const done = [];
  try {
    if (!force && now.getHours() < AUTO_HOUR) return done;
    const day = localDay(now);
    const libs = db.prepare(`SELECT * FROM libraries WHERE reminder_mode = 'auto' AND reminder_auto_send = 1
      AND (reminder_auto_day IS NULL OR reminder_auto_day <> ?)`).all(force ? '' : day);
    for (const lib of libs) {
      if (mail.mailStatus(lib.id) !== 'active') continue;
      // Note avant l'envoi : un redemarrage pendant la serie ne la relance pas le meme jour.
      db.prepare('UPDATE libraries SET reminder_auto_day = ? WHERE id = ?').run(day, lib.id);
      try {
        const r = await inLibrary(lib.id, () => sendDueReminders(lib, { origin: 'auto' }));
        done.push({ libraryId: lib.id, ...r });
        if (r.failed) console.error(`Rappels automatiques (${lib.name}) : ${r.error}`);
      } catch (e) { console.error(`Rappels automatiques (${lib.name}) :`, e); }
    }
  } finally {
    running = false;
  }
  return done;
}

// Verification toutes les 15 minutes (et une minute apres le demarrage). Les minuteries
// ne retiennent pas le processus (unref).
function startReminderScheduler() {
  const tick = () => runAutoReminders().catch((e) => console.error('Rappels automatiques :', e));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 15 * 60 * 1000).unref();
}

module.exports = { REMINDER_DEFAULT, reminderMessage, sendBorrowerReminder, sendDueReminders, runAutoReminders, startReminderScheduler };
