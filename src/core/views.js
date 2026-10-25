// Read models shared by the browser API and MCP tools.

import { evaluate, portfolio, lotRisk, intentReadyOn } from './rules.js';
import { sizePlan } from './sizing.js';
import { resolveMarginPct } from './fees.js';
import { planProblem } from './rules.js';
import { UserError } from './settings.js';
import { indiaDate } from './time.js';
import { TRASH_KINDS } from './state.js';
import { trashedItems } from './commands.js';

export function intentStatus(intent, now) {
  return intent.status === 'pending' && Date.parse(intent.expiresAt) <= now ? 'expired' : intent.status;
}

export function intentView(state, intent, now) {
  const view = { ...intent, status: intentStatus(intent, now) };
  if (intent.status === 'pending') view.evaluation = evaluate(state, intent, now);
  if (intent.kind === 'buy') {
    view.strategyName = state.strategies[intent.strategyId]?.name ?? intent.strategyId;
    view.readyOn = intentReadyOn(state, intent, now);
  }
  if (intent.kind === 'buy' || intent.kind === 'exit') {
    view.lots = Object.values(state.lots).filter((l) => l.intentId === intent.id).map((l) => l.id);
  }
  return view;
}

export function lotView(lot) {
  const realised = lot.sales.reduce((a, s) => a + s.pnl, 0);
  return { ...lot, risk: lotRisk(lot), realised };
}

export function deskStatus(state, now) {
  const today = indiaDate(now);
  const intents = Object.values(state.intents);
  return {
    today,
    settings: state.settings,
    automationPaused: state.automationPaused,
    portfolio: portfolio(state, now),
    pendingRequests: intents.filter((i) => intentStatus(i, now) === 'pending').length,
    approvedNotFilled: intents.filter((i) => i.status === 'approved').length,
    fees: { checkedOn: state.fees.checkedOn, source: state.fees.source },
  };
}

/** What-if sizing for a plan; nothing is saved. */
export function previewPlan(state, input) {
  const plan = {
    exchange: input.exchange ?? 'NSE',
    buyType: input.buyType,
    marginPct: resolveMarginPct(input),
    entry: input.entry, stop: input.stop, target: input.target, days: input.days,
    ...(input.qty !== undefined ? { qty: input.qty } : {}),
  };
  const problem = planProblem(plan);
  if (problem) throw new UserError(problem);
  return { plan, sizing: sizePlan(plan, state.settings, state.fees) };
}

export function recentFirst(list, limit, filter = () => true) {
  const out = [];
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) if (filter(list[i])) out.push(list[i]);
  return out;
}

/** A short name for an item, shown in the Trash. */
function trashLabel(state, kind, x) {
  switch (kind) {
    case 'evidence': return `${x.symbol} · ${x.kind}${x.price ? ` ₹${x.price}` : x.summary ? `: ${x.summary.slice(0, 80)}` : ''}`;
    // Pasted sections share a title per kind; the exchange and as-of date tell versions apart.
    case 'note': return `${x.symbol ? `${x.symbol} · ` : ''}${x.title}${x.section ? `${x.exchange ? ` · ${x.exchange}` : ''} · as of ${x.asOf}` : ''}`;
    case 'request': return x.kind === 'buy' ? `Buy ${x.symbol}` : x.kind === 'exit' ? `Sell ${x.qty} ${x.symbol}` : 'Settings change';
    case 'lot': return `${x.symbol} · ${x.qty} shares bought ${x.date}`;
    case 'task': return `${state.playbooks[x.playbookId]?.name ?? 'Playbook'} job due ${x.dueAt.slice(0, 16).replace('T', ' ')} UTC`;
    default: return x.name;
  }
}

/** Items in the Trash (not purged), newest first. */
export function trashView(state) {
  return TRASH_KINDS.flatMap((kind) => trashedItems(state, kind).map((x) => ({ kind, id: x.id, label: trashLabel(state, kind, x), at: x.trashed })))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function purgedIds(state) {
  const ids = new Set();
  for (const kind of TRASH_KINDS) {
    const all = { evidence: state.evidence, note: state.notes, request: Object.values(state.intents), lot: Object.values(state.lots), strategy: Object.values(state.strategies), playbook: Object.values(state.playbooks), agent: Object.values(state.agents), task: Object.values(state.tasks) }[kind];
    for (const x of all) if (x.purged) ids.add(x.id);
  }
  return ids;
}
