#!/usr/bin/env node
// desk setup            – guided first-time setup (Claude, desktop shortcut, automatic runs)
// desk start [--open]   – run the web app at http://127.0.0.1:8790 and the playbook scheduler
// desk mcp              – run the MCP server on stdio (for a model app; needs SWING_DESK_AGENT_KEY)
// desk connect          – set the PIN if needed, create a key and register the desk with Claude Code
// desk run-tasks        – one automatic Claude run for queued playbook tasks (used by schedules)
// desk schedule [list | add HH:MM | remove HH:MM | remove all]
// desk verify           – recompute the ledger hash chain
// desk backup [file]    – consistent copy of the database
// desk export [file]    – all events as JSON Lines (no PIN, keys or call log)

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { dbFile, backupDir, port, dataDir } from '../src/config.js';
import { UserError } from '../src/core/settings.js';

const [command = 'start', arg, arg2] = process.argv.slice(2);
const store = new Store(dbFile());

/** Print plain-language errors without a stack trace. */
async function friendly(fn) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  }
}

switch (command) {
  case 'start': {
    const { startServer } = await import('../src/http/server.js');
    const { openBrowser } = await import('../src/automation.js');
    const p = port();
    const url = `http://127.0.0.1:${p}`;
    const open = process.argv.includes('--open');
    try {
      await startServer(store, { port: p });
    } catch (err) {
      // Already running? Then just open it.
      const ours = err.code === 'PORT_IN_USE' && (await fetch(`${url}/api/session`).then((r) => r.ok).catch(() => false));
      if (ours) {
        console.log(`Swing Desk is already running: ${url}`);
        if (open) openBrowser(url);
        process.exit(0);
      }
      console.error(err.message);
      process.exit(1);
    }
    console.log(`Swing Desk Agent is running: ${url}`);
    console.log(`Data: ${dataDir()}`);
    console.log('Keep this window open. Press Ctrl + C to stop.');
    if (open) openBrowser(url);
    break;
  }
  case 'setup': {
    const { setup } = await import('../src/setup.js');
    await friendly(() => setup(store));
    store.close();
    break;
  }
  case 'run-tasks': {
    store.close();
    const { runTasks } = await import('../src/automation.js');
    process.exitCode = runTasks();
    break;
  }
  case 'schedule': {
    store.close();
    const { scheduleAdd, scheduleList, scheduleRemove } = await import('../src/automation.js');
    await friendly(() => {
      if (arg === 'add') {
        const r = scheduleAdd(arg2);
        console.log(r.cron ? `Add this line with \`crontab -e\`:\n  ${r.cron}` : `Added ${r.name}: Monday to Friday at ${arg2}.`);
      } else if (arg === 'remove') {
        const removed = scheduleRemove(arg2 ?? '');
        console.log(removed.length ? `Removed: ${removed.join(', ')}` : 'Nothing to remove.');
      } else {
        const list = scheduleList();
        console.log(list.length ? list.map((t) => `${t.name} → next run ${t.nextRun}`).join('\n') : 'No automatic runs. Add one: node bin/desk.js schedule add 08:50');
      }
    });
    break;
  }
  case 'mcp': {
    const { serveStdio } = await import('../src/mcp/server.js');
    serveStdio(store);
    break;
  }
  case 'connect': {
    const { connect } = await import('../src/connect.js');
    await friendly(() => connect(store, { dataDirOverride: process.env.SWING_DESK_DATA }));
    store.close();
    break;
  }
  case 'verify': {
    const result = store.verify();
    console.log(result.ok ? `Ledger OK: ${result.count} events.` : `Ledger BROKEN at event #${result.brokenAt}.`);
    process.exitCode = result.ok ? 0 : 1;
    store.close();
    break;
  }
  case 'backup': {
    const file = arg || join(backupDir(), `desk-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    console.log(`Backup written: ${store.backup(file)}`);
    store.close();
    break;
  }
  case 'export': {
    const lines = [];
    let before;
    for (;;) {
      const page = store.events({ before, limit: 500 });
      if (!page.length) break;
      lines.push(...page);
      before = page.at(-1).seq;
    }
    const text = lines.reverse().map((e) => JSON.stringify(e)).join('\n') + '\n';
    if (arg) writeFileSync(arg, text);
    else process.stdout.write(text);
    store.close();
    break;
  }
  default:
    console.error('Usage: desk setup | start [--open] | mcp | connect | run-tasks | schedule [list|add HH:MM|remove HH:MM|remove all] | verify | backup [file] | export [file]');
    process.exitCode = 2;
}
