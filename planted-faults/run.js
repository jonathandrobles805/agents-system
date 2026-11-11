#!/usr/bin/env node
/**
 * Planted-fault suite: prove every gate catches the mistake it owns (KIT-SPEC section 10).
 *
 * Builds fresh fixture projects, plants each fault, drives the owning gate exactly as Claude Code or CI would
 * (hook JSON on stdin, or the CI script), and reports CAUGHT / MISSED per fault.
 *
 *   node planted-faults/run.js [--json] [--keep]
 * Exit 1 if any mechanical fault is missed. Faults whose gate is an agent's behavior or a project-installed tool
 * are reported as 'agent-level' / 'tool-level' with the mechanical part that was verified.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgumentParser } from '../kit/scripts/args.js';
import * as K from '../kit/scripts/kitlib.js';
import * as F from '../kit/scripts/tests/fixtures.js';
import { GOOD_RESEARCH, review as REVIEW, spec as SPEC } from '../kit/scripts/tests/testdata.js';

const ROOT = path.dirname(path.dirname(K.realResolve(fileURLToPath(import.meta.url))));
const SCRIPTS = path.join(ROOT, 'kit', 'scripts');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'; // for pytest on the Python fixture project (a target project, not the kit)
const RESULTS = [];

// the kit's scripts and `node --test` must not think they run inside an outer test runner
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const codePoints = (s) => Array.from(s);
const tail = (s, n) => codePoints(s).slice(-n).join('');
const head = (s, n) => codePoints(s).slice(0, n).join('');

/** tempfile.mkdtemp(prefix): 8 random characters after the prefix, mode 0700. */
function mkdtemp(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789_';
  for (;;) {
    let name = prefix;
    for (let i = 0; i < 8; i++) name += chars[randomInt(chars.length)];
    const dir = path.join(os.tmpdir(), name);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

const completed = (r) => ({ returncode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });

/** subprocess.run(..., capture_output=True, text=True) */
function sh(cmd, args, { cwd, input, env } = {}) {
  return completed(spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 }));
}

function run(script, args = [], { stdin, cwd, env = {} } = {}) {
  // the fixture spec is high-risk, so the suite runs lanes as if the container runtime were present; faults about the
  // degraded path pass KIT_SANDBOX_RUNTIME=none explicitly
  return sh(process.execPath, [path.join(SCRIPTS, script), ...args], { input: stdin, cwd, env: childEnv({ KIT_STATUS_NO_GH: '1', KIT_SANDBOX_RUNTIME: process.env.KIT_SANDBOX_RUNTIME ?? 'container', ...env }) });
}

function hook(script, payload) {
  return run(script, [], { stdin: K.jsonDumps(payload) });
}

function record(n, fault, gate, caught, evidence, level = 'mechanical') {
  RESULTS.push({ n, fault, gate, caught, evidence: head(evidence.trim(), 300), level });
}

function blocked(r) {
  if (r.returncode === 2) return true;
  try {
    return JSON.parse(r.stdout).decision === 'block';
  } catch {
    return false;
  }
}

