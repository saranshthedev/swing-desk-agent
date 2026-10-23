// Zerodha charge estimates for Regular (CNC) and MTF equity buys.
//
// Values are ported unchanged from Swing Desk v3 (fee-config.js, checked 2026-10-22,
// MTF funding checked 2026-10-23). Before changing any number, re-check the official
// pages below and update `checkedOn`. Every approved trade stores a frozen copy of
// the rates it used, so later edits never rewrite historical costs.

export const FEE_DEFAULTS = Object.freeze({
  checkedOn: '2026-10-22',
  source: 'https://zerodha.com/charges/ · https://zerodha.com/mtf/',
  mtfInterestPctPerDay: 0.04, // 14.6% a year on the borrowed amount, per calendar day
  mtfBrokeragePct: 0.3,
  mtfBrokerageCap: 20, // ₹ per order
  regularDeliveryPct: 0,
  regularIntradayPct: 0.03,
  regularBrokerageCap: 20,
  sttDeliveryPct: 0.1, // on buy and sell value
  sttIntradaySellPct: 0.025, // same-day: on sell value only
  exchangePctNSE: 0.00307,
  exchangePctBSE: 0.00375, // standard BSE group; other groups need an owner-entered rate
  sebiPct: 0.0001,
  stampDeliveryPct: 0.015, // on buy value
  stampIntradayPct: 0.003,
  gstPct: 18, // on brokerage + exchange + SEBI fees, and on pledge charges
  pledgePerAction: 15, // ₹ per pledge and again per unpledge (MTF, overnight only)
  dpPerSale: 15.34, // ₹ per stock sold from demat (not same-day)
});

export const FEE_KEYS = Object.keys(FEE_DEFAULTS).filter((k) => typeof FEE_DEFAULTS[k] === 'number');

export function validFees(f) {
  return !!f && FEE_KEYS.every((k) => Number.isFinite(f[k]) && f[k] >= 0 && f[k] <= 10_000);
}

export function marginPctOf(plan) {
  return plan.buyType === 'regular' ? 100 : plan.marginPct;
}

export function exchangePct(plan, f) {
  if ((plan.exchange || 'NSE') === 'NSE') return f.exchangePctNSE;
  return Number.isFinite(plan.bseRatePct) ? plan.bseRatePct : f.exchangePctBSE;
}

const ZERO = Object.freeze({ interest: 0, brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0, pledge: 0, dp: 0, total: 0 });

/**
 * Estimated round-trip charges for `qty` shares bought at plan.entry and sold at `exitPrice`
 * after `days` calendar days. Same-day MTF keeps MTF brokerage but has no interest, pledge or DP.
 */
export function estimateCosts(plan, qty, exitPrice, days, f = FEE_DEFAULTS) {
  if (!qty) return { ...ZERO };
  const regular = plan.buyType === 'regular';
  const buy = plan.entry * qty;
  const sell = exitPrice * qty;
  const funded = buy * (1 - marginPctOf(plan) / 100);
  const broker = (value) => regular
    ? Math.min(f.regularBrokerageCap, (value * (plan.sameDay ? f.regularIntradayPct : f.regularDeliveryPct)) / 100)
    : Math.min(f.mtfBrokerageCap, (value * f.mtfBrokeragePct) / 100);
  const carried = !plan.sameDay && !regular;
  const brokerage = broker(buy) + broker(sell);
  const exchange = ((buy + sell) * exchangePct(plan, f)) / 100;
  const sebi = ((buy + sell) * f.sebiPct) / 100;
  const out = {
    interest: carried ? (funded * f.mtfInterestPctPerDay * days) / 100 : 0,
    brokerage,
    stt: plan.sameDay ? (sell * f.sttIntradaySellPct) / 100 : ((buy + sell) * f.sttDeliveryPct) / 100,
    exchange,
    sebi,
    stamp: (buy * (plan.sameDay ? f.stampIntradayPct : f.stampDeliveryPct)) / 100,
    gst: ((brokerage + exchange + sebi) * f.gstPct) / 100,
    pledge: carried ? 2 * f.pledgePerAction * (1 + f.gstPct / 100) : 0,
    dp: plan.sameDay ? 0 : f.dpPerSale,
  };
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}
