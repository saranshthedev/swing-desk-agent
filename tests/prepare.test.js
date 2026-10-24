import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { evaluate, researchStatus, masterStatus } from '../src/core/rules.js';
import { markKey } from '../src/core/prepare.js';
import { LIBRARY_ITEMS } from '../src/core/checklist-library.js';
import { desk, PLAN, readyEvidence, answersFor, prepareAll } from './helpers.js';

const DAY = 86_400_000;
const find = (r, id) => r.checks.find((c) => c.id === id);
const research = (d, strategyId, type) => d.store.read((s) => s.strategies[strategyId].items
  .filter((i) => i.stage === 'research' && i.required && (!type || i.type === type)).map((i) => i.id));
const markAll = (d, ids, extra = {}) => { for (const itemId of ids) d.owner(C.markPrepared, { symbol: 'ABC', strategyId: 'breakout', itemId, exchange: 'NSE', yes: true, ...extra }); };
const status = (d, symbol = 'ABC', strategyId = 'breakout', exchange = 'NSE') => d.store.read((s, now) => researchStatus(s, symbol, strategyId, exchange, now));
const buy = (d, extra = {}) => d.owner(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: PLAN, ...extra });

test('nothing counts before buffer days', () => {
  const d = desk();
  const attests = research(d, 'breakout', 'attest');
  markAll(d, attests);
  d.clock.now += 2 * DAY;
  readyEvidence(d);
  const { id } = buy(d);
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, answersFor(d)));
  for (const a of attests) {
    const c = find(ev, `item:${a}`);
    assert.equal(c.status, 'wait', a);
    assert.match(c.detail, /2026-10-26/, a);
  }
  assert.equal(ev.ready, false);
  assert.throws(() => d.owner(C.approveIntent, { id, answers: answersFor(d) }), /Not ready/);
});

test('counts from buffer to expire, then expires', () => {
  const d = desk();
  const attests = research(d, 'breakout', 'attest');
  const start = d.clock.now;
  markAll(d, attests);
  const at = (day) => { d.clock.now = start + day * DAY; return status(d); };
  for (const [day, want] of [[3, 'pass'], [5, 'pass'], [6, 'expired']]) {
    const r = at(day);
    for (const a of attests) assert.equal(find(r, `item:${a}`).status, want, `${a} on day ${day}`);
  }
  assert.match(find(at(6), `item:${attests[0]}`).detail, /2026-10-28/);
});

test('per-strategy window', () => {
  const d = desk();
  const s = d.store.read((st) => structuredClone(st.strategies.breakout));
  d.owner(C.saveStrategy, { ...s, bufferDays: 4, expireDays: 10 });
  const start = d.clock.now;
  markAll(d, ['fund-debt']);
  const on = (day) => { d.clock.now = start + day * DAY; return find(status(d), 'item:fund-debt').status; };
  assert.equal(on(3), 'wait');
  assert.equal(on(4), 'pass');
  assert.equal(on(10), 'pass');
  assert.equal(on(11), 'expired');
  assert.deepEqual(status(d).window, { bufferDays: 4, expireDays: 10 });
  // The same mark under the default window of another strategy.
  d.clock.now = start + 3 * DAY;
  assert.equal(find(status(d, 'ABC', 'pullback'), 'item:fund-debt').status, 'pass');
});

test('request-page answers no longer satisfy research items', () => {
  const d = desk();
  readyEvidence(d);
  const { id } = buy(d);
  const answers = answersFor(d);
  assert.equal(answers['fund-debt'], true);
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, answers));
  assert.equal(find(ev, 'item:fund-debt').status, 'missing');
  assert.equal(find(ev, 'item:mind-calm').status, 'pass', 'on-the-day items still take answers');
  // Old research.answered events are kept but no longer count.
  d.owner(C.saveResearch, { symbol: 'ABC', strategyId: 'breakout', answers: { 'fund-debt': true } });
  d.clock.now += 3 * DAY;
  assert.equal(find(status(d), 'item:fund-debt').status, 'missing');
});

test('evidence research items need a verified record and a mark', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const found = agent.run(C.addEvidence, { kind: 'fundamentals', symbol: 'ABC', summary: 'Promoter 60%' });
  assert.throws(() => markAll(d, ['fund-promoter'], { evidenceId: found.id }), /verified/);
  const { id } = d.owner(C.addEvidence, { kind: 'fundamentals', symbol: 'ABC', summary: 'Promoter 60%, no pledge' });
  assert.equal(find(status(d), 'item:fund-promoter').status, 'missing', 'a record alone is not a mark');
  assert.throws(() => markAll(d, ['fund-promoter']), /record/);
  const other = d.owner(C.addEvidence, { kind: 'sector', symbol: 'ABC', summary: 'Sector strong' });
  assert.throws(() => markAll(d, ['fund-promoter'], { evidenceId: other.id }), /kind|record/);
  const wrongStock = d.owner(C.addEvidence, { kind: 'fundamentals', symbol: 'XYZ', summary: 'x' });
  assert.throws(() => markAll(d, ['fund-promoter'], { evidenceId: wrongStock.id }), /ABC/);
  markAll(d, ['fund-promoter'], { evidenceId: id });
  assert.equal(find(status(d), 'item:fund-promoter').status, 'wait');
  d.clock.now += 3 * DAY;
  assert.equal(find(status(d), 'item:fund-promoter').status, 'pass');
});