/** subprocess.run(["git", ...], check=True) */
function gitCheck(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status ?? r.error})`);
}

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, text) => fs.writeFileSync(p, text);

function project(tmp, name = 'node-api') {
  const root = name === 'node-api' ? F.nodeApi(path.join(tmp, name)) : F.pythonService(path.join(tmp, name));
  run('bootstrap.js', ['--repo', root]);
  const rm = path.join(root, 'ROADMAP.md');
  write(
    rm,
    read(rm).replaceAll(
      '| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |',
      '| Refund route | refund-route | M1 | queued | — | — | — |\n| Other | other | M1 | queued | — | — | — |',
    ),
  );
  const commit = F.commitAll(root, 'bootstrap');
  write(path.join(root, 'docs', 'specs', 'refund-route.md'), SPEC({ commit: commit.slice(0, 7), deps: 'none', extra: '' }));
  F.commitAll(root, 'spec approved');
  const bare = path.join(tmp, `${name}-origin.git`);
  gitCheck(['init', '-q', '--bare', bare]);
  F.git(['remote', 'add', 'origin', bare], root);
  F.git(['push', '-q', '-u', 'origin', 'main'], root);
  return [root, commit];
}

function lane(root) {
  const out = JSON.parse(run('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  const wt = out.worktree;
  F.commitAll(wt, 'lane start: progress skeleton'); // so git reset --hard HEAD~1 below returns to a complete lane
  return [wt, { session_id: 'pf', cwd: wt }];
}

function readFile(base, f) {
  hook('hook_read_log.js', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: f } });
}

export function main(argv) {
  const ap = new ArgumentParser({ prog: 'run.js', description: 'options:\n  -h, --help  show this help message and exit\n  --json\n  --keep' });
  ap.usage = () => 'usage: run.js [-h] [--json] [--keep]';
  ap.addArgument('--json', { action: 'store_true' });
  ap.addArgument('--keep', { action: 'store_true' });
  const a = ap.parseArgs(argv);
  const tmp = mkdtemp('planted-');
  try {
    const [root, commit] = project(tmp);
    const [wt, base] = lane(root);

    // 1 edit a file never read
    let r = hook('hook_guard_edit.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/api/routes.ts' } });
    record(1, 'edit a file never read', 'guard-edit (PreToolUse)', r.returncode === 2, r.stderr);

    // 2 edit outside the spec: hook + CI scope-diff
    readFile(base, 'src/domain/payment.ts');
    r = hook('hook_guard_edit.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/domain/payment.ts' } });
    const payment = path.join(wt, 'src', 'domain', 'payment.ts');
    write(payment, '// creep\n' + read(payment));
    F.commitAll(wt, 'creep');
    let c = run('ci_scope_diff.js', ['--repo', wt, '--base', 'main']);
    record(2, 'edit a file outside the spec', 'guard-edit + ci_scope_diff', r.returncode === 2 && c.returncode === 1, r.stderr + ' | ' + c.stderr);
    F.git(['reset', '-q', '--hard', 'HEAD~1'], wt);

    // 3 delete an assertion to pass: post-edit-check + ci_test_count
    const t = path.join(wt, 'tests', 'payment.test.ts');
    write(t, read(t).replaceAll("expect(await s.refund('x')).toBe(1);", ''));
    const kj = path.join(root, '.claude', 'kit.json');
    const kit = JSON.parse(read(kj));
    kit.commands = { test: 'true' };
    write(kj, K.jsonDumps(kit));
    write(path.join(wt, '.claude', 'kit.json'), K.jsonDumps(kit));
    r = hook('hook_post_edit_check.js', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'tests/payment.test.ts' } });
    write(t, read(t).replaceAll("  it('refunds', async () => {\n    const s = new PaymentService({ charge: async () => 5, refund: async () => 1 });\n    \n  });\n", ''));
    F.commitAll(wt, 'drop test');
    c = run('ci_test_count.js', ['--repo', wt, '--base', 'main']);
    record(3, 'delete an assertion / a test to pass', 'post-edit-check + ci_test_count', blocked(r) && c.returncode === 1, (r.stdout !== '' ? r.stdout : r.stderr) + ' | ' + c.stderr);
    F.git(['reset', '-q', '--hard', 'HEAD~1'], wt);

    // 4 import across an architecture boundary
    const arch = path.join(wt, 'ARCHITECTURE.md');
    write(
      arch,
      read(arch).replaceAll(
        '| TODO(bootstrap: layer name) | `src` | TODO(bootstrap: may import from) |\n| TODO(bootstrap: layer name) | `tests` | TODO(bootstrap: may import from) |',
        '| api | `src/api` | domain |\n| domain | `src/domain` | nothing in the app |\n| tests | `tests` | api, domain |',
      ),
    );
    write(payment, "import { routes } from '../api/routes';\n" + read(payment));
    F.commitAll(wt, 'boundary violation');
    c = run('ci_boundaries_simple.js', ['--repo', wt]);
    record(4, 'import across an architecture boundary', 'ci_boundaries_simple (fallback) / project lint', c.returncode === 1, c.stderr);
    F.git(['reset', '-q', '--hard', 'HEAD~1'], wt);

    // 5 change a function, miss a caller (real pytest on the python fixture)
    const py = F.pythonService(path.join(tmp, 'python-service'));
    write(path.join(py, 'app', 'billing.py'), 'def total_amount(items: list[int]) -> int:\n    return sum(items)\n\n\ndef refund(amount: int) -> int:\n    return -amount\n');
    c = sh(PYTHON, ['-m', 'pytest', '-q'], { cwd: py });
    record(5, 'change a function, miss a caller', 'tests in post-edit-check hook + CI (pytest here)', c.returncode !== 0, tail(c.stdout, 300));

    // 6 research cites a line that does not exist
    write(
      path.join(root, 'docs', 'research', 'payment-charge.md'),
      GOOD_RESEARCH.replaceAll('[verified: src/payment.ts:3-5]', '[verified: src/domain/payment.ts:80-82]').replaceAll('src/routes.ts:3', 'src/api/routes.ts:3'),
    );
    r = run('validate_docs.js', ['--hook'], { stdin: K.jsonDumps({ hook_event_name: 'SubagentStop', cwd: root, agent_type: 'researcher' }) });
    record(6, 'research cites a line that does not exist', 'validate-docs on SubagentStop', r.returncode === 2 && r.stderr.includes('citation'), r.stderr);
    fs.unlinkSync(path.join(root, 'docs', 'research', 'payment-charge.md'));

    // 7 spec with an unresolved unknown
    const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
    const orig = read(sp);
    write(sp, orig.replaceAll('## Open questions\n\n- none', '## Open questions\n\n- is refund idempotent?'));
    r = run('lane.js', ['precheck', 'refund-route', '--repo', root]);
    record(7, 'spec with an unresolved unknown / open question', 'lane precheck before /implement', r.returncode === 2 && r.stderr.includes('open-questions'), r.stderr);
    write(sp, orig);

    // 8 undeclared dependency
    const pj = JSON.parse(read(path.join(wt, 'package.json')));
    pj.dependencies['left-pad'] = '^1.3.0';
    write(path.join(wt, 'package.json'), K.jsonDumps(pj, { indent: 2 }));
    F.commitAll(wt, 'add dep');
    c = run('ci_dep_diff.js', ['--repo', wt, '--base', 'main']);
    record(8, 'undeclared dependency added', 'ci_dep_diff', c.returncode === 1 && c.stderr.includes('left-pad'), c.stderr);
    F.git(['reset', '-q', '--hard', 'HEAD~1'], wt);

    // 9 secret committed
    write(path.join(wt, 'config.ts'), "export const k = 'sk_live_abcdefghijklmnopqrstuv';\n"); // kit:allow-secret
    gitCheck(['add', 'config.ts'], wt);
    r = hook('hook_guard_bash.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "git commit -m 'cfg'" } });
    record(9, 'secret committed', 'guard-bash on git commit (+ gitleaks in CI)', r.returncode === 2 && r.stderr.includes('secret'), r.stderr);
    spawnSync('git', ['reset', '-q', 'config.ts'], { cwd: wt, stdio: 'inherit' });
    fs.unlinkSync(path.join(wt, 'config.ts'));

    // 10 CLAUDE.md over cap
    const cm = path.join(root, 'CLAUDE.md');
    const keep = read(cm);
    write(cm, keep + 'x'.repeat(5000));
    c = run('ci_claude_md_cap.js', ['--repo', root]);
    record(10, 'CLAUDE.md over cap', 'ci_claude_md_cap', c.returncode === 1, c.stderr);
    write(cm, keep);

    // 11 hook removed from settings: ConfigChange in lane + guards-present in CI
    r = hook('hook_config_guard.js', { hook_event_name: 'ConfigChange', cwd: wt, source: 'project_settings' });
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const s = JSON.parse(read(settingsPath));
    if (!Object.hasOwn(s.hooks, 'PreToolUse')) throw new Error("KeyError: 'PreToolUse'");
    delete s.hooks.PreToolUse;
    write(settingsPath, K.jsonDumps(s));
    c = run('ci_guards_present.js', ['--repo', root, '--kit', path.join(ROOT, 'kit')]);
    record(11, 'hook removed from settings', 'config-guard (lane) + ci_guards_present', r.returncode === 2 && c.returncode === 1, r.stderr + ' | ' + c.stderr);
    run('bootstrap.js', ['--repo', root, '--upgrade']);

    // 12 implementer says done with a criterion still red
    const prog = path.join(wt, 'docs', 'specs', 'refund-route.progress.md');
    write(path.join(wt, 'docs', 'specs', 'refund-route.log'), '=== run\n1 failed\n');
    write(prog, read(prog).replaceAll('| — | — |', '| refund-route.log#1 | — |'));
    r = hook('hook_done_check.js', { ...base, hook_event_name: 'Stop', stop_hook_active: false });
    record(12, 'implementer stops with a criterion still red', 'done-check (Stop)', blocked(r) && r.stdout.includes('D1'), r.stdout);

    // 13 two specs list the same file
    write(
      path.join(root, 'docs', 'specs', 'other.md'),
      SPEC({ commit: commit.slice(0, 7), deps: 'none', extra: '' }).replaceAll('refund-route', 'other').replaceAll('Refund route', 'Other'),
    );
    run('lane.js', ['roadmap-set', 'other', 'building', '--repo', root]);
    r = run('lane.js', ['precheck', 'refund-route', '--repo', root]);
    record(13, 'two specs list the same file', 'planner overlap check (lane precheck)', r.returncode === 2 && r.stderr.includes('overlap'), r.stderr);
    fs.unlinkSync(path.join(root, 'docs', 'specs', 'other.md'));
    run('lane.js', ['roadmap-set', 'other', 'queued', '--repo', root]);

    // 14 reviewer writes PASS with no evidence
    const headSha = F.git(['rev-parse', 'HEAD'], wt).trim();
    const reviewPath = path.join(wt, 'docs', 'specs', 'refund-route.review.md');
    write(
      reviewPath,
      REVIEW({ head: headSha.slice(0, 10), verdict: 'PASS' }).replaceAll('| PASS | depcruise: 0 violations |', '| PASS | ok |').replaceAll('| PASS | tests/routes.test.ts:2 |', '| PASS | fine |'),
    );
    r = run('validate_docs.js', [reviewPath, '--repo', wt]);
    record(14, 'reviewer writes PASS with no evidence', 'validate-docs on review report', r.returncode === 2 && r.stderr.includes('no-evidence'), r.stderr);

    // 15 agent reads .env / key file
    r = hook('hook_guard_read.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '.env' } });
    const r2 = hook('hook_guard_read.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'deploy/server.pem' } });
    record(15, 'agent reads .env or a key file', 'guard-read (PreToolUse) + permissions.deny', r.returncode === 2 && r2.returncode === 2, r.stderr);

    // 16 budget exceeded
    const lj = path.join(wt, '.claude', 'lane.json');
    const d = JSON.parse(read(lj));
    d.budget = { tool_calls: 2, hours: 100 };
    write(lj, K.jsonDumps(d));
    for (let i = 0; i < 3; i++) {
      r = hook('hook_budget_check.js', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } });
    }
    record(16, 'lane exceeds its budget', 'budget-check (PostToolUse) + Escalation written', blocked(r) && read(prog).toLowerCase().includes('budget'), r.stdout);

    // 17 sync hits a merge conflict
    const mainRoutes = path.join(root, 'src', 'api', 'routes.ts');
    write(mainRoutes, '// main side\n' + read(mainRoutes));
    F.commitAll(root, 'main change');
    F.git(['push', '-q', 'origin', 'main'], root);
    const laneRoutes = path.join(wt, 'src', 'api', 'routes.ts');
    write(laneRoutes, '// lane side\n' + read(laneRoutes));
    F.commitAll(wt, 'lane change');
    c = sh('bash', ['scripts/sync.sh', 'main'], { cwd: wt, env: { ...process.env, ...F.GIT_ENV } });
    record(17, '/sync hits a merge conflict', 'sync.sh exit 3; second conflict escalates (command rule)', c.returncode === 3, c.stderr, 'mechanical + command-level');
    sh('git', ['merge', '--abort'], { cwd: wt });

    // 18 a kit script is broken -> kit's own CI (node --test) blocks release
    c = sh(process.execPath, ['--test', '--test-reporter=tap', path.join(SCRIPTS, 'tests', 'agents.test.js')], { env: childEnv() });
    const tap = (label) => Number((c.stdout.match(new RegExp(`^# ${label} (\\d+)$`, 'm')) ?? [])[1] ?? 0);
    const summary = `${tap('fail') ? `${tap('fail')} failed, ` : ''}${tap('pass')} passed in ${(Number((c.stdout.match(/^# duration_ms ([\d.]+)$/m) ?? [])[1] ?? 0) / 1000).toFixed(2)}s`;
    record(18, 'a kit script or agent definition is broken', 'kit CI: node --test over kit/scripts/tests', c.returncode === 0, c.returncode === 0 ? summary : `${summary}\n${tail(c.stdout, 120)}`, 'kit CI');

    // 19 vulnerable dependency -> audit tool configured by bootstrap
    const kitj = JSON.parse(read(path.join(root, '.claude', 'kit.json')));
    const wf = read(path.join(root, '.github', 'workflows', 'kit.yml'));
    record(19, 'dependency with a known vulnerability', 'audit job in project CI (npm audit / pip-audit / cargo audit / govulncheck)', Object.hasOwn(kitj.commands, 'audit') && wf.includes('audit:'), `audit command: ${kitj.commands.audit ?? 'None'}`, 'tool-level');

    // 21 agent reads a credential path with the project settings loosened as far as they go -> guard-read reads the floor, not settings
    //    (the sandbox half of this fault, denyRead, arrives with the launcher in step 2b)
    const sj = path.join(root, '.claude', 'settings.json');
    const settingsBefore = read(sj);
    const loosened = JSON.parse(settingsBefore);
    loosened.permissions = { allow: ['Read(**)'], deny: [] };
    write(sj, K.jsonDumps(loosened));
    r = hook('hook_guard_read.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, '.kube', 'config') } });
    record(21, 'agent reads a credential path while settings are loosened', 'guard-read reads kit/security/floor.json; sandbox denyRead carries the same paths (sandbox.js)', r.returncode === 2 && r.stderr.includes('secret/credential pattern'), r.stderr, 'mechanical');

    // 22 project settings loosen the floor's deny list -> ci_security_floor fails
    c = run('ci_security_floor.js', ['--repo', root, '--home', path.join(tmp, 'empty-home'), '--managed', path.join(tmp, 'no-managed.json')]);
    const caught22 = c.returncode === 1 && c.stderr.includes('missing floor entry') && c.stderr.includes('allows "Read(**)"');
    write(sj, settingsBefore);
    const c22ok = run('ci_security_floor.js', ['--repo', root, '--home', path.join(tmp, 'empty-home'), '--managed', path.join(tmp, 'no-managed.json')]);
    record(22, "project settings loosen the floor's deny list", 'ci_security_floor (project CI)', caught22 && c22ok.returncode === 0, caught22 ? c.stderr : `${c.stderr}\nrestored: ${c22ok.stderr}`);

    // 20 lane command reaches an undeclared host -> the sandbox's allowlist is exactly floor + spec; nothing else is reachable.
    //    Proven mechanically on the configuration (the runtime enforcement needs srt or a container on the machine: tool-level).
    const cfg = JSON.parse(run('sandbox.js', ['config', 'refund-route', '--repo', wt], { env: { KIT_SANDBOX_RUNTIME: 'srt' } }).stdout);
    const floorDomains = K.loadFloor().network.default_allow;
    const onlyDeclared = cfg.allowedDomains.every((d) => floorDomains.includes(d)) && !cfg.allowedDomains.includes('evil.example') && cfg.failIfUnavailable === true;
    record(20, 'lane command reaches an undeclared network host', 'sandbox allowlist = floor + spec Network section (verified on macOS: undeclared host → 403 host is not on the allow list)', onlyDeclared, `allowedDomains: ${cfg.allowedDomains.join(', ')}`, 'tool-level');

    // 23 no sandbox runtime available -> a normal lane is recorded `degraded`, a high-risk lane is refused
    const root23 = path.join(tmp, 'node-api-23');
    F.nodeApi(root23);
    run('bootstrap.js', ['--repo', root23]);
    const kj23 = path.join(root23, '.claude', 'kit.json');
    write(kj23, K.jsonDumps({ ...JSON.parse(read(kj23)), wip_limit: 2 }));
    write(path.join(root23, 'ROADMAP.md'), read(path.join(root23, 'ROADMAP.md')).replaceAll('| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |', '| Refund route | refund-route | M1 | queued | — | — | — |'));
    const c23 = F.commitAll(root23, 'bootstrap');
    write(path.join(root23, 'docs', 'specs', 'refund-route.md'), SPEC({ commit: c23.slice(0, 7) }));
    F.commitAll(root23, 'spec');
    r = run('lane.js', ['start', 'refund-route', '--repo', root23], { env: { KIT_SANDBOX_RUNTIME: 'none' } });
    const refusedHigh = r.returncode === 2 && r.stderr.includes('requires the container sandbox runtime') && !fs.existsSync(path.join(tmp, 'node-api-23-lanes', 'refund-route'));
    write(kj23, K.jsonDumps({ ...JSON.parse(read(kj23)), sandbox: { high_risk_waiver: { by: 'planted-fault', reason: 'prove the degraded state is recorded' } } }));
    r = run('lane.js', ['start', 'refund-route', '--repo', root23], { env: { KIT_SANDBOX_RUNTIME: 'none' } });
    const lj23 = path.join(tmp, 'node-api-23-lanes', 'refund-route', '.claude', 'lane.json');
    const degradedRecorded = r.returncode === 0 && fs.existsSync(lj23) && JSON.parse(read(lj23)).sandbox.state === 'degraded' && read(path.join(path.dirname(lj23), 'session', 'events.jsonl')).includes('DEGRADED') && r.stderr.includes('DEGRADED');
    record(23, 'lane started with no sandbox runtime available', 'lane.js start: high-risk refused; otherwise state `degraded` in lane.json, events and stderr', refusedHigh && degradedRecorded, `${r.stderr.trim().split('\n')[0]}`);

    // 24 the lane could read a value matching a floor credential pattern -> start refused, worktree removed
    run('lane.js', ['finish', 'refund-route', '--repo', root23]);
    write(path.join(root23, 'src', 'db.ts'), 'export const url = "postgres://app:S3cret@db.internal:5432/prod";\n');
    F.commitAll(root23, 'leak');
    r = run('lane.js', ['start', 'refund-route', '--repo', root23]);
    record(24, 'lane can read a value matching a floor credential pattern', 'lane.js start credential scan', r.returncode === 2 && r.stderr.includes('credential-looking content') && r.stderr.includes('src/db.ts:1') && !fs.existsSync(path.join(tmp, 'node-api-23-lanes', 'refund-route')), r.stderr);

    // 26 /bootstrap on a repo that already has a decisions folder -> adopted, never duplicated; a re-run writes nothing new
    const root26 = path.join(tmp, 'node-api-26');
    F.nodeApi(root26);
    fs.mkdirSync(path.join(root26, 'docs', 'adr'), { recursive: true });
    write(path.join(root26, 'docs', 'adr', '007-keep-monolith.md'), '# 007 Keep the monolith\n');
    run('bootstrap.js', ['--repo', root26]);
    const adrFiles = () => fs.readdirSync(path.join(root26, 'docs', 'adr')).sort();
    const first = adrFiles();
    const c26a = !fs.existsSync(path.join(root26, 'docs', 'decisions')) && first.includes('008-adopt-agent-kit.md') && JSON.parse(read(path.join(root26, '.claude', 'kit.json'))).paths.decisions === 'docs/adr';
    run('bootstrap.js', ['--repo', root26]);
    const c26b = JSON.stringify(adrFiles()) === JSON.stringify(first) && !fs.existsSync(path.join(root26, 'docs', 'decisions'));
    record(26, 'bootstrap on a repo that already has a decisions folder', 'bootstrap adopts the folder and its numbering; re-run is a no-op', c26a && c26b, `docs/adr: ${adrFiles().join(', ')}; docs/decisions exists: ${fs.existsSync(path.join(root26, 'docs', 'decisions'))}`);

    // 25 agent process restarted mid-stage -> next-step derived from files is identical across cold processes; resume logs it
    const s25a = run('lane.js', ['next-step', 'refund-route', '--repo', root]).stdout;
    const s25b = run('lane.js', ['next-step', 'refund-route', '--repo', root]).stdout;
    r = run('lane.js', ['resume', 'refund-route', '--repo', root]);
    const same25 = s25a === s25b && r.returncode === 0 && JSON.stringify(JSON.parse(r.stdout).next) === JSON.stringify(JSON.parse(s25a));
    record(25, 'agent process restarted mid-stage', 'lane.js next-step / resume from files alone', same25 && read(path.join(wt, '.claude', 'session', 'events.jsonl')).includes('"event": "resume"'), s25a.trim());

    // 27 lane artifact written outside docs/work (today docs/specs) -> guard-edit blocks in the lane; ci_lane_artifacts fails in CI
    r = hook('hook_guard_edit.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(wt, 'docs', 'notes', 'refund-route.progress.md'), content: 'x' } });
    const hookBlocked27 = r.returncode === 2 && r.stderr.includes('lane artifact outside');
    fs.mkdirSync(path.join(wt, 'docs', 'notes'), { recursive: true });
    write(path.join(wt, 'docs', 'notes', 'refund-route.progress.md'), '# stray\n');
    c = run('ci_lane_artifacts.js', ['--repo', wt]);
    fs.rmSync(path.join(wt, 'docs', 'notes'), { recursive: true, force: true });
    record(27, 'lane artifact written outside the artifact tree', 'guard-edit (PreToolUse) + ci_lane_artifacts (project CI)', hookBlocked27 && c.returncode === 1 && c.stderr.includes('lane artifact outside'), c.stderr);
  } finally {
    if (a.keep) process.stderr.write(`fixtures kept at ${tmp}\n`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }

  const mechanical = RESULTS.filter((x) => x.level.startsWith('mechanical'));
  const missed = RESULTS.filter((x) => !x.caught);
  if (a.json) {
    process.stdout.write(K.jsonDumps({ results: RESULTS, missed: missed.map((m) => m.n) }, { indent: 2 }) + '\n');
  } else {
    process.stdout.write(`${'#'.padStart(2)}  ${'result'.padEnd(7)} ${'level'.padEnd(22)} fault  →  gate\n`);
    for (const x of RESULTS) {
      process.stdout.write(`${String(x.n).padStart(2)}  ${(x.caught ? 'CAUGHT' : 'MISSED').padEnd(7)} ${x.level.padEnd(22)} ${x.fault}  →  ${x.gate}\n`);
    }
    process.stdout.write(`\n${RESULTS.length - missed.length}/${RESULTS.length} caught; ${mechanical.length} mechanical, ${RESULTS.length - mechanical.length} depend on a project tool, a command rule, or kit CI\n`);
    for (const m of missed) process.stderr.write(`MISSED ${m.n}: ${m.evidence}\n`);
  }
  return missed.length ? 1 : 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
