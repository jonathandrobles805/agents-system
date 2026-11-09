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
