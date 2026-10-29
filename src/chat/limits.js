import { UserError } from '../core/settings.js';

export const CHAT_LIMITS = {
  replyMinutes: { label: 'Reply time limit', unit: 'minutes', default: 15, min: 1, max: 120 },
  toolCalls: { label: 'Tool calls per reply', unit: 'tool calls', default: 60, min: 1, max: 500 },
  modelTurns: { label: 'Claude turns per reply', unit: 'Claude turns', default: 40, min: 1, max: 200 },
  idleMinutes: { label: 'Close an idle session after', unit: 'minutes', default: 10, min: 1, max: 120 },
};

export function chatLimits(input = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(CHAT_LIMITS)) {
    const v = input[key] ?? spec.default;
    if (!Number.isInteger(v) || v < spec.min || v > spec.max) {
      throw new UserError(`${spec.label} must be a whole number from ${spec.min} to ${spec.max}.`);
    }
    out[key] = v;
  }
  // Limits the owner switched off are not enforced; the number is kept for when it is switched back on.
  if (input.off !== undefined) {
    if (!Array.isArray(input.off)) throw new UserError('Switched-off limits must be a list.');
    for (const k of input.off) if (!(k in CHAT_LIMITS)) throw new UserError(`Unknown limit ${k}.`);
    const off = [...new Set(input.off)];
    if (off.length) out.off = off;
  }
  return out;
}

export function limitOn(limits, key) {
  return !(limits.off ?? []).includes(key);
}

const TAIL = 'Anything Claude already recorded is on the desk. Send ‘continue’ to carry on.';

export function stopMessage(key, limits) {
  if (key === 'replyMinutes') return `Stopped after ${limits.replyMinutes} minutes (your reply time limit). ${TAIL}`;
  if (key === 'toolCalls') return `Stopped after ${limits.toolCalls} tool calls (your tool-call limit). ${TAIL}`;
  if (key === 'modelTurns') return `Stopped after ${limits.modelTurns} Claude turns (your Claude-turns limit). ${TAIL}`;
  throw new UserError(`Unknown limit ${key}.`);
}
