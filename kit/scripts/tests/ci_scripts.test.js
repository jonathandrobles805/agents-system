import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { splitlines } from '../kitlib.js';
import * as C from '../ci_common.js';
import * as F from './fixtures.js';
import { SCRIPTS, runScript, makeRepo, setEnv, tmpPath } from './helpers.js';
import { GOOD_REVIEW, spec as makeSpec, review as makeReview, write } from './testdata.js';

const KIT = path.dirname(SCRIPTS);
const read = (root, ...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

function laneRepo(t, { deps = 'none', extra = '' } = {}) {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  const commit = F.commitAll(root, 'bootstrap');
  write(root, 'docs/specs/refund-route.md', makeSpec({ commit: commit.slice(0, 7), deps, extra }));
  F.commitAll(root, 'spec');
  F.git(['checkout', '-q', '-b', 'wt/refund-route'], root);
  return root;
}

const ci = (name, root, ...args) => runScript(name, ['--repo', root, '--base', 'main', ...args]);

test('scope diff pass and fail', (t) => {
  const root = laneRepo(t);
  write(root, 'src/api/routes.ts', "import { PaymentService } from '../domain/payment';\nexport function routes(s: PaymentService) {\n  return { charge: (u: string) => s.charge(u), refund: (i: string) => s.refund(i) };\n}\n");
  write(root, 'tests/routes.test.ts', "import { it, expect } from 'vitest';\nit('exposes refund', () => { expect(1).toBe(1); });\n");
  F.commitAll(root, 'D1');
  let r = ci('ci_scope_diff.js', root);
  assert.equal(r.returncode, 0, r.stderr);
  write(root, 'src/domain/payment.ts', '// touched\n' + read(root, 'src', 'domain', 'payment.ts'));
  F.commitAll(root, 'creep');
  r = ci('ci_scope_diff.js', root);
  assert.ok(r.returncode === 1 && r.stderr.includes('src/domain/payment.ts'));
});

test('scope diff skips non lane branch', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  F.git(['checkout', '-q', '-b', 'chore/readme'], root);
  const r = ci('ci_scope_diff.js', root);
  assert.ok(r.returncode === 0 && r.stdout.includes('skipped'));
});

test('test count drop fails unless declared', (t) => {
  const root = laneRepo(t);
  const tf = path.join(root, 'tests', 'payment.test.ts');
  fs.writeFileSync(tf, fs.readFileSync(tf, 'utf8').replaceAll("  it('refunds', async () => {\n    const s = new PaymentService({ charge: async () => 5, refund: async () => 1 });\n    expect(await s.refund('x')).toBe(1);\n  });\n", ''));
  F.commitAll(root, 'drop a test');
  let r = ci('ci_test_count.js', root);
  assert.ok(r.returncode === 1 && r.stderr.includes('dropped from 2 to 1'));
  const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8') + '\nTest count may drop: refund test moves to routes.test.ts in D1\n');
  F.commitAll(root, 'declare');
  r = ci('ci_test_count.js', root);
  assert.equal(r.returncode, 0, r.stderr);
});

test('test count increase passes', (t) => {
  const root = laneRepo(t);
  write(root, 'tests/routes.test.ts', "import { it, expect } from 'vitest';\nit('exposes refund', () => { expect(1).toBe(1); });\nit('b', () => {});\n");
  F.commitAll(root, 'tests');
  const r = ci('ci_test_count.js', root);
  assert.ok(r.returncode === 0 && r.stdout.includes('2 -> 4'));
});

test('dep diff undeclared fails declared passes', (t) => {
  const root = laneRepo(t, { deps: 'none' });
  const pj = JSON.parse(read(root, 'package.json'));
  pj.dependencies.stripe = '^16.0.0';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pj, null, 2));
  F.commitAll(root, 'add stripe');
  let r = ci('ci_dep_diff.js', root);
  assert.ok(r.returncode === 1 && r.stderr.includes('stripe'));
  const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replaceAll('## New dependencies\n\n- none', '## New dependencies\n\n- `stripe@^16.0.0` — refund API client'));
  F.commitAll(root, 'declare');
  r = ci('ci_dep_diff.js', root);
  assert.equal(r.returncode, 0, r.stderr);
});

