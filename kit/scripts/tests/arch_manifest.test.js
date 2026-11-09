// Architecture manifest: what the generator reads from files, what it flags, and that it never changes without the files changing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as M from '../arch_manifest.js';
import * as Live from '../arch_live.js';
import * as S from '../../dashboard/server.js';
import { runScript, tmpPath } from './helpers.js';
import { project } from './testdata.js';

const REAL_KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNAPSHOT = path.join(REAL_KIT, M.SNAPSHOT_FILE);

function put(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const AGENT = `---
name: builder
description: Builds things.
tools: Edit, Write
model: opus
hooks:
  PreToolUse:
    - matcher: Edit|Write
      hooks:
        - type: command
          command: node "$HOME/.claude/kit/scripts/hook_guard.js"
          timeout: 30
  Stop:
    - hooks:
        - type: command
          command: node "$HOME/.claude/kit/scripts/ci_check.js" --hook
---

Read \`templates/spec.md\` first. Run scripts/lib.js now.
`;

const COMMAND = `---
description: Run the builder.
argument-hint: <slug>
allowed-tools: Bash, Agent
---

Spawn the \`builder\` agent on the slug, then follow \`/finish\`.
node "$HOME/.claude/kit/scripts/lib.js" go
Use templates/spec.md.
`;

const WORKFLOW = `name: ci
jobs:
  checks:
    name: the checks
    runs-on: ubuntu-latest
    steps:
      - name: check it
        run: node $KIT_DIR/kit/scripts/ci_check.js --repo .
      - name: unit tests
        run: npm test
`;

/** A small kit: one agent, two commands, three scripts, one test, one template, one workflow job. All declared. */
function miniKit(t, { declare = true } = {}) {
  const repo = tmpPath(t);
  const kit = path.join(repo, 'kit');
  put(kit, 'agents/builder.md', AGENT);
  put(kit, 'commands/build.md', COMMAND);
  put(kit, 'commands/finish.md', '---\ndescription: Finish.\n---\nDone.\n');
  put(kit, 'scripts/hook_guard.js', "import * as L from './lib.js';\nexport const x = L;\n");
  put(kit, 'scripts/ci_check.js', "import { a } from './lib.js';\nexport const y = a;\n");
  put(kit, 'scripts/lib.js', "export const a = 1;\nexport const load = () => import('./hook_guard.js');\n");
  put(kit, 'scripts/tests/lib.test.js', "import test from 'node:test';\nimport { a } from '../lib.js';\ntest('a', () => a);\ntest('b', () => a);\n");
  put(kit, 'templates/spec.md', '# spec\n');
  put(kit, 'ci/github.yml', WORKFLOW);
  put(repo, 'package.json', JSON.stringify({ scripts: { test: 'node --test kit/scripts/tests/*.test.js' } }));
  put(repo, 'VERSION', '9.9.9\n');
  const components = {};
  if (declare) {
    for (const id of ['command:build', 'command:finish', 'agent:builder', 'hook:guard', 'ci:check', 'script:lib', 'ci-job:template/checks']) components[id] = { purpose: `purpose of ${id}` };
  }
  put(kit, 'manifest.json', JSON.stringify({ schema: 1, components }));
  return { repo, kit };
}

const edge = (m, from, to, kind) => m.edges.find((e) => e.from === from && e.to === to && e.kind === kind);
const problems = (m, id) => m.problems.filter((p) => p.id === id);

// ---------------------------------------------------------------------------------------------- parsing

test('agent hooks are read with event, matcher and timeout', () => {
  const lines = AGENT.split('\n');
  const fm = M.frontmatter(lines);
  assert.equal(fm.fields.model, 'opus');
  const hooks = M.agentHooks(lines, fm.close);
  assert.deepEqual(hooks.map((h) => [h.event, h.matcher, h.timeout ?? null]), [['PreToolUse', 'Edit|Write', 30], ['Stop', '', null]]);
  assert.equal(M.hookTarget(hooks[1].command).file, 'ci_check.js');
  assert.equal(M.hookTarget(hooks[1].command).args, '--hook');
});

test('settings hooks keep document order and find their lines; invalid JSON gives null', () => {
  const text = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$HOME/.claude/kit/scripts/a.js"' }, { type: 'command', command: 'node "$HOME/.claude/kit/scripts/b.js"', timeout: 5 }] }] } }, null, 2);
  const hooks = M.settingsHooks(text);
  assert.deepEqual(hooks.map((h) => path.basename(M.hookTarget(h.command).file)), ['a.js', 'b.js']);
  assert.ok(hooks[0].line > 0 && hooks[1].line > hooks[0].line);
  assert.equal(hooks[1].timeout, 5);
  assert.equal(M.settingsHooks('{nope'), null);
});

test('workflow jobs are found by indentation and carry their display name', () => {
  const jobs = M.workflowJobs(WORKFLOW.split('\n'));
  assert.deepEqual(jobs.map((j) => [j.key, j.name]), [['checks', 'the checks']]);
});

// ---------------------------------------------------------------------------------------------- the graph

test('every kind of link is read from the file that makes it, with its line', (t) => {
  const { kit } = miniKit(t);
  const m = M.buildManifest(kit);
  const hook = edge(m, 'agent:builder', 'hook:guard', 'hook');
  assert.deepEqual([hook.event, hook.matcher, hook.timeout], ['PreToolUse', 'Edit|Write', 30]);
  assert.equal(hook.evidence.file, 'kit/agents/builder.md');
  assert.ok(hook.evidence.line > 0);
  assert.equal(edge(m, 'agent:builder', 'ci:check', 'hook').args, '--hook');
  assert.ok(edge(m, 'agent:builder', 'template:spec', 'uses'));
  assert.ok(edge(m, 'agent:builder', 'script:lib', 'runs'));
  assert.ok(edge(m, 'command:build', 'agent:builder', 'spawns'));
  assert.ok(edge(m, 'command:build', 'command:finish', 'follows'));
  assert.ok(edge(m, 'command:build', 'script:lib', 'runs'));
  const job = edge(m, 'ci-job:template/checks', 'ci:check', 'runs');
  assert.equal(job.step, 'check it');
  assert.ok(edge(m, 'ci-job:template/checks', 'test:lib', 'runs'), 'npm test reaches the test files through package.json');
  assert.ok(edge(m, 'ci:check', 'script:lib', 'imports'));
  assert.ok(edge(m, 'script:lib', 'hook:guard', 'imports'), 'dynamic import() counts');
  assert.ok(edge(m, 'test:lib', 'script:lib', 'tests'));
  assert.equal(m.nodes.find((n) => n.id === 'test:lib').stats.cases, 2);
  assert.equal(m.kit_version, '9.9.9');
});

test('a change reaches everything that needs it, through imports, tests and CI, and cycles end', (t) => {
  const { kit } = miniKit(t);
  const d = M.buildManifest(kit).nodes.find((n) => n.id === 'script:lib').derived;
  for (const id of ['hook:guard', 'ci:check', 'test:lib', 'command:build', 'agent:builder', 'ci-job:template/checks']) assert.ok(d.dependents.includes(id), `${id} depends on lib`);
  assert.deepEqual(d.tests, ['test:lib']);
  assert.deepEqual(d.jobs, ['ci-job:template/checks']);
  assert.equal(d.cases, 2);
  assert.ok(!d.dependents.includes('script:lib'), 'a component is not its own dependent');
});

test('the manifest is a pure function of the files', (t) => {
  const { kit } = miniKit(t);
  const a = M.buildManifest(kit);
  const b = M.buildManifest(kit);
  assert.deepEqual(a, b);
  assert.equal(a.digest, b.digest);
  put(kit, 'scripts/lib.js', "export const a = 1;\nexport const load = () => import('./hook_guard.js');\n// a comment changes nothing about the architecture\n");
  assert.equal(M.buildManifest(kit).digest, a.digest, 'a comment is not an architecture change');
  put(kit, 'scripts/extra.js', 'export const z = 1;\n');
  assert.notEqual(M.buildManifest(kit).digest, a.digest, 'a new component is');
});

// ---------------------------------------------------------------------------------------------- violations

test('a fully declared kit has no errors', (t) => {
  const { kit } = miniKit(t);
  assert.deepEqual(problems(M.buildManifest(kit), 'undeclared'), []);
  assert.equal(M.buildManifest(kit).problems.filter((p) => p.severity === 'error').length, 0);
  assert.equal(M.buildManifest(kit).nodes.find((n) => n.id === 'agent:builder').purpose, 'purpose of agent:builder');
});

test('a component that is not declared, and a declaration with no component, are errors', (t) => {
  const { kit } = miniKit(t);
  put(kit, 'scripts/hook_new.js', 'export const n = 1;\n');
  const decl = JSON.parse(fs.readFileSync(path.join(kit, 'manifest.json'), 'utf8'));
  decl.components['agent:ghost'] = { purpose: 'not there' };
  put(kit, 'manifest.json', JSON.stringify(decl));
  const m = M.buildManifest(kit);
  assert.deepEqual(problems(m, 'undeclared').map((p) => p.component), ['hook:new']);
  assert.deepEqual(problems(m, 'declared-missing').map((p) => p.component), ['agent:ghost']);
  assert.equal(m.nodes.find((n) => n.id === 'hook:new').declared, false);
});

test('without a declared file every component is undeclared', (t) => {
  const { kit } = miniKit(t, { declare: false });
  fs.rmSync(path.join(kit, 'manifest.json'));
  const m = M.buildManifest(kit);
  assert.equal(m.declared_file, false);
  assert.equal(problems(m, 'undeclared').length, 7);
});

test('references to things that do not exist are errors with their line', (t) => {
  const { kit } = miniKit(t);
  put(kit, 'commands/build.md', `${COMMAND}Then run scripts/nope.js and use templates/missing.md.\n`);
  put(kit, 'scripts/lib.js', "import './gone.js';\nexport const a = 1;\n");
  const m = M.buildManifest(kit);
  const dangling = problems(m, 'dangling-reference').map((p) => p.message);
  assert.ok(dangling.some((x) => x.includes('scripts/nope.js')));
  assert.ok(dangling.some((x) => x.includes('templates/missing.md')));
  assert.ok(problems(m, 'dangling-reference').every((p) => p.evidence.line > 0));
  assert.match(problems(m, 'dangling-import')[0].message, /gone\.js/);
});

test('an agent with the Bash or Read tool must run the matching guard before it (decision 0005)', (t) => {
  const { kit } = miniKit(t);
  put(kit, 'scripts/hook_guard_bash.js', 'export const b = 1;\n');
  put(kit, 'scripts/hook_guard_read.js', 'export const r = 1;\n');
  const decl = JSON.parse(fs.readFileSync(path.join(kit, 'manifest.json'), 'utf8'));
  decl.components['hook:guard_bash'] = { purpose: 'b' };
  decl.components['hook:guard_read'] = { purpose: 'r' };
  put(kit, 'manifest.json', JSON.stringify(decl));
  put(kit, 'agents/builder.md', AGENT.replace('tools: Edit, Write', 'tools: Read, Bash'));
  const bare = problems(M.buildManifest(kit), 'unguarded-tool').map((p) => p.message);
  assert.equal(bare.length, 2);
  assert.ok(bare.some((x) => x.includes('Bash tool')) && bare.some((x) => x.includes('Read tool')));
  const guarded = (matcher, script) => `  PreToolUse:\n    - matcher: ${matcher}\n      hooks:\n        - type: command\n          command: node "$HOME/.claude/kit/scripts/${script}"\n`;
  put(kit, 'agents/builder.md', AGENT.replace('tools: Edit, Write', 'tools: Read, Bash').replace('hooks:\n  PreToolUse:', `hooks:\n${guarded('Read|NotebookRead', 'hook_guard_read.js')}${guarded('Bash', 'hook_guard_bash.js').replace('  PreToolUse:\n', '')}  PreToolUse:`));
  assert.deepEqual(problems(M.buildManifest(kit), 'unguarded-tool'), []);
});

test('an agent whose name differs from its file is an error', (t) => {
  const { kit } = miniKit(t);
  put(kit, 'agents/builder.md', AGENT.replace('name: builder', 'name: other'));
  assert.equal(problems(M.buildManifest(kit), 'agent-name-mismatch').length, 1);
});

test('the stages of /run must equal the stages lane.js can answer', (t) => {
  const { kit } = miniKit(t);
  put(kit, 'commands/run.md', '---\ndescription: run\n---\n| stage | what |\n|---|---|\n| `research` | spawn `builder` |\n| `plan` | follow `/finish` |\n');
  put(kit, 'scripts/lane.js', "export async function nextStep() {\n  return { stage: 'research' };\n  return { stage: 'build', reason: 'x' };\n}\n");
  const m = M.buildManifest(kit);
  assert.deepEqual(m.pipeline.map((s) => s.id), ['research', 'plan']);
  assert.match(problems(m, 'stage-mismatch')[0].message, /only in lane\.js \[build\].*only in \/run \[plan\]/);
});

test('warnings: nothing uses a script, no test names a script', (t) => {
  const { kit } = miniKit(t);
  put(kit, 'scripts/orphan.js', 'export const o = 1;\n');
  const m = M.buildManifest(kit);
  assert.deepEqual(problems(m, 'unreferenced').map((p) => p.component), ['script:orphan']);
  assert.ok(problems(m, 'untested').some((p) => p.component === 'script:orphan'));
  assert.ok(!problems(m, 'untested').some((p) => p.component === 'script:lib'));
});

// ---------------------------------------------------------------------------------------------- snapshot and CLI

test('the snapshot has no line numbers or counts, so moving text does not make it stale', (t) => {
  const { kit } = miniKit(t);
  const snap = M.snapshotOf(M.buildManifest(kit));
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('"line"') && !text.includes('"count"') && !text.includes('"stats"') && !text.includes('"derived"'));
  put(kit, 'commands/build.md', COMMAND.replace('---\n\nSpawn', '---\n\n\n\nSpawn'));
  assert.equal(M.snapshotText(M.buildManifest(kit)), M.snapshotText(M.buildManifest(kit)));
  assert.deepEqual(M.snapshotOf(M.buildManifest(kit)), snap);
});

