# Structured Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five structured note sections (SWOT, Overview, Quarterly results, Shareholding, Peers) that the owner or Claude pastes as text, the desk parses and tabulates with worked-out figures, shown on Prepare and the stock page. Notes are corrected by saving a new version, never verified.

**Architecture:** A pure module `src/core/sections.js` parses, formats and derives. One new event `note.structured` stores records in `state.notes`. HTTP actions and an MCP tool expose it. The web gets a Snapshot area with paste boxes.

**Tech Stack:** Node 24 built-ins, `node:test`, ES-module browser app. No packages.

**Spec:** `docs/superpowers/specs/2026-10-25-structured-notes-design.md`. Read it first. It holds the exact shapes, label dictionary, derived figures and test fixtures.

## Global Constraints

- Node 24 built-ins only. No npm packages, no web fetching, no AI parsing.
- Events are immutable: add the new event type `note.structured`, leave `note.added` and its reducer unchanged. Reducers are deterministic (ids, `revises`, `asOf`, derived values come from the command).
- No MCP tool may approve, verify, correct evidence, change access, edit strategies/playbooks/PIN, or delete/rewrite events. Agents never see trashed or purged records.
- Notes are never verified; nothing here affects approval checks, evidence, sizing or checklist items.
- `exchange` (NSE or BSE) is required for `overview` and `peers`, absent for other sections. `asOf` is an India date, default today, not in the future.
- Section names: `swot`, `overview`, `results`, `shareholding`, `peers`. Limits: pasted text ≤ 20,000 characters; SWOT bullet ≤ 300 characters, ≤ 20 per list; grids ≤ 40 rows × 12 columns.
- Plain-language UI text with examples. No inline script or style in `web/`.
- Bump `API_VERSION` (src/version.js) and `CLIENT_API` (web/app.js) together, 4 → 5, in the web task.
- Never read the real data folder, `desk.sqlite`, agent keys or the PIN.
- Verify with `npm test`, `node --check web/app.js`, and for UI work `npm run test:browser` plus looking at its screenshots.

## Review Focus

1. **Messy paste.** Windows line endings, trailing spaces, blank lines, a label with no value, a value line that is another label, duplicate labels. Expected: no crash, a warning for each line not read, the rest still parsed. Test in Task 1.
2. **Revise races.** Saving the same section twice, then trashing the current one. Expected: exactly one current record; after trashing the current, the previous version is not silently current again (the section shows empty). Test in Task 1.
3. **Agent trust.** An agent saves a section with HTML in a bullet or label. Expected: stored as text, escaped on every web render, and an agent cannot see trashed or purged sections. Tests in Tasks 2 and 3.
4. **Exchange mixing.** An NSE Overview and a BSE Overview for one stock. Expected: independent current records; the Prepare page shows the one for the chosen exchange. Test in Task 2.
5. **Big or odd numbers.** Overview with `1,89,89,022`, negative values, `%` and `₹` signs, empty cells in grids. Expected: numbers or null, never NaN. Test in Task 1.

---

### Task 1: Parser, formatter, worked-out figures, event and reducer

**Files:**
- Create: `src/core/sections.js`
- Modify: `src/core/commands.js` (new `addSection`), `src/core/state.js` (reducer, `WRITE_TYPES`)
- Test: `tests/sections.test.js` (new)

**Interfaces:**
- Produces:
  - `SECTIONS = { swot: 'SWOT', overview: 'Overview', results: 'Quarterly results', shareholding: 'Shareholding pattern', peers: 'Peers' }` and `EXCHANGE_SECTIONS = new Set(['overview', 'peers'])`.
  - `parseSection(section: string, text: string) -> { data, warnings: string[] }`. Throws `UserError` for an unknown section, empty text, text over 20,000 characters, or text that parses to nothing.
  - `formatSection(section: string, data) -> string` (round-trips with `parseSection`).
  - `deriveSection(section: string, data, ctx: { symbol?: string }) -> object` per the spec's "Worked-out figures".
  - `addSection(state, { symbol, section, text, exchange, asOf, sources }, { actor, newId, now }) -> { events, result: { id, warnings } }`; event `note.structured` with `data = { id, symbol, section, exchange?, asOf, title, data, sources, revises? }`; `revises` is the current record's id for the same `(symbol, section, exchange)`.
  - `currentSection(state, symbol, section, exchange?) -> record | null` (not trashed, no `revisedBy`).
  - Reducer `'note.structured'`: pushes `{ ...d, by: e.actor, at: e.at }` into `s.notes` and sets `revisedBy` on the record named by `d.revises`. `note.structured` is in `WRITE_TYPES`.

