# Mandatory Prepare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Prepare a per-strategy cooling-off gate, turn evidence into a verified, correctable knowledge store, keep price-type data on one exchange, add desk and Claude recommendations, and remove the Research page.

**Architecture:** Two new pure modules hold the new logic: `src/core/knowledge.js` (record status, verify/correct/flag, which records count) and `src/core/prepare.js` (research windows, prepare marks, the gate, recommendations). `rules.js` calls them for every evidence and research check. New event types carry every new state change; old event types keep their reducers. The web app gets a rebuilt Prepare page and loses the Research page.

**Tech Stack:** Node 24 built-ins, `node:test`, `node:sqlite` store, ES-module browser app. No packages.

**Spec:** `docs/superpowers/specs/2026-10-24-mandatory-prepare-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Node 24 built-ins only. No npm packages, no paid APIs or data feeds, no database server.
- The desk never places, modifies or cancels broker orders.
- No MCP tool may approve, verify, correct, change agent access, edit strategies/playbooks/PIN, or delete or rewrite events.
- Events are immutable. Never edit or delete `events` rows. New meaning = new event type; old reducers stay. New fields are optional.
- Reducers are deterministic: ids, times, derived values are computed in commands and stored in the event.
- Window limits: `3 ≤ bufferDays ≤ expireDays ≤ 21`; defaults `bufferDays = 3`, `expireDays = 5`. Ages are in India days (`daysBetween(indiaDate(markMs), indiaDate(now))`).
- Quote freshness stays 5 minutes; MTF requirement stays today-only; news for the built-in `news` check stays current India date.
- Every evidence check counts only on an owner-entered or owner-verified record that is live (not trashed, not corrected) and whose `goodUntil` (India date) is on or after today.
- Exchange-bound records/marks count only for the same exchange (`'NSE'` or `'BSE'`).
- Plain-language UI text: rupees, India time, examples. No inline script or style in `web/`.
- Bump `API_VERSION` in `src/version.js` and `CLIENT_API` in `web/app.js` together, 3 → 4.
- Never read the real data folder, `desk.sqlite`, keys or the PIN. Tests use `:memory:` or temp folders.
- Verify with `npm test`, `node --check web/app.js`, and for UI tasks `npm run test:browser` plus looking at its screenshots.

## Review Focus

1. **Request expires during the wait.** Requests live at most 72 h (`FIXED.maxIntentHours`). A request sent on day 0 with buffer 3 can never be approved. Expected: the request page and `get_request` say "This request expires on … before research is ready on …; send a new one from <date>". Test in Task 4.
2. **India-date boundary.** A mark made at 23:50 IST is day 0 for that date; at 00:10 IST next day it is 1 day old. Expected: ages follow India dates, not 24-hour periods. Test in Task 3.
3. **Exchange mismatch.** NSE quote or NSE zone mark with a BSE plan. Expected: the check is `stale` and the detail names both exchanges ("You have an NSE price; this plan is on BSE"). Test in Task 4.
4. **Referenced record trashed or corrected after the mark.** Expected: the evidence research item stops counting and says why ("The record you used was corrected on …; prepare it again"). Test in Task 3.
5. **Verifying a stale or already-corrected record.** Verifying a record with `goodUntil` before today, or one that has been corrected, is refused with a plain message. Test in Task 2.

---

### Task 1: Strategy windows, exchange flag and the research rule

**Files:**
- Modify: `src/core/checklist-library.js` (STAGES text, `RESEARCH_VALID_DAYS` replaced, `exchangeBound` on items, research-stage `ev()` loses `maxAgeDays`, `toStrategyItem`)
- Modify: `src/core/strategies.js` (validation, built-ins version bump, header comment)
- Test: `tests/checklist.test.js`

**Interfaces:**
- Produces:
  - `WINDOW = { minBuffer: 3, maxExpire: 21, defaultBuffer: 3, defaultExpire: 5 }` exported from `checklist-library.js`.
  - `strategyWindow(strategy) -> { bufferDays: number, expireDays: number }` in `strategies.js`; missing fields fall back to defaults (old saved strategies).
  - `isExchangeBound(item) -> boolean` in `strategies.js`: `item.exchangeBound ?? LIBRARY default for item.id ?? false`.
  - `hasRequiredResearch(strategy) -> boolean`: at least one item with `stage === 'research'`, `required`, `type` attest or evidence.
  - `LIBRARY_ITEMS[i].exchangeBound: boolean`. Default true for groups `zones`, `daily`, `volume`, for evidence kinds `quote`, `candles`, `zones`, and for `sector-peers`. False otherwise.
  - Strategy shape gains `bufferDays`, `expireDays`; items gain `exchangeBound`; research-stage evidence items have no `maxAgeDays`.

- [ ] **Step 1: Write failing tests** in `tests/checklist.test.js`:
  - `window limits are enforced`: `validateStrategy` with `bufferDays: 2` throws `/at least 3/`; `expireDays: 22` throws `/at most 21/`; `bufferDays: 6, expireDays: 5` throws `/expire.*at least.*buffer/i`; `bufferDays: 3, expireDays: 3` passes; missing both gives `bufferDays 3, expireDays 5`.
  - `a strategy needs a required research item`: items all `stage: 'before'` throws `/required research item/`; one optional research attest throws; one required research rule throws; one required research attest passes.
  - `exchange-bound defaults`: `LIBRARY_ITEMS` ids `zones-weekly-demand`, `daily-trend`, `volume-delivery`, `sector-peers` are `exchangeBound: true`; `sector-strength`, `sector-trend`, `fund-promoter`, `events-news` are false.
  - `research evidence has no age limit`: every built-in item with `stage === 'research' && type === 'evidence'` has no `maxAgeDays`; `validateStrategy` drops `maxAgeDays` on such items and still requires it (0–400) on `before` evidence items.
  - `built-ins validate and were bumped`: every `BUILTIN_STRATEGIES` entry passes `validateStrategy`, `hasRequiredResearch` is true, `breakout/pullback/results` are version 3 and `complete` version 2.
  - `old saved strategy falls back`: `strategyWindow({ items: [] })` deep-equals `{ bufferDays: 3, expireDays: 5 }`; `isExchangeBound({ id: 'daily-trend' })` is true.

- [ ] **Step 2: Run** `node --test tests/checklist.test.js`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** Error copy: "Buffer must be at least 3 days.", "Expire must be at most 21 days.", "Expire days must be at least the buffer days.", "Add at least one required research item that you can prepare days ahead (a “you answer” or evidence item, not a plan rule)." STAGES text becomes "Research (days before)" / "Do these calmly in the days before. Each strategy says how many days they must wait and how long they stay good." Remove `RESEARCH_VALID_DAYS`; fix its importers in Task 3 (until then `rules.js` imports `WINDOW.defaultExpire`). If After-results momentum fails `hasRequiredResearch`, add required research items from the library to it.

- [ ] **Step 4: Run** `node --test tests/checklist.test.js`. Expected: new tests PASS. Older tests in this file that use the 5-day behaviour may fail; they are rewritten in Task 3.

- [ ] **Step 5: Commit** `feat: per-strategy research window, exchange flag and required-research rule`.

### Task 2: Knowledge store records

**Files:**
- Create: `src/core/knowledge.js`
- Modify: `src/core/commands.js` (`addEvidence`, new `verifyEvidence`, `correctEvidence`, `flagEvidence`), `src/core/state.js` (reducers), `src/core/evidence.js` (kind metadata)
- Test: `tests/knowledge.test.js` (new)

**Interfaces:**
- Consumes: `isExchangeBound`-style kind set from Task 1 (`EXCHANGE_KINDS = new Set(['quote','candles','zones'])` lives in `evidence.js`).
- Produces:
  - `evidence.added` data gains optional `topic` (checklist item id), `exchange` (required for `EXCHANGE_KINDS`), `goodUntil` (India date, owner records only), `verdict` (`'good' | 'bad'`, optional).
  - New events: `evidence.verified { id, goodUntil }` (owner), `evidence.corrected { id: newId, corrects: oldId, reason, ...record fields }` (owner), `evidence.flagged { id, reason }` (agent or owner).
  - Reducer-maintained record fields: `verifiedAt`, `goodUntil`, `correctedBy`, `correctedAt`, `flags: [{ by, at, reason }]`.
  - `recordStatus(e, today) -> 'found' | 'verified' | 'expired' | 'corrected' | 'trashed'`.
  - `counts(e, today) -> boolean` (status `verified`).
  - `latestCounting(state, { kind, symbol, topic?, exchange?, today }) -> record | null`, newest first; when `exchange` is given, records of other exchanges are skipped.
  - `suggestGoodUntil(kind, observedDate, nextResultsDate?) -> 'YYYY-MM-DD'` (spec call 7: candles/zones/volume readings +5 days, fundamentals = next results date else +90, governance/legal/other +90, macro +7, news +0, quote/funding +0).
  - Commands: `verifyEvidence(state, { id, goodUntil }, ctx)`, `correctEvidence(state, { corrects, reason, ...fields }, ctx)`, `flagEvidence(state, { id, reason }, ctx)`.

- [ ] **Step 1: Write failing tests** in `tests/knowledge.test.js` (use `desk()` from `tests/helpers.js`):
  - `agent records are found, not counting`: agent `addEvidence` news → `recordStatus` is `found`, `counts` false.
  - `owner records count until goodUntil`: owner adds fundamentals with `goodUntil` 10 days ahead → counts today; after `clock.now += 11 days` status `expired`.
  - `owner verifies an agent record`: owner `verifyEvidence` → status `verified`, `verifiedAt` equals the clock time.
  - `only the owner verifies or corrects`: agent `verifyEvidence` / `correctEvidence` throw `/Only the owner/`.
  - `correction keeps history`: owner corrects a verified record with reason "wrong quarter" → old status `corrected`, old record still in `state.evidence`, new record counts and has `corrects` = old id.
  - `exchange is required on price-type kinds only`: `candles` without `exchange` throws `/NSE or BSE/`; `news` with `exchange` stores none.
  - `latestCounting respects exchange`: NSE candles verified; `latestCounting({ kind: 'candles', exchange: 'BSE' })` is null.
  - `agents can flag; a flag changes nothing`: agent flags a verified record → `flags.length === 1`, status still `verified`.
  - Review Focus 5: verifying a record with `goodUntil` before today throws `/good-until/i`; verifying or correcting a `corrected` record throws `/already corrected/`.
  - `goodUntil must not be before the record date` throws.

- [ ] **Step 2: Run** `node --test tests/knowledge.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement.** Owner-entered `addEvidence` for non-quote/funding kinds requires `goodUntil` (default `suggestGoodUntil`). Quote/funding keep the existing `confirms` path (a new owner record timed now) and get `goodUntil` = today. Old `evidence.added` rows without `goodUntil` are status `found` even if owner-entered. Add the three new types to `reducers` in `state.js`; add `evidence.flagged` to `WRITE_TYPES`.

