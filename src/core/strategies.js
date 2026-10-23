// Strategies give each kind of trade its own checklist. A buy request must name one.
//
// Item types:
//   attest   – the owner answers yes at approval. Agents may add a claim; it is shown as not verified.
//   evidence – needs evidence of `kind` observed within `maxAgeDays` India days (0 = today), for the
//              stock, or with scope 'market' saved once under MARKET for every stock.
//   rule     – a fixed numeric check on the plan. Rules only add to the global limits, never relax them.
// Items can carry a `group` (a checklist-library group id or your own) to show them as sub-items;
// a group is done only when all its required sub-items pass. Each item also has a `stage`:
// 'research' (can be answered 1–5 days ahead on the Prepare page) or 'before' (on the day).
//
// The built-in strategies are starting templates, not recommendations or proof of an edge.
// Saving a strategy bumps its version; a request made against an older version cannot be approved.
// Built-ins are at version 2 since they gained grouped checklists from the library.

import { UserError } from './settings.js';
import { EVIDENCE_KINDS } from './evidence.js';
import { LIBRARY_ITEMS, toStrategyItem } from './checklist-library.js';

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
    id: 'breakout', name: 'Breakout from a base', version: 2, builtin: true, enabled: true,
    description: 'Price closes above a recent high after a quiet period, with strong volume.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-weekly-supply', 'zones-room-to-target']),
      own('breakout-close', 'daily', 'evidence', 'Daily close above the 20-day high', { kind: 'candles', maxAgeDays: 1, scope: 'stock', help: 'Check the last daily candle in Kite or your chart.' }),
      ...lib(['daily-close', 'volume-signal', ...SHARED_LIQUIDITY]),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-reward', 'plan-invalid']),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'pullback', name: 'Pullback in an uptrend', version: 2, builtin: true, enabled: true,
    description: 'A rising stock dips to its 20-day average on lighter volume, then turns up.',
    items: [
      ...lib(SHARED_TOP),
      ...lib(['sector-strength', 'sector-concentration']),
      ...lib(SHARED_SAFETY),
      ...lib(['zones-weekly-trend', 'zones-weekly-demand', 'zones-entry-near-demand', 'zones-room-to-target']),
      own('pullback-trend', 'daily', 'evidence', 'Price above a rising 50-day average', { kind: 'candles', maxAgeDays: 5, scope: 'stock', stage: 'research' }),
      own('pullback-dip', 'daily', 'attest', 'The dip happened on lower volume than the rise', { help: 'Quiet selling means sellers are not in control.' }),
      own('pullback-turn', 'daily', 'attest', 'A daily candle has closed back up from the 20-day average', { help: 'Wait for proof that buyers returned.' }),
      ...lib(SHARED_LIQUIDITY),
      ...lib(['plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-reward', 'plan-invalid'], { 'plan-stop-distance': { value: 6 } }),
      ...lib(SHARED_END),
    ],
  },
  {
    id: 'results', name: 'After-results momentum', version: 2, builtin: true, enabled: true,
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
    id: 'complete', name: 'Complete pre-trade checklist', version: 1, builtin: true, enabled: true,
    description: 'Every check in the library. Core checks are required; the rest are optional notes. Use it as a full review, or copy it and trim.',
    items: LIBRARY_ITEMS.filter((i) => i.id !== 'money-regular-for-events').map((i) => toStrategyItem(i, { required: !!i.core })),
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
    const common = { id: itemId, ...(group ? { group } : {}), stage, help: str(raw.help, 'Help', 500, false) };
    if (raw.type === 'attest') return { ...common, type: 'attest', label: str(raw.label, `Item ${i + 1}`, 200), required };
    if (raw.type === 'evidence') {
      if (!EVIDENCE_KINDS[raw.kind]) throw new UserError(`Item ${i + 1}: evidence kind must be one of ${Object.keys(EVIDENCE_KINDS).join(', ')}.`);
      if (!Number.isInteger(raw.maxAgeDays) || raw.maxAgeDays < 0 || raw.maxAgeDays > 400) throw new UserError(`Item ${i + 1}: freshness must be 0 (today) to 400 days.`);
      const scope = raw.scope ?? 'stock';
      if (!['stock', 'market'].includes(scope)) throw new UserError(`Item ${i + 1}: scope must be stock or market.`);
      return { ...common, type: 'evidence', label: str(raw.label, `Item ${i + 1}`, 200), kind: raw.kind, maxAgeDays: raw.maxAgeDays, scope, required };
    }
    if (raw.type === 'rule') {
      const def = RULES[raw.rule];
      if (!def || !def.valid(raw.value)) throw new UserError(`Item ${i + 1}: choose a valid rule and value.`);
      return { ...common, type: 'rule', rule: raw.rule, value: raw.value, label: def.label(raw.value), required: true };
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
