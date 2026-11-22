import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonDumps } from '../kitlib.js';
import { nodeApi, pythonService, git, commitAll } from './fixtures.js';
import { runScript, setEnv, tmpPath } from './helpers.js';
import { toPythonEraKit } from './testdata.js';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRAG = JSON.parse(fs.readFileSync(path.join(KIT, 'hooks', 'settings.project.json'), 'utf8'));
const KIT_VERSION = fs.readFileSync(path.join(KIT, '..', 'VERSION'), 'utf8').trim();

const read = (root, ...rel) => fs.readFileSync(path.join(root, ...rel), 'utf8');
const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();

function boot(root, ...args) {
  const r = runScript('bootstrap.js', ['--repo', root, '--json', ...args]);
  assert.equal(r.returncode, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('detect node', (t) => {
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  const r = runScript('bootstrap.js', ['--repo', root, '--detect-only', '--json']);
  const det = JSON.parse(r.stdout).detection;
  assert.ok(JSON.stringify(det.stacks) === JSON.stringify(['node']) && det.frameworks.includes('Express'));
  assert.ok(det.commands.test.startsWith('npx vitest') && det.commands.typecheck.startsWith('npx tsc') && det.commands.lint.includes('eslint'));
  assert.ok(det.ci === 'github' && det.credential_files.includes('.env'));
  assert.ok('boundaries' in det.missing_tools && 'mutation' in det.missing_tools);
  assert.deepEqual(new Set(det.dirs.map((d) => d.dir)), new Set(['src', 'tests']));
});

test('detect python', (t) => {
  const root = pythonService(path.join(tmpPath(t), 'py'));
  const det = JSON.parse(runScript('bootstrap.js', ['--repo', root, '--detect-only', '--json']).stdout).detection;
  assert.ok(JSON.stringify(det.stacks) === JSON.stringify(['python']) && det.frameworks.includes('FastAPI'));
  assert.ok(det.commands.test.startsWith('python -m pytest') && det.commands.lint.includes('ruff') && det.commands.typecheck.includes('mypy'));
  assert.equal(det.ci, 'gitlab');
});

test('bootstrap generates project layer', (t) => {
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  const res = boot(root);
  for (const rel of ['CLAUDE.md', 'ROADMAP.md', 'ARCHITECTURE.md', 'DESIGN.md', 'LESSONS.md', 'docs/research/INDEX.md', 'docs/specs/README.md',
    'docs/decisions/0001-adopt-agent-kit.md', '.claude/kit.json', '.claude/settings.json', '.claude/kit-manifest.json', 'scripts/sync.sh', '.github/workflows/kit.yml']) {
    assert.ok(isFile(path.join(root, rel)), rel);
  }
  // no template placeholders survive; unknowns become TODO(bootstrap) markers
  for (const rel of ['CLAUDE.md', 'ROADMAP.md', 'ARCHITECTURE.md', 'DESIGN.md']) {
    const text = read(root, rel);
    assert.ok(!text.includes('{{'), rel);
  }
  assert.ok(read(root, 'ROADMAP.md').includes('TODO(bootstrap'));
  const kit = JSON.parse(read(root, '.claude', 'kit.json'));
  assert.ok(JSON.stringify(kit.stack) === JSON.stringify(['node']) && kit.wip_limit === 2 && kit.commands.test.startsWith('npx vitest'));
  const settings = JSON.parse(read(root, '.claude', 'settings.json'));
  assert.deepEqual(settings.hooks, FRAG.hooks);
  assert.ok(settings.permissions.deny.includes('Read(.env)'));
  assert.ok(fs.readFileSync(path.join(root, 'CLAUDE.md')).length <= kit.claude_md_cap_bytes);
  const gi = read(root, '.gitignore');
  assert.ok(gi.includes('.claude/session/') && gi.includes('.claude/lane.json'));
  assert.ok(fs.statSync(path.join(root, 'scripts', 'sync.sh')).mode & 0o111);
  const wf = read(root, '.github', 'workflows', 'kit.yml');
  assert.ok(wf.includes('npx vitest run') && wf.includes('ci_scope_diff.js') && !/(?<!\$)\{\{/.test(wf));
  assert.ok(res.questions.some((q) => q.id === 'roadmap') && res.questions.some((q) => q.id === 'credentials'));
});

test('bootstrap with answers fills roadmap and architecture', (t) => {
  const tmp = tmpPath(t);
  const root = pythonService(path.join(tmp, 'py'));
  const ans = path.join(tmp, 'answers.json');
  fs.writeFileSync(ans, jsonDumps({
    project: 'billing-svc', wip_limit: 1,
    milestones: [{ name: 'MVP', target: 'Dec 2026' }],
    features: [{ name: 'Refund endpoint', slug: 'refund-endpoint', milestone: 'M1' }, { name: 'Invoices', slug: 'invoices' }],
    layers: [{ name: 'api', dirs: ['app/api'], imports: 'domain' }, { name: 'domain', dirs: ['app'], imports: 'nothing in the app' }],
    invariants: ['app/domain never imports app/api'], high_risk_paths: ['app/billing.py'],
    commands: { test: 'python -m pytest -q tests' },
  }));
  const res = boot(root, '--answers', ans);
  const rm = read(root, 'ROADMAP.md');
  assert.ok(rm.includes('| M1 | MVP | Dec 2026 | planned |') && rm.includes('| Refund endpoint | refund-endpoint | M1 | queued |') && rm.includes('1. refund-endpoint\n2. invoices'));
  assert.ok(!rm.includes('TODO(bootstrap'));
  const arch = read(root, 'ARCHITECTURE.md');
  assert.ok(arch.includes('| api | `app/api` | domain |') && arch.includes('- [ ] app/domain never imports app/api') && arch.includes('- `app/billing.py`'));
  const kit = JSON.parse(read(root, '.claude', 'kit.json'));
  assert.ok(kit.wip_limit === 1 && kit.project === 'billing-svc' && kit.commands.test === 'python -m pytest -q tests' && JSON.stringify(kit.high_risk_paths) === JSON.stringify(['app/billing.py']));
  assert.ok(!res.questions.some((q) => ['roadmap', 'layers', 'wip_limit'].includes(q.id)));
});

test('bootstrap is idempotent and keeps human files', (t) => {
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), read(root, 'CLAUDE.md') + '\n## Team notes\n- we deploy on Fridays\n');
  const res = boot(root);
  assert.ok(res.skipped.includes('CLAUDE.md (exists, human-owned)'));
  assert.ok(read(root, 'CLAUDE.md').includes('we deploy on Fridays'));
  assert.ok(res.skipped.includes('.claude/settings.json (unchanged)'));
});

test('upgrade backs up kit files and touches only version stamp', (t) => {
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), read(root, 'CLAUDE.md').replaceAll(`agent-kit ${KIT_VERSION}`, 'agent-kit 0.0.9') + '\n## Team notes\n- keep\n');
  // simulate an older settings.json that needs refreshing
  const s = JSON.parse(read(root, '.claude', 'settings.json'));
  delete s.hooks.Stop;
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), jsonDumps(s));
  const res = boot(root, '--upgrade');
  assert.ok(res.backed_up.includes('.claude/settings.json'));
  assert.ok(fs.statSync(path.join(root, '.claude', 'backup')).isDirectory());
  assert.deepEqual(JSON.parse(read(root, '.claude', 'settings.json')).hooks, FRAG.hooks);
  const text = read(root, 'CLAUDE.md');
  assert.ok(text.includes('- keep') && text.includes(`agent-kit ${KIT_VERSION}`) && !text.includes('agent-kit 0.0.9'));
});

