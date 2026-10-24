# Mandatory Prepare, verified knowledge store and single-exchange data

Date: 2026-10-24 · Status: ready for owner approval

## Intent

Swing Desk exists to make the owner trade in a structured way instead of reacting to price
moves. Today the Prepare (research) step is optional in practice: research-stage checklist
items can be ticked on the request page at approval time, and research saved today counts
today. That leaves the FOMO path open: see a move, send a request, tick everything, approve.

This change makes Prepare a real cooling-off gate, turns gathered information into a reusable
verified store so the same facts are not searched for again, keeps all price-type analysis on
one exchange at a time, and gives the owner a wait/buy/hold/sell view for each stock, from the
desk's rules and from Claude, side by side.

## Goals

1. No buy can be approved unless every research-stage item of the request's strategy was
   prepared between *buffer* and *expire* India days before the approval.
2. Prepare is the single place where research happens. The dedicated Research page goes away.
3. Prepare runs one comprehensive master checklist (the existing library: 15 groups, 107
   sub-items, in `src/core/checklist-library.js`) for every stock as the general analysis, then
   evaluates each enabled strategy's own checklist on top and lists which strategies fit.
4. Prepare shows two recommendations side by side: the desk's (fixed rules) and Claude's (its
   own analysis, marked not verified). Disagreement is flagged; the desk never picks a winner.
5. Information becomes structured records. Once the owner verifies a record, it is reused until
   its own *good until* date. Records can be corrected without erasing history.
6. Price-type data records its exchange, and every check and analysis uses only records from
   the one exchange being prepared or planned.

## Non-goals

- No change to fees, sizing, the 5-minute quote rule or the today-only MTF rule.
- No new data feeds, paid APIs or scraping by the desk. Claude still gathers; the desk
  validates, records and gates.
- No change to how lots, fills and sales are recorded.

## Anti-goals (a failure even if it works)

- Any path that lets a buy be approved without the cooling-off wait, including re-using old
  verified facts so the wait is skipped (see "Two clocks" below).
- The desk presenting its recommendation as advice, or auto-acting on either recommendation.
- An agent able to verify, correct, approve, change windows, or edit strategies.
- Silently mixing NSE and BSE prices in one analysis.
- Editing or deleting rows in `events`.

## Constraints (from AGENTS.md, unchanged)

Node 24 built-ins only; free and open source; the desk never touches broker orders; no MCP tool
may approve, change agent access, edit strategies/playbooks/PIN, or rewrite events; reducers
deterministic (ids, times, derived values computed in commands); events immutable, new event
types rather than changed meanings, new optional fields only; strategy rules only add
restrictions and saving a strategy bumps its version; plain-language UI (rupees, India time,
borrowed money); bump `API_VERSION` in `src/version.js` and `CLIENT_API` in `web/app.js`
together; never read the real data folder.

## Decisions made by the owner

### Research window per strategy

- Each strategy has two numbers:
  - **buffer days**: how long a prepared item must age before it counts. Minimum **3** for
    every strategy.
  - **expire days**: how long it keeps counting. Maximum **21** for every strategy.
  - `3 ≤ buffer ≤ expire ≤ 21`. Defaults: buffer 3, expire 5. Buffer equal to expire is
    allowed (a one-day buy window).
- An item counts on a given India day only if its age in India days is `≥ buffer` and
  `≤ expire`. Older than expire: it has expired and must be prepared again.
- **The clock starts per item, when that item is ticked (attest) or validated (evidence) in
  Prepare.** Each item has its own clock.
- **Evidence-type research items need the wait too.** They count only after the owner
  validates them in Prepare; the clock starts at that validation.
- Changing buffer/expire is a strategy save (PIN, version bump, pending requests on the old
  version become unapprovable), like any other strategy edit.

### Every evidence check needs owner-verified records

