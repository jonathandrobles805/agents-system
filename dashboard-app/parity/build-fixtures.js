#!/usr/bin/env node
// Ground-truth data for the parity harness (register #77). Every file here is produced by the kit's own code:
// planted-faults/make_fixtures.js for the repositories, bootstrap.js to set them up, lane.js to start lanes, and the
// real hook scripts (hook_event_log.js, hook_guard_edit.js) fed Claude Code's hook JSON to write the event logs.
// The only hand edits are the ones a human makes in the real flow and that the kit's own tests make the same way:
// ROADMAP rows, approving or not approving a spec, an escalation in progress.md, a review report.
//
//   node dashboard-app/parity/build-fixtures.js [OUT]     default: dashboard-app/parity/.data
//
// Writes OUT/fixture.json: the kit commit, the build time, every repo path and its HEAD.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const KIT = path.join(REPO, 'kit');
const SCRIPTS = path.join(KIT, 'scripts');
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, '.data'));

process.env.CLAUDE_HOME = path.join(OUT, 'claude-home');
process.env.KIT_STATUS_NO_GH = '1';

const { approveSpec, commitAll, git } = await import(path.join(SCRIPTS, 'tests', 'fixtures.js'));
const { spec, review, write } = await import(path.join(SCRIPTS, 'tests', 'testdata.js'));

function run(script, args, { stdin, cwd, ok = true } = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { input: stdin, cwd, encoding: 'utf8', env: process.env });
  if (ok && r.status !== 0) throw new Error(`${script} ${args.join(' ')} → ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}

/** One Claude Code hook call, exactly the JSON the CLI sends on stdin. */
function hook(script, payload) {
  return run(script, [], { stdin: JSON.stringify({ session_id: 'parity-fixture', ...payload }), cwd: payload.cwd, ok: false });
}

function setup(root, rows, { wip = 3, commands = null } = {}) {
  run('bootstrap.js', ['--repo', root]);
  const kj = path.join(root, '.claude', 'kit.json');
  const d = JSON.parse(fs.readFileSync(kj, 'utf8'));
  d.wip_limit = wip;
  d.local_only = true; // the fixtures have no remote; they say so (as kit/scripts/tests/testdata.js does)
  if (commands) d.commands = { ...d.commands, ...commands };
  fs.writeFileSync(kj, JSON.stringify(d, null, 2) + '\n');
  const rm = path.join(root, 'ROADMAP.md');
  fs.writeFileSync(rm, fs.readFileSync(rm, 'utf8').replaceAll(
    '| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |',
    rows.map(([feature, slug]) => `| ${feature} | ${slug} | M1 | queued | — | — | — |`).join('\n'),
  ));
  return commitAll(root, 'bootstrap');
}

/** The kit's approved "Refund route" spec, renamed to `slug` / `feature`; unapproved when `approved` is false. */
function writeSpec(root, slug, feature, commit, { approved = true } = {}) {
  let text = spec({ commit: commit.slice(0, 7) }).replaceAll('refund-route', slug).replaceAll('Refund route', feature);
  // lane.js refuses two active specs that change the same files; each feature gets its own route and test file.
  // Only the files to change are renamed; the [verified: …] citations still point at code that exists.
  if (slug !== 'refund-route') text = text.replaceAll('`src/api/routes.ts`', `\`src/api/${slug}.ts\``).replaceAll('tests/routes.test.ts', `tests/${slug}.test.ts`);
  if (!approved) text = text.replace(/Approved by: .* on .* at \w+/, 'Approved by: — on — at —');
  write(root, `docs/specs/${slug}.md`, text);
}

function startLane(root, slug) {
  return JSON.parse(run('lane.js', ['start', slug, '--repo', root]).stdout).worktree;
}

// The kit's own lane tests' test-log runs (kit/scripts/tests/lane.test.js, LOG_RED and LOG_GREEN), read the way GOAL
// is read below. Each round lane cites them from progress.md, as lane.test.js atReview does.
const LANE_TEST = fs.readFileSync(path.join(SCRIPTS, 'tests', 'lane.test.js'), 'utf8');
const LOG_RED = JSON.parse(LANE_TEST.match(/const LOG_RED = ('.*');/)[1].replaceAll("'", '"'));
const LOG_GREEN = JSON.parse(LANE_TEST.match(/const LOG_GREEN = ('.*');/)[1].replaceAll("'", '"'));

