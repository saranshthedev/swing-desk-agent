# Chat Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude chat docked on the right of every desk page, driven by the owner's local Claude Code CLI, with history in SQLite, owner-overrule notes, and configurable chat limits.

**Architecture:** Pure modules in `src/chat/` (limits, step lines, overrule notes, CLI arguments, history) plus one stateful `ChatManager` that owns the single CLI child process and streams events. The owner HTTP server exposes chat actions through the existing `/api/action/*` path (same Host/Origin/CSRF/JSON checks), two GET routes and one streamed GET. The browser gets a fixed `aside#chat` driven by a new `web/chat.js`.

**Tech Stack:** Node 24 built-ins (`node:child_process`, `node:sqlite`, `node:crypto`, `node:test`), plain ES modules in the browser.

**Spec:** `docs/superpowers/specs/2026-10-29-chat-panel-design.md`

## Global Constraints

- Node 24 built-ins only; no npm packages, no paid API, no API key.
- The chat never approves, rejects, changes agent access, edits strategies/playbooks/PIN, or deletes/rewrites events. No new MCP tool.
- The chat agent's plain key lives only in `ChatManager` memory and in the child's `--mcp-config` argument. Never in a file, log, HTTP response, SSE frame, chat message or error text. Never log spawn arguments.
- Chat text never enters `events`.
- Chat text is rendered with `mdBlock` (Claude) or `esc` (owner); never raw HTML.
- Message text capped at 20 000 characters.
- Bump `API_VERSION` (src/version.js) and `CLIENT_API` (web/app.js) together, 7 → 8.
- Tests use `:memory:` stores or temporary folders and a fake CLI; never the real data folder or a real Claude login.
- Plain language in UI copy: India time, rupees, no jargon.
- Exact copy pinned by the spec, used verbatim:
  - Time-limit stop: `Stopped after 15 minutes (your reply time limit). Anything Claude already recorded is on the desk. Send ‘continue’ to carry on.` (the number is the configured value)
  - Correction prefix block header: `Owner corrections since your last reply`

## Review Focus

1. **CLI missing or not logged in** — the panel must say so in plain words, and Send must not spawn. Pinned in Task 5 (`send refuses when no CLI`) and Task 6 (state block `cli: false`).
2. **Child process dies mid-reply** (crash, logout, network) — the turn ends, an `error` message is saved, Send works again. Pinned in Task 5 (`process exit mid-turn ends the turn with an error`).
3. **Server restart with an old thread** — the next message must `--resume` the saved session id under the freshly issued key. Pinned in Task 5 (`resume passes saved session id`).
4. **Huge or odd owner text** (40 000 chars, only spaces, control chars) — capped, blank refused, never crashes the stdin JSON line. Pinned in Task 1 (`text is capped`) and Task 5 (`blank text is refused`).
5. **Chat agent revoked/expired/Off while a process is idle** — the next send is refused with the reason; nothing spawned. Pinned in Task 6 (`revoked chat agent: nothing spawned`).

---

### Task 1: Chat tables and history

**Files:**
- Modify: `src/store/store.js` (constructor `CREATE TABLE` block)
- Create: `src/chat/history.js`
- Test: `tests/chat-history.test.js`

**Interfaces:**
- Produces (all take the `Store` as first argument; times are ISO strings from `store.clock()`):
  - `createThread(store, { title, agentId }) → thread` (`title` cut to 80 chars, `id` from `newId('chat')`)
  - `listThreads(store) → thread[]` newest `updated_at` first, at most 200
  - `getThread(store, id) → thread | null`
  - `setThreadSession(store, id, cliSessionId)`
  - `addMessage(store, threadId, { role, text, tool?, summary? }) → message` (bumps thread `updated_at`; `role` ∈ `owner|claude|step|note|error`, else throws `UserError`)
  - `messages(store, threadId) → message[]` oldest first
  - `notesSinceReply(store, threadId) → message[]` — `note` messages after the latest `claude` message
  - `chatSetting(store, name) → any | null` and `setChatSetting(store, name, value)` (JSON in `chat_settings`)
  - Row shapes: thread `{ id, title, createdAt, updatedAt, cliSessionId, agentId }`; message `{ id, threadId, at, role, text, tool, summary }`.
