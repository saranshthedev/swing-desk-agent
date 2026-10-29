// Chat history lives in its own tables, outside the hash-chained event log.
import { newId } from '../store/store.js';
import { UserError } from '../core/settings.js';

const ROLES = ['owner', 'claude', 'step', 'note', 'error'];
const cap = (t) => String(t ?? '').slice(0, 20_000);
const iso = (store) => new Date(store.clock()).toISOString();

const thread = (r) => r && ({
  id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at,
  cliSessionId: r.cli_session_id, agentId: r.agent_id,
});
const message = (r) => ({
  id: r.id, threadId: r.thread_id, at: r.at, role: r.role, text: r.text, tool: r.tool, summary: r.summary,
});

export function createThread(store, { title, agentId } = {}) {
  const id = newId('chat');
  const at = iso(store);
  store.db.prepare('INSERT INTO chat_threads (id, title, created_at, updated_at, agent_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, String(title ?? '').slice(0, 80), at, at, agentId ?? null);
  return getThread(store, id);
}

export function listThreads(store) {
  return store.db.prepare('SELECT * FROM chat_threads ORDER BY updated_at DESC, rowid DESC LIMIT 200').all().map(thread);
}

export function getThread(store, id) {
  return thread(store.db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id)) ?? null;
}

export function setThreadSession(store, id, cliSessionId) {
  store.db.prepare('UPDATE chat_threads SET cli_session_id = ? WHERE id = ?').run(cliSessionId ?? null, id);
}

export function addMessage(store, threadId, { role, text, tool, summary }) {
  if (!ROLES.includes(role)) throw new UserError(`Unknown chat role "${role}".`);
  const at = iso(store);
  const { lastInsertRowid } = store.db.prepare(
    'INSERT INTO chat_messages (thread_id, at, role, text, tool, summary) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(threadId, at, role, cap(text), tool ?? null, summary == null ? null : cap(summary));
  store.db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(at, threadId);
  return message(store.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(lastInsertRowid));
}

export function messages(store, threadId) {
  return store.db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id').all(threadId).map(message);
}

/** Notes added after Claude's latest reply. */
export function notesSinceReply(store, threadId) {
  return store.db.prepare(`SELECT * FROM chat_messages WHERE thread_id = ? AND role = 'note'
    AND id > COALESCE((SELECT MAX(id) FROM chat_messages WHERE thread_id = ? AND role = 'claude'), 0) ORDER BY id`)
    .all(threadId, threadId).map(message);
}

export function chatSetting(store, name) {
  const r = store.db.prepare('SELECT value FROM chat_settings WHERE name = ?').get(name);
  return r ? JSON.parse(r.value) : null;
}

export function setChatSetting(store, name, value) {
  store.db.prepare('INSERT INTO chat_settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
    .run(name, JSON.stringify(value));
}
