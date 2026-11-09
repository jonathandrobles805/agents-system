// View model of the Architecture Canvas: layout, component states, blast radius, pipeline, search.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../arch_manifest.js';
import * as V from '../../dashboard/model.js';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = buildManifest(KIT);
const idx = V.index(manifest);

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('layout places every component of a band once, inside the canvas, without overlap', () => {
  for (const width of [700, 1080, 1400]) {
    const layout = V.layoutBands(manifest, width);
    const placed = layout.bands.flatMap((b) => b.nodes);
    assert.equal(new Set(placed.map((n) => n.id)).size, placed.length, 'no component twice');
    for (const n of placed) {
      assert.ok(n.x >= 0 && n.x + n.w <= width, `${n.id} inside ${width}`);
      assert.ok(n.y >= 0 && n.y + n.h <= layout.height, `${n.id} above the bottom edge`);
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!overlap(placed[i], placed[j]), `${placed[i].id} overlaps ${placed[j].id}`);
  }
});

test('layout shows exactly the components of the declared kinds, in band order', () => {
  const layout = V.layoutBands(manifest);
  assert.deepEqual(layout.bands.map((b) => b.key), ['commands', 'agents', 'hooks', 'scripts', 'ci', 'jobs']);
  const shown = new Set(layout.bands.flatMap((b) => b.nodes.map((n) => n.id)));
  for (const n of manifest.nodes.filter((x) => ['command', 'agent', 'hook', 'script', 'ci', 'ci-job'].includes(x.kind))) assert.ok(shown.has(n.id), `${n.id} is on the canvas`);
  const ys = layout.bands.map((b) => b.y);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys);
});

test('/run comes first and agents follow the pipeline', () => {
  assert.equal(V.orderedNodes(manifest, 'command')[0].id, 'command:run');
  assert.deepEqual(V.orderedNodes(manifest, 'agent').map((n) => n.label).slice(0, 4), ['researcher', 'planner', 'spec-critic', 'tester']);
});

test('edges leave the bottom of a box above their target, and loop over the top otherwise', () => {
  const a = { x: 0, y: 0, w: 100, h: 40 };
  assert.match(V.edgePath(a, { x: 200, y: 200, w: 100, h: 40 }), /^M50 40 C/);
  assert.match(V.edgePath(a, { x: 200, y: 10, w: 100, h: 40 }), /^M50 0 C/);
});

test('blast radius groups dependents by kind and counts the tests that cover them', () => {
  const kitlib = V.blastRadius(manifest, idx, 'script:kitlib');
  assert.ok(kitlib.dependents.length > 50);
  assert.ok(kitlib.groups.some((g) => g.kind === 'hook' && g.count === g.total), 'every hook needs kitlib');
  assert.ok(kitlib.tests.length >= 10 && kitlib.cases > 100);
  assert.ok(kitlib.jobs.includes('ci-job:kit/scripts'));
  const g = kitlib.groups[0];
  assert.equal(g.more, g.count - 1);
  assert.equal(V.blastRadius(manifest, idx, 'nope'), null);
  const leaf = V.blastRadius(manifest, idx, 'ci-job:kit/scripts');
  assert.deepEqual(leaf.dependents, []);
  assert.equal(leaf.coversAll, false);
});

test('what a component depends on carries the file and line that says so', () => {
  const agent = V.blastRadius(manifest, idx, 'agent:implementer');
  const guard = agent.dependsOn.find((d) => d.id === 'hook:guard_edit');
  assert.equal(guard.kind, 'hook');
  assert.equal(guard.event, 'PreToolUse');
  assert.equal(guard.evidence.file, 'kit/agents/implementer.md');
  assert.ok(guard.evidence.line > 0);
});

test('states: nothing running, nothing wrong gives an idle kit; problems and git changes show', () => {
  const quiet = V.nodeStates(manifest, idx, { now: 1000 });
  assert.ok([...quiet.values()].every((s) => ['idle', 'warn'].includes(s.tone)), 'only warnings can be present in a clean kit');
  const modified = V.nodeStates(manifest, idx, { git: { modified: ['kit/scripts/hook_guard_edit.js'] }, now: 0 });
  assert.deepEqual(modified.get('hook:guard_edit').tags.map((t) => t.key), ['modified']);
  assert.equal(modified.get('hook:guard_edit').tone, 'warn');
});

