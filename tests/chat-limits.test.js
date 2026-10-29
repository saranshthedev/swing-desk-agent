import test from 'node:test';
import assert from 'node:assert/strict';
import { chatLimits, limitOn, stopMessage } from '../src/chat/limits.js';
import { stepLine } from '../src/chat/steps.js';
import { TOOLS } from '../src/mcp/tools.js';

test('chat limits fill defaults', () => {
  assert.deepEqual(chatLimits(), { replyMinutes: 15, toolCalls: 60, modelTurns: 40, idleMinutes: 10 });
});

test('out-of-range and fractional limits are refused', () => {
  for (const bad of [{ replyMinutes: 0 }, { replyMinutes: 121 }, { replyMinutes: 1.5 }, { toolCalls: 501 }, { modelTurns: 201 }, { idleMinutes: 0 }]) {
    assert.throws(() => chatLimits(bad), /must be a whole number from/);
  }
});

test('switched-off limits keep their numbers', () => {
  const l = chatLimits({ replyMinutes: 30, off: ['replyMinutes', 'replyMinutes'] });
  assert.deepEqual(l, { replyMinutes: 30, toolCalls: 60, modelTurns: 40, idleMinutes: 10, off: ['replyMinutes'] });
  assert.throws(() => chatLimits({ off: ['nope'] }));
  assert.throws(() => chatLimits({ off: 'replyMinutes' }));
  assert.equal(limitOn(l, 'replyMinutes'), false);
  assert.equal(limitOn(l, 'toolCalls'), true);
  assert.equal('off' in chatLimits({ off: [] }), false);
});

test('stop message uses the configured number', () => {
  assert.equal(stopMessage('replyMinutes', chatLimits()),
    'Stopped after 15 minutes (your reply time limit). Anything Claude already recorded is on the desk. Send ‘continue’ to carry on.');
  assert.match(stopMessage('replyMinutes', chatLimits({ replyMinutes: 7 })), /^Stopped after 7 minutes/);
  assert.match(stopMessage('toolCalls', chatLimits()), /^Stopped after 60 tool calls \(your tool-call limit\)\. .*‘continue’/);
  assert.match(stopMessage('modelTurns', chatLimits()), /^Stopped after 40 Claude turns \(your Claude-turns limit\)\. /);
});

test('step lines are plain and flag desk writes', () => {
  const w = stepLine('mcp__swing-desk__add_evidence', { symbol: 'tcs' });
  assert.equal(w.write, true);
  assert.match(w.summary, /TCS/);
  assert.equal(stepLine('mcp__swing-desk__list_evidence', { symbol: 'tcs' }).write, false);
  assert.equal(stepLine('mcp__swing-desk__add_structured_note', { symbol: 'tcs', section: 'swot' }).summary, 'Saved TCS · swot');
  assert.equal(stepLine('WebSearch', { query: 'nifty today' }).summary, 'Searched the web: “nifty today”');
  assert.equal(stepLine('WebFetch', { url: 'https://www.nseindia.com/x' }).summary, 'Read www.nseindia.com');
  assert.ok(stepLine('WebSearch', { query: 'x'.repeat(500) }).summary.length <= 160);
  assert.equal(stepLine('Bash', {}).summary, 'Used Bash');
  assert.equal(stepLine('WebFetch', { url: 'not a url' }).summary, 'Read a web page');
});

test('every desk tool has a phrase and write flag matches', () => {
  for (const [name, t] of Object.entries(TOOLS)) {
    const s = stepLine(`mcp__swing-desk__${name}`, { symbol: 'abc' });
    assert.doesNotMatch(s.summary, /^Used /, name);
    assert.equal(s.write, Boolean(t.write), name);
  }
  assert.equal(stepLine('mcp__swing-desk__nonexistent', {}).summary, 'Used mcp__swing-desk__nonexistent');
});
