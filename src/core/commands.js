// Commands turn a request into events. They validate against the current state and never
// mutate it. The same commands serve the owner's browser and MCP agents; who may call which
// command (and whether a PIN is needed) is decided by the HTTP and MCP layers.

import { UserError, validateSettingsPatch, FIXED } from './settings.js';
import { evaluate, orderTicket, planProblem, lotPlan } from './rules.js';
import { estimateCosts, resolveMarginPct, FEE_DEFAULTS } from './fees.js';
import { validateSchedule } from './schedule.js';
import { daysBetween, indiaDate, isDate } from './time.js';
import { EVIDENCE_KINDS, EXCHANGE_KINDS, NEEDS_OWNER_CONFIRMATION } from './evidence.js';
import { counts, suggestGoodUntil } from './knowledge.js';
import { validateStrategy, isExchangeBound } from './strategies.js';
import { LIBRARY_ITEMS, toStrategyItem } from './checklist-library.js';
import { markExchange, markKey, preparable, recordSymbol } from './prepare.js';
import { TRASH_KINDS, findItem } from './state.js';
import { intentStatus } from './views.js';

export { EVIDENCE_KINDS };
export const SCOPES = ['off', 'read', 'draft', 'propose'];

// ---------- small validators ----------

function text(value, label, max, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new UserError(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new UserError(`${label} must be text.`);
  const v = value.trim();
  if (required && !v) throw new UserError(`${label} is required.`);
  if (v.length > max) throw new UserError(`${label} must be at most ${max} characters.`);
  return v;
}

function symbolOf(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9&._-]{0,19}$/.test(s)) throw new UserError('Enter the stock symbol as shown in Kite, for example TATAMOTORS.');
  return s;
}

function positive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new UserError(`${label} must be a number above 0.`);
  return value;
}

function wholeShares(value, label = 'Shares') {
  if (!Number.isInteger(value) || value < 1) throw new UserError(`${label} must be a whole number of 1 or more.`);
  return value;
}

function pastDate(value, now, label) {
  if (!isDate(value)) throw new UserError(`${label} must be a date like 2026-10-23.`);
  if (value > indiaDate(now)) throw new UserError(`${label} cannot be in the future.`);
  return value;
}

function sources(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 10) throw new UserError('Sources must be a list of up to 10 links or names.');
  return list.map((s, i) => text(s, `Source ${i + 1}`, 500));
}

const intentOf = (state, id) => {
  const intent = state.intents[id];
  if (!intent) throw new UserError('That request does not exist.');
  return intent;
};

// ---------- owner settings & automation ----------

export function changeSettings(state, { patch }) {
  validateSettingsPatch(patch, state.settings);
  return { events: [{ type: 'settings.changed', data: { patch } }] };
}

export function setAutomation(state, { paused }) {
  if (paused === state.automationPaused) return { events: [] };
  return { events: [{ type: paused ? 'automation.paused' : 'automation.resumed', data: {} }] };
}

// ---------- agents ----------

export function addAgent(state, input, { newId, now }) {
  const scope = input.scope ?? 'off';
  if (!SCOPES.includes(scope)) throw new UserError('Choose Off, Read, Draft or Propose.');
  const data = {
    id: newId('agent'),
    name: text(input.name, 'Name', 60),
    client: text(input.client, 'App', 80, { required: false }),
    scope,
    limits: agentLimits(input.limits),
    expiresAt: new Date(now + expiryDays(input.expiresDays) * 86_400_000).toISOString(),
  };
  return { events: [{ type: 'agent.added', data }], result: { id: data.id } };
}

export function updateAgent(state, input, { now }) {
  const agent = state.agents[input.id];
  if (!agent) throw new UserError('That agent does not exist.');
  const data = { id: agent.id };
  if (input.scope !== undefined) {
    if (!SCOPES.includes(input.scope)) throw new UserError('Choose Off, Read, Draft or Propose.');
    data.scope = input.scope;
  }
  if (input.limits !== undefined) data.limits = agentLimits(input.limits);
  if (input.expiresDays !== undefined) data.expiresAt = new Date(now + expiryDays(input.expiresDays) * 86_400_000).toISOString();
  if (input.revoked === true) data.revoked = true;
  return { events: [{ type: 'agent.updated', data }] };
}

