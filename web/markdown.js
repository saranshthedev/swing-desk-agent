// Markdown for text written by agents (notes, reasons, summaries). Agent text is untrusted:
// everything is escaped first, then only a fixed set of elements is built. No raw HTML, no
// images, and links only to http(s) addresses.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// \u0001 and \u0002 mark placeholders while inline text is built; input never keeps them.
const clean = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0001\u0002]/g, '');

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"&])/g;

/** One line of Markdown → inline HTML: `code`, links, **bold**, *italic*. */
export function mdInline(text) {
  const parts = [];
  const keep = (html) => `\u0001${parts.push(html) - 1}\u0002`;
  let s = clean(text).split('`').map((seg, i, all) => (i % 2 && i < all.length - 1 ? keep(`<code>${esc(seg)}</code>`) : esc(seg))).join('');
  s = s.replace(LINK, (m, label, href, bare) => {
    const url = href ?? bare;
    if (!/^https?:\/\//i.test(url.replace(/&amp;/g, '&'))) return m;
    return keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label ?? url}</a>`);
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  return s.replace(/\u0001(\d+)\u0002/g, (_, n) => parts[n]);
}

const ITEM = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const SPLIT = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** A block of Markdown → HTML: headings, paragraphs, lists, tables, quotes, code and rules. */
export function mdBlock(text) {
  const lines = clean(text).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${Math.min(h[1].length + 3, 6)} class="md-h">${mdInline(h[2].replace(/\s#+\s*$/, ''))}</h${Math.min(h[1].length + 3, 6)}>`); i++; continue; }
    if (RULE.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdBlock(quote.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && SPLIT.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${mdInline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items = [];
      for (; i < lines.length; i++) {
        const m = lines[i].match(ITEM);
        if (m) items.push(m[2]);
        else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${mdInline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>)/.test(lines[i]) && !ITEM.test(lines[i]) && !RULE.test(lines[i]) && !(lines[i].includes('|') && SPLIT.test(lines[i + 1] ?? '')); i++) para.push(mdInline(lines[i].trim()));
    if (!para.length) para.push(mdInline(lines[i++].trim())); // never stall on a line no rule takes
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return out.join('');
}
