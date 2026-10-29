// The chat with Claude, docked beside every page. Drawn once into #chat; render() never touches
// it, so a typed message and the open chat survive moving between pages.
// Owner text is escaped; Claude text goes through mdBlock, which escapes everything first.

import { mdBlock } from './markdown.js';
import { chatToMarkdown, shortTitle } from './export-md.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
const day = (iso) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30_000;
const DESK_WRITE_MS = 1500;

/**
 * Start the chat panel.
 * api(path, init) and toast(text, bad) come from app.js; state() returns the latest /api/state;
 * csrf() the session token for the stream; onDeskWrite() refreshes and redraws the page.
 * Returns { update } for app.js to call after every refresh.
 */
export function initChat({ api, state, csrf, renewCsrf = async () => {}, onDeskWrite, toast = () => {} }) {
  const root = document.getElementById('chat');
  root.innerHTML = `
    <div class="chat-head">
      <h2 id="chat-heading">Chat with Claude</h2>
      <div class="chat-tools">
        <label class="visually-hidden" for="chat-thread">Choose a chat</label>
        <select id="chat-thread"></select>
        <button type="button" class="btn" data-chat="export">Export chat</button>
      </div>
      <p class="chat-status small" id="chat-status"></p>
      <p class="chat-status small bad" id="chat-conn" role="status"></p>
    </div>
    <div class="chat-log" id="chat-log" role="log" aria-labelledby="chat-heading"></div>
    <form class="chat-compose" id="chat-form">
      <label for="chat-text">Message Claude</label>
      <textarea id="chat-text" name="text" rows="3" placeholder="Ask about a stock, your plans or the market"></textarea>
      <p class="chat-error small" id="chat-error" role="alert" hidden></p>
      <div class="chat-actions">
        <button type="submit" class="btn primary" id="chat-send">Send</button>
        <button type="button" class="btn danger" data-chat="stop" id="chat-stop" hidden>Stop</button>
        <small class="muted">Enter sends. Shift+Enter starts a new line.</small>
      </div>
    </form>`;

  const $ = (id) => document.getElementById(id);
  const log = $('chat-log'), picker = $('chat-thread'), form = $('chat-form'), text = $('chat-text');
  const sendBtn = $('chat-send'), stopBtn = $('chat-stop'), errorLine = $('chat-error');

  let threads = [];
  let threadId = null; // null = a new chat, made by the first message
  let thread = null;
  let shown = []; // stored messages of the open thread
  let seen = new Set(); // their ids, so a message from the stream and from a reload shows once
  let live = null; // { el, text }: the Claude bubble text chunks go into now
  let lives = []; // every unsaved streamed bubble of the current reply
  let loadSeq = 0; // only the newest thread load is drawn
  let busy = state()?.chat?.active ?? null; // the thread Claude is replying in, or null
  let sending = false;
  let endedWhileSending = new Set(); // threads whose reply ended before the send request returned
  let pickerStale = false; // a refresh came while the chat list was open
  let deskTimer = null;

  const deskWrite = () => {
    clearTimeout(deskTimer);
    deskTimer = setTimeout(onDeskWrite, DESK_WRITE_MS);
  };

  function showError(message) {
    errorLine.textContent = message ?? '';
    errorLine.hidden = !message;
  }

  function syncButtons() {
    sendBtn.disabled = sending || busy !== null;
    stopBtn.hidden = busy === null;
  }

  function statusHtml() {
    const c = state()?.chat;
    if (!c) return 'Restart Swing Desk to use the chat.';
    if (!c.cli) return 'Claude Code is not installed on this computer. Install it, sign in once, then restart Swing Desk.';
    if (!c.agent.ok) return `${esc(c.agent.reason)} <a href="#/agents">Open Agents &amp; MCP</a>`;
    if (c.agent.paused) return 'Agents are paused: Claude can talk but cannot use the desk.';
    return `Claude can use the desk with <b>${esc(c.agent.scope)}</b> access. You still approve every trade.`;
  }

  function update() {
    $('chat-status').innerHTML = statusHtml();
    const active = state()?.chat?.active;
    if (active !== undefined) busy = active;
    syncButtons();
    drawPicker();
  }

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const toBottom = (stick) => { if (stick) log.scrollTop = log.scrollHeight; };

  function messageEl(m) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-${m.role}${m.role === 'note' && m.tool === 'stop' ? ' chat-stop' : ''}`;
    if (m.role === 'owner') el.innerHTML = `<div class="chat-who">You</div><div class="pre">${esc(m.text)}</div>`;
    else if (m.role === 'claude') el.innerHTML = `<div class="chat-who">Claude</div><div class="md">${mdBlock(m.text)}</div>`;
    else if (m.role === 'step') el.textContent = m.summary || m.tool || '';
    else if (m.role === 'note') el.innerHTML = `<b>Note:</b> <span class="pre">${esc(m.text)}</span>`;
    else el.innerHTML = `<b>Error:</b> <span class="pre">${esc(m.text)}</span>`;
    if (m.at) el.title = when(m.at);
    return el;
  }

  function add(m) {
    if (!m || (m.id && seen.has(m.id))) return;
    if (m.id) seen.add(m.id);
    shown.push(m);
    const stick = nearBottom();
    // A stored Claude reply replaces the bubbles that streamed it.
    if (m.role === 'claude') dropLive();
    log.querySelector('.chat-empty')?.remove();
    log.append(messageEl(m));
    toBottom(stick);
  }

  function appendText(chunk) {
    const stick = nearBottom();
    if (!live) {
      const el = document.createElement('div');
      el.className = 'chat-msg chat-claude';
      el.innerHTML = '<div class="chat-who">Claude</div><div class="md"></div>';
      log.querySelector('.chat-empty')?.remove();
      log.append(el);
      live = { el, text: '' };
      lives.push(live);
    }
    log.setAttribute('aria-busy', 'true');
    live.text += chunk;
    live.el.querySelector('.md').innerHTML = mdBlock(live.text);
    toBottom(stick);
  }

  function dropLive() {
    for (const l of lives) l.el.remove();
    lives = [];
    live = null;
  }

  function drawLog() {
    log.replaceChildren();
    // Keep a reply that is still streaming into this thread; anything else is stale.
    if (busy === null || busy !== threadId) { lives = []; live = null; log.removeAttribute('aria-busy'); }
    if (!shown.length && !lives.length) {
      log.innerHTML = '<p class="muted small chat-empty">Ask Claude to research a stock, check your plans or explain a rule. What it records shows on the desk as not verified until you check it.</p>';
      return;
    }
    for (const m of shown) log.append(messageEl(m));
    for (const l of lives) log.append(l.el);
    log.scrollTop = log.scrollHeight;
  }

  function drawPicker() {
    // Rebuilding the options would close the list the owner has open: redraw when it loses focus.
    if (document.activeElement === picker) { pickerStale = true; return; }
    pickerStale = false;
    picker.innerHTML = `<option value="">New chat</option>${threads.map((t) => `<option value="${esc(t.id)}">${esc(shortTitle(t.title))} · ${esc(day(t.updatedAt || t.createdAt))}${t.id === busy ? ' · replying' : ''}</option>`).join('')}`;
    picker.value = threadId ?? '';
  }

  async function loadThreads() {
    try { threads = (await api('/api/chat/threads')).threads ?? []; } catch { threads = []; }
    drawPicker();
  }

  async function loadThread() {
    const id = threadId;
    const seq = ++loadSeq;
    if (!id) { thread = null; shown = []; seen = new Set(); drawLog(); return; }
    try {
      const r = await api(`/api/chat/threads/${encodeURIComponent(id)}`);
      if (seq !== loadSeq || id !== threadId) return; // a newer load or another chat came first
      thread = r.thread;
      shown = r.messages ?? [];
      seen = new Set(shown.map((m) => m.id));
      drawLog();
    } catch (err) {
      showError(err.message);
    }
  }

  function onEvent(ev) {
    if (ev.type === 'busy') {
      busy = ev.threadId ?? null;
      if (busy === null) log.removeAttribute('aria-busy');
      syncButtons();
      drawPicker();
      return;
    }
    if (ev.type === 'step' && ev.write) deskWrite();
    if (ev.type === 'end') {
      if (sending) endedWhileSending.add(ev.threadId);
      if (busy === ev.threadId) busy = null;
      // The streamed bubbles stay until the reload below draws the stored reply in their place.
      if (ev.threadId === threadId) { log.removeAttribute('aria-busy'); live = null; }
      syncButtons();
      drawPicker();
      deskWrite(); // covers tools that change the desk without a write flag
      loadThreads();
      if (ev.threadId === threadId) loadThread();
      return;
    }
    if (ev.threadId !== threadId) return;
    if (ev.type === 'text') appendText(String(ev.text ?? ''));
    if (ev.type === 'step') { live = null; add(ev.message); }
    if (ev.type === 'message') add(ev.message);
  }

  function frames(chunk, state) {
    state.buf += chunk.replace(/\r\n/g, '\n');
    let i;
    while ((i = state.buf.indexOf('\n\n')) >= 0) {
      const frame = state.buf.slice(0, i);
      state.buf = state.buf.slice(i + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue; // ": ping"
      try { onEvent(JSON.parse(data)); } catch { /* skip a bad frame */ }
    }
  }

  async function listen() {
    let first = true;
    let failures = 0;
    for (;;) {
      try {
        const res = await fetch('/api/chat/stream', { headers: { 'X-CSRF': csrf() } });
        // A refused token means the desk restarted: get a new one before the next try.
        if (res.status === 403) { try { await renewCsrf(); } catch { /* desk still down */ } }
        if (!res.ok || !res.body) throw new Error('stream refused');
        failures = 0;
        $('chat-conn').textContent = '';
        if (!first) {
          // Catch up on anything sent while the stream was down.
          try { busy = (await api('/api/state')).chat?.active ?? null; } catch { /* keep */ }
          syncButtons();
          loadThreads();
          loadThread();
        }
        first = false;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        const st = { buf: '' };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          frames(value, st);
        }
      } catch { /* desk stopped or restarting: try again below */ }
      first = false;
      failures += 1;
      if (failures >= 3) $('chat-conn').textContent = 'Lost the live connection to the desk. Reload the page.';
      // 3 s, 6 s, 12 s, 24 s, then every 30 s.
      await new Promise((r) => setTimeout(r, Math.min(RECONNECT_MS * 2 ** (failures - 1), MAX_RECONNECT_MS)));
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = text.value.trim();
    if (!message || sending || busy !== null) return;
    sending = true;
    endedWhileSending = new Set();
    syncButtons();
    showError('');
    try {
      const out = await api('/api/action/chat.send', { method: 'POST', body: JSON.stringify({ threadId: threadId ?? undefined, text: message }) });
      text.value = '';
      const id = out.result?.threadId ?? threadId;
      // A short reply can end before this request returns; then Send must stay enabled.
      if (!endedWhileSending.has(id)) busy = id;
      if (id !== threadId) { threadId = id; await loadThreads(); }
      await loadThread();
    } catch (err) {
      showError(err.message);
    } finally {
      sending = false;
      syncButtons();
    }
  });

  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  picker.addEventListener('blur', () => { if (pickerStale) drawPicker(); });

  picker.addEventListener('change', () => {
    threadId = picker.value || null;
    showError('');
    loadThread();
  });

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-chat]');
    if (!el) return;
    if (el.dataset.chat === 'stop') {
      el.disabled = true;
      try { await api('/api/action/chat.stop', { method: 'POST', body: JSON.stringify({}) }); } catch (err) { showError(err.message); }
      el.disabled = false;
    }
    if (el.dataset.chat === 'export') {
      if (!thread || !shown.length) { toast('Nothing to export yet. Pick a chat first.', true); return; }
      const md = chatToMarkdown(thread, shown, { at: when(new Date().toISOString()) });
      const name = `swing-desk-chat-${indiaToday()}.md`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(`Saved ${name} to your downloads.`);
    }
  });

  update();
  (async () => {
    await loadThreads();
    threadId = busy ?? threads[0]?.id ?? null;
    picker.value = threadId ?? '';
    await loadThread();
  })();
  listen();

  return { update };
}