test('--check passes on a fresh snapshot and names what changed on a stale one', (t) => {
  const { repo, kit } = miniKit(t);
  const snap = path.join(repo, 'architecture.json');
  assert.equal(runScript('arch_manifest.js', ['--kit', kit, '--out', snap]).returncode, 0);
  const ok = runScript('arch_manifest.js', ['--kit', kit, '--check', snap]);
  assert.equal(ok.returncode, 0, ok.stderr);
  put(kit, 'scripts/hook_new.js', "import { a } from './lib.js';\nexport const n = a;\n");
  put(kit, 'manifest.json', JSON.stringify({ schema: 1, components: { ...JSON.parse(fs.readFileSync(path.join(kit, 'manifest.json'), 'utf8')).components, 'hook:new': { purpose: 'new' } } }));
  const stale = runScript('arch_manifest.js', ['--kit', kit, '--check', snap]);
  assert.equal(stale.returncode, 1);
  assert.match(stale.stderr, /is stale/);
  assert.match(stale.stderr, /\+ component hook:new/);
  assert.match(stale.stderr, /\+ edge hook:new -\[imports\]-> script:lib/);
  assert.equal(runScript('arch_manifest.js', ['--kit', kit, '--check', path.join(repo, 'absent.json')]).returncode, 1);
});

