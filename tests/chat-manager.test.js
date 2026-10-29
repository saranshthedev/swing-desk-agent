import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desk } from './helpers.js';
import { ChatManager } from '../src/chat/manager.js';
import { CHAT_KEY_ENV } from '../src/chat/cli.js';
import { addMessage, createThread, getThread, messages, setChatSetting, setThreadSession } from '../src/chat/history.js';
import { stopMessage, chatLimits } from '../src/chat/limits.js';

const MIN = 60_000;
const OWNER_STOP = 'You stopped this reply. Anything Claude already recorded is on the desk.';
const tick = () => new Promise((r) => setImmediate(r));

function fakeSpawn() {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.input = [];
    child.stdin.on('data', (c) => child.input.push(...String(c).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    child.killed = false;
    child.kill = () => { child.killed = true; calls.order.push(['kill', calls.indexOf(entry)]); child.emit('exit', null, 'SIGTERM'); };
    const entry = { bin, args, opts, child };
    calls.push(entry);
    calls.order.push(['spawn', calls.length - 1]);
    return child;
  };
  calls.order = [];
  return { spawn, calls };
}

function setup(t, { limits, bin = 'claude' } = {}) {
  mock.timers.enable({ apis: ['setTimeout'] });
  const d = desk();
  const agent = d.addAgent('draft');
  d.store.setSecret('chat_agent', agent.id);
  const keys = [];
  const issue = d.store.issueKey.bind(d.store);
  d.store.issueKey = (id) => { const k = issue(id); keys.push(k); return k; };
  if (limits) setChatSetting(d.store, 'limits', chatLimits(limits));
  const dataDir = mkdtempSync(join(tmpdir(), 'chat-mgr-'));
  const { spawn, calls } = fakeSpawn();
  const chat = new ChatManager(d.store, { bin, dataDir, spawn });
  chat.rekey();
  const events = [];
  chat.on((e) => events.push(e));
  t.after(() => { chat.close(); mock.timers.reset(); rmSync(dataDir, { recursive: true, force: true }); });
  return { d, chat, calls, events, keys, dataDir, agent };
}

async function feed(child, ...objs) {
  for (const o of objs) child.stdout.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`);
  await tick();
}

const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const result = (text = 'done') => ({ type: 'result', subtype: 'success', is_error: false, result: text });
const toolUse = (name = 'mcp__swing-desk__add_note', input = { symbol: 'abc' }) =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input }] } });
const roles = (d, id) => messages(d.store, id).map((m) => m.role);

test('a reply streams, is stored and ends the turn', async (t) => {
  const { d, chat, calls, events, dataDir } = setup(t);
  const { threadId } = chat.send({ text: 'Hello desk' });
  assert.equal(getThread(d.store, threadId).title, 'Hello desk');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.cwd, join(dataDir, 'chat'));
  assert.ok(existsSync(join(dataDir, 'chat')));
  assert.equal(chat.status().active, threadId);
  await tick();
  assert.deepEqual(calls[0].child.input, [{ type: 'user', message: { role: 'user', content: 'Hello desk' } }]);
  const child = calls[0].child;
  await feed(child, { type: 'system', subtype: 'init', session_id: 's-1' }, 'not json', delta('Hel'));
  // A line split across chunks is joined before parsing.
  const line = JSON.stringify(delta('lo'));
  child.stdout.write(line.slice(0, 10)); await tick();
  child.stdout.write(`${line.slice(10)}\n`); await tick();
  await feed(child, result('Hello'));
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['Hel', 'lo']);
  assert.equal(events.filter((e) => e.type === 'end').length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'busy').map((e) => e.threadId), [threadId, null]);
  const msgs = messages(d.store, threadId);
  assert.deepEqual(msgs.map((m) => m.role), ['owner', 'claude']);
  assert.equal(msgs[1].text, 'Hello');
  assert.equal(chat.status().active, null);
  assert.equal(child.killed, false);
});

test('result text is used when no deltas came', async (t) => {
  const { d, chat, calls } = setup(t);
  const { threadId } = chat.send({ text: 'Hi' });
  await feed(calls[0].child, result('Whole reply'));
  assert.equal(messages(d.store, threadId).at(-1).text, 'Whole reply');
});

test('an error result is stored as an error without its text', async (t) => {
  const { d, chat, calls } = setup(t);
  const { threadId } = chat.send({ text: 'Hi' });
  await feed(calls[0].child, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'raw failure details' });
  const msgs = messages(d.store, threadId);
  assert.deepEqual(msgs.map((m) => m.role), ['owner', 'error']);
  assert.ok(!msgs[1].text.includes('raw failure'));
  assert.equal(chat.status().active, null);
});

test('tool use becomes a step line and marks desk writes', async (t) => {
  const { d, chat, calls, events } = setup(t);
  const { threadId } = chat.send({ text: 'Note ABC' });
  await feed(calls[0].child, toolUse(), { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 't2', name: 'WebSearch', input: { query: 'abc news' } }] } });
  const steps = events.filter((e) => e.type === 'step');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].write, true);
  assert.equal(steps[0].message.role, 'step');
  assert.equal(steps[0].message.summary, 'Saved a note for ABC');
  assert.equal(steps[1].write, false);
  assert.deepEqual(roles(d, threadId), ['owner', 'step', 'step']);
});

test('a second send while replying is refused', async (t) => {
  const { chat, calls } = setup(t);
  const { threadId } = chat.send({ text: 'one' });
  assert.throws(() => chat.send({ threadId, text: 'two' }), /still replying/);
  assert.throws(() => chat.send({ text: 'other thread' }), /still replying/);
  assert.equal(calls.length, 1);
});

test('stop kills the process and keeps partial text', async (t) => {
  const { d, chat, calls, events } = setup(t);
  const { threadId } = chat.send({ text: 'Go' });
  await feed(calls[0].child, delta('Part'), delta('ial'));
  chat.stop();
  assert.equal(calls[0].child.killed, true);
  const msgs = messages(d.store, threadId);
  assert.deepEqual(msgs.map((m) => m.role), ['owner', 'claude', 'note']);
  assert.equal(msgs[1].text, 'Partial');
  assert.equal(msgs[2].text, OWNER_STOP);
  assert.equal(chat.status().active, null);
  assert.equal(events.filter((e) => e.type === 'end').length, 1);
  assert.ok(!roles(d, threadId).includes('error'), 'a killed child is not an unexpected exit');
  chat.stop(); // nothing active: no-op
  assert.equal(messages(d.store, threadId).length, 3);
});

test('reply time limit stops the turn when on and not when off', async (t) => {
  await t.test('on', async (t) => {
    const { d, chat, calls } = setup(t);
    const { threadId } = chat.send({ text: 'Long job' });
    mock.timers.tick(15 * MIN - 1);
    assert.equal(chat.status().active, threadId);
    mock.timers.tick(1);
    assert.equal(chat.status().active, null);
    assert.equal(calls[0].child.killed, true);
    assert.equal(messages(d.store, threadId).at(-1).text, stopMessage('replyMinutes', chatLimits()));
    assert.ok(messages(d.store, threadId).at(-1).text.startsWith('Stopped after 15 minutes'));
  });
  await t.test('off', async (t) => {
    const { chat } = setup(t, { limits: { off: ['replyMinutes'] } });
    const { threadId } = chat.send({ text: 'Long job' });
    mock.timers.tick(200 * MIN);
    assert.equal(chat.status().active, threadId);
  });
});

test('tool-call and turn limits stop the turn', async (t) => {
  await t.test('tool calls', async (t) => {
    const { d, chat, calls } = setup(t, { limits: { toolCalls: 1 } });
    const { threadId } = chat.send({ text: 'Go' });
    await feed(calls[0].child, toolUse(), toolUse());
    assert.equal(chat.status().active, null);
    assert.equal(calls[0].child.killed, true);
    assert.deepEqual(roles(d, threadId), ['owner', 'step', 'note']);
    assert.equal(messages(d.store, threadId).at(-1).text, stopMessage('toolCalls', chatLimits({ toolCalls: 1 })));
  });
  await t.test('turns', async (t) => {
    const { d, chat, calls } = setup(t, { limits: { modelTurns: 1 } });
    const { threadId } = chat.send({ text: 'Go' });
    const say = { type: 'assistant', message: { content: [{ type: 'text', text: 'hm' }] } };
    await feed(calls[0].child, say);
    assert.equal(chat.status().active, threadId);
    await feed(calls[0].child, say);
    assert.equal(chat.status().active, null);
    assert.equal(messages(d.store, threadId).at(-1).text, stopMessage('modelTurns', chatLimits({ modelTurns: 1 })));
  });
  await t.test('switched off', async (t) => {
    const { chat, calls } = setup(t, { limits: { toolCalls: 1, modelTurns: 1, off: ['toolCalls', 'modelTurns'] } });
    const { threadId } = chat.send({ text: 'Go' });
    await feed(calls[0].child, toolUse(), toolUse(), toolUse());
    assert.equal(chat.status().active, threadId);
  });
});

test('idle limit closes the process; next send resumes', async (t) => {
  const { d, chat, calls } = setup(t);
  const { threadId } = chat.send({ text: 'Hi' });
  const sessionId = getThread(d.store, threadId).cliSessionId;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].args[calls[0].args.indexOf('--session-id') + 1], sessionId);
  await feed(calls[0].child, result('ok'));
  mock.timers.tick(10 * MIN - 1);
  assert.equal(calls[0].child.killed, false);
  mock.timers.tick(1);
  assert.equal(calls[0].child.killed, true);
  assert.deepEqual(roles(d, threadId), ['owner', 'claude']);
  chat.send({ threadId, text: 'Again' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], sessionId);
});

test('an idle process is reused for the next message in the same thread', async (t) => {
  const { chat, calls } = setup(t);
  const { threadId } = chat.send({ text: 'Hi' });
  await feed(calls[0].child, result('ok'));
  chat.send({ threadId, text: 'More' });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].child.input.length, 2);
  mock.timers.tick(10 * MIN); // idle timer was cleared by the new turn
  assert.equal(calls[0].child.killed, false);
});

test('resume passes saved session id', async (t) => {
  const { d, chat, calls, agent } = setup(t);
  const thread = createThread(d.store, { title: 'Old', agentId: agent.id });
  setThreadSession(d.store, thread.id, 'saved-session');
  chat.send({ threadId: thread.id, text: 'Back again' });
  assert.ok(calls[0].args.includes('--resume'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--resume') + 1], 'saved-session');
  assert.ok(!calls[0].args.includes('--session-id'));
});

test('new threads record the chat agent', (t) => {
  const { d, chat, agent } = setup(t);
  const { threadId } = chat.send({ text: 'Hi' });
  assert.equal(getThread(d.store, threadId).agentId, agent.id);
});

test('sending in another thread closes the first process first', async (t) => {
  const { chat, calls } = setup(t);
  chat.send({ text: 'First' });
  await feed(calls[0].child, result('ok'));
  chat.send({ text: 'Second' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.order, [['spawn', 0], ['kill', 0], ['spawn', 1]]);
});

test('owner corrections are prepended once', async (t) => {
  const { d, chat, calls } = setup(t);
  const { threadId } = chat.send({ text: 'Hi' });
  await feed(calls[0].child, result('ok'));
  addMessage(d.store, threadId, { role: 'note', text: 'You corrected ABC' });
  chat.send({ threadId, text: 'Next' });
  await feed(calls[0].child, result('ok2'));
  chat.send({ threadId, text: 'Third' });
  await tick();
  const sent = calls[0].child.input.map((m) => m.message.content);
  assert.ok(sent[1].startsWith('Owner corrections since your last reply:\n- You corrected ABC'), sent[1]);
  assert.ok(sent[1].endsWith('Next'));
  assert.equal(sent[2], 'Third');
});

test('process exit mid-turn ends the turn with an error', async (t) => {
  const { d, chat, calls, events } = setup(t);
  const { threadId } = chat.send({ text: 'Hi' });
  calls[0].child.stderr.write('secret stderr text');
  calls[0].child.emit('exit', 1, null);
  const msgs = messages(d.store, threadId);
  assert.equal(msgs.at(-1).role, 'error');
  assert.equal(msgs.at(-1).text, 'Claude stopped unexpectedly. Send your message again; earlier replies are kept.');
  assert.equal(chat.status().active, null);
  assert.equal(events.filter((e) => e.type === 'end').length, 1);
  chat.send({ threadId, text: 'Retry' });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes('--resume'));
});

test('a child error ends the turn without leaking arguments', async (t) => {
  const { d, chat, calls, events } = setup(t);
  const { threadId } = chat.send({ text: 'Hi' });
  const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', spawnargs: calls[0].args });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a);
  try { calls[0].child.emit('error', err); } finally { console.error = orig; }
  const msgs = messages(d.store, threadId);
  assert.equal(msgs.at(-1).role, 'error');
  assert.equal(msgs.at(-1).text, 'Claude stopped unexpectedly. Send your message again; earlier replies are kept.');
  assert.equal(chat.status().active, null);
  const dump = JSON.stringify([msgs, events, logged.map((a) => a.map(String))]);
  assert.ok(!dump.includes('--mcp-config') && !dump.includes('ENOENT spawn'));
  assert.ok(!dump.includes('spawn claude'));
});

test('send refuses when no CLI and blank text is refused', (t) => {
  const { chat, calls } = setup(t, { bin: null });
  assert.throws(() => chat.send({ text: '   ' }), /Type a message first/);
  assert.throws(() => chat.send({ text: 'Hi' }), /Claude Code is not installed on this computer/);
  assert.equal(calls.length, 0);
  assert.equal(chat.status().cli, false);
});

test('send refuses when the chat agent is not ok', (t) => {
  const { d, chat, calls } = setup(t);
  d.store.setSecret('chat_agent', '');
  chat.rekey();
  assert.throws(() => chat.send({ text: 'Hi' }), /Chat is not turned on/);
  assert.equal(calls.length, 0);
  assert.equal(chat.status().agent.ok, false);
});

test('status reports cli, agent, limits and rules', (t) => {
  const { chat, agent } = setup(t, { limits: { replyMinutes: 5 } });
  const s = chat.status();
  assert.equal(s.cli, true);
  assert.equal(s.agent.ok, true);
  assert.equal(s.agent.id, agent.id);
  assert.equal(s.agent.scope, 'draft');
  assert.equal(s.agent.name, 'draft agent');
  assert.equal(s.limits.replyMinutes, 5);
  assert.ok(s.limitRules.toolCalls);
  assert.equal(s.active, null);
});

test('notify emits a message event', (t) => {
  const { chat, events } = setup(t);
  const message = { id: 1, threadId: 'chat_x', role: 'note', text: 'n' };
  chat.notify(message);
  assert.deepEqual(events.at(-1), { type: 'message', threadId: 'chat_x', message });
});

test('rekey closes the process and unsubscribe stops events', async (t) => {
  const { chat, calls, events } = setup(t);
  chat.send({ text: 'Hi' });
  await feed(calls[0].child, result('ok'));
  chat.rekey();
  assert.equal(calls[0].child.killed, true);
  const seen = [];
  const off = chat.on((e) => seen.push(e));
  off();
  chat.notify({ threadId: 'x' });
  assert.equal(seen.length, 0);
  assert.ok(events.length > 0);
});

test('the key never reaches messages, events or arguments', async (t) => {
  const { d, chat, calls, events, keys } = setup(t);
  const { threadId } = chat.send({ text: 'Hi' });
  await feed(calls[0].child, delta('a'), toolUse(), result('ok'));
  chat.send({ threadId, text: 'Again' });
  chat.stop();
  chat.send({ threadId, text: 'Third' });
  calls.at(-1).child.emit('exit', 1, null);
  assert.ok(keys.length >= 1);
  const key = keys.at(-1);
  for (const c of calls) {
    assert.ok(!JSON.stringify(c.args).includes(key), 'key not in argv');
    assert.equal(c.opts.env[CHAT_KEY_ENV], key, 'key in spawn env');
  }
  const dump = JSON.stringify([events, messages(d.store, threadId), chat.status()]);
  for (const k of keys) assert.ok(!dump.includes(k));
});
