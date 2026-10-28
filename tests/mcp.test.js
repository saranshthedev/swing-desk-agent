import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { createHandler } from '../src/mcp/server.js';
import { desk, PLAN } from './helpers.js';
import { scheduleTick } from '../src/core/schedule.js';
import { newId } from '../src/store/store.js';

function client(d, key) {
  const handle = createHandler(d.store, key);
  let id = 0;
  const call = (method, params) => handle({ jsonrpc: '2.0', id: ++id, method, params });
  return {
    init: () => call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
    tools: () => call('tools/list').result.tools.map((t) => t.name),
    tool: (name, args = {}) => call('tools/call', { name, arguments: args }).result,
  };
}

test('initialize negotiates a supported protocol version', () => {
  const d = desk();
  const r = client(d, d.addAgent('read').key).init().result;
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.ok(r.capabilities.tools);
});

test('tools are filtered by access level and no approval tool exists at any level', () => {
  const d = desk();
  const off = client(d, d.addAgent('off').key).tools();
  const read = client(d, d.addAgent('read').key).tools();
  const propose = client(d, d.addAgent('propose').key).tools();
  assert.deepEqual(off, ['whoami']);
  assert.ok(read.includes('desk_status') && !read.includes('add_note'));
  assert.ok(propose.includes('propose_buy'));
  for (const name of propose) assert.doesNotMatch(name, /approve|order|delete|scope|pin/);
});