test('the CLI fails when a violation of severity error exists', (t) => {
  const { kit } = miniKit(t);
  put(kit, 'scripts/hook_new.js', 'export const n = 1;\n');
  const r = runScript('arch_manifest.js', ['--kit', kit]);
  assert.equal(r.returncode, 1);
  assert.match(r.stdout, /ERROR undeclared/);
  assert.equal(runScript('arch_manifest.js', ['--kit', path.join(kit, 'nowhere')]).returncode, 2);
});

// ---------------------------------------------------------------------------------------------- the real kit

test('the real kit: no violations of severity error, every component declared with a purpose', () => {
  const m = M.buildManifest(REAL_KIT);
  assert.deepEqual(m.problems.filter((p) => p.severity === 'error'), []);
  for (const n of m.nodes.filter((x) => M.DECLARED_KINDS.includes(x.kind))) assert.ok(n.declared && n.purpose, `${n.id} needs a purpose in kit/manifest.json`);
});

test('the real kit: every agent has hooks, and the committed snapshot is current', () => {
  const m = M.buildManifest(REAL_KIT);
  for (const a of m.nodes.filter((n) => n.kind === 'agent')) assert.ok(m.edges.some((e) => e.from === a.id && e.kind === 'hook'), `${a.id} has no hooks`);
  const r = runScript('arch_manifest.js', ['--check', SNAPSHOT]);
  assert.equal(r.returncode, 0, `kit/architecture.json is stale: run npm run architecture:update\n${r.stderr}`);
});