// ---------------- upgrade as a transaction (KIT-SPEC 11) ----------------

test('the backup is named for the version being replaced, not the one replacing it', (t) => {
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  const kj = path.join(root, '.claude', 'kit.json');
  const d = JSON.parse(read(root, '.claude', 'kit.json'));
  d.kit_version = '0.0.9'; // as an older kit left it
  fs.writeFileSync(kj, jsonDumps(d, { indent: 2 }));
  const res = boot(root, '--upgrade');
  assert.ok(res.backed_up.includes('.claude/kit.json'));
  assert.ok(isFile(path.join(root, '.claude', 'backup', '0.0.9', '.claude__kit.json')),
    'the directory names the version it holds');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'backup', KIT_VERSION)));
  // and what it holds is the previous content, not the new one
  assert.equal(JSON.parse(read(root, '.claude', 'backup', '0.0.9', '.claude__kit.json')).kit_version, '0.0.9');
  assert.equal(JSON.parse(read(root, '.claude', 'kit.json')).kit_version, KIT_VERSION);
});

test('an upgrade reports both project checks, before and after', (t) => {
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  const res = boot(root, '--upgrade');
  assert.deepEqual(res.checks.before.map((c) => c.name), ['guards-present', 'security-floor']);
  assert.deepEqual(res.checks.after.map((c) => c.name), ['guards-present', 'security-floor']);
  assert.ok(res.checks.after.every((c) => c.ok), JSON.stringify(res.checks.after));
  assert.equal(res.checks.regressed.length, 0);
  assert.equal(res.checks.restored, null, 'nothing to undo when nothing regressed');
});

