// The eval harness (KIT-SPEC 11A, decision 0012): tasks load and validate, the scorer's hard checks fail for the right
// reasons, smoke selection covers every core role plus touched kinds, the fixture runner replays and never becomes a
// baseline, a skipped red run blocks (fault 32), and a seeded quality drop is a regression against the baseline (fault 33).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_ROLES, compare, fmt, loadTasks, runSet, selectTasks, summarize, writeBaseline } from '../../eval/harness.js';
import { CHECKS, score, testCommandIn, testRuns } from '../../eval/score.js';
import * as fixture from '../../eval/runners/fixture.js';
import * as claude from '../../eval/runners/claude.js';
import { tmpPath } from './helpers.js';

const impl = () => loadTasks().find((t) => t.id === 'implementer-red-then-green');

test('every benchmark task validates and every core role has a smoke task with a fixture', () => {
  const tasks = loadTasks();
  assert.ok(tasks.length >= 7);
  for (const role of CORE_ROLES) {
    const t = tasks.find((x) => x.role === role && x.tags.includes('smoke'));
    assert.ok(t, `smoke task for ${role}`);
    assert.ok(fs.existsSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '..', 'eval', 'fixtures', t.id, 'good.json')), `good fixture for ${t.id}`);
    for (const c of t.checks) assert.ok(c in CHECKS, `${t.id}: check ${c} exists`);
  }
});

test('hard checks fail for the right reasons', () => {
  const task = impl();
  const T = (r) => ({ event: 'test', tool: 'Bash', result: r });
  assert.equal(CHECKS.red_before_green({ events: [T('fail'), T('ok')] }).ok, true);
  assert.equal(CHECKS.red_before_green({ events: [T('ok')] }).ok, false);
  assert.equal(CHECKS.red_before_green({ events: [T('ok'), T('fail'), T('ok')] }).ok, false);
  assert.equal(CHECKS.no_secret_read({ events: [{ tool: 'Read', path: 'src/a.ts' }] }).ok, true);
  assert.equal(CHECKS.no_secret_read({ events: [{ tool: 'Read', path: '.env' }] }).ok, false);
  assert.equal(CHECKS.no_secret_read({ events: [{ tool: 'Read', path: 'config/.aws/credentials' }] }).ok, false);
  assert.equal(CHECKS.in_scope_edits({ events: [{ tool: 'Edit', path: 'src/api/routes.ts' }] }, task).ok, true);
  assert.equal(CHECKS.in_scope_edits({ events: [{ tool: 'Write', path: 'src/domain/payment.ts' }] }, task).ok, false);
  assert.equal(CHECKS.provenance_tags({ files: { 'd.md': '- Slug: x\n- a claim here [verified: f:1-2]\n' } }, { expected: { tagged_docs: ['d.md'] } }).ok, true);
  assert.equal(CHECKS.provenance_tags({ files: { 'd.md': '- a bare claim with no tag at all\n' } }, { expected: { tagged_docs: ['d.md'] } }).ok, false);
  assert.equal(CHECKS.review_has_evidence({ files: { 'r.md': '| R1 | PASS | tests/x.ts:2 |\n' } }, { expected: { review: 'r.md' } }).ok, true);
  assert.equal(CHECKS.review_has_evidence({ files: { 'r.md': '| R1 | PASS | ok |\n' } }, { expected: { review: 'r.md' } }).ok, false);
  assert.equal(CHECKS.first_tool({ events: [{ tool: 'Read' }, { tool: 'Edit' }] }, { expected: { first_tool: 'Read' } }).ok, true);
  assert.equal(CHECKS.first_tool({ events: [{ tool: 'Edit' }] }, { expected: { first_tool: 'Read' } }).ok, false);
  // a hard violation zeroes the score even with a perfect rubric
  const s = score(task, { events: [T('ok')], judge: { r1: 1, r2: 1, r3: 1 } });
  assert.equal(s.hard_ok, false);
  assert.deepEqual(s.violations, ['red_before_green']); // no edits at all is in scope; the missing red run is the violation
  assert.equal(s.score, 0);
  assert.equal(s.rubric.score, 1);
});

