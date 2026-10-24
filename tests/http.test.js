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
    assert.equal(state.meta.api, 4);
  } finally { t.server.close(); }
});
