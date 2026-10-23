// Swing Desk Agent – owner web app. Plain ES module, no build step, no dependencies.

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
  const a = S?.agents.find((x) => `agent:${x.id}` === actor);
  return a ? `${a.name} (agent)` : actor;
};
const byLine = (actor) => (actor === 'owner' ? 'You' : `${esc(actorName(actor))} · <span class="tag tag-warn">not verified</span>`);
const STATUS_TAG = { pass: 'tag-ok', fail: 'tag-bad', stale: 'tag-warn', ask: 'tag-ask', info: 'tag-muted' };
const STATUS_TEXT = { pass: 'Pass', fail: 'Fail', stale: 'Needs update', ask: 'Your answer', info: 'Note' };
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
  const res = await fetch(path, { ...init, headers: { 'X-CSRF': csrf, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
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
  ledgerCache = null;
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

const field = (label, input, hint = '') => `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
const num = (name, value = '', attrs = '') => `<input name="${name}" type="number" step="any" inputmode="decimal" data-num value="${esc(value)}" ${attrs}>`;
const pinField = () => field('Approval PIN', '<input name="pin" type="password" inputmode="numeric" autocomplete="off" required minlength="6" maxlength="12">');
const options = (list, selected) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(l)}</option>`).join('');
const tag = (status) => `<span class="tag ${STATUS_TAG[status] || 'tag-muted'}">${STATUS_TEXT[status] || esc(status)}</span>`;

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
        <div class="actions"><a class="btn" href="#/research">Add broker price</a><a class="btn primary" href="#/plan">New plan</a></div></header>
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
        </div>
        <div class="col-side">
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
        return list.length ? `<section class="card"><h2>${g[0].toUpperCase() + g.slice(1)}</h2><ul class="rows">${list.map(requestRow).join('')}</ul></section>` : '';
      }).join('') || '<p class="muted">No requests yet.</p>'}`;
  },

  request(id) {
    const i = S.intents.find((x) => x.id === id);
    if (!i) return '<p>That request was not found.</p>';
    const title = i.kind === 'buy' ? `Buy ${i.symbol}` : i.kind === 'exit' ? `Sell ${i.symbol}` : 'Change risk settings';
    const head = `<header class="page-head"><div><a href="#/requests">Back to requests</a><h1>${esc(title)} <span class="tag tag-muted">${esc(i.status)}</span></h1>
      <p class="muted">From ${byLine(i.by)} · ${when(i.at)}${i.status === 'pending' ? ` · expires ${when(i.expiresAt)}` : ''}${i.strategyName ? ` · strategy: ${esc(i.strategyName)}` : ''}</p></div></header>`;
    const thesis = `<section class="card"><h2>Reason given</h2>${i.by === 'owner' ? '' : '<p class="small"><span class="tag tag-warn">Written by a model · not verified</span></p>'}<blockquote>${esc(i.thesis)}</blockquote>${evidenceFor(i)}</section>`;
    if (i.status === 'pending') return head + pendingRequest(i) + thesis;
    return head + decidedRequest(i) + thesis;
  },

  plan() {
    const strategies = S.strategies.filter((s) => s.enabled);
    const d = drafts.plan ?? { exchange: 'NSE', buyType: 'mtf', fundingMode: fundingMode(), fundingValue: fundingMode() === 'cash' ? 50 : 2, days: 10, strategyId: strategies[0]?.id };
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
      <section class="card"><h2>Closed lots</h2>${closed.length ? lotsTable(closed, true) : '<p class="muted">None yet.</p>'}</section>`;
  },

  research() {
    const kinds = Object.entries(S.meta.evidenceKinds);
    return `<header class="page-head"><h1>Research</h1></header>
      <div class="cols">
        <div class="col-side">
          <form class="card form" data-form="quote"><h2>Broker price</h2><p class="small muted">Copy the price from Kite now, or confirm an agent’s price in the Evidence list. It counts for 5 minutes.</p>
            ${field('Stock', '<input name="symbol" required autocapitalize="characters">')}${field('Price ₹', num('price', '', 'required'))}
            <button class="btn primary">Save price</button></form>
          <form class="card form" data-form="funding"><h2>MTF requirement</h2><p class="small muted">From Kite’s MTF stock list, today. Counts for today only.</p>
            ${field('Stock', '<input name="symbol" required autocapitalize="characters">')}${fundingFields('Kite shows it as', fundingMode())}
            ${field('Where you checked', '<input name="summary" value="Kite MTF list">')}
            <button class="btn primary">Save requirement</button></form>
          <form class="card form" data-form="evidence"><h2>Other evidence</h2>
            ${field('Kind', `<select name="kind">${options(kinds.filter(([k]) => !['quote', 'funding'].includes(k)), 'news')}</select>`)}
            ${field('Stock', '<input name="symbol" required autocapitalize="characters">')}
            ${field('What you found', '<textarea name="summary" rows="3" required></textarea>')}
            ${field('Link (optional)', '<input name="source" type="url">')}
            <button class="btn primary">Save evidence</button></form>
        </div>
        <div class="col-main">
          <section class="card"><h2>Evidence</h2>${S.evidence.length ? `<ul class="rows">${S.evidence.map(evidenceRow).join('')}</ul>` : '<p class="muted">None yet.</p>'}</section>
          <section class="card"><h2>Notes</h2>${S.notes.length ? S.notes.map((n) => `<article class="note"><h3>${esc(n.symbol ? `${n.symbol} · ` : '')}${esc(n.title)}</h3><p class="small muted">${byLine(n.by)} · ${when(n.at)}</p><p class="pre">${esc(n.body)}</p>${sourcesList(n.sources)}</article>`).join('') : '<p class="muted">Agents with Draft access can add notes.</p>'}</section>
        </div>
      </div>`;
  },

  strategies(id) {
    if (id) return strategyEditor(id);
    return `<header class="page-head"><h1>Strategies</h1><a class="btn primary" href="#/strategies/new">New strategy</a></header>
      <p class="lead">Each strategy has its own checklist. Every buy must name one. The built-in strategies are starting templates, not recommendations.</p>
      ${S.strategies.map((s) => `<section class="card"><div class="card-head"><h2>${esc(s.name)} <span class="tag tag-muted">v${s.version}</span>${s.enabled ? '' : ' <span class="tag tag-muted">off</span>'}</h2><a href="#/strategies/${esc(s.id)}">Edit</a></div>
        <p class="muted">${esc(s.description)}</p><ul class="checklist">${s.items.map((it) => `<li><span class="tag tag-muted">${it.type === 'attest' ? 'You answer' : it.type === 'evidence' ? `Evidence: ${esc(it.kind)}` : 'Rule'}</span> ${esc(it.label)}${it.required ? '' : ' <span class="muted">(optional)</span>'}</li>`).join('')}</ul></section>`).join('')}`;
  },

  playbooks(id) {
    if (id) return playbookEditor(id);
    return `<header class="page-head"><h1>Playbooks</h1><a class="btn primary" href="#/playbooks/new">New playbook</a></header>
      <p class="lead">A playbook is a repeating job. At its time the desk queues a task; the assigned model app picks it up with <code>next_task</code>, follows your instructions and reports back. The desk never needs its own model key. There is no holiday calendar: switch playbooks off on market holidays.</p>
      ${S.playbooks.length ? S.playbooks.map((pb) => `<section class="card"><div class="card-head"><h2>${esc(pb.name)} ${pb.enabled ? '<span class="tag tag-ok">On</span>' : '<span class="tag tag-muted">Off</span>'}</h2><a href="#/playbooks/${esc(pb.id)}">Edit</a></div>
        <p class="muted">${esc(scheduleText(pb.schedule))} · run by ${esc(S.agents.find((a) => a.id === pb.agentId)?.name ?? 'nobody')} · up to ${pb.maxIntents} request(s) per run</p><p class="pre small">${esc(pb.instructions)}</p></section>`).join('') : '<p class="muted">No playbooks yet.</p>'}
      <section class="card"><h2>Recent tasks</h2>${S.tasks.length ? `<ul class="rows">${S.tasks.map((t) => `<li><div><b>${esc(S.playbooks.find((p) => p.id === t.playbookId)?.name ?? t.playbookId)}</b> <span class="tag tag-muted">${esc(t.status)}</span><div class="small muted">Due ${when(t.dueAt)}</div>${t.summary ? `<p class="pre small">${esc(t.summary)}</p>` : ''}</div></li>`).join('')}</ul>` : '<p class="muted">No tasks yet.</p>'}</section>`;
  },

  agents() {
    const shown = drafts.newKey;
    return `<header class="page-head"><h1>Agents &amp; MCP</h1></header>
      <p class="lead">Connect any model app that speaks MCP. Each connection gets its own key, access level and limits. No level can approve, place orders, change access, edit strategies or delete history.</p>
      ${shown ? `<section class="card highlight"><h2>Key for ${esc(shown.name)} — shown once</h2><p>Add this to the model app’s MCP settings. Anyone with this key can act as this agent.</p><pre class="code">${esc(JSON.stringify({ mcpServers: { 'swing-desk': { ...S.meta.mcp, env: { ...(S.meta.mcp.env || {}), SWING_DESK_AGENT_KEY: shown.key } } } }, null, 2))}</pre><button class="btn" data-action="hide-key">I have saved it</button></section>` : ''}
      <section class="card"><h2>Connections</h2>${S.agents.length ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Access</th><th>Limits</th><th>Today</th><th>Key expires</th><th></th></tr></thead><tbody>
        ${S.agents.map((a) => { const u = a.usage[S.status.today] ?? { writes: 0, intents: 0 }; return `<tr><td><b>${esc(a.name)}</b><div class="small muted">${esc(a.client)}</div></td><td>${a.revoked ? '<span class="tag tag-bad">revoked</span>' : `<span class="tag scope-${a.scope}">${a.scope}</span>`}</td><td class="small">${a.limits.intentsPerDay} requests/day · ${a.limits.writesPerDay} writes/day · ${a.limits.callsPerHour} calls/hour</td><td class="small">${u.intents} requests · ${u.writes} writes</td><td class="small">${when(a.expiresAt)}</td>
        <td>${a.revoked ? '' : `<details><summary class="btn">Change</summary><form class="form" data-form="agent-update"><input type="hidden" name="id" value="${esc(a.id)}">${field('Access', `<select name="scope">${options(['off', 'read', 'draft', 'propose'].map((s) => [s, s]), a.scope)}</select>`)}${field('Requests per day', num('intentsPerDay', a.limits.intentsPerDay, 'step="1" min="0"'))}${field('Writes per day', num('writesPerDay', a.limits.writesPerDay, 'step="1" min="0"'))}${field('Calls per hour', num('callsPerHour', a.limits.callsPerHour, 'step="1" min="0"'))}${field('Revoke this key', '<input type="checkbox" name="revoked">')}${pinField()}<div class="actions"><button class="btn primary">Save</button><button class="btn" name="rekey" value="1">New key</button></div></form></details>`}</td></tr>`; }).join('')}
        </tbody></table></div>` : '<p class="muted">No agents yet.</p>'}</section>
      <form class="card form" data-form="agent-add"><h2>Add an agent</h2>
        <div class="grid">${field('Name', '<input name="name" required placeholder="Research agent">')}${field('App', '<input name="client" placeholder="Claude Desktop">')}
        ${field('Access', `<select name="scope">${options(['off', 'read', 'draft', 'propose'].map((s) => [s, s]), 'off')}</select>`)}${field('Key lifetime (days)', num('expiresDays', 30, 'step="1" min="1" max="365"'))}</div>
        <ul class="small muted">${Object.entries(SCOPE_HELP).map(([k, v]) => `<li><b>${k}</b>: ${v}</li>`).join('')}</ul>
        ${pinField()}<button class="btn primary">Create agent and key</button></form>
      <section class="card"><h2>Recent MCP calls</h2>${S.calls.length ? `<ul class="rows">${S.calls.map((c) => `<li><span>${esc(S.agents.find((a) => a.id === c.agent_id)?.name ?? c.agent_id)} · <code>${esc(c.tool)}</code> ${c.ok ? '' : `<span class="tag tag-bad">${esc(c.error)}</span>`}</span><span class="small muted">${when(c.at)}</span></li>`).join('')}</ul>` : '<p class="muted">No calls yet.</p>'}</section>`;
  },

  ledger() {
    return `<header class="page-head"><h1>Ledger</h1></header>
      <p class="lead">Every change is a new entry. Nothing is edited or deleted. Each entry includes a fingerprint of the one before it, so tampering shows up.</p>
      <section class="card"><div id="chain" class="muted">Checking…</div><ul class="rows" id="ledger-rows"><li class="muted">Loading…</li></ul></section>`;
  },

  settings() {
    const st = S.status.settings;
    return `<header class="page-head"><h1>Settings</h1></header>
      ${S.pinSet ? '' : '<section class="card highlight"><h2>Set your approval PIN first</h2><p>Approvals, agent access, strategies and playbooks need this PIN. Keep it out of any model app’s reach.</p></section>'}
      ${S.status.automationPaused ? `<form class="card form highlight" data-form="resume"><h2>Agents are paused</h2><p>Resuming lets connected agents call the desk again.</p>${pinField()}<button class="btn primary">Resume agents</button></form>` : ''}
      <form class="card form" data-form="settings"><h2>Risk limits</h2><p class="small muted">Changing these never changes past trades.</p>
        <div class="grid">${Object.entries(S.meta.settingRules).map(([k, r]) => field(esc(r.label), num(k, st[k], `min="${r.min}" max="${r.max}"`))).join('')}</div>
        ${pinField()}<button class="btn primary">Save limits</button></form>
      <form class="card form" data-form="pin"><h2>${S.pinSet ? 'Change' : 'Set'} approval PIN</h2>
        ${S.pinSet ? field('Current PIN', '<input name="oldPin" type="password" inputmode="numeric" autocomplete="off" required>') : ''}
        ${field('New PIN (6–12 digits)', '<input name="pin" type="password" inputmode="numeric" autocomplete="off" required minlength="6" maxlength="12" pattern="[0-9]{6,12}">')}
        <button class="btn primary">Save PIN</button></form>
      <section class="card"><h2>Backup</h2><p class="muted">Writes a full copy of the database to your backup folder.</p><button class="btn" data-action="backup">Back up now</button></section>
      <section class="card"><h2>Charges</h2><p class="muted">Zerodha rates checked ${esc(S.status.fees.checkedOn)} (${esc(S.status.fees.source)}). Each approved buy keeps a frozen copy.</p></section>`;
  },
};

// ---------- page pieces ----------

function tile(label, value, used, limit, hint) {
  return `<div class="tile"><div class="muted small">${label}</div><div class="tile-value mono">${value}</div><meter min="0" max="${Math.max(1, limit)}" value="${Math.min(Math.max(0, used), limit)}" high="${limit * 0.8}" optimum="0"></meter><div class="small muted">${hint}</div></div>`;
}

function requestRow(i) {
  const label = i.kind === 'buy' ? `Buy ${i.symbol}` : i.kind === 'exit' ? `Sell ${i.qty} ${i.symbol}` : `Settings: ${Object.keys(i.patch).join(', ')}`;
  const blockers = i.evaluation ? i.evaluation.checks.filter((c) => c.required && c.status !== 'pass') : [];
  const detail = i.status === 'pending' ? (blockers.length ? `${blockers.length} item(s) need attention` : 'All checks pass') : i.status === 'approved' ? 'Approved · record the fill after you place it in Kite' : '';
  return `<li><div><a href="#/request/${esc(i.id)}"><b>${esc(label)}</b></a> <span class="tag tag-muted">${esc(i.status)}</span><div class="small muted">${byLine(i.by)} · ${when(i.at)}${detail ? ` · ${detail}` : ''}</div></div><a class="btn" href="#/request/${esc(i.id)}">Open</a></li>`;
}

function pendingRequest(i) {
  const ev = i.evaluation;
  const sizing = ev.sizing;
  const quoteFix = ev.checks.some((c) => c.id === 'quote' && c.status !== 'pass');
  const fundingFix = ev.checks.some((c) => c.id === 'funding' && c.status !== 'pass');
  const attest = ev.checks.filter((c) => c.status === 'ask');
  const planCard = sizing ? `<section class="card"><h2>The plan, recalculated by the desk</h2><p class="small muted">The agent’s numbers are not trusted. Size and charges come from your saved limits.</p>
    <div class="stats">${[['Entry', price(ev.plan.entry)], ['Stop', price(ev.plan.stop)], ['Target', price(ev.plan.target)], ['Shares', sizing.qty], ['Type', ev.plan.buyType === 'mtf' ? `MTF ${funding(ev.plan.marginPct)}` : 'Regular'], ['Hold up to', `${ev.plan.days} days`], ['Loss at stop', money(sizing.riskAtStop)], ['Gain at target', money(sizing.rewardAtTarget)]].map(([k, v]) => `<div><span>${k}</span><b class="mono">${v}</b></div>`).join('')}</div>
    <p>In plain words: you put in ${money(sizing.ownCash)} of your own cash${sizing.borrowed > 0 ? ` and borrow ${money(sizing.borrowed)} (interest about ${money(sizing.interestPerDay)} a day)` : ''}. If the price falls to the stop you lose about ${money(sizing.riskAtStop)} including charges and a ${price(sizing.slipPerShare)}/share worse-price allowance. At the target you gain about ${money(sizing.rewardAtTarget)}.</p></section>` : '';
  return `${planCard}
    <section class="card"><h2>Checks</h2><ul class="rows">${ev.checks.map((c) => `<li><div>${tag(c.status)} <b>${esc(c.label)}</b>${c.required ? '' : ' <span class="muted small">(optional)</span>'}<div class="small muted">${esc(c.detail)}</div></div></li>`).join('')}</ul>
      ${quoteFix ? agentFinding(i.symbol, 'quote') : ''}
      ${fundingFix ? agentFinding(i.symbol, 'funding') : ''}
      ${quoteFix ? `<form class="form inline" data-form="quote" data-symbol="${esc(i.symbol)}">${field(`Price in Kite now for ${esc(i.symbol)} ₹`, num('price', '', 'required'))}<button class="btn">Save fresh price</button></form>` : ''}
      ${fundingFix ? `<form class="form inline" data-form="funding" data-symbol="${esc(i.symbol)}">${fundingFields('MTF limit from Kite today, as', fundingMode())}<button class="btn">Save requirement</button></form>` : ''}
    </section>
    <form class="card form" data-form="approve" data-id="${esc(i.id)}"><h2>Your decision</h2>
      ${attest.length ? `<fieldset><legend>Answer the checklist yourself</legend>${attest.map((c) => `<label class="check"><input type="checkbox" name="answer:${esc(c.id.slice(5))}"> <span>${esc(c.label)}</span></label>`).join('')}</fieldset>` : ''}
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
  return `${items.length ? `<h3>Evidence it points to</h3><ul class="rows">${items.map(evidenceRow).join('')}</ul>` : ''}${claims.length ? `<h3>Agent’s checklist claims</h3><ul class="rows">${claims.map(([k, v]) => `<li><span><b>${esc(k)}</b>: ${esc(v)}</span></li>`).join('')}</ul>` : ''}`;
}

