// The desk's state is never saved directly. It is rebuilt by replaying the append-only
// event log through `apply`. Every value a reducer needs (P/L, fee snapshot, ids) is
// computed by a command *before* the event is written, so replay is deterministic.

import { DEFAULT_SETTINGS } from './settings.js';
import { FEE_DEFAULTS } from './fees.js';
import { indiaDate } from './time.js';
import { BUILTIN_STRATEGIES } from './strategies.js';
import { preparedKey } from './prepare.js';

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
    prepared: {},
    recommendations: [],
    usage: {},
  };
}

const reducers = {
  'settings.changed': (s, d) => { s.settings = { ...s.settings, ...d.patch }; },
  'fees.changed': (s, d) => { s.fees = { ...s.fees, ...d.patch }; },
  'automation.paused': (s) => { s.automationPaused = true; },
  'automation.resumed': (s) => { s.automationPaused = false; },
  'strategy.saved': (s, d) => { s.strategies[d.id] = { ...d, builtin: !!s.strategies[d.id]?.builtin }; },
  // Old owner research answers (kept for replay; they no longer satisfy any check, Prepare
  // marks do): stock + strategy → item id → time answered. A new strategy
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
  // A Prepare mark: stock + item key (+ exchange for exchange-bound items) → time marked and
  // the record used. `yes: false` removes the mark.
  'prepare.marked': (s, d, e) => {
    const key = preparedKey(d.symbol, d.key, d.exchange);
    if (d.yes) s.prepared[key] = { at: e.at, ...(d.evidenceId ? { evidenceId: d.evidenceId } : {}) };
    else delete s.prepared[key];
  },

  // A wait/buy/hold/sell call someone stored. Information only; the desk never acts on it.
  'recommendation.added': (s, d, e) => { s.recommendations.push({ ...d, by: e.actor, at: e.at }); },

  'agent.added': (s, d) => { s.agents[d.id] = { ...d, revoked: false }; },
  'agent.updated': (s, d) => { Object.assign(s.agents[d.id], d); },

  'evidence.added': (s, d, e) => { s.evidence.push({ ...d, by: e.actor, at: e.at }); },
  'evidence.verified': (s, d, e) => {
    const ev = s.evidence.find((x) => x.id === d.id);
    ev.verifiedAt = e.at;
    ev.goodUntil = d.goodUntil;
  },
  // The corrected record stays, marked; the new record points back with corrects = old id.
  'evidence.corrected': (s, d, e) => {
    s.evidence.push({ ...d, by: e.actor, at: e.at });
    const old = s.evidence.find((x) => x.id === d.corrects);
    old.correctedBy = d.id;
    old.correctedAt = e.at;
  },
  'evidence.flagged': (s, d, e) => {
    const ev = s.evidence.find((x) => x.id === d.id);
    (ev.flags ??= []).push({ by: e.actor, at: e.at, reason: d.reason });
  },
  'note.added': (s, d, e) => { s.notes.push({ ...d, by: e.actor, at: e.at }); },
  'note.structured': (s, d, e) => {
    s.notes.push({ ...d, by: e.actor, at: e.at });
    const old = d.revises && s.notes.find((n) => n.id === d.revises);
    if (old) old.revisedBy = d.id;
  },

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

  // Trash: a flag on the item, never a removed record. Purged items stay flagged for good.
  'item.trashed': (s, d, e) => { findItem(s, d.kind, d.id).trashed = e.at; },
  'item.restored': (s, d) => { delete findItem(s, d.kind, d.id).trashed; },
  'item.purged': (s, d) => { findItem(s, d.kind, d.id).purged = true; },

  'pin.changed': () => {},
  'backup.created': () => {},
};

/** Kinds of item the owner can move to the Trash, and where each lives in the state. */
export const TRASH_KINDS = ['evidence', 'note', 'request', 'lot', 'strategy', 'playbook', 'agent', 'task'];

export function findItem(state, kind, id) {
  switch (kind) {
    case 'evidence': return state.evidence.find((e) => e.id === id);
    case 'note': return state.notes.find((n) => n.id === id);
    case 'request': return state.intents[id];
    case 'lot': return state.lots[id];
    case 'strategy': return state.strategies[id];
    case 'playbook': return state.playbooks[id];
    case 'agent': return state.agents[id];
    case 'task': return state.tasks[id];
    default: return undefined;
  }
}

/** Not in the Trash and never purged. */
export const live = (item) => !item.trashed;

/** Event types an agent's daily write quota counts, and those its intent quota counts. */
const WRITE_TYPES = new Set(['evidence.added', 'evidence.flagged', 'note.added', 'note.structured', 'recommendation.added', 'task.completed', 'task.failed']);

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
