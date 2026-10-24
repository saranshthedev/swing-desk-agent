import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { researchStatus, evaluate } from '../src/core/rules.js';
import { isExchangeBound } from '../src/core/strategies.js';
import { createHandler } from '../src/mcp/server.js';
import { desk, PLAN, readyEvidence } from './helpers.js';

const DAY = 86_400_000;
const find = (r, id) => r.checks.find((c) => c.id === id);

/** A price record saved before records carried an exchange: no exchange field at all. */
function legacy(d, actor, kind = 'candles') {
  const id = 'ev-legacy';
  d.store.run(actor, (s, ctx) => ({ events: [{ type: 'evidence.added', data: {
    id, kind, symbol: 'ABC', observedAt: new Date(ctx.now).toISOString(), summary: 'old chart', sources: [],
    ...(actor === 'owner' ? { goodUntil: '2026-11-30' } : {}),
  } }] }));
  return id;
}

test('a legacy price record with no exchange cannot be verified', () => {
  const d = desk();
  const id = legacy(d, 'agent:x');
  assert.throws(() => d.owner(C.verifyEvidence, { id }), /say the exchange/i);
});

test('a legacy price record cannot back marks on NSE and BSE', () => {
  const d = desk();
  const id = legacy(d, 'owner');
  for (const exchange of ['NSE', 'BSE']) {
    assert.throws(() => d.owner(C.markPrepared, { symbol: 'ABC', strategyId: 'pullback', itemId: 'pullback-trend', exchange, evidenceId: id, yes: true }), /exchange/i, exchange);
  }
});

test('a legacy price record can be corrected with an exchange and then backs a mark on that exchange only', () => {
  const d = desk();
  const old = legacy(d, 'owner');
  assert.throws(() => d.owner(C.correctEvidence, { corrects: old, reason: 'no exchange', summary: 'old chart' }), /NSE or BSE/);
  const { id } = d.owner(C.correctEvidence, { corrects: old, reason: 'Chart was from NSE', summary: 'old chart', exchange: 'NSE' });
  const mark = (exchange) => () => d.owner(C.markPrepared, { symbol: 'ABC', strategyId: 'pullback', itemId: 'pullback-trend', exchange, evidenceId: id, yes: true });
  assert.doesNotThrow(mark('NSE'));
  assert.throws(mark('BSE'), /for NSE, not BSE/);
});

test('a mark whose record lacks the exchange is not counted', () => {
  const d = desk();
  const id = legacy(d, 'owner');
  // A mark made by the old rules (event written directly): the record has no exchange.
  d.store.run('owner', (s, ctx) => ({ events: [{ type: 'prepare.marked', data: { symbol: 'ABC', key: 'pullback:pullback-trend', exchange: 'NSE', yes: true, evidenceId: id } }] }));
  d.clock.now += 3 * DAY;
  const r = d.store.read((s, now) => researchStatus(s, 'ABC', 'pullback', 'NSE', now));
  assert.equal(find(r, 'item:pullback-trend').status, 'missing');
});

test('own price-type evidence items are exchange-bound by default', () => {
  assert.equal(isExchangeBound({ id: 'my-chart', type: 'evidence', kind: 'candles' }), true);
  assert.equal(isExchangeBound({ id: 'my-chart', type: 'evidence', kind: 'candles', exchangeBound: false }), true);
  assert.equal(isExchangeBound({ id: 'my-news', type: 'evidence', kind: 'news' }), false);
  assert.equal(isExchangeBound({ id: 'my-note', type: 'attest' }), false);
});

const ownStrategy = (stage) => ({
  id: 'own', name: 'Own', bufferDays: 3, expireDays: 5,
  items: [{ id: 'my-chart', stage, type: 'evidence', kind: 'candles', label: 'My chart', required: true, ...(stage === 'before' ? { maxAgeDays: 0 } : {}) },
    ...(stage === 'before' ? [{ id: 'my-att', stage: 'research', type: 'attest', label: 'x', required: true }] : [])],
});

test('own research candles item: NSE mark needs an NSE record', () => {
  const d = desk();
  d.owner(C.saveStrategy, ownStrategy('research'));
  const bse = d.owner(C.addEvidence, { kind: 'candles', symbol: 'ABC', exchange: 'BSE', summary: 'chart' }).id;
  assert.throws(() => d.owner(C.markPrepared, { symbol: 'ABC', strategyId: 'own', itemId: 'my-chart', exchange: 'NSE', evidenceId: bse, yes: true }), /BSE, not NSE/);
  assert.throws(() => d.owner(C.markPrepared, { symbol: 'ABC', strategyId: 'own', itemId: 'my-chart', evidenceId: bse, yes: true }), /exchange/i);
});

test('own before-stage candles item: BSE record does not pass an NSE plan', () => {
  const d = desk();
  d.owner(C.saveStrategy, ownStrategy('before'));
  d.owner(C.addEvidence, { kind: 'candles', symbol: 'ABC', exchange: 'BSE', summary: 'chart' });
  const { id } = d.owner(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'own', thesis: 'x', plan: PLAN });
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, {}));
  assert.notEqual(find(ev, 'item:my-chart').status, 'pass');
});

test('get_research_status refuses trashed strategies for agents', () => {
  const d = desk();
  const key = d.addAgent('read').key;
  const h = createHandler(d.store, key);
  const call = (name, args) => h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).result;
  h({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(call('get_research_status', { symbol: 'ABC', strategyId: 'breakout' }).isError, undefined);
  d.owner(C.moveToTrash, { kind: 'strategy', id: 'breakout' });
  const r = call('get_research_status', { symbol: 'ABC', strategyId: 'breakout' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /strateg/i);
});

test('verify default good-until follows the record date, never earlier than today', () => {
  const d = desk();
  const { id } = d.as('agent:x')(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'n', observedAt: new Date(d.clock.now - 20 * DAY).toISOString() });
  const r = d.owner(C.verifyEvidence, { id });
  assert.equal(r.goodUntil, '2026-10-23'); // 20 days old news, good for 1 day only: today
  const fresh = d.as('agent:x')(C.addEvidence, { kind: 'fundamentals', symbol: 'ABC', summary: 'f', observedAt: new Date(d.clock.now - 10 * DAY).toISOString() });
  const f = d.owner(C.verifyEvidence, { id: fresh.id });
  assert.equal(f.goodUntil, '2027-01-11'); // 2026-10-13 + 90 days
});

test('unconfirmed agent price hint ignores the other exchange', () => {
  const d = desk();
  readyEvidence(d);
  d.store.run('agent:x', (s, ctx) => ({ events: [{ type: 'evidence.added', data: { id: 'q1', kind: 'quote', symbol: 'ABC', exchange: 'BSE', price: 123.45, observedAt: new Date(ctx.now).toISOString(), summary: '', sources: [] } }] }));
  d.clock.now += 10 * 60_000;
  const { id } = d.owner(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: PLAN });
  const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now, {}));
  assert.doesNotMatch(find(ev, 'quote').detail, /123\.45/);
});
