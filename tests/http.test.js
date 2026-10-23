import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/http/server.js';
import { desk } from './helpers.js';

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