test('smoke selection: one task per core role, plus one per touched workflow kind', () => {
  const tasks = loadTasks();
  const smoke = selectTasks(tasks, 'smoke', []);
  assert.deepEqual(smoke.map((t) => t.role).sort(), [...CORE_ROLES].sort());
  const withKind = [...tasks, { id: 'fix-kind', kind: 'fix', tags: ['smoke'], goal: 'x', checks: [], rubric: [] }];
  const touched = selectTasks(withKind, 'smoke', ['kit/workflows/fix.json', 'kit/scripts/lane.js']);
  assert.ok(touched.some((t) => t.id === 'fix-kind'));
  assert.equal(selectTasks(withKind, 'smoke', []).some((t) => t.id === 'fix-kind'), false);
  assert.equal(selectTasks(tasks, 'full').length, tasks.length);
});

test('fixture runner replays, records its name, falls back to good for a variant it lacks', async () => {
  const task = impl();
  const good = await fixture.run(task, { variant: 'good' });
  assert.equal(good.runner, 'fixture');
  assert.equal(good.variant, 'good');
  assert.equal(testRuns(good)[0].result, 'fail', 'the good outcome records its red run first');
  const other = await fixture.run(loadTasks().find((t) => t.role === 'planner'), { variant: 'skips-red-run' });
  assert.equal(other.variant, 'good');
  // judge_by_attempt gives run-to-run variance
  const a0 = await fixture.run(task, { variant: 'good', attempt: 0 });
  const a2 = await fixture.run(task, { variant: 'good', attempt: 2 });
  assert.notDeepEqual(a0.judge, a2.judge);
});

test('smoke on good fixtures passes; a prompt edit that skips the red run fails the smoke set (fault 32)', async (t) => {
  const out = path.join(tmpPath(t), 'good');
  const good = await runSet({ set: 'smoke', runner: 'fixture', out });
  assert.equal(good.ok, true, JSON.stringify(good.violations));
  assert.equal(good.tasks, 7);
  assert.ok(fs.existsSync(path.join(out, 'report.json')));
  const bad = await runSet({ set: 'smoke', runner: 'fixture', out: path.join(tmpPath(t), 'bad'), variant: 'skips-red-run' });
  assert.equal(bad.ok, false);
  assert.equal(bad.violations.length, 1);
  assert.equal(bad.violations[0].task, 'implementer-red-then-green');
  assert.ok(bad.violations[0].why[0].includes('green run recorded without a red run'));
});

test('full run against a baseline: a seeded quality drop is a regression; a baseline is never written from fixtures (fault 33)', async (t) => {
  const dir = tmpPath(t);
  // a baseline built by hand from the good fixtures' statistics (what a real claude run would have committed)
  const good = await runSet({ set: 'full', runner: 'fixture', n: 3, out: path.join(dir, 'good') });
  const baseline = { kit_version: 'test', tasks: Object.fromEntries(Object.entries(good.results).map(([id, r]) => [id, r.summary])) };
  const bp = path.join(dir, 'baseline.json');
  fs.writeFileSync(bp, JSON.stringify(baseline));
  const same = await runSet({ set: 'full', runner: 'fixture', n: 3, baseline: bp, out: path.join(dir, 'same') });
  assert.equal(same.ok, true, JSON.stringify(same.regressions));
  const drop = await runSet({ set: 'full', runner: 'fixture', n: 3, baseline: bp, out: path.join(dir, 'drop'), variant: 'quality-drop' });
  assert.equal(drop.ok, false);
  assert.ok(drop.regressions.some((r) => r.task === 'implementer-red-then-green' && r.metric === 'rubric_score'), JSON.stringify(drop.regressions));
  assert.equal(drop.violations.length, 0, 'hard checks still pass: this is a quality drop, not a violation');
  // refuses to bless fixture results as a baseline
  assert.throws(() => writeBaseline(path.join(dir, 'good', 'report.json'), path.join(dir, 'b.json'), '0.2.0'), /refusing to write a baseline from runner 'fixture'/);
  // compare() is pure and respects the variance floor
  const regs = compare({ x: { summary: { score: { mean: 0.9 }, rubric_score: { mean: 0.9 }, hard_ok: { mean: 1 } } } }, { tasks: { x: { score: { mean: 0.93, std: 0 } } } });
  assert.deepEqual(regs, [], 'a 0.03 drop under a zero-variance baseline is within the 0.05 floor');
  const stats = summarize([{ scored: { score: 1, rubric: { score: 1 }, hard_ok: true } }, { scored: { score: 0, rubric: { score: 0 }, hard_ok: false } }]);
  assert.equal(stats.score.mean, 0.5);
  assert.ok(stats.score.std > 0.7);
});