function evidenceRow(e) {
  const value = e.kind === 'quote' ? price(e.price) : e.kind === 'funding' ? `up to ${funding(e.marginPct)}` : esc(e.summary);
  return `<li><div><b>${esc(e.symbol)}</b> <span class="tag tag-muted">${esc(e.kind)}</span> ${value}<div class="small muted">${byLine(e.by)} · observed ${when(e.observedAt)}${e.confirms ? ' · confirmed against Kite' : ''}</div>${sourcesList(e.sources)}</div>${confirmButton(e)}</li>`;
}

/** Agent-found prices and MTF requirements count only after the owner checks them in Kite. */
function confirmButton(e) {
  if (!['quote', 'funding'].includes(e.kind) || e.by === 'owner') return '';
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

function lotsTable(lots, closed = false) {
  if (!lots.length) return '<p class="muted">None.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Stock</th><th>Type</th><th class="num">Shares</th><th class="num">Buy price</th><th class="num">${closed ? 'Result' : 'Stop'}</th><th class="num">${closed ? 'Charges' : 'Risk left'}</th><th>Bought</th></tr></thead><tbody>
    ${lots.map((l) => `<tr><td><b>${esc(l.symbol)}</b> <span class="small muted">${esc(l.exchange)}</span></td><td>${l.buyType === 'mtf' ? `MTF ${lev(l.marginPct)}` : 'Regular'}</td><td class="num mono">${closed ? l.qty : `${l.remaining}${l.remaining !== l.qty ? ` of ${l.qty}` : ''}`}</td><td class="num mono">${price(l.entry)}</td><td class="num mono">${closed ? money(l.realised) : price(l.stop)}</td><td class="num mono">${closed ? money(l.sales.reduce((a, s) => a + s.charges, 0)) : money(l.risk)}</td><td>${esc(l.date)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function lotCard(l) {
  return `<article class="lot"><div class="card-head"><h3>${esc(l.symbol)} · ${l.remaining} shares at ${price(l.entry)}</h3><span class="muted small">${l.buyType === 'mtf' ? `MTF ${lev(l.marginPct)}` : 'Regular'} · bought ${esc(l.date)}</span></div>
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
  const base = id === 'new' ? { id: '', name: '', description: '', enabled: true, items: [{ id: 'item-1', type: 'attest', label: '', required: true }] } : S.strategies.find((s) => s.id === id);
  if (!base) return '<p>Strategy not found.</p>';
  const d = (drafts.strategy?.key === id ? drafts.strategy.value : null) ?? structuredClone(base);
  const kinds = Object.keys(S.meta.evidenceKinds);
  return `<header class="page-head"><div><a href="#/strategies">Back to strategies</a><h1>${id === 'new' ? 'New strategy' : `Edit ${esc(base.name)}`}</h1></div></header>
    <p class="lead">Saving creates a new version. Requests made against the old version can no longer be approved.</p>
    <form class="card form" data-form="strategy" data-key="${esc(id)}">
      <div class="grid">${field('Id (letters, digits, dashes)', `<input name="id" required value="${esc(d.id)}" ${id === 'new' ? '' : 'readonly'}>`)}${field('Name', `<input name="name" required value="${esc(d.name)}">`)}</div>
      ${field('Description', `<input name="description" value="${esc(d.description)}">`)}
      <label class="check"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}> <span>Agents can use this strategy</span></label>
      <h2>Checklist</h2>
      ${d.items.map((it, n) => `<fieldset class="item-row"><legend>Item ${n + 1}</legend><div class="grid">
        ${field('Id', `<input data-item="id" value="${esc(it.id)}" required>`)}
        ${field('Type', `<select data-item="type">${options([['attest', 'You answer yes/no'], ['evidence', 'Needs evidence'], ['rule', 'Fixed rule']], it.type)}</select>`)}
        ${it.type === 'rule' ? field('Rule', `<select data-item="rule">${options(S.meta.ruleKinds.map((r) => [r, r]), it.rule)}</select>`) + field('Value', `<input data-item="value" value="${esc(it.value ?? '')}">`, 'regularOnly: true') : field('Label', `<input data-item="label" value="${esc(it.label)}" required>`)}
        ${it.type === 'evidence' ? field('Evidence kind', `<select data-item="kind">${options(kinds.map((k) => [k, k]), it.kind)}</select>`) + field('Max age (days, 0 = today)', `<input data-item="maxAgeDays" type="number" min="0" max="30" step="1" value="${esc(it.maxAgeDays ?? 0)}">`) : ''}
        ${it.type !== 'rule' ? field('Required', `<input type="checkbox" data-item="required" ${it.required !== false ? 'checked' : ''}>`) : ''}
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
  return { id: top.id, name: top.name, description: top.description, enabled: top.enabled, items, pin: top.pin };
}

function playbookEditor(id) {
  const base = id === 'new' ? { name: '', agentId: S.agents[0]?.id ?? '', schedule: { days: [1, 2, 3, 4, 5], at: '15:50' }, instructions: '', maxIntents: 0, enabled: true } : S.playbooks.find((p) => p.id === id);
  if (!base) return '<p>Playbook not found.</p>';
  const s = base.schedule;
  return `<header class="page-head"><div><a href="#/playbooks">Back to playbooks</a><h1>${id === 'new' ? 'New playbook' : `Edit ${esc(base.name)}`}</h1></div></header>
    <form class="card form" data-form="playbook" data-id="${id === 'new' ? '' : esc(id)}">
      <div class="grid">${field('Name', `<input name="name" required value="${esc(base.name)}">`)}
      ${field('Run by', `<select name="agentId">${options([['', 'Nobody (off)'], ...S.agents.filter((a) => !a.revoked).map((a) => [a.id, `${a.name} (${a.scope})`])], base.agentId)}</select>`)}
      ${field('Requests allowed per run', num('maxIntents', base.maxIntents, 'step="1" min="0" max="20"'), 'Only agents with Propose access can send requests.')}</div>
      <fieldset><legend>Days</legend>${DAYS.map((d, n) => `<label class="check inline"><input type="checkbox" name="day${n}" ${s.days.includes(n) ? 'checked' : ''}> <span>${d}</span></label>`).join('')}</fieldset>
      <fieldset><legend>When (India time)</legend>
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
    ledgerCache ??= await api('/api/ledger');
  } catch (err) {
    return toast(err.message, true);
  }
  const rows = ledgerCache.events.map((e) => `<li><div><b>${esc(describe(e))}</b><div class="small muted">#${e.seq} · ${esc(actorName(e.actor))} · ${when(e.at)}</div></div></li>`).join('');
  const activity = $('#activity');
  if (activity) activity.innerHTML = ledgerCache.events.filter((e) => !e.type.startsWith('task.')).slice(0, 8).map((e) => `<li><div>${esc(describe(e))}<div class="small muted">${esc(actorName(e.actor))} · ${when(e.at)}</div></div></li>`).join('') || '<li class="muted">Nothing yet.</li>';
  const list = $('#ledger-rows');
  if (list) list.innerHTML = rows || '<li class="muted">No entries yet.</li>';
  const chain = $('#chain');
  if (chain) chain.innerHTML = ledgerCache.chain.ok ? `<span class="tag tag-ok">Chain intact</span> ${ledgerCache.chain.count} entries` : `<span class="tag tag-bad">Chain broken at #${ledgerCache.chain.brokenAt}</span> Restore from a backup.`;
}

function describe(e) {
  const d = e.data;
  const map = {
    'settings.changed': () => `Changed limits: ${Object.keys(d.patch).join(', ')}`,
    'automation.paused': () => 'Paused all agents',
    'automation.resumed': () => 'Resumed agents',
    'strategy.saved': () => `Saved strategy ${d.name} (v${d.version})`,
    'agent.added': () => `Added agent ${d.name} (${d.scope})`,
    'agent.updated': () => `Updated agent ${S.agents.find((a) => a.id === d.id)?.name ?? d.id}${d.scope ? ` → ${d.scope}` : ''}${d.revoked ? ' (revoked)' : ''}`,
    'evidence.added': () => `Evidence for ${d.symbol}: ${d.kind}${d.price ? ` ${price(d.price)}` : ''}`,
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
    await act('evidence.add', { kind: 'quote', symbol: form.dataset.symbol || data.symbol, price: data.price });
    toast('Price saved. It counts for 5 minutes.');
  },
  async funding(form, data) {
    await act('evidence.add', { kind: 'funding', symbol: form.dataset.symbol || data.symbol, ...fundingInput(data), summary: data.summary || 'Kite MTF list' });
    toast('MTF requirement saved for today.');
  },
  async evidence(form, data) {
    await act('evidence.add', { kind: data.kind, symbol: data.symbol, summary: data.summary, sources: data.source ? [data.source] : [] });
    toast('Evidence saved.');
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
    const r = await act('agent.add', data);
    drafts.newKey = { name: data.name, key: r.key };
  },
  async 'agent-update'(form, data, submitter) {
    if (submitter?.name === 'rekey') {
      const r = await act('agent.rekey', { id: data.id, pin: data.pin });
      drafts.newKey = { name: S.agents.find((a) => a.id === data.id)?.name, key: r.key };
      return;
    }
    await act('agent.update', { id: data.id, scope: data.scope, revoked: data.revoked || undefined, limits: { intentsPerDay: data.intentsPerDay, writesPerDay: data.writesPerDay, callsPerHour: data.callsPerHour }, pin: data.pin });
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
    location.hash = '#/playbooks';
  },
  async settings(form, data) {
    const { pin, ...values } = data;
    const patch = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== undefined && v !== S.status.settings[k]));
    if (!Object.keys(patch).length) return toast('Nothing changed.');
    await act('settings.change', { patch, pin });
    toast('Limits saved.');
  },
  async resume(form, data) {
    await act('automation.resume', { pin: data.pin });
    toast('Agents resumed.');
  },
  async pin(form, data) {
    await act('pin.set', { pin: data.pin, oldPin: data.oldPin });
    toast('PIN saved.');
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
    if (action === 'confirm-evidence') { await act('evidence.add', { confirms: el.dataset.id }); toast('Confirmed. It counts from now.'); }
    if (['add-item', 'remove-item', 'refresh-items'].includes(action)) {
      const form = el.closest('form');
      const s = readStrategy(form);
      if (action === 'add-item') s.items.push({ id: `item-${s.items.length + 1}`, type: 'attest', label: '', required: true });
      if (action === 'remove-item') s.items.splice(Number(el.dataset.n), 1);
      drafts.strategy = { key: form.dataset.key, value: s };
    }
    render();
  } catch (err) {
    toast(err.message, true);
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
    box.outerHTML = fundingFields(box.dataset.label, mode, v > 0 ? trim(100 / v) : '');
    document.querySelector('[data-funding] [name=fundingMode]')?.focus();
  }
  if (e.target.name === 'buyType') syncFunding(e.target.form);
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

// ---------- routing ----------

function render() {
  const [route = 'today', arg] = location.hash.replace(/^#\/?/, '').split('/');
  const page = pages[route] ?? pages.today;
  main.innerHTML = page(arg && decodeURIComponent(arg));
  document.querySelectorAll('form').forEach(syncFunding);
  // Fill the activity/ledger lists only after the page markup exists.
  if (page === pages.today || page === pages.ledger) loadLedger();
  for (const a of document.querySelectorAll('.side a')) a.toggleAttribute('aria-current', a.dataset.route === route || (route === 'request' && a.dataset.route === 'requests'));
  const pending = S.intents.filter((i) => i.status === 'pending').length;
  const count = $('#pending-count');
  count.hidden = !pending;
  count.textContent = pending;
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
