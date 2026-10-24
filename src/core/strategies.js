// Strategies give each kind of trade its own checklist. A buy request must name one.
//
// Item types:
//   attest   – the owner answers yes at approval. Agents may add a claim; it is shown as not verified.
//   evidence – needs evidence of `kind` observed within `maxAgeDays` India days (0 = today), for the
//              stock, or with scope 'market' saved once under MARKET for every stock. Research-stage
//              evidence has no `maxAgeDays`: it is judged by the strategy’s research window instead.
//   rule    – a fixed numeric check on the plan. Rules only add to the global limits, never relax them.
// Items can carry a `group` (a checklist-library group id or your own) to show them as sub-items;
// a group is done only when all its required sub-items pass. Each item also has a `stage`:
// 'research' (answered in the days ahead on the Prepare page) or 'before' (on the day).
// Each strategy has a research window: `bufferDays` (research must be at least this old) and
// `expireDays` (older research no longer counts); limits are WINDOW in checklist-library.js.
// Items may carry `exchangeBound` (true: rests on exchange data); if absent the library default applies.
// A strategy must have at least one required research item (a “you answer” or evidence item).
//
// The built-in strategies are starting templates, not recommendations or proof of an edge.
// Saving a strategy bumps its version; a request made against an older version cannot be approved.
// Built-ins are at version 3 (Complete: 2) since they gained the research window and exchange flags.

import { UserError } from './settings.js';
import { EVIDENCE_KINDS, EXCHANGE_KINDS } from './evidence.js';
import { LIBRARY_ITEMS, WINDOW, toStrategyItem } from './checklist-library.js';

export const RULES = {
  minRewardRisk: { label: (v) => `Gain is at least ${v}× the risk`, valid: (v) => Number.isFinite(v) && v > 0 && v <= 20 },
  maxStopPct: { label: (v) => `Stop is at most ${v}% below entry`, valid: (v) => Number.isFinite(v) && v > 0 && v <= 50 },
  maxDays: { label: (v) => `Planned hold is at most ${v} days`, valid: (v) => Number.isInteger(v) && v >= 1 && v <= 60 },
  regularOnly: { label: () => 'Regular (CNC) only, no MTF borrowing', valid: (v) => v === true },
};

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Library sub-items by id; `overrides` can change a field (e.g. a rule value). */
function lib(ids, overrides = {}) {
  return ids.map((id) => {
    const found = LIBRARY_ITEMS.find((i) => i.id === id);
    if (!found) throw new Error(`Unknown checklist item ${id}`);
    const item = toStrategyItem(found);
    const o = overrides[id] ?? {};
    return { ...item, ...o, ...(item.type === 'rule' && o.value !== undefined ? { label: RULES[item.rule].label(o.value) } : {}) };
  });
}
const own = (id, group, type, label, extra = {}) => ({ id, group, stage: 'before', type, label, help: '', required: true, ...extra });

const SHARED_TOP = ['market-nifty-trend', 'market-vix', 'market-fits', 'global-us', 'global-news', 'currency-usdinr', 'commodity-crude', 'commodity-direction'];
const SHARED_SAFETY = ['fund-debt', 'fund-promoter', 'fund-governance', 'events-results', 'events-news'];
const SHARED_LIQUIDITY = ['volume-turnover', 'volume-bands', 'volume-surveillance'];
const SHARED_END = ['order-details', 'order-protect', 'mind-calm'];

