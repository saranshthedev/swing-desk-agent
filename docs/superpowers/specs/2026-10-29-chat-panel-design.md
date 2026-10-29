# Chat panel: talk to Claude inside the desk

Date: 2026-10-29. Status: approved by the owner.

## Intent

The owner wants one place to type: a Claude chat docked inside the desk. Everything else on the
desk is read-only Markdown with Verify, Correct, Approve and Reject. The owner asks things like
“how is the market today?”, “which stocks are good to build a position in?” or “research
TATAMOTORS”; Claude answers, does the research through the desk’s existing MCP tools and the
results appear on the desk next to the chat, waiting for the owner to verify or approve.

This replaces “open Claude Code in another window and talk to it there”. It does not replace the
desk’s gates: Claude in the chat is just another agent with its own key and access level.

## Goals

- A chat panel docked on the right of every desk page, always open (layout option A on the
  design canvas, https://claude.ai/artifact/SPQW8uzEGChv2RrsBgKwpL). On narrow screens (phone
  width) the chat moves below the page content.
- The desk server runs the owner’s locally installed Claude Code CLI as a child process and
  streams its replies to the browser. No API key, no paid service, no npm packages.
- Claude in the chat uses the swing-desk MCP tools (with its own agent key) plus web search and
  web fetch. Nothing else: no shell, no file reading or editing.
