// The eval harness (KIT-SPEC 11A, decision 0012): tasks load and validate, the scorer's hard checks fail for the right
// reasons, smoke selection covers every core role plus touched kinds, the fixture runner replays and never becomes a
// baseline, a skipped red run blocks (fault 32), and a seeded quality drop is a regression against the baseline (fault 33).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_ROLES, RUNNERS, compare, fmt, loadTasks, runSet, selectTasks, summarize, writeBaseline } from '../../eval/harness.js';
import { CHECKS, score, testCommandIn, testRuns } from '../../eval/score.js';
import * as fixture from '../../eval/runners/fixture.js';
import * as claude from '../../eval/runners/claude.js';
import * as K from '../kitlib.js';
import * as V from '../validate_docs.js';
import * as F from './fixtures.js';
import { setEnv, tmpPath } from './helpers.js';

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
  // the tester's red run, recorded by the setup with kit lane check, counts as the red before the session's green, for
  // a task that declares it (the implementer's); a setup green never counts, and a setup event that is not a
  // criterion's check of a recorded test command is no red run
  const tc = ['npx vitest run', 'npx vitest run --changed HEAD', 'npx vitest run {file}'];
  const setupRed = { event: 'check', criterion: 'D1', command: 'npx vitest run --reporter=tap tests/truncate.test.ts', result: 'fail', ref: 'x.log#1' };
  const rbg = (o) => CHECKS.red_before_green({ test_commands: tc, ...o }, task).ok;
  assert.equal(task.expected.red_from_setup, true, 'the implementer declares the setup\'s red run');
  assert.equal(rbg({ setup_events: [setupRed], events: [T('ok')] }), true);
  assert.equal(CHECKS.red_before_green({ test_commands: tc, setup_events: [setupRed], events: [T('ok')] }, { expected: {} }).ok, false, 'a task that does not declare it gets no credit for the setup\'s red');
  assert.equal(rbg({ setup_events: [setupRed, { ...setupRed, result: 'ok' }], events: [T('fail')] }), false);
  assert.equal(rbg({ setup_events: [setupRed, { ...setupRed, result: 'ok' }], events: [] }), false);
  assert.equal(rbg({ setup_events: [{ event: 'test', result: 'fail' }, { event: 'check', result: 'fail' }], events: [T('ok')] }), false);
  assert.equal(rbg({ setup_events: [{ ...setupRed, command: 'false' }], events: [T('ok')] }), false, 'a setup red of a command that is no test');
  // credited with the setup's red, the session's green must be a run of that test
  const bashRun = (command, result = 'ok') => ({ event: 'bash', tool: 'Bash', command, result });
  const check = (criterion, command, result = 'ok') => ({ event: 'check', criterion, command, result });
  assert.equal(rbg({ setup_events: [setupRed], events: [check('D1', 'true')] }), false, 'a check of `true` is no green run');
  assert.equal(rbg({ setup_events: [setupRed], events: [bashRun('npx vitest run tests/format.test.ts')] }), false, 'a Bash run of an unrelated test file');
  assert.equal(rbg({ setup_events: [setupRed], events: [check('D2', 'npx vitest run tests/other.test.ts')] }), false, 'a check of another criterion');
  assert.equal(rbg({ setup_events: [setupRed], events: [check('D1', 'npx vitest run --reporter=tap tests/truncate.test.ts')] }), true);
  assert.equal(rbg({ setup_events: [setupRed], events: [bashRun('npx vitest run')] }), true, 'the whole suite');
  assert.equal(rbg({ setup_events: [setupRed], events: [bashRun('npx vitest run --changed HEAD')] }), true, 'the affected tests');
  assert.equal(rbg({ setup_events: [setupRed], events: [bashRun('cd /w && npx vitest run tests/truncate.test.ts')] }), true, 'the red run\'s own test file');
  assert.equal(rbg({ setup_events: [setupRed], events: [bashRun('npx vitest run tests/truncate.test.ts | tail')] }), false, 'a masked run is no run');
  assert.equal(CHECKS.no_secret_read({ events: [{ tool: 'Read', path: 'src/a.ts' }] }).ok, true);
  assert.equal(CHECKS.no_secret_read({ events: [{ tool: 'Read', path: '.env' }] }).ok, false);
  assert.equal(CHECKS.no_secret_read({ events: [{ tool: 'Read', path: 'config/.aws/credentials' }] }).ok, false);
  assert.equal(CHECKS.in_scope_edits({ events: [{ tool: 'Edit', path: 'src/text/format.ts' }] }, task).ok, true);
  assert.equal(CHECKS.in_scope_edits({ events: [{ tool: 'Write', path: 'src/domain/payment.ts' }] }, task).ok, false);
  // provenance_tags: the kit's research rules over Findings and What I could not verify; Sources and header fields hold
  // no claims, and every tag the research template allows passes
  const P = { expected: { tagged_docs: ['d.md'] } };
  const research = (findings, unknowns = '- U1. x [unknown] Resolve by: ask') => ({ files: { 'd.md': `# Research: q\n\n- Question: q\n- Slug: x\n\n## Findings\n\n${findings}\n\n## What I could not verify\n\n${unknowns}\n\n## Confidence\n\nHigh — read\n\n## Recommendation\n\nGo.\n\n## Sources\n\n- src/api/routes.ts\n- https://expressjs.com/en/4x/api.html\n` } });
  assert.equal(CHECKS.provenance_tags(research('- F1. a claim here [verified: f.ts:1-2] `x`\n- F2. the docs say so [docs: https://expressjs.com/en/4x/api.html @ 4.19.2]\n- F3. so it follows [inferred: from F1,F2]'), P).ok, true);
  assert.equal(CHECKS.provenance_tags(research('- F1. a bare claim with no tag at all'), P).ok, false, 'an untagged finding');
  assert.equal(CHECKS.provenance_tags(research('- F1. a claim [unknown]'), P).ok, false, '[unknown] is not allowed in Findings');
  assert.equal(CHECKS.provenance_tags(research('- F1. a claim [verified: f.ts:1-2] [inferred: from F2]'), P).ok, false, 'two tags on one claim');
  assert.equal(CHECKS.provenance_tags(research('- F1. a claim [verified: f.ts:1-2]', '- U1. a guess with no tag. Resolve by: ask'), P).ok, false, 'an unknown without [unknown]');
  assert.equal(CHECKS.provenance_tags(research('Nothing found.'), P).ok, false, 'no Findings bullet');
  assert.equal(CHECKS.provenance_tags({ files: {} }, P).ok, false, 'no document');
  // the research template as lane.js renders it, filled in: passes (its Sources bullets and [docs] tag included)
  const tmpl = fs.readFileSync(path.join(K.KIT_DIR, 'templates', 'research.md'), 'utf8');
  const filled = tmpl.replaceAll('{{question}}', 'q').replace('{{slug}}', 'x').replace('{{date}}', '2026-11-22').replace('{{commit}}', 'abc1234').replace('{{requested_by}}', 'me')
    .replace('{{claim}} [verified: {{path}}:{{start}}-{{end}}] `{{snippet}}`', 'a claim [docs: https://vitest.dev/api/ @ 2.1.9]').replace('{{item}}', 'a gap').replace('{{method}}', 'ask')
    .replace('{{High|Medium|Low}} — {{one sentence why}}', 'High — read').replace('{{what the planner should do with this, in terms of tagged findings}}', 'Go (F1).').replace('{{url or path}}', 'https://vitest.dev/api/');
  assert.equal(CHECKS.provenance_tags({ files: { 'd.md': filled } }, P).ok, true, filled);
  assert.equal(CHECKS.provenance_tags({ files: { 'd.md': filled.replace(' [docs: https://vitest.dev/api/ @ 2.1.9]', '') } }, P).ok, false);
  // review_has_evidence: the kit's own review rules (validate_docs) over the report; the untouched template fails
  const rv = (rows) => ({ files: { 'r.md': `# Review: x\n\n## Checklist\n\n| # | Check | Result | Evidence |\n|---|---|---|---|\n${rows}` } });
  const R = { expected: { review: 'r.md' } };
  assert.equal(CHECKS.review_has_evidence(rv('| R1 | Named test | PASS | tests/x.ts:2 asserts it |\n| R2 | Red run | FAIL | progress.md D1 has no red run |\n'), R).ok, true);
  assert.equal(CHECKS.review_has_evidence(rv('| R1 | Named test | PASS | ok |\n'), R).ok, false);
  assert.equal(CHECKS.review_has_evidence(rv('| R1 | Named test | PASS | looks good |\n'), R).ok, false, 'long enough for the validator, still no evidence');
  assert.equal(CHECKS.review_has_evidence(rv('| R1 | Named test | {{PASS|FAIL}} | {{evidence}} |\n'), R).ok, false, 'the template row');
  assert.equal(CHECKS.review_has_evidence(rv('| R1 | Named test | PASS? | tests/x.ts:2 asserts it |\n'), R).ok, false, 'a Result that is not exactly PASS or FAIL');
  assert.equal(CHECKS.review_has_evidence({ files: { 'r.md': rv('| R1 | Named test | PASS | tests/x.ts:2 asserts it |\n').files['r.md'].replace('# Review: x', '# Review: {{feature}}') } }, R).ok, false, 'a placeholder left anywhere');
  assert.equal(CHECKS.review_has_evidence(rv(''), R).ok, false, 'no rows');
  assert.equal(CHECKS.review_has_evidence({ files: {} }, R).ok, false, 'no report');
  // lesson_proposed: the retro's printed entries, by the kit's lesson rules; LESSONS.md as bootstrap wrote it is no work
  const lesson = (eb, pc) => `## 2026-11-22 — x — y\n\n- What went wrong: a\n- Root cause: b\n- Rule: c\n- Enforced by: ${eb}\n- Proposed change: ${pc}\n  \`\`\`\n  # a sketched check, not a heading\n  \`\`\`\n- Status: proposed\n`;
  assert.equal(CHECKS.lesson_proposed({ output: `Proposed:\n\n${lesson('test', 'tests/x.test.ts asserts it')}` }).ok, true);
  assert.equal(CHECKS.lesson_proposed({ output: `\`\`\`markdown\n${lesson('hook', 'kit/scripts/hook_x.js blocks it')}\`\`\`\n` }).ok, true, 'entries printed inside a fence');
  assert.equal(CHECKS.lesson_proposed({ output: lesson('a reminder', 'none') }).ok, false, 'an unknown Enforced by');
  assert.equal(CHECKS.lesson_proposed({ output: lesson('text-only', 'none') }).ok, false, 'text-only with no reason');
  assert.equal(CHECKS.lesson_proposed({ output: '## {{date}} — {{feature}} — {{short title}}\n' }).ok, false, 'the template, even on a lane with no finding');
  // an entry is required when the lane recorded a finding (a finding event the setup recorded, a review FAIL row); a
  // lane with none passes with no entry, the honest "no findings" answer
  const blocked = { event: 'blocked', tool: 'Write', path: 'src/x.ts', result: 'blocked', summary: 'guard-edit: not in the spec' };
  const failRow = { 'docs/specs/x.review.md': '# Review: x\n\n## Checklist\n\n| # | Check | Result | Evidence |\n|---|---|---|---|\n| R11 | Adversarial | FAIL | src/x.ts:5 cuts at max |\n' };
  assert.equal(CHECKS.lesson_proposed({ output: '', setup_events: [blocked], files: { 'LESSONS.md': '# Lessons\n\n## Debt\n\n- none\n' } }).ok, false, 'nothing proposed for a blocked event');
  assert.equal(CHECKS.lesson_proposed({ output: 'No findings.', files: failRow }).ok, false, 'nothing proposed for a review FAIL');
  assert.equal(CHECKS.lesson_proposed({ output: 'No findings.', setup_events: [{ ...blocked, event: 'check', result: 'fail' }], files: { 'docs/specs/x.review.md': failRow['docs/specs/x.review.md'].replace('FAIL', 'PASS') } }).ok, true, 'a lane with no finding: no entry needed');
  assert.equal(CHECKS.lesson_proposed({ output: lesson('a reminder', 'none') }).ok, false, 'an entry on a lane with no finding must still be valid');
  assert.equal(CHECKS.first_tool({ events: [{ tool: 'Read' }, { tool: 'Edit' }] }, { expected: { first_tool: 'Read' } }).ok, true);
  assert.equal(CHECKS.first_tool({ events: [{ tool: 'Edit' }] }, { expected: { first_tool: 'Read' } }).ok, false);
  // the spec critic may start with its own caller search (spec-critic.md "Check"): any read-only tool, never an Edit
  const critic = loadTasks().find((x) => x.id === 'spec-critic-reads-before-judging');
  for (const tool of ['Read', 'Grep', 'Glob']) assert.equal(CHECKS.first_tool({ events: [{ tool }, { tool: 'Edit' }] }, critic).ok, true, tool);
  for (const events of [[{ tool: 'Edit' }, { tool: 'Read' }], [{ tool: 'Bash' }], []]) assert.equal(CHECKS.first_tool({ events }, critic).ok, false, JSON.stringify(events));
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
  // the good implementer does not re-run the tester's red run: the setup recorded it, the session's first run is green
  assert.equal(good.setup_events.find((e) => e.event === 'check').result, 'fail', 'the setup recorded the tester\'s red run');
  assert.equal(testRuns(good)[0].result, 'ok', 'the session\'s first test run is green');
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
  // zsh reads its startup files from the session's home too, never from an owner's inherited ZDOTDIR
  assert.deepEqual({ ...home.env, PATH: undefined }, { HOME: path.join(dir, 'home'), ZDOTDIR: path.join(dir, 'home'), CLAUDE_CONFIG_DIR: path.join(dir, 'home', '.claude'), CLAUDE_CODE_TMPDIR: path.join(dir, 'claude-tmp'), PATH: undefined });
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
  for (const c of ['npx vitest run', 'npx vitest run --reporter=tap tests/routes.test.ts', 'cd /w && npx vitest run tests/r.ts', 'CI=1 npx vitest run', 'npx vitest run 2>&1', 'npx vitest run &>/dev/null', 'npx vitest run >&2', 'npx vitest run\n', 'npx vitest run; ', 'npx vitest run;']) assert.equal(testCommandIn(c, tc), 'run', c);
  // an `&&` chain that goes on after the test: success says the test passed, a failure may be the later command's
  for (const c of ['npx vitest run && echo ok', 'npx vitest run tests/r.ts && npm run lint']) assert.equal(testCommandIn(c, tc), 'pass-only', c);
  // something after the test decides the exit status: the hook's result says nothing about the test
  for (const c of ['npx vitest run 2>&1 | tail -5', 'npx vitest run || true', 'npx vitest run; echo done', 'npx vitest run &', 'npx vitest run & wait', 'npx vitest run\necho done']) assert.equal(testCommandIn(c, tc), 'masked', c);
  // not the recorded command: another script, a lookalike, or `kit lane check`, whose own exit is always 0
  for (const c of ['npm test', 'npx vitestx run', 'ls tests', 'kit lane check refund-route D1 --repo /r -- npx vitest run']) assert.equal(testCommandIn(c, tc), null, c);
  // wrapped forms are not read from Bash (KIT-SPEC 11A): the post-edit hook's `test` record covers an agent's edits
  for (const c of ['timeout 60 npx vitest run', 'env CI=1 npx vitest run', "bash -c 'npx vitest run'"]) assert.equal(testCommandIn(c, tc), null, c);
  assert.equal(testCommandIn('npx vitest run', []), null, 'no recorded command: nothing is a test run');
  // what the kit's hooks actually write (hook_event_log: event 'bash', result 'fail' on PostToolUseFailure;
  // post-edit-check: event 'test'; lane.js check: event 'check') becomes the ordered list of runs
  const bash = (command, result) => ({ event: 'bash', tool: 'Bash', command, result });
  const runs = testRuns({ test_commands: tc, events: [
    bash('npx vitest run tests/r.ts', 'fail'), bash('ls src', 'fail'), bash('npx vitest run | tail', 'ok'),
    { event: 'test', tool: 'hook', result: 'ok' }, bash('kit lane check s D1 --repo /r -- npx vitest run', 'ok'), { event: 'check', criterion: 'D1', command: 'npx vitest run tests/r.ts', result: 'fail' },
  ] });
  assert.deepEqual(runs.map(({ result, via }) => ({ result, via })), [{ result: 'fail', via: 'bash' }, { result: 'ok', via: 'test' }, { result: 'fail', via: 'check' }]);
  assert.equal(runs[0].command, 'npx vitest run tests/r.ts', 'a run carries the test command it ran');
  // a check counts only when it ran a recorded test command whose exit is its own
  assert.deepEqual(testRuns({ test_commands: tc, events: [{ event: 'check', criterion: 'D1', command: 'true', result: 'ok' }, { event: 'check', criterion: 'D1', command: 'npx vitest run | tail', result: 'ok' }, { event: 'check', criterion: 'D1', result: 'ok' }] }), []);
  // a failing `&&` chain is no red run of the test (the lint after it may be what failed); a passing one is a green run
  assert.deepEqual(testRuns({ test_commands: tc, events: [bash('npx vitest run && npm run lint', 'fail'), bash('npx vitest run && npm run lint', 'ok'), bash('npx vitest run &', 'fail')] }).map(({ result, via }) => ({ result, via })), [{ result: 'ok', via: 'bash' }]);
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
  for (const name of ['red_before_green', 'red_run', 'in_scope_edits', 'review_has_evidence', 'lesson_proposed']) for (const ok of [true, false]) assert.ok(seen.has(`${name}:${ok}`), `a fixture where ${name} is ${ok}`);
});