export const BUILTIN_STRATEGIES = Object.freeze([
  {
    id: 'breakout', name: 'Breakout from a base', version: 3, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Price closes above a recent high after a quiet period, with strong volume.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-weekly-supply', 'zones-room-to-target']),
      own('breakout-close', 'daily', 'evidence', 'Daily close above the 20-day high', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last daily candle in Kite or your chart.' }),
      ...lib(['daily-close', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-reward', 'plan-invalid']),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'pullback', name: 'Pullback in an uptrend', version: 3, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'A rising stock dips to its 20-day average on lighter volume, then turns up.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-weekly-demand', 'zones-entry-near-demand', 'zones-room-to-target']),
      own('pullback-trend', 'daily', 'evidence', 'Price above a rising 50-day average', { kind: 'candles', scope: 'stock', stage: 'research', exchangeBound: true }),
      own('pullback-dip', 'daily', 'attest', 'The dip happened on lower volume than the rise', { help: 'Quiet selling means sellers are not in control.' }),
      own('pullback-turn', 'daily', 'attest', 'A daily candle has closed back up from the 20-day average', { help: 'Wait for proof that buyers returned.' }),
      ...lib(SHARED_LIQUIDITY),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-reward', 'plan-invalid'], { 'plan-stop-distance': { value: 6 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'results', name: 'After-results momentum', version: 3, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'A strong move after results that holds. Event-driven, so no borrowing.',
    items: [
      ...lib(['market-nifty-trend', 'market-vix', 'global-us', 'global-news']),
      own('results-news', 'events', 'evidence', 'Results announced and read today', { kind: 'news', maxAgeDays: 0, scope: 'stock' }),
      own('results-quality', 'fundamentals', 'attest', 'Growth and margins in the results are genuinely good', { help: 'Look for real sales and profit growth, not a one-time gain.' }),
      ...lib(['fund-governance', 'sector-peers']),
      own('gap-held', 'daily', 'attest', 'The opening move held through the first hour', { help: 'Moves that fade in the first hour often keep fading.' }),
      own('not-chasing', 'daily', 'attest', 'Entry is not more than 3% above the first-hour high'),
      ...lib(['zones-room-to-target', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['money-regular-for-events', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 10 }, 'plan-reward': { value: 2.5 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'trend', name: 'Trend following', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Buy a stock already in a strong, steady uptrend and hold while the trend lasts.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-trend', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-monthly-trend', 'zones-weekly-trend', 'zones-weekly-averages', 'zones-52week', 'zones-room-to-target']),
      ...lib(['daily-trend', 'daily-averages', 'daily-relative']),
      own('trend-200', 'daily', 'evidence', 'Price is above a rising 200-day average', { stage: 'research', kind: 'candles', scope: 'stock', exchangeBound: true, help: 'The 200-day average shows the long trend. Price above it, and the line itself rising, is the base of a trend trade.' }),
      own('trend-pullbacks', 'daily', 'attest', 'Recent pullbacks held above the 50-day average', { stage: 'research', help: 'A healthy trend dips only a little. Deeper falls mean the trend is weakening.' }),
      own('trend-entry', 'daily', 'attest', 'Entry is a new 20-day high close, or a bounce from the 20- or 50-day average', { help: 'Buy a clear signal, not a guess. Wait for the daily candle to close.' }),
      ...lib(['daily-close', 'daily-momentum', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 40 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'support-bounce', name: 'Support bounce (demand zone)', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Buy when price comes back to a marked weekly demand zone and shows buyers returning, with the stop just below the zone.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-monthly-trend', 'zones-weekly-trend', 'zones-monthly-demand', 'zones-weekly-demand', 'zones-weekly-supply', 'zones-entry-near-demand', 'zones-room-to-target', 'daily-levels']),
      own('bounce-fresh', 'zones', 'attest', 'The demand zone is fresh: price has touched it at most once before', { stage: 'research', help: 'Each touch uses up some of the buying in the zone. A zone touched many times is more likely to break.' }),
      own('bounce-reaction', 'daily', 'attest', 'A daily candle closed with a rejection from the zone (long lower wick or bullish engulfing)', { help: 'Wait for buyers to show up. Do not buy only because price reached the zone.' }),
      own('bounce-volume', 'volume', 'attest', 'Selling volume dried up as price reached the zone', { help: 'Falling volume on the way down means sellers are tiring.' }),
      ...lib(['daily-close', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-reward', 'plan-invalid'], { 'plan-stop-distance': { value: 5 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'mean-reversion', name: 'Mean reversion (oversold)', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Buy a sound stock in a long-term uptrend after a sharp short-term drop, aiming for a bounce back to its average. No borrowing.',
    items: [
      ...lib(['market-nifty-trend', 'market-vix', 'market-fits', 'global-news']),
      ...lib(['sector-trend', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-monthly-trend', 'zones-weekly-trend', 'zones-weekly-demand', 'daily-levels']),
      own('mr-cause', 'events', 'attest', 'The reason for the drop is understood and temporary (market or sector dip, not fraud, heavy debt or bad results)', { stage: 'research', help: 'A bounce works when the business is fine. A broken business keeps falling.' }),
      own('mr-support', 'zones', 'attest', 'Price has reached a weekly demand zone or the 200-day average', { stage: 'research', help: 'Buy where buyers have stepped in before, not in mid-air.' }),
      own('mr-stretch', 'daily', 'evidence', 'Price is far below its 20-day average and RSI(14) is below 30', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'This shows the drop is stretched. Check the last daily candle in Kite.' }),
      own('mr-turn', 'daily', 'attest', 'A daily candle has closed up after the drop (the bounce has started)', { help: 'Do not catch a falling knife. Wait for one up-close.' }),
      ...lib(['daily-close', ...SHARED_LIQUIDITY]),
      ...lib(['money-regular-for-events', 'plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 10 }, 'plan-stop-distance': { value: 6 }, 'plan-reward': { value: 1.5 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'smc', name: 'Smart Money Concepts (SMC)', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Buy from a fresh bullish order block in the discount half of the range, after a liquidity sweep, when a smaller timeframe turns up. Nothing here proves large players are involved.',
    items: [
      ...lib(['market-nifty-trend', 'market-vix', 'market-fits', 'global-news']),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-room-to-target']),
      ...lib(['smc-htf-bias', 'smc-bos', 'smc-choch', 'smc-liquidity', 'smc-order-block', 'smc-fvg', 'smc-unmitigated', 'smc-htf-poi', 'smc-discount', 'smc-confluence', 'smc-target-liquidity']),
      ...lib(['smc-sweep', 'smc-displacement', 'smc-ltf-confirm', 'smc-reaction', 'smc-stop-beyond']),
      ...lib(['daily-close', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-reward', 'plan-invalid'], { 'plan-stop-distance': { value: 5 }, 'plan-reward': { value: 3 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'gap-hold', name: 'Gap and hold', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Buy after a gap up on real news that holds through the first hour. Event-driven, so no borrowing.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-weekly-supply', 'zones-room-to-target']),
      own('gap-cause', 'events', 'attest', 'The gap came from real news (an order win, an upgrade, a policy change), not a rumour', { help: 'Gaps on solid news can keep going. Gaps on rumours often fade.' }),
      own('gap-held', 'daily', 'attest', 'Price held above the gap through the first hour and did not fill it', { help: 'A gap that is filled quickly shows sellers took over.' }),
      own('gap-not-chasing', 'daily', 'attest', 'Entry is not more than 3% above the first-hour high', { help: 'Chasing a stock far above where it opened leaves a wide stop.' }),
      ...lib(['volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['money-regular-for-events', 'plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid', 'plan-gap'], { 'plan-time': { value: 7 }, 'plan-stop-distance': { value: 5 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'vcp', name: 'Tight base (volatility contraction)', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'A stock that rose strongly pauses in a base where each swing gets smaller, then breaks out of the tightest point on higher volume.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-52week', 'daily-averages']),
      own('vcp-prior-rise', 'daily', 'attest', 'The stock rose at least 30% before the base started', { stage: 'research', help: 'A tight base works best after a real advance, not after a long sleep.' }),
      own('vcp-contractions', 'daily', 'attest', 'The base has two to four swings, each smaller than the last (for example 15%, 8%, 4%)', { stage: 'research', help: 'Shrinking swings mean sellers are running out.' }),
      own('vcp-length', 'daily', 'attest', 'The base lasted 3 to 12 weeks', { stage: 'research', help: 'Too short is a pause. Too long means the move is stale.' }),
      own('vcp-dryup', 'volume', 'attest', 'Volume dried up during the last, tightest swing', { stage: 'research', help: 'Very low volume at the tightest point shows few people want to sell.' }),
      own('vcp-pivot', 'daily', 'evidence', 'Daily close above the pivot (the top of the last swing) on higher volume', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last daily candle in Kite. Wait for the close.' }),
      ...lib(['daily-close', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-reward', 'plan-invalid'], { 'plan-stop-distance': { value: 6 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'bull-flag', name: 'Bull flag continuation', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'After a sharp rise, price rests in a small downward or sideways channel on lighter volume, then breaks up and continues.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-room-to-target', 'daily-averages']),
      own('flag-pole', 'daily', 'attest', 'A sharp rise of at least 15% in under four weeks came first (the pole)', { stage: 'research', help: 'The flag only matters after a strong, fast move.' }),
      own('flag-shape', 'daily', 'attest', 'The rest is a tight channel, down or sideways, that gave back less than half of the pole', { stage: 'research', help: 'A deep drop is a reversal, not a flag.' }),
      own('flag-volume', 'volume', 'attest', 'Volume fell during the flag', { stage: 'research', help: 'Quiet trading while resting means holders are not selling.' }),
      own('flag-breakout', 'daily', 'evidence', 'Daily close above the top of the flag', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last daily candle in Kite. Wait for the close.' }),
      ...lib(['daily-close', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 15 }, 'plan-stop-distance': { value: 6 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'wyckoff-spring', name: 'Wyckoff spring (accumulation)', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'After a fall and a long sideways range, price dips below the range low, snaps back inside on low volume, and a quiet retest holds.',
    items: [
      ...lib(['market-nifty-trend', 'market-vix', 'market-fits', 'global-news']),
      ...lib(['sector-trend', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-monthly-demand', 'zones-weekly-demand', 'zones-room-to-target']),
      own('wy-climax', 'zones', 'attest', 'A selling climax (huge volume, long lower wick) marked the end of the fall', { stage: 'research', help: 'The panic low starts the range and is the base of the idea.' }),
      own('wy-range', 'zones', 'attest', 'Price has moved sideways in a clear range for at least six weeks since', { stage: 'research', help: 'Big players need time to buy without moving the price.' }),
      own('wy-support', 'zones', 'attest', 'The range low sits on a weekly or monthly demand zone', { stage: 'research', help: 'Two reasons at the same price are stronger than one.' }),
      own('wy-spring', 'daily', 'evidence', 'Price dipped below the range low and closed back inside it (the spring)', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last daily candle in Kite. The close back inside is what counts.' }),
      own('wy-lowvol', 'volume', 'attest', 'The dip below the range low came on low volume', { help: 'Weak selling on the dip means few sellers were left.' }),
      own('wy-retest', 'daily', 'attest', 'A quiet retest of the spring low held (a higher low on lighter volume)', { help: 'The retest is the safer entry. Skip the trade if it breaks.' }),
      ...lib(['daily-close', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 20 }, 'plan-stop-distance': { value: 6 }, 'plan-reward': { value: 2.5 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'rs-leader', name: 'Relative-strength leader at a new high', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Buy a stock that has beaten Nifty and its sector for months and is closing at or near a new 52-week high.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-peers', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-monthly-trend', 'zones-weekly-trend', 'zones-weekly-averages', 'zones-52week', 'daily-trend', 'daily-averages', 'daily-relative']),
      own('rs-outperform', 'daily', 'attest', 'The stock beat Nifty over the last 1, 3 and 6 months', { stage: 'research', help: 'Leaders tend to stay leaders. Compare the stock and Nifty charts over each period.' }),
      own('rs-near-high', 'daily', 'attest', 'Price is within 5% of its 52-week high', { stage: 'research', help: 'There are few old sellers waiting above a stock at its highs.' }),
      own('rs-new-high', 'daily', 'evidence', 'Daily close at a new 52-week high or above the top of the last base', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last daily candle in Kite. Wait for the close.' }),
      ...lib(['daily-close', 'daily-momentum', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 30 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'double-bottom', name: 'Double bottom reversal', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'After a fall, price makes two lows near the same level and then closes above the high between them.',
    items: [
      ...lib(['market-nifty-trend', 'market-vix', 'market-fits', 'global-news']),
      ...lib(['sector-trend', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-monthly-demand', 'zones-weekly-demand', 'zones-weekly-supply', 'zones-room-to-target']),
      own('db-two-lows', 'daily', 'attest', 'Two lows within about 3% of each other, at least four weeks apart', { stage: 'research', help: 'The second low holding where the first one did shows buyers defending the level.' }),
      own('db-second-weaker', 'volume', 'attest', 'Selling volume was lower at the second low than at the first', { stage: 'research', help: 'Less selling on the second dip means the pressure is fading.' }),
      own('db-support', 'zones', 'attest', 'Both lows sit on a weekly or monthly demand zone', { stage: 'research', help: 'A known buyer area makes the pattern more reliable.' }),
      own('db-neckline', 'daily', 'evidence', 'Daily close above the neckline (the high between the two lows)', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last daily candle in Kite. Wait for the close.' }),
      ...lib(['daily-close', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 20 }, 'plan-stop-distance': { value: 6 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'cup-handle', name: 'Cup and handle', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'After a strong rise, a rounded base forms, a short pullback (the handle) follows, and price breaks above the handle on higher volume.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-52week', 'daily-averages']),
      own('cup-prior-rise', 'daily', 'attest', 'The stock rose at least 30% before the cup started', { stage: 'research', help: 'The pattern works best after a real advance.' }),
      own('cup-shape', 'daily', 'attest', 'The cup is rounded (not a sharp V), 7 to 40 weeks long and 12% to 35% deep', { stage: 'research', help: 'A rounded base means selling faded slowly. A sharp V is less reliable.' }),
      own('cup-recovery', 'daily', 'attest', 'Price has climbed back at least 80% of the way up the right side of the cup', { stage: 'research', help: 'The handle forms near the old high.' }),
      own('cup-handle', 'volume', 'attest', 'The handle lasted one to four weeks, gave back less than half of the cup depth, and volume was light', { stage: 'research', help: 'A short, shallow rest on low volume shows holders are not selling.' }),
      own('cup-breakout', 'daily', 'evidence', 'Daily close above the top of the handle on higher volume', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last daily candle in Kite. Wait for the close.' }),
      ...lib(['daily-close', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 25 }, 'plan-stop-distance': { value: 7 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'ascending-triangle', name: 'Ascending triangle breakout', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Price presses against a flat ceiling with higher lows underneath, then closes above the ceiling on higher volume.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-weekly-supply', 'zones-room-to-target', 'daily-averages']),
      own('tri-ceiling', 'daily', 'attest', 'A flat ceiling has been touched at least twice (the highs are within 1% of each other)', { stage: 'research', help: 'The same price stopping buyers twice marks a clear line to beat.' }),
      own('tri-higher-lows', 'daily', 'attest', 'Each pullback ended higher than the one before', { stage: 'research', help: 'Rising lows show buyers are getting more eager at each dip.' }),
      own('tri-length', 'daily', 'attest', 'The pattern lasted 4 to 12 weeks', { stage: 'research', help: 'Too short is noise. Too long and the energy fades.' }),
      own('tri-breakout', 'daily', 'evidence', 'Daily close above the flat ceiling on higher volume', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last daily candle in Kite. Wait for the close.' }),
      ...lib(['daily-close', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 15 }, 'plan-stop-distance': { value: 6 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'inverse-hns', name: 'Inverse head and shoulders', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'After a fall, three lows form with the middle one lowest, and price closes above the line joining the two highs between them.',
    items: [
      ...lib(['market-nifty-trend', 'market-vix', 'market-fits', 'global-news']),
      ...lib(['sector-trend', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-monthly-demand', 'zones-weekly-demand', 'zones-weekly-supply', 'zones-room-to-target']),
      own('ihs-shape', 'daily', 'attest', 'Three lows: a lower middle low (the head) between two higher, similar lows (the shoulders)', { stage: 'research', help: 'The right shoulder failing to make a new low shows sellers are done.' }),
      own('ihs-volume', 'volume', 'attest', 'Selling volume was lighter at the right shoulder than at the head', { stage: 'research', help: 'Less selling on the last dip means pressure is fading.' }),
      own('ihs-support', 'zones', 'attest', 'The head sits on a weekly or monthly demand zone', { stage: 'research', help: 'A known buyer area makes the pattern more reliable.' }),
      own('ihs-neckline', 'daily', 'evidence', 'Daily close above the neckline (the line joining the two highs between the lows) on higher volume', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last daily candle in Kite. Wait for the close.' }),
      ...lib(['daily-close', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 25 }, 'plan-stop-distance': { value: 7 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'ma-reclaim', name: '200-day average reclaim', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'A stock that spent weeks below its 200-day average, after the average stops falling, closes back above it on higher volume.',
    items: [
      ...lib(['market-nifty-trend', 'market-vix', 'market-fits', 'global-news']),
      ...lib(['sector-trend', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-monthly-trend', 'zones-weekly-demand', 'zones-room-to-target']),
      own('reclaim-base', 'daily', 'attest', 'Price spent at least four weeks below the 200-day average after falling from higher levels', { stage: 'research', help: 'This is a recovery from a weak spell, not a stock that was never down.' }),
      own('reclaim-flat', 'daily', 'attest', 'The 200-day average has stopped falling (flat or turning up)', { stage: 'research', help: 'Reclaiming a line that is still sinking fast usually fails.' }),
      own('reclaim-higher-low', 'zones', 'attest', 'The weekly chart has made a higher low', { stage: 'research', help: 'A higher low is the first sign the fall is over.' }),
      own('reclaim-close', 'daily', 'evidence', 'Two daily closes above the 200-day average, the second on higher volume', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last two daily candles in Kite. One close above is not enough.' }),
      ...lib(['daily-close', 'daily-momentum', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 20 }, 'plan-stop-distance': { value: 6 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'quality-pullback', name: 'Quality growth on a pullback', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'A company with strong, growing numbers pulls back to support in an uptrend. The business review matters most here.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['fund-growth', 'fund-margins', 'fund-returns', 'fund-cash', 'fund-valuation', 'fund-dilution', 'fund-guidance']),
      ...lib(['zones-weekly-trend', 'zones-weekly-demand', 'zones-entry-near-demand', 'zones-room-to-target', 'daily-levels']),
      own('qp-dip', 'daily', 'attest', 'Price pulled back 8% to 20% from its high to a support level, on lighter volume', { help: 'A calm dip in a good business is a better entry than chasing a high.' }),
      own('qp-turn', 'daily', 'attest', 'A daily candle has closed up from the support level', { help: 'Wait for proof that buyers returned.' }),
      ...lib(['daily-close', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 40 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'failed-breakdown', name: 'Failed breakdown (bear trap)', version: 1, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Price closes below a well-tested support, then closes back above it within three days, trapping sellers.',
    items: [
      ...lib(['market-nifty-trend', 'market-vix', 'market-fits', 'global-news']),
      ...lib(['sector-trend', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-weekly-demand', 'zones-room-to-target', 'daily-levels']),
      own('fb-support', 'zones', 'attest', 'A clear support level held at least three times in the last six months', { stage: 'research', help: 'The more times a level held, the more stops sit just below it.' }),
      own('fb-uptrend', 'daily', 'attest', 'The weekly trend before the break was up or sideways, not a steady fall', { stage: 'research', help: 'A trap in a falling stock often just continues falling.' }),
      own('fb-reclaim', 'daily', 'evidence', 'Price closed below the support, then closed back above it within three days', { kind: 'candles', maxAgeDays: 1, scope: 'stock', exchangeBound: true, help: 'Check the last few daily candles in Kite. The close back above is what counts.' }),
      own('fb-volume', 'volume', 'attest', 'Volume was low on the break below and higher on the move back up', { help: 'Weak selling and strong buying show the break was not real.' }),
      own('fb-strong', 'daily', 'attest', 'The close back above support was a strong candle, not a slow drift', { help: 'A big candle shows buyers acted at once.' }),
      ...lib(['daily-close', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-time', 'plan-reward', 'plan-invalid'], { 'plan-time': { value: 15 }, 'plan-stop-distance': { value: 5 }, 'plan-reward': { value: 2.5 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'complete', name: 'Complete pre-trade checklist', version: 3, builtin: true, enabled: true, bufferDays: 3, expireDays: 5,
    description: 'Every check in the library. Core checks are required; the rest are optional notes. Use it as a full review, or copy it and trim.',
    items: LIBRARY_ITEMS.filter((i) => i.id !== 'money-regular-for-events').map((i) => toStrategyItem(i, { required: !!i.core })),
  },
]);

/** A strategy’s research window; strategies saved before windows existed get the defaults. */
export function strategyWindow(strategy) {
  return { bufferDays: strategy?.bufferDays ?? WINDOW.defaultBuffer, expireDays: strategy?.expireDays ?? WINDOW.defaultExpire };
}

/**
 * Whether an item rests on exchange data. Every evidence item of a price kind (quote, candles,
 * zones) is, whatever its flag says; otherwise its own flag, else the library default, else false.
 */
export function isExchangeBound(item) {
  if (item.type === 'evidence' && EXCHANGE_KINDS.has(item.kind)) return true;
  return item.exchangeBound ?? LIBRARY_ITEMS.find((i) => i.id === item.id)?.exchangeBound ?? false;
}

/** True when the strategy has a required research item the owner can prepare ahead (not a plan rule). */
export function hasRequiredResearch(strategy) {
  return strategy.items.some((i) => i.stage === 'research' && i.required && (i.type === 'attest' || i.type === 'evidence'));
}

/** Validate an owner-edited strategy. Returns the cleaned strategy (without version). */
export function validateStrategy(input) {
  const str = (v, label, max, required = true) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required && !s) throw new UserError(`${label} is required.`);
    if (s.length > max) throw new UserError(`${label} must be at most ${max} characters.`);
    return s;
  };
  const id = str(input.id, 'Strategy id', 40);
  if (!ID.test(id)) throw new UserError('Strategy id must be lower-case letters, digits and dashes.');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 150) throw new UserError('A checklist needs 1 to 150 items.');
  const seen = new Set();
  const items = input.items.map((raw, i) => {
    const itemId = str(raw.id, `Item ${i + 1} id`, 40);
    if (!ID.test(itemId) || seen.has(itemId)) throw new UserError(`Item ${i + 1} needs a unique id (lower-case letters, digits, dashes).`);
    seen.add(itemId);
    const required = raw.required !== false;
    const group = str(raw.group, `Item ${i + 1} group`, 40, false);
    if (group && !ID.test(group)) throw new UserError(`Item ${i + 1}: group must be lower-case letters, digits and dashes.`);
    const stage = raw.stage ?? 'before';
    if (!['research', 'before'].includes(stage)) throw new UserError(`Item ${i + 1}: stage must be research or before.`);
    const common = { id: itemId, ...(group ? { group } : {}), stage, ...(typeof raw.exchangeBound === 'boolean' ? { exchangeBound: raw.exchangeBound } : {}), help: str(raw.help, 'Help', 500, false) };
    if (raw.type === 'attest') return { ...common, type: 'attest', label: str(raw.label, `Item ${i + 1}`, 200), required };
    if (raw.type === 'evidence') {
      if (!EVIDENCE_KINDS[raw.kind]) throw new UserError(`Item ${i + 1}: evidence kind must be one of ${Object.keys(EVIDENCE_KINDS).join(', ')}.`);
      // Research evidence is judged by the strategy window, so it keeps no age of its own.
      const dated = stage === 'research' ? {} : { maxAgeDays: raw.maxAgeDays };
      if (stage !== 'research' && (!Number.isInteger(raw.maxAgeDays) || raw.maxAgeDays < 0 || raw.maxAgeDays > 400)) throw new UserError(`Item ${i + 1}: freshness must be 0 (today) to 400 days.`);
      const scope = raw.scope ?? 'stock';
      if (!['stock', 'market'].includes(scope)) throw new UserError(`Item ${i + 1}: scope must be stock or market.`);
      return { ...common, type: 'evidence', label: str(raw.label, `Item ${i + 1}`, 200), kind: raw.kind, ...dated, scope, required };
    }
    if (raw.type === 'rule') {
      const def = RULES[raw.rule];
      if (!def || !def.valid(raw.value)) throw new UserError(`Item ${i + 1}: choose a valid rule and value.`);
      return { ...common, type: 'rule', rule: raw.rule, value: raw.value, label: def.label(raw.value), required: true };
    }
    throw new UserError(`Item ${i + 1}: type must be attest, evidence or rule.`);
  });
  const bufferDays = input.bufferDays ?? WINDOW.defaultBuffer;
  const expireDays = input.expireDays ?? WINDOW.defaultExpire;
  if (!Number.isInteger(bufferDays) || !Number.isInteger(expireDays)) throw new UserError('Buffer and expire must be whole numbers of days.');
  if (bufferDays < WINDOW.minBuffer) throw new UserError(`Buffer must be at least ${WINDOW.minBuffer} days.`);
  if (expireDays > WINDOW.maxExpire) throw new UserError(`Expire must be at most ${WINDOW.maxExpire} days.`);
  if (expireDays < bufferDays) throw new UserError('Expire days must be at least the buffer days.');
  if (!hasRequiredResearch({ items })) throw new UserError('Add at least one required research item that you can prepare days ahead (a “you answer” or evidence item, not a plan rule).');
  return {
    id,
    name: str(input.name, 'Name', 80),
    description: str(input.description, 'Description', 500, false),
    enabled: input.enabled !== false,
    bufferDays,
    expireDays,
    items,
  };
}
