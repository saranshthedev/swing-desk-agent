import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS, EXCHANGE_SECTIONS, parseSection, formatSection, deriveSection, currentSection } from '../src/core/sections.js';
import * as C from '../src/core/commands.js';
import { UserError } from '../src/core/settings.js';
import { performance } from 'node:perf_hooks';
import { desk } from './helpers.js';
import { trashView } from '../src/core/views.js';

const OVERVIEW = `Open	692.55
Previous Close	694.05
Volume	1,89,89,022
Value (Lacs)	1,31,555.94
VWAP	692.13
Beta
1.22
Mkt Cap (Rs. Cr.)	10,68,200
High	696.80
Low	686.85
UC Limit	711.65
LC Limit	670.25
52 Week High	1,017.50
52 Week Low	681.90
Face Value	1
All Time High	1,020.50
All Time Low	7.85
20D Avg Volume	3,14,62,518
20D Avg Delivery(%)	59.64
Book Value Per Share	390.37
Dividend Yield	2.24
TTM EPS
See historical trend
51.95
(+10.51% YoY)
TTM PE
See historical trend
13.34
(Low PE)
P/B
See historical trend
1.78
(Low P/B)
Sector PE	18.08`;

const SWOT = `Strengths :
Growth in Net Profit with increasing Profit Margin (QoQ)
Increasing Revenue every Quarter for the past 4 Quarters
Annual EPS Improving for last 2 years
Company with Zero Promoter Pledge
--Weakness :
FII/FPI decreased their shareholding last quarter
Near 52 Week Low
Inefficient use of shareholder funds - ROE declining
Inefficient use of capital to generate profits - RoCE declining`;

const RESULTS = `\tMar 2026\tDec 2025\tSep 2025\tJun 2025\tMar 2025
Revenue\t1200\t1100\t1000\t900\t800
Net Profit\t100\t90\t95\t80\t70
Net Margin %\t8.3\t8.2\t9.5\t8.9\t8.8`;

const RESULTS_OLD_FIRST = `\tMar 2025\tJun 2025\tSep 2025\tDec 2025\tMar 2026
Revenue\t800\t900\t1000\t1100\t1200
Net Profit\t70\t80\t95\t90\t100
Net Margin %\t8.8\t8.9\t9.5\t8.2\t8.3`;

const SHARE = `\tDec 2025\tMar 2026
Promoters\t50.1\t50.1
FII/FPI\t20.1\t18.4
DII\t10\t11.2
Public\t19.8\t20.3
Pledge\t0\t0`;

const PEERS = `\tPE\tROE %
ABC Ltd\t10\t20
Alpha\t20\t10
Beta Co\t30\t30
Gamma\t40\t—`;

const near = (a, b, tol = 0.06) => assert.ok(Math.abs(a - b) <= tol, `${a} not near ${b}`);

test('constants', () => {
  assert.deepEqual(SECTIONS, { swot: 'SWOT', overview: 'Overview', results: 'Quarterly results', shareholding: 'Shareholding pattern', peers: 'Peers' });
  assert.deepEqual([...EXCHANGE_SECTIONS].sort(), ['overview', 'peers']);
});

test('overview fixture parses', () => {
  const { data, warnings } = parseSection('overview', OVERVIEW);
  assert.deepEqual(warnings, []);
  const r = data.rows;
  assert.equal(r.open, 692.55);
  assert.equal(r.volume, 18989022);
  assert.equal(r.valueLacs, 131555.94);
  assert.equal(r.beta, 1.22);
  assert.equal(r.mktCapCr, 1068200);
  assert.equal(r.high52, 1017.5);
  assert.equal(r.avgDelivery20, 59.64);
  assert.equal(r.ttmEps, 51.95);
  assert.equal(r.ttmPe, 13.34);
  assert.equal(r.pb, 1.78);
  assert.equal(r.sectorPe, 18.08);
  assert.equal(r.ltp, undefined);
  assert.deepEqual(data.tags, { ttmEps: '+10.51% YoY', ttmPe: 'Low PE', pb: 'Low P/B' });
  assert.deepEqual(data.extra, []);
});

