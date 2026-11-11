// Step 2d-i (KIT-SPEC 10.11): lane artifacts live in one configured tree, enforced by hook and CI; every stage resumes from
// files alone; the work root is configurable and defaults to the historical layout so nothing moves for existing projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as K from '../kitlib.js';
import { check } from '../ci_lane_artifacts.js';
import * as F from './fixtures.js';
import { runScript, tmpPath } from './helpers.js';
import { project } from './testdata.js';

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, t) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
};
const hook = (name, payload) => runScript(name, [], { stdin: JSON.stringify(payload) });

test('workRoot and decisionsRoot: kit.json paths win, defaults are the historical layout', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  assert.equal(K.workRoot(root), 'docs/specs');
  assert.equal(K.decisionsRoot(root), 'docs/decisions');
  const kj = path.join(root, '.claude', 'kit.json');
  const kit = JSON.parse(read(kj));
  kit.paths = { work: 'docs/work/', decisions: 'docs/adr' };
  fs.writeFileSync(kj, JSON.stringify(kit));
  assert.equal(K.workRoot(root), 'docs/work');
  assert.equal(K.decisionsRoot(root), 'docs/adr');
});

test('ci_lane_artifacts: passes a clean project, fails an artifact outside the tree and source inside it (fault 27)', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  assert.deepEqual(check(root), []);
  write(path.join(root, 'docs', 'notes', 'refund-route.progress.md'), '# stray\n');
  write(path.join(root, 'docs', 'plans', 'thing.md'), '# Spec: Thing\n\n- Slug: thing\n');
  write(path.join(root, 'docs', 'specs', 'helper.ts'), 'export const x = 1;\n');
  const problems = check(root);
  assert.ok(problems.some((p) => p.startsWith('docs/notes/refund-route.progress.md: lane artifact outside docs/specs/')), problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('docs/plans/thing.md: lane artifact outside docs/specs/')));
  assert.ok(problems.some((p) => p.startsWith('docs/specs/helper.ts: source file inside')));
  // a research file carries a Slug header but is not a spec; it stays where it is
  write(path.join(root, 'docs', 'research', 'r.md'), '# Research: r\n\n- Slug: r\n');
  assert.ok(!check(root).some((p) => p.includes('docs/research/r.md')));
  const r = runScript('ci_lane_artifacts.js', ['--repo', root]);
  assert.equal(r.returncode, 1);
  assert.ok(r.stderr.includes('lane-artifacts:'));
});

test('guard-edit refuses a lane artifact written outside the work root, in a live lane (fault 27)', (t) => {
  const { root } = project(t);
  const out = JSON.parse(runScript('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  const wt = out.worktree;
  const base = { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: wt };
  // the lane's own progress file in the tree: fine (once read, as every edit requires)
  hook('hook_read_log.js', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(wt, 'docs', 'specs', 'refund-route.progress.md') } });
  const ok = hook('hook_guard_edit.js', { ...base, tool_input: { file_path: path.join(wt, 'docs', 'specs', 'refund-route.progress.md'), content: 'x' } });
  assert.equal(ok.returncode, 0, ok.stderr);
  // the same kind of file anywhere else: refused, before the spec's file list is even consulted
  const bad = hook('hook_guard_edit.js', { ...base, tool_input: { file_path: path.join(wt, 'docs', 'notes', 'refund-route.progress.md'), content: 'x' } });
  assert.equal(bad.returncode, 2);
  assert.ok(bad.stderr.includes("lane artifact outside 'docs/specs/'"), bad.stderr);
});

test('a stage resumes from files alone: next-step is identical across processes and after a resume (fault 25)', (t) => {
  const { root } = project(t);
  const out = JSON.parse(runScript('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  const step = (label) => {
    const r = runScript('lane.js', ['next-step', 'refund-route', '--repo', root]);
    assert.equal(r.returncode, 0, `${label}: ${r.stderr}`);
    return r.stdout;
  };
  const first = step('fresh process 1');
  const second = step('fresh process 2');
  assert.equal(first, second, 'two cold processes derive the same next step from the same files');
  // progress written by the previous "session" is the only memory the next one has
  const prog = path.join(out.worktree, 'docs', 'specs', 'refund-route.progress.md');
  fs.writeFileSync(prog, read(prog).replace('## Current step\n\nreading the spec\'s files', '## Current step\n\nimplementing D1: red run recorded'));
  const r = runScript('lane.js', ['resume', 'refund-route', '--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  const resumed = JSON.parse(r.stdout);
  assert.equal(resumed.slug, 'refund-route');
  assert.deepEqual(resumed.next, JSON.parse(step('after resume')));
  assert.ok(resumed.launch.includes('lane.js launch refund-route'));
  assert.ok(read(out.worktree, '.claude', 'session', 'events.jsonl').includes('"event": "resume"'));
  // nothing in the lane refers to a transcript or a session id
  const lj = read(out.worktree, '.claude', 'lane.json');
  assert.ok(!/transcript|session_id|conversation/i.test(lj));
});
