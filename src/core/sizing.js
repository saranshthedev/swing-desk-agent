// Position sizing: the largest share count whose loss at the stop (price drop + worse-price
// allowance + estimated charges) fits the per-trade risk budget AND whose own-cash need fits
// the per-trade cash limit. Borrowed MTF money raises exposure, never the risk budget.

import { estimateCosts, marginPctOf, FEE_DEFAULTS } from './fees.js';

export function slipPerShare(plan, settings) {
  return Number.isFinite(plan.slipPerShare) ? plan.slipPerShare : (plan.entry * settings.slipPct) / 100;
}

export function sizePlan(plan, settings, fees = FEE_DEFAULTS) {
  const margin = marginPctOf(plan);
  const slip = slipPerShare(plan, settings);
  const budget = (settings.capital * settings.riskPct) / 100;
  const lossAt = (q) => (plan.entry - plan.stop + slip) * q + estimateCosts(plan, q, plan.stop, plan.days, fees).total;
  const cashAt = (q) => (plan.entry * q * margin) / 100 + estimateCosts(plan, q, plan.stop, plan.days, fees).total;

  let lo = 0;
  let hi = Math.floor(settings.cashPerTrade / ((plan.entry * margin) / 100));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lossAt(mid) <= budget && cashAt(mid) <= settings.cashPerTrade) lo = mid;
    else hi = mid - 1;
  }
  const suggestedQty = lo;
  const qty = Number.isInteger(plan.qty) && plan.qty > 0 ? plan.qty : suggestedQty;
  const costsAtTarget = estimateCosts(plan, qty, plan.target, plan.days, fees);
  const costsAtStop = estimateCosts(plan, qty, plan.stop, plan.days, fees);
  const riskAtStop = lossAt(qty);
  const rewardAtTarget = (plan.target - plan.entry - slip) * qty - costsAtTarget.total;

  return {
    qty,
    suggestedQty,
    budget,
    slipPerShare: slip,
    riskAtStop,
    rewardAtTarget,
    rewardRisk: riskAtStop > 0 ? rewardAtTarget / riskAtStop : 0,
    value: qty * plan.entry,
    ownCash: (qty * plan.entry * margin) / 100,
    borrowed: qty * plan.entry * (1 - margin / 100),
    interestPerDay: plan.buyType === 'regular' ? 0 : (qty * plan.entry * (1 - margin / 100) * fees.mtfInterestPctPerDay) / 100,
    costsAtTarget,
    costsAtStop,
    breakeven: qty ? breakeven(plan, qty, slip, fees) : 0,
  };
}

function breakeven(plan, qty, slip, fees) {
  const net = (price) => (price - plan.entry - slip) * qty - estimateCosts(plan, qty, price, plan.days, fees).total;
  let a = plan.entry;
  let b = plan.entry * 2 + 100;
  while (net(b) < 0 && b < 1e9) b *= 2;
  for (let i = 0; i < 70; i++) {
    const m = (a + b) / 2;
    if (net(m) < 0) a = m;
    else b = m;
  }
  return b;
}
