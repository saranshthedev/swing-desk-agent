// One Claude Code process for the whole desk, one turn at a time, with the owner's chat limits.
// The agent key lives only in this object and in the environment of the child process: never in
// arguments, messages, events or logs. Never log a child-process error object (it carries argv).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../core/settings.js';
import { addMessage, chatSetting, createThread, getThread, notesSinceOwner, setThreadSession } from './history.js';
import { CHAT_LIMITS, chatLimits, limitOn, stopMessage } from './limits.js';
import { refusedLine, resultText, stepLine } from './steps.js';
import { correctionsBlock } from './notes.js';
import { CHAT_KEY_ENV, chatAgentStatus, chatArgs, mcpConfigJson, spawnClaude } from './cli.js';

const OWNER_STOP = 'You stopped this reply. Anything Claude already recorded is on the desk.';
const UNEXPECTED = 'Claude stopped unexpectedly. Send your message again; earlier replies are kept.';
const FAILED = 'Claude could not finish this reply. Send your message again; earlier replies are kept.';
const CLOSED = 'The desk stopped while Claude was replying. Send your message again to continue.';
const MIN = 60_000;
const PARA = '\n\n';
const SIGN_IN = 'Claude could not sign in to the desk. Restart Swing Desk; if it keeps happening, turn chat on again under Agents & MCP.';

const defaultTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };

// A .cmd/.bat child runs under cmd.exe; killing only cmd.exe would leave Claude running.
function killChild(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill();
  } catch { /* already gone */ }
}

export class ChatManager {
  #store; #bin; #dataDir; #spawn; #timers;
  #key = null;
  #keyFor = null;
  #listeners = new Set();
  #proc = null; // { child, threadId, buf }
  #turn = null; // { threadId, text, toolCalls, modelTurns, seen, gap, tools, signInError, limits, timer }
  #idle = null;

  constructor(store, { bin, dataDir, spawn = spawnClaude, timers = defaultTimers } = {}) {
    this.#store = store;
    this.#bin = bin || null;
    this.#dataDir = dataDir;
    this.#spawn = spawn;
    this.#timers = timers;
  }

  rekey() {
    if (this.#turn) this.stop('owner');
    this.#closeProcess();
    const id = this.#store.secret('chat_agent');
    this.#key = id ? this.#store.issueKey(id) : null;
    this.#keyFor = this.#key ? id : null;
  }

  #agentStatus() {
    const id = this.#store.secret('chat_agent') || null;
    return this.#store.read((s, now) => chatAgentStatus(s, id, now));
  }

  #limits() {
    return chatSetting(this.#store, 'limits') ?? chatLimits();
  }

