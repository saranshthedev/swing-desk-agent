import { Store } from '../src/store/store.js';
import * as C from '../src/core/commands.js';

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

/** Evidence for every evidence item of a strategy (market-wide ones under MARKET), plus fresh price data. */
export function readyEvidence(d, symbol = 'ABC', agent, strategyId = 'breakout') {
  const by = agent ? agent.run : d.owner;
  const items = d.store.read((s) => s.strategies[strategyId].items.filter((i) => i.type === 'evidence'));
  const done = new Set();
  for (const i of [...items, { kind: 'news', scope: 'stock' }]) {
    const sym = i.scope === 'market' ? 'MARKET' : symbol;
    if (done.has(i.kind + sym)) continue;
    done.add(i.kind + sym);
    by(C.addEvidence, { kind: i.kind, symbol: sym, summary: `Checked ${i.kind}` });
  }
  d.owner(C.addEvidence, { kind: 'quote', symbol, price: 100.1 });
  d.owner(C.addEvidence, { kind: 'funding', symbol, marginPct: 40, summary: 'Kite' });
}

/** “Yes” to every you-answer item of a strategy. */
export const answersFor = (d, strategyId = 'breakout') =>
  d.store.read((s) => Object.fromEntries(s.strategies[strategyId].items.filter((i) => i.type === 'attest').map((i) => [i.id, true])));