- [ ] **Step 1: Write failing tests** in `tests/sections.test.js` with the spec's two fixtures verbatim:
  - overview fixture parses to the expected values in the spec (including the multi-line `TTM EPS` and `Beta` cases and the tags); `deriveSection('overview', …)` gives reference price VWAP 692.13, `aboveLow52Pct` ≈ 1.5, `nearLow52` true, `peVsSectorPct` ≈ −26.2, `withinLimits` true.
  - SWOT fixture parses to 4 strengths and 4 weaknesses (the `--Weakness :` heading works), 0 opportunities, 0 threats; `Weaknesses`, `weakness`, `OPPORTUNITIES :` headings also work; bullets with `-`, `•`, `1.` prefixes are cleaned.
  - a results grid (header `Mar 2026, Dec 2025, Sep 2025, Jun 2025, Mar 2025`, rows Revenue 1200 1100 1000 900 800, Net Profit 100 90 95 80 70, Net Margin % 8.3 8.2 9.5 8.9 8.8) → `risingQuarters` 4 for revenue, `qoqPct` ≈ 9.09, `yoyPct` 50 for revenue, margin `marginChangePp` ≈ 0.1; an oldest-first version of the same grid gives the same derived figures.
  - a shareholding grid (Promoters, FII/FPI 20.1 → 18.4, DII, Pledge 0) → `changePp` −1.7 and `decreased` for FII/FPI.
  - a peers grid with the stock's own row → medians exclude the stock; `vsMedianPct` correct for a worked example.
  - round trip: `parseSection(s, formatSection(s, data))` deep-equals `data` for each section.
  - Review Focus 1: CRLF line endings, blank lines, a label with no value, a duplicate label, and an unknown line give warnings but still parse; empty text, 20,001 characters, unknown section, and text that parses to nothing throw `UserError`.
  - Review Focus 5: `₹`, `%`, negatives, `—`/`NA` cells → numbers or `null`, never `NaN`.
  - command/reducer: saving twice gives `revises` on the second and exactly one current; `currentSection` returns the newest; trashing the current makes `currentSection` null (Review Focus 2); `exchange` required for overview/peers and refused for others; `asOf` in the future refused; an agent with draft access can add (counts toward its write quota) and the title is the section label.

- [ ] **Step 2: Run** `node --test tests/sections.test.js`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/core/sections.js` (pure, no I/O) with the signatures above, and `addSection` in `commands.js` (use the existing `symbolOf`, `sources` helpers; section cap on `data` size comes from the text limits). Register the reducer and `WRITE_TYPES`.

- [ ] **Step 4: Run** `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit** `feat: structured note sections with parser, worked-out figures and event`.

### Task 2: HTTP actions, MCP tool and docs

**Files:**
- Modify: `src/http/server.js`, `src/mcp/tools.js`, `src/version.js` (API_VERSION 5), `docs/MCP.md`
- Test: `tests/http.test.js`, `tests/mcp.test.js`

