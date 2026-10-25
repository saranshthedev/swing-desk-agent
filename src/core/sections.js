// Structured note sections: read pasted text with fixed rules (no AI, no web), write it back as
// canonical text, and work out a few figures from the numbers. Pure: no I/O.
import { UserError } from './settings.js';

export const SECTIONS = {
  swot: 'SWOT',
  overview: 'Overview',
  results: 'Quarterly results',
  shareholding: 'Shareholding pattern',
  peers: 'Peers',
};
export const EXCHANGE_SECTIONS = new Set(['overview', 'peers']);

const MAX_TEXT = 20_000;
const MAX_BULLET = 300;
const MAX_BULLETS = 20;
const MAX_ROWS = 40;
const MAX_COLUMNS = 12;
const MAX_EXTRA = 50;
const MAX_TEXT_VALUE = 200;

// ---------- shared helpers ----------

const lines = (text) => text.split(/\r\n|\r|\n/);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const clip = (s, n = 50) => (s.length > n ? `${s.slice(0, n)}…` : s);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Cut a pasted label or text value to 200 characters; the first cut in a section adds one warning. */
function textCapper(warnings) {
  let warned = false;
  return (t) => {
    if (t.length <= MAX_TEXT_VALUE) return t;
    if (!warned) {
      warned = true;
      warnings.push(`Some labels or text values were longer than ${MAX_TEXT_VALUE} characters and were shortened.`);
    }
    return t.slice(0, MAX_TEXT_VALUE);
  };
}

