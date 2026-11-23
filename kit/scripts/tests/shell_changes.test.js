// What a Bash call changed in a lane (shell_changes.js) and the scope check post-edit-check builds on it.
//
// The first real-agent eval (main 516ffdd) had post-edit-check block `ls` and `npx tsc` in a lane run under srt,
// naming eleven paths srt had masked with /dev/null (character devices 1,3) and telling the agent to `git checkout --`
// them. These cases drive the hooks the way Claude Code does: guard-bash on PreToolUse, the command itself, then
// post-edit-check on PostToolUse, with the same tool_use_id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isoSeconds } from '../kitlib.js';
import * as S from '../shell_changes.js';
import { commitAll } from './fixtures.js';
import { SCRIPTS, makeRepo, runScript, tmpPath } from './helpers.js';
import { GOOD_SPEC } from './testdata.js';

const SID = 'sess-shell';
const write = (repo, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const read = (repo, rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A lane on the fixture repo whose spec allows src/routes.ts and src/__tests__/refund.test.ts. */
function laneRepo(t, kit = { commands: { test: 'true' } }) {
  const repo = makeRepo(t);
  write(repo, 'docs/specs/refund-endpoint.md', GOOD_SPEC);
  commitAll(repo, 'spec');
  write(repo, '.claude/lane.json', JSON.stringify({ feature: 'refund-endpoint', spec: 'docs/specs/refund-endpoint.md', stage: 'build', started: isoSeconds(new Date(Date.now() - 2 * 3.6e6)) }));
  write(repo, '.claude/kit.json', JSON.stringify(kit));
  return repo;
}

let seq = 0;
/** One Bash call as Claude Code makes it. `pre: false` is a session whose guard-bash took no snapshot. */
function call(repo, command, { pre = true, id = `toolu_${++seq}`, extra = {} } = {}) {
  const base = { session_id: SID, cwd: repo, tool_name: 'Bash', tool_input: { command }, tool_use_id: id, ...extra };
  if (pre) {
    const g = runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ ...base, hook_event_name: 'PreToolUse' }) });
    assert.equal(g.returncode, 0, g.stderr);
  }
  spawnSync('bash', ['-c', command], { cwd: repo, encoding: 'utf8' });
  const p = runScript('hook_post_edit_check.js', [], { stdin: JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: 'ok' }) });
  assert.equal(p.returncode, 0, p.stderr);
  const out = p.stdout.trim();
  return { out, reason: out ? JSON.parse(out).reason : '' };
}

// ---------------- the classifier ----------------

/** An lstat result of the given kind, the shape fs.lstatSync(p, { bigint: true }) returns. */
const fakeStat = (kind) => ({
  isSymbolicLink: () => kind === 'symlink',
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'dir',
  isCharacterDevice: () => kind === 'char',
  isBlockDevice: () => kind === 'block',
  isFIFO: () => kind === 'fifo',
  isSocket: () => kind === 'socket',
  size: 0n, ino: 7n, mtimeNs: 1n, ctimeNs: BigInt(Date.now()) * 1000000n,
});

test('classifier: devices, FIFOs and sockets are never content; files and symlinks are', () => {
  for (const k of ['char', 'block', 'fifo', 'socket']) assert.equal(S.kindOf(fakeStat(k)), 'special', k);
  assert.equal(S.kindOf(fakeStat('file')), 'file');
  assert.equal(S.kindOf(fakeStat('symlink')), 'symlink');
  assert.equal(S.kindOf(fakeStat('dir')), 'dir');
  assert.equal(S.kindOf(null), null);
  assert.deepEqual([...S.CONTENT_KINDS].sort(), ['file', 'symlink']);
});

test('classifier: a sandbox mask (character device 1,3, as srt mounts /dev/null) is never a change, even when new', () => {
  const lstat = () => fakeStat('char');
  const e = S.entryFor('/nonexistent/.bashrc', { lstat });
  assert.equal(e.k, 'special');
  assert.equal(e.h, undefined, 'a device is never opened or hashed');
  const before = { v: 1, taken: Date.now() - 10_000, entries: {} };
  const after = { v: 1, taken: Date.now(), entries: { '.bashrc': { xy: '??', ...e }, '.mcp.json': { xy: '??', ...e } } };
  assert.deepEqual(S.changedPaths(before, after), []);
  // a regular file where a mask was, or the reverse, is judged by what is there now
  const file = { xy: '??', k: 'file', c: Date.now(), m: 'x', h: 'aa' };
  assert.deepEqual(S.changedPaths({ ...before, entries: { '.bashrc': { xy: '??', ...e } } }, { ...after, entries: { '.bashrc': file } }).map((c) => c.rel), ['.bashrc']);
  assert.deepEqual(S.changedPaths({ ...before, entries: { '.bashrc': file } }, { ...after, entries: { '.bashrc': { xy: '??', ...e } } }), []);
});

