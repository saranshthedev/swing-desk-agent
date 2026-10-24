// Fixed, model-free checks. An intent can be approved only when every required check passes
// at the moment of approval. Agent claims never satisfy a check that needs owner evidence.

import { estimateCosts, fundingLabel } from './fees.js';
import { sizePlan } from './sizing.js';
import { FIXED } from './settings.js';
import { daysBetween, indiaDate, indiaWeekStart } from './time.js';
import { MARKET, RESEARCH_VALID_DAYS } from './checklist-library.js';

const money = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function lotPlan(lot) {
  return { entry: lot.entry, buyType: lot.buyType, marginPct: lot.marginPct, exchange: lot.exchange, bseRatePct: lot.bseRatePct };
}

export function lotRisk(lot) {
  if (lot.status !== 'open') return 0;
  const drop = Math.max(0, lot.entry - lot.stop) * lot.remaining;
  return drop + estimateCosts(lotPlan(lot), lot.remaining, lot.stop, lot.plannedDays, lot.fees).total;
}

export function portfolio(state, now = Date.now()) {
  const open = Object.values(state.lots).filter((l) => l.status === 'open');
  const weekStart = indiaWeekStart(now);
  let weekPnl = 0;
  let totalPnl = 0;
  for (const lot of Object.values(state.lots)) {
    for (const sale of lot.sales) {
      totalPnl += sale.pnl;
      if (sale.date >= weekStart) weekPnl += sale.pnl;
    }
  }
  const s = state.settings;
  const openRisk = open.reduce((a, l) => a + lotRisk(l), 0);
  const borrowed = open.reduce((a, l) => a + l.entry * l.remaining * (1 - l.marginPct / 100), 0);
  const ownCash = open.reduce((a, l) => a + (l.entry * l.remaining * l.marginPct) / 100, 0);
  return {
    openLots: open.length,
    openSymbols: new Set(open.map((l) => `${l.exchange}:${l.symbol}`)).size,
    openRisk,
    openRiskLimit: (s.capital * s.maxOpenRiskPct) / 100,
    borrowed,
    borrowedLimit: (s.capital * s.maxBorrowedPct) / 100,
    ownCash,
    weekPnl,
    totalPnl,
    weekLossLimit: (s.capital * s.weeklyLossLimitPct) / 100,
    buysPaused: weekPnl <= -(s.capital * s.weeklyLossLimitPct) / 100,
  };
}

export function latestEvidence(state, kind, symbol, { ownerOnly = false } = {}) {
  for (let i = state.evidence.length - 1; i >= 0; i--) {
    const e = state.evidence[i];
    if (!e.trashed && e.kind === kind && e.symbol === symbol && (!ownerOnly || e.by === 'owner')) return e;
  }
  return null;
}

const check = (id, label, status, detail, required = true) => ({ id, label, status, detail, required });

/**
 * `answers` holds the owner's yes/no for the strategy's attest items. Without answers (list
 * views, agents) attest items show as "ask" and the request is not ready.
 */
export function evaluate(state, intent, now = Date.now(), answers = {}) {
  if (intent.kind === 'buy') return evaluateBuy(state, intent, now, answers);
  if (intent.kind === 'exit') return evaluateExit(state, intent, now);
  return evaluateSettings(state, intent, now);
}

function expiryCheck(intent, now) {
  const left = Date.parse(intent.expiresAt) - now;
  return left > 0
    ? check('expiry', 'Request still valid', 'pass', `Expires ${new Date(intent.expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`)
    : check('expiry', 'Request still valid', 'fail', 'This request has expired. Ask for a new one.');
}

function finish(checks, extra = {}) {
  return { checks, ready: checks.every((c) => !c.required || c.status === 'pass'), ...extra };
}

export function planProblem(plan) {
  const n = (v) => Number.isFinite(v) && v > 0;
  if (!n(plan.entry) || !n(plan.stop) || !n(plan.target)) return 'Entry, stop and target must be positive prices.';
  if (!(plan.stop < plan.entry)) return 'The stop must be below the entry price.';
  if (!(plan.target > plan.entry)) return 'The target must be above the entry price.';
  if (!Number.isInteger(plan.days) || plan.days < 1 || plan.days > FIXED.maxHoldDays) return `Holding days must be a whole number from 1 to ${FIXED.maxHoldDays}.`;
  if (!['mtf', 'regular'].includes(plan.buyType)) return 'Choose MTF or Regular.';
  if (plan.buyType === 'mtf' && (!Number.isFinite(plan.marginPct) || plan.marginPct < 100 / FIXED.maxLeverage || plan.marginPct > 100)) {
    return `For MTF, leverage must be 1× to ${FIXED.maxLeverage}× (your own cash ${100 / FIXED.maxLeverage}% to 100% of the buy value).`;
  }
  if (!['NSE', 'BSE'].includes(plan.exchange)) return 'Choose NSE or BSE.';
  if (plan.qty !== undefined && plan.qty !== null && (!Number.isInteger(plan.qty) || plan.qty < 1)) return 'Shares must be a whole number.';
  return '';
}