- [ ] **Step 4: Run** `node --test tests/knowledge.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: verified, correctable evidence records with good-until and exchange`.

### Task 3: Prepare marks and the research gate

**Files:**
- Create: `src/core/prepare.js`
- Modify: `src/core/commands.js` (new `markPrepared`; `saveResearch` stays but is no longer routed), `src/core/state.js` (`prepared: {}` in `initialState`, reducer), `src/core/rules.js` (`itemCheck`, `researchFor` removed, `researchStatus` rewritten)
- Test: `tests/prepare.test.js` (new), rewrite research tests in `tests/checklist.test.js`

**Interfaces:**
- Consumes: Task 1 `strategyWindow`, `isExchangeBound`; Task 2 `counts`, `latestCounting`, `recordStatus`.
- Produces:
  - `markKey(strategy, item) -> string`: library ids → `item.id`; strategy-own ids → `${strategy.id}:${item.id}`.
  - Event `prepare.marked { symbol, key, exchange?, evidenceId?, yes }`; state `prepared[`${symbol}|${key}|${exchange ?? ''}`] = { at, evidenceId? }`; `yes: false` deletes.
  - `markPrepared(state, { symbol, strategyId?, itemId, exchange, evidenceId?, yes }, ctx)`: owner only; item must be research-stage; evidence items need `evidenceId` of a record that `counts` and matches symbol (or `MARKET` for market scope), kind and exchange; exchange-bound items need `exchange`.
  - `researchItemState(state, strategy, item, symbol, exchange, now) -> { status: 'pass'|'wait'|'expired'|'missing'|'broken', detail, validFrom?, expiresOn? }`. `wait` = age < buffer; `expired` = age > expire; `broken` = referenced record no longer counts.
  - `researchStatus(state, symbol, strategyId, exchange, now)` returns `{ strategyId, strategyName, version, symbol, exchange, window, checks, researchDone, readyOn }` where `readyOn` is the earliest India date all required research items pass (null if any is missing).
  - `masterStatus(state, symbol, exchange, now)`: the whole `LIBRARY_ITEMS` list through the same functions, using the default window.
  - Check status `'wait'` is new; `finish()` already treats non-`pass` required checks as not ready.