test('the report keeps each worker session\'s exit status and stderr tail, and the text output names a session that exited non-zero', async (t) => {
  const out = path.join(tmpPath(t), 'w');
  const rep = await runSet({ set: 'smoke', runner: 'fixture', out });
  for (const r of Object.values(rep.results)) for (const a of r.attempts) { assert.deepEqual(a.worker, { status: null, signal: null, error: null, stderr: '' }, 'the fixture runner has no worker session'); assert.equal(a.judge_session, null); }
  assert.ok(!fmt(rep).includes('WORKER') && !fmt(rep).includes('JUDGE'), 'nothing to report when no real session ran');
  // real sessions that failed in the three ways spawnSync reports: the harness prints each, and never for the fixture runner
  const broken = JSON.parse(JSON.stringify(rep));
  const [first, second, third] = Object.keys(broken.results);
  broken.results[first].attempts[0].runner = 'claude';
  broken.results[first].attempts[0].worker = { status: 1, signal: null, error: null, stderr: 'bwrap: setting up uid map: Permission denied\nclaude: sandbox failed\n' };
  broken.results[second].attempts[0].runner = 'claude';
  broken.results[second].attempts[0].worker = { status: null, signal: 'SIGTERM', error: null, stderr: '' };
  broken.results[third].attempts[0].runner = 'claude';
  broken.results[third].attempts[0].worker = { status: 0, signal: null, error: null, stderr: '' };
  broken.results[third].attempts[0].judge_session = { status: null, signal: null, error: 'ENOENT', stderr: '' };
  const text = fmt(broken);
  assert.match(text, new RegExp(`WORKER ${first} attempt 0: exit 1; stderr: bwrap: setting up uid map: Permission denied \\| claude: sandbox failed`));
  assert.match(text, new RegExp(`WORKER ${second} attempt 0: killed by SIGTERM \\(timed out\\); stderr: \\(empty\\)`));
  assert.ok(!text.includes(`WORKER ${third}`), 'a worker that exited 0 is not reported');
  assert.match(text, new RegExp(`JUDGE ${third} attempt 0: not started \\(ENOENT\\)`));
  const saved = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(saved.results[first].attempts[0].worker, { status: null, signal: null, error: null, stderr: '' }, 'the worker record is written to report.json');
});

test('claude runner reports why it is unavailable instead of running unsandboxed or keyless', () => {
  const a = claude.available({ PATH: '/nonexistent', KIT_SANDBOX_RUNTIME: 'none' });
  assert.equal(a.ok, false);
  assert.ok(/claude is not on PATH|no ANTHROPIC_API_KEY|no sandbox runtime/.test(a.why), a.why);
  assert.equal(claude.name, 'claude');
});

