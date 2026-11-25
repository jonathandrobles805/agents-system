import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { git, commitAll, nodeApi, approveSpec } from './fixtures.js';
import { runScript, setEnv, tmpPath } from './helpers.js';
import { project, spec, review } from './testdata.js';
import * as P from '../permission_probe.js';
import * as K from '../kitlib.js';
import * as L from '../lane.js';

const lane = (...args) => runScript('lane.js', args);
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, text) => fs.writeFileSync(p, text);

test('precheck passes for approved spec', (t) => {
  const { root } = project(t);
  const r = lane('precheck', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
});

test('precheck refuses unapproved', (t) => {
  const { root } = project(t, { status: 'waiting-approval', approved: false });
  const r = lane('precheck', 'refund-route', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('no recorded approval for refund-route: merge the spec PR first') && r.stderr.includes("needs 'approved'"), r.stderr);
});

test('precheck refuses open question', (t) => {
  const { root } = project(t);
  const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
  write(sp, read(sp).replaceAll('## Open questions\n\n- none', '## Open questions\n\n- is refund idempotent?'));
  const r = lane('precheck', 'refund-route', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('open-questions'));
});

test('precheck refuses overlap', (t) => {
  const { root, commit } = project(t, { wipLimit: 2 });
  const other = spec({ commit: commit.slice(0, 7), deps: 'none', extra: '' }).replaceAll('refund-route', 'other').replaceAll('Refund route', 'Other');
  write(path.join(root, 'docs', 'specs', 'other.md'), other);
  const r = lane('precheck', 'refund-route', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes("file overlap with active spec 'other'"), r.stderr);
});

test('precheck refuses when the WIP limit is already taken by a live lane', (t) => {
  const { root, commit } = project(t, { wipLimit: 1 });
  // a second feature that touches different files, so only the WIP limit can refuse it
  let other = spec({ commit: commit.slice(0, 7), deps: 'none', extra: '' }).replaceAll('refund-route', 'other').replaceAll('Refund route', 'Other');
  other = other.replaceAll('src/api/routes.ts', 'src/api/other.ts').replaceAll('tests/routes.test.ts', 'tests/other.test.ts');
  write(path.join(root, 'src', 'api', 'other.ts'), "import { PaymentService } from '../domain/payment';\nexport function other(s: PaymentService) {\n  return { charge: (u: string) => s.charge(u) };\n}\n");
  write(path.join(root, 'docs', 'specs', 'other.md'), other);
  commitAll(root, 'second spec');
  approveSpec(root, 'other');
  // WIP is the number of worktrees holding a lane.json, not a word in ROADMAP (decision 0006): starting one takes it
  assert.equal(JSON.parse(lane('wip', '--repo', root).stdout).in_flight, 0);
  assert.equal(lane('start', 'other', '--repo', root).returncode, 0);
  assert.equal(JSON.parse(lane('wip', '--repo', root).stdout).in_flight, 1);
  const r = lane('precheck', 'refund-route', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('WIP limit reached: 1/1 in flight (other)'), r.stderr);
});

test('start fails closed on the base (hardening plan D3): no origin is refused unless local_only; a failed fetch is always refused; the base commit is recorded', (t) => {
  const { root } = project(t);
  const kj = path.join(root, '.claude', 'kit.json');
  const setLocal = (v) => { const d = JSON.parse(read(kj)); if (v === undefined) delete d.local_only; else d.local_only = v; write(kj, JSON.stringify(d, null, 2) + '\n'); commitAll(root, `local_only ${v}`); };
  const lanes = path.join(path.dirname(root), `${path.basename(root)}-lanes`, 'refund-route');
  // nothing created anywhere: no worktree, no lane branch, the main checkout untouched
  const nothingCreated = () => {
    assert.ok(!fs.existsSync(lanes), 'no worktree');
    assert.equal(git(['branch', '--list', 'wt/refund-route'], root).trim(), '', 'no lane branch');
    assert.equal(git(['status', '--porcelain'], root).trim(), '', 'main checkout unchanged');
  };
  // no origin, not local-only: refused, nothing created
  setLocal(undefined);
  let r = lane('start', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 2);
  assert.match(r.stderr, /no 'origin' remote.*"local_only": true/);
  nothingCreated();
  // "local_only": "yes" is not true: still refused
  setLocal('yes');
  r = lane('start', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 2);
  assert.match(r.stderr, /no 'origin' remote/);
  nothingCreated();
  // an origin that cannot be fetched: refused even with local_only, nothing created
  setLocal(true);
  git(['remote', 'add', 'origin', path.join(tmpPath(t), 'no-such-remote.git')], root);
  r = lane('start', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 2);
  assert.match(r.stderr, /could not fetch 'main' from origin, so the lane would start from a stale base \(fatal: /);
  nothingCreated();
  // a reachable origin: the lane starts from origin/main, recorded with its commit, even when local main is ahead
  const bare = path.join(tmpPath(t), 'origin.git');
  git(['init', '-q', '--bare', bare], path.dirname(bare));
  git(['remote', 'set-url', 'origin', bare], root);
  git(['push', '-q', 'origin', 'main'], root);
  // the remote moves on after the last fetch, and the remote's refspec does not cover main (a narrowed clone):
  // the start must still use the remote's newest main, not a stale origin/main
  const other = path.join(tmpPath(t), 'other');
  git(['clone', '-q', '-b', 'main', bare, other], path.dirname(other));
  write(path.join(other, 'remote-change.txt'), 'pushed by someone else\n');
  commitAll(other, 'remote moved on');
  git(['push', '-q', 'origin', 'main'], other);
  const remoteHead = git(['rev-parse', 'main'], other).trim();
  git(['config', '--unset-all', 'remote.origin.fetch'], root);
  write(path.join(root, 'local-only-change.txt'), 'not pushed\n');
  commitAll(root, 'local commit, not pushed');
  r = lane('start', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
  const lj = JSON.parse(read(lanes, '.claude', 'lane.json'));
  assert.equal(lj.base_commit, remoteHead, 'the remote\'s newest main, fetched explicitly');
  assert.ok(fs.existsSync(path.join(lanes, 'remote-change.txt')), 'the remote\'s new commit is in the lane');
  assert.ok(!fs.existsSync(path.join(lanes, 'local-only-change.txt')), 'the unpushed local commit is not in the lane');
});

test('start on a local-only repo records it and starts from the local base', (t) => {
  const { root } = project(t);
  const r = lane('start', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
  const lj = JSON.parse(read(JSON.parse(r.stdout).worktree, '.claude', 'lane.json'));
  assert.equal(lj.base_commit, git(['rev-parse', 'main'], root).trim());
});

test('start creates worktree lane and progress', (t) => {
  const { root } = project(t);
  const r = lane('start', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const wt = out.worktree;
  assert.ok(fs.statSync(wt).isDirectory() && fs.statSync(path.join(wt, '.claude', 'lane.json')).isFile());
  const lj = JSON.parse(read(wt, '.claude', 'lane.json'));
  assert.ok(lj.feature === 'refund-route' && lj.stage === 'build' && lj.branch === 'wt/refund-route');
  const prog = read(wt, 'docs', 'specs', 'refund-route.progress.md');
  assert.ok(prog.includes('| D1 | routes exposes refund | `tests/routes.test.ts::exposes refund` | — | — |'));
  // #36: the status belongs on main, the only copy anyone reads to see what is in flight, and the lane's own
  // ROADMAP is left exactly as the branch had it
  assert.ok(read(root, 'ROADMAP.md').includes('| Refund route | refund-route | M1 | building |'));
  assert.ok(!read(wt, 'ROADMAP.md').includes('| Refund route | refund-route | M1 | building |'));
  assert.equal(git(['branch', '--show-current'], wt).trim(), 'wt/refund-route');
  const kit = JSON.parse(read(root, '.claude', 'kit.json'));
  assert.ok('refund-route' in kit.lanes);
  // lane.json is ignored by git inside the worktree
  assert.ok(!git(['status', '--porcelain', '--untracked-files=all'], wt).includes('.claude/lane.json'));
  // second start is refused
  const r2 = lane('start', 'refund-route', '--repo', root);
  assert.ok(r2.returncode === 2 && r2.stderr.includes('already exists'));
});

test('stage and finish', (t) => {
  const { root } = project(t);
  const out = JSON.parse(lane('start', 'refund-route', '--repo', root).stdout);
  const wt = out.worktree;
  // lane.js stage is the old name of advance: the same table, the same store
  assert.equal(lane('stage', 'refund-route', 'test', '--repo', root).returncode, 0);
  assert.equal(JSON.parse(read(wt, '.claude', 'lane.json')).stage, 'test');
  assert.equal(JSON.parse(read(root, '.claude', 'session', 'lanes', 'refund-route.json')).stage, 'test');
  const r = lane('finish', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
  assert.ok(!fs.existsSync(wt));
  assert.ok(!git(['branch'], root).includes('wt/refund-route'));
  assert.ok(read(root, 'ROADMAP.md').includes('| Refund route | refund-route | M1 | merged |'));
  assert.ok(!('refund-route' in JSON.parse(read(root, '.claude', 'kit.json')).lanes));
});

test('#41 a raised budget survives a stage change', (t) => {
  // A human raised the review budget to 400/4h; the next lane.js stage review put it back to the default and the
  // budget hook stopped the lane again at 250 calls. A raise recorded in budget_override.<stage> outlives the stage change.
  const { root } = project(t);
  const wt = JSON.parse(lane('start', 'refund-route', '--repo', root).stdout).worktree;
  const lf = path.join(wt, '.claude', 'lane.json');
  const d = JSON.parse(fs.readFileSync(lf, 'utf8'));
  d.budget_override = { test: { tool_calls: 400, hours: 4 } };
  fs.writeFileSync(lf, JSON.stringify(d, null, 2));
  assert.equal(lane('advance', 'refund-route', 'test', '--repo', root).returncode, 0);
  const after = JSON.parse(fs.readFileSync(lf, 'utf8'));
  assert.equal(after.stage, 'test');
  assert.equal(after.budget.tool_calls, 400, JSON.stringify(after.budget));
  assert.equal(after.budget.hours, 4, JSON.stringify(after.budget));
  assert.deepEqual(after.budget_override, { test: { tool_calls: 400, hours: 4 } }, 'the override itself is kept');
});

// hardening plan Step 2: lane.js advance is the only writer of the lane store, through one table of allowed moves
const storeOf = (root) => JSON.parse(read(root, '.claude', 'session', 'lanes', 'refund-route.json'));
const LOG_RED = '=== 2026-11-11T10:00:00 test: npx vitest run -> exit 1\nnot ok 1 - exposes refund\n\n';
const LOG_GREEN = '=== 2026-11-11T10:05:00 test: npx vitest run -> exit 0\nok 1 - exposes refund\n\n';

test('advance: start writes the store; an illegal move is refused with a reason; each legal move is recorded with its commit', (t) => {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root } = project(t);
  const wt = JSON.parse(lane('start', 'refund-route', '--repo', root).stdout).worktree;
  assert.equal(storeOf(root).stage, 'build');
  assert.deepEqual(storeOf(root).moves.map((m) => [m.from, m.to]), [[null, 'build']]);
  // the store is in the main checkout, ignored by git, and not in the lane
  assert.equal(git(['status', '--porcelain'], root).includes('.claude/session'), false);
  assert.ok(!fs.existsSync(path.join(wt, '.claude', 'session', 'lanes')));
  let r = lane('advance', 'refund-route', 'retro', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('not merged'), r.stderr);
  assert.equal(lane('advance', 'refund-route', 'test', '--repo', root).returncode, 0);
  r = lane('advance', 'refund-route', 'review', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('test → review is not an allowed move') && r.stderr.includes('may go to test, build, retro'), r.stderr);
  r = lane('advance', 'refund-route', 'plan', '--repo', root);
  assert.notEqual(r.returncode, 0, 'a stage outside the table is not even accepted as an argument');
  // the lane's own lane.json is a copy for the in-lane hooks; the store wins where they differ
  const lf = path.join(wt, '.claude', 'lane.json');
  assert.equal(JSON.parse(read(lf)).stage, 'test');
  write(lf, read(lf).replace('"stage": "test"', '"stage": "review"'));
  const st = JSON.parse(runScript('kit_status.js', ['--repo', root, '--json']).stdout).lanes.find((l) => l.slug === 'refund-route');
  assert.ok(st.stage === 'test' && st.position === 'building', JSON.stringify({ stage: st.stage, position: st.position }));
  r = lane('advance', 'refund-route', 'review', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('test → review is not an allowed move'), 'a lane rewriting its lane.json does not move its stage');
  // fields a later step adds to the record are kept by every move
  const sp = path.join(root, '.claude', 'session', 'lanes', 'refund-route.json');
  write(sp, JSON.stringify({ ...storeOf(root), approval: { by: 'Jonathan Robles' } }));
  write(path.join(wt, '.claude/session/refund-route.log'), LOG_RED + LOG_GREEN);
  const prog = path.join(wt, 'docs/specs/refund-route.progress.md');
  write(prog, read(prog).replaceAll('| — | — |', '| refund-route.log#1 | — |'));
  assert.equal(lane('advance', 'refund-route', 'build', '--repo', root).returncode, 0);
  write(prog, read(prog).replaceAll('| refund-route.log#1 | — |', '| refund-route.log#1 | refund-route.log#4 |'));
  assert.equal(lane('advance', 'refund-route', 'review', '--repo', root).returncode, 0);
  assert.equal(lane('advance', 'refund-route', 'build', '--repo', root).returncode, 0, 'a review FAIL sends the work back');
  assert.equal(lane('advance', 'refund-route', 'review', '--repo', root).returncode, 0);
  const rec = storeOf(root);
  assert.deepEqual(rec.moves.map((m) => m.to), ['build', 'test', 'build', 'review', 'build', 'review']);
  assert.deepEqual(rec.approval, { by: 'Jonathan Robles' });
  assert.ok(rec.moves.every((m) => /^[0-9a-f]{40}$/.test(m.commit)));
  // merged in git: lane.js merged moves the lane to retro, where its evidence is sealed (#107 reads this)
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// built\n');
  commitAll(wt, 'D1');
  lane('evidence', 'refund-route', '--repo', root);
  commitAll(wt, 'evidence');
  git(['merge', '-q', '--no-ff', 'wt/refund-route', '-m', 'merge'], root);
  r = lane('merged', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
  assert.equal(storeOf(root).stage, 'retro');
  assert.equal(JSON.parse(read(lf)).stage, 'retro');
  // the kill switch refuses every move
  lane('stop', '--repo', root, '--by', 'Jonathan', '--reason', 'test');
  r = lane('advance', 'refund-route', 'retro', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('kill switch'), r.stderr);
});

test('advance (#56): a progress cell containing # moves no stage unless it names a logged run of its test', (t) => {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root } = project(t);
  fs.mkdirSync(path.join(root, 'docs', 'goals'));
  write(path.join(root, 'docs', 'goals', 'refund-route.md'), GOAL);
  const wt = JSON.parse(lane('start', 'refund-route', '--repo', root).stdout).worktree;
  assert.equal(lane('advance', 'refund-route', 'test', '--repo', root).returncode, 0);
  const prog = path.join(wt, 'docs/specs/refund-route.progress.md');
  write(prog, read(prog).replaceAll('| — | — |', '| see #3 | #4 |'));
  let r = lane('advance', 'refund-route', 'build', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('test → build refused') && r.stderr.includes('D1: red run ref see #3 points past the end'), r.stderr);
  // a logged run of another test is no red run for this one
  write(path.join(wt, '.claude/session/refund-route.log'), LOG_RED.replace('exposes refund', 'charges'));
  write(prog, read(prog).replace('| see #3 | #4 |', '| refund-route.log#1 | — |'));
  r = lane('advance', 'refund-route', 'build', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes("has no result for '`tests/routes.test.ts::exposes refund`'"), r.stderr);
  assert.equal(JSON.parse(lane('next-step', 'refund-route', '--repo', root).stdout).stage, 'test', 'next-step agrees: tester first');
  assert.equal(storeOf(root).stage, 'test');
  write(path.join(wt, '.claude/session/refund-route.log'), LOG_RED);
  assert.equal(JSON.parse(lane('next-step', 'refund-route', '--repo', root).stdout).stage, 'build');
  assert.equal(lane('advance', 'refund-route', 'build', '--repo', root).returncode, 0);
});

test('advance: a lane started before the store keeps working; its lane.json stage is read until its first move', (t) => {
  const { root } = project(t);
  const wt = JSON.parse(lane('start', 'refund-route', '--repo', root).stdout).worktree;
  fs.rmSync(path.join(root, '.claude', 'session', 'lanes'), { recursive: true });
  const lf = path.join(wt, '.claude', 'lane.json');
  write(lf, read(lf).replace('"stage": "build"', '"stage": "review"'));
  assert.equal(lane('advance', 'refund-route', 'build', '--repo', root).returncode, 0);
  assert.deepEqual(storeOf(root).moves.map((m) => [m.from, m.to]), [['review', 'build']]);
});

// hardening plan Step 2: rounds and wall time are kept in the store by advance, not in the lane's own files

/** A started lane at review, its criteria citing a logged red and green run, as the tester and implementer leave it. */
function atReview(t, { maxRounds = null } = {}) {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root } = project(t);
  if (maxRounds !== null) {
    const kj = path.join(root, '.claude', 'kit.json');
    write(kj, JSON.stringify({ ...JSON.parse(read(kj)), max_rounds: maxRounds }, null, 2));
    commitAll(root, 'max_rounds');
  }
  fs.mkdirSync(path.join(root, 'docs', 'goals'), { recursive: true });
  write(path.join(root, 'docs', 'goals', 'refund-route.md'), GOAL);
  const wt = JSON.parse(lane('start', 'refund-route', '--repo', root).stdout).worktree;
  assert.equal(lane('advance', 'refund-route', 'test', '--repo', root).returncode, 0);
  write(path.join(wt, '.claude/session/refund-route.log'), LOG_RED + LOG_GREEN);
  const prog = path.join(wt, 'docs/specs/refund-route.progress.md');
  write(prog, read(prog).replaceAll('| — | — |', '| refund-route.log#1 | refund-route.log#4 |'));
  assert.equal(lane('advance', 'refund-route', 'build', '--repo', root).returncode, 0);
  assert.equal(lane('advance', 'refund-route', 'review', '--repo', root).returncode, 0);
  return { root, wt };
}
const statusOf = (root) => JSON.parse(runScript('kit_status.js', ['--repo', root, '--json']).stdout);
const laneStatus = (root) => statusOf(root).lanes.find((l) => l.slug === 'refund-route');

test('rounds: each review → build move counts a FAIL round in the store; a round past the limit parks the lane with its reason', (t) => {
  const { root } = atReview(t);
  assert.deepEqual(L.laneRounds(root, storeOf(root)), { round: 1, limit: 3, failed: 0, parked: null });
  assert.deepEqual(laneStatus(root).rounds, { round: 1, limit: 3, failed: 0, parked: null });
  for (const n of [1, 2]) {
    assert.equal(lane('advance', 'refund-route', 'build', '--repo', root).returncode, 0, `FAIL round ${n} sends the work back`);
    assert.equal(storeOf(root).failed_rounds, n);
    assert.equal(lane('advance', 'refund-route', 'review', '--repo', root).returncode, 0);
  }
  const ns = JSON.parse(lane('next-step', 'refund-route', '--repo', root).stdout);
  assert.deepEqual(ns.rounds, { round: 3, limit: 3, failed: 2, parked: false });
  // the third FAIL would start round 4 of 3: lane.js stage (advance's old name, the same call) parks the lane instead
  const r = lane('stage', 'refund-route', 'build', '--repo', root);
  assert.equal(r.returncode, 2, r.stderr);
  assert.match(r.stderr, /review → build refused: the lane is parked/);
  assert.match(r.stderr, /3 review FAIL rounds; round 4 would pass the limit of 3/);
  assert.match(r.stderr, /kit lane advance refund-route build --by <name>/, 'it names the command the human runs');
  const rec = storeOf(root);
  assert.equal(rec.stage, 'parked');
  assert.equal(rec.failed_rounds, 3);
  assert.match(rec.parked.reason, /round 4 would pass the limit of 3/);
  assert.deepEqual(rec.moves.slice(-1).map((m) => [m.from, m.to]), [['review', 'parked']]);
  assert.match(read(root, 'ROADMAP.md'), /\| refund-route \| M1 \| escalated \|/);
  // readers: kit_status (the dashboard's source) and next-step say so, from the store
  const st = statusOf(root);
  const l = st.lanes.find((x) => x.slug === 'refund-route');
  assert.equal(l.position, 'escalated');
  assert.ok(l.rounds.parked && l.rounds.round === 3 && l.rounds.limit === 3, JSON.stringify(l.rounds));
  assert.ok(st.needs_you.some((n) => n.slug === 'refund-route' && /round 4 would pass/.test(n.failure)), JSON.stringify(st.needs_you));
  const parked = JSON.parse(lane('next-step', 'refund-route', '--repo', root).stdout);
  assert.ok(parked.stage === 'escalated' && parked.needs_human && /kit lane advance refund-route build --by <name>/.test(parked.reason), JSON.stringify(parked));
  // a merge is a fact in git: a parked lane the owner merged anyway goes to retro, and nobody is recorded as unparking it
  const wt = path.join(path.dirname(root), `${path.basename(root)}-lanes`, 'refund-route');
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// built\n');
  commitAll(wt, 'D1');
  lane('evidence', 'refund-route', '--repo', root);
  commitAll(wt, 'evidence');
  git(['merge', '-q', '--no-ff', 'wt/refund-route', '-m', 'merge'], root);
  const m = lane('merged', 'refund-route', '--repo', root);
  assert.equal(m.returncode, 0, m.stderr);
  assert.ok(storeOf(root).stage === 'retro' && storeOf(root).unparked === undefined, JSON.stringify(storeOf(root)));
});

test('rounds: a parked lane refuses every build move until a named human lets it go on, for one more round', (t) => {
  const { root, wt } = atReview(t, { maxRounds: 1 });
  let r = lane('advance', 'refund-route', 'build', '--repo', root);
  assert.ok(r.returncode === 2 && /round 2 would pass the limit of 1/.test(r.stderr), `kit.json max_rounds sets the limit: ${r.stderr}`);
  for (const to of ['test', 'review']) {
    r = lane('advance', 'refund-route', to, '--repo', root);
    assert.ok(r.returncode === 2 && r.stderr.includes(`parked → ${to} is not an allowed move`) && r.stderr.includes('--by <name>'), r.stderr);
  }
  r = lane('advance', 'refund-route', 'build', '--repo', root);
  assert.ok(r.returncode === 2 && r.stderr.includes('only a named human lets it go on'), r.stderr);
  r = lane('advance', 'refund-route', 'parked', '--repo', root);
  assert.equal(r.returncode, 2, 'nothing moves a lane to parked but the round limit');
  // the lane rewriting its own lane.json changes nothing: the store is the record
  const lf = path.join(wt, '.claude', 'lane.json');
  write(lf, JSON.stringify({ ...JSON.parse(read(lf)), stage: 'build', failed_rounds: 0, round_limit: 99 }, null, 2));
  assert.equal(lane('advance', 'refund-route', 'review', '--repo', root).returncode, 2);
  assert.equal(storeOf(root).stage, 'parked');
  assert.equal(laneStatus(root).position, 'escalated');
  // the human's word: one more round, recorded with their name; the next FAIL parks it again
  r = lane('advance', 'refund-route', 'build', '--repo', root, '--by', 'Jonathan Robles');
  assert.equal(r.returncode, 0, r.stderr);
  const rec = storeOf(root);
  assert.equal(rec.stage, 'build');
  assert.equal(rec.parked, undefined);
  assert.equal(rec.round_limit, 2);
  assert.ok(rec.unparked.length === 1 && rec.unparked[0].by === 'Jonathan Robles' && rec.unparked[0].round === 2, JSON.stringify(rec.unparked));
  assert.match(read(root, 'ROADMAP.md'), /\| refund-route \| M1 \| building \|/);
  assert.deepEqual(laneStatus(root).rounds, { round: 2, limit: 2, failed: 1, parked: null });
  assert.equal(lane('advance', 'refund-route', 'review', '--repo', root).returncode, 0);
  r = lane('advance', 'refund-route', 'build', '--repo', root);
  assert.ok(r.returncode === 2 && /2 review FAIL rounds; round 3 would pass the limit of 2/.test(r.stderr), r.stderr);
});

test('wall time is the store\'s: started and each move\'s time; the budget hook reads it, not the lane\'s lane.json', (t) => {
  const { root, wt } = atReview(t);
  const sp = path.join(root, '.claude', 'session', 'lanes', 'refund-route.json');
  const seven = K.isoSeconds(new Date(Date.now() - 7 * 3.6e6));
  const rec = storeOf(root);
  assert.ok(typeof rec.started === 'string' && rec.started === rec.moves[0].at, 'the lane\'s start is recorded');
  write(sp, JSON.stringify({ ...rec, started: seven, moves: rec.moves.map((m) => ({ ...m, at: seven })), budget: { hours: 1, tool_calls: 800 } }, null, 2));
  const l = laneStatus(root);
  assert.ok(l.elapsed_hours > 6.9 && l.elapsed_hours < 7.1 && l.started === seven, JSON.stringify({ e: l.elapsed_hours, s: l.started }));
  assert.ok(JSON.parse(lane('next-step', 'refund-route', '--repo', root).stdout).elapsed_hours > 6.9);
  // the lane resets its own clock and raises its budget in lane.json: the hook still reads the store
  const lf = path.join(wt, '.claude', 'lane.json');
  write(lf, JSON.stringify({ ...JSON.parse(read(lf)), started: K.isoSeconds(), budget: { hours: 100, tool_calls: 100000 } }, null, 2));
  const h = runScript('hook_budget_check.js', [], { stdin: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', cwd: wt, tool_name: 'Read', tool_input: { file_path: 'x' } }) });
  assert.match(h.stdout, /budget exceeded for stage 'review': 7\.0h elapsed > budget 1h/, JSON.stringify(h));
  // re-entering the stage it is at does not restart its clock (#53)
  assert.equal(lane('advance', 'refund-route', 'review', '--repo', root).returncode, 0);
  assert.equal(K.storeClock(storeOf(root)).stage_started, seven);
  // a review FAIL starts a new build stage, with its own clock
  assert.equal(lane('advance', 'refund-route', 'build', '--repo', root).returncode, 0);
  const c = K.storeClock(storeOf(root));
  assert.ok(c.stage_hours < 0.1 && c.elapsed_hours > 6.9, JSON.stringify(c));
});

test('rounds and time: a lane recorded before these fields counts from 0 and never crashes', (t) => {
  const { root, wt } = atReview(t);
  const sp = path.join(root, '.claude', 'session', 'lanes', 'refund-route.json');
  const { started: _s, failed_rounds: _f, budget: _b, ...old } = storeOf(root);
  write(sp, JSON.stringify(old, null, 2));
  assert.deepEqual(laneStatus(root).rounds, { round: 1, limit: 3, failed: 0, parked: null });
  assert.equal(laneStatus(root).started, old.moves[0].at, 'its start is its first move');
  assert.equal(lane('advance', 'refund-route', 'build', '--repo', root).returncode, 0);
  assert.equal(storeOf(root).failed_rounds, 1);
  assert.equal(storeOf(root).started, old.moves[0].at);
  // no store at all (a lane started before the store): its lane.json's stage, no rounds or time to show
  fs.rmSync(path.join(root, '.claude', 'session', 'lanes'), { recursive: true });
  const l = laneStatus(root);
  assert.ok(l.rounds === null && l.elapsed_hours === null && l.stage === 'build', JSON.stringify({ r: l.rounds, e: l.elapsed_hours, s: l.stage }));
  assert.equal(JSON.parse(lane('next-step', 'refund-route', '--repo', root).stdout).rounds, undefined);
  const lf = path.join(wt, '.claude', 'lane.json');
  write(lf, read(lf).replace('"stage": "build"', '"stage": "review"'));
  assert.equal(lane('advance', 'refund-route', 'build', '--repo', root).returncode, 0);
  assert.equal(storeOf(root).failed_rounds, 1, 'its first FAIL round is round 1');
});

test('wip count comes from the lane worktrees, not from ROADMAP', (t) => {
  const { root } = project(t, { wipLimit: 1 });
  let r = lane('wip', '--repo', root);
  assert.ok(r.returncode === 0 && JSON.parse(r.stdout).in_flight === 0);
  assert.equal(lane('start', 'refund-route', '--repo', root).returncode, 0);
  // no ROADMAP edit: lane.js start writes 'building' into the worktree's copy, which the main checkout never sees
  assert.match(read(path.join(root, 'ROADMAP.md')), /\| refund-route \| M1 \| building \|/); // #36
  r = lane('wip', '--repo', root);
  assert.ok(r.returncode === 2 && JSON.parse(r.stdout).in_flight === 1, r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).lanes, ['refund-route']);
  // and /zi-status reports the same number, because it calls the same function
  const s = JSON.parse(runScript('kit_status.js', ['--repo', root, '--json']).stdout);
  assert.deepEqual(s.wip, { in_flight: 1, limit: 1 });
});

test('index lookup reuse stale new', (t) => {
  const { root, commit } = project(t);
  let r = lane('index', 'add', 'How does PaymentService charge a user?', '--repo', root, '--slug', 'payment-charge',
    '--keywords', 'payment charge service', '--files', 'src/domain/payment.ts', '--commit', commit.slice(0, 7));
  assert.equal(r.returncode, 0, r.stderr);
  let res = JSON.parse(lane('index', 'lookup', 'how does the payment service charge users', '--repo', root, '--json').stdout);
  assert.ok(res.decision === 'reuse' && res.match.slug === 'payment-charge');
  res = JSON.parse(lane('index', 'lookup', 'what does the webhook retry policy look like', '--repo', root, '--json').stdout);
  assert.equal(res.decision, 'new');
  const payment = path.join(root, 'src', 'domain', 'payment.ts');
  write(payment, '// changed\n' + read(payment));
  commitAll(root, 'change payment');
  res = JSON.parse(lane('index', 'lookup', 'How does PaymentService charge a user?', '--repo', root, '--json').stdout);
  assert.ok(res.decision === 'reverify');
  assert.deepEqual(res.stale_files, ['src/domain/payment.ts']);
  // re-adding the same slug supersedes the old row
  lane('index', 'add', 'How does PaymentService charge a user?', '--repo', root, '--slug', 'payment-charge', '--keywords', 'payment charge', '--files', 'src/domain/payment.ts', '--commit', 'deadbee');
  const text = read(root, 'docs', 'research', 'INDEX.md');
  assert.ok(text.split('| payment-charge |').length - 1 === 2 && text.includes('| superseded |'));
});

test('unknowns budget', (t) => {
  const { root } = project(t);
  const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
  const base = read(sp);
  let r = lane('unknowns', 'docs/specs/refund-route.md', '--repo', root, '--json');
  assert.ok(r.returncode === 0 && JSON.parse(r.stdout).decision === 'none');
  const two = base.replaceAll('- A1. routes returns a plain object [verified: src/api/routes.ts:3-3]',
    '- A1. routes returns a plain object [verified: src/api/routes.ts:3-3]\n- A2. refund idempotent at provider [unknown] Resolve by: call sandbox twice\n- A3. rate limit [unknown]');
  write(sp, two);
  r = lane('unknowns', 'docs/specs/refund-route.md', '--repo', root, '--json');
  let out = JSON.parse(r.stdout);
  assert.ok(r.returncode === 3 && out.decision === 'resolve' && out.count === 2 && out.missing_method === 1);
  const four = two.replaceAll('## Open questions\n\n- none', '## Open questions\n\n- who owns refunds?\n- which currency?');
  write(sp, four);
  r = lane('unknowns', 'docs/specs/refund-route.md', '--repo', root, '--json');
  out = JSON.parse(r.stdout);
  assert.ok(r.returncode === 2 && out.decision === 'research' && out.count === 4);
});

test('incident record', (t) => {
  const { root } = project(t);
  const r = lane('incident', '--repo', root, '--what', 'refund charged twice on retry', '--slug', 'refund-route', '--pr', 'https://x/pr/9');
  assert.equal(r.returncode, 0, r.stderr);
  const p = path.join(root, r.stdout.trim());
  assert.ok(fs.statSync(p).isFile() && path.basename(path.dirname(p)) === 'incidents');
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes('refund charged twice on retry') && text.includes('- Feature: refund-route') && text.includes('- Status: open') && !text.split('## Impact')[0].includes('{{'));
  const r2 = lane('incident', '--repo', root, '--what', 'second');
  assert.notEqual(r2.stdout.trim(), r.stdout.trim());
});

const GOAL = `# Goal: Refund route

- Slug: refund-route
- Date: 2026-11-08
- Agreed by: Jonathan Robles and Claude on 2026-11-08
- Status: agreed

## What we want

Expose refunds over the routes module.

## Who it is for

- support staff

## Done looks like

- G1. POST refund returns the service result

## Not in this goal

- partial refunds

## Constraints

- no new dependencies

## Open points settled during discussion

- none
`;

// Hardening plan Step 2, D1 "The approval line": the owner approves a spec by saying yes to merging its spec/<slug> PR,
// and lane.js merge records that yes in the lane store. lane.js start builds only such a spec, on the base it starts from.
test('start builds only a spec the owner approved by merging its spec PR (D1): not on main, not approved, a written line', (t) => {
  const { root } = project(t, { approved: false });
  const lanes = path.join(path.dirname(root), `${path.basename(root)}-lanes`, 'refund-route');
  const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
  const refused = (r, text) => {
    assert.equal(r.returncode, 2, r.stdout);
    assert.ok(r.stderr.includes(text), r.stderr);
    assert.ok(!fs.existsSync(lanes), 'no worktree');
    assert.equal(git(['branch', '--list', 'wt/refund-route'], root).trim(), '', 'no lane branch');
  };
  const specText = read(sp);
  // the spec PR is open: its branch holds the spec, main does not, nothing is recorded
  git(['branch', 'spec/refund-route'], root);
  git(['reset', '-q', '--hard', 'HEAD~1'], root);
  git(['checkout', '-q', 'spec/refund-route'], root);
  refused(lane('start', 'refund-route', '--repo', root), 'no recorded approval for refund-route: merge the spec PR first, with kit lane merge --pr <the spec/refund-route PR> --by <your name>');
  // an approval line written into the spec (by an agent, say) approves nothing
  write(sp, read(sp).replace('Approved by: — on — at —', 'Approved by: Jonathan Robles on 2026-11-08 at abc1234'));
  const lineOnly = commitAll(root, 'an agent fills the approval line');
  refused(lane('start', 'refund-route', '--repo', root), "An 'Approved by:' line in the spec does not count");
  // a record whose merge is not in main, with the spec not on main either: the spec must be merged first
  approveSpec(root, 'refund-route', { commit: lineOnly });
  refused(lane('start', 'refund-route', '--repo', root), 'spec docs/specs/refund-route.md is not on main: merge the spec PR first');
  // merged, but the merged spec says waiting-approval (the PR was merged without setting Status: approved)
  git(['checkout', '-q', 'main'], root);
  write(sp, specText.replace('- Status: approved', '- Status: waiting-approval'));
  approveSpec(root, 'refund-route', { commit: commitAll(root, 'spec: refund-route (#2)'), pr: 2 });
  git(['checkout', '-q', 'spec/refund-route'], root);
  refused(lane('start', 'refund-route', '--repo', root), 'the spec on main says Status: waiting-approval; it is approved when a spec/refund-route PR that sets Status: approved is merged with kit lane merge');
  git(['checkout', '-q', 'main'], root);
  refused(lane('start', 'refund-route', '--repo', root), "spec status is 'waiting-approval', needs 'approved' (set it on the spec/refund-route PR");
  // a recorded merge that main does not contain (reverted, or recorded against another branch)
  write(sp, read(sp).replace('- Status: waiting-approval', '- Status: approved'));
  commitAll(root, 'spec: refund-route approved (#3)');
  approveSpec(root, 'refund-route', { commit: lineOnly, pr: 3 });
  refused(lane('start', 'refund-route', '--repo', root), `the recorded approval of refund-route (PR #3, merged as ${lineOnly.slice(0, 7)}) is not in main`);
});

test('start goes ahead once the spec PR is merged and recorded, with or without an approval line; the record outlives the start (D1)', (t) => {
  // Approved by: — on — at —: the spec file no longer needs the line
  const { root } = project(t, { approved: false });
  assert.equal(lane('precheck', 'refund-route', '--repo', root).returncode, 2);
  const ap = approveSpec(root, 'refund-route', { pr: 2 });
  assert.equal(lane('precheck', 'refund-route', '--repo', root).returncode, 0);
  const r = lane('start', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
  const rec = JSON.parse(read(root, '.claude', 'session', 'lanes', 'refund-route.json'));
  assert.equal(rec.stage, 'build');
  assert.deepEqual(rec.spec_approval, ap);
  // a lane already under way is not re-checked: one started before this change has no recorded approval, and its
  // stage still moves
  delete rec.spec_approval;
  write(path.join(root, '.claude', 'session', 'lanes', 'refund-route.json'), JSON.stringify(rec, null, 2));
  const adv = lane('advance', 'refund-route', 'test', '--repo', root);
  assert.equal(adv.returncode, 0, adv.stderr);
  assert.equal(JSON.parse(read(root, '.claude', 'session', 'lanes', 'refund-route.json')).stage, 'test');
});

test('lane.js merge records the owner\'s yes to a spec PR in the store, also for one already merged on GitHub; a wrong slug or no --by is refused (D1)', (t) => {
  const { root } = project(t, { approved: false });
  const merged = git(['rev-parse', 'HEAD'], root).trim();
  const bin = tmpPath(t);
  // a spec PR already merged (from GitHub's page): no merge is attempted, only the recording
  write(path.join(bin, 'gh'), `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(JSON.stringify({ number: 7, url: 'https://github.com/o/proj/pull/7', state: 'MERGED', isDraft: false, headRefOid: 'b'.repeat(40), headRefName: 'spec/refund-route', baseRefName: 'main', title: 'spec: refund route', mergeCommit: { oid: ${JSON.stringify(merged)} }, mergedAt: '2026-11-24T10:00:00Z' })); process.exit(0); }
process.stderr.write('fake gh: unexpected ' + a.join(' ')); process.exit(9);
`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  let r = runScript('lane.js', ['merge', 'other', '--repo', root, '--pr', '7', '--by', 'Jonathan'], { env });
  assert.ok(r.returncode === 2 && r.stderr.includes("PR 7 is the spec of 'refund-route', not 'other'"), r.stderr);
  r = runScript('lane.js', ['merge', '--repo', root, '--pr', '7'], { env });
  assert.ok(r.returncode === 2 && r.stderr.includes('--by <name> is required'), r.stderr);
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'session', 'lanes', 'refund-route.json')), 'nothing recorded');
  r = runScript('lane.js', ['merge', '--repo', root, '--pr', '7', '--by', 'Jonathan Robles'], { env });
  assert.equal(r.returncode, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`spec refund-route: approval by Jonathan Robles recorded \\(PR #7, merged as ${merged.slice(0, 7)}\\)`));
  const ap = JSON.parse(read(root, '.claude', 'session', 'lanes', 'refund-route.json')).spec_approval;
  assert.equal(ap.by, 'Jonathan Robles');
  assert.equal(ap.pr, 7);
  assert.equal(ap.commit, merged);
  assert.equal(ap.head, 'b'.repeat(40));
  assert.equal(ap.merged_at, '2026-11-24T10:00:00Z');
  assert.match(ap.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  r = lane('start', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
});

test('a fix lane still opens from its goal alone, without any approval; an older record\'s approval is not carried into it (D1)', (t) => {
  const { root } = project(t);
  fs.mkdirSync(path.join(root, 'docs', 'goals'), { recursive: true });
  write(path.join(root, 'docs', 'goals', 'refund-route.md'), GOAL.replace('- Status: agreed', '- Status: agreed\n- Work type: fix\n- Risk: normal\n- Size: S'));
  fs.rmSync(path.join(root, 'docs', 'specs', 'refund-route.md'));
  commitAll(root, 'a fix goal, no spec');
  const r = lane('start', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
  const rec = JSON.parse(read(root, '.claude', 'session', 'lanes', 'refund-route.json'));
  assert.equal(rec.stage, 'reproduce');
  assert.equal(rec.spec_approval, undefined);
});

test('next step walks the pipeline from facts', (t) => {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root, commit } = project(t, { status: 'waiting-approval', approved: false });
  const stage = () => JSON.parse(lane('next-step', 'refund-route', '--repo', root).stdout);
  // no goal -> start
  const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
  const specText = read(sp);
  fs.unlinkSync(sp);
  assert.equal(stage().stage, 'start');
  fs.mkdirSync(path.join(root, 'docs', 'goals'));
  write(path.join(root, 'docs', 'goals', 'refund-route.md'), GOAL);
  // goal, no research -> research
  assert.equal(stage().stage, 'research');
  lane('index', 'add', 'How does the refund route work?', '--repo', root, '--slug', 'refund-route-shape', '--keywords', 'refund route', '--files', 'src/api/routes.ts', '--commit', commit.slice(0, 7));
  // research, no spec -> plan
  assert.equal(stage().stage, 'plan');
  write(sp, specText);
  // spec waiting -> approve (needs human)
  let ns = stage();
  assert.ok(ns.stage === 'approve' && ns.needs_human);
  write(sp, specText.replaceAll('- Status: waiting-approval', '- Status: approved').replaceAll('Approved by: — on — at —', `Approved by: Jonathan Robles on 2026-11-08 at ${commit.slice(0, 7)}`));
  commitAll(root, 'approve');
  // an approval line written into the spec approves nothing; the owner's recorded merge of the spec PR does (D1)
  assert.equal(stage().stage, 'approve');
  approveSpec(root, 'refund-route');
  assert.equal(stage().stage, 'lane');
  const out = JSON.parse(lane('start', 'refund-route', '--repo', root).stdout);
  const wt = out.worktree;
  // lane, no red runs -> test (tester first)
  assert.equal(stage().stage, 'test');
  const prog = path.join(wt, 'docs/specs/refund-route.progress.md');
  // a cell containing `#` is not a run (#56): it must name a logged run of its own test
  write(path.join(wt, '.claude/session/refund-route.log'), '=== 2026-11-11T10:00:00 test: npm test -> exit 1\n1 failed\n\n=== 2026-11-11T10:05:00 test: npm test -> exit 0\n1 passed\n');
  write(prog, read(prog).replaceAll('| — | — |', '| refund-route.log#1 | refund-route.log#4 |'));
  assert.equal(stage().stage, 'test');
  write(path.join(wt, '.claude/session/refund-route.log'), '=== 2026-11-11T10:00:00 test: npx vitest run -> exit 1\nnot ok 1 - exposes refund\n\n=== 2026-11-11T10:05:00 test: npx vitest run -> exit 0\nok 1 - exposes refund\n');
  write(prog, read(prog).replaceAll('| refund-route.log#1 | refund-route.log#4 |', '| refund-route.log#1 | — |'));
  assert.equal(stage().stage, 'build');
  write(prog, read(prog).replaceAll('| refund-route.log#1 | — |', '| refund-route.log#1 | refund-route.log#4 |'));
  assert.equal(stage().stage, 'review');
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// built\n');
  commitAll(wt, 'D1');
  const head = git(['rev-parse', 'HEAD'], wt).trim();
  write(path.join(wt, 'docs/specs/refund-route.review.md'), review({ head: head.slice(0, 10), verdict: 'PASS' }));
  ns = stage();
  // the fixture's spec is high risk (it touches payment code), and the feature profile adds a human security sign-off
  // for high risk: the stage waits for it and names what it requires (#58)
  assert.ok(ns.stage === 'security-signoff' && ns.needs_human && ns.requires?.includes('security-signoff'), JSON.stringify(ns));
  assert.match(ns.reason, /none is recorded: a named human reviews the lane, then runs kit lane signoff refund-route --by <your name>/);
  // a sign-off written in a file (the lane's lane.json, its progress) counts for nothing; only the store's record does
  const lj = path.join(wt, '.claude', 'lane.json');
  write(lj, JSON.stringify({ ...JSON.parse(read(lj)), security_signoff: { by: 'Jonathan Robles', at: '2026-11-24T10:00:00', commit: head } }, null, 2));
  write(prog, `${read(prog)}\nSecurity sign-off: Jonathan Robles on 2026-11-24 at ${head}\n`);
  assert.equal(stage().stage, 'security-signoff');
  // the human's command records it for the lane's HEAD, and next-step goes on to the merge
  let so = lane('signoff', 'refund-route', '--repo', root, '--by', 'Jonathan Robles');
  assert.equal(so.returncode, 0, so.stderr);
  assert.equal(storeOf(root).security_signoff.commit, head);
  ns = stage();
  assert.equal(ns.stage, 'wait-merge', JSON.stringify(ns));
  // a commit after the sign-off makes it stale: next-step stops at the sign-off again and says why
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// built, then changed\n');
  commitAll(wt, 'D1 again');
  const head2 = git(['rev-parse', 'HEAD'], wt).trim();
  write(path.join(wt, 'docs/specs/refund-route.review.md'), review({ head: head2.slice(0, 10), verdict: 'PASS' }));
  ns = stage();
  assert.equal(ns.stage, 'security-signoff', JSON.stringify(ns));
  assert.match(ns.reason, new RegExp(`the recorded one is stale: Jonathan Robles signed off ${head.slice(0, 7)} at .*, and the lane is now at ${head2.slice(0, 7)}; review the commits since`));
  so = lane('signoff', 'refund-route', '--repo', root, '--by', 'Jonathan Robles');
  assert.equal(so.returncode, 0, so.stderr);
  assert.equal(stage().stage, 'wait-merge');
  commitAll(wt, 'review');
  git(['merge', '-q', '--no-ff', 'wt/refund-route', '-m', 'merge'], root);
  assert.equal(stage().stage, 'retro');
  lane('goal-set', 'refund-route', 'done', '--repo', root);
  assert.equal(stage().stage, 'done');
});

// #58, hardening plan Step 2: a high-risk lane is merged only with a named human's sign-off that lane.js signoff recorded
// in the store for the commit being merged. The PR is read from a fake gh; any call past the sign-off check stops it.
test('lane.js merge of a high-risk lane: refused without a recorded sign-off or with a stale one, accepted with a current one; signoff refuses no name, no commits and a lane that needs none (#58)', (t) => {
  const { root } = project(t);
  const wt = JSON.parse(lane('start', 'refund-route', '--repo', root).stdout).worktree;
  const bin = tmpPath(t);
  const ghAt = (oid) => {
    write(path.join(bin, 'gh'), `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(JSON.stringify({ number: 5, url: 'https://github.com/o/proj/pull/5', state: 'OPEN', isDraft: false, headRefOid: ${JSON.stringify(oid)}, headRefName: 'wt/refund-route', baseRefName: 'main', title: 't' })); process.exit(0); }
process.stderr.write('fake gh: past the sign-off'); process.exit(9);
`);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    return { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
  };
  const merge = (oid) => runScript('lane.js', ['merge', 'refund-route', '--repo', root, '--pr', '5', '--by', 'Jonathan'], ghAt(oid));
  const signoff = (...by) => lane('signoff', 'refund-route', '--repo', root, ...by);
  const refused = (r, re) => {
    assert.equal(r.returncode, 2, r.stdout);
    assert.match(r.stderr, re);
    assert.doesNotMatch(r.stderr, /past the sign-off/);
  };
  // nothing to sign off before the lane has commits; a name is required
  refused(signoff('--by', 'Jonathan'), /wt\/refund-route has no commits of its own, so there is nothing to sign off/);
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// built\n');
  const head1 = commitAll(wt, 'D1');
  refused(signoff(), /--by <name> is required: the human who reviewed the lane and signs it off/);
  refused(signoff('--by', '  '), /--by <name> is required/);
  refused(lane('signoff', 'other', '--repo', root, '--by', 'Jonathan'), /no lane for other/);
  assert.equal(storeOf(root).security_signoff, undefined, 'a refused signoff records nothing');
  // no record: refused, and a sign-off written in the lane's files does not count
  const lj = path.join(wt, '.claude', 'lane.json');
  write(lj, JSON.stringify({ ...JSON.parse(read(lj)), security_signoff: { by: 'Jonathan', at: '2026-11-24T10:00:00', commit: head1 } }, null, 2));
  refused(merge(head1), /refund-route needs a human security sign-off before the merge \(high risk\) and none is recorded: a named human reviews the lane, then runs kit lane signoff refund-route --by <your name>/);
  // the human's sign-off: who, when, the lane's HEAD, in the store; then the merge goes on to GitHub's checks
  const r = signoff('--by', 'Jonathan Robles');
  assert.equal(r.returncode, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`security sign-off by Jonathan Robles recorded for wt/refund-route at ${head1.slice(0, 7)}`));
  const so = storeOf(root).security_signoff;
  assert.deepEqual({ by: so.by, commit: so.commit, branch: so.branch }, { by: 'Jonathan Robles', commit: head1, branch: 'wt/refund-route' });
  assert.match(so.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  assert.equal(storeOf(root).stage, 'build', 'the sign-off moves no stage');
  let m = merge(head1);
  assert.doesNotMatch(m.stderr, /security sign-off/);
  assert.match(m.stderr, /fake gh: past the sign-off/);
  // the PR's head is not the signed commit (a push after the sign-off): refused as stale
  refused(merge('f'.repeat(40)), new RegExp(`and the recorded one is stale: Jonathan Robles signed off ${head1.slice(0, 7)} at .*, and the lane is now at fffffff; review the commits since, push them if the PR lacks them, then run kit lane signoff refund-route --by <your name> again`));
  // a new local commit on the lane, even one the PR does not have yet: refused as stale
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// built, then changed\n');
  const head2 = commitAll(wt, 'D2');
  refused(merge(head1), new RegExp(`the recorded one is stale: .* the lane is now at ${head2.slice(0, 7)}`));
  // signed off again at the new HEAD: accepted
  assert.equal(signoff('--by', 'Jonathan Robles').returncode, 0);
  m = merge(head2);
  assert.match(m.stderr, /fake gh: past the sign-off/);
  // a lane whose profile asks for no sign-off: signoff refuses, says how to merge, and records nothing new
  fs.mkdirSync(path.join(root, 'docs', 'goals'), { recursive: true });
  write(path.join(root, 'docs', 'goals', 'refund-route.md'), GOAL.replace('- Status: agreed', '- Status: running\n- Work type: refactor\n- Risk: high'));
  refused(signoff('--by', 'Jonathan'), /refund-route does not need a security sign-off \(risk high, work type refactor\); nothing is recorded\. Merge it with kit lane merge refund-route --by <your name>/);
  assert.equal(storeOf(root).security_signoff.commit, head2);
});

test('next in queue respects goal and wip', (t) => {
  const { root } = project(t, { wipLimit: 1 });
  const rm = path.join(root, 'ROADMAP.md');
  write(rm, read(rm).replaceAll('1. TODO(bootstrap: ROADMAP.md — slug)', '1. other\n2. refund-route'));
  let r = lane('next', '--repo', root);
  assert.ok(r.returncode === 2 && JSON.parse(r.stdout).reason.includes('no item with an agreed goal'));
  fs.mkdirSync(path.join(root, 'docs', 'goals'));
  write(path.join(root, 'docs', 'goals', 'other.md'), GOAL.replaceAll('refund-route', 'other'));
  write(rm, read(rm).replaceAll('| Other | other | M1 | queued |', '| Other | other | M1 | queued |'));
  r = lane('next', '--repo', root);
  assert.ok(r.returncode === 0 && JSON.parse(r.stdout).slug === 'other');
  // taking the limit means a live lane, not a ROADMAP word; refund-route is the one with an approved spec
  assert.equal(lane('start', 'refund-route', '--repo', root).returncode, 0);
  r = lane('next', '--repo', root);
  assert.ok(r.returncode === 2 && JSON.parse(r.stdout).reason.includes('WIP 1/1'), r.stdout);
});

test('lane.js template prints a kit template with slug, date and commit; agents never read ~/.claude/kit/templates', (t) => {
  const { root } = project(t);
  const head = git(['rev-parse', '--short', 'HEAD'], root).trim();
  // lane.js dates a template in local time (todayIso), not UTC: between local and UTC midnight the two differ
  const d = new Date();
  const today = `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let r = runScript('lane.js', ['template', 'spec', '--slug', 'refund-route', '--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  assert.match(r.stdout, /^# Spec: \{\{feature\}\}/);
  assert.match(r.stdout, /^- Slug: refund-route$/m);
  assert.match(r.stdout, new RegExp(`^- Date: ${today}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^- Commit: ${head}$`, 'm'));
  // every template an agent fills is served, from the kit's own copy, with no {{slug}}/{{date}} left
  for (const name of ['goal', 'spec', 'research', 'review', 'lesson']) {
    r = runScript('lane.js', ['template', name, '--slug', 'refund-route', '--repo', root]);
    assert.equal(r.returncode, 0, `${name}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout.split('\n').filter((l) => !/\bby:/i.test(l)).join('\n'), /\{\{(slug|date)\}\}/, name);
  }
  // only header lines are filled: the agreement line keeps its placeholders for the person deciding, and the spec's
  // approval line asks nobody to fill it (kit lane merge records the owner's yes, hardening plan D1)
  r = runScript('lane.js', ['template', 'spec', '--slug', 'refund-route', '--repo', root]);
  assert.match(r.stdout, /^Approved by: — \(recorded by kit lane merge when the owner merges the spec PR\)$/m);
  r = runScript('lane.js', ['template', 'goal', '--slug', 'refund-route', '--repo', root]);
  assert.match(r.stdout, /^- Agreed by: \{\{human name\}\} and Claude on \{\{date\}\}$/m);
  assert.match(r.stdout, new RegExp(`^- Date: ${today}$`, 'm'));
  r = runScript('lane.js', ['template', 'lesson', '--repo', root]);
  assert.match(r.stdout, new RegExp(`^## ${today} — \\{\\{feature\\}\\}`));
  // an unknown template and a slug that is not kebab-case are refused
  r = runScript('lane.js', ['template', 'progress', '--repo', root]);
  assert.equal(r.returncode, 2);
  assert.match(r.stderr, /unknown template 'progress'/);
  r = runScript('lane.js', ['template', 'spec', '--slug', '../etc', '--repo', root]);
  assert.equal(r.returncode, 2);
  assert.match(r.stderr, /not kebab-case/);
  // the agents and skills get templates from lane.js: ~/.claude/kit/templates is outside the project, so an unattended
  // session cannot read it (eval evidence 2026-11-22)
  const kit = path.resolve(import.meta.dirname, '..', '..');
  const readers = [];
  for (const dir of ['agents', 'skills']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md') && /\.claude\/kit\/templates\//.test(fs.readFileSync(p, 'utf8'))) readers.push(path.relative(kit, p));
      }
    };
    walk(path.join(kit, dir));
  }
  assert.deepEqual(readers, []);
});

test('the permission probe has a case for every rule the kit ships, plus controls that must stay refused (#63, hardening plan Step 2)', async () => {
  const SB = await import('../sandbox.js');
  const perms = JSON.parse(fs.readFileSync(P.FRAGMENT, 'utf8')).permissions;
  const floor = JSON.parse(fs.readFileSync(path.join(path.dirname(P.FRAGMENT), '..', 'security', 'floor.json'), 'utf8')).deny;
  const grants = SB.laneGrants();
  const rulesOf = (kind) => [...new Set(P.CASES.filter((c) => c.kind === kind).map((c) => c.rule))].sort();
  // every allow rule is proved approved; every ask rule refused although Bash(kit *) is added to allow (ask beats allow)
  assert.deepEqual(rulesOf('allow'), [...perms.allow].sort());
  assert.deepEqual(rulesOf('ask'), [...perms.ask].sort());
  assert.ok(P.CASES.filter((c) => c.kind === 'ask').every((c) => c.broad?.includes('Bash(kit *)')));
  // every floor rule about reviews, merges, protection and rulesets is proved refused, although Bash(gh *) is allowed and
  // without the guard, so the rule itself refused it
  const gh = floor.filter((r) => r.startsWith('Bash(gh '));
  assert.ok(gh.length >= 10, gh.join(', '));
  assert.deepEqual(rulesOf('deny'), [...gh].sort());
  assert.ok(P.CASES.filter((c) => c.kind === 'deny').every((c) => c.noGuard && c.broad?.includes('Bash(gh *)')));
  // a lane: every per-run deny is proved over the project's allow rules (trusted, plus Bash(kit *)), and every per-run
  // allow rule approved through --settings in a repository that is not trusted
  assert.deepEqual(rulesOf('lane-deny'), [...grants.deny].sort());
  assert.ok(P.CASES.filter((c) => c.kind === 'lane-deny').every((c) => c.via === 'lane' && c.broad?.includes('Bash(kit *)')));
  // and in a skill that grants plain Bash, as /zi-run does in a launched lane
  assert.ok(P.CASES.some((c) => c.kind === 'lane-deny-skill' && c.via === 'lane' && c.ask.startsWith('/') && c.command.startsWith('kit lane advance')));
  const run = SB.runSettings({ root: os.tmpdir(), wt: '/w', grants, floor: [] }).permissions.allow.map((r) => (r === 'Edit(//w/**)' ? P.WORKTREE_EDIT : r));
  assert.deepEqual(rulesOf('lane-allow'), [...new Set(run)].sort());
  assert.ok(P.CASES.filter((c) => c.kind === 'lane-allow').every((c) => c.via === 'flag'));
  assert.ok(P.CASES.every((c) => (['allow', 'allow-form', 'lane-allow'].includes(c.kind) ? c.expect === 'approved' : c.expect === 'denied')), 'allow cases expect approved, all others denied');
  assert.equal(new Set(P.CASES.map((c) => c.id)).size, P.CASES.length, 'case ids are unique (--only picks by id)');
  // the xargs form, which Claude Code checks as `kit lane`, is probed against the real guard
  assert.ok(P.CASES.some((c) => c.kind === 'guard' && /xargs kit lane/.test(c.command)));
  // merging stays the human's: an ask rule covers it, no allow rule approves it, and a skill granting plain Bash is probed
  assert.ok(perms.ask.includes('Bash(kit lane merge *)') && !perms.allow.includes('Bash(kit *)'));
  assert.ok(P.CASES.some((c) => c.kind === 'ask-skill' && c.command.startsWith('kit lane merge')));
  // the skills' `--repo .` form is probed as approved; "$PWD" in the arguments is a control (not approved, 2026-11-25)
  assert.ok(P.CASES.some((c) => c.kind === 'allow-form' && c.command === 'kit lane wip --repo .'));
  assert.ok(P.CASES.some((c) => c.kind === 'control' && c.command.includes('"$PWD"') && c.expect === 'denied'));
  // a security sign-off is the human's too (#58): Claude Code asks every time, and the probe proves the rule matches
  assert.ok(perms.ask.includes('Bash(kit lane signoff *)'));
  assert.ok(P.CASES.some((c) => c.kind === 'ask' && c.rule === 'Bash(kit lane signoff *)' && c.command.startsWith('kit lane signoff ')));
  // the "$HOME" form Claude Code did not approve (2026-11-22) is a control, and no shipped rule uses it again; another
  // tool called kit stays refused
  assert.ok(P.CASES.some((c) => c.id === 'home-form' && c.expect === 'denied'));
  assert.ok(P.CASES.some((c) => c.id === 'other-kit' && c.command.startsWith('kit pack') && c.expect === 'denied'));
  for (const r of [...perms.allow, ...grants.deny, ...Object.values(grants.roles).flat(), ...grants.session]) assert.ok(!/\$|"/.test(r), `a shipped rule relies on a $variable or quotes: ${r}`);
});

test('the probe runs each case with the rules its via names: project (trusted), lane (trusted plus --settings), flag (--settings only)', (t) => {
  // a stand-in claude reports its arguments, the project settings, the per-run settings and whether the repo is trusted
  const bin = path.join(tmpPath(t), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const out = path.join(tmpPath(t), 'seen.jsonl');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), i = a.indexOf('--settings');
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'));
fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: a, project: JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8')), run: i >= 0 ? JSON.parse(fs.readFileSync(a[i + 1], 'utf8')) : null, trusted: Object.keys(cfg.projects ?? {}).length > 0, gh: process.env.GH_TOKEN ?? null }) + '\\n');
process.stdout.write(JSON.stringify({ result: 'stub', permission_denials: [] }));
`, { mode: 0o755 });
  setEnv(t, 'PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  setEnv(t, 'GH_TOKEN', 'probe-must-not-see-this');
  const tmp = tmpPath(t);
  const byId = (id) => P.CASES.find((c) => c.id === id);
  for (const id of ['merge-asks', 'gh-pr-merge', 'lane-kit-lane-advance', 'lane-kit-lane-check']) assert.equal(P.runCase(byId(id), tmp).got, 'inconclusive', id);
  const [ask, gh, laneDeny, laneAllow] = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(ask.trusted && ask.run === null && ask.project.permissions.allow.includes('Bash(kit *)') && ask.project.hooks.PreToolUse.length === 1);
  assert.ok(gh.trusted && gh.project.permissions.allow.includes('Bash(gh *)') && gh.project.hooks.PreToolUse.length === 0, 'a floor case runs without the guard');
  assert.ok(laneDeny.trusted && laneDeny.run.permissions.deny.includes('Bash(kit lane advance *)') && laneDeny.project.permissions.allow.includes('Bash(kit lane advance *)'));
  assert.ok(!laneAllow.trusted && laneAllow.run.permissions.allow.includes('Bash(kit lane check *)') && !('allow' in laneAllow.project.permissions), 'untrusted, and no project allow rule');
  assert.ok([ask, gh, laneDeny, laneAllow].every((s) => s.gh === null), 'no GitHub token reaches a probe session');
});

// The whole lane, as the agents run it, with the fixture's real vitest and no --reporter flag: the tester runs the
// test file, the implementer's hook runs the affected tests, then the suite. Nothing may be refused (hardening plan
// Step 2: a correct lane is never blocked by advance).
test('end to end: a fix lane goes start → scope → test → build → review → merged → retro with the agents\' own commands', (t) => {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const SETUP = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'eval', 'setups', 'truncate-text');
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  const kj = path.join(root, '.claude', 'kit.json');
  write(kj, JSON.stringify({ ...JSON.parse(read(kj)), local_only: true }, null, 2));
  fs.mkdirSync(path.join(root, 'src', 'text'), { recursive: true });
  fs.copyFileSync(path.join(SETUP, 'format.ts'), path.join(root, 'src', 'text', 'format.ts'));
  fs.copyFileSync(path.join(SETUP, 'format.test.ts'), path.join(root, 'tests', 'format.test.ts'));
  const rm = path.join(root, 'ROADMAP.md');
  write(rm, read(rm).replaceAll('| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |', '| Truncate text | truncate-text | M1 | queued | — | — | — |'));
  fs.mkdirSync(path.join(root, 'docs', 'goals'), { recursive: true });
  write(path.join(root, 'docs', 'goals', 'truncate-text.md'), GOAL.replaceAll('refund-route', 'truncate-text').replace('- Status: agreed', '- Status: agreed\n- Work type: fix\n- Risk: normal\n- Size: S'));
  const head = commitAll(root, 'truncate-text goal');
  const ci = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: root, encoding: 'utf8' });
  if (ci.status !== 0) return t.skip(`npm ci could not install the fixture's dependencies: ${(ci.stderr || '').trim().split('\n').pop()}`);
  const ok = (r, what) => assert.equal(r.returncode, 0, `${what}: ${r.stderr}`);
  const next = () => JSON.parse(lane('next-step', 'truncate-text', '--repo', root).stdout);
  const start = lane('start', 'truncate-text', '--repo', root);
  ok(start, 'start');
  const wt = JSON.parse(start.stdout).worktree;
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(wt, 'node_modules'));
  assert.equal(next().stage, 'reproduce');
  // the debugger's cause, then the planner's spec, approved by the human
  const prog = path.join(wt, 'docs/specs/truncate-text.progress.md');
  write(prog, read(prog).replace('## Current step', 'cause: truncate does not exist yet\n\n## Current step'));
  const specText = read(path.join(SETUP, 'spec.approved.md')).replaceAll('{{eval:head}}', head.slice(0, 7));
  write(path.join(wt, 'docs/specs/truncate-text.md'), specText);
  // the spec says approved and carries a name, but counts only once the owner merged its spec/<slug> PR (D1)
  assert.equal(next().stage, 'approve');
  const early = lane('scope', 'truncate-text', '--repo', root);
  assert.ok(early.returncode === 2 && early.stderr.includes('no recorded approval for truncate-text'), early.stderr);
  // the spec PR, merged by the owner with kit lane merge: the same file on main, and the recorded yes
  write(path.join(root, 'docs/specs/truncate-text.md'), specText);
  approveSpec(root, 'truncate-text', { commit: commitAll(root, 'spec: truncate-text (#2)'), pr: 2 });
  assert.equal(next().stage, 'scope');
  ok(lane('scope', 'truncate-text', '--repo', root), 'scope');
  // tester: writes the test and runs the test file
  assert.equal(next().stage, 'test');
  ok(lane('advance', 'truncate-text', 'test', '--repo', root), 'advance test');
  fs.copyFileSync(path.join(SETUP, 'truncate.test.ts'), path.join(wt, 'tests', 'truncate.test.ts'));
  const red = JSON.parse(lane('check', 'truncate-text', 'D1', '--repo', root, '--', 'npx vitest run tests/truncate.test.ts').stdout);
  assert.notEqual(red.exit, 0, 'the red run fails');
  write(prog, read(prog).replace(/(\| D1 \|[^\n]*\|) — \| — \|/, `$1 ${red.ref} | — |`));
  // implementer: the post-edit hook runs the affected tests, then the suite once more
  assert.equal(next().stage, 'build');
  ok(lane('advance', 'truncate-text', 'build', '--repo', root), 'advance build');
  fs.copyFileSync(path.join(SETUP, 'format.done.ts'), path.join(wt, 'src', 'text', 'format.ts'));
  const green = JSON.parse(lane('check', 'truncate-text', 'D1', '--repo', root, '--', 'npx vitest run --changed HEAD').stdout);
  assert.equal(green.exit, 0, 'the green run passes');
  write(prog, read(prog).replace(/\| — \|\s*$/m, `| ${green.ref} |`));
  commitAll(wt, 'truncate-text: D1');
  assert.equal(JSON.parse(lane('check', 'truncate-text', 'suite', '--repo', root, '--', 'npx vitest run').stdout).exit, 0);
  // reviewer
  assert.equal(next().stage, 'review');
  ok(lane('advance', 'truncate-text', 'review', '--repo', root), 'advance review');
  ok(lane('evidence', 'truncate-text', '--repo', root), 'evidence');
  commitAll(wt, 'truncate-text: evidence');
  // the human merges; the retro starts
  git(['merge', '-q', '--no-ff', 'wt/truncate-text', '-m', 'merge'], root);
  ok(lane('merged', 'truncate-text', '--repo', root), 'merged');
  assert.deepEqual(JSON.parse(read(root, '.claude', 'session', 'lanes', 'truncate-text.json')).moves.map((m) => m.to), ['reproduce', 'test', 'test', 'build', 'review', 'retro']);
});
