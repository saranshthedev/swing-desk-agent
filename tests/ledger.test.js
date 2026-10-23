import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import * as C from '../src/core/commands.js';
import { desk } from './helpers.js';

test('hash chain verifies and detects an edited event', () => {
  const d = desk();
  d.owner(C.addNote, { title: 'a', body: 'b' });
  assert.equal(d.store.verify().ok, true);
  d.store.db.prepare("UPDATE events SET data = '{\"title\":\"tampered\"}' WHERE type = 'note.added'").run();
  const r = d.store.verify();
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 2);
});

test('state is rebuilt identically from the log, and two processes stay in step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  try {
    const file = join(dir, 'desk.sqlite');
    const a = new Store(file);
    const b = new Store(file);
    a.run('owner', (s, ctx) => C.addNote(s, { title: 'from a', body: 'x' }, ctx));
    b.run('owner', (s, ctx) => C.addNote(s, { title: 'from b', body: 'y' }, ctx));
    assert.deepEqual(a.read((s) => s.notes.map((n) => n.title)), ['from a', 'from b']);
    const c = new Store(file);
    assert.deepEqual(c.read((s) => s.notes.map((n) => n.title)), ['from a', 'from b']);
    assert.equal(c.verify().count, 2);
    [a, b, c].forEach((s) => s.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed command writes nothing', () => {
  const d = desk();
  const before = d.store.verify().count;
  assert.throws(() => d.owner(C.addNote, { title: '', body: 'x' }));
  assert.equal(d.store.verify().count, before);
});

test('wrong PINs lock approvals for 15 minutes', () => {
  const d = desk();
  for (let i = 0; i < 5; i++) assert.throws(() => d.store.checkPin('000000'), /Wrong PIN/);
  assert.throws(() => d.store.checkPin('123456'), /Too many/);
  d.clock.now += 15 * 60_000 + 1;
  d.store.checkPin('123456');
});

test('agent keys are only stored hashed and identify their agent', () => {
  const d = desk();
  const agent = d.addAgent('read');
  assert.equal(d.store.identify(agent.key), agent.id);
  assert.equal(d.store.identify(agent.key.slice(0, -1) + (agent.key.endsWith('A') ? 'B' : 'A')), null);
  const stored = d.store.db.prepare('SELECT key_hash FROM agent_keys').get().key_hash;
  assert.ok(!agent.key.includes(stored));
});