function agentLimits(limits = {}) {
  const out = { writesPerDay: limits.writesPerDay ?? 50, intentsPerDay: limits.intentsPerDay ?? 5, callsPerHour: limits.callsPerHour ?? 300 };
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new UserError(`${k} must be a whole number from 0 to 10000.`);
  }
  return out;
}

function expiryDays(days = 30) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new UserError('Key lifetime must be 1 to 365 days.');
  return days;
}

// ---------- research ----------

export function addEvidence(state, input, { actor, newId, now }) {
  if (input.confirms !== undefined) return confirmEvidence(state, input, { actor, newId, now });
  const data = evidenceData(input, { actor, newId, now });
  return { events: [{ type: 'evidence.added', data }], result: { id: data.id } };
}

/**
 * Validates a new evidence record and returns its event data. Only the owner can set
 * good-until: owner records count until then (default by kind); agent records never carry one.
 */
function evidenceData(input, { actor, newId, now }) {
  const kind = input.kind;
  if (!EVIDENCE_KINDS[kind]) throw new UserError(`Evidence kind must be one of: ${Object.keys(EVIDENCE_KINDS).join(', ')}.`);
  const observedAt = input.observedAt === undefined ? new Date(now).toISOString() : input.observedAt;
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs) || observedMs > now + 60_000) throw new UserError('The time it was observed must be a real time, not in the future.');
  const data = {
    id: newId('ev'),
    kind,
    symbol: symbolOf(input.symbol),
    observedAt: new Date(observedMs).toISOString(),
    summary: text(input.summary, 'Summary', 2_000, { required: kind !== 'quote' && kind !== 'funding' }),
    sources: sources(input.sources),
  };
  if (EXCHANGE_KINDS.has(kind)) {
    if (input.exchange !== 'NSE' && input.exchange !== 'BSE') throw new UserError('Say which exchange this is for: NSE or BSE.');
    data.exchange = input.exchange;
  }
  if (input.topic !== undefined && input.topic !== '') data.topic = text(input.topic, 'Topic', 80);
  if (input.verdict !== undefined) {
    if (input.verdict !== 'good' && input.verdict !== 'bad') throw new UserError('The verdict must be good or bad.');
    data.verdict = input.verdict;
  }
  if (kind === 'quote') data.price = positive(input.price, 'Price');
  if (kind === 'funding') {
    data.marginPct = positive(resolveMarginPct({ buyType: 'mtf', marginPct: input.marginPct, leverage: input.leverage }), 'Own cash % (or leverage)');
    if (data.marginPct > 100) throw new UserError('Own cash % cannot be above 100.');
  }
  if (actor === 'owner') {
    const observedDate = indiaDate(observedMs);
    data.goodUntil = input.goodUntil === undefined ? suggestGoodUntil(kind, observedDate) : goodUntilDate(input.goodUntil, observedDate);
  }
  return data;
}

/** A good-until date no earlier than `from` (the record's India date, or today). */
function goodUntilDate(value, from) {
  if (!isDate(value)) throw new UserError('Good-until must be a date like 2026-10-30.');
  if (value < from) throw new UserError(`Good-until cannot be before ${from}.`);
  return value;
}

/** The record to act on: it must exist, not be in the Trash and not already be corrected. */
function openRecord(state, id) {
  const e = state.evidence.find((x) => x.id === id);
  if (!e || e.trashed) throw new UserError('That record does not exist.');
  if (e.correctedBy) throw new UserError('That record was already corrected. Use the newer one.');
  return e;
}

