import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasks, RUN_ARGS, scheduleAdd, scheduleList, scheduleRemove, createShortcut } from '../src/automation.js';

const win = process.platform === 'win32';
const fakeRun = (stdout = '') => {
  const calls = [];
  const fn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout, stderr: '' }; };
  return { fn, calls };
};

test('automatic runs give Claude only web research and the desk tools, in an empty folder, and log the result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-auto-'));
  try {
    const { fn, calls } = fakeRun('No task. Stopping.');
    const status = runTasks({ claude: 'C:/fake/claude.exe', logDir: join(dir, 'logs'), workDir: join(dir, 'runs'), spawnFn: fn });
    assert.equal(status, 0);
    assert.equal(calls[0].cmd, 'C:/fake/claude.exe');
    assert.deepEqual(calls[0].args, RUN_ARGS);
    assert.deepEqual(RUN_ARGS.slice(RUN_ARGS.indexOf('--tools') + 1, RUN_ARGS.indexOf('--allowedTools')), ['WebSearch', 'WebFetch']);
    assert.ok(!RUN_ARGS.some((a) => /Bash|Read|Write|Edit/.test(a)));
    assert.equal(calls[0].opts.cwd, join(dir, 'runs'));
    assert.match(readFileSync(join(dir, 'logs', 'automatic-runs.log'), 'utf8'), /exit 0 ===\nNo task\. Stopping\./);
    assert.equal(runTasks({ claude: null, logDir: join(dir, 'logs'), workDir: join(dir, 'runs') }), 1);
    assert.match(readFileSync(join(dir, 'logs', 'automatic-runs.log'), 'utf8'), /Claude Code not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schedules are weekday Task Scheduler entries in their own folder', { skip: !win }, () => {
  const { fn, calls } = fakeRun();
  assert.equal(scheduleAdd('8:50', undefined, fn).name, 'SwingDeskAgent\\Claude check 0850');
  const a = calls[0].args;
  assert.equal(calls[0].cmd, 'schtasks');
  assert.deepEqual([a[a.indexOf('/SC') + 1], a[a.indexOf('/D') + 1], a[a.indexOf('/ST') + 1]], ['WEEKLY', 'MON,TUE,WED,THU,FRI', '08:50']);
  assert.match(a[a.indexOf('/TR') + 1], /^".+node(\.exe)?" ".+desk\.js" run-tasks$/);
  assert.throws(() => scheduleAdd('25:00', undefined, fn), /not a time/);
});

test('listing and removing only touch this app’s schedules', { skip: !win }, () => {
  const csv = ['"\\SwingDeskAgent\\Claude check 0850","27-10-2026 08:50:00","Ready"', '"\\Other\\Thing","N/A","Ready"', '"\\SwingDeskAgent\\Claude check 1555","27-10-2026 15:55:00","Ready"'].join('\r\n');
  const { fn, calls } = fakeRun(csv);
  assert.deepEqual(scheduleList(fn).map((t) => t.name), ['SwingDeskAgent\\Claude check 0850', 'SwingDeskAgent\\Claude check 1555']);
  scheduleRemove('all', fn);
  assert.deepEqual(calls.filter((c) => c.args[0] === '/Delete').map((c) => c.args[2]), ['SwingDeskAgent\\Claude check 0850', 'SwingDeskAgent\\Claude check 1555']);
});

test('the desktop shortcut points at start.cmd, passing paths by environment (no quoting games)', { skip: !win }, () => {
  const { fn, calls } = fakeRun('C:\\Users\\x\\Desktop\\Swing Desk.lnk');
  assert.match(createShortcut(fn), /Swing Desk\.lnk$/);
  assert.match(calls[0].opts.env.SD_TARGET, /start\.cmd$/);
  assert.match(calls[0].args.at(-1), /\$s\.TargetPath = \$env:SD_TARGET/);
});
