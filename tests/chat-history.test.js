import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import {
  createThread, listThreads, getThread, addMessage, messages, notesSinceReply, chatSetting, setChatSetting,
} from '../src/chat/history.js';

const mk = () => {
  const clock = { now: Date.UTC(2026, 9, 29, 4, 0, 0) };
  const store = new Store(':memory:', { clock: () => clock.now });
  return { store, clock };
};

test('threads list newest first and keep their messages in order', () => {
  const { store, clock } = mk();
  const a = createThread(store, { title: 'First', agentId: 'agent_1' });
  clock.now += 1000;
  const b = createThread(store, { title: 'Second' });
  clock.now += 1000;
  addMessage(store, a.id, { role: 'owner', text: 'one' });
  addMessage(store, a.id, { role: 'claude', text: 'two' });
  assert.deepEqual(listThreads(store).map((t) => t.id), [a.id, b.id]);
  assert.deepEqual(messages(store, a.id).map((m) => m.text), ['one', 'two']);
  assert.equal(getThread(store, a.id).agentId, 'agent_1');
  assert.equal(getThread(store, 'nope'), null);
});

test('text is capped at 20 000 characters', () => {
  const { store } = mk();
  const t = createThread(store, { title: 'x'.repeat(200) });
  assert.equal(t.title.length, 80);
  const m = addMessage(store, t.id, { role: 'owner', text: 'x'.repeat(40_000) });
  assert.equal(m.text.length, 20_000);
  assert.equal(messages(store, t.id)[0].text.length, 20_000);
});

test('unknown role is refused', () => {
  const { store } = mk();
  const t = createThread(store, { title: 't' });
  assert.throws(() => addMessage(store, t.id, { role: 'system', text: 'x' }), /role/i);
});

test('notes since reply are the notes after the last Claude message', () => {
  const { store } = mk();
  const t = createThread(store, { title: 't' });
  for (const [role, text] of [['owner', 'o'], ['note', 'A'], ['claude', 'c'], ['note', 'B'], ['note', 'C']]) {
    addMessage(store, t.id, { role, text });
  }
  assert.deepEqual(notesSinceReply(store, t.id).map((m) => m.text), ['B', 'C']);
});

test('chat history never touches the event log', () => {
  const { store } = mk();
  const seq = store.state.seq;
  const t = createThread(store, { title: 't' });
  addMessage(store, t.id, { role: 'step', text: 's', tool: 'list_lots', summary: 'ok' });
  setChatSetting(store, 'limits', { a: 1 });
  assert.equal(store.state.seq, seq);
  assert.equal(store.verify().ok, true);
});

test('settings round-trip as JSON', () => {
  const { store } = mk();
  setChatSetting(store, 'limits', { a: 1 });
  assert.deepEqual(chatSetting(store, 'limits'), { a: 1 });
  assert.equal(chatSetting(store, 'missing'), null);
});