test('marks are shared across strategies', () => {
  const d = desk();
  const { id } = d.owner(C.addEvidence, { kind: 'fundamentals', symbol: 'ABC', summary: 'Promoter fine' });
  markAll(d, ['fund-promoter'], { evidenceId: id });
  d.clock.now += 3 * DAY;
  assert.equal(find(status(d, 'ABC', 'breakout'), 'item:fund-promoter').status, 'pass');
  assert.equal(find(status(d, 'ABC', 'pullback'), 'item:fund-promoter').status, 'pass');
  assert.equal(find(status(d, 'XYZ', 'breakout'), 'item:fund-promoter').status, 'missing', 'per stock');
  // Strategy-own items are keyed per strategy.
  const s = d.store.read((st) => st.strategies.pullback);
  assert.equal(markKey(s, s.items.find((i) => i.id === 'pullback-trend')), 'pullback:pullback-trend');
  assert.equal(markKey(s, s.items.find((i) => i.id === 'fund-promoter')), 'fund-promoter');
});

test('exchange-bound marks stay on their exchange', () => {
  const d = desk();
  const { id } = d.owner(C.addEvidence, { kind: 'zones', symbol: 'ABC', exchange: 'NSE', summary: 'Weekly uptrend' });
  assert.throws(() => markAll(d, ['zones-weekly-trend'], { evidenceId: id, exchange: undefined }), /NSE or BSE/);
  assert.throws(() => markAll(d, ['zones-weekly-trend'], { evidenceId: id, exchange: 'BSE' }), /NSE|exchange/);
  markAll(d, ['zones-weekly-trend'], { evidenceId: id });
  markAll(d, ['fund-debt']);
  d.clock.now += 3 * DAY;
  assert.equal(find(status(d, 'ABC', 'breakout', 'NSE'), 'item:zones-weekly-trend').status, 'pass');
  const bse = status(d, 'ABC', 'breakout', 'BSE');
  assert.equal(bse.exchange, 'BSE');
  assert.equal(find(bse, 'item:zones-weekly-trend').status, 'missing');
  assert.equal(find(bse, 'item:fund-debt').status, 'pass', 'not exchange-bound: one mark for both');
});

test('correcting or trashing the record behind a mark breaks it', () => {
  const d = desk();
  const a = d.owner(C.addEvidence, { kind: 'fundamentals', symbol: 'ABC', summary: 'Promoter fine' });
  const b = d.owner(C.addEvidence, { kind: 'sector', symbol: 'ABC', summary: 'Sector strong' });
  markAll(d, ['fund-promoter'], { evidenceId: a.id });
  markAll(d, ['sector-strength'], { evidenceId: b.id });
  d.clock.now += 3 * DAY;
  assert.equal(find(status(d), 'item:fund-promoter').status, 'pass');
  const fixed = d.owner(C.correctEvidence, { corrects: a.id, summary: 'Promoter pledged 40%', reason: 'Misread' });
  d.owner(C.moveToTrash, { kind: 'evidence', id: b.id });
  const r = status(d);
  assert.equal(find(r, 'item:fund-promoter').status, 'broken');
  assert.match(find(r, 'item:fund-promoter').detail, /corrected/);
  assert.equal(find(r, 'item:sector-strength').status, 'broken');
  assert.match(find(r, 'item:sector-strength').detail, /Trash/);
  // Re-preparing on the new record starts a new clock.
  markAll(d, ['fund-promoter'], { evidenceId: fixed.id });
  assert.equal(find(status(d), 'item:fund-promoter').status, 'wait');
});

test('a record past its good-until breaks the mark', () => {
  const d = desk();
  const { id } = d.owner(C.addEvidence, { kind: 'sector', symbol: 'ABC', summary: 'Sector strong', goodUntil: '2026-10-27' });
  markAll(d, ['sector-strength'], { evidenceId: id });
  d.clock.now += 4 * DAY;
  assert.equal(find(status(d), 'item:sector-strength').status, 'pass');
  assert.equal(find(status(d), 'item:sector-strength').expiresOn, '2026-10-27');
  d.clock.now += DAY;
  const c = find(status(d), 'item:sector-strength');
  assert.equal(c.status, 'broken');
  assert.match(c.detail, /2026-10-27/);
});

test('age counts India calendar days, not hours', () => {
  const d = desk(Date.parse('2026-10-23T18:20:00Z')); // 23:50 IST
  markAll(d, ['fund-debt']);
  d.clock.now = Date.parse('2026-10-23T18:40:00Z'); // 00:10 IST, 24 Oct: one India day later
  const c = find(status(d), 'item:fund-debt');
  assert.equal(c.status, 'wait');
  assert.equal(c.validFrom, '2026-10-26');
  d.clock.now = Date.parse('2026-10-25T18:40:00Z'); // 00:10 IST, 26 Oct: 48 h 20 min after the mark
  assert.equal(find(status(d), 'item:fund-debt').status, 'pass');
});

