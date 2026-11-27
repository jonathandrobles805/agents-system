// Is a lane merged? (#67, #82) GitHub squash-merges (lane.js merge does), so the lane tip is never an ancestor of main.
// lane.js laneMerge is the one answer for lane.js merged and advance, kit_status, next-step and the dashboard. Every
// case below is real git in a temporary repository; GitHub is a fake gh on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as L from '../lane.js';
import * as G from '../pr_gate.js';
import { git, commitAll, gatePass } from './fixtures.js';
import { runScript, setEnv, tmpPath } from './helpers.js';
import { project } from './testdata.js';

const SLUG = 'refund-route';
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

/** A project with a started lane holding `n` commits of its own, and main moved on by one unrelated commit. */
function laneWith(t, n = 1, { mainMoves = true } = {}) {
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root } = project(t);
  const r = runScript('lane.js', ['start', SLUG, '--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  const wt = JSON.parse(r.stdout).worktree;
  for (let i = 1; i <= n; i++) {
    write(path.join(wt, 'src', 'api', 'routes.ts'), `${read(wt, 'src', 'api', 'routes.ts')}// lane change ${i}\n`);
    commitAll(wt, `lane ${i}`);
  }
  if (mainMoves) {
    write(path.join(root, 'docs', 'unrelated.md'), '# Unrelated\n\nA change on main while the lane ran.\n');
    commitAll(root, 'main moves on');
  }
  return { root, wt, tip: git(['rev-parse', `wt/${SLUG}`], root).trim() };
}

const squash = (root) => {
  git(['merge', '-q', '--squash', `wt/${SLUG}`], root);
  git(['commit', '-q', '-m', `${SLUG} (#9)`], root);
};
const merged = (root) => L.laneMerge(root, SLUG);
const position = (root) => JSON.parse(runScript('kit_status.js', ['--repo', root, '--json']).stdout).lanes.find((l) => l.slug === SLUG).position;

test('a single-commit squash merge is merged (squash), and kit_status and next-step agree', (t) => {
  const { root } = laneWith(t, 1);
  assert.equal(merged(root).merged, false);
  assert.equal(position(root), 'building');
  squash(root);
  const m = merged(root);
  assert.deepEqual([m.merged, m.how, m.commit], [true, 'squash', git(['rev-parse', 'HEAD'], root).trim()]);
  assert.equal(position(root), 'merged');
  assert.equal(L.notMerged(root, SLUG), null);
  write(path.join(root, 'docs', 'goals', `${SLUG}.md`), '# Goal: refund route\n\n- Status: running\n- Agreed by: Jonathan Robles on 2026-11-23\n- Work type: feature\n- Size: S\n\n## Outcome\n\nA refund route.\n');
  assert.equal(JSON.parse(runScript('lane.js', ['next-step', SLUG, '--repo', root]).stdout).stage, 'retro');
});

test('a multi-commit squash merge is merged: git cherry misses it, the whole-diff patch-id does not', (t) => {
  const { root } = laneWith(t, 3);
  squash(root);
  // what git itself says: every lane commit is still "+" (not in main), because cherry compares commit by commit
  assert.ok(git(['cherry', 'main', `wt/${SLUG}`], root).trim().split('\n').every((l) => l.startsWith('+ ')));
  assert.equal(merged(root).how, 'squash');
});

test('a regular merge and a fast-forward are merged (ancestor)', (t) => {
  let { root } = laneWith(t, 2);
  git(['merge', '-q', '--no-ff', `wt/${SLUG}`, '-m', 'merge'], root);
  assert.equal(merged(root).how, 'ancestor');
  ({ root } = laneWith(t, 1, { mainMoves: false }));
  git(['merge', '-q', '--ff-only', `wt/${SLUG}`], root);
  assert.equal(merged(root).how, 'ancestor');
});

test('a rebase merge is merged (rebase), also when the lane synced main with a merge commit', (t) => {
  const { root, wt } = laneWith(t, 1);
  git(['merge', '-q', '--no-ff', 'main', '-m', 'sync main'], wt);
  write(path.join(wt, 'src', 'api', 'refund.ts'), 'export const refund = 1;\n');
  commitAll(wt, 'lane 2');
  write(path.join(root, 'docs', 'other.md'), '# Other\n\nmain again.\n');
  commitAll(root, 'main again');
  // GitHub's rebase merge: the lane's commits replayed on main, new shas, merges dropped
  git(['checkout', '-q', '-b', 'replay', `wt/${SLUG}`], root);
  git(['rebase', '-q', 'main'], root);
  git(['checkout', '-q', 'main'], root);
  git(['merge', '-q', '--ff-only', 'replay'], root);
  git(['branch', '-q', '-D', 'replay'], root);
  assert.notEqual(spawnSync('git', ['merge-base', '--is-ancestor', `wt/${SLUG}`, 'main'], { cwd: root }).status, 0, 'not an ancestor');
  assert.equal(merged(root).how, 'rebase');
});

test('never merged when it is not: unmerged, no own commits, a different change to the same file, or a lane that moved on after its squash', (t) => {
  // unmerged, main moved
  let { root, wt } = laneWith(t, 2);
  let m = merged(root);
  assert.ok(!m.merged && m.why.includes('not merged into main yet'), m.why);
  assert.equal(position(root), 'building');
  // main got another change to the same file (and the same line count): no patch matches
  write(path.join(root, 'src', 'api', 'routes.ts'), `${read(root, 'src', 'api', 'routes.ts')}// lane change 9\n`);
  commitAll(root, 'similar but not the lane');
  assert.equal(merged(root).merged, false);
  // a lane with no commits of its own, even though its tip is in main (field test #38)
  ({ root } = laneWith(t, 0, { mainMoves: true }));
  m = merged(root);
  assert.ok(!m.merged && m.why.includes('no commits of its own'), m.why);
  // squashed, then the lane went on: its new commit is not in main
  ({ root, wt } = laneWith(t, 1));
  squash(root);
  write(path.join(wt, 'src', 'api', 'late.ts'), 'export const late = 1;\n');
  commitAll(wt, 'after the merge');
  assert.equal(merged(root).merged, false);
  assert.equal(position(root), 'building');
});

test('a squash that main later reverted stays merged: the lane was merged; undoing it is new work', (t) => {
  const { root } = laneWith(t, 2);
  squash(root);
  git(['revert', '--no-edit', 'HEAD'], root);
  // the content is gone from main's tree, but the squash commit is in its history
  assert.notEqual(git(['merge-tree', '--write-tree', 'main', `wt/${SLUG}`], root).trim().split('\n')[0], git(['rev-parse', 'main^{tree}'], root).trim());
  assert.equal(merged(root).how, 'squash');
  assert.equal(position(root), 'merged');
});

test('lane.js merged after a squash, offline: no gh at all, and a gh that cannot reach GitHub', (t) => {
  const { root, wt } = laneWith(t, 2);
  const offline = fakeGh(t, { fail: 'error connecting to api.github.com' });
  // before the merge: refused, with git's reason and GitHub's
  let r = runScript('lane.js', ['merged', SLUG, '--repo', root, '--pr', '9'], { env: offline.env });
  assert.ok(r.returncode === 2 && r.stderr.includes('not merged into main yet') && r.stderr.includes('GitHub could not be read'), r.stderr);
  squash(root);
  r = runScript('lane.js', ['merged', SLUG, '--repo', root], { env: noGh(t) });
  assert.equal(r.returncode, 0, r.stderr);
  assert.ok(read(root, 'ROADMAP.md').includes(`| ${SLUG} | M1 | merged |`));
  assert.equal(L.readStore(root, SLUG).stage, 'retro');
});

/** A fake gh on PATH: `pr view` answers `pr` (after `pr merge`, `merged`), check runs are all green, no protection. */
function fakeGh(t, { pr = null, merged: after = null, fail = null, checks = [] } = {}) {
  const dir = tmpPath(t);
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ pr, after, checks, done: false }));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const j = process.argv.slice(2).join(' ');
${fail ? `process.stderr.write(${JSON.stringify(fail)}); process.exit(1);` : ''}
if (j.startsWith('pr view')) { process.stdout.write(JSON.stringify(st.done ? { ...st.pr, ...st.after } : st.pr)); process.exit(0); }
if (j.includes('/check-runs')) { process.stdout.write(st.checks.map((name, i) => JSON.stringify({ id: i + 1, name, status: 'completed', conclusion: 'success' })).join('\\n') + '\\n'); process.exit(0); }
if (j.startsWith('pr merge')) { st.done = true; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st)); process.exit(0); }
if (j.includes('/protection')) { process.stderr.write('gh: Branch not protected (HTTP 404)'); process.exit(1); }
process.stderr.write('fake gh: unexpected ' + j); process.exit(9);
`, { mode: 0o755 });
  return { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, KIT_PR_GATE_POLL_SECONDS: '0', KIT_STATUS_NO_GH: '1' } };
}

/** An environment whose PATH has git and node and no gh. */
function noGh(t) {
  const dir = tmpPath(t);
  const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(git, path.join(dir, 'git'));
  fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  assert.notEqual(spawnSync('sh', ['-c', 'command -v gh'], { encoding: 'utf8', env: { PATH: dir } }).status, 0);
  return { ...process.env, PATH: dir, KIT_STATUS_NO_GH: '1' };
}

const PR = (tip, extra = {}) => ({ number: 9, url: 'https://github.com/o/p/pull/9', state: 'MERGED', isDraft: false, headRefOid: tip, headRefName: `wt/${SLUG}`, baseRefName: 'main', title: SLUG, mergeCommit: { oid: 'f'.repeat(40) }, ...extra });

test('lane.js merged asks GitHub when git cannot tell (main not pulled), checks the PR is this lane at this tip, and records it for every reader', (t) => {
  const { root, wt, tip } = laneWith(t, 2);
  write(path.join(wt, 'src', 'api', 'refund.ts'), 'export const refund = 1;\n');
  commitAll(wt, 'after the PR was merged');
  const head = git(['rev-parse', `wt/${SLUG}`], root).trim();
  // GitHub merged an older head: the last local commit was not in it
  let g = fakeGh(t, { pr: PR(tip) });
  let r = runScript('lane.js', ['merged', SLUG, '--repo', root, '--pr', '9'], { env: g.env });
  assert.ok(r.returncode === 2 && r.stderr.includes('does not hold'), r.stderr);
  // another branch, or still open
  for (const [extra, why] of [[{ headRefName: 'wt/other' }, 'not wt/refund-route into main'], [{ state: 'OPEN', mergeCommit: null }, 'GitHub says open']]) {
    g = fakeGh(t, { pr: PR(head, extra) });
    r = runScript('lane.js', ['merged', SLUG, '--repo', root, '--pr', '9'], { env: g.env });
    assert.ok(r.returncode === 2 && r.stderr.includes(why), r.stderr);
  }
  assert.equal(position(root), 'building');
  // merged on GitHub at this head; main here is not pulled, so git alone cannot tell
  g = fakeGh(t, { pr: PR(head) });
  r = runScript('lane.js', ['merged', SLUG, '--repo', root, '--pr', '9'], { env: g.env });
  assert.equal(r.returncode, 0, r.stderr);
  const rec = L.readStore(root, SLUG);
  assert.deepEqual([rec.stage, rec.merge.commit, rec.merge.head, rec.merge.pr], ['retro', 'f'.repeat(40), head, 9]);
  assert.equal(JSON.parse(read(wt, '.claude', 'lane.json')).merge.commit, 'f'.repeat(40));
  // every reader now agrees, offline
  assert.equal(merged(root).how, 'recorded');
  assert.equal(position(root), 'merged');
  // the lane.json copy is in the lane's worktree, so it is never trusted on its own
  const { root: other, wt: wt2 } = laneWith(t, 1);
  const lf = path.join(wt2, '.claude', 'lane.json');
  write(lf, JSON.stringify({ ...JSON.parse(read(lf)), merge: { commit: 'f'.repeat(40), head: git(['rev-parse', 'HEAD'], wt2).trim() } }));
  assert.equal(merged(other).merged, false);
});

test('lane.js merge records the merge it made, so the squash reads as merged before main is pulled', (t) => {
  const { root, wt } = laneWith(t, 1);
  // a normal-risk lane: a high-risk one is refused before any merge until a sign-off can be recorded (#58)
  for (const sp of [path.join(root, 'docs', 'specs', `${SLUG}.md`), path.join(wt, 'docs', 'specs', `${SLUG}.md`)]) write(sp, read(sp).replace('- Risk: high-risk', '- Risk: low'));
  // updated from main, as kit lane gate --sync does, and gated: lane.js merge refuses a head without main's tip (Step 3)
  git(['merge', '-q', '--no-edit', 'main'], wt);
  const head = git(['rev-parse', `wt/${SLUG}`], root).trim();
  assert.equal(gatePass(root, SLUG), head, 'the gate passed the head it merges');
  const g = fakeGh(t, { pr: PR(head, { state: 'OPEN', mergeCommit: null }), merged: { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }, checks: G.projectChecks(root).required });
  let r = runScript('lane.js', ['merge', SLUG, '--repo', root, '--pr', '9', '--by', 'Jonathan'], { env: g.env });
  assert.equal(r.returncode, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /merged \(squash\)/);
  assert.equal(L.readStore(root, SLUG).merge.commit, 'e'.repeat(40));
  assert.equal(position(root), 'merged');
  r = runScript('lane.js', ['merged', SLUG, '--repo', root], { env: g.env });
  assert.equal(r.returncode, 0, r.stderr);
  assert.equal(L.readStore(root, SLUG).stage, 'retro');
});
