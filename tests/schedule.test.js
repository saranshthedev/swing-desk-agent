import test from 'node:test';
import assert from 'node:assert/strict';
import { latestSlot, scheduleTick, validateSchedule } from '../src/core/schedule.js';
import { newId } from '../src/store/store.js';
import * as C from '../src/core/commands.js';
import { desk, FRIDAY_11_IST } from './helpers.js';

const at = (iso) => Date.parse(iso);

test('daily slot is in India time and only on chosen weekdays', () => {
  const s = validateSchedule({ days: [1, 2, 3, 4, 5], at: '08:45' });
  assert.equal(new Date(latestSlot(s, FRIDAY_11_IST)).toISOString(), '2026-10-23T03:15:00.000Z');
  assert.equal(latestSlot(s, at('2026-10-24T05:30:00Z')), null); // Saturday
  assert.equal(latestSlot(s, at('2026-10-23T03:00:00Z')), null); // before 08:45 IST
});

test('interval slot snaps to the last step inside the window', () => {
  const s = validateSchedule({ days: [5], every: 15, from: '09:15', to: '15:30' });
  assert.equal(new Date(latestSlot(s, at('2026-10-23T05:37:00Z'))).toISOString(), '2026-10-23T05:30:00.000Z'); // 11:07 → 11:00 IST
});

test('a slot is queued once, missed slots beyond 10 minutes are skipped, stale tasks expire', () => {
  const d = desk();
  const agent = d.addAgent('read');
  d.owner(C.savePlaybook, { name: 'Watch', agentId: agent.id, schedule: { days: [5], at: '10:55' }, instructions: 'Watch' });
  const tick = () => d.store.run('system', (s, ctx) => ({ events: scheduleTick(s, ctx.now, newId) }));
  tick();
  tick();
  assert.equal(d.store.read((s) => Object.keys(s.tasks).length), 1);
  d.clock.now += 61 * 60_000;
  tick();
  assert.equal(d.store.read((s) => Object.values(s.tasks)[0].status), 'expired');

  const late = desk(FRIDAY_11_IST + 30 * 60_000);
  const a2 = late.addAgent('read');
  late.owner(C.savePlaybook, { name: 'Watch', agentId: a2.id, schedule: { days: [5], at: '10:55' }, instructions: 'Watch' });
  late.store.run('system', (s, ctx) => ({ events: scheduleTick(s, ctx.now, newId) }));
  assert.equal(late.store.read((s) => Object.keys(s.tasks).length), 0);
});