- Tables (in the existing `db.exec` block):
  - `chat_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cli_session_id TEXT, agent_id TEXT)`
  - `chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, at TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, tool TEXT, summary TEXT)` + index on `(thread_id, id)`
  - `chat_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)`

- [ ] **Step 1: Write the failing tests** in `tests/chat-history.test.js`:
  - `threads list newest first and keep their messages in order` — create two threads, add messages, assert order of `listThreads` and `messages`.
  - `text is capped at 20 000 characters` — `addMessage` with 40 000 `x` → stored length `20000`.
  - `unknown role is refused` — `assert.throws(() => addMessage(store, t.id, { role: 'system', text: 'x' }), /role/i)`.
  - `notes since reply are the notes after the last Claude message` — owner, note A, claude, note B, note C → `['B','C']`.
  - `chat history never touches the event log` — `store.state.seq` unchanged and `store.verify().ok` after all writes.
  - `settings round-trip as JSON` — `setChatSetting(store, 'limits', { a: 1 })` then `chatSetting` deep-equals; missing → `null`.
- [ ] **Step 2: Run** `node --test tests/chat-history.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Add the tables and implement `src/chat/history.js`.** Prepared statements on `store.db`; `cap = (t) => String(t ?? '').slice(0, 20_000)`.
- [ ] **Step 4: Run** `node --test tests/chat-history.test.js` — Expected: PASS. Run `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(chat): chat history tables outside the event log`

---

### Task 2: Chat limits and step lines

**Files:**
- Create: `src/chat/limits.js`, `src/chat/steps.js`
- Test: `tests/chat-limits.test.js`

**Interfaces:**
- `src/chat/limits.js`:
  - `CHAT_LIMITS` — `{ replyMinutes: { label: 'Reply time limit', unit: 'minutes', default: 15, min: 1, max: 120 }, toolCalls: { label: 'Tool calls per reply', unit: 'tool calls', default: 60, min: 1, max: 500 }, modelTurns: { label: 'Claude turns per reply', unit: 'Claude turns', default: 40, min: 1, max: 200 }, idleMinutes: { label: 'Close an idle session after', unit: 'minutes', default: 10, min: 1, max: 120 } }`
  - `chatLimits(input = {}) → { replyMinutes, toolCalls, modelTurns, idleMinutes, off? }` — defaults filled; non-integer or out-of-range throws `UserError('<label> must be a whole number from <min> to <max>.')`; `off` follows `agentLimits` in `src/core/commands.js` exactly (list, known keys, de-duplicated, omitted when empty).
  - `limitOn(limits, key) → boolean`
  - `stopMessage(key, limits) → string` — `replyMinutes` returns the pinned global copy with the configured number; `toolCalls` → `Stopped after N tool calls (your tool-call limit). Anything Claude already recorded is on the desk. Send ‘continue’ to carry on.`; `modelTurns` → `Stopped after N Claude turns (your Claude-turns limit). …same tail`.
- `src/chat/steps.js`:
  - `stepLine(toolName, input) → { tool, summary, write }`. `mcp__swing-desk__<name>` maps through a `PHRASES` table to plain phrases (e.g. `add_evidence` → `Added an evidence record for SYMBOL`, `add_structured_note` → `Saved SYMBOL · <section>`, `propose_buy` → `Proposed a buy of SYMBOL`, read tools → `Read the desk: <what>`); `write` is true when `TOOLS[name].write` is set in `src/mcp/tools.js`. `WebSearch` → `Searched the web: “query”`; `WebFetch` → `Read <hostname>`. Anything else → `Used <toolName>`. `summary` ≤ 160 chars; symbols upper-cased from `input.symbol` when present.

- [ ] **Step 1: Write the failing tests:**
  - `chat limits fill defaults` — `chatLimits()` deep-equals `{ replyMinutes: 15, toolCalls: 60, modelTurns: 40, idleMinutes: 10 }`.
  - `out-of-range and fractional limits are refused` — `replyMinutes: 0`, `121`, `1.5`, `toolCalls: 501`, `modelTurns: 201`, `idleMinutes: 0` each throw.
  - `switched-off limits keep their numbers` — `chatLimits({ replyMinutes: 30, off: ['replyMinutes', 'replyMinutes'] })` → `{ …, replyMinutes: 30, off: ['replyMinutes'] }`; `off: ['nope']` throws; `limitOn` false/true accordingly.
  - `stop message uses the configured number` — `stopMessage('replyMinutes', chatLimits())` equals the pinned copy exactly.
  - `step lines are plain and flag desk writes` — `stepLine('mcp__swing-desk__add_evidence', { symbol: 'tcs' })` → `write: true`, summary contains `TCS`; `list_evidence` → `write: false`; `WebSearch` `{ query: 'nifty today' }` → `Searched the web: “nifty today”`; `WebFetch` `{ url: 'https://www.nseindia.com/x' }` → `Read www.nseindia.com`; a 500-char query is cut to ≤ 160.
- [ ] **Step 2: Run** `node --test tests/chat-limits.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement both modules.**
- [ ] **Step 4: Run** the test file — PASS; `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(chat): chat limits with switches and plain step lines`

