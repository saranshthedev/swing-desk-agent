// Stand-in for the Claude Code CLI in tests. Speaks just enough stream-json for the desk chat.
// Writes its arguments (never its environment) to the file in FAKE_CLAUDE_ARGS when set.
// FAKE_CLAUDE_HANG=1 stops after the tool call and never sends a result, so a turn stays open until stopped.

import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS) writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(args));

const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
const sessionId = at('--session-id') ?? at('--resume') ?? 'fake-session';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const start = (id) => ({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
const textBlock = { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
// Each turn is two model messages: the echo (first 20 characters of the prompt), a tool call, then DONE.
const DONE = 'Done.';

let turn = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg?.type !== 'user') return;
  turn += 1;
  const content = msg.message?.content;
  const prompt = typeof content === 'string' ? content : '';
  const echo = prompt.slice(0, 20);
  const half = Math.ceil(echo.length / 2);
  out({ type: 'system', subtype: 'init', session_id: sessionId });
  // First model message: text, then a desk tool call.
  out(start(`msg_${turn}a`));
  out(textBlock);
  out(delta(echo.slice(0, half)));
  out(delta(echo.slice(half)));
  out({ type: 'assistant', message: { id: `msg_${turn}a`, content: [{ type: 'text', text: echo }] } });
  out({ type: 'assistant', message: { id: `msg_${turn}a`, content: [{ type: 'tool_use', id: `tool_${turn}`, name: 'mcp__swing-desk__add_note', input: { symbol: 'abc', title: 'Fake note' } }] } });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool_${turn}`, content: [{ type: 'text', text: 'Saved.' }] }] } });
  if (process.env.FAKE_CLAUDE_HANG === '1') return;
  // Second model message: more text after the tool result.
  out(start(`msg_${turn}b`));
  out(textBlock);
  out(delta(DONE));
  out({ type: 'assistant', message: { id: `msg_${turn}b`, content: [{ type: 'text', text: DONE }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: DONE });
});
