# Structured notes: SWOT, Overview, Results, Shareholding, Peers

Date: 2026-10-25 · Status: owner-approved in chat (paste box, extra sections, placement on Prepare)

## Intent

Notes are free text today. The owner pastes market data and analysis from other sites by hand and
reads it as a wall of text. Give a stock a small set of structured sections that the owner pastes
once, sees as tables and lists, and can correct later. The desk reads the pasted text with fixed
rules (no AI, no web calls) and adds a few worked-out figures so claims like "near 52-week low"
are checked numbers, not sentences.

## Goals

1. Five sections per stock: **SWOT**, **Overview**, **Quarterly results**, **Shareholding pattern**, **Peers**.
2. A **paste box** is the way in. The desk parses the text, shows a preview table plus warnings
   about lines it could not read, and the owner saves. Claude can save a section too (MCP), using
   the same text format.
3. **Notes are never verified.** There is no verify step and nothing here passes or fails a
   checklist item or any approval check. Notes can be **corrected**: saving a section again for the
   same stock (and exchange, for Overview and Peers) creates a new version that replaces the old
   one as "current". Old versions stay in history and in the ledger.
4. The current sections show at the top of the **Prepare** page for the chosen stock and exchange,
   and on the stock page.
5. The desk adds a "worked out by the desk" column or line, computed from the pasted numbers.

## Non-goals

- No fetching from the web, no paid data, no AI parsing. No effect on approval, sizing or checks.
- No verify button, no good-until date, no counting toward evidence.
- No change to existing plain-text notes.

## Constraints (AGENTS.md)

Node 24 built-ins only; events immutable (a new event type, old `note.added` unchanged); reducers
deterministic (ids, derived values computed in commands); no MCP tool may approve/verify/edit
strategies or rewrite events; agent text is untrusted and shown as written by a model; plain
language UI with examples; bump `API_VERSION` and `CLIENT_API` together (5); price-type data
records its exchange (NSE or BSE).

## Data model

One new event: `note.structured`, data:
`{ id, symbol, section, exchange?, asOf, title, data, sources, revises? }`.
- `section` ∈ `swot | overview | results | shareholding | peers`; `title` is the section's label.
- `exchange` is required for `overview` and `peers` (price-derived numbers), absent otherwise.
- `asOf` is an India date (`YYYY-MM-DD`), default today, never in the future.
- `revises` is computed by the command: the id of the current record for the same
  `(symbol, section, exchange)` if one exists. The reducer marks that old record `revisedBy: <new id>`.
  Structured records live in `state.notes` (with `section` set and no `body`) so Trash, ledger and
  note lists keep working. **Current** = the newest live record (not trashed, not deleted) for the same `(symbol, section, exchange)`, ordered by saved time then id; every other live record is history. `revises`/`revisedBy` are recorded links only. Trashing the current version brings the previous one back (undo a bad save).
- Quota: `note.structured` counts as an agent write (add to `WRITE_TYPES`).

### Parsed shapes (`src/core/sections.js`, pure)

- **swot**: `{ strengths: string[], weaknesses: string[], opportunities: string[], threats: string[] }`.
  Pasted headings: Strengths, Weakness/Weaknesses, Opportunities, Threats (any case, optional
  trailing colon or dashes, e.g. `--Weakness :`). Following lines are bullets (leading `-`, `•`, `*`,
  `1.` stripped). Each bullet ≤ 300 chars, ≤ 20 per list.
- **overview**: `{ rows: { [key]: number|null }, tags: { [key]: string }, extra: [{ label, text }] }`.
  Known labels and their keys: Open `open`, Previous Close `prevClose`, Close/LTP/Last Price `ltp`,
  Volume `volume`, Value (Lacs) `valueLacs`, VWAP `vwap`, Beta `beta`, Mkt Cap (Rs. Cr.) `mktCapCr`,
  High `high`, Low `low`, UC Limit `ucLimit`, LC Limit `lcLimit`, 52 Week High `high52`, 52 Week Low
  `low52`, Face Value `faceValue`, All Time High `allTimeHigh`, All Time Low `allTimeLow`,
  20D Avg Volume `avgVol20`, 20D Avg Delivery(%) `avgDelivery20`, Book Value Per Share `bookValue`,
  Dividend Yield `dividendYield`, TTM EPS `ttmEps`, TTM PE `ttmPe`, P/B `pb`, Sector PE `sectorPe`.
  Value is on the same line after a tab, a colon or 2+ spaces, **or** on the next non-empty line(s);
  skip noise lines like "See historical trend". Indian digit grouping (`1,89,89,022`) is read as a
  number. A parenthesised remark after a value, e.g. `(+10.51% YoY)`, `(Low PE)`, goes to `tags[key]`.
  Unknown lines go to `extra`.
- **results, shareholding, peers** (grids): `{ columns: string[], rows: [{ label, cells: (number|string|null)[] }] }`.
  Cells split on tabs, or on 2+ spaces if there are no tabs. The first non-empty line is the header
  (its first cell may be empty or a corner label and is not a column). Numbers lose commas, `%`,
  `₹`; `—`, `-`, `NA` are `null`. At most 40 rows × 12 columns.
  - results: columns are periods (e.g. `Mar 2026`). shareholding: columns are quarters, rows like
    Promoters, FII/FPI, DII, Public, Pledge. peers: columns are metrics, rows are companies.

