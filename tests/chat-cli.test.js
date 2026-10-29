import test from 'node:test';
import assert from 'node:assert/strict';
import { chatArgs, mcpConfigJson, CHAT_RULES, chatAgentStatus } from '../src/chat/cli.js';
import { shellLine } from '../src/connect.js';
import * as C from '../src/core/commands.js';
import { desk } from './helpers.js';

const after = (args, flag) => args[args.indexOf(flag) + 1];

test('chat arguments allow only the desk and web tools', () => {
  const args = chatArgs({ mcpConfig: '{}', sessionId: 's1', resume: false });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(after(args, '--tools'), 'WebSearch,WebFetch');
  assert.equal(after(args, '--allowedTools'), 'mcp__swing-desk__*,WebSearch,WebFetch');
  assert.equal(after(args, '--setting-sources'), '');
  assert.equal(after(args, '--session-id'), 's1');
  assert.ok(!args.includes('--resume'));
  const again = chatArgs({ mcpConfig: '{}', sessionId: 's1', resume: true });
  assert.equal(after(again, '--resume'), 's1');
  assert.ok(!again.includes('--session-id'));
});

test('the MCP config carries the key only in the server env', () => {
  const cfg = JSON.parse(mcpConfigJson({ key: 'sdk_x', dataDir: '/d' }));
  assert.deepEqual(Object.keys(cfg.mcpServers), ['swing-desk']);
  assert.equal(cfg.mcpServers['swing-desk'].env.SWING_DESK_AGENT_KEY, 'sdk_x');
  assert.equal(cfg.mcpServers['swing-desk'].env.SWING_DESK_DATA, '/d');
  const args = chatArgs({ mcpConfig: mcpConfigJson({ key: 'sdk_x', dataDir: '/d' }), sessionId: 's', resume: false });
  assert.equal(args.filter((a) => a.includes('sdk_x')).length, 1);
});

test('chat rules are a single line', () => {
  assert.ok(!/\n/.test(CHAT_RULES));
});

test('shellLine quotes every argument', () => {
  assert.equal(shellLine('c.cmd', ['a b', 'x"y', '']), '"c.cmd" "a b" "x""y" ""');
});

test('chat agent status reasons', () => {
  const d = desk();
  const now = () => d.clock.now;
  const st = () => d.store.read((s) => s);
  assert.equal(chatAgentStatus(st(), null, now()).reason, 'Chat is not turned on. Turn it on under Agents & MCP.');
  assert.equal(chatAgentStatus(st(), 'nope', now()).ok, false);
  const a = d.addAgent('draft');
  const ok = chatAgentStatus(st(), a.id, now());
  assert.equal(ok.ok, true);
  assert.equal(ok.paused, false);
  assert.equal(ok.agent.id, a.id);
  d.owner(C.updateAgent, { id: a.id, scope: 'off' });
  assert.equal(chatAgentStatus(st(), a.id, now()).reason, 'The chat agent’s access is Off. Change it under Agents & MCP.');
  d.owner(C.updateAgent, { id: a.id, scope: 'draft' });
  d.clock.now += 100 * 86_400_000;
  assert.equal(chatAgentStatus(st(), a.id, now()).reason, 'The chat agent’s key has expired. Turn chat on again under Agents & MCP.');
  d.owner(C.updateAgent, { id: a.id, revoked: true });
  assert.equal(chatAgentStatus(st(), a.id, now()).reason, 'The chat agent was disconnected. Turn chat on again under Agents & MCP.');
});