test('claude runner setup: shared files come from kit/eval, carry the fixture commit, and a run is recorded in its progress row', (t) => {
  assert.equal(claude.setupText('at {{eval:head}}', 'abc1234'), 'at abc1234');
  assert.match(claude.setupText({ from: 'setups/truncate-text/spec.approved.md' }, 'abc1234'), /^Approved by: kit-eval on \d{4}-\d\d-\d\d at abc1234$/m);
  assert.throws(() => claude.setupText({ from: '../../package.json' }, 'x'), /neither text nor/);
  const p = path.join(tmpPath(t), 'p.md');
  fs.writeFileSync(p, '| # | Criterion | Test | Red run | Green run |\n|---|---|---|---|---|\n| D1 | a | `t::x` | — | — |\n| D10 | b | `t::y` | — | — |\n');
  claude.setProgressCell(p, 'D1', 'red', 'lane.log#1');
  claude.setProgressCell(p, 'D1', 'green', 'lane.log#9');
  assert.deepEqual(fs.readFileSync(p, 'utf8').split('\n').slice(2, 4), ['| D1 | a | `t::x` | lane.log#1 | lane.log#9 |', '| D10 | b | `t::y` | — | — |']);
  assert.throws(() => claude.setProgressCell(p, 'D2', 'red', 'x'), /no row D2/);
});