test('agents cannot mark', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  assert.throws(() => agent.run(C.markPrepared, { symbol: 'ABC', strategyId: 'breakout', itemId: 'fund-debt', exchange: 'NSE', yes: true }), /Only the owner/);
});

test('only research items can be marked, and unmarking removes the mark', () => {
  const d = desk();
  assert.throws(() => markAll(d, ['mind-calm']), /research/);
  assert.throws(() => markAll(d, ['nope']), /research|not/);
  markAll(d, ['fund-debt']);
  markAll(d, ['fund-debt'], { yes: false });
  d.clock.now += 3 * DAY;
  assert.equal(find(status(d), 'item:fund-debt').status, 'missing');
  // Library items can be marked without a strategy (the master list).
  d.owner(C.markPrepared, { symbol: 'ABC', itemId: 'fund-debt', yes: true });
  d.clock.now += 3 * DAY;
  assert.equal(find(status(d), 'item:fund-debt').status, 'pass');
});

test('readyOn is the first India day every required research item counts', () => {
  const d = desk();
  assert.equal(status(d).readyOn, null, 'nothing prepared');
  prepareAll(d); // marks on 23 Oct, clock now 26 Oct
  d.clock.now -= 3 * DAY; // look back at 23 Oct: all waiting, ready on 26 Oct
  assert.equal(status(d).readyOn, '2026-10-26');
  assert.equal(status(d).researchDone, false);
  d.clock.now += 3 * DAY;
  const r = status(d);
  assert.equal(r.researchDone, true, r.checks.filter((c) => c.stage === 'research' && c.required && c.status !== 'pass').map((c) => c.id).join(', '));
  assert.equal(r.readyOn, '2026-10-26');
  // Re-prepared today, fund-debt counts from 29 Oct, but the rest stop after 28 Oct: no common day.
  markAll(d, ['fund-debt']);
  assert.equal(status(d).readyOn, null);
  assert.equal(status(d).researchDone, false);
});

test('a fully prepared request is approvable; the gate has no way around the wait', () => {
  const d = desk();
  const attests = research(d, 'breakout');
  assert.ok(attests.length > 5);
  prepareAll(d);
  readyEvidence(d);
  const { id } = buy(d);
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, answersFor(d)));
  assert.equal(ev.ready, true, ev.checks.filter((c) => c.required && c.status !== 'pass').map((c) => `${c.id}: ${c.detail}`).join('; '));
  d.owner(C.approveIntent, { id, answers: answersFor(d) });
});

test('on-the-day evidence counts only on owner-entered or owner-verified records, on the plan’s exchange', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const macro = agent.run(C.addEvidence, { kind: 'macro', symbol: 'MARKET', summary: 'Nifty up' });
  const candles = d.owner(C.addEvidence, { kind: 'candles', symbol: 'ABC', exchange: 'BSE', summary: 'Closed above high' });
  const { id } = buy(d);
  const ev = () => d.store.read((s, now) => evaluate(s, s.intents[id], now, {}));
  assert.equal(find(ev(), 'item:market-nifty-trend').status, 'stale');
  assert.equal(find(ev(), 'item:breakout-close').status, 'stale', 'BSE chart does not count for an NSE plan');
  d.owner(C.verifyEvidence, { id: macro.id });
  d.owner(C.addEvidence, { kind: 'candles', symbol: 'ABC', exchange: 'NSE', summary: 'Closed above high' });
  assert.equal(find(ev(), 'item:market-nifty-trend').status, 'pass');
  assert.equal(find(ev(), 'item:breakout-close').status, 'pass');
  assert.ok(candles.id);
});

test('strategy without required research blocks approval', () => {
  const d = desk();
  const items = [{ id: 'calm', stage: 'before', type: 'attest', label: 'Calm', help: '', required: true }];
  d.store.run('owner', () => ({ events: [{ type: 'strategy.saved', data: { id: 'bare', name: 'Bare', description: '', enabled: true, bufferDays: 3, expireDays: 5, items, version: 1 } }] }));
  readyEvidence(d, 'ABC', undefined, 'bare');
  const { id } = d.owner(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'bare', thesis: 'x', plan: PLAN });
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, { calm: true }));
  const c = find(ev, 'strategy-research');
  assert.equal(c.status, 'fail');
  assert.equal(c.detail, 'This strategy has no required research items. Edit it first.');
  assert.equal(ev.ready, false);
});

test('the master list covers every library item with the default window', () => {
  const d = desk();
  markAll(d, ['fund-debt']);
  d.clock.now += 3 * DAY;
  const m = d.store.read((s, now) => masterStatus(s, 'ABC', 'NSE', now));
  assert.equal(m.checks.length, LIBRARY_ITEMS.length);
  assert.deepEqual(m.window, { bufferDays: 3, expireDays: 5 });
  assert.equal(find(m, 'item:fund-debt').status, 'pass');
  assert.equal(find(m, 'item:fund-growth').status, 'missing');
});
