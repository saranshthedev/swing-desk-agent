// Kinds of evidence. Agents gather information with whatever their own model app can reach
// (the desk adds no paid data source). Prices and MTF requirements gate real money, so they
// count toward approval only when the owner recorded or confirmed them; an agent's value is
// shown for one-click confirmation. Everything else from agents counts but is shown as not verified.
//
// Market-wide facts (Nifty, global markets, oil, USDINR…) are saved once under the symbol
// MARKET and count for every stock.

export const EVIDENCE_KINDS = Object.freeze({
  quote: 'Current price',
  funding: 'MTF own-cash requirement',
  news: 'News / announcements check',
  candles: 'Daily price and volume check',
  calendar: 'Results or event dates',
  zones: 'Weekly / monthly trend and demand-supply zones',
  sector: 'Sector and peer comparison',
  fundamentals: 'Company fundamentals (results, debt, holdings)',
  macro: 'Market-wide check: Nifty, VIX, global markets, oil, USDINR, flows (save under MARKET)',
  other: 'Other',
});

export const NEEDS_OWNER_CONFIRMATION = new Set(['quote', 'funding']);

// Price-type kinds are specific to one exchange (NSE and BSE can differ), so records name it.
export const EXCHANGE_KINDS = new Set(['quote', 'candles', 'zones']);
