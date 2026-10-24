import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { evaluate, portfolio } from '../src/core/rules.js';
import { desk, PLAN, readyEvidence, answersFor, prepareAll } from './helpers.js';

const buy = (agent, extra = {}) => agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'Breakout', plan: PLAN, ...extra });
const checks = (d, id, answers) => d.store.read((s, now) => evaluate(s, s.intents[id], now, answers));
const status = (ev, checkId) => ev.checks.find((c) => c.id === checkId)?.status;

test('a fully evidenced agent request is approvable only with the owner’s answers', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  prepareAll(d);
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent, { claims: { 'volume-signal': 'Volume 2.1× average' } });
  const without = checks(d, id);
  assert.equal(without.ready, false);
  assert.equal(status(without, 'item:volume-signal'), 'ask');
  assert.throws(() => d.owner(C.approveIntent, { id }), /Not ready/);
  const r = d.owner(C.approveIntent, { id, answers: answersFor(d) });
  assert.match(r.ticket, /^BUY \d+ ABC on NSE · MTF/);
});

test('a broker quote older than five minutes blocks approval', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent);
  d.clock.now += 5 * 60_000 + 1;
  assert.equal(status(checks(d, id, answersFor(d)), 'quote'), 'stale');
});

test('agent-found prices count only after the owner confirms them, and only agents’ values can be confirmed', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  agent.run(C.addEvidence, { kind: 'news', symbol: 'ABC', summary: 'Nothing new' });
  const { id: quoteId } = agent.run(C.addEvidence, { kind: 'quote', symbol: 'ABC', exchange: 'NSE', price: 100.2, summary: 'NSE site' });
  const { id: fundingId } = agent.run(C.addEvidence, { kind: 'funding', symbol: 'ABC', marginPct: 40, summary: 'MTF list' });
  const { id } = buy(agent);
  let ev = checks(d, id);
  assert.equal(status(ev, 'quote'), 'stale');
  assert.match(ev.checks.find((c) => c.id === 'quote').detail, /agent found ₹100.2/i);
  assert.equal(status(ev, 'funding'), 'stale');

  assert.throws(() => agent.run(C.addEvidence, { confirms: quoteId }), /Only the owner/);
  d.clock.now += 4 * 60_000; // confirmation counts from when the owner confirms
  d.owner(C.addEvidence, { confirms: quoteId });
  d.owner(C.addEvidence, { confirms: fundingId });
  d.clock.now += 4 * 60_000;
  ev = checks(d, id);
  assert.equal(status(ev, 'quote'), 'pass');
  assert.equal(status(ev, 'funding'), 'pass');

  const own = d.store.read((s) => s.evidence.find((e) => e.by === 'owner' && e.kind === 'quote'));
  assert.throws(() => d.owner(C.addEvidence, { confirms: own.id }), /Only an agent’s/);
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
  d.owner(C.saveStrategy, { ...s, items: s.items.filter((i) => i.id !== 'market-fits') });
  const ev = checks(d, id, answersFor(d));
  assert.equal(status(ev, 'strategy'), 'fail');
  assert.equal(ev.ready, false);
});

test('strategy rules add to global limits: results strategy refuses MTF', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const { id } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'results', thesis: 'x', plan: PLAN });
  assert.equal(status(checks(d, id), 'item:money-regular-for-events'), 'fail');
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
  prepareAll(d); // now Monday 26 Oct
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent);
  d.owner(C.approveIntent, { id, answers: answersFor(d) });
  const approved = d.store.read((s) => s.intents[id].decision.sizing.qty);
  assert.throws(() => d.owner(C.recordBuyFill, { intentId: id, qty: approved + 1, price: 100.05, date: '2026-10-26' }), /more shares/);
  const { lotId } = d.owner(C.recordBuyFill, { intentId: id, qty: approved, price: 100.05, date: '2026-10-26' });
  const r = d.owner(C.recordSale, { lotId, qty: 10, price: 110, date: '2026-10-26', charges: 25 });
  assert.equal(r.pnl, (110 - 100.05) * 10 - 25);
  const lot = d.store.read((s) => s.lots[lotId]);
  assert.equal(lot.remaining, approved - 10);
  assert.equal(lot.entry, 100.05);
  assert.equal(lot.status, 'open');
});

test('this week’s losses pause new buys', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  prepareAll(d); // now Monday 26 Oct, a new India week
  readyEvidence(d, 'ABC', agent);
  const { id } = buy(agent);
  d.owner(C.approveIntent, { id, answers: answersFor(d) });
  const { lotId } = d.owner(C.recordBuyFill, { intentId: id, qty: 50, price: 100, date: '2026-10-26' });
  d.owner(C.recordSale, { lotId, qty: 50, price: 30, date: '2026-10-26', charges: 0 });
  assert.equal(d.store.read((s, now) => portfolio(s, now).buysPaused), true);
  readyEvidence(d, 'XYZ', agent);
  const second = agent.run(C.submitIntent, { kind: 'buy', symbol: 'XYZ', strategyId: 'breakout', thesis: 'x', plan: PLAN });
  assert.equal(status(checks(d, second.id, answersFor(d)), 'weekly'), 'fail');
});

test('leverage and own cash % are interchangeable for plans and MTF requirements', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  const byLev = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: { ...PLAN, marginPct: undefined, leverage: 2 } });
  const byPct = buy(agent);
  const a = checks(d, byLev.id), b = checks(d, byPct.id);
  assert.equal(a.plan.marginPct, 50);
  assert.deepEqual(a.sizing, b.sizing);
  assert.throws(() => agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: { ...PLAN, marginPct: 40, leverage: 2 } }), /means 50% own cash, not 40%/);
  assert.throws(() => agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: { ...PLAN, marginPct: undefined, leverage: 6 } }), /1× to 5×/);
});

test('a 3× plan passes a Kite limit recorded as 33.33% (rounded)', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  d.owner(C.addEvidence, { kind: 'funding', symbol: 'ABC', marginPct: 33.33, summary: 'Kite' });
  const { id } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: { ...PLAN, marginPct: undefined, leverage: 3 } });
  assert.equal(status(checks(d, id), 'funding'), 'pass');
  d.owner(C.addEvidence, { kind: 'funding', symbol: 'ABC', leverage: 2.5, summary: 'Kite' });
  const ev = checks(d, id);
  assert.equal(status(ev, 'funding'), 'fail');
  assert.match(ev.checks.find((c) => c.id === 'funding').detail, /at most 2\.5× \(40% own cash\)/);
});
