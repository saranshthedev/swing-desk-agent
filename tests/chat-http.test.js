import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, startServer } from '../src/http/server.js';
import { ChatManager } from '../src/chat/manager.js';
import { createThread } from '../src/chat/history.js';
import { desk } from './helpers.js';
import * as C from '../src/core/commands.js';

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.mjs');
const PIN = '123456';
const DISCONNECTED = 'The chat agent was disconnected. Turn chat on again under Agents & MCP.';

async function serve(t, { defaultChat = false, beforeApp } = {}) {
  const d = desk();
  const dir = mkdtempSync(join(tmpdir(), 'chat-http-'));
  const argsFile = join(dir, 'args.json');
  const before = process.env.FAKE_CLAUDE_ARGS;
  process.env.FAKE_CLAUDE_ARGS = argsFile;
  beforeApp?.(d);
  const chat = defaultChat ? undefined : new ChatManager(d.store, { bin: FAKE, dataDir: join(dir, 'data') });
  const server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  server.on('request', createApp(d.store, { port, chat }));
  const base = `http://127.0.0.1:${port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const post = (name, body, headers = {}) => fetch(`${base}/api/action/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': csrf, ...headers }, body: JSON.stringify(body) });
  const get = async (path) => (await fetch(`${base}${path}`, { headers: { 'X-CSRF': csrf } })).json();
  const readers = [];
  // Reads the desk-wide chat stream; `seen` collects parsed events and `raw` the text.
  const stream = async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/chat/stream`, { headers: { 'X-CSRF': csrf }, signal: ac.signal });
    const s = { res, events: [], raw: '', waiters: [], close: () => ac.abort() };
    readers.push(s);
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          const text = dec.decode(chunk, { stream: true });
          s.raw += text;
          buf += text;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.startsWith('data: ')) s.events.push(JSON.parse(block.slice(6)));
            for (const w of [...s.waiters]) w();
          }
        }
      } catch { /* aborted */ }
    })();
    s.until = (pred, ms = 5000) => new Promise((ok, fail) => {
      const check = () => {
        if (s.events.some(pred)) { s.waiters.splice(s.waiters.indexOf(check), 1); clearTimeout(timer); ok(); }
      };
      const timer = setTimeout(() => { s.waiters.splice(s.waiters.indexOf(check), 1); fail(new Error('stream timed out')); }, ms);
      s.waiters.push(check);
      check();
    });
    return s;
  };
  t.after(async () => {
    for (const r of readers) r.close();
    chat?.close();
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    if (before === undefined) delete process.env.FAKE_CLAUDE_ARGS; else process.env.FAKE_CLAUDE_ARGS = before;
    rmSync(dir, { recursive: true, force: true });
  });
  return { d, chat, server, base, csrf, post, get, stream, argsFile };
}

async function enable(t) {
  const res = await t.post('chat.enable', { pin: PIN });
  assert.equal(res.status, 200);
  return (await res.json()).result;
}

async function exchange(t, s, text = 'Research ABC for me please') {
  const res = await t.post('chat.send', { text });
  assert.equal(res.status, 200);
  const { threadId } = (await res.json()).result;
  await s.until((e) => e.type === 'end' && e.threadId === threadId);
  return threadId;
}

test('turn on chat returns no key and sets up the chat agent', async (tt) => {
  const t = await serve(tt);
  const result = await enable(t);
  assert.ok(result.id);
  assert.equal(result.key, undefined);
  assert.deepEqual(Object.keys(result), ['id']);
  const state = await t.get('/api/state');
  assert.equal(state.chat.agent.ok, true);
  assert.equal(state.chat.agent.id, result.id);
  assert.equal(state.chat.cli, true);
  assert.equal(state.meta.api, 8);
  const agent = state.agents.find((a) => a.id === result.id);
  assert.equal(agent.name, 'Desk chat');
  assert.equal(agent.client, 'Desk chat (built in)');
  assert.equal(agent.scope, 'propose');
  const rekey = await t.post('agent.rekey', { id: result.id, pin: PIN });
  assert.equal(rekey.status, 400);
  assert.equal((await rekey.json()).error, 'The desk replaces the chat agent’s key itself. Turn chat on again to make a new one.');
  assert.equal((await t.post('chat.enable', { pin: '999999' })).status, 400);
});

test('a message streams back and is saved', async (tt) => {
  const t = await serve(tt);
  await enable(t);
  const s = await t.stream();
  assert.equal(s.res.status, 200);
  assert.match(s.res.headers.get('content-type'), /^text\/event-stream/);
  assert.match(s.res.headers.get('content-security-policy'), /default-src 'self'/);
  const threadId = await exchange(t, s, 'Research ABC for me please');
  const text = s.events.filter((e) => e.type === 'text' && e.threadId === threadId).map((e) => e.text).join('');
  assert.equal(text, 'Research ABC for me ');
  assert.ok(s.events.some((e) => e.type === 'step' && e.write === true));
  assert.ok(s.events.some((e) => e.type === 'busy' && e.threadId === threadId));
  const { thread, messages } = await t.get(`/api/chat/threads/${threadId}`);
  assert.equal(thread.id, threadId);
  assert.deepEqual(messages.map((m) => m.role), ['owner', 'step', 'claude']);
  assert.equal(messages[2].text, 'Research ABC for me ');
  const { threads } = await t.get('/api/chat/threads');
  assert.equal(threads[0].id, threadId);
  const missing = await fetch(`${t.base}/api/chat/threads/chat_nope`, { headers: { 'X-CSRF': t.csrf } });
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).error);
  // A second message continues the same thread.
  const again = await (await t.post('chat.send', { threadId, text: 'And XYZ' })).json();
  assert.equal(again.result.threadId, threadId);
  await s.until((e) => e.type === 'end' && e.threadId === threadId && s.events.filter((x) => x.type === 'end').length === 2);
  assert.equal((await t.post('chat.send', { text: '   ' })).status, 400);
});

test('stop ends a hanging reply', async (tt) => {
  const t = await serve(tt);
  await enable(t);
  const s = await t.stream();
  // Works because the manager spawns the fixture with { ...process.env }, so the child inherits this.
  process.env.FAKE_CLAUDE_HANG = '1';
  tt.after(() => { delete process.env.FAKE_CLAUDE_HANG; });
  const { threadId } = (await (await t.post('chat.send', { text: 'Wait for me' })).json()).result;
  await s.until((e) => e.type === 'step');
  assert.equal((await t.get('/api/state')).chat.active, threadId);
  assert.equal((await t.post('chat.stop', {})).status, 200);
  await s.until((e) => e.type === 'end');
  const { messages } = await t.get(`/api/chat/threads/${threadId}`);
  assert.equal(messages.at(-1).role, 'note');
  assert.equal((await t.get('/api/state')).chat.active, null);
});

test('chat routes enforce CSRF and Origin', async (tt) => {
  const t = await serve(tt);
  await enable(t);
  assert.equal((await fetch(`${t.base}/api/chat/stream`)).status, 403);
  assert.equal((await fetch(`${t.base}/api/chat/threads`)).status, 403);
  assert.equal((await fetch(`${t.base}/api/chat/threads/x`, { headers: { 'X-CSRF': 'wrong' } })).status, 403);
  for (const name of ['chat.send', 'chat.stop', 'chat.limits', 'chat.enable']) {
    assert.equal((await t.post(name, { text: 'hi', pin: PIN }, { Origin: 'https://evil.example' })).status, 403, name);
    assert.equal((await t.post(name, { text: 'hi', pin: PIN }, { 'X-CSRF': 'wrong' })).status, 403, name);
  }
  assert.equal(existsSync(t.argsFile), false);
});

test('revoked chat agent: nothing spawned', async (tt) => {
  const t = await serve(tt);
  const { id } = await enable(t);
  assert.equal((await t.post('agent.update', { id, revoked: true, pin: PIN })).status, 200);
  const res = await t.post('chat.send', { text: 'Hello' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, DISCONNECTED);
  assert.equal(existsSync(t.argsFile), false);
  assert.equal((await t.get('/api/state')).chat.agent.ok, false);
});

test('a correction posts a note to the latest thread', async (tt) => {
  const t = await serve(tt);
  await enable(t);
  const s = await t.stream();
  const threadId = await exchange(t, s);
  const quote = t.d.addAgent('draft').run(C.addEvidence, { kind: 'quote', symbol: 'ABC', exchange: 'NSE', price: 100 }).id;
  assert.equal((await t.post('evidence.correct', { corrects: quote, reason: 'Kite shows 101', price: 101 })).status, 200);
  await s.until((e) => e.type === 'message' && e.message.role === 'note');
  const { messages } = await t.get(`/api/chat/threads/${threadId}`);
  const note = messages.find((m) => m.role === 'note');
  assert.ok(note);
  assert.match(note.text, /ABC/);
  assert.match(note.text, /Kite shows 101/);
});

test('corrections from before the server started are skipped; the first owner action posts its own', async (tt) => {
  let threadId, quote;
  const t = await serve(tt, {
    beforeApp: (d) => {
      threadId = createThread(d.store, { title: 'Earlier chat' }).id;
      const old = d.addAgent('draft').run(C.addEvidence, { kind: 'quote', symbol: 'OLD', exchange: 'NSE', price: 100 }).id;
      d.owner(C.correctEvidence, { corrects: old, reason: 'before start', price: 99 });
      quote = d.addAgent('draft').run(C.addEvidence, { kind: 'quote', symbol: 'ABC', exchange: 'NSE', price: 100 }).id;
    },
  });
  // The very first owner action after start is a correction: it must reach the chat.
  assert.equal((await t.post('evidence.correct', { corrects: quote, reason: 'Kite shows 101', price: 101 })).status, 200);
  const notes = (await t.get(`/api/chat/threads/${threadId}`)).messages.filter((m) => m.role === 'note');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /ABC/);
  assert.doesNotMatch(notes[0].text, /before start/);
});

test('turning chat on again disconnects the old chat agent', async (tt) => {
  const t = await serve(tt);
  const first = await enable(t);
  const second = await enable(t);
  assert.notEqual(first.id, second.id);
  const chats = (await t.get('/api/state')).agents.filter((a) => a.name === 'Desk chat');
  assert.deepEqual(chats.filter((a) => !a.revoked).map((a) => a.id), [second.id]);
  assert.equal(chats.find((a) => a.id === first.id).revoked, true);
  assert.equal(t.d.store.secret('chat_agent'), second.id);
  assert.equal((await t.get('/api/state')).chat.agent.id, second.id);
});

test('chat scope must be read, draft or propose', async (tt) => {
  const t = await serve(tt);
  for (const scope of ['off', 'admin', '']) {
    const res = await t.post('chat.enable', { pin: PIN, scope });
    assert.equal(res.status, 400, scope);
    assert.equal((await res.json()).error, 'Choose Read, Draft or Propose for the chat.');
  }
  assert.equal(t.d.store.secret('chat_agent'), null);
  const { id } = (await (await t.post('chat.enable', { pin: PIN, scope: 'draft' })).json()).result;
  assert.equal((await t.get('/api/state')).agents.find((a) => a.id === id).scope, 'draft');
});

test('closing the desk server ends open chat streams and removes its exit hook', async (tt) => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-start-'));
  const saved = { bin: process.env.DESK_CLAUDE_BIN, data: process.env.SWING_DESK_DATA };
  process.env.DESK_CLAUDE_BIN = FAKE;
  process.env.SWING_DESK_DATA = dir;
  tt.after(() => {
    for (const [k, v] of [['DESK_CLAUDE_BIN', saved.bin], ['SWING_DESK_DATA', saved.data]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });
  const probe = createServer();
  await new Promise((ok) => probe.listen(0, '127.0.0.1', ok));
  const port = probe.address().port;
  await new Promise((ok) => probe.close(ok));
  const d = desk();
  const exitsBefore = process.listenerCount('exit');
  const server = await startServer(d.store, { port });
  assert.equal(process.listenerCount('exit'), exitsBefore + 1);
  const base = `http://127.0.0.1:${port}`;
  const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
  const res = await fetch(`${base}/api/chat/stream`, { headers: { 'X-CSRF': csrf } });
  assert.equal(res.status, 200);
  const reading = (async () => { try { for await (const _ of res.body); } catch { /* cut off */ } })();
  await new Promise((ok) => server.close(ok)); // would hang if the stream kept the server open
  await reading;
  assert.equal(process.listenerCount('exit'), exitsBefore);
});

