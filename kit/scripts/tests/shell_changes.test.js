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
import { spawn, spawnSync } from 'node:child_process';
import { isoSeconds } from '../kitlib.js';
import * as S from '../shell_changes.js';
import { commitAll, git } from './fixtures.js';
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
  const baseCommit = git(['rev-parse', 'HEAD'], repo).trim();
  const started = isoSeconds(new Date(Date.now() - 2 * 3.6e6));
  write(repo, '.claude/lane.json', JSON.stringify({ feature: 'refund-endpoint', spec: 'docs/specs/refund-endpoint.md', stage: 'build', started, created: started, base_commit: baseCommit, start_commit: baseCommit }));
  write(repo, '.claude/kit.json', JSON.stringify(kit));
  return repo;
}

let seq = 0;
/**
 * The session's transcript, as Claude Code passes it to every hook: started at the session's first call, so what the
 * test wrote before that call existed before the session.
 */
function transcriptFor(repo) {
  const tp = path.join(repo, '..', 'session.jsonl');
  if (!fs.existsSync(tp)) {
    sleep(15);
    fs.writeFileSync(tp, JSON.stringify({ type: 'queue-operation', timestamp: new Date().toISOString() }) + '\n');
  }
  return tp;
}

/** One Bash call as Claude Code makes it. `pre: false` is a session whose guard-bash took no snapshot. */
function call(repo, command, { pre = true, id = `toolu_${++seq}`, extra = {} } = {}) {
  const base = { session_id: SID, cwd: repo, tool_name: 'Bash', tool_input: { command }, tool_use_id: id, transcript_path: transcriptFor(repo), ...extra };
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
  size: 0, ino: 7, mtimeMs: 1, ctimeMs: Date.now(),
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
    ["echo '// x' >> src/payment.ts", 'src/payment.ts', 'git restore --source=BASE --staged --worktree -- src/payment.ts'],
    ["sed -i 's/charge/charge2/' src/payment.ts", 'src/payment.ts', 'git restore --source=BASE --staged --worktree -- src/payment.ts'],
    ["cat > src/other.ts <<'EOF'\nexport const x = 1;\nEOF", 'src/other.ts', 'rm -- src/other.ts'],
    // no redirect, no sed: SHELL_WRITES does not recognise it, the measured change does
    ['node -e "require(\'fs\').writeFileSync(\'evidence.txt\', \'x\')"', 'evidence.txt', 'rm -- evidence.txt'],
    ["rm src/payment.ts", 'src/payment.ts', 'git restore --source=BASE --staged --worktree -- src/payment.ts'],
    ["echo x > 'my notes.md'", 'my notes.md', "rm -- 'my notes.md'"],
  ];
  for (const [cmd, rel, undo] of cases) {
    const repo = laneRepo(t);
    const r = call(repo, cmd);
    assert.ok(r.reason.includes('[scope]') && r.reason.includes(rel), `${cmd}: ${r.out}`);
    const base = git(['rev-parse', 'HEAD'], repo).trim().slice(0, 12);
    assert.ok(r.reason.includes(undo.replace('BASE', base)), `${cmd}: ${r.reason}`);
    assert.ok(!r.reason.includes('git checkout --'), r.reason);
    assert.match(read(repo, 'docs/specs/refund-endpoint.events.jsonl'), /shell edit outside spec/);
  }
  // inside the allow-list is fine
  const repo = laneRepo(t);
  assert.equal(call(repo, "echo '// ok' >> src/routes.ts").out, '');
});