`formatSection(section, data)` returns canonical paste text so that
`parseSection(section, formatSection(section, data))` deep-equals `data` (used by **Modify**).

### Worked-out figures (`deriveSection(section, data, ctx)`, pure)

- overview: reference price = `ltp ?? vwap ?? prevClose` (named in the output); `aboveLow52Pct`,
  `belowHigh52Pct`, `peVsSectorPct` (TTM PE vs Sector PE), `nearLow52` (within 10% above the 52-week
  low), `withinLimits` (reference price between LC and UC).
- results: detect period order (newest first or last, by parsing `Mon YYYY` labels; fall back to
  last = newest). For rows whose label matches revenue/sales/income and net profit/PAT: latest
  `qoqPct`, `yoyPct` (if 5+ periods), and `risingQuarters` (consecutive increases up to latest).
  For margin rows: `marginChangePp` latest vs previous.
- shareholding: for every row, `changePp` latest vs previous period; flag `decreased` / `increased`.
- peers: for every numeric column, the median across rows other than the stock itself (row whose
  label matches the symbol case-insensitively, or contains it), and each row's `vsMedianPct`.
- swot: counts only.

## Surfaces

- HTTP (owner, no PIN, same Host/Origin/CSRF checks): `note.preview { section, text }` → `{ data, warnings, derived }`;
  `note.section.add { symbol, section, text, exchange?, asOf?, sources? }` → `{ id }`;
  `stock.snapshot { symbol, exchange }` → `{ sections: { [section]: { current, derived, history: [records newest first] } } }`
  (Overview and Peers filtered to the exchange; excludes trashed and purged; `history` holds the newest 20 earlier versions and `historyCount` the full number). `/api/state` carries no parsed data for sections: plain `notes` exclude them and a light `sections` list (`id, symbol, section, exchange, asOf, title, by, at, revisedBy`) is sent for links.
- MCP: `add_structured_note` (draft access, counts as a write) `{ symbol, section, text, exchange?, asOf?, sources? }` →
  `{ id, warnings }`; refuses text that parses to nothing. `list_notes` gains `section` and returns
  only current records of that kind by default. Agents never see trashed or purged records.
- Web: a "Snapshot" area for the stock: Prepare page top (for the chosen stock + exchange) and the stock page.
  Overview as a grouped table (Today, Range, Valuation, Activity) with a "Worked out by the desk"
  column; SWOT as a 2×2 grid of lists; results/shareholding/peers as tables with the worked-out
  column or row. Each section has **Paste or update** (textarea, Preview button, Save) and **Modify**
  (textarea prefilled by `formatSection`), plus "Earlier versions (n)". Labels: "Written by you" /
  "Written by a model" and the as-of date with its age; never a verify button. Overview/Peers show
  the exchange. Plain-language help with a paste example for each section.

## Fixtures (use verbatim in tests)

Overview paste (tab-separated; some values on the next line):
```
Open	692.55
Previous Close	694.05
Volume	1,89,89,022
Value (Lacs)	1,31,555.94
VWAP	692.13
Beta	
1.22
Mkt Cap (Rs. Cr.)	10,68,200
High	696.80
Low	686.85
UC Limit	711.65
LC Limit	670.25
52 Week High	1,017.50
52 Week Low	681.90
Face Value	1
All Time High	1,020.50
All Time Low	7.85
20D Avg Volume	3,14,62,518
20D Avg Delivery(%)	59.64
Book Value Per Share	390.37
Dividend Yield	2.24
TTM EPS
See historical trend 
51.95
(+10.51% YoY)
TTM PE
See historical trend 
13.34
(Low PE)
P/B
See historical trend 
1.78
(Low P/B)
Sector PE	18.08
```
Expected: `rows.open` 692.55, `rows.volume` 18989022, `rows.mktCapCr` 1068200, `rows.high52` 1017.5,
`rows.ttmEps` 51.95 with `tags.ttmEps` `+10.51% YoY`, `rows.ttmPe` 13.34 tag `Low PE`, `rows.pb` 1.78 tag
`Low P/B`, `rows.sectorPe` 18.08, `rows.beta` 1.22; derived: reference price is VWAP 692.13 (no LTP),
`aboveLow52Pct` ≈ 1.5, `nearLow52` true, `peVsSectorPct` ≈ −26.2, `withinLimits` true.

SWOT paste:
```
Strengths :
Growth in Net Profit with increasing Profit Margin (QoQ)
Increasing Revenue every Quarter for the past 4 Quarters
Annual EPS Improving for last 2 years
Company with Zero Promoter Pledge
--Weakness :
FII/FPI decreased their shareholding last quarter
Near 52 Week Low
Inefficient use of shareholder funds - ROE declining
Inefficient use of capital to generate profits - RoCE declining
```
Expected: 4 strengths, 4 weaknesses, empty opportunities and threats.

## Left to the builder

File layout inside the limits above; exact warning wording; how the web lays out each table;
test structure; docs wording. Every item under "Worked-out figures" needs a test with numbers.