/** The owner verifies an agent's record: it then counts until the good-until date. */
export function verifyEvidence(state, input, { actor, now }) {
  if (actor !== 'owner') throw new UserError('Only the owner can verify a record.');
  const e = openRecord(state, input.id);
  if (NEEDS_OWNER_CONFIRMATION.has(e.kind)) throw new UserError('Prices and MTF requirements are confirmed against Kite, not verified.');
  if (EXCHANGE_KINDS.has(e.kind) && e.exchange === undefined) throw new UserError('That record does not say which exchange it is for. Correct it and say the exchange.');
  const today = indiaDate(now);
  // Default: the record's own date plus the kind's days, but never earlier than today.
  const suggested = suggestGoodUntil(e.kind, indiaDate(Date.parse(e.observedAt)));
  const goodUntil = input.goodUntil === undefined
    ? (suggested < today ? today : suggested)
    : goodUntilDate(input.goodUntil, today);
  return { events: [{ type: 'evidence.verified', data: { id: e.id, goodUntil } }], result: { id: e.id, goodUntil } };
}

/**
 * The owner replaces a wrong record. The old one stays (marked corrected); the new one is an
 * owner record, observed now unless said otherwise, that carries over what is not changed.
 */
export function correctEvidence(state, input, ctx) {
  if (ctx.actor !== 'owner') throw new UserError('Only the owner can correct a record.');
  const old = openRecord(state, input.corrects);
  const reason = text(input.reason, 'Reason', 500);
  const carried = {};
  for (const k of ['summary', 'sources', 'topic', 'verdict', 'exchange', 'price', 'marginPct']) if (old[k] !== undefined) carried[k] = old[k];
  const data = { ...evidenceData({ ...carried, ...input, kind: old.kind, symbol: old.symbol }, ctx), corrects: old.id, reason };
  return { events: [{ type: 'evidence.corrected', data }], result: { id: data.id } };
}

/** Anyone with write access can say a record looks wrong. A flag only asks the owner to look. */
export function flagEvidence(state, input) {
  const e = state.evidence.find((x) => x.id === input.id);
  if (!e || e.trashed) throw new UserError('That record does not exist.');
  return { events: [{ type: 'evidence.flagged', data: { id: e.id, reason: text(input.reason, 'Reason', 500) } }] };
}

/**
 * The owner confirms that an agent-gathered price or MTF requirement matches what Kite shows
 * now. The confirmation is a new owner record observed at confirmation time; the agent's
 * original stays as it was.
 */
function confirmEvidence(state, { confirms }, { actor, newId, now }) {
  if (actor !== 'owner') throw new UserError('Only the owner can confirm a price or MTF requirement.');
  const source = state.evidence.find((e) => e.id === confirms);
  if (!source || source.trashed || !NEEDS_OWNER_CONFIRMATION.has(source.kind) || source.by === 'owner') {
    throw new UserError('Only an agent’s price or MTF requirement can be confirmed.');
  }
  if (source.correctedBy) throw new UserError('That record was already corrected. Use the newer one.');
  const data = {
    id: newId('ev'),
    kind: source.kind,
    symbol: source.symbol,
    observedAt: new Date(now).toISOString(),
    summary: `Confirmed by owner against Kite. Found by ${source.by}${source.summary ? `: ${source.summary}` : ''}`.slice(0, 2_000),
    sources: source.sources,
    confirms: source.id,
    ...(source.exchange ? { exchange: source.exchange } : {}),
    goodUntil: indiaDate(now),
    ...(source.kind === 'quote' ? { price: source.price } : { marginPct: source.marginPct }),
  };
  return { events: [{ type: 'evidence.added', data }], result: { id: data.id } };
}

export function addNote(state, input, { newId }) {
  const data = {
    id: newId('note'),
    symbol: input.symbol ? symbolOf(input.symbol) : '',
    title: text(input.title, 'Title', 200),
    body: text(input.body, 'Note', 8_000),
    sources: sources(input.sources),
  };
  return { events: [{ type: 'note.added', data }], result: { id: data.id } };
}