test('a pre-existing untracked file is blamed only when the call changes its content, and never told to delete it', (t) => {
  const repo = laneRepo(t);
  write(repo, 'notes.txt', 'mine\n');
  assert.equal(call(repo, "printf 'mine\\n' > notes.txt").out, '', 'the same bytes written again are not a change');
  const r = call(repo, 'echo more >> notes.txt');
  assert.ok(r.reason.includes('notes.txt') && r.reason.includes('put back the content notes.txt had before'), r.out);
  assert.ok(!r.reason.includes('rm -- notes.txt'), 'the human\'s file must not be deleted to undo the command');
  // putting the old content back clears it
  assert.ok(call(repo, 'ls').reason.includes('notes.txt'), 'still flagged while changed');
  assert.equal(call(repo, "printf 'mine\\n' > notes.txt").out, '');
  assert.equal(call(repo, 'ls').out, '');
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

test('a call guard-bash refused leaves nothing; files of calls that never reached PostToolUse are pruned by age', (t) => {
  const repo = laneRepo(t);
  const g = runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: repo, tool_name: 'Bash', tool_use_id: 'toolu_refused', tool_input: { command: 'git reset --hard' } }) });
  assert.equal(g.returncode, 2);
  assert.ok(!fs.existsSync(S.beforePath(repo, 'toolu_refused')));
  // allowed by guard-bash, then denied by the permission prompt or interrupted: no PostToolUse ever comes
  const pre = (id) => runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: repo, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'ls' } }) });
  pre('toolu_denied');
  const orphan = S.beforePath(repo, 'toolu_denied');
  assert.ok(fs.existsSync(orphan));
  const tmp = path.join(path.dirname(orphan), 'last.json.123.abcd.tmp');
  fs.writeFileSync(tmp, '{');
  call(repo, 'ls');
  assert.ok(fs.existsSync(orphan) && fs.existsSync(tmp), 'young files may belong to a call still running');
  const old = new Date(Date.now() - S.ORPHAN_MS - 60_000);
  fs.utimesSync(orphan, old, old);
  fs.utimesSync(tmp, old, old);
  call(repo, 'ls');
  assert.ok(!fs.existsSync(orphan) && !fs.existsSync(tmp));
});

test('the state directory does not grow: 50 calls leave the lane state and nothing per call', (t) => {
  const repo = laneRepo(t);
  const dir = path.dirname(S.lastPath(repo));
  for (let i = 0; i < 50; i++) {
    const r = call(repo, i % 5 === 0 ? `echo '// ${i}' >> src/routes.ts` : 'ls 2>/dev/null');
    assert.equal(r.out, '', `call ${i}: ${r.reason}`);
  }
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names.filter((n) => /^(before|claim)\.|\.tmp$/.test(n)), [], names.join(' '));
  assert.ok(names.length <= 5, names.join(' ')); // last, windows, flagged, origin and checks .json
  // a read-only call does not rewrite the recorded state
  const m0 = fs.statSync(S.lastPath(repo)).mtimeMs;
  sleep(20);
  call(repo, 'ls');
  assert.equal(fs.statSync(S.lastPath(repo)).mtimeMs, m0);
  // and the before-file of a call with nothing new is a reference, not a copy
  runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: repo, tool_name: 'Bash', tool_use_id: 'toolu_ref', tool_input: { command: 'ls' } }) });
  assert.ok(fs.statSync(S.beforePath(repo, 'toolu_ref')).size < 300);
});

test('an out-of-scope file is reported on every later call until it is undone (the review\'s repro)', (t) => {
  const repo = laneRepo(t);
  let r = call(repo, `node -e "require('fs').writeFileSync('out.txt', 'x')"`);
  assert.ok(r.reason.includes('this shell command changed') && r.reason.includes('out.txt'), r.out);
  r = call(repo, 'echo hi > src/routes.ts');
  assert.ok(r.reason.includes('[scope]') && r.reason.includes('an earlier shell command changed are still there: out.txt'), r.out);
  assert.ok(r.reason.includes('rm -- out.txt'), r.reason);
  assert.ok(call(repo, 'ls').reason.includes('out.txt'), 'a read-only call is told too');
  // an Edit or Write run reports it as well
  const e = runScript('hook_post_edit_check.js', [], { stdin: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SID, cwd: repo, tool_name: 'Edit', tool_input: { file_path: 'src/routes.ts' } }) });
  assert.ok(JSON.parse(e.stdout).reason.includes('out.txt'), e.stdout);
  // removed: cleared
  assert.equal(call(repo, 'rm -- out.txt').out, '');
  assert.equal(call(repo, 'ls').out, '');
  // a tracked file: cleared when restored to HEAD
  assert.ok(call(repo, "echo '// x' >> src/payment.ts").reason.includes('src/payment.ts'));
  assert.ok(call(repo, 'ls').reason.includes('src/payment.ts'));
  assert.equal(call(repo, 'git restore --staged --worktree -- src/payment.ts').out, '');
  assert.equal(call(repo, 'ls').out, '');
});

