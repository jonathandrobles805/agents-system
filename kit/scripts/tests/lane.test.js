import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, commitAll } from './fixtures.js';
import { runScript, setEnv } from './helpers.js';
import { project, spec, review } from './testdata.js';

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
  assert.equal(lane('stage', 'refund-route', 'review', '--repo', root).returncode, 0);
  assert.equal(JSON.parse(read(wt, '.claude', 'lane.json')).stage, 'review');
  const r = lane('finish', 'refund-route', '--repo', root);
  assert.equal(r.returncode, 0, r.stderr);
  assert.ok(!fs.existsSync(wt));
  assert.ok(!git(['branch'], root).includes('wt/refund-route'));
  assert.ok(read(root, 'ROADMAP.md').includes('| Refund route | refund-route | M1 | merged |'));
  assert.ok(!('refund-route' in JSON.parse(read(root, '.claude', 'kit.json')).lanes));
});

test('#41 a raised review budget survives lane.js stage review', (t) => {
  // A human raised the review budget to 400/4h; the next lane.js stage review put it back to the default and the
  // budget hook stopped the lane again at 250 calls. A raise recorded in budget_override.<stage> outlives the stage change.
  const { root } = project(t);
  const wt = JSON.parse(lane('start', 'refund-route', '--repo', root).stdout).worktree;
  const lf = path.join(wt, '.claude', 'lane.json');
  const d = JSON.parse(fs.readFileSync(lf, 'utf8'));
  d.budget_override = { review: { tool_calls: 400, hours: 4 } };
  fs.writeFileSync(lf, JSON.stringify(d, null, 2));
  assert.equal(lane('stage', 'refund-route', 'review', '--repo', root).returncode, 0);
  const after = JSON.parse(fs.readFileSync(lf, 'utf8'));
  assert.equal(after.stage, 'review');
  assert.equal(after.budget.tool_calls, 400, JSON.stringify(after.budget));
  assert.equal(after.budget.hours, 4, JSON.stringify(after.budget));
  assert.deepEqual(after.budget_override, { review: { tool_calls: 400, hours: 4 } }, 'the override itself is kept');
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
  // and /status reports the same number, because it calls the same function
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
  write(path.join(wt, '.claude/session/refund-route.log'), '=== 2026-11-11T10:00:00 test: npm test -> exit 1\n1 failed\n\n=== 2026-11-11T10:05:00 test: npm test -> exit 0\n1 passed\n');
  write(prog, read(prog).replaceAll('| — | — |', '| refund-route.log#1 | — |'));
  assert.equal(stage().stage, 'build');
  write(prog, read(prog).replaceAll('| refund-route.log#1 | — |', '| refund-route.log#1 | refund-route.log#4 |'));
  assert.equal(stage().stage, 'review');
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// built\n');
  commitAll(wt, 'D1');
  const head = git(['rev-parse', 'HEAD'], wt).trim();
  write(path.join(wt, 'docs/specs/refund-route.review.md'), review({ head: head.slice(0, 10), verdict: 'PASS' }));
  ns = stage();
  assert.ok(ns.stage === 'wait-merge' && ns.needs_human);
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
