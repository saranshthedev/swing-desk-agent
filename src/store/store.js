// SQLite-backed append-only event log. Each event's hash covers the previous hash, so any
// edit to history is detectable with `verify()`. Secrets (PIN hash, agent key hashes) and the
// per-call audit live in separate tables, outside the event log and outside exports.
//
// Several processes (the web server and each MCP client) share one database file. Every
// write runs in BEGIN IMMEDIATE, first catching up on events other processes appended, so
// commands always validate against the latest state.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { initialState, apply } from '../core/state.js';
import { UserError } from '../core/settings.js';

const GENESIS = 'genesis';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const eventHash = (prev, seq, at, actor, type, dataText) => sha256([prev, seq, at, actor, type, dataText].join('\n'));

export class Store {
  constructor(file, { clock = () => Date.now() } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.file = file;
    this.clock = clock;
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL,
        data TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_keys (agent_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, agent_id TEXT NOT NULL,
        tool TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS calls_agent_at ON calls(agent_id, at);
      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        cli_session_id TEXT, agent_id TEXT);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, at TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, tool TEXT, summary TEXT);
      CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages(thread_id, id);
      CREATE TABLE IF NOT EXISTS chat_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.state = initialState();
    this.lastHash = GENESIS;
    this.catchUp();
  }

  catchUp() {
    const rows = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(this.state.seq);
    for (const row of rows) {
      apply(this.state, { seq: row.seq, at: row.at, actor: row.actor, type: row.type, data: JSON.parse(row.data) });
      this.lastHash = row.hash;
    }
    return this.state;
  }

  /** Read the latest state. */
  read(fn) {
    this.catchUp();
    return fn(this.state, this.clock());
  }

  /**
   * Run a command and append its events atomically.
   * `fn(state, ctx)` returns `{ events: [{type, data}], result }` and must not mutate state.
   */
  run(actor, fn) {
    this.db.exec('BEGIN IMMEDIATE');
    let out;
    const appended = [];
    try {
      this.catchUp();
      const now = this.clock();
      out = fn(this.state, { actor, now, newId }) ?? { events: [] };
      const at = new Date(now).toISOString();
      const insert = this.db.prepare('INSERT INTO events (seq, at, actor, type, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
      let prev = this.lastHash;
      let seq = this.state.seq;
      for (const e of out.events ?? []) {
        seq += 1;
        const dataText = JSON.stringify(e.data ?? {});
        const hash = eventHash(prev, seq, at, actor, e.type, dataText);
        insert.run(seq, at, actor, e.type, dataText, prev, hash);
        appended.push({ seq, at, actor, type: e.type, data: JSON.parse(dataText), hash });
        prev = hash;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    for (const e of appended) {
      apply(this.state, e);
      this.lastHash = e.hash;
    }
    return out.result;
  }

  events({ before, limit = 100 } = {}) {
    const max = Math.max(1, Math.min(500, limit));
    const rows = before
      ? this.db.prepare('SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(before, max)
      : this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(max);
    return rows.map(eventRow);
  }

  /** Events with a seq greater than `seq`, oldest first. */
  eventsAfter(seq) {
    return this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(seq).map(eventRow);
  }

  /** Recompute the whole hash chain. Returns { ok, count, brokenAt? }. */
  verify() {
    let prev = GENESIS;
    let count = 0;
    for (const r of this.db.prepare('SELECT * FROM events ORDER BY seq').iterate()) {
      count += 1;
      if (r.seq !== count || r.prev_hash !== prev || eventHash(prev, r.seq, r.at, r.actor, r.type, r.data) !== r.hash) {
        return { ok: false, count, brokenAt: r.seq };
      }
      prev = r.hash;
    }
    return { ok: true, count, head: prev };
  }

  /** Consistent copy of the whole database, safe while other processes write. */
  backup(target) {
    mkdirSync(dirname(target), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(target);
    return target;
  }

  // ---------- approval PIN ----------

  hasPin() {
    return !!this.secret('pin');
  }

  setPin(newPin, oldPin) {
    if (this.hasPin()) this.checkPin(oldPin);
    if (!/^\d{6,12}$/.test(String(newPin ?? ''))) throw new UserError('Use a PIN of 6 to 12 digits.');
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(String(newPin), salt, 32).toString('hex');
    this.setSecret('pin', JSON.stringify({ salt, hash }));
    this.setSecret('pin_failures', JSON.stringify({ count: 0, lockedUntil: 0 }));
    this.run('owner', () => ({ events: [{ type: 'pin.changed', data: {} }] }));
  }

  /** Throws unless `pin` is correct. Five wrong tries lock approvals for 15 minutes. */
  checkPin(pin) {
    const stored = this.secret('pin');
    if (!stored) throw new UserError('Set an approval PIN first (Settings).');
    const failures = JSON.parse(this.secret('pin_failures') ?? '{"count":0,"lockedUntil":0}');
    const now = this.clock();
    if (failures.lockedUntil > now) throw new UserError(`Too many wrong PINs. Try again after ${new Date(failures.lockedUntil).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`);
    const { salt, hash } = JSON.parse(stored);
    const given = scryptSync(String(pin ?? ''), salt, 32);
    if (!timingSafeEqual(given, Buffer.from(hash, 'hex'))) {
      const count = failures.count + 1;
      this.setSecret('pin_failures', JSON.stringify({ count: count >= 5 ? 0 : count, lockedUntil: count >= 5 ? now + 15 * 60_000 : 0 }));
      throw new UserError('Wrong PIN.');
    }
    this.setSecret('pin_failures', JSON.stringify({ count: 0, lockedUntil: 0 }));
  }

  // ---------- agent keys ----------

  /** Create (or replace) an agent's key. The plain key is returned once and never stored. */
  issueKey(agentId) {
    const secret = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO agent_keys (agent_id, key_hash) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET key_hash = excluded.key_hash').run(agentId, sha256(secret));
    return `sdk_${agentId}_${secret}`;
  }

  /** The agent id a key belongs to, or null. */
  identify(key) {
    const m = /^sdk_(agent_[a-f0-9]+)_([A-Za-z0-9_-]{32})$/.exec(String(key ?? ''));
    if (!m) return null;
    const row = this.db.prepare('SELECT key_hash FROM agent_keys WHERE agent_id = ?').get(m[1]);
    if (!row) return null;
    const ok = timingSafeEqual(Buffer.from(sha256(m[2]), 'hex'), Buffer.from(row.key_hash, 'hex'));
    return ok ? m[1] : null;
  }

  logCall(agentId, tool, ok, error) {
    this.db.prepare('INSERT INTO calls (at, agent_id, tool, ok, error) VALUES (?, ?, ?, ?, ?)').run(new Date(this.clock()).toISOString(), agentId, tool, ok ? 1 : 0, error ?? null);
  }

  callsSince(agentId, sinceMs) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE agent_id = ? AND at >= ?').get(agentId, new Date(sinceMs).toISOString()).n;
  }

  recentCalls(limit = 50) {
    return this.db.prepare('SELECT * FROM calls ORDER BY id DESC LIMIT ?').all(Math.min(500, limit));
  }

  secret(name) {
    return this.db.prepare('SELECT value FROM secrets WHERE name = ?').get(name)?.value ?? null;
  }

  setSecret(name, value) {
    this.db.prepare('INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
  }

  close() {
    this.db.close();
  }
}

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

const eventRow = (r) => ({ seq: r.seq, at: r.at, actor: r.actor, type: r.type, data: JSON.parse(r.data), hash: r.hash });
