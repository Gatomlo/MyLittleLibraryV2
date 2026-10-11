// Envoi des e-mails : SMTP par bibliotheque (administrateur), mot de passe oublie,
// rappels de retour manuels et automatiques, journal. Les messages sont ecrits dans
// MLL_MAIL_OUTBOX (voir tests/helpers.js) ; un serveur en .invalid echoue.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { setup, stop, login, client, PASSWORD } = require('./helpers');
const { db } = require('../lib/db');
const { runAutoReminders } = require('../lib/reminders');

let ctx;
let a;
let api;
const SMTP = { host: 'smtp.exemple.org', port: 465, security: 'ssl', username: 'biblio@exemple.org', password: 'secret-smtp', fromAddress: 'biblio@exemple.org', replyTo: 'accueil@exemple.org' };

const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const outbox = () => (fs.existsSync(process.env.MLL_MAIL_OUTBOX)
  ? fs.readFileSync(process.env.MLL_MAIL_OUTBOX, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
// Attend un nouveau message (mot de passe oublie : envoye apres la reponse).
async function nextMail(count) {
  for (let i = 0; i < 50; i++) {
    const list = outbox();
    if (list.length > count) return list[list.length - 1];
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

before(async () => {
  ctx = await setup();
  a = ctx.admin;
  api = ctx.api;
});
after(stop);

test('SMTP : reglage par l\'administrateur, operationnel apres un test reussi', async () => {
  const g = ctx.users.gestionnaire;
  assert.equal(ok(await g.get(`${api}/settings`)).mail.status, 'inactive');
  assert.equal((await g.put(`${api}/settings`, { reminders: { autoSend: true } })).status, 409);
  assert.equal((await g.get('/api/admin/mail')).status, 403);
  assert.equal((await g.put(`/api/admin/libraries/${ctx.lib.id}/mail`, SMTP)).status, 403);

  assert.equal((await a.put(`/api/admin/libraries/${ctx.lib.id}/mail`, { ...SMTP, host: 'pas un serveur' })).status, 400);
  let conf = ok(await a.put(`/api/admin/libraries/${ctx.lib.id}/mail`, SMTP));
  assert.equal(conf.status, 'inactive');
  assert.equal(conf.passwordSaved, true);
  assert.equal(conf.password, undefined);
  // Mot de passe chiffre en base.
  const row = db.prepare('SELECT password_enc FROM library_mail WHERE library_id = ?').get(ctx.lib.id);
  assert.ok(row.password_enc && !row.password_enc.includes('secret-smtp'));

  assert.equal((await a.post(`/api/admin/libraries/${ctx.lib.id}/mail/test`, {})).status, 400); // admin sans adresse
  conf = ok(await a.post(`/api/admin/libraries/${ctx.lib.id}/mail/test`, { to: 'admin@exemple.org' }));
  assert.equal(conf.status, 'active');
  const m = outbox().pop();
  assert.equal(m.to, 'admin@exemple.org');
  assert.equal(m.replyTo, 'accueil@exemple.org');
  assert.equal(m.from.address, 'biblio@exemple.org');
  assert.equal(m.from.name, 'Test');
  assert.equal(ok(await g.get(`${api}/settings`)).mail.status, 'active');

  // Meme reglage renvoye sans mot de passe : inchange, reste operationnel.
  conf = ok(await a.put(`/api/admin/libraries/${ctx.lib.id}/mail`, { ...SMTP, password: '' }));
  assert.equal(conf.status, 'active');
  // Reglage modifie : a retester.
  conf = ok(await a.put(`/api/admin/libraries/${ctx.lib.id}/mail`, { ...SMTP, port: 587, security: 'starttls' }));
  assert.equal(conf.status, 'inactive');
  ok(await a.post(`/api/admin/libraries/${ctx.lib.id}/mail/test`, { to: 'admin@exemple.org' }));
});

test('adresse e-mail des comptes', async () => {
  const l = ctx.users.lecteur;
  assert.equal((await l.put('/api/me/email', { email: 'pas-une-adresse' })).status, 400);
  ok(await l.put('/api/me/email', { email: 'lecteur@exemple.org' }));
  assert.equal(ok(await l.get('/api/auth/status')).user.email, 'lecteur@exemple.org');
  assert.equal((await ctx.users.lecteur2.put('/api/me/email', { email: 'LECTEUR@exemple.org' })).status, 409);
  const u = ok(await a.put(`/api/admin/users/${ctx.users.lecteur2.id}`, { username: 'lecteur2', role: 'user', email: 'l2@exemple.org', libraries: [{ id: ctx.lib.id, role: 'user' }] }));
  assert.equal(u.email, 'l2@exemple.org');
});

test('mot de passe oublie : lien envoye par le SMTP de la bibliotheque', async () => {
  ok(await a.put('/api/admin/public-url', { url: 'https://exemple.org/mll/' }));
  const anon = client();
  const before0 = outbox().length;
  // Compte inconnu : meme reponse, rien d'envoye.
  ok(await anon.post('/api/auth/forgot', { login: 'personne', library: ctx.lib.slug }));
  ok(await anon.post('/api/auth/forgot', { login: 'lecteur', library: ctx.lib.slug }));
  const m = await nextMail(before0);
  assert.ok(m, 'message de reinitialisation attendu');
  assert.equal(outbox().length, before0 + 1);
  assert.equal(m.to, 'lecteur@exemple.org');
  const token = (m.text.match(/https:\/\/exemple\.org\/mll\/test\/#\/reset\/([a-f0-9]{64})/) || [])[1];
  assert.ok(token, m.text);

  assert.equal((await anon.post('/api/auth/reset', { token, password: 'court' })).status, 400);
  const r = ok(await anon.post('/api/auth/reset', { token, password: 'nouveau-mot-de-passe' }));
  assert.equal(r.user.username, 'lecteur');
  assert.equal(ok(await anon.get('/api/auth/status')).user.username, 'lecteur');
  // Jeton a usage unique ; anciennes sessions fermees ; nouveau mot de passe valable.
  assert.equal((await anon.post('/api/auth/reset', { token, password: 'encore-un-autre' })).status, 400);
  assert.equal(ok(await ctx.users.lecteur.get('/api/auth/status')).user, null);
  await login('lecteur', 'nouveau-mot-de-passe');

  // Sans bibliotheque : bibliotheque par defaut du compte (par l'adresse e-mail).
  const before1 = outbox().length;
  ok(await anon.post('/api/auth/forgot', { login: 'l2@exemple.org' }));
  const m2 = await nextMail(before1);
  assert.ok(m2 && m2.to === 'l2@exemple.org');

  // Lien cree par l'administrateur.
  assert.equal((await ctx.users.gestionnaire.post(`/api/admin/users/${ctx.users.lecteur2.id}/reset-link`)).status, 403);
  const link = ok(await a.post(`/api/admin/users/${ctx.users.lecteur2.id}/reset-link`));
  assert.equal(link.slug, ctx.lib.slug);
  ok(await client().post('/api/auth/reset', { token: link.token, password: PASSWORD }));
});

test('rappels : envoi manuel, serie, automatique et journal', async () => {
  const g = ctx.users.gestionnaire;
  ok(await g.put(`${api}/settings`, { reminders: { mode: 'auto', offset: 0 } }));
  const borrower = ok(await g.post(`${api}/borrowers`, { name: 'Camille Martin', email: 'camille@exemple.org' }));
  const noMail = ok(await g.post(`${api}/borrowers`, { name: 'Sans Adresse' }));
  const loanOf = async (title, borrowerId) => {
    const b = ok(await g.post(`${api}/books`, { title, copies: 1 }));
    return ok(await g.post(`${api}/loans`, { code: b.copies[0].code, borrowerId, dueAt: '2020-01-01' }));
  };
  const l1 = await loanOf('Premier livre', borrower.id);
  await loanOf('Deuxieme livre', noMail.id);
  assert.equal(ok(await g.get(`${api}/loans/summary`)).mail, 'active');

  // Bibliothecaire : envoi manuel d'un rappel.
  const n = outbox().length;
  ok(await ctx.users.bibliothecaire.post(`${api}/loans/send-reminder`, { borrowerId: borrower.id, ids: [l1.id] }));
  const m = outbox()[n];
  assert.equal(m.to, 'camille@exemple.org');
  assert.match(m.subject, /Test/);
  assert.match(m.text, /Premier livre/);
  const loans = ok(await g.get(`${api}/loans?status=open`));
  assert.equal(loans.find((l) => l.id === l1.id).reminderCount, 1);
  assert.equal((await g.post(`${api}/loans/send-reminder`, { borrowerId: noMail.id, ids: [loans.find((l) => l.borrower.id === noMail.id).id] })).status, 409);

  // Serie « a relancer » : Camille deja relancee, l'emprunteur sans adresse est signale.
  const all = ok(await g.post(`${api}/loans/send-reminders`));
  assert.equal(all.sent, 0);
  assert.deepEqual(all.skipped, ['Sans Adresse']);

  // Envoi automatique : seulement une fois active, une fois par jour.
  const l3 = await loanOf('Troisieme livre', borrower.id);
  assert.deepEqual(await runAutoReminders({ force: true }), []);
  ok(await g.put(`${api}/settings`, { reminders: { autoSend: true } }));
  assert.equal(ok(await g.get(`${api}/settings`)).reminders.autoSend, true);
  const done = await runAutoReminders({ force: true });
  assert.equal(done.length, 1);
  assert.equal(done[0].sent, 1);
  assert.match(outbox().pop().text, /Troisieme livre/);
  assert.deepEqual(await runAutoReminders({ now: new Date(2030, 0, 1, 10) }), [{ libraryId: ctx.lib.id, sent: 0, skipped: ['Sans Adresse'], failed: 0, remaining: 0, error: '' }]);
  assert.deepEqual(await runAutoReminders({ now: new Date(2030, 0, 1, 11) }), []); // deja passe ce jour-la
  assert.deepEqual(await runAutoReminders({ now: new Date(2030, 0, 2, 7) }), []); // trop tot
  assert.equal(ok(await g.get(`${api}/loans?status=open`)).find((l) => l.id === l3.id).reminderCount, 1);

  // Journal : gestionnaires seulement.
  const log = ok(await g.get(`${api}/mail-log`));
  assert.ok(log.some((e) => e.kind === 'reminder' && e.origin === 'auto' && e.ok));
  assert.ok(log.some((e) => e.kind === 'reset' && e.recipient === 'lecteur@exemple.org'));
  assert.equal((await ctx.users.bibliothecaire.get(`${api}/mail-log`)).status, 403);
});

test('echecs repetes : envoi en erreur, signale a l\'administrateur', async () => {
  const g = ctx.users.gestionnaire;
  db.prepare("UPDATE library_mail SET host = 'panne.invalid' WHERE library_id = ?").run(ctx.lib.id);
  const b = ok(await g.post(`${api}/books`, { title: 'Livre en panne', copies: 1 }));
  const loan = ok(await g.post(`${api}/loans`, { code: b.copies[0].code, borrowerName: 'Camille Martin', dueAt: '2020-01-01' }));
  for (let i = 0; i < 3; i++) {
    const r = await g.post(`${api}/loans/send-reminder`, { borrowerId: loan.borrower.id, ids: [loan.id] });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /ENOTFOUND/);
  }
  assert.equal(ok(await g.get(`${api}/settings`)).mail.status, 'error');
  assert.equal((await g.post(`${api}/loans/send-reminder`, { borrowerId: loan.borrower.id, ids: [loan.id] })).status, 409);
  assert.deepEqual(ok(await a.get('/api/auth/status')).mailErrors, ['Test']);
  assert.ok(ok(await g.get(`${api}/mail-log`)).some((e) => !e.ok && /ENOTFOUND/.test(e.error)));
  // Rien a reveler aux autres comptes.
  assert.deepEqual(ok(await g.get('/api/auth/status')).mailErrors, []);

  // Suppression du reglage : plus d'envoi, envoi automatique coupe.
  ok(await a.del(`/api/admin/libraries/${ctx.lib.id}/mail`));
  const s = ok(await g.get(`${api}/settings`));
  assert.equal(s.mail.status, 'inactive');
  assert.equal(s.reminders.autoSend, false);
});