test('overview derived', () => {
  const { data } = parseSection('overview', OVERVIEW);
  const d = deriveSection('overview', data, {});
  assert.equal(d.referencePrice.name, 'VWAP');
  assert.equal(d.referencePrice.value, 692.13);
  near(d.aboveLow52Pct, 1.5);
  near(d.belowHigh52Pct, 31.98);
  near(d.peVsSectorPct, -26.2);
  assert.equal(d.nearLow52, true);
  assert.equal(d.withinLimits, true);
});

test('overview ltp aliases and label matching', () => {
  for (const label of ['Close', 'LTP', 'last price', 'Last Traded Price']) {
    const { data } = parseSection('overview', `${label}\t100\nOpen: 99`);
    assert.equal(data.rows.ltp, 100, label);
    assert.equal(data.rows.open, 99);
  }
  const { data } = parseSection('overview', '20D Avg Delivery (%)  55.5\nTTM PE 12');
  assert.equal(data.rows.avgDelivery20, 55.5);
  assert.equal(data.rows.ttmPe, 12);
  assert.equal(deriveSection('overview', { rows: { ltp: 5, vwap: 6 }, tags: {}, extra: [] }, {}).referencePrice.name, 'Last price');
});

test('overview numbers: rupee, percent, negatives, NA never NaN', () => {
  const { data, warnings } = parseSection('overview', 'Open\t₹1,200.50\nDividend Yield\t2.5%\nBeta\t-0.4\nTTM PE\t—\nP/B\tNA\nSector PE\tabc');
  assert.equal(data.rows.open, 1200.5);
  assert.equal(data.rows.dividendYield, 2.5);
  assert.equal(data.rows.beta, -0.4);
  assert.equal(data.rows.ttmPe, null);
  assert.equal(data.rows.pb, null);
  assert.equal(data.rows.sectorPe, undefined);
  assert.equal(data.extra.length, 1);
  assert.ok(warnings.some((w) => /Sector PE/.test(w)));
  assert.ok(!Object.values(data.rows).some(Number.isNaN));
  const dv = deriveSection('overview', data, {});
  assert.equal(dv.peVsSectorPct, null);
  assert.equal(dv.withinLimits, null);
});

test('overview tolerance: CRLF, blanks, no value, duplicates, unknown line', () => {
  const text = 'Open\t10\r\n\r\nBeta\r\nHigh\t12\r\nOpen\t11\r\nMystery thing here\r\n';
  const { data, warnings } = parseSection('overview', text);
  assert.equal(data.rows.open, 11);
  assert.equal(data.rows.beta, null);
  assert.equal(data.rows.high, 12);
  assert.equal(data.extra.length, 1);
  assert.ok(warnings.includes('Could not read a value for “Beta”.'));
  assert.ok(warnings.some((w) => /Open/.test(w) && /more than once/.test(w)));
  assert.ok(warnings.some((w) => /Mystery thing here/.test(w)));
});

test('swot fixture', () => {
  const { data, warnings } = parseSection('swot', SWOT);
  assert.deepEqual(warnings, []);
  assert.equal(data.strengths.length, 4);
  assert.equal(data.weaknesses.length, 4);
  assert.deepEqual(data.opportunities, []);
  assert.deepEqual(data.threats, []);
  assert.equal(data.strengths[0], 'Growth in Net Profit with increasing Profit Margin (QoQ)');
  const c = deriveSection('swot', data, {});
  assert.deepEqual(c.counts, { strengths: 4, weaknesses: 4, opportunities: 0, threats: 0 });
});

test('swot headings and bullets', () => {
  const text = 'Weaknesses\n- one\n• two\n1. three\n* four\nweakness:\nfive\nOPPORTUNITIES :\nO1\nThreat\nT1';
  const { data } = parseSection('swot', text);
  assert.deepEqual(data.weaknesses, ['one', 'two', 'three', 'four', 'five']);
  assert.deepEqual(data.opportunities, ['O1']);
  assert.deepEqual(data.threats, ['T1']);
  assert.throws(() => parseSection('swot', 'Strengths:\n'), UserError);
  const { warnings } = parseSection('swot', 'stray\nStrengths:\nok');
  assert.ok(warnings.some((w) => /stray/.test(w)));
});

