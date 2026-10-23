// Ready-made starting points. They only fill forms; every value can still be changed, and the
// usual validation and PIN rules apply when saving. They are examples, not advice.

import { DEFAULT_SETTINGS } from './settings.js';

/** Risk limits. cashPerTradePct is turned into ₹ from the owner's capital. */
export const RISK_PRESETS = Object.freeze({
  careful: {
    label: 'Careful',
    about: 'Small losses, few trades at a time, little borrowing. Good while you are learning.',
    values: { riskPct: 0.25, cashPerTradePct: 15, minRewardRisk: 2.5, maxOpenLots: 4, maxOpenRiskPct: 1.5, maxBorrowedPct: 25, weeklyLossLimitPct: 1.5, slipPct: 0.15 },
  },
  balanced: {
    label: 'Balanced',
    about: 'The app’s default. Moderate losses per trade and some borrowing.',
    values: { riskPct: 0.5, cashPerTradePct: 25, minRewardRisk: 2, maxOpenLots: 6, maxOpenRiskPct: 3, maxBorrowedPct: 100, weeklyLossLimitPct: 3, slipPct: 0.1 },
  },
  active: {
    label: 'Active',
    about: 'Bigger losses allowed, more trades and more borrowing. Only if you are experienced.',
    values: { riskPct: 1, cashPerTradePct: 33, minRewardRisk: 1.5, maxOpenLots: 8, maxOpenRiskPct: 6, maxBorrowedPct: 200, weeklyLossLimitPct: 5, slipPct: 0.1 },
  },
});

/** Full settings for a preset at a given capital. */
export function riskPresetSettings(key, capital) {
  const { cashPerTradePct, ...rest } = RISK_PRESETS[key].values;
  return { capital, ...rest, cashPerTrade: Math.max(100, Math.round((capital * cashPerTradePct) / 100)) };
}

/** Which preset the settings match exactly (₹1 tolerance on cash per trade), or null for custom. */
export function matchRiskPreset(settings) {
  for (const key of Object.keys(RISK_PRESETS)) {
    const want = riskPresetSettings(key, settings.capital);
    if (Object.entries(want).every(([k, v]) => (k === 'cashPerTrade' ? Math.abs(settings[k] - v) <= 1 : settings[k] === v))) return key;
  }
  return null;
}

/** Agent access presets for the "Add an agent" form. */
export const AGENT_PRESETS = Object.freeze({
  watcher: { label: 'Watcher', about: 'Only looks. Good for checking your open trades.', scope: 'read', limits: { writesPerDay: 20, intentsPerDay: 0, callsPerHour: 120 } },
  researcher: { label: 'Researcher', about: 'Looks and saves research and prices it finds. Cannot send trade ideas.', scope: 'draft', limits: { writesPerDay: 50, intentsPerDay: 0, callsPerHour: 300 } },
  proposer: { label: 'Trade proposer', about: 'Researches and sends you up to 5 trade ideas a day to approve.', scope: 'propose', limits: { writesPerDay: 50, intentsPerDay: 5, callsPerHour: 300 } },
});

const WEEKDAYS = [1, 2, 3, 4, 5];

/** Playbook templates for "New playbook". */
export const PLAYBOOK_TEMPLATES = Object.freeze({
  news: {
    label: 'Morning news check',
    name: 'Morning news check',
    schedule: { days: WEEKDAYS, at: '08:45' },
    maxIntents: 0,
    instructions: 'For each open lot and each pending buy request, check today’s news and company announcements. Save one add_evidence (kind news) per stock with links. Never guess. Finish with complete_task and a 3-line summary of anything important.',
  },
  scan: {
    label: 'After-close scan',
    name: 'After-close scan',
    schedule: { days: WEEKDAYS, at: '15:50' },
    maxIntents: 3,
    instructions: 'Call list_strategies and desk_status. Look for stocks that fit a strategy’s checklist today. For each one, save what you checked with add_evidence (candles, calendar, news) with sources. Only for real matches, call calculate_plan, then propose_buy with the strategyId, your evidenceIds and a short claim for each “you answer” item. Pass this task’s taskId. Finish with complete_task: what you looked at, what you proposed and why.',
  },
  watch: {
    label: 'Position watch',
    name: 'Position watch',
    schedule: { days: WEEKDAYS, every: 30, from: '09:15', to: '15:30' },
    maxIntents: 0,
    instructions: 'Call list_lots. For each open lot, find the latest price from a public source and save it with add_evidence (kind quote, with the source). Compare it with the stop and target. Never guess a price. In complete_task, list anything near or past its stop or target, or say “nothing to report”.',
  },
  weekly: {
    label: 'Weekly review',
    name: 'Weekly review',
    schedule: { days: [6], at: '10:00' },
    maxIntents: 1,
    instructions: 'Look at this week’s closed trades and open lots (list_lots with includeClosed). Write a short add_note: what went well, what went badly, any repeated mistake. Only if a risk limit clearly needs to change, send one propose_settings with a clear reason. Finish with complete_task.',
  },
});

/** Usual plan values per strategy, filled when you pick a strategy in "New plan". */
export const PLAN_DEFAULTS = Object.freeze({
  breakout: { days: 10, buyType: 'mtf', leverage: 2 },
  pullback: { days: 10, buyType: 'mtf', leverage: 2 },
  results: { days: 7, buyType: 'regular' },
  default: { days: 10, buyType: 'mtf', leverage: 2 },
});

// The app's starting settings are the Balanced preset at ₹1,00,000.
export const DEFAULTS_ARE_BALANCED = matchRiskPreset(DEFAULT_SETTINGS) === 'balanced';