test('classifier: content, not metadata, decides; HEAD moving under a path is not a write', () => {
  const t0 = Date.now() - 60_000;
  const f = (h, c = t0) => ({ xy: '??', k: 'file', c, m: `1:${c}`, h });
  const before = { v: 1, taken: t0 + 1000, entries: { 'notes.txt': f('aa'), 'gone.txt': f('bb') } };
  // same bytes rewritten (new mtime/ctime): unchanged; different bytes: changed
  assert.deepEqual(S.changedPaths(before, { v: 1, taken: Date.now(), entries: { 'notes.txt': f('aa', Date.now()) } }), []);
  assert.deepEqual(S.changedPaths(before, { v: 1, taken: Date.now(), entries: { 'notes.txt': f('cc', Date.now()) } }).map((c) => c.rel), ['notes.txt']);
  // not in the baseline (identical to HEAD then): changed only if written since the baseline, or deleted
  assert.deepEqual(S.changedPaths(before, { v: 1, taken: Date.now(), entries: { 'src/a.ts': { ...f('dd', t0 - 3_600_000), xy: 'M ' } } }), []);
  assert.deepEqual(S.changedPaths(before, { v: 1, taken: Date.now(), entries: { 'src/a.ts': { ...f('dd', Date.now()), xy: ' M' } } }).map((c) => c.rel), ['src/a.ts']);
  assert.deepEqual(S.changedPaths(before, { v: 1, taken: Date.now(), entries: { 'src/b.ts': { xy: ' D', k: null } } }).map((c) => c.rel), ['src/b.ts']);
  // the session-start fallback knows nothing of deletions and claims none
  assert.deepEqual(S.changedPaths({ ...before, entries: {}, partial: true }, { v: 1, taken: Date.now(), entries: { 'src/b.ts': { xy: ' D', k: null } } }), []);
  // symlinks are compared by target
  const l = (t) => ({ xy: '??', k: 'symlink', c: t0, t });
  assert.deepEqual(S.changedPaths({ ...before, entries: { ln: l('/dev/null') } }, { v: 1, taken: Date.now(), entries: { ln: l('/dev/null') } }), []);
  assert.deepEqual(S.changedPaths({ ...before, entries: { ln: l('/dev/null') } }, { v: 1, taken: Date.now(), entries: { ln: l('src/x') } }).map((c) => c.rel), ['ln']);
});

test('snapshot: real FIFO, character device and symlink to /dev/null are classified with lstat; a FIFO is never read', (t) => {
  const dir = tmpPath(t);
  spawnSync('mkfifo', [path.join(dir, 'fifo')]);
  fs.symlinkSync('/dev/null', path.join(dir, 'masked'));
  assert.equal(S.entryFor(path.join(dir, 'fifo')).k, 'special', 'reading it would hang; this returning at all is the proof');
  assert.deepEqual(S.entryFor(path.join(dir, 'masked')), { k: 'symlink', c: S.entryFor(path.join(dir, 'masked')).c, t: '/dev/null' });
  assert.equal(S.entryFor('/dev/null').k, 'special');
  const dev = path.join(dir, 'chardev');
  if (spawnSync('mknod', [dev, 'c', '1', '3']).status === 0) assert.equal(S.entryFor(dev).k, 'special');
  else t.diagnostic('mknod needs CAP_MKNOD; the character device case ran against /dev/null only');
});

// ---------------- the hooks, end to end ----------------