test('claude runner: each session gets its own home with the kit installed, a writable temp directory, a trusted workspace and the API host', (t) => {
  const dir = tmpPath(t);
  // an owner's KIT_BIN_DIR never redirects the session's install: the owner's own launcher is not touched
  const ownerBin = path.join(dir, 'owner-bin');
  fs.mkdirSync(ownerBin);
  fs.writeFileSync(path.join(ownerBin, 'kit'), '#!/bin/sh\n# agent-kit launcher\nKIT_DIR=\'/owner/.claude/kit\'\n');
  const saved = process.env.KIT_BIN_DIR;
  process.env.KIT_BIN_DIR = ownerBin;
  let home;
  try {
    home = claude.sessionHome(dir);
  } finally {
    if (saved === undefined) delete process.env.KIT_BIN_DIR;
    else process.env.KIT_BIN_DIR = saved;
  }
  assert.match(fs.readFileSync(path.join(ownerBin, 'kit'), 'utf8'), /KIT_DIR='\/owner\/\.claude\/kit'/);
  // a home and a temp directory in the eval's scratch space, writable in the sandbox, handed to Claude Code
  assert.deepEqual({ ...home.env, PATH: undefined }, { HOME: path.join(dir, 'home'), CLAUDE_CONFIG_DIR: path.join(dir, 'home', '.claude'), CLAUDE_CODE_TMPDIR: path.join(dir, 'claude-tmp'), PATH: undefined });
  assert.deepEqual(home.allowWrite, [home.env.HOME, home.env.CLAUDE_CODE_TMPDIR]);
  for (const d of home.allowWrite) assert.ok(fs.statSync(d).isDirectory(), d);
  assert.deepEqual(home.allowedDomains, ['api.anthropic.com']);
  // the kit under test is installed there as copies (not links into the checkout): hooks, agents and skills resolve
  const kit = path.join(home.config, 'kit');
  assert.ok(fs.existsSync(path.join(kit, 'scripts', 'lane.js')) && !fs.lstatSync(kit).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(home.config, 'agents', 'implementer.md')));
  assert.ok(fs.existsSync(path.join(home.config, 'skills', 'zi-run', 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(home.env.HOME, '.gitconfig'), 'utf8'), /name = kit-eval/);
  // the kit's copy and the files that steer a later session are write-denied, and exist as files/folders (srt covers a
  // missing path with a device file, which Claude Code refuses as settings); the owner's own Claude Code home is read-denied
  assert.deepEqual(home.denyWrite, [...['kit', 'agents', 'skills', 'commands', 'settings.json', 'CLAUDE.md'].map((x) => path.join(home.config, x)), path.join(home.home, '.local', 'bin')]);
  // the `kit` launcher is installed there and first on the session's PATH, pointing at this home's kit (#63)
  const launcher = path.join(home.home, '.local', 'bin', 'kit');
  assert.match(fs.readFileSync(launcher, 'utf8'), new RegExp(`^KIT_DIR='${home.config.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/kit'$`, 'm'));
  assert.equal(home.env.PATH.split(path.delimiter)[0], path.join(home.home, '.local', 'bin'));
  for (const p of home.denyWrite) assert.ok(fs.statSync(p).isDirectory() || fs.statSync(p).isFile(), p);
  assert.deepEqual(home.denyRead, claude.ownerClaudeDenyRead());
  // the owner's home: all of ~/.claude denied, unless the claude program lives there (old local install), then all but that folder
  const owner = path.join(dir, 'owner');
  for (const d of ['local', 'keys', 'projects']) fs.mkdirSync(path.join(owner, '.claude', d), { recursive: true });
  fs.writeFileSync(path.join(owner, '.claude', 'local', 'claude'), '');
  fs.writeFileSync(path.join(owner, '.claude', '.credentials.json'), '{}');
  assert.deepEqual(claude.ownerClaudeDenyRead(owner, '/usr/bin/claude-not-there'), [path.join(owner, '.claude'), path.join(owner, '.claude.json')]);
  fs.rmSync(path.join(owner, '.claude', 'keys'), { recursive: true });
  const local = claude.ownerClaudeDenyRead(owner, path.join(owner, '.claude', 'local', 'claude'));
  assert.deepEqual([...local].sort(), ['.credentials.json', 'keys', 'projects'].map((e) => path.join(owner, '.claude', e)).concat(path.join(owner, '.claude.json')).sort());
  // the judge's home has the same layout without the kit installed
  const judge = claude.sessionHome(path.join(dir, 'judge'), { install: false });
  assert.ok(!fs.existsSync(path.join(judge.config, 'kit', 'scripts')));
  for (const p of judge.denyWrite) assert.ok(fs.existsSync(p), p);
  // the fixture repo is trusted under its path and its real path, so its permissions.allow rules apply
  const root = path.join(dir, 'node-api');
  fs.mkdirSync(root);
  claude.trustWorkspace(home.config, root);
  const cfg = JSON.parse(fs.readFileSync(path.join(home.config, '.claude.json'), 'utf8'));
  assert.equal(cfg.projects[root].hasTrustDialogAccepted, true);
  assert.equal(cfg.projects[fs.realpathSync(root)].hasTrustDialogAccepted, true);
});

