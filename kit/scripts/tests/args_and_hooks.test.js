// Tests for args.js (the command line parser every script uses), hook_notify.js and hook_session_context.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SCRIPTS, makeRepo, runScript, tmpPath } from './helpers.js';
import { ArgumentParser } from '../args.js';

// ---------------- args.js ----------------

function parser() {
  const p = new ArgumentParser({ prog: 'tool' });
  p.addArgument('--repo', { default: '.' });
  p.addArgument('--limit', { type: parseInt, default: 5 });
  p.addArgument('--ratio', { type: parseFloat });
  p.addArgument('--mode', { choices: ['fast', 'slow'], default: 'fast' });
  p.addArgument('--dry-run', { action: 'store_true' });
  p.addArgument('--tag', { action: 'append' });
  p.addArgument('-v', '--verbose', { action: 'count' });
  p.addArgument('target');
  p.addArgument('rest', { nargs: '*' });
  return p;
}

test('args: options, defaults, positionals and dest names', () => {
  const a = parser().parseArgs(['--limit', '9', '--dry-run', '--tag', 'a', '--tag=b', '-v', '-v', 'src', 'x', 'y']);
  assert.equal(a.repo, '.');
  assert.equal(a.limit, 9);
  assert.equal(a.dry_run, true);
  assert.deepEqual(a.tag, ['a', 'b']);
  assert.equal(a.verbose, 2);
  assert.equal(a.mode, 'fast');
  assert.equal(a.target, 'src');
  assert.deepEqual(a.rest, ['x', 'y']);
  assert.equal(parser().parseArgs(['t']).dry_run, false);
  assert.equal(parser().parseArgs(['t']).tag, null);
});

test('args: -- ends options, negative numbers are values', () => {
  const a = parser().parseArgs(['--limit', '-3', '--', '--not-an-option']);
  assert.equal(a.limit, -3);
  assert.equal(a.target, '--not-an-option');
});

test('args: subparsers route to the right parser', () => {
  const p = new ArgumentParser({ prog: 'lane' });
  const sub = p.addSubparsers({ dest: 'cmd', required: true });
  sub.addParser('start').addArgument('slug');
  sub.addParser('status').addArgument('--json', { action: 'store_true' });
  assert.deepEqual({ ...p.parseArgs(['start', 'refund']) }, { cmd: 'start', slug: 'refund' });
  assert.equal(p.parseArgs(['status', '--json']).json, true);
});

