// lane.js gate (hardening plan Step 3; 0016 E.1 Add 2; #56 S1.1, S1.2, S1.4): the base's recorded checks, re-run on
// the lane's HEAD, contained and non-interactive; the verdict is bound to that commit; no reviewer starts without a PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, commitAll, approveSpec } from './fixtures.js';
import { runScript, setEnv } from './helpers.js';
import { project } from './testdata.js';
import { CI_COMMANDS } from '../bootstrap.js';
import * as L from '../lane.js';
import { spawnSync } from 'node:child_process';

const spawnGit = (args, cwd) => spawnSync('git', args, { cwd }).status;

const lane = (...args) => runScript('lane.js', args);
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const LOG = '=== 2026-11-11T10:00:00 test: npx vitest run -> exit 1\nnot ok 1 - exposes refund\n\n=== 2026-11-11T10:05:00 test: npx vitest run -> exit 0\nok 1 - exposes refund\n\n';

const GOAL = '# Goal: refund route\n\n- Slug: refund-route\n- Date: 2026-11-11\n- Agreed by: Jonathan Robles and Claude on 2026-11-11\n- Status: agreed\n- Work type: feature\n- Risk: normal\n- Size: M\n\n## What we want\n\nA refund route.\n\n## Done looks like\n\n- POST /refund works\n';

/** Every check CI runs passes (`true`), with `over` changing some; committed on main, then the lane starts at build. */
function gateLane(t, over = {}, kitOver = {}, { risk = null } = {}) {
  setEnv(t, 'KIT_SANDBOX_RUNTIME', 'none');
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root } = project(t);
  const kj = path.join(root, '.claude', 'kit.json');
  const kit = JSON.parse(fs.readFileSync(kj, 'utf8'));
  const commands = { ...kit.commands };
  delete commands.lint_all;
  for (const n of CI_COMMANDS) commands[n] = 'true';
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete commands[k];
    else commands[k] = v;
  }
  // the fixture spec is high-risk; with no runtime here (KIT_SANDBOX_RUNTIME=none) the lane needs the owner's waiver
  const sandbox = { ...(kit.sandbox ?? {}), high_risk_waiver: { by: 'test', reason: 'the gate tests run without a sandbox runtime' } };
  write(kj, JSON.stringify({ ...kit, sandbox, ...kitOver, commands }, null, 2));
  // next-step walks the pipeline only for an agreed goal
  write(path.join(root, 'docs', 'goals', 'refund-route.md'), GOAL);
  // a spec approved at another risk: the spec PR the owner merged says so (the approval is recorded at that commit)
  if (risk) {
    const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
    // a spec at normal risk names no high-risk path or keyword (validate_docs' risk-flag)
    write(sp, read(sp).replace('- Risk: high-risk', `- Risk: ${risk}`).replace('- Risks: payments', '- Risks: none')
      .replace('`src/domain/payment.ts` — the service [verified: src/domain/payment.ts:1-3]', '`src/api/routes.ts` — the routes [verified: src/api/routes.ts:1-3]'));
  }
  const c = commitAll(root, 'kit.json: the checks the gate runs');
  if (risk) approveSpec(root, 'refund-route', { commit: c });
  const st = lane('start', 'refund-route', '--repo', root);
  assert.equal(st.returncode, 0, `start: ${st.stderr}`);
  const wt = JSON.parse(st.stdout).worktree;
  return { root, wt, store: () => JSON.parse(read(root, '.claude', 'session', 'lanes', 'refund-route.json')) };
}

/** The lane's criteria cite a logged red and green run, so only the gate stands between build and review. */
function greenRuns(wt) {
  write(path.join(wt, '.claude', 'session', 'refund-route.log'), LOG);
  const prog = path.join(wt, 'docs', 'specs', 'refund-route.progress.md');
  write(prog, read(prog).replaceAll('| — | — |', '| refund-route.log#1 | refund-route.log#4 |'));
}