test('a check that was already failing is reported, not restored', (t) => {
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  // the state every version bump is in: the project's settings no longer match the kit's fragment
  const s = JSON.parse(read(root, '.claude', 'settings.json'));
  delete s.hooks.PreToolUse;
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), jsonDumps(s));
  const before = runScript('ci_guards_present.js', ['--repo', root, '--kit', KIT]);
  assert.equal(before.returncode, 1, 'guards-present fails before the upgrade');

  const res = boot(root, '--upgrade'); // boot() asserts exit 0: an upgrade that fixes a check is a success
  assert.equal(res.checks.before.find((c) => c.name === 'guards-present').ok, false);
  assert.equal(res.checks.after.find((c) => c.name === 'guards-present').ok, true);
  assert.equal(res.checks.restored, null, 'fail -> ok is the point of upgrading, not a regression');
  assert.deepEqual(JSON.parse(read(root, '.claude', 'settings.json')).hooks, FRAG.hooks);
});

test('regressions() only fires on a check that passed before and fails after', async () => {
  const B = await import('../bootstrap.js');
  const c = (name, ok) => ({ name, ok, output: '' });
  const names = (before, after) => B.regressions(before, after).map((x) => x.name);
  assert.deepEqual(names([c('a', true)], [c('a', false)]), ['a'], 'ok -> fail is a regression');
  assert.deepEqual(names([c('a', false)], [c('a', false)]), [], 'fail -> fail is not');
  assert.deepEqual(names([c('a', false)], [c('a', true)]), [], 'fail -> ok is not');
  assert.deepEqual(names([c('a', true)], [c('a', true)]), [], 'ok -> ok is not');
  assert.deepEqual(names([c('a', true), c('b', true)], [c('a', true), c('b', false)]), ['b'], 'one of two');
  assert.deepEqual(names([], [c('a', false)]), [], 'a check with no baseline is not a regression');
});

test('restoreBackup puts the project back byte for byte and removes what the upgrade created', async (t) => {
  const B = await import('../bootstrap.js');
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  const kitJson = path.join(root, '.claude', 'kit.json');
  const d = JSON.parse(read(root, '.claude', 'kit.json'));
  d.kit_version = '0.0.9';
  d.wip_limit = 7; // a value the human set, which the upgrade carries forward
  fs.writeFileSync(kitJson, jsonDumps(d, { indent: 2 }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), read(root, 'CLAUDE.md').replaceAll(`agent-kit ${KIT_VERSION}`, 'agent-kit 0.0.9'));
  const bytesBefore = { 'CLAUDE.md': read(root, 'CLAUDE.md'), '.claude/kit.json': read(root, '.claude', 'kit.json') };
  // whatever state the project was in — this one is deliberately inconsistent, since kit.json was edited without
  // regenerating the manifest — a restore must return it to exactly that, not to a healthy one.
  const checksBefore = B.projectChecks(root).map((c) => c.ok);

  const res = boot(root, '--upgrade');
  assert.ok(res.backed_up.includes('CLAUDE.md'), 'a human-owned file whose stamp changed is backed up too');
  assert.ok(res.backed_up.includes('.claude/kit.json'));
  assert.notEqual(read(root, 'CLAUDE.md'), bytesBefore['CLAUDE.md'], 'the upgrade changed it');

  // a file this upgrade introduced, which has nothing to restore from
  const invented = path.join(root, '.claude', 'invented-by-the-new-kit.json');
  fs.writeFileSync(invented, '{}');

  const dir = path.join(root, '.claude', 'backup', '0.0.9');
  const done = B.restoreBackup(root, dir, res.backed_up, ['.claude/invented-by-the-new-kit.json']);
  for (const [rel, text] of Object.entries(bytesBefore)) {
    assert.equal(read(root, ...rel.split('/')), text, `${rel} is back byte for byte`);
  }
  assert.ok(!fs.existsSync(invented), 'the created file is gone');
  assert.ok(done.includes('.claude/invented-by-the-new-kit.json (removed)'));
  // the project is back where it was, check for check
  assert.deepEqual(B.projectChecks(root).map((c) => c.ok), checksBefore);
});