test('swot caps', () => {
  const many = ['Strengths:', ...Array.from({ length: 25 }, (_, i) => `s${i}`), 'x'.repeat(400)].join('\n');
  const { data, warnings } = parseSection('swot', many);
  assert.equal(data.strengths.length, 20);
  assert.ok(warnings.length > 0);
  const long = parseSection('swot', `Threats:\n${'y'.repeat(400)}`);
  assert.equal(long.data.threats[0].length, 300);
});

test('results derived, newest first and oldest first agree', () => {
  const a = parseSection('results', RESULTS);
  assert.deepEqual(a.warnings, []);
  assert.deepEqual(a.data.columns, ['Mar 2026', 'Dec 2025', 'Sep 2025', 'Jun 2025', 'Mar 2025']);
  assert.equal(a.data.rows[0].label, 'Revenue');
  assert.deepEqual(a.data.rows[0].cells, [1200, 1100, 1000, 900, 800]);
  const da = deriveSection('results', a.data, {});
  const rev = da.rows.find((r) => r.label === 'Revenue');
  assert.equal(rev.risingQuarters, 4);
  near(rev.qoqPct, 9.09, 0.01);
  assert.equal(rev.yoyPct, 50);
  const profit = da.rows.find((r) => r.label === 'Net Profit');
  assert.equal(profit.risingQuarters, 1);
  near(profit.qoqPct, 11.11, 0.01);
  const margin = da.rows.find((r) => r.label === 'Net Margin %');
  near(margin.marginChangePp, 0.1, 0.001);
  const b = parseSection('results', RESULTS_OLD_FIRST);
  const db = deriveSection('results', b.data, {});
  assert.deepEqual(db.rows, da.rows);
});

test('results header without corner cell and space-separated', () => {
  const { data } = parseSection('results', 'Mar 2026  Dec 2025\nRevenue  120  100');
  assert.deepEqual(data.columns, ['Mar 2026', 'Dec 2025']);
  assert.deepEqual(data.rows[0].cells, [120, 100]);
});

test('grid cells: rupee, percent, dashes', () => {
  const { data } = parseSection('results', 'x\tMar 2026\tDec 2025\tSep 2025\nRevenue\t₹1,200\t—\tNA\nMargin\t8.3%\t-\t-4.5');
  assert.deepEqual(data.rows[0].cells, [1200, null, null]);
  assert.deepEqual(data.rows[1].cells, [8.3, null, -4.5]);
});

test('shareholding derived', () => {
  const { data } = parseSection('shareholding', SHARE);
  const d = deriveSection('shareholding', data, {});
  const fii = d.rows.find((r) => r.label === 'FII/FPI');
  assert.equal(fii.changePp, -1.7);
  assert.equal(fii.decreased, true);
  assert.equal(fii.direction, 'decreased');
  const dii = d.rows.find((r) => r.label === 'DII');
  assert.equal(dii.changePp, 1.2);
  assert.equal(dii.increased, true);
  const pledge = d.rows.find((r) => r.label === 'Pledge');
  assert.equal(pledge.changePp, 0);
  assert.equal(pledge.decreased, false);
  assert.equal(pledge.increased, false);
});

test('peers derived exclude own row', () => {
  const { data } = parseSection('peers', PEERS);
  const d = deriveSection('peers', data, { symbol: 'abc' });
  assert.equal(d.ownRow, 'ABC Ltd');
  assert.equal(d.medians.PE, 30);
  assert.equal(d.medians['ROE %'], 20);
  const own = d.rows.find((r) => r.own);
  assert.equal(own.label, 'ABC Ltd');
  near(own.vsMedianPct.PE, -66.67, 0.01);
  near(own.vsMedianPct['ROE %'], 0, 0.001);
  const gamma = d.rows.find((r) => r.label === 'Gamma');
  near(gamma.vsMedianPct.PE, 33.33, 0.01);
  assert.equal(gamma.vsMedianPct['ROE %'], null);
  const none = deriveSection('peers', data, { symbol: 'ZZZ' });
  assert.equal(none.ownRow, null);
  assert.equal(none.medians.PE, 25);
});

