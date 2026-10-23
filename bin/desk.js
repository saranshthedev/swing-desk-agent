#!/usr/bin/env node
// desk start            – run the web app at http://127.0.0.1:8790 and the playbook scheduler
// desk mcp              – run the MCP server on stdio (for a model app; needs SWING_DESK_AGENT_KEY)
// desk connect          – set the PIN if needed, create a key and register the desk with Claude Code
// desk verify           – recompute the ledger hash chain
// desk backup [file]    – consistent copy of the database
// desk export [file]    – all events as JSON Lines (no PIN, keys or call log)

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { dbFile, backupDir, port, dataDir } from '../src/config.js';

const [command = 'start', arg] = process.argv.slice(2);
const store = new Store(dbFile());

switch (command) {
  case 'start': {
    const { startServer } = await import('../src/http/server.js');
    const p = port();
    await startServer(store, { port: p });
    console.log(`Swing Desk Agent is running: http://127.0.0.1:${p}`);
    console.log(`Data: ${dataDir()}`);
    break;
  }
  case 'mcp': {
    const { serveStdio } = await import('../src/mcp/server.js');
    serveStdio(store);
    break;
  }
  case 'connect': {
    const { connect } = await import('../src/connect.js');
    const { UserError } = await import('../src/core/settings.js');
    try {
      await connect(store, { dataDirOverride: process.env.SWING_DESK_DATA });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      console.error(`\n${err.message}`);
      process.exitCode = 1;
    } finally {
      store.close();
    }
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
    console.error('Usage: desk start | mcp | connect | verify | backup [file] | export [file]');
    process.exitCode = 2;
}