/** `lane.js advance`; `code` is the exit the move must give (2: refused, which is how advance parks a lane). */
function advance(root, slug, to, code = 0) {
  const r = run('lane.js', ['advance', slug, to, '--repo', root], { ok: false });
  if (r.status !== code) throw new Error(`lane.js advance ${slug} ${to} → ${r.status}, expected ${code}\n${r.stdout}\n${r.stderr}`);
  return r;
}

/** `lane.js gate`, which must PASS: every check is recorded as off in kit.json (CI_GATE_OFF below). */
function gate(root, slug) {
  const r = run('lane.js', ['gate', slug, '--repo', root], { ok: false });
  if (r.status !== 0) throw new Error(`lane.js gate ${slug} → ${r.status}\n${r.stdout}\n${r.stderr}`);
}

/**
 * A started lane taken to review through lane.js, the path kit/scripts/tests/lane.test.js atReview takes: advance to
 * test, the red and green runs logged and cited, advance to build, the gate, advance to review.
 */
function toReview(root, wt, slug) {
  advance(root, slug, 'test');
  write(wt, `.claude/session/${slug}.log`, LOG_RED + LOG_GREEN);
  const prog = path.join(wt, 'docs', 'specs', `${slug}.progress.md`);
  fs.writeFileSync(prog, fs.readFileSync(prog, 'utf8').replaceAll('| — | — |', `| ${slug}.log#1 | ${slug}.log#4 |`));
  advance(root, slug, 'build');
  gate(root, slug);
  advance(root, slug, 'review');
}

/** One review FAIL round: review → build (counted by advance), then the gate and back to review. */
function failRound(root, slug) {
  advance(root, slug, 'build');
  gate(root, slug);
  advance(root, slug, 'review');
}

// lane.js gate runs every check kit.json records on the base. The fixture repos have no installed dependencies, so
// node-api records each check as off, with its reason, the way a project turns a check off ("none: <reason>").
const CI_GATE_OFF = Object.fromEntries(['test', 'coverage', 'format', 'integration', 'typecheck', 'lint', 'boundaries', 'audit', 'mutation']
  .map((n) => [n, 'none: parity fixture, no dependencies installed']));

// the kit checkout the server runs from (serve.js): remove the old one before wiping OUT, then prune
for (const t of ['original', 'react']) {
  const wt = path.join(OUT, `kit-${t}`);
  if (fs.existsSync(wt)) execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: REPO });
}
fs.rmSync(OUT, { recursive: true, force: true });
execFileSync('git', ['worktree', 'prune'], { cwd: REPO });
fs.mkdirSync(process.env.CLAUDE_HOME, { recursive: true });
execFileSync(process.execPath, [path.join(REPO, 'planted-faults', 'make_fixtures.js'), path.join(OUT, 'repos')], { stdio: 'inherit' });

const nodeApi = path.join(OUT, 'repos', 'node-api');
const pySvc = path.join(OUT, 'repos', 'python-service');

// node-api: one lane per position the Worktrees screen draws.
let c = setup(nodeApi, [
  ['Refund route', 'refund-route'], ['Export CSV', 'export-csv'], ['Audit log', 'audit-log'],
  ['Rate limits', 'rate-limits'], ['Other', 'other'],
], { wip: 3 });
writeSpec(nodeApi, 'refund-route', 'Refund route', c);
writeSpec(nodeApi, 'export-csv', 'Export CSV', c);
writeSpec(nodeApi, 'audit-log', 'Audit log', c);
writeSpec(nodeApi, 'rate-limits', 'Rate limits', c, { approved: false });
c = commitAll(nodeApi, 'specs');
// lane.js start needs the approval recorded in the lane store, which kit lane merge --pr writes when the owner merges
// the spec PR on GitHub. The fixtures have no remote, so this uses the kit's own tests' stand-in for that merge
// (kit/scripts/tests/fixtures.js approveSpec, which calls lane.js recordSpecApproval). rate-limits stays unapproved.
for (const slug of ['refund-route', 'export-csv', 'audit-log']) approveSpec(nodeApi, slug, { commit: c });

