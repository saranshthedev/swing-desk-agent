// Swing Desk Agent – owner web app. Plain ES module, no build step, no dependencies.

import { INFO, INFO_IN } from './info.js';
import { checklistHtml, libraryHtml, strategyItemsHtml, toStrategyItem, groupName } from './checklist-ui.js';

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
let csrf = '';
let S = null; // latest /api/state
let ledgerCache = null;
const drafts = {}; // unsaved editor state (strategies, playbooks)

// ---------- formatting ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => {
  const r = Math.round(n);
  return (r < 0 ? '−' : '') + '₹' + Math.abs(r).toLocaleString('en-IN');
};
const price = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const actorName = (actor) => {
  if (actor === 'owner') return 'You';
  if (actor === 'system') return 'Scheduler';
  const name = S?.agentNames?.[actor.replace(/^agent:/, '')];
  return name ? `${name} (agent)` : actor;
};
/** A stock symbol that opens its stock page. */
const symLink = (sym) => (sym ? `<a class="sym" href="#/stock/${esc(encodeURIComponent(sym))}">${esc(sym)}</a>` : '');
const byLine = (actor) => (actor === 'owner' ? 'You' : `${esc(actorName(actor))} · <span class="tag tag-warn">not verified</span>`);
const STATUS_TAG = { pass: 'tag-ok', fail: 'tag-bad', stale: 'tag-warn', ask: 'tag-ask', info: 'tag-muted', wait: 'tag-warn', missing: 'tag-ask', expired: 'tag-warn', broken: 'tag-bad' };
const STATUS_TEXT = { pass: 'Pass', fail: 'Fail', stale: 'Needs update', ask: 'Your answer', info: 'Note', wait: 'Wait', missing: 'Not prepared', expired: 'Expired', broken: 'Prepare again' };
const SCOPE_HELP = {
  off: 'Sees nothing. New agents start here.',
  read: 'Reads your plans, limits and lots; runs calculators; picks up its playbook tasks.',
  draft: 'Read, plus writes research notes and evidence (marked not verified).',
  propose: 'Draft, plus sends buy, exit and settings requests to you for approval.',
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// MTF funding: brokers quote leverage (2×) or own cash % (50%); same thing, own cash % = 100 ÷ leverage.
const trim = (n) => String(Number(Number(n).toFixed(2)));
const lev = (marginPct) => `${trim(100 / marginPct)}×`;
const funding = (marginPct) => `${lev(marginPct)} (${trim(marginPct)}% own cash)`;
function fundingMode() {
  try { return localStorage.getItem('fundingMode') === 'cash' ? 'cash' : 'leverage'; } catch { return 'leverage'; }
}
/** A mode switch and one number box. The hint shows the other form as you type. */
function fundingFields(label, mode, value) {
  return `<div class="funding" data-funding data-label="${esc(label)}">
    ${field(label, `<select name="fundingMode">${options([['leverage', 'Leverage (×)'], ['cash', 'Own cash %']], mode)}</select>`)}
    ${field(mode === 'cash' ? 'Own cash %' : 'Leverage ×', num('fundingValue', value ?? '', 'min="1" max="100"'), `<span class="funding-hint">${fundingHint(mode, value)}</span>`)}
  </div>`;
}
function fundingHint(mode, value) {
  const v = Number(value);
  if (!value || !Number.isFinite(v) || v <= 0) return 'Example: 2× leverage = 50% own cash: you pay half, Zerodha lends half.';
  const pct = mode === 'cash' ? v : 100 / v;
  return pct > 100 || pct <= 0 ? 'Leverage must be at least 1× (own cash at most 100%).' : `= ${funding(pct)}. You pay ${trim(pct)}% and borrow ${trim(100 - pct)}%.`;
}
/** Turn the switch + number into what the API takes. */
const fundingInput = (data) => (data.fundingMode === 'cash' ? { marginPct: data.fundingValue } : { leverage: data.fundingValue });

// ---------- server ----------

async function api(path, init = {}) {
  let res;
  try {
    res = await fetch(path, { ...init, headers: { 'X-CSRF': csrf, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  } catch {
    // The browser only says "Failed to fetch" when the desk is not running.
    throw new Error('Swing Desk is not running. Double-click Swing Desk on your Desktop (or start.cmd), then reload this page.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

async function act(name, data) {
  const out = await api(`/api/action/${name}`, { method: 'POST', body: JSON.stringify(data) });
  await refresh();
  return out.result;
}

async function refresh() {
  S = await api('/api/state');
  // An older server (not restarted after an update) does not send these; pages still open and show the restart banner.
  S.trash ??= [];
  S.agentNames ??= Object.fromEntries(S.agents.map((a) => [a.id, a.name]));
  S.recommendations ??= [];
  ledgerCache = null;
  for (const c of Object.values(prepCache)) c.stale = true;
}

function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast show ${bad ? 'bad' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 5000);
}

// ---------- forms ----------

/** Read a form: inputs with data-num become numbers (blank → undefined), checkboxes booleans. */
function read(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.dataset.num !== undefined) out[el.name] = el.value === '' ? undefined : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

let fieldSeq = 0;
/** A labelled control. Its “i” help button is added by addInfoButtons() from the control’s name. */
const field = (label, input, hint = '') => {
  const id = `f${++fieldSeq}`;
  const control = input.replace(/<(input|select|textarea)\b/, `<$1 id="${id}"`);
  return `<div class="field"><div class="field-label"><label for="${id}">${label}</label></div>${control}${hint ? `<small>${hint}</small>` : ''}</div>`;
};

/**
 * Add an “i” button to every field (and every element with data-info) that has help text.
 * Help comes from INFO_IN[form][name], else INFO[name]. Click, tap or Enter opens it; Escape closes.
 */
function addInfoButtons(root) {
  const targets = [
    ...[...root.querySelectorAll('.field')].map((f) => {
      const control = f.querySelector('input, select, textarea');
      return { host: f.querySelector('.field-label'), after: null, key: control?.name || control?.dataset.item, form: control?.closest('form')?.dataset.form, label: f.querySelector('label')?.textContent };
    }),
    ...[...root.querySelectorAll('[data-info]')].map((el) => {
      const head = el.querySelector('legend, h2, h3') ?? el;
      return { host: head, after: head, key: el.dataset.info, form: el.closest('form')?.dataset.form, label: head.textContent };
    }),
  ];
  for (const t of targets) {
    const text = (t.form && INFO_IN[t.form]?.[t.key]) ?? INFO[t.key];
    if (!t.host || !text || t.host.querySelector('.info')) continue;
    const tipId = `tip-${++fieldSeq}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'info';
    button.textContent = 'i';
    button.setAttribute('aria-label', `What is “${(t.label || t.key).trim()}”?`);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', tipId);
    const tip = document.createElement('p');
    tip.className = 'tip';
    tip.id = tipId;
    tip.hidden = true;
    tip.textContent = text;
    t.host.append(button);
    (t.after ?? button).after(tip);
  }
}

function toggleInfo(button, open = button.getAttribute('aria-expanded') !== 'true') {
  button.setAttribute('aria-expanded', String(open));
  if (!open) delete button.dataset.hover;
  document.getElementById(button.getAttribute('aria-controls')).hidden = !open;
}

// Hovering an “i” shows its help; clicking pins it open (or closes it). Touch taps pin directly.
let infoHoverClose;
const closeHoverInfo = (except) => {
  for (const b of document.querySelectorAll('button.info[data-hover]')) if (b !== except) { delete b.dataset.hover; toggleInfo(b, false); }
};
document.addEventListener('mouseover', (e) => {
  const button = e.target.closest?.('button.info');
  if (button) {
    clearTimeout(infoHoverClose);
    closeHoverInfo(button);
    if (button.getAttribute('aria-expanded') !== 'true') { button.dataset.hover = '1'; toggleInfo(button, true); }
  } else if (e.target.closest?.('.tip')) clearTimeout(infoHoverClose);
});
document.addEventListener('mouseout', (e) => {
  const from = e.target.closest?.('button.info, .tip');
  if (!from || from.contains(e.relatedTarget)) return;
  const button = from.matches('.tip') ? document.querySelector(`button.info[aria-controls="${from.id}"]`) : from;
  if (!button?.dataset.hover) return;
  clearTimeout(infoHoverClose);
  infoHoverClose = setTimeout(() => closeHoverInfo(), 150);
});
document.addEventListener('click', (e) => {
  const button = e.target.closest('button.info');
  if (button?.dataset.hover) { delete button.dataset.hover; return; }
  if (button) { toggleInfo(button); return; }
  if (!e.target.closest('.tip')) for (const b of document.querySelectorAll('button.info[aria-expanded="true"]')) { delete b.dataset.hover; toggleInfo(b, false); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const b of document.querySelectorAll('button.info[aria-expanded="true"]')) toggleInfo(b, false);
});
const num = (name, value = '', attrs = '') => `<input name="${name}" type="number" step="any" inputmode="decimal" data-num value="${esc(value)}" ${attrs}>`;
const pinField = () => field('Approval PIN', '<input name="pin" type="password" inputmode="numeric" autocomplete="off" required minlength="6" maxlength="12">');
const options = (list, selected) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(l)}</option>`).join('');
const tag = (status) => `<span class="tag ${STATUS_TAG[status] || 'tag-muted'}">${STATUS_TEXT[status] || esc(status)}</span>`;

// ---------- trash, paging, folding ----------

const KIND_LABEL = { evidence: 'Evidence', note: 'Note', request: 'Request', lot: 'Closed lot', strategy: 'Strategy', playbook: 'Playbook', agent: 'Agent', task: 'Playbook job' };
const TRASH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9zm4 2v8h1.5v-8H10zm3.5 0v8H15v-8h-1.5z"/></svg>';
/** Small icon that moves an item to the Trash (it can be restored from there). */
const trashBtn = (kind, id, what) => `<button type="button" class="icon-btn" data-action="trash" data-kind="${kind}" data-id="${esc(id)}" aria-label="Move ${esc(what)} to the Trash" title="Move to the Trash">${TRASH_ICON}</button>`;
const FINISHED = new Set(['filled', 'rejected', 'withdrawn', 'expired']);

const pageAt = {}; // list key → page shown (1 = first)
/** One page of a long list plus Previous / Next buttons. */
function paged(key, list, size = 10) {
  const total = Math.max(1, Math.ceil(list.length / size));
  const at = Math.min(Math.max(1, pageAt[key] ?? 1), total);
  const btn = (to, label, off) => `<button type="button" class="btn" data-action="page" data-key="${esc(key)}" data-to="${to}" ${off ? 'disabled' : ''}>${label}</button>`;
  const nav = total > 1 ? `<nav class="pager" data-key="${esc(key)}" aria-label="Pages">${btn(at - 1, '‹ Previous', at === 1)}<span class="small muted">Page ${at} of ${total} · ${list.length} in all</span>${btn(at + 1, 'Next ›', at === total)}</nav>` : '';
  return { items: list.slice((at - 1) * size, at * size), nav };
}

// Every card with a heading can be folded to its heading. The choice is remembered per page.
const FOLDED_AT_FIRST = new Set(['strategies', 'playbooks', 'settings']);
const folds = {};
function isFolded(key, byDefault) {
  if (key in folds) return folds[key];
  try {
    const v = localStorage.getItem(`fold:${key}`);
    if (v !== null) return v === '1';
  } catch { /* preference only */ }
  return byDefault;
}
function setFold(card, folded) {
  const button = card.querySelector('.fold');
  folds[button.dataset.foldKey] = folded;
  try { localStorage.setItem(`fold:${button.dataset.foldKey}`, folded ? '1' : '0'); } catch { /* preference only */ }
  card.classList.toggle('folded', folded);
  button.setAttribute('aria-expanded', String(!folded));
}
function addFolds(root, route, byDefault) {
  for (const card of root.querySelectorAll('.card:not(details):not(.highlight)')) {
    const first = card.firstElementChild;
    const heading = first?.matches('h2') ? first : first?.matches('.card-head') ? first.querySelector('h2, h3') : null;
    if (!heading || heading.querySelector('.fold')) continue;
    const key = `${route}|${card.dataset.fold ?? heading.textContent.trim()}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fold';
    button.dataset.foldKey = key;
    button.setAttribute('aria-label', 'Show or hide this section');
    heading.prepend(button);
    heading.classList.add('fold-head');
    const folded = isFolded(key, byDefault || card.hasAttribute('data-start-folded'));
    card.classList.toggle('folded', folded);
    button.setAttribute('aria-expanded', String(!folded));
  }
}
document.addEventListener('click', (e) => {
  const head = e.target.closest('.fold-head');
  if (!head || (e.target.closest('a, button, input, select, textarea') && !e.target.closest('.fold'))) return;
  const card = head.closest('.card');
  setFold(card, !card.classList.contains('folded'));
});

function trashRow(t) {
  return `<li><div><b>${esc(t.label)}</b> <span class="tag tag-muted">${KIND_LABEL[t.kind] ?? esc(t.kind)}</span><div class="small muted">Moved here ${when(t.at)}</div></div>
    <div class="row-tools"><button type="button" class="btn" data-action="restore" data-kind="${t.kind}" data-id="${esc(t.id)}">Restore</button>
      <details class="purge"><summary class="btn danger">Delete forever</summary><form class="form" data-form="trash-purge" data-kind="${t.kind}" data-id="${esc(t.id)}">
        <p class="small">It can no longer be restored. The ledger keeps a line saying something was deleted, without its contents.</p>${pinField()}<button class="btn danger">Delete forever</button></form></details></div></li>`;
}

// ---------- pages ----------

const pages = {
  today() {
    const p = S.status.portfolio;
    const st = S.status.settings;
    const pending = S.intents.filter((i) => i.status === 'pending');
    const approved = S.intents.filter((i) => i.status === 'approved');
    const open = S.lots.filter((l) => l.status === 'open');
    const nextRuns = S.playbooks.filter((pb) => pb.enabled).map((pb) => `<li><span>${esc(pb.name)}</span><span class="mono">${esc(scheduleText(pb.schedule))}</span></li>`).join('');
    return `
      <header class="page-head"><div><p class="muted">${esc(S.status.today)} · India date</p><h1>Today</h1></div>
        <div class="actions"><a class="btn" href="#/prepare">Prepare</a><a class="btn primary" href="#/plan">New plan</a></div></header>
      <section class="tiles">
        ${tile('Loss if every stop is hit', `${money(p.openRisk)} / ${money(p.openRiskLimit)}`, p.openRisk, p.openRiskLimit, 'Your total open risk right now')}
        ${tile('Open lots', `${p.openLots} / ${st.maxOpenLots}`, p.openLots, st.maxOpenLots, p.openSymbols === 1 ? 'In 1 stock' : `In ${p.openSymbols} different stocks`)}
        ${tile('Borrowed (MTF)', `${money(p.borrowed)} / ${money(p.borrowedLimit)}`, p.borrowed, p.borrowedLimit, 'Borrowed money is exposure, not extra risk money')}
        ${tile('This week', money(p.weekPnl), Math.max(0, -p.weekPnl), p.weekLossLimit, p.buysPaused ? 'New buys are paused for this week' : `New buys pause at −${money(p.weekLossLimit)}`)}
      </section>
      <div class="cols">
        <div class="col-main">
          <section class="card"><div class="card-head"><h2>Needs you</h2><a href="#/requests">All requests</a></div>
            ${pending.length || approved.length ? `<ul class="rows">${[...pending, ...approved].map(requestRow).join('')}</ul>` : '<p class="muted">Nothing waiting. Agents’ requests appear here.</p>'}
          </section>
          <section class="card"><div class="card-head"><h2>Open lots</h2><a href="#/positions">Positions</a></div>${lotsTable(open)}</section>
          ${newFromClaude()}
        </div>
        <div class="col-side">
          <form class="card form" data-form="stock-pick"><h2>Open a stock</h2><p class="small muted">Its prices, records, notes and requests, and where to save a broker price.</p>
            ${field('Stock', '<input name="symbol" required autocapitalize="characters" placeholder="TATAMOTORS">')}<button class="btn primary">Open stock</button></form>
          <section class="card"><h2>Recent activity</h2><p class="muted small">Every change is in the ledger with who made it.</p><ul class="rows" id="activity"><li class="muted">Loading…</li></ul></section>
          <section class="card"><div class="card-head"><h2>Playbooks</h2><a href="#/playbooks">Edit</a></div>${nextRuns ? `<ul class="rows kv">${nextRuns}</ul>` : '<p class="muted">No playbooks yet.</p>'}</section>
        </div>
      </div>`;
  },

  requests() {
    const groups = ['pending', 'approved', 'filled', 'rejected', 'expired', 'withdrawn'];
    return `<header class="page-head"><h1>Requests</h1></header>
      <p class="lead">Agents (and you) send requests. The desk checks them with fixed rules. Only you approve, with your PIN. Approving never places an order: it gives you an order ticket for Kite.</p>
      ${groups.map((g) => {
        const list = S.intents.filter((i) => i.status === g);
        const p = paged(`requests-${g}`, list);
        return list.length ? `<section class="card"><h2>${g[0].toUpperCase() + g.slice(1)} <span class="small muted">${list.length}</span></h2><ul class="rows">${p.items.map((i) => requestRow(i)).join('')}</ul>${p.nav}</section>` : '';
      }).join('') || '<p class="muted">No requests yet.</p>'}`;
  },

  request(id) {
    const i = S.intents.find((x) => x.id === id);
    if (!i) return '<p>That request was not found.</p>';
    const title = i.kind === 'buy' ? `Buy ${i.symbol}` : i.kind === 'exit' ? `Sell ${i.symbol}` : 'Change risk settings';
    const head = `<header class="page-head"><div><a href="#/requests">Back to requests</a><h1>${i.symbol ? esc(title).replace(esc(i.symbol), symLink(i.symbol)) : esc(title)} <span class="tag tag-muted">${esc(i.status)}</span></h1>
      <p class="muted">From ${byLine(i.by)} · ${when(i.at)}${i.status === 'pending' ? ` · expires ${when(i.expiresAt)}` : ''}${i.strategyName ? ` · strategy: ${esc(i.strategyName)}` : ''}</p></div>${FINISHED.has(i.status) ? trashBtn('request', i.id, 'this request') : ''}</header>`;
    const thesis = `<section class="card"><h2>Reason given</h2>${i.by === 'owner' ? '' : '<p class="small"><span class="tag tag-warn">Written by a model · not verified</span></p>'}<blockquote>${esc(i.thesis)}</blockquote>${evidenceFor(i)}</section>`;
    const chart = i.symbol ? tvChart(i.symbol, i.plan?.exchange) : '';
    if (i.status === 'pending') return head + pendingRequest(i) + thesis + chart;
    return head + decidedRequest(i) + thesis + chart;
  },

  plan(symbol) {
    const strategies = S.strategies.filter((s) => s.enabled);
    const first = strategies[0]?.id;
    const pd = S.meta.presets.plan[first] ?? S.meta.presets.plan.default;
    const lev2 = pd.leverage ?? 2;
    const d = { ...(drafts.plan ?? { exchange: 'NSE', buyType: pd.buyType, fundingMode: fundingMode(), fundingValue: fundingMode() === 'cash' ? trim(100 / lev2) : lev2, days: pd.days, strategyId: first }), ...(symbol ? { symbol: symbol.toUpperCase() } : {}) };
    return `<header class="page-head"><h1>New plan</h1></header>
      <p class="lead">Your own plan goes through the same checks as an agent’s. Leave shares blank and the desk sizes it from your limits.</p>
      <form class="card form" data-form="plan">
        <div class="grid">
          ${field('Stock symbol', `<input name="symbol" required value="${esc(d.symbol ?? '')}" autocapitalize="characters">`)}
          ${field('Strategy', `<select name="strategyId">${options(strategies.map((s) => [s.id, s.name]), d.strategyId)}</select>`)}
          ${field('Exchange', `<select name="exchange">${options([['NSE', 'NSE'], ['BSE', 'BSE']], d.exchange)}</select>`)}
          ${field('Buy type', `<select name="buyType">${options([['mtf', 'MTF (borrow from Zerodha)'], ['regular', 'Regular / CNC (own cash only)']], d.buyType)}</select>`)}
          ${fundingFields('MTF funding entered as', d.fundingMode, d.fundingValue)}
          ${field('Entry (limit) ₹', num('entry', d.entry, 'required'))}
          ${field('Stop ₹', num('stop', d.stop, 'required'))}
          ${field('Target ₹', num('target', d.target, 'required'))}
          ${field('Max hold (calendar days)', num('days', d.days, 'required min="1" max="60" step="1"'))}
          ${field('Shares (optional)', num('qty', d.qty, 'min="1" step="1"'))}
        </div>
        ${field('Why this trade', `<textarea name="thesis" rows="3" required>${esc(d.thesis ?? '')}</textarea>`)}
        <div class="actions"><button type="submit" name="intent" value="preview" class="btn">Preview size and charges</button><button type="submit" name="intent" value="submit" class="btn primary">Send to Requests</button></div>
        <div id="preview">${drafts.planPreview ?? ''}</div>
      </form>`;
  },

  positions() {
    const open = S.lots.filter((l) => l.status === 'open');
    const closed = S.lots.filter((l) => l.status === 'closed');
    return `<header class="page-head"><h1>Positions</h1></header>
      <p class="lead">Each buy fill is its own lot with its own price and date. Selling part of a lot keeps the rest open at the same buy price.</p>
      <section class="card"><h2>Open lots</h2>${open.length ? open.map(lotCard).join('') : '<p class="muted">No open lots.</p>'}</section>
      <section class="card"><h2>Closed lots</h2>${closed.length ? (({ items, nav }) => lotsTable(items, true) + nav)(paged('lots-closed', closed)) : '<p class="muted">None yet.</p>'}</section>`;
  },

  stocks() {
    const list = stockIndex();
    const p = paged('stocks', list, 15);
    return `<header class="page-head"><h1>Stocks</h1></header>
      <p class="lead">Every stock you or an agent has worked on. Open one to see its requests, lots, prices, evidence and notes in one place, and to act on it. Any stock symbol in the app opens its page too.</p>
      <form class="card form inline" data-form="stock-pick">${field('Stock', '<input name="symbol" required autocapitalize="characters" placeholder="TATAMOTORS">')}<button class="btn primary">Open stock</button></form>
      <section class="card"><h2>Your stocks <span class="small muted">${list.length}</span></h2>${list.length ? `<ul class="rows">${p.items.map(stockRow).join('')}</ul>${p.nav}` : '<p class="muted">None yet. Type a stock above to start.</p>'}</section>`;
  },

  stock(symbol = '') {
    const sym = symbol.toUpperCase().replace(/[^A-Z0-9&._-]/g, '');
    if (!sym) return pages.stocks();
    const market = sym === S.meta.checklist.market;
    const intents = S.intents.filter((i) => i.symbol === sym);
    const open = S.lots.filter((l) => l.symbol === sym && l.status === 'open');
    const closed = S.lots.filter((l) => l.symbol === sym && l.status === 'closed');
    const exchange = open[0]?.exchange ?? 'NSE';
    // The full list for this stock comes with prepare.status; S.evidence is only the newest 200 of all stocks.
    const full = prepData(sym, exchange)?.records;
    const evidence = (full ?? S.evidence).filter((e) => e.symbol === sym);
    const notes = S.notes.filter((n) => n.symbol === sym);
    const quote = evidence.find((e) => e.kind === 'quote' && e.status === 'verified') ?? evidence.find((e) => e.kind === 'quote');
    const rq = paged(`stock-requests-${sym}`, intents);
    const ev = paged(`stock-evidence-${sym}`, evidence);
    const nt = paged(`stock-notes-${sym}`, notes, 5);
    const kinds = Object.entries(S.meta.evidenceKinds).filter(([k]) => !['quote', 'funding'].includes(k));
    return `<header class="page-head"><div><a href="#/stocks">All stocks</a><h1>${esc(sym)}</h1>
        <p class="muted">${market ? 'Whole-market records count for every stock.' : quote ? `Last broker price ${price(quote.price)}${quote.exchange ? ` on ${esc(quote.exchange)}` : ''} · ${byLine(quote.by)} · ${when(quote.observedAt)}` : 'No broker price saved yet.'}</p></div>
        ${market ? '' : `<div class="actions"><a class="btn" href="#/prepare/${esc(encodeURIComponent(sym))}/${exchange}">Prepare</a><a class="btn primary" href="#/plan/${esc(encodeURIComponent(sym))}">New plan</a></div>`}</header>
      ${newerMarker()}
      <div class="cols">
        <div class="col-main">
          ${market ? '' : recSummary(sym, exchange)}
          ${open.length ? `<section class="card"><h2>Open lots <span class="small muted">${open.length}</span></h2>${open.map(lotCard).join('')}</section>` : ''}
          ${market ? '' : `<section class="card"><h2>Requests <span class="small muted">${intents.length}</span></h2>${intents.length ? `<ul class="rows">${rq.items.map((i) => requestRow(i)).join('')}</ul>${rq.nav}` : '<p class="muted">No requests for this stock.</p>'}</section>`}
          <section class="card" data-info="records"><h2>Records <span class="small muted">${evidence.length}</span></h2>
            <p class="small muted">Only records you entered or verified count, and only until their good-until date. A correction keeps the old record, marked corrected.</p>
            ${full ? '' : '<p class="small muted">Loading the full list…</p>'}
            ${evidence.length ? `<ul class="rows">${ev.items.map((e) => evidenceRow(e, true)).join('')}</ul>${ev.nav}` : '<p class="muted">None yet. Save some with the forms on this page, on Prepare, or ask Claude.</p>'}</section>
          <section class="card"><h2>Notes <span class="small muted">${notes.length}</span></h2>${notes.length ? nt.items.map(noteHtml).join('') + nt.nav : '<p class="muted">No notes yet.</p>'}</section>
          ${closed.length ? `<section class="card"><h2>Closed lots <span class="small muted">${closed.length}</span></h2>${lotsTable(closed, true)}</section>` : ''}
          ${market ? '' : tvChart(sym, exchange)}
        </div>
        <div class="col-side">
          ${market ? '' : `<form class="card form" data-form="quote" data-symbol="${esc(sym)}" data-start-folded><h2>Broker price</h2><p class="small muted">Copy the price from Kite now. It counts for 5 minutes.</p>
            ${field('Exchange', `<select name="exchange">${options([['NSE', 'NSE'], ['BSE', 'BSE']], exchange)}</select>`)}
            ${field('Price ₹', num('price', '', 'required'))}<button class="btn primary">Save price</button></form>
          <form class="card form" data-form="funding" data-symbol="${esc(sym)}" data-start-folded><h2>MTF requirement</h2><p class="small muted">From Kite’s MTF stock list, today. Counts for today only.</p>
            ${fundingFields('Kite shows it as', fundingMode())}${field('Where you checked', '<input name="summary" value="Kite MTF list">')}<button class="btn primary">Save requirement</button></form>`}
          <form class="card form" data-form="evidence" data-symbol="${esc(sym)}" data-start-folded><h2>Other record</h2>
            ${field('Kind', `<select name="kind">${options(kinds, market ? 'macro' : 'news')}</select>`)}
            ${field('What you found', '<textarea name="summary" rows="3" required></textarea>')}
            ${field('Link (optional)', '<input name="source" type="url">')}
            ${field('Exchange (prices and charts only)', `<select name="exchange">${options([['NSE', 'NSE'], ['BSE', 'BSE']], exchange)}</select>`)}
            ${field('Good until (optional)', '<input name="goodUntil" type="date">', 'Blank: the desk picks by kind (chart readings 5 days, fundamentals 90, market-wide 7, news today only).')}
            <button class="btn primary">Save record</button></form>
          <form class="card form" data-form="note" data-symbol="${esc(sym)}" data-start-folded><h2>Note</h2>
            ${field('Title', '<input name="title" required maxlength="200">')}
            ${field('Note', '<textarea name="body" rows="4" required></textarea>')}
            <button class="btn primary">Save note</button></form>
        </div>
      </div>`;
  },

  strategies(id) {
    if (id) return strategyEditor(id);
    return `<header class="page-head"><h1>Strategies</h1><a class="btn primary" href="#/strategies/new">New strategy</a></header>
      <p class="lead">Each strategy has its own checklist. Every buy must name one. The built-in strategies are starting templates, not recommendations.</p>
      ${S.strategies.map((s) => `<section class="card" data-fold="${esc(s.id)}"><div class="card-head"><h2>${esc(s.name)} <span class="tag tag-muted">v${s.version}</span>${s.enabled ? '' : ' <span class="tag tag-muted">off</span>'}</h2><div class="row-tools"><a href="#/strategies/${esc(s.id)}">Edit</a>${trashBtn('strategy', s.id, `strategy ${s.name}`)}</div></div>
        <p class="muted">${esc(s.description)} · ${s.items.length} checks · <a href="#/prepare">Prepare a stock</a></p><p class="small">${esc(windowText(strategyWin(s)))}</p>${strategyItemsHtml(s.items, { checklist: S.meta.checklist, esc })}</section>`).join('')}`;
  },

  checklist() {
    const c = S.meta.checklist;
    const count = c.groups.reduce((a, g) => a + g.items.length, 0);
    return `<header class="page-head"><div><h1>Pre-trade checklist</h1><p class="muted">${c.groups.length} groups · ${count} checks</p></div>
      <div class="actions"><button class="btn" data-action="copy-complete">Make my own strategy from this list</button></div></header>
      <p class="lead">Everything worth looking at before a swing trade, in two stages. <b>Research</b> is done on the Prepare page days before; each strategy says how long it must wait and how long it keeps counting (${esc(windowText({ bufferDays: S.meta.checklist.window.defaultBuffer, expireDays: S.meta.checklist.window.defaultExpire }))}). <b>On the day</b> must be checked just before buying. Strategies pick from this list. Nothing here is advice.</p>
      <p class="small muted">Whole-market checks (Nifty, VIX, US and Asian markets, crude oil, USDINR, FII/DII) are saved once a day under the name <b>${esc(c.market)}</b> and count for every stock.</p>
      ${libraryHtml(c, { esc })}
      <section class="card"><h2>Free places to look</h2><ul class="rows">${Object.values(c.sources).map(([name, url]) => `<li><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a></li>`).join('')}</ul></section>`;
  },

  prepare(...args) {
    // Old links were #/prepare/<strategy>/<stock>; new ones are #/prepare/<stock>/<exchange>.
    if (args[0] && S.strategies.some((x) => x.id === args[0])) args = args.slice(1);
    const sym = (args[0] || '').toUpperCase().replace(/[^A-Z0-9&._-]/g, '');
    const exchange = args[1] === 'BSE' ? 'BSE' : 'NSE';
    const w = S.meta.checklist.window;
    let body = '<p class="muted">Enter a stock to see the full research list, how each strategy fits, and the desk’s and Claude’s views.</p>';
    if (sym) {
      const cached = prepData(sym, exchange);
      body = cached ? prepareBody(sym, exchange, cached) : '<p class="muted">Loading…</p>';
    }
    return `<header class="page-head"><div><h1>Prepare a trade</h1><p class="muted">Stage 1: research, days before you buy. Nothing can be approved until its research has waited. ${esc(windowText({ bufferDays: w.defaultBuffer, expireDays: w.defaultExpire }))}${sym ? ` Everything about ${symLink(sym)} is on its stock page.` : ''}</p></div></header>
      <form class="card form inline" data-form="prepare-pick">
        ${field('Stock', `<input name="symbol" required autocapitalize="characters" value="${esc(sym)}">`)}
        ${field('Exchange', `<select name="exchange">${options([['NSE', 'NSE'], ['BSE', 'BSE']], exchange)}</select>`)}
        <button class="btn primary">Show checklist</button>
      </form>
      ${body}`;
  },

  playbooks(id) {
    if (id) return playbookEditor(id);
    return `<header class="page-head"><h1>Playbooks</h1><a class="btn primary" href="#/playbooks/new">New playbook</a></header>
      <p class="lead">A playbook is a repeating job. At its time the desk queues a task; the assigned model app picks it up with <code>next_task</code>, follows your instructions and reports back. The desk never needs its own model key. There is no holiday calendar: switch playbooks off on market holidays.</p>
      ${S.playbooks.length ? S.playbooks.map((pb) => `<section class="card" data-fold="${esc(pb.id)}"><div class="card-head"><h2>${esc(pb.name)} ${pb.enabled ? '<span class="tag tag-ok">On</span>' : '<span class="tag tag-muted">Off</span>'}</h2><div class="row-tools"><a href="#/playbooks/${esc(pb.id)}">Edit</a>${trashBtn('playbook', pb.id, `playbook ${pb.name}`)}</div></div>
        <p class="muted">${esc(scheduleText(pb.schedule))} · run by ${esc(S.agentNames[pb.agentId] ?? 'nobody')} · up to ${pb.maxIntents} request(s) per run</p><p class="pre small">${esc(pb.instructions)}</p></section>`).join('') : '<p class="muted">No playbooks yet.</p>'}
      <section class="card"><h2>Recent tasks</h2>${S.tasks.length ? (({ items, nav }) => `<ul class="rows">${items.map((t) => `<li><div><b>${esc(S.playbooks.find((p) => p.id === t.playbookId)?.name ?? t.playbookId)}</b> <span class="tag tag-muted">${esc(t.status)}</span><div class="small muted">Due ${when(t.dueAt)}</div>${t.summary ? `<p class="pre small">${esc(t.summary)}</p>` : ''}</div>${['queued', 'claimed'].includes(t.status) ? '' : trashBtn('task', t.id, 'this job')}</li>`).join('')}</ul>${nav}`)(paged('tasks', S.tasks)) : '<p class="muted">No tasks yet.</p>'}</section>`;
  },

  agents() {
    const shown = drafts.newKey;
    const live = S.agents.filter((a) => !a.revoked), gone = S.agents.filter((a) => a.revoked);
    return `<header class="page-head"><h1>Agents &amp; MCP</h1></header>
      <p class="lead">Connect any model app that speaks MCP. Each connection gets its own key, access level and limits. No level can approve, place orders, change access, edit strategies or delete history.</p>
      ${shown ? `<section class="card highlight"><h2>Key for ${esc(shown.name)} — shown once</h2><p>Add this to the model app’s MCP settings. Anyone with this key can act as this agent.</p><pre class="code">${esc(JSON.stringify({ mcpServers: { 'swing-desk': { ...S.meta.mcp, env: { ...(S.meta.mcp.env || {}), SWING_DESK_AGENT_KEY: shown.key } } } }, null, 2))}</pre><button class="btn" data-action="hide-key">I have saved it</button></section>` : ''}
      <section class="card"><h2>Connections</h2>${live.length ? `<ul class="agent-list">${live.map(agentRow).join('')}</ul>` : '<p class="muted">No connected agents. Add one below.</p>'}
        ${gone.length ? (({ items, nav }) => `<details class="agent-gone"><summary>Disconnected agents (${gone.length})</summary><ul class="rows">${items.map((a) => `<li><div><b>${esc(a.name)}</b> <span class="tag tag-bad">disconnected</span><div class="small muted">${esc(a.client)} · its past calls and requests stay in the ledger</div></div>${trashBtn('agent', a.id, `agent ${a.name}`)}</li>`).join('')}</ul>${nav}</details>`)(paged('agents-gone', gone)) : ''}</section>
      <form class="card form" data-form="agent-add"><h2>Add an agent</h2>
        ${field('Start from', `<select name="agentPreset">${options([...Object.entries(S.meta.presets.agents).map(([k, p]) => [k, `${p.label} – ${p.about}`]), ['custom', 'Custom – choose everything yourself']], 'researcher')}</select>`)}
        <div class="grid">${field('Name', '<input name="name" required placeholder="Claude research">')}${field('App', '<input name="client" placeholder="Claude Code">')}
        ${field('Access', `<select name="scope">${options(['off', 'read', 'draft', 'propose'].map((s) => [s, s]), S.meta.presets.agents.researcher.scope)}</select>`)}${field('Key lifetime (days)', num('expiresDays', 30, 'step="1" min="1" max="365"'))}
        ${field('Requests per day', num('intentsPerDay', S.meta.presets.agents.researcher.limits.intentsPerDay, 'step="1" min="0"'))}${field('Writes per day', num('writesPerDay', S.meta.presets.agents.researcher.limits.writesPerDay, 'step="1" min="0"'))}${field('Calls per hour', num('callsPerHour', S.meta.presets.agents.researcher.limits.callsPerHour, 'step="1" min="0"'))}</div>
        <ul class="small muted">${Object.entries(SCOPE_HELP).map(([k, v]) => `<li><b>${k}</b>: ${v}</li>`).join('')}</ul>
        ${pinField()}<button class="btn primary">Create agent and key</button></form>
      <section class="card"><h2>Recent MCP calls</h2>${S.calls.length ? (({ items, nav }) => `<ul class="rows">${items.map((c) => `<li><span>${esc(S.agentNames[c.agent_id] ?? c.agent_id)} · <code>${esc(c.tool)}</code> ${c.ok ? '' : `<span class="tag tag-bad">${esc(c.error)}</span>`}</span><span class="small muted">${when(c.at)}</span></li>`).join('')}</ul>${nav}`)(paged('calls', S.calls)) : '<p class="muted">No calls yet.</p>'}</section>`;
  },

  ledger() {
    return `<header class="page-head"><h1>Ledger</h1></header>
      <p class="lead">Every change is a new entry. Nothing is edited or deleted. Each entry includes a fingerprint of the one before it, so tampering shows up.</p>
      <section class="card"><div id="chain" class="muted">Checking…</div><ul class="rows" id="ledger-rows"><li class="muted">Loading…</li></ul><div id="ledger-pager"></div></section>`;
  },

  trash() {
    const p = paged('trash', S.trash, 15);
    return `<header class="page-head"><h1>Trash</h1></header>
      <p class="lead">Things you moved here are hidden from every page and from agents. Closed lots still count in your profit and loss. <b>Restore</b> puts an item back. <b>Delete forever</b> means it can never come back. The ledger keeps a line saying something was deleted, so your history still checks out.</p>
      <section class="card"><h2>In the Trash <span class="small muted">${S.trash.length}</span></h2>${S.trash.length ? `<ul class="rows">${p.items.map(trashRow).join('')}</ul>${p.nav}` : '<p class="muted">The Trash is empty.</p>'}</section>
      ${S.trash.length ? `<form class="card form" data-form="trash-empty"><h2>Empty the Trash</h2><p>Deletes all ${S.trash.length} item(s) forever. This cannot be undone.</p>${pinField()}<button class="btn danger">Delete all forever</button></form>` : ''}`;
  },

  settings() {
    const st = S.status.settings;
    return `<header class="page-head"><h1>Settings</h1></header>
      ${S.pinSet ? '' : '<section class="card highlight"><h2>Set your approval PIN first</h2><p>Approvals, agent access, strategies and playbooks need this PIN. Keep it out of any model app’s reach.</p></section>'}
      ${S.status.automationPaused ? `<form class="card form highlight" data-form="resume"><h2>Agents are paused</h2><p>Resuming lets connected agents call the desk again.</p>${pinField()}<button class="btn primary">Resume agents</button></form>` : ''}
      <form class="card form" data-form="settings"><h2>Risk limits</h2><p class="small muted">Changing these never changes past trades.</p>
        <fieldset class="presets" data-info="preset"><legend>Start from</legend>
          <p class="small muted">Your saved limits: <b>${esc(S.meta.presets.currentRisk ? S.meta.presets.risk[S.meta.presets.currentRisk].label : 'Custom')}</b>. These are examples, not advice.</p>
          <div class="preset-grid">
            ${[...Object.entries(S.meta.presets.risk).map(([k, p]) => [k, p.label, p.about]), ['custom', 'Custom', 'Type your own numbers below.']].map(([k, label, about]) => `
              <label class="preset"><input type="radio" name="preset" value="${k}" ${(S.meta.presets.currentRisk ?? 'custom') === k ? 'checked' : ''}><span><b>${esc(label)}</b><small>${esc(about)}</small></span></label>`).join('')}
          </div>
          <p class="small muted">Picking one fills the boxes below using your trading capital. Nothing is saved until you click Save limits.</p>
        </fieldset>
        <div class="grid">${Object.entries(S.meta.settingRules).map(([k, r]) => field(esc(r.label), num(k, st[k], `min="${r.min}" max="${r.max}"`))).join('')}</div>
        ${pinField()}<button class="btn primary">Save limits</button></form>
      <form class="card form" data-form="pin"><h2>${S.pinSet ? 'Change' : 'Set'} approval PIN</h2>
        ${S.pinSet ? field('Current PIN', '<input name="oldPin" type="password" inputmode="numeric" autocomplete="off" required>') : ''}
        ${field('New PIN (6–12 digits)', '<input name="pin" type="password" inputmode="numeric" autocomplete="off" required minlength="6" maxlength="12" pattern="[0-9]{6,12}">')}
        <button class="btn primary">Save PIN</button></form>
      <section class="card"><h2>Backup</h2><p class="muted">Writes a full copy of the database to your backup folder.</p><button class="btn" data-action="backup">Back up now</button></section>
      <section class="card"><h2>Charges</h2><p class="muted">Zerodha rates checked ${esc(S.status.fees.checkedOn)}. Each approved buy keeps a frozen copy.</p>${sourcesList(String(S.status.fees.source ?? "").split(" · ").filter(Boolean))}</section>`;
  },
};

// ---------- page pieces ----------

// ---------- records, Prepare and recommendations ----------

const NEEDS_CONFIRM = new Set(['quote', 'funding']); // confirmed against Kite, never “verified”
const PRICE_KINDS = new Set(['quote', 'candles', 'zones']); // mirrors EXCHANGE_KINDS in src/core/evidence.js
// Days a new record stays good, by kind. Mirrors suggestGoodUntil in src/core/knowledge.js.
const GOOD_DAYS = { candles: 5, zones: 5, sector: 5, macro: 7, governance: 90, legal: 90, other: 90, fundamentals: 90, news: 0, quote: 0, funding: 0 };
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const suggestGoodUntil = (kind, date) => addDays(date, GOOD_DAYS[kind] ?? 90);
const RECORD_TAG = { found: ['Found, not verified', 'tag-warn'], verified: ['Verified', 'tag-ok'], expired: ['Past good-until', 'tag-muted'], corrected: ['Corrected', 'tag-bad'], trashed: ['In the Trash', 'tag-muted'] };
const recordTag = (e) => { const [label, cls] = RECORD_TAG[e.status] ?? [e.status, 'tag-muted']; return `<span class="tag ${cls}">${esc(label)}</span>`; };
const CALL = { wait: ['Wait', 'tag-warn'], buy: ['Buy', 'tag-ok'], hold: ['Hold', 'tag-muted'], sell: ['Sell', 'tag-bad'] };
const callTag = (call) => `<span class="tag call ${CALL[call]?.[1] ?? 'tag-muted'}">${CALL[call]?.[0] ?? esc(call)}</span>`;
const exchangeSelect = (selected) => `<select name="exchange">${options([['NSE', 'NSE'], ['BSE', 'BSE']], selected)}</select>`;

const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const strategyWin = (s) => ({ bufferDays: s?.bufferDays ?? S.meta.checklist.window.defaultBuffer, expireDays: s?.expireDays ?? S.meta.checklist.window.defaultExpire });
/** “Buffer 3, expire 5: research ticked on Monday counts Thursday to Saturday.” */
function windowText({ bufferDays: b, expireDays: e }) {
  const day = (n) => `${LONG_DAYS[(1 + n) % 7]}${n < 7 ? '' : n < 14 ? ' a week later' : ` ${Math.floor(n / 7)} weeks later`}`;
  return `Buffer ${b}, expire ${e}: research ticked on Monday counts ${day(b)} to ${day(e)}.`;
}

/** A checklist item as a strategy item: from the strategy, or from the library (master list) when no strategy is given. */
function itemDef(strategyId, id) {
  if (strategyId) return S.strategies.find((s) => s.id === strategyId)?.items.find((i) => i.id === id);
  for (const g of S.meta.checklist.groups) {
    const i = g.items.find((x) => x.id === id);
    if (i) return toStrategyItem(i, g.id);
  }
  return null;
}
const libraryItem = (id) => S.meta.checklist.groups.flatMap((g) => g.items).find((i) => i.id === id);
const isBound = (item) => item.exchangeBound ?? libraryItem(item.id)?.exchangeBound ?? false;
const recordSymbol = (item, symbol) => (item.scope === 'market' ? S.meta.checklist.market : symbol);
/**
 * Records that could answer an evidence item for a stock on an exchange, best first. `list` is
 * the full per-stock list from prepare.status where available (S.evidence holds only the newest
 * 200 of all stocks). Price-type records of exchange-bound items must be on the chosen exchange,
 * as the server checks; other kinds keep no exchange.
 */
function recordsFor(item, symbol, exchange, statuses, list = S.evidence) {
  const sym = recordSymbol(item, symbol);
  const onExchange = isBound(item) && PRICE_KINDS.has(item.kind);
  return list
    .filter((e) => e.kind === item.kind && e.symbol === sym && statuses.includes(e.status) && (!onExchange || e.exchange === exchange))
    .sort((a, b) => (b.topic === item.id) - (a.topic === item.id));
}

/**
 * Owner-only: an agent's (or an old) record is right. It then counts until the good-until date
 * chosen here, prefilled with the usual length for its kind. Prices and MTF are confirmed instead.
 * No <form>: this also sits inside the approval form.
 */
function verifyButton(e) {
  if (e.status !== 'found' || NEEDS_CONFIRM.has(e.kind)) return '';
  const today = S.status.today;
  return `<details class="verify"><summary class="btn">Verify…</summary><div class="verify-box">
    ${field('Good until', `<input name="goodUntil" type="date" min="${today}" value="${suggestGoodUntil(e.kind, today)}" data-verify-date>`)}
    <button type="button" class="btn primary" data-action="verify-evidence" data-id="${esc(e.id)}" aria-label="Verify this ${esc(e.kind)} record for ${esc(e.symbol)}">Verify: it is right</button></div></details>`;
}

function correctForm(e) {
  const value = e.kind === 'quote' ? field('Correct price ₹', num('price', e.price, 'required'))
    : e.kind === 'funding' ? field('Correct own cash %', num('marginPct', e.marginPct, 'required min="1" max="100"'))
    : field('Corrected text', `<textarea name="summary" rows="3" required>${esc(e.summary)}</textarea>`);
  return `<details class="correct"><summary class="btn">Correct</summary><form class="form" data-form="correct" data-id="${esc(e.id)}">
    <p class="small muted">The old record stays in the history, marked corrected, and stops counting. Research you prepared with it must be prepared again, and its wait starts again.</p>
    ${value}${e.exchange ? field('Exchange', exchangeSelect(e.exchange)) : ''}
    ${NEEDS_CONFIRM.has(e.kind) ? '' : field('Good until (optional)', '<input name="goodUntil" type="date">', 'Blank: the desk picks by kind.')}
    ${field('Why it was wrong', '<input name="reason" required maxlength="500">')}
    <button class="btn primary">Save correction</button></form></details>`;
}

function flagsHtml(e) {
  return (e.flags ?? []).map((f) => `<div class="small flag"><span class="tag tag-warn">Flagged</span> ${f.by === 'owner' ? 'You' : `${esc(actorName(f.by))} (written by a model · not verified)`} · ${when(f.at)}: ${esc(f.reason)}</div>`).join('');
}

/** What Claude found, its views and its flags, waiting for the owner. */
function newFromClaude() {
  const found = S.evidence.filter((e) => e.status === 'found' && e.by !== 'owner' && !(NEEDS_CONFIRM.has(e.kind) && S.evidence.some((x) => x.confirms === e.id)));
  const flagged = S.evidence.filter((e) => e.flags?.length && ['found', 'verified', 'expired'].includes(e.status));
  const views = (S.recommendations ?? []).filter((r) => String(r.by).startsWith('agent:')).slice(0, 5);
  const head = '<h2>New from Claude</h2><p class="small muted">Written by a model, not verified. A record counts only after you verify it; prices and MTF requirements only after you confirm them against Kite.</p>';
  if (!found.length && !flagged.length && !views.length) return `<section class="card new-from-claude" data-info="verify">${head}<p class="muted">Nothing new. Records Claude finds, its views and its flags appear here.</p></section>`;
  const p = paged('today-found', found, 5);
  return `<section class="card new-from-claude" data-info="verify">${head}
    ${found.length ? `<h3>Found records <span class="small muted">${found.length}</span></h3><ul class="rows">${p.items.map((e) => evidenceRow(e)).join('')}</ul>${p.nav}` : ''}
    ${views.length ? `<h3>Claude’s views</h3><ul class="rows">${views.map((r) => `<li><div><b>${symLink(r.symbol)}</b> ${esc(r.exchange)} · Claude says ${callTag(r.call)}<div class="small muted">${when(r.at)} · ${esc(String(r.reasons).slice(0, 160))}</div></div><a class="btn" href="#/prepare/${esc(encodeURIComponent(r.symbol))}/${esc(r.exchange)}">Compare on Prepare</a></li>`).join('')}</ul>` : ''}
    ${flagged.length ? `<h3 data-info="flag">Flagged records <span class="small muted">${flagged.length}</span></h3><ul class="rows">${flagged.slice(0, 5).map((e) => evidenceRow(e)).join('')}</ul><p class="small muted">Open the stock to correct a record that is really wrong.</p>` : ''}
  </section>`;
}

// Prepare data comes from the server (prepare.status). Cached per stock and exchange; every
// state refresh marks it stale, and the page shows the last copy while a fresh one loads.
const prepCache = {};
function prepData(symbol, exchange) {
  const key = `${symbol}|${exchange}`;
  const c = prepCache[key];
  if (!c || c.stale) loadPrep(symbol, exchange, key, !!c);
  return c?.data ?? null;
}
const loadingPrep = new Map(); // key → { again }: set when the data went stale during a load
async function loadPrep(symbol, exchange, key, hadData) {
  if (loadingPrep.has(key)) { loadingPrep.get(key).again = true; return; }
  const job = { again: false };
  loadingPrep.set(key, job);
  try {
    const r = await api('/api/action/prepare.status', { method: 'POST', body: JSON.stringify({ symbol, exchange }) });
    // A change saved while this was loading may be missing from it: keep it marked stale.
    prepCache[key] = { data: r.result, stale: job.again };
    if (job.again) { loadingPrep.delete(key); return await loadPrep(symbol, exchange, key, true); }
    // Do not redraw under someone typing; say that newer data is waiting instead.
    if (hadData && document.activeElement?.closest('main form, main .verify')) {
      for (const m of document.querySelectorAll('.prep-newer')) m.hidden = false;
      return;
    }
    if (/^#\/(prepare|stock)\//.test(location.hash)) render();
  } catch (err) {
    toast(err.message, true);
  } finally {
    loadingPrep.delete(key);
  }
}

/** Shown when a fresher copy arrived while you were typing, so stale statuses never pass silently. */
const newerMarker = () => '<p class="prep-newer" role="status" hidden><button type="button" class="btn" data-action="prep-redraw">Newer data available — refresh</button> <span class="small muted">Statuses below may be out of date. Refreshing keeps what you saved, not what you are typing.</span></p>';

/** Buttons, records and a small form under one research item on the Prepare page. */
function prepExtra(c, strategyId, symbol, exchange, list) {
  const item = itemDef(strategyId, c.id.replace(/^item:/, ''));
  if (!item || (item.stage ?? 'before') !== 'research' || !['attest', 'evidence'].includes(item.type)) return '';
  const counting = c.status === 'pass' || c.status === 'wait';
  const base = `data-symbol="${esc(symbol)}" data-exchange="${esc(exchange)}" data-itemid="${esc(item.id)}" data-strategy="${esc(strategyId ?? '')}"`;
  const mark = (yes, label, evidenceId) => `<button type="button" class="btn" data-action="prepare-mark" data-yes="${yes ? 1 : 0}" ${base}${evidenceId ? ` data-evidence="${esc(evidenceId)}"` : ''}>${label}</button>`;
  if (item.type === 'attest') return `<div class="actions prep-tools">${counting ? mark(false, 'Remove mark') : mark(true, c.status === 'missing' ? 'I checked this' : 'I checked it again')}</div>`;
  const today = S.status.today;
  const records = recordsFor(item, symbol, exchange, ['verified', 'found'], list).slice(0, 3);
  const rows = records.map((e) => `<li class="prep-record"><div>${recordTag(e)} ${e.exchange ? `<span class="tag tag-muted">${esc(e.exchange)}</span> ` : ''}${esc(e.summary || (e.price ? price(e.price) : ''))}
      <div class="small muted">${e.by === 'owner' ? 'You' : `Found by ${esc(actorName(e.by))}`} · ${when(e.observedAt)}${e.status === 'verified' ? ` · good until ${esc(e.goodUntil)}` : ''}</div>${flagsHtml(e)}</div>
      <div class="actions">${e.status === 'verified' ? mark(true, counting ? 'Use this record instead (the wait starts again)' : 'Use this verified record', e.id) : verifyButton(e)}</div></li>`).join('');
  const sym = recordSymbol(item, symbol);
  const form = `<details class="prep-add"><summary class="btn">Add a record</summary>
    <form class="form" data-form="prep-evidence" ${base} data-kind="${esc(item.kind)}" data-record-symbol="${esc(sym)}">
      <p class="small muted">A “${esc(S.meta.evidenceKinds[item.kind] ?? item.kind)}” record${sym !== symbol ? ` saved under ${esc(sym)} (counts for every stock)` : ''}. You entered it, so it counts as verified until its good-until date.</p>
      ${field('What you found', '<textarea name="summary" rows="2" required></textarea>')}
      ${field('Link (optional)', '<input name="source" type="url">')}
      ${PRICE_KINDS.has(item.kind) ? field('Exchange', exchangeSelect(exchange)) : ''}
      ${field('Good until', `<input name="goodUntil" type="date" required min="${today}" value="${suggestGoodUntil(item.kind, today)}">`)}
      <button class="btn primary">Save record and use it</button></form></details>`;
  return `${rows ? `<ul class="rows prep-records">${rows}</ul>` : '<p class="small muted">No verified record yet.</p>'}<div class="actions prep-tools">${form}</div>`;
}

function prepareBody(symbol, exchange, d) {
  const cl = S.meta.checklist;
  const research = d.master.checks.filter((c) => c.stage === 'research');
  const later = d.master.checks.filter((c) => c.stage !== 'research');
  const master = `<section class="card prep-master" data-fold="master"><div class="card-head"><h2>Master list · ${esc(symbol)} on ${esc(exchange)}</h2>${d.master.researchDone ? '<span class="tag tag-ok">Core research counting</span>' : '<span class="tag tag-ask">Core research not finished</span>'}</div>
      <p class="small">The full pre-trade list, for every stock. Mark an item when you have checked it; it counts only after the wait. A mark here also counts for every strategy that uses the same item. Core items feed the desk’s view below; only a request’s own strategy items can block approval.</p>
      <p class="small muted">Price and chart items use only ${esc(exchange)} records. Switch the exchange above to prepare on the other one.</p>
      ${checklistHtml(research, { checklist: cl, esc, tag, extra: (c) => prepExtra(c, null, symbol, exchange, d.records) })}
      <details class="cl-later"><summary>On the day: ${later.length} checks done on the request page</summary>${checklistHtml(later, { checklist: cl, esc, tag })}</details></section>`;
  const strategies = d.strategies.map((r) => {
    const fit = d.desk.strategies.find((x) => x.id === r.strategyId);
    const items = r.checks.filter((c) => c.stage === 'research');
    const ready = r.readyOn
      ? (r.readyOn <= S.status.today ? 'Its required research counts today.' : `Its required research all counts from ${esc(r.readyOn)}, if nothing expires first.`)
      : 'No ready date yet: some required research is not prepared, has expired, or must be prepared again.';
    return `<section class="card prep-strategy" data-fold="strategy-${esc(r.strategyId)}"><div class="card-head"><h2>${esc(r.strategyName)} <span class="tag tag-muted">v${r.version}</span></h2>${fit?.fits ? '<span class="tag tag-ok">Research ready</span>' : '<span class="tag tag-ask">Not ready yet</span>'}</div>
      <p class="small">${esc(windowText(r.window))}</p><p>${ready}</p>
      ${fit?.missing.length ? `<p class="small">Still to do: ${fit.missing.map(esc).join('; ')}.</p>` : ''}
      <details class="cl-later"><summary>Its research items (${items.length})</summary>${checklistHtml(items, { checklist: cl, esc, tag, extra: (c) => prepExtra(c, r.strategyId, symbol, exchange, d.records) })}</details></section>`;
  }).join('');
  return `${newerMarker()}${master}${strategies || '<p class="muted">No strategy is switched on.</p>'}${recCards(symbol, exchange, d)}
    ${tvChart(symbol, exchange)}
    <section class="card"><h2>Let Claude do the research</h2><p class="small">Ask Claude Code:</p>
      <pre class="code wrap">Use swing-desk. For ${esc(symbol)} on ${esc(exchange)}, call list_evidence and use the records that are still verified. For each research item still missing, research it with free sources and save it with add_evidence (exchange ${esc(exchange)} for prices and charts, whole-market checks under MARKET), with links. Then call get_recommendation and save your own view with add_recommendation. Tell me what I still need to check and verify myself.</pre></section>`;
}

/** The desk's rule-based view and Claude's view, side by side. Neither is advice. */
function recCards(symbol, exchange, d) {
  const { desk, agent } = d;
  const names = (ids) => ids.map((id) => esc(S.strategies.find((s) => s.id === id)?.name ?? id)).join(', ');
  const fits = desk.strategies.filter((s) => s.fits);
  const differ = agent && agent.call !== desk.call;
  return `<section class="card recs" data-fold="recs"><h2>Wait, buy, hold or sell</h2>
    <p class="small muted">Two views side by side. Neither is advice, and the desk never acts on either. You decide, and only you approve.</p>
    ${differ ? '<p class="disagree"><span class="tag tag-bad">The desk and Claude disagree</span> Read both reasons before deciding anything.</p>' : ''}
    <div class="rec-grid">
      <article class="rec"><h3>Desk rules</h3><p>The rules give: ${callTag(desk.call)}</p>
        <ul class="small">${desk.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        <p class="small">${fits.length ? `Strategies with research ready: ${names(fits.map((s) => s.id))}.` : 'No strategy has its research ready yet.'}</p>
        ${desk.recheck.length ? `<p class="small">Needs a re-check (not a sell reason): ${desk.recheck.map(esc).join('; ')}.</p>` : ''}
        <p class="small muted">Worked out only from records you entered or verified, on ${esc(exchange)}. “Near the stop” means the latest price is in the bottom quarter of the way from the stop up to the entry. Example: entry ₹500, stop ₹480: at or below ₹485.</p></article>
      <article class="rec"><h3>Claude <span class="small">(written by a model · not verified)</span></h3>
        ${agent ? `<p>Claude gives: ${callTag(agent.call)}</p><p class="small pre">${esc(agent.reasons)}</p>
          ${agent.strategyIds?.length ? `<p class="small">Strategies it names: ${names(agent.strategyIds)}.</p>` : ''}${sourcesList(agent.sources)}
          <p class="small muted">${esc(actorName(agent.by))} · ${when(agent.at)}</p>` : `<p class="muted">No view from Claude for ${esc(symbol)} on ${esc(exchange)} yet. Ask it with the prompt below.</p>`}</article>
    </div></section>`;
}

/** Short version of both views for the stock page. */
function recSummary(symbol, exchange) {
  const d = prepData(symbol, exchange);
  const head = `<div class="card-head"><h2>Desk rules and Claude · ${esc(exchange)}</h2><a href="#/prepare/${esc(encodeURIComponent(symbol))}/${esc(exchange)}">Compare on Prepare</a></div>`;
  if (!d) return `<section class="card rec-summary" data-fold="recs">${head}<p class="muted">Loading…</p></section>`;
  const differ = d.agent && d.agent.call !== d.desk.call;
  return `<section class="card rec-summary" data-fold="recs">${head}
    <p>Desk rules: ${callTag(d.desk.call)} · Claude (written by a model · not verified): ${d.agent ? callTag(d.agent.call) : '<span class="muted">no view yet</span>'}${differ ? ' <span class="tag tag-bad">The desk and Claude disagree</span>' : ''}</p>
    ${d.desk.reasons[0] ? `<p class="small muted">${esc(d.desk.reasons[0])}</p>` : ''}<p class="small muted">Neither is advice; the desk never acts on either.</p></section>`;
}

/** On a request: unverified records that could make a failing on-the-day check pass. */
function requestExtra(c, i) {
  const item = itemDef(i.strategyId, c.id.replace(/^item:/, ''));
  if (!item || item.type !== 'evidence' || c.status === 'pass' || (item.stage ?? 'before') === 'research') return '';
  return recordsFor(item, i.symbol, i.plan?.exchange ?? 'NSE', ['found']).slice(0, 2)
    .map((e) => `<div class="confirm-row"><span class="small">${e.by === 'owner' ? 'You' : esc(actorName(e.by))} found at ${when(e.observedAt)}${e.exchange ? ` (${esc(e.exchange)})` : ''}: ${esc(String(e.summary).slice(0, 160))} <span class="tag tag-warn">not verified</span></span>${verifyButton(e)}</div>`).join('');
}

function tile(label, value, used, limit, hint) {
  return `<div class="tile"><div class="muted small">${label}</div><div class="tile-value mono">${value}</div><meter min="0" max="${Math.max(1, limit)}" value="${Math.min(Math.max(0, used), limit)}" high="${limit * 0.8}" optimum="0"></meter><div class="small muted">${hint}</div></div>`;
}

function requestRow(i) {
  const label = i.kind === 'buy' ? `Buy ${i.symbol}` : i.kind === 'exit' ? `Sell ${i.qty} ${i.symbol}` : `Settings: ${Object.keys(i.patch).join(', ')}`;
  const blockers = i.evaluation ? i.evaluation.checks.filter((c) => c.required && c.status !== 'pass') : [];
  const detail = i.status === 'pending' ? (blockers.length ? `${blockers.length} item(s) need attention` : 'All checks pass') : i.status === 'approved' ? 'Approved · record the fill after you place it in Kite' : '';
  const verb = i.kind === 'buy' ? 'Buy' : i.kind === 'exit' ? `Sell ${i.qty}` : label;
  return `<li><div><b><a href="#/request/${esc(i.id)}">${esc(verb)}</a> ${symLink(i.symbol)}</b> <span class="tag tag-muted">${esc(i.status)}</span><div class="small muted">${byLine(i.by)} · ${when(i.at)}${detail ? ` · ${detail}` : ''}</div></div><div class="row-tools"><a class="btn" href="#/request/${esc(i.id)}">Open</a>${FINISHED.has(i.status) ? trashBtn('request', i.id, `request ${label}`) : ''}</div></li>`;
}

function pendingRequest(i) {
  const ev = i.evaluation;
  const sizing = ev.sizing;
  const quoteFix = ev.checks.some((c) => c.id === 'quote' && c.status !== 'pass');
  const fundingFix = ev.checks.some((c) => c.id === 'funding' && c.status !== 'pass');
  const desk = ev.checks.filter((c) => !c.id.startsWith('item:'));
  const items = ev.checks.filter((c) => c.id.startsWith('item:'));
  const planCard = sizing ? `<section class="card"><h2>The plan, recalculated by the desk</h2><p class="small muted">The agent’s numbers are not trusted. Size and charges come from your saved limits.</p>
    <div class="stats">${[['Entry', price(ev.plan.entry)], ['Stop', price(ev.plan.stop)], ['Target', price(ev.plan.target)], ['Shares', sizing.qty], ['Type', ev.plan.buyType === 'mtf' ? `MTF ${funding(ev.plan.marginPct)}` : 'Regular'], ['Hold up to', `${ev.plan.days} days`], ['Loss at stop', money(sizing.riskAtStop)], ['Gain at target', money(sizing.rewardAtTarget)]].map(([k, v]) => `<div><span>${k}</span><b class="mono">${v}</b></div>`).join('')}</div>
    <p>In plain words: you put in ${money(sizing.ownCash)} of your own cash${sizing.borrowed > 0 ? ` and borrow ${money(sizing.borrowed)} (interest about ${money(sizing.interestPerDay)} a day)` : ''}. If the price falls to the stop you lose about ${money(sizing.riskAtStop)} including charges and a ${price(sizing.slipPerShare)}/share worse-price allowance. At the target you gain about ${money(sizing.rewardAtTarget)}.</p></section>` : '';
  return `${planCard}
    <section class="card"><h2>Checks the app makes</h2><ul class="rows">${desk.map((c) => `<li><div>${tag(c.status)} <b>${esc(c.label)}</b>${c.required ? '' : ' <span class="muted small">(optional)</span>'}<div class="small muted">${esc(c.detail)}</div></div></li>`).join('')}</ul>
      ${quoteFix ? agentFinding(i.symbol, 'quote') : ''}
      ${fundingFix ? agentFinding(i.symbol, 'funding') : ''}
      ${quoteFix ? `<form class="form inline" data-form="quote" data-symbol="${esc(i.symbol)}" data-exchange="${esc(ev.plan.exchange)}">${field(`${esc(ev.plan.exchange)} price in Kite now for ${esc(i.symbol)} ₹`, num('price', '', 'required'))}<button class="btn">Save fresh price</button></form>` : ''}
      ${fundingFix ? `<form class="form inline" data-form="funding" data-symbol="${esc(i.symbol)}">${fundingFields('MTF limit from Kite today, as', fundingMode())}<button class="btn">Save requirement</button></form>` : ''}
    </section>
    <form class="card form" data-form="approve" data-id="${esc(i.id)}"><h2>Strategy checklist and your decision</h2>
      ${items.length ? `<p class="small">Research items are not ticked here. They come from the <a href="#/prepare/${esc(encodeURIComponent(i.symbol))}/${esc(ev.plan.exchange)}">Prepare page</a> and count only inside this strategy’s window. ${esc(windowText(strategyWin(S.strategies.find((s) => s.id === i.strategyId))))}</p>
      <p class="small">Tick each on-the-day “Your answer” item only if it is really true now. Records from Claude count only after you verify them.</p>
      ${checklistHtml(items, { checklist: S.meta.checklist, esc, tag, answer: 'ask', extra: (c) => requestExtra(c, i) })}` : ''}
      <p class="small">Approving saves your decision and gives you an order ticket. You place the order yourself in Kite.</p>
      ${pinField()}
      <div class="actions"><button class="btn primary">Approve</button></div>
    </form>
    <form class="card form" data-form="reject" data-id="${esc(i.id)}">${field('Reason (optional)', '<input name="reason">')}<button class="btn danger">Reject</button></form>`;
}

function decidedRequest(i) {
  const d = i.decision || {};
  let out = `<section class="card"><h2>Decision</h2><p>${esc(i.status)} ${d.at ? `on ${when(d.at)}` : ''}${d.reason ? ` · ${esc(d.reason)}` : ''}</p>${d.ticket ? `<p class="ticket mono">${esc(d.ticket)}</p>` : ''}</section>`;
  if (i.status === 'approved' && i.kind === 'buy') {
    const filled = S.lots.filter((l) => l.intentId === i.id).reduce((a, l) => a + l.qty, 0);
    out += `<form class="card form" data-form="fill-buy" data-id="${esc(i.id)}"><h2>Record your buy</h2><p class="small muted">Use the actual average price from Kite (it already includes any slippage). Several fills at different prices? Record each separately.</p>
      <div class="grid">${field('Shares bought', num('qty', d.sizing.qty - filled, 'required step="1" min="1"'))}${field('Actual price ₹', num('price', '', 'required'))}${field('Date', `<input name="date" type="date" required value="${indiaToday()}">`)}</div>
      <button class="btn primary">Save buy</button></form>`;
  }
  if (i.status === 'approved' && i.kind === 'exit') {
    out += saleForm(S.lots.find((l) => l.id === i.lotId), i.id, i.qty);
  }
  if (d.checks) out += `<details class="card"><summary>Checks at approval</summary><ul class="rows">${d.checks.map((c) => `<li><div>${tag(c.status)} ${esc(c.label)}<div class="small muted">${esc(c.detail)}</div></div></li>`).join('')}</ul></details>`;
  return out;
}

function evidenceFor(i) {
  if (!i.evidenceIds?.length && !i.claims) return '';
  const items = (i.evidenceIds || []).map((id) => S.evidence.find((e) => e.id === id)).filter(Boolean);
  const claims = Object.entries(i.claims || {});
  return `${items.length ? `<h3>Evidence it points to</h3><ul class="rows">${items.map((e) => evidenceRow(e)).join('')}</ul>` : ''}${claims.length ? `<h3>Agent’s checklist claims</h3><ul class="rows">${claims.map(([k, v]) => `<li><span><b>${esc(k)}</b>: ${esc(v)}</span></li>`).join('')}</ul>` : ''}`;
}

function evidenceRow(e, withTrash = false) {
  const value = e.kind === 'quote' ? price(e.price) : e.kind === 'funding' ? `up to ${funding(e.marginPct)}` : esc(e.summary);
  const meta = [
    e.by === 'owner' ? 'You' : `Found by ${esc(actorName(e.by))}`,
    e.exchange ? esc(e.exchange) : '',
    e.topic ? `for “${esc(libraryItem(e.topic)?.label ?? e.topic)}”` : '',
    `observed ${when(e.observedAt)}`,
    e.goodUntil && (e.status === 'verified' || e.status === 'expired') ? `good until ${esc(e.goodUntil)}` : '',
    e.confirms ? 'confirmed against Kite' : '',
    e.corrects ? `corrects an earlier record: ${esc(e.reason ?? '')}` : '',
  ].filter(Boolean).join(' · ');
  const tools = confirmButton(e) + verifyButton(e) + (withTrash && ['found', 'verified', 'expired'].includes(e.status) ? correctForm(e) : '');
  return `<li class="ev-row"><div>${e.status ? `${recordTag(e)} ` : ''}<b>${symLink(e.symbol)}</b> <span class="tag tag-muted">${esc(e.kind)}</span> ${value}<div class="small muted">${meta}</div>${sourcesList(e.sources)}${flagsHtml(e)}${tools ? `<div class="actions rec-tools">${tools}</div>` : ''}</div>${withTrash ? trashBtn('evidence', e.id, `${e.kind} record for ${e.symbol}`) : ''}</li>`;
}

/** Agent-found prices and MTF requirements count only after the owner checks them in Kite. */
function confirmButton(e) {
  if (!NEEDS_CONFIRM.has(e.kind) || e.by === 'owner' || e.status === 'corrected' || e.status === 'trashed') return '';
  if (S.evidence.some((x) => x.confirms === e.id)) return '<span class="tag tag-ok">Confirmed</span>';
  const label = e.kind === 'quote' ? `Kite shows ${price(e.price)} now` : `Kite allows ${lev(e.marginPct)} today`;
  return `<button class="btn" data-action="confirm-evidence" data-id="${esc(e.id)}">${label}: confirm</button>`;
}

function agentFinding(symbol, kind) {
  const e = S.evidence.find((x) => x.symbol === symbol && x.kind === kind);
  return e && e.by !== 'owner' && !S.evidence.some((x) => x.confirms === e.id) ? `<div class="confirm-row"><span class="small">${byLine(e.by)} found ${kind === 'quote' ? price(e.price) : `up to ${funding(e.marginPct)}`} at ${when(e.observedAt)}</span>${confirmButton(e)}</div>` : '';
}

function sourcesList(list) {
  if (!list?.length) return '';
  return `<div class="small">${list.map((s) => /^https?:\/\//.test(s) ? `<a href="${esc(s)}" rel="noopener noreferrer" target="_blank">${esc(s)}</a>` : esc(s)).join(' · ')}</div>`;
}

/**
 * TradingView chart, loaded only when the owner opens it. It is for looking, never evidence for a check.
 * TradingView does not allow NSE data in charts embedded on other sites, so the embed shows the BSE
 * listing and links to the NSE chart on tradingview.com.
 */
function tvChart(symbol, exchange = 'NSE') {
  const sym = esc(encodeURIComponent(symbol));
  const note = exchange === 'BSE' ? '' : ` <span class="tag tag-warn bse-note">Shows BSE prices · nothing on it counts for ${esc(exchange)}</span>`;
  return `<details class="card tv-chart" data-tv-symbol="${esc(`BSE:${symbol}`)}"><summary>TradingView chart · BSE:${esc(symbol)}${note}</summary>
    <p class="small muted">Opening this loads TradingView’s chart from tradingview.com, which then sees the stock you view. TradingView only allows BSE prices in charts shown inside other apps, so this is the BSE listing; NSE prices can differ slightly. If the BSE code is different, search for the stock in the chart. It is for looking only: nothing on it counts as evidence for a check. Confirm prices in Kite before you buy.</p>
    <div class="tv-frame"></div>
    <p class="small muted"><a href="https://www.tradingview.com/chart/?symbol=NSE%3A${sym}" rel="noopener noreferrer" target="_blank">Open the NSE chart on tradingview.com</a> · Chart by TradingView</p></details>`;
}

document.addEventListener('toggle', (e) => {
  const box = e.target;
  if (!box.matches?.('details.tv-chart') || !box.open || box.dataset.loaded) return;
  box.dataset.loaded = '1';
  const host = box.querySelector('.tv-frame');
  host.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  script.textContent = JSON.stringify({
    autosize: true, symbol: box.dataset.tvSymbol, interval: 'D', timezone: 'Asia/Kolkata',
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', style: '1', locale: 'en',
    allow_symbol_change: true, calendar: false, support_host: 'https://www.tradingview.com',
  });
  host.firstElementChild.append(script);
}, true);

function agentRow(a) {
  const u = a.usage[S.status.today] ?? { writes: 0, intents: 0 };
  return `<li class="agent">
    <div class="agent-head"><div><b>${esc(a.name)}</b> <span class="tag scope-${a.scope}">${a.scope}</span><div class="small muted">${esc(a.client)}</div></div>
      <dl class="agent-facts"><div><dt>Limits</dt><dd>${a.limits.intentsPerDay} requests/day · ${a.limits.writesPerDay} writes/day · ${a.limits.callsPerHour} calls/hour</dd></div><div><dt>Used today</dt><dd>${u.intents} requests · ${u.writes} writes</dd></div><div><dt>Key expires</dt><dd>${when(a.expiresAt)}</dd></div></dl></div>
    <div class="agent-tools">
      <details><summary class="btn">Change access or limits</summary><form class="form" data-form="agent-update"><input type="hidden" name="id" value="${esc(a.id)}">
        <div class="grid">${field('Access', `<select name="scope">${options(['off', 'read', 'draft', 'propose'].map((s) => [s, s]), a.scope)}</select>`)}${field('Requests per day', num('intentsPerDay', a.limits.intentsPerDay, 'step="1" min="0"'))}${field('Writes per day', num('writesPerDay', a.limits.writesPerDay, 'step="1" min="0"'))}${field('Calls per hour', num('callsPerHour', a.limits.callsPerHour, 'step="1" min="0"'))}</div>
        ${pinField()}<div class="actions"><button class="btn primary">Save changes</button><button class="btn" name="rekey" value="1">Replace key</button></div><p class="small muted">Replace key: the old key stops working and a new one is shown once.</p></form></details>
      <details><summary class="btn danger">Disconnect</summary><form class="form" data-form="agent-update"><input type="hidden" name="id" value="${esc(a.id)}"><input type="hidden" name="revoked" value="1">
        <p>Disconnecting switches this key off for good. ${esc(a.name)} can no longer call the desk. Its past calls, research and requests stay in the ledger. To connect again, add a new agent.</p>
        ${pinField()}<div class="actions"><button class="btn danger">Disconnect ${esc(a.name)}</button></div></form></details>
    </div></li>`;
}

function lotsTable(lots, closed = false) {
  if (!lots.length) return '<p class="muted">None.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Stock</th><th>Type</th><th class="num">Shares</th><th class="num">Buy price</th><th class="num">${closed ? 'Result' : 'Stop'}</th><th class="num">${closed ? 'Charges' : 'Risk left'}</th><th>Bought</th>${closed ? '<th><span class="visually-hidden">Trash</span></th>' : ''}</tr></thead><tbody>
    ${lots.map((l) => `<tr><td><b>${symLink(l.symbol)}</b> <span class="small muted">${esc(l.exchange)}</span></td><td>${l.buyType === 'mtf' ? `MTF ${lev(l.marginPct)}` : 'Regular'}</td><td class="num mono">${closed ? l.qty : `${l.remaining}${l.remaining !== l.qty ? ` of ${l.qty}` : ''}`}</td><td class="num mono">${price(l.entry)}</td><td class="num mono">${closed ? money(l.realised) : price(l.stop)}</td><td class="num mono">${closed ? money(l.sales.reduce((a, s) => a + s.charges, 0)) : money(l.risk)}</td><td>${esc(l.date)}</td>${closed ? `<td>${trashBtn('lot', l.id, `closed lot ${l.symbol}`)}</td>` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}

function noteHtml(n) {
  return `<article class="note"><div class="card-head"><h3>${n.symbol ? `${symLink(n.symbol)} · ` : ''}${esc(n.title)}</h3>${trashBtn('note', n.id, `note “${n.title}”`)}</div><p class="small muted">${byLine(n.by)} · ${when(n.at)}</p><p class="pre">${esc(n.body)}</p>${sourcesList(n.sources)}</article>`;
}

/** Every symbol that has requests, lots, evidence or notes, most recently active first. */
function stockIndex() {
  const map = new Map();
  const touch = (symbol, at, add) => {
    if (!symbol) return;
    const s = map.get(symbol) ?? { symbol, last: '', openLots: 0, waiting: 0, quote: null };
    if (at > s.last) s.last = at;
    add?.(s);
    map.set(symbol, s);
  };
  for (const i of S.intents) touch(i.symbol, i.at, (s) => { if (i.status === 'pending' || i.status === 'approved') s.waiting++; });
  for (const l of S.lots) touch(l.symbol, l.date, (s) => { if (l.status === 'open') s.openLots++; });
  for (const e of S.evidence) touch(e.symbol, e.observedAt, (s) => { if (e.kind === 'quote' && !s.quote) s.quote = e; }); // newest first
  for (const n of S.notes) touch(n.symbol, n.at);
  return [...map.values()].sort((a, b) => b.last.localeCompare(a.last));
}

function stockRow(s) {
  return `<li><div><b>${symLink(s.symbol)}</b>${s.openLots ? ` <span class="tag tag-ok">${s.openLots} open lot${s.openLots > 1 ? 's' : ''}</span>` : ''}${s.waiting ? ` <span class="tag tag-ask">${s.waiting} request${s.waiting > 1 ? 's' : ''} for you</span>` : ''}
    <div class="small muted">${s.quote ? `Last price ${price(s.quote.price)} · ` : ''}Last activity ${when(s.last)}</div></div><a class="btn" href="#/stock/${esc(encodeURIComponent(s.symbol))}">Open</a></li>`;
}

function lotCard(l) {
  return `<article class="lot"><div class="card-head"><h3>${symLink(l.symbol)} · ${l.remaining} shares at ${price(l.entry)}</h3><span class="muted small">${l.buyType === 'mtf' ? `MTF ${lev(l.marginPct)}` : 'Regular'} · bought ${esc(l.date)}</span></div>
    <p class="small">Stop ${price(l.stop)} · target ${price(l.target)} · loss if stop hit ≈ ${money(l.risk)}${l.realised ? ` · realised so far ${money(l.realised)}` : ''}</p>
    <div class="actions"><details><summary class="btn">Record a sale</summary>${saleForm(l)}</details>
    <details><summary class="btn">Move stop</summary><form class="form inline" data-form="stop" data-id="${esc(l.id)}">${field('New stop ₹', num('stop', l.stop, 'required'))}<button class="btn">Save</button></form></details></div></article>`;
}

function saleForm(lot, intentId = '', qty = '') {
  if (!lot) return '';
  return `<form class="form" data-form="fill-sell" data-lot="${esc(lot.id)}" data-intent="${esc(intentId)}"><h3>Record sale of ${esc(lot.symbol)}</h3>
    <div class="grid">${field('Shares sold', num('qty', qty || lot.remaining, `required step="1" min="1" max="${lot.remaining}"`))}${field('Actual price ₹', num('price', '', 'required'))}${field('Date', `<input name="date" type="date" required value="${indiaToday()}">`)}
    ${field('Actual charges ₹ (optional)', num('charges', '', 'min="0"'), 'From the contract note plus MTF interest. Blank = estimate (may repeat fixed fees on partial sales).')}</div>
    <button class="btn primary">Save sale</button></form>`;
}

function scheduleText(s) {
  const days = s.days.map((d) => DAYS[d]).join(', ');
  return s.every ? `${days} · every ${s.every} min ${s.from}–${s.to} IST` : `${days} · ${s.at} IST`;
}

function strategyEditor(id) {
  const w = S.meta.checklist.window;
  const base = id === 'new' ? { id: '', name: '', description: '', enabled: true, bufferDays: w.defaultBuffer, expireDays: w.defaultExpire, items: [{ id: 'item-1', type: 'attest', stage: 'research', label: '', required: true }] } : S.strategies.find((s) => s.id === id);
  if (!base) return '<p>Strategy not found.</p>';
  const d = (drafts.strategy?.key === id ? drafts.strategy.value : null) ?? structuredClone(base);
  const kinds = Object.keys(S.meta.evidenceKinds);
  return `<header class="page-head"><div><a href="#/strategies">Back to strategies</a><h1>${id === 'new' ? 'New strategy' : `Edit ${esc(base.name)}`}</h1></div></header>
    <p class="lead">Saving creates a new version. Requests made against the old version can no longer be approved.</p>
    <form class="card form" data-form="strategy" data-key="${esc(id)}">
      ${id === 'new' ? field('Start from', `<select name="copyFrom">${options([['', 'Blank checklist'], ...S.strategies.map((s) => [s.id, `Copy of ${s.name}`])], d.copyFrom ?? '')}</select>`, 'Copies the checklist so you can change it. The original stays as it is.') : ''}
      <div class="grid">${field('Id (letters, digits, dashes)', `<input name="id" required value="${esc(d.id)}" ${id === 'new' ? '' : 'readonly'}>`)}${field('Name', `<input name="name" required value="${esc(d.name)}">`)}</div>
      ${field('Description', `<input name="description" value="${esc(d.description)}">`)}
      <label class="check"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}> <span>Agents can use this strategy</span></label>
      <fieldset class="window" data-info="window"><legend>Research window</legend>
        <div class="grid">${field('Buffer days', num('bufferDays', d.bufferDays ?? w.defaultBuffer, `required step="1" min="${w.minBuffer}" max="${w.maxExpire}"`))}${field('Expire days', num('expireDays', d.expireDays ?? w.defaultExpire, `required step="1" min="${w.minBuffer}" max="${w.maxExpire}"`))}</div>
        <p class="small muted">${esc(windowText(strategyWin(d)))} Buffer at least ${w.minBuffer}, expire at most ${w.maxExpire}, and expire not below buffer.${d.bufferDays === 3 && d.expireDays === 5 ? '' : ' Example: buffer 3, expire 5: research ticked on Monday counts Thursday to Saturday.'}</p>
        <p class="small muted">Every strategy needs at least one required research item (a “you answer” or evidence item, not a fixed rule).</p></fieldset>
      <h2>Checklist <span class="small muted">${d.items.length} items</span></h2>
      ${field('Add from checklist library', `<select name="libraryPick"><option value="">Choose a check or a whole group…</option>${S.meta.checklist.groups.map((g) => `<optgroup label="${esc(g.title)}"><option value="group:${esc(g.id)}">➕ All ${g.items.length} checks in “${esc(g.title)}”</option>${g.items.map((i) => `<option value="item:${esc(i.id)}" ${d.items.some((x) => x.id === i.id) ? 'disabled' : ''}>${esc(i.label)}</option>`).join('')}</optgroup>`).join('')}</select>`, 'Already added checks are greyed out.')}
      ${d.items.map((it, n) => `<fieldset class="item-row"><legend>Item ${n + 1}${it.group ? ` · ${esc(groupName(it.group, S.meta.checklist))}` : ''}</legend><div class="grid">
        ${field('Id', `<input data-item="id" value="${esc(it.id)}" required>`)}
        ${field('Type', `<select data-item="type">${options([['attest', 'You answer yes/no'], ['evidence', 'Needs evidence'], ['rule', 'Fixed rule']], it.type)}</select>`)}
        ${field('Group', `<select data-item="group">${options([['', 'No group'], ...S.meta.checklist.groups.map((g) => [g.id, g.title]), ...(it.group && !S.meta.checklist.groups.some((g) => g.id === it.group) ? [[it.group, it.group]] : [])], it.group ?? '')}</select>`)}
        ${field('When', `<select data-item="stage">${options([['research', 'Research (on Prepare, waits the buffer)'], ['before', 'Just before buying']], it.stage ?? 'before')}</select>`)}
        ${it.type === 'evidence' ? field('Evidence for', `<select data-item="scope">${options([['stock', 'This stock'], ['market', 'Whole market (MARKET)']], it.scope ?? 'stock')}</select>`) : ''}
        <input type="hidden" data-item="help" value="${esc(it.help ?? '')}">
        ${it.type === 'rule' ? field('Rule', `<select data-item="rule">${options(S.meta.ruleKinds.map((r) => [r, r]), it.rule)}</select>`) + field('Value', `<input data-item="value" value="${esc(it.value ?? '')}">`, 'regularOnly: true') : field('Label', `<input data-item="label" value="${esc(it.label)}" required>`)}
        ${it.type === 'evidence' ? field('Evidence kind', `<select data-item="kind">${options(kinds.map((k) => [k, k]), it.kind)}</select>`) : ''}
        ${it.type === 'evidence' && (it.stage ?? 'before') !== 'research' ? field('Max age (days, 0 = today)', `<input data-item="maxAgeDays" type="number" min="0" max="30" step="1" value="${esc(it.maxAgeDays ?? 0)}">`) : ''}
        ${it.type !== 'rule' ? field('Required', `<input type="checkbox" data-item="required" ${it.required !== false ? 'checked' : ''}>`) : ''}
        ${it.type !== 'rule' ? field('Uses one exchange’s prices', `<input type="checkbox" data-item="exchangeBound" ${isBound(it) ? 'checked' : ''}>`) : ''}
        </div><button type="button" class="btn small-btn" data-action="remove-item" data-n="${n}">Remove item</button></fieldset>`).join('')}
      <div class="actions"><button type="button" class="btn" data-action="add-item">Add item</button><button type="button" class="btn" data-action="refresh-items">Update form for changed types</button></div>
      ${pinField()}<button class="btn primary">Save strategy</button>
    </form>`;
}

function readStrategy(form) {
  const top = read(form);
  const items = [...form.querySelectorAll('.item-row')].map((row) => {
    const it = {};
    for (const el of row.querySelectorAll('[data-item]')) {
      const k = el.dataset.item;
      it[k] = el.type === 'checkbox' ? el.checked : el.value;
    }
    if (it.maxAgeDays !== undefined) it.maxAgeDays = Number(it.maxAgeDays);
    if (it.value !== undefined) it.value = it.value === 'true' ? true : Number(it.value);
    return it;
  });
  return { id: top.id, name: top.name, description: top.description, enabled: top.enabled, bufferDays: top.bufferDays, expireDays: top.expireDays, items, pin: top.pin };
}

function playbookEditor(id) {
  const templates = S.meta.presets.playbooks;
  const chosen = id === 'new' ? (drafts.playbookTemplate ?? 'news') : null;
  const t = templates[chosen];
  const base = id === 'new'
    ? { name: t?.name ?? '', agentId: S.agents.find((a) => !a.revoked)?.id ?? '', schedule: structuredClone(t?.schedule ?? { days: [1, 2, 3, 4, 5], at: '15:50' }), instructions: t?.instructions ?? '', maxIntents: t?.maxIntents ?? 0, enabled: true }
    : S.playbooks.find((p) => p.id === id);
  if (!base) return '<p>Playbook not found.</p>';
  const s = base.schedule;
  return `<header class="page-head"><div><a href="#/playbooks">Back to playbooks</a><h1>${id === 'new' ? 'New playbook' : `Edit ${esc(base.name)}`}</h1></div></header>
    <form class="card form" data-form="playbook" data-id="${id === 'new' ? '' : esc(id)}">
      ${id === 'new' ? field('Start from', `<select name="template">${options([...Object.entries(templates).map(([k, p]) => [k, p.label]), ['blank', 'Blank – write your own']], chosen)}</select>`, 'Fills everything below. You can change any of it.') : ''}
      <div class="grid">${field('Name', `<input name="name" required value="${esc(base.name)}">`)}
      ${field('Run by', `<select name="agentId">${options([['', 'Nobody (off)'], ...S.agents.filter((a) => !a.revoked).map((a) => [a.id, `${a.name} (${a.scope})`])], base.agentId)}</select>`)}
      ${field('Requests allowed per run', num('maxIntents', base.maxIntents, 'step="1" min="0" max="20"'), 'Only agents with Propose access can send requests.')}</div>
      <fieldset><legend>Days</legend>${DAYS.map((d, n) => `<label class="check inline"><input type="checkbox" name="day${n}" ${s.days.includes(n) ? 'checked' : ''}> <span>${d}</span></label>`).join('')}</fieldset>
      <fieldset data-info="mode"><legend>When (India time)</legend>
        <label class="check"><input type="radio" name="mode" value="at" ${s.every ? '' : 'checked'}> <span>Once a day at</span> <input name="at" value="${esc(s.at ?? '15:50')}" pattern="[0-2][0-9]:[0-5][0-9]" size="5"></label>
        <label class="check"><input type="radio" name="mode" value="every" ${s.every ? 'checked' : ''}> <span>Every</span> <input name="every" type="number" data-num min="5" max="240" step="1" value="${esc(s.every ?? 15)}"> <span>minutes from</span> <input name="from" value="${esc(s.from ?? '09:15')}" size="5"> <span>to</span> <input name="to" value="${esc(s.to ?? '15:30')}" size="5"></label>
      </fieldset>
      ${field('Instructions for the model', `<textarea name="instructions" rows="8" required>${esc(base.instructions)}</textarea>`, 'Say which tools to use and what to report. Example: “Check today’s news for each open lot with add_evidence (kind news). Call complete_task with a 3-line summary.”')}
      <label class="check"><input type="checkbox" name="enabled" ${base.enabled ? 'checked' : ''}> <span>On</span></label>
      ${pinField()}<button class="btn primary">Save playbook</button>
    </form>`;
}

async function loadLedger() {
  try {
    if (!ledgerCache) {
      ledgerCache = await api('/api/ledger');
      ledgerCache.more = ledgerCache.events.length === 100;
    }
  } catch (err) {
    return toast(err.message, true);
  }
  const p = paged('ledger', ledgerCache.events, 25);
  const pager = $('#ledger-pager');
  if (pager) pager.innerHTML = p.nav + (ledgerCache.more && p.items.at(-1) === ledgerCache.events.at(-1) ? '<button type="button" class="btn" data-action="ledger-more">Load older entries</button>' : '');
  const rows = p.items.map((e) => `<li><div><b>${esc(describe(e))}</b><div class="small muted">#${e.seq} · ${esc(actorName(e.actor))} · ${when(e.at)}</div></div></li>`).join('');
  const activity = $('#activity');
  if (activity) activity.innerHTML = ledgerCache.events.filter((e) => !e.type.startsWith('task.')).slice(0, 8).map((e) => `<li><div>${esc(describe(e))}<div class="small muted">${esc(actorName(e.actor))} · ${when(e.at)}</div></div></li>`).join('') || '<li class="muted">Nothing yet.</li>';
  const list = $('#ledger-rows');
  if (list) list.innerHTML = rows || '<li class="muted">No entries yet.</li>';
  const chain = $('#chain');
  if (chain) chain.innerHTML = ledgerCache.chain.ok ? `<span class="tag tag-ok">Chain intact</span> ${ledgerCache.chain.count} entries` : `<span class="tag tag-bad">Chain broken at #${ledgerCache.chain.brokenAt}</span> Restore from a backup.`;
}

function describe(e) {
  if (e.purged) return 'Something deleted forever (contents hidden)';
  const d = e.data;
  const kind = (KIND_LABEL[d.kind] ?? 'item').toLowerCase();
  const an = /^[aeiou]/.test(kind) ? 'an' : 'a';
  const map = {
    'settings.changed': () => `Changed limits: ${Object.keys(d.patch).join(', ')}`,
    'automation.paused': () => 'Paused all agents',
    'automation.resumed': () => 'Resumed agents',
    'strategy.saved': () => `Saved strategy ${d.name} (v${d.version})`,
    'agent.added': () => `Added agent ${d.name} (${d.scope})`,
    'agent.updated': () => `Updated agent ${S.agents.find((a) => a.id === d.id)?.name ?? d.id}${d.scope ? ` → ${d.scope}` : ''}${d.revoked ? ' (revoked)' : ''}`,
    'evidence.added': () => `Record for ${d.symbol}: ${d.kind}${d.exchange ? ` (${d.exchange})` : ''}${d.price ? ` ${price(d.price)}` : ''}`,
    'note.added': () => `Note: ${d.title}`,
    'intent.submitted': () => `Request: ${d.kind} ${d.symbol}`,
    'intent.approved': () => `Approved request ${d.id}`,
    'intent.rejected': () => `Rejected request ${d.id}`,
    'intent.withdrawn': () => `Withdrew request ${d.id}`,
    'intent.filled': () => `Request ${d.id} filled`,
    'lot.opened': () => `Bought ${d.qty} ${d.symbol} at ${price(d.entry)}`,
    'lot.sold': () => `Sold ${d.qty} shares at ${price(d.price)} · ${money(d.pnl)}`,
    'lot.stopChanged': () => `Moved stop to ${price(d.stop)}`,
    'playbook.saved': () => `Saved playbook ${d.name}`,
    'task.queued': () => 'Task queued',
    'task.claimed': () => 'Task picked up',
    'task.completed': () => 'Task done',
    'task.failed': () => 'Task failed',
    'task.expired': () => 'Task expired',
    'pin.changed': () => 'Approval PIN changed',
    'research.answered': () => `Research checklist answers for ${d.symbol} (old style, no longer counted)`,
    'prepare.marked': () => `${d.yes ? 'Prepared' : 'Removed the mark on'} “${libraryItem(String(d.key).split(':').at(-1))?.label ?? d.key}” for ${d.symbol}${d.exchange ? ` on ${d.exchange}` : ''}`,
    'evidence.verified': () => `Verified a record (good until ${d.goodUntil})`,
    'evidence.corrected': () => `Corrected a ${d.kind} record for ${d.symbol}: ${d.reason}`,
    'evidence.flagged': () => `Flagged a record: ${d.reason}`,
    'recommendation.added': () => `View on ${d.symbol} (${d.exchange}): ${CALL[d.call]?.[0] ?? d.call}`,
    'item.trashed': () => `Moved ${an} ${kind} to the Trash`,
    'item.restored': () => `Restored ${an} ${kind} from the Trash`,
    'item.purged': () => `Deleted ${an} ${kind} forever`,
  };
  return (map[e.type] ?? (() => e.type))();
}

// ---------- events ----------

const forms = {
  async plan(form, data, submitter) {
    drafts.plan = data;
    const plan = { exchange: data.exchange, buyType: data.buyType, ...(data.buyType === 'mtf' ? fundingInput(data) : {}), entry: data.entry, stop: data.stop, target: data.target, days: data.days, qty: data.qty };
    if (submitter?.value === 'preview') {
      const r = await act('plan.preview', plan);
      const z = r.sizing;
      drafts.planPreview = `<div class="stats">${[['Shares allowed', z.suggestedQty], ['Shares used', z.qty], ['Own cash', money(z.ownCash)], ['Borrowed', money(z.borrowed)], ['Loss at stop', money(z.riskAtStop)], ['Gain at target', money(z.rewardAtTarget)], ['Gain ÷ loss', `${z.rewardRisk.toFixed(2)}×`], ['Break-even sell', price(z.breakeven)]].map(([k, v]) => `<div><span>${k}</span><b class="mono">${v}</b></div>`).join('')}</div>`;
      return;
    }
    const r = await act('intent.submit', { kind: 'buy', symbol: data.symbol, strategyId: data.strategyId, thesis: data.thesis, plan });
    delete drafts.plan;
    delete drafts.planPreview;
    location.hash = `#/request/${r.id}`;
  },
  async quote(form, data) {
    const exchange = data.exchange || form.dataset.exchange || 'NSE';
    await act('evidence.add', { kind: 'quote', symbol: form.dataset.symbol || data.symbol, exchange, price: data.price });
    toast(`${exchange} price saved. It counts for 5 minutes.`);
  },
  async funding(form, data) {
    await act('evidence.add', { kind: 'funding', symbol: form.dataset.symbol || data.symbol, ...fundingInput(data), summary: data.summary || 'Kite MTF list' });
    toast('MTF requirement saved for today.');
  },
  async evidence(form, data) {
    // The exchange is kept only for prices and chart readings; the server ignores it for other kinds.
    await act('evidence.add', { kind: data.kind, symbol: form.dataset.symbol || data.symbol, summary: data.summary, sources: data.source ? [data.source] : [], exchange: data.exchange, goodUntil: data.goodUntil || undefined });
    toast('Record saved. You entered it, so it counts until its good-until date.');
  },
  async 'prep-evidence'(form, data) {
    const d = form.dataset;
    const { id } = await act('evidence.add', { kind: d.kind, symbol: d.recordSymbol, topic: d.itemid, summary: data.summary, sources: data.source ? [data.source] : [], exchange: data.exchange ?? d.exchange, goodUntil: data.goodUntil || undefined });
    await act('prepare.mark', { symbol: d.symbol, strategyId: d.strategy || undefined, itemId: d.itemid, exchange: d.exchange, evidenceId: id, yes: true });
    toast('Record saved and used for this item. It counts after the wait.');
  },
  async correct(form, data) {
    const { reason, goodUntil, ...fields } = data;
    await act('evidence.correct', { corrects: form.dataset.id, reason, ...fields, ...(goodUntil ? { goodUntil } : {}) });
    toast('Corrected. The old record stays in the history and no longer counts.');
  },
  async approve(form, data) {
    const answers = Object.fromEntries(Object.entries(data).filter(([k, v]) => k.startsWith('answer:') && v).map(([k]) => [k.slice(7), true]));
    const r = await act('intent.approve', { id: form.dataset.id, answers, pin: data.pin });
    toast(`Approved. Now in Kite: ${r.ticket}`);
  },
  async reject(form, data) {
    await act('intent.reject', { id: form.dataset.id, reason: data.reason });
    toast('Rejected.');
  },
  async 'fill-buy'(form, data) {
    await act('fill.buy', { intentId: form.dataset.id, qty: data.qty, price: data.price, date: data.date });
    toast('Buy saved as an open lot.');
  },
  async 'fill-sell'(form, data) {
    const r = await act('fill.sell', { lotId: form.dataset.lot, intentId: form.dataset.intent || undefined, qty: data.qty, price: data.price, date: data.date, charges: data.charges });
    toast(`Sale saved. Result ${money(r.pnl)}.`);
  },
  async stop(form, data) {
    await act('lot.stop', { lotId: form.dataset.id, stop: data.stop });
    toast('Stop moved.');
  },
  async 'agent-add'(form, data) {
    const r = await act('agent.add', {
      name: data.name, client: data.client, scope: data.scope, expiresDays: data.expiresDays, pin: data.pin,
      limits: { intentsPerDay: data.intentsPerDay, writesPerDay: data.writesPerDay, callsPerHour: data.callsPerHour },
    });
    drafts.newKey = { name: data.name, key: r.key };
  },
  async 'agent-update'(form, data, submitter) {
    if (submitter?.name === 'rekey') {
      const r = await act('agent.rekey', { id: data.id, pin: data.pin });
      drafts.newKey = { name: S.agents.find((a) => a.id === data.id)?.name, key: r.key };
      return;
    }
    if (data.revoked) {
      await act('agent.update', { id: data.id, revoked: true, pin: data.pin });
      toast('Agent disconnected. Its key no longer works.');
      return;
    }
    await act('agent.update', { id: data.id, scope: data.scope, limits: { intentsPerDay: data.intentsPerDay, writesPerDay: data.writesPerDay, callsPerHour: data.callsPerHour }, pin: data.pin });
    toast('Agent updated.');
  },
  async strategy(form) {
    const s = readStrategy(form);
    const r = await act('strategy.save', s);
    delete drafts.strategy;
    toast(`Saved version ${r.version}.`);
    location.hash = '#/strategies';
  },
  async playbook(form, data) {
    const days = DAYS.map((_, n) => (data[`day${n}`] ? n : -1)).filter((n) => n >= 0);
    const schedule = data.mode === 'every' ? { days, every: data.every, from: data.from, to: data.to } : { days, at: data.at };
    await act('playbook.save', { id: form.dataset.id || undefined, name: data.name, agentId: data.agentId || null, maxIntents: data.maxIntents, schedule, instructions: data.instructions, enabled: data.enabled, pin: data.pin });
    toast('Playbook saved.');
    delete drafts.playbookTemplate;
    location.hash = '#/playbooks';
  },
  async settings(form, data) {
    const { pin, preset, ...values } = data;
    const patch = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== undefined && v !== S.status.settings[k]));
    if (!Object.keys(patch).length) return toast('Nothing changed.');
    await act('settings.change', { patch, pin });
    toast('Limits saved.');
  },
  async note(form, data) {
    await act('note.add', { symbol: form.dataset.symbol, title: data.title, body: data.body });
    toast('Note saved.');
  },
  async 'stock-pick'(form, data) {
    location.hash = `#/stock/${encodeURIComponent(data.symbol.trim().toUpperCase())}`;
  },
  async 'prepare-pick'(form, data) {
    location.hash = `#/prepare/${encodeURIComponent(data.symbol.trim().toUpperCase())}/${data.exchange === 'BSE' ? 'BSE' : 'NSE'}`;
  },
  async resume(form, data) {
    await act('automation.resume', { pin: data.pin });
    toast('Agents resumed.');
  },
  async pin(form, data) {
    await act('pin.set', { pin: data.pin, oldPin: data.oldPin });
    toast('PIN saved.');
  },
  async 'trash-purge'(form, data) {
    await act('trash.purge', { kind: form.dataset.kind, id: form.dataset.id, pin: data.pin });
    toast('Deleted forever.');
  },
  async 'trash-empty'(form, data) {
    const r = await act('trash.purge', { all: true, pin: data.pin });
    toast(`Deleted ${r.count} item(s) forever.`);
  },
};

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const handler = forms[form.dataset.form];
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await handler(form, read(form), e.submitter);
    render();
  } catch (err) {
    toast(err.message, true);
    buttons.forEach((b) => { b.disabled = false; });
  }
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  try {
    if (action === 'pause') { await act('automation.pause', {}); toast('All agents paused.'); }
    if (action === 'backup') { const r = await act('backup', {}); toast(`Backup written: ${r.file}`); }
    if (action === 'hide-key') delete drafts.newKey;
    if (action === 'copy-complete') {
      const src = S.strategies.find((s) => s.id === 'complete');
      drafts.strategy = { key: 'new', value: { ...structuredClone(src), id: 'my-checklist', name: 'My checklist', copyFrom: 'complete' } };
      location.hash = '#/strategies/new';
      return;
    }
    if (['confirm-evidence', 'verify-evidence', 'prepare-mark'].includes(action)) el.disabled = true; // one click is enough
    if (action === 'confirm-evidence') { await act('evidence.add', { confirms: el.dataset.id }); toast('Confirmed. It counts from now.'); }
    if (action === 'verify-evidence') {
      const goodUntil = el.closest('.verify')?.querySelector('[data-verify-date]')?.value || undefined;
      const r = await act('evidence.verify', { id: el.dataset.id, goodUntil });
      toast(`Verified. It counts until ${r.goodUntil} (India date).`);
    }
    if (action === 'prep-redraw') { /* the render below draws the newer copy */ }
    if (action === 'prepare-mark') {
      const d = el.dataset;
      await act('prepare.mark', { symbol: d.symbol, strategyId: d.strategy || undefined, itemId: d.itemid, exchange: d.exchange, evidenceId: d.evidence || undefined, yes: d.yes === '1' });
      toast(d.yes === '1' ? 'Marked as checked. It counts only after the wait (the strategy’s buffer days).' : 'Mark removed. Prepare it again when you have checked it.');
    }
    if (action === 'trash') {
      await act('trash.move', { kind: el.dataset.kind, id: el.dataset.id });
      toast('Moved to the Trash. You can restore it from the Trash page.');
      const parent = { request: '#/requests', strategy: '#/strategies', playbook: '#/playbooks' }[el.dataset.kind];
      if (parent && location.hash.includes(el.dataset.id)) location.hash = parent;
      main.focus();
    }
    if (action === 'restore') { await act('trash.restore', { kind: el.dataset.kind, id: el.dataset.id }); toast('Restored.'); }
    if (action === 'page') pageAt[el.dataset.key] = Number(el.dataset.to);
    if (action === 'ledger-more') {
      const older = await api(`/api/ledger?before=${ledgerCache.events.at(-1).seq}`);
      ledgerCache.events.push(...older.events);
      ledgerCache.more = older.events.length === 100;
      pageAt.ledger = Math.ceil((ledgerCache.events.length - older.events.length) / 25) + 1;
    }
    if (['add-item', 'remove-item', 'refresh-items'].includes(action)) {
      const form = el.closest('form');
      const s = readStrategy(form);
      if (action === 'add-item') s.items.push({ id: `item-${s.items.length + 1}`, type: 'attest', label: '', required: true });
      if (action === 'remove-item') s.items.splice(Number(el.dataset.n), 1);
      drafts.strategy = { key: form.dataset.key, value: s };
    }
    render();
    if (action === 'page' || action === 'ledger-more') {
      const nav = main.querySelector(`.pager[data-key="${CSS.escape(el.dataset.key ?? 'ledger')}"]`);
      (nav?.querySelector(`button:not(:disabled)`) ?? main).focus();
    }
  } catch (err) {
    toast(err.message, true);
    if (el.isConnected) el.disabled = false;
  }
});

// Funding fields: convert the typed value when the mode flips, keep the hint live,
// and hide them for Regular buys.
document.addEventListener('change', (e) => {
  const box = e.target.closest('[data-funding]');
  if (box && e.target.name === 'fundingMode') {
    const mode = e.target.value;
    const v = Number(box.querySelector('[name=fundingValue]').value);
    try { localStorage.setItem('fundingMode', mode); } catch { /* preference only */ }
    const form = box.closest('form');
    box.outerHTML = fundingFields(box.dataset.label, mode, v > 0 ? trim(100 / v) : '');
    addInfoButtons(form);
    form.querySelector('[data-funding] [name=fundingMode]')?.focus();
  }
  if (e.target.name === 'buyType') syncFunding(e.target.form);
  const form = e.target.form;
  if (form?.dataset.form === 'plan' && e.target.name === 'strategyId') applyPlanDefaults(form, e.target.value);
  if (form?.dataset.form === 'settings' && e.target.name === 'preset' && e.target.value !== 'custom') applyRiskPreset(form, e.target.value);
  if (form?.dataset.form === 'agent-add' && e.target.name === 'agentPreset') applyAgentPreset(form, e.target.value);
  if (form?.dataset.form === 'playbook' && e.target.name === 'template') { drafts.playbookTemplate = e.target.value; render(); }
  if (form?.dataset.form === 'strategy' && e.target.name === 'libraryPick' && e.target.value) {
    const s = readStrategy(form);
    const [kind, id] = e.target.value.split(':');
    const group = S.meta.checklist.groups.find((g) => (kind === 'group' ? g.id === id : g.items.some((i) => i.id === id)));
    const picked = kind === 'group' ? group.items : group.items.filter((i) => i.id === id);
    const added = picked.filter((i) => !s.items.some((x) => x.id === i.id)).map((i) => toStrategyItem(i, group.id));
    s.items.push(...added);
    drafts.strategy = { key: form.dataset.key, value: { ...s, copyFrom: drafts.strategy?.value?.copyFrom } };
    render();
    toast(added.length ? `Added ${added.length} check(s). Review them below, then save.` : 'Those checks are already in this strategy.');
  }
  if (form?.dataset.form === 'strategy' && e.target.name === 'copyFrom') {
    const src = S.strategies.find((s) => s.id === e.target.value);
    drafts.strategy = src ? { key: 'new', value: { ...structuredClone(src), id: `my-${src.id}`, name: `My ${src.name}`, copyFrom: src.id } } : null;
    render();
  }
});

// ---------- ready-made starting points ----------

function setValue(form, name, value) {
  const el = form.elements[name];
  if (el) el.value = value;
}

/** Fill a strategy’s usual hold days and buy type in New plan. */
function applyPlanDefaults(form, strategyId) {
  const d = S.meta.presets.plan[strategyId] ?? S.meta.presets.plan.default;
  setValue(form, 'days', d.days);
  setValue(form, 'buyType', d.buyType);
  if (d.buyType === 'mtf') {
    const mode = form.elements.fundingMode?.value;
    setValue(form, 'fundingValue', mode === 'cash' ? trim(100 / d.leverage) : d.leverage);
    form.elements.fundingValue?.dispatchEvent(new Event('input', { bubbles: true }));
  }
  syncFunding(form);
  toast(`Filled the usual values for this strategy (${d.days} days, ${d.buyType === 'mtf' ? `MTF ${d.leverage}×` : 'Regular'}). Change anything you like.`);
}

function riskPresetValues(key, capital) {
  const { cashPerTradePct, ...rest } = S.meta.presets.risk[key].values;
  return { ...rest, cashPerTrade: Math.max(100, Math.round((capital * cashPerTradePct) / 100)) };
}

function applyRiskPreset(form, key) {
  const capital = Number(form.elements.capital.value) || S.status.settings.capital;
  for (const [k, v] of Object.entries(riskPresetValues(key, capital))) setValue(form, k, v);
}

function applyAgentPreset(form, key) {
  const p = S.meta.presets.agents[key];
  if (!p) return;
  setValue(form, 'scope', p.scope);
  for (const [k, v] of Object.entries(p.limits)) setValue(form, k, v);
}

// Typing your own number turns a preset choice into “Custom”.
document.addEventListener('input', (e) => {
  const form = e.target.form;
  if (form?.dataset.form === 'settings' && e.target.dataset.num !== undefined && e.target.name !== 'capital') {
    const custom = form.querySelector('input[name=preset][value=custom]');
    if (custom) custom.checked = true;
  }
  if (form?.dataset.form === 'settings' && e.target.name === 'capital') {
    const chosen = form.querySelector('input[name=preset]:checked')?.value;
    if (chosen && chosen !== 'custom') setValue(form, 'cashPerTrade', riskPresetValues(chosen, Number(e.target.value) || 0).cashPerTrade);
  }
  if (form?.dataset.form === 'agent-add' && e.target.name === 'scope') {
    // Changing access also brings that access level's usual limits (e.g. Propose → 5 requests a day).
    const match = Object.entries(S.meta.presets.agents).find(([, p]) => p.scope === e.target.value)?.[0];
    if (match) applyAgentPreset(form, match);
    setValue(form, 'agentPreset', match ?? 'custom');
  }
  if (form?.dataset.form === 'agent-add' && ['intentsPerDay', 'writesPerDay', 'callsPerHour'].includes(e.target.name)) setValue(form, 'agentPreset', 'custom');
});
document.addEventListener('input', (e) => {
  const box = e.target.closest('[data-funding]');
  if (box && e.target.name === 'fundingValue') {
    box.querySelector('.funding-hint').textContent = fundingHint(box.querySelector('[name=fundingMode]').value, e.target.value);
  }
});
function syncFunding(form) {
  const type = form?.elements.buyType;
  const box = form?.querySelector('[data-funding]');
  if (type && box) box.hidden = type.value !== 'mtf';
}

// ---------- update check ----------

/** Must match API_VERSION in src/version.js. Bump both when the page needs new server data. */
const CLIENT_API = 4;
const serverIsOld = () => (S?.meta?.api ?? 1) < CLIENT_API;

/** The server keeps its code in memory; after an update it must be restarted. */
function restartBanner() {
  if (!serverIsOld() && !S?.meta?.restartNeeded) return '';
  return `<div class="banner" role="alert"><b>Swing Desk was updated. Please restart it.</b>
    Close the black “Swing Desk” window (or press Ctrl + C in it), then double-click <b>Swing Desk</b> on your Desktop (or start.cmd).
    ${serverIsOld() ? 'Until then, some pages cannot open.' : 'Until then, the newest changes are not active.'}
    If Claude Code is connected, start a new Claude conversation afterwards too.</div>`;
}

// ---------- routing ----------

function render() {
  let [route = 'today', ...args] = location.hash.replace(/^#\/?/, '').split('/');
  // The Research page is gone: its parts live on Prepare, the stock pages and Today.
  if (route === 'research') { history.replaceState(null, '', '#/stocks'); [route, args] = ['stocks', []]; }
  const page = pages[route] ?? pages.today;
  let html;
  try {
    html = page(...args.map((a) => decodeURIComponent(a)));
  } catch (err) {
    // Never leave a page silently unchanged: say what happened and what to do.
    console.error(err);
    html = `<section class="card highlight" role="alert"><h1>This page could not open</h1>
      <p>${serverIsOld() ? 'Swing Desk was updated but the old version is still running. Restart it (see the message above).' : 'Reload the page. If it keeps happening, restart Swing Desk.'}</p>
      <p class="small muted">Details: ${esc(err.message)}</p></section>`;
  }
  main.innerHTML = restartBanner() + html;
  addInfoButtons(main);
  addFolds(main, route, !args.length && FOLDED_AT_FIRST.has(route));
  document.querySelectorAll('form').forEach(syncFunding);
  // Fill the activity/ledger lists only after the page markup exists.
  if (page === pages.today || page === pages.ledger) loadLedger();
  for (const a of document.querySelectorAll('.side a')) a.toggleAttribute('aria-current', a.dataset.route === route || (route === 'request' && a.dataset.route === 'requests') || (route === 'stock' && a.dataset.route === 'stocks'));
  const pending = S.intents.filter((i) => i.status === 'pending').length;
  const count = $('#pending-count');
  count.hidden = !pending;
  count.textContent = pending;
  const trashCount = $('#trash-count');
  trashCount.hidden = !S.trash.length;
  trashCount.textContent = S.trash.length;
  $('#automation').innerHTML = S.status.automationPaused
    ? '<p class="small">Agents are <b>paused</b></p><a class="btn" href="#/settings">Resume agents…</a>'
    : `<p class="small">Agents: ${S.agents.filter((a) => !a.revoked && a.scope !== 'off').length} active</p><button class="btn danger" data-action="pause">Pause all agents</button>`;
}

window.addEventListener('hashchange', () => {
  if (!S) return; // first load still running; it renders the current hash when done
  main.focus();
  render();
});

setInterval(async () => {
  if (document.hidden || document.activeElement?.closest('form, details[open]') || document.querySelector('details[open]')) return;
  try { await refresh(); render(); } catch { /* keep current view */ }
}, 20_000);

(async () => {
  try {
    csrf = (await api('/api/session')).csrf;
    await refresh();
    render();
  } catch (err) {
    main.innerHTML = `<p class="bad">${esc(err.message)}</p>`;
  }
})();
