// Conversion epub -> kepub (format natif des Kobo, comme kepubify et Calibre) : dans
// chaque document du livre, le texte est decoupe en phrases entourees de
// <span class="koboSpan" id="kobo.<paragraphe>.<phrase>"> (reperes de lecture, de
// surlignage et de statistiques), les images aussi, et le corps entoure de
// <div id="book-columns"><div id="book-inner">. Le reste du livre est inchange. Un
// document deja converti (koboSpan) ou illisible est laisse tel quel.
const path = require('path');
const { readText } = require('./zip');

const MAX_DOC = 8 * 1024 * 1024;
// Balises dont le contenu n'est pas du texte a lire.
const SKIP = new Set(['head', 'script', 'style', 'title', 'svg', 'math', 'textarea', 'template', 'noscript']);
// Elements vides (jamais fermes, meme ecrits sans "/" dans un document HTML).
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Blocs : un nouveau paragraphe commence a chacun.
const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'blockquote', 'pre', 'td', 'th', 'caption',
  'figcaption', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'address', 'center', 'tr', 'ul', 'ol', 'dl', 'table', 'figure']);
// Balise (les ">" entre guillemets ne la terminent pas), commentaire, CDATA, instruction.
const TOKEN = /(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>)/;
// Phrase : jusqu'a une ponctuation finale (et guillemets / parentheses qui suivent).
const SENTENCE = /[^.!?…]+(?:[.!?…]+["'»”’)\]]*)?\s*|[.!?…]+["'»”’)\]]*\s*/g;

const tagName = (tag) => (/^<\/?([A-Za-z][\w:.-]*)/.exec(tag) || [])[1].toLowerCase().replace(/^.*:/, '');

function convertDocument(html) {
  if (html.includes('koboSpan')) return html;
  const parts = html.split(TOKEN);
  const stack = [];
  let skip = 0;
  let para = 0;
  let seg = 0;
  let newPara = true;
  let inBody = false;
  const span = (content) => {
    if (newPara || !para) { para++; seg = 0; newPara = false; }
    return `<span class="koboSpan" id="kobo.${para}.${++seg}">${content}</span>`;
  };
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i % 2 === 1) {
      // Balise (ou commentaire...).
      if (!/^<\/?[A-Za-z]/.test(part)) { out.push(part); continue; }
      const name = tagName(part);
      const closing = part.startsWith('</');
      const selfClosing = /\/\s*>$/.test(part) || VOID.has(name);
      if (closing) {
        const at = stack.lastIndexOf(name);
        if (at >= 0) {
          stack.splice(at).forEach((n) => { if (SKIP.has(n)) skip = Math.max(0, skip - 1); });
        }
        if (name === 'body' && inBody) { out.push('</div></div>'); inBody = false; }
        if (BLOCKS.has(name)) newPara = true;
        out.push(part);
        continue;
      }
      if (name === 'body') {
        out.push(part, '<div id="book-columns"><div id="book-inner">');
        inBody = true;
        if (!selfClosing) stack.push(name);
        continue;
      }
      if (name === 'head' && !selfClosing) {
        out.push(part, '<style type="text/css">div#book-inner { margin-top: 0; margin-bottom: 0; }</style>');
        stack.push(name);
        skip++;
        continue;
      }
      if (BLOCKS.has(name)) newPara = true;
      if (name === 'img' && !skip && inBody) { out.push(span(part)); continue; }
      out.push(part);
      if (!selfClosing) {
        stack.push(name);
        if (SKIP.has(name)) skip++;
      }
      continue;
    }
    // Texte.
    if (skip || !inBody || !part.trim()) { out.push(part); continue; }
    for (const m of part.match(SENTENCE) || []) {
      if (!m.trim()) { out.push(m); continue; }
      // Espaces de fin hors du span (comme kepubify).
      const body = m.replace(/\s+$/, '');
      out.push(span(body), m.slice(body.length));
    }
  }
  if (inBody) throw new Error('Corps du document non ferme');
  return out.join('');
}

// Convertit les documents (XHTML) du livre ouvert dans zip ; renvoie leur nombre.
async function kepubify(zip, opf, opfPath) {
  const dir = path.posix.dirname(opfPath);
  const items = [...opf.matchAll(/<(?:opf:)?item\b[^>]*>/g)].map((m) => m[0])
    .filter((t) => /\bmedia-type="application\/xhtml\+xml"/.test(t));
  let n = 0;
  for (const item of items) {
    let href = (/\bhref="([^"]*)"/.exec(item) || [])[1];
    if (!href) continue;
    try { href = decodeURIComponent(href); } catch (e) { /* nom deja decode */ }
    const file = zip.file(path.posix.join(dir, href).replace(/^\.\//, ''));
    if (!file) continue;
    try {
      const html = await readText(file, MAX_DOC);
      const converted = convertDocument(html);
      if (converted !== html) { zip.file(file.name, converted); n++; }
    } catch (e) { /* document atypique : laisse tel quel */ }
  }
  return n;
}

module.exports = { kepubify, convertDocument };