- [ ] **Step 1: Write failing tests** in `tests/prepare.test.js`:
  - `nothing counts before buffer days`: mark every required research attest of `breakout` on day 0; evaluate a request with all on-the-day answers on day 2 → those items `wait`, `ready` false, detail contains the India date of day 3.
  - `counts from buffer to expire, then expires`: same marks → day 3 `pass`, day 5 `pass`, day 6 `expired`.
  - `per-strategy window`: strategy saved with `bufferDays: 4, expireDays: 10` → day 3 `wait`, day 10 `pass`, day 11 `expired`.
  - `request-page answers no longer satisfy research items`: `evaluate(..., answers)` with a research item ticked → still `missing`.
  - `evidence research items need a verified record and a mark`: an owner-verified record alone → `missing`; marked on day 0 → day 3 `pass`.
  - `marks are shared across strategies`: marking `fund-promoter` once passes it for `breakout` and `pullback`.
  - `exchange-bound marks stay on their exchange`: `zones-weekly-trend` marked on NSE → BSE `researchStatus` shows `missing`.
  - Review Focus 4: correcting or trashing the record behind a mark → `broken` with detail `/corrected|Trash/`.
  - Review Focus 2: mark at 23:50 IST, check at 00:10 IST next day → age 1; 3 India days later `pass` even if fewer than 72 hours.
  - `agents cannot mark`: agent `markPrepared` throws `/Only the owner/`.
  - `strategy without required research blocks approval`: a stored strategy (inject a `strategy.saved` event directly through `store.run` with a hand-built strategy) with no required research → check `strategy-research` `fail` with "This strategy has no required research items. Edit it first."

