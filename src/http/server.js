// Owner web app and API, bound to 127.0.0.1 only. Requests must carry the right Host,
// a same-origin Origin (for writes) and the per-process CSRF token. Approvals, access
// changes, strategy/playbook edits and settings additionally need the approval PIN.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as C from '../core/commands.js';
import { deskStatus, intentView, lotView, recentFirst, previewPlan, trashView, purgedIds } from '../core/views.js';
import { live } from '../core/state.js';
import { scheduleTick } from '../core/schedule.js';
import { SETTING_RULES, UserError } from '../core/settings.js';
import { EVIDENCE_KINDS } from '../core/evidence.js';
import { RULES } from '../core/strategies.js';
import { LIBRARY_GROUPS, SOURCES, STAGES, WINDOW, MARKET } from '../core/checklist-library.js';
import { researchStatus, masterStatus } from '../core/rules.js';
import { recordStatus } from '../core/knowledge.js';
import { deskRecommendation, latestRecommendation } from '../core/prepare.js';
import { indiaDate } from '../core/time.js';
import { RISK_PRESETS, AGENT_PRESETS, PLAYBOOK_TEMPLATES, PLAN_DEFAULTS, matchRiskPreset } from '../core/presets.js';
import { newId } from '../store/store.js';
import { backupDir } from '../config.js';
import { API_VERSION, codeChangedSinceStart } from '../version.js';
import { SECTIONS, EXCHANGE_SECTIONS, parseSection, deriveSection, currentSection } from '../core/sections.js';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/desk.js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' https://s3.tradingview.com; frame-src https://s.tradingview.com https://www.tradingview-widget.com https://www.tradingview.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
  'prepare.mark': [false, owner(C.markPrepared)],
  'prepare.status': [false, (store, body) => store.read((s, now) => {
    const symbol = String(body.symbol ?? '').trim().toUpperCase();
    const exchange = body.exchange ?? 'NSE';
    if (exchange !== 'NSE' && exchange !== 'BSE') throw new UserError('Exchange must be NSE or BSE.');
    return {
      master: masterStatus(s, symbol, exchange, now),
      strategies: Object.values(s.strategies).filter((x) => x.enabled && live(x)).map((x) => researchStatus(s, symbol, x.id, exchange, now)),
      desk: deskRecommendation(s, symbol, exchange, now),
      agent: latestRecommendation(s, symbol, exchange),
      // Every live record for this stock and MARKET (not just the 200 newest of all stocks in
      // stateView), so the page never hides a record the checks still count.
      records: recentFirst(s.evidence, 500, (e) => live(e) && !e.purged && (e.symbol === symbol || e.symbol === MARKET))
        .map((e) => ({ ...e, status: recordStatus(e, indiaDate(now)) })),
    };
  })],
  'evidence.verify': [false, owner(C.verifyEvidence)],
  'evidence.correct': [false, owner(C.correctEvidence)],
  'evidence.flag': [false, owner(C.flagEvidence)],
  'playbook.save': [true, owner(C.savePlaybook)],
  'evidence.add': [false, owner(C.addEvidence)],
  'note.add': [false, owner(C.addNote)],
  'note.preview': [false, (store, body) => {
    const { data, warnings } = parseSection(body.section, body.text);
    return { data, warnings, derived: deriveSection(body.section, data, { symbol: String(body.symbol ?? '').trim().toUpperCase() }) };
  }],
  'note.section.add': [false, owner(C.addSection)],
  'stock.snapshot': [false, (store, body) => store.read((s) => {
    const symbol = String(body.symbol ?? '').trim().toUpperCase();
    const exchange = body.exchange ?? 'NSE';
    if (exchange !== 'NSE' && exchange !== 'BSE') throw new UserError('Exchange must be NSE or BSE.');
    const sections = {};
    for (const section of Object.keys(SECTIONS)) {
      const ex = EXCHANGE_SECTIONS.has(section) ? exchange : undefined;
      const current = currentSection(s, symbol, section, ex);
      // Older versions, newest first. Never trashed or purged; never promoted to current.
      const history = s.notes.filter((n) => n.section === section && n.symbol === symbol && (n.exchange ?? undefined) === ex && n.revisedBy && live(n) && !n.purged).reverse();
      sections[section] = { current, derived: current ? deriveSection(section, current.data, { symbol }) : null, history };
    }
    return { sections };
  })],
  'intent.submit': [false, owner(C.submitIntent)],
  'intent.approve': [true, owner(C.approveIntent)],
  'intent.reject': [false, owner(C.rejectIntent)],
  'intent.withdraw': [false, owner(C.withdrawIntent)],
  'fill.buy': [false, owner(C.recordBuyFill)],
  'fill.sell': [false, owner(C.recordSale)],
  'lot.stop': [false, owner(C.changeStop)],
  'trash.move': [false, owner(C.moveToTrash)],
  'trash.restore': [false, owner(C.restoreFromTrash)],
  'trash.purge': [true, owner(C.purgeFromTrash)],
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
    strategies: Object.values(s.strategies).filter(live),
    // Names of every agent, including trashed ones, so old ledger lines and calls still read well.
    agentNames: Object.fromEntries(Object.values(s.agents).filter((a) => !a.purged).map((a) => [a.id, a.name])),
    agents: Object.values(s.agents).filter(live).map((a) => ({ ...a, usage: s.usage[`agent:${a.id}`] ?? {} })),
    intents: Object.values(s.intents).filter(live).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200).map((i) => intentView(s, i, now)),
    lots: Object.values(s.lots).filter(live).map(lotView).sort((a, b) => b.date.localeCompare(a.date)),
    evidence: recentFirst(s.evidence, 200, live).map((e) => ({ ...e, status: recordStatus(e, indiaDate(now)) })),
    recommendations: recentFirst(s.recommendations, 100, live),
    notes: recentFirst(s.notes, 100, live),
    playbooks: Object.values(s.playbooks).filter(live),
    tasks: Object.values(s.tasks).filter(live).sort((a, b) => b.dueAt.localeCompare(a.dueAt)).slice(0, 50),
    trash: trashView(s),
    calls: store.recentCalls(30),
    meta: {
      api: API_VERSION,
      restartNeeded: codeChangedSinceStart(),
      sections: SECTIONS,
      settingRules: SETTING_RULES,
      evidenceKinds: EVIDENCE_KINDS,
      ruleKinds: Object.keys(RULES),
      checklist: { groups: LIBRARY_GROUPS, sources: SOURCES, stages: STAGES, window: WINDOW, market: MARKET },
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
        // Purged items stay in the log (the chain must still check out) but their contents are not shown.
        const purged = store.read((s) => purgedIds(s));
        const events = store.events({ before, limit: 100 }).map((e) => (!e.type.startsWith('item.') && (purged.has(e.data.id) || purged.has(e.data.lotId)) ? { ...e, data: { id: e.data.id }, purged: true } : e));
        return send(res, 200, { events, chain: store.verify() });
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