test('gate: every recorded check passes → PASS bound to HEAD; "none: <reason>" is off, and said so', (t) => {
  const { root, wt, store } = gateLane(t, { mutation: 'none: manual in CI', integration: 'none: no database in this project' });
  const r = lane('gate', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^GATE: PASS/);
  const g = store().gate;
  assert.equal(g.verdict, 'PASS');
  assert.equal(g.commit, git(['rev-parse', 'HEAD'], wt).trim());
  assert.equal(g.state, 'degraded');
  assert.deepEqual(g.failed, []);
  assert.ok(g.checks.some((c) => c.name === 'integration' && c.result === 'off' && c.reason === 'no database in this project'), JSON.stringify(g.checks));
  assert.ok(!g.checks.some((c) => c.name === 'mutation'), 'mutation runs only when kit.json mutation_in_ci is "pr", as in CI');
  const report = read(g.report);
  assert.match(report, /^GATE: PASS\n/);
  assert.match(report, /off {3}integration: none: no database in this project/);
  assert.equal(L.gateState(root, 'refund-route').state, 'pass');
});

test('gate: a failing check → FAIL with its output in the report; the FAIL counts one round, once per commit', (t) => {
  const { root, store } = gateLane(t, { lint: 'echo "src/a.ts: 3 problems" >&2; exit 3' });
  const r = lane('gate', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^GATE: FAIL/);
  assert.deepEqual(store().gate.failed, ['lint']);
  assert.ok(store().gate.checks.find((c) => c.name === 'lint').exit === 3);
  assert.match(read(store().gate.report), /--- lint \(last output\) ---\nsrc\/a\.ts: 3 problems/);
  assert.equal(store().failed_rounds, 1, 'a gate FAIL ends the round (D2)');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 1);
  assert.equal(store().failed_rounds, 1, 'the same commit failing again is the same round');
});

test('gate: a missing check, or "none" with no reason, fails it: nothing passes by default (#56 S1.2)', (t) => {
  const { root, store } = gateLane(t, { typecheck: undefined, audit: 'none' });
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 1);
  const g = store().gate;
  assert.deepEqual(g.failed.sort(), ['audit', 'typecheck']);
  assert.match(read(g.report), /FAIL {2}typecheck: missing \(not recorded in kit\.json commands\)/);
  assert.match(read(g.report), /FAIL {2}audit: missing \("none" with no reason\)/);
});

test('gate: a check that hangs is stopped at the time limit, with its children; stdin is closed', (t) => {
  // gate_timeout_min from the base's kit.json: 0.02 min = 1.2 s a check
  const { root, store } = gateLane(t, { test: 'sleep 60 & sleep 60', typecheck: 'cat', lint: 'read x; test -z "$x"' }, { gate_timeout_min: 0.02 });
  const t0 = Date.now();
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 1);
  assert.ok(Date.now() - t0 < 30000, `took ${Date.now() - t0} ms`);
  const by = Object.fromEntries(store().gate.checks.map((c) => [c.name, c]));
  assert.ok(by.test.timed_out && by.test.result === 'FAIL', JSON.stringify(by.test));
  assert.equal(by.typecheck.result, 'pass', 'cat reads a closed stdin and ends: the check is non-interactive');
  assert.equal(by.lint.result, 'pass');
  assert.match(read(store().gate.report), /test: sleep 60 & sleep 60 {2}\(stopped at the time limit, 1s/);
});

test("gate: the checks come from the base's committed kit.json, not the main checkout's working file", (t) => {
  const { root, store } = gateLane(t, { test: 'exit 1' });
  const kj = path.join(root, '.claude', 'kit.json');
  write(kj, read(kj).replace('"test": "exit 1"', '"test": "true"'));
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 1);
  assert.deepEqual(store().gate.failed, ['test']);
  assert.match(store().gate.base_ref, /refs\/heads\/main$/);
});