- [ ] **Step 2: Run** `node --test tests/prepare.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** Research items in `itemCheck` go through `researchItemState`; `ctx.answers` apply only to `before` attest items. On-the-day evidence items use `latestCounting` with `maxAgeDays` against `observedAt`, plus `exchange: plan.exchange` when exchange-bound. Rewrite the old research tests in `checklist.test.js` to the new behaviour; delete none of their intent.

- [ ] **Step 4: Run** `npm test`. Expected: `prepare.test.js` and `checklist.test.js` PASS. `requests.test.js` and others may fail until Task 4 updates `tests/helpers.js`.

- [ ] **Step 5: Commit** `feat: per-item prepare marks and the cooling-off research gate`.

### Task 4: Buy checks use verified, same-exchange records

**Files:**
- Modify: `src/core/rules.js` (`evaluateBuy` quote/news/funding/evidence items, expiry-before-ready check), `src/core/views.js` (`intentView` exposes `readyOn`)
- Modify: `tests/helpers.js` (`readyEvidence` → owner-verified records with `exchange` and `goodUntil`; new `prepareAll(d, symbol, strategyId, exchange)` marking every required research item, then `d.clock.now += 3 days`)
- Test: `tests/requests.test.js`, `tests/mcp.test.js`, `tests/automation.test.js` updated

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: `evaluateBuy` checks `quote` and `funding` filter by `plan.exchange` (funding is not exchange-bound); `news` needs a counting record from today; check `research-timing` (`info` when fine, `fail` when `Date.parse(intent.expiresAt)` is before `readyOn`).

- [ ] **Step 1: Write failing tests** in `tests/requests.test.js`:
  - `agent evidence alone never passes an evidence check`: agent news today, no owner verification → `news` `stale`.
  - Review Focus 3: owner NSE quote, BSE plan → `quote` `stale`, detail `/NSE.*BSE/`.
  - Review Focus 1: request submitted on day 0 with 24 h expiry and research marked day 0 → `research-timing` `fail`, detail contains the expiry date and the ready date.
  - `full happy path`: `prepareAll` + `readyEvidence` + on-the-day answers → `ready` true and `approveIntent` succeeds.

- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement**, then update the existing tests and helpers so they prepare, wait and verify instead of relying on agent evidence and same-day research.

- [ ] **Step 4: Run** `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit** `feat: buy checks use owner-verified records on the plan's exchange`.

