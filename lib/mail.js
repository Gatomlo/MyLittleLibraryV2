// Envoi des e-mails. Chaque bibliotheque a son propre serveur SMTP (table library_mail
// de la base centrale), regle par l'administrateur : une bibliotheque n'envoie jamais
// par le serveur d'une autre ni par un serveur par defaut. Sans SMTP operationnel
// (configure + dernier test reussi + pas d'echecs repetes), elle n'envoie rien.
// Chaque envoi est note dans le journal de la bibliotheque (mail_log).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { db, inLibrary, DATA_DIR } = require('./db');
const { httpError, str, intOrNull } = require('./util');

// Echecs d'envoi consecutifs a partir desquels l'envoi passe « en erreur » (envoi
// automatique suspendu jusqu'a un nouveau test reussi).
const MAX_FAILURES = 3;
const SECURITY = ['ssl', 'starttls', 'none'];

// ---------- Adresses ----------
const EMAIL_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/;
// Adresse saisie : '' si vide, erreur 400 si invalide.
function readEmail(v, label = 'Adresse e-mail') {
  const s = str(v, 200);
  if (!s) return '';
  if (!EMAIL_RE.test(s)) throw httpError(400, `${label} invalide.`);
  return s;
}

// ---------- Mot de passe SMTP chiffre ----------
// Cle : variable d'environnement MLL_SECRET, sinon fichier data/secret.key cree au
// premier besoin (absent des sauvegardes de bases : une copie de central.db ne livre
// pas le mot de passe). Cle perdue : mot de passe illisible, a ressaisir.
let keyCache = null;
function secretKey() {
  if (keyCache) return keyCache;
  let secret = process.env.MLL_SECRET || '';
  if (!secret) {
    const file = path.join(DATA_DIR, 'secret.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    secret = fs.readFileSync(file, 'utf8').trim();
  }
  keyCache = crypto.createHash('sha256').update(secret).digest();
  return keyCache;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(':');
}

// null si illisible (cle changee).
function decrypt(stored) {
  const [v, iv, tag, data] = String(stored || '').split(':');
  if (v !== 'v1' || !iv || !tag || data === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) { return null; }
}

// ---------- Reglages SMTP d'une bibliotheque ----------
const getRow = (libraryId) => db.prepare('SELECT * FROM library_mail WHERE library_id = ?').get(libraryId) || null;

// active | inactive (non configure ou jamais teste) | error (echecs repetes).
function statusOf(row) {
  if (!row || !row.verified_at) return 'inactive';
  return row.failures >= MAX_FAILURES ? 'error' : 'active';
}
const mailStatus = (libraryId) => statusOf(getRow(libraryId));

// Pour l'administration : jamais le mot de passe.
function adminConfig(libraryId) {
  const r = getRow(libraryId);
  if (!r) return { configured: false, status: 'inactive', security: 'ssl', port: 465 };
  return {
    configured: true, status: statusOf(r), host: r.host, port: r.port, security: r.security, username: r.username || '',
    passwordSaved: !!r.password_enc, passwordUnreadable: !!r.password_enc && decrypt(r.password_enc) == null,
    fromAddress: r.from_address, fromName: r.from_name || '', replyTo: r.reply_to || '',
    verifiedAt: r.verified_at, failures: r.failures, lastError: r.last_error || '', lastErrorAt: r.last_error_at,
  };
}

// Enregistre les reglages (body.password vide : mot de passe inchange). Tout
// changement remet l'envoi « non teste » : un nouveau test reussi le reactive.
function saveConfig(libraryId, b) {
  const host = str(b.host, 200).toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) throw httpError(400, 'Serveur SMTP invalide (ex. mail.infomaniak.com).');
  const port = intOrNull(b.port);
  if (!(port >= 1 && port <= 65535)) throw httpError(400, 'Port invalide (465 en SSL, 587 en STARTTLS).');
  const security = SECURITY.includes(b.security) ? b.security : 'ssl';
  const fromAddress = readEmail(b.fromAddress, "Adresse d'expédition");
  if (!fromAddress) throw httpError(400, "L'adresse d'expédition est requise.");
  const next = {
    host, port, security, username: str(b.username, 200) || null, from_address: fromAddress,
    from_name: str(b.fromName, 120) || null, reply_to: readEmail(b.replyTo, 'Adresse de réponse') || null,
  };
  const old = getRow(libraryId);
  const password = typeof b.password === 'string' && b.password ? encrypt(b.password.slice(0, 500)) : old ? old.password_enc : null;
  const changed = !old || password !== old.password_enc || Object.keys(next).some((k) => next[k] !== old[k]);
  db.prepare(`INSERT INTO library_mail (library_id, host, port, security, username, password_enc, from_address, from_name, reply_to)
    VALUES (@id, @host, @port, @security, @username, @password, @from_address, @from_name, @reply_to)
    ON CONFLICT(library_id) DO UPDATE SET host = excluded.host, port = excluded.port, security = excluded.security,
      username = excluded.username, password_enc = excluded.password_enc, from_address = excluded.from_address,
      from_name = excluded.from_name, reply_to = excluded.reply_to, updated_at = datetime('now')`)
    .run({ id: libraryId, ...next, password });
  if (changed) db.prepare('UPDATE library_mail SET verified_at = NULL, failures = 0 WHERE library_id = ?').run(libraryId);
}

