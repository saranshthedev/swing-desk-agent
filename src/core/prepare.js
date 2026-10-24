// Prepare marks: the owner's record that a research item was done for a stock, and the
// cooling-off gate built on them. A mark counts on an India day only when its age in India
// calendar days is at least the strategy's buffer and at most its expire (strategyWindow).
// An evidence mark also needs the record it points to to still count (verified, not
// corrected, not in the Trash, within good-until). Nothing here reads request-page answers,
// so there is no way to skip the wait.
//
// Marks are shared: a library item is keyed by its id for every strategy (a strategy's own
// items by strategy id + item id), per stock, plus the exchange for exchange-bound items.

import { LIBRARY_ITEMS, MARKET, toStrategyItem } from './checklist-library.js';
import { strategyWindow, isExchangeBound } from './strategies.js';
import { recordStatus, counts, latestCounting } from './knowledge.js';
import { researchStatus, masterStatus } from './rules.js';
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

// ---------- recommendations ----------
// The desk's own wait / buy / hold / sell call for a stock, worked out from the owner's
// records only. It is information, never advice, and the desk never acts on it.

const MASTER_ITEMS = LIBRARY_ITEMS.map((i) => toStrategyItem(i));
const MASTER_STRATEGY = { id: 'master', name: 'Master list', items: MASTER_ITEMS };
const CORE_IDS = new Set(LIBRARY_ITEMS.filter((i) => i.core).map((i) => i.id));
const rupees = (n) => `₹${(Math.round(n * 100) / 100).toFixed(2)}`;
const labelOf = (c) => c.label ?? c.id;

