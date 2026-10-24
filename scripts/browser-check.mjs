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
  // Claude researches: per-stock evidence, plus market-wide checks saved once under MARKET.
  for (const [kind, summary] of [['news', 'No adverse news today'], ['candles', 'Closed above 20-day high on 2.1× volume'], ['calendar', 'Results in four weeks'],
    ['zones', 'Weekly uptrend; nearest weekly supply at 580'], ['sector', 'Sector index beat Nifty over 3 months'], ['fundamentals', 'Sales +18% a year; promoter 62%, no pledge']]) {
    await tool('add_evidence', { kind, symbol: 'SAMPLE', summary, sources: ['https://example.com/source'] });
  }
  await tool('add_evidence', { kind: 'macro', symbol: 'MARKET', summary: 'Nifty uptrend, VIX 13, US flat, Brent $78, USDINR 83.9 steady', sources: ['https://example.com/markets'] });
  const status = await tool('get_research_status', { symbol: 'SAMPLE', strategyId: 'breakout' });
  assert.ok(status.checks.filter((c) => c.type === 'evidence').every((c) => c.status === 'pass'), 'all evidence items pass after research');
  await tool('add_evidence', { kind: 'quote', symbol: 'SAMPLE', price: 500.5, summary: 'Public exchange page' });
  await tool('add_evidence', { kind: 'funding', symbol: 'SAMPLE', marginPct: 40, summary: 'Broker MTF list page' });
  const proposed = await tool('propose_buy', { symbol: 'SAMPLE', strategyId: 'breakout', thesis: 'Synthetic breakout for testing', claims: { 'volume-signal': '2.1× the 20-day average' }, plan: { buyType: 'mtf', marginPct: 50, entry: 500, stop: 485, target: 560, days: 10 } });

  // Stage 1: the owner ticks research items on the Prepare page (valid 5 days).
  await go('#/prepare/breakout/SAMPLE');
  await waitText('Research not finished');
  await shot('prepare', 390);
  await js('[...document.querySelectorAll("form[data-form=research] input[type=checkbox]")].filter((b) => b.name.startsWith("answer:")).forEach((b) => { b.checked = true; })');
  await submit('research', {});
  assert.match(await toast(), /Research saved/);
  await waitText('Research done');

  // Owner reviews the agent's request in the browser.
  await js('location.reload()');
  await until(() => js('document.querySelector("#pending-count")?.textContent === "1"'), 'pending count');
  await go(`#/request/${proposed.id}`);
  await waitText('The plan, recalculated by the desk');
  assert.match(await text(), /Written by a model · not verified/);
  assert.match(await text(), /found ₹500\.50/);
  await shot('request-pending');
  await shot('request-pending', 390);

  await submit('approve', { pin: '24681357' });
  assert.match(await toast(), /Not ready to approve/);
  await js('[...document.querySelectorAll("[data-action=confirm-evidence]")].forEach((b) => b.click())');
  await until(async () => !(await js('!!document.querySelector("[data-action=confirm-evidence]")')), 'confirmations');
  await until(async () => (await text()).includes('Fresh price from your broker') && !(await text()).includes('An agent found ₹500.5'), 'quote check updated');
  // Stage 2: research answers already count; only on-the-day items still need ticking.
  // Passed groups start collapsed, so read the full text, not just what is visible.
  assert.match(await js('document.querySelector("main").textContent'), /You checked this in research on/);
  const boxes = await js('[...document.querySelectorAll("form[data-form=approve] input[type=checkbox]")].filter((b) => b.name.startsWith("answer:")).map((b) => b.name)');
  assert.ok(boxes.length > 0 && !boxes.includes('answer:fund-debt'), 'research items are not asked again');
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

  // Every form field on these pages has an "i" help button.
  for (const page of ['#/settings', '#/plan', '#/research', '#/agents', '#/playbooks/new', '#/strategies/new', '#/prepare']) {
    await go(page);
    const missing = await js('[...document.querySelectorAll(".field")].filter((f) => !f.querySelector(".info")).map((f) => f.querySelector("label")?.textContent)');
    assert.deepEqual(missing, [], `fields without help on ${page}`);
  }
  // Keyboard: Enter opens the help, Escape closes it.
  await go('#/settings');
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

  // Pause stops the agent; strategies, playbooks and research pages render.
  await click('[data-action=pause]');
  assert.match(await toast(), /paused/);
  const paused = (await rpc('tools/call', { name: 'desk_status', arguments: {} })).result;
  assert.ok(paused.isError && /paused/.test(paused.content[0].text));
  for (const page of ['#/research', '#/strategies', '#/strategies/breakout', '#/checklist', '#/prepare', '#/playbooks/new', '#/requests', '#/plan', '#/today']) {
    await go(page);
    await shot(page.replace(/[#/]+/g, '-').replace(/^-|-$/g, '') || 'page', 390);
  }
  await go('#/today');
  await until(() => js('!document.querySelector("#activity").innerText.includes("Loading")'), 'activity list after cached ledger');
  assert.match(await text(), /Bought \d+ SAMPLE/);
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