test('projectChecks runs the two read-only checks and nothing else', async (t) => {
  const B = await import('../bootstrap.js');
  assert.deepEqual(B.PROJECT_CHECKS.map((c) => c[1]), ['ci_guards_present.js', 'ci_security_floor.js']);
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  let checks = B.projectChecks(root);
  assert.deepEqual(checks.map((c) => c.ok), [false, false], 'an unbootstrapped project fails both');
  assert.match(checks[0].output, /settings\.json missing/);
  boot(root);
  checks = B.projectChecks(root);
  assert.deepEqual(checks.map((c) => c.ok), [true, true], JSON.stringify(checks));
  assert.match(checks[1].output, /effective permissions at or above floor/);
});

test('dry run writes nothing', (t) => {
  const root = pythonService(path.join(tmpPath(t), 'py'));
  const res = boot(root, '--dry-run');
  assert.ok(res.dry_run && res.written.length);
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')) && !fs.existsSync(path.join(root, '.claude', 'kit.json')));
});

test('not a git repo fails', (t) => {
  const tmp = tmpPath(t);
  fs.mkdirSync(path.join(tmp, 'x'));
  const r = runScript('bootstrap.js', ['--repo', path.join(tmp, 'x')]);
  assert.equal(r.returncode, 1);
});

test('drift question appears for stale branches', (t) => {
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  git(['checkout', '-q', '-b', 'old-feature'], root);
  git(['checkout', '-q', 'main'], root);
  for (let i = 0; i < 25; i++) {
    fs.writeFileSync(path.join(root, `f${i}.txt`), String(i));
    commitAll(root, `c${i}`);
  }
  const det = JSON.parse(runScript('bootstrap.js', ['--repo', root, '--detect-only', '--json']).stdout);
  assert.ok(det.questions.some((q) => q.id === 'drift'));
  assert.equal(det.detection.branches[0].behind, '25');
});

// ---------------- projects set up by the Python-era kit ----------------

test('upgrade moves a project set up by the Python kit onto node hooks', (t) => {
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  toPythonEraKit(root);
  commitAll(root, 'as the Python kit left it');
  const settings = path.join(root, '.claude', 'settings.json');
  assert.ok(fs.readFileSync(settings, 'utf8').includes('python3'));
  const r = runScript('bootstrap.js', ['--repo', root, '--upgrade']);
  assert.equal(r.returncode, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks, FRAG.hooks);
  for (const rel of ['.claude/settings.json', '.claude/kit.json', '.github/workflows/kit.yml']) {
    assert.ok(!fs.readFileSync(path.join(root, rel), 'utf8').includes('python3'), rel);
  }
  // the stale Python command is replaced by the current default, the launcher form (#63)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'kit.json'), 'utf8')).commands.boundaries, 'kit ci_boundaries_simple --repo .');
  assert.equal(runScript('ci_guards_present.js', ['--repo', root, '--kit', KIT]).returncode, 0);
});

test('check_projects warns about stale hooks until the project is upgraded', (t) => {
  setEnv(t, 'CLAUDE_HOME', tmpPath(t));
  const root = nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]); // registers the project in $CLAUDE_HOME/kit-projects.json
  assert.equal(runScript('check_projects.js', []).stdout, '');
  toPythonEraKit(root);
  let r = runScript('check_projects.js', []);
  assert.equal(r.returncode, 0);
  assert.ok(r.stdout.includes(`WARNING: ${root}`) && r.stdout.includes('hook_guard_edit.py') && r.stdout.includes('--upgrade'), r.stdout);
  assert.equal(runScript('bootstrap.js', ['--repo', root, '--upgrade']).returncode, 0);
  r = runScript('check_projects.js', []);
  assert.equal(r.stdout, '');
});

test('an upgrade owns only the kit\'s own allow rules: the old "$HOME" form, Bash(kit *) and rules naming a kit script (#63)', async () => {
  const { kitOwnedAllow } = await import('../bootstrap.js');
  for (const rule of ['Bash(node "$HOME/.claude/kit/scripts/*)', 'Bash(kit *)', 'Bash(kit lane next-step *)', 'Bash(kit lane)', 'Bash(kit kit_status)']) {
    assert.equal(kitOwnedAllow(rule), true, rule);
  }
  // another tool called `kit`, and anything that is not a kit script, stays the project's
  for (const rule of ['Bash(kit pack *)', 'Bash(kit nosuchscript *)', 'Bash(kit)', 'Bash(kit lane:*)', 'Bash(npm run lint)', 'Edit(/**)']) {
    assert.equal(kitOwnedAllow(rule), false, rule);
  }
});