function failure(argvScript) {
  const url = pathToFileURL(path.join(SCRIPTS, 'args.js')).href;
  const code = `import { ArgumentParser } from ${JSON.stringify(url)};\n${argvScript}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
}

test('args: invalid input exits 2 with a usage line and a clear message, like argparse', () => {
  const setup = `const p = new ArgumentParser({ prog: 'tool' }); p.addArgument('--n', { type: parseInt }); p.addArgument('--m', { choices: ['a'] }); p.addArgument('x');\n`;
  const cases = [
    ['p.parseArgs(["--n","abc","x"])', "invalid int value: 'abc'"],
    ['p.parseArgs(["--m","z","x"])', 'invalid choice'],
    ['p.parseArgs([])', 'the following arguments are required: x'],
    ['p.parseArgs(["x","--nope"])', 'unrecognized arguments: --nope'],
    ['p.parseArgs(["--n"])', 'expected one argument'],
  ];
  for (const [call, message] of cases) {
    const r = failure(setup + call);
    assert.equal(r.status, 2, call);
    assert.match(r.stderr, /^usage: tool/m, call);
    assert.ok(r.stderr.includes(`tool: error: `) && r.stderr.includes(message), `${call}: ${r.stderr}`);
  }
});

test('args: --help prints usage and exits 0', () => {
  const r = failure(`const p = new ArgumentParser({ prog: 'tool', description: 'does a thing' }); p.addArgument('--n'); p.parseArgs(['--help']);`);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: tool/);
  assert.ok(r.stdout.includes('does a thing'));
});

// ---------------- hook_notify.js ----------------

/** Run a script asynchronously, so a local server in this process can answer while it runs. */
function runAsync(name, stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, name)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ returncode: code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function withWebhook(t, fn) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/hook`, received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function notifyEnv(t, cfg) {
  const home = tmpPath(t);
  if (cfg !== undefined) fs.writeFileSync(path.join(home, 'kit-notify.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  // PATH is emptied so a desktop notification command can never fire from a test.
  return { ...process.env, CLAUDE_HOME: home, PATH: '' };
}

test('notify: a Notification event posts the message to the configured webhook', async (t) => {
  await withWebhook(t, async (url, received) => {
    const env = notifyEnv(t, { webhook: url, desktop: false });
    const r = await runAsync('hook_notify.js', JSON.stringify({ hook_event_name: 'Notification', message: 'needs a decision', cwd: tmpPath(t) }), env);
    assert.equal(r.returncode, 0, r.stderr);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.match(received[0].type, /application\/json/);
    assert.deepEqual(JSON.parse(received[0].body), { text: 'Claude needs you: needs a decision' });
  });
});

test('notify: Stop in a lane reports the lane, Stop outside a lane and other events say nothing', async (t) => {
  await withWebhook(t, async (url, received) => {
    const env = notifyEnv(t, { webhook: url, desktop: false });
    const repo = makeRepo(t);
    const empty = await runAsync('hook_notify.js', '', env);
    assert.equal(empty.returncode, 0);
    const stopNoLane = await runAsync('hook_notify.js', JSON.stringify({ hook_event_name: 'Stop', cwd: repo }), env);
    const other = await runAsync('hook_notify.js', JSON.stringify({ hook_event_name: 'PreToolUse', cwd: repo }), env);
    assert.equal(stopNoLane.returncode, 0);
    assert.equal(other.returncode, 0);
    assert.equal(received.length, 0);

    fs.writeFileSync(path.join(repo, '.claude', 'lane.json'), JSON.stringify({ feature: 'refund-endpoint', spec: 'docs/specs/refund-endpoint.md', stage: 'build', started: '2026-11-08T10:00:00' }));
    const stop = await runAsync('hook_notify.js', JSON.stringify({ hook_event_name: 'Stop', cwd: repo }), env);
    assert.equal(stop.returncode, 0, stop.stderr);
    assert.equal(received.length, 1);
    assert.match(JSON.parse(received[0].body).text, /^Lane refund-endpoint: stopped: Check \/zi-status/);
  });
});

test('notify: an unreachable webhook, a corrupt config or a non-string webhook never fail the hook', async (t) => {
  const event = JSON.stringify({ hook_event_name: 'Notification', message: 'x', cwd: tmpPath(t) });
  for (const cfg of [{ webhook: 'http://127.0.0.1:1/none', desktop: false }, '{not json', '[]', { webhook: 42, desktop: false }]) {
    const r = await runAsync('hook_notify.js', event, notifyEnv(t, cfg));
    assert.equal(r.returncode, 0, `${JSON.stringify(cfg)}: ${r.stderr}`);
  }
});

// ---------------- hook_session_context.js ----------------

test('session context: prints nothing outside a lane with no debt', (t) => {
  const repo = makeRepo(t);
  const r = runScript('hook_session_context.js', [], { stdin: JSON.stringify({ cwd: repo }) });
  assert.equal(r.returncode, 0);
  assert.equal(r.stdout.trim(), '');
});

test('session context: re-injects LESSONS debt and the active lane spec after a compaction', (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'LESSONS.md'), '# Lessons\n\n## Debt\n- Never log card numbers (no check yet)\n\n## Other\n- not shown\n');
  fs.writeFileSync(
    path.join(repo, 'docs', 'specs', 'refund-endpoint.md'),
    '# Spec\n\n## Summary\nAdd a refund endpoint.\n\n## Files to change\n- src/payment.ts\n\n## Done-criteria\n- refund returns 200\n',
  );
  fs.writeFileSync(path.join(repo, '.claude', 'lane.json'), JSON.stringify({ feature: 'refund-endpoint', spec: 'docs/specs/refund-endpoint.md', stage: 'build', started: '2026-11-08T10:00:00' }));
  const r = runScript('hook_session_context.js', [], { stdin: JSON.stringify({ cwd: repo, hook_event_name: 'SessionStart', source: 'compact' }) });
  assert.equal(r.returncode, 0, r.stderr);
  assert.ok(r.stdout.includes('Never log card numbers'), r.stdout);
  assert.ok(!r.stdout.includes('not shown'));
  assert.ok(r.stdout.includes('# Active lane: refund-endpoint'));
  assert.ok(r.stdout.includes('Add a refund endpoint.') && r.stdout.includes('src/payment.ts') && r.stdout.includes('refund returns 200'));
  assert.ok(r.stdout.includes('tests before code'));
});

test('session context: garbage input never fails the hook', () => {
  for (const stdin of ['', 'not json', '[]', '{"cwd": 5}']) {
    const r = runScript('hook_session_context.js', [], { stdin });
    assert.equal(r.returncode, 0, `${stdin}: ${r.stderr}`);
  }
});