/** A number from pasted text: commas, rupee signs, percent signs and spaces are ignored. Null if unreadable. */
function numOf(value) {
  const t = String(value).replace(/[,₹%\s]/g, '').replace(/[−–]/g, '-');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function pct(cur, prev) {
  if (!isNum(cur) || !isNum(prev) || prev === 0) return null;
  return round2(((cur - prev) / Math.abs(prev)) * 100);
}

// ---------- overview ----------

const OVERVIEW_LABELS = [
  ['open', ['Open']],
  ['prevClose', ['Previous Close']],
  ['ltp', ['Close', 'LTP', 'Last Price', 'Last Traded Price']],
  ['volume', ['Volume']],
  ['valueLacs', ['Value (Lacs)']],
  ['vwap', ['VWAP']],
  ['beta', ['Beta']],
  ['mktCapCr', ['Mkt Cap (Rs. Cr.)']],
  ['high', ['High']],
  ['low', ['Low']],
  ['ucLimit', ['UC Limit']],
  ['lcLimit', ['LC Limit']],
  ['high52', ['52 Week High']],
  ['low52', ['52 Week Low']],
  ['faceValue', ['Face Value']],
  ['allTimeHigh', ['All Time High']],
  ['allTimeLow', ['All Time Low']],
  ['avgVol20', ['20D Avg Volume']],
  ['avgDelivery20', ['20D Avg Delivery(%)']],
  ['bookValue', ['Book Value Per Share']],
  ['dividendYield', ['Dividend Yield']],
  ['ttmEps', ['TTM EPS']],
  ['ttmPe', ['TTM PE']],
  ['pb', ['P/B']],
  ['sectorPe', ['Sector PE']],
];
const LABEL_KEY = new Map(OVERVIEW_LABELS.flatMap(([key, names]) => names.map((n) => [norm(n), key])));
const KEY_LABEL = Object.fromEntries(OVERVIEW_LABELS.map(([key, names]) => [key, names[0]]));

/** Is the text after a label a value we can read (a number, a number with a remark, a dash/NA, or nothing)? */
function readable(rest) {
  if (rest === '') return true;
  if (/^(—|–|-|na|n\/a)$/i.test(rest)) return true;
  const m = rest.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return numOf(m ? m[1] : rest) !== null;
}

const MAX_LABEL_LINE = 200; // labels are short; longer lines are never label lines (keeps parsing linear)
const MAX_LABEL_WORDS = 8;

/** Find a known label at the start of a line: `{ key, rest }` or null. */
function findLabel(line) {
  if (line.length > MAX_LABEL_LINE) return null;
  const m = line.match(/^(.*?)(?:\t+|\s*:\s*|\s{2,})(.*)$/);
  if (m && LABEL_KEY.has(norm(m[1])) && readable(m[2].trim())) return { key: LABEL_KEY.get(norm(m[1])), rest: m[2].trim() };
  if (LABEL_KEY.has(norm(line))) return { key: LABEL_KEY.get(norm(line)), rest: '' };
  const words = line.split(/\s+/);
  for (let i = Math.min(words.length - 1, MAX_LABEL_WORDS); i >= 1; i--) {
    const head = words.slice(0, i).join(' ');
    const rest = words.slice(i).join(' ');
    if (LABEL_KEY.has(norm(head)) && readable(rest)) return { key: LABEL_KEY.get(norm(head)), rest };
  }
  return null;
}

/** `13.34 (Low PE)` -> `{ number: 13.34, tag: 'Low PE' }`. */
function valueAndTag(text) {
  const m = text.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  const body = m ? m[1] : text;
  return { number: numOf(body), body, tag: m ? m[2].trim() : '' };
}

function parseOverview(text) {
  const warnings = [];
  const rows = {};
  const tags = {};
  const extra = [];
  const cap = textCapper(warnings);
  let extraSkipped = false;
  let pending = null; // label waiting for its value on a later line
  let last = null; // label that already has a value (a remark line may follow)

  const unreadable = (key) => {
    rows[key] = null;
    warnings.push(`Could not read a value for “${KEY_LABEL[key]}”.`);
  };
  const dropPending = () => {
    if (pending) unreadable(pending);
    pending = null;
  };
  const setValue = (key, v) => {
    if (key in rows) warnings.push(`“${KEY_LABEL[key]}” appears more than once; using the last value.`);
    rows[key] = v.number;
    if (v.number === null) warnings.push(`Could not read a value for “${KEY_LABEL[key]}”.`);
    delete tags[key];
    if (v.tag) tags[key] = cap(v.tag);
    last = key;
  };

  for (const raw of lines(text)) {
    const line = raw.trim();
    if (!line) continue;
    const hit = line.startsWith('(') ? null : findLabel(line);
    if (hit) {
      dropPending();
      if (hit.rest === '') {
        pending = hit.key;
        last = null;
      } else {
        setValue(hit.key, valueAndTag(hit.rest));
      }
      continue;
    }
    if (/^see\b/i.test(line)) continue; // noise such as "See historical trend"
    if (pending) {
      const v = valueAndTag(line);
      if (v.number !== null && !line.startsWith('(')) {
        const key = pending;
        pending = null;
        setValue(key, v);
        continue;
      }
    } else if (last && /^\(.*\)$/.test(line)) {
      tags[last] = cap(line.slice(1, -1).trim());
      continue;
    }
    if (extra.length >= MAX_EXTRA) {
      if (!extraSkipped) warnings.push(`More than ${MAX_EXTRA} unread lines were skipped.`);
      extraSkipped = true;
      continue;
    }
    warnings.push(`Could not read the line “${clip(line)}”.`);
    const split = line.match(/^(.*?)(?:\t+|\s{2,})(.*)$/);
    extra.push(split ? { label: cap(split[1].trim()), text: cap(split[2].trim()) } : { label: cap(line), text: '' });
  }
  dropPending();
  if (!Object.keys(rows).length) throw new UserError('I could not find any known Overview labels such as Open, VWAP or 52 Week Low in that text.');
  return { data: { rows, tags, extra }, warnings };
}

function formatOverview(data) {
  const out = [];
  for (const [key] of OVERVIEW_LABELS) {
    if (!(key in data.rows)) continue;
    const v = data.rows[key];
    out.push(v === null ? KEY_LABEL[key] : `${KEY_LABEL[key]}\t${v}`);
    if (data.tags?.[key]) out.push(`(${data.tags[key]})`);
  }
  for (const e of data.extra ?? []) out.push(e.text ? `${e.label}\t${e.text}` : e.label);
  return out.join('\n');
}

function deriveOverview(data) {
  const r = data.rows;
  const pick = [['ltp', 'Last price'], ['vwap', 'VWAP'], ['prevClose', 'Previous close']].find(([k]) => isNum(r[k]));
  const ref = pick ? r[pick[0]] : null;
  const referencePrice = pick ? { name: pick[1], value: ref } : null;
  const aboveLow52Pct = ref !== null && isNum(r.low52) && r.low52 !== 0 ? round2((ref / r.low52 - 1) * 100) : null;
  const belowHigh52Pct = ref !== null && isNum(r.high52) && r.high52 !== 0 ? round2((1 - ref / r.high52) * 100) : null;
  const peVsSectorPct = isNum(r.ttmPe) && isNum(r.sectorPe) && r.sectorPe !== 0 ? round2((r.ttmPe / r.sectorPe - 1) * 100) : null;
  return {
    referencePrice,
    aboveLow52Pct,
    belowHigh52Pct,
    peVsSectorPct,
    nearLow52: aboveLow52Pct === null ? null : aboveLow52Pct <= 10,
    withinLimits: ref !== null && isNum(r.lcLimit) && isNum(r.ucLimit) ? ref >= r.lcLimit && ref <= r.ucLimit : null,
  };
}

// ---------- swot ----------

const SWOT_KEYS = { strength: 'strengths', weakness: 'weaknesses', opportunit: 'opportunities', threat: 'threats' };
const SWOT_HEADS = { strengths: 'Strengths', weaknesses: 'Weaknesses', opportunities: 'Opportunities', threats: 'Threats' };
const SWOT_HEADING = /^[\s\-–—*#•]*(strengths?|weakness(?:es)?|opportunit(?:y|ies)|threats?)\s*[:\-–—]*\s*$/i;

function parseSwot(text) {
  const warnings = [];
  const data = { strengths: [], weaknesses: [], opportunities: [], threats: [] };
  let list = null;
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(SWOT_HEADING);
    if (head) {
      const w = head[1].toLowerCase();
      list = data[SWOT_KEYS[Object.keys(SWOT_KEYS).find((p) => w.startsWith(p))]];
      continue;
    }
    if (!list) {
      warnings.push(`Skipped “${clip(line)}” because it is before any heading (Strengths, Weakness, Opportunities, Threats).`);
      continue;
    }
    let bullet = line.replace(/^(?:[-–—•*·]+\s*|\d+[.)]\s+)/, '').trim();
    if (!bullet) continue;
    if (list.length >= MAX_BULLETS) {
      warnings.push(`Only the first ${MAX_BULLETS} points of a list are kept; skipped “${clip(bullet)}”.`);
      continue;
    }
    if (bullet.length > MAX_BULLET) {
      warnings.push(`Shortened a point to ${MAX_BULLET} characters: “${clip(bullet)}”.`);
      bullet = bullet.slice(0, MAX_BULLET);
    }
    list.push(bullet);
  }
  if (!Object.values(data).some((l) => l.length)) throw new UserError('I could not find any points under Strengths, Weakness, Opportunities or Threats in that text.');
  return { data, warnings };
}

