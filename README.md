# Swing Desk Agent

A free, local desk for Indian equity swing trades where **your own AI models do the research
and propose trades over MCP, fixed rules check every proposal, and you approve**. It never
places orders: approving gives you an exact order ticket to enter in Kite, then you record the
real fill.

- Works with any MCP model app (Claude Desktop, Claude Code, ChatGPT, local models). No model API key.
- Zerodha Regular (CNC) and MTF charges, sizing from your loss limit and cash limit.
- Per-strategy checklists: things you answer, evidence that must be fresh, and fixed rules.
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

```sh
node --version   # v24.x
npm start        # http://127.0.0.1:8790
```

1. **Settings** → set your 6–12 digit approval PIN and your risk limits.
2. **Agents & MCP** → add an agent, copy its config into your model app ([docs/MCP.md](docs/MCP.md)).
3. **Strategies** → review the three starting templates or make your own.
4. **Playbooks** → schedule work for your agents (optional).

Data lives in `%LOCALAPPDATA%\SwingDeskAgent` on Windows or `~/.swing-desk-agent` elsewhere.
Change it with `SWING_DESK_DATA`, the port with `SWING_DESK_PORT`, backups with `SWING_DESK_BACKUPS`.

## Commands

| Command | Does |
|---|---|
| `npm start` | Web app and playbook scheduler on 127.0.0.1 |
| `npm run mcp` | MCP server on stdio (needs `SWING_DESK_AGENT_KEY`) |
| `npm test` | Test suite (no network, no real data) |
| `npm run test:browser [folder]` | Optional owner-flow check in an installed Chrome/Edge, with a real MCP client; saves screenshots if a folder is given |
| `npm run check` | Verify the ledger hash chain |
| `node bin/desk.js backup [file]` | Consistent database copy |
| `node bin/desk.js export [file]` | All events as JSON Lines (no PIN, keys or call log) |

## How a trade flows

1. An agent (or you) records evidence and sends a **buy request** naming a strategy.
2. The desk recalculates shares and charges from *your* limits and runs every check: loss per
   trade, gain vs risk, open lots, total open risk, borrowed money, weekly loss pause, a confirmed
   price from the last 5 minutes, today’s news, today’s MTF requirement, and the strategy’s checklist.
3. You confirm the agent’s price (or type Kite’s), answer the checklist’s yes/no items, enter your PIN and approve.
4. You place the order in Kite using the ticket, then record the actual fill. Sales are recorded
   the same way, with actual contract-note charges when you have them.

## Limits

- Charges are estimates from Zerodha’s published rates checked on 2026-10-22/23. Re-check
  <https://zerodha.com/charges/> and <https://zerodha.com/mtf/> before relying on them; actual
  contract-note charges always override estimates.
- No live price feed, no automatic news, no tax reports, no exchange holiday calendar.
- Strategy templates are examples, not advice or proof of an edge.
- MCP limits do not protect against a model app that can also read your files or control your browser.

## Licence

MIT. See [LICENSE](LICENSE).