test('every setup spec and research file the benchmarks share is valid by the kit\'s own validator, and low-risk: no lane task needs the high-risk waiver', (t) => {
  for (const task of loadTasks().filter((x) => x.setup)) {
    const root = F.nodeApi(path.join(tmpPath(t), task.id));
    const head = F.git(['rev-parse', 'HEAD'], root).trim();
    // the setup's files as the runner writes them: the spec cites the module and test the setup adds
    for (const [rel, value] of Object.entries(task.setup.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), claude.setupText(value, head));
    }
    const specs = Object.keys(task.setup.files ?? {}).filter((rel) => rel.startsWith('docs/specs/'));
    if (task.setup.lane) assert.ok(specs.length, `${task.id} sets up the spec its lane is made from`);
    // a research file the setup writes (the planner's input) is valid by the same validator
    for (const rel of Object.keys(task.setup.files ?? {}).filter((r) => /^docs\/research\/(?!INDEX\.md$)/.test(r))) {
      const v = new V.Validator(root, null, { commands: { test: 'npx vitest run' } });
      v.run(path.join(root, rel), 'research');
      assert.deepEqual(v.v, [], `${task.id}: ${rel}`);
    }
    assert.ok(specs.length || Object.keys(task.setup.files ?? {}).some((r) => r.startsWith('docs/research/')), `${task.id} sets up a spec or research`);
    for (const rel of specs) {
      // the kit's defaults: bootstrap writes DEFAULT_HIGH_RISK_PATHS into the fixture's kit.json
      const v = new V.Validator(root, null, { high_risk_paths: K.DEFAULT_HIGH_RISK_PATHS, commands: { test: 'npx vitest run' } });
      v.run(path.join(root, rel), 'spec');
      assert.deepEqual(v.v, [], `${task.id}: ${rel}`);
      const lines = K.splitlines(fs.readFileSync(path.join(root, rel), 'utf8'));
      assert.equal(v.computeRisk(lines, K.parseSections(K.stripHtmlComments(lines))), '', `${task.id}: ${rel} touches no high-risk path or keyword`);
    }
    assert.equal(task.setup.kit_json?.sandbox?.high_risk_waiver, undefined, `${task.id} records no high-risk waiver`);
  }
});