test('states: a violation outranks everything and is red', () => {
  const broken = { ...manifest, problems: [...manifest.problems, { id: 'undeclared', severity: 'error', component: 'agent:planner', message: 'x' }] };
  const s = V.nodeStates(broken, V.index(broken), { git: { modified: ['kit/agents/planner.md'] } }).get('agent:planner');
  assert.equal(s.tone, 'bad');
  assert.deepEqual(s.tags.map((t) => t.key).sort(), ['modified', 'violation']);
});

test('states: agents of a lane\'s stage are running with recent events, next up without', () => {
  const overlay = { hooks: { missing: [] }, lanes: [{ slug: 'refund', stage: 'build', needs_human: false, last_check: null }] };
  const now = 1_000_000;
  const next = V.nodeStates(manifest, idx, { overlay, now, lastEventAt: { refund: now - V.RUNNING_WINDOW_MS - 1 } });
  assert.equal(next.get('agent:implementer').tone, 'next');
  assert.equal(next.get('agent:implementer').tags[0].detail, 'lane refund, stage build');
  assert.equal(next.get('agent:reviewer').tone, 'idle');
  const running = V.nodeStates(manifest, idx, { overlay, now, lastEventAt: { refund: now - 1000 } });
  assert.equal(running.get('agent:implementer').tone, 'run');
  assert.equal(running.get('agent:tester').tone, 'run');
  const waiting = V.nodeStates(manifest, idx, { overlay: { ...overlay, lanes: [{ slug: 'refund', stage: 'approve', needs_human: true }] }, now, lastEventAt: { refund: now } });
  assert.equal(waiting.get('agent:planner').tone, 'next', 'a lane waiting for a human is not running');
});

test('states: hooks a project does not register, and a failing last check, are flagged for that project only', () => {
  const overlay = { hooks: { missing: [{ node: 'hook:guard_bash' }] }, lanes: [{ slug: 'x', stage: 'build', last_check: { result: 'fail' } }] };
  const s = V.nodeStates(manifest, idx, { overlay, now: 1 });
  assert.deepEqual(s.get('hook:guard_bash').tags.map((t) => t.key), ['missing']);
  assert.ok(s.get('hook:post_edit_check').tags.some((t) => t.key === 'failing'));
  assert.equal(s.get('hook:post_edit_check').tone, 'bad');
  const other = V.nodeStates(manifest, idx, { overlay: { hooks: { missing: [] }, lanes: [] }, now: 1 });
  assert.ok(!other.get('hook:guard_bash').tags.some((t) => t.key === 'missing'), 'another project is unaffected');
});

test('pipeline view puts each lane at the stage the next-step script named', () => {
  const view = V.pipelineView(manifest, { lanes: [{ slug: 'a', stage: 'build' }, { slug: 'b', stage: 'approve' }, { slug: 'c', stage: 'build' }] });
  assert.deepEqual(view.find((s) => s.id === 'build').lanes, ['a', 'c']);
  assert.deepEqual(view.find((s) => s.id === 'approve').lanes, ['b']);
  assert.ok(view.filter((s) => !['build', 'approve'].includes(s.id)).every((s) => s.lanes.length === 0));
  assert.ok(V.pipelineView(manifest, null).every((s) => s.lanes.length === 0));
});

test('search matches id, label and declared purpose, optionally within one kind', () => {
  assert.ok(V.searchNodes(manifest, 'guard').length >= 4);
  assert.deepEqual(V.searchNodes(manifest, 'guard', 'agent'), []);
  assert.ok(V.searchNodes(manifest, 'secrets').some((n) => n.id === 'ci-job:template/secrets'));
  assert.equal(V.searchNodes(manifest, '').length, manifest.nodes.length);
});

test('GitHub links need a GitHub remote', () => {
  const node = idx.byId.get('script:lane');
  assert.equal(V.githubFileUrl({ repo_url: 'https://github.com/o/r' }, node), 'https://github.com/o/r/blob/main/kit/scripts/lane.js');
  assert.equal(V.githubFileUrl({ repo_url: null }, node), null);
  assert.equal(V.githubFileUrl(null, node), null);
});
