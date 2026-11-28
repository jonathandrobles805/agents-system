// Friction found in hardening plan Step 4 (kit-test): the kit blocked correct work or left a mess the owner had to
// clear by hand. #136 bootstrap in the kit's own repo, #138 helper branches left behind, #142 idle time on the
// budget, #144 `kit lane --help`, #145 deleting a merged branch, #148 no command to clear an escalation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, commitAll } from './fixtures.js';
import { runScript, tmpPath, SCRIPTS } from './helpers.js';
import { project } from './testdata.js';
import { activeHours, IDLE_CAP_H } from '../hook_budget_check.js';
import { progressInfo } from '../kit_status.js';

const KIT_REPO = path.dirname(path.dirname(SCRIPTS));
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

/** A bootstrapped project with the lane refund-route open in its worktree. */
function withLane(t) {
  const { root } = project(t);
  assert.equal(runScript('lane.js', ['start', 'refund-route', '--repo', root]).returncode, 0);
  const wt = path.join(path.dirname(root), `${path.basename(root)}-lanes`, 'refund-route');
  if (git(['status', '--porcelain'], wt).trim()) commitAll(wt, 'lane skeleton');
  return { root, wt };
}
const bash = (cwd, command) => runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd, tool_name: 'Bash', tool_input: { command } }) });

test('#144 guard-bash lets kit lane --help, -h and <subcommand> --help through; other non-plain words stay refused', (t) => {
  const { root } = withLane(t);
  for (const c of ['kit lane --help', 'kit lane -h', 'kit lane check --help']) assert.equal(bash(root, c).returncode, 0, c);
  for (const c of ['kit lane "merge" 5', 'kit lane $SUB x', 'kit lane --x']) assert.equal(bash(root, c).returncode, 2, c);
});

test('#145 in the main checkout a merged branch may be deleted while a lane is open; an open lane\'s branch, an unmerged branch, and any delete inside the worktree may not; quoted text is no command', (t) => {
  const { root, wt } = withLane(t);
  git(['branch', 'chore/merged', 'main'], root);
  const unmerged = path.join(tmpPath(t), 'unmerged');
  git(['worktree', 'add', '-q', '-b', 'chore/unmerged', unmerged, 'main'], root);
  fs.writeFileSync(path.join(unmerged, 'new.txt'), 'not on main\n');
  git(['add', 'new.txt'], unmerged);
  git([...ident, 'commit', '-q', '-m', 'unmerged'], unmerged);
  git(['worktree', 'remove', '--force', unmerged], root);
  assert.equal(bash(root, 'git branch -D chore/merged').returncode, 0, bash(root, 'git branch -D chore/merged').stderr);
  let r = bash(root, 'git branch -D chore/unmerged');
  assert.ok(r.returncode === 2 && /changes are not all on/.test(r.stderr), r.stderr);
  r = bash(root, 'git branch -D wt/refund-route');
  assert.ok(r.returncode === 2 && /the branch of an open lane/.test(r.stderr), r.stderr);
  r = bash(wt, 'git branch -d chore/merged');
  assert.ok(r.returncode === 2 && /from inside a lane/.test(r.stderr), r.stderr);
  assert.equal(bash(root, 'gh issue create --title x --body "the guard refused git branch -D chore/x in the main checkout"').returncode, 0);
});