### Task 5: Recommendations

**Files:**
- Modify: `src/core/prepare.js` (`deskRecommendation`), `src/core/commands.js` (`addRecommendation`), `src/core/state.js` (`recommendations: []`, reducer)
- Test: `tests/prepare.test.js`

**Interfaces:**
- Consumes: Task 3 `researchStatus`, `masterStatus`; Task 2 `latestCounting`.
- Produces:
  - `deskRecommendation(state, symbol, exchange, now) -> { call: 'wait'|'buy'|'hold'|'sell', reasons: string[], strategies: [{ id, name, fits: boolean, missing: string[] }], recheck: string[] }`.
  - Rules (spec "Recommendations" + call 11). With an open lot in `symbol` on `exchange`: `sell` if any of (a) a record referenced by a mark for this symbol, or by an `item:` check id in the lot's `intent.decision.checks`, is now `corrected`; (b) a newer counting record for the same symbol and topic has `verdict: 'bad'`; (c) latest counting quote ≤ `stop + 0.25 × (entry − stop)`; (d) India today > lot `date` + `plannedDays`. Else `hold`; expired items go into `recheck`. Without an open lot: `buy` if master core research items pass and at least one enabled strategy has `researchDone` and `readyOn ≤ today`; else `wait`, with reasons naming what is missing or the `readyOn` date.
  - Event `recommendation.added { id, symbol, exchange, call, strategyIds, reasons, sources }` (agent or owner); `addRecommendation(state, input, ctx)`; `latestRecommendation(state, symbol, exchange) -> record | null`, newest agent one.
  - Recommendations are written into `WRITE_TYPES`.

- [ ] **Step 1: Write failing tests**: `wait during buffer` (reason contains the ready date); `buy when ready`; `hold with an open lot`; `sell near stop` (owner quote 96.2 with entry 100, stop 95 → sell, because 96.25 is the line); `sell after hold days`; `expired research on a held stock is recheck, not sell`; `agent recommendation is stored with exchange and is not the desk call`; `call outside wait/buy/hold/sell throws`.

- [ ] **Step 2: Run** `node --test tests/prepare.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: desk and agent wait/buy/hold/sell recommendations`.

### Task 6: MCP tools and owner web actions

**Files:**
- Modify: `src/mcp/tools.js`, `src/http/server.js` (actions table, `stateView`), `src/version.js` (`API_VERSION = 4`)
- Modify: `docs/MCP.md`
- Test: `tests/mcp.test.js`, `tests/http.test.js`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - MCP: `add_evidence` gains `topic`, `exchange`, `verdict` (and refuses `goodUntil`/`confirms`); `list_evidence` gains filters `symbol`, `topic`, `exchange`, `status` and returns `status` per record; `get_research_status` gains `exchange` and returns the new shape; new `flag_evidence` (level `draft`, write) and `add_recommendation` (level `draft`, write); new `get_recommendation` (level `read`) returning desk and latest agent view. Descriptions tell agents to read verified records before searching the web, and that only the owner verifies.
  - Web actions: `evidence.verify` (no PIN), `evidence.correct` (no PIN), `evidence.flag`, `prepare.mark` (no PIN), `prepare.status` → `{ master, strategies: researchStatus[], desk, agent }`. Remove `research.save` and `research.status` routes.
  - `stateView` sends `evidence` with `status`, `recommendations`, and `meta.checklist.window = WINDOW` (no `researchValidDays`).

