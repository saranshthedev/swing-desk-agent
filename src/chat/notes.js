// Tells Claude, in the chat, when the owner overrules something an agent wrote.
import { chatSetting, setChatSetting, listThreads, addMessage } from './history.js';

const fromAgent = (by) => typeof by === 'string' && by.startsWith('agent:');
const cut = (t, n = 120) => { const s = String(t ?? '').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

function shown(r) {
  if (r.price !== undefined) return `₹${r.price}`;
  if (r.marginPct !== undefined) return `${r.marginPct}%`;
  return cut(r.summary);
}

/** Plain-language notes for owner events that overrule an agent's record. Pure. */
export function overruleNotes(state, events) {
  const out = [];
  for (const e of events) {
    if (e.actor !== 'owner') continue;
    const d = e.data;
    if (e.type === 'evidence.corrected') {
      const old = state.evidence.find((x) => x.id === d.corrects);
      if (!old || !fromAgent(old.by)) continue;
      out.push(`You corrected ${old.symbol} · ${old.kind}: “${shown(old)}” → “${shown(d)}”. Reason: ${d.reason}`);
    } else if (e.type === 'note.structured') {
      const old = d.revises && state.notes.find((n) => n.id === d.revises);
      if (!old || !fromAgent(old.by)) continue;
      out.push(`You re-saved ${d.symbol} · ${d.title} over the agent’s version.`);
    } else if (e.type === 'evidence.flagged') {
      const ev = state.evidence.find((x) => x.id === d.id);
      if (!ev || !fromAgent(ev.by)) continue;
      out.push(`You flagged ${ev.symbol} · ${ev.kind}: ${d.reason}`);
    } else if (e.type === 'intent.rejected') {
      const intent = state.intents[d.id];
      if (!intent || !fromAgent(intent.by)) continue;
      out.push(`You rejected the ${intent.kind} request${intent.symbol ? ` for ${intent.symbol}` : ''}. Reason: ${d.reason || 'none given'}`);
    }
  }
  return out;
}

/** Posts new overrule notes to the newest thread. The first call only marks the present. */
export function syncOverruleNotes(store) {
  const last = chatSetting(store, 'notes_seq');
  const now = store.state.seq;
  if (last === null) { setChatSetting(store, 'notes_seq', now); return []; }
  if (now <= last) return [];
  const texts = store.read((s) => overruleNotes(s, store.eventsAfter(last)));
  const thread = listThreads(store)[0];
  const posted = thread ? texts.map((text) => addMessage(store, thread.id, { role: 'note', text })) : [];
  setChatSetting(store, 'notes_seq', now);
  return posted;
}

export function correctionsBlock(notes) {
  return notes.length ? `Owner corrections since your last reply:\n${notes.map((n) => `- ${n.text}`).join('\n')}\n\n` : '';
}