---

### Task 3: Owner-overrule notes

**Files:**
- Create: `src/chat/notes.js`
- Test: `tests/chat-notes.test.js`

**Interfaces:**
- `overruleNotes(state, events) → string[]` — pure. Looks only at events with `actor === 'owner'`, about something an agent wrote (`by` starts with `agent:`):
  - `evidence.corrected` (old = `state.evidence` row `data.corrects`): `You corrected SYMBOL · <kind>: “<old>” → “<new>”. Reason: <reason>` where old/new is `price` (₹), `marginPct` (%) or `summary` (cut to 120 chars).
  - `note.structured` with `data.revises` pointing at an agent's note: `You re-saved SYMBOL · <title> over the agent’s version.`
  - `evidence.flagged`: `You flagged SYMBOL · <kind>: <reason>`
  - `intent.rejected` of an agent's intent: `You rejected the <kind> request for SYMBOL. Reason: <reason or “none given”>`
  - Nothing for `evidence.verified`, confirmations (`evidence.added` with `confirms` — they always copy the agent's value; a different value goes through correction), `item.trashed`/trash moves (owner's decision: Trash is manual only), or owner edits of owner records.
- `syncOverruleNotes(store) → message[]` (same file) — reads events with `seq` greater than chat setting `notes_seq` (first call: sets `notes_seq` to current `store.state.seq` and returns `[]`, so old history is never replayed), adds each note as a `note` message to the most recently updated thread (if any), saves the new `notes_seq`, returns the posted messages. Read events with a new `Store` method `eventsAfter(seq) → event[]` (ascending; same row mapping as `events()`), added in `src/store/store.js`.
- `correctionsBlock(notes: message[]) → string` — `''` when empty, else `Owner corrections since your last reply:\n- …\n- …\n\n`.

- [ ] **Step 1: Write the failing tests** (use `desk()` and `addAgent('draft')` from `tests/helpers.js`):
  - `a correction of an agent record becomes one note` — agent adds a quote `price: 100`, owner corrects to `price: 98` with reason `Kite shows 98` → one string containing `ABC`, `₹100`, `₹98`, `Kite shows 98`.
  - `re-saving a section over the agent's version is noted` — agent `addSection` overview, owner `addSection` overview same symbol → note contains `Overview` and `over the agent’s version`.
  - `flag and reject are noted` — flag reason and reject reason appear.
  - `verify, confirm, trash and owner-on-owner edits make no note` — each yields `[]`.
  - `sync posts to the latest thread once and never replays old history` — events before first sync produce `[]`; after a correction, `syncOverruleNotes` returns one message, a second call `[]`; message role `note` in the newest thread.
  - `corrections block` — `correctionsBlock([])` → `''`; two notes → starts with `Owner corrections since your last reply:`.
