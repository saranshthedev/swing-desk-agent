// Prepare marks: the owner's record that a research item was done for a stock, and the
// cooling-off gate built on them. A mark counts on an India day only when its age in India
// calendar days is at least the strategy's buffer and at most its expire (strategyWindow).
// An evidence mark also needs the record it points to to still count (verified, not
// corrected, not in the Trash, within good-until). Nothing here reads request-page answers,
// so there is no way to skip the wait.
//
// Marks are shared: a library item is keyed by its id for every strategy (a strategy's own
// items by strategy id + item id), per stock, plus the exchange for exchange-bound items.

import { LIBRARY_ITEMS, MARKET } from './checklist-library.js';
import { strategyWindow, isExchangeBound } from './strategies.js';
import { recordStatus } from './knowledge.js';
import { addDays, daysBetween, indiaDate } from './time.js';

const LIBRARY_IDS = new Set(LIBRARY_ITEMS.map((i) => i.id));

/** Key for an item's mark: library ids are shared across strategies; own ids are per strategy. */
export function markKey(strategy, item) {
  return LIBRARY_IDS.has(item.id) ? item.id : `${strategy.id}:${item.id}`;
}

/** Where a mark lives in state.prepared. `exchange` is set only for exchange-bound items. */
export const preparedKey = (symbol, key, exchange) => `${symbol}|${key}|${exchange ?? ''}`;

/** The exchange a mark is keyed with: the given one for exchange-bound items, else none. */
export const markExchange = (item, exchange) => (isExchangeBound(item) ? exchange : undefined);

/** Items the owner can prepare ahead: research-stage “you answer” and evidence items. */
export const preparable = (item) => (item.stage ?? 'before') === 'research' && (item.type === 'attest' || item.type === 'evidence');

/** The stock an evidence item's record is saved under. */
export const recordSymbol = (item, symbol) => (item.scope === 'market' ? MARKET : symbol);

/**
 * State of one research item for a stock on the India day of `now`:
 *   missing – not prepared (or prepared with a record of the wrong kind)
 *   broken  – the record behind the mark was corrected, trashed or is past its good-until
 *   wait    – prepared fewer than bufferDays ago
 *   expired – prepared more than expireDays ago
 *   pass    – inside the window
 * validFrom / expiresOn are the first and last India days the mark counts.
 */
export function researchItemState(state, strategy, item, symbol, exchange, now) {
  const { bufferDays, expireDays } = strategyWindow(strategy);
  const mark = state.prepared?.[preparedKey(symbol, markKey(strategy, item), markExchange(item, exchange))];
  if (!mark) return { status: 'missing', detail: `Not prepared yet. Prepare it on the Prepare page; it counts ${bufferDays} days later.` };
  const today = indiaDate(now);
  const markedOn = indiaDate(Date.parse(mark.at));
  const validFrom = addDays(markedOn, bufferDays);
  let expiresOn = addDays(markedOn, expireDays);
  if (item.type === 'evidence') {
    const record = mark.evidenceId ? state.evidence.find((e) => e.id === mark.evidenceId) : null;
    if (!record || record.kind !== item.kind || record.symbol !== recordSymbol(item, symbol)) return { status: 'missing', detail: `Not prepared with a “${item.kind}” record yet. Prepare it on the Prepare page.` };
    const rs = recordStatus(record, today);
    if (rs === 'corrected') return { status: 'broken', detail: 'The record you prepared this with was corrected. Prepare it again with the new record; the wait starts again.' };
    if (rs === 'trashed') return { status: 'broken', detail: 'The record you prepared this with is in the Trash. Prepare it again with another record; the wait starts again.' };
    if (rs !== 'verified') {
      return { status: 'broken', detail: `The record you prepared this with ${record.goodUntil ? `was good until ${record.goodUntil}` : 'is not verified'}. Add or verify a new record and prepare it again.`, validFrom, expiresOn };
    }
    if (record.goodUntil < expiresOn) expiresOn = record.goodUntil;
  }
  const dates = { validFrom, expiresOn };
  const age = daysBetween(markedOn, today);
  if (age < bufferDays) return { status: 'wait', detail: `Prepared on ${markedOn}. It counts from ${validFrom} (after the ${bufferDays}-day wait) until ${expiresOn}.`, ...dates };
  if (age > expireDays) return { status: 'expired', detail: `Prepared on ${markedOn}; it stopped counting after ${expiresOn}. Prepare it again.`, ...dates };
  return { status: 'pass', detail: `Prepared on ${markedOn}. Counts until ${expiresOn}.`, ...dates };
}

/**
 * The earliest India day every given research state passes at once, or null when one is
 * missing, broken or expired, or when their windows never overlap.
 */
export function readyOn(states) {
  if (!states.length || states.some((s) => !s.validFrom || ['missing', 'broken', 'expired'].includes(s.status))) return null;
  const from = states.reduce((a, s) => (s.validFrom > a ? s.validFrom : a), '');
  const to = states.reduce((a, s) => (s.expiresOn < a ? s.expiresOn : a), '9999-12-31');
  return from <= to ? from : null;
}
