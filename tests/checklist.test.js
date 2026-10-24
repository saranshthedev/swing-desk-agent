import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { evaluate, researchStatus } from '../src/core/rules.js';
import { CHECKLIST_LIBRARY, LIBRARY_ITEMS, SOURCES, WINDOW } from '../src/core/checklist-library.js';
import { BUILTIN_STRATEGIES, validateStrategy, strategyWindow, isExchangeBound, hasRequiredResearch } from '../src/core/strategies.js';
import { EVIDENCE_KINDS } from '../src/core/evidence.js';
import { createHandler } from '../src/mcp/server.js';
import { desk, PLAN, readyEvidence, prepareAll } from './helpers.js';

const status = (ev, id) => ev.checks.find((c) => c.id === id)?.status;
const attestIds = (d, strategyId, stage) => d.store.read((s) => s.strategies[strategyId].items.filter((i) => i.type === 'attest' && (!stage || i.stage === stage)).map((i) => i.id));
const yes = (ids) => Object.fromEntries(ids.map((id) => [id, true]));

test('the library is complete and consistent', () => {
  const ids = LIBRARY_ITEMS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(CHECKLIST_LIBRARY.length >= 15 && LIBRARY_ITEMS.length >= 100);
  for (const want of ['zones-weekly-demand', 'zones-monthly-supply', 'commodity-crude', 'currency-usdinr', 'fund-growth', 'fund-promoter', 'global-us', 'market-vix']) assert.ok(ids.includes(want), want);
  for (const i of LIBRARY_ITEMS) {
    assert.ok(['research', 'before'].includes(i.stage), i.id);
    assert.ok(i.help && i.help.length <= 220, `${i.id} help`);
    if (i.check.evidence) assert.ok(EVIDENCE_KINDS[i.check.evidence], `${i.id} evidence kind`);
  }
  for (const [, url] of Object.values(SOURCES)) assert.match(url, /^https:\/\//);
  for (const s of BUILTIN_STRATEGIES) assert.doesNotThrow(() => validateStrategy(s), s.id);
});

test('market-wide evidence saved under MARKET counts for every stock', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const { id } = agent.run(C.addEvidence, { kind: 'macro', symbol: 'MARKET', summary: 'Nifty up, VIX calm, Brent flat, USDINR steady' });
  const usdinr = (sym) => d.store.read((s, now) => researchStatus(s, sym, 'breakout', 'NSE', now)).checks.find((c) => c.id === 'item:currency-usdinr').status;
  assert.equal(usdinr('AAA'), 'stale', 'an agent’s find counts only once verified');
  d.owner(C.verifyEvidence, { id });
  for (const sym of ['AAA', 'BBB']) {
    const r = d.store.read((s, now) => researchStatus(s, sym, 'breakout', 'NSE', now));
    assert.equal(r.checks.find((c) => c.id === 'item:currency-usdinr').status, 'pass');
    assert.equal(r.checks.find((c) => c.id === 'item:fund-promoter').status, 'missing'); // per-stock research still needed
  }
});

test('research prepared days ahead counts at approval from the wait to expire, then expires', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const research = attestIds(d, 'breakout', 'research');
  const before = attestIds(d, 'breakout', 'before');
  assert.ok(research.length && before.length);
  prepareAll(d); // prepared today, clock moves on three days
  readyEvidence(d, 'ABC', agent);
  const { id } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: PLAN });
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, yes(before)));
  for (const r of research) assert.equal(status(ev, `item:${r}`), 'pass', r);
  assert.equal(ev.ready, true, ev.checks.filter((c) => c.required && c.status !== 'pass').map((c) => c.label).join('; '));
  d.clock.now += 3 * 86_400_000; // six days after the research
  const late = d.store.read((s, now) => evaluate(s, s.intents[id], now, { ...yes(before), ...yes(research) }));
  assert.equal(status(late, `item:${research[0]}`), 'expired', 'ticking it on the request page does not renew it');
});

