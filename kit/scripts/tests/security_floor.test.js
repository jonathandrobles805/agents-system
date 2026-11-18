// The security floor (KIT-SPEC 10.9, decision 0008): the file is well-formed and is the minimum everywhere it must be,
// the guards read it, and ci_security_floor fails on every way a project could fall below it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as K from '../kitlib.js';
import { allowLoosens, check, splitRule } from '../ci_security_floor.js';
import * as F from './fixtures.js';
import { SCRIPTS, runScript, setEnv, tmpPath } from './helpers.js';

const KIT = path.dirname(SCRIPTS);
const FRAG = JSON.parse(fs.readFileSync(path.join(KIT, 'hooks', 'settings.project.json'), 'utf8'));

function bootstrapped(t) {
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  const r = runScript('bootstrap.js', ['--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  return root;
}
const settingsPath = (root) => path.join(root, '.claude', 'settings.json');
const readSettings = (root) => JSON.parse(fs.readFileSync(settingsPath(root), 'utf8'));
const writeSettings = (root, s) => fs.writeFileSync(settingsPath(root), JSON.stringify(s, null, 2));
const emptyHome = (t) => {
  const h = path.join(tmpPath(t), 'home');
  fs.mkdirSync(h, { recursive: true });
  return h;
};
const run = (root, home, extra = []) => runScript('ci_security_floor.js', ['--repo', root, '--home', home, '--managed', path.join(home, 'no-managed.json'), ...extra]);

test('floor file: well-formed, and a superset of what the kit already enforced', () => {
  const f = K.loadFloor();
  assert.equal(f.version, 1);
  for (const d of FRAG.permissions.deny) assert.ok(f.deny.includes(d), `fragment deny ${d} must be in the floor`);
  for (const p of K.SECRET_READ_PATTERNS) assert.ok(f.secret_read_patterns.includes(p), `built-in pattern ${p} must be in the floor`);
  assert.ok(f.credential_patterns.length >= 7);
  for (const p of f.credential_patterns) assert.doesNotThrow(() => new RegExp(p), `credential pattern compiles: ${p}`);
  assert.ok(f.max_researchers <= 8);
  assert.ok(K.credentialRegex().test('postgres://app:hunter2@db.internal:5432/prod')); // kit:allow-secret
  assert.ok(!K.credentialRegex().test('postgres://db.internal:5432/prod'));
});

test('bootstrap writes every floor deny entry into the project settings', (t) => {
  const root = bootstrapped(t);
  const deny = new Set(readSettings(root).permissions.deny);
  for (const d of K.loadFloor().deny) assert.ok(deny.has(d), d);
});

test('guard-read blocks a floor-only pattern even when the project settings are loosened', (t) => {
  const root = bootstrapped(t);
  // loosen the project file as far as it can go; the hook must not care
  const s = readSettings(root);
  s.permissions = { allow: ['Read(**)'], deny: [] };
  writeSettings(root, s);
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: root, tool_input: { file_path: path.join(root, '.kube', 'config') } });
  const r = runScript('hook_guard_read.js', [], { stdin: input });
  assert.equal(r.returncode, 2, r.stderr);
  assert.ok(r.stderr.includes('secret/credential pattern'));
  // a project may add patterns, and they are honoured
  const kit = path.join(root, '.claude', 'kit.json');
  const kj = JSON.parse(fs.readFileSync(kit, 'utf8'));
  kj.secret_patterns = ['**/vault/**'];
  fs.writeFileSync(kit, JSON.stringify(kj));
  const r2 = runScript('hook_guard_read.js', [], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: root, tool_input: { file_path: path.join(root, 'vault', 'x.txt') } }) });
  assert.equal(r2.returncode, 2);
});

test('splitRule and allowLoosens', () => {
  assert.deepEqual(splitRule('Read(.env)'), ['Read', '.env']);
  assert.deepEqual(splitRule('Bash'), ['Bash', '']);
  assert.equal(splitRule('not a rule!'), null);
  assert.ok(allowLoosens('Read(.env)', 'Read(.env)'));
  assert.ok(allowLoosens('Read(**)', 'Read(.env)'));
  assert.ok(allowLoosens('Read', 'Read(**/.ssh/**)'));
  assert.ok(allowLoosens('Bash(*)', 'Bash(sudo *)'));
  assert.ok(allowLoosens('Read(.en*)', 'Read(.env)'));
  assert.ok(!allowLoosens('Read(src/**)', 'Read(.env)'));
  assert.ok(!allowLoosens('Edit(src/**)', 'Read(.env)'));
  assert.ok(!allowLoosens('Bash(npm test *)', 'Bash(sudo *)'));
});

test('ci_security_floor passes a fresh project and fails every loosening', (t) => {
  const root = bootstrapped(t);
  const home = emptyHome(t);
  let r = run(root, home);
  assert.equal(r.returncode, 0, r.stderr);
  assert.ok(r.stdout.includes('at or above floor'));

  // 1. a floor deny entry removed from the project file (planted fault 22)
  const s = readSettings(root);
  const kept = s.permissions.deny.filter((d) => d !== 'Read(**/.ssh/**)');
  writeSettings(root, { ...s, permissions: { ...s.permissions, deny: kept } });
  r = run(root, home);
  assert.equal(r.returncode, 1);
  assert.ok(r.stderr.includes('missing floor entry Read(**/.ssh/**)'));
  writeSettings(root, s);

  // 2. an allow in the project-local scope that grants a floor-denied path
  const local = path.join(root, '.claude', 'settings.local.json');
  fs.writeFileSync(local, JSON.stringify({ permissions: { allow: ['Read(.env)'] } }));
  r = run(root, home);
  assert.equal(r.returncode, 1);
  assert.ok(r.stderr.includes('project-local scope allows "Read(.env)"'));
  fs.rmSync(local);

  // 3. disableAllHooks in the user scope
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ disableAllHooks: true }));
  r = run(root, home);
  assert.equal(r.returncode, 1);
  assert.ok(r.stderr.includes('disableAllHooks is set in user scope'));
  fs.rmSync(path.join(home, 'settings.json'));

  // 4. a managed file that allows the whole Bash tool
  const managed = path.join(home, 'managed.json');
  fs.writeFileSync(managed, JSON.stringify({ permissions: { allow: ['Bash'] } }));
  r = runScript('ci_security_floor.js', ['--repo', root, '--home', home, '--managed', managed]);
  assert.equal(r.returncode, 1);
  assert.ok(r.stderr.includes('managed scope allows "Bash"'));

  // 5. a project trying to redefine the floor
  const kit = path.join(root, '.claude', 'kit.json');
  const kj = JSON.parse(fs.readFileSync(kit, 'utf8'));
  fs.writeFileSync(kit, JSON.stringify({ ...kj, floor: { deny: [] } }));
  r = run(root, home);
  assert.equal(r.returncode, 1);
  assert.ok(r.stderr.includes('"floor" key'));
  fs.writeFileSync(kit, JSON.stringify(kj));

  // back to clean: passes again
  r = run(root, home);
  assert.equal(r.returncode, 0, r.stderr);
});

test('check() is pure and reports a missing settings file', (t) => {
  const root = path.join(tmpPath(t), 'empty');
  fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(check({ root, home: emptyHome(t), managed: [] }), ['.claude/settings.json missing; run /zi-bootstrap']);
  setEnv(t, 'CLAUDE_HOME', emptyHome(t));
});