test('#138 kit lane finish deletes the lane\'s helper branches whose changes are on the base, and keeps and names any that are not', (t) => {
  const { root } = withLane(t);
  git(['branch', 'goal/refund-route', 'main'], root);
  git(['branch', 'goal/refund-route-done', 'main'], root);
  git(['branch', 'evidence/refund-route', 'main'], root);
  const side = path.join(tmpPath(t), 'retro');
  git(['worktree', 'add', '-q', '-b', 'retro/refund-route', side, 'main'], root);
  fs.writeFileSync(path.join(side, 'LESSONS.md'), 'a lesson not merged yet\n');
  git(['add', 'LESSONS.md'], side);
  git([...ident, 'commit', '-q', '-m', 'retro'], side);
  git(['worktree', 'remove', '--force', side], root);
  git(['branch', 'goal/other-feature', 'main'], root);
  const r = runScript('lane.js', ['finish', 'refund-route', '--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  const left = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], root).split('\n').filter(Boolean);
  for (const b of ['goal/refund-route', 'goal/refund-route-done', 'evidence/refund-route', 'wt/refund-route']) assert.ok(!left.includes(b), `${b} deleted: ${left}`);
  assert.ok(left.includes('retro/refund-route') && /kept branch retro\/refund-route: it has changes that are not on main/.test(r.stdout), r.stdout);
  assert.ok(left.includes('goal/other-feature'), 'another lane\'s branch is not touched');
});

test('#142 a stage\'s budget hours are working time: each gap between calls counts at most 30 minutes', (t) => {
  const f = path.join(tmpPath(t), 'budget.build.active');
  const start = Date.parse('2026-11-26T20:00:00Z');
  assert.equal(IDLE_CAP_H, 0.5);
  // the first call 7 hours after the stage started: 0.5h, not 7h
  assert.equal(activeHours(f, '2026-11-26T20:00:00Z', start + 7 * 3.6e6), 0.5);
  // ten minutes of work, then an overnight wait, then five more minutes
  assert.ok(Math.abs(activeHours(f, null, start + 7 * 3.6e6 + 10 * 6e4) - (0.5 + 10 / 60)) < 1e-9);
  assert.ok(Math.abs(activeHours(f, null, start + 20 * 3.6e6) - (1 + 10 / 60)) < 1e-9);
  assert.ok(Math.abs(activeHours(f, null, start + 20 * 3.6e6 + 5 * 6e4) - (1 + 15 / 60)) < 1e-9);
});

test('#148 kit lane resolve moves a filled Escalation into Resolved with the owner\'s name and note, and resets the template', (t) => {
  const { root, wt } = withLane(t);
  const prog = path.join(wt, 'docs', 'specs', 'refund-route.progress.md');
  fs.appendFileSync(prog, '\n## Escalation\n\n- Attempts: n/a of 3\n- Failure: budget exceeded for stage \'build\': 13.3h > budget 4h\n- Tried: see events log\n- Needs: a human to raise the budget\n');
  assert.equal(progressInfo(prog).escalated, true);
  let r = runScript('lane.js', ['resolve', 'refund-route', '--repo', root, '--note', 'raised']);
  assert.ok(r.returncode === 2 && /--by <name> is required/.test(r.stderr), r.stderr);
  r = runScript('lane.js', ['resolve', 'refund-route', '--repo', root, '--by', 'Jonathan Robles']);
  assert.ok(r.returncode === 2 && /--note/.test(r.stderr), r.stderr);
  r = runScript('lane.js', ['resolve', 'refund-route', '--repo', root, '--by', 'Jonathan Robles', '--note', 'raised budget_override.build to 8h']);
  assert.equal(r.returncode, 0, r.stderr);
  const text = fs.readFileSync(prog, 'utf8');
  assert.equal(progressInfo(prog).escalated, false, text);
  assert.match(text, /## Resolved\n\n- \d{4}-\d\d-\d\d, resolved by Jonathan Robles: raised budget_override\.build to 8h\n {2}- was: Attempts: n\/a of 3\n {2}- was: Failure: budget exceeded/);
  assert.equal((text.match(/^## Escalation$/gm) ?? []).length, 1, 'one Escalation section, the template');
  assert.match(text, /- Attempts: \{\{n\}\} of 3/);
  // nothing left to resolve
  r = runScript('lane.js', ['resolve', 'refund-route', '--repo', root, '--by', 'Jonathan Robles', '--note', 'again']);
  assert.ok(r.returncode === 2 && /no filled escalation/.test(r.stderr), r.stderr);
  // an owner's decision: the project asks first, a lane is denied it
  const ask = JSON.parse(fs.readFileSync(path.join(KIT_REPO, 'kit', 'hooks', 'settings.project.json'), 'utf8')).permissions.ask;
  const deny = JSON.parse(fs.readFileSync(path.join(KIT_REPO, 'kit', 'hooks', 'settings.lane.json'), 'utf8')).deny;
  assert.ok(ask.includes('Bash(kit lane resolve *)') && deny.includes('Bash(kit lane resolve *)'));
});

test('#136 bootstrap refuses the kit\'s own repository; reading it (--detect-only) is allowed', () => {
  const r = runScript('bootstrap.js', ['--repo', KIT_REPO, '--dry-run']);
  assert.ok(r.returncode === 1 && /the agent kit's own repository, not a project/.test(r.stderr), r.stderr);
  assert.equal(runScript('bootstrap.js', ['--repo', KIT_REPO, '--detect-only', '--json']).returncode, 0);
});
