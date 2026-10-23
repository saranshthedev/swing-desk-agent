// Playbook scheduling in India time. The desk only *queues* tasks; a connected model app
// claims them over MCP. A slot missed while the desk was off is not back-filled beyond a
// short grace window, so a laptop waking up does not unleash a burst of stale jobs.
// There is no exchange holiday calendar: pause a playbook on market holidays.

import { indiaParts, indiaTimeToMs, parseClock } from './time.js';
import { UserError } from './settings.js';

const GRACE_MS = 10 * 60_000;

export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new UserError('Choose when the playbook runs.');
  const days = schedule.days;
  if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new UserError('Pick at least one weekday.');
  }
  if (schedule.every === undefined) {
    if (parseClock(schedule.at) === null) throw new UserError('Enter the run time as HH:MM (India time).');
    return { days: [...new Set(days)].sort(), at: schedule.at };
  }
  const from = parseClock(schedule.from);
  const to = parseClock(schedule.to);
  if (!Number.isInteger(schedule.every) || schedule.every < 5 || schedule.every > 240) throw new UserError('Repeat every 5 to 240 minutes.');
  if (from === null || to === null || to <= from) throw new UserError('Enter a start and end time (HH:MM, India time) with the end after the start.');
  return { days: [...new Set(days)].sort(), every: schedule.every, from: schedule.from, to: schedule.to };
}

/** The most recent scheduled slot at or before `now`, today in India, or null. */
export function latestSlot(schedule, now) {
  const p = indiaParts(now);
  if (!schedule.days.includes(p.weekday)) return null;
  let minutes;
  if (schedule.every === undefined) {
    minutes = parseClock(schedule.at);
  } else {
    const from = parseClock(schedule.from);
    const to = parseClock(schedule.to);
    if (p.minutes < from) return null;
    minutes = Math.min(to, from + Math.floor((p.minutes - from) / schedule.every) * schedule.every);
  }
  const ms = indiaTimeToMs(p.date, minutes);
  return ms <= now ? ms : null;
}

/** Events that queue newly due tasks and expire abandoned ones. */
export function scheduleTick(state, now, newId) {
  const events = [];
  for (const pb of Object.values(state.playbooks)) {
    if (!pb.enabled || !pb.agentId || state.agents[pb.agentId]?.revoked) continue;
    const due = latestSlot(pb.schedule, now);
    if (due === null || now - due > GRACE_MS) continue;
    const slot = `${pb.id}@${new Date(due).toISOString()}`;
    if (state.taskSlots.has(slot)) continue;
    const lifetime = (pb.schedule.every ?? 60) * 60_000;
    events.push({ type: 'task.queued', data: { id: newId('task'), playbookId: pb.id, agentId: pb.agentId, slot, dueAt: new Date(due).toISOString(), expiresAt: new Date(due + lifetime).toISOString() } });
  }
  for (const t of Object.values(state.tasks)) {
    if ((t.status === 'queued' || t.status === 'claimed') && Date.parse(t.expiresAt) < now) {
      events.push({ type: 'task.expired', data: { id: t.id } });
    }
  }
  return events;
}
