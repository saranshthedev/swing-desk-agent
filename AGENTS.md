# Instructions for coding agents

Read `README.md` and `docs/RETHINK.md` first.

## Constraints

- Completely free and open source (MIT). Never integrate a paid API, paid data feed, broker
  data subscription, hosted service or required model API key. Information gathering is the
  connected models’ job; the desk validates, records and gates it.
- Node 24 built-ins only. No npm packages or database server.
- The desk never places, modifies or cancels broker orders. Do not add order endpoints, even behind a flag.
- No MCP tool may approve, change agent access, edit strategies/playbooks/PIN, or delete or rewrite events.
  Do not add an auto-approve path.
- The chat agent's key exists only in server memory; never write it to disk, logs, responses or chat history.
- Use plain language in UI text: rupees, percentages, India time, borrowed money, with examples.

## Architecture

| Path | Responsibility |
|---|---|
| `src/core/` | Pure logic: fees, sizing, settings, rules, strategies, schedule, commands, state reducer, views |
| `src/store/store.js` | SQLite event log with hash chain, PIN, hashed agent keys, call log |
| `src/chat/` | Chat panel: CLI process manager, chat history (outside the event log), limits, overrule notes |
| `src/mcp/` | stdio MCP server and tool definitions (access levels, quotas) |
| `src/http/server.js` | Owner web API on 127.0.0.1, Host/Origin/CSRF checks, PIN-gated actions, scheduler |
| `web/` | Browser app (ES modules, no inline script/style) |
| `bin/desk.js` | CLI |
| `tests/` | `node --test` suites using in-memory or temporary databases |

The server serves web/ files from disk on every request but keeps its own code in memory. When the page starts relying on new server data, bump API_VERSION in src/version.js and CLIENT_API in web/app.js together; an older running server then shows a restart banner instead of broken pages.

State changes only through commands that return events. Reducers in `src/core/state.js` must be
deterministic: compute ids, P/L and snapshots in the command, store them in the event.

**Events are immutable.** Never edit or delete rows in `events`. To change the meaning of
an event type, add a new type and keep the reducer for the old one. Add new optional fields
rather than changing existing ones.

## Financial invariants

- Charge formulas in `src/core/fees.js` match Swing Desk v3; `tests/fees.test.js` pins them.
  Change rates only from Zerodha’s official pages and update `checkedOn`.
- Approved buys freeze their fee snapshot; lots use it for all later estimates.
- Same-day MTF keeps MTF brokerage; Regular trades have no MTF interest/pledge.
- Borrowed money is exposure, not risk budget. Sizing must satisfy both loss and cash limits.
- Actual fill prices already include slippage. Actual charges override estimates.
- Agents may submit prices and MTF requirements, but those gates pass only on owner-entered or
  owner-confirmed values (a confirmation is a new owner record timed at confirmation). Quote
  freshness is 5 minutes; news must be from the current India date.
- Strategy rules only add restrictions. Saving a strategy bumps its version and invalidates
  pending requests made on the old version.

## Privacy

Never read or print the real data folder, `desk.sqlite`, agent keys or the PIN. Use
`:memory:` stores or temporary folders in tests and manual checks.

## Verify

```sh
npm test
node --check web/app.js
```

For UI changes run `npm run test:browser` (installed Chrome/Edge, temporary data, synthetic
values; checks the approval flow, 390 px overflow, keyboard focus and console errors) and look
at its screenshots. If browser checks were not possible, say so.
