import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { evaluate } from '../src/core/rules.js';
import { BUILTIN_STRATEGIES, validateStrategy, hasRequiredResearch, isExchangeBound } from '../src/core/strategies.js';
import { LIBRARY_ITEMS, LIBRARY_GROUPS } from '../src/core/checklist-library.js';
import { desk, PLAN, readyEvidence, answersFor, prepareAll } from './helpers.js';

const NEW = ['trend', 'support-bounce', 'mean-reversion', 'smc', 'gap-hold', 'vcp', 'bull-flag', 'wyckoff-spring', 'rs-leader', 'double-bottom'];
const byId = (id) => BUILTIN_STRATEGIES.find((s) => s.id === id);
const libIds = new Set(LIBRARY_ITEMS.map((i) => i.id));

// Plans that meet each strategy's own rules (stop distance, hold days, reward, no borrowing).
const PLANS = {
  trend: { ...PLAN, target: 122, days: 30 },
  'support-bounce': { ...PLAN, target: 116, days: 10 },
  'mean-reversion': { ...PLAN, buyType: 'regular', marginPct: 100, target: 112, days: 8 },
  smc: { ...PLAN, target: 125, days: 10 },
  'gap-hold': { ...PLAN, buyType: 'regular', marginPct: 100, target: 116, days: 7 },
  vcp: { ...PLAN, target: 120, days: 15 },
  'bull-flag': { ...PLAN, target: 118, days: 12 },
  'wyckoff-spring': { ...PLAN, target: 120, days: 18 },
  'rs-leader': { ...PLAN, target: 125, days: 25 },
  'double-bottom': { ...PLAN, target: 120, days: 18 },
};

test('the Smart Money Concepts group is in the library with research and on-the-day items', () => {
  const group = LIBRARY_GROUPS.find((g) => g.id === 'smc');
  assert.ok(group, 'smc group');
  assert.equal(group.items.length, 16);
  assert.equal(group.items.filter((i) => i.stage === 'research').length, 11);
  assert.ok(group.items.every((i) => i.exchangeBound), 'every SMC item rests on one exchange’s chart');
  assert.ok(group.items.every((i) => !i.core), 'no SMC item is required in the Complete strategy');
  for (const id of ['smc-order-block', 'smc-fvg', 'smc-liquidity', 'smc-discount', 'smc-bos', 'smc-choch']) assert.ok(libIds.has(id), id);
});

test('the Complete strategy gained the SMC items without making them required', () => {
  const complete = byId('complete');
  assert.equal(complete.version, 3);
  const smc = complete.items.filter((i) => i.group === 'smc');
  assert.equal(smc.length, 16);
  assert.ok(smc.every((i) => i.required === false));
});

for (const id of NEW) {
  test(`${id}: built-in validates, has required research and unique ids`, () => {
    const s = byId(id);
    assert.ok(s, id);
    assert.equal(s.version, 1);
    assert.doesNotThrow(() => validateStrategy(s));
    assert.ok(hasRequiredResearch(s));
    assert.equal(new Set(s.items.map((i) => i.id)).size, s.items.length, 'item ids are unique');
    // A strategy's own item id must not shadow a library item, or the two would share one mark.
    for (const i of s.items.filter((x) => !libIds.has(x.id))) assert.ok(!i.id.startsWith('smc-'), i.id);
  });

  test(`${id}: prepared, waited and ticked on the day, it can be approved`, () => {
    const d = desk();
    const agent = d.addAgent('propose');
    prepareAll(d, 'ABC', id);
    readyEvidence(d, 'ABC', agent, id);
    const { id: reqId } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: id, thesis: id, plan: PLANS[id] });
    const ev = d.store.read((s, now) => evaluate(s, s.intents[reqId], now, answersFor(d, id)));
    assert.equal(ev.ready, true, ev.checks.filter((c) => c.required && c.status !== 'pass').map((c) => `${c.label} (${c.status}: ${c.detail})`).join('; '));
    d.owner(C.approveIntent, { id: reqId, answers: answersFor(d, id) });
  });

  test(`${id}: the same day as preparing, it cannot be approved`, () => {
    const d = desk();
    const agent = d.addAgent('propose');
    prepareAll(d, 'ABC', id);
    d.clock.now -= 3 * 86_400_000; // back to the day the items were prepared
    readyEvidence(d, 'ABC', agent, id);
    const { id: reqId } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: id, thesis: id, plan: PLANS[id] });
    const ev = d.store.read((s, now) => evaluate(s, s.intents[reqId], now, answersFor(d, id)));
    assert.equal(ev.ready, false);
    assert.ok(ev.checks.some((c) => c.id.startsWith('item:') && c.status === 'wait'), 'a research item says wait');
    assert.throws(() => d.owner(C.approveIntent, { id: reqId, answers: answersFor(d, id) }));
  });
}

test('mean reversion refuses borrowing', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  prepareAll(d, 'ABC', 'mean-reversion');
  readyEvidence(d, 'ABC', agent, 'mean-reversion');
  const { id } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'mean-reversion', thesis: 'x', plan: { ...PLAN, target: 112, days: 8 } });
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, answersFor(d, 'mean-reversion')));
  assert.equal(ev.ready, false);
  assert.equal(ev.checks.find((c) => c.id === 'item:money-regular-for-events')?.status, 'fail');
});

test('price-chart evidence items in the new strategies are tied to one exchange', () => {
  for (const [sid, itemId] of [['trend', 'trend-200'], ['mean-reversion', 'mr-stretch']]) {
    const item = byId(sid).items.find((i) => i.id === itemId);
    assert.equal(isExchangeBound(item), true, itemId);
  }
});
