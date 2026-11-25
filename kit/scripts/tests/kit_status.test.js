import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, commitAll, approveSpec } from './fixtures.js';
import { runScript } from './helpers.js';
import { project, review } from './testdata.js';

const ENV = { ...process.env, KIT_STATUS_NO_GH: '1' };

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, text) => fs.writeFileSync(p, text);

function status(root) {
  const r = runScript('kit_status.js', ['--repo', root, '--json'], { env: ENV });
  assert.equal(r.returncode, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const laneOf = (s, slug) => s.lanes.find((l) => l.slug === slug);

test('positions follow files not claims', (t) => {
  const { root, commit } = project(t, { status: 'waiting-approval', approved: false });
  let s = status(root);
  let l = laneOf(s, 'refund-route');
  assert.ok(l.position === 'waiting-approval' && l.needs_you === true);
  assert.equal(laneOf(s, 'other').position, 'queued');
  assert.equal(s.needs_you[0].slug, 'refund-route');

  // approve: still no worktree -> approved
  const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
  write(sp, read(sp).replaceAll('- Status: waiting-approval', '- Status: approved').replaceAll('Approved by: — on — at —', `Approved by: Jonathan Robles on 2026-11-08 at ${commit.slice(0, 7)}`));
  commitAll(root, 'approve');
  // a filled approval line approves nothing: only the owner's merge of the spec PR, recorded by kit lane merge (D1)
  assert.equal(laneOf(status(root), 'refund-route').position, 'waiting-approval');
  approveSpec(root, 'refund-route');
  assert.equal(laneOf(status(root), 'refund-route').position, 'approved');

  // start lane -> building, derived from the worktree + lane.json
  const out = JSON.parse(runScript('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  const wt = out.worktree;
  s = status(root);
  l = laneOf(s, 'refund-route');
  assert.ok(l.position === 'building' && l.worktree === wt && l.behind_base === 0 && l.progress.criteria === 1);
  assert.equal(s.wip.in_flight, 1);

  // events + a red test run show up without any agent writing a summary
  write(path.join(wt, 'docs/specs/refund-route.events.jsonl'),
    '{"ts":"2026-11-08T16:00:00","event":"blocked","tool":"Edit","path":"src/x.ts","result":"blocked"}\n' +
    '{"ts":"2026-11-08T16:00:05","event":"test","result":"fail","summary":"1 failed, 2 passed","ref":"refund-route.log#1"}\n');
  l = laneOf(status(root), 'refund-route');
  assert.ok(l.events.blocked === 1 && l.last_check.result === 'fail' && l.last_check.summary.includes('1 failed'));

  // escalation in progress.md -> escalated, needs you
  const prog = path.join(wt, 'docs/specs/refund-route.progress.md');
  write(prog, read(prog).replaceAll('- Attempts: {{n}} of 3', '- Attempts: 3 of 3').replaceAll('- Failure: {{what fails}}', '- Failure: routes.test.ts keeps failing: mock never called'));
  s = status(root);
  l = laneOf(s, 'refund-route');
  assert.ok(l.position === 'escalated' && l.needs_you && s.needs_you[0].failure.includes('mock never called'));

  // clear escalation, add a passing review for the lane HEAD -> ready-to-merge
  write(prog, read(prog).replaceAll('- Attempts: 3 of 3', '- Attempts: {{n}} of 3').replaceAll('- Failure: routes.test.ts keeps failing: mock never called', '- Failure: {{what fails}}'));
  const head = git(['rev-parse', 'HEAD'], wt).trim();
  write(path.join(wt, 'docs/specs/refund-route.review.md'), review({ head: head.slice(0, 10), verdict: 'PASS' }));
  l = laneOf(status(root), 'refund-route');
  assert.ok(l.position === 'ready-to-merge' && l.review.valid && l.review.head_matches);

  // a commit after the review drops it back to in-review
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// late change\n');
  commitAll(wt, 'late');
  l = laneOf(status(root), 'refund-route');
  assert.ok(l.position === 'in-review' && l.review.head_matches === false && l.ahead_base === 1);

  // merged in ROADMAP wins
  runScript('lane.js', ['finish', 'refund-route', '--repo', root]);
  assert.equal(laneOf(status(root), 'refund-route').position, 'merged');
});

test('debt and research summary', (t) => {
  const { root, commit } = project(t);
  write(path.join(root, 'LESSONS.md'), '# Lessons\n\n## Debt\n\n- webhook handlers must be idempotent (text-only)\n- never log card numbers (text-only)\n');
  runScript('lane.js', ['index', 'add', 'q1', '--repo', root, '--slug', 'q1', '--keywords', 'a b', '--files', 'src/domain/payment.ts', '--commit', commit.slice(0, 7)]);
  write(path.join(root, 'src', 'domain', 'payment.ts'), '//\n');
  commitAll(root, 'chg');
  const s = status(root);
  assert.ok(s.debt.text_only_lessons === 2 && s.debt.bootstrap_todos > 0);
  assert.deepEqual(s.research, { questions: 1, current: 1, stale: 1 });
});

test('render text', (t) => {
  const { root } = project(t);
  const r = runScript('kit_status.js', ['--repo', root], { env: ENV });
  // refund-route is approved, not queued
  assert.ok(r.returncode === 0 && r.stdout.includes('needs you:') && !r.stdout.includes('queued: refund-route, other'));
  assert.ok(r.stdout.includes('refund-route: approved'));
});

test('merged is derived from git even if roadmap not updated', (t) => {
  const { root } = project(t);
  const out = JSON.parse(runScript('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  const wt = out.worktree;
  write(path.join(wt, 'src', 'api', 'routes.ts'), '// done\n');
  commitAll(wt, 'work');
  // lane.js merged refuses before the merge
  let r = runScript('lane.js', ['merged', 'refund-route', '--repo', root]);
  assert.ok(r.returncode === 2 && r.stderr.includes('not merged'));
  // merge into main without touching ROADMAP or running retro
  git(['merge', '-q', '--no-ff', 'wt/refund-route', '-m', 'merge'], root);
  const s = status(root);
  assert.equal(laneOf(s, 'refund-route').position, 'merged');
  assert.ok(read(root, 'ROADMAP.md').includes('| refund-route | M1 | building |')); // roadmap still stale: git wins
  r = runScript('lane.js', ['merged', 'refund-route', '--repo', root, '--pr', 'https://x/pr/1']);
  assert.equal(r.returncode, 0);
  assert.ok(read(root, 'ROADMAP.md').includes('| refund-route | M1 | merged | — | — | https://x/pr/1 |'));
});
