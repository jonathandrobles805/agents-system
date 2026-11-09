// View model of the Architecture Canvas. Pure functions: the manifest (and facts about one project) in, plain data out.
// No DOM, no network, no clock (callers pass `now`), so every rule here is unit-tested in kit/scripts/tests/dashboard_model.test.js.

export const KINDS = {
  command: { label: 'COMMAND', plural: 'commands' },
  agent: { label: 'AGENT', plural: 'agents' },
  hook: { label: 'HOOK', plural: 'hooks' },
  ci: { label: 'CI CHECK', plural: 'CI checks' },
  script: { label: 'CORE SCRIPT', plural: 'core scripts' },
  'ci-job': { label: 'CI JOB', plural: 'CI jobs' },
  test: { label: 'TEST FILE', plural: 'test files' },
  template: { label: 'TEMPLATE', plural: 'templates' },
  settings: { label: 'SETTINGS', plural: 'settings' },
  tool: { label: 'TOOL', plural: 'tools' },
  shell: { label: 'SHELL SCRIPT', plural: 'shell scripts' },
};
export const kindLabel = (kind) => (KINDS[kind] ? KINDS[kind].label : String(kind).toUpperCase());
export const kindPlural = (kind) => (KINDS[kind] ? KINDS[kind].plural : `${kind}s`);

/** A running lane is one whose event log moved in the last two minutes. */
export const RUNNING_WINDOW_MS = 120000;

export function index(manifest) {
  const byId = new Map(manifest.nodes.map((n) => [n.id, n]));
  const out = new Map();
  const inn = new Map();
  for (const e of manifest.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inn.has(e.to)) inn.set(e.to, []);
    out.get(e.from).push(e);
    inn.get(e.to).push(e);
  }
  return { byId, out, inn };
}

// ---------------------------------------------------------------------------------------------- impact

/**
 * What a change to `id` reaches: the dependents grouped by kind ("12 of 12 hooks", first name and "+N"), the tests and CI
 * jobs among them, and what `id` itself depends on. Read from the manifest's derived data; nothing is estimated.
 */