Owner chose "safer, more clicks". Every evidence-type checklist item, research-stage *and*
"just before buying" (news today, Nifty trend, VIX, global markets, USDINR, daily pattern …),
counts only on a record the owner entered or verified. Claude's finds are shown with a
one-click **verify** button (on Today, Prepare and the request page), exactly like price and
MTF confirmation today. Verifying is an owner record timed at verification.

### No strategy without required research

Saving a strategy is refused unless it has at least one **required** research-stage item that
can be prepared ahead (not a plan rule). The built-in strategies that fall short (After-results
momentum) gain required research items in their new version. A strategy already saved without
one cannot have buys approved: the request page says "This strategy has no required research
items. Edit it first." (designer's call for already-saved strategies).

### Requests during the wait

A buy request can be sent at any time, by Claude or the owner, and waits in Requests. The
request page shows a Prepare check listing each research item's state ("valid from 27 Oct",
"not prepared", "expired on …"). Approve is blocked until every required research item is in its
window. The request page no longer accepts ticks for research-stage items; it only accepts
"just before buying" items.

### Recommendations

- Desk and Claude, side by side, in Prepare (and summarised on the stock page).
- Values: **wait, buy, hold, sell**, plus the list of suitable strategies.
- Desk rules (owner agreed to this outline):
  - **wait**: research not finished, a required item failing, or inside the buffer period.
  - **buy**: every required master-list and strategy research item passes, inside the buy window,
    at least one strategy fits.
  - **hold**: the owner has an open lot in this stock and nothing has turned bad.
  - **sell**: the owner has an open lot and something has turned bad: a required item now fails
    (corrected record, expired good-until), the latest owner price is at or near the stop, or the
    planned hold time has run out.
- Claude's recommendation is a new agent record: stock, exchange, call, suitable strategy ids,
  reasons, source links, time. Shown with "Written by a model · not verified".
- When the two differ, both are shown with a clear "The desk and Claude disagree" marker.

### Verified knowledge store

- Every piece of information is a structured record: stock (or `MARKET`); topic = the checklist
  item id it answers; a value in a fixed shape for its kind; summary; source links; who found it
  and when; exchange (price-type only); **good until** date; status.
- Status lifecycle: **found → verified (owner only) → corrected/replaced**.
- **Each verified record carries its own good-until date** (e.g. the next results date for
  quarterly figures). A record counts only up to and including its good-until India date.
- Claude reads the store first and searches the web only for topics with no current verified
  record. MCP tools/instructions must say so.
- Corrections never erase: a correction is a new record pointing at the old one with a reason.
  The old one shows as "corrected", stays in history and stops counting. Only the owner can
  verify or correct. Claude may **flag** a verified record as possibly wrong, with a reason; a
  flag changes nothing by itself but surfaces the record to the owner (Today and the stock page).

### Exchange

- Exchange (NSE or BSE) is required on price-type records only: broker price (`quote`), chart
  readings (`candles`), volume and delivery. News, results, fundamentals, macro and other
  company facts are exchange-free.
- Prepare is done for one exchange at a time (a selector, default NSE). Price-type items are
  evaluated only against records of that exchange; a plan's checks use only records matching
  `plan.exchange`. Research ticks/validations of price-type items are tied to the exchange they
  were made on and do not count for the other.

### Removing the Research page

