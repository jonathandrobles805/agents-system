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

const { commitAll, git } = await import(path.join(SCRIPTS, 'tests', 'fixtures.js'));
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

function setup(root, rows, { wip = 3 } = {}) {
  run('bootstrap.js', ['--repo', root]);
  const kj = path.join(root, '.claude', 'kit.json');
  const d = JSON.parse(fs.readFileSync(kj, 'utf8'));
  d.wip_limit = wip;
  d.local_only = true; // the fixtures have no remote; they say so (as kit/scripts/tests/testdata.js does)
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

// a second checkout of node-api for the duplicate-name scenario (register #63)
const dup = path.join(OUT, 'repos-dup', 'node-api');
fs.mkdirSync(path.dirname(dup), { recursive: true });
execFileSync('git', ['clone', '-q', nodeApi, dup]);

// static mode: status.json written by the kit itself (the Pages job's command, kit/ci/github.yml:215)
const pages = path.join(OUT, 'pages');
fs.mkdirSync(pages, { recursive: true });
run('kit_status.js', ['--repo', nodeApi, '--out', path.join(pages, 'status.json')]);

const kitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
// a clean checkout of the kit at that commit for the original build; the React build gets its own (serve.js)
execFileSync('git', ['worktree', 'add', '-q', '--detach', path.join(OUT, 'kit-original'), kitCommit], { cwd: REPO });
const heads = Object.fromEntries([nodeApi, pySvc, dup, wtRefund, wtExport, wtAudit].map((r) => [r, git(['rev-parse', 'HEAD'], r).trim()]));
const record = { kit_commit: kitCommit, built_at: new Date().toISOString(), guard_edit_exit: blocked.status, repos: { nodeApi, pySvc, dup }, worktrees: { wtRefund, wtExport, wtAudit }, heads };
fs.writeFileSync(path.join(OUT, 'fixture.json'), JSON.stringify(record, null, 2) + '\n');
process.stdout.write(JSON.stringify(record, null, 2) + '\n');
