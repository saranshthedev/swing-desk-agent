// Plain-language help shown by the “i” buttons next to form fields.
// Keys are field names. Keep sentences short and give a ₹ example where it helps.

export const INFO = {
  // ---------- risk limits ----------
  capital: 'All the money you keep for trading. Other limits are worked out from it. Example: ₹1,00,000.',
  riskPct: 'The most you agree to lose on one trade if the price falls to your stop. Example: 0.5% of ₹1,00,000 = ₹500.',
  cashPerTrade: 'The most of your own money one trade can use. Borrowed MTF money comes on top. Example: ₹25,000.',
  minRewardRisk: 'How much bigger the possible gain must be than the possible loss, after charges. 2 means: risk ₹500 only if you could gain ₹1,000.',
  maxOpenLots: 'How many buys can be open at once. Each separate buy counts as one, even in the same stock.',
  maxOpenRiskPct: 'If every open trade fell to its stop at the same time, this is the most you could lose in total. Example: 3% of ₹1,00,000 = ₹3,000.',
  maxBorrowedPct: 'The most you can borrow from Zerodha (MTF) across all trades. 100% of ₹1,00,000 = ₹1,00,000 borrowed. 0 means never borrow.',
  weeklyLossLimitPct: 'If your sold trades lose this much in one week (Monday to Sunday), new buys stop until next Monday. Example: 3% of ₹1,00,000 = ₹3,000.',
  slipPct: 'You often buy a little higher and sell a little lower than planned. This adds a small safety cost to plans. 0.1% of ₹500 = 50 paise per share.',
  preset: 'Pick a ready-made set of limits as a starting point. You can still change any number. Changing a number makes it “Custom”.',

  // ---------- PIN ----------
  pin: 'Your secret approval number, like an ATM PIN. Only you should know it. Never give it to Claude or any AI.',
  oldPin: 'The PIN you use now. Needed before you can set a new one.',

  // ---------- plan ----------
  symbol: 'The stock’s short name exactly as Kite shows it. Example: TATAMOTORS, INFY.',
  strategyId: 'The kind of trade. Each strategy has its own checklist. Picking one also fills its usual hold days and buy type.',
  exchange: 'Where you buy the stock. Most people use NSE. Charges differ a little on BSE.',
  buyType: 'MTF: Zerodha lends you part of the money and charges daily interest. Regular (CNC): you pay everything yourself, no interest.',
  fundingMode: 'Brokers show MTF in two ways. Leverage 2× and own cash 50% mean the same thing: you pay half, Zerodha lends half.',
  fundingValue: 'How much Zerodha lends. 2× (or 50%) = you pay ₹50,000 and borrow ₹50,000 for a ₹1,00,000 buy. Most stocks allow up to 5×. Check the stock in Kite.',
  entry: 'The price you want to buy at (a limit price). Example: ₹500.',
  stop: 'The price where you will sell to stop the loss. It must be below the entry. Example: entry ₹500, stop ₹485.',
  target: 'The price where you plan to take profit. It must be above the entry. Example: ₹560.',
  days: 'The longest you plan to hold, in calendar days. MTF interest is charged for every day you hold.',
  thesis: 'In your own words, why this trade. You will be glad to read it later.',

  // ---------- research ----------
  kind: 'What sort of proof this is: news, the daily chart (candles), results dates, or something else.',
  source: 'A link where you found it, so you or Claude can check it again.',

  // ---------- agents ----------
  name: 'A name you will recognise, for example “Claude research”.',
  client: 'Which app this key is for, for example Claude Code or Claude Desktop. Just a note for you.',
  scope: 'What this AI may do. Read: only look. Draft: also save research. Propose: also send trade ideas for you to approve. No level can approve or place orders.',
  agentPreset: 'Pick a ready-made access level and daily limits. You can still change them below.',
  expiresDays: 'After this many days the key stops working and you make a new one. Shorter is safer.',
  intentsPerDay: 'The most trade ideas (requests) this AI can send in one day. 0 = none.',
  writesPerDay: 'The most notes and evidence this AI can save in one day.',
  callsPerHour: 'The most times this AI can talk to the app in one hour. Stops runaway loops.',
  revoked: 'Tick to switch this key off for good. The AI can no longer use the app with it.',

  // ---------- playbooks ----------
  template: 'Start from a ready-made job. You can change the time, the AI and the instructions.',
  agentId: 'Which AI does this job. It must be connected under Agents & MCP.',
  maxIntents: 'How many trade ideas the AI may send in one run. 0 = research only.',
  mode: 'Once a day at a fixed time, or again and again every few minutes during market hours.',
  at: 'The time in India (IST), 24-hour clock. Example: 15:50 is 3:50 pm.',
  every: 'How often, in minutes. Example: 30 = every half hour.',
  from: 'Start time in India (IST). Example: 09:15 is when the market opens.',
  to: 'End time in India (IST). Example: 15:30 is when the market closes.',
  instructions: 'Tell the AI what to do in plain words, as you would tell a person. Say which tools to use and what to report.',
  enabled: 'Switch the job on or off. Turn it off on market holidays.',

  // ---------- strategies ----------
  id: 'A short code name using small letters, numbers and dashes. Example: my-breakout.',
  description: 'One line about when to use this strategy.',
  copyFrom: 'Start with the checklist of an existing strategy, then change it.',
  type: 'You answer: you tick yes yourself when approving. Needs evidence: proof must be saved first. Fixed rule: the app checks the numbers itself.',
  label: 'The question in plain words, for example “Volume is at least 1.5× normal”.',
  rule: 'Which number the app checks: biggest stop distance, smallest gain-to-loss, longest hold, or Regular only (no borrowing).',
  value: 'The limit for the rule. Example: 8 for “stop at most 8% below entry”. For Regular only, type true.',
  maxAgeDays: 'How old the proof may be, in days. 0 means it must be from today.',
  required: 'Ticked: the trade cannot be approved without this. Not ticked: shown only as a note.',
  group: 'Which heading this check sits under, like “Company fundamentals”. A group is done only when all its required checks pass.',
  stage: 'Research: can be done 1–5 days before and saved on the Prepare page. Just before buying: must be checked on the day.',
  scope: 'This stock: proof is needed for each stock. Whole market: saved once a day under MARKET (for Nifty, oil, USDINR…) and counts for every stock.',
  libraryPick: 'Pick ready-made checks from the full pre-trade list. Choose a group to add all its checks at once.',
};

