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

/** Evidence that satisfies the breakout checklist and the global fresh-data checks. */
export function readyEvidence(d, symbol = 'ABC', agent) {
  const by = agent ? agent.run : d.owner;
  by(C.addEvidence, { kind: 'news', symbol, summary: 'No adverse news' });
  by(C.addEvidence, { kind: 'candles', symbol, summary: 'Closed above 20-day high' });
  by(C.addEvidence, { kind: 'calendar', symbol, summary: 'Results on 20 Nov' });
  d.owner(C.addEvidence, { kind: 'quote', symbol, price: 100.1 });
  d.owner(C.addEvidence, { kind: 'funding', symbol, marginPct: 40, summary: 'Kite' });
}

export const BREAKOUT_ANSWERS = { volume: true, market: true };
