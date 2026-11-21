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
  // Unquoted numbers print as YAML numbers in the check name (3.10 reports as 3.1); quoted ones are verbatim.
  c = G.workflowChecks(wf('py (${{ matrix.v }})', '        v: [3.10, "3.10", 20, 1.0]\n'));
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.required, ['py (3.1)', 'py (3.10)', 'py (20)', 'py (1)']);
  // A quoted value with a comma, an inline mapping, and a `matrix:` outside strategy are refused or ignored, never required wrong.
  assert.match(err('t (${{ matrix.v }})', '        v: ["a, b", c]\n'), /quoted value contains a comma/);
  c = G.workflowChecks('jobs:\n  t:\n    name: t (${{ matrix.node }})\n    strategy:\n      matrix: { node: [20, 22] }\n    steps: []\n');
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0], /inline mapping/);
  assert.deepEqual(c.required, []);
  c = G.workflowChecks('jobs:\n  t:\n    name: T\n    env:\n      matrix:\n        node: [20, 22]\n    steps: []\n');
  assert.deepEqual([c.errors, c.required], [[], ['T']]);
  // An inline `strategy: {…}`, a comment line inside strategy/matrix, a collection value and a replacement pattern: no silent wrong name.
  c = G.workflowChecks('jobs:\n  s:\n    strategy: { matrix: { v: [1, 2] } }\n    steps: []\n');
  assert.match(c.errors[0] ?? '', /strategy \(inline mapping/);
  assert.deepEqual(c.required, []);
  c = G.workflowChecks('jobs:\n  t:\n    name: t (${{ matrix.v }})\n    strategy:\n    # a comment\n      matrix:\n      # another\n        v: [1, 2]\n    steps: []\n');
  assert.deepEqual([c.errors, c.required], [[], ['t (1)', 't (2)']]);
  assert.match(err('t (${{ matrix.v }})', '        v: [{a: 1}, 2]\n'), /collection or a non-decimal/);
  assert.match(err('t (${{ matrix.v }})', '        v: [0x10, 2]\n'), /collection or a non-decimal/);
  c = G.workflowChecks(wf('t (${{ matrix.v }})', "        v: ['c$&d']\n"));
  assert.deepEqual(c.required, ['t (c$&d)']);
  // Booleans and nulls print as the runner prints them; unusual YAML is refused, not required wrong.
  c = G.workflowChecks(wf('t (${{ matrix.v }})', '        v: [True, FALSE, null, ~]\n'));
  assert.deepEqual([c.errors, c.required], [[], ['t (true)', 't (false)', 't ()', 't ()']]);
  assert.match(err('t (${{ matrix.v }}) ${{ github.ref }}', '        v: [1]\n'), /still contains an expression/);
  c = G.workflowChecks('jobs:\n  t:\n    name: tests\n    strategy:\n        matrix:\n          v: [1, 2]\n    steps: []\n');
  assert.match(c.errors[0] ?? '', /non-standard indentation/);
  assert.deepEqual(c.required, []);
  assert.match(err('t (${{ matrix.v }})', '        v: [1]\n        w.x: [1, 2]\n'), /unparsed matrix line/);
  assert.match(err('t (${{ matrix.v }})', '        v: []\n'), /empty list/);
  assert.match(err('t (${{ matrix.v }})', '        v: [",", x]\n'), /quoted value contains a comma/);
  assert.match(err('t (${{ matrix.v }})', "        v: ['it''s', b]\n"), /escape or a key/);
  assert.match(err('t (${{ matrix.v }})', '        v: [a: b]\n'), /escape or a key/);
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
if (j.startsWith('pr view')) { st.views = (st.views || 0) + 1; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st)); process.stdout.write(JSON.stringify(st.prAfter && st.views > st.prAfter.after ? { ...st.pr, ...st.prAfter.pr } : st.pr)); process.exit(0); }
if (j.includes('/check-runs')) {
  const runs = st.polls[Math.min(st.poll, st.polls.length - 1)];
  st.poll += 1; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st));
  process.stdout.write(runs.map((r) => JSON.stringify(r)).join('\\n') + (runs.length ? '\\n' : ''));
  process.exit(0);
}
if (j.startsWith('pr merge')) { process.exit(st.mergeFails ? 1 : 0); }
if (j.includes('/protection') && args.includes('PUT')) { st.put = JSON.parse(input); fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st)); process.exit(0); }
if (j.includes('/protection')) {
  // after a PUT, answer the read-back with what was sent, in the shape GET returns, plus any planted drift
  if (st.put) {
    const b = st.put, d = st.drift || {};
    process.stdout.write(JSON.stringify({
      required_status_checks: { strict: b.required_status_checks.strict, contexts: d.contexts || b.required_status_checks.contexts },
      enforce_admins: { enabled: 'enforce_admins' in d ? d.enforce_admins : b.enforce_admins },
      required_pull_request_reviews: 'reviews' in d ? d.reviews : b.required_pull_request_reviews,
      allow_force_pushes: { enabled: b.allow_force_pushes }, allow_deletions: { enabled: b.allow_deletions },
    }));
    process.exit(0);
  }
  if (st.protection === 'error') { process.stderr.write('gh: Resource not accessible by integration (HTTP 403)'); process.exit(1); }
  if (st.protection === 'on') { process.stdout.write(args.includes('.enforce_admins.enabled') ? String(st.enforceAdmins ?? true) + '\\n' : ''); process.exit(0); }
  process.stderr.write('gh: Branch not protected (HTTP 404)'); process.exit(1);
}
// repository rulesets: a list, create, update and read by id, kept in the state file; st.rulesetDrift is merged
// into the read-back of the ruleset of that name (the kit must notice); st.rulesetsFail refuses every write
if (j === 'api repos/o/proj') { process.stdout.write(JSON.stringify({ owner: { login: 'o', type: st.ownerType || 'User' } })); process.exit(0); }
if (j === 'api user') { process.stdout.write(JSON.stringify({ login: 'o', id: 4242 })); process.exit(0); }
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st));
st.rulesets = st.rulesets || [];
const api = (args.filter((a) => !a.startsWith('-') && a !== 'api' && a !== 'PUT' && a !== 'POST')[0] || '').split('?')[0];
const byId = /\\/rulesets\\/(\\d+)$/.exec(api);
if (api.endsWith('/rulesets') && !args.includes('POST')) { process.stdout.write(JSON.stringify(st.rulesets.map(({ id, name }) => ({ id, name })))); process.exit(0); }
if (api.endsWith('/rulesets') && args.includes('POST')) {
  if (st.rulesetsFail) { process.stderr.write('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'); process.exit(1); }
  const rs = { id: 100 + st.rulesets.length, ...JSON.parse(input) }; st.rulesets.push(rs); save(); process.stdout.write(JSON.stringify(rs)); process.exit(0);
}
if (byId && args.includes('PUT')) {
  const i = st.rulesets.findIndex((x) => String(x.id) === byId[1]); if (i < 0) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
  st.rulesets[i] = { id: st.rulesets[i].id, ...JSON.parse(input) }; save(); process.stdout.write(JSON.stringify(st.rulesets[i])); process.exit(0);
}
if (byId) {
  const rs = st.rulesets.find((x) => String(x.id) === byId[1]); if (!rs) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
  const d = (st.rulesetDrift || {})[rs.name] || {};
  process.stdout.write(JSON.stringify({ ...rs, ...d, conditions: d.conditions ? { ref_name: { ...rs.conditions.ref_name, ...d.conditions.ref_name } } : rs.conditions })); process.exit(0);
}
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

