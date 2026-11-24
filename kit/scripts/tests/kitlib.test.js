// kitlib behaviours that matter for safety: odd JSON in lane.json / kit.json, spec paths, stale hook detection, fail-closed guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from '../kitlib.js';
import { SCRIPTS, makeRepo } from './helpers.js';

const KIT = path.dirname(SCRIPTS);

test('lane.json that is not an object is treated as an empty lane', (t) => {
  const repo = makeRepo(t);
  for (const body of ['null', '[]', '"x"', '7']) {
    fs.writeFileSync(path.join(repo, '.claude', 'lane.json'), body);
    const lane = K.findLane(repo);
    assert.deepEqual(lane.data, {}, body);
    assert.equal(lane.slug, '');
  }
});

test('kit.json that is not an object is ignored', (t) => {
  const repo = makeRepo(t);
  for (const body of ['null', '[1]', 'not json']) {
    fs.writeFileSync(path.join(repo, '.claude', 'kit.json'), body);
    assert.deepEqual(K.loadKitJson(repo), {}, body);
  }
});

test('lane spec path may be relative or absolute', () => {
  const lane = new K.Lane('/work/lane', { feature: 'x', spec: 'docs/specs/x.md' });
  assert.equal(lane.specPath, '/work/lane/docs/specs/x.md');
  assert.equal(new K.Lane('/work/lane', { feature: 'x', spec: '/elsewhere/x.md' }).specPath, '/elsewhere/x.md');
  assert.equal(new K.Lane('/work/lane', { feature: 'x' }).specPath, '/work/lane/docs/specs/x.md');
});

test('staleHookScripts finds hooks that point at scripts the kit does not have', () => {
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node "$HOME/.claude/kit/scripts/hook_guard_edit.js"' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'python3 "$HOME/.claude/kit/scripts/hook_done_check.py"' }, { type: 'command', command: 'echo no script here' }] }],
    },
  };
  assert.deepEqual(K.staleHookScripts(settings, KIT), ['hook_done_check.py']);
  for (const odd of [null, {}, { hooks: null }, { hooks: { Stop: 'x' } }, { hooks: { Stop: [null, { hooks: 'x' }] } }]) {
    assert.deepEqual(K.staleHookScripts(odd, KIT), []);
  }
});

test('runGuard turns a crash into exit 2 with the reason on stderr', () => {
  const code = `import * as K from ${JSON.stringify(path.join(SCRIPTS, 'kitlib.js'))}; K.runGuard('demo-guard', () => { throw new Error('boom'); });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('demo-guard: internal error, blocking for safety') && r.stderr.includes('boom'), r.stderr);
});

test('runGuard passes the exit code of a normal run through', () => {
  const code = `import * as K from ${JSON.stringify(path.join(SCRIPTS, 'kitlib.js'))}; K.runGuard('demo-guard', () => 0);`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', code]).status, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// A cited run is matched against what real runners print. The outputs under data/runner-output are captured from
// the node-api fixture's vitest 2.1.9 (default, verbose, tap, tap-flat; `--changed HEAD` is the post-edit hook's
// command; ci-color is the default reporter coloured, as on GitHub Actions) and jest 29, never written by hand: truncate.test.* has `describe('truncate') > it('shortens …')`,
// nested.test.* has `outer > inner > adds two numbers` and a skipped `is skipped`.
// ---------------------------------------------------------------------------------------------------------------
const RUNS = path.join(path.dirname(new URL(import.meta.url).pathname), 'data', 'runner-output');
const D1 = '`tests/truncate.test.ts::shortens text longer than max to max characters ending in an ellipsis`';
const runProblem = (file, label, test) => {
  const exit = label === 'red' ? 1 : 0;
  const lines = [`=== 2026-11-23T10:00:00 D1: npx vitest run -> exit ${exit}`, ...fs.readFileSync(path.join(RUNS, file), 'utf8').split('\n')];
  const lane = { root: null, logPath: '/x/.claude/session/truncate-text.log' };
  return K.runRefProblem(lane, lines, ['D1', 'c', test, label === 'red' ? 'truncate-text.log#1' : '—', label === 'green' ? 'truncate-text.log#1' : '—'], label);
};

test('a run counts for its criterion in every vitest reporter, red and green, describe-nested or not', () => {
  for (const r of ['default', 'verbose', 'tap', 'tap-flat', 'changed', 'ci-color']) {
    for (const label of ['red', 'green']) {
      const f = `vitest-${r}.${label}.txt`;
      assert.equal(runProblem(f, label, D1), null, f);
      // the nested test, by its name alone or with its describes
      if (['verbose', 'tap', 'tap-flat'].includes(r)) {
        assert.equal(runProblem(f, label, 'tests/nested.test.ts::adds two numbers'), null, `${f} nested`);
        assert.equal(runProblem(f, label, 'tests/nested.test.ts::outer > inner > adds two numbers'), null, `${f} nested path`);
      }
    }
  }
  // vitest's default reporter names every failed test, so a red nested test counts there too
  assert.equal(runProblem('vitest-default.red.txt', 'red', 'tests/nested.test.ts::outer > inner > adds two numbers'), null);
});

test('a run counts for its criterion in jest, one file (each test listed) or a failure heading', () => {
  const J = '`tests/truncate.test.js::shortens text longer than max to max characters ending in an ellipsis`';
  assert.equal(runProblem('jest-one-file.red.txt', 'red', J), null);
  assert.equal(runProblem('jest-one-file.green.txt', 'green', J), null);
  assert.equal(runProblem('jest-all.red.txt', 'red', J), null);
  assert.equal(runProblem('jest-nested.red.txt', 'red', 'tests/nested.test.js::outer > inner > adds two numbers'), null);
  assert.equal(runProblem('jest-nested.green.txt', 'green', 'tests/nested.test.js::adds two numbers'), null);
});

test('a wrong name, another describe, a skipped test, another file, or the wrong outcome is still refused', () => {
  const refused = (f, label, test, why) => assert.match(runProblem(f, label, test) ?? 'accepted', why, `${f} ${label} ${test}`);
  for (const r of ['default', 'verbose', 'tap', 'tap-flat']) {
    refused(`vitest-${r}.red.txt`, 'red', '`tests/truncate.test.ts::shortens text`', /has no result/);
    refused(`vitest-${r}.red.txt`, 'red', '`tests/other.test.ts::shortens text longer than max to max characters ending in an ellipsis`', /has no result/);
    refused(`vitest-${r}.green.txt`, 'green', 'tests/nested.test.ts::is skipped', /has no result/);
    refused(`vitest-${r}.red.txt`, 'red', 'tests/nested.test.ts::other > adds two numbers', /has no result/);
    // a green run cited as red, a red run cited as green
    refused(`vitest-${r}.green.txt`, 'red', D1, /has no result|as passing/);
    refused(`vitest-${r}.red.txt`, 'green', D1, /as failing/);
  }
  // a run of another file is no run of this test, and a file that passed with a skip does not vouch for its tests
  refused('vitest-other-file.green.txt', 'green', D1, /has no result/);
  refused('vitest-changed.green.txt', 'green', 'tests/nested.test.ts::adds two numbers', /has no result/);
  // jest gives a file's skips only in the run's summary, so a PASS line in a run with skips vouches for nothing
  refused('jest-all.green.txt', 'green', '`tests/truncate.test.js::shortens text longer than max to max characters ending in an ellipsis`', /no test result|has no result/);
  // a file-level pass is never a red run, and a cell without a file cannot use one
  refused('vitest-default.green.txt', 'green', 'shortens text longer than max to max characters ending in an ellipsis', /has no result/);
});