test('dep diff python', (t) => {
  const root = F.pythonService(path.join(tmpPath(t), 'py'));
  F.git(['checkout', '-q', '-b', 'wt/x'], root);
  const pp = path.join(root, 'pyproject.toml');
  fs.writeFileSync(pp, fs.readFileSync(pp, 'utf8').replaceAll('dependencies = ["fastapi>=0.110", "pydantic>=2"]', 'dependencies = ["fastapi>=0.110", "pydantic>=2", "stripe>=9"]'));
  F.commitAll(root, 'dep');
  const r = ci('ci_dep_diff.js', root);
  assert.ok(r.returncode === 1 && r.stderr.includes('stripe'));
});

test('claude md cap', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  assert.equal(runScript('ci_claude_md_cap.js', ['--repo', root]).returncode, 0);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'x'.repeat(5000));
  const r = runScript('ci_claude_md_cap.js', ['--repo', root]);
  assert.ok(r.returncode === 1 && r.stderr.includes('5000 bytes'));
});

test('guards present detects tampering', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  const ok = runScript('ci_guards_present.js', ['--repo', root, '--kit', KIT]);
  assert.equal(ok.returncode, 0, ok.stderr);
  const sj = path.join(root, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sj, 'utf8'));
  delete s.hooks.Stop;
  fs.writeFileSync(sj, JSON.stringify(s));
  let r = runScript('ci_guards_present.js', ['--repo', root, '--kit', KIT]);
  assert.ok(r.returncode === 1 && r.stderr.includes('Stop') && r.stderr.includes('changed since bootstrap'));
  s.hooks = JSON.parse(fs.readFileSync(path.join(KIT, 'hooks', 'settings.project.json'), 'utf8')).hooks;
  s.disableAllHooks = true;
  fs.writeFileSync(sj, JSON.stringify(s));
  r = runScript('ci_guards_present.js', ['--repo', root, '--kit', KIT]);
  assert.ok(r.returncode === 1 && r.stderr.includes('disableAllHooks'));
});

test('review report check', (t) => {
  const root = laneRepo(t);
  write(root, 'tests/routes.test.ts', "import { it, expect } from 'vitest';\nit('exposes refund', () => { expect(1).toBe(1); });\n");
  const head = F.commitAll(root, 'D1');
  let r = runScript('ci_review_report.js', ['--repo', root]);
  assert.ok(r.returncode === 1 && r.stderr.includes('missing'));
  const rep = path.join(root, 'docs', 'specs', 'refund-route.review.md');
  fs.writeFileSync(rep, makeReview({ head: head.slice(0, 10), verdict: 'PASS' }));
  F.commitAll(root, 'review'); // report commit is HEAD, reviewed commit is HEAD~1: accepted
  r = runScript('ci_review_report.js', ['--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  write(root, 'src/api/routes.ts', '// changed after review\n' + read(root, 'src', 'api', 'routes.ts'));
  F.commitAll(root, 'sneaky change');
  r = runScript('ci_review_report.js', ['--repo', root]);
  assert.ok(r.returncode === 1 && r.stderr.includes('code changed after review'));
  fs.writeFileSync(rep, makeReview({ head: head.slice(0, 10), verdict: 'FAIL' }));
  r = runScript('ci_review_report.js', ['--repo', root]);
  assert.equal(r.returncode, 1);
});

test('pr size warning', (t) => {
  const root = laneRepo(t);
  for (let i = 0; i < 30; i++) write(root, `src/f${i}.ts`, 'export const x = 1;\n');
  F.commitAll(root, 'big');
  const r = ci('ci_pr_size.js', root);
  assert.ok(r.returncode === 1 && r.stderr.includes('30 files'));
});

test('changed docs validates in ci mode', (t) => {
  const root = laneRepo(t);
  write(root, 'docs/research/bad.md', '# Research: x\n\n- Question: x\n- Slug: bad\n- Date: 2026-11-08\n- Commit: abc\n\n## Findings\n\n- F1. it probably works\n\n## What I could not verify\n\n- none\n\n## Confidence\n\nLow\n\n## Recommendation\n\nnone\n\n## Sources\n\n- none\n');
  F.commitAll(root, 'bad research');
  const r = ci('ci_changed_docs.js', root);
  assert.ok(r.returncode === 1 && r.stderr.includes('untagged-claim'));
});

test('lane slug prefers repo branch over ci env', (t) => {
  // GitHub Actions sets GITHUB_HEAD_REF to the PR branch; a repo on its own branch must still win.
  const root = laneRepo(t);
  setEnv(t, 'GITHUB_HEAD_REF', 'phase-2-bootstrap');
  assert.equal(C.laneSlug(root), 'refund-route');
  F.git(['checkout', '-q', '--detach'], root);
  setEnv(t, 'GITHUB_HEAD_REF', 'wt/other');
  assert.equal(C.laneSlug(root), 'other');
});

const ARCH_LAYERS = `# Architecture

- Updated: 2026-11-08

## Layers

| Layer | Directories | May import from |
|---|---|---|
| api | \`src/api\` | domain |
| domain | \`src/domain\` | nothing in the app |
| tests | \`tests\` | api, domain |

## Invariants

- [ ] domain never imports api
`;

test('boundaries fallback', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  write(root, 'ARCHITECTURE.md', ARCH_LAYERS);
  F.commitAll(root, 'arch');
  assert.equal(runScript('ci_boundaries_simple.js', ['--repo', root]).returncode, 0);
  const p = path.join(root, 'src', 'domain', 'payment.ts');
  fs.writeFileSync(p, "import { routes } from '../api/routes';\n" + fs.readFileSync(p, 'utf8'));
  F.commitAll(root, 'violation');
  const r = runScript('ci_boundaries_simple.js', ['--repo', root]);
  assert.ok(r.returncode === 1 && r.stderr.includes('src/domain/payment.ts') && r.stderr.includes('(api)'));
});

test('boundaries fallback python', (t) => {
  const root = F.pythonService(path.join(tmpPath(t), 'py'));
  write(root, 'ARCHITECTURE.md', ARCH_LAYERS.replaceAll('`src/api`', '`app/api`').replaceAll('`src/domain`', '`app`'));
  fs.mkdirSync(path.join(root, 'app', 'api'));
  write(root, 'app/api/__init__.py', '');
  write(root, 'app/api/routes.py', 'from app.billing import total\n');
  F.commitAll(root, 'ok');
  assert.equal(runScript('ci_boundaries_simple.js', ['--repo', root]).returncode, 0);
  write(root, 'app/billing.py', 'from app.api.routes import total as t\n' + read(root, 'app', 'billing.py'));
  F.commitAll(root, 'bad');
  assert.equal(runScript('ci_boundaries_simple.js', ['--repo', root]).returncode, 1);
});

test('boundaries fallback without layers is noop', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  const r = runScript('ci_boundaries_simple.js', ['--repo', root]);
  assert.ok(r.returncode === 0 && r.stdout.includes('nothing to check'));
});

