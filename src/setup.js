// `desk setup` – the guided first-time setup behind setup.cmd / setup.sh.

import { prompter, connect } from './connect.js';
import { createShortcut, scheduleAdd, scheduleList } from './automation.js';
import { dataDir } from './config.js';
import { UserError } from './core/settings.js';

const yes = (answer, byDefault) => (answer === '' ? byDefault : /^y/i.test(answer));

export async function setup(store) {
  const major = Number(process.versions.node.split('.')[0]);
  console.log('Swing Desk Agent – setup\n');
  console.log(`Node.js ${process.versions.node} ✓`);
  if (major < 24) throw new UserError('Swing Desk needs Node.js 24 or newer. Download it free from https://nodejs.org and run setup again.');
  if (major > 24) console.log('  (Tested with Node.js 24. Newer versions should work; if anything fails, install version 24.)');
  console.log(`Your data will be kept in: ${dataDir()}\n`);

  const p = prompter();
  try {
    // 1. Claude
    console.log('STEP 1 of 3 – Connect Claude Code');
    if (yes(await p.ask('Connect Claude Code now? [Y/n]: '), true)) {
      try {
        await connect(store, { dataDirOverride: process.env.SWING_DESK_DATA, p });
      } catch (err) {
        if (!(err instanceof UserError) || err.message === 'Setup cancelled.') throw err;
        console.log(err.message);
      }
    } else {
      console.log('Skipped. Run setup again or `npm run connect` later.');
      if (!store.hasPin()) console.log('Note: set your approval PIN in Settings before approving anything.');
    }

    // 2. Shortcut
    console.log('\nSTEP 2 of 3 – Desktop shortcut');
    let shortcut = false;
    if (process.platform !== 'win32') {
      console.log('On this computer, start the app with ./start.sh');
    } else if (yes(await p.ask('Put a "Swing Desk" shortcut on your Desktop? [Y/n]: '), true)) {
      console.log(`Shortcut created: ${createShortcut()}`);
      shortcut = true;
    }

    // 3. Automatic runs
    console.log('\nSTEP 3 of 3 – Automatic Claude runs (optional)');
    console.log('Claude can check for playbook jobs by itself at set times on weekdays.');
    console.log('You also need a playbook in the app (Playbooks page) and the app must be running.');
    if (yes(await p.ask('Set this up now? [y/N]: '), false)) {
      const answer = await p.ask('At what times? Your computer’s clock, HH:MM, separated by commas [08:50,15:55]: ');
      for (const time of (answer || '08:50,15:55').split(',').map((t) => t.trim()).filter(Boolean)) {
        const r = scheduleAdd(time);
        console.log(r.cron ? `Add this line with \`crontab -e\`:\n  ${r.cron}` : `Added: ${r.name} (Mon–Fri)`);
      }
      if (process.platform === 'win32') console.log(`Scheduled runs: ${scheduleList().map((t) => `${t.name} → next ${t.nextRun}`).join('; ') || 'none'}`);
      console.log('Change these any time with: node bin/desk.js schedule');
    }

    console.log('\nAll done!');
    console.log(process.platform !== 'win32' ? 'Start the app: ./start.sh'
      : shortcut ? 'Start the app: double-click "Swing Desk" on your Desktop (or start.cmd in this folder).'
        : 'Start the app: double-click start.cmd in this folder.');
    console.log('Step-by-step guide: docs/SETUP.md');
  } finally {
    p.close();
  }
}
