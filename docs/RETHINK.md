# Rethink: from Swing Desk v3 to Swing Desk Agent

Swing Desk v3 was a careful planner and journal that the owner filled in by hand. MCP access
was added later as a side door: one global access mode, a research-pack export and a
proposal import. This repository starts again around one idea:

> **Models do the legwork. Fixed rules check it. The owner decides. Everything is recorded once.**

This page records what was removed, what was redone, what is new, and what was kept on purpose.

## Removed

| v3 feature | Why it is gone | What replaces it |
|---|---|---|
| Hosted Cloudflare Worker, D1 database, Drizzle migrations, ChatGPT Site identity, hosted bundle build | Two storage backends had to stay identical, and a hosted copy of a personal money journal is a large attack surface for one user. | Local only. One SQLite file. Remote access, if ever wanted, through a private network tool (for example Tailscale) to the same local app. |
| Source ZIP packaging, generated copies of README/licence/plan, Python packaging script | Build machinery for the hosted Site. | Plain Git repository. Nothing is generated. |
| One JSON “journal” blob saved with a single revision number | Any change rewrote everything; conflicts were coarse; history and audit were separate. | Append-only event ledger with a hash chain (see below). |
| One global MCP access mode (Off / Read / Draft) | Every model client had the same power and was indistinguishable in the audit. | A separate key, access level, quota and expiry for each agent. |
| `swing-desk-proposals.v1` JSON import/export and the research-pack | A file round-trip that a model had to format perfectly, then a human had to paste. | Typed MCP tools (`propose_buy`, `add_evidence`, …) that are validated on arrival. |
| Google sign-in and Google Drive backup | Sign-in is unnecessary for a local app; Drive consent is extra setup and risk. | `desk backup` / the Backup button writes a consistent SQLite copy to any folder you choose. Point it at a synced folder if you want an off-machine copy. |
| Example breakout backtester and held-out strategy selection | Useful research, but it mixed historical testing into the decision desk and invited “proven strategy” readings. | Out of core. A future, separate read-only tool could expose backtests as evidence. |
| 35 KB fixed checklist definitions and 24 KB tooltip text | One giant checklist for every trade, mostly manual ticks. | Per-strategy checklists that mix owner answers, evidence requirements and automatic rules. Explanations live next to each check. |
| Shared-statement charge allocation tables and JSON charge-table imports | Complex importer for a step most people do once a month. | Enter the actual charges for a sale from the contract note; otherwise a disclosed estimate is used. |
| UMD modules written as minified one-liners | Hard to read, review and change safely. | Readable ES modules, one responsibility each. |
| Repo data folder under OneDrive | Sync clients can corrupt a live SQLite file. | Data defaults to `%LOCALAPPDATA%\SwingDeskAgent` (Windows) or `~/.swing-desk-agent`. |

## Redone

| Area | v3 | Now |
|---|---|---|
| Storage | Journal blob + separate audit table | Event log is the only source of truth. Each event stores who (owner, agent, scheduler), when, what, and a SHA-256 hash that covers the previous event. `desk verify` detects any edit. State is rebuilt by replaying events. |
| Agent input | Imported proposals were “unconfirmed research” the owner re-entered | Agents send **requests** (buy, exit, settings change). The desk recalculates size and charges itself, runs every check, and the owner approves or rejects. |
| Checklist | One list, parents derived from children | Strategy checklists with three item types: *you answer*, *needs evidence*, *fixed rule*. Strategy rules can only add to global limits. Editing a strategy creates a new version; requests made on the old version cannot be approved. |
| Approval | Owner PIN on proposed setting changes only | One approval path for everything: buy, exit and settings. PIN required, five wrong tries lock it for 15 minutes. The approval freezes the checks, the owner’s answers, the plan, the sizing and the fee rates. |
| Order handling | No orders; plan shown in the planner | Still no orders. Approval produces an exact **order ticket** to enter in Kite, then the owner records the real fill. |
| Slippage in plans | Fixed ₹ per share | Percentage of price by default (0.1%), so cheap and expensive stocks are treated alike. A fixed ₹ amount can still be given. |
| Web UI | Large single page with many panels | Small pages: Today, Requests, New plan, Positions, Research, Strategies, Playbooks, Agents & MCP, Ledger, Settings. Strict content security policy, no inline script or style. |

## New

- **Per-agent MCP keys** with Off / Read / Draft / Propose, daily write and request quotas, hourly call limits, expiry, revoke and re-key. Keys are shown once and stored only as hashes.
- **Playbooks**: scheduled jobs in India time (once a day, or every N minutes in a window). The desk queues a task; the assigned model app takes it with `next_task`, follows the owner’s instructions and reports with `complete_task`. The desk never needs a model API key, so it stays free and model-independent.
- **Pause all agents** switch, available from every page.
- **Evidence with provenance**: broker price and MTF requirement can only come from the owner; news, candles, calendar and other evidence can come from agents and are always labelled *not verified*.
- **Weekly loss pause**, **total open-risk limit** and **borrowed-money limit** checked on every buy.
- **Ledger page** showing every change and whether the hash chain is intact.

## Kept on purpose

- Zerodha charge formulas and rates, ported unchanged and tested against v3’s outputs (same-day MTF keeps MTF brokerage; Regular has no MTF interest or pledge; BSE uses its own exchange rate).
- Each trade keeps its own frozen fee snapshot; changing settings never rewrites history.
- Borrowed money is exposure, not extra risk money. Sizing fits both the loss budget and the cash limit.
- Broker quotes expire after 5 minutes. News must be from today’s India date. No fresh evidence means no approval.
- Distinct buy fills are distinct lots with their own price and date. Partial sales keep the rest open at the same basis. Actual charges override estimates; estimates on partial sales may repeat fixed fees, and the UI says so.
- Agent text is untrusted data. No tool can approve, place orders, change access, edit strategies or delete history.
- Free, local, MIT, no npm packages, Node 24 built-ins only.

## Not done yet (candidates, in rough order)

1. **Read-only Kite Connect adapter** so broker prices, holdings and MTF requirements can arrive as *broker* evidence instead of pasted values. Keep reads allowlisted, no order endpoints.
2. **Importer from v3**: read the v3 SQLite journal and emit `lot.opened` / `lot.sold` / `settings.changed` events with an `imported` marker. Never modify the v3 file.
3. **Company actions** (split, bonus, consolidation) as reviewed events on open lots, as v3 had.
4. **Phone approvals** over a private network, with the same PIN rule.
5. **Streamable HTTP MCP transport** for model apps that cannot launch a local process.
6. **NSE holiday calendar** so playbooks skip market holidays automatically.
7. **Backtests as evidence**: a separate tool that never uses future candles, records its assumptions and attaches results as evidence, not as approval.
