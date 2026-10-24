// The pre-trade checklist library: groups (items) and their sub-items, in plain language.
// Strategies pick sub-items from here. Adapted and extended from Swing Desk v3's checklist.
//
// Each sub-item has:
//   label – what to check;  help – why, in easy words;  how – where to look (free sources only)
//   check – how the app treats it when added to a strategy:
//     'you'                                   → you tick it yourself when approving
//     { evidence, maxAgeDays, scope }          → needs saved evidence (scope 'market' = once for all stocks)
//                                                Research-stage evidence has no maxAgeDays: it is judged by the strategy’s window.
//     { rule, value }                          → the app checks the plan’s numbers itself
//   core  – true: required in the Complete strategy. Others are optional notes there.
//   exchangeBound – true: only the exchange can show it (price, chart, volume), so the owner sees it as a
//                   check done on exchange data. Set by group, evidence kind or id (see EXCHANGE_*).
//
// Nothing here is advice or a promise of profit. It is a list of things worth looking at.

export const MARKET = 'MARKET'; // evidence saved under this name applies to every stock

export const SOURCES = Object.freeze({
  charts: ['Charts in Kite', 'https://kite.zerodha.com/'],
  filings: ['Company announcements on NSE', 'https://www.nseindia.com/companies-listing/corporate-filings-announcements'],
  results: ['Financial results on NSE', 'https://www.nseindia.com/companies-listing/corporate-filings-financial-results'],
  meetings: ['Board meetings on NSE', 'https://www.nseindia.com/companies-listing/corporate-filings-board-meetings'],
  actions: ['Company actions on NSE', 'https://www.nseindia.com/companies-listing/corporate-filings-actions'],
  shareholding: ['Shareholding pattern on NSE', 'https://www.nseindia.com/companies-listing/corporate-filings-shareholding-pattern'],
  pledge: ['Promoter pledge data on NSE', 'https://www.nseindia.com/companies-listing/corporate-filings-pledged-data'],
  deals: ['Bulk and block deals on NSE', 'https://www.nseindia.com/report-detail/display-bulk-and-block-deals'],
  holidays: ['Exchange holidays', 'https://www.nseindia.com/resources/exchange-communication-holidays'],
  vix: ['India VIX on NSE', 'https://www.nseindia.com/static/products-services/indices-indiavix-index'],
  indices: ['NSE indices (Nifty, sectors, midcap)', 'https://www.nseindia.com/market-data/live-market-indices'],
  fiidii: ['FII/DII trading activity on NSE', 'https://www.nseindia.com/reports/fii-dii'],
  bands: ['Price bands and surveillance (ASM/GSM) on NSE', 'https://www.nseindia.com/static/market-data/price-bands-surveillance-actions'],
  delivery: ['Security-wise delivery data on NSE', 'https://www.nseindia.com/all-reports'],
  rbi: ['RBI press releases and reference rate', 'https://www.rbi.org.in/'],
  oil: ['International crude oil prices (Govt. of India, PPAC)', 'https://ppac.gov.in/prices/international-prices-of-crude-oil'],
  mospi: ['Indian inflation, IIP and GDP data (MoSPI)', 'https://www.mospi.gov.in/'],
  imd: ['Monsoon updates (IMD)', 'https://mausam.imd.gov.in/'],
  mtf: ['Zerodha MTF guide', 'https://support.zerodha.com/category/trading-and-markets/margins/margin-trading-facility/articles/margin-trading-facility-mtf-faqs'],
  rms: ['Zerodha MTF risk rules', 'https://support.zerodha.com/category/trading-and-markets/margins/margin-trading-facility/articles/rms-policy-on-mtf'],
  gtt: ['Zerodha GTT (stop/target orders)', 'https://support.zerodha.com/category/trading-and-markets/charts-and-orders/gtt/articles/what-is-the-good-till-triggered-gtt-feature'],
  costs: ['Zerodha charges', 'https://zerodha.com/charges/'],
});

const you = 'you';
const ev = (evidence, maxAgeDays, scope = 'stock') => ({ evidence, maxAgeDays, scope });
const evResearch = (evidence, scope = 'stock') => ({ evidence, scope }); // research evidence: no age limit of its own
const rule = (r, value) => ({ rule: r, value });