test('only research-stage items can be prepared ahead, and a strategy edit re-judges marks by its new window', () => {
  const d = desk();
  const before = attestIds(d, 'breakout', 'before');
  assert.throws(() => d.owner(C.markPrepared, { symbol: 'ABC', strategyId: 'breakout', itemId: before[0], exchange: 'NSE', yes: true }), /not a research item/);
  assert.throws(() => d.owner(C.saveResearch, { symbol: 'ABC', strategyId: 'breakout', answers: yes([before[0]]) }), /not a research item/);
  const research = attestIds(d, 'breakout', 'research');
  for (const itemId of research) d.owner(C.markPrepared, { symbol: 'ABC', strategyId: 'breakout', itemId, exchange: 'NSE', yes: true });
  d.clock.now += 3 * 86_400_000;
  const r1 = d.store.read((st, now) => researchStatus(st, 'ABC', 'breakout', 'NSE', now));
  assert.equal(r1.checks.find((c) => c.id === `item:${research[0]}`).status, 'pass');
  const s = d.store.read((st) => structuredClone(st.strategies.breakout));
  d.owner(C.saveStrategy, { ...s, bufferDays: 5, expireDays: 10 });
  const r2 = d.store.read((st, now) => researchStatus(st, 'ABC', 'breakout', 'NSE', now));
  assert.equal(r2.version, s.version + 1);
  assert.equal(r2.checks.find((c) => c.id === `item:${research[0]}`).status, 'wait');
});

test('the Complete strategy is approvable with only its core items answered', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  prepareAll(d, 'ABC', 'complete');
  readyEvidence(d, 'ABC', agent, 'complete');
  const { id } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'complete', thesis: 'x', plan: PLAN });
  const core = d.store.read((s) => Object.fromEntries(s.strategies.complete.items.filter((i) => i.type === 'attest' && i.required).map((i) => [i.id, true])));
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, core));
  assert.equal(ev.ready, true, ev.checks.filter((c) => c.required && c.status !== 'pass').map((c) => c.label).join('; '));
  assert.ok(ev.checks.some((c) => c.status === 'ask' && !c.required), 'optional items stay visible as notes');
  assert.ok(ev.checks.some((c) => c.status === 'missing' && !c.required), 'optional research never blocks');
});

test('agents can read the library and a stock’s research status, but cannot answer or prepare research', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const handle = createHandler(d.store, agent.key);
  const call = (name, args = {}) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).result;
  assert.ok(call('get_checklist_library').structuredContent.groups.length >= 15);
  const r = call('get_research_status', { symbol: 'abc', strategyId: 'pullback' }).structuredContent;
  assert.equal(r.symbol, 'ABC');
  assert.equal(r.exchange, 'NSE');
  assert.deepEqual(r.window, { bufferDays: 3, expireDays: 5 });
  assert.equal(r.readyOn, null);
  assert.equal(call('get_research_status', { symbol: 'abc', strategyId: 'pullback', exchange: 'BSE' }).structuredContent.exchange, 'BSE');
  assert.ok(r.checks.some((c) => c.stage === 'research') && r.checks.some((c) => c.stage === 'before'));
  const names = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((t) => t.name);
  assert.ok(!names.some((n) => /research_save|answer|prepare|mark/.test(n)));
});

const attestItem = (id, stage, required = true) => ({ id, stage, type: 'attest', label: id, required });
const strat = (extra = {}) => ({ id: 'tmp', name: 'Tmp', items: [attestItem('a', 'research'), attestItem('b', 'before')], ...extra });

test('window limits are enforced', () => {
  assert.deepEqual(WINDOW, { minBuffer: 3, maxExpire: 21, defaultBuffer: 3, defaultExpire: 5 });
  assert.throws(() => validateStrategy(strat({ bufferDays: 2 })), /at least 3/);
  assert.throws(() => validateStrategy(strat({ expireDays: 22 })), /at most 21/);
  assert.throws(() => validateStrategy(strat({ bufferDays: 6, expireDays: 5 })), /expire.*at least.*buffer/i);
  const tight = validateStrategy(strat({ bufferDays: 3, expireDays: 3 }));
  assert.equal(tight.bufferDays, 3);
  assert.equal(tight.expireDays, 3);
  const plain = validateStrategy(strat());
  assert.equal(plain.bufferDays, 3);
  assert.equal(plain.expireDays, 5);
});