/** A wait/buy/hold/sell call from the owner or an agent. Shown as not verified; never acted on. */
export function addRecommendation(state, input, { newId }) {
  if (!['wait', 'buy', 'hold', 'sell'].includes(input.call)) throw new UserError('The call must be wait, buy, hold or sell.');
  if (input.exchange !== 'NSE' && input.exchange !== 'BSE') throw new UserError('Say which exchange this is for: NSE or BSE.');
  const ids = input.strategyIds ?? [];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !state.strategies[id])) throw new UserError('Strategy ids must be a list of existing strategies.');
  const data = {
    id: newId('rec'),
    symbol: symbolOf(input.symbol),
    exchange: input.exchange,
    call: input.call,
    strategyIds: [...new Set(ids)],
    reasons: text(input.reasons, 'Reasons', 4_000),
    sources: sources(input.sources),
  };
  return { events: [{ type: 'recommendation.added', data }], result: { id: data.id } };
}

// ---------- intents ----------

export function submitIntent(state, input, { actor, newId, now }) {
  const hours = input.expiresInHours ?? FIXED.defaultIntentHours;
  if (!Number.isFinite(hours) || hours <= 0 || hours > FIXED.maxIntentHours) throw new UserError(`A request can stay open for at most ${FIXED.maxIntentHours} hours.`);
  const base = {
    id: newId('int'),
    kind: input.kind,
    thesis: text(input.thesis, 'Reason', 4_000),
    expiresAt: new Date(now + hours * 3_600_000).toISOString(),
  };
  if (input.taskId !== undefined) {
    const task = state.tasks[input.taskId];
    if (!task || `agent:${task.agentId}` !== actor || task.status !== 'claimed') throw new UserError('That task is not claimed by you.');
    const pb = state.playbooks[task.playbookId];
    const used = Object.values(state.intents).filter((i) => i.taskId === task.id).length;
    if (used >= (pb?.maxIntents ?? 0)) throw new UserError(`This playbook allows ${pb?.maxIntents ?? 0} request(s) per run.`);
    base.taskId = task.id;
  }

  if (input.kind === 'buy') {
    const p = input.plan ?? {};
    const plan = {
      exchange: p.exchange ?? 'NSE',
      buyType: p.buyType,
      marginPct: resolveMarginPct(p),
      entry: p.entry, stop: p.stop, target: p.target, days: p.days,
      ...(p.qty !== undefined ? { qty: p.qty } : {}),
      ...(p.exchange === 'BSE' && Number.isFinite(p.bseRatePct) ? { bseRatePct: p.bseRatePct } : {}),
    };
    const problem = planProblem(plan);
    if (problem) throw new UserError(problem);
    const evidenceIds = input.evidenceIds ?? [];
    if (!Array.isArray(evidenceIds) || evidenceIds.length > 20 || evidenceIds.some((id) => !state.evidence.some((e) => e.id === id && !e.trashed))) {
      throw new UserError('evidenceIds must list up to 20 existing evidence ids.');
    }
    const strategy = state.strategies[input.strategyId];
    if (!strategy || !strategy.enabled || strategy.trashed) {
      throw new UserError(`Choose a strategy: ${Object.values(state.strategies).filter((s) => s.enabled && !s.trashed).map((s) => s.id).join(', ')}.`);
    }
    const claims = {};
    for (const [itemId, claim] of Object.entries(input.claims ?? {})) {
      if (!strategy.items.some((i) => i.id === itemId && i.type === 'attest')) throw new UserError(`“${itemId}” is not a yes/no item in ${strategy.name}.`);
      claims[itemId] = text(claim, `Claim for ${itemId}`, 500);
    }
    return {
      events: [{ type: 'intent.submitted', data: { ...base, symbol: symbolOf(input.symbol), plan, evidenceIds, strategyId: strategy.id, strategyVersion: strategy.version, claims } }],
      result: { id: base.id },
    };
  }

  if (input.kind === 'exit') {
    const lot = state.lots[input.lotId];
    if (!lot || lot.status !== 'open') throw new UserError('That lot is not open.');
    const qty = wholeShares(input.qty);
    if (qty > lot.remaining) throw new UserError(`Only ${lot.remaining} shares remain in this lot.`);
    return { events: [{ type: 'intent.submitted', data: { ...base, symbol: lot.symbol, lotId: lot.id, qty } }], result: { id: base.id } };
  }

  if (input.kind === 'settings') {
    validateSettingsPatch(input.patch, state.settings);
    return { events: [{ type: 'intent.submitted', data: { ...base, symbol: '', patch: input.patch } }], result: { id: base.id } };
  }
  throw new UserError('kind must be buy, exit or settings.');
}

