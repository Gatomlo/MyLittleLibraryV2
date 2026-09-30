// Telechargement d'une adresse fournie par un utilisateur (couverture d'un livre) :
// le serveur ne doit jamais servir de relais vers son propre reseau (localhost,
// adresses privees, autres outils de la passerelle), ni charger un fichier sans limite.
const dns = require('dns').promises;
const net = require('net');
const { httpError } = require('./util');

// Developpement local : MLL_ALLOW_LOCAL_FETCH=1 autorise localhost (reimport d'un
// export dont les couvertures pointent vers l'instance locale).
const allowLocal = () => process.env.MLL_ALLOW_LOCAL_FETCH === '1';

// MLL_OFFLINE=1 : aucune recherche en ligne (tests, serveur sans acces a Internet).
function assertOnline() {
  if (process.env.MLL_OFFLINE === '1') throw new Error('Recherche en ligne desactivee (MLL_OFFLINE).');
}

// Adresse IP non routable sur Internet (boucle locale, reseaux prives, lien local...).
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0))
      || (a === 198 && (b === 18 || b === 19));
  }
  const v = String(ip).toLowerCase();
  if (!net.isIPv6(v)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]);
  // Adresses globales : 2000::/3 seulement (hors documentation 2001:db8::/32).
  return !/^[23]/.test(v) || v.startsWith('2001:db8:');
}

async function assertPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw httpError(400, 'Adresse invalide.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw httpError(400, 'Adresse invalide.');
  if (allowLocal()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); } catch (e) { throw httpError(400, 'Adresse introuvable.'); }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw httpError(400, 'Adresse non autorisée.');
  return u;
}

// fetch limite aux adresses publiques ; chaque redirection est verifiee a son tour.
async function fetchPublic(url, { timeout = 10000, headers } = {}) {
  assertOnline();
  let current = String(url);
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(current);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('location');
    if (res.body) res.body.cancel().catch(() => {});
    if (!location) throw new Error('Redirection sans adresse.');
    current = new URL(location, u).href;
  }
  throw new Error('Trop de redirections.');
}

// Corps d'une reponse, refuse au-dela de maxBytes (sans tout charger en memoire).
async function readBody(res, maxBytes) {
  const tooBig = () => httpError(400, 'Fichier trop lourd.');
  if (Number(res.headers.get('content-length') || 0) > maxBytes) {
    if (res.body) res.body.cancel().catch(() => {});
    throw tooBig();
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw tooBig();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = { assertOnline, isPrivateAddress, assertPublicUrl, fetchPublic, readBody };
