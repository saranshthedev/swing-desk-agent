import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { desk, PLAN } from './helpers.js';
import { overruleNotes, syncOverruleNotes, correctionsBlock } from '../src/chat/notes.js';
import { createThread, listThreads, messages } from '../src/chat/history.js';

const OVERVIEW = 'Open\t692.55\nPrevious Close\t694.05\nVWAP\t692.13';
const notesSince = (d, seq) => d.store.read((s) => overruleNotes(s, d.store.eventsAfter(seq)));
const seqNow = (d) => d.store.state.seq;

test('a correction of an agent record becomes one note', () => {
  const d = desk(); const a = d.addAgent('draft');
  const { id } = a.run(C.addEvidence, { kind: 'quote', symbol: 'ABC', exchange: 'NSE', price: 100 });
  const seq = seqNow(d);
  d.owner(C.correctEvidence, { corrects: id, reason: 'Kite shows 98', price: 98 });
  const n = notesSince(d, seq);
  assert.equal(n.length, 1);
  for (const part of ['ABC', '₹100', '₹98', 'Kite shows 98']) assert.ok(n[0].includes(part), n[0]);
});

test('re-saving a section over the agent’s version is noted', () => {
  const d = desk(); const a = d.addAgent('draft');
  a.run(C.addSection, { symbol: 'ABC', section: 'overview', exchange: 'NSE', text: OVERVIEW });
  const seq = seqNow(d);
  d.owner(C.addSection, { symbol: 'ABC', section: 'overview', exchange: 'NSE', text: OVERVIEW });
  const n = notesSince(d, seq);
  assert.equal(n.length, 1);
  assert.ok(n[0].includes('Overview') && n[0].includes('over the agent’s version'), n[0]);
});

test('flag and reject are noted', () => {
  const d = desk(); const a = d.addAgent('draft');
  const ev = a.run(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'Old news' });
  const { id } = a.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: PLAN });
  const seq = seqNow(d);
  d.owner(C.flagEvidence, { id: ev.id, reason: 'Looks stale' });
  d.owner(C.rejectIntent, { id, reason: 'Too risky now' });
  const n = notesSince(d, seq);
  assert.equal(n.length, 2);
  assert.ok(n[0].includes('Looks stale') && n[0].includes('ABC'));
  assert.ok(n[1].includes('Too risky now') && n[1].includes('buy'));
});

test('verify, confirm, trash and owner-on-owner edits make no note', () => {
  const d = desk(); const a = d.addAgent('draft');
  const news = a.run(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'Fresh' });
  const q = a.run(C.addEvidence, { kind: 'quote', symbol: 'ABC', exchange: 'NSE', price: 100 });
  const mine = d.owner(C.addEvidence, { kind: 'news', symbol: 'XYZ', summary: 'Mine' });
  let seq = seqNow(d);
  d.owner(C.verifyEvidence, { id: news.id });
  assert.deepEqual(notesSince(d, seq), []);
  seq = seqNow(d);
  d.owner(C.addEvidence, { confirms: q.id });
  assert.deepEqual(notesSince(d, seq), []);
  seq = seqNow(d);
  d.owner(C.correctEvidence, { corrects: mine.id, reason: 'typo', summary: 'Mine, fixed' });
  assert.deepEqual(notesSince(d, seq), []);
  seq = seqNow(d);
  d.owner(C.flagEvidence, { id: mine.id, reason: 'hm' });
  assert.deepEqual(notesSince(d, seq), []);
  seq = seqNow(d);
  d.owner(C.moveToTrash, { kind: 'evidence', id: news.id });
  assert.deepEqual(notesSince(d, seq), []);
});

test('sync posts to the latest thread once and never replays old history', () => {
  const d = desk(); const a = d.addAgent('draft');
  const { id } = a.run(C.addEvidence, { kind: 'quote', symbol: 'ABC', exchange: 'NSE', price: 100 });
  createThread(d.store, { title: 'old' });
  d.clock.now += 1000;
  const t = createThread(d.store, { title: 'new' });
  assert.deepEqual(syncOverruleNotes(d.store), []);
  d.owner(C.correctEvidence, { corrects: id, reason: 'Kite shows 98', price: 98 });
  const posted = syncOverruleNotes(d.store);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].role, 'note');
  assert.equal(posted[0].threadId, t.id);
  assert.deepEqual(syncOverruleNotes(d.store), []);
  assert.equal(messages(d.store, listThreads(d.store)[0].id).length, 1);
});

test('corrections block', () => {
  assert.equal(correctionsBlock([]), '');
  const b = correctionsBlock([{ text: 'a' }, { text: 'b' }]);
  assert.ok(b.startsWith('Owner corrections since your last reply:\n- a\n- b'));
  assert.ok(b.endsWith('\n\n'));
});
