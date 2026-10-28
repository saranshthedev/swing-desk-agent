import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdBlock, mdInline } from '../web/markdown.js';
import { pageToMarkdown } from '../web/export-md.js';

test('agent Markdown renders headings, lists, tables, quotes, code and links', () => {
  const html = mdBlock([
    '## Verdict', 'Looks **strong**, *for now*.', 'Second line.', '',
    '- one', '- two', '', '1. first', '2. second', '',
    '| Quarter | Sales ₹ cr |', '|---|---:|', '| Q1 | 1,200 |', '',
    '> careful', '', '```', 'a < b', '```', '', '---', '',
    'See [NSE](https://www.nseindia.com/a?x=1&y=2) or https://example.com/page.',
  ].join('\n'));
  assert.match(html, /<h5 class="md-h">Verdict<\/h5>/);
  assert.match(html, /<p>Looks <strong>strong<\/strong>, <em>for now<\/em>\.<br>Second line\.<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul><ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<table><thead><tr><th>Quarter<\/th><th>Sales ₹ cr<\/th><\/tr><\/thead><tbody><tr><td>Q1<\/td><td>1,200<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<blockquote><p>careful<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>a &lt; b<\/code><\/pre>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<a href="https:\/\/www\.nseindia\.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">NSE<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com\/page"[^>]*>https:\/\/example\.com\/page<\/a>\./);
});

test('plain text from older records looks the same', () => {
  assert.equal(mdBlock('Results were fine.\nGuidance raised.'), '<p>Results were fine.<br>Guidance raised.</p>');
  assert.equal(mdBlock(''), '');
  assert.equal(mdBlock(undefined), '');
});

test('agent text cannot inject HTML, scripts or unsafe links', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[x](data:text/html,<b>hi</b>)',
    '[x](https://ok.com" onmouseover="alert(1))',
    '**<b>bold</b>**',
    '| <i>a</i> |\n|---|\n| <svg onload=alert(1)> |',
    '```\n</code></pre><script>x</script>\n```',
    '`<script>`',
    '\u0001 0 \u0002 [a](https://x.com) \u00010\u0002',
  ];
  for (const a of attacks) {
    const html = mdBlock(a) + mdInline(a);
    assert.doesNotMatch(html, /<(script|img|svg|iframe|b|i)[\s>]/i, a);
    assert.doesNotMatch(html, /href="(?!https?:\/\/)/i, a);
    assert.doesNotMatch(html, /<[a-z][^>]*\son\w+\s*=/i, a);
  }
  // The quote stays inside the href value as an entity, so no attribute can start.
  assert.match(mdInline('[x](https://ok.com"onmouseover="alert(1))'), /href="https:\/\/ok\.com&quot;onmouseover=&quot;alert\(1/);
});

test('odd input never stalls and keeps every line', () => {
  const html = mdBlock('#nospace\n# \n>\n|\n-\n1.\n***\n``` \nunclosed');
  assert.match(html, /#nospace/);
  assert.match(html, /unclosed/);
});

// A tiny stand-in for the browser DOM: only what export-md.js reads.
const el = (tag, attrs = {}, ...kids) => ({
  nodeType: 1, tagName: tag.toUpperCase(), childNodes: kids.map((k) => (typeof k === 'string' ? { nodeType: 3, textContent: k } : k)),
  getAttribute: (n) => (n in attrs ? attrs[n] : null),
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); },
});

test('export turns the page into Markdown and leaves out controls', () => {
  const page = el('main', {},
    el('header', { class: 'page-head' }, el('div', {}, el('a', { class: 'back', href: '#/stocks' }, 'All stocks'), el('h1', {}, 'SAMPLE')),
      el('a', { class: 'btn', href: '#/prepare' }, 'Prepare'), el('a', { class: 'btn primary', href: '#/plan' }, 'New plan'),
      el('div', { class: 'export-tools' }, el('button', {}, 'Export as Markdown'))),
    el('section', { class: 'card folded' },
      el('h2', {}, el('button', { class: 'fold' }), 'Overview'),
      el('p', {}, 'Makes ', el('b', {}, 'cars'), '. ', el('span', { class: 'tag tag-ok' }, 'Verified'), ' ', el('a', { href: '#/stock/X' }, 'X'), ' ', el('a', { href: 'https://nse.in' }, 'NSE')),
      el('ul', {}, el('li', {}, el('div', {}, el('span', { class: 'tag tag-stage-research' }, 'Before trading day'), ' ', el('b', {}, 'Results read'), el('div', { class: 'small' }, 'From the filing'))), el('li', {}, 'Second')),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Q'), el('th', {}, 'Sales | ₹'))), el('tbody', {}, el('tr', {}, el('td', {}, 'Q1'), el('td', {}, '1,200'))))),
      el('details', {}, el('summary', { class: 'btn' }, 'Correct'), el('form', {}, el('textarea', {}, 'secret draft'))),
      el('details', {}, el('summary', {}, 'On trading day: 3 checks'), el('p', {}, 'Shown even when folded')),
      el('form', {}, el('label', {}, 'Approval PIN', el('input', { type: 'password' }))),
      el('p', { hidden: '' }, 'hidden text'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox' }), el('span', {}, 'Calm and not chasing')),
    ),
  );
  const md = pageToMarkdown(page, { at: '29 Oct, 10:00 am IST' });
  assert.equal(md, [
    '*Exported from Swing Desk on 29 Oct, 10:00 am IST*', '',
    '# SAMPLE', '',
    '## Overview', '',
    'Makes **cars**. [Verified] X [NSE](https://nse.in)', '',
    '- [Before trading day] **Results read**', '  From the filing',
    '- Second', '',
    '| Q | Sales \\| ₹ |', '| --- | --- |', '| Q1 | 1,200 |', '',
    '**On trading day: 3 checks**', '',
    'Shown even when folded', '',
    'Calm and not chasing', '',
  ].join('\n'));
});