function formatSwot(data) {
  return Object.keys(SWOT_HEADS).map((k) => [`${SWOT_HEADS[k]} :`, ...(data[k] ?? []).map((b) => `- ${b}`)].join('\n')).join('\n');
}

// ---------- grids (results, shareholding, peers) ----------

const splitCells = (line) => (line.includes('\t') ? line.replace(/\r$/, '').split('\t') : line.trim().split(/\s{2,}/)).map((c) => c.trim());

function cellOf(raw) {
  const t = raw.trim();
  if (/^(|—|–|-|na|n\/a|nil)$/i.test(t)) return null;
  const n = numOf(t);
  return n === null ? t : n;
}

const NOT_A_TABLE = 'I could not read a table from that text. Paste the table with its header row, values separated by tabs.';

function parseGrid(text) {
  const warnings = [];
  const rawLines = lines(text).filter((l) => l.trim());
  if (rawLines.length < 2) throw new UserError('I need a header line and at least one row. Paste the table with the column names on the first line.');
  const header = splitCells(rawLines[0]);
  const body = rawLines.slice(1).map(splitCells);
  const n = body[0].length;
  const dropFirst = header.length === n || (header.length !== n - 1 && header[0] === '');
  let columns = dropFirst ? header.slice(1) : header;
  if (columns.length > MAX_COLUMNS) {
    warnings.push(`Only the first ${MAX_COLUMNS} columns are kept.`);
    columns = columns.slice(0, MAX_COLUMNS);
  }
  if (!columns.length) throw new UserError(NOT_A_TABLE);
  const cap = textCapper(warnings);
  const rows = [];
  for (const cells of body) {
    const label = cells[0] && cap(cells[0]);
    if (!label) {
      warnings.push('Skipped a row with no name.');
      continue;
    }
    if (rows.length >= MAX_ROWS) {
      warnings.push(`Only the first ${MAX_ROWS} rows are kept.`);
      break;
    }
    const values = cells.slice(1);
    if (values.length !== (dropFirst ? header.length - 1 : header.length)) warnings.push(`The row “${clip(label)}” has ${values.length} values but there are ${columns.length} columns; blanks were filled in or extras dropped.`);
    rows.push({ label, cells: columns.map((_, i) => (i < values.length ? (() => { const c = cellOf(values[i]); return typeof c === 'string' ? cap(c) : c; })() : null)) });
  }
  if (!rows.length) throw new UserError('I could not find any rows in that table.');
  if (!rows.some((r) => r.cells.some((c) => c !== null))) throw new UserError(NOT_A_TABLE);
  return { data: { columns, rows }, warnings };
}

