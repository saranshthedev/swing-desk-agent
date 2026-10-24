import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { recordStatus, counts, latestCounting, suggestGoodUntil } from '../src/core/knowledge.js';
import { indiaDate, addDays } from '../src/core/time.js';
import { desk } from './helpers.js';

const DAY = 86_400_000;
const today = (d) => indiaDate(d.clock.now);
const rec = (d, id) => d.store.read((s) => s.evidence.find((e) => e.id === id));
const status = (d, id) => recordStatus(rec(d, id), today(d));

test('agent records are found, not counting', () => {
  const d = desk();
  const agent = d.addAgent('draft');
  const { id } = agent.run(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'No news' });
  assert.equal(status(d, id), 'found');
  assert.equal(counts(rec(d, id), today(d)), false);
});

test('owner records count until goodUntil', () => {
  const d = desk();
  const goodUntil = addDays(today(d), 10);
  const { id } = d.owner(C.addEvidence, { kind: 'fundamentals', symbol: 'ABC', summary: 'Q2 fine', goodUntil });
  assert.equal(status(d, id), 'verified');
  d.clock.now += 11 * DAY;
  assert.equal(status(d, id), 'expired');
});

test('owner records without goodUntil default from the kind', () => {
  const d = desk();
  const { id } = d.owner(C.addEvidence, { kind: 'macro', symbol: 'MARKET', summary: 'Calm' });
  assert.equal(rec(d, id).goodUntil, addDays(today(d), 7));
  assert.equal(suggestGoodUntil('fundamentals', '2026-10-23', '2026-11-05'), '2026-11-05');
  assert.equal(suggestGoodUntil('fundamentals', '2026-10-23'), '2027-01-21');
  assert.equal(suggestGoodUntil('candles', '2026-10-23'), '2026-10-28');
  assert.equal(suggestGoodUntil('news', '2026-10-23'), '2026-10-23');
});

test('agents cannot set goodUntil', () => {
  const d = desk();
  const { id } = d.addAgent('draft').run(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'x', goodUntil: addDays(today(d), 30) });
  assert.equal(rec(d, id).goodUntil, undefined);
});

test('owner verifies an agent record', () => {
  const d = desk();
  const { id } = d.addAgent('draft').run(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'No news' });
  d.clock.now += 1000;
  d.owner(C.verifyEvidence, { id, goodUntil: addDays(today(d), 3) });
  assert.equal(status(d, id), 'verified');
  assert.equal(rec(d, id).verifiedAt, new Date(d.clock.now).toISOString());
});

test('verify defaults goodUntil and refuses price and funding records', () => {
  const d = desk();
  const agent = d.addAgent('draft');
  const { id } = agent.run(C.addEvidence, { kind: 'candles', symbol: 'ABC', exchange: 'NSE', summary: 'Up' });
  d.owner(C.verifyEvidence, { id });
  assert.equal(rec(d, id).goodUntil, addDays(today(d), 5));
  const q = agent.run(C.addEvidence, { kind: 'quote', symbol: 'ABC', exchange: 'NSE', price: 100 });
  assert.throws(() => d.owner(C.verifyEvidence, { id: q.id }), /confirm/i);
});

test('only the owner verifies or corrects', () => {
  const d = desk();
  const agent = d.addAgent('draft');
  const { id } = agent.run(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'x' });
  assert.throws(() => agent.run(C.verifyEvidence, { id }), /Only the owner/);
  assert.throws(() => agent.run(C.correctEvidence, { corrects: id, reason: 'no' }), /Only the owner/);
});

test('correction keeps history', () => {
  const d = desk();
  const { id } = d.owner(C.addEvidence, { kind: 'fundamentals', symbol: 'ABC', summary: 'Q1 fine', goodUntil: addDays(today(d), 10) });
  d.clock.now += 1000;
  const fixed = d.owner(C.correctEvidence, { corrects: id, reason: 'wrong quarter', summary: 'Q2 fine' });
  assert.equal(status(d, id), 'corrected');
  assert.equal(rec(d, id).correctedBy, fixed.id);
  assert.equal(rec(d, id).correctedAt, new Date(d.clock.now).toISOString());
  const n = rec(d, fixed.id);
  assert.equal(n.corrects, id);
  assert.equal(n.reason, 'wrong quarter');
  assert.equal(n.summary, 'Q2 fine');
  assert.equal(n.symbol, 'ABC');
  assert.equal(counts(n, today(d)), true);
  assert.throws(() => d.owner(C.correctEvidence, { corrects: id, reason: 'again' }), /already corrected/);
  assert.throws(() => d.owner(C.verifyEvidence, { id }), /already corrected/);
});