const wtRefund = startLane(nodeApi, 'refund-route'); // building, with events
const wtExport = startLane(nodeApi, 'export-csv'); // escalated
const wtAudit = startLane(nodeApi, 'audit-log'); // in review

// refund-route: real hook calls inside the worktree.
const P = (wt, rel) => path.join(wt, rel);
hook('hook_event_log.js', { hook_event_name: 'SubagentStart', agent_type: 'implementer', cwd: wtRefund });
hook('hook_event_log.js', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: P(wtRefund, 'src/domain/payment.ts') }, tool_response: { content: 'export class PaymentService {' }, cwd: wtRefund });
hook('hook_event_log.js', { hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'refund' }, tool_response: { content: 'src/domain/payment.ts' }, cwd: wtRefund });
const blocked = hook('hook_guard_edit.js', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: P(wtRefund, 'src/routes/refund.ts') }, cwd: wtRefund });
hook('hook_event_log.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: '2 passing' }, cwd: wtRefund });
hook('hook_event_log.js', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm run typecheck' }, error: 'src/routes/refund.ts(4,1): error TS2304', cwd: wtRefund });
hook('hook_event_log.js', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: P(wtRefund, 'src/domain/payment.ts') }, tool_response: { message: 'ok' }, cwd: wtRefund });

// export-csv: escalated, the way the kit's own dashboard test escalates a lane (dashboard.test.js:131-134).
const prog = P(wtExport, 'docs/specs/export-csv.progress.md');
fs.writeFileSync(prog, fs.readFileSync(prog, 'utf8').replaceAll('- Attempts: {{n}} of 3', '- Attempts: 3 of 3').replaceAll('- Failure: {{what fails}}', '- Failure: mock never called'));
hook('hook_event_log.js', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: P(wtExport, 'src/domain/payment.ts') }, tool_response: { content: 'export' }, cwd: wtExport });

// audit-log: a review report at the lane's HEAD.
const head = git(['rev-parse', 'HEAD'], wtAudit).trim();
write(wtAudit, 'docs/specs/audit-log.review.md', review({ head: head.slice(0, 7), verdict: 'CHANGES' }).replaceAll('refund-route', 'audit-log'));

// Goal files, what /zi-start writes: without one, lane.js next-step answers "start" for a lane and the System view
// shows no running or next-up agent (register #20, #47). The text is the kit's own test goal
// (kit/scripts/tests/lane.test.js, const GOAL), renamed per lane.
const GOAL = fs.readFileSync(path.join(SCRIPTS, 'tests', 'lane.test.js'), 'utf8').match(/const GOAL = `([\s\S]*?)`;/)[1];
write(nodeApi, 'docs/goals/refund-route.md', GOAL);
write(nodeApi, 'docs/goals/audit-log.md', GOAL.replaceAll('refund-route', 'audit-log').replaceAll('Refund route', 'Audit log'));

// python-service: second project, one unapproved spec, nothing started.
c = setup(pySvc, [['Billing export', 'billing-export'], ['Health check', 'health-check']], { wip: 2 });
writeSpec(pySvc, 'billing-export', 'Billing export', c, { approved: false });
commitAll(pySvc, 'specs');