export function approveIntent(state, { id, answers = {} }, { now }) {
  const intent = intentOf(state, id);
  if (intent.status !== 'pending') throw new UserError(`This request is already ${intent.status}.`);
  if (intent.trashed) throw new UserError('This request is in the Trash. Restore it first.');
  const ev = evaluate(state, intent, now, answers);
  if (!ev.ready) {
    const blocking = ev.checks.filter((c) => c.required && c.status !== 'pass').map((c) => c.label);
    throw new UserError(`Not ready to approve: ${blocking.join(', ')}.`);
  }
  const data = { id, checks: ev.checks, answers, ticket: orderTicket(intent, ev, state.lots[intent.lotId]) };
  if (intent.kind === 'buy') Object.assign(data, { plan: ev.plan, sizing: ev.sizing, fees: { ...state.fees } });
  const events = [{ type: 'intent.approved', data }];
  if (intent.kind === 'settings') events.push({ type: 'settings.changed', data: { patch: intent.patch, intentId: id } });
  return { events, result: { ticket: data.ticket } };
}

export function rejectIntent(state, { id, reason }) {
  const intent = intentOf(state, id);
  if (intent.status !== 'pending') throw new UserError(`This request is already ${intent.status}.`);
  return { events: [{ type: 'intent.rejected', data: { id, reason: text(reason, 'Reason', 1_000, { required: false }) } }] };
}

export function withdrawIntent(state, { id }, { actor }) {
  const intent = intentOf(state, id);
  if (intent.by !== actor) throw new UserError('You can only withdraw your own requests.');
  if (intent.status !== 'pending') throw new UserError(`This request is already ${intent.status}.`);
  return { events: [{ type: 'intent.withdrawn', data: { id } }] };
}

// ---------- fills (always entered by the owner after acting in Kite) ----------

export function recordBuyFill(state, input, { newId, now }) {
  const intent = intentOf(state, input.intentId);
  if (intent.kind !== 'buy' || intent.status !== 'approved') throw new UserError('Record a buy only for an approved buy request.');
  const approved = intent.decision.sizing.qty;
  const filled = Object.values(state.lots).filter((l) => l.intentId === intent.id).reduce((a, l) => a + l.qty, 0);
  const qty = wholeShares(input.qty);
  if (filled + qty > approved) throw new UserError(`Only ${approved - filled} more shares were approved.`);
  const p = intent.decision.plan;
  const lot = {
    id: newId('lot'),
    intentId: intent.id,
    symbol: intent.symbol,
    exchange: p.exchange,
    ...(p.bseRatePct !== undefined ? { bseRatePct: p.bseRatePct } : {}),
    buyType: p.buyType,
    marginPct: p.marginPct,
    qty,
    entry: positive(input.price, 'Actual buy price'),
    date: pastDate(input.date, now, 'Buy date'),
    stop: p.stop,
    target: p.target,
    plannedDays: p.days,
    fees: intent.decision.fees ?? { ...FEE_DEFAULTS },
  };
  const events = [{ type: 'lot.opened', data: lot }];
  if (filled + qty === approved) events.push({ type: 'intent.filled', data: { id: intent.id } });
  return { events, result: { lotId: lot.id } };
}