function strategyChecks(state, intent, plan, sizing, now, answers) {
  const strategy = state.strategies[intent.strategyId];
  if (!strategy || strategy.trashed) return [check('strategy', 'Strategy', 'fail', 'This strategy no longer exists.')];
  if (!strategy.enabled) return [check('strategy', strategy.name, 'fail', 'This strategy is switched off.')];
  if (strategy.version !== intent.strategyVersion) {
    return [check('strategy', strategy.name, 'fail', `The checklist changed after this request (v${intent.strategyVersion} → v${strategy.version}). Ask for a new request.`)];
  }
  const out = [check('strategy', `Strategy: ${strategy.name}`, 'pass', `Checklist version ${strategy.version}`)];
  const ctx = { symbol: intent.symbol, claims: intent.claims, answers, research: researchFor(state, intent.symbol, strategy, now), plan, sizing, now };
  for (const item of strategy.items) out.push(itemCheck(state, item, ctx));
  return out;
}

/** Owner research answers for a stock + strategy that are still valid (same version, ≤ 5 India days old). */
export function researchFor(state, symbol, strategy, now) {
  const saved = state.research[`${symbol}|${strategy.id}`];
  if (!saved || saved.version !== strategy.version) return {};
  const today = indiaDate(now);
  return Object.fromEntries(Object.entries(saved.items).filter(([, at]) => daysBetween(indiaDate(Date.parse(at)), today) <= RESEARCH_VALID_DAYS));
}

/**
 * One strategy checklist item. ctx: { symbol, claims, answers (today's ticks), research (saved
 * research answers), plan & sizing (absent on the Prepare page), now }.
 */
export function itemCheck(state, item, ctx) {
  const meta = { group: item.group ?? null, stage: item.stage ?? 'before', help: item.help ?? '', type: item.type };
  const done = (status, detail) => ({ ...check(`item:${item.id}`, item.label, status, detail, item.type === 'rule' ? true : item.required), ...meta });
  const today = indiaDate(ctx.now);
  if (item.type === 'attest') {
    if (ctx.answers?.[item.id] === true) return done('pass', 'You ticked this now.');
    const researchedAt = meta.stage === 'research' ? ctx.research?.[item.id] : null;
    if (researchedAt) return done('pass', `You checked this in research on ${indiaDate(Date.parse(researchedAt))}. Valid for ${RESEARCH_VALID_DAYS} days.`);
    const claim = ctx.claims?.[item.id];
    return done('ask', claim ? `Agent says (not verified): ${claim}` : (item.help || 'Tick this yourself.'));
  }
  if (item.type === 'evidence') {
    const market = item.scope === 'market';
    const ev = latestEvidence(state, item.kind, market ? MARKET : ctx.symbol);
    const age = ev ? daysBetween(indiaDate(Date.parse(ev.observedAt)), today) : Infinity;
    if (ev && age <= item.maxAgeDays) return done('pass', `${ev.by === 'owner' ? 'You' : 'Agent (not verified)'}${market ? ' · market-wide' : ''}: ${(ev.summary || '').slice(0, 140)}`);
    return done('stale', `Needs “${item.kind}” evidence${market ? ` saved under ${MARKET}` : ''} from ${item.maxAgeDays === 0 ? 'today' : `the last ${item.maxAgeDays} day(s)`}.`);
  }
  if (!ctx.plan) return done('info', 'Checked automatically when you make the plan.');
  const pass = {
    minRewardRisk: () => ctx.sizing.rewardRisk >= item.value,
    maxStopPct: () => ((ctx.plan.entry - ctx.plan.stop) / ctx.plan.entry) * 100 <= item.value,
    maxDays: () => ctx.plan.days <= item.value,
    regularOnly: () => ctx.plan.buyType === 'regular',
  }[item.rule]();
  return done(pass ? 'pass' : 'fail', pass ? 'Plan meets this rule' : 'Plan breaks this rule');
}