test('the real kit: the /run stages are the stages next-step can answer, in the order the pipeline runs', () => {
  const m = M.buildManifest(REAL_KIT);
  assert.deepEqual(m.pipeline.map((s) => s.id).slice(0, 9), ['start', 'research', 'plan', 'approve', 'lane', 'test', 'build', 'review', 'wait-merge']);
  assert.equal(m.pipeline.find((s) => s.id === 'approve').pause, 1);
  assert.equal(m.pipeline.find((s) => s.id === 'wait-merge').pause, 2);
  assert.ok(m.pipeline.find((s) => s.id === 'build').agents.includes('implementer'));
});

// ---------------------------------------------------------------------------------------------- git and projects

test('a GitHub remote becomes a link without credentials; anything else gives none', () => {
  assert.equal(Live.githubUrl('https://user:secret@github.com/o/r.git'), 'https://github.com/o/r');
  assert.equal(Live.githubUrl('git@github.com:o/r.git'), 'https://github.com/o/r');
  assert.equal(Live.githubUrl('https://gitlab.com/o/r'), null);
  assert.equal(Live.githubUrl(null), null);
});

test('git info and history come from git; outside a repository they are empty', (t) => {
  const info = Live.gitInfo(path.dirname(REAL_KIT));
  assert.ok(info.commit === null || /^[0-9a-f]{7,}$/.test(info.commit));
  assert.equal(Live.gitInfo(tmpPath(t)).commit, null);
  assert.deepEqual(Live.fileHistory(tmpPath(t), 'nothing.js'), []);
});