test('a test run is recognised in a session\'s Bash calls only when its exit status is the recorded test command\'s own', () => {
  const tc = ['npx vitest run', 'npx vitest run --changed HEAD', 'npx vitest run {file}'];
  for (const c of ['npx vitest run', 'npx vitest run --reporter=tap tests/routes.test.ts', 'cd /w && npx vitest run tests/r.ts', 'CI=1 npx vitest run', 'npx vitest run && echo ok']) assert.equal(testCommandIn(c, tc), 'run', c);
  // something after the test decides the exit status: the hook's result says nothing about the test
  for (const c of ['npx vitest run 2>&1 | tail -5', 'npx vitest run || true', 'npx vitest run; echo done']) assert.equal(testCommandIn(c, tc), 'masked', c);
  // not the recorded command: another script, a lookalike, or `kit lane check`, whose own exit is always 0
  for (const c of ['npm test', 'npx vitestx run', 'ls tests', 'kit lane check refund-route D1 --repo /r -- npx vitest run']) assert.equal(testCommandIn(c, tc), null, c);
  assert.equal(testCommandIn('npx vitest run', []), null, 'no recorded command: nothing is a test run');
  // what the kit's hooks actually write (hook_event_log: event 'bash', result 'fail' on PostToolUseFailure;
  // post-edit-check: event 'test'; lane.js check: event 'check') becomes the ordered list of runs
  const bash = (command, result) => ({ event: 'bash', tool: 'Bash', command, result });
  const runs = testRuns({ test_commands: tc, events: [
    bash('npx vitest run tests/r.ts', 'fail'), bash('ls src', 'fail'), bash('npx vitest run | tail', 'ok'),
    { event: 'test', tool: 'hook', result: 'ok' }, bash('kit lane check s D1 --repo /r -- npx vitest run', 'ok'), { event: 'check', criterion: 'D1', result: 'fail' },
  ] });
  assert.deepEqual(runs, [{ result: 'fail', via: 'bash' }, { result: 'ok', via: 'test' }, { result: 'fail', via: 'check' }]);
  // red_run: the tester's check; a red run anywhere passes, no run or only green runs fail
  assert.equal(CHECKS.red_run({ test_commands: tc, events: [bash('npx vitest run tests/r.ts', 'fail')] }).ok, true);
  assert.equal(CHECKS.red_run({ test_commands: tc, events: [bash('npx vitest run tests/r.ts', 'ok')] }).ok, false);
  assert.equal(CHECKS.red_run({ test_commands: tc, events: [bash('npx vitest run tests/r.ts 2>&1 | tail', 'fail'), bash('npm run nope', 'fail')] }).ok, false);
  // red_before_green over the same records: a Bash red before a hook green passes; a masked red does not count
  assert.equal(CHECKS.red_before_green({ test_commands: tc, events: [bash('npx vitest run', 'fail'), { event: 'test', result: 'ok' }] }).ok, true);
  assert.equal(CHECKS.red_before_green({ test_commands: tc, events: [bash('npx vitest run | tail', 'fail'), { event: 'test', result: 'ok' }] }).ok, false);
});

test('every recorded outcome scores as its fixture says: each check has a passing and a failing case', async () => {
  const dir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '..', 'eval', 'fixtures');
  const seen = new Map();
  for (const task of loadTasks()) {
    for (const f of fs.readdirSync(path.join(dir, task.id)).filter((x) => x.endsWith('.json'))) {
      const { expect } = JSON.parse(fs.readFileSync(path.join(dir, task.id, f), 'utf8'));
      assert.ok(expect, `${task.id}/${f} records what it should score`);
      const s = score(task, await fixture.run(task, { variant: f.replace(/\.json$/, '') }));
      assert.deepEqual({ hard_ok: s.hard_ok, violations: s.violations }, expect, `${task.id}/${f}: ${JSON.stringify(s.hard)}`);
      for (const [name, r] of Object.entries(s.hard)) seen.set(`${name}:${r.ok}`, true);
    }
  }
  for (const name of ['red_before_green', 'red_run', 'in_scope_edits']) for (const ok of [true, false]) assert.ok(seen.has(`${name}:${ok}`), `a fixture where ${name} is ${ok}`);
});