export function recordSale(state, input, { newId, now }) {
  const lot = state.lots[input.lotId];
  if (!lot || lot.status !== 'open') throw new UserError('That lot is not open.');
  const qty = wholeShares(input.qty);
  if (qty > lot.remaining) throw new UserError(`Only ${lot.remaining} shares remain in this lot.`);
  const price = positive(input.price, 'Actual sell price');
  const date = pastDate(input.date, now, 'Sell date');
  if (date < lot.date) throw new UserError('The sell date cannot be before the buy date.');
  const events = [];
  if (input.intentId) {
    const intent = intentOf(state, input.intentId);
    if (intent.kind !== 'exit' || intent.status !== 'approved' || intent.lotId !== lot.id) throw new UserError('That is not an approved exit for this lot.');
    events.push({ type: 'intent.filled', data: { id: intent.id } });
  }
  // Actual allocated contract-note + funding charges override the estimate. The estimate
  // treats each partial sale as its own round trip, which can repeat fixed fees (disclosed).
  let charges;
  let chargesEstimated = false;
  if (input.charges !== undefined && input.charges !== null && input.charges !== '') {
    if (!Number.isFinite(input.charges) || input.charges < 0) throw new UserError('Actual charges must be 0 or more.');
    charges = input.charges;
  } else {
    const sameDay = date === lot.date;
    charges = estimateCosts({ ...lotPlan(lot), sameDay }, qty, price, sameDay ? 0 : daysBetween(lot.date, date), lot.fees).total;
    chargesEstimated = true;
  }
  const sale = { saleId: newId('sale'), lotId: lot.id, qty, price, date, charges, chargesEstimated, pnl: (price - lot.entry) * qty - charges, ...(input.intentId ? { intentId: input.intentId } : {}) };
  events.unshift({ type: 'lot.sold', data: sale });
  return { events, result: { saleId: sale.saleId, pnl: sale.pnl } };
}

export function changeStop(state, { lotId, stop }) {
  const lot = state.lots[lotId];
  if (!lot || lot.status !== 'open') throw new UserError('That lot is not open.');
  positive(stop, 'Stop');
  return { events: [{ type: 'lot.stopChanged', data: { lotId, stop } }] };
}

// ---------- research (stage 1, days before the trade) ----------

/**
 * Old research answers for a stock + strategy. Still accepted by the web page until it moves to
 * markPrepared, but research.answered no longer satisfies any check.
 */
export function saveResearch(state, { symbol, strategyId, answers }) {
  const strategy = state.strategies[strategyId];
  if (!strategy) throw new UserError('Choose a strategy.');
  if (!answers || typeof answers !== 'object' || !Object.keys(answers).length) throw new UserError('Nothing to save.');
  for (const [id, v] of Object.entries(answers)) {
    const item = strategy.items.find((i) => i.id === id);
    if (!item || item.type !== 'attest' || (item.stage ?? 'before') !== 'research') throw new UserError(`“${id}” is not a research item you can answer ahead in ${strategy.name}.`);
    if (typeof v !== 'boolean') throw new UserError('Answers must be yes or no.');
  }
  return { events: [{ type: 'research.answered', data: { symbol: symbolOf(symbol), strategyId, strategyVersion: strategy.version, answers } }] };
}

/**
 * The owner marks a research item as prepared for a stock (or removes the mark with yes:
 * false). The item comes from the strategy, or from the checklist library when no strategy is
 * given. Evidence items need a record that counts now, for this stock (MARKET for market-wide
 * items), of the item's kind and, for exchange data, on the same exchange. The mark counts
 * only after the strategy's wait (see prepare.js).
 */