test('exchange is required on price-type kinds only', () => {
  const d = desk();
  assert.throws(() => d.owner(C.addEvidence, { kind: 'candles', symbol: 'ABC', summary: 'x' }), /NSE or BSE/);
  assert.throws(() => d.owner(C.addEvidence, { kind: 'zones', symbol: 'ABC', summary: 'x', exchange: 'MCX' }), /NSE or BSE/);
  const { id } = d.owner(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'x', exchange: 'NSE' });
  assert.equal(rec(d, id).exchange, undefined);
});

test('topic and verdict are stored and checked', () => {
  const d = desk();
  const { id } = d.owner(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'x', topic: 'results-date', verdict: 'good' });
  assert.equal(rec(d, id).topic, 'results-date');
  assert.equal(rec(d, id).verdict, 'good');
  assert.throws(() => d.owner(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'x', verdict: 'maybe' }), /good or bad/);
});

test('latestCounting respects exchange, topic and newest-first', () => {
  const d = desk();
  const base = { kind: 'candles', symbol: 'ABC', summary: 'x' };
  const a = d.owner(C.addEvidence, { ...base, exchange: 'NSE', topic: 't1' });
  d.clock.now += 1000;
  const b = d.owner(C.addEvidence, { ...base, exchange: 'NSE', topic: 't1' });
  const find = (q) => d.store.read((s) => latestCounting(s, { kind: 'candles', symbol: 'ABC', today: today(d), ...q }));
  assert.equal(find({ exchange: 'BSE' }), null);
  assert.equal(find({ exchange: 'NSE' }).id, b.id);
  assert.equal(find({ topic: 't2' }), null);
  assert.equal(find({}).id, b.id);
  assert.notEqual(a.id, b.id);
});

test('agents can flag; a flag changes nothing', () => {
  const d = desk();
  const { id } = d.owner(C.addEvidence, { kind: 'fundamentals', symbol: 'ABC', summary: 'x', goodUntil: addDays(today(d), 10) });
  const agent = d.addAgent('draft');
  agent.run(C.flagEvidence, { id, reason: 'Results were restated' });
  const e = rec(d, id);
  assert.equal(e.flags.length, 1);
  assert.equal(e.flags[0].by, `agent:${agent.id}`);
  assert.equal(e.flags[0].reason, 'Results were restated');
  assert.equal(status(d, id), 'verified');
  assert.throws(() => agent.run(C.flagEvidence, { id, reason: '' }), /Reason/i);
});

test('good-until dates are checked', () => {
  const d = desk();
  const { id } = d.addAgent('draft').run(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'x' });
  assert.throws(() => d.owner(C.verifyEvidence, { id, goodUntil: addDays(today(d), -1) }), /good-until/i);
  assert.throws(() => d.owner(C.verifyEvidence, { id, goodUntil: 'soon' }), /good-until/i);
  assert.throws(
    () => d.owner(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'x', goodUntil: addDays(today(d), -1) }),
    /good-until/i,
  );
});

test('owner confirmation of a quote is a new record good for today, same exchange', () => {
  const d = desk();
  const q = d.addAgent('draft').run(C.addEvidence, { kind: 'quote', symbol: 'ABC', exchange: 'BSE', price: 100 });
  assert.equal(status(d, q.id), 'found');
  const c = d.owner(C.addEvidence, { kind: 'quote', symbol: 'ABC', confirms: q.id });
  assert.equal(rec(d, c.id).exchange, 'BSE');
  assert.equal(rec(d, c.id).goodUntil, today(d));
  assert.equal(status(d, c.id), 'verified');
});

test('old owner records without goodUntil are found', () => {
  assert.equal(recordStatus({ by: 'owner', kind: 'news' }, '2026-10-23'), 'found');
});
