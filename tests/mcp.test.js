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
  const q = c.tool('add_evidence', { kind: 'quote', symbol: 'ABC', price: 100, summary: 'site' }).structuredContent;
  c.tool('add_evidence', { kind: 'quote', symbol: 'ABC', summary: 'x', price: 100, confirms: q.id });
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
