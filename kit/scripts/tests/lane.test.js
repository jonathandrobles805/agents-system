import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, commitAll } from './fixtures.js';
import { runScript, setEnv, tmpPath } from './helpers.js';
import { project, spec, review } from './testdata.js';
import * as P from '../permission_probe.js';

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
  assert.ok(r.returncode === 2 && r.stderr.includes('approval line') && r.stderr.includes("needs 'approved'"));
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
  commitAll(wt, 'review');
  git(['merge', '-q', '--no-ff', 'wt/refund-route', '-m', 'merge'], root);
  assert.equal(stage().stage, 'retro');
  lane('goal-set', 'refund-route', 'done', '--repo', root);
  assert.equal(stage().stage, 'done');
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
  // only header lines are filled: the approval and agreement lines keep their placeholders for the person deciding
  r = runScript('lane.js', ['template', 'spec', '--slug', 'refund-route', '--repo', root]);
  assert.match(r.stdout, /^Approved by: \{\{name\}\} on \{\{date\}\} at \{\{commit\}\}$/m);
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

test('the permission probe has a case for every allow rule the kit ships, plus controls that must stay refused (#63)', () => {
  const perms = JSON.parse(fs.readFileSync(P.FRAGMENT, 'utf8')).permissions;
  const shipped = perms.allow;
  const caseFor = (kind) => P.CASES.filter((c) => c.kind === kind).map((c) => c.rule).sort();
  // every allow rule is proved approved; every ask rule is proved refused
  assert.deepEqual(caseFor('allow'), [...perms.allow].sort());
  assert.deepEqual(caseFor('ask'), [...perms.ask].sort());
  assert.ok(P.CASES.every((c) => (c.kind === 'allow' ? c.expect === 'approved' : c.expect === 'denied')), 'allow cases expect approved, all others denied');
  // the xargs form, which Claude Code checks as `kit lane`, is probed against the real guard
  assert.ok(P.CASES.some((c) => c.kind === 'guard' && /xargs kit lane/.test(c.command)));
  // merging stays the human's: an ask rule covers it, it beats Bash(kit *), and a skill granting plain Bash is probed too
  assert.ok(perms.ask.includes('Bash(kit lane merge *)') && perms.allow.includes('Bash(kit *)'));
  assert.ok(P.CASES.some((c) => c.kind === 'ask-skill' && c.command.startsWith('kit lane merge')));
  // the "$HOME" form Claude Code did not approve (2026-11-22) is a control, and no shipped rule uses it again
  assert.ok(P.CASES.some((c) => c.id === 'home-form' && c.expect === 'denied'));
  assert.ok(shipped.every((r) => !/\$|"/.test(r)), `a shipped rule relies on a $variable or quotes: ${shipped.join(', ')}`);
});