test('round trips', () => {
  const samples = { overview: OVERVIEW, swot: SWOT, results: RESULTS, shareholding: SHARE, peers: PEERS };
  for (const [s, text] of Object.entries(samples)) {
    const { data } = parseSection(s, text);
    const again = parseSection(s, formatSection(s, data));
    assert.deepEqual(again.data, data, s);
  }
  const odd = parseSection('overview', 'Open\t1\nBeta\nHigh\t2\nSomething odd\tvalue\nLonely line');
  assert.deepEqual(parseSection('overview', formatSection('overview', odd.data)).data, odd.data);
});

test('errors', () => {
  assert.throws(() => parseSection('nope', 'x'), UserError);
  assert.throws(() => parseSection('swot', ''), UserError);
  assert.throws(() => parseSection('swot', '   \n  '), UserError);
  assert.throws(() => parseSection('swot', `Strengths:\n${'a'.repeat(20_001)}`), UserError);
  assert.doesNotThrow(() => parseSection('swot', `Strengths:\n${'a'.repeat(19_000)}`));
  assert.throws(() => parseSection('overview', 'nothing known here'), UserError);
  assert.throws(() => parseSection('results', 'Mar 2026'), UserError);
  assert.throws(() => parseSection('overview', 5), UserError);
});

test('grid limits warn', () => {
  const header = '\t' + Array.from({ length: 14 }, (_, i) => `C${i}`).join('\t');
  const rows = Array.from({ length: 45 }, (_, i) => `R${i}\t` + Array.from({ length: 14 }, () => 1).join('\t'));
  const { data, warnings } = parseSection('peers', [header, ...rows].join('\n'));
  assert.equal(data.columns.length, 12);
  assert.equal(data.rows.length, 40);
  assert.ok(warnings.length >= 2);
});

// ---------- command and reducer ----------

const add = (d, input, who = d.owner) => who(C.addSection, { symbol: 'abc', section: 'swot', text: SWOT, ...input });

test('addSection saves and revises', () => {
  const d = desk();
  const a = add(d, {});
  assert.deepEqual(a.warnings, []);
  d.clock.now += 1000;
  const b = add(d, { text: 'Strengths:\nOnly one' });
  const { notes, cur, first } = d.store.read((s) => ({ notes: s.notes, cur: currentSection(s, 'ABC', 'swot'), first: s.notes.find((n) => n.id === a.id) }));
  assert.equal(notes.length, 2);
  assert.equal(cur.id, b.id);
  assert.equal(cur.revises, a.id);
  assert.equal(first.revisedBy, b.id);
  assert.equal(cur.title, 'SWOT');
  assert.equal(cur.symbol, 'ABC');
  assert.equal(cur.by, 'owner');
  assert.equal(cur.exchange, undefined);
  assert.equal(notes.filter((n) => !n.revisedBy).length, 1);
});

test('exchange sections track per exchange', () => {
  const d = desk();
  assert.throws(() => add(d, { section: 'overview', text: OVERVIEW }), UserError);
  assert.throws(() => add(d, { section: 'overview', text: OVERVIEW, exchange: 'MCX' }), UserError);
  assert.throws(() => add(d, { section: 'swot', exchange: 'NSE' }), UserError);
  const n = add(d, { section: 'overview', text: OVERVIEW, exchange: 'NSE' });
  const b = add(d, { section: 'overview', text: OVERVIEW, exchange: 'BSE' });
  const out = d.store.read((s) => ({ n: currentSection(s, 'ABC', 'overview', 'NSE'), b: currentSection(s, 'ABC', 'overview', 'BSE') }));
  assert.equal(out.n.id, n.id);
  assert.equal(out.b.id, b.id);
  assert.equal(out.b.revises, undefined);
});

test('asOf validation and default', () => {
  const d = desk();
  assert.throws(() => add(d, { asOf: '2026-10-24' }), UserError);
  assert.throws(() => add(d, { asOf: 'yesterday' }), UserError);
  const ok = add(d, { asOf: '2026-10-20' });
  const def = add(d, {});
  d.store.read((s) => {
    assert.equal(s.notes.find((x) => x.id === ok.id).asOf, '2026-10-20');
    assert.equal(s.notes.find((x) => x.id === def.id).asOf, '2026-10-23');
  });
});

