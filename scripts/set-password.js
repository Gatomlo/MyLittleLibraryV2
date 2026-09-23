// Cree le compte ou change son mot de passe en ligne de commande :
//   npm run set-password -- <identifiant> <mot-de-passe>
const { db } = require('../lib/db');
const { hashPassword } = require('../lib/auth');

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('Usage : npm run set-password -- <identifiant> <mot-de-passe (8 caracteres min.)>');
  process.exit(1);
}
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Mot de passe de "${username}" mis a jour.`);
} else {
  // Compte cree depuis le serveur : administrateur (il pourra ensuite tout gerer).
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, hashPassword(password));
  console.log(`Compte administrateur "${username}" cree.`);
}