- [ ] **Step 2: Run** `node --test tests/chat-notes.test.js` — FAIL.
- [ ] **Step 3: Implement** `eventsAfter` and `src/chat/notes.js`.
- [ ] **Step 4: Run** the file — PASS; `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(chat): tell Claude when the owner overrules an agent`

---

### Task 4: CLI arguments, chat agent status and spawning

**Files:**
- Create: `src/chat/cli.js`
- Modify: `src/connect.js` (extract the `.cmd` quoting from `runClaude` into exported `shellLine(claude, args) → string`; `runClaude` uses it, behaviour unchanged)
- Test: `tests/chat-cli.test.js`

**Interfaces:**
- `CHAT_RULES` — one line (no newlines, so `.cmd` quoting stays safe): you are inside Swing Desk; the owner approves on the desk, never in the chat; record only through the swing-desk tools; follow the research rule from the MCP server instructions; plain language, rupees, India time; say where on the desk anything you recorded is.
- `mcpConfigJson({ key, dataDir }) → string` — `{"mcpServers":{"swing-desk":{"command":process.execPath,"args":[BIN,"mcp"],"env":{"SWING_DESK_AGENT_KEY":key,"SWING_DESK_DATA":dataDir}}}}` where `BIN` is this checkout's `bin/desk.js`.
- `chatArgs({ mcpConfig, sessionId, resume }) → string[]` — exactly, in order: `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --strict-mcp-config --mcp-config <mcpConfig> --tools WebSearch,WebFetch --allowedTools mcp__swing-desk__*,WebSearch,WebFetch --setting-sources "" --append-system-prompt <CHAT_RULES>` then `--resume <sessionId>` when `resume` is true, else `--session-id <sessionId>`. (The turns limit is counted by `ChatManager`, not a CLI flag: `--max-turns` is not in `claude --help` for 2.1.310.)
- `spawnClaude(bin, args, { cwd }) → ChildProcess` — `stdio: ['pipe','pipe','pipe']`, `windowsHide: true`. `.cmd`/`.bat` → `spawn(shellLine(bin, args), { shell: true, … })`; `.js`/`.mjs` → `spawn(process.execPath, [bin, ...args], …)` (lets tests point `DESK_CLAUDE_BIN` at a Node script); otherwise `spawn(bin, args, …)`.
- `chatAgentStatus(state, agentId, now) → { ok, reason?, agent? }` — reasons, verbatim: `Chat is not turned on. Turn it on under Agents & MCP.` (no id or agent missing/purged), `The chat agent was disconnected. Turn chat on again under Agents & MCP.` (revoked), `The chat agent’s key has expired. Turn chat on again under Agents & MCP.`, `The chat agent’s access is Off. Change it under Agents & MCP.`; `ok: true` otherwise (with `paused: state.automationPaused`).

- [ ] **Step 1: Write the failing tests:**
  - `chat arguments allow only the desk and web tools` — args include `--strict-mcp-config`, `--tools` followed by `WebSearch,WebFetch`, `--allowedTools` followed by `mcp__swing-desk__*,WebSearch,WebFetch`, `--setting-sources` followed by `''`; `resume: false` → `--session-id`, `true` → `--resume`.
  - `the MCP config carries the key only in the server env` — `JSON.parse(mcpConfigJson({ key: 'sdk_x', dataDir: '/d' })).mcpServers['swing-desk'].env.SWING_DESK_AGENT_KEY === 'sdk_x'`; only one server.
  - `chat rules are a single line` — `!/\n/.test(CHAT_RULES)`.
  - `shellLine quotes every argument` — `shellLine('c.cmd', ['a b', 'x"y', ''])` → `"c.cmd" "a b" "x""y" ""`.
  - `chat agent status reasons` — none / revoked / expired (move clock) / scope off / ok, matching the copy above.
