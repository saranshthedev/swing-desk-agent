// Read models shared by the browser API and MCP tools.

import { evaluate, portfolio, lotRisk } from './rules.js';
import { sizePlan } from './sizing.js';
import { resolveMarginPct } from './fees.js';
import { planProblem } from './rules.js';
import { UserError } from './settings.js';
import { indiaDate } from './time.js';

export function intentStatus(intent, now) {
  return intent.status === 'pending' && Date.parse(intent.expiresAt) <= now ? 'expired' : intent.status;
}

export function intentView(state, intent, now) {
  const view = { ...intent, status: intentStatus(intent, now) };
  if (intent.status === 'pending') view.evaluation = evaluate(state, intent, now);
  if (intent.kind === 'buy') view.strategyName = state.strategies[intent.strategyId]?.name ?? intent.strategyId;
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
