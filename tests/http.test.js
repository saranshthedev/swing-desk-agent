import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/server.js';
import { desk } from './helpers.js';
import * as C from '../src/core/commands.js';

async function serve() {
  const d = desk();
  const server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  server.on('request', createApp(d.store, { port }));
  const base = `http://127.0.0.1:${port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const post = (name, body, headers = {}) => fetch(`${base}/api/action/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': csrf, ...headers }, body: JSON.stringify(body) });
  return { d, server, base, csrf, post };
}

test('the app page loads with a strict content security policy', async () => {
  const t = await serve();
  try {
    const res = await fetch(`${t.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  } finally { t.server.close(); }
});

test('API refuses missing CSRF token and foreign origins', async () => {
  const t = await serve();
  try {
    assert.equal((await fetch(`${t.base}/api/state`)).status, 403);
    assert.equal((await t.post('note.add', { title: 'x', body: 'y' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.post('note.add', { title: 'x', body: 'y' })).status, 200);
  } finally { t.server.close(); }
});

test('the PIN can be changed through the API with the old PIN', async () => {
  const t = await serve();
  try {
    assert.equal((await t.post('pin.set', { pin: '24681012', oldPin: '000000' })).status, 400);
    assert.equal((await t.post('pin.set', { pin: '24681012', oldPin: '123456' })).status, 200);
    assert.equal((await t.post('settings.change', { patch: { maxOpenLots: 5 }, pin: '24681012' })).status, 200);
  } finally { t.server.close(); }
});

test('PIN-protected actions fail without the PIN and work with it', async () => {
  const t = await serve();
  try {
    const bad = await t.post('agent.add', { name: 'R', scope: 'read', pin: '999999' });
    assert.equal(bad.status, 400);
    const good = await (await t.post('agent.add', { name: 'R', scope: 'read', pin: '123456' })).json();
    assert.match(good.result.key, /^sdk_agent_/);
    const state = await (await fetch(`${t.base}/api/state`, { headers: { 'X-CSRF': t.csrf } })).json();
    const secret = good.result.key.slice(`sdk_${good.result.id}_`.length);
    assert.equal(secret.length, 32);
    assert.ok(!JSON.stringify(state).includes(secret), 'key must not be in state');
  } finally { t.server.close(); }
});

test('prepare.mark works for the owner without a PIN and obeys CSRF and Origin checks', async () => {
  const t = await serve();
  try {
    const item = t.d.store.read((s) => s.strategies.breakout.items.find((i) => i.stage === 'research' && i.type === 'attest'));
    const body = { symbol: 'ABC', strategyId: 'breakout', itemId: item.id, exchange: 'NSE', yes: true };
    assert.equal((await t.post('prepare.mark', body, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.post('prepare.mark', body, { 'X-CSRF': 'wrong' })).status, 403);
    assert.equal((await t.post('prepare.mark', body)).status, 200);
    const st = await (await t.post('prepare.status', { symbol: 'abc' })).json();
    assert.equal(st.result.master.symbol, 'ABC');
    assert.equal(st.result.master.exchange, 'NSE');
    assert.ok(st.result.strategies.length > 0);
    assert.ok(st.result.desk.call);
    assert.equal(st.result.agent, null);
    assert.equal((await t.post('prepare.status', { symbol: 'ABC', exchange: 'XX' })).status, 400);
  } finally { t.server.close(); }
});

test('evidence.verify, correct and flag work without a PIN; old research routes are gone; state carries status', async () => {
  const t = await serve();
  try {
    const id = t.d.addAgent('draft').run(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'x' }).id;
    assert.equal((await t.post('evidence.flag', { id, reason: 'odd' })).status, 200);
    assert.equal((await t.post('evidence.verify', { id })).status, 200);
    const fixed = await (await t.post('evidence.correct', { corrects: id, reason: 'typo', summary: 'y' })).json();
    assert.ok(fixed.result.id);
    assert.equal((await t.post('research.save', {})).status, 404);
    assert.equal((await t.post('research.status', {})).status, 404);
    const state = await (await fetch(`${t.base}/api/state`, { headers: { 'X-CSRF': t.csrf } })).json();
    assert.equal(state.evidence.find((e) => e.id === id).status, 'corrected');
    assert.equal(state.evidence.find((e) => e.id === fixed.result.id).status, 'verified');
    assert.ok(Array.isArray(state.recommendations));
    assert.ok(state.meta.checklist.window);
    assert.equal(state.meta.checklist.researchValidDays, undefined);
    assert.equal(state.meta.api, 8);
  } finally { t.server.close(); }
});

test('prepare.status returns every live record for the stock and MARKET, even past the 200 newest', async () => {
  const t = await serve();
  try {
    const old = t.d.owner(C.addEvidence, { kind: 'fundamentals', symbol: 'OLDCO', summary: 'Old but still good' }).id;
    const gone = t.d.owner(C.addEvidence, { kind: 'news', symbol: 'OLDCO', summary: 'Trashed' }).id;
    t.d.owner(C.moveToTrash, { kind: 'evidence', id: gone });
    const market = t.d.owner(C.addEvidence, { kind: 'macro', symbol: 'MARKET', summary: 'Market check' }).id;
    for (let n = 0; n < 205; n++) t.d.owner(C.addEvidence, { kind: 'news', symbol: `X${n}`, summary: 'filler' });
    const state = await (await fetch(`${t.base}/api/state`, { headers: { 'X-CSRF': t.csrf } })).json();
    assert.equal(state.evidence.some((e) => e.id === old), false, 'the global list is capped');
    const r = (await (await t.post('prepare.status', { symbol: 'oldco', exchange: 'NSE' })).json()).result;
    const ids = r.records.map((e) => e.id);
    assert.ok(ids.includes(old) && ids.includes(market));
    assert.equal(ids.includes(gone), false, 'trashed records are left out');
    assert.equal(r.records.find((e) => e.id === old).status, 'verified');
    assert.ok(r.records.every((e) => e.symbol === 'OLDCO' || e.symbol === 'MARKET'));
  } finally { t.server.close(); }
});

const SWOT_TEXT = 'Strengths :\nGood growth\n--Weakness :\nNear 52 Week Low';
const OVERVIEW_TEXT = 'VWAP\t100\n52 Week Low\t95\n52 Week High\t200\nTTM PE\t10\nSector PE\t20';

test('note.preview parses without writing; note.section.add shows in stock.snapshot with history', async () => {
  const t = await serve();
  try {
    const before = t.d.store.read((s) => s.seq);
    const pv = await (await t.post('note.preview', { section: 'overview', text: OVERVIEW_TEXT })).json();
    assert.equal(pv.result.data.rows.vwap, 100);
    assert.ok(Array.isArray(pv.result.warnings));
    assert.equal(pv.result.derived.referencePrice.value, 100);
    assert.equal(t.d.store.read((s) => s.seq), before);

    const add = await (await t.post('note.section.add', { symbol: 'abc', section: 'swot', text: SWOT_TEXT })).json();
    assert.ok(add.result.id);
    assert.ok(Array.isArray(add.result.warnings));
    let snap = (await (await t.post('stock.snapshot', { symbol: 'ABC' })).json()).result;
    assert.equal(snap.sections.swot.current.id, add.result.id);
    assert.equal(snap.sections.swot.derived.counts.strengths, 1);
    assert.deepEqual(snap.sections.swot.history, []);
    assert.equal(snap.sections.results.current, null);

    const second = await (await t.post('note.section.add', { symbol: 'ABC', section: 'swot', text: 'Strengths:\nA\nB' })).json();
    snap = (await (await t.post('stock.snapshot', { symbol: 'ABC' })).json()).result;
    assert.equal(snap.sections.swot.current.id, second.result.id);
    assert.deepEqual(snap.sections.swot.history.map((h) => h.id), [add.result.id]);

    // trashing the current brings the older version back as current
    t.d.owner(C.moveToTrash, { kind: 'note', id: second.result.id });
    snap = (await (await t.post('stock.snapshot', { symbol: 'ABC' })).json()).result;
    assert.equal(snap.sections.swot.current.id, add.result.id);
    assert.equal(snap.sections.swot.derived.counts.strengths, 1);
    assert.deepEqual(snap.sections.swot.history, []);
    assert.ok(!JSON.stringify(snap).includes(`"id":"${second.result.id}"`));
  } finally { t.server.close(); }
});

test('stock.snapshot keeps NSE and BSE overviews apart and validates the exchange', async () => {
  const t = await serve();
  try {
    const nse = await (await t.post('note.section.add', { symbol: 'ABC', section: 'overview', exchange: 'NSE', text: OVERVIEW_TEXT })).json();
    const bse = await (await t.post('note.section.add', { symbol: 'ABC', section: 'overview', exchange: 'BSE', text: 'VWAP\t101' })).json();
    const get = async (ex) => (await (await t.post('stock.snapshot', { symbol: 'ABC', ...(ex ? { exchange: ex } : {}) })).json()).result.sections.overview;
    assert.equal((await get()).current.id, nse.result.id);
    assert.equal((await get('NSE')).current.id, nse.result.id);
    const b = await get('BSE');
    assert.equal(b.current.id, bse.result.id);
    assert.deepEqual(b.history, []);
    assert.equal((await t.post('stock.snapshot', { symbol: 'ABC', exchange: 'XX' })).status, 400);
    assert.equal((await t.post('note.section.add', { symbol: 'ABC', section: 'nope', text: 'x' })).status, 400);
  } finally { t.server.close(); }
});

test('structured note actions obey Origin and CSRF checks', async () => {
  const t = await serve();
  try {
    const body = { symbol: 'ABC', section: 'swot', text: SWOT_TEXT };
    for (const name of ['note.preview', 'note.section.add', 'stock.snapshot', 'note.section.text']) {
      assert.equal((await t.post(name, body, { Origin: 'https://evil.example' })).status, 403, name);
      assert.equal((await t.post(name, body, { 'X-CSRF': 'wrong' })).status, 403, name);
    }
    assert.equal(t.d.store.read((s) => s.notes.length), 0);
  } finally { t.server.close(); }
});

test('note.section.text gives the canonical text of a saved section, never of a trashed or plain note', async () => {
  const t = await serve();
  try {
    const add = await (await t.post('note.section.add', { symbol: 'ABC', section: 'swot', text: SWOT_TEXT })).json();
    const before = t.d.store.read((s) => s.seq);
    const r = await (await t.post('note.section.text', { id: add.result.id })).json();
    assert.equal(r.result.text, 'Strengths :\n- Good growth\nWeaknesses :\n- Near 52 Week Low\nOpportunities :\nThreats :');
    assert.equal(t.d.store.read((s) => s.seq), before, 'reading the text writes nothing');
    const plain = t.d.owner(C.addNote, { symbol: 'ABC', title: 'x', body: 'y' }).id;
    assert.equal((await t.post('note.section.text', { id: plain })).status, 400);
    assert.equal((await t.post('note.section.text', { id: 'note_missing' })).status, 400);
    t.d.owner(C.moveToTrash, { kind: 'note', id: add.result.id });
    const gone = await t.post('note.section.text', { id: add.result.id });
    assert.equal(gone.status, 400);
    assert.match((await gone.json()).error, /not found/);
    t.d.owner(C.purgeFromTrash, { kind: 'note', id: add.result.id });
    assert.equal((await t.post('note.section.text', { id: add.result.id })).status, 400);
  } finally { t.server.close(); }
});

test('stock.snapshot keeps the newest 20 earlier versions and the full count', async () => {
  const t = await serve();
  try {
    const ids = [];
    for (let i = 0; i < 25; i++) {
      t.d.clock.now += 1000;
      ids.push((await (await t.post('note.section.add', { symbol: 'ABC', section: 'swot', text: `Strengths:
V${i}` })).json()).result.id);
    }
    const sw = (await (await t.post('stock.snapshot', { symbol: 'ABC' })).json()).result.sections.swot;
    assert.equal(sw.current.id, ids[24]);
    assert.equal(sw.history.length, 20);
    assert.equal(sw.historyCount, 24);
    assert.deepEqual(sw.history.map((h) => h.id), ids.slice(4, 24).reverse());
    const empty = (await (await t.post('stock.snapshot', { symbol: 'NONE' })).json()).result.sections.swot;
    assert.equal(empty.historyCount, 0);
  } finally { t.server.close(); }
});

test('structured saves do not crowd plain notes out of /api/state and carry no data there', async () => {
  const t = await serve();
  try {
    const plain = t.d.owner(C.addNote, { symbol: 'ABC', title: 'plain one', body: 'hello' }).id;
    for (let i = 0; i < 100; i++) {
      t.d.clock.now += 1000;
      t.d.owner(C.addSection, { symbol: 'ABC', section: 'swot', text: `Strengths:
V${i}` });
    }
    const state = await (await fetch(`${t.base}/api/state`, { headers: { 'X-CSRF': t.csrf } })).json();
    assert.ok(state.notes.some((n) => n.id === plain));
    assert.ok(state.notes.every((n) => !n.section && !n.data));
    assert.equal(state.sections.length, 100);
    for (const x of state.sections) {
      assert.deepEqual(Object.keys(x).filter((k) => ['data', 'sources', 'body'].includes(k)), []);
      assert.equal(x.section, 'swot');
    }
    assert.ok(!JSON.stringify(state.sections).includes('V99'));
  } finally { t.server.close(); }
});