- Claude’s tool use shows in the chat as small step lines (“Added 4 evidence records”,
  “Proposed buy · Request #14”), and the desk page refreshes when Claude writes something.
- Chat history is saved in the database (its own tables, not the event log) and survives
  restarts. The owner can scroll back through earlier chats and start a new one.
- When the owner saves a correction with the existing Correct form, Claude learns about it on its
  next turn, so it stops repeating the old figure.

## Non-goals

- No other model apps in the panel for now (Codex, Gemini CLI). Keep the CLI wrapper small enough
  that one could be added later, but do not build the abstraction now.
- No attachments, images or file uploads in the chat.
- No interactive permission prompts. Claude gets a fixed tool list; anything outside it is simply
  unavailable.
- No Google sign-in or remote access. The desk stays on 127.0.0.1.

## Anti-goals (a failure even if it works)

- The chat can approve, reject, change agent access, edit strategies, playbooks or the PIN, or
  delete or rewrite events. These stay owner-only, outside MCP, exactly as today.
- Claude in the chat gets shell, file system or arbitrary MCP servers (for example the owner’s
  user-level MCP servers or project `.claude` settings leaking in).
- The agent key appears in a file on disk, in a log, in the browser, or in the chat history.
- Chat text reaches the event log’s hash chain.
- Another website can drive the chat (it must pass the same Host, Origin and CSRF checks as the
  rest of the owner API).

## Constraints (from AGENTS.md and the owner)

- Free and open source, Node 24 built-ins only, SQLite through the existing store.
- The desk never places, modifies or cancels broker orders.
- Agent text is untrusted data. Chat replies are rendered with the existing safe Markdown renderer
  (`web/markdown.js`), never as raw HTML.
- Plain language in UI text.
- The page and server contract: bump `API_VERSION` in `src/version.js` and `CLIENT_API` in
  `web/app.js` together, because the page will rely on new server endpoints.
- Privacy: tests use `:memory:` stores or temporary folders and a fake CLI, never the real data
  folder or a real Claude login.

## Decided with the owner

1. **Layout:** docked right, always open, on every page (option A).
2. **Only input:** the chat is the only place the owner types free text. Existing forms stay for
   now (other projects remove them); the Correct form stays as it is.
3. **Correct:** the owner edits as today. Saving a correction posts a line into the current chat,
   for example `You corrected TATAMOTORS · Overview: “[old]” → “[new]”`, and the next message sent
   to Claude starts with the corrections made since the owner’s previous message (including any
   saved while Claude was still replying).
4. **History:** saved in the database.
5. **Approve stays PIN-gated** on the desk; the chat never approves.
6. **One reply at a time across the whole desk.** Only one Claude session can be open at once, so
   at most one CLI child process exists at any time.
7. **Chat limits are configurable, each with an on/off switch**, like the agent limits (commit
   291a858). The reply time limit (15 minutes by default) is one of them. See “Chat limits”.
8. **Trash is manual only.** Moving a record to the Trash is never reported to Claude as a
   correction.

## How it works

### The chat agent

- A dedicated agent named “Desk chat”, created by the owner on the Agents & MCP page with a
  separate **Turn on chat** action (PIN needed). Its access level is chosen there like any agent;
  the page suggests **propose**, so Claude can send buy and exit ideas that the owner approves on
  the desk. Its quotas, expiry and audit trail work like every other agent’s.
- *Builder’s call, recorded here:* the existing `agent.add` and `agent.rekey` actions return the
  plain key to the browser, so the chat agent is never made through them. **Turn on chat** creates
  the agent through the same `addAgent` command (client `Desk chat (built in)`) and returns no key.
  Which agent is the chat agent is stored in the `secrets` table (name `chat_agent`), not in an
  event, so it can change. Only one chat agent at a time: turning chat on again after a revoke
  makes a new agent and points `chat_agent` at it. Rekey is hidden and refused for the chat agent
  (the server rotates its key itself). Old threads keep working under the new agent; a thread’s
  `agent_id` only records who replied then.
- Keys are stored only as hashes (`agent_keys`, one per agent). The server cannot read an old key,
  so **every time the server starts** (and when the chat agent is created or re-enabled) it issues
  a fresh key for the chat agent and keeps it in memory only. Issuing replaces the previous hash,
  so a key from an earlier run stops working.
- If the chat agent is missing, revoked, expired or set to Off, the panel says so in plain words
  and links to Agents & MCP. Pausing all agents also pauses the chat (Claude can still talk but its
  tools refuse, as they do today).

### Running the CLI

- Find the CLI with the existing `findClaude()` (`src/connect.js`). If it is not found, the panel
  explains how to install Claude Code and log in.
- One child process per active conversation, started with stream-json in and out, roughly:

  ```
  claude -p --input-format stream-json --output-format stream-json --verbose
    --strict-mcp-config --mcp-config <inline JSON>
    --tools WebSearch,WebFetch
    --allowedTools "mcp__swing-desk__*,WebSearch,WebFetch"
    --setting-sources ""            (no user/project settings, hooks or CLAUDE.md)
    --append-system-prompt <desk chat rules>
    --resume <session id>           (when continuing a saved conversation)
  ```

  Exact flags are for the builder to confirm against `claude --help` for the installed version;
  the requirements are: only the swing-desk MCP server, only those tools, no user or project
  settings or hooks, and conversations that can be resumed.
- The MCP server entry runs this checkout’s `bin/desk.js mcp` with `SWING_DESK_AGENT_KEY` (the
  in-memory key) and `SWING_DESK_DATA` (the server’s data folder) in its `env`. The config is
  passed inline, not written to a file. (It is visible to other processes of the same Windows user
  for the life of the child process; that is accepted for a single-user local app.)
- Windows: `.cmd`/`.bat` shims need the same careful quoting as `runClaude()`; prefer the
  `claude.exe` path.
- The desk chat rules (system prompt addition) say, in short: you are inside Swing Desk; the owner
  approves on the desk, never in the chat; use the swing-desk tools for anything you record; follow
  the research rule from the MCP server instructions; reply in plain language with rupees and India
  time; when you record something, say where on the desk it is.
- One turn at a time **across the whole desk**, and at most one child process at all (owner’s
  decision: only one Claude session can be open at once). While Claude is replying, Send is
  disabled in every thread and the switcher marks the replying thread; a **Stop** button ends the
  turn (kill the child process; the next message resumes the session). Sending in a different
  thread closes the current idle process first and starts that thread’s session with `--resume`.
- Idle conversations: the child process is closed after the idle limit (below) and resumed with
  `--resume` on the next message. The child process is closed when the server stops; a reply in
  progress is kept as far as it got, with an error asking the owner to send again.
- The session id is saved on the thread only when Claude Code reports it (its `system`/`init`
  event). A thread without one starts with a fresh `--session-id`, so a start that failed never
  leaves a session that cannot be resumed.
- Text from separate model messages (or text blocks) is joined with a blank line, so a stored reply
  never runs two sentences together.

### Chat limits

Set by the owner in a **Chat limits** card on the Agents & MCP page. Each limit has a number and
an on/off switch, following the agent-limit pattern: a switched-off limit is not enforced and its
number is kept for when it is switched back on.

| Limit | Default | What happens when reached |
|---|---|---|
| Reply time limit | 15 minutes, on | The turn is stopped (as with Stop). |
| Tool calls per reply | 60, on | The turn is stopped. |
| Claude turns per reply (`--max-turns`) | 40, on | The CLI ends the turn itself. |
| Close an idle session after | 10 minutes, on | The child process is closed; the next message resumes it. |

- When a limit stops a reply, the chat shows a plain note, for example “Stopped after 15 minutes
  (your reply time limit). Anything Claude already recorded is on the desk. Send ‘continue’ to
  carry on.” What Claude wrote before the stop stays saved.
- *Builder’s call:* the limits are stored with the chat tables (a `chat_settings` row), not in the
  event log, because they govern spending of the owner’s Claude allowance, not trading decisions.
  They change only through the owner API (Host, Origin and CSRF checks); no MCP tool reads or
  changes them, and no PIN is asked. A limit change applies from the next reply.
- *Builder’s call:* numbers are whole and within sane bounds (time 1–120 minutes, tool calls
  1–500, turns 1–200, idle 1–120 minutes); out-of-range values are refused with a plain message.

### Corrections reaching Claude

- When the owner overrules an agent, the server adds a `note` message to the most recent
  conversation. *Builder’s call on which actions count* (all are owner actions on something an
  agent wrote): correcting a record (old value, new value, reason); re-saving a Snapshot section
  over an agent’s version (section, what changed in one line); confirming an agent’s price or MTF
  requirement with a different value; flagging a record (reason); rejecting a request (reason).
  Verifying or confirming unchanged is agreement and makes no note. Moving a record to the Trash
  is manual housekeeping and makes no note (owner’s decision).
- When the owner next sends a message, the server prepends the notes posted since the owner’s
  previous message in that thread (stop and limit notices excluded), as a short block marked
  “Owner corrections since your last reply”, before the owner’s text. Notes saved while Claude is
  replying are therefore sent with the next message, and notes already sent are never sent twice,
  even when the turn was stopped. Claude sees them; the chat shows them as notes, not as owner
  messages.
- A tool call Claude Code reports as an error gets its own step line, `Refused: <first line of the
  reason>`. If the desk refused the agent key, the chat also shows one plain error per reply asking
  the owner to restart Swing Desk or turn chat on again.

### Storage

New tables in `desk.sqlite`, created by the store like the existing ones, outside the event log:

- `chat_threads`: id, title (first owner message, cut short), created_at, updated_at,
  cli_session_id (for `--resume`), agent_id.
- `chat_messages`: id, thread_id, at, role (`owner`, `claude`, `step`, `note`, `error`), text,
  and for steps the tool name and a one-line summary.

Messages are stored as they complete (the owner’s message at once; Claude’s reply when its turn
ends; steps as they happen). Text is capped (for example 20 000 characters per message). Chat
history is not hash-chained and can later get a delete option; the event log stays the record of
what was decided.

### Server API (owner API, same Host/Origin/CSRF checks)

- `GET /api/chat/threads` – list, newest first.
- `GET /api/chat/threads/:id` – its messages.
- `POST /api/chat/send` – `{ threadId?, text }`; starts a thread when `threadId` is missing.
- `POST /api/chat/stop` – `{ threadId }`.
- `GET /api/chat/stream?threadId=` – Server-Sent Events: text chunks, step lines, turn end,
  errors. CSP already allows `connect-src 'self'`.
- `POST /api/chat/limits` – `{ limits, off }`; same shape and switch pattern as agent limits.
- `GET /api/state` gains a small `chat` block: CLI found or not, chat agent status, active turn,
  chat limits.

### Browser

- The shell gains a right-hand `aside` next to `main` (both from `web/index.html`), so it stays
  open across route changes and is not redrawn by `render()`.
- Messages render with `mdBlock` (Claude) and plain escaped text (owner). Steps show as small
  muted lines. Notes about corrections show in a distinct style.
- A thread switcher (“New chat”, earlier chats by title and date).
- When a step reports a desk write, the page refreshes its state and redraws (respecting the
  existing rule of not redrawing while a form or open `details` has focus).
- The Export as Markdown button on a page exports the page only, not the chat. The chat gets its
  own “Export chat” button that saves the thread as Markdown.
- Keyboard: Enter sends, Shift+Enter makes a new line; focus order reaches the chat after the
  page; the panel has a visible label.

## Verification

- Unit/HTTP tests with a fake CLI (a small Node script set through `DESK_CLAUDE_BIN`) that emits
  stream-json lines: a reply streams through SSE; steps are stored; Stop kills the process;
  resume passes the saved session id; a correction note is prepended on the next send; CSRF and
  Origin are enforced; the agent key never appears in responses, stored messages or logs; with the
  chat agent revoked, the panel state says so and nothing is spawned; each chat limit stops a
  reply when on and does not when switched off; a second send while a reply runs is refused;
  sending in another thread closes the first process before spawning.
- Check that the spawned arguments include the strict MCP config, the tool lists and empty setting
  sources (test the argument builder directly).
- `npm test`, `node --check web/app.js`, `npm run test:browser` with the fake CLI: send a message,
  see the reply, the 390 px layout (chat below the page), keyboard focus, no console errors.
- One manual check with the real CLI on the owner’s machine, done by the owner.

## Left to the builder

- Exact CLI flags and the stream-json event shapes for the installed version.
- Module layout (for example `src/chat/` for the process manager and the store methods).
- How step lines summarise tool calls (map MCP tool names to plain phrases).
- Styling, within the existing design tokens.
