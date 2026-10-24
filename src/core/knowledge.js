// The verified knowledge store: how an evidence record is judged and looked up.
// A record counts toward a check only while it is "verified": the owner entered it (or
// verified it) and its good-until date has not passed. Agent records are "found": shown, not counted.

import { addDays } from './time.js';

/** Days a record stays good after it was observed, by kind (spec call 7). */
const GOOD_DAYS = { candles: 5, zones: 5, sector: 5, macro: 7, governance: 90, legal: 90, other: 90, fundamentals: 90, news: 0, quote: 0, funding: 0 };

/**
 * Default good-until date. Fundamentals last until the next results date when known.
 * observedDate and the result are India dates (YYYY-MM-DD).
 */
export function suggestGoodUntil(kind, observedDate, nextResultsDate) {
  if (kind === 'fundamentals' && nextResultsDate && nextResultsDate >= observedDate) return nextResultsDate;
  return addDays(observedDate, GOOD_DAYS[kind] ?? 90);
}

/** found | verified | expired | corrected | trashed. `today` is an India date. */
export function recordStatus(e, today) {
  if (e.trashed) return 'trashed';
  if (e.correctedBy) return 'corrected';
  // Old owner records have no good-until, so they stay "found" until the owner verifies them.
  if (!e.goodUntil || (e.by !== 'owner' && !e.verifiedAt)) return 'found';
  return e.goodUntil >= today ? 'verified' : 'expired';
}

export const counts = (e, today) => recordStatus(e, today) === 'verified';

/** Newest counting record for a kind and stock (or topic), or null. Other exchanges are skipped. */
export function latestCounting(state, { kind, symbol, topic, exchange, today }) {
  let best = null;
  for (const e of state.evidence) {
    if (e.kind !== kind || e.symbol !== symbol) continue;
    if (topic !== undefined && e.topic !== topic) continue;
    if (exchange !== undefined && e.exchange !== exchange) continue;
    if (!counts(e, today)) continue;
    if (!best || e.observedAt > best.observedAt || (e.observedAt === best.observedAt && e.at > best.at)) best = e;
  }
  return best;
}