/** Research-stage status for a stock before any request exists (the Prepare page and agents). */
export function researchStatus(state, symbol, strategyId, now) {
  const strategy = state.strategies[strategyId];
  if (!strategy) return null;
  const ctx = { symbol, answers: {}, research: researchFor(state, symbol, strategy, now), now };
  const checks = strategy.items.map((item) => itemCheck(state, item, ctx));
  const research = checks.filter((c) => c.stage === 'research');
  return {
    strategyId, strategyName: strategy.name, version: strategy.version, symbol,
    checks,
    researchDone: research.every((c) => !c.required || c.status === 'pass' || c.status === 'info'),
  };
}

export function evaluateBuy(state, intent, now, answers = {}) {
  const plan = { ...intent.plan, sameDay: false, marginPct: intent.plan.buyType === 'regular' ? 100 : intent.plan.marginPct };
  const problem = planProblem(plan);
  if (problem) return finish([check('plan', 'Plan numbers make sense', 'fail', problem), expiryCheck(intent, now)]);

  const s = state.settings;
  const sizing = sizePlan(plan, s, state.fees);
  const p = portfolio(state, now);
  const today = indiaDate(now);
  const checks = [check('plan', 'Plan numbers make sense', 'pass', `Entry ${plan.entry}, stop ${plan.stop}, target ${plan.target}`)];

  if (sizing.suggestedQty === 0) {
    checks.push(check('size', 'Fits your loss limit per trade', 'fail', `Even 1 share would lose more than ${money(sizing.budget)} or need more than ${money(s.cashPerTrade)} of cash.`));
  } else if (sizing.qty > sizing.suggestedQty) {
    checks.push(check('size', 'Fits your loss limit per trade', 'fail', `${sizing.qty} shares is too many. Your limits allow ${sizing.suggestedQty}.`));
  } else {
    checks.push(check('size', 'Fits your loss limit per trade', 'pass', `Loss at stop ${money(sizing.riskAtStop)} of ${money(sizing.budget)} allowed`));
  }

  checks.push(sizing.rewardRisk >= s.minRewardRisk
    ? check('reward', 'Gain is big enough for the risk', 'pass', `${sizing.rewardRisk.toFixed(2)}× (you want at least ${s.minRewardRisk}×)`)
    : check('reward', 'Gain is big enough for the risk', 'fail', `${sizing.rewardRisk.toFixed(2)}× is below your ${s.minRewardRisk}× minimum after charges`));

  checks.push(p.openLots + 1 <= s.maxOpenLots
    ? check('lots', 'Open lots limit', 'pass', `${p.openLots + 1} of ${s.maxOpenLots} after this buy`)
    : check('lots', 'Open lots limit', 'fail', `You already have ${p.openLots} open lots (limit ${s.maxOpenLots}).`));

  const riskAfter = p.openRisk + sizing.riskAtStop;
  checks.push(riskAfter <= p.openRiskLimit
    ? check('openRisk', 'Total loss if every stop is hit', 'pass', `${money(riskAfter)} of ${money(p.openRiskLimit)} after this buy`)
    : check('openRisk', 'Total loss if every stop is hit', 'fail', `${money(riskAfter)} would be over your ${money(p.openRiskLimit)} limit.`));

  if (plan.buyType === 'mtf') {
    const borrowedAfter = p.borrowed + sizing.borrowed;
    checks.push(borrowedAfter <= p.borrowedLimit
      ? check('borrowed', 'Borrowed money limit', 'pass', `${money(borrowedAfter)} of ${money(p.borrowedLimit)} after this buy`)
      : check('borrowed', 'Borrowed money limit', 'fail', `${money(borrowedAfter)} would be over your ${money(p.borrowedLimit)} limit.`));
  }

  checks.push(p.buysPaused
    ? check('weekly', 'Not paused for this week’s losses', 'fail', `This week’s result is ${money(p.weekPnl)}. New buys pause at −${money(p.weekLossLimit)}.`)
    : check('weekly', 'Not paused for this week’s losses', 'pass', `This week so far: ${money(p.weekPnl)}`));

  const quote = latestEvidence(state, 'quote', intent.symbol, { ownerOnly: true });
  const agentQuote = latestEvidence(state, 'quote', intent.symbol);
  const unconfirmed = agentQuote && agentQuote.by !== 'owner' ? ` An agent found ₹${agentQuote.price}; confirm it if Kite shows the same.` : '';
  if (!quote) {
    checks.push(check('quote', 'Fresh price from your broker', 'stale', `Enter or confirm the current price from Kite. Prices count for 5 minutes.${unconfirmed}`));
  } else {
    const age = now - Date.parse(quote.observedAt);
    const gap = (Math.abs(quote.price - plan.entry) / plan.entry) * 100;
    if (age > FIXED.quoteMaxAgeMs) checks.push(check('quote', 'Fresh price from your broker', 'stale', `Your last confirmed price is ${Math.round(age / 60_000)} minutes old. Prices count for 5 minutes.${unconfirmed}`));
    else if (gap > FIXED.quoteMaxGapPct) checks.push(check('quote', 'Fresh price from your broker', 'fail', `Price now ₹${quote.price} is ${gap.toFixed(1)}% away from the planned entry. Ask for a new plan.`));
    else checks.push(check('quote', 'Fresh price from your broker', 'pass', `₹${quote.price} at ${new Date(quote.observedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST`));
  }

  const news = latestEvidence(state, 'news', intent.symbol);
  checks.push(news && indiaDate(Date.parse(news.observedAt)) === today
    ? check('news', 'News checked today', 'pass', `${news.by === 'owner' ? 'You' : 'An agent (not verified)'}: ${news.summary.slice(0, 120)}`)
    : check('news', 'News checked today', 'stale', 'No news check from today (India date) for this stock.'));

  if (plan.buyType === 'mtf') {
    const funding = latestEvidence(state, 'funding', intent.symbol, { ownerOnly: true });
    if (!funding || indiaDate(Date.parse(funding.observedAt)) !== today) {
      const agentFunding = latestEvidence(state, 'funding', intent.symbol);
      const hint = agentFunding && agentFunding.by !== 'owner' ? ` An agent found ${fundingLabel(agentFunding.marginPct)}; confirm it if Kite shows the same.` : '';
      checks.push(check('funding', 'MTF cash requirement checked today', 'stale', `Check this stock’s MTF requirement in Kite today and record or confirm it.${hint}`));
    } else if (funding.marginPct > plan.marginPct + 0.01) {
      // 0.01 tolerance: 3× is 33.33…% and brokers round it to 33.33%.
      checks.push(check('funding', 'MTF cash requirement checked today', 'fail', `Kite allows at most ${fundingLabel(funding.marginPct)}; the plan uses ${fundingLabel(plan.marginPct)}.`));
    } else {
      checks.push(check('funding', 'MTF cash requirement checked today', 'pass', `Kite allows up to ${fundingLabel(funding.marginPct)}; plan uses ${fundingLabel(plan.marginPct)}`));
    }
  }

  checks.push(...strategyChecks(state, intent, plan, sizing, now, answers));

  const attached = (intent.evidenceIds || []).length;
  checks.push(check('evidence', 'Agent evidence attached', 'info', attached ? `${attached} item(s), written by a model, not verified` : 'None attached', false));
  checks.push(expiryCheck(intent, now));
  return finish(checks, { sizing, plan });
}

