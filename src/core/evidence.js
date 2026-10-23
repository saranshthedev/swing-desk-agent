// Kinds of evidence. Broker prices and MTF requirements can only come from the owner,
// because they gate real money; everything else may come from an agent and is shown as
// not verified.

export const EVIDENCE_KINDS = Object.freeze({
  quote: 'Current price from your broker',
  funding: 'MTF own-cash requirement from your broker',
  news: 'News / announcements check',
  candles: 'Daily price and volume check',
  calendar: 'Results or event dates',
  other: 'Other',
});

export const OWNER_ONLY_EVIDENCE = new Set(['quote', 'funding']);