| Research page part | New home |
|---|---|
| Other evidence form | Prepare, inline under each research item that needs evidence (stock or `MARKET`) |
| Evidence and notes for one stock | Prepare (this stock's items) and the stock page (full history) |
| Whole-market evidence | Prepare, inline under market-wide items |
| Broker price and MTF forms | Request page (already there when failing) and stock page |
| Cross-stock feed of agent evidence/notes | Today: "New from Claude" card with verify/confirm buttons, plus flagged records |

Also: Today's "Add broker price" button (links `#/research`) is replaced by a stock picker or
removed; Prepare's help text that mentions the Research page is reworded; `#/research`
redirects to `#/stocks`; the sidebar loses Research and is ordered Today, Stocks, Prepare,
New plan, Requests, Positions, then the rest. All "1–5 days" wording becomes the strategy's
actual window.

## Calls made by the designer (owner may override)

1. **Two clocks, never merged.** A verified record's good-until says whether the *fact* is
   still true. The research item's buffer/expire clock says whether the owner *prepared this
   stock* recently enough. Re-using a verified record in Prepare is one click ("use this
   verified record"), which starts that item's clock. So re-use saves the web search but never
   skips the cooling-off wait. An evidence research item passes only if its validation is
   inside the window **and** the referenced record is still verified, not corrected, and within
   good-until on the approval day.
2. **Ticks are shared across strategies.** A research tick/validation is stored per stock +
   checklist item (+ exchange for price-type items), not per strategy, and each strategy applies
   its own buffer/expire to the same tick. Strategy-own items (ids not in the library) are keyed
   per strategy. Ticking "promoter holding is fine" once serves every strategy.
3. **Correction resets dependent ticks.** When a record is corrected, any validation that
   referenced it stops counting and must be redone (new clock).
4. **Master-list items outside a strategy do not gate approval**; they feed the desk
   recommendation and are shown in Prepare. Only the request's strategy items gate approval.
   The master list uses the default window (3/5) for its own display.
5. **Old data.** Existing `evidence.added` events have no exchange, status or good-until; they
   show as "found, not verified" and do not satisfy research items until verified (owner) under
   the new flow. Existing `research.answered` events keep their reducer but do not satisfy the
   new gate. New behaviour uses new event types.
6. **TradingView chart** stays reference-only (it can only show BSE). When preparing on NSE it
   carries a visible note that it shows BSE prices and nothing on it counts.
7. Good-until defaults suggested when verifying (owner can change): chart/volume/delivery
   readings = record date + expire days of the default window; quarterly fundamentals = next
   results date if known, else 90 days; one-off facts (governance, legal) = 90 days; macro = 7
   days. Must be on or after the record's date.

8. **Only required research items gate approval.** Optional research items are shown and can
   be prepared, but never block. (Goal 1 means "every required research-stage item".)
9. **Research-stage evidence items drop `maxAgeDays`.** For them, freshness is the research
   window plus the record's good-until; `maxAgeDays` applies only to "just before buying"
   evidence items. The strategy editor hides `maxAgeDays` for research-stage evidence items,
   the library's research-stage `ev(kind, maxAgeDays)` entries keep the kind only, and the
   built-in strategies are bumped to a new version.
10. **Price-type = a per-item `exchangeBound` flag in the library and editor.** Library
    defaults: every item in the `zones`, `daily` and `volume` groups, and every evidence item
    of kind `quote`, `candles` or `zones`, plus `sector-peers` (compares stock charts; owner
    confirmed). Sector-index comparisons (`sector-strength`, `sector-trend`) are not
    exchange-bound. Owner confirmed no other item is misplaced.
    Exchange-bound ticks and validations are keyed with their exchange.
11. **Hold and sell use the lot's own strategy (the version it was approved on) plus the
    master list's core items.** "Turned bad" means only: a referenced record was corrected, a
    new owner record contradicts the earlier verdict, the latest owner price is at or below
    stop + 25% of the entry-to-stop distance, or the planned hold days have passed. An expired
    tick or passed good-until shows as **needs re-check**, not sell.

## Left to the builder

Event type names and shapes; the record value shapes per kind; exact MCP tool names and access
levels (verify/correct are owner-only web actions; flag and recommendation are agent writes that
count against the write quota); the Prepare page layout; how "near the stop" is measured for
the sell rule (state it in the UI); test structure (pin the window maths, exchange isolation,
correction reset and the no-skip guarantee with tests); keeping `docs/MCP.md`, `docs/SETUP.md`
and `README.md` in step.
