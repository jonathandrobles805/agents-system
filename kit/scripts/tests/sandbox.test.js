// The lane sandbox (KIT-SPEC 10.9, decision 0008): runtime detection, configuration from floor and spec, the credential
// scan, the launch command, and lane.js start/launch behaviour in every runtime state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as K from '../kitlib.js';
import { ALLOW_MARKER, SRT_REQUIRED_KEYS, credentialScan, detectRuntime, launchCommand, sandboxConfig, specNetwork, srtSettings } from '../sandbox.js';
import * as F from './fixtures.js';
import { runScript, tmpPath } from './helpers.js';
import { project } from './testdata.js';

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const write = (p, t) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
};

/** A bootstrapped repo with an approved spec, ready for lane.js start. The fixture spec is high-risk (payments). */
function approvedRepo(t, { highRisk = true } = {}) {
  const { root } = project(t);
  if (!highRisk) {
    const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
    // three lines so the fixture's `:1-3` and `:3-3` citations stay in range; no high-risk path or keyword anywhere in the spec
    write(path.join(root, 'src', 'util', 'format.ts'), 'export const f = (x: string) => x;\nexport const g = (x: string) => x.trim();\nexport const h = (x: string) => x.toUpperCase();\n');
    write(sp, read(sp).replace(/^- Risk:.*$/m, '- Risk: low').replaceAll('src/domain/payment.ts', 'src/util/format.ts').replaceAll('src/api/routes.ts', 'src/util/format.ts'));
    F.commitAll(root, 'low-risk spec');
  }
  return root;
}
const envWith = (runtime) => ({ ...process.env, KIT_SANDBOX_RUNTIME: runtime });
const laneJson = (root) => JSON.parse(read(path.dirname(root), `${path.basename(root)}-lanes`, 'refund-route', '.claude', 'lane.json'));
const events = (root) => read(path.dirname(root), `${path.basename(root)}-lanes`, 'refund-route', '.claude', 'session', 'events.jsonl');

test('detectRuntime honours the override and names its reason', () => {
  assert.deepEqual(detectRuntime({ KIT_SANDBOX_RUNTIME: 'none' }), { runtime: null, how: 'KIT_SANDBOX_RUNTIME=none' });
  assert.equal(detectRuntime({ KIT_SANDBOX_RUNTIME: 'srt' }).runtime, 'srt');
  const c = detectRuntime({ KIT_SANDBOX_RUNTIME: 'container', KIT_CONTAINER_ENGINE: 'podman' });
  assert.equal(c.runtime, 'container');
  assert.equal(c.engine, 'podman');
  assert.equal(detectRuntime({ KIT_SANDBOX_RUNTIME: 'firecracker' }).runtime, null);
  const real = detectRuntime({});
  assert.ok(typeof real.how === 'string' && real.how.length > 10);
});

test('sandboxConfig: floor domains plus the spec Network section, deny paths from the floor, writes only the worktree and scratch', (t) => {
  const root = approvedRepo(t);
  const sp = path.join(root, 'docs', 'specs', 'refund-route.md');
  fs.appendFileSync(sp, '\n## Network\n\n- `api.stripe.com`\n- example.org\n- not a domain\n');
  assert.deepEqual(specNetwork(sp), ['api.stripe.com', 'example.org']);
  const cfg = sandboxConfig({ root, wt: root, slug: 'refund-route', env: envWith('srt') });
  assert.equal(cfg.runtime, 'srt');
  assert.equal(cfg.state, 'contained');
  assert.ok(cfg.allowedDomains.includes('registry.npmjs.org') && cfg.allowedDomains.includes('api.stripe.com'));
  assert.ok(!cfg.allowedDomains.includes('not'));
  assert.equal(cfg.allowWrite[0], root);
  assert.ok(cfg.allowWrite[1].startsWith(os.tmpdir()));
  assert.ok(cfg.denyRead.some((p) => p.endsWith(path.join('.ssh'))));
  assert.ok(cfg.denyRead.some((p) => p === path.join(root, '.env') || p.endsWith(path.join(root, '**', '.env'))));
  assert.equal(cfg.failIfUnavailable, true);
  // the exact shape srt accepts (verified on macOS 2026-11-10; a missing key makes srt refuse the file)
  const s = srtSettings(cfg);
  assert.deepEqual(Object.keys(s).sort(), ['filesystem', 'network']);
  for (const [section, keys] of Object.entries(SRT_REQUIRED_KEYS)) {
    for (const k of keys) assert.ok(Array.isArray(s[section][k]), `${section}.${k} present and a list`);
  }
  assert.deepEqual(s.network.allowedDomains, cfg.allowedDomains);
  assert.deepEqual(s.filesystem.allowWrite, cfg.allowWrite);
  assert.deepEqual(s.filesystem.denyRead, cfg.denyRead);
  assert.ok(!('sandbox' in s), 'no nested sandbox key: srt would refuse it');
  // a role cannot widen the lane: the sandbox boundary is the lane process and the kit's agents are subagents
  // inside one lane session, so the floor carries no per-agent list and `agent` is recorded, not enforced
  const r = sandboxConfig({ root, wt: root, slug: 'refund-route', agent: 'researcher', env: envWith('srt') });
  assert.deepEqual(r.allowedDomains, cfg.allowedDomains);
  assert.ok(!r.allowedDomains.includes('*'));
  // no runtime: degraded, and the config says so instead of pretending
  const d = sandboxConfig({ root, wt: root, slug: 'refund-route', env: envWith('none') });
  assert.equal(d.runtime, null);
  assert.equal(d.state, 'degraded');
});

