# Swing Desk Agent

A free, local desk for Indian equity swing trades where **your own AI models do the research
and propose trades over MCP, fixed rules check every proposal, and you approve**. It never
places orders: approving gives you an exact order ticket to enter in Kite, then you record the
real fill.

- Works with any MCP model app (Claude Desktop, Claude Code, ChatGPT, local models). No model API key.
- Zerodha Regular (CNC) and MTF charges, sizing from your loss limit and cash limit.
- A 107-item pre-trade checklist in 15 groups (market, global, USDINR, oil and commodities, fundamentals, weekly/monthly demand-supply zones, volume, plan, money, order) split into research (done on the Prepare page days before) and on-the-day stages; each strategy picks from it.
- Scheduled playbooks that hand tasks to your model app in India time.
- Every change is an entry in a tamper-evident ledger.
- Node 24 only. No npm packages, no database server, no paid feed. MIT licence.

Why it is built this way, and what changed from Swing Desk v3: [docs/RETHINK.md](docs/RETHINK.md).

## Free forever

Swing Desk Agent is completely free and open source. It does not integrate, and will not
integrate, any paid API, paid data feed, subscription or hosted service. Your models gather
information themselves with whatever their own apps can reach (web search, public exchange
pages, filings) and record it with sources. Prices and MTF requirements an agent finds count
toward approval only after you confirm in one click that Kite shows the same.

## Start

**New here? Follow the easy step-by-step guide: [docs/SETUP.md](docs/SETUP.md).**

Windows in short: install Node.js 24 and the Claude Code extension, then double-click
**`setup.cmd`** once and **`start.cmd`** (or the Desktop shortcut it makes) every day.
Mac/Linux: `./setup.sh` and `./start.sh`.

Or by hand:

```sh
node --version   # v24.x
npm start        # http://127.0.0.1:8790
```

1. **Connect Claude Code** (VS Code extension or terminal): in a second terminal run
   `npm run connect`. It sets your approval PIN if needed, asks what Claude may do, creates a
   key and registers the desk with Claude Code. Then start a new Claude conversation and run `/mcp`.
   For other model apps use **Agents & MCP** in the desk ([docs/MCP.md](docs/MCP.md)).
2. **Settings** → review your risk limits.
3. **Strategies** → review the three starting templates or make your own.
4. **Playbooks** → schedule work for your agents (optional).

Data lives in `%LOCALAPPDATA%\SwingDeskAgent` on Windows or `~/.swing-desk-agent` elsewhere.
Change it with `SWING_DESK_DATA`, the port with `SWING_DESK_PORT`, backups with `SWING_DESK_BACKUPS`.

## Commands

| Command | Does |
|---|---|
| `npm start` | Web app and playbook scheduler on 127.0.0.1 |
| `setup.cmd` / `./setup.sh` | Guided first-time setup: Claude connection, Desktop shortcut, automatic runs |
| `start.cmd` / `./start.sh` | Start the app and open the browser (or just open it if already running) |
| `npm run connect` | Set the PIN if needed, create a key and register the desk with Claude Code |
| `node bin/desk.js schedule [list\|add HH:MM\|remove HH:MM\|remove all]` | Weekday automatic Claude runs (Task Scheduler on Windows, a crontab line elsewhere) |
| `node bin/desk.js run-tasks` | One automatic run: Claude takes queued playbook tasks with only the desk tools and web search |
| `npm run mcp` | MCP server on stdio (needs `SWING_DESK_AGENT_KEY`) |
| `npm test` | Test suite (no network, no real data) |
| `npm run test:browser [folder]` | Optional owner-flow check in an installed Chrome/Edge, with a real MCP client; saves screenshots if a folder is given |
| `npm run check` | Verify the ledger hash chain |
| `node bin/desk.js backup [file]` | Consistent database copy |
| `node bin/desk.js export [file]` | All events as JSON Lines (no PIN, keys or call log) |

## How a trade flows

1. **Prepare, days ahead (mandatory).** On the Prepare page, for one stock on one exchange
   (NSE by default), you mark each research item as checked; evidence items rest on a record you
   entered or verified. Each strategy has a research window: a mark counts only after its
   **buffer** days (at least 3) and until its **expire** days (at most 21). Example: buffer 3,
   expire 5: research ticked on Monday counts Thursday to Saturday. Prepare also shows the desk’s
   rule-based wait/buy/hold/sell view next to Claude’s (marked not verified); neither is advice.
2. Records are reused: Claude’s finds stay “found” until you verify them, each verified record
   counts until its own good-until date, and a wrong record is corrected (the old one stays,
   marked). Price and chart records name their exchange and count only for that exchange.
3. An agent (or you) sends a **buy request** naming a strategy. It can be sent any time; it
   cannot be approved until every required research item of its strategy is inside its window.
4. The desk recalculates shares and charges from *your* limits and runs every check: loss per
   trade, gain vs risk, open lots, total open risk, borrowed money, weekly loss pause, a confirmed
   price from the last 5 minutes, today’s news, today’s MTF requirement, and the strategy’s checklist.
5. On the day you verify Claude’s on-the-day records (news, chart, market), confirm the agent’s
   price and MTF requirement (or type Kite’s), tick the on-the-day yes/no items, enter your PIN
   and approve. Research items cannot be ticked on the request page.
6. You place the order in Kite using the ticket, then record the actual fill. Sales are recorded
   the same way, with actual contract-note charges when you have them.

## Snapshot: pasted notes as tables

At the top of Prepare and on each stock page, a **Snapshot** keeps five sections you paste from
free sites: **Overview** (the day’s price box), **SWOT**, **Quarterly results**, **Shareholding
pattern** and **Peers**. Click **Paste or update**, paste the text as it comes, click **Preview**
to see what the desk read (and any line it could not read), then **Save**. No PIN is needed.
Claude can save the same sections with `add_structured_note`; they show “Written by a model”.

- The desk reads the text with fixed rules (no AI, nothing fetched) and works out a few figures:
  for example “1.5% above the 52-week low · near the low” (within 10%), “PE is 26% below the
  sector’s”, “Revenue rose in each of the last 4 quarters”, “FII/FPI holding fell 1.7 points”, and
  each peer number against the median of the other companies.
- Overview and Peers are kept per exchange (NSE or BSE). Each section shows its as-of date and age.
- Notes are **never verified** and never count for a checklist item or an approval. A wrong one
  is **corrected** by saving it again (**Modify** starts from the saved text): the new version
  becomes current and earlier versions stay under **Earlier versions** and in the ledger.

## Limits

- Charges are estimates from Zerodha’s published rates checked on 2026-10-22/23. Re-check
  <https://zerodha.com/charges/> and <https://zerodha.com/mtf/> before relying on them; actual
  contract-note charges always override estimates.
- No live price feed, no automatic news, no tax reports, no exchange holiday calendar.
- Strategy templates are examples, not advice or proof of an edge.
- MCP limits do not protect against a model app that can also read your files or control your browser.

## Licence

MIT. See [LICENSE](LICENSE).
