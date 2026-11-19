// The merge gate (#68): lane.js ci / merge wait for every required check on the PR head and merge only on green.
// gh is replaced by a fake on PATH that answers from a scenario file and logs every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as G from '../pr_gate.js';
import * as F from './fixtures.js';
import { runScript, tmpPath } from './helpers.js';

const run = (id, name, status = 'completed', conclusion = 'success') => ({ id, name, status, conclusion });
const CHECKS = { required: ['tests', 'kit-checks', 'secrets'], advisory: ['mutation (threshold 70%)'] };

test('evaluate: green only when every required check reported and passed', () => {
  const ok = [run(1, 'tests'), run(2, 'kit-checks'), run(3, 'secrets')];
  assert.equal(G.evaluate(ok, CHECKS).state, 'green');
  // "no checks reported" is not green: the case that let kit-test PR #3 and #4 merge on red CI.
  let r = G.evaluate([], CHECKS);
  assert.equal(r.state, 'pending');
  assert.deepEqual(r.missing, CHECKS.required);
  r = G.evaluate([run(1, 'tests'), run(2, 'kit-checks', 'in_progress', null)], CHECKS);
  assert.ok(r.state === 'pending' && r.pending.includes('kit-checks') && r.missing.includes('secrets'));
  // A failure is red at once, even while other checks still run.
  r = G.evaluate([run(1, 'tests', 'completed', 'failure'), run(2, 'kit-checks', 'in_progress', null)], CHECKS);
  assert.ok(r.state === 'red' && r.failed[0] === 'tests: failure');
  // A re-run that passed replaces the failure (the latest run per name counts).
  assert.equal(G.evaluate([run(1, 'tests', 'completed', 'failure'), run(4, 'tests'), run(2, 'kit-checks'), run(3, 'secrets')], CHECKS).state, 'green');
  // A required check that was skipped did not pass.
  assert.equal(G.evaluate([run(1, 'tests', 'completed', 'skipped'), run(2, 'kit-checks'), run(3, 'secrets')], CHECKS).state, 'red');
  // Advisory failures are reported but do not block; any other failing check (another workflow or app) blocks.
  r = G.evaluate([...ok, run(5, 'mutation (threshold 70%)', 'completed', 'failure')], CHECKS);
  assert.ok(r.state === 'green' && r.advisory.length === 1);
  assert.equal(G.evaluate([...ok, run(6, 'CodeQL', 'completed', 'failure')], CHECKS).state, 'red');
  for (const c of ['cancelled', 'timed_out', 'action_required', 'stale']) assert.equal(G.evaluate([run(1, 'tests', 'completed', c), run(2, 'kit-checks'), run(3, 'secrets')], CHECKS).state, 'red', c);
});

test('workflowChecks: a matrix job is required once per value, named as GitHub reports it (0016 E.11)', () => {
  // This repo's own workflow: the name GitHub reports is `script unit tests (node 20)`, never the unexpanded form.
  const kit = G.workflowChecks(fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'kit.yml'), 'utf8'));
  assert.deepEqual(kit.errors, []);
  assert.ok(kit.required.includes('script unit tests (node 20)') && kit.required.includes('script unit tests (node 22)'));
  assert.ok(!kit.required.some((n) => n.includes('${{')), 'no unexpanded matrix expression may be required');
  // PR #88's real check runs (head 2d18a29) were green on both node values; before the fix this evaluated as pending.
  const runs = [run(1, 'script unit tests (node 20)'), run(2, 'script unit tests (node 22)'), run(3, 'kit docs validate themselves'), run(4, 'eval smoke set (agents, skills, templates, workflows, eval)')];
  assert.equal(G.evaluate(runs, kit).state, 'green');
  // Values keep their quoting rules and the job's if:/continue-on-error flags.
  const wf = (name, matrix, extra = '') => `jobs:\n  t:\n    name: ${name}\n${extra}    strategy:\n      matrix:\n${matrix}    steps: []\n`;
  let c = G.workflowChecks(wf('tests (${{ matrix.os }})', "        os: ['ubuntu-latest', \"macos-14\"]\n", '    continue-on-error: true\n'));
  assert.deepEqual(c.advisory, ['tests (ubuntu-latest)', 'tests (macos-14)']);
  assert.deepEqual(c.required, []);
  // Refusals, each with a reason: the caller must not guess a required list.
  const err = (name, matrix, extra) => { const r = G.workflowChecks(wf(name, matrix, extra)); assert.equal(r.errors.length, 1, JSON.stringify(r)); return r.errors[0]; };
  assert.match(err('t (${{ matrix.node }})', '        node: [20]\n        os: [ubuntu]\n'), /more than one axis/);
  assert.match(err('t (${{ matrix.node }})', '        include:\n          - node: 20\n'), /include.*cannot be expanded/);
  assert.match(err('t (${{ matrix.node }})', '        node: ${{ fromJSON(inputs.m) }}\n'), /cannot be expanded/);
  assert.match(err('t (${{ matrix.other }})', '        node: [20]\n'), /matrix\.other, which is not an axis/);
  assert.match(err('t', '        node: [20, 22]\n'), /does not use matrix\.node/);
  // A name that uses matrix.* in a job without a matrix is an error too (and the job is still listed).
  const r = G.workflowChecks('jobs:\n  t:\n    name: t (${{ matrix.node }})\n    steps: []\n');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /no strategy\.matrix/);
  // A workflow without any matrix is unchanged.
  assert.deepEqual(G.workflowChecks('jobs:\n  a:\n    name: A\n  b:\n    if: x\n  c:\n').required, ['A', 'c']);
});