function removeConfig(libraryId) {
  db.prepare('DELETE FROM library_mail WHERE library_id = ?').run(libraryId);
  // Plus d'envoi : les rappels automatiques sont coupes.
  db.prepare('UPDATE libraries SET reminder_auto_send = 0 WHERE id = ?').run(libraryId);
}

// ---------- Envoi ----------
// MLL_MAIL_OUTBOX (tests, demonstration) : messages ajoutes a ce fichier (une ligne
// JSON par message) au lieu d'etre envoyes ; un serveur en .invalid echoue.
function outboxTransport(row) {
  return {
    sendMail: async (msg) => {
      if (/\.invalid$/.test(row.host)) throw new Error(`getaddrinfo ENOTFOUND ${row.host}`);
      fs.appendFileSync(process.env.MLL_MAIL_OUTBOX, JSON.stringify({ libraryId: row.library_id, ...msg }) + '\n');
    },
    close: () => {},
  };
}

function transportFor(row, password) {
  if (process.env.MLL_MAIL_OUTBOX) return outboxTransport(row);
  return nodemailer.createTransport({
    host: row.host, port: row.port, secure: row.security === 'ssl', requireTLS: row.security === 'starttls',
    auth: row.username ? { user: row.username, pass: password || '' } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    disableFileAccess: true, disableUrlAccess: true,
  });
}

// Message d'erreur lisible (une ligne, sans les details techniques trop longs).
const errorText = (e) => String((e && (e.response || e.message)) || e).replace(/\s+/g, ' ').slice(0, 300);

function log(libraryId, entry) {
  inLibrary(libraryId, () => db.prepare(`INSERT INTO mail_log (kind, origin, recipient, subject, borrower_id, loan_ids, user_id, ok, error)
    VALUES (@kind, @origin, @recipient, @subject, @borrowerId, @loanIds, @userId, @ok, @error)`).run({
    kind: entry.kind, origin: entry.origin || 'manual', recipient: entry.to || null, subject: entry.subject || null,
    borrowerId: entry.borrowerId || null, loanIds: entry.loanIds ? entry.loanIds.join(',') : null, userId: entry.userId || null,
    ok: entry.ok ? 1 : 0, error: entry.error || null,
  }));
}

// Envoie un message texte par le SMTP de la bibliotheque. msg : { to, subject, text,
// kind (reminder | reset | test), origin (manual | auto), borrowerId, loanIds, userId }.
// Hors test, il faut un envoi operationnel. Erreur 422 si le serveur refuse.
async function sendMail(libraryId, msg) {
  const row = getRow(libraryId);
  const test = msg.kind === 'test';
  if (!row) throw httpError(409, "L'envoi des e-mails n'est pas configuré pour cette bibliothèque.");
  if (!test && statusOf(row) !== 'active') throw httpError(409, "L'envoi des e-mails n'est pas opérationnel pour cette bibliothèque.");
  const password = row.password_enc ? decrypt(row.password_enc) : '';
  if (password == null) throw httpError(409, "Mot de passe SMTP illisible (clé du serveur changée) : à ressaisir dans l'administration.");
  const lib = db.prepare('SELECT name FROM libraries WHERE id = ?').get(libraryId);
  const transport = transportFor(row, password);
  try {
    await transport.sendMail({
      from: { name: row.from_name || lib.name, address: row.from_address },
      to: msg.to, replyTo: row.reply_to || undefined, subject: msg.subject, text: msg.text,
    });
  } catch (e) {
    const error = errorText(e);
    if (test) db.prepare("UPDATE library_mail SET verified_at = NULL, last_error = ?, last_error_at = datetime('now') WHERE library_id = ?").run(error, libraryId);
    else db.prepare("UPDATE library_mail SET failures = failures + 1, last_error = ?, last_error_at = datetime('now') WHERE library_id = ?").run(error, libraryId);
    log(libraryId, { ...msg, ok: false, error });
    throw httpError(422, `Envoi impossible : ${error}`);
  } finally {
    transport.close();
  }
  db.prepare(`UPDATE library_mail SET failures = 0${test ? ", verified_at = datetime('now'), last_error = NULL" : ''} WHERE library_id = ?`).run(libraryId);
  log(libraryId, { ...msg, ok: true });
}

// Journal (les plus recents d'abord), dans le contexte de la bibliotheque.
function mailLog(limit = 100) {
  return db.prepare(`SELECT m.*, b.name AS borrower_name FROM mail_log m LEFT JOIN borrowers b ON b.id = m.borrower_id
    ORDER BY m.id DESC LIMIT ?`).all(limit).map((m) => ({
    id: m.id, sentAt: m.sent_at, kind: m.kind, origin: m.origin, recipient: m.recipient || '', subject: m.subject || '',
    borrower: m.borrower_id ? { id: m.borrower_id, name: m.borrower_name || '' } : null, ok: !!m.ok, error: m.error || '',
  }));
}

module.exports = {
  MAX_FAILURES, readEmail, mailStatus, adminConfig, saveConfig, removeConfig, sendMail, mailLog, encrypt, decrypt,
};
