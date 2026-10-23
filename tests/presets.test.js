import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core/commands.js';
import { evaluate } from '../src/core/rules.js';
import { DEFAULT_SETTINGS, SETTING_RULES, validateSettingsPatch } from '../src/core/settings.js';
import { RISK_PRESETS, AGENT_PRESETS, PLAYBOOK_TEMPLATES, PLAN_DEFAULTS, riskPresetSettings, matchRiskPreset } from '../src/core/presets.js';
import { INFO, INFO_IN } from '../web/info.js';
import { desk, PLAN } from './helpers.js';

test('every risk preset is valid at small and large capital, and is recognised again', () => {
  for (const capital of [10_000, 1_00_000, 10_00_000, 1_00_00_000]) {
    for (const key of Object.keys(RISK_PRESETS)) {
      const settings = riskPresetSettings(key, capital);
      assert.doesNotThrow(() => validateSettingsPatch(settings, DEFAULT_SETTINGS), `${key} at ₹${capital}`);
      assert.equal(matchRiskPreset(settings), key);
    }
  }
  assert.equal(matchRiskPreset(DEFAULT_SETTINGS), 'balanced');
  assert.equal(matchRiskPreset({ ...DEFAULT_SETTINGS, maxOpenLots: 7 }), null);
});

test('presets get stricter from Active to Careful', () => {
  const [c, b, a] = ['careful', 'balanced', 'active'].map((k) => RISK_PRESETS[k].values);
  for (const k of ['riskPct', 'cashPerTradePct', 'maxOpenLots', 'maxOpenRiskPct', 'maxBorrowedPct', 'weeklyLossLimitPct']) {
    assert.ok(c[k] < b[k] && b[k] < a[k], k);
  }
  assert.ok(c.minRewardRisk > b.minRewardRisk && b.minRewardRisk > a.minRewardRisk);
});

test('agent presets and playbook templates are accepted as they are', () => {
  const d = desk();
  for (const p of Object.values(AGENT_PRESETS)) {
    const { id } = d.owner(C.addAgent, { name: p.label, scope: p.scope, limits: p.limits });
    assert.deepEqual(d.store.read((s) => s.agents[id].limits), p.limits);
  }
  const agentId = d.store.read((s) => Object.keys(s.agents)[0]);
  for (const t of Object.values(PLAYBOOK_TEMPLATES)) {
    assert.doesNotThrow(() => d.owner(C.savePlaybook, { name: t.name, agentId, schedule: t.schedule, instructions: t.instructions, maxIntents: t.maxIntents }), t.label);
  }
});

test('each strategy’s plan defaults pass that strategy’s own fixed rules', () => {
  const d = desk();
  const agent = d.addAgent('propose');
  for (const strategyId of ['breakout', 'pullback', 'results']) {
    const pd = PLAN_DEFAULTS[strategyId];
    const plan = { ...PLAN, days: pd.days, buyType: pd.buyType, marginPct: undefined, ...(pd.leverage ? { leverage: pd.leverage } : {}) };
    const { id } = agent.run(C.submitIntent, { kind: 'buy', symbol: 'ABC', strategyId, thesis: 'x', plan });
    const ev = d.store.read((s, now) => evaluate(s, s.intents[id], now));
    for (const c of ev.checks.filter((x) => x.id.startsWith('item:') && ['plan-time', 'money-regular-for-events', 'plan-stop-distance'].includes(x.id.slice(5)))) {
      assert.equal(c.status, 'pass', `${strategyId}: ${c.label}`);
    }
  }
});

test('every risk setting and every plan field has easy help text', () => {
  for (const key of [...Object.keys(SETTING_RULES), 'preset', 'pin', 'symbol', 'strategyId', 'exchange', 'buyType', 'fundingMode', 'fundingValue', 'entry', 'stop', 'target', 'days', 'thesis']) {
    assert.ok(INFO[key], `missing help for ${key}`);
    assert.ok(INFO[key].length <= 220, `help for ${key} is too long to read quickly`);
  }
  for (const [form, map] of Object.entries(INFO_IN)) for (const [k, v] of Object.entries(map)) assert.ok(v.length <= 220, `${form}.${k}`);
});