test('a strategy needs a required research item', () => {
  const allBefore = [attestItem('a', 'before'), attestItem('b', 'before')];
  assert.throws(() => validateStrategy(strat({ items: allBefore })), /required research item/);
  assert.throws(() => validateStrategy(strat({ items: [attestItem('a', 'research', false), attestItem('b', 'before')] })), /required research item/);
  const ruleOnly = { id: 'r', stage: 'research', type: 'rule', rule: 'maxDays', value: 10, label: 'x', required: true };
  assert.throws(() => validateStrategy(strat({ items: [ruleOnly, attestItem('b', 'before')] })), /required research item/);
  assert.doesNotThrow(() => validateStrategy(strat({ items: [attestItem('a', 'research'), attestItem('b', 'before')] })));
  assert.equal(hasRequiredResearch({ items: allBefore }), false);
  assert.equal(hasRequiredResearch({ items: [attestItem('a', 'research')] }), true);
});

test('exchange-bound defaults', () => {
  const by = (id) => LIBRARY_ITEMS.find((i) => i.id === id).exchangeBound;
  for (const id of ['zones-weekly-demand', 'daily-trend', 'volume-delivery', 'sector-peers']) assert.equal(by(id), true, id);
  for (const id of ['sector-strength', 'sector-trend', 'fund-promoter', 'events-news']) assert.equal(by(id), false, id);
  assert.equal(isExchangeBound({ id: 'sector-trend', exchangeBound: true }), true);
  assert.equal(isExchangeBound({ id: 'daily-trend', exchangeBound: false }), false);
  assert.equal(isExchangeBound({ id: 'my-own-item' }), false);
  const kept = validateStrategy(strat({ items: [{ ...attestItem('a', 'research'), exchangeBound: true }, attestItem('b', 'before')] }));
  assert.equal(kept.items[0].exchangeBound, true);
  assert.ok(!('exchangeBound' in kept.items[1]));
});

test('research evidence has no age limit', () => {
  const research = BUILTIN_STRATEGIES.flatMap((s) => s.items).filter((i) => i.stage === 'research' && i.type === 'evidence');
  assert.ok(research.length > 0);
  for (const i of research) assert.ok(!('maxAgeDays' in i) || i.maxAgeDays === undefined, i.id);
  const research2 = (extra) => ({ id: 'e', stage: 'research', type: 'evidence', kind: 'sector', scope: 'stock', label: 'e', required: true, ...extra });
  const cleaned = validateStrategy(strat({ items: [research2({ maxAgeDays: 4 })] }));
  assert.ok(!('maxAgeDays' in cleaned.items[0]));
  const day = (extra) => ({ ...research2(extra), id: 'd', stage: 'before' });
  assert.throws(() => validateStrategy(strat({ items: [attestItem('a', 'research'), day({})] })), /freshness/);
  assert.throws(() => validateStrategy(strat({ items: [attestItem('a', 'research'), day({ maxAgeDays: 401 })] })), /freshness/);
  assert.equal(validateStrategy(strat({ items: [attestItem('a', 'research'), day({ maxAgeDays: 400 })] })).items[1].maxAgeDays, 400);
});

test('built-ins validate and were bumped', () => {
  const version = Object.fromEntries(BUILTIN_STRATEGIES.map((s) => [s.id, s.version]));
  assert.deepEqual(version, { breakout: 3, pullback: 3, results: 3, trend: 1, 'support-bounce': 1, 'mean-reversion': 1, smc: 1, 'gap-hold': 1, vcp: 1, 'bull-flag': 1, 'wyckoff-spring': 1, 'rs-leader': 1, 'double-bottom': 1, 'cup-handle': 1, 'ascending-triangle': 1, 'inverse-hns': 1, 'ma-reclaim': 1, 'quality-pullback': 1, 'failed-breakdown': 1, 'nr7-squeeze': 1, 'fib-pullback': 1, 'breakout-retest': 1, 'sector-rotation': 1, 'falling-wedge': 1, 'golden-cross': 1, complete: 3 });
  for (const s of BUILTIN_STRATEGIES) {
    assert.doesNotThrow(() => validateStrategy(s), s.id);
    assert.ok(hasRequiredResearch(s), s.id);
    assert.deepEqual(strategyWindow(s), { bufferDays: 3, expireDays: 5 }, s.id);
    assert.equal(s.bufferDays, 3);
    assert.equal(s.expireDays, 5);
  }
});

test('old saved strategy falls back', () => {
  assert.deepEqual(strategyWindow({ items: [] }), { bufferDays: 3, expireDays: 5 });
  assert.deepEqual(strategyWindow({ bufferDays: 4, expireDays: 9, items: [] }), { bufferDays: 4, expireDays: 9 });
  assert.equal(isExchangeBound({ id: 'daily-trend' }), true);
});