- [ ] **Step 2: Run** `node --test tests/chat-cli.test.js` — FAIL.
- [ ] **Step 3: Implement** `src/chat/cli.js` and the `shellLine` extraction.
- [ ] **Step 4: Run** the file — PASS; `npm test` — PASS (connect tests unchanged).
- [ ] **Step 5: Commit** `feat(chat): locked-down Claude Code arguments for the desk chat`

---

### Task 5: ChatManager (one process, one turn, limits)

**Files:**
- Create: `src/chat/manager.js`
- Test: `tests/chat-manager.test.js`

**Interfaces:**
- Consumes: Task 1 history, Task 2 `chatLimits/limitOn/stopMessage/stepLine`, Task 3 `notesSinceReply/correctionsBlock`, Task 4 `chatArgs/mcpConfigJson/spawnClaude/chatAgentStatus`.
- `new ChatManager(store, { bin, dataDir, spawn = spawnClaude, timers = { setTimeout, clearTimeout } })`
  - `rekey() → void` — if `store.secret('chat_agent')` names an agent, `this.#key = store.issueKey(id)`; closes any process. Called once at server start and after `chat.enable`.
  - `status() → { cli: boolean, agent: { ok, reason?, paused?, id?, name?, scope? }, active: threadId | null, limits, limitRules: CHAT_LIMITS }` — limits from `chatSetting(store, 'limits') ?? chatLimits()`.
  - `notify(message) → void` — emits `{ type: 'message', threadId: message.threadId, message }`; the server uses it for overrule notes.
  - `send({ threadId, text }) → { threadId }` — refusals (`UserError`): blank text `Type a message first.`; busy `Claude is still replying. Wait, or press Stop.`; no CLI `Claude Code is not installed on this computer. Install it and log in, then reload.`; agent not ok → its reason. Then: create the thread if `threadId` missing (title = text); save owner message; build prompt = `correctionsBlock(notesSinceReply(...)) + text`; if a process exists for another thread, close it; spawn when none (`--session-id` with `randomUUID()` saved by `setThreadSession`, or `--resume` with the saved id), `cwd` = `join(dataDir, 'chat')` (created); write `{"type":"user","message":{"role":"user","content":prompt}}\n` to stdin; start the turn and its timers.
  - `stop(reason = 'owner') → void` — ends the active turn: kills the child, saves any partial Claude text as a `claude` message, then a `note`: `You stopped this reply. Anything Claude already recorded is on the desk.` (owner) or `stopMessage(key, limits)` (limit).
  - `on(listener) → unsubscribe` — listener gets `{ type: 'text', threadId, text }`, `{ type: 'step', threadId, message, write }`, `{ type: 'message', threadId, message }` (any stored message), `{ type: 'end', threadId }`, `{ type: 'busy', threadId | null }`.
  - `close() → void` — kills the process and timers.
- Stream handling (newline-delimited JSON on stdout; ignore unparseable lines):
  - `stream_event` with `event.delta.type === 'text_delta'` → append to turn text, emit `text`.
  - `assistant` → `modelTurns += 1` (stop when on and exceeded); each `tool_use` block → `toolCalls += 1` (stop when on and exceeded), else store a `step` message from `stepLine` and emit `step`.
  - `result` → store the `claude` message (turn text, or `result.result` if no deltas came), `error` message when `is_error`, emit `end`, clear the reply timer, arm the idle timer (`idleMinutes`, when on).
  - Child `exit` during a turn → store `error`: `Claude stopped unexpectedly. Send your message again; earlier replies are kept.`, emit `end`. Never include stderr or arguments in messages or logs.
  - Reply timer: `replyMinutes` when on → `stop('replyMinutes')`.