/** Groups in the order you would normally work through them. */
export const CHECKLIST_LIBRARY = Object.freeze([
  {
    id: 'market', title: 'Indian market direction',
    why: 'Most stocks move with the market. Buying when the whole market is falling is harder.',
    items: [
      { id: 'market-nifty-trend', label: 'Nifty 50 is not in a falling trend on the daily and weekly chart', help: 'Look for higher highs and higher lows. If Nifty keeps making lower lows, be careful.', how: 'Kite chart of NIFTY 50, daily and weekly.', check: ev('macro', 0, 'market'), core: true },
      { id: 'market-nifty-averages', label: 'Nifty is above its 50-day and 200-day averages', help: 'Above both averages usually means a healthy market. Below both means a weak one.', how: 'Add 50 and 200 moving averages on the Nifty daily chart.', check: you },
      { id: 'market-banknifty', label: 'Bank Nifty agrees with Nifty', help: 'Banks are a big part of the market. If banks are weak, the market often follows.', how: 'Kite chart of NIFTY BANK.', check: you },
      { id: 'market-broad', label: 'Midcap and smallcap indices are also healthy', help: 'If only big stocks rise while small ones fall, the rally is narrow and fragile.', how: 'NIFTY MIDCAP 100 and NIFTY SMALLCAP 100 charts.', check: you },
      { id: 'market-breadth', label: 'More stocks are rising than falling (market breadth)', help: 'When most stocks fall even on an up day, the market is weaker than it looks.', how: 'Advances vs declines on the NSE market page.', check: you },
      { id: 'market-vix', label: 'India VIX is not jumping sharply', help: 'VIX shows how much traders expect prices to swing. A sudden jump means more risk and wider stops.', how: 'India VIX on NSE or Kite.', check: ev('macro', 0, 'market'), core: true },
      { id: 'market-gift', label: 'GIFT Nifty does not point to a big gap', help: 'GIFT Nifty trades before the Indian market opens and hints at the opening price.', how: 'Any free market website showing GIFT Nifty.', check: you },
      { id: 'market-fits', label: 'Today’s market suits this strategy', help: 'Breakouts work better in rising markets. In a choppy or falling market, waiting is often best.', how: 'Your own judgement after the checks above.', check: you, core: true },
    ],
  },
  {
    id: 'global', title: 'Global markets and news',
    why: 'Big moves abroad overnight often show up in Indian prices the next morning.',
    items: [
      { id: 'global-us', label: 'US markets (S&P 500, Nasdaq) closed without a big fall', help: 'A sharp fall in the US often brings a weak opening in India.', how: 'Any free market website, checked in the morning.', check: ev('macro', 0, 'market'), core: true },
      { id: 'global-asia', label: 'Asian markets (Japan, Hong Kong) are calm this morning', help: 'Asia opens before India and sets the mood.', how: 'Nikkei 225 and Hang Seng on a free market website.', check: you },
      { id: 'global-yields', label: 'US 10-year bond yield is not jumping', help: 'Rising US yields can pull foreign money out of India.', how: 'US 10-year Treasury yield on a free market website.', check: you },
      { id: 'global-dxy', label: 'US Dollar Index (DXY) is not surging', help: 'A strong dollar often weakens the rupee and Indian stocks.', how: 'DXY on a free market website.', check: you },
      { id: 'global-centralbanks', label: 'No major central bank decision in the next days (Fed, ECB)', help: 'Interest rate decisions can move all markets at once.', how: 'Economic calendar on a free market website.', check: you },
      { id: 'global-news', label: 'No big world event right now (war, crisis, sanctions)', help: 'Sudden world news can make all prices fall together.', how: 'Main news headlines today.', check: ev('macro', 0, 'market'), core: true },
    ],
  },
  {
    id: 'currency', title: 'Rupee and currency (USDINR)',
    why: 'A falling rupee helps exporters and hurts importers. Foreign investors watch it closely.',
    items: [
      { id: 'currency-usdinr', label: 'USDINR trend checked today', help: 'USDINR going up means the rupee is getting weaker.', how: 'RBI reference rate or USDINR on a free market website.', check: ev('macro', 0, 'market'), core: true },
      { id: 'currency-exposure', label: 'You know if this company earns or spends in dollars', help: 'IT and pharma exporters gain from a weak rupee. Oil, gold and electronics importers lose.', how: 'Company annual report: “foreign exchange earnings and outgo”.', check: you, core: true },
      { id: 'currency-debt', label: 'The company has no large foreign-currency debt', help: 'Dollar loans get costlier when the rupee falls.', how: 'Annual report notes on borrowings.', check: you },
      { id: 'currency-rbi', label: 'No RBI currency action or rate decision due soon', help: 'RBI decisions can move the rupee and bank stocks.', how: 'RBI website: monetary policy dates.', check: you },
    ],
  },
  {
    id: 'commodities', title: 'Oil and other commodities',
    why: 'Raw material prices change company profits. Find out which ones matter for this company.',
    items: [
      { id: 'commodity-crude', label: 'Brent and WTI crude oil checked today', help: 'High oil hurts paint, tyre, aviation, chemical and oil-marketing companies. It helps oil producers.', how: 'Brent and WTI (USOIL) on a free market website, or PPAC.', check: ev('macro', 0, 'market'), core: true },
      { id: 'commodity-which', label: 'You know which commodities this company buys or sells', help: 'Example: a steel maker sells steel and buys iron ore and coal.', how: 'Annual report: raw materials and products.', check: you, core: true },
      { id: 'commodity-gas', label: 'Natural gas price (for gas, fertiliser and power companies)', help: 'Gas is a main cost for city gas, fertiliser and some power companies.', how: 'Natural gas price on a free market website.', check: you },
      { id: 'commodity-metals', label: 'Base metals: steel, aluminium, copper, zinc', help: 'Metal prices drive metal company profits and raise costs for auto and capital goods makers.', how: 'LME or MCX prices on a free market website.', check: you },
      { id: 'commodity-gold', label: 'Gold and silver', help: 'Matter for jewellers and gold-loan companies.', how: 'Gold and silver on MCX or a free market website.', check: you },
      { id: 'commodity-coal', label: 'Coal', help: 'Matters for power, cement and steel companies.', how: 'Coal price news or index.', check: you },
      { id: 'commodity-agri', label: 'Farm goods: sugar, cotton, palm oil, wheat, rubber', help: 'Matter for sugar, textile, food, edible oil and tyre companies.', how: 'Commodity prices on a free market website.', check: you },
      { id: 'commodity-direction', label: 'The commodity trend helps (or does not hurt) this trade', help: 'Write in one line whether recent commodity moves are good or bad for this company.', how: 'Your judgement after the checks above.', check: you, core: true },
    ],
  },
  {
    id: 'india-macro', title: 'Indian economy and policy',
    why: 'Interest rates, inflation and government decisions affect whole sectors.',
    items: [
      { id: 'macro-rbi', label: 'RBI interest rate stance known', help: 'Rate cuts usually help banks, NBFCs, real estate and autos. Hikes hurt them.', how: 'RBI monetary policy statement.', check: you },
      { id: 'macro-inflation', label: 'Latest inflation (CPI) known', help: 'High inflation can lead to higher rates and lower spending.', how: 'MoSPI CPI release.', check: you },
      { id: 'macro-growth', label: 'Latest growth data (IIP, GDP, GST collections)', help: 'A growing economy helps most companies.', how: 'MoSPI and finance ministry releases.', check: you },
      { id: 'macro-bond', label: 'India 10-year bond yield not jumping', help: 'Rising yields hurt banks’ bond holdings and make stocks less attractive.', how: 'India 10-year yield on a free market website.', check: you },
      { id: 'macro-policy', label: 'No government decision pending that targets this sector', help: 'Duties, bans, PLI schemes or price controls can change a sector overnight.', how: 'News for the sector; budget and ministry announcements.', check: you, core: true },
      { id: 'macro-monsoon', label: 'Monsoon status (for farm, rural, FMCG, fertiliser, tractor stocks)', help: 'A weak monsoon reduces rural spending.', how: 'IMD monsoon updates.', check: you },
    ],
  },
  {
    id: 'flows', title: 'Who is buying: FII, DII and big deals',
    why: 'Large investors move prices. It helps to know if they are buying or selling.',
    items: [
      { id: 'flows-fiidii', label: 'FII and DII net buying/selling for recent days', help: 'Heavy foreign selling for many days often weighs on the market.', how: 'NSE FII/DII report.', check: ev('macro', 0, 'market') },
      { id: 'flows-deals', label: 'Bulk or block deals in this stock checked', help: 'A big holder selling in bulk can push the price down.', how: 'NSE bulk and block deals.', check: you },
      { id: 'flows-holding', label: 'Mutual fund and FII holding trend in this stock', help: 'Rising institutional holding over quarters is a good sign.', how: 'NSE shareholding pattern, last 4 quarters.', check: evResearch('fundamentals') },
    ],
  },
  {
    id: 'sector', title: 'Sector and peers',
    why: 'A good stock in a strong sector has the wind behind it.',
    items: [
      { id: 'sector-strength', label: 'The sector index is stronger than Nifty recently', help: 'Compare the sector’s last 1–3 months with Nifty. Leaders often keep leading.', how: 'Kite: compare the sector index (e.g. NIFTY IT) with NIFTY 50.', check: evResearch('sector'), core: true },
      { id: 'sector-trend', label: 'The sector index is not falling on the weekly chart', help: 'Buying a stock while its whole sector falls is swimming against the tide.', how: 'Weekly chart of the sector index.', check: you },
      { id: 'sector-peers', label: 'This stock is stronger than its main peers', help: 'Pick the leader, not the laggard.', how: 'Compare 2–3 similar companies’ charts.', check: you, core: true },
      { id: 'sector-peer-results', label: 'Recent results of peers were not bad', help: 'Bad results at a peer can hit the whole sector.', how: 'Peers’ latest results on NSE.', check: you },
      { id: 'sector-news', label: 'No bad sector news this week', help: 'Example: a new tax, ban or price cut for the whole industry.', how: 'News search for the sector.', check: ev('news', 3) },
      { id: 'sector-concentration', label: 'You do not already hold too much in this sector', help: 'Two or three trades in the same sector can fall together.', how: 'Your Positions page.', check: you, core: true },
    ],
  },
  {
    id: 'fundamentals', title: 'Company fundamentals',
    why: 'A healthy business is less likely to collapse while you hold it.',
    items: [
      { id: 'fund-growth', label: 'Sales and profit are growing (last 3 years and recent quarters)', help: 'Steady growth is a good sign. Falling profit needs a reason.', how: 'Company results on NSE; annual report.', check: evResearch('fundamentals'), core: true },
      { id: 'fund-margins', label: 'Profit margins are stable or improving', help: 'Shrinking margins mean costs are rising faster than prices.', how: 'Operating margin in the last 4–8 quarterly results.', check: you },
      { id: 'fund-returns', label: 'Return on capital is decent (ROE / ROCE)', help: 'Shows how well the company uses money. Above about 15% is usually good.', how: 'Annual report or results.', check: you },
      { id: 'fund-debt', label: 'Debt is under control', help: 'High debt is dangerous when rates rise or business slows. Check debt-to-equity and interest cover.', how: 'Balance sheet in results or annual report.', check: you, core: true },
      { id: 'fund-cash', label: 'Cash from operations supports the reported profit', help: 'Profit on paper with no cash coming in can be a warning.', how: 'Cash flow statement in the annual report.', check: you },
      { id: 'fund-valuation', label: 'Valuation is not extreme compared with peers and its own history', help: 'Very high P/E can fall fast on small disappointments.', how: 'P/E and P/B vs 2–3 peers.', check: you },
      { id: 'fund-promoter', label: 'Promoter holding is stable and not heavily pledged', help: 'Promoters selling or pledging many shares can be a red flag.', how: 'NSE shareholding pattern and pledge data.', check: evResearch('fundamentals'), core: true },
      { id: 'fund-governance', label: 'No audit warnings, auditor resignation or governance issues', help: 'These can lead to sudden large falls.', how: 'Annual report; NSE announcements.', check: you, core: true },
      { id: 'fund-dilution', label: 'No big share issue (QIP, rights, warrants) planned', help: 'New shares can push the price down.', how: 'NSE announcements and board meetings.', check: you },
      { id: 'fund-rating', label: 'No credit rating downgrade recently', help: 'A downgrade means lenders see more risk.', how: 'NSE announcements (credit rating).', check: you },
      { id: 'fund-guidance', label: 'Management’s latest outlook is not negative', help: 'What management said in the last results call or presentation.', how: 'Investor presentation or call transcript on NSE.', check: you },
      { id: 'fund-orderbook', label: 'Order book or pipeline is healthy (for capital goods, infra, defence)', help: 'Shows how much future work the company already has.', how: 'Investor presentation.', check: you },
    ],
  },
  {
    id: 'events', title: 'Company events and dates',
    why: 'Known dates can cause sudden big moves. Decide your rule before they happen.',
    items: [
      { id: 'events-results', label: 'No results date inside the planned hold (or you have a rule for it)', help: 'Prices can jump or crash on results day.', how: 'NSE board meetings.', check: evResearch('calendar'), core: true },
      { id: 'events-news', label: 'Company news and announcements read today', help: 'Look for orders, legal cases, management changes, or anything unusual.', how: 'NSE corporate announcements.', check: ev('news', 0), core: true },
      { id: 'events-actions', label: 'Dividend, bonus, split or buyback dates known', help: 'Prices adjust on these dates. Your stop and target may need to change.', how: 'NSE company actions.', check: you },
      { id: 'events-legal', label: 'No big court case, regulator (SEBI) action or tax demand', help: 'These can hit the price without warning.', how: 'NSE announcements and news.', check: you },
      { id: 'events-index', label: 'No index inclusion or exclusion surprise expected', help: 'Index changes move large amounts of money in and out.', how: 'NSE index rebalancing announcements.', check: you },
      { id: 'events-holidays', label: 'Market holidays inside the hold are known', help: 'Holidays mean you cannot exit, but MTF interest still runs every calendar day.', how: 'NSE holiday list.', check: you },
      { id: 'events-economy', label: 'No big economic event during the hold (budget, election result, RBI)', help: 'Whole-market events can swamp a good stock setup.', how: 'Economic calendar.', check: you },
    ],
  },
  {
    id: 'zones', title: 'Weekly and monthly chart: demand and supply zones',
    why: 'Higher timeframes show where big buyers and sellers acted before. Prices often react there again.',
    items: [
      { id: 'zones-monthly-trend', label: 'Monthly chart trend is up or sideways, not down', help: 'Trade in the direction of the bigger picture.', how: 'Kite chart, monthly candles, last 3–5 years.', check: evResearch('zones'), core: true },
      { id: 'zones-weekly-trend', label: 'Weekly chart trend is up (higher highs and higher lows)', help: 'The weekly trend is the main direction for a swing trade.', how: 'Kite chart, weekly candles, last 1–2 years.', check: evResearch('zones'), core: true },
      { id: 'zones-monthly-demand', label: 'Monthly demand zones marked', help: 'A demand zone is a price area where the stock rose sharply before. Buyers may return there.', how: 'Find the base just before a strong up-move on monthly candles. Mark its high and low.', check: you },
      { id: 'zones-monthly-supply', label: 'Monthly supply zones marked', help: 'A supply zone is a price area where the stock fell sharply before. Sellers may return there.', how: 'Find the base just before a strong down-move on monthly candles.', check: you },
      { id: 'zones-weekly-demand', label: 'Weekly demand zones marked', help: 'Closer, more detailed buyer areas than monthly zones.', how: 'Same method on weekly candles.', check: you, core: true },
      { id: 'zones-weekly-supply', label: 'Weekly supply zones marked', help: 'Closer seller areas. These often stop a rally.', how: 'Same method on weekly candles.', check: you, core: true },
      { id: 'zones-entry-near-demand', label: 'Entry is near a demand zone or just above a broken supply zone', help: 'Buying near support keeps your stop close and your risk small.', how: 'Compare your entry price with the zones you marked.', check: you, core: true },
      { id: 'zones-room-to-target', label: 'No strong supply zone between entry and target', help: 'If sellers sit in the way, the price may stop before your target.', how: 'Check the zones between your entry and target.', check: you, core: true },
      { id: 'zones-52week', label: '52-week high/low and all-time high are known', help: 'Near a 52-week or all-time high, there are fewer old sellers above. Near a low, many are waiting to sell.', how: 'Kite stock page.', check: you },
      { id: 'zones-weekly-averages', label: 'Price is above its weekly 20 and 50 moving averages', help: 'Above rising weekly averages means the long trend is healthy.', how: 'Add moving averages on the weekly chart.', check: you },
      { id: 'zones-gaps', label: 'Old unfilled price gaps on weekly/daily charts are noted', help: 'Price sometimes comes back to fill gaps.', how: 'Look for empty spaces between candles.', check: you },
    ],
  },
  {
    id: 'smc', title: 'Smart Money Concepts (SMC)',
    why: 'SMC reads the chart as a trail left by large buyers and sellers: where they stopped price, trapped others and left gaps. Nothing here is a promise that big players are behind a move.',
    items: [
      { id: 'smc-htf-bias', label: 'Weekly and daily structure agree on direction (bias is up)', help: 'Take only buy ideas that match the bigger picture. Mixed weekly and daily structure means wait.', how: 'Weekly and daily charts: a series of higher highs and higher lows on both.', check: evResearch('zones') },
      { id: 'smc-bos', label: 'The last break of structure (BOS) on the daily chart was up', help: 'A break of structure is a close above the last swing high. It shows buyers are in control.', how: 'Daily chart: mark swing highs and lows, find the latest close above a swing high.', check: you },
      { id: 'smc-choch', label: 'No change of character (CHoCH) against you on the daily chart', help: 'A change of character is the first close below the last higher low in an uptrend. It warns the trend may turn.', how: 'Daily chart, last 2–3 months.', check: you },
      { id: 'smc-liquidity', label: 'Liquidity pools marked: equal highs or lows, and previous day, week and month highs and lows', help: 'Stops of many traders sit just beyond these levels. Large players often push price to them first.', how: 'Daily and weekly charts: look for two or more highs or lows at nearly the same price.', check: you },
      { id: 'smc-order-block', label: 'A bullish order block is marked (the last down candle before a strong up-move that broke structure)', help: 'An order block is a zone where large buyers may have placed orders. Mark its high and low.', how: 'Daily chart: find the strong up-move, then the last red candle just before it.', check: you },
      { id: 'smc-fvg', label: 'Fair value gaps are marked (three-candle gaps price moved through too fast)', help: 'A fair value gap is a thin area where price jumped. Price often comes back to fill part of it.', how: 'Daily chart: find a candle whose range does not overlap the candles on either side.', check: you },
      { id: 'smc-unmitigated', label: 'The order block is still fresh: price has returned to it at most once', help: 'Each return uses up some of the buying left in the zone. A zone touched many times is weaker.', how: 'Count the returns to the zone on the daily chart.', check: you },
      { id: 'smc-htf-poi', label: 'The area you will trade from is on the weekly or daily chart, not a smaller timeframe', help: 'Areas from bigger timeframes carry more weight and are less likely to be noise.', how: 'Check which chart the order block or gap was drawn on.', check: you },
      { id: 'smc-discount', label: 'Entry is in the discount half (below 50%) of the current swing range', help: 'Buy cheap inside the range, not near the top. The 50% line is halfway between the swing low and swing high.', how: 'Draw the Fibonacci tool from swing low to swing high and read the 50% level.', check: you },
      { id: 'smc-confluence', label: 'The order block overlaps a fair value gap or a demand zone', help: 'Two reasons at the same price make the area stronger than one.', how: 'Compare your marked zones with the weekly and monthly demand zones above.', check: you },
      { id: 'smc-target-liquidity', label: 'Target is the next liquidity pool or opposing order block', help: 'Price is often drawn to resting stops. Aim for the next pool, and no further.', how: 'Look up from your entry for the nearest equal highs, old high or supply zone.', check: you },
      { id: 'smc-sweep', label: 'Sell-side liquidity was swept: price dipped below a prior low and closed back above it', help: 'A sweep with a quick recovery suggests sellers were trapped. It is a common sign before a rise.', how: 'Daily chart: a wick below a marked low with a close back above it.', check: ev('candles', 1) },
      { id: 'smc-displacement', label: 'The move away from the area was strong and fast (large candles, little overlap)', help: 'A sharp move shows real demand. Slow, overlapping candles show nothing special.', how: 'Daily chart: compare candle size with the last 20 candles.', check: you },
      { id: 'smc-ltf-confirm', label: 'The 1-hour chart shows a change of character up inside the area', help: 'A smaller timeframe turning up inside your zone is the entry signal. Wait for it instead of buying early.', how: 'Switch Kite to 1-hour candles and look inside the zone.', check: you },
      { id: 'smc-reaction', label: 'A daily candle has closed with a reaction from the area (long lower wick or bullish engulfing)', help: 'Waiting for the close avoids buying a candle that is still falling.', how: 'Daily candle after 3:30 pm.', check: you },
      { id: 'smc-stop-beyond', label: 'Stop is below the order block low or the sweep low, not inside the zone', help: 'If price closes below the whole zone, the idea is wrong. A stop inside the zone gets hit by normal noise.', how: 'Compare your stop with the marked low.', check: you },
    ],
  },
  {
    id: 'daily', title: 'Daily chart setup',
    why: 'This is where the actual buy signal comes from.',
    items: [
      { id: 'daily-pattern', label: 'The pattern matches this strategy’s rules exactly', help: 'Name the pattern (breakout, pullback…) and check every rule, not just most of them.', how: 'Daily chart in Kite.', check: ev('candles', 1), core: true },
      { id: 'daily-trend', label: 'Daily trend is up: higher highs and higher lows', help: 'A healthy uptrend makes each dip a possible buying chance.', how: 'Daily chart, last 3–6 months.', check: you },
      { id: 'daily-levels', label: 'Daily support and resistance levels marked', help: 'Support is where price stopped falling before; resistance is where it stopped rising.', how: 'Daily chart.', check: you },
      { id: 'daily-averages', label: 'Price is above the 20- and 50-day averages', help: 'Shows short and medium trend are both up.', how: 'Add 20 and 50 moving averages.', check: you },
      { id: 'daily-close', label: 'The signal candle has closed (not just touched the level)', help: 'Prices often poke above a level during the day and then fall back. Wait for the close.', how: 'Daily candle after 3:30 pm.', check: you, core: true },
      { id: 'daily-momentum', label: 'Momentum is not overheated (RSI not extremely high)', help: 'After a very big run, a pause or pullback is common.', how: 'RSI(14) on the daily chart; above about 80 is stretched.', check: you },
      { id: 'daily-candle', label: 'No warning candle (long upper wick, huge range after a big run)', help: 'A long upper wick shows sellers pushed the price down.', how: 'Look at the last few daily candles.', check: you },
      { id: 'daily-relative', label: 'Stock is stronger than Nifty over the last 1–3 months', help: 'Stocks that rise more than the market often keep doing so.', how: 'Compare the stock and Nifty charts.', check: you },
    ],
  },
  {
    id: 'volume', title: 'Volume and ease of buying and selling',
    why: 'Volume confirms a move. Liquidity decides if you can get out at a fair price.',
    items: [
      { id: 'volume-signal', label: 'Signal-day volume is above normal (e.g. 1.5× the 20-day average)', help: 'Big volume means many buyers agree with the move.', how: 'Volume bars with a 20-day average in Kite.', check: you, core: true },
      { id: 'volume-delivery', label: 'Delivery percentage is healthy', help: 'High delivery % means people bought to hold, not just to trade the same day.', how: 'NSE security-wise delivery data.', check: you },
      { id: 'volume-turnover', label: 'Daily traded value is large enough', help: 'If a stock trades only a few lakh rupees a day, getting out can be hard and costly.', how: 'Average daily turnover on NSE.', check: you, core: true },
      { id: 'volume-your-size', label: 'Your order is tiny compared with daily volume', help: 'Keep your shares well under 1% of the average daily volume.', how: 'Compare your shares with average volume.', check: you },
      { id: 'volume-spread', label: 'Buy/sell price gap (spread) is small and the order book is deep', help: 'A wide gap means you lose money the moment you buy.', how: 'Market depth in Kite.', check: you },
      { id: 'volume-bands', label: 'Price band (circuit limit) is not too tight', help: 'In a 5% band stock, a bad day can lock the price and stop you selling.', how: 'NSE price bands; Kite stock info.', check: you, core: true },
      { id: 'volume-surveillance', label: 'Stock is not under ASM/GSM surveillance or in F&O ban', help: 'Surveillance can mean higher margins and trading limits.', how: 'NSE surveillance lists; Kite shows a tag.', check: you, core: true },
    ],
  },
  {
    id: 'plan', title: 'Entry, stop, target and time',
    why: 'Decide everything before the trade. Decisions made in a hurry are usually worse.',
    items: [
      { id: 'plan-trigger', label: 'Exact buy trigger written (price and condition)', help: 'Example: “Buy only if it closes above ₹520 on volume above 1.5×”.', how: 'Write it in the plan’s reason box.', check: you, core: true },
      { id: 'plan-max-price', label: 'Highest price you will pay is set', help: 'If it opens far above, do not chase. A missed trade costs nothing.', how: 'Use a limit order at or below this price.', check: you, core: true },
      { id: 'plan-stop-structure', label: 'Stop is below a real level (demand zone or swing low)', help: 'A stop placed at a random number gets hit by normal noise.', how: 'Daily and weekly levels you marked.', check: you, core: true },
      { id: 'plan-stop-distance', label: 'Stop is not too far away', help: 'A very wide stop forces a tiny position or a big loss.', how: 'The app checks this.', check: rule('maxStopPct', 8), core: true },
      { id: 'plan-target', label: 'Target is before the next supply zone', help: 'Aim where sellers are likely to appear, not beyond them.', how: 'Zones you marked.', check: you, core: true },
      { id: 'plan-reward', label: 'Possible gain is at least 2× the possible loss, after charges', help: 'Then even winning only half your trades can still make money.', how: 'The app works this out.', check: rule('minRewardRisk', 2), core: true },
      { id: 'plan-time', label: 'Planned hold time is set', help: 'MTF interest runs every day. A trade that goes nowhere still costs money.', how: 'The app checks this.', check: rule('maxDays', 20), core: true },
      { id: 'plan-invalid', label: 'You wrote what would prove the idea wrong', help: 'Example: “If it closes back below ₹500, the breakout failed – exit”.', how: 'Write it in the reason box.', check: you, core: true },
      { id: 'plan-gap', label: 'You know what you will do if it opens far below your stop', help: 'Gaps can skip your stop. Decide now: exit at open, or another rule.', how: 'Your own rule.', check: you },
    ],
  },
  {
    id: 'money', title: 'Money, borrowing and risk',
    why: 'Even a good trade can hurt badly if it is too big or borrows too much.',
    items: [
      { id: 'money-mtf', label: 'Stock is MTF-eligible today and you know its leverage', help: 'Eligibility and leverage change. Check in Kite on the day.', how: 'Kite MTF stock list.', check: you },
      { id: 'money-interest', label: 'You know the daily interest cost for this trade', help: 'Example: ₹50,000 borrowed at 0.04% a day ≈ ₹20 every day, including holidays.', how: 'The app shows it on the request.', check: you },
      { id: 'money-spare', label: 'You keep spare cash for a margin call', help: 'If the price falls, Zerodha may ask for more money. Without it, shares can be sold for you.', how: 'Kite funds page.', check: you, core: true },
      { id: 'money-total', label: 'Total risk across all trades is within your limit', help: 'Many small risks can add up to one big one.', how: 'The app checks this.', check: you },
      { id: 'money-correlated', label: 'Open trades will not all fall together', help: 'Three trades in the same sector act like one big trade.', how: 'Positions page.', check: you },
      { id: 'money-regular-for-events', label: 'Regular (no borrowing) for event-driven trades', help: 'Around results or big news, borrowing magnifies surprises.', how: 'The app checks this when added.', check: rule('regularOnly', true) },
    ],
  },
  {
    id: 'order', title: 'The order itself and you',
    why: 'A good plan can still go wrong with a typo or a rushed mind.',
    items: [
      { id: 'order-details', label: 'Order matches the ticket: stock, exchange, Buy, MTF/CNC, shares, limit price', help: 'Read every field once before you press Buy.', how: 'Kite order window.', check: you, core: true },
      { id: 'order-duplicate', label: 'No duplicate or old pending order for this stock', help: 'Two orders by mistake means double the risk.', how: 'Kite orders page.', check: you },
      { id: 'order-protect', label: 'You will place the stop and target (GTT) right after the fill', help: 'A stop that is only in your head does not protect you.', how: 'Kite GTT.', check: you, core: true },
      { id: 'order-watch', label: 'You can watch the trade today', help: 'Do not enter just before a long meeting or travel.', how: 'Your day plan.', check: you },
      { id: 'mind-calm', label: 'You are calm and not chasing a loss or fear of missing out', help: 'Trades made to win back a loss are usually too big and too rushed.', how: 'Be honest with yourself.', check: you, core: true },
      { id: 'mind-rules', label: 'This trade follows your written rules, with no exceptions', help: '“Just this once” is how plans break.', how: 'Read your strategy checklist once more.', check: you, core: true },
    ],
  },
]);

