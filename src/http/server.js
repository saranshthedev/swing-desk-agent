// Owner web app and API, bound to 127.0.0.1 only. Requests must carry the right Host,
// a same-origin Origin (for writes) and the per-process CSRF token. Approvals, access
// changes, strategy/playbook edits and settings additionally need the approval PIN.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as C from '../core/commands.js';
import { deskStatus, intentView, lotView, recentFirst, previewPlan } from '../core/views.js';
import { scheduleTick } from '../core/schedule.js';
import { SETTING_RULES, UserError } from '../core/settings.js';
import { EVIDENCE_KINDS } from '../core/evidence.js';
import { RULES } from '../core/strategies.js';
import { LIBRARY_GROUPS, SOURCES, STAGES, RESEARCH_VALID_DAYS, MARKET } from '../core/checklist-library.js';
import { researchStatus } from '../core/rules.js';
import { RISK_PRESETS, AGENT_PRESETS, PLAYBOOK_TEMPLATES, PLAN_DEFAULTS, matchRiskPreset } from '../core/presets.js';
import { newId } from '../store/store.js';
import { backupDir } from '../config.js';
import { API_VERSION, codeChangedSinceStart } from '../version.js';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/desk.js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** Owner actions: [needsPin, handler(store, body) → result]. */
const owner = (fn) => (store, body) => store.run('owner', (s, ctx) => fn(s, body, ctx));
const ACTIONS = {
  'settings.change': [true, owner(C.changeSettings)],
  'automation.pause': [false, owner((s) => C.setAutomation(s, { paused: true }))],
  'automation.resume': [true, owner((s) => C.setAutomation(s, { paused: false }))],
  'agent.add': [true, (store, body) => {
    const { id } = store.run('owner', (s, ctx) => C.addAgent(s, body, ctx));
    return { id, key: store.issueKey(id) };
  }],
  'agent.update': [true, owner(C.updateAgent)],
  'agent.rekey': [true, (store, body) => {
    if (!store.read((s) => s.agents[body.id])) throw new UserError('That agent does not exist.');
    return { id: body.id, key: store.issueKey(body.id) };
  }],
  'strategy.save': [true, owner(C.saveStrategy)],
  'research.save': [false, owner(C.saveResearch)],
  'research.status': [false, (store, body) => store.read((s, now) => researchStatus(s, String(body.symbol ?? '').trim().toUpperCase(), body.strategyId, now))],
  'playbook.save': [true, owner(C.savePlaybook)],
  'evidence.add': [false, owner(C.addEvidence)],
  'note.add': [false, owner(C.addNote)],
  'intent.submit': [false, owner(C.submitIntent)],
  'intent.approve': [true, owner(C.approveIntent)],
  'intent.reject': [false, owner(C.rejectIntent)],
  'intent.withdraw': [false, owner(C.withdrawIntent)],
  'fill.buy': [false, owner(C.recordBuyFill)],
  'fill.sell': [false, owner(C.recordSale)],
  'lot.stop': [false, owner(C.changeStop)],
  'plan.preview': [false, (store, body) => store.read((s) => previewPlan(s, body))],
  'pin.set': [false, (store, body) => { store.setPin(body.pin, body.oldPin); return { ok: true }; }],
  backup: [false, (store) => {
    const file = join(backupDir(), `desk-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    store.backup(file);
    return { file };
  }],
};

export function stateView(store) {
  return store.read((s, now) => ({
    now,
    status: deskStatus(s, now),
    pinSet: store.hasPin(),
    strategies: Object.values(s.strategies),
    agents: Object.values(s.agents).map((a) => ({ ...a, usage: s.usage[`agent:${a.id}`] ?? {} })),
    intents: Object.values(s.intents).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200).map((i) => intentView(s, i, now)),
    lots: Object.values(s.lots).map(lotView).sort((a, b) => b.date.localeCompare(a.date)),
    evidence: recentFirst(s.evidence, 200),
    notes: recentFirst(s.notes, 100),
    playbooks: Object.values(s.playbooks),
    tasks: Object.values(s.tasks).sort((a, b) => b.dueAt.localeCompare(a.dueAt)).slice(0, 50),
    calls: store.recentCalls(30),
    meta: {
      api: API_VERSION,
      restartNeeded: codeChangedSinceStart(),
      settingRules: SETTING_RULES,
      evidenceKinds: EVIDENCE_KINDS,
      ruleKinds: Object.keys(RULES),
      checklist: { groups: LIBRARY_GROUPS, sources: SOURCES, stages: STAGES, researchValidDays: RESEARCH_VALID_DAYS, market: MARKET },
      presets: {
        risk: RISK_PRESETS,
        currentRisk: matchRiskPreset(s.settings),
        agents: AGENT_PRESETS,
        playbooks: PLAYBOOK_TEMPLATES,
        plan: PLAN_DEFAULTS,
      },
      // What a model app needs to launch the MCP server against this same database.
      mcp: { command: process.execPath, args: [BIN, 'mcp'], ...(process.env.SWING_DESK_DATA ? { env: { SWING_DESK_DATA: process.env.SWING_DESK_DATA } } : {}) },
    },
  }));
}

export function createApp(store, { port }) {
  const csrf = randomBytes(24).toString('base64url');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { ...HEADERS, 'Content-Type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };

  return async function handler(req, res) {
    try {
      if (!hosts.has(req.headers.host)) return send(res, 421, { error: 'Open the desk at http://127.0.0.1:' + port });
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(name)) return send(res, 404, 'Not found', 'text/plain');
        try {
          return send(res, 200, await readFile(join(WEB, name)), TYPES[extname(name)]);
        } catch {
          return send(res, 404, 'Not found', 'text/plain');
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/session') {
        if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 403, { error: 'Forbidden' });
        return send(res, 200, { csrf });
      }
      if (req.headers['x-csrf'] !== csrf) return send(res, 403, { error: 'Reload the page and try again.' });

      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, stateView(store));
      if (req.method === 'GET' && url.pathname === '/api/ledger') {
        const before = Number(url.searchParams.get('before')) || undefined;
        return send(res, 200, { events: store.events({ before, limit: 100 }), chain: store.verify() });
      }

      const action = req.method === 'POST' && url.pathname.startsWith('/api/action/') ? ACTIONS[url.pathname.slice(12)] : null;
      if (!action) return send(res, 404, { error: 'Not found' });
      if (req.headers.origin && !origins.has(req.headers.origin)) return send(res, 403, { error: 'Forbidden' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });

      const body = await readJson(req);
      const [needsPin, run] = action;
      if (needsPin) {
        store.checkPin(body.pin);
        delete body.pin;
      }
      return send(res, 200, { ok: true, result: run(store, body) ?? null });
    } catch (err) {
      if (err instanceof UserError) return send(res, 400, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong. Nothing was saved.' });
    }
  };
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new UserError('Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolveBody(body);
      } catch {
        reject(new UserError('Send a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

export function startServer(store, { port }) {
  const server = createServer(createApp(store, { port }));
  const tick = () => {
    try {
      store.run('system', (s, ctx) => ({ events: scheduleTick(s, ctx.now, newId) }));
    } catch (err) {
      console.error('Scheduler:', err.message);
    }
  };
  tick();
  const timer = setInterval(tick, 30_000);
  server.on('close', () => clearInterval(timer));
  return new Promise((ok, fail) => {
    server.once('error', (err) => {
      clearInterval(timer);
      if (err.code !== 'EADDRINUSE') return fail(err);
      const busy = new UserError(`Port ${port} is already in use. Swing Desk may already be running in another window: open http://127.0.0.1:${port}. Or stop the other one with Ctrl + C.`);
      busy.code = 'PORT_IN_USE';
      fail(busy);
    });
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}