function istTime(ms) {
  return new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

const markOf = (state, strategy, item, symbol, exchange) => state.prepared?.[preparedKey(symbol, markKey(strategy, item), markExchange(item, exchange))];

/**
 * The research items one open lot relied on: the items its own request was checked against
 * (`item:<id>` in decision.checks, read from its strategy) plus the master core research items.
 * Each entry is { strat, item, key }.
 */
function lotItems(state, lot) {
  const intent = state.intents[lot.intentId];
  const strategy = intent ? state.strategies[intent.strategyId] : null;
  const ids = new Set((intent?.decision?.checks ?? []).map((c) => c.id).filter((id) => typeof id === 'string' && id.startsWith('item:')).map((id) => id.slice(5)));
  const out = new Map();
  const add = (strat, item) => {
    if (!preparable(item)) return;
    const key = markKey(strat, item);
    if (!out.has(key)) out.set(key, { strat, item, key });
  };
  for (const item of strategy?.items ?? []) if (ids.has(item.id)) add(strategy, item);
  for (const item of MASTER_ITEMS) if (CORE_IDS.has(item.id)) add(MASTER_STRATEGY, item);
  return [...out.values()];
}

/** Reasons this open lot may be sold, and research labels worth a re-check (never a sell reason). */
function lotReview(state, lot, now) {
  const today = indiaDate(now);
  const sell = [];
  const set = lotItems(state, lot);
  const topics = new Set(set.map((x) => x.item.id));

  // Records the lot's research rested on.
  const refs = new Map();
  for (const { strat, item } of set) {
    const mark = markOf(state, strat, item, lot.symbol, lot.exchange);
    const r = mark?.evidenceId ? state.evidence.find((e) => e.id === mark.evidenceId) : null;
    if (r) refs.set(r.id, r);
  }
  const opened = new Date(`${lot.date}T00:00:00+05:30`).toISOString();
  for (const r of refs.values()) {
    if (recordStatus(r, today) !== 'corrected') continue;
    const fixedAt = state.evidence.find((e) => e.id === r.correctedBy)?.at;
    const when = fixedAt && fixedAt > opened ? ' after you bought' : '';
    sell.push(`A record your research rested on (${r.kind}${r.topic ? `, ${r.topic}` : ''}, saved ${indiaDate(Date.parse(r.at))}) was corrected${when}.`);
  }

  // A newer counting record on the same stock and one of those items that says “bad”.
  for (const b of state.evidence) {
    if (b.symbol !== lot.symbol || !topics.has(b.topic) || b.verdict !== 'bad' || !counts(b, today)) continue;
    const older = [...refs.values()].filter((r) => r.topic === b.topic).map((r) => r.at);
    const cutoff = older.length ? older.reduce((a, x) => (x > a ? x : a)) : opened;
    if (b.at > cutoff) sell.push(`A newer record on “${b.topic}” (saved ${indiaDate(Date.parse(b.at))}) is marked bad.`);
  }

  // Price close to the stop: in the bottom quarter of the way from stop to entry.
  const quote = latestCounting(state, { kind: 'quote', symbol: lot.symbol, exchange: lot.exchange, today });
  if (quote) {
    const line = lot.stop + 0.25 * (lot.entry - lot.stop);
    if (quote.price <= line) sell.push(`The latest price you entered or verified, ${rupees(quote.price)} (${istTime(Date.parse(quote.observedAt))} India time), is at or below ${rupees(line)}, a quarter of the way up from the stop (${rupees(lot.stop)}) to the entry (${rupees(lot.entry)}).`);
  }

  // Planned holding days used up.
  const last = addDays(lot.date, lot.plannedDays);
  if (today > last) sell.push(`The planned ${lot.plannedDays} holding days from ${lot.date} ended on ${last}.`);

  // Research the lot relied on that has gone out of date.
  const recheck = [];
  for (const { strat, item } of set) {
    const st = researchItemState(state, strat, item, lot.symbol, lot.exchange, now);
    let old = st.status === 'expired';
    if (st.status === 'broken') {
      const mark = markOf(state, strat, item, lot.symbol, lot.exchange);
      const r = mark?.evidenceId ? state.evidence.find((e) => e.id === mark.evidenceId) : null;
      old = !!r && recordStatus(r, today) === 'expired';
    }
    if (old && !recheck.includes(item.label)) recheck.push(item.label);
  }
  return { sell, recheck };
}

/** wait | buy | hold | sell for a stock on an exchange, with plain-language reasons. */
export function deskRecommendation(state, symbol, exchange, now) {
  const today = indiaDate(now);
  const strategies = Object.values(state.strategies)
    .filter((s) => s.enabled && !s.trashed)
    .map((s) => {
      const r = researchStatus(state, symbol, s.id, exchange, now);
      const missing = r.checks
        .filter((c) => c.required && c.stage === 'research' && c.status !== 'pass' && c.status !== 'info')
        .map((c) => `${labelOf(c)}${c.status === 'wait' && c.validFrom ? ` (counts from ${c.validFrom})` : ''}`);
      const fits = r.researchDone && !!r.readyOn && r.readyOn <= today;
      return { id: s.id, name: s.name, fits, missing, readyOn: r.readyOn };
    });
  const out = (call, reasons, recheck = []) => ({ call, reasons, strategies: strategies.map(({ readyOn, ...rest }) => rest), recheck });

  const lots = Object.values(state.lots).filter((l) => l.status === 'open' && l.symbol === symbol && l.exchange === exchange);
  if (lots.length) {
    const reviews = lots.map((l) => lotReview(state, l, now));
    const sell = reviews.flatMap((r) => r.sell);
    const recheck = [...new Set(reviews.flatMap((r) => r.recheck))];
    if (sell.length) return out('sell', sell, recheck);
    return out('hold', [`${symbol} is held on ${exchange}. No sell signal is on: no corrected or bad record, the price is above the stop zone, and the planned days are not used up.`], recheck);
  }

  const masterMissing = masterStatus(state, symbol, exchange, now).checks
    .filter((c) => c.required && c.stage === 'research' && CORE_IDS.has(String(c.id).slice(5)) && c.status !== 'pass' && c.status !== 'info');
  const fitting = strategies.filter((s) => s.fits);
  if (!masterMissing.length && fitting.length) {
    return out('buy', [`All core master research is inside its window, and ${fitting.map((s) => s.name).join(', ')} ${fitting.length > 1 ? 'have' : 'has'} its research done and past the wait.`]);
  }
  const reasons = [];
  if (masterMissing.length) reasons.push(`Core master research not counting yet: ${masterMissing.map(labelOf).join('; ')}.`);
  if (!fitting.length) {
    const dated = strategies.filter((s) => s.readyOn).map((s) => s.readyOn).sort();
    if (!strategies.length) reasons.push('No strategy is switched on.');
    else if (dated.length && dated[0] > today) reasons.push(`The earliest a strategy is ready is ${dated[0]}.`);
    else reasons.push('No strategy has all its required research prepared and inside its window.');
    for (const s of strategies) if (s.missing.length) reasons.push(`${s.name} is missing: ${s.missing.join('; ')}.`);
  }
  return out('wait', reasons);
}

/** The newest recommendation an agent stored for a stock on an exchange, or null. */
export function latestRecommendation(state, symbol, exchange) {
  const list = state.recommendations ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.symbol === symbol && r.exchange === exchange && String(r.by).startsWith('agent:')) return r;
  }
  return null;
}