/**
 * Two stages:
 *   research – done in the days before the trade; each strategy sets how many days it must wait
 *              (bufferDays) and how long it stays good (expireDays), within WINDOW
 *   before   – must be checked on the day, just before buying
 */
export const STAGES = Object.freeze({
  research: { title: 'Research (days before)', about: 'Do these calmly in the days before. Each strategy says how many days they must wait and how long they stay good.' },
  before: { title: 'Just before buying (today)', about: 'Check these on the day, right before you place the order.' },
});
/** Limits for a strategy’s research window, in India calendar days. */
export const WINDOW = Object.freeze({ minBuffer: 3, maxExpire: 21, defaultBuffer: 3, defaultExpire: 5 });

const RESEARCH_IDS = new Set([
  'currency-exposure', 'currency-debt', 'currency-rbi',
  'commodity-which',
  'macro-rbi', 'macro-inflation', 'macro-growth', 'macro-bond', 'macro-policy', 'macro-monsoon',
  'flows-deals', 'flows-holding',
  'sector-strength', 'sector-trend', 'sector-peers', 'sector-peer-results', 'sector-concentration',
  'fund-growth', 'fund-margins', 'fund-returns', 'fund-debt', 'fund-cash', 'fund-valuation', 'fund-promoter',
  'fund-governance', 'fund-dilution', 'fund-rating', 'fund-guidance', 'fund-orderbook',
  'events-results', 'events-actions', 'events-legal', 'events-index', 'events-holidays', 'events-economy',
  'zones-monthly-trend', 'zones-weekly-trend', 'zones-monthly-demand', 'zones-monthly-supply', 'zones-weekly-demand',
  'zones-weekly-supply', 'zones-entry-near-demand', 'zones-room-to-target', 'zones-52week', 'zones-weekly-averages', 'zones-gaps',
  'smc-htf-bias', 'smc-bos', 'smc-choch', 'smc-liquidity', 'smc-order-block', 'smc-fvg', 'smc-unmitigated', 'smc-htf-poi', 'smc-discount', 'smc-confluence', 'smc-target-liquidity',
  'daily-trend', 'daily-levels', 'daily-averages', 'daily-relative',
  'volume-delivery', 'volume-turnover',
  'plan-trigger', 'plan-max-price', 'plan-stop-structure', 'plan-stop-distance', 'plan-target', 'plan-reward', 'plan-time', 'plan-invalid', 'plan-gap',
  'money-regular-for-events',
]);