test('a project is compared with the kit by event, matcher and script', (t) => {
  const m = M.buildManifest(REAL_KIT);
  const { root } = project(t);
  const clean = Live.projectOverlay(m, REAL_KIT, root);
  assert.equal(clean.settings, true);
  assert.deepEqual(clean.hooks.missing, []);
  assert.deepEqual(clean.hooks.stale, []);
  assert.equal(clean.hooks.installed, clean.hooks.expected);
  assert.ok(clean.installed_nodes.includes('hook:guard_edit'));

  const sp = path.join(root, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.PreToolUse = s.hooks.PreToolUse.filter((g) => !JSON.stringify(g).includes('hook_guard_bash.js'));
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: 'node "$HOME/.claude/kit/scripts/hook_removed.py"' }] });
  fs.writeFileSync(sp, JSON.stringify(s));
  const drift = Live.projectOverlay(m, REAL_KIT, root);
  assert.deepEqual(drift.hooks.missing.map((h) => [h.event, h.node]), [['PreToolUse', 'hook:guard_bash']]);
  assert.deepEqual(drift.hooks.stale, ['hook_removed.py']);
  assert.ok(!drift.installed_nodes.includes('hook:guard_bash'));

  fs.rmSync(sp);
  const none = Live.projectOverlay(m, REAL_KIT, root);
  assert.equal(none.settings, false);
  assert.equal(none.hooks.missing.length, none.hooks.expected);
});

// ---------------------------------------------------------------------------------------------- the server

async function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve([res.statusCode, JSON.parse(Buffer.concat(chunks).toString('utf8'))]));
    }).on('error', reject);
  });
}

test('the server answers with the map, one overlay per project, and per-component history', { timeout: 60000 }, async (t) => {
  const a = project(t).root;
  const b = project(t).root;
  for (const [root, name] of [[a, 'alpha'], [b, 'beta']]) {
    const kj = path.join(root, '.claude', 'kit.json');
    fs.writeFileSync(kj, JSON.stringify({ ...JSON.parse(fs.readFileSync(kj, 'utf8')), project: name }));
  }
  fs.rmSync(path.join(b, '.claude', 'settings.json')); // project b has no hooks installed; project a is untouched
  const port = await freePort();
  const httpd = S.serve([a, b], port, false, 5);
  await once(httpd, 'listening');
  try {
    const base = `http://127.0.0.1:${port}`;
    const [code, arch] = await getJson(`${base}/api/architecture`);
    assert.equal(code, 200);
    assert.ok(arch.manifest.nodes.length > 60 && arch.manifest.edges.length > 100);
    assert.equal(arch.projects.length, 2);
    assert.deepEqual(arch.projects.map((p) => [p.project, p.root]), [['alpha', a], ['beta', b]], 'two projects, two separate overlays, each tied to its own root');
    const [pa, pb] = arch.projects;
    assert.deepEqual(pa.hooks.missing, []);
    assert.equal(pb.settings, false);
    assert.equal(pb.hooks.missing.length, pb.hooks.expected);
    assert.ok(pa.lanes.every((l) => typeof l.slug === 'string'));
    assert.ok(arch.git && 'modified' in arch.git);

    const page = await new Promise((resolve, reject) => {
      http.get(`${base}/model.js`, { agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });
    assert.equal(page.status, 200);
    assert.match(page.type, /javascript/);
    assert.ok(page.body.includes('export function blastRadius'));

    const [hc, hist] = await getJson(`${base}/api/history?id=script:lane`);
    assert.equal(hc, 200);
    assert.equal(hist.path, 'kit/scripts/lane.js');
    assert.ok(Array.isArray(hist.commits));
    for (const bad of ['nope', '../../etc/passwd', '']) assert.equal((await getJson(`${base}/api/history?id=${encodeURIComponent(bad)}`))[0], 404);
  } finally {
    httpd.close();
  }
});
