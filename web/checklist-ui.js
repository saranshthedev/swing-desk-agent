// Grouped, two-stage checklist display used by the request, Prepare, Checklist and Strategies pages.
// A group shows “Done” only when every required sub-item passes. Groups with anything failing,
// missing or waiting for you start open, so problems stay visible.

const STAGE_ORDER = ['research', 'before'];
const CHECK_TYPE = { attest: 'You answer', evidence: 'Needs evidence', rule: 'App checks' };
const STAGE_TAG = { research: ['Before trading day', 'tag-stage-research'], before: ['On trading day', 'tag-stage-before'] };

/** Marker shown on every checklist item: when it is checked. Missing stage means on the day. */
export function stageTag(stage) {
  const [label, cls] = STAGE_TAG[stage] ?? STAGE_TAG.before;
  return `<span class="tag ${cls}">${label}</span>`;
}

/**
 * checks: [{ id, label, status, detail, required, group, stage, help }]
 * opts: { checklist (meta), esc, tag, answer: null | 'ask', extra }
 *   answer 'ask' → checkbox on every item waiting for your answer (on-the-day items at approval).
 *                  Research items are never ticked here: they come from the Prepare page.
 *   extra(check) → optional HTML added under an item (buttons, records, small forms)
 */
export function checklistHtml(checks, opts) {
  const { checklist, esc } = opts;
  return STAGE_ORDER.map((stage) => {
    const list = checks.filter((c) => (c.stage ?? 'before') === stage);
    if (!list.length) return '';
    const req = list.filter((c) => c.required && c.status !== 'info');
    const ok = req.filter((c) => c.status === 'pass').length;
    return `<section class="cl-stage">
      <div class="cl-stage-head"><h3>${stage === 'research' ? '1' : '2'}. ${esc(checklist.stages[stage].title)}</h3><span class="tag ${ok === req.length ? 'tag-ok' : 'tag-ask'}">${ok} of ${req.length} required done</span></div>
      <p class="small muted">${esc(checklist.stages[stage].about)}</p>
      ${groupsOf(list, checklist).map(([gid, items]) => groupHtml(gid, items, opts)).join('')}
    </section>`;
  }).join('');
}

function groupsOf(list, checklist) {
  const order = checklist.groups.map((g) => g.id);
  const map = new Map();
  for (const c of list) {
    const g = c.group ?? 'other';
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(c);
  }
  return [...map].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
}

export const groupName = (gid, checklist) => checklist.groups.find((g) => g.id === gid)?.title ?? (gid === 'other' ? 'Other checks' : gid);

function groupHtml(gid, items, opts) {
  const { esc, tag, checklist } = opts;
  const req = items.filter((c) => c.required && c.status !== 'info');
  const passed = req.filter((c) => c.status === 'pass').length;
  const failed = req.some((c) => c.status === 'fail');
  const state = failed ? 'fail' : passed === req.length ? 'pass' : 'ask';
  const label = failed ? 'Has a failure' : state === 'pass' ? 'Done' : `${req.length - passed} to do`;
  return `<details class="cl-group" ${state === 'pass' ? '' : 'open'}>
    <summary><span class="cl-group-title">${esc(groupName(gid, checklist))}</span> <span class="tag ${state === 'pass' ? 'tag-ok' : failed ? 'tag-bad' : 'tag-ask'}">${label}</span> <span class="small muted">${passed}/${req.length} required</span></summary>
    <ul class="rows cl-items">${items.map((c) => itemHtml(c, opts)).join('')}</ul>
  </details>`;
}

function itemHtml(c, { esc, tag, answer, extra }) {
  const key = c.id.replace(/^item:/, '');
  const box = answer === 'ask' && c.status === 'ask';
  const head = `${tag(c.status)} ${stageTag(c.stage)} <b>${esc(c.label)}</b>${c.required ? '' : ' <span class="muted small">(optional)</span>'}`;
  const body = `<div class="small muted">${esc(c.detail)}</div>${c.help && c.help !== c.detail ? `<div class="small cl-help">${esc(c.help)}</div>` : ''}`;
  const more = extra?.(c) ?? '';
  const attrs = `data-check="${esc(key)}" data-stage="${esc(c.stage ?? 'before')}"`;
  return box
    ? `<li ${attrs}><label class="check cl-answer"><input type="checkbox" name="answer:${esc(key)}"><span>${head}${body}</span></label>${more}</li>`
    : `<li ${attrs}><div>${head}${body}${more}</div></li>`;
}

/** Library view (no statuses): stage tag, label, help, where to look. */
export function libraryHtml(checklist, { esc }) {
  return checklist.groups.map((g) => `<details class="card cl-group cl-library">
    <summary><span class="cl-group-title">${esc(g.title)}</span> <span class="small muted">${g.items.length} checks</span></summary>
    <p class="muted">${esc(g.why)}</p>
    <ul class="rows cl-items">${g.items.map((i) => `<li><div>
      ${stageTag(stageOf(i))}
      <span class="tag tag-muted">${checkType(i)}</span>${i.core ? ' <span class="tag tag-ok">Core</span>' : ''}
      <b>${esc(i.label)}</b>
      <div class="small">${esc(i.help)}</div>
      <div class="small muted">Where to look: ${esc(i.how)}</div></div></li>`).join('')}</ul>
  </details>`).join('');
}

function checkType(i) {
  if (i.check === 'you') return CHECK_TYPE.attest;
  if (i.check.evidence) return `${CHECK_TYPE.evidence}: ${i.check.evidence}${i.check.scope === 'market' ? ' (whole market)' : ''}`;
  return CHECK_TYPE.rule;
}

const stageOf = (i) => i.stage ?? 'before';

/** Library sub-item → strategy checklist item (mirrors src/core/checklist-library.js). */
export function toStrategyItem(i, group) {
  const base = { id: i.id, group, stage: i.stage ?? 'before', label: i.label, help: i.help, required: true, exchangeBound: i.exchangeBound };
  if (i.check === 'you') return { ...base, type: 'attest' };
  if (i.check.evidence) return { ...base, type: 'evidence', kind: i.check.evidence, ...(i.check.maxAgeDays !== undefined ? { maxAgeDays: i.check.maxAgeDays } : {}), scope: i.check.scope };
  return { ...base, type: 'rule', rule: i.check.rule, value: i.check.value };
}

/** Strategy items (no statuses) grouped by stage and group, for the Strategies page. */
export function strategyItemsHtml(items, { checklist, esc }) {
  return STAGE_ORDER.map((stage) => {
    const list = items.map((it) => ({ ...it, stage: it.stage ?? 'before' })).filter((it) => it.stage === stage);
    if (!list.length) return '';
    return `<h3 class="cl-stage-title">${stage === 'research' ? '1' : '2'}. ${esc(checklist.stages[stage].title)} <span class="small muted">${list.length} checks</span></h3>
      <div class="cl-group-grid">${groupsOf(list, checklist).map(([gid, group]) => `<details class="cl-group"><summary><span class="cl-group-title">${esc(groupName(gid, checklist))}</span> <span class="small muted">${group.length}</span></summary>
        <ul class="checklist">${group.map((it) => `<li>${stageTag(it.stage)} <span class="tag tag-muted">${it.type === 'evidence' ? `Evidence: ${esc(it.kind)}${it.scope === 'market' ? ' (market)' : ''}` : CHECK_TYPE[it.type]}</span> ${esc(it.label)}${it.required ? '' : ' <span class="muted">(optional)</span>'}</li>`).join('')}</ul></details>`).join('')}</div>`;
  }).join('');
}