export function markPrepared(state, input, { actor, now }) {
  if (actor !== 'owner') throw new UserError('Only the owner can prepare research items.');
  const symbol = symbolOf(input.symbol);
  let strategy = null;
  let item;
  if (input.strategyId !== undefined && input.strategyId !== null && input.strategyId !== '') {
    strategy = state.strategies[input.strategyId];
    if (!strategy || strategy.trashed) throw new UserError('Choose a strategy.');
    item = strategy.items.find((i) => i.id === input.itemId);
  } else {
    const lib = LIBRARY_ITEMS.find((i) => i.id === input.itemId);
    item = lib && toStrategyItem(lib);
  }
  if (!item || !preparable(item)) throw new UserError(`“${input.itemId}” is not a research item you can prepare ahead${strategy ? ` in ${strategy.name}` : ''}.`);
  if (typeof input.yes !== 'boolean') throw new UserError('Say yes or no.');
  const exchange = markExchange(item, input.exchange);
  if (isExchangeBound(item) && exchange !== 'NSE' && exchange !== 'BSE') throw new UserError('This item rests on exchange data. Say which exchange you checked: NSE or BSE.');
  const data = { symbol, key: markKey(strategy ?? { id: '' }, item), ...(exchange ? { exchange } : {}), yes: input.yes };
  if (input.yes && item.type === 'evidence') {
    const want = recordSymbol(item, symbol);
    const e = state.evidence.find((x) => x.id === input.evidenceId);
    if (!e || e.trashed) throw new UserError(`Choose the verified “${item.kind}” record this rests on.`);
    if (e.kind !== item.kind) throw new UserError(`This item needs a “${item.kind}” record, not “${e.kind}”.`);
    if (e.symbol !== want) throw new UserError(`This item needs a record saved under ${want}.`);
    if (isExchangeBound(item) && EXCHANGE_KINDS.has(e.kind)) {
      if (e.exchange === undefined) throw new UserError('That record does not say which exchange it is for. Correct it and say the exchange.');
      if (e.exchange !== exchange) throw new UserError(`That record is for ${e.exchange}, not ${exchange}.`);
    }
    if (!counts(e, indiaDate(now))) throw new UserError('That record does not count yet: only records you entered or verified, still within good-until, can be used.');
    data.evidenceId = e.id;
  }
  return { events: [{ type: 'prepare.marked', data }] };
}

// ---------- strategies ----------

export function saveStrategy(state, input) {
  const clean = validateStrategy(input);
  if (state.strategies[clean.id]?.trashed) throw new UserError('A strategy with this id is in the Trash. Restore it there, or use another id.');
  const version = (state.strategies[clean.id]?.version ?? 0) + 1;
  return { events: [{ type: 'strategy.saved', data: { ...clean, version } }], result: { id: clean.id, version } };
}

// ---------- playbooks & tasks ----------

export function savePlaybook(state, input, { newId }) {
  if (input.agentId && (!state.agents[input.agentId] || state.agents[input.agentId].trashed)) throw new UserError('Choose an existing agent.');
  if (input.id !== undefined && !state.playbooks[input.id]) throw new UserError('That playbook does not exist.');
  if (input.id !== undefined && state.playbooks[input.id].trashed) throw new UserError('That playbook is in the Trash. Restore it first.');
  const maxIntents = input.maxIntents ?? 0;
  if (!Number.isInteger(maxIntents) || maxIntents < 0 || maxIntents > 20) throw new UserError('Requests per run must be 0 to 20.');
  const data = {
    id: input.id ?? newId('pb'),
    name: text(input.name, 'Name', 80),
    agentId: input.agentId || null,
    schedule: validateSchedule(input.schedule),
    instructions: text(input.instructions, 'Instructions', 8_000),
    maxIntents,
    enabled: input.enabled !== false,
  };
  return { events: [{ type: 'playbook.saved', data }], result: { id: data.id } };
}

export function claimTask(state, _input, { actor }) {
  const agentId = actor.replace(/^agent:/, '');
  const task = Object.values(state.tasks)
    .filter((t) => t.agentId === agentId && t.status === 'queued' && !state.playbooks[t.playbookId]?.trashed)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  if (!task) return { events: [], result: null };
  return { events: [{ type: 'task.claimed', data: { id: task.id } }], result: task.id };
}

