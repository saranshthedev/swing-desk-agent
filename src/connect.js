// `desk connect` – one-step setup for Claude Code on this computer.
// Asks for the approval PIN, creates an agent key, and registers the desk's MCP server with
// Claude Code through its own `claude mcp add`. The key goes straight into Claude Code's config
// and is not printed (unless registration fails and you must add it by hand).

import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './core/commands.js';
import { UserError } from './core/settings.js';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/desk.js');
const SERVER_NAME = 'swing-desk';

/** Locate the Claude Code CLI: PATH first, then the copy bundled with the VS Code/Cursor extension. */
export function findClaude() {
  if (process.env.DESK_CLAUDE_BIN) return process.env.DESK_CLAUDE_BIN;
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.split(/\r?\n/)[0].trim();
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const dir = join(homedir(), editor, 'extensions');
    if (!existsSync(dir)) continue;
    const bundled = readdirSync(dir)
      .filter((name) => name.startsWith('anthropic.claude-code-'))
      .map((name) => join(dir, name, 'resources', 'native-binary', exe))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (bundled.length) return bundled[0];
  }
  return null;
}

function runClaude(claude, args) {
  // .cmd/.bat shims (npm global installs) need a shell on Windows; quote every argument then.
  if (/\.(cmd|bat)$/i.test(claude)) {
    // Node runs this as cmd /d /s /c "<line>"; /s strips only that outer pair, keeping our quotes.
    const line = [claude, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ');
    return spawnSync(line, { encoding: 'utf8', shell: true, windowsHide: true });
  }
  return spawnSync(claude, args, { encoding: 'utf8', windowsHide: true });
}

function prompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  let muted = false;
  rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question, { hidden = false } = {}) {
      process.stdout.write(question);
      muted = hidden;
      const { value, done } = await lines.next();
      muted = false;
      if (hidden && process.stdin.isTTY) process.stdout.write('\n');
      if (done) throw new UserError('Setup cancelled.');
      return String(value).trim();
    },
    close: () => rl.close(),
  };
}

export async function connect(store, { dataDirOverride } = {}) {
  const p = prompter();
  try {
    console.log('Connect Swing Desk to Claude Code\n');
    const claude = findClaude();
    console.log(claude ? `Found Claude Code: ${claude}` : 'Claude Code CLI not found. I will print the command for you to run.');

    if (store.hasPin()) {
      store.checkPin(await p.ask('Approval PIN: ', { hidden: true }));
    } else {
      console.log('First, create your approval PIN (6–12 digits). Only you should know it; never give it to a model.');
      const pin = await p.ask('New PIN: ', { hidden: true });
      if (pin !== (await p.ask('Repeat PIN: ', { hidden: true }))) throw new UserError('The PINs do not match.');
      store.setPin(pin);
    }

    console.log('\nWhat may Claude do?');
    console.log('  read    – read your plans, limits and lots; run calculators; do playbook tasks');
    console.log('  draft   – read, plus record research notes and evidence (prices, news…) with sources');
    console.log('  propose – draft, plus send buy/exit/settings requests for you to approve');
    const scope = ((await p.ask('Access [draft]: ')) || 'draft').toLowerCase();
    if (!['read', 'draft', 'propose'].includes(scope)) throw new UserError('Choose read, draft or propose.');

    let replace = false;
    if (claude && runClaude(claude, ['mcp', 'get', SERVER_NAME]).status === 0) {
      replace = /^y/i.test(await p.ask(`Claude Code already has a "${SERVER_NAME}" server. Replace it? [y/N]: `));
      if (!replace) throw new UserError('Nothing changed.');
    }

    const { id } = store.run('owner', (s, ctx) => C.addAgent(s, { name: 'Claude Code', client: 'Claude Code (desk connect)', scope, expiresDays: 90 }, ctx));
    const key = store.issueKey(id);
    const env = [`SWING_DESK_AGENT_KEY=${key}`, ...(dataDirOverride ? [`SWING_DESK_DATA=${dataDirOverride}`] : [])];
    const addArgs = ['mcp', 'add', SERVER_NAME, '--scope', 'user', ...env.flatMap((e) => ['-e', e]), '--', process.execPath, BIN, 'mcp'];

    if (claude) {
      if (replace) runClaude(claude, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
      const added = runClaude(claude, addArgs);
      if (added.status === 0) {
        console.log(`\nDone. Claude Code can now use the desk as "${SERVER_NAME}" with ${scope} access (key valid 90 days).`);
        if (replace) console.log('Revoke the old Claude Code agent under Agents & MCP if you no longer need it.');
        console.log('\nNext:');
        console.log('  1. Start a new Claude Code conversation (or reload VS Code) and run /mcp to see it connected.');
        console.log('  2. Ask: "Use swing-desk: call whoami and list_strategies."');
        console.log('  3. Keep `npm start` running to approve requests at http://127.0.0.1:8790');
        return;
      }
      console.log(`\nClaude Code could not add the server:\n${(added.stderr || added.stdout).trim()}`);
    }
    console.log('\nRun this yourself (it contains the agent key; do not share it):\n');
    console.log(['claude', ...addArgs].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' '));
  } finally {
    p.close();
  }
}
