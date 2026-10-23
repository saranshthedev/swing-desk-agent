import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { evaluate, researchStatus } from '../src/core/rules.js';
import { CHECKLIST_LIBRARY, LIBRARY_ITEMS, SOURCES } from '../src/core/checklist-library.js';
import { BUILTIN_STRATEGIES, validateStrategy } from '../src/core/strategies.js';
import { EVIDENCE_KINDS } from '../src/core/evidence.js';
import { createHandler } from '../src/mcp/server.js';
import { desk, PLAN, readyEvidence } from './helpers.js';

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
  agent.run(C.addEvidence, { kind: 'macro', symbol: 'MARKET', summary: 'Nifty up, VIX calm, Brent flat, USDINR steady' });
  for (const sym of ['AAA', 'BBB']) {
    const r = d.store.read((s, now) => researchStatus(s, sym, 'breakout', now));
    assert.equal(r.checks.find((c) => c.id === 'item:currency-usdinr').status, 'pass');
    assert.equal(r.checks.find((c) => c.id === 'item:fund-promoter').status, 'stale'); // per-stock evidence still needed
  }
});

test('research answers given days ahead count at approval for 5 days, then expire', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const research = attestIds(d, 'breakout', 'research');
  const before = attestIds(d, 'breakout', 'before');
  assert.ok(research.length && before.length);
  d.owner(C.saveResearch, { symbol: 'ABC', strategyId: 'breakout', answers: yes(research) });
  d.clock.now += 3 * 86_400_000; // three days later
  readyEvidence(d, 'ABC', agent);
  const { id } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: PLAN });
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, yes(before)));
  for (const r of research) assert.equal(status(ev, `item:${r}`), 'pass', r);
  assert.equal(ev.ready, true, ev.checks.filter((c) => c.required && c.status !== 'pass').map((c) => c.label).join('; '));
  d.clock.now += 3 * 86_400_000; // six days after the research
  const late = d.store.read((s, now) => evaluate(s, s.intents[id], now, yes(before)));
  assert.equal(status(late, `item:${research[0]}`), 'ask');
});

test('only research-stage “you answer” items can be answered ahead, and a strategy edit clears them', () => {
  const d = desk();
  const before = attestIds(d, 'breakout', 'before');
  assert.throws(() => d.owner(C.saveResearch, { symbol: 'ABC', strategyId: 'breakout', answers: yes([before[0]]) }), /not a research item/);
  const research = attestIds(d, 'breakout', 'research');
  d.owner(C.saveResearch, { symbol: 'ABC', strategyId: 'breakout', answers: yes(research) });
  const s = d.store.read((st) => structuredClone(st.strategies.breakout));
  d.owner(C.saveStrategy, s);
  const r = d.store.read((st, now) => researchStatus(st, 'ABC', 'breakout', now));
  assert.equal(r.checks.find((c) => c.id === `item:${research[0]}`).status, 'ask');
});

test('the Complete strategy is approvable with only its core items answered', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  readyEvidence(d, 'ABC', agent, 'complete');
  const { id } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'complete', thesis: 'x', plan: PLAN });
  const core = d.store.read((s) => Object.fromEntries(s.strategies.complete.items.filter((i) => i.type === 'attest' && i.required).map((i) => [i.id, true])));
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, core));
  assert.equal(ev.ready, true, ev.checks.filter((c) => c.required && c.status !== 'pass').map((c) => c.label).join('; '));
  assert.ok(ev.checks.some((c) => c.status === 'ask' && !c.required), 'optional items stay visible as notes');
});

test('agents can read the library and a stock’s research status, but cannot answer research', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const handle = createHandler(d.store, agent.key);
  const call = (name, args = {}) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).result;
  assert.ok(call('get_checklist_library').structuredContent.groups.length >= 15);
  const r = call('get_research_status', { symbol: 'abc', strategyId: 'pullback' }).structuredContent;
  assert.equal(r.symbol, 'ABC');
  assert.ok(r.checks.some((c) => c.stage === 'research') && r.checks.some((c) => c.stage === 'before'));
  const names = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((t) => t.name);
  assert.ok(!names.some((n) => /research_save|answer/.test(n)));
});
