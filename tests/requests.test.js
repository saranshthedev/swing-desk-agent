import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { evaluate, portfolio } from '../src/core/rules.js';
import { desk, PLAN, readyEvidence, BREAKOUT_ANSWERS } from './helpers.js';

const buy = (agent, extra = {}) => agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'Breakout', plan: PLAN, ...extra });
const checks = (d, id, answers) => d.store.read((s, now) => evaluate(s, s.intents[id], now, answers));
const status = (ev, checkId) => ev.checks.find((c) => c.id === checkId)?.status;

test('a fully evidenced agent request is approvable only with the owner’s answers', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent, { claims: { volume: 'Volume 2.1× average' } });
  const without = checks(d, id);
  assert.equal(without.ready, false);
  assert.equal(status(without, 'item:volume'), 'ask');
  assert.throws(() => d.owner(C.approveIntent, { id }), /Not ready/);
  const r = d.owner(C.approveIntent, { id, answers: BREAKOUT_ANSWERS });
  assert.match(r.ticket, /^BUY \d+ ABC on NSE · MTF/);
});

test('a broker quote older than five minutes blocks approval', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent);
  d.clock.now += 5 * 60_000 + 1;
  assert.equal(status(checks(d, id, BREAKOUT_ANSWERS), 'quote'), 'stale');
});

test('agents cannot record broker prices or MTF requirements', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  assert.throws(() => agent.run(C.addEvidence, { kind: 'quote', symbol: 'ABC', price: 100 }), /Only the owner/);
  assert.throws(() => agent.run(C.addEvidence, { kind: 'funding', symbol: 'ABC', marginPct: 20 }), /Only the owner/);
});

test('news from a previous India date does not count', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent, { expiresInHours: 48 });
  d.clock.now += 24 * 3_600_000;
  assert.equal(status(checks(d, id), 'news'), 'stale');
});

test('editing a strategy invalidates requests made against the old version', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent);
  const s = d.store.read((st) => structuredClone(st.strategies.breakout));
  d.owner(C.saveStrategy, { ...s, items: s.items.filter((i) => i.id !== 'market') });
  const ev = checks(d, id, BREAKOUT_ANSWERS);
  assert.equal(status(ev, 'strategy'), 'fail');
  assert.equal(ev.ready, false);
});

test('strategy rules add to global limits: results strategy refuses MTF', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const { id } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'results', thesis: 'x', plan: PLAN });
  assert.equal(status(checks(d, id), 'item:cash'), 'fail');
});

test('agent claims can only target attest items of the chosen strategy', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  assert.throws(() => buy(agent, { claims: { stop: 'fine' } }), /not a yes\/no item/);
});

test('approving a settings request applies it; nothing changes before', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const { id } = agent.run(C.submitIntent, { kind: 'settings', patch: { maxOpenLots: 7 }, thesis: 'More room' });
  assert.equal(d.store.read((s) => s.settings.maxOpenLots), 6);
  d.owner(C.approveIntent, { id });
  assert.equal(d.store.read((s) => s.settings.maxOpenLots), 7);
});

test('partial sale keeps the rest open at the same basis; fills cannot exceed approval', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent);
  d.owner(C.approveIntent, { id, answers: BREAKOUT_ANSWERS });
  const approved = d.store.read((s) => s.intents[id].decision.sizing.qty);
  assert.throws(() => d.owner(C.recordBuyFill, { intentId: id, qty: approved + 1, price: 100.05, date: '2026-10-23' }), /more shares/);
  const { lotId } = d.owner(C.recordBuyFill, { intentId: id, qty: approved, price: 100.05, date: '2026-10-23' });
  const r = d.owner(C.recordSale, { lotId, qty: 10, price: 110, date: '2026-10-23', charges: 25 });
  assert.equal(r.pnl, (110 - 100.05) * 10 - 25);
  const lot = d.store.read((s) => s.lots[lotId]);
  assert.equal(lot.remaining, approved - 10);
  assert.equal(lot.entry, 100.05);
  assert.equal(lot.status, 'open');
});

test('this week’s losses pause new buys', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent);
  d.owner(C.approveIntent, { id, answers: BREAKOUT_ANSWERS });
  const { lotId } = d.owner(C.recordBuyFill, { intentId: id, qty: 50, price: 100, date: '2026-10-23' });
  d.owner(C.recordSale, { lotId, qty: 50, price: 30, date: '2026-10-23', charges: 0 });
  assert.equal(d.store.read((s, now) => portfolio(s, now).buysPaused), true);
  readyEvidence(d, 'XYZ', agent);
  const second = agent.run(C.submitIntent, { kind: 'buy', symbol: 'XYZ', strategyId: 'breakout', thesis: 'x', plan: PLAN });
  assert.equal(status(checks(d, second.id, BREAKOUT_ANSWERS), 'weekly'), 'fail');
});
