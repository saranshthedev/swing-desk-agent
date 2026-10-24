import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as C from '../src/core/commands.js';
import { latestEvidence, portfolio } from '../src/core/rules.js';
import { createApp } from '../src/http/server.js';
import { TOOLS } from '../src/mcp/tools.js';
import { desk, PLAN, readyEvidence, answersFor, prepareAll } from './helpers.js';

const buy = (d) => d.owner(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId: 'breakout', thesis: 'Breakout', plan: PLAN });

test('trash hides an item, restore brings it back, purge hides it for good and keeps the chain', () => {
  const d = desk();
  const { id } = d.owner(C.addNote, { title: 'Idea', body: 'Watch ABC' });
  d.owner(C.moveToTrash, { kind: 'note', id });
  assert.throws(() => d.owner(C.moveToTrash, { kind: 'note', id }), /already in the Trash/);
  assert.ok(d.store.read((s) => s.notes[0].trashed));
  d.owner(C.restoreFromTrash, { kind: 'note', id });
  assert.equal(d.store.read((s) => s.notes[0].trashed), undefined);
  assert.throws(() => d.owner(C.purgeFromTrash, { kind: 'note', id }), /Move it to the Trash first/);
  d.owner(C.moveToTrash, { kind: 'note', id });
  d.owner(C.purgeFromTrash, { kind: 'note', id });
  assert.throws(() => d.owner(C.restoreFromTrash, { kind: 'note', id }), /does not exist/);
  assert.equal(d.store.events({ limit: 100 }).length > 0, true);
  assert.equal(d.store.verify().ok, true);
});

test('items that affect money or waiting decisions cannot be trashed yet', () => {
  const d = desk();
  prepareAll(d); // now Monday 26 Oct
  readyEvidence(d);
  const { id } = buy(d);
  assert.throws(() => d.owner(C.moveToTrash, { kind: 'request', id }), /Reject it first/);
  assert.throws(() => d.owner(C.moveToTrash, { kind: 'strategy', id: 'breakout' }), /Reject them first/);
  d.owner(C.approveIntent, { id, answers: answersFor(d) });
  assert.throws(() => d.owner(C.moveToTrash, { kind: 'request', id }), /Record the fill/);
  const qty = d.store.read((s) => s.intents[id].decision.sizing.qty);
  const { lotId } = d.owner(C.recordBuyFill, { intentId: id, qty, price: 100, date: '2026-10-26' });
  assert.throws(() => d.owner(C.moveToTrash, { kind: 'lot', id: lotId }), /still open/);
  d.owner(C.recordSale, { lotId, qty, price: 90, date: '2026-10-26' });
  const before = d.store.read((s, now) => portfolio(s, now).weekPnl);
  d.owner(C.moveToTrash, { kind: 'lot', id: lotId });
  d.owner(C.moveToTrash, { kind: 'request', id });
  assert.equal(d.store.read((s, now) => portfolio(s, now).weekPnl), before, 'a hidden lot still counts in P/L');

  const agent = d.addAgent('read');
  assert.throws(() => d.owner(C.moveToTrash, { kind: 'agent', id: agent.id }), /Disconnect it first/);
  d.owner(C.updateAgent, { id: agent.id, revoked: true });
  d.owner(C.moveToTrash, { kind: 'agent', id: agent.id });
});

test('trashed evidence no longer counts for checks and cannot be confirmed', () => {
  const d = desk();
  const agent = d.addAgent('draft');
  const { id } = agent.run(C.addEvidence, { kind: 'quote', symbol: 'ABC', exchange: 'NSE', price: 101 });
  d.owner(C.moveToTrash, { kind: 'evidence', id });
  assert.equal(d.store.read((s) => latestEvidence(s, 'quote', 'ABC')), null);
  assert.throws(() => d.owner(C.addEvidence, { confirms: id }), /can be confirmed/);
});

test('a trashed strategy cannot be used or overwritten until restored', () => {
  const d = desk();
  d.owner(C.moveToTrash, { kind: 'strategy', id: 'breakout' });
  assert.throws(() => buy(d), /Choose a strategy/);
  const s = d.store.read((x) => x.strategies.breakout);
  assert.throws(() => d.owner(C.saveStrategy, { ...s }), /in the Trash/);
  d.owner(C.restoreFromTrash, { kind: 'strategy', id: 'breakout' });
  assert.ok(d.store.read((x) => x.strategies.breakout.enabled && !x.strategies.breakout.trashed));
});

test('agents cannot see trashed items and have no trash tool', () => {
  const d = desk();
  const { id } = d.owner(C.addNote, { title: 'Secret idea', body: 'x' });
  d.owner(C.moveToTrash, { kind: 'note', id });
  const notes = TOOLS.list_notes.run(d.store, null, {});
  assert.equal(notes.length, 0);
  assert.ok(!Object.keys(TOOLS).some((n) => /trash|delete|purge|restore/.test(n)));
});

test('the API hides trashed items, lists the Trash, and needs the PIN to delete for good', async () => {
  const d = desk();
  const server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  server.on('request', createApp(d.store, { port }));
  const base = `http://127.0.0.1:${port}`;
  try {
    const csrf = (await (await fetch(`${base}/api/session`)).json()).csrf;
    const post = (name, body) => fetch(`${base}/api/action/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF': csrf }, body: JSON.stringify(body) });
    const state = async () => (await fetch(`${base}/api/state`, { headers: { 'X-CSRF': csrf } })).json();
    const { id } = d.owner(C.addNote, { title: 'Old idea', body: 'x' });
    assert.equal((await post('trash.move', { kind: 'note', id })).status, 200);
    let s = await state();
    assert.equal(s.notes.length, 0);
    assert.deepEqual(s.trash.map((t) => [t.kind, t.label]), [['note', 'Old idea']]);
    assert.equal((await post('trash.purge', { all: true, pin: '000000' })).status, 400);
    assert.equal((await post('trash.purge', { all: true, pin: '123456' })).status, 200);
    s = await state();
    assert.equal(s.trash.length, 0);
    const ledger = await (await fetch(`${base}/api/ledger`, { headers: { 'X-CSRF': csrf } })).json();
    assert.equal(ledger.chain.ok, true);
    const added = ledger.events.find((e) => e.type === 'note.added');
    assert.equal(added.purged, true);
    assert.ok(!JSON.stringify(ledger).includes('Old idea'), 'purged contents are not shown');
  } finally { server.close(); }
});
