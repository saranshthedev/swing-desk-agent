// Snapshot sections (Overview, SWOT, results, shareholding, peers) as tables and lists.
// Pure HTML builders. Every pasted or model-written string goes through esc().

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, digits = 2) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: digits });
const rupees = (v) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** 1.5 → “1.5%”, 26.22 → “26%”: one decimal for small changes, whole numbers from 10% up. */
const pctWord = (x) => { const a = Math.abs(x); return `${a >= 10 ? Math.round(a) : Number(a.toFixed(1))}%`; };
const points = (x) => { const a = Number(Math.abs(x).toFixed(2)); return `${a} point${a === 1 ? '' : 's'}`; };
const cell = (v) => (v === null || v === undefined ? '<span class="muted">—</span>' : isNum(v) ? num(v) : esc(v));

// ---------- Overview ----------

const OVERVIEW_GROUPS = [
  ['Today', [['open', 'Open', 'price'], ['prevClose', 'Previous close', 'price'], ['ltp', 'Last price', 'price'], ['vwap', 'VWAP (average traded price)', 'price'],
    ['high', 'Day high', 'price'], ['low', 'Day low', 'price'], ['ucLimit', 'Upper limit (UC)', 'price'], ['lcLimit', 'Lower limit (LC)', 'price']]],
  ['Range', [['high52', '52-week high', 'price'], ['low52', '52-week low', 'price'], ['allTimeHigh', 'All-time high', 'price'], ['allTimeLow', 'All-time low', 'price']]],
  ['Valuation', [['mktCapCr', 'Market value', 'crore'], ['ttmEps', 'Earnings per share (last 12 months)', 'price'], ['ttmPe', 'PE (last 12 months)', 'ratio'],
    ['sectorPe', 'Sector PE', 'ratio'], ['pb', 'Price to book (P/B)', 'ratio'], ['bookValue', 'Book value per share', 'price'], ['dividendYield', 'Dividend yield', 'pct'], ['faceValue', 'Face value', 'price']]],
  ['Activity', [['volume', 'Volume (shares)', 'count'], ['valueLacs', 'Value traded', 'lakh'], ['avgVol20', '20-day average volume', 'count'],
    ['avgDelivery20', '20-day average delivery', 'pct'], ['beta', 'Beta (how much it moves with the market)', 'ratio']]],
];
const REF_KEY = { 'Last price': 'ltp', VWAP: 'vwap', 'Previous close': 'prevClose' };

function overviewValue(v, unit) {
  if (!isNum(v)) return '<span class="muted">could not read</span>';
  if (unit === 'price') return rupees(v);
  if (unit === 'crore') return `₹${num(v)} crore`;
  if (unit === 'lakh') return `₹${num(v)} lakh`;
  if (unit === 'pct') return `${num(v)}%`;
  if (unit === 'count') return num(v, 0);
  return num(v);
}

function overviewNote(key, d) {
  if (!d) return '';
  if (d.referencePrice && REF_KEY[d.referencePrice.name] === key) return 'Reference price for the figures in this column';
  if (key === 'low52' && isNum(d.aboveLow52Pct)) return `${pctWord(d.aboveLow52Pct)} ${d.aboveLow52Pct < 0 ? 'below' : 'above'} the 52-week low${d.nearLow52 ? ' · near the low' : ''}`;
  if (key === 'high52' && isNum(d.belowHigh52Pct)) return `${pctWord(d.belowHigh52Pct)} ${d.belowHigh52Pct < 0 ? 'above' : 'below'} the 52-week high`;
  if (key === 'ttmPe' && isNum(d.peVsSectorPct)) return d.peVsSectorPct === 0 ? 'PE is the same as the sector’s' : `PE is ${pctWord(d.peVsSectorPct)} ${d.peVsSectorPct < 0 ? 'below' : 'above'} the sector’s`;
  if (key === 'ucLimit' && d.withinLimits !== null && d.withinLimits !== undefined) return d.withinLimits ? 'Reference price is inside today’s limits (LC to UC)' : 'Reference price is outside today’s limits. Check the pasted numbers.';
  return '';
}