test('launchCommand per runtime', () => {
  const base = { allowWrite: ['/w', '/tmp/s'], allowedDomains: ['a.example'], engine: 'docker' };
  const srt = launchCommand({ ...base, runtime: 'srt' }, { wt: '/w', settingsPath: '/w/.claude/session/sandbox.json', prompt: '/kit x' });
  assert.deepEqual(srt.slice(0, 4), ['srt', '--settings', '/w/.claude/session/sandbox.json', '--']);
  assert.ok(srt.includes('claude') && srt.includes('/kit x'));
  const c = launchCommand({ ...base, runtime: 'container' }, { wt: '/w', settingsPath: '/x', prompt: 'p' });
  assert.equal(c[0], 'docker');
  assert.ok(c.includes('--network') && c.includes('kit-lane') && c.includes('/w:/w') && c.includes('KIT_ALLOWED_DOMAIN=a.example'));
  const none = launchCommand({ ...base, runtime: null }, { wt: '/w', settingsPath: '/x', prompt: 'p' });
  assert.equal(none[0], 'claude');
});

test('credentialScan finds content the floor names, skips denied files, honours the marker', (t) => {
  const root = path.join(tmpPath(t), 'repo');
  write(path.join(root, 'src', 'config.ts'), 'export const url = "postgres://app:S3cret@db.internal:5432/prod";\n');
  write(path.join(root, '.env'), 'STRIPE=sk_live_abcdefghijklmnop\n');
  write(path.join(root, 'tests', 'fixture.ts'), `const fake = "sk_live_abcdefghijklmnop"; // ${ALLOW_MARKER}\n`);
  write(path.join(root, 'node_modules', 'x', 'index.js'), 'const k = "AKIAABCDEFGHIJKLMNOP";\n');
  write(path.join(root, 'README.md'), 'no secrets here\n');
  const hits = credentialScan(root);
  assert.deepEqual(hits.map((h) => h.path), ['src/config.ts']);
  assert.equal(hits[0].line, 1);
});

test('lane.js start: records the sandbox state and runtime, writes the settings file, logs an event', (t) => {
  const root = approvedRepo(t);
  const r = runScript('lane.js', ['start', 'refund-route', '--repo', root], { env: envWith('container') });
  assert.equal(r.returncode, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.sandbox, 'contained');
  assert.equal(out.runtime, 'container');
  const lj = laneJson(root);
  assert.equal(lj.risk, 'high');
  assert.equal(lj.sandbox.state, 'contained');
  assert.equal(lj.sandbox.runtime, 'container');
  assert.ok(fs.existsSync(path.join(out.worktree, lj.sandbox.settings)));
  assert.ok(events(root).includes('"event": "sandbox"'));
  // launch prints the command for the recorded runtime and refuses a runtime change
  const l = runScript('lane.js', ['launch', 'refund-route', '--repo', root], { env: envWith('container') });
  assert.equal(l.returncode, 0, l.stderr);
  const cmd = JSON.parse(l.stdout);
  assert.equal(cmd.command[0], 'docker');
  assert.equal(cmd.cwd, out.worktree);
  const changed = runScript('lane.js', ['launch', 'refund-route', '--repo', root], { env: envWith('srt') });
  assert.equal(changed.returncode, 2);
  assert.ok(changed.stderr.includes('runtime changed since start'));
});