test('gate: a check gets no GitHub token or API key', (t) => {
  setEnv(t, 'GH_TOKEN', 'ghp_x');
  setEnv(t, 'ANTHROPIC_API_KEY', 'sk-x');
  const { root, store } = gateLane(t, { test: 'test -z "$GH_TOKEN" && test -z "$ANTHROPIC_API_KEY" && test "$CI" = 1' });
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 0, read(root, '.claude', 'session', 'lanes', 'refund-route.gate.txt'));
  assert.equal(store().gate.verdict, 'PASS');
});

test('gate: refuses a worktree with uncommitted changes (its verdict is for a commit), but not the lane\'s own progress file', (t) => {
  const { root, wt } = gateLane(t);
  greenRuns(wt);
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 0, 'progress.md is the lane\'s bookkeeping');
  write(path.join(wt, 'src', 'refund.ts'), 'export const x = 1;\n');
  const r = lane('gate', 'refund-route', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('commit them first') && r.stderr.includes('src/refund.ts'), r.stderr);
});

test('no reviewer without a gate PASS on HEAD: none, FAIL and a stale verdict are refused; next-step says gate', (t) => {
  const { root, wt } = gateLane(t, { lint: 'test -f lint-ok' });
  greenRuns(wt);
  const next = () => JSON.parse(lane('next-step', 'refund-route', '--repo', root).stdout);
  let r = lane('advance', 'refund-route', 'review', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('the gate has not run on this lane'), r.stderr);
  assert.equal(next().stage, 'gate');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 1);
  r = lane('advance', 'refund-route', 'review', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('the gate FAILED'), r.stderr);
  assert.equal(next().stage, 'build', 'a FAIL goes back to the implementer');
  write(path.join(wt, 'lint-ok'), '');
  commitAll(wt, 'fix lint');
  assert.equal(next().stage, 'gate', 'a new commit needs a new verdict');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 0);
  assert.equal(next().stage, 'review');
  write(path.join(wt, 'src', 'later.ts'), 'export const later = 1;\n');
  commitAll(wt, 'a commit after the gate');
  r = lane('advance', 'refund-route', 'review', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('(stale)'), r.stderr);
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 0);
  assert.equal(lane('advance', 'refund-route', 'review', '--repo', root).returncode, 0);
  // re-entering review on a newer commit needs the gate again too
  write(path.join(wt, 'src', 'later2.ts'), 'export const later2 = 1;\n');
  commitAll(wt, 'during review');
  r = lane('advance', 'refund-route', 'review', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('(stale)'), r.stderr);
});

test('gate: a FAIL past the round limit parks the lane for a human', (t) => {
  const { root, store } = gateLane(t, { test: 'exit 1' });
  const kj = path.join(root, '.claude', 'kit.json');
  write(kj, JSON.stringify({ ...JSON.parse(read(kj)), max_rounds: 1 }, null, 2));
  const r = lane('gate', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 1);
  assert.match(r.stderr, /is parked: 1 failed round \(the last a gate FAIL\); round 2 would pass the limit of 1/);
  assert.equal(store().stage, 'parked');
  assert.ok(lane('gate', 'refund-route', '--repo', root).stderr.includes("at 'parked'"));
});

test('gate: refused at a stage that is not build or review, and when the kill switch is set', (t) => {
  const { root } = gateLane(t);
  assert.equal(lane('advance', 'refund-route', 'test', '--repo', root).returncode, 0);
  let r = lane('gate', 'refund-route', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes("at 'test'"), r.stderr);
  assert.equal(lane('stop', '--repo', root, '--by', 'J', '--reason', 'x').returncode, 0);
  r = lane('gate', 'refund-route', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('kill switch'), r.stderr);
});

// D4: protected files (#56 S1.3; 0016 E.1 Add 4) and the risk re-check