test('read-only calls are not blamed for what was there before them: masks, symlinks to /dev/null, untracked files', (t) => {
  const repo = laneRepo(t);
  // what srt leaves in a worktree, as far as an unprivileged test can make it, plus a human's untracked notes
  fs.symlinkSync('/dev/null', path.join(repo, '.mcp.json'));
  spawnSync('mkfifo', [path.join(repo, '.bashrc')]);
  spawnSync('mknod', [path.join(repo, '.gitconfig'), 'c', '1', '3']);
  write(repo, 'notes.txt', 'mine\n');
  for (const cmd of ['ls -la 2>/dev/null', 'git status', 'npx --no-install tsc --noEmit -p . 2>&1 | head -20', 'cat notes.txt > /dev/null']) {
    const r = call(repo, cmd);
    assert.equal(r.out, '', `${cmd}: ${r.reason}`);
  }
  // the same holds with no before-snapshot at all, from the first call of a session that started after they existed
  const repo2 = laneRepo(t);
  fs.symlinkSync('/dev/null', path.join(repo2, '.mcp.json'));
  write(repo2, 'notes.txt', 'mine\n');
  sleep(50);
  const transcript = path.join(repo2, '..', 'session.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'queue-operation', timestamp: new Date().toISOString() }) + '\n');
  assert.equal(call(repo2, 'ls 2>/dev/null', { pre: false, extra: { transcript_path: transcript } }).out, '');
});

test('real shell writes outside the spec are still caught, new untracked files included, with a remedy that works', (t) => {
  const cases = [
    ["echo '// x' >> src/payment.ts", 'src/payment.ts', 'git restore --source=HEAD --staged --worktree -- src/payment.ts'],
    ["sed -i 's/charge/charge2/' src/payment.ts", 'src/payment.ts', 'git restore --source=HEAD --staged --worktree -- src/payment.ts'],
    ["cat > src/other.ts <<'EOF'\nexport const x = 1;\nEOF", 'src/other.ts', 'rm -- src/other.ts'],
    // no redirect, no sed: SHELL_WRITES does not recognise it, the measured change does
    ['node -e "require(\'fs\').writeFileSync(\'evidence.txt\', \'x\')"', 'evidence.txt', 'rm -- evidence.txt'],
    ["rm src/payment.ts", 'src/payment.ts', 'git restore --source=HEAD --staged --worktree -- src/payment.ts'],
    ["echo x > 'my notes.md'", 'my notes.md', "rm -- 'my notes.md'"],
  ];
  for (const [cmd, rel, undo] of cases) {
    const repo = laneRepo(t);
    const r = call(repo, cmd);
    assert.ok(r.reason.includes('[scope]') && r.reason.includes(rel), `${cmd}: ${r.out}`);
    assert.ok(r.reason.includes(undo), `${cmd}: ${r.reason}`);
    assert.ok(!r.reason.includes('git checkout --'), r.reason);
    assert.match(read(repo, 'docs/specs/refund-endpoint.events.jsonl'), /shell edit outside spec/);
  }
  // inside the allow-list is fine
  const repo = laneRepo(t);
  assert.equal(call(repo, "echo '// ok' >> src/routes.ts").out, '');
});

test('a pre-existing untracked file is blamed only when the call changes its content', (t) => {
  const repo = laneRepo(t);
  write(repo, 'notes.txt', 'mine\n');
  assert.equal(call(repo, "printf 'mine\\n' > notes.txt").out, '', 'the same bytes written again are not a change');
  const r = call(repo, "echo more >> notes.txt");
  assert.ok(r.reason.includes('notes.txt') && r.reason.includes('rm -- notes.txt'), r.out);
});

test('without a before-snapshot the lane\'s last known state is the baseline', (t) => {
  const repo = laneRepo(t);
  write(repo, 'scratch.txt', 'x\n'); // out of scope, before the first call
  sleep(50);
  const transcript = path.join(repo, '..', 'session.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString() }) + '\n');
  const extra = { transcript_path: transcript };
  assert.equal(call(repo, 'ls', { pre: false, extra }).out, '');
  assert.ok(fs.existsSync(S.lastPath(repo)));
  // a later call with no snapshot of its own: what existed at the end of the previous run is not blamed, a new write is
  assert.equal(call(repo, 'ls 2>/dev/null', { pre: false, extra }).out, '');
  const r = call(repo, "echo y > scratch.txt", { pre: false, extra });
  assert.ok(r.reason.includes('scratch.txt'), r.out);
});

test('files the hook\'s own checks write are not blamed on the command, or on the next one', (t) => {
  const repo = laneRepo(t, { commands: { test: "sh -c 'echo run >> coverage.txt; echo 1 passed'" } });
  assert.equal(call(repo, "echo '// ok' >> src/routes.ts").out, '');
  assert.ok(fs.existsSync(path.join(repo, 'coverage.txt')));
  assert.equal(call(repo, 'ls').out, '');
  assert.equal(call(repo, "echo '// ok again' >> src/routes.ts").out, '');
});

test('a call guard-bash refused leaves no lasting state; stale before-snapshots are pruned', (t) => {
  const repo = laneRepo(t);
  const g = runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: repo, tool_name: 'Bash', tool_use_id: 'toolu_refused', tool_input: { command: 'git reset --hard' } }) });
  assert.equal(g.returncode, 2);
  assert.ok(!fs.existsSync(S.beforePath(repo, 'toolu_refused')));
  call(repo, 'ls', { id: 'toolu_old' });
  const old = S.beforePath(repo, 'toolu_old');
  const past = new Date(Date.now() - S.STALE_BEFORE_MS - 60_000);
  fs.utimesSync(old, past, past);
  call(repo, 'ls');
  assert.ok(!fs.existsSync(old));
});