function overviewHtml(data, d) {
  const rows = data.rows ?? {};
  const tags = data.tags ?? {};
  const ref = d?.referencePrice;
  const top = d ? `<p class="snap-ref">${ref ? `Reference price: <b>${esc(ref.name)} ${rupees(ref.value)}</b> <span class="small muted">(the desk uses the last price, else VWAP, else the previous close)</span>` : '<span class="muted">No last price, VWAP or previous close was pasted, so there are no worked-out figures.</span>'}</p>` : '';
  const body = OVERVIEW_GROUPS.map(([group, list]) => {
    const present = list.filter(([key]) => Object.hasOwn(rows, key));
    if (!present.length) return '';
    return `<tr class="snap-group"><th colspan="3" scope="rowgroup">${group}</th></tr>${present.map(([key, label, unit]) => `<tr><th scope="row">${label}</th>
      <td class="num mono">${overviewValue(rows[key], unit)}${Object.hasOwn(tags, key) ? ` <span class="small muted">(${esc(tags[key])})</span>` : ''}</td>
      <td class="small">${esc(overviewNote(key, d))}</td></tr>`).join('')}`;
  }).join('');
  const extra = (data.extra ?? []).length ? `<h4>Other lines</h4><ul class="snap-extra small">${data.extra.map((e) => `<li>${esc(e.label)}${e.text ? `: ${esc(e.text)}` : ''}</li>`).join('')}</ul>` : '';
  return `${top}<div class="table-wrap"><table class="snap-table snap-overview"><thead><tr><th>Item</th><th class="num">Value</th><th>Worked out by the desk</th></tr></thead><tbody>${body}</tbody></table></div>${extra}`;
}

// ---------- SWOT ----------

const SWOT = [['strengths', 'Strengths'], ['weaknesses', 'Weaknesses'], ['opportunities', 'Opportunities'], ['threats', 'Threats']];