**Interfaces:**
- Consumes: Task 1 `parseSection`, `deriveSection`, `addSection`, `currentSection`, `SECTIONS`.
- Produces:
  - HTTP `note.preview { section, text }` → `{ data, warnings, derived }` (no events); `note.section.add { symbol, section, text, exchange?, asOf?, sources? }` → `{ id, warnings }`; `stock.snapshot { symbol, exchange }` → `{ sections: { [section]: { current, derived, history } } }` where `history` is the earlier non-purged versions newest first; Overview and Peers are filtered to `exchange` (default NSE, validated); trashed and purged records never included. All owner actions without PIN, same Host/Origin/CSRF checks as the other actions.
  - MCP `add_structured_note` (level `draft`, `write: 'write'`) `{ symbol, section, text, exchange?, asOf?, sources? }` → `{ id, warnings }`. `list_notes` gains optional `section`; with `section` it returns only current records of that kind. Descriptions say notes are never verified and agent text is untrusted.
  - `stateView` meta: `sections: SECTIONS`.

- [ ] **Step 1: Write failing tests:**
  - HTTP: `note.preview` returns data, warnings and derived without writing an event (event count unchanged); `note.section.add` then `stock.snapshot` shows it as current with derived figures; a second add makes the first appear in `history`; trashing the current makes the section empty; NSE and BSE Overviews are independent (Review Focus 4); a bad Origin or CSRF token is refused 403; `stock.snapshot` rejects an invalid exchange.
  - MCP: `add_structured_note` needs draft access, counts toward the write quota, returns warnings; text with `<img src=x onerror=1>` in a bullet is stored as given (escaping is a web concern) and `list_notes` with `section` returns it; a trashed and a purged section never appear in `list_notes` (Review Focus 3); no MCP tool name matches `verify|correct|mark`.

- [ ] **Step 2: Run** `npm test`. Expected: new tests FAIL.

- [ ] **Step 3: Implement** the actions and tool. Update `docs/MCP.md` (tool list, text formats for each section with one short example, "notes are never verified").

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: HTTP and MCP access to structured note sections`.

### Task 3: Web — Snapshot area, paste boxes, tables

**Files:**
- Modify: `web/app.js` (Prepare page top, stock page, `CLIENT_API = 5`), `web/info.js`, `web/style.css`, `scripts/browser-check.mjs`, `README.md`, `docs/SETUP.md`

**Interfaces:**
- Consumes: Task 2 `note.preview`, `note.section.add`, `stock.snapshot`, `meta.sections`.
- Produces: `CLIENT_API = 5`.

- [ ] **Step 1: Extend `scripts/browser-check.mjs` first** (fails against the current page): open Prepare for SAMPLE on NSE → a Snapshot card exists with five sections; paste the spec's Overview fixture into Overview's paste box → Preview shows a table with "Worked out by the desk" and `nearLow52` wording; Save → the table shows `692.13` as the reference price and the as-of date; paste the SWOT fixture → four Strengths and four Weaknesses appear as list rows; Modify on SWOT shows the canonical text, change one bullet, Save → "Earlier versions (1)" appears; an agent-written section (seed one with `<img src=x onerror=1>` in a bullet through the Store before starting) renders as visible text and creates no `img` element; no verify button anywhere in Snapshot; 390 px has no horizontal overflow on Prepare and the stock page (wide tables scroll inside their card); no console errors.

- [ ] **Step 2: Run** `npm run test:browser`. Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement** per the spec's "Surfaces": a Snapshot card at the top of Prepare (Overview and SWOT open, the other three folded) and the same on the stock page. Overview table groups Today, Range, Valuation, Activity with a "Worked out by the desk" column; SWOT as a 2×2 grid; results/shareholding/peers as tables with the worked-out figures (rising quarters, change in percentage points, vs peer median). Each section has "Paste or update", "Modify", "Earlier versions (n)", help text with a short paste example (info.js), and the line "Written by you" or "Written by a model" with the as-of date and its age. Every pasted or agent string goes through `esc()`. Load data with `stock.snapshot` and refresh it after a save. Bump `CLIENT_API` to 5. Update README.md and docs/SETUP.md (what the sections are, paste formats, notes are corrected, never verified).

- [ ] **Step 4: Run** `node --check web/app.js`, `npm test`, `npm run test:browser`. Expected: all PASS. Look at the Prepare and stock screenshots at 1280 and 390 px and fix layout problems.

- [ ] **Step 5: Commit** `feat: structured note sections on Prepare and the stock page`.
