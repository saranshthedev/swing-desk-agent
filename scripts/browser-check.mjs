// Optional real-browser check of the owner flow, using an installed Chrome/Edge/Chromium,
// a throwaway profile, a temporary data folder and synthetic data only. No dependencies:
// it speaks the Chrome DevTools Protocol over Node's built-in WebSocket.
//
//   node scripts/browser-check.mjs [screenshot-folder]

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { Store } from '../src/store/store.js';
import * as C from '../src/core/commands.js';
import { EXCHANGE_KINDS } from '../src/core/evidence.js';

const root = resolve(import.meta.dirname, '..');
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
const browserPath = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!browserPath) throw new Error('Install Chrome, Edge or Chromium, or set BROWSER_PATH. npm test does not need a browser.');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});
async function until(fn, label, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await delay(100);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}
function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  else child.kill('SIGKILL');
}

const temp = mkdtempSync(join(tmpdir(), 'desk-browser-'));
const env = { ...process.env, SWING_DESK_DATA: join(temp, 'data'), SWING_DESK_PORT: String(await freePort()) };
const base = `http://127.0.0.1:${env.SWING_DESK_PORT}`;
let server, browser, mcp;
const errors = [];

// Stage 1 happened three days ago: before the server starts, the owner prepared every required
// research item of Breakout for SAMPLE on NSE (evidence items on records the owner entered).
// The store's own clock is set back; the server itself runs on real time.
{
  const threeDaysAgo = Date.now() - 3 * 86_400_000;
  const seed = new Store(join(env.SWING_DESK_DATA, 'desk.sqlite'), { clock: () => threeDaysAgo });
  const owner = (fn, input) => seed.run('owner', (s, ctx) => fn(s, input, ctx));
  const items = seed.read((s) => s.strategies.breakout.items.filter((i) => i.stage === 'research' && i.required && (i.type === 'attest' || i.type === 'evidence')));
  for (const item of items) {
    let evidenceId;
    if (item.type === 'evidence') {
      const symbol = item.scope === 'market' ? 'MARKET' : 'SAMPLE';
      evidenceId = owner(C.addEvidence, { kind: item.kind, symbol, topic: item.id, summary: `Synthetic ${item.kind} check for testing`, sources: ['https://example.com/source'], ...(EXCHANGE_KINDS.has(item.kind) ? { exchange: 'NSE' } : {}) }).id;
    }
    owner(C.markPrepared, { symbol: 'SAMPLE', strategyId: 'breakout', itemId: item.id, exchange: 'NSE', evidenceId, yes: true });
  }
  // A model wrote a SWOT for MODELCO with HTML in its points: it must show as plain text.
  seed.run('agent:seed-model', (s, ctx) => C.addSection(s, { symbol: 'MODELCO', section: 'swot', text: 'Strengths :\n- Strong <img src=x onerror=1> brand\n--Weakness :\n- Debt <b>rising</b>' }, ctx));
  seed.close();
}

// Pasted sections, verbatim from the design spec.
const OVERVIEW_PASTE = ['Open\t692.55', 'Previous Close\t694.05', 'Volume\t1,89,89,022', 'Value (Lacs)\t1,31,555.94', 'VWAP\t692.13', 'Beta\t', '1.22',
  'Mkt Cap (Rs. Cr.)\t10,68,200', 'High\t696.80', 'Low\t686.85', 'UC Limit\t711.65', 'LC Limit\t670.25', '52 Week High\t1,017.50', '52 Week Low\t681.90',
  'Face Value\t1', 'All Time High\t1,020.50', 'All Time Low\t7.85', '20D Avg Volume\t3,14,62,518', '20D Avg Delivery(%)\t59.64', 'Book Value Per Share\t390.37',
  'Dividend Yield\t2.24', 'TTM EPS', 'See historical trend ', '51.95', '(+10.51% YoY)', 'TTM PE', 'See historical trend ', '13.34', '(Low PE)',
  'P/B', 'See historical trend ', '1.78', '(Low P/B)', 'Sector PE\t18.08'].join('\n');
const SWOT_PASTE = ['Strengths :', 'Growth in Net Profit with increasing Profit Margin (QoQ)', 'Increasing Revenue every Quarter for the past 4 Quarters',
  'Annual EPS Improving for last 2 years', 'Company with Zero Promoter Pledge', '--Weakness :', 'FII/FPI decreased their shareholding last quarter',
  'Near 52 Week Low', 'Inefficient use of shareholder funds - ROE declining', 'Inefficient use of capital to generate profits - RoCE declining'].join('\n');
// Synthetic wide tables (newest period last), so the 390 px screenshots show them scrolling inside their card.
const RESULTS_PASTE = ['\tJun 2025\tSep 2025\tDec 2025\tMar 2026\tJun 2026\tSep 2026', 'Revenue\t1,000\t1,050\t1,100\t1,180\t1,240\t1,300',
  'Net Profit\t100\t96\t110\t118\t121\t130', 'Operating Margin %\t18.2\t18.0\t18.6\t19.1\t19.0\t19.4'].join('\n');
const SHAREHOLDING_PASTE = ['\tDec 2025\tMar 2026\tJun 2026\tSep 2026', 'Promoters\t50.10\t50.10\t50.10\t50.10', 'FII/FPI\t20.40\t20.10\t19.80\t18.10',
  'DII\t15.00\t15.20\t15.90\t17.30', 'Public\t14.50\t14.60\t14.20\t14.50', 'Pledge\t0\t0\t0\t0'].join('\n');
