// Owner risk settings. Agents may only *propose* changes to these keys; the owner approves.

export const SETTING_RULES = Object.freeze({
  capital: { label: 'Trading capital (₹)', min: 1_000, max: 1_000_000_000 },
  riskPct: { label: 'Max loss per trade (% of capital)', min: 0.05, max: 5 },
  cashPerTrade: { label: 'Max own cash per trade (₹)', min: 100, max: 1_000_000_000 },
  minRewardRisk: { label: 'Minimum reward ÷ risk', min: 0.5, max: 10 },
  maxOpenLots: { label: 'Max open lots', min: 1, max: 50, integer: true },
  maxOpenRiskPct: { label: 'Max total loss if every stop is hit (% of capital)', min: 0.1, max: 25 },
  maxBorrowedPct: { label: 'Max MTF borrowing (% of capital)', min: 0, max: 400 },
  weeklyLossLimitPct: { label: 'Pause new buys after this week’s loss (% of capital)', min: 0.1, max: 25 },
  slipPct: { label: 'Worse-price allowance for plans (% of price)', min: 0, max: 5 },
});

export const DEFAULT_SETTINGS = Object.freeze({
  capital: 100_000,
  riskPct: 0.5,
  cashPerTrade: 25_000,
  minRewardRisk: 2,
  maxOpenLots: 6,
  maxOpenRiskPct: 3,
  maxBorrowedPct: 100,
  weeklyLossLimitPct: 3,
  slipPct: 0.1,
});

/** Fixed rules that are deliberately not settings. */
export const FIXED = Object.freeze({
  quoteMaxAgeMs: 5 * 60_000, // a pasted quote is stale after 5 minutes
  quoteMaxGapPct: 2, // plan entry must be within 2% of the fresh quote
  maxLeverage: 5,
  maxHoldDays: 60,
  defaultIntentHours: 24,
  maxIntentHours: 72,
});

export function validateSettingsPatch(patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new UserError('Send the settings to change.');
  const keys = Object.keys(patch);
  if (!keys.length) throw new UserError('Nothing to change.');
  const next = { ...current };
  for (const key of keys) {
    const rule = SETTING_RULES[key];
    const value = patch[key];
    if (!rule) throw new UserError(`“${key}” is not a setting that can be changed.`);
    if (!Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value))) {
      throw new UserError(`${rule.label} must be ${rule.integer ? 'a whole number ' : ''}between ${rule.min} and ${rule.max}.`);
    }
    next[key] = value;
  }
  return next;
}

export class UserError extends Error {}