// rounds-api: a third project for review rounds (#126), served alone (scenario 'rounds'), so node-api and
// python-service, which the interaction tests read, are as they were. It is the planted-faults node-api repository in
// a directory of its own, so the project is named rounds-api. All through lane.js: advance counts each review → build
// move and parks the lane when another round would pass max_rounds.
execFileSync(process.execPath, [path.join(REPO, 'planted-faults', 'make_fixtures.js'), path.join(OUT, 'repos-rounds')], { stdio: 'ignore' });
const rounds = path.join(OUT, 'repos-rounds', 'rounds-api');
fs.renameSync(path.join(OUT, 'repos-rounds', 'node-api'), rounds);
fs.rmSync(path.join(OUT, 'repos-rounds', 'python-service'), { recursive: true, force: true });
c = setup(rounds, [['Search index', 'search-index'], ['Webhooks', 'webhooks']], { wip: 2, commands: CI_GATE_OFF });
writeSpec(rounds, 'search-index', 'Search index', c);
writeSpec(rounds, 'webhooks', 'Webhooks', c);
c = commitAll(rounds, 'specs');
for (const slug of ['search-index', 'webhooks']) approveSpec(rounds, slug, { commit: c });
const wtSearch = startLane(rounds, 'search-index'); // back at build after one review FAIL: round 2 of 3
const wtHooks = startLane(rounds, 'webhooks'); // parked: a third review FAIL would start round 4 of 3
toReview(rounds, wtSearch, 'search-index');
advance(rounds, 'search-index', 'build');
toReview(rounds, wtHooks, 'webhooks');
failRound(rounds, 'webhooks');
failRound(rounds, 'webhooks');
if (!/review → build refused: the lane is parked/.test(advance(rounds, 'webhooks', 'build', 2).stderr)) throw new Error('webhooks did not park');

// board-api: the Board's cases (hardening plan Step 10; scenario 'board', served by this checkout's own kit), all through
// the kit's scripts: an agent running (hook events with agent_id, a start and no stop), a gate PASS, a stale gate (a
// commit after the PASS), a FAIL round then a PASS round (lane.js gate on a committed FAIL file, then without it), a
// parked lane, a lane that needs the owner (an unapproved spec), cost hidden (telemetry.show_cost is off), and lanes with
// no events. Its checks are `test ! -e FAIL`, run with no sandbox runtime and the owner's waiver for the high-risk
// fixture spec, as kit/scripts/tests/gate.test.js runs them.
const board = path.join(OUT, 'repos-board', 'board-api');
{
  execFileSync(process.execPath, [path.join(REPO, 'planted-faults', 'make_fixtures.js'), path.join(OUT, 'repos-board')], { stdio: 'ignore' });
  fs.renameSync(path.join(OUT, 'repos-board', 'node-api'), board);
  fs.rmSync(path.join(OUT, 'repos-board', 'python-service'), { recursive: true, force: true });
  const runtime = process.env.KIT_SANDBOX_RUNTIME;
  process.env.KIT_SANDBOX_RUNTIME = 'none';
  const checks = Object.fromEntries(Object.keys(CI_GATE_OFF).map((n) => [n, 'test ! -e FAIL']));
  const slugs = [['Running agent', 'running'], ['Gate passed', 'gated'], ['Stale gate', 'stale'], ['Two rounds', 'rounds'], ['Parked lane', 'parked'], ['Billing', 'billing']];
  c = setup(board, slugs, { wip: 6, commands: checks });
  const kj = path.join(board, '.claude', 'kit.json');
  const kd = JSON.parse(fs.readFileSync(kj, 'utf8'));
  kd.sandbox = { ...(kd.sandbox ?? {}), high_risk_waiver: { by: 'parity fixture', reason: 'the fixture runs its gate checks without a sandbox runtime' } };
  fs.writeFileSync(kj, JSON.stringify(kd, null, 2) + '\n');
  c = commitAll(board, 'kit.json: the waiver');
  for (const [feature, slug] of slugs) writeSpec(board, slug, feature, c, { approved: slug !== 'billing' });
  c = commitAll(board, 'specs');
  for (const [, slug] of slugs) if (slug !== 'billing') approveSpec(board, slug, { commit: c });
  const wt = Object.fromEntries(slugs.filter(([, sl]) => sl !== 'billing').map(([, sl]) => [sl, startLane(board, sl)]));
  // goal files, as /zi-start writes them (see GOAL above): without one, next-step answers 'start' for every lane
  for (const [feature, slug] of slugs) write(board, `docs/goals/${slug}.md`, GOAL.replaceAll('refund-route', slug).replaceAll('Refund route', feature));
  // an agent running: the event-log hook fed a subagent's start, then one of its tool calls; no stop
  const sub = { agent_id: 'a1b2c3d4e5f60718', agent_type: 'implementer' };
  hook('hook_event_log.js', { hook_event_name: 'SubagentStart', cwd: wt.running, ...sub });
  hook('hook_event_log.js', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(wt.running, 'src/domain/payment.ts') }, tool_response: { content: 'export' }, cwd: wt.running, ...sub });
  gate(board, 'gated');
  gate(board, 'stale');
  fs.writeFileSync(path.join(wt.stale, 'NOTES.md'), 'a commit after the gate\n');
  commitAll(wt.stale, 'after the gate');
  fs.writeFileSync(path.join(wt.rounds, 'FAIL'), 'the checks fail while this file exists\n');
  commitAll(wt.rounds, 'a failing change');
  const failed = run('lane.js', ['gate', 'rounds', '--repo', board], { ok: false });
  if (failed.status !== 1) throw new Error(`rounds: the first gate should FAIL: ${failed.status}\n${failed.stdout}`);
  fs.rmSync(path.join(wt.rounds, 'FAIL'));
  commitAll(wt.rounds, 'fixed');
  gate(board, 'rounds');
  toReview(board, wt.parked, 'parked');
  failRound(board, 'parked');
  failRound(board, 'parked');
  if (!/review → build refused: the lane is parked/.test(advance(board, 'parked', 'build', 2).stderr)) throw new Error('parked did not park');
  if (runtime === undefined) delete process.env.KIT_SANDBOX_RUNTIME; else process.env.KIT_SANDBOX_RUNTIME = runtime;
}

