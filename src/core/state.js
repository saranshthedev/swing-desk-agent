// The desk's state is never saved directly. It is rebuilt by replaying the append-only
// event log through `apply`. Every value a reducer needs (P/L, fee snapshot, ids) is
// computed by a command *before* the event is written, so replay is deterministic.

import { DEFAULT_SETTINGS } from './settings.js';
import { FEE_DEFAULTS } from './fees.js';
import { indiaDate } from './time.js';
import { BUILTIN_STRATEGIES } from './strategies.js';

export function initialState() {
  return {
    seq: 0,
    settings: { ...DEFAULT_SETTINGS },
    fees: { ...FEE_DEFAULTS },
    automationPaused: false,
    strategies: Object.fromEntries(BUILTIN_STRATEGIES.map((s) => [s.id, structuredClone(s)])),
    agents: {},
    evidence: [],
    notes: [],
    intents: {},
    lots: {},
    playbooks: {},
    tasks: {},
    taskSlots: new Set(),
    research: {},
    usage: {},
  };
}

const reducers = {
  'settings.changed': (s, d) => { s.settings = { ...s.settings, ...d.patch }; },
  'fees.changed': (s, d) => { s.fees = { ...s.fees, ...d.patch }; },
  'automation.paused': (s) => { s.automationPaused = true; },
  'automation.resumed': (s) => { s.automationPaused = false; },
  'strategy.saved': (s, d) => { s.strategies[d.id] = { ...d, builtin: !!s.strategies[d.id]?.builtin }; },
  // Owner research answers for a stock + strategy: item id → time answered. A new strategy
  // version starts a fresh record; `false` removes an answer.
  'research.answered': (s, d, e) => {
    const key = `${d.symbol}|${d.strategyId}`;
    const prev = s.research[key]?.version === d.strategyVersion ? s.research[key].items : {};
    const items = { ...prev };
    for (const [id, yes] of Object.entries(d.answers)) {
      if (yes) items[id] = e.at;
      else delete items[id];
    }
    s.research[key] = { version: d.strategyVersion, items };
  },

  'agent.added': (s, d) => { s.agents[d.id] = { ...d, revoked: false }; },
  'agent.updated': (s, d) => { Object.assign(s.agents[d.id], d); },

  'evidence.added': (s, d, e) => { s.evidence.push({ ...d, by: e.actor, at: e.at }); },
  'note.added': (s, d, e) => { s.notes.push({ ...d, by: e.actor, at: e.at }); },

  'intent.submitted': (s, d, e) => { s.intents[d.id] = { ...d, status: 'pending', by: e.actor, at: e.at }; },
  'intent.approved': (s, d, e) => { Object.assign(s.intents[d.id], { status: 'approved', decision: { ...d, at: e.at } }); },
  'intent.rejected': (s, d, e) => { Object.assign(s.intents[d.id], { status: 'rejected', decision: { ...d, at: e.at } }); },
  'intent.withdrawn': (s, d, e) => { Object.assign(s.intents[d.id], { status: 'withdrawn', decision: { ...d, at: e.at } }); },
  'intent.filled': (s, d) => { s.intents[d.id].status = 'filled'; },

  'lot.opened': (s, d) => { s.lots[d.id] = { ...d, remaining: d.qty, sales: [], status: 'open' }; },
  'lot.sold': (s, d) => {
    const lot = s.lots[d.lotId];
    lot.sales.push(d);
    lot.remaining -= d.qty;
    if (lot.remaining === 0) lot.status = 'closed';
  },
  'lot.stopChanged': (s, d) => { s.lots[d.lotId].stop = d.stop; },

  'playbook.saved': (s, d) => { s.playbooks[d.id] = { ...d }; },
  'task.queued': (s, d) => { s.tasks[d.id] = { ...d, status: 'queued' }; s.taskSlots.add(d.slot); },
  'task.claimed': (s, d, e) => { Object.assign(s.tasks[d.id], { status: 'claimed', claimedAt: e.at }); },
  'task.completed': (s, d, e) => { Object.assign(s.tasks[d.id], { status: 'done', summary: d.summary, doneAt: e.at }); },
  'task.failed': (s, d, e) => { Object.assign(s.tasks[d.id], { status: 'failed', summary: d.reason, doneAt: e.at }); },
  'task.expired': (s, d) => { s.tasks[d.id].status = 'expired'; },

  'pin.changed': () => {},
  'backup.created': () => {},
};

/** Event types an agent's daily write quota counts, and those its intent quota counts. */
const WRITE_TYPES = new Set(['evidence.added', 'note.added', 'task.completed', 'task.failed']);

export function apply(state, event) {
  const reducer = reducers[event.type];
  if (!reducer) throw new Error(`Unknown event type ${event.type} at #${event.seq}.`);
  reducer(state, event.data, event);
  state.seq = event.seq;
  if (event.actor.startsWith('agent:')) {
    const day = indiaDate(Date.parse(event.at));
    const usage = ((state.usage[event.actor] ??= {})[day] ??= { writes: 0, intents: 0 });
    if (WRITE_TYPES.has(event.type)) usage.writes++;
    if (event.type === 'intent.submitted') usage.intents++;
  }
  return state;
}

export const EVENT_TYPES = Object.keys(reducers);