/** Help that depends on the form a field is in (same field name, different meaning). */
export const INFO_IN = {
  plan: { qty: 'Leave empty and the app picks the biggest number of shares that fits your limits.' },
  'fill-buy': {
    qty: 'How many shares really got bought in Kite.',
    price: 'The average price Kite shows for the buy. It already includes any slippage.',
    date: 'The day the buy happened.',
  },
  'fill-sell': {
    qty: 'How many shares you sold. Sell part, and the rest stays open at the same buy price.',
    price: 'The average price Kite shows for the sale.',
    date: 'The day the sale happened.',
    charges: 'All charges for this sale from the contract note, plus MTF interest. Leave empty and the app will estimate them.',
  },
  quote: { price: 'The price Kite shows right now. It counts for 5 minutes only.' },
  funding: {
    summary: 'Where you checked, for example “Kite MTF list”.',
    fundingMode: 'Kite may show leverage (like 3×) or own cash (like 33%). Choose the one you see.',
    fundingValue: 'What Kite allows for this stock today. 3× means you can borrow up to two-thirds.',
  },
  evidence: {
    summary: 'What you found, in a few words. Example: “No news today. Results on 20 Nov.”',
    symbol: 'The stock’s name as in Kite. For whole-market checks (Nifty, VIX, oil, USDINR, US markets) type MARKET.',
  },
  'stock-pick': { symbol: 'The stock’s name as in Kite, for example TATAMOTORS. Type MARKET for whole-market checks.' },
  note: { title: 'A short heading, for example “Watch the 580 level”.', body: 'Anything you want to remember about this stock. Connected agents with Read access can see notes.' },
  'prepare-pick': { symbol: 'The stock you are thinking of buying in the next few days.', strategyId: 'Which strategy’s checklist to use. Each one has its own research list.' },
  stop: { stop: 'Your new stop price. Moving it up locks in profit; moving it down adds risk.' },
  reject: { reason: 'Optional. Why you said no, so you and the AI can learn.' },
  playbook: { name: 'A short name for this job, for example “Morning news check”.' },
  strategy: { name: 'A name you will recognise, for example “My breakout”.', id: 'A short code name: small letters, numbers and dashes, for example my-breakout. It cannot change later.' },
  'agent-update': { scope: 'Change what this AI may do. Read: only look. Draft: also save research. Propose: also send trade ideas.' },
};