test('done-check refuses "done" while a flagged path is still there, unless an escalation is written', (t) => {
  const repo = laneRepo(t);
  write(repo, 'docs/specs/refund-endpoint.progress.md', '# Progress: refund-endpoint\n\n## Done-criteria\n\n| # | Criterion | Test | Red run | Green run |\n|---|---|---|---|---|\n\n## Escalation\n\n- Attempts: {{n}}\n- Failure: —\n');
  const stop = () => runScript('hook_done_check.js', [], { stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: repo, stop_hook_active: false }) });
  call(repo, `node -e "require('fs').writeFileSync('out.txt', 'x')"`);
  let r = stop();
  assert.match(JSON.parse(r.stdout).reason, /done-check: files outside the spec's allow-list .* still changed: out\.txt/);
  fs.rmSync(path.join(repo, 'out.txt'));
  r = stop();
  assert.doesNotMatch(r.stdout, /out\.txt/, 'cleared once removed; the other checks decide');
  call(repo, `node -e "require('fs').writeFileSync('out.txt', 'x')"`);
  write(repo, 'docs/specs/refund-endpoint.progress.md', read(repo, 'docs/specs/refund-endpoint.progress.md').replace('- Attempts: {{n}}\n- Failure: —', '- Attempts: 1 of 3\n- Failure: the spec needs out.txt'));
  r = stop();
  assert.equal(r.stdout.trim(), '', 'an escalation is the other way out');
});

test('two runs of post-edit-check for one call (settings and frontmatter) report the same and leave nothing', async (t) => {
  const repo = laneRepo(t);
  const base = { session_id: SID, cwd: repo, tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'toolu_dup' };
  runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ ...base, hook_event_name: 'PreToolUse' }) });
  write(repo, 'out.txt', 'x');
  const post = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(SCRIPTS, 'hook_post_edit_check.js')]);
    let out = '';
    c.stdout.on('data', (b) => (out += b));
    c.on('close', () => resolve(out.trim()));
    c.stdin.end(JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: 'ok' }));
  });
  const [a, b] = await Promise.all([post(), post()]);
  for (const o of [a, b]) assert.ok(JSON.parse(o).reason.includes('this shell command changed files outside the spec\'s allow-list: out.txt'), o);
  const left = fs.readdirSync(path.dirname(S.lastPath(repo))).filter((n) => /^(before|claim)\.|\.tmp$/.test(n));
  assert.deepEqual(left, []);
});

test('overlapping calls: a change is not put on a command that may not have made it, and still blocks', (t) => {
  const repo = laneRepo(t);
  const pre = (id, command) => runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: repo, tool_name: 'Bash', tool_use_id: id, tool_input: { command } }) });
  const post = (id, command, extra = {}) => {
    const p = runScript('hook_post_edit_check.js', [], { stdin: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SID, cwd: repo, tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: 'ok', ...extra }) });
    return p.stdout.trim() ? JSON.parse(p.stdout).reason : '';
  };
  // A (read-only) and B (a write) run in parallel; A finishes first
  pre('toolu_A', 'ls');
  pre('toolu_B', 'node gen.js');
  write(repo, 'out.txt', 'from B');
  const ra = post('toolu_A', 'ls');
  assert.ok(ra.includes('changed while other shell commands were running alongside this one') && ra.includes('out.txt'), ra);
  assert.ok(!ra.includes('this shell command changed'), 'the read-only call is not told it wrote the file');
  const rb = post('toolu_B', 'node gen.js');
  assert.ok(rb.includes('out.txt') && rb.includes('[scope]'), rb);
  // a before-file left by a call the transcript shows as finished (denied) is not an overlap
  const repo2 = laneRepo(t);
  const transcript = path.join(repo2, '..', 'session.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ timestamp: new Date(Date.now() - 1000).toISOString() }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_denied', is_error: true, content: 'denied' }] } }) + '\n');
  runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: repo2, tool_name: 'Bash', tool_use_id: 'toolu_denied', tool_input: { command: 'curl x' } }) });
  const r = call(repo2, `node -e "require('fs').writeFileSync('out.txt', 'x')"`, { extra: { transcript_path: transcript } });
  assert.ok(r.reason.includes('this shell command changed files outside the spec\'s allow-list: out.txt'), r.reason);
});