test('chat limits save and validate', async (tt) => {
  const t = await serve(tt);
  const res = await t.post('chat.limits', { limits: { replyMinutes: 30, off: ['toolCalls'] } });
  assert.equal(res.status, 200);
  const saved = (await res.json()).result;
  assert.equal(saved.replyMinutes, 30);
  assert.deepEqual(saved.off, ['toolCalls']);
  const state = await t.get('/api/state');
  assert.equal(state.chat.limits.replyMinutes, 30);
  assert.deepEqual(state.chat.limits.off, ['toolCalls']);
  assert.ok(state.chat.limitRules.replyMinutes);
  const bad = await t.post('chat.limits', { limits: { replyMinutes: 0 } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Reply time limit/);
  assert.equal((await t.post('chat.limits', { limits: null })).status, 200);
  assert.equal((await t.get('/api/state')).chat.limits.replyMinutes, 15);
});

test('the agent key never leaves the server', async (tt) => {
  const keys = [];
  const t = await serve(tt, {
    beforeApp: (d) => {
      const issue = d.store.issueKey.bind(d.store);
      d.store.issueKey = (id) => { const k = issue(id); keys.push(k); return k; };
    },
  });
  await enable(t);
  const s = await t.stream();
  const threadId = await exchange(t, s);
  assert.ok(keys.length >= 1);
  const key = keys.at(-1);
  const secret = key.slice(-32);
  assert.match(key, new RegExp(`_${secret}$`));
  const seen = [
    JSON.stringify(await t.get('/api/state')),
    JSON.stringify(await t.get('/api/chat/threads')),
    JSON.stringify(await t.get(`/api/chat/threads/${threadId}`)),
    s.raw,
    readFileSync(t.argsFile, 'utf8'),
  ];
  for (const text of seen) {
    for (const k of keys) {
      assert.ok(!text.includes(k), 'key leaked');
      assert.ok(!text.includes(k.slice(-32)), 'key secret leaked');
    }
  }
});

test('the state block reports a missing CLI', async (tt) => {
  const t = await serve(tt, { defaultChat: true });
  const state = await t.get('/api/state');
  assert.equal(state.chat.cli, false);
  assert.equal(state.chat.agent.ok, false);
  await enable(t);
  const res = await t.post('chat.send', { text: 'Hello' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not installed/);
});