test('gate: a lane that changes .claude/ (kit.json), CI config or test config fails on protected files; the checks are not run', (t) => {
  for (const [file, text, why] of [
    ['.claude/kit.json', null, "the kit's configuration"],
    ['.github/workflows/ci.yml', 'on: push\n', 'CI configuration'],
    ['vitest.config.ts', 'export default {};\n', 'test configuration'],
  ]) {
    const { root, wt, store } = gateLane(t, { test: 'exit 1' });
    const p = path.join(wt, file);
    write(p, text ?? read(p).replace('"test": "exit 1"', '"test": "true"'));
    commitAll(wt, `lane: ${file}`);
    assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 1, file);
    const g = store().gate;
    assert.ok(g.failed.includes('protected-files'), `${file}: ${JSON.stringify(g.failed)}`);
    assert.equal(g.checks.find((c) => c.name === 'test').result, 'skipped', 'a check is never run on what the lane changed');
    assert.match(read(g.report), new RegExp(`${file.replace(/[.]/g, '\\.')}: ${why}`));
  }
});

test("gate: a package.json's scripts are protected, its dependencies are not; a test file is not test config", (t) => {
  const { root, wt, store } = gateLane(t);
  const pj = path.join(wt, 'package.json');
  const d = JSON.parse(read(pj));
  write(pj, JSON.stringify({ ...d, dependencies: { ...(d.dependencies ?? {}), 'left-pad': '1.3.0' } }, null, 2));
  write(path.join(wt, 'tests', 'refund.test.ts'), 'import { test } from "vitest";\ntest("x", () => {});\n');
  commitAll(wt, 'lane: a dependency and a test');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 0, read(root, '.claude', 'session', 'lanes', 'refund-route.gate.txt'));
  write(pj, JSON.stringify({ ...JSON.parse(read(pj)), scripts: { ...(d.scripts ?? {}), test: 'true' } }, null, 2));
  commitAll(wt, 'lane: a script');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 1);
  assert.match(read(store().gate.report), /package\.json: its "scripts" changed/);
});

test('gate: the spec changed after its approved commit fails on protected files', (t) => {
  const { root, wt, store } = gateLane(t);
  const sp = path.join(wt, 'docs', 'specs', 'refund-route.md');
  write(sp, read(sp).replace('## Non-goals', '## Non-goals\n\n- anything the lane finds inconvenient'));
  commitAll(wt, 'lane: rewrite the spec');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 1);
  assert.match(read(store().gate.report), /docs\/specs\/refund-route\.md: the spec changed after its approved commit/);
});

test('gate: a lane not approved as high risk that touches a high-risk path is stopped for the owner; a near name is not', (t) => {
  const { root, wt, store } = gateLane(t, {}, {}, { risk: 'normal' });
  write(path.join(wt, 'src', 'author.ts'), 'export const author = 1;\n');
  commitAll(wt, 'lane: author, not auth');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 0, read(root, '.claude', 'session', 'lanes', 'refund-route.gate.txt'));
  write(path.join(wt, 'src', 'billing', 'charge.ts'), 'export const charge = 1;\n');
  commitAll(wt, 'lane: billing, which its spec never named');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 1);
  assert.deepEqual(store().gate.failed, ['risk']);
  assert.match(read(store().gate.report), /src\/billing\/charge\.ts: a high-risk path \('billing'\), in a lane approved as normal/);
  greenRuns(wt);
  const ns = JSON.parse(lane('next-step', 'refund-route', '--repo', root).stdout);
  assert.ok(ns.stage === 'escalated' && ns.needs_human && /risk re-check/.test(ns.reason), JSON.stringify(ns));
});

test('gate: a lane approved as high risk may touch high-risk paths', (t) => {
  const { root, wt } = gateLane(t);
  write(path.join(wt, 'src', 'billing', 'charge.ts'), 'export const charge = 1;\n');
  commitAll(wt, 'lane: billing, in a high-risk lane');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 0, read(root, '.claude', 'session', 'lanes', 'refund-route.gate.txt'));
});

