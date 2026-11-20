// Step 4 (KIT-SPEC 7.4): CI stages 1–3 in the generated workflow, the coverage floor that only rises, CODEOWNERS for CI
// and kit configuration (the review is requested, not required: 0016 E.10).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check, floorAt, readCoverage } from '../ci_coverage_floor.js';
import * as F from './fixtures.js';
import { runScript, tmpPath } from './helpers.js';

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, t) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
};
const boot = (root, ...args) => {
  const r = runScript('bootstrap.js', ['--repo', root, '--json', ...args]);
  assert.equal(r.returncode, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const kitJson = (root) => JSON.parse(read(root, '.claude', 'kit.json'));
const setKit = (root, fn) => {
  const k = kitJson(root);
  fn(k);
  fs.writeFileSync(path.join(root, '.claude', 'kit.json'), JSON.stringify(k, null, 2));
};

test('generated workflow: merge_group trigger, format, coverage floor step in tests, integration job; commands detected', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  const pj = path.join(root, 'package.json');
  const p = JSON.parse(read(pj));
  p.devDependencies = { ...(p.devDependencies ?? {}), prettier: '3.0.0', vitest: '2.0.0' };
  fs.writeFileSync(pj, JSON.stringify(p, null, 2));
  boot(root);
  const wf = read(root, '.github', 'workflows', 'kit.yml');
  assert.ok(wf.includes('  merge_group:\n'), 'merge queue runs the checks');
  assert.ok(wf.includes('  format:\n'));
  assert.ok(wf.includes('npx prettier --check .'));
  assert.ok(wf.includes('ci_coverage_floor.js" --repo . --base origin/main'));
  assert.ok(wf.includes('--coverage.reporter=json-summary'));
  assert.ok(wf.includes('  integration:\n'));
  assert.ok(wf.includes('integration is not configured (kit.json db.lane_adapter: none)') && wf.includes('exit 1'));
  const cmds = kitJson(root).commands;
  assert.equal(cmds.format, 'npx prettier --check .');
  assert.ok(cmds.coverage.startsWith('npx vitest run --coverage'));
});

test('CODEOWNERS is generated once, names the GitHub owner from origin, covers CI and kit configuration', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  F.git(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], root);
  boot(root);
  const co = read(root, '.github', 'CODEOWNERS');
  assert.ok(co.includes('/.github/workflows/ @acme'));
  assert.ok(co.includes('/.claude/ @acme'));
  assert.ok(co.includes('/.github/CODEOWNERS @acme'));
  fs.writeFileSync(path.join(root, '.github', 'CODEOWNERS'), '/src/ @someone\n');
  boot(root);
  assert.equal(read(root, '.github', 'CODEOWNERS'), '/src/ @someone\n', 'human-owned: never overwritten');
  // no origin: a TODO the human must fill, never a guess
  const root2 = F.nodeApi(path.join(tmpPath(t), 'node-api-2'));
  boot(root2);
  assert.ok(read(root2, '.github', 'CODEOWNERS').includes('TODO(bootstrap: CODEOWNERS'));
});

test('readCoverage understands istanbul, coverage.py and lcov', (t) => {
  const root = path.join(tmpPath(t), 'r');
  write(path.join(root, 'coverage', 'coverage-summary.json'), JSON.stringify({ total: { lines: { pct: 81.5 } } }));
  assert.deepEqual(readCoverage(root), { pct: 81.5, file: 'coverage/coverage-summary.json' });
  fs.rmSync(path.join(root, 'coverage'), { recursive: true });
  write(path.join(root, 'coverage', 'coverage.json'), JSON.stringify({ totals: { percent_covered: 77.25 } }));
  assert.equal(readCoverage(root).pct, 77.25);
  fs.rmSync(path.join(root, 'coverage'), { recursive: true });
  write(path.join(root, 'coverage', 'lcov.info'), 'SF:a.js\nLF:10\nLH:7\nend_of_record\nSF:b.js\nLF:10\nLH:9\nend_of_record\n');
  assert.equal(readCoverage(root).pct, 80);
  assert.equal(readCoverage(path.join(tmpPath(t), 'empty')), null);
});

test('coverage floor: passes at or above, fails below, fails when lowered against base, ratchets up only (fault 31)', (t) => {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  boot(root);
  // no command, no summary: pass with a note (the fixture declares vitest, so bootstrap detected a coverage command; drop it first)
  setKit(root, (k) => { delete k.commands.coverage; });
  let r = check({ root });
  assert.deepEqual(r.problems, []);
  assert.ok(r.notes[0].includes('no coverage command'));
  // a command but no summary: the command produced nothing → fail
  setKit(root, (k) => { k.commands.coverage = 'npx vitest run --coverage'; });
  r = check({ root });
  assert.ok(r.problems[0].includes('wrote nothing'));
  // measured 80, no floor yet: pass; --ratchet sets the floor
  write(path.join(root, 'coverage', 'coverage-summary.json'), JSON.stringify({ total: { lines: { pct: 80 } } }));
  r = check({ root });
  assert.deepEqual(r.problems, []);
  r = check({ root, ratchet: true });
  assert.equal(kitJson(root).coverage_floor, 80);
  assert.ok(r.notes[0].includes('floor raised none → 80'));
  F.commitAll(root, 'floor 80');
  // below the floor → fail
  write(path.join(root, 'coverage', 'coverage-summary.json'), JSON.stringify({ total: { lines: { pct: 79.9 } } }));
  r = check({ root });
  assert.ok(r.problems[0].includes('below the floor 80%'));
  // ratchet never lowers
  r = check({ root, ratchet: true });
  assert.equal(kitJson(root).coverage_floor, 80);
  // the floor lowered in kit.json relative to the base branch → fail even with coverage above it
  write(path.join(root, 'coverage', 'coverage-summary.json'), JSON.stringify({ total: { lines: { pct: 95 } } }));
  setKit(root, (k) => { k.coverage_floor = 60; });
  assert.equal(floorAt(root, 'HEAD'), 80);
  r = check({ root, base: 'HEAD' });
  assert.ok(r.problems[0].includes('lowered from 80'));
  // and raised honestly: pass, ratchet to 95
  setKit(root, (k) => { k.coverage_floor = 80; });
  r = check({ root, base: 'HEAD', ratchet: true });
  assert.deepEqual(r.problems, []);
  assert.equal(kitJson(root).coverage_floor, 95);
  // CLI exit codes
  write(path.join(root, 'coverage', 'coverage-summary.json'), JSON.stringify({ total: { lines: { pct: 10 } } }));
  const cli = runScript('ci_coverage_floor.js', ['--repo', root]);
  assert.equal(cli.returncode, 1);
  assert.ok(cli.stderr.includes('coverage-floor:'));
});
