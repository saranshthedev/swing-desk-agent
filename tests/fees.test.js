import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCosts } from '../src/core/fees.js';
import { sizePlan } from '../src/core/sizing.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';

// Reference values produced by Swing Desk v3's calc.js (dist/calc.js) on 2026-10-23 with its
// default rates, so the port keeps identical charge treatment.
const plan = { entry: 842, buyType: 'mtf', marginPct: 50, exchange: 'NSE' };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

test('MTF overnight costs match v3', () => {
  const c = estimateCosts(plan, 104, 896, 15);
  close(c.interest, 262.704);
  close(c.brokerage, 40);
  close(c.stt, 180.752);
  close(c.exchange, 5.5490864);
  close(c.gst, 8.231370912);
  close(c.pledge, 35.4);
  close(c.dp, 15.34);
  close(c.total, 561.292409312);
});

test('same-day MTF keeps MTF brokerage but drops interest, pledge and DP', () => {
  const c = estimateCosts({ ...plan, sameDay: true }, 104, 896, 0);
  close(c.brokerage, 40);
  close(c.interest + c.pledge + c.dp, 0);
  close(c.stt, 23.296);
  close(c.total, 79.884249312);
});

test('Regular delivery has zero brokerage and no funding costs', () => {
  close(estimateCosts({ ...plan, buyType: 'regular' }, 104, 896, 15).total, 215.988409312);
});

test('BSE standard group uses the BSE exchange rate', () => {
  close(estimateCosts({ ...plan, exchange: 'BSE' }, 104, 896, 15).total, 562.74276336);
});

test('sizing matches v3 with the same fixed allowance', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const z = sizePlan({ ...plan, stop: 815, target: 896, days: 15, slipPerShare: 0.84 }, settings);
  assert.equal(z.suggestedQty, 12);
  close(z.riskAtStop, 484.47538090399996);
  close(z.rewardAtTarget, 486.51626046399997);
  close(z.breakeven, 855.4148750425251);
});

test('borrowing never raises the loss budget', () => {
  const settings = { ...DEFAULT_SETTINGS, cashPerTrade: 1e9 };
  const cash = sizePlan({ ...plan, buyType: 'regular', marginPct: 100, stop: 815, target: 896, days: 15 }, settings);
  const mtf = sizePlan({ ...plan, marginPct: 20, stop: 815, target: 896, days: 15 }, settings);
  assert.ok(mtf.riskAtStop <= mtf.budget && cash.riskAtStop <= cash.budget);
  assert.ok(mtf.suggestedQty <= cash.suggestedQty);
});