test('every scope block says not to mark anything done in build, read-only calls included', (t) => {
  const repo = laneRepo(t);
  call(repo, `node -e "require('fs').writeFileSync('out.txt', 'x')"`); // not write-like to SHELL_WRITES
  const r = call(repo, 'ls');
  assert.ok(r.reason.startsWith('post-edit-check found problems. Fix them before continuing; do not mark anything done.'), r.reason);
  const w = call(repo, "echo '// ok' >> src/routes.ts");
  assert.ok(w.reason.startsWith('post-edit-check found problems. Fix them before continuing; do not mark anything done.'), w.reason);
});

const stopCheck = (repo) => runScript('hook_done_check.js', [], { stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: repo, stop_hook_active: false, transcript_path: transcriptFor(repo) }) });
const PROGRESS = '# Progress: refund-endpoint\n\n## Done-criteria\n\n| # | Criterion | Test | Red run | Green run |\n|---|---|---|---|---|\n\n## Escalation\n\n- Attempts: {{n}}\n- Failure: —\n';

test('committing a flagged file does not clear it; judged against the lane\'s base commit (the review\'s repro)', (t) => {
  const repo = makeRepo(t);
  write(repo, 'README.md', '# proj\n');
  commitAll(repo, 'readme');
  const repo2 = repo; // laneRepo on an existing repo: spec + lane.json with base_commit
  write(repo2, 'docs/specs/refund-endpoint.md', GOOD_SPEC);
  commitAll(repo2, 'spec');
  const baseCommit = git(['rev-parse', 'HEAD'], repo2).trim();
  write(repo2, '.claude/lane.json', JSON.stringify({ feature: 'refund-endpoint', spec: 'docs/specs/refund-endpoint.md', stage: 'build', started: isoSeconds(new Date(Date.now() - 2 * 3.6e6)), created: isoSeconds(new Date(Date.now() - 2 * 3.6e6)), base_commit: baseCommit, start_commit: baseCommit }));
  write(repo2, '.claude/kit.json', JSON.stringify({ commands: { test: 'true' } }));
  write(repo2, 'docs/specs/refund-endpoint.progress.md', PROGRESS);
  let r = call(repo2, 'echo hi >> README.md');
  assert.ok(r.reason.includes('this shell command changed') && r.reason.includes('README.md'), r.out);
  r = call(repo2, "git -c user.name=t -c user.email=t@t commit -qam wip");
  assert.ok(r.reason.includes('README.md'), `the commit cleared the flag: ${r.out}`);
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(S.flaggedPath(repo2), 'utf8')).paths).includes('README.md'));
  assert.match(JSON.parse(stopCheck(repo2).stdout).reason, /done-check: .*README\.md/);
  const undo = `git restore --source=${baseCommit.slice(0, 12)} --staged --worktree -- README.md, then commit`;
  assert.ok(r.reason.includes(undo), r.reason);
  // undone and committed: equal to the base again, cleared
  r = call(repo2, `${undo.replace(', then commit', '')} && git -c user.name=t -c user.email=t@t commit -qm undo`);
  assert.equal(r.out, '');
  assert.doesNotMatch(stopCheck(repo2).stdout, /README/);
  // a commit that brings an out-of-scope file in without any Bash write being seen is found at the next check
  write(repo2, 'docs/extra.md', 'x\n');
  git(['add', 'docs/extra.md'], repo2);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'sneak'], repo2);
  r = call(repo2, 'ls');
  assert.ok(r.reason.includes('the lane has changed files outside the spec\'s allow-list since its base commit: docs/extra.md'), r.out);
  assert.ok(r.reason.includes('git rm -f -- docs/extra.md, then commit'), r.reason);
  assert.match(JSON.parse(stopCheck(repo2).stdout).reason, /docs\/extra\.md/);
});