function formatGrid(data) {
  const cell = (c) => (c === null || c === undefined ? '—' : String(c));
  return [`\t${data.columns.join('\t')}`, ...data.rows.map((r) => [r.label, ...r.cells.map(cell)].join('\t'))].join('\n');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function periodKey(label) {
  const m = String(label).trim().match(/^([A-Za-z]{3})[A-Za-z]*[\s'’\-/]*(\d{4}|\d{2})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return year * 12 + month;
}

/** Newest-first when every column parses as `Mon YYYY` and the first is later than the last; otherwise last is newest. */
function newestFirst(columns) {
  const keys = columns.map(periodKey);
  return columns.length > 1 && keys.every((k) => k !== null) && keys[0] > keys[keys.length - 1];
}

const oldestFirst = (cells, reversed) => (reversed ? [...cells].reverse() : cells);

function deriveResults(data) {
  const reversed = newestFirst(data.columns);
  const rows = [];
  for (const row of data.rows) {
    const s = oldestFirst(row.cells, reversed);
    const n = s.length;
    const latest = n ? s[n - 1] : null;
    const l = String(row.label);
    if (/margin/i.test(l)) {
      const prev = n > 1 ? s[n - 2] : null;
      rows.push({ label: row.label, kind: 'margin', latest: isNum(latest) ? latest : null, marginChangePp: isNum(latest) && isNum(prev) ? round2(latest - prev) : null });
    } else if (/revenue|sales|income|net profit|\bpat\b|profit after tax/i.test(l)) {
      let rising = 0;
      for (let i = n - 1; i > 0 && isNum(s[i]) && isNum(s[i - 1]) && s[i] > s[i - 1]; i--) rising++;
      rows.push({
        label: row.label,
        kind: /net profit|\bpat\b|profit after tax/i.test(l) ? 'profit' : 'revenue',
        latest: isNum(latest) ? latest : null,
        qoqPct: n > 1 ? pct(latest, s[n - 2]) : null,
        yoyPct: n >= 5 ? pct(latest, s[n - 5]) : null,
        risingQuarters: rising,
      });
    }
  }
  return { order: reversed ? 'newest first' : 'newest last', rows };
}

function deriveShareholding(data) {
  const reversed = newestFirst(data.columns);
  const rows = data.rows.map((row) => {
    const s = oldestFirst(row.cells, reversed);
    const n = s.length;
    const latest = n ? s[n - 1] : null;
    const previous = n > 1 ? s[n - 2] : null;
    const changePp = isNum(latest) && isNum(previous) ? round2(latest - previous) : null;
    return {
      label: row.label,
      latest: isNum(latest) ? latest : null,
      previous: isNum(previous) ? previous : null,
      changePp,
      direction: changePp === null ? null : changePp > 0 ? 'increased' : changePp < 0 ? 'decreased' : 'unchanged',
      increased: changePp !== null && changePp > 0,
      decreased: changePp !== null && changePp < 0,
    };
  });
  return { order: reversed ? 'newest first' : 'newest last', rows };
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return round2(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

function derivePeers(data, ctx) {
  const sym = String(ctx?.symbol ?? '').trim().toLowerCase();
  const labels = data.rows.map((r) => String(r.label).toLowerCase());
  let ownIndex = -1;
  if (sym) {
    ownIndex = labels.indexOf(sym);
    if (ownIndex < 0) ownIndex = labels.findIndex((l) => l.includes(sym));
  }
  // Maps by column index, then plain objects with own keys only (column names like "constructor" or "__proto__" are safe).
  const medianAt = new Map();
  data.columns.forEach((_, ci) => {
    const m = median(data.rows.filter((_r, i) => i !== ownIndex).map((r) => r.cells[ci]).filter(isNum));
    if (m !== null) medianAt.set(ci, m);
  });
  const medians = Object.fromEntries([...medianAt].map(([ci, m]) => [data.columns[ci], m]));
  const rows = data.rows.map((row, i) => ({
    label: row.label,
    own: i === ownIndex,
    vsMedianPct: Object.fromEntries([...medianAt].map(([ci, m]) => [data.columns[ci], isNum(row.cells[ci]) && m !== 0 ? round2((row.cells[ci] / m - 1) * 100) : null])),
  }));
  return { ownRow: ownIndex >= 0 ? data.rows[ownIndex].label : null, medians, rows };
}

// ---------- public API ----------

const PARSERS = { swot: parseSwot, overview: parseOverview, results: parseGrid, shareholding: parseGrid, peers: parseGrid };

const known = (section) => typeof section === 'string' && Object.hasOwn(SECTIONS, section);

/** Read pasted text. Returns `{ data, warnings }`; throws UserError when nothing usable is there. */
export function parseSection(section, text) {
  if (!known(section)) throw new UserError('Unknown section. Use swot, overview, results, shareholding or peers.');
  if (typeof text !== 'string' || !text.trim()) throw new UserError('Paste the text for this section first.');
  if (text.length > MAX_TEXT) throw new UserError(`That text is too long. Keep it under ${MAX_TEXT.toLocaleString('en-IN')} characters.`);
  return PARSERS[section](text);
}

/** Canonical paste text; `parseSection(section, formatSection(section, data))` gives back `data`. */
export function formatSection(section, data) {
  if (!known(section)) throw new UserError('Unknown section. Use swot, overview, results, shareholding or peers.');
  if (section === 'swot') return formatSwot(data);
  if (section === 'overview') return formatOverview(data);
  return formatGrid(data);
}

/** Figures the desk works out from the pasted numbers. */
export function deriveSection(section, data, ctx = {}) {
  switch (section) {
    case 'overview': return deriveOverview(data);
    case 'results': return deriveResults(data);
    case 'shareholding': return deriveShareholding(data);
    case 'peers': return derivePeers(data, ctx);
    case 'swot': return { counts: Object.fromEntries(Object.keys(SWOT_HEADS).map((k) => [k, (data[k] ?? []).length])) };
    default: throw new UserError('Unknown section. Use swot, overview, results, shareholding or peers.');
  }
}

/**
 * Every live (not trashed, not deleted) record for a stock's section (and exchange), newest first by
 * saved time. Records saved at the same instant keep the order they were saved in (later is newer;
 * ids are random so they cannot break the tie). The first is the current one; the rest are earlier versions.
 */
export function liveSections(state, symbol, section, exchange) {
  return state.notes
    .map((n, i) => [n, i])
    .filter(([n]) => n.section === section && n.symbol === symbol && (n.exchange ?? undefined) === (exchange ?? undefined) && !n.trashed && !n.purged)
    .sort(([a, i], [b, j]) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1) || j - i)
    .map(([n]) => n);
}

/** The current record: the newest live one. Trashing it brings the previous version back. */
export function currentSection(state, symbol, section, exchange) {
  return liveSections(state, symbol, section, exchange)[0] ?? null;
}