test('lane.js merge uses the owner\'s ruleset bypass (--admin) only after every check is green and only where GitHub enforces protection for admins', (t) => {
  const root = project(t);
  const mergeOf = (calls) => calls().find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  // enforce_admins on: --admin is passed, after the checks are green
  let g = fakeGh(t, { pr: PR, polls: [[run(1, 'tests', 'in_progress', null)], all()], protection: 'on', enforceAdmins: true });
  let r = lane(root, g.env, 'merge', 'footer', '--by', 'Jonathan');
  assert.equal(r.returncode, 0, r.stderr + r.stdout);
  assert.ok(mergeOf(g.calls).args.includes('--admin'), 'the owner bypass for the ruleset');
  assert.match(r.stdout, /as the owner \(--admin: the ruleset bypass; GitHub enforces the checks for admins too\)/);
  assert.doesNotMatch(r.stdout, /warning/);
  const order = g.calls().map((c) => c.args.join(' '));
  assert.ok(order.findIndex((c) => c.includes('.enforce_admins.enabled')) > order.findLastIndex((c) => c.includes('/check-runs')), 'read after the checks went green');
  // enforce_admins off: never --admin (it would let an admin skip the checks), and a warning
  g = fakeGh(t, { pr: PR, polls: [all()], protection: 'on', enforceAdmins: false });
  r = lane(root, g.env, 'merge', 'footer', '--by', 'Jonathan');
  assert.equal(r.returncode, 0, r.stderr + r.stdout);
  assert.ok(!mergeOf(g.calls).args.includes('--admin'));
  assert.match(r.stdout, /warning: branch protection on main does not apply to admins \(enforce_admins off\)/);
  // no protection: never --admin, and the existing warning
  g = fakeGh(t, { pr: PR, polls: [all()] });
  r = lane(root, g.env, 'merge', 'footer', '--by', 'Jonathan');
  assert.ok(!mergeOf(g.calls).args.includes('--admin'));
  assert.match(r.stdout, /warning: branch protection on main is off/);
  // red CI with enforce_admins on: no merge at all, so no --admin
  g = fakeGh(t, { pr: PR, polls: [all('failure')], protection: 'on', enforceAdmins: true });
  r = lane(root, g.env, 'merge', 'footer', '--by', 'Jonathan');
  assert.notEqual(r.returncode, 0);
  assert.equal(mergeOf(g.calls), undefined);
  // protection unreadable (not a 404): never --admin, and the 'unknown' warning
  g = fakeGh(t, { pr: PR, polls: [all()], protection: 'error' });
  r = lane(root, g.env, 'merge', 'footer', '--by', 'Jonathan');
  assert.equal(r.returncode, 0, r.stderr + r.stdout);
  assert.ok(!mergeOf(g.calls).args.includes('--admin'));
  assert.match(r.stdout, /warning: branch protection on main is unknown/);
  // the PR moved to another base after the checks were read: refused, nothing merged
  g = fakeGh(t, { pr: PR, polls: [all()], protection: 'on', enforceAdmins: true, prAfter: { after: 2, pr: { baseRefName: 'release' } } });
  r = lane(root, g.env, 'merge', 'footer', '--by', 'Jonathan');
  assert.equal(r.returncode, 2);
  assert.match(r.stderr, /changed while it was being merged \(base main -> release/);
  assert.equal(mergeOf(g.calls), undefined);
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

test('bootstrap --protect: nobody bypasses CI, no review is required, and the settings are read back (hardening plan D1, 0016 E.10)', (t) => {
  const root = project(t);
  const { env, calls } = fakeGh(t, { pr: PR, polls: [[]] });
  const r = runScript('bootstrap.js', ['--repo', root, '--upgrade', '--protect', '--json'], { env });
  assert.equal(r.returncode, 0, r.stderr);
  const put = calls().find((c) => c.args.includes('PUT') && c.args.some((a) => a.endsWith('/branches/main/protection')));
  const body = JSON.parse(put.input);
  assert.equal(body.enforce_admins, true, 'admins included');
  assert.equal(body.required_pull_request_reviews.require_code_owner_reviews, false, 'no code-owner review (0016 E.10)');
  assert.equal(body.required_pull_request_reviews.required_approving_review_count, 0, 'no approving review');
  assert.equal(body.allow_force_pushes, false);
  assert.equal(body.allow_deletions, false);
  assert.equal(body.required_status_checks.strict, true);
  const get = calls().filter((c) => c.args.some((a) => a.endsWith('/branches/main/protection')) && !c.args.includes('PUT'));
  assert.equal(get.length, 1, 'protection is read back once');
  const bp = JSON.parse(r.stdout).branch_protection;
  assert.equal(bp.ok, true, JSON.stringify(bp));
  assert.deepEqual(bp.read_back, { ok: true, mismatches: [], checks: G.projectChecks(root).required });
});

test('bootstrap --protect: the agents\' identity may create, update or delete only wt/* and spec/* branches, and no tag; only the owner bypasses (D1, 0016 E.7)', (t) => {
  const root = project(t);
  const { env, calls } = fakeGh(t, { pr: PR, polls: [[]] });
  const r = runScript('bootstrap.js', ['--repo', root, '--upgrade', '--protect', '--json'], { env });
  assert.equal(r.returncode, 0, r.stderr);
  const bp = JSON.parse(r.stdout).branch_protection;
  assert.equal(bp.ok, true, JSON.stringify(bp));
  const posts = calls().filter((c) => c.args.includes('POST') && c.args.some((a) => a.endsWith('/rulesets'))).map((c) => JSON.parse(c.input));
  const listed = calls().filter((c) => c.args.some((a) => a.startsWith('repos/o/proj/rulesets?')));
  assert.ok(listed.length >= 2 && listed.every((c) => c.args.some((a) => a.endsWith('/rulesets?includes_parents=false&per_page=100'))), 'lists only this repository\'s rulesets, all of them');
  const branches = posts.find((x) => x.name === 'kit agent branches');
  const tags = posts.find((x) => x.name === 'kit tags');
  assert.ok(branches && tags, 'both rulesets were created');
  for (const rs of [branches, tags]) {
    assert.equal(rs.enforcement, 'active');
    assert.deepEqual(rs.rules.map((x) => x.type), ['creation', 'update', 'deletion']);
    assert.deepEqual(rs.bypass_actors, [{ actor_id: 4242, actor_type: 'User', bypass_mode: 'always' }], 'only the owner, by user id');
    assert.deepEqual(rs.conditions.ref_name.include, ['~ALL']);
  }
  assert.equal(branches.target, 'branch');
  assert.deepEqual(branches.conditions.ref_name.exclude, ['refs/heads/wt/*', 'refs/heads/spec/*']);
  assert.equal(tags.target, 'tag');
  assert.deepEqual(tags.conditions.ref_name.exclude, []);
  assert.deepEqual(bp.agent_rulesets.rulesets, { branches: { id: 100, action: 'created' }, tags: { id: 101, action: 'created' } });
  // a second run updates the same rulesets instead of adding duplicates
  const r2 = runScript('bootstrap.js', ['--repo', root, '--upgrade', '--protect', '--json'], { env });
  const bp2 = JSON.parse(r2.stdout).branch_protection;
  assert.equal(bp2.ok, true, JSON.stringify(bp2));
  assert.deepEqual(bp2.agent_rulesets.rulesets, { branches: { id: 100, action: 'updated' }, tags: { id: 101, action: 'updated' } });
  assert.equal(calls().filter((c) => c.args.includes('POST') && c.args.some((a) => a.endsWith('/rulesets'))).length, 3, 'three creates in all: two agent rulesets and the merge queue, none repeated');
});

test('bootstrap --protect: on an organization\'s repository the bypass actor is OrganizationAdmin', (t) => {
  const root = project(t);
  const { env, calls } = fakeGh(t, { pr: PR, polls: [[]], ownerType: 'Organization' });
  const r = runScript('bootstrap.js', ['--repo', root, '--upgrade', '--protect', '--json'], { env });
  const bp = JSON.parse(r.stdout).branch_protection;
  assert.equal(bp.ok, true, JSON.stringify(bp));
  assert.deepEqual(bp.agent_rulesets.bypass, { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' });
  const posts = calls().filter((c) => c.args.includes('POST') && c.args.some((a) => a.endsWith('/rulesets'))).map((c) => JSON.parse(c.input)).filter((x) => x.name.startsWith('kit agent') || x.name === 'kit tags');
  assert.equal(posts.length, 2);
  for (const rs of posts) assert.deepEqual(rs.bypass_actors, [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }]);
  assert.ok(!calls().some((c) => c.args.join(' ') === 'api user'), 'the user id is not needed for an organization');
});

test('bootstrap --protect: an agent ruleset GitHub holds differently, or cannot create, fails the result', (t) => {
  const root = project(t);
  const cases = [
    [{ rulesetDrift: { 'kit agent branches': { bypass_actors: [{ actor_id: 4242, actor_type: 'User', bypass_mode: 'always' }, { actor_id: 77, actor_type: 'Integration', bypass_mode: 'always' }] } } }, /kit agent branches: bypass list is User 4242, Integration 77, not only the owner \(User 4242\)/],
    [{ rulesetDrift: { 'kit agent branches': { conditions: { ref_name: { exclude: ['refs/heads/wt/*'] } } } } }, /kit agent branches: exclude is \[refs\/heads\/wt\/\*\], not \[refs\/heads\/wt\/\*, refs\/heads\/spec\/\*\]/],
    [{ rulesetDrift: { 'kit tags': { enforcement: 'disabled' } } }, /kit tags: enforcement is disabled, not active/],
    [{ rulesetDrift: { 'kit tags': { rules: [{ type: 'creation' }] } } }, /kit tags: rules are \[creation\], not \[creation, deletion, update\]/],
    [{ rulesetsFail: true }, /kit agent branches: gh: Upgrade to GitHub Pro/],
  ];
  for (const [scenario, re] of cases) {
    const { env } = fakeGh(t, { pr: PR, polls: [[]], ...scenario });
    const r = runScript('bootstrap.js', ['--repo', root, '--upgrade', '--protect', '--json'], { env });
    const bp = JSON.parse(r.stdout).branch_protection;
    assert.equal(bp.ok, false, `${JSON.stringify(scenario)} must fail`);
    assert.equal(r.returncode, 1);
    assert.match(bp.reason, /agent rulesets: /);
    assert.match(bp.reason, re);
  }
});

test('bootstrap --protect: a read-back that differs from what the kit set fails the result and the exit code', (t) => {
  const root = project(t);
  const required = G.projectChecks(root).required;
  const cases = [
    [{ enforce_admins: false }, /enforce_admins is not enabled/],
    [{ contexts: ['ghost', ...required] }, /required check "ghost" is not a job the workflow reports/],
    [{ contexts: ['tests'] }, /required check "kit-checks" is missing on GitHub/],
    [{ reviews: { require_code_owner_reviews: true, required_approving_review_count: 0 } }, /require_code_owner_reviews is not false/],
    [{ reviews: { require_code_owner_reviews: false, required_approving_review_count: 1 } }, /required_approving_review_count is 1, not 0/],
    [{ reviews: null }, /required_pull_request_reviews is missing/],
  ];
  for (const [drift, re] of cases) {
    const { env } = fakeGh(t, { pr: PR, polls: [[]], drift });
    const r = runScript('bootstrap.js', ['--repo', root, '--upgrade', '--protect', '--json'], { env });
    const bp = JSON.parse(r.stdout).branch_protection;
    assert.equal(bp.ok, false, `drift ${JSON.stringify(drift)} must fail`);
    assert.equal(r.returncode, 1, 'a failed protection is an exit 1');
    assert.match(bp.reason, /protection read back from GitHub differs/);
    assert.match(bp.reason, re);
  }
});