test('flagged.json is a cache: deleted or corrupted, done is still refused while an out-of-scope change exists', (t) => {
  const repo = laneRepo(t);
  write(repo, 'docs/specs/refund-endpoint.progress.md', PROGRESS);
  call(repo, `node -e "require('fs').writeFileSync('out.txt', 'x')"`);
  fs.rmSync(S.flaggedPath(repo));
  assert.match(JSON.parse(stopCheck(repo).stdout).reason, /out\.txt/, 'deleted');
  assert.ok(JSON.parse(fs.readFileSync(S.flaggedPath(repo), 'utf8')).paths['out.txt'], 'rebuilt from git');
  fs.writeFileSync(S.flaggedPath(repo), '{"v": 2, "paths": [');
  assert.match(JSON.parse(stopCheck(repo).stdout).reason, /out\.txt/, 'corrupt');
  fs.writeFileSync(S.flaggedPath(repo), JSON.stringify({ v: 2, head: git(['rev-parse', 'HEAD'], repo).trim(), paths: {} }));
  assert.match(JSON.parse(stopCheck(repo).stdout).reason, /out\.txt/, 'emptied by hand');
  assert.ok(call(repo, 'ls').reason.includes('out.txt'), 'and the next Bash call says so too');
  fs.rmSync(path.join(repo, 'out.txt'));
  assert.doesNotMatch(stopCheck(repo).stdout, /out\.txt/);
});

test('a claim left by a run that died is removed once the duplicate has waited, and does not read as an overlap', (t) => {
  const repo = laneRepo(t);
  const base = { session_id: SID, cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_dead', transcript_path: transcriptFor(repo) };
  runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ ...base, hook_event_name: 'PreToolUse' }) });
  // the first run claimed the record and was killed
  const claim = path.join(path.dirname(S.lastPath(repo)), 'claim.toolu_dead.json');
  fs.renameSync(S.beforePath(repo, 'toolu_dead'), claim);
  const old = new Date(Date.now() - S.DUPLICATE_WAIT_MS - 5000);
  fs.utimesSync(claim, old, old);
  const t0 = Date.now();
  const p = runScript('hook_post_edit_check.js', [], { stdin: JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: 'ok' }) });
  assert.equal(p.stdout.trim(), '');
  assert.ok(Date.now() - t0 < S.DUPLICATE_WAIT_MS, 'an expired claim is not waited for');
  assert.ok(!fs.existsSync(claim), 'the stale claim is gone');
  const r = call(repo, `node -e "require('fs').writeFileSync('out.txt', 'x')"`);
  assert.ok(r.reason.includes('this shell command changed files outside the spec\'s allow-list: out.txt'), r.reason);
  // a stale claim of another call that the transcript shows as finished is removed too, and is no overlap
  const repo2 = laneRepo(t);
  const tp = transcriptFor(repo2);
  fs.appendFileSync(tp, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_gone', content: 'ok' }] } }) + '\n');
  fs.mkdirSync(path.dirname(S.lastPath(repo2)), { recursive: true });
  const claim2 = path.join(path.dirname(S.lastPath(repo2)), 'claim.toolu_gone.json');
  fs.writeFileSync(claim2, '{}');
  fs.utimesSync(claim2, old, old);
  const r2 = call(repo2, `node -e "require('fs').writeFileSync('out.txt', 'x')"`);
  assert.ok(r2.reason.includes('this shell command changed files outside the spec\'s allow-list: out.txt'), r2.reason);
  assert.ok(!fs.existsSync(claim2));
});

test('a duplicate run that finishes after the first reports this call\'s file as this call\'s', (t) => {
  const repo = laneRepo(t);
  const base = { session_id: SID, cwd: repo, tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'toolu_seq', transcript_path: transcriptFor(repo) };
  runScript('hook_guard_bash.js', [], { stdin: JSON.stringify({ ...base, hook_event_name: 'PreToolUse' }) });
  write(repo, 'out.txt', 'x');
  const post = () => JSON.parse(runScript('hook_post_edit_check.js', [], { stdin: JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: 'ok' }) }).stdout).reason;
  const first = post();
  const second = post();
  assert.equal(second, first);
  assert.ok(second.includes('this shell command changed files outside the spec\'s allow-list: out.txt') && !second.includes('earlier'), second);
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