function swotHtml(data) {
  return `<div class="swot-grid">${SWOT.map(([key, label]) => {
    const list = data[key] ?? [];
    return `<section class="swot-box swot-${key}" data-list="${key}"><h4>${label} <span class="small muted">${list.length}</span></h4>
      ${list.length ? `<ul>${list.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '<p class="small muted">None pasted.</p>'}</section>`;
  }).join('')}</div>`;
}

// ---------- grids: results, shareholding, peers ----------

const upDown = (x, what) => (x === 0 ? `unchanged on ${what}` : `${x > 0 ? 'up' : 'down'} ${pctWord(x)} on ${what}`);

function resultsNote(r) {
  if (!r) return '';
  const label = String(r.label);
  if (r.kind === 'margin') return isNum(r.marginChangePp) ? (r.marginChangePp === 0 ? 'Margin unchanged on the quarter before' : `Margin ${r.marginChangePp > 0 ? 'up' : 'down'} ${points(r.marginChangePp)} on the quarter before`) : '';
  const parts = [];
  if (r.risingQuarters >= 2) parts.push(`${label} rose in each of the last ${r.risingQuarters} quarters`);
  else if (r.risingQuarters === 1) parts.push(`${label} rose in the latest quarter`);
  else if (isNum(r.qoqPct)) parts.push(`${label} did not rise in the latest quarter`);
  if (isNum(r.qoqPct)) parts.push(upDown(r.qoqPct, 'the quarter before'));
  if (isNum(r.yoyPct)) parts.push(upDown(r.yoyPct, 'a year earlier'));
  return parts.join(' · ');
}

function shareholdingNote(r) {
  if (!r || !isNum(r.changePp)) return '';
  const who = /holding|pledge/i.test(r.label) ? r.label : `${r.label} holding`;
  return r.changePp === 0 ? `${who} unchanged` : `${who} ${r.changePp > 0 ? 'rose' : 'fell'} ${points(r.changePp)}`;
}

/** Derived rows matched to table rows by label, first unused match first (labels may repeat). */
function matcher(derivedRows) {
  const left = [...(derivedRows ?? [])];
  return (label) => {
    const i = left.findIndex((r) => r.label === label);
    return i < 0 ? null : left.splice(i, 1)[0];
  };
}

function orderLine(columns, d) {
  if (!d?.order || !columns.length) return '';
  const newest = d.order === 'newest first' ? columns[0] : columns.at(-1);
  return `<p class="small muted">Newest period: ${esc(newest)} (${d.order === 'newest first' ? 'the first column' : 'the last column'}).</p>`;
}

function gridTable(data, extraHead, extraCell, rowClass = () => '') {
  const columns = data.columns ?? [];
  return `<div class="table-wrap"><table class="snap-table snap-grid"><thead><tr><th><span class="visually-hidden">Row</span></th>${columns.map((c) => `<th class="num">${esc(c)}</th>`).join('')}${extraHead ? `<th>${extraHead}</th>` : ''}</tr></thead>
    <tbody>${(data.rows ?? []).map((r) => `<tr${rowClass(r)}><th scope="row">${esc(r.label)}</th>${columns.map((_, i) => `<td class="num mono">${cell(r.cells?.[i])}</td>`).join('')}${extraHead ? `<td class="small">${esc(extraCell(r))}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function resultsHtml(data, d) {
  const match = matcher(d?.rows);
  return orderLine(data.columns ?? [], d) + gridTable(data, d ? 'Worked out by the desk' : '', (r) => resultsNote(match(r.label)));
}

function shareholdingHtml(data, d) {
  const match = matcher(d?.rows);
  return `${orderLine(data.columns ?? [], d)}${gridTable(data, d ? 'Worked out by the desk' : '', (r) => shareholdingNote(match(r.label)))}
    ${d ? '<p class="small muted">Change from the quarter before, in percentage points. Example: 19.8% to 18.1% is a fall of 1.7 points.</p>' : ''}`;
}

function peersHtml(data, d, ctx) {
  const columns = data.columns ?? [];
  if (!d) return gridTable(data, '', () => '');
  const own = d.rows?.find((r) => r.own);
  const ownLabel = d.ownRow;
  const table = gridTable(data, '', () => '', (r) => (ownLabel !== null && r.label === ownLabel ? ' class="snap-own"' : ''));
  const median = (c) => (Object.hasOwn(d.medians ?? {}, c) ? d.medians[c] : null);
  const vs = (c) => {
    const v = own && Object.hasOwn(own.vsMedianPct ?? {}, c) ? own.vsMedianPct[c] : null;
    return isNum(v) ? (v === 0 ? 'same as the median' : `${pctWord(v)} ${v > 0 ? 'above' : 'below'}`) : '—';
  };
  const worked = `<div class="table-wrap"><table class="snap-table snap-grid"><thead><tr><th>Worked out by the desk</th>${columns.map((c) => `<th class="num">${esc(c)}</th>`).join('')}</tr></thead><tbody>
    <tr><th scope="row" class="snap-wrap">Median of the peers${ownLabel !== null ? ` (not counting ${esc(ownLabel)})` : ''}</th>${columns.map((c) => `<td class="num mono">${cell(median(c))}</td>`).join('')}</tr>
    ${own ? `<tr class="snap-own"><th scope="row" class="snap-wrap">${esc(ownLabel)} against the median</th>${columns.map((c) => `<td class="num small">${esc(vs(c))}</td>`).join('')}</tr>` : ''}
    </tbody></table></div>`;
  const note = ownLabel === null ? `<p class="small muted">${esc(ctx?.symbol ?? 'This stock')} is not one of the rows, so every row counts in the median. Add its own row to compare it.</p>` : '';
  return `${table}${worked}${note}`;
}

/** The body of one section: `derived` is null for earlier versions (no worked-out figures shown). */
export function sectionBody(section, data, derived, ctx = {}) {
  if (!data) return '';
  if (section === 'overview') return overviewHtml(data, derived);
  if (section === 'swot') return swotHtml(data);
  if (section === 'results') return resultsHtml(data, derived);
  if (section === 'shareholding') return shareholdingHtml(data, derived);
  if (section === 'peers') return peersHtml(data, derived, ctx);
  return '';
}

/** Lines the desk could not read, one plain line each. */
export function warningsHtml(warnings) {
  if (!warnings?.length) return '<p class="small muted">Every line was read.</p>';
  return `<ul class="snap-warnings small">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
}