// #56 S1.5: before the merge the gate runs again on the lane updated from the base; a conflict parks the lane

test('gate --sync: updates the lane from the base\'s new tip, then gates the result; the merge needs exactly that', (t) => {
  const { root, wt, store } = gateLane(t);
  // the lane has a commit of its own, so the update is a real merge commit (not a fast-forward): it must work on a
  // machine with no git identity configured, as on a CI runner
  write(path.join(wt, 'src', 'api', 'refund.ts'), 'export const refund = 1;\n');
  commitAll(wt, 'lane: D1');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 0);
  const head0 = git(['rev-parse', 'HEAD'], wt).trim();
  assert.equal(L.syncProblem(root, 'refund-route', head0), null, 'nothing new on the base yet');
  // the base moves on (another lane merged)
  write(path.join(root, 'src', 'other.ts'), 'export const other = 1;\n');
  const tip = commitAll(root, 'another lane');
  assert.match(L.syncProblem(root, 'refund-route', head0), new RegExp(`does not contain main's tip ${tip.slice(0, 7)}: update it from the base and gate it again: kit lane gate refund-route --sync`));
  const r = lane('gate', 'refund-route', '--sync', '--repo', root);
  assert.equal(r.returncode, 0, r.stdout + r.stderr);
  const head1 = git(['rev-parse', 'HEAD'], wt).trim();
  assert.notEqual(head1, head0);
  assert.equal(spawnGit(['merge-base', '--is-ancestor', tip, head1], wt), 0, 'the lane now contains the base tip');
  assert.deepEqual({ commit: store().gate.commit, base_tip: store().gate.synced.base_tip, merged: store().gate.synced.merged }, { commit: head1, base_tip: tip, merged: true });
  assert.equal(L.syncProblem(root, 'refund-route', head1), null);
  assert.ok(fs.existsSync(path.join(wt, 'src', 'other.ts')));
  assert.equal(git(['rev-list', '--parents', '-n', '1', 'HEAD'], wt).trim().split(' ').length, 3, 'a merge commit, with both parents');
  // protected files and risk are judged on the lane's own changes, not the base's: the base's new file is not the lane's
  assert.ok(!store().gate.failed.length);
});

test('gate --sync: a merge conflict with the base is undone and parks the lane for a human; no verdict is written', (t) => {
  const { root, wt, store } = gateLane(t);
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// the lane\'s line\n');
  commitAll(wt, 'lane');
  assert.equal(lane('gate', 'refund-route', '--repo', root).returncode, 0);
  const head = git(['rev-parse', 'HEAD'], wt).trim();
  write(path.join(root, 'src', 'api', 'routes.ts'), '// the base\'s line\n');
  const tip = commitAll(root, 'base edits the same line');
  const r = lane('gate', 'refund-route', '--sync', '--repo', root);
  assert.equal(r.returncode, 2, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`lane refund-route is parked: a merge conflict with main at ${tip.slice(0, 7)} in src/api/routes\\.ts; the merge was undone\\. A human resolves it`));
  assert.equal(git(['rev-parse', 'HEAD'], wt).trim(), head, 'HEAD is where it was');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no'], wt).trim(), '', 'no half-merge left in the worktree');
  assert.ok(!fs.existsSync(path.join(wt, '.git')) || !fs.existsSync(path.join(git(['rev-parse', '--git-dir'], wt).trim(), 'MERGE_HEAD')), 'no merge in progress');
  assert.equal(store().stage, 'parked');
  assert.deepEqual(store().parked.conflict, ['src/api/routes.ts']);
  assert.equal(store().gate.commit, head, 'the last verdict is still the one for HEAD; the conflict wrote none');
  assert.match(L.syncProblem(root, 'refund-route', head), /does not contain main's tip/);
});