export function blastRadius(manifest, idx, id) {
  const node = idx.byId.get(id);
  if (!node) return null;
  const d = node.derived ?? { dependents: [], tests: [], jobs: [], direct_tests: [], cases: 0 };
  const totals = new Map();
  for (const n of manifest.nodes) totals.set(n.kind, (totals.get(n.kind) ?? 0) + 1);
  const byKind = new Map();
  for (const dep of d.dependents) {
    const kind = idx.byId.get(dep).kind;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(dep);
  }
  const groups = [...byKind.entries()]
    .map(([kind, ids]) => ({ kind, label: kindPlural(kind), count: ids.length, total: totals.get(kind), ids, first: idx.byId.get(ids[0]).label, more: ids.length - 1 }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
  const dependsOn = (idx.out.get(id) ?? []).map((e) => ({ id: e.to, kind: e.kind, label: idx.byId.get(e.to).label, evidence: e.evidence, event: e.event ?? null }));
  return {
    id,
    dependents: d.dependents,
    groups,
    tests: d.tests,
    jobs: d.jobs,
    directTests: d.direct_tests,
    cases: d.cases,
    dependsOn,
    coversAll: d.dependents.length > 0 && groups.every((g) => g.count === g.total),
  };
}

// ---------------------------------------------------------------------------------------------- state

const TONE_ORDER = ['bad', 'warn', 'run', 'next', 'idle'];

/**
 * State of every component for one project. `ctx`:
 *   git      {modified: [paths]}                  uncommitted changes in the kit repository
 *   overlay  {hooks: {missing: [{node}]}, lanes: [{slug, stage, last_check}]}   one project, never several
 *   lastEventAt {slug: epoch ms}, now epoch ms
 * Returns Map(id -> {tone, tags: [{key, label, detail}]}); `tone` is the strongest tag.
 */
export function nodeStates(manifest, idx, ctx = {}) {
  const modified = new Set(ctx.git?.modified ?? []);
  const overlay = ctx.overlay ?? null;
  const now = ctx.now ?? 0;
  const missing = new Set((overlay?.hooks?.missing ?? []).map((h) => h.node));
  const laneAgents = new Map(); // agent id -> [{slug, stage, running}]
  for (const lane of overlay?.lanes ?? []) {
    const stage = manifest.pipeline.find((s) => s.id === lane.stage);
    if (!stage) continue;
    const running = (ctx.lastEventAt?.[lane.slug] ?? 0) > now - RUNNING_WINDOW_MS && !lane.needs_human;
    for (const a of stage.agents) {
      if (!laneAgents.has(`agent:${a}`)) laneAgents.set(`agent:${a}`, []);
      laneAgents.get(`agent:${a}`).push({ slug: lane.slug, stage: lane.stage, running });
    }
  }
  const failing = (overlay?.lanes ?? []).filter((l) => l.last_check && l.last_check.result && l.last_check.result !== 'ok');
  const states = new Map();
  for (const n of manifest.nodes) {
    const tags = [];
    const problems = manifest.problems.filter((p) => p.component === n.id);
    for (const p of problems) tags.push({ key: p.severity === 'error' ? 'violation' : 'warning', label: p.severity === 'error' ? 'Violation' : 'Warning', detail: p.message, tone: p.severity === 'error' ? 'bad' : 'warn' });
    if (modified.has(n.path)) tags.push({ key: 'modified', label: 'Modified', detail: 'uncommitted changes in git', tone: 'warn' });
    if (n.kind === 'hook' && overlay && missing.has(n.id)) tags.push({ key: 'missing', label: 'Not installed', detail: 'this project\'s settings.json does not register it', tone: 'warn' });
    if (n.id === 'hook:post_edit_check' && failing.length) tags.push({ key: 'failing', label: 'Failing', detail: `last check failed in ${failing.map((l) => l.slug).join(', ')}`, tone: 'bad' });
    for (const l of laneAgents.get(n.id) ?? []) {
      tags.push(l.running ? { key: 'running', label: 'Running', detail: `lane ${l.slug}, stage ${l.stage}`, tone: 'run' } : { key: 'next', label: 'Next up', detail: `lane ${l.slug}, stage ${l.stage}`, tone: 'next' });
    }
    const tone = tags.reduce((best, t) => (TONE_ORDER.indexOf(t.tone) < TONE_ORDER.indexOf(best) ? t.tone : best), 'idle');
    states.set(n.id, { tone, tags });
  }
  return states;
}

// ---------------------------------------------------------------------------------------------- layout

export const BANDS = [
  { key: 'commands', title: 'ORCHESTRATION · commands', kinds: ['command'], w: 124, h: 38 },
  { key: 'agents', title: 'AGENTS', kinds: ['agent'], w: 188, h: 76 },
  { key: 'hooks', title: 'GATES · hooks', kinds: ['hook'], w: 150, h: 48 },
  { key: 'scripts', title: 'CORE · scripts', kinds: ['script'], w: 150, h: 40 },
  { key: 'ci', title: 'CI · checks', kinds: ['ci'], w: 150, h: 40 },
  { key: 'jobs', title: 'CI · jobs', kinds: ['ci-job'], w: 190, h: 40 },
];

/** Components in the order a reader expects: /run first, agents in pipeline order, the rest by name. */
export function orderedNodes(manifest, kind) {
  const nodes = manifest.nodes.filter((n) => n.kind === kind);
  if (kind === 'agent') {
    const order = [];
    for (const s of manifest.pipeline) for (const a of s.agents) if (!order.includes(`agent:${a}`)) order.push(`agent:${a}`);
    const rank = (n) => (order.includes(n.id) ? order.indexOf(n.id) : order.length);
    return nodes.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
  }
  if (kind === 'command') return nodes.sort((a, b) => (a.id === 'command:run' ? -1 : b.id === 'command:run' ? 1 : a.id < b.id ? -1 : 1));
  return nodes.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Place every band's components on a grid that wraps at `width`. Returns {width, height, bands: [{key, title, y, nodes: [{id, x, y, w, h}]}]}. */
export function layoutBands(manifest, width = 1080, { pad = 20, gap = 12, head = 30, bandGap = 26 } = {}) {
  const bands = [];
  let y = pad;
  for (const b of BANDS) {
    const nodes = b.kinds.flatMap((k) => orderedNodes(manifest, k));
    if (!nodes.length) continue;
    const perRow = Math.max(1, Math.floor((width - 2 * pad + gap) / (b.w + gap)));
    const top = y + head;
    const placed = nodes.map((n, i) => ({ id: n.id, x: pad + (i % perRow) * (b.w + gap), y: top + Math.floor(i / perRow) * (b.h + gap), w: b.w, h: b.h }));
    const rows = Math.ceil(nodes.length / perRow);
    bands.push({ key: b.key, title: b.title, y, nodes: placed });
    y = top + rows * (b.h + gap) - gap + bandGap;
  }
  return { width, height: y - bandGap + pad, bands };
}

/** SVG path from the bottom centre of box `a` to the top centre of box `b` (or sideways when `b` is not below `a`). */
export function edgePath(a, b) {
  if (b.y > a.y + a.h) {
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const dy = Math.max(20, (y2 - y1) / 2);
    return `M${x1} ${y1} C${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`;
  }
  const x1 = a.x + a.w / 2;
  const y1 = a.y;
  const x2 = b.x + b.w / 2;
  const y2 = b.y;
  const lift = 26;
  return `M${x1} ${y1} C${x1} ${y1 - lift} ${x2} ${y2 - lift} ${x2} ${y2}`;
}

// ---------------------------------------------------------------------------------------------- pipeline

/** The stages of /run with the lanes of one project that stand at each: [{...stage, lanes: [slug]}]. */
export function pipelineView(manifest, overlay) {
  return manifest.pipeline.map((s) => ({ ...s, lanes: (overlay?.lanes ?? []).filter((l) => l.stage === s.id).map((l) => l.slug) }));
}

// ---------------------------------------------------------------------------------------------- search

export function searchNodes(manifest, query, kind = null) {
  const q = String(query ?? '').trim().toLowerCase();
  return manifest.nodes.filter((n) => (!kind || n.kind === kind) && (q === '' || n.id.toLowerCase().includes(q) || n.label.toLowerCase().includes(q) || (n.purpose ?? '').toLowerCase().includes(q)));
}

/** URL of a component's file on GitHub (default branch), or null when the kit repository has no GitHub remote. */
export function githubFileUrl(git, node, branch = 'main') {
  return git && git.repo_url && node ? `${git.repo_url}/blob/${branch}/${node.path}` : null;
}