- [ ] **Step 1: Write the failing tests** with a fake `spawn` returning `{ stdin: PassThrough, stdout: PassThrough, stderr: PassThrough, kill(), on('exit') }` (an `EventEmitter`) that records `args`; timers via `mock.timers.enable({ apis: ['setTimeout'] })` from `node:test`:
  - `a reply streams, is stored and ends the turn` — feed init, two `text_delta`s, `result` → listener saw two `text` and one `end`; messages `owner`,`claude` with joined text.
  - `tool use becomes a step line and marks desk writes` — `assistant` with a `tool_use` named `mcp__swing-desk__add_note` → `step` with `write: true`, stored role `step`.
  - `a second send while replying is refused` — throws `/still replying/`.
  - `stop kills the process and keeps partial text` — `kill` called; messages end with partial `claude` and the owner-stop note.
  - `reply time limit stops the turn when on and not when off` — tick 15 min → stopped with the pinned copy; with `off: ['replyMinutes']` → still active.
  - `tool-call and turn limits stop the turn` — `toolCalls: 1` and two tool uses → stopped; `modelTurns: 1` and two `assistant` lines → stopped.
  - `idle limit closes the process; next send resumes` — after `result`, tick 10 min → killed; next send's args contain `--resume` and the saved session id.
  - `resume passes saved session id` — a thread with `cliSessionId` set and no process → `--resume <id>`.
  - `sending in another thread closes the first process first` — first child's `kill` called before the second spawn.
  - `owner corrections are prepended once` — add a `note` to the thread, send → stdin line's content starts with `Owner corrections since your last reply:`; after the reply, next send has no block.
  - `process exit mid-turn ends the turn with an error` — emit `exit` → `error` stored, `status().active === null`.
  - `send refuses when no CLI` (`bin: null`) and `blank text is refused` — nothing spawned.
  - `the key never reaches messages or events` — collect every listener event and stored message; `JSON.stringify` of both does not include the key returned by a spied `store.issueKey`.
- [ ] **Step 2: Run** `node --test tests/chat-manager.test.js` — FAIL.
- [ ] **Step 3: Implement** `src/chat/manager.js`.
- [ ] **Step 4: Run** the file — PASS; `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(chat): one Claude process with streaming, stop and limits`

---

### Task 6: Owner API for chat

**Files:**
- Modify: `src/http/server.js`, `src/version.js` (`API_VERSION = 8`)
- Create: `tests/fixtures/fake-claude.mjs`
- Test: `tests/chat-http.test.js`; update the version assertion in `tests/http.test.js`