test('srt reproduction: /dev/null bind-mounted over absent dotfiles (bubblewrap), then ls; nothing is blamed', (t) => {
  const probe = spawnSync('bwrap', ['--dev-bind', '/', '/', 'true']);
  if (probe.status !== 0) {
    t.skip('bubblewrap is not available or may not create namespaces here');
    return;
  }
  const repo = laneRepo(t);
  const masked = ['.bashrc', '.gitconfig', '.mcp.json', '.idea'];
  const base = { session_id: SID, cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls -la 2>/dev/null' }, tool_use_id: 'toolu_srt' };
  const preJson = path.join(repo, '..', 'pre.json');
  const postJson = path.join(repo, '..', 'post.json');
  fs.writeFileSync(preJson, JSON.stringify({ ...base, hook_event_name: 'PreToolUse' }));
  fs.writeFileSync(postJson, JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: 'ok' }));
  const node = JSON.stringify(process.execPath);
  const script = [
    `${node} ${JSON.stringify(path.join(SCRIPTS, 'hook_guard_bash.js'))} < ${JSON.stringify(preJson)} || exit 90`,
    'git status --porcelain --untracked-files=all; ls -la 2>/dev/null',
    `${node} ${JSON.stringify(path.join(SCRIPTS, 'hook_post_edit_check.js'))} < ${JSON.stringify(postJson)} > ../post.out`,
  ].join('\n');
  // as srt does for deny paths that do not exist: --ro-bind /dev/null <path>, which makes an empty file on the host
  const args = ['--dev-bind', '/', '/', ...masked.flatMap((m) => ['--ro-bind', '/dev/null', path.join(repo, m)]), '--chdir', repo, 'bash', '-c', script];
  const r = spawnSync('bwrap', args, { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  for (const m of masked) assert.match(r.stdout, new RegExp(`\\?\\? ${m.replace('.', '\\.')}`), `git lists ${m} inside the sandbox`);
  assert.match(r.stdout, /^c\S+ .* 1, +3 .*\.bashrc$/m, 'inside the sandbox it is character device 1,3');
  assert.equal(read(repo, '../post.out').trim(), '', 'post-edit-check blocked the read-only call');
});

test('performance: snapshots of a lane with thousands of changed files stay cheap', (t) => {
  const repo = laneRepo(t);
  for (let i = 0; i < 3000; i++) write(repo, `vendor/m${i % 30}/f${i}.js`, `module.exports = ${i};\n`.repeat(20));
  commitAll(repo, 'many tracked files');
  for (let i = 0; i < 1500; i++) write(repo, `build/out${i % 15}/g${i}.txt`, `${i}\n`.repeat(50));
  let t0 = performance.now();
  const first = S.snapshot(repo);
  const cold = performance.now() - t0;
  assert.equal(Object.keys(first.entries).filter((k) => k.startsWith('build/')).length, 1500);
  // a later snapshot reuses the hashes of files untouched since well before the previous one
  const prev = { ...first, taken: first.taken + S.RACY_MS + 1000 };
  t0 = performance.now();
  const second = S.snapshot(repo, prev);
  const warm = performance.now() - t0;
  assert.deepEqual(S.changedPaths(prev, second), []);
  t.diagnostic(`1500 untracked + 3000 tracked files: cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms`);
  assert.ok(cold < 5000 && warm < 3000, `cold ${cold} ms, warm ${warm} ms`);
});