/** A bootstrapped project with a GitHub origin and a ROADMAP row pointing at PR #4. */
function project(t) {
  const root = F.nodeApi(path.join(tmpPath(t), 'proj'));
  runScript('bootstrap.js', ['--repo', root]);
  F.git(['remote', 'add', 'origin', 'https://github.com/o/proj.git'], root);
  const rm = path.join(root, 'ROADMAP.md');
  fs.writeFileSync(rm, fs.readFileSync(rm, 'utf8').replace(/(## Features[\s\S]*?\|---[^\n]*\n)/, '$1| Footer | footer | M1 | in-review | docs/specs/footer.md | — | https://github.com/o/proj/pull/4 |\n'));
  F.commitAll(root, 'bootstrap');
  return root;
}

test('the required checks are the workflow job names, never step names', (t) => {
  const root = project(t);
  const c = G.projectChecks(root);
  assert.deepEqual(c.required, ['tests', 'format', 'integration', 'typecheck', 'lint', 'boundaries', 'kit-checks', 'secrets', 'audit', 'mutation-gate']);
  for (const step of ['scope-diff', 'test-count', 'dep-diff', 'claude-md-cap', 'guards-present', 'validate-docs', 'review-report']) assert.ok(!c.required.includes(step), step);
  assert.deepEqual(c.advisory, ['mutation (threshold 70%)']);
  assert.ok(c.optional[0].startsWith('dashboard'));
  // Once the mutation gate is blocking, a failing mutation run blocks the merge.
  assert.deepEqual(G.projectChecks(root, { mutationBlocking: true }).advisory, []);
});

/**
 * Install a fake gh. `scenario.polls` is the list of check-run answers, one per poll (the last one repeats);
 * `scenario.pr` the PR view. Every call is appended to calls.log, with stdin for `api --input -`.
 */
function fakeGh(t, scenario) {
  const dir = tmpPath(t);
  const state = path.join(dir, 'state.json');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(state, JSON.stringify({ ...scenario, poll: 0 }));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const args = process.argv.slice(2);
let input = '';
if (args.includes('--input')) input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
const j = args.join(' ');
if (j.startsWith('pr view')) { process.stdout.write(JSON.stringify(st.pr)); process.exit(0); }
if (j.includes('/check-runs')) {
  const runs = st.polls[Math.min(st.poll, st.polls.length - 1)];
  st.poll += 1; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st));
  process.stdout.write(runs.map((r) => JSON.stringify(r)).join('\\n') + (runs.length ? '\\n' : ''));
  process.exit(0);
}
if (j.startsWith('pr merge')) { process.exit(st.mergeFails ? 1 : 0); }
if (j.includes('/protection')) { process.stderr.write(st.protection === 'on' ? '' : 'gh: Branch not protected (HTTP 404)'); process.exit(st.protection === 'on' ? 0 : 1); }
if (j.includes('/rulesets')) process.exit(0);
process.stderr.write('fake gh: unexpected ' + j); process.exit(9);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, KIT_PR_GATE_POLL_SECONDS: '0' };
  const calls = () => (K_read(log)).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { env, calls };
}
const K_read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

const PR = { number: 4, url: 'https://github.com/o/proj/pull/4', state: 'OPEN', isDraft: false, headRefOid: 'a'.repeat(40), headRefName: 'wt/footer', baseRefName: 'main', title: 'footer' };
const all = (conclusion = 'success', names = ['tests', 'format', 'integration', 'typecheck', 'lint', 'boundaries', 'kit-checks', 'secrets', 'audit', 'mutation-gate']) =>
  names.map((n, i) => run(100 + i, n, 'completed', conclusion));