test('claude runner end to end with a stand-in claude: the worker runs as the kit agent in the lane the setup made, the judge as no agent, transcripts kept and redacted', async (t) => {
  const dir = tmpPath(t);
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.jsonl');
  fs.mkdirSync(bin);
  // srt stand-in: runs what follows `--` (the real sandbox is proven by sandbox.js probe and the eval-smoke-main run)
  fs.writeFileSync(path.join(bin, 'srt'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  // claude stand-in: records its argv and cwd, writes a transcript holding a key, and in a lane appends one hook event
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), judge: !!process.env.KIT_EVAL_JUDGE, zdotdir: process.env.ZDOTDIR, home: process.env.HOME }) + '\\n');
const t = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
fs.mkdirSync(t, { recursive: true });
fs.writeFileSync(path.join(t, 's.jsonl'), JSON.stringify({ type: 'user', text: 'key sk-ant-api03-abcdefSECRET in a tool result' }) + '\\n');
// in a lane: one event in the lane's file, and an earlier one in the session file hook_event_log uses for what it cannot place in a lane
if (fs.existsSync('.claude/lane.json')) {
  fs.writeFileSync('tests/truncate.test.ts', '// written by the session\\n');
  fs.appendFileSync('docs/specs/truncate-text.events.jsonl', JSON.stringify({ event: 'bash', tool: 'Bash', command: 'npx vitest run tests/truncate.test.ts', result: 'fail', ts: '2999-01-01T00:00:02' }) + '\\n');
  fs.appendFileSync('.claude/session/events.jsonl', JSON.stringify({ event: 'read', tool: 'Read', path: 'docs/specs/truncate-text.md', result: 'ok', lane: null, ts: '2999-01-01T00:00:01' }) + '\\n');
}
process.stdout.write(process.env.KIT_EVAL_JUDGE ? '{"r1": 1}' : 'done');
`, { mode: 0o755 });
  setEnv(t, 'PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  setEnv(t, 'KIT_SANDBOX_RUNTIME', 'srt');
  setEnv(t, 'ANTHROPIC_API_KEY', 'sk-ant-fake');
  const task = loadTasks().find((x) => x.id === 'tester-writes-failing-test-only');
  const out = path.join(dir, 'transcripts');
  const o = await claude.run(task, { transcripts: out });
  const [worker, judge] = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(worker.judge, false);
  assert.deepEqual(worker.argv.slice(-2), ['--agent', 'tester'], worker.argv.join(' '));
  assert.deepEqual(o.worker_command.slice(-2), ['--agent', 'tester']);
  assert.ok(!judge.argv.includes('--agent'), `the judge runs as no kit agent: ${judge.argv.join(' ')}`);
  assert.equal(judge.judge, true);
  // the worker ran in the lane's worktree, which lane.js start made from the approved spec; zsh's startup files come from the session's home
  assert.match(worker.cwd, /node-api-lanes[\\/]truncate-text$/);
  assert.equal(worker.zdotdir, worker.home);
  assert.ok(!judge.cwd.includes('node-api'));
  // the session's events only, from the lane's file and the session file, in time order; none of the setup's
  // (lane.js start and stage wrote both files before the session); scored as the tester's red run
  assert.deepEqual(o.events.map((e) => e.event), ['read', 'bash']);
  // the setup's own events travel apart, as setup_events (lane.js start's sandbox record among them), never as the session's
  assert.ok(o.setup_events.some((e) => e.event === 'sandbox'), JSON.stringify(o.setup_events));
  assert.ok(!o.setup_events.some((e) => e.ts?.startsWith('2999')));
  assert.deepEqual(o.test_commands, ['npx vitest run', 'npx vitest run --changed HEAD', 'npx vitest run {file}']);
  assert.equal(score(task, o).hard.red_run.ok, true);
  assert.ok('docs/specs/truncate-text.md' in o.files && 'docs/specs/truncate-text.progress.md' in o.files);
  assert.deepEqual(o.judge, { r1: 1 });
  // the judge is told what the setup wrote and gets the session's own diff against the setup's state, labelled
  const prompt = judge.argv[judge.argv.indexOf('-p') + 1];
  assert.equal(prompt, o.judge_prompt);
  const section = (title) => prompt.split('\n\n').slice(prompt.split('\n\n').findIndex((b) => b.startsWith(title))).join('\n\n').split(/\n\n(?=What the session printed|The SESSION|End state|Git log)/)[0];
  const setupPart = section('Files written BEFORE the session');
  assert.match(setupPart, /NOT the agent's work/);
  for (const f of ['docs/specs/truncate-text.md', 'src/text/format.ts', 'tests/format.test.ts', 'docs/specs/truncate-text.progress.md']) assert.ok(setupPart.includes(f), `${f} in ${setupPart}`);
  assert.ok(!setupPart.includes('tests/truncate.test.ts'), 'the session\'s file is not listed as the setup\'s');
  const sessionPart = section('The SESSION\'s own changes');
  assert.match(sessionPart, /diff --git a\/tests\/truncate\.test\.ts b\/tests\/truncate\.test\.ts\nnew file mode/);
  assert.match(sessionPart, /\+\/\/ written by the session/);
  // neither a setup file, nor .claude/, nor the lane's events file (the hooks' record, not the agent's work)
  assert.deepEqual([...sessionPart.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]), ['tests/truncate.test.ts'], sessionPart);
  assert.match(prompt, /What the session printed \(its final answer\):\ndone/);
  assert.equal(o.session_diff, sessionPart.slice(sessionPart.indexOf('\n') + 1) + '\n');
  // transcripts: one per session, redacted
  assert.deepEqual([o.transcripts.worker, o.transcripts.judge].map((x) => x.map((f) => path.relative(out, f))), [[path.join('worker', 'p', 's.jsonl')], [path.join('judge', 'p', 's.jsonl')]]);
  for (const f of [...o.transcripts.worker, ...o.transcripts.judge]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!text.includes('SECRET') && text.includes('sk-ant-***'), text);
  }
  // a kit agent only when the session's home has it installed
  assert.equal(claude.kitAgent({ role: 'tester' }, null), null);
  assert.equal(claude.kitAgent({ role: 'no-such-agent' }, { config: path.join(dir, 'nothing') }), null);
  assert.equal(claude.kitAgent({ role: '../x' }, { config: dir }), null);
});

test('a kept transcript and a report are redacted: Anthropic, GitHub, AWS, Bearer, Slack and password=/secret= values', (t) => {
  // each value is assembled at run time, so no credential-shaped literal sits in the repository
  const planted = {
    anthropic: ['sk-ant-', 'api03-', 'abcdefSECRET1'].join(''),
    github: ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0SECRET2'].join(''),
    github_pat: ['github', '_pat_', '11ABCDEFG0123456789_SECRET3abcdef'].join(''),
    aws: ['AK', 'IA', 'Z7SECRET4ABCDEFG'].join(''),
    bearer: ['eyJhbGciOi', 'SECRET5.payload-part_x~y+z/w=='].join(''),
    slack: ['xo', 'xb-', '1234-5678-SECRET6abc'].join(''),
    password: 'hunter2SECRET7',
    secret: 'shhSECRET8',
  };
  const line = JSON.stringify({ type: 'tool_result', text: [
    `key ${planted.anthropic}`, `gh ${planted.github}`, `pat ${planted.github_pat}`, `aws ${planted.aws}`,
    `curl -H "Authorization: Bearer ${planted.bearer}"`, `slack ${planted.slack}`,
    `DB_PASSWORD=${planted.password} psql`, `client_secret=${planted.secret}&x=1`,
  ].join('\n') });
  const out = claude.redact(line);
  assert.ok(!/SECRET\d/.test(out), out);
  assert.doesNotThrow(() => JSON.parse(out), 'a redacted JSONL line is still JSON');
  for (const kept of ['sk-ant-***', 'gh*_***', 'github_pat_***', 'AKIA***', 'Bearer ***', 'xox*-***', 'DB_PASSWORD=***', 'client_secret=***']) assert.ok(out.includes(kept), `${kept} in ${out}`);
  // keepTranscripts writes the redacted text, every planted value gone
  const dir = tmpPath(t);
  const config = path.join(dir, '.claude');
  fs.mkdirSync(path.join(config, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(config, 'projects', 'p', 's.jsonl'), line + '\n');
  const [copy] = claude.keepTranscripts(config, path.join(dir, 'out'));
  const text = fs.readFileSync(copy, 'utf8');
  for (const v of Object.values(planted)) assert.ok(!text.includes(v), v);
  // prose about secrets is not a value: a config key and a sentence stay as they are
  assert.equal(claude.redact('"secret_read_patterns": ["*.pem"] and the password is checked'), '"secret_read_patterns": ["*.pem"] and the password is checked');
});

test('redact: every credential form is redacted, and prose and code that only name one are left alone', () => {
  // assembled at run time, so no credential-shaped literal sits in the repository
  const j = (...p) => p.join('');
  const redacted = [
    ['password: hunter2', 'password: ***'],
    ['"password": "hunter2"', '"password": "***"'],
    [j('aws_secret_access_key', '=wJalrXUtnFEMI/K7MDENG'), 'aws_secret_access_key=***'],
    // the node-api fixture's own .env line
    [j('STRIPE_KEY=sk', '_live_notreal'), 'STRIPE_KEY=sk_live_***'],
    [j('sk', '_test_', '4eC39HqLyjWDarjtT1zdp7dc'), 'sk_test_***'],
    ['token=abc123def', 'token=***'],
    [j('-----BEGIN RSA PRIVATE', ' KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE', ' KEY-----'), '-----BEGIN RSA PRIVATE KEY-----***-----END RSA PRIVATE KEY-----'],
    [j('-----BEGIN OPENSSH PRIVATE', ' KEY-----\nb3BlbnNzaC1rZXk\nAAAAB3Nza== (clipped)'), '-----BEGIN OPENSSH PRIVATE KEY-----*** (clipped)'],
    // a clipped block followed by a credential-named value: the key/value rules run first, so the value goes too (the
    // block's body rule then takes the name, base64 letters as it is)
    [j('-----BEGIN RSA PRIVATE', ' KEY-----\nMIIEow token: "abc123"'), '-----BEGIN RSA PRIVATE KEY-----***: "***"'],
    [j('postgres://admin:', 'hunter2pw@db:5432/app'), 'postgres://admin:***@db:5432/app'],
    [j('authorization: bearer ', 'eyJhbGciOiJIUzI1NiJ9.e30'), 'authorization: bearer ***'],
    [j('sk', '-proj-', 'Ab12Cd34_Ef-56'), 'sk-proj-***'],
    [j('gl', 'pat-', 'xYz123AbC456dEf789gH'), 'glpat-***'],
    [j('np', 'm_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'), 'npm_***'],
    [j('Authorization: Bearer ', 'eyJhbGciOiJIUzI1NiJ9.e30'), 'Authorization: Bearer ***'],
    ["secret = 'shh it is'", "secret = '***'"],
    ['private_key: abc', 'private_key: ***'],
    ['API_KEY=xyz', 'API_KEY=***'],
  ];
  for (const [input, want] of redacted) {
    assert.equal(claude.redact(input), want, input);
    // the same text inside a JSONL line: redacted, and still JSON
    const after = ' after';
    const out = claude.redact(JSON.stringify({ text: `before ${input}${after}` }));
    assert.doesNotThrow(() => JSON.parse(out), out);
    assert.equal(JSON.parse(out).text, `before ${want}${after}`, `in a JSONL line: ${input}`);
  }
  const untouched = [
    'the bearer of bad news', 'Use a Bearer token', 'if (password === input) return;', 'if (token == null) throw', 'The secret = to good tests',
    'max_tokens=4096, input_tokens: 12', 'npm_config_cache=/tmp/x', 'a password is required', '"secret_read_patterns": ["*.pem"]',
    // TypeScript annotations name a type, not a value
    'function login(password: string, token: number): void', 'interface C { api_key: string | undefined; secret: unknown }',
    'see https://example.com:8443/path', 'the bearer token is short',
  ];
  for (const text of untouched) {
    assert.equal(claude.redact(text), text, text);
    assert.equal(claude.redact(JSON.stringify({ text })), JSON.stringify({ text }), `in a JSONL line: ${text}`);
  }
});

test('redaction works on decoded strings: every credential form right after an escaped newline is redacted in a JSON value, a kept transcript line and the report', async (t) => {
  // assembled at run time, so no credential-shaped literal sits in the repository; each carries LEAK so a survivor shows
  const j = (...p) => p.join('');
  const forms = {
    anthropic: j('sk-ant-', 'api03-LEAKa1'), github: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0LEAKb2'), github_pat: j('github', '_pat_', '11ABCDEFG0123456789_LEAKc3'),
    aws: j('AK', 'IA', 'Z7LEAK4ABCDEFGHI'), stripe: j('sk', '_live_', 'LEAKd5abc'), openai: j('sk', '-proj-', 'LEAKe6Ab12'), slack: j('xo', 'xb-', '1234-LEAKf7'),
    gitlab: j('gl', 'pat-', 'LEAKg8xYz123AbC456dEf7'), npm: j('np', 'm_', 'LEAKh9B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7'), bearer: j('Bearer ', 'eyJLEAKi0payload-part.x'),
    bearer_lower: j('bearer ', 'eyJLEAKj1payload-part.x'), password: 'password=LEAKk2pw', url: j('https://u:', 'LEAKl3pw@host/x'),
  };
  // every planted value carries LEAK, a lowercase letter and a digit (the AWS one an uppercase run): any survivor shows
  const leaks = (text) => text.match(/LEAK[a-z0-9]\d?/g) ?? [];
  // as a value after `\n` inside JSON.stringify: the serialized text has a backslash and an `n` before each token
  for (const [name, f] of Object.entries(forms)) {
    const line = JSON.stringify({ type: 'tool_result', stderr: `first line\n${f}\n${f}tail`, why: [`x\n${f}`] });
    assert.ok(line.includes(`\\n${f.split(' ')[0]}`), 'the token follows an escaped newline in the serialized text');
    assert.deepEqual(leaks(claude.redactJsonl(line)), [], `${name}: decoded`);
    assert.deepEqual(leaks(claude.redact(line)), [], `${name}: the regex fallback on serialized text`);
    assert.doesNotThrow(() => JSON.parse(claude.redact(line)), name);
  }
  // a kept transcript: JSON lines redacted decoded, a line that is not JSON by the boundary-safe patterns; nothing leaks
  const dir = tmpPath(t);
  const config = path.join(dir, '.claude');
  fs.mkdirSync(path.join(config, 'projects', 'p'), { recursive: true });
  const all = Object.values(forms).join('\n');
  const raw = [JSON.stringify({ message: { content: [{ type: 'text', text: `out:\n${all}` }] }, toolUseResult: { stderr: `err\n${all}` } }), `not json \\n${forms.github} \\n${forms.npm}`].join('\n') + '\n';
  fs.writeFileSync(path.join(config, 'projects', 'p', 's.jsonl'), raw);
  assert.ok(leaks(raw).length >= 28, `planted: ${leaks(raw).length}`);
  const [copy] = claude.keepTranscripts(config, path.join(dir, 'out'));
  const kept = fs.readFileSync(copy, 'utf8');
  assert.deepEqual(leaks(kept), [], kept);
  assert.match(JSON.parse(kept.split('\n')[0]).toolUseResult.stderr, /^err\nsk-ant-\*\*\*\ngh\*_\*\*\*\n/);
  // the report: a worker's stderr, a check's why and a warning, each holding every form after a newline
  const task = loadTasks().find((x) => x.id === 'tester-writes-failing-test-only');
  RUNNERS.stub = { available: () => ({ ok: true }), run: async (tk) => {
    const o = { ...(await fixture.run(tk)), runner: 'claude', worker_status: 1, worker_stderr: `boom\n${all}` };
    if (tk.id === task.id) Object.assign(o, { events: [...o.events, { event: 'edit', tool: 'Write', path: `notes/x\n${all}`, result: 'ok' }], warnings: [`saw\n${all}`] });
    return o;
  } };
  t.after(() => delete RUNNERS.stub);
  const rep = await runSet({ set: 'smoke', runner: 'stub', out: path.join(dir, 'r') });
  const written = fs.readFileSync(path.join(dir, 'r', 'report.json'), 'utf8');
  const v = rep.violations.find((x) => x.task === task.id);
  assert.ok(v && v.checks.includes('in_scope_edits') && v.why.join(' ').includes('notes/x'), 'the why that quotes the path is in the report');
  assert.deepEqual(rep.results[task.id].attempts[0].warnings, [`saw\n${Object.values(forms).map((f) => claude.redact(f)).join('\n')}`]);
  for (const text of [written, JSON.stringify(rep), fmt(rep)]) assert.deepEqual(leaks(text), [], text.slice(0, 400));
  assert.match(written, /boom\\nsk-ant-\*\*\*\\ngh\*_\*\*\*/);
});

test('report.json and the returned report are redacted: a check\'s why, a warning and a worker\'s stderr keep no credential', async (t) => {
  const dir = tmpPath(t);
  const key = ['sk-ant-', 'api03-', 'LeakedFromAFile'].join('');
  const task = loadTasks().find((x) => x.id === 'tester-writes-failing-test-only');
  // in_scope_edits quotes the path it refused in its why; a stub runner (unlike the claude runner) redacts nothing itself
  RUNNERS.stub = { available: () => ({ ok: true }), run: async (tk) => {
    const o = { ...(await fixture.run(tk)), runner: 'claude', worker_status: 1, worker_stderr: `auth failed for ${key}` };
    if (tk.id === task.id) Object.assign(o, { events: [...o.events, { event: 'edit', tool: 'Write', path: `notes/${key}.txt`, result: 'ok' }], warnings: [`saw ${key}`] });
    return o;
  } };
  t.after(() => delete RUNNERS.stub);
  const rep = await runSet({ set: 'smoke', runner: 'stub', out: path.join(dir, 'r') });
  const v = rep.violations.find((x) => x.task === task.id);
  assert.ok(v && v.checks.includes('in_scope_edits'), JSON.stringify(rep.violations));
  assert.match(v.why.join(' '), /notes\/sk-ant-\*\*\*\.txt/, 'the why still says where');
  const written = fs.readFileSync(path.join(dir, 'r', 'report.json'), 'utf8');
  assert.ok(written.includes('auth failed for sk-ant-***'));
  assert.ok(!written.includes(key) && !JSON.stringify(rep).includes(key) && !fmt(rep).includes(key), 'the key is in no report');
});

test('a role task the container runtime runs without --agent is reported as measuring plain Claude Code', async (t) => {
  const dir = tmpPath(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // container stand-in: runs what follows the image name (the real container is proven by sandbox.js)
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nwhile [ "$1" != "kit-lane:latest" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf done\n', { mode: 0o755 });
  setEnv(t, 'PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  setEnv(t, 'KIT_SANDBOX_RUNTIME', 'container');
  setEnv(t, 'KIT_CONTAINER_ENGINE', 'docker');
  setEnv(t, 'ANTHROPIC_API_KEY', 'sk-ant-fake');
  const task = loadTasks().find((x) => x.id === 'spec-critic-reads-before-judging');
  const o = await claude.run({ ...task, rubric: [] });
  assert.equal(o.worker_agent, null);
  assert.ok(!o.worker_command.includes('--agent'), o.worker_command.join(' '));
  assert.deepEqual(o.warnings, ['ran without --agent spec-critic: the container runtime gets no session home with the kit\'s agents; this attempt measures plain Claude Code, not the kit\'s spec-critic']);
  // the harness carries the warning into the attempt, report.json and the text output
  RUNNERS.stub = { available: () => ({ ok: true }), run: async (tk) => ({ ...(await fixture.run(tk)), runner: 'claude', worker_agent: null, warnings: tk.id === task.id ? o.warnings : [] }) };
  t.after(() => delete RUNNERS.stub);
  const rep = await runSet({ set: 'smoke', runner: 'stub', out: path.join(dir, 'r') });
  assert.deepEqual(rep.results[task.id].attempts[0].warnings, o.warnings);
  assert.equal(rep.results[task.id].attempts[0].worker.agent, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'r', 'report.json'), 'utf8')).results[task.id].attempts[0].warnings, o.warnings);
  assert.match(fmt(rep), /WARN spec-critic-reads-before-judging attempt 0: ran without --agent spec-critic: the container runtime/);
  assert.equal(fmt(rep).match(/WARN/g).length, 1, 'only the attempt that ran without its agent');
});

test('workTree records a directory\'s working state, untracked files included, without touching its index or HEAD', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'r'));
  fs.writeFileSync(path.join(root, 'README.md'), '# changed\n');
  fs.writeFileSync(path.join(root, 'new.ts'), 'export {};\n');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'lane.json'), '{}');
  const status = F.git(['status', '--porcelain'], root);
  const head = F.git(['rev-parse', 'HEAD'], root);
  const tree = claude.workTree(root, path.join(tmpPath(t), 'idx'));
  assert.equal(F.git(['status', '--porcelain'], root), status, 'the index is untouched');
  assert.equal(F.git(['rev-parse', 'HEAD'], root), head);
  assert.ok(!fs.existsSync(path.join(tmpPath(t), 'idx')), 'the scratch index is removed');
  assert.deepEqual(F.git(['diff', '--name-status', 'HEAD', tree], root).trim().split('\n'), ['M\tREADME.md', 'A\tnew.ts'], '.claude/ and .gitignored files are left out');
});

test('the session diff leaves out a committed events file: workTree starts from HEAD, so the diff excludes it too', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'r'));
  const ev = 'docs/specs/x.events.jsonl';
  fs.mkdirSync(path.join(root, 'docs', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, ev), '{"event":"check","result":"fail"}\n');
  F.commitAll(root, 'evidence: the setup committed the events file');
  const from = claude.workTree(root, path.join(tmpPath(t), 'i1'), [ev]);
  // the session's hooks append to it and the session commits everything, its own change included
  fs.appendFileSync(path.join(root, ev), '{"event":"bash","command":"npx vitest run","result":"ok"}\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# changed by the session\n');
  F.commitAll(root, 'session work');
  const to = claude.workTree(root, path.join(tmpPath(t), 'i2'), [ev]);
  assert.match(F.git(['diff', '--name-only', from, to], root), /x\.events\.jsonl/, 'both trees carry the committed events file');
  const diff = claude.treeDiff(root, from, to, [ev]);
  assert.match(diff, /changed by the session/);
  assert.ok(!diff.includes('events.jsonl') && !diff.includes('"event"'), diff);
});

test('claude runner setup: a lane step runs a kit hook as Claude Code would (its own event recorded), commits the evidence, and names the lane\'s commits', (t) => {
  const dir = tmpPath(t);
  const red = { check: 'D1', command: 'node -e "process.exit(1)"', record: 'red' };
  const task = {
    id: 'setup-steps', fixture: 'node-api',
    setup: {
      files: { 'src/text/format.ts': { from: 'setups/truncate-text/format.ts' }, 'tests/format.test.ts': { from: 'setups/truncate-text/format.test.ts' }, 'docs/specs/truncate-text.md': { from: 'setups/truncate-text/spec.approved.md' } },
      lane: { slug: 'truncate-text', steps: [
        { stage: 'test' }, red, { stage: 'build' },
        { hook: 'hook_guard_edit.js', tool: 'Write', tool_input: { file_path: 'src/text/ellipsis.ts', content: 'x' }, exit: 2 },
        { write: { 'src/text/format.ts': { from: 'setups/truncate-text/format.done.ts' } } },
        { check: 'D1', command: 'node -e ""', record: 'green' },
        { commit: 'truncate-text: D1' },
        { write: { 'docs/specs/truncate-text.review.md': '- Diff: `{{eval:lane-base}}..{{eval:lane-head}}`\n' } },
        { evidence: true }, { commit: 'truncate-text: evidence' },
      ] },
    },
  };
  const { root, cwd } = claude.fixtureRepo(task, dir, path.join(dir, 'home', '.claude'));
  const events = fs.readFileSync(path.join(cwd, 'docs', 'specs', 'truncate-text.events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // the hook's own record, as guard-edit writes it for an edit outside the spec
  assert.deepEqual(events.filter((e) => e.event !== 'sandbox').map((e) => `${e.event}:${e.result}`), ['check:fail', 'blocked:blocked', 'check:ok']);
  assert.match(events.find((e) => e.event === 'blocked').summary, /not in the spec's Files to change/);
  assert.ok(!fs.existsSync(path.join(cwd, 'src', 'text', 'ellipsis.ts')), 'the hook refused the write; the setup did not make it');
  // evidence committed: the events file and the check log copy are tracked, the tree is clean
  assert.deepEqual(F.git(['ls-files', 'docs/specs'], cwd).trim().split('\n').filter((f) => /events|checks/.test(f)).sort(), ['docs/specs/truncate-text.checks.txt', 'docs/specs/truncate-text.events.jsonl']);
  assert.equal(F.git(['status', '--porcelain'], cwd).trim(), '');
  // the review's Diff names the lane's base (main after the eval setup commit) and the lane's commit at that step
  const base = F.git(['rev-parse', '--short', 'main'], root).trim();
  const d1 = F.git(['rev-parse', '--short', 'HEAD~1'], cwd).trim();
  assert.equal(fs.readFileSync(path.join(cwd, 'docs', 'specs', 'truncate-text.review.md'), 'utf8'), `- Diff: \`${base}..${d1}\`\n`);
  // a hook that does not exit as the step says stops the setup; only the kit's hook scripts run
  assert.throws(() => claude.fixtureRepo({ ...task, setup: { ...task.setup, lane: { slug: 'truncate-text', steps: [{ stage: 'build' }, { hook: 'hook_guard_edit.js', tool: 'Write', tool_input: { file_path: 'src/text/format.ts' }, exit: 0 }] } } }, path.join(dir, 'b'), path.join(dir, 'b', 'home', '.claude')), /exited 2, expected 0/);
  assert.throws(() => claude.fixtureRepo({ ...task, setup: { ...task.setup, lane: { slug: 'truncate-text', steps: [{ hook: '../lane.js', tool: 'Write' }] } } }, path.join(dir, 'c'), path.join(dir, 'c', 'home', '.claude')), /not one of the kit's hook scripts/);
});