- [ ] **Step 1: Write failing tests**: `agents cannot verify, correct or mark` (no MCP tool named `verify`/`correct`/`mark`, and `add_evidence` with `confirms` or `goodUntil` ignores them); `flag_evidence and add_recommendation need draft access and count writes`; `list_evidence status filter returns only verified`; HTTP `prepare.mark` works with CSRF and Origin checks like `research.save` did.

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement**, and update `docs/MCP.md` (tool list, "read the store first", verify is owner-only).

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: MCP and web actions for records, prepare marks and recommendations`.

### Task 7: Web app — remove Research, rebuild Prepare, update request, Today, stock and strategy pages

**Files:**
- Modify: `web/app.js`, `web/index.html`, `web/info.js`, `web/style.css`
- Modify: `scripts/browser-check.mjs`
- Modify: `README.md`, `docs/SETUP.md`

**Interfaces:**
- Consumes: Task 6 `prepare.status`, `prepare.mark`, `evidence.verify`, `evidence.correct`, `stateView` fields.
- Produces: `CLIENT_API = 4`.

- [ ] **Step 1: Update `scripts/browser-check.mjs` first** so it fails against the current page:
  - Seed the temp database before starting the server: `new Store(path, { clock: () => threeDaysAgo })`, then mark every required research item of `breakout` for `SAMPLE` on NSE and add owner-verified records. Do not add any server flag that shifts time.
  - Assert the sidebar has no Research link and `#/research` lands on Stocks.
  - On Prepare: exchange selector exists; the master list and the per-strategy list both render; desk and Claude recommendation cards are side by side, with "The desk and Claude disagree" when the seeded agent call differs; the BSE chart note shows when the exchange is NSE.
  - On the request page: research items show "Prepared on …" and have no checkboxes; an agent record shows a Verify button.
  - Keep the existing 390 px overflow, keyboard focus and console-error checks for every page, with `#/research` removed from the page list.

- [ ] **Step 2: Run** `npm run test:browser`. Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**, following the spec's "Removing the Research page" table and sidebar order (Today, Stocks, Prepare, New plan, Requests, Positions, then the rest):
  - Prepare: stock + exchange (default NSE) picker. Master list by group with each research item's state (`pass`/`wait` with "counts from <date>"/`expired`/`missing`/`broken`); a Mark button for attest items; for evidence items the counting records with a "Use this verified record" button, Verify buttons on found records, and an inline add-evidence form (exchange field for price-type kinds, good-until prefilled with the suggestion). Then each enabled strategy: window, fit, missing items, `readyOn`. Then the two recommendation cards side by side.
  - Request page: research items read-only with their state; on-the-day attest items keep checkboxes; Verify buttons next to agent records; `research-timing` shown when it fails.
  - Today: "New from Claude" card (agent records with Verify, agent recommendations, flags); replace the "Add broker price" button with a stock picker.
  - Stock page: records with status tags, Verify, Correct (a form with reason and corrected fields), flags; recommendation summary.
  - Strategy editor: Buffer days and Expire days fields (3–21) with help text and an example ("Buffer 3, expire 5: research ticked on Monday counts Thursday to Saturday"); an "Uses one exchange's prices" checkbox per item; no freshness field for research-stage evidence items.
  - Field help in `web/info.js` for buffer, expire, good-until, exchange, verify, correct and flag.
  - Replace every "1–5 days" text; reword Prepare's "(Research page)" line.

- [ ] **Step 4: Run** `node --check web/app.js`, `npm test`, `npm run test:browser`. Expected: all PASS. Look at every screenshot, including 390 px.

- [ ] **Step 5: Update README.md and docs/SETUP.md** (flow, Prepare now mandatory with buffer/expire, no Research page).

- [ ] **Step 6: Commit** `feat: mandatory Prepare page, records and recommendations in the web app`.
