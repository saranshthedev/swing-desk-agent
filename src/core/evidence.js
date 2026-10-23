// Kinds of evidence. Agents gather information with whatever their own model app can reach
// (the desk adds no paid data source). Prices and MTF requirements gate real money, so they
// count toward approval only when the owner recorded or confirmed them; an agent's value is
// shown for one-click confirmation. Everything else from agents counts but is shown as not verified.

export const EVIDENCE_KINDS = Object.freeze({
  quote: 'Current price',
  funding: 'MTF own-cash requirement',
  news: 'News / announcements check',
  candles: 'Daily price and volume check',
  calendar: 'Results or event dates',
  other: 'Other',
});

export const NEEDS_OWNER_CONFIRMATION = new Set(['quote', 'funding']);