// a second checkout of node-api for the duplicate-name scenario (register #63)
const dup = path.join(OUT, 'repos-dup', 'node-api');
fs.mkdirSync(path.dirname(dup), { recursive: true });
execFileSync('git', ['clone', '-q', nodeApi, dup]);

// static mode: status.json written by the kit itself (the Pages job's command, kit/ci/github.yml:215)
const pages = path.join(OUT, 'pages');
fs.mkdirSync(pages, { recursive: true });
run('kit_status.js', ['--repo', nodeApi, '--out', path.join(pages, 'status.json')]);

// The original page is the kit at the commit this branch is based on: the parent of the commit that added
// dashboard-app/. Not HEAD: once the React build is committed, HEAD's kit/dashboard/index.html is that build, not
// the original. PARITY_KIT_COMMIT names another commit.
const gitOut = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const added = gitOut(['log', '--format=%H', '--diff-filter=A', '--', 'dashboard-app/package.json']).split('\n').at(-1);
const kitCommit = gitOut(['rev-parse', process.env.PARITY_KIT_COMMIT || `${added}^`]);
// The data above was written by this checkout's kit scripts and the server runs from kitCommit: they must be the
// same kit, apart from the page under test.
const drift = gitOut(['diff', '--name-only', kitCommit, '--', 'kit', ':!kit/dashboard/index.html', ':!kit/architecture.json']);
if (drift) throw new Error(`kit/ differs between this checkout and ${kitCommit.slice(0, 7)} (the original): ${drift.replaceAll('\n', ', ')}`);
// a clean checkout of the kit at that commit for the original build; the React build gets its own (serve.js)
execFileSync('git', ['worktree', 'add', '-q', '--detach', path.join(OUT, 'kit-original'), kitCommit], { cwd: REPO });
const heads = Object.fromEntries([nodeApi, pySvc, dup, rounds, wtRefund, wtExport, wtAudit, wtSearch, wtHooks].map((r) => [r, git(['rev-parse', 'HEAD'], r).trim()]));
const record = { kit_commit: kitCommit, built_at: new Date().toISOString(), guard_edit_exit: blocked.status, repos: { nodeApi, pySvc, dup, rounds, board }, worktrees: { wtRefund, wtExport, wtAudit, wtSearch, wtHooks }, heads };
fs.writeFileSync(path.join(OUT, 'fixture.json'), JSON.stringify(record, null, 2) + '\n');
process.stdout.write(JSON.stringify(record, null, 2) + '\n');