const lane = (root, env, ...args) => runScript('lane.js', [...args, '--repo', root], { env });

test('lane.js merge waits through "no checks reported" and merges at the checked head once all are green', (t) => {
  const root = project(t);
  const { env, calls } = fakeGh(t, { pr: PR, polls: [[], [run(1, 'tests', 'in_progress', null)], all()] });
  const r = lane(root, env, 'merge', 'footer', '--by', 'Jonathan');
  assert.equal(r.returncode, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /not reported yet/);
  assert.match(r.stdout, /merged \(squash\) at head aaaaaaa/);
  assert.match(r.stdout, /warning: branch protection on main is off/);
  const merge = calls().find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.deepEqual(merge.args.slice(0, 5), ['pr', 'merge', '4', '--squash', '--match-head-commit']);
  assert.equal(merge.args[5], PR.headRefOid);
  assert.ok(merge.args.join(' ').includes('for Jonathan'));
});

test('lane.js merge refuses red CI, a draft, a closed PR, no --by, and CI that never finishes', (t) => {
  const root = project(t);
  const noMerge = (calls) => assert.ok(!calls().some((c) => c.args[0] === 'pr' && c.args[1] === 'merge'), 'must not merge');
  let g = fakeGh(t, { pr: PR, polls: [[...all(), run(200, 'kit-checks', 'completed', 'failure')]] });
  let r = lane(root, g.env, 'merge', 'footer', '--by', 'Jonathan');
  assert.ok(r.returncode === 2 && r.stderr.includes('CI red') && r.stderr.includes('kit-checks: failure'), r.stderr);
  noMerge(g.calls);
  g = fakeGh(t, { pr: { ...PR, isDraft: true }, polls: [all()] });
  r = lane(root, g.env, 'merge', 'footer', '--by', 'Jonathan');
  assert.ok(r.returncode === 2 && r.stderr.includes('draft'), r.stderr);
  noMerge(g.calls);
  g = fakeGh(t, { pr: { ...PR, state: 'MERGED' }, polls: [all()] });
  r = lane(root, g.env, 'merge', '--pr', '4', '--by', 'Jonathan');
  assert.ok(r.returncode === 2 && r.stderr.includes('is merged, not open'), r.stderr);
  g = fakeGh(t, { pr: PR, polls: [all()] });
  r = lane(root, g.env, 'merge', 'footer');
  assert.ok(r.returncode === 2 && r.stderr.includes('--by'), r.stderr);
  noMerge(g.calls);
  g = fakeGh(t, { pr: PR, polls: [[run(1, 'tests', 'queued', null)]] });
  r = lane(root, g.env, 'merge', 'footer', '--by', 'Jonathan', '--timeout-min', '0');
  assert.ok(r.returncode === 2 && r.stderr.includes('still pending after 0 min'), r.stderr);
  noMerge(g.calls);
  r = lane(root, g.env, 'merge', 'nope', '--by', 'Jonathan');
  assert.ok(r.returncode === 2 && r.stderr.includes("no PR for 'nope'"), r.stderr);
});

test('lane.js ci reports the state from the PR head: pending is not green', (t) => {
  const root = project(t);
  let g = fakeGh(t, { pr: PR, polls: [[]] });
  let r = lane(root, g.env, 'ci', 'footer');
  assert.ok(r.returncode === 3 && r.stdout.includes('CI pending') && r.stdout.includes('not reported yet'), r.stdout);
  g = fakeGh(t, { pr: PR, polls: [[], all()] });
  r = lane(root, g.env, 'ci', '--pr', 'https://github.com/o/proj/pull/4', '--wait');
  assert.ok(r.returncode === 0 && r.stdout.includes('CI green'), r.stdout);
  g = fakeGh(t, { pr: PR, polls: [all('failure')] });
  r = lane(root, g.env, 'ci', 'footer');
  assert.ok(r.returncode === 1 && r.stdout.includes('CI red'), r.stdout);
});

test('bootstrap --protect requires the workflow job names (#68)', (t) => {
  const root = project(t);
  const { env, calls } = fakeGh(t, { pr: PR, polls: [[]] });
  const r = runScript('bootstrap.js', ['--repo', root, '--upgrade', '--protect', '--json'], { env });
  assert.equal(r.returncode, 0, r.stderr);
  const put = calls().find((c) => c.args.includes('PUT') && c.args.some((a) => a.endsWith('/branches/main/protection')));
  assert.ok(put, 'protection was set');
  assert.deepEqual(JSON.parse(put.input).required_status_checks.contexts, G.projectChecks(root).required);
});
