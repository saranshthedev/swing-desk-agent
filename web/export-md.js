// Export what is on the page as Markdown. Reads the page's own markup, so every page gets it
// without a second layout. Buttons, form fields, the menu and help tips are left out; folded
// sections are included. Uses only nodeType, tagName, childNodes, textContent and
// getAttribute, so tests can pass plain objects instead of a browser DOM.

const SKIP_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM', 'SCRIPT', 'STYLE', 'SVG', 'NAV', 'IFRAME', 'TEMPLATE', 'NOSCRIPT']);
// .btn covers links styled as buttons (“Prepare”, “New plan”); .back covers “Back to …” links.
const SKIP_CLASSES = ['md-skip', 'fold', 'info', 'tip', 'banner', 'export-tools', 'btn', 'back'];
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'FIGURE', 'FIELDSET', 'DL', 'DT', 'DD']);

const classes = (el) => (el.getAttribute?.('class') ?? '').split(/\s+/);
const tagOf = (el) => String(el.tagName ?? '').toUpperCase();

function skipped(el) {
  if (SKIP_TAGS.has(tagOf(el))) return true;
  if (el.getAttribute?.('hidden') != null || el.getAttribute?.('aria-hidden') === 'true') return true;
  const cls = classes(el);
  if (SKIP_CLASSES.some((c) => cls.includes(c))) return true;
  // An action disclosure (“Verify…”, “Correct”, “Delete forever”) is a form, not content.
  if (tagOf(el) === 'DETAILS') {
    const summary = [...el.childNodes].find((n) => tagOf(n) === 'SUMMARY');
    if (summary && classes(summary).includes('btn')) return true;
  }
  return false;
}

const squash = (s) => s.replace(/\s+/g, ' ');

/** Inline text of a node: links, bold, italic, code and status chips. */
function inline(node) {
  if (node.nodeType === 3) return squash(node.textContent ?? '');
  if (node.nodeType !== 1 || skipped(node)) return '';
  const tag = tagOf(node);
  if (tag === 'BR') return '\n';
  const inner = () => [...node.childNodes].map(inline).join('');
  if (tag === 'A') {
    const text = inner().trim();
    const href = node.getAttribute('href') ?? '';
    return /^https?:\/\//i.test(href) && text ? `[${text}](${href})` : text;
  }
  if (tag === 'STRONG' || tag === 'B') return wrap('**', inner());
  if (tag === 'EM' || tag === 'I') return wrap('*', inner());
  if (tag === 'CODE') return wrap('`', node.textContent ?? '');
  if (tag === 'SPAN' && classes(node).includes('tag')) return `[${inner().trim()}]`;
  return inner();
}
function wrap(mark, text) {
  const t = text.trim();
  if (!t) return text;
  const lead = text.match(/^\s*/)[0] ? ' ' : '';
  const tail = text.match(/\s*$/)[0] ? ' ' : '';
  return `${lead}${mark}${t}${mark}${tail}`;
}

const cell = (el) => inline(el).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

function table(el) {
  const rows = [];
  const walk = (n) => {
    for (const c of n.childNodes ?? []) {
      if (c.nodeType !== 1 || skipped(c)) continue;
      if (tagOf(c) === 'TR') rows.push([...c.childNodes].filter((d) => ['TH', 'TD'].includes(tagOf(d))).map(cell));
      else walk(c);
    }
  };
  walk(el);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

function list(el, ordered) {
  let n = 0;
  return [...el.childNodes].filter((c) => c.nodeType === 1 && tagOf(c) === 'LI' && !skipped(c)).map((li) => {
    const body = blocks(li).trim();
    if (!body) return '';
    const mark = ordered ? `${++n}.` : '-';
    return `${mark} ${body.split('\n').filter((l) => l.trim()).join(`\n${' '.repeat(mark.length + 1)}`)}`;
  }).filter(Boolean).join('\n');
}

/** Block Markdown for a node's children, paragraphs separated by blank lines. */
function blocks(node) {
  const out = [];
  let para = '';
  const flush = () => {
    const t = para.split('\n').map((l) => l.trim()).filter(Boolean).join('  \n');
    if (t) out.push(t);
    para = '';
  };
  for (const c of node.childNodes ?? []) {
    if (c.nodeType === 3) { para += inline(c); continue; }
    if (c.nodeType !== 1 || skipped(c)) continue;
    const tag = tagOf(c);
    const h = tag.match(/^H([1-6])$/);
    if (h) { flush(); const t = inline(c).trim(); if (t) out.push(`${'#'.repeat(Number(h[1]))} ${t}`); continue; }
    if (tag === 'UL' || tag === 'OL') { flush(); const t = list(c, tag === 'OL'); if (t) out.push(t); continue; }
    if (tag === 'TABLE') { flush(); const t = table(c); if (t) out.push(t); continue; }
    if (tag === 'PRE') { flush(); out.push(`\`\`\`\n${(c.textContent ?? '').replace(/\n+$/, '')}\n\`\`\``); continue; }
    if (tag === 'HR') { flush(); out.push('---'); continue; }
    if (tag === 'BLOCKQUOTE') { flush(); const t = blocks(c).trim(); if (t) out.push(t.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')); continue; }
    if (tag === 'SUMMARY') { flush(); const t = inline(c).trim(); if (t) out.push(`**${t}**`); continue; }
    if (tag === 'DETAILS' || tag === 'LI' || BLOCK_TAGS.has(tag)) { flush(); const t = blocks(c).trim(); if (t) out.push(t); continue; }
    para += inline(c);
  }
  flush();
  return out.join('\n\n');
}

/** The page under `root` as Markdown, with a one-line header saying where and when. */
export function pageToMarkdown(root, { title = 'Swing Desk', at = '' } = {}) {
  const body = blocks(root).replace(/\n{3,}/g, '\n\n').trim();
  return `${`*Exported from ${title}${at ? ` on ${at}` : ''}*`}\n\n${body}\n`;
}
