import { TOOLS } from '../mcp/tools.js';

const PREFIX = 'mcp__swing-desk__';
const MAX = 160;

// Plain phrases for every desk tool. `s` is the upper-cased symbol (or '' when absent).
const PHRASES = {
  whoami: () => 'Read the desk: who Claude is connected as',
  desk_status: () => 'Read the desk: overall status',
  list_strategies: () => 'Read the desk: your strategies',
  get_checklist_library: () => 'Read the desk: the checklist library',
  get_research_status: (s) => `Read the desk: research progress${of(s)}`,
  list_lots: () => 'Read the desk: your holdings',
  list_requests: () => 'Read the desk: pending requests',
  get_request: () => 'Read the desk: one request',
  calculate_plan: (s) => `Worked out a trade plan${of(s)}`,
  list_evidence: (s) => `Read the desk: evidence records${of(s)}`,
  get_recommendation: (s) => `Read the desk: the recommendation${of(s)}`,
  list_notes: (s) => `Read the desk: notes${of(s)}`,
  next_task: () => 'Asked the desk for the next task',
  complete_task: () => 'Marked a task done',
  fail_task: () => 'Marked a task as failed',
  add_note: (s) => `Saved a note${of(s)}`,
  add_structured_note: (s, i) => `Saved ${s || 'a note'}${i.section ? ` · ${clean(i.section)}` : ''}`,
  add_evidence: (s) => `Added an evidence record${of(s, 'for')}`,
  flag_evidence: () => 'Flagged an evidence record',
  add_recommendation: (s) => `Saved a recommendation${of(s, 'for')}`,
  propose_buy: (s) => `Proposed a buy${of(s, 'of')}`,
  propose_exit: (s) => `Proposed a sale${of(s, 'of')}`,
  propose_settings: () => 'Proposed a settings change',
  withdraw_request: () => 'Withdrew a request',
};

function of(s, word = 'for') {
  return s ? ` ${word} ${s}` : '';
}

function clean(v) {
  return String(v).replace(/\s+/g, ' ').trim();
}

function cut(text) {
  return text.length <= MAX ? text : `${text.slice(0, MAX - 1)}…`;
}

export function stepLine(toolName, input = {}) {
  input = input && typeof input === 'object' ? input : {};
  if (toolName.startsWith(PREFIX)) {
    const name = toolName.slice(PREFIX.length);
    const phrase = Object.hasOwn(PHRASES, name) ? PHRASES[name] : null;
    const symbol = typeof input.symbol === 'string' && input.symbol.trim() ? clean(input.symbol).toUpperCase() : '';
    const write = Object.hasOwn(TOOLS, name) ? Boolean(TOOLS[name].write) : false;
    return { tool: toolName, summary: cut(phrase ? phrase(symbol, input) : `Used ${toolName}`), write };
  }
  if (toolName === 'WebSearch') {
    const q = typeof input.query === 'string' ? clean(input.query) : '';
    return { tool: toolName, summary: q ? cut(`Searched the web: “${q.slice(0, MAX - 22)}”`) : 'Searched the web', write: false };
  }
  if (toolName === 'WebFetch') {
    let host = '';
    try { host = new URL(input.url).hostname; } catch { /* not a URL */ }
    return { tool: toolName, summary: cut(host ? `Read ${host}` : 'Read a web page'), write: false };
  }
  return { tool: toolName, summary: cut(`Used ${toolName}`), write: false };
}