test('lane.js start: high-risk is refused without the container runtime, and the worktree is not left behind (fault 23)', (t) => {
  const root = approvedRepo(t);
  for (const rt of ['none', 'srt']) {
    const r = runScript('lane.js', ['start', 'refund-route', '--repo', root], { env: envWith(rt) });
    assert.equal(r.returncode, 2, r.stdout);
    assert.ok(r.stderr.includes('high-risk lane requires the container sandbox runtime'), r.stderr);
    assert.ok(r.stderr.includes('high_risk_waiver'));
    assert.ok(!fs.existsSync(path.join(path.dirname(root), `${path.basename(root)}-lanes`, 'refund-route')), `worktree removed after refusal (${rt})`);
  }
});

test('lane.js start: a normal-risk lane runs degraded with no runtime, loudly and on record (fault 23)', (t) => {
  const root = approvedRepo(t, { highRisk: false });
  const r = runScript('lane.js', ['start', 'refund-route', '--repo', root], { env: envWith('none') });
  assert.equal(r.returncode, 0, r.stderr);
  assert.ok(r.stderr.includes('DEGRADED'));
  assert.equal(JSON.parse(r.stdout).sandbox, 'degraded');
  const lj = laneJson(root);
  assert.equal(lj.risk, 'normal');
  assert.equal(lj.sandbox.state, 'degraded');
  assert.equal(lj.sandbox.runtime, null);
  assert.ok(events(root).includes('DEGRADED'));
});

test('lane.js start: a human waiver lets a high-risk lane run without the container, recorded on the lane and in events', (t) => {
  const root = approvedRepo(t);
  const kj = path.join(root, '.claude', 'kit.json');
  const kit = JSON.parse(read(kj));
  kit.sandbox = { high_risk_waiver: { by: 'Jonathan', reason: 'laptop without docker; wallet code is reviewed by hand' } };
  fs.writeFileSync(kj, JSON.stringify(kit, null, 2));
  const r = runScript('lane.js', ['start', 'refund-route', '--repo', root], { env: envWith('srt') });
  assert.equal(r.returncode, 0, r.stderr);
  assert.ok(r.stderr.includes('WAIVED by Jonathan'));
  const lj = laneJson(root);
  assert.equal(lj.sandbox.high_risk_waiver.by, 'Jonathan');
  assert.ok(events(root).includes('"event": "waiver"'));
  // a waiver without a reason is not a waiver
  kit.sandbox = { high_risk_waiver: { by: 'Jonathan' } };
  fs.writeFileSync(kj, JSON.stringify(kit, null, 2));
  runScript('lane.js', ['finish', 'refund-route', '--repo', root]);
  const r2 = runScript('lane.js', ['start', 'refund-route', '--repo', root], { env: envWith('srt') });
  assert.equal(r2.returncode, 2);
});

test('lane.js start: credential-looking content the lane could read is refused (fault 24)', (t) => {
  const root = approvedRepo(t);
  write(path.join(root, 'src', 'db.ts'), 'export const url = "mongodb+srv://svc:Pa55word@cluster0.example.net/app";\n');
  F.commitAll(root, 'leak');
  const r = runScript('lane.js', ['start', 'refund-route', '--repo', root], { env: envWith('container') });
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('credential-looking content') && r.stderr.includes('src/db.ts:1'), r.stderr);
  assert.ok(!fs.existsSync(path.join(path.dirname(root), `${path.basename(root)}-lanes`, 'refund-route')));
  // the same value in a file the sandbox denies anyway (.env) is not a reason to refuse
  fs.rmSync(path.join(root, 'src', 'db.ts'));
  write(path.join(root, '.env'), 'DB=mongodb+srv://svc:Pa55word@cluster0.example.net/app\n');
  F.commitAll(root, 'env only');
  const r2 = runScript('lane.js', ['start', 'refund-route', '--repo', root], { env: envWith('container') });
  assert.equal(r2.returncode, 0, r2.stderr);
});

test('max_concurrent_lanes is the limit; wip_limit remains as the older name', (t) => {
  const root = approvedRepo(t);
  const kj = path.join(root, '.claude', 'kit.json');
  const kit = JSON.parse(read(kj));
  kit.max_concurrent_lanes = 5;
  kit.wip_limit = 1;
  fs.writeFileSync(kj, JSON.stringify(kit, null, 2));
  const r = runScript('lane.js', ['wip', '--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).limit, 5);
});
