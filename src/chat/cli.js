// Locked-down Claude Code command line for the desk chat. The agent key goes only into the
// --mcp-config JSON (server env). Never log these arguments.

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellLine } from '../connect.js';
import { live } from '../core/state.js';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/desk.js');

// One line only: .cmd quoting stays safe.
export const CHAT_RULES = 'You are inside Swing Desk. The owner approves on the desk, never in the chat. Record only through the swing-desk tools. Follow the research rule from the MCP server instructions. Use plain language, rupees and India time. Say where on the desk anything you recorded is.';

export function mcpConfigJson({ key, dataDir }) {
  return JSON.stringify({
    mcpServers: {
      'swing-desk': {
        command: process.execPath,
        args: [BIN, 'mcp'],
        env: { SWING_DESK_AGENT_KEY: key, SWING_DESK_DATA: dataDir },
      },
    },
  });
}

export function chatArgs({ mcpConfig, sessionId, resume }) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--tools', 'WebSearch,WebFetch',
    '--allowedTools', 'mcp__swing-desk__*,WebSearch,WebFetch',
    '--setting-sources', '',
    '--append-system-prompt', CHAT_RULES,
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
  ];
}

export function spawnClaude(bin, args, { cwd } = {}) {
  const opts = { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (/\.(cmd|bat)$/i.test(bin)) return spawn(shellLine(bin, args), { ...opts, shell: true });
  if (/\.(m?js)$/i.test(bin)) return spawn(process.execPath, [bin, ...args], opts);
  return spawn(bin, args, opts);
}

export function chatAgentStatus(state, agentId, now) {
  const agent = agentId ? state.agents[agentId] : null;
  if (!agent || agent.purged || !live(agent)) return { ok: false, reason: 'Chat is not turned on. Turn it on under Agents & MCP.' };
  if (agent.revoked) return { ok: false, reason: 'The chat agent was disconnected. Turn chat on again under Agents & MCP.' };
  if (Date.parse(agent.expiresAt) <= now) return { ok: false, reason: 'The chat agent’s key has expired. Turn chat on again under Agents & MCP.' };
  if (agent.scope === 'off') return { ok: false, reason: 'The chat agent’s access is Off. Change it under Agents & MCP.' };
  return { ok: true, paused: state.automationPaused, agent };
}
