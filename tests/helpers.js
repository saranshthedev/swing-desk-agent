import { Store } from '../src/store/store.js';
import * as C from '../src/core/commands.js';
import { EXCHANGE_KINDS } from '../src/core/evidence.js';
import { latestCounting } from '../src/core/knowledge.js';
import { indiaDate } from '../src/core/time.js';

// Friday 23 Oct 2026, 11:00 IST.
export const FRIDAY_11_IST = Date.parse('2026-10-23T05:30:00Z');

export function desk(start = FRIDAY_11_IST) {
  const clock = { now: start };
  const store = new Store(':memory:', { clock: () => clock.now });
  store.setPin('123456');
  const as = (actor) => (fn, input) => store.run(actor, (s, ctx) => fn(s, input, ctx));
  const owner = as('owner');
  const addAgent = (scope, limits) => {
    const { id } = owner(C.addAgent, { name: `${scope} agent`, scope, limits });
    return { id, key: store.issueKey(id), run: as(`agent:${id}`) };
  };
  return { store, clock, owner, as, addAgent };
}

export const PLAN = { exchange: 'NSE', buyType: 'mtf', marginPct: 50, entry: 100, stop: 95, target: 116, days: 10 };

/**
 * Counting evidence for every evidence item of a strategy (market-wide ones under MARKET), plus
 * fresh price data. Without an agent the owner enters each record; with one, the agent finds it
 * and the owner verifies it (only owner-entered or owner-verified records count).
 */
export function readyEvidence(d, symbol = 'ABC', agent, strategyId = 'breakout') {
  const items = d.store.read((s) => s.strategies[strategyId].items.filter((i) => i.type === 'evidence'));
  const done = new Set();
  for (const i of [...items, { kind: 'news', scope: 'stock' }]) {
    const sym = i.scope === 'market' ? 'MARKET' : symbol;
    if (done.has(i.kind + sym)) continue;
    done.add(i.kind + sym);
    const input = { kind: i.kind, symbol: sym, summary: `Checked ${i.kind}`, ...(EXCHANGE_KINDS.has(i.kind) ? { exchange: 'NSE' } : {}) };
    if (agent) d.owner(C.verifyEvidence, { id: agent.run(C.addEvidence, input).id });
    else d.owner(C.addEvidence, input);
  }
  d.owner(C.addEvidence, { kind: 'quote', symbol, exchange: 'NSE', price: 100.1 });
  d.owner(C.addEvidence, { kind: 'funding', symbol, marginPct: 40, summary: 'Kite' });
}

/**
 * The owner prepares every required research item of a strategy for a stock (evidence items
 * on a counting owner record, entered if none exists), then the clock moves on 3 days so the
 * marks are past the default wait.
 */
export function prepareAll(d, symbol = 'ABC', strategyId = 'breakout', exchange = 'NSE') {
  const items = d.store.read((s) => s.strategies[strategyId].items.filter((i) => i.stage === 'research' && i.required && (i.type === 'attest' || i.type === 'evidence')));
  for (const item of items) {
    let evidenceId;
    if (item.type === 'evidence') {
      const sym = item.scope === 'market' ? 'MARKET' : symbol;
      const ex = EXCHANGE_KINDS.has(item.kind) ? exchange : undefined;
      const found = d.store.read((s, now) => latestCounting(s, { kind: item.kind, symbol: sym, exchange: ex, today: indiaDate(now) }));
      evidenceId = found?.id ?? d.owner(C.addEvidence, { kind: item.kind, symbol: sym, summary: `Prepared ${item.kind}`, ...(ex ? { exchange: ex } : {}) }).id;
    }
    d.owner(C.markPrepared, { symbol, strategyId, itemId: item.id, exchange, evidenceId, yes: true });
  }
  d.clock.now += 3 * 86_400_000;
}

/** “Yes” to every you-answer item of a strategy. */
export const answersFor = (d, strategyId = 'breakout') =>
  d.store.read((s) => Object.fromEntries(s.strategies[strategyId].items.filter((i) => i.type === 'attest').map((i) => [i.id, true])));