export function evaluateExit(state, intent, now) {
  const lot = state.lots[intent.lotId];
  const checks = [];
  if (!lot || lot.status !== 'open') checks.push(check('lot', 'Lot is still open', 'fail', 'This lot is closed or does not exist.'));
  else if (intent.qty > lot.remaining) checks.push(check('lot', 'Lot is still open', 'fail', `Only ${lot.remaining} shares remain in this lot.`));
  else checks.push(check('lot', 'Lot is still open', 'pass', `Sell ${intent.qty} of ${lot.remaining} remaining shares`));
  checks.push(expiryCheck(intent, now));
  return finish(checks);
}

export function evaluateSettings(state, intent, now) {
  const checks = Object.entries(intent.patch).map(([k, v]) =>
    check(`setting:${k}`, k, 'info', `${state.settings[k]} → ${v}`, false));
  checks.push(expiryCheck(intent, now));
  return finish(checks);
}

export function orderTicket(intent, evaluation, lot) {
  if (intent.kind === 'buy') {
    const p = evaluation.plan;
    return `BUY ${evaluation.sizing.qty} ${intent.symbol} on ${p.exchange} · ${p.buyType === 'mtf' ? `MTF ${fundingLabel(p.marginPct)}` : 'CNC (Regular)'} · LIMIT ₹${p.entry.toFixed(2)} · then set stop ₹${p.stop.toFixed(2)} and target ₹${p.target.toFixed(2)}`;
  }
  if (intent.kind === 'exit') return `SELL ${intent.qty} ${lot.symbol} on ${lot.exchange} · ${lot.buyType === 'mtf' ? 'MTF' : 'CNC'} · your chosen order type`;
  return '';
}