test('trashing the current leaves the section empty', () => {
  const d = desk();
  add(d, {});
  d.clock.now += 1000;
  const b = add(d, {});
  d.owner(C.moveToTrash, { kind: 'note', id: b.id });
  assert.equal(d.store.read((s) => currentSection(s, 'ABC', 'swot')), null);
});

test('agent with draft access can add, counts as a write', () => {
  const d = desk();
  const ag = d.addAgent('draft');
  const r = add(d, {}, ag.run);
  assert.ok(r.id);
  const writes = d.store.read((s) => Object.values(s.usage[`agent:${ag.id}`] ?? {})[0].writes);
  assert.equal(writes, 1);
  const rec = d.store.read((s) => s.notes.find((n) => n.id === r.id));
  assert.equal(rec.by, `agent:${ag.id}`);
  assert.throws(() => add(d, { text: 'garbage' }, ag.run), UserError);
});

test('20,000-character single line parses fast', () => {
  const lines = ['a '.repeat(9990), 'Open ' + '1 '.repeat(9990), ' '.repeat(19_990) + 'x', '\t'.repeat(9_990) + 'x', '-'.repeat(19_990) + 'x', 'Strengths ' + '(a'.repeat(9_990)];
  for (const section of Object.keys(SECTIONS)) {
    for (const text of lines) {
      const t0 = performance.now();
      try { parseSection(section, text); } catch (e) { assert.ok(e instanceof UserError); }
      const ms = performance.now() - t0;
      assert.ok(ms < 200, `${section} took ${ms} ms`);
    }
  }
});

test('peers columns named like object properties', () => {
  const { data } = parseSection('peers', '\tconstructor\ttoString\t__proto__\nAlpha\t1\t2\t3\nBeta\t3\t4\t5');
  const d = deriveSection('peers', data, { symbol: 'zzz' });
  assert.deepEqual(Object.keys(d.medians).sort(), ['__proto__', 'constructor', 'toString']);
  assert.equal(Object.getOwnPropertyDescriptor(d.medians, '__proto__').value, 4);
  assert.equal(d.medians.constructor, 2);
  assert.equal(d.rows[0].vsMedianPct.toString, -33.33);
  assert.equal(Object.getOwnPropertyDescriptor(d.rows[1].vsMedianPct, '__proto__').value, 25);
});

test('a noise line starting with a label does not overwrite its value', () => {
  const { data, warnings } = parseSection('overview', 'Open 692.55\nOpen interest rising');
  assert.equal(data.rows.open, 692.55);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Open interest rising/);
  assert.equal(data.extra.length, 1);
});

test('more worked-out figures', () => {
  const p = (text) => deriveSection('overview', parseSection('overview', text).data, {});
  const out = p('LTP\t650\n52 Week Low\t500\n52 Week High\t800\nUC Limit\t600\nLC Limit\t540');
  assert.equal(out.withinLimits, false);
  assert.equal(out.nearLow52, false);
  assert.equal(out.referencePrice.name, 'Last price');
  assert.equal(out.aboveLow52Pct, 30);
  assert.equal(out.belowHigh52Pct, 18.75);
  assert.equal(p('LTP\t520\nLC Limit\t540\nUC Limit\t600').withinLimits, false);
});

test('trashed sections are told apart in the Trash by exchange and as-of date', () => {
  const d = desk();
  const swot = add(d, { asOf: '2026-01-02' });
  const ov = add(d, { section: 'overview', exchange: 'BSE', text: 'VWAP	100' });
  const note = d.owner(C.addNote, { symbol: 'ABC', title: 'Plain', body: 'x' });
  for (const id of [swot.id, ov.id, note.id]) d.owner(C.moveToTrash, { kind: 'note', id });
  const labels = Object.fromEntries(d.store.read((s) => trashView(s)).map((t) => [t.id, t.label]));
  assert.equal(labels[swot.id], 'ABC · SWOT · as of 2026-01-02');
  assert.match(labels[ov.id], /^ABC · Overview · BSE · as of \d{4}-\d{2}-\d{2}$/);
  assert.equal(labels[note.id], 'ABC · Plain');
});