test('an invalid key gets no tools and calls fail', () => {
  const d = desk();
  const c = client(d, 'sdk_agent_000000000000_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  assert.deepEqual(c.tools(), []);
  assert.equal(c.tool('whoami').isError, true);
});

test('a lower level is refused even if the tool name is known', () => {
  const d = desk();
  const r = client(d, d.addAgent('read').key).tool('add_note', { title: 't', body: 'b' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /needs draft access/);
});

test('an agent cannot confirm its own price through MCP', () => {
  const d = desk();
  const c = client(d, d.addAgent('draft').key);
  const q = c.tool('add_evidence', { kind: 'quote', symbol: 'ABC', exchange: 'NSE', price: 100, summary: 'site' }).structuredContent;
  c.tool('add_evidence', { kind: 'quote', symbol: 'ABC', exchange: 'NSE', summary: 'x', price: 100, confirms: q.id });
  assert.equal(d.store.read((s) => s.evidence.some((e) => e.by === 'owner' || e.confirms)), false);
});

test('owner pause stops every tool except whoami', () => {
  const d = desk();
  const c = client(d, d.addAgent('propose').key);
  d.owner(C.setAutomation, { paused: true });
  assert.match(c.tool('desk_status').content[0].text, /paused/);
  assert.equal(c.tool('whoami').isError, undefined);
});

test('daily request quota and key expiry are enforced', () => {
  const d = desk();
  const agent = d.addAgent('propose', { intentsPerDay: 1 });
  const c = client(d, agent.key);
  const args = { symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: PLAN };
  assert.equal(c.tool('propose_buy', args).isError, undefined);
  assert.match(c.tool('propose_buy', args).content[0].text, /Daily request limit/);
  d.clock.now += 31 * 86_400_000;
  assert.match(c.tool('whoami').content[0].text, /expired/);
});

test('a limit switched off is not enforced; the others still are', () => {
  const d = desk();
  const agent = d.addAgent('draft', { writesPerDay: 1, callsPerHour: 2, off: ['writesPerDay'] });
  const c = client(d, agent.key);
  assert.equal(c.tool('add_note', { title: 't', body: 'b' }).isError, undefined);
  assert.equal(c.tool('add_note', { title: 't', body: 'b' }).isError, undefined); // write limit is off
  assert.match(c.tool('add_note', { title: 't', body: 'b' }).content[0].text, /Hourly call limit/);
  d.owner(C.updateAgent, { id: agent.id, limits: { writesPerDay: 1, callsPerHour: 2, off: ['callsPerHour'] } });
  d.clock.now += 3_600_000;
  assert.match(c.tool('add_note', { title: 't', body: 'b' }).content[0].text, /Daily write limit/);
});

test('limit switches accept only known limits', () => {
  const d = desk();
  assert.throws(() => d.addAgent('read', { off: ['approvals'] }), /limit/i);
  const { id } = d.addAgent('read', { off: ['callsPerHour', 'callsPerHour'] });
  assert.deepEqual(d.store.read((s) => s.agents[id].limits.off), ['callsPerHour']);
  const { id: plain } = d.addAgent('read', {});
  assert.equal(d.store.read((s) => s.agents[plain].limits.off), undefined);
});

test('revoking an agent stops its key immediately', () => {
  const d = desk();
  const agent = d.addAgent('read');
  const c = client(d, agent.key);
  d.owner(C.updateAgent, { id: agent.id, revoked: true });
  assert.match(c.tool('desk_status').content[0].text, /revoked/);
});

test('a playbook task can be claimed, used for requests up to its limit, and completed', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  d.owner(C.savePlaybook, { name: 'Scan', agentId: agent.id, schedule: { days: [5], at: '10:55' }, instructions: 'Scan', maxIntents: 1 });
  d.store.run('system', (s, ctx) => ({ events: scheduleTick(s, ctx.now, newId) }));
  const c = client(d, agent.key);
  const task = c.tool('next_task').structuredContent;
  assert.equal(task.playbook.name, 'Scan');
  const args = { symbol: 'ABC', strategyId: 'breakout', thesis: 'x', plan: PLAN, taskId: task.task.id };
  assert.equal(c.tool('propose_buy', args).isError, undefined);
  assert.match(c.tool('propose_buy', args).content[0].text, /allows 1 request/);
  assert.equal(c.tool('complete_task', { taskId: task.task.id, summary: 'Done' }).isError, undefined);
  assert.equal(c.tool('next_task').structuredContent.result, null);
});

test('agents cannot verify, correct or mark; add_evidence ignores goodUntil and confirms but keeps exchange, topic, verdict', () => {
  const d = desk();
  const c = client(d, d.addAgent('propose').key);
  for (const name of c.tools()) assert.doesNotMatch(name, /verify|correct|mark/);
  const r = c.tool('add_evidence', { kind: 'quote', symbol: 'ABC', exchange: 'BSE', price: 100, summary: 'site', topic: 't1', verdict: 'good', goodUntil: '2099-01-01', confirms: 'ev_x' });
  assert.equal(r.isError, undefined);
  const e = d.store.read((s) => s.evidence[0]);
  assert.equal(e.exchange, 'BSE');
  assert.equal(e.topic, 't1');
  assert.equal(e.verdict, 'good');
  assert.equal(e.goodUntil, undefined);
  assert.equal(e.confirms, undefined);
  assert.equal(e.by.startsWith('agent:'), true);
});

test('flag_evidence and add_recommendation need draft access and count writes', () => {
  const d = desk();
  const read = client(d, d.addAgent('read').key);
  assert.match(read.tool('flag_evidence', { id: 'x', reason: 'r' }).content[0].text, /needs draft access/);
  assert.match(read.tool('add_recommendation', { symbol: 'ABC', exchange: 'NSE', call: 'wait', reasons: 'r' }).content[0].text, /needs draft access/);
  const agent = d.addAgent('draft', { writesPerDay: 3 });
  const c = client(d, agent.key);
  const id = c.tool('add_evidence', { kind: 'news', symbol: 'ABC', summary: 's' }).structuredContent.id; // write 1
  assert.equal(c.tool('flag_evidence', { id, reason: 'looks wrong' }).isError, undefined); // write 2
  assert.equal(c.tool('add_recommendation', { symbol: 'ABC', exchange: 'NSE', call: 'wait', reasons: 'not ready', strategyIds: [] }).isError, undefined); // write 3
  assert.match(c.tool('add_note', { title: 't', body: 'b' }).content[0].text, /Daily write limit/);
});

test('list_evidence filters by status and returns status; get_recommendation returns desk and agent views', () => {
  const d = desk();
  const agent = d.addAgent('draft');
  const c = client(d, agent.key);
  const a = c.tool('add_evidence', { kind: 'news', symbol: 'ABC', summary: 'one' }).structuredContent.id;
  c.tool('add_evidence', { kind: 'news', symbol: 'ABC', summary: 'two' });
  d.owner(C.verifyEvidence, { id: a });
  const all = c.tool('list_evidence', { symbol: 'ABC' }).structuredContent.result;
  assert.deepEqual(all.map((e) => e.status).sort(), ['found', 'verified']);
  const ver = c.tool('list_evidence', { status: 'verified' }).structuredContent.result;
  assert.deepEqual(ver.map((e) => e.id), [a]);
  assert.equal(c.tool('list_evidence', { topic: 'nope' }).structuredContent.result.length, 0);
  assert.equal(c.tool('list_evidence', { exchange: 'BSE' }).structuredContent.result.length, 0);
  c.tool('add_recommendation', { symbol: 'ABC', exchange: 'NSE', call: 'wait', reasons: 'later' });
  const rec = c.tool('get_recommendation', { symbol: 'abc', exchange: 'NSE' }).structuredContent;
  assert.equal(rec.desk.call, 'wait');
  assert.equal(rec.agent.call, 'wait');
  assert.equal(c.tool('get_recommendation', { symbol: 'ABC', exchange: 'XX' }).isError, true);
});

test('list_evidence never shows trashed or deleted-forever records, and refuses status trashed', () => {
  const d = desk();
  const agent = d.addAgent('draft');
  const c = client(d, agent.key);
  const keep = c.tool('add_evidence', { kind: 'news', symbol: 'ABC', summary: 'kept' }).structuredContent.id;
  const trashed = c.tool('add_evidence', { kind: 'news', symbol: 'ABC', summary: 'trashed' }).structuredContent.id;
  const purged = c.tool('add_evidence', { kind: 'news', symbol: 'ABC', summary: 'purged' }).structuredContent.id;
  d.owner(C.moveToTrash, { kind: 'evidence', id: trashed });
  d.owner(C.moveToTrash, { kind: 'evidence', id: purged });
  d.owner(C.purgeFromTrash, { kind: 'evidence', id: purged });
  for (const args of [{}, { symbol: 'ABC' }, { status: 'found' }, { limit: 200 }]) {
    const ids = c.tool('list_evidence', args).structuredContent.result.map((e) => e.id);
    assert.ok(ids.includes(keep));
    assert.equal(ids.includes(trashed) || ids.includes(purged), false, JSON.stringify(args));
  }
  const refused = c.tool('list_evidence', { status: 'trashed' });
  assert.equal(refused.isError, true);
  assert.doesNotMatch(refused.content[0].text, /trashed"|purged/);
});

test('add_structured_note needs draft access, counts as a write and returns warnings', () => {
  const d = desk();
  const args = { symbol: 'abc', section: 'swot', text: 'Strengths:\nGood\nnot a heading line' };
  assert.match(client(d, d.addAgent('read').key).tool('add_structured_note', args).content[0].text, /needs draft access/);
  const c = client(d, d.addAgent('draft', { writesPerDay: 1 }).key);
  const r = c.tool('add_structured_note', args);
  assert.equal(r.isError, undefined);
  assert.ok(r.structuredContent.id);
  assert.ok(Array.isArray(r.structuredContent.warnings));
  assert.match(c.tool('add_structured_note', args).content[0].text, /Daily write limit/);
  const e = client(d, d.addAgent('draft').key);
  assert.equal(e.tool('add_structured_note', { ...args, section: 'bogus' }).isError, true);
  assert.equal(e.tool('add_structured_note', { symbol: 'ABC', section: 'overview', exchange: 'XX', text: 'VWAP\t1' }).isError, true);
});

test('list_notes with section returns current records only; markup stays as given; trashed and purged hidden', () => {
  const d = desk();
  const c = client(d, d.addAgent('draft').key);
  const text = 'Strengths:\n<img src=x onerror=1>';
  const first = c.tool('add_structured_note', { symbol: 'ABC', section: 'swot', text }).structuredContent.id;
  const list = (args) => c.tool('list_notes', args).structuredContent.result;
  const rows = list({ section: 'swot' });
  assert.deepEqual(rows.map((n) => n.id), [first]);
  assert.deepEqual(rows[0].data.strengths, ['<img src=x onerror=1>']);
  const second = c.tool('add_structured_note', { symbol: 'ABC', section: 'swot', text: 'Strengths:\nNew' }).structuredContent.id;
  assert.deepEqual(list({ section: 'swot' }).map((n) => n.id), [second]);
  // without section the plain list still works and shows structured records with their fields
  c.tool('add_note', { symbol: 'ABC', title: 'plain', body: 'hello' });
  const all = list({});
  assert.ok(all.some((n) => n.body === 'hello'));
  assert.ok(all.some((n) => n.id === second && n.section === 'swot' && n.data && n.title === 'SWOT' && n.asOf));
  const other = c.tool('add_structured_note', { symbol: 'XYZ', section: 'results', text: 'x\tMar 2026\nRevenue\t10' }).structuredContent.id;
  d.owner(C.moveToTrash, { kind: 'note', id: second });
  d.owner(C.moveToTrash, { kind: 'note', id: other });
  d.owner(C.purgeFromTrash, { kind: 'note', id: other });
  for (const args of [{ section: 'swot' }, { section: 'results' }, {}, { symbol: 'XYZ' }]) {
    const ids = list(args).map((n) => n.id);
    assert.equal(ids.includes(second) || ids.includes(other), false, JSON.stringify(args));
  }
  // trashing the newest brings the first version back as the one current record
  assert.deepEqual(list({ section: 'swot' }).map((n) => n.id), [first]);
  d.owner(C.moveToTrash, { kind: 'note', id: first });
  assert.deepEqual(list({ section: 'swot' }), []);
  assert.equal(c.tool('list_notes', { section: 'bogus' }).isError, true);
});

test('no tool name suggests verifying, correcting or marking', () => {
  const d = desk();
  const names = client(d, d.addAgent('propose').key).tools();
  assert.ok(names.includes('add_structured_note'));
  for (const n of names) assert.doesNotMatch(n, /verify|correct|mark/);
});
