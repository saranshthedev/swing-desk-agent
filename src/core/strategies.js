// Strategies give each kind of trade its own checklist. A buy request must name one.
//
// Item types:
//   attest   – the owner answers yes at approval. Agents may add a claim; it is shown as not verified.
//   evidence – needs evidence of `kind` for the stock, observed within `maxAgeDays` India days (0 = today).
//   rule     – a fixed numeric check on the plan. Rules only add to the global limits, never relax them.
//
// The built-in strategies are starting templates, not recommendations or proof of an edge.
// Saving a strategy bumps its version; a request made against an older version cannot be approved.

import { UserError } from './settings.js';
import { EVIDENCE_KINDS } from './evidence.js';

export const RULES = {
  minRewardRisk: { label: (v) => `Gain is at least ${v}× the risk`, valid: (v) => Number.isFinite(v) && v > 0 && v <= 20 },
  maxStopPct: { label: (v) => `Stop is at most ${v}% below entry`, valid: (v) => Number.isFinite(v) && v > 0 && v <= 50 },
  maxDays: { label: (v) => `Planned hold is at most ${v} days`, valid: (v) => Number.isInteger(v) && v >= 1 && v <= 60 },
  regularOnly: { label: () => 'Regular (CNC) only, no MTF borrowing', valid: (v) => v === true },
};

const attest = (id, label, help = '') => ({ id, type: 'attest', label, help, required: true });
const evidence = (id, label, kind, maxAgeDays, help = '') => ({ id, type: 'evidence', label, kind, maxAgeDays, help, required: true });
const rule = (id, name, value) => ({ id, type: 'rule', rule: name, value, label: RULES[name].label(value), required: true });

export const BUILTIN_STRATEGIES = Object.freeze([
  {
    id: 'breakout', name: 'Breakout from a base', version: 1, builtin: true, enabled: true,
    description: 'Price closes above a recent high after a quiet period, with strong volume.',
    items: [
      evidence('daily-close', 'Daily close above the 20-day high', 'candles', 1, 'Check the last daily candle in Kite or your chart.'),
      attest('volume', 'Breakout-day volume is at least 1.5× the 20-day average'),
      attest('market', 'Nifty and the stock’s sector are not in a falling trend'),
      evidence('results-date', 'No results date inside the planned hold', 'calendar', 7, 'Results can move the price sharply either way.'),
      rule('stop', 'maxStopPct', 8),
      rule('rr', 'minRewardRisk', 2),
    ],
  },
  {
    id: 'pullback', name: 'Pullback in an uptrend', version: 1, builtin: true, enabled: true,
    description: 'A rising stock dips to its 20-day average on lighter volume, then turns up.',
    items: [
      evidence('daily-trend', 'Price above a rising 50-day average', 'candles', 1),
      attest('dip-volume', 'The dip happened on lower volume than the rise'),
      attest('turn', 'A daily candle has closed back up from the 20-day average'),
      evidence('results-date', 'No results date inside the planned hold', 'calendar', 7),
      rule('stop', 'maxStopPct', 6),
      rule('rr', 'minRewardRisk', 2),
    ],
  },
  {
    id: 'results', name: 'After-results momentum', version: 1, builtin: true, enabled: true,
    description: 'A strong move after results that holds. Event-driven, so no borrowing.',
    items: [
      evidence('results-news', 'Results announced and read today', 'news', 0),
      attest('gap-held', 'The opening move held through the first hour'),
      attest('not-chasing', 'Entry is not more than 3% above the first-hour high'),
      rule('cash', 'regularOnly', true),
      rule('hold', 'maxDays', 10),
      rule('rr', 'minRewardRisk', 2.5),
    ],
  },
]);

/** Validate an owner-edited strategy. Returns the cleaned strategy (without version). */
export function validateStrategy(input) {
  const str = (v, label, max, required = true) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required && !s) throw new UserError(`${label} is required.`);
    if (s.length > max) throw new UserError(`${label} must be at most ${max} characters.`);
    return s;
  };
  const id = str(input.id, 'Strategy id', 40);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new UserError('Strategy id must be lower-case letters, digits and dashes.');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 30) throw new UserError('A checklist needs 1 to 30 items.');
  const seen = new Set();
  const items = input.items.map((raw, i) => {
    const itemId = str(raw.id, `Item ${i + 1} id`, 40);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(itemId) || seen.has(itemId)) throw new UserError(`Item ${i + 1} needs a unique id (lower-case letters, digits, dashes).`);
    seen.add(itemId);
    const required = raw.required !== false;
    if (raw.type === 'attest') return { id: itemId, type: 'attest', label: str(raw.label, `Item ${i + 1}`, 200), help: str(raw.help, 'Help', 500, false), required };
    if (raw.type === 'evidence') {
      if (!EVIDENCE_KINDS[raw.kind]) throw new UserError(`Item ${i + 1}: evidence kind must be one of ${Object.keys(EVIDENCE_KINDS).join(', ')}.`);
      if (!Number.isInteger(raw.maxAgeDays) || raw.maxAgeDays < 0 || raw.maxAgeDays > 30) throw new UserError(`Item ${i + 1}: freshness must be 0 (today) to 30 days.`);
      return { id: itemId, type: 'evidence', label: str(raw.label, `Item ${i + 1}`, 200), kind: raw.kind, maxAgeDays: raw.maxAgeDays, help: str(raw.help, 'Help', 500, false), required };
    }
    if (raw.type === 'rule') {
      const def = RULES[raw.rule];
      if (!def || !def.valid(raw.value)) throw new UserError(`Item ${i + 1}: choose a valid rule and value.`);
      return { id: itemId, type: 'rule', rule: raw.rule, value: raw.value, label: def.label(raw.value), required: true };
    }
    throw new UserError(`Item ${i + 1}: type must be attest, evidence or rule.`);
  });
  return {
    id,
    name: str(input.name, 'Name', 80),
    description: str(input.description, 'Description', 500, false),
    enabled: input.enabled !== false,
    items,
  };
}
