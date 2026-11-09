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
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), read(root, 'CLAUDE.md').replaceAll('agent-kit 0.1.0', 'agent-kit 0.0.9') + '\n## Team notes\n- keep\n');
  // simulate an older settings.json that needs refreshing
  const s = JSON.parse(read(root, '.claude', 'settings.json'));
  delete s.hooks.Stop;
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), jsonDumps(s));
  const res = boot(root, '--upgrade');
  assert.ok(res.backed_up.includes('.claude/settings.json'));
  assert.ok(fs.statSync(path.join(root, '.claude', 'backup')).isDirectory());
  assert.deepEqual(JSON.parse(read(root, '.claude', 'settings.json')).hooks, FRAG.hooks);
  const text = read(root, 'CLAUDE.md');
  assert.ok(text.includes('- keep') && text.includes('agent-kit 0.1.0') && !text.includes('agent-kit 0.0.9'));
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
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'kit.json'), 'utf8')).commands.boundaries.startsWith('node '));
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