  status() {
    const a = this.#agentStatus();
    const agent = a.ok
      ? { ok: true, paused: a.paused, id: a.agent.id, name: a.agent.name, scope: a.agent.scope }
      : { ok: false, reason: a.reason };
    return { cli: Boolean(this.#bin), agent, active: this.#turn?.threadId ?? null, limits: this.#limits(), limitRules: CHAT_LIMITS };
  }

  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event) {
    for (const l of this.#listeners) {
      try { l(event); } catch { /* a broken listener must not break the turn */ }
    }
  }

  #save(threadId, msg) {
    const message = addMessage(this.#store, threadId, msg);
    this.#emit({ type: 'message', threadId, message });
    return message;
  }

  notify(message) {
    this.#emit({ type: 'message', threadId: message.threadId, message });
  }

  send({ threadId, text } = {}) {
    text = String(text ?? '').trim();
    if (!text) throw new UserError('Type a message first.');
    if (this.#turn) throw new UserError('Claude is still replying. Wait, or press Stop.');
    if (!this.#bin) throw new UserError('Claude Code is not installed on this computer. Install it and log in, then reload.');
    const agent = this.#agentStatus();
    if (!agent.ok) throw new UserError(agent.reason);
    if (!this.#key || this.#keyFor !== agent.agent.id) this.rekey();

    let thread = threadId ? getThread(this.#store, threadId) : null;
    if (threadId && !thread) throw new UserError('That chat was not found.');
    if (!thread) thread = createThread(this.#store, { title: text, agentId: agent.agent.id });
    const id = thread.id;

    // Read before saving this message: corrections are the notes since the owner's previous one.
    const notes = notesSinceOwner(this.#store, id);
    this.#save(id, { role: 'owner', text });
    const prompt = correctionsBlock(notes) + text;

    if (this.#proc && this.#proc.threadId !== id) this.#closeProcess();
    this.#clearIdle();
    if (!this.#proc) {
      try {
        this.#start(thread);
      } catch {
        // Never surface the raw error: it can carry arguments.
        this.#proc = null;
        this.#save(id, { role: 'error', text: UNEXPECTED });
        throw new UserError(UNEXPECTED);
      }
    }

    const limits = this.#limits();
    this.#turn = { threadId: id, text: '', toolCalls: 0, modelTurns: 0, seen: new Set(), gap: false, tools: new Map(), signInError: false, limits, timer: null };
    if (limitOn(limits, 'replyMinutes')) {
      this.#turn.timer = this.#timers.setTimeout(() => this.stop('replyMinutes'), limits.replyMinutes * MIN);
    }
    this.#emit({ type: 'busy', threadId: id });
    try {
      this.#proc.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    } catch {
      this.#fail(UNEXPECTED);
    }
    return { threadId: id };
  }

  #start(thread) {
    // A session is saved only when Claude Code reports it (system/init), so a start that fails
    // before then leaves nothing to resume: the next send starts a fresh session.
    const resume = Boolean(thread.cliSessionId);
    const sessionId = resume ? thread.cliSessionId : randomUUID();
    const cwd = join(this.#dataDir, 'chat');
    mkdirSync(cwd, { recursive: true });
    const args = chatArgs({ mcpConfig: mcpConfigJson({ dataDir: this.#dataDir }), sessionId, resume });
    const child = this.#spawn(this.#bin, args, { cwd, env: { ...process.env, [CHAT_KEY_ENV]: this.#key } });
    const proc = { child, threadId: thread.id, buf: '' };
    this.#proc = proc;
    child.stdin?.on('error', () => { /* the close handler reports it */ });
    child.stderr?.resume(); // drained, never read: it may echo arguments
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => this.#onData(proc, chunk));
    // 'close' comes after stdout is drained, so the final deltas and result are not lost.
    child.on('close', () => this.#onGone(proc));
    child.on('error', (err) => {
      if (err?.code) console.error(`Desk chat: Claude Code could not run (${err.code}).`);
      this.#onGone(proc);
    });
  }

  #onGone(proc) {
    if (this.#proc !== proc) return;
    this.#proc = null;
    this.#clearIdle();
    if (this.#turn) this.#fail(UNEXPECTED);
  }

  #onData(proc, chunk) {
    if (this.#proc !== proc) return;
    proc.buf += String(chunk);
    let nl;
    while ((nl = proc.buf.indexOf('\n')) !== -1) {
      const line = proc.buf.slice(0, nl).trim();
      proc.buf = proc.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.#onLine(proc, msg);
      if (this.#proc !== proc) return;
    }
  }

  #onLine(proc, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
      const thread = getThread(this.#store, proc.threadId);
      if (thread && thread.cliSessionId !== msg.session_id) setThreadSession(this.#store, proc.threadId, msg.session_id);
      return;
    }
    const turn = this.#turn;
    if (!turn) return;
    const { threadId, limits } = turn;
    if (msg.type === 'stream_event') {
      const ev = msg.event;
      // A new model message or text block starts a new paragraph, so replies do not run together.
      if (ev?.type === 'message_start' || (ev?.type === 'content_block_start' && ev.content_block?.type === 'text')) turn.gap = true;
      const d = ev?.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        if (turn.gap && turn.text && !turn.text.endsWith(PARA)) {
          turn.text += PARA;
          this.#emit({ type: 'text', threadId, text: PARA });
        }
        turn.gap = false;
        turn.text += d.text;
        this.#emit({ type: 'text', threadId, text: d.text });
      }
    } else if (msg.type === 'assistant') {
      // The CLI may send one assistant event per content block of the same model message.
      const mid = msg.message?.id;
      const fresh = typeof mid !== 'string' || !turn.seen.has(mid);
      if (typeof mid === 'string') turn.seen.add(mid);
      if (fresh) turn.modelTurns += 1;
      if (fresh && limitOn(limits, 'modelTurns') && turn.modelTurns > limits.modelTurns) return this.stop('modelTurns');
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        turn.toolCalls += 1;
        if (limitOn(limits, 'toolCalls') && turn.toolCalls > limits.toolCalls) return this.stop('toolCalls');
        if (typeof block.id === 'string') turn.tools.set(block.id, block.name);
        const step = stepLine(block.name, block.input);
        const message = addMessage(this.#store, threadId, { role: 'step', text: step.summary, tool: step.tool, summary: step.summary });
        this.#emit({ type: 'step', threadId, message, write: step.write });
      }
    } else if (msg.type === 'user') {
      // Tool results: a refused call gets its own step line, so the earlier one is not read as done.
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const block of content) {
        if (block?.type !== 'tool_result' || block.is_error !== true) continue;
        const raw = this.#hideKey(resultText(block.content));
        const text = refusedLine(raw);
        const tool = turn.tools.get(block.tool_use_id) ?? null;
        const message = addMessage(this.#store, threadId, { role: 'step', text, tool, summary: text });
        this.#emit({ type: 'step', threadId, message, write: false });
        if (!turn.signInError && raw.includes('No valid agent key')) {
          turn.signInError = true;
          this.#save(threadId, { role: 'error', text: SIGN_IN });
        }
      }
    } else if (msg.type === 'result') {
      const text = turn.text || (!msg.is_error && typeof msg.result === 'string' ? msg.result : '');
      if (text.trim()) this.#save(threadId, { role: 'claude', text });
      if (msg.is_error) this.#save(threadId, { role: 'error', text: FAILED });
      this.#endTurn();
      const idle = this.#limits();
      if (limitOn(idle, 'idleMinutes')) this.#idle = this.#timers.setTimeout(() => { this.#idle = null; this.#closeProcess(); }, idle.idleMinutes * MIN);
    }
  }

  // Tool output is untrusted text; it must never carry the agent key into history.
  #hideKey(text) {
    return this.#key ? text.split(this.#key).join('[hidden]') : text;
  }

  stop(reason = 'owner') {
    const turn = this.#turn;
    if (!turn) return;
    this.#closeProcess(); // detaches the process first, so its exit is not an unexpected stop
    if (turn.text.trim()) this.#save(turn.threadId, { role: 'claude', text: turn.text });
    this.#save(turn.threadId, { role: 'note', tool: 'stop', text: reason === 'owner' ? OWNER_STOP : stopMessage(reason, turn.limits) });
    this.#endTurn();
  }

  #fail(text) {
    const turn = this.#turn;
    if (!turn) return;
    if (turn.text.trim()) this.#save(turn.threadId, { role: 'claude', text: turn.text });
    this.#save(turn.threadId, { role: 'error', text });
    this.#endTurn();
  }

  #endTurn() {
    const turn = this.#turn;
    if (!turn) return;
    if (turn.timer) this.#timers.clearTimeout(turn.timer);
    this.#turn = null;
    this.#emit({ type: 'end', threadId: turn.threadId });
    this.#emit({ type: 'busy', threadId: null });
  }

  #clearIdle() {
    if (this.#idle) this.#timers.clearTimeout(this.#idle);
    this.#idle = null;
  }

  #closeProcess() {
    this.#clearIdle();
    const proc = this.#proc;
    if (!proc) return;
    this.#proc = null;
    killChild(proc.child);
  }

  close() {
    this.#closeProcess(); // detached first, so its exit is not reported as unexpected
    // Keeps any partial reply. The store may already be closed at process exit.
    try { this.#fail(CLOSED); } catch { /* nothing more to save */ }
    if (this.#turn?.timer) this.#timers.clearTimeout(this.#turn.timer);
    this.#turn = null;
  }
}