**Interfaces:**
- `createApp(store, { port, chat })` — `chat` is a `ChatManager`; when omitted, create `new ChatManager(store, { bin: null, dataDir: '' })` so existing tests keep working.
- Actions added to `ACTIONS` (POST `/api/action/<name>`; the spec's `POST /api/chat/send|stop|limits` live here so they reuse the Origin/CSRF/JSON checks):
  - `chat.enable` `[true]` — body `{ scope = 'propose', expiresDays = 365 }`: `C.addAgent` with `name: 'Desk chat'`, `client: 'Desk chat (built in)'`; `store.setSecret('chat_agent', id)`; `chat.rekey()`; returns `{ id }` only.
  - `chat.send` `[false]` → `chat.send(body)`
  - `chat.stop` `[false]` → `chat.stop('owner')`
  - `chat.limits` `[false]` → `setChatSetting(store, 'limits', chatLimits(body.limits))`, returns the saved limits.
  - `agent.rekey` refuses the chat agent: `UserError('The desk replaces the chat agent’s key itself. Turn chat on again to make a new one.')`.
- After every successful action, call `syncOverruleNotes(store)` (Task 3) and pass each posted message to `chat.notify(message)`.
- GET routes after the CSRF check:
  - `/api/chat/threads` → `{ threads: listThreads(store) }`
  - `/api/chat/threads/<id>` → `{ thread, messages }` (404 JSON when missing)
  - `/api/chat/stream` → `text/event-stream`, `data: <json>\n\n` per manager event, `: ping\n\n` every 25 s, unsubscribes on `close`. Browser reads it with `fetch` (EventSource cannot send `X-CSRF`).
- `stateView` gains `chat: chat.status()` (pass `chat` into `stateView`).
- `startServer` builds the manager with `findClaude()` and `dataDir()`, calls `rekey()`, and calls `close()` on server `close`.
- Fake CLI `tests/fixtures/fake-claude.mjs`: reads stdin lines; for each user message writes `system/init`, two `stream_event` text deltas echoing the first 20 chars of the prompt, one `assistant` with a `tool_use` `mcp__swing-desk__add_note`, then `result`. Env `FAKE_CLAUDE_HANG=1` → never sends `result`. Writes its argv to the file in `FAKE_CLAUDE_ARGS` when set (tests only check it, never print it).

- [ ] **Step 1: Write the failing tests** (`serve()` as in `tests/http.test.js`, plus `chat: new ChatManager(d.store, { bin: <fixture path>, dataDir: <temp dir> })` and `process.env.FAKE_CLAUDE_ARGS`):
  - `turn on chat returns no key and sets up the chat agent` — `chat.enable` with PIN → `result` has `id` and no `key`; state `chat.agent.ok === true`; `agent.rekey` for that id → 400.
  - `a message streams back and is saved` — open `/api/chat/stream` with `fetch` + `X-CSRF`, `chat.send` → stream yields `text` and `end`; `/api/chat/threads/<id>` has `owner`, `step`, `claude`.
  - `chat routes enforce CSRF and Origin` — stream and threads without `X-CSRF` → 403; `chat.send` with `Origin: https://evil.example` → 403.
  - `revoked chat agent: nothing spawned` — revoke via `agent.update`; `chat.send` → 400 with the disconnected copy; args file absent.
  - `a correction posts a note to the latest thread` — after one exchange, an agent quote corrected via `evidence.correct` → thread has a `note`.
  - `chat limits save and validate` — `chat.limits` `{ replyMinutes: 30, off: ['toolCalls'] }` → state shows them; `{ replyMinutes: 0 }` → 400.
  - `the agent key never leaves the server` — read the args file to get the key, then assert it appears in none of: `/api/state`, threads, thread messages, captured stream text.
  - `the state block reports a missing CLI` — app with default manager → `chat.cli === false`.
- [ ] **Step 2: Run** `node --test tests/chat-http.test.js` — FAIL.
- [ ] **Step 3: Implement** the server changes, version bump and fixture.
- [ ] **Step 4: Run** the file — PASS; `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(chat): owner API and live stream for the chat panel`

---

### Task 7: Chat panel in the browser

**Files:**
- Modify: `web/index.html` (add `<aside id="chat" class="chat" aria-label="Chat with Claude"></aside>` after `main`, inside `.shell`), `web/style.css`, `web/app.js`, `web/export-md.js`, `web/info.js` (help text for the chat-limit fields)
- Create: `web/chat.js`
- Test: `tests/markdown.test.js` (chat export)

**Interfaces:**
- `web/export-md.js`: `chatToMarkdown(thread, messages, { at }) → string` — `*Exported from Swing Desk on <at>*`, `# <title>`, then per message: owner `**You:** text`, claude `**Claude:**` + text, step `- <summary>` (italic), note `> Note: text`, error `> Error: text`; blank line between.
- `web/chat.js`: `initChat({ api, act, state: () => S, onDeskWrite })` — renders into `#chat` once; never touched by `render()`. Parts: header with thread switcher (`New chat` + earlier chats by title and India date), message list (`mdBlock` for Claude, `esc` for owner, muted step lines, distinct note/error style), composer (`textarea` with visible label, Enter sends, Shift+Enter newline, Send disabled while any turn runs, Stop shown while replying), `Export chat` button (downloads `chatToMarkdown` as `swing-desk-chat-<date>.md`). Status line uses `state().chat`: CLI missing → install hint; agent not ok → its reason + link `#/agents`; paused → `Agents are paused: Claude can talk but cannot use the desk.`. Stream: `fetch('/api/chat/stream', { headers: { 'X-CSRF': csrf } })` read with `getReader()`, reconnect after 3 s on drop. On `step` with `write`, call `onDeskWrite()` (debounced 1.5 s).
- `web/app.js`:
  - `CLIENT_API = 8`; import `initChat`; call it after the first `render()`; `onDeskWrite` = `refresh()` then `render()` unless the focus rule (`main form, main .verify`, `details[open]`) blocks it.
  - Agents page: a **Desk chat** card. When chat is off: Access select (default `propose`) + PIN + `Turn on chat` (`chat.enable`). When on: status line. Rekey button hidden in `agentRow` for `S.chat.agent.id`.
  - Agents page: a **Chat limits** form (`data-form="chat-limits"`) reusing the `LIMITS` number+On pattern with `CHAT_LIMITS`-shaped data from `S.chat.limits` (labels/min/max from `S.chat.limitRules`). No PIN. Submit → `chat.limits`.
- `web/style.css`: `.shell` gains the aside: `.chat { flex: 0 0 380px; position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--card); }`; `@media (max-width: 1100px)` → `.chat { flex: 1 1 100%; position: static; height: auto; max-height: 80vh; border-left: 0; border-top: 1px solid var(--line); }` so it sits below the page; message styles use existing tokens; no inline styles.

- [ ] **Step 1: Write the failing test** `chat export lists who said what` in `tests/markdown.test.js` — thread `{ title: 'Market today' }`, messages owner/claude/step/note/error → exact string from the format above.
- [ ] **Step 2: Run** `node --test tests/markdown.test.js` — FAIL.
- [ ] **Step 3: Implement** `chatToMarkdown`, `web/chat.js`, the HTML/CSS/app.js changes.
- [ ] **Step 4: Run** `npm test` — PASS; `node --check web/app.js` and `node --check web/chat.js` — no output.
- [ ] **Step 5: Commit** `feat(chat): docked chat panel with history, stop and export`

---

### Task 8: Browser check and docs

**Files:**
- Modify: `scripts/browser-check.mjs`, `README.md`, `AGENTS.md`

**Interfaces:**
- Consumes: Task 6 fixture, Task 7 DOM (`#chat`, its textarea, Send/Stop/Export chat buttons).

- [ ] **Step 1: Extend the browser check:** set `DESK_CLAUDE_BIN` to `tests/fixtures/fake-claude.mjs` in `env`; seed a chat agent in the seed store (`C.addAgent` `Desk chat`, `propose`, then `seed.setSecret('chat_agent', id)`). Assert: `#chat` present on Today and on a stock page (not redrawn: a typed draft survives a route change); type a message and press Enter → the Claude reply text appears and a step line shows; Send is disabled during the reply; `Export chat` exists; at 390 px the chat is below `main` and `document.documentElement.scrollWidth <= 390`; Tab from the last page control reaches the chat textarea; no console errors. Save `chat-<width>.png` screenshots when a shots folder is given.
- [ ] **Step 2: Run** `npm run test:browser -- <scratchpad>/shots` — Expected: `Browser check passed`. Look at `chat-1280.png` and `chat-390.png`.
- [ ] **Step 3: Docs:** README — a short "Chat with Claude" section (turn it on, limits, what Claude can and cannot do, the history stays on this computer). AGENTS.md — add `src/chat/` to the Architecture table (`Chat panel: CLI process manager, chat history (outside the event log), limits, overrule notes`) and a constraint line: `The chat agent's key exists only in server memory; never write it to disk, logs, responses or chat history.`
- [ ] **Step 4: Run** `npm test` and `node --check web/app.js` — PASS.
- [ ] **Step 5: Commit** `test(chat): browser check for the chat panel; docs`

---

## Manual check (owner)

With the real CLI: turn chat on, ask "how is the market today?", ask Claude to record one note for a stock, correct it on the desk, ask a follow-up, and check Claude mentions the correction. Confirm the stream-json event names match the installed CLI; if not, adjust only the parser in `src/chat/manager.js`.
