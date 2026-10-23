// Helpers for the easy-use scripts: open the browser, run Claude for playbook tasks, schedule
// those runs with the operating system, and make a desktop shortcut. No new dependencies.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude } from './connect.js';
import { dataDir } from './config.js';
import { UserError } from './core/settings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'desk.js');
const TASK_FOLDER = 'SwingDeskAgent';
const IS_WIN = process.platform === 'win32';

export const RUN_PROMPT = 'Call the swing-desk next_task tool. If it returns a task, follow its instructions exactly and finish with complete_task. If it returns null, stop.';
/**
 * Automatic runs get only web research plus the desk's MCP tools: `--tools` removes Claude
 * Code's shell and file tools entirely; `--allowedTools` lets the rest run without prompts.
 */
export const RUN_ARGS = ['-p', RUN_PROMPT, '--tools', 'WebSearch', 'WebFetch', '--allowedTools', 'mcp__swing-desk__*', 'WebSearch', 'WebFetch'];

export function openBrowser(url) {
  const [cmd, args] = IS_WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* the URL is printed too */
  }
}

/** One automatic Claude run. Finds Claude Code fresh every time, so extension updates do not break it. */
export function runTasks({ claude = findClaude(), logDir = join(dataDir(), 'logs'), workDir = join(dataDir(), 'runs'), spawnFn = spawnSync } = {}) {
  mkdirSync(logDir, { recursive: true });
  mkdirSync(workDir, { recursive: true }); // empty folder: nothing for Claude to read
  const log = join(logDir, 'automatic-runs.log');
  const stamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  if (!claude) {
    appendFileSync(log, `\n=== ${stamp} IST ===\nClaude Code not found. Install the Claude Code extension or CLI.\n`);
    return 1;
  }
  const viaShell = /\.(cmd|bat)$/i.test(claude);
  const line = [claude, ...RUN_ARGS].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ');
  const r = viaShell
    ? spawnFn(line, { cwd: workDir, encoding: 'utf8', shell: true, windowsHide: true, timeout: 30 * 60_000 })
    : spawnFn(claude, RUN_ARGS, { cwd: workDir, encoding: 'utf8', windowsHide: true, timeout: 30 * 60_000 });
  appendFileSync(log, `\n=== ${stamp} IST · exit ${r.status ?? r.signal ?? r.error?.code} ===\n${(r.stdout || '').trim()}\n${(r.stderr || '').trim()}\n`);
  return r.status ?? 1;
}

// ---------- scheduling ----------

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function checkTime(time) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time).trim());
  if (!m) throw new UserError(`“${time}” is not a time. Use HH:MM, for example 08:50.`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

const taskName = (time) => `${TASK_FOLDER}\\Claude check ${time.replace(':', '')}`;

/**
 * Add a weekly automatic run at `time` (the computer's clock) on `days` (0=Sun … 6=Sat).
 * Windows: a Task Scheduler entry for the current user. Elsewhere: returns a crontab line to add.
 */
export function scheduleAdd(time, days = [1, 2, 3, 4, 5], run = spawnSync) {
  const t = checkTime(time);
  const command = `"${process.execPath}" "${BIN}" run-tasks`;
  if (!IS_WIN) {
    const [hh, mm] = t.split(':').map(Number);
    return { cron: `${mm} ${hh} * * ${days.join(',')} ${command}` };
  }
  if (command.length > 261) throw new UserError('The app folder path is too long for Task Scheduler. Move the app to a shorter path, e.g. C:\\SwingDesk.');
  const r = run('schtasks', ['/Create', '/TN', taskName(t), '/SC', 'WEEKLY', '/D', days.map((d) => DAY_CODES[d]).join(','), '/ST', t, '/TR', command, '/RL', 'LIMITED', '/F'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new UserError(`Task Scheduler refused: ${(r.stderr || r.stdout).trim()}`);
  return { name: taskName(t) };
}

/** Automatic runs created by this app: [{ name, nextRun }]. */
export function scheduleList(run = spawnSync) {
  if (!IS_WIN) return [];
  const r = run('schtasks', ['/Query', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const seen = new Map();
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (cells[0]?.startsWith(`\\${TASK_FOLDER}\\`)) seen.set(cells[0].slice(1), cells[1]);
  }
  return [...seen].map(([name, nextRun]) => ({ name, nextRun }));
}

export function scheduleRemove(time, run = spawnSync) {
  if (!IS_WIN) return [];
  const names = time === 'all' ? scheduleList(run).map((t) => t.name) : [taskName(checkTime(time))];
  for (const name of names) {
    const r = run('schtasks', ['/Delete', '/TN', name, '/F'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new UserError(`Could not remove “${name}”: ${(r.stderr || r.stdout).trim()}`);
  }
  return names;
}

// ---------- desktop shortcut ----------

/** Windows: a "Swing Desk" shortcut on the Desktop that runs start.cmd. */
export function createShortcut(run = spawnSync) {
  if (!IS_WIN) return null;
  const script = [
    '$desk = [Environment]::GetFolderPath("Desktop")',
    '$link = Join-Path $desk "Swing Desk.lnk"',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($link)',
    '$s.TargetPath = $env:SD_TARGET',
    '$s.WorkingDirectory = $env:SD_DIR',
    '$s.IconLocation = "$env:SystemRoot\\System32\\shell32.dll,43"',
    '$s.Description = "Start Swing Desk Agent"',
    '$s.Save()',
    'Write-Output $link',
  ].join('; ');
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, SD_TARGET: join(ROOT, 'start.cmd'), SD_DIR: ROOT },
  });
  if (r.status !== 0) throw new UserError(`Could not create the shortcut: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}