test('mutation gate flips after two merged', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  const rm = path.join(root, 'ROADMAP.md');
  fs.writeFileSync(rm, fs.readFileSync(rm, 'utf8').replaceAll(
    '| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |',
    '| A | a | M1 | merged | — | — | — |\n| B | b | M1 | building | — | — | — |',
  ));
  assert.ok(runScript('ci_mutation_gate.js', ['--repo', root]).stdout.includes('blocking=false'));
  fs.writeFileSync(rm, fs.readFileSync(rm, 'utf8').replaceAll('| B | b | M1 | building |', '| B | b | M1 | merged |'));
  assert.ok(runScript('ci_mutation_gate.js', ['--repo', root]).stdout.includes('blocking=true'));
  const wf = read(root, '.github', 'workflows', 'kit.yml');
  assert.ok(wf.includes('mutation-gate') && wf.includes('ci_mutation_gate.js'));
});

test('bootstrap writes second reviewer key and upgrade all', (t) => {
  const base = tmpPath(t);
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  setEnv(t, 'CLAUDE_HOME', home);
  const a = F.nodeApi(path.join(base, 'a'));
  const b = F.pythonService(path.join(base, 'b'));
  for (const r of [a, b]) {
    runScript('bootstrap.js', ['--repo', r]);
    assert.ok('second_reviewer_model' in JSON.parse(read(r, '.claude', 'kit.json')));
  }
  const reg = JSON.parse(read(home, 'kit-projects.json'));
  assert.ok(reg.includes(a) && reg.includes(b));
  const sj = path.join(a, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(sj, 'utf8'));
  delete s.hooks.Stop;
  fs.writeFileSync(sj, JSON.stringify(s));
  const r = runScript('bootstrap.js', ['--upgrade', '--all', '--json']);
  assert.equal(r.returncode, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out[a].backed_up.includes('.claude/settings.json') && b in out);
});

test('review requires r12', (t) => {
  const repo = makeRepo(t);
  const bad = splitlines(GOOD_REVIEW).filter((l) => !l.startsWith('| R12')).join('\n') + '\n';
  const p = write(repo, 'docs/specs/refund-endpoint.review.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('checklist-missing-r12'));
});