// Checks that rest on exchange data, so the owner can confirm them from the exchange.
const EXCHANGE_GROUPS = new Set(['zones', 'smc', 'daily', 'volume']);
const EXCHANGE_EVIDENCE = new Set(['quote', 'candles', 'zones']);
const EXCHANGE_IDS = new Set(['sector-peers']);

/** All sub-items with their group id, stage and exchangeBound flag, in order. */
export const LIBRARY_ITEMS = CHECKLIST_LIBRARY.flatMap((g) => g.items.map((i) => ({
  ...i, group: g.id, stage: RESEARCH_IDS.has(i.id) ? 'research' : 'before',
  exchangeBound: EXCHANGE_GROUPS.has(g.id) || EXCHANGE_IDS.has(i.id) || EXCHANGE_EVIDENCE.has(i.check.evidence),
})));

/** Turn a library sub-item into a strategy checklist item. */
export function toStrategyItem(libItem, { required = true } = {}) {
  const base = { id: libItem.id, group: libItem.group, stage: libItem.stage, label: libItem.label, help: libItem.help, required, exchangeBound: libItem.exchangeBound };
  if (libItem.check === 'you') return { ...base, type: 'attest' };
  if (libItem.check.evidence) return { ...base, type: 'evidence', kind: libItem.check.evidence, ...(libItem.check.maxAgeDays !== undefined ? { maxAgeDays: libItem.check.maxAgeDays } : {}), scope: libItem.check.scope };
  return { ...base, type: 'rule', rule: libItem.check.rule, value: libItem.check.value };
}

/** Groups with their sub-items’ group and stage filled in (what pages and agents receive). */
export const LIBRARY_GROUPS = CHECKLIST_LIBRARY.map((g) => ({ ...g, items: LIBRARY_ITEMS.filter((i) => i.group === g.id) }));

export const groupTitle = (id) => CHECKLIST_LIBRARY.find((g) => g.id === id)?.title ?? id;