const PEERS_PASTE = ['\tPrice ₹\tMkt Cap ₹ Cr\tPE\tP/B\tROE %\tDividend yield %', 'SAMPLE\t692.13\t10,68,200\t13.34\t1.78\t13.6\t2.24',
  'Peer One\t1,450.00\t5,20,000\t24.1\t3.9\t16.2\t1.1', 'Peer Two\t310.50\t1,10,000\t18.0\t2.2\t12.4\t1.8', 'Peer Three\t95.20\t45,000\t11.2\t1.1\t9.8\t3.0'].join('\n');

try {
  server = spawn(process.execPath, [join(root, 'bin/desk.js'), 'start'], { env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  await until(() => fetch(base).then((r) => r.ok).catch(() => false), 'desk server');

  const debugPort = await freePort();
  browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(temp, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const target = await until(async () => {
    const list = await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json()).catch(() => []);
    return list.find((t) => t.type === 'page');
  }, 'browser page');

  // ---------- minimal CDP client ----------
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, fail } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
  };
  const cdp = (method, params = {}) => new Promise((ok, fail) => { const id = ++seq; waiting.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  in: ${expression.slice(0, 200)}`);
    return r.result.value;
  };
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Page.enable');

  // ---------- page helpers (run inside the page) ----------
  const go = async (hash) => {
    await js(`location.hash = ${JSON.stringify(hash)}`);
    await delay(150);
  };
  const text = () => js('document.querySelector("main").innerText');
  const waitText = (needle, label = needle) => until(async () => (await text()).includes(needle), label);
  const toast = () => until(() => js('document.querySelector("#toast.show")?.innerText'), 'toast');
  const clearToast = () => js('(() => { const t = document.querySelector("#toast"); t.className = "toast"; t.textContent = ""; })()');
  const click = async (selector) => { await clearToast(); await js(`document.querySelector(${JSON.stringify(selector)}).click()`); };
  /** Fill a form (found by data-form, optionally the nth match) and submit it with an optional button. */
  const submit = async (form, values, { nth = 0, button } = {}) => {
    await clearToast();
    await js(`(() => {
      const f = document.querySelectorAll('form[data-form="${form}"]')[${nth}];
      if (!f) throw new Error('form ${form} not found');
      for (const [k, v] of Object.entries(${JSON.stringify(values)})) {
        const el = f.elements[k];
        if (!el) throw new Error('field ' + k + ' not found in ${form}');
        if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
      }
      const b = ${button ? `f.querySelector(${JSON.stringify(button)})` : 'null'};
      f.requestSubmit(b || undefined);
    })()`);
  };
  const shot = async (name, width = 1280) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await delay(200);
    const overflow = await js('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    assert.ok(overflow <= 1, `${name} at ${width}px scrolls sideways by ${overflow}px`);
    if (shots) {
      mkdirSync(shots, { recursive: true });
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(shots, `${name}-${width}.png`), Buffer.from(data, 'base64'));
    }
    await cdp('Emulation.clearDeviceMetricsOverride');
  };

  // ---------- the flow ----------
  await cdp('Page.navigate', { url: base });
  await waitText('Today', 'Today page');
  await shot('today-empty');
  await shot('today-empty', 390);

  await go('#/settings');
  await waitText('Set your approval PIN first');
  await submit('pin', { pin: '24681357' });
  assert.match(await toast(), /PIN saved/);
  await submit('settings', { maxOpenLots: 5, pin: '00000000' });
  assert.match(await toast(), /Wrong PIN/);

  await go('#/agents');
  // Choosing Access like a person does also brings that level's usual limits.
  await js(`(() => { const s = document.querySelector('form[data-form=agent-add]').elements.scope; s.value = 'propose'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.deepEqual(await js('(() => { const f = document.querySelector("form[data-form=agent-add]").elements; return [f.agentPreset.value, f.intentsPerDay.value]; })()'), ['proposer', '5']);
  await submit('agent-add', { name: 'Research agent', client: 'Test client', pin: '24681357' });
  const config = await until(() => js('document.querySelector("pre.code")?.textContent'), 'key panel');
  const key = JSON.parse(config).mcpServers['swing-desk'].env.SWING_DESK_AGENT_KEY;
  assert.match(key, /^sdk_agent_/);
  await shot('agents-key');
  await js('document.querySelector("[data-action=hide-key]").click()');

  // A real MCP client process records agent-found evidence.
  mcp = spawn(process.execPath, [join(root, 'bin/desk.js'), 'mcp'], { env: { ...env, SWING_DESK_AGENT_KEY: key }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const replies = new Map();
  readline.createInterface({ input: mcp.stdout }).on('line', (l) => { const m = JSON.parse(l); replies.get(m.id)?.(m); });
  let rid = 0;
  const rpc = (method, params) => new Promise((ok) => { const id = ++rid; replies.set(id, ok); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result;
    assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-check', version: '1' } });
  // Today, Claude gathers the on-the-day checks (found, not verified): news, the daily chart on
  // NSE, and the whole-market check under MARKET. One research-type find stays for Today's card.
  await tool('add_evidence', { kind: 'news', symbol: 'SAMPLE', summary: 'No adverse news today', sources: ['https://example.com/source'] });
  await tool('add_evidence', { kind: 'candles', symbol: 'SAMPLE', exchange: 'NSE', summary: 'Closed above 20-day high on 2.1× volume', sources: ['https://example.com/source'] });
  await tool('add_evidence', { kind: 'macro', symbol: 'MARKET', summary: 'Nifty uptrend, VIX 13, US flat, Brent $78, USDINR 83.9 steady', sources: ['https://example.com/markets'] });
  await tool('add_evidence', { kind: 'sector', symbol: 'SAMPLE', summary: 'Sector index beat Nifty over 3 months', sources: ['https://example.com/source'] });
  const status = await tool('get_research_status', { symbol: 'SAMPLE', strategyId: 'breakout', exchange: 'NSE' });
  assert.ok(status.researchDone, 'research prepared three days ago counts today');
  // Claude flags one of the owner's records, and stores its own call, different from the desk's.
  const [ownerRecord] = await tool('list_evidence', { symbol: 'SAMPLE', status: 'verified', limit: 1 }).then((r) => r.result);
  await tool('flag_evidence', { id: ownerRecord.id, reason: 'Synthetic flag: the promoter figure may be out of date' });
  const views = await tool('get_recommendation', { symbol: 'SAMPLE', exchange: 'NSE' });
  const agentCall = views.desk.call === 'buy' ? 'wait' : 'buy';
  await tool('add_recommendation', { symbol: 'SAMPLE', exchange: 'NSE', call: agentCall, strategyIds: ['breakout'], reasons: 'Synthetic recommendation for testing', sources: ['https://example.com/source'] });
  await tool('add_evidence', { kind: 'quote', symbol: 'SAMPLE', exchange: 'NSE', price: 500.5, summary: 'Public exchange page' });
  await tool('add_evidence', { kind: 'funding', symbol: 'SAMPLE', marginPct: 40, summary: 'Broker MTF list page' });
  const proposed = await tool('propose_buy', { symbol: 'SAMPLE', strategyId: 'breakout', thesis: 'Synthetic breakout for testing', claims: { 'volume-signal': '2.1× the 20-day average' }, plan: { exchange: 'NSE', buyType: 'mtf', marginPct: 50, entry: 500, stop: 485, target: 560, days: 10 } });

  // The sidebar has no Research page; old links land on Stocks.
  assert.equal(await js('!!document.querySelector(".side a[href=\\"#/research\\"]")'), false, 'no Research link');
  assert.deepEqual(await js('[...document.querySelectorAll(".side a")].map((a) => a.dataset.route)'), ['today', 'stocks', 'prepare', 'plan', 'requests', 'positions', 'settings', 'agents', 'checklist', 'strategies', 'playbooks', 'ledger', 'trash']);
  await go('#/research');
  await until(() => js('location.hash === "#/stocks"'), '#/research lands on Stocks');
  await waitText('Your stocks');

  // Prepare: one exchange at a time; the master list, each strategy, and both recommendations.
  await js('location.reload()');
  await until(() => js('!!document.querySelector("#pending-count")'), 'reloaded');
  await go('#/prepare/SAMPLE');
  await until(() => js('!!document.querySelector(".prep-master")'), 'Prepare master list');
  assert.equal(await js('document.querySelector("form[data-form=prepare-pick]").elements.exchange.value'), 'NSE');
  assert.ok(await js('document.querySelectorAll(".prep-strategy").length') >= 1, 'per-strategy lists');
  assert.match(await js('document.querySelector(".prep-strategy").textContent'), /Breakout/);
  assert.equal(await js('document.querySelectorAll(".rec-grid > .rec").length'), 2);
  assert.equal(await js('(() => { const [a, b] = document.querySelectorAll(".rec-grid > .rec"); return a.getBoundingClientRect().top === b.getBoundingClientRect().top; })()'), true, 'recommendation cards side by side');
  const recs = await js('document.querySelector(".rec-grid").textContent');
  assert.match(recs, /Desk rules/);
  assert.match(recs, /Claude \(written by a model · not verified\)/);
  assert.match(await text(), /The desk and Claude disagree/);
  assert.doesNotMatch(await text(), /you should/i);
  assert.match(await js('document.querySelector(".bse-note")?.textContent ?? ""'), /BSE/);
  await shot('prepare');
  await shot('prepare', 390);
  // Marking a research item starts its wait.
  await click('.prep-master [data-action=prepare-mark][data-yes="1"]');
  assert.match(await toast(), /Marked as checked/);
  // An inline record saved on Prepare is used for its item at once.
  await until(() => js('!!document.querySelector(".prep-master form[data-form=prep-evidence]")'), 'inline record form');
  await submit('prep-evidence', { summary: 'Synthetic inline record' }, { nth: 0 });
  assert.match(await toast(), /Record saved and used/);
  // A fresher copy that arrives while you type is announced, never silently held back.
  await delay(800); // let the reload after the save finish first
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*prepare.status*', requestStage: 'Request' }] });
  const pausedLoad = new Promise((ok) => {
    const prev = ws.onmessage;
    ws.onmessage = (m) => {
      prev(m);
      const msg = JSON.parse(m.data);
      if (msg.method === 'Fetch.requestPaused') { ws.onmessage = prev; ok(msg.params.requestId); }
    };
  });
  await click('.prep-master [data-action=prepare-mark]');
  await toast(); // the page has redrawn and asked for a fresh copy, which is held
  const pausedId = await pausedLoad;
  await js('(() => { const t = document.querySelector(".prep-master form[data-form=prep-evidence] textarea"); for (let d = t.closest("details"); d; d = d.parentElement.closest("details")) d.open = true; t.focus(); return document.activeElement === t; })()').then((ok) => assert.ok(ok, 'typing in a Prepare form'));
  await cdp('Fetch.continueRequest', { requestId: pausedId });
  await cdp('Fetch.disable');
  await until(() => js('!document.querySelector(".prep-newer").hidden'), 'newer-data marker');
  await click('[data-action=prep-redraw]');
  await until(() => js('document.querySelector(".prep-newer")?.hidden === true'), 'redrawn with the newer copy');

  // Snapshot: pasted sections shown as tables and lists. Notes are corrected, never verified.
  const sec = (s) => `.snapshot .snap-sec[data-section="${s}"]`;
  const secText = (s, part = '') => js(`document.querySelector(${JSON.stringify(`${sec(s)} ${part}`.trim())})?.textContent ?? ''`);
  const paste = async (section, text, button) => {
    await clearToast();
    await js(`(() => {
      const f = document.querySelector(${JSON.stringify(`${sec(section)} form[data-form=section-paste]`)});
      if (!f) throw new Error('paste box for ${section} not found');
      for (let d = f.closest('details'); d; d = d.parentElement.closest('details')) d.open = true;
      ${text === null ? '' : `f.elements.text.value = ${JSON.stringify(text)}; f.elements.text.dispatchEvent(new Event('input', { bubbles: true }));`}
      f.requestSubmit(f.querySelector('button[value=${button}]'));
    })()`);
  };
  await until(() => js('document.querySelectorAll(".snapshot .snap-sec").length === 5'), 'Snapshot with five sections');
  assert.deepEqual(await js('[...document.querySelectorAll(".snapshot .snap-sec")].map((c) => c.dataset.section)'), ['overview', 'swot', 'results', 'shareholding', 'peers']);
  assert.equal(await js(`document.querySelector(${JSON.stringify(`${sec('overview')} form[data-form=section-paste]`)}).elements.exchange.value`), 'NSE');
  await paste('overview', OVERVIEW_PASTE, 'preview');
  const preview = await until(async () => { const t = await secText('overview', '.snap-preview'); return t.includes('Worked out by the desk') && t; }, 'Overview preview');
  assert.match(preview, /1\.5% above the 52-week low · near the low/);
  assert.match(preview, /PE is 26% below the sector’s/);
  assert.equal(await secText('overview', '.snap-current'), '', 'a preview saves nothing');
  await paste('overview', null, 'save');
  assert.match(await toast(), /Saved\. Earlier versions stay in history\./);
  const overview = await until(async () => { const t = await secText('overview', '.snap-current'); return t.includes('692.13') && t; }, 'saved Overview');
  assert.match(overview, /Reference price.*VWAP.*692\.13/);
  assert.match(overview, /as of \d{1,2} [A-Z][a-z]{2}, 0 days ago/);
  assert.match(overview, /Written by you/);
  assert.match(overview, /NSE/);
  // Each exchange has its own paste box: an NSE preview never shows on the BSE page.
  await paste('overview', OVERVIEW_PASTE.replace('VWAP\t692.13', 'VWAP\t700.00'), 'preview');
  await until(async () => (await secText('overview', '.snap-preview')).includes('700'), 'second NSE preview');
  await go('#/prepare/SAMPLE/BSE');
  await until(() => js('document.querySelectorAll(".snapshot .snap-sec").length === 5 && document.querySelector("form[data-form=prepare-pick]").elements.exchange.value === "BSE"'), 'BSE Snapshot');
  assert.deepEqual(await js(`(() => {
    const box = document.querySelector(${JSON.stringify(`${sec('overview')} details.snap-paste`)});
    return [box.open, box.querySelector('textarea').value, !!box.querySelector('.snap-preview'), box.querySelector('select[name=exchange]').value];
  })()`), [false, '', false, 'BSE'], 'the BSE Overview box starts closed and empty');
  await go('#/prepare/SAMPLE/NSE');
  await until(async () => (await secText('overview', '.snap-preview')).includes('700'), 'NSE draft kept');
  // Typing new text removes the old preview.
  await js(`(() => { const t = document.querySelector(${JSON.stringify(`${sec('overview')} form[data-form=section-paste] textarea`)}); t.value += '\\n'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await js(`!!document.querySelector(${JSON.stringify(`${sec('overview')} .snap-preview`)})`), false, 'preview cleared when the text changes');
  await js(`document.querySelector(${JSON.stringify(`${sec('overview')} details.snap-paste`)}).open = false`);
  await paste('swot', SWOT_PASTE, 'save');
  assert.match(await toast(), /Saved/);
  await until(() => js(`document.querySelectorAll(${JSON.stringify(`${sec('swot')} .snap-current [data-list=strengths] li`)}).length === 4`), 'four strengths');
  assert.equal(await js(`document.querySelectorAll(${JSON.stringify(`${sec('swot')} .snap-current [data-list=weaknesses] li`)}).length`), 4);
  // Modify starts from the saved text; saving it makes a new version and keeps the old one.
  await click(`${sec('swot')} [data-action=section-modify]`);
  const canonical = await until(() => js(`document.querySelector(${JSON.stringify(`${sec('swot')} form[data-form=section-paste] textarea`)})?.value`), 'Modify text');
  assert.match(canonical, /^Strengths :\n- Growth in Net Profit/);
  assert.match(canonical, /- Near 52 Week Low/);
  await paste('swot', canonical.replace('Near 52 Week Low', 'Close to the 52 Week Low'), 'save');
  assert.match(await toast(), /Saved\. Earlier versions stay in history\./);
  await until(async () => (await secText('swot')).includes('Earlier versions (1)') && (await secText('swot', '.snap-current')).includes('Close to the 52 Week Low'), 'new SWOT version with history');
  // Wide tables: quarterly results, shareholding and peers.
  for (const [section, text] of [['results', RESULTS_PASTE], ['shareholding', SHAREHOLDING_PASTE], ['peers', PEERS_PASTE]]) {
    await paste(section, text, 'save');
    assert.match(await toast(), /Saved/);
    await until(async () => (await secText(section, '.snap-current')).includes('Worked out by the desk'), `saved ${section}`);
  }
  assert.match(await secText('results', '.snap-current'), /Revenue rose in each of the last 5 quarters/);
  assert.match(await secText('shareholding', '.snap-current'), /FII\/FPI holding fell 1\.7 points/);
  assert.match(await secText('peers', '.snap-current'), /median/i);
  // Open the folded sections for the screenshots.
  await js('document.querySelectorAll(".snapshot .snap-sec.folded .fold").forEach((b) => b.click())');
  const snapshotAll = await js('document.querySelector(".snapshot").innerText');
  assert.doesNotMatch(snapshotAll, /you should|undefined|NaN/i);
  assert.equal(await js('document.querySelectorAll(".snapshot [data-action=verify-evidence], .snapshot .verify").length'), 0, 'no verify control in the Snapshot');
  assert.equal(await js('[...document.querySelectorAll(".snapshot button, .snapshot summary")].some((b) => /verif|confirm/i.test(b.textContent))'), false, 'no verify or confirm button in the Snapshot');
  await shot('prepare-snapshot');
  await shot('prepare-snapshot', 390);
  // A model's section: HTML stays visible text, no image is created, and it says who wrote it.
  await go('#/prepare/MODELCO/NSE');
  await until(async () => (await secText('swot', '.snap-current')).includes('<img src=x onerror=1>'), 'model SWOT as text');
  assert.equal(await js('document.querySelectorAll("main img").length'), 0, 'agent text creates no image');
  assert.match(await secText('swot', '.snap-current'), /Written by a model/);
  assert.match(await secText('swot', '.snap-current'), /<b>rising<\/b>/);
  await go('#/stock/MODELCO');
  await until(async () => (await secText('swot', '.snap-current')).includes('<img src=x onerror=1>'), 'model SWOT on the stock page');
  assert.equal(await js('document.querySelectorAll("main img").length'), 0);
  assert.doesNotMatch(await text(), /undefined/);
  await go('#/prepare/SAMPLE/NSE');

  // Owner reviews the agent's request in the browser.
  await go(`#/request/${proposed.id}`);
  await waitText('The plan, recalculated by the desk');
  assert.match(await text(), /Written by a model · not verified/);
  assert.match(await text(), /found ₹500\.50/);
  // Research items are read-only here: they show when they were prepared and have no tick box.
  const all = () => js('document.querySelector("main").textContent');
  assert.match(await all(), /Prepared on \d{4}-\d{2}-\d{2}/);
  const researchIds = await js('[...document.querySelectorAll("li[data-stage=research]")].map((li) => li.dataset.check)');
  assert.ok(researchIds.length > 0, 'research items listed');
  const boxes = await js('[...document.querySelectorAll("form[data-form=approve] input[type=checkbox]")].filter((b) => b.name.startsWith("answer:")).map((b) => b.name.slice(7))');
  assert.ok(boxes.length > 0 && boxes.every((b) => !researchIds.includes(b)), 'research items have no tick boxes');
  assert.ok(await js('!!document.querySelector("[data-action=verify-evidence]")'), 'agent records show a Verify button');
  await shot('request-pending');
  await shot('request-pending', 390);

  await submit('approve', { pin: '24681357' });
  assert.match(await toast(), /Not ready to approve/);
  // Verify shows the good-until date it will apply (prefilled, changeable) and the toast names it.
  assert.match(await js('document.querySelector("form[data-form=approve] .verify [data-verify-date]").value'), /^\d{4}-\d{2}-\d{2}$/);
  const chosen = await js('(() => { const box = document.querySelector("form[data-form=approve] .verify"); box.open = true; const i = box.querySelector("[data-verify-date]"); i.value = new Date(Date.parse(i.min + "T00:00:00Z") + 2 * 86400000).toISOString().slice(0, 10); return i.value; })()');
  await click('form[data-form=approve] .verify [data-action=verify-evidence]');
  assert.match(await toast(), new RegExp(`Verified\. It counts until ${chosen}`));
  // On the day: verify Claude's finds, confirm price and MTF against Kite, tick the on-the-day items.
  await until(async () => {
    const b = await js('(() => { const b = document.querySelector("form[data-form=approve] [data-action=verify-evidence], [data-action=confirm-evidence]"); if (b && !b.disabled) { b.click(); return "clicked"; } return b ? "busy" : "done"; })()');
    if (b !== 'done') await delay(250);
    return b === 'done';
  }, 'verifications and confirmations', 20_000);
  await until(async () => (await text()).includes('Fresh price from your broker') && !(await text()).includes('An agent found ₹500.5'), 'quote check updated');
  await js('[...document.querySelectorAll("form[data-form=approve] input[type=checkbox]")].filter((b) => b.name.startsWith("answer:")).forEach((b) => { b.checked = true; })');
  await submit('approve', { pin: '24681357' });
  assert.match(await toast(), /Approved\. Now in Kite: BUY \d+ SAMPLE/);

  // Record the real fill, then a partial sale.
  await waitText('Record your buy');
  const approvedQty = Number(await js('document.querySelector("form[data-form=fill-buy]").elements.qty.value'));
  await submit('fill-buy', { price: '500.20' });
  assert.match(await toast(), /open lot/);
  await go('#/positions');
  await waitText(`SAMPLE · ${approvedQty} shares at ₹500.20`);
  await js('document.querySelector(".lot details summary").click()');
  await submit('fill-sell', { qty: 2, price: '520', charges: '40' });
  assert.match(await toast(), /Sale saved\. Result −?₹/);
  assert.doesNotMatch(await toast(), /−₹0\./, 'a result that rounds to zero must not show a minus sign');
  await waitText(`SAMPLE · ${approvedQty - 2} shares at ₹500.20`);
  await shot('positions');
  await shot('positions', 390);

  // Symbols link to one page per stock, where everything about it is gathered and can be acted on.
  await click('main a.sym');
  await until(() => js('location.hash === "#/stock/SAMPLE"'), 'symbol opens the stock page');
  await waitText('Open lots');
  assert.match(await text(), /Records\s+\d+/);
  // Records carry their status; Claude's finds can be verified, the owner's corrected, flags show.
  assert.match(await text(), /Verified/);
  assert.match(await text(), /Found by/);
  assert.match(await text(), /Flagged/);
  assert.ok(await js('!!document.querySelector("main [data-action=verify-evidence]")'), 'Verify on the stock page');
  await waitText('Desk rules', 'recommendation summary');
  await until(async () => !(await text()).includes('Loading the full list'), 'full record list');
  // One step in the page, so a redraw in between cannot swap the form.
  await clearToast();
  await js(`(() => {
    const f = [...document.querySelectorAll('form[data-form=correct]')].find((x) => x.elements.summary);
    f.closest('details').open = true;
    f.elements.summary.value = 'Synthetic corrected figure';
    f.elements.reason.value = 'Synthetic correction for testing';
    f.requestSubmit();
  })()`);
  assert.match(await toast(), /Corrected/);
  await waitText('Corrected');
  await js('document.querySelector("form[data-form=note] .fold").click()');
  await submit('note', { title: 'Watch 580', body: 'Weekly supply zone' });
  assert.match(await toast(), /Note saved/);
  await waitText('Watch 580');
  // The stock page shows the same Snapshot; plain note lists never show a blank or "undefined" note.
  await until(async () => (await secText('overview', '.snap-current')).includes('692.13'), 'Snapshot on the stock page');
  assert.doesNotMatch(await text(), /undefined/);
  await js('document.querySelectorAll(".snapshot .snap-sec.folded .fold").forEach((b) => b.click())');
  await shot('stock');
  await shot('stock', 390);
  // Export gives exactly what is on the page as Markdown, without buttons, forms or the PIN.
  assert.ok(await js('!!document.querySelector(".page-head [data-export=file]") && !!document.querySelector(".page-head [data-export=copy]")'), 'Export buttons on the stock page');
  const exported = await js('import("/export-md.js").then((m) => m.pageToMarkdown(document.querySelector("main")))');
  if (shots) writeFileSync(join(shots, 'stock-export.md'), exported);
  assert.match(exported, /^\*Exported from Swing Desk\*\n\n# SAMPLE/, 'export starts the page with its title');
  assert.match(exported, /Weekly supply zone/, 'export has the note');
  assert.match(exported, /692\.13/, 'export has the Snapshot figures');
  assert.match(exported, /^\| .+ \|$/m, 'export keeps tables');
  assert.doesNotMatch(exported, /Export as Markdown|Save correction|Delete forever|All stocks|New plan|undefined/, 'export leaves out controls');
  assert.ok(await js('!!document.querySelector("main .note .md")'), 'note text rendered as Markdown');
  await go('#/stocks');
  await waitText('1 open lot');
  await submit('stock-pick', { symbol: 'newco' });
  await until(() => js('location.hash === "#/stock/NEWCO"'), 'stock search');
  await waitText('No broker price saved yet.');

  // Every form field on these pages has an "i" help button.
  for (const page of ['#/settings', '#/plan', '#/today', '#/agents', '#/playbooks/new', '#/strategies/new', '#/strategies/breakout', '#/prepare', '#/prepare/SAMPLE', '#/stocks', '#/stock/SAMPLE']) {
    await go(page);
    const missing = await js('[...document.querySelectorAll(".field")].filter((f) => !f.querySelector(".info")).map((f) => f.querySelector("label")?.textContent)');
    assert.deepEqual(missing, [], `fields without help on ${page}`);
  }
  // Settings sections start folded to their headings; the fold button opens one and it stays open.
  await go('#/settings');
  assert.equal(await js('document.querySelector("form[data-form=settings]").classList.contains("folded")'), true, 'settings sections start folded');
  await shot('settings-folded', 390);
  await js('document.querySelector("form[data-form=settings] .fold").click()');
  assert.equal(await js('document.querySelector("form[data-form=settings] .fold").getAttribute("aria-expanded")'), 'true');
  await go('#/today');
  await go('#/settings');
  assert.equal(await js('document.querySelector("form[data-form=settings]").classList.contains("folded")'), false, 'an opened section stays open');
  // Keyboard: Enter opens the help, Escape closes it.
  await js('document.querySelector(".field .info").focus()');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.match(await js('(() => { const b = document.querySelector(".field .info"); return b.getAttribute("aria-expanded") + " " + document.getElementById(b.getAttribute("aria-controls")).textContent; })()'), /^true .*₹1,00,000/);
  await shot('settings-help', 390);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await js('document.querySelector(".field .info").getAttribute("aria-expanded")'), 'false');
  // Mouse: hovering opens the help, leaving closes it, and a click while hovered keeps it open.
  const infoAt = await js('(() => { const r = document.querySelector(".field .info").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
  const infoOpen = () => js('document.querySelector(".field .info").getAttribute("aria-expanded")');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: infoAt.x, y: infoAt.y });
  assert.equal(await until(async () => (await infoOpen()) === 'true' && 'true', 'help opens on hover'), 'true');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  assert.equal(await until(async () => (await infoOpen()) === 'false' && 'false', 'help closes after hover'), 'false');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: infoAt.x, y: infoAt.y });
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: infoAt.x, y: infoAt.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  await delay(300);
  assert.equal(await infoOpen(), 'true', 'a clicked help stays open after the mouse leaves');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

  // Risk presets fill the boxes from capital; typing a number switches to Custom.
  assert.match(await text(), /Your saved limits: Balanced/);
  await js(`(() => { const r = document.querySelector('input[name=preset][value=careful]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.deepEqual(await js('(() => { const f = document.querySelector("form[data-form=settings]").elements; return [f.riskPct.value, f.cashPerTrade.value, f.maxOpenLots.value]; })()'), ['0.25', '15000', '4']);
  await js(`(() => { const i = document.querySelector('form[data-form=settings]').elements.maxOpenLots; i.value = '5'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await js('document.querySelector("input[name=preset]:checked").value'), 'custom');
  await shot('settings-presets');

  // Agent presets and playbook templates fill their forms.
  await go('#/agents');
  await js(`(() => { const s = document.querySelector('form[data-form=agent-add]').elements.agentPreset; s.value = 'proposer'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.deepEqual(await js('(() => { const f = document.querySelector("form[data-form=agent-add]").elements; return [f.scope.value, f.intentsPerDay.value]; })()'), ['propose', '5']);
  await go('#/playbooks/new');
  await js(`(() => { const s = document.querySelector('form[data-form=playbook]').elements.template; s.value = 'watch'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.deepEqual(await js('(() => { const f = document.querySelector("form[data-form=playbook]").elements; return [f.name.value, f.every.value, f.mode.value]; })()'), ['Position watch', '30', 'every']);
  await go('#/strategies/new');
  await js(`(() => { const s = document.querySelector('form[data-form=strategy]').elements.copyFrom; s.value = 'results'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await js('document.querySelectorAll(".item-row").length'), await js('(() => { const s = [...document.querySelectorAll("select[name=copyFrom] option")].find((o) => o.value === "results"); return s ? Number(document.querySelectorAll(".item-row").length) : -1; })()'));
  // Adding a whole library group appends its checks.
  const before = await js('document.querySelectorAll(".item-row").length');
  await js(`(() => { const s = document.querySelector('form[data-form=strategy]').elements.libraryPick; s.value = 'group:commodities'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.ok((await js('document.querySelectorAll(".item-row").length')) > before, 'library group added');
  // Picking a strategy in New plan fills its usual hold days and buy type.
  await go('#/plan');
  await js(`(() => { const s = document.querySelector('form[data-form=plan]').elements.strategyId; s.value = 'results'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.deepEqual(await js('(() => { const f = document.querySelector("form[data-form=plan]").elements; return [f.days.value, f.buyType.value]; })()'), ['7', 'regular']);
  await js(`(() => { const s = document.querySelector('form[data-form=plan]').elements.strategyId; s.value = 'breakout'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  // MTF funding can be entered as leverage or own cash %; switching converts the typed value.
  await go('#/plan');
  await js(`(() => { const f = document.querySelector('form[data-form=plan]'); f.elements.fundingMode.value = 'leverage'; f.elements.fundingMode.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await js(`(() => { const i = document.querySelector('form[data-form=plan]').elements.fundingValue; i.value = '2.5'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.ok((await js('document.querySelector("[data-funding] .funding-hint").textContent')).includes('2.5× (40% own cash). You pay 40% and borrow 60%'));
  await js(`(() => { const s = document.querySelector('form[data-form=plan]').elements.fundingMode; s.value = 'cash'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await js('document.querySelector("form[data-form=plan]").elements.fundingValue.value'), '40');
  await js(`(() => { const s = document.querySelector('form[data-form=plan]').elements.buyType; s.value = 'regular'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await js('document.querySelector("[data-funding]").hidden'), true);
  await shot('plan-funding', 390);

  // Persistence across a reload; ledger intact.
  await js('location.reload()');
  await go('#/positions');
  await waitText(`${approvedQty - 2} shares`);
  await go('#/ledger');
  await until(() => js('document.querySelector("#chain")?.innerText.includes("Chain intact")'), 'ledger chain');
  await shot('ledger');

  // Pause stops the agent; strategies, playbooks and Prepare pages render.
  await click('[data-action=pause]');
  assert.match(await toast(), /paused/);
  const paused = (await rpc('tools/call', { name: 'desk_status', arguments: {} })).result;
  assert.ok(paused.isError && /paused/.test(paused.content[0].text));
  for (const page of ['#/strategies', '#/strategies/breakout', '#/checklist', '#/prepare', '#/prepare/SAMPLE/BSE', '#/playbooks/new', '#/requests', '#/plan', '#/today']) {
    await go(page);
    await shot(page.replace(/[#/]+/g, '-').replace(/^-|-$/g, '') || 'page', 390);
  }
  await go('#/today');
  await until(() => js('!document.querySelector("#activity").innerText.includes("Loading")'), 'activity list after cached ledger');
  assert.match(await text(), /Bought \d+ SAMPLE/);
  // Today: what Claude found waiting for you, and a stock picker instead of the old Research link.
  assert.match(await text(), /New from Claude/);
  assert.ok(await js('!!document.querySelector(".new-from-claude [data-action=verify-evidence]")'), 'Verify on Today');
  assert.ok(await js('!!document.querySelector("main form[data-form=stock-pick]") && !document.querySelector("main a[href=\\"#/research\\"]")'), 'stock picker on Today');
  assert.equal(await js('(() => { const b = document.querySelector(".automation .btn"); const s = getComputedStyle(b); return s.color !== s.backgroundColor; })()'), true);
  await shot('today');

  // Keyboard: Tab reaches the navigation and the focused link is visibly outlined.
  await js('document.activeElement?.blur(); document.body.focus()');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  const focus = await js('(() => { const a = document.activeElement; return { tag: a.tagName, outline: getComputedStyle(a).outlineStyle }; })()');
  assert.equal(focus.tag, 'A', 'Tab should land on a link');
  assert.notEqual(focus.outline, 'none', 'focused links need a visible outline');

  // An old server still running after an update: pages must say "restart", never go dead.
  const errorsBefore = errors.length;
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/state*', requestStage: 'Response' }] });
  const stripped = new Promise((ok) => {
    const prev = ws.onmessage;
    ws.onmessage = async (m) => {
      prev(m);
      const msg = JSON.parse(m.data);
      if (msg.method !== 'Fetch.requestPaused') return;
      const { body, base64Encoded } = await cdp('Fetch.getResponseBody', { requestId: msg.params.requestId });
      const state = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body);
      delete state.meta.api; delete state.meta.presets; delete state.meta.checklist; delete state.meta.restartNeeded;
      await cdp('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(state)).toString('base64') });
      ok();
    };
  });
  await js('location.reload()');
  await stripped;
  await cdp('Fetch.disable');
  await delay(500);
  await go('#/settings');
  assert.match(await text(), /Swing Desk was updated. Please restart it./);
  assert.match(await text(), /This page could not open/);
  await shot('old-server-banner', 390);
  errors.splice(errorsBefore); // the simulated failure logs on purpose
  await js('location.reload()');
  await delay(800);
  await go('#/settings');
  assert.doesNotMatch(await text(), /Please restart it/);

  // Disconnect is its own clear action: the key stops working and the agent moves to the disconnected list.
  await go('#/agents');
  assert.match(await text(), /Change access or limits/);
  await submit('agent-update', { pin: '24681357' }, { nth: 1 });
  assert.match(await toast(), /disconnected/);
  await waitText('Disconnected agents (1)');
  assert.doesNotMatch(await text(), /Change access or limits/);
  const afterDisconnect = (await rpc('tools/call', { name: 'desk_status', arguments: {} })).result;
  assert.ok(afterDisconnect.isError, 'a disconnected key can no longer call the desk');
  await shot('agents-disconnected');

  // Trash: the disconnected agent is hidden, restored, then deleted forever with the PIN; the chain stays intact.
  const trashAgent = async () => {
    await js('document.querySelector(".agent-gone").open = true');
    await click('.agent-gone [data-action=trash]');
    assert.match(await toast(), /Moved to the Trash/);
    await until(() => js('!document.querySelector(".agent-gone")'), 'agent hidden after trash');
  };
  await trashAgent();
  assert.equal(await js('document.querySelector("#trash-count").textContent'), '1');
  await go('#/trash');
  await waitText('In the Trash');
  await shot('trash', 390);
  await click('[data-action=restore]');
  assert.match(await toast(), /Restored/);
  await go('#/agents');
  await waitText('Disconnected agents (1)');
  await trashAgent();
  await go('#/trash');
  await js('document.querySelector(".purge").open = true');
  await submit('trash-purge', { pin: '24681357' });
  assert.match(await toast(), /Deleted forever/);
  await waitText('The Trash is empty.');
  await go('#/ledger');
  await until(() => js('document.querySelector("#chain")?.innerText.includes("Chain intact")'), 'chain intact after delete forever');
  assert.match(await text(), /Deleted an agent forever/);
  assert.ok(await js('document.querySelectorAll("#ledger-rows > li").length <= 25'), 'the ledger shows 25 entries per page');
  await shot('ledger-paged', 390);

  // The flow deliberately triggers two refusals (wrong PIN, approving too early); those 400s are expected.
  const real = errors.filter((e) => !/status of 400 \(Bad Request\) .*\/api\/action\/(settings\.change|intent\.approve)/.test(e));
  assert.deepEqual(real, [], `browser errors:\n${real.join('\n')}`);
  console.log(`Browser check passed (${browserPath.split(/[\\/]/).at(-1)}).${shots ? ` Screenshots: ${shots}` : ''}`);
  ws.close();
} finally {
  mcp?.stdin.end();
  kill(mcp);
  kill(browser);
  kill(server);
  await delay(300);
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