export function finishTask(state, { taskId, summary, failed }, { actor }) {
  const task = state.tasks[taskId];
  if (!task || `agent:${task.agentId}` !== actor || task.status !== 'claimed') throw new UserError('That task is not claimed by you.');
  const body = text(summary, failed ? 'Reason' : 'Summary', 4_000);
  return { events: [failed ? { type: 'task.failed', data: { id: taskId, reason: body } } : { type: 'task.completed', data: { id: taskId, summary: body } }] };
}

// ---------- trash (owner only; hides items, never removes events) ----------

const busyTask = (t) => t.status === 'queued' || t.status === 'claimed';

/** Why an item may not go to the Trash yet, in plain words; null when it may. */
function trashBlocker(state, kind, item, now) {
  if (kind === 'request') {
    if (item.status === 'approved') return 'This request is approved. Record the fill from Kite first.';
    if (intentStatus(item, now) === 'pending') return 'This request is still waiting. Reject it first.';
  }
  if (kind === 'lot') {
    if (item.status === 'open') return 'This lot is still open. Record the sale of all its shares first.';
    if (state.intents[item.intentId]?.status === 'approved') return 'Its buy request still expects more shares. Wait until it is filled.';
  }
  if (kind === 'strategy' && Object.values(state.intents).some((i) => i.strategyId === item.id && intentStatus(i, now) === 'pending')) {
    return 'Requests are waiting on this strategy. Reject them first.';
  }
  if (kind === 'playbook' && Object.values(state.tasks).some((t) => t.playbookId === item.id && busyTask(t))) {
    return 'This playbook has a job queued or running. Wait until it finishes.';
  }
  if (kind === 'agent' && !item.revoked) return 'This agent is still connected. Disconnect it first.';
  if (kind === 'task' && busyTask(item)) return 'This job is queued or running. Wait until it finishes.';
  return null;
}

function trashTarget(state, { kind, id }) {
  if (!TRASH_KINDS.includes(kind)) throw new UserError('That kind of item cannot go to the Trash.');
  const item = findItem(state, kind, id);
  if (!item || item.purged) throw new UserError(`That ${kind} does not exist.`);
  return item;
}

export function moveToTrash(state, input, { now }) {
  const item = trashTarget(state, input);
  if (item.trashed) throw new UserError('It is already in the Trash.');
  const blocker = trashBlocker(state, input.kind, item, now);
  if (blocker) throw new UserError(blocker);
  return { events: [{ type: 'item.trashed', data: { kind: input.kind, id: input.id } }] };
}

export function restoreFromTrash(state, input) {
  const item = trashTarget(state, input);
  if (!item.trashed) throw new UserError('It is not in the Trash.');
  return { events: [{ type: 'item.restored', data: { kind: input.kind, id: input.id } }] };
}

/** Hide for good (`all: true` empties the Trash). The record stays in the ledger so its chain still checks out. */
export function purgeFromTrash(state, input) {
  if (input.all === true) {
    const events = TRASH_KINDS.flatMap((kind) => trashedItems(state, kind).map((item) => ({ type: 'item.purged', data: { kind, id: item.id } })));
    if (!events.length) throw new UserError('The Trash is already empty.');
    return { events, result: { count: events.length } };
  }
  const item = trashTarget(state, input);
  if (!item.trashed) throw new UserError('Move it to the Trash first.');
  return { events: [{ type: 'item.purged', data: { kind: input.kind, id: input.id } }], result: { count: 1 } };
}

export function trashedItems(state, kind) {
  const all = { evidence: state.evidence, note: state.notes, request: Object.values(state.intents), lot: Object.values(state.lots), strategy: Object.values(state.strategies), playbook: Object.values(state.playbooks), agent: Object.values(state.agents), task: Object.values(state.tasks) }[kind];
  return all.filter((x) => x.trashed && !x.purged);
}
