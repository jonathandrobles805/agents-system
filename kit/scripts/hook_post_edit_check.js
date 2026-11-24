#!/usr/bin/env node
// PostToolUse on Edit|Write|MultiEdit|Bash inside a lane: run typecheck, lint, and tests; log everything;
// detect weakened tests; feed failures back as a block decision so the agent must respond.
//
// Commands come from .claude/kit.json:
//   {"commands": {"typecheck": "...", "lint": "... {file}", "test": "...", "test_affected": "... {file}"},
//    "timeouts": {"check": 180}, "always_check": false}
// Tokens: {file} = the edited file (repo-relative). A missing command is skipped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from './kitlib.js';
import * as S from './shell_changes.js';

// Python's \b is Unicode-aware, JS's is not, so word boundaries are spelled out.
const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$/;
export const REMOVED_ASSERT = new RegExp(`^-\\s*.*${B}(expect|assert|should|must)${E}`, 'iu');
export const ADDED_SKIP = new RegExp(`^\\+\\s*.*(\\.skip\\(|\\.only\\(|${B}xit\\(|${B}xdescribe\\(|${B}xtest\\(|@pytest\\.mark\\.skip|pytest\\.skip\\(|${B}t\\.Skip\\(|@unittest\\.skip|#\\[ignore\\])`, 'u');
export const PASS_COUNT = /(\d+)\s+passed/i;
export const FAIL_COUNT = /(\d+)\s+failed/i;
export const FAILED_TEST = /(?:FAILED|FAIL|✗|×|✖)\s+(\S.*?)(?:\s+-\s|\s+\(|$)/gm;
export const SHELL_WRITES = new RegExp(`(>|>>|${B}sed\\s+-i|${B}tee${E}|${B}mv${E}|${B}cp${E}|${B}rm${E}|npm\\s+(i|install|add|rm|remove)|pip\\s+install|git\\s+(apply|checkout|merge|rebase|stash))`, 'u');
const MAX_ATTEMPTS = 3;

const text = (v) => (typeof v === 'string' ? v : '');
/** First n code points. */
const clip = (s, n) => Array.from(s.slice(0, 2 * n)).slice(0, n).join('');
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');

/**
 * Everything in a run's output that changes between two runs of the same failing tests: how long it took, where
 * the temp files went, when it happened. Without this the signature of an unchanged failure is new every time.
 * Not a list of things to ignore -- these are the shapes of a measurement, and a measurement cannot identify a
 * failure. What identifies it is which tests failed, which is why that is tried first.
 */
export function normalizeRun(out) {
  return out
    .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z?\b/g, '<t>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|us|ns)\b/gi, '<d>')
    .replace(/\b(?:duration(?:_ms)?|elapsed|time|took)\b\s*[:=]?\s*[\d.]+/gi, '<d>')
    .replace(/(?:\/[\w.@+-]+){2,}/g, '<p>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<h>')
    .replace(/\b\d{4,}\b/g, '<n>');
}

/**
 * Stable id for 'the same failure': which tests failed, and only if nothing can be parsed, the normalized tail.
 *
 * The counter this feeds could not reach three. FAILED_TEST matches jest-style "FAIL name" lines and never TAP's
 * `not ok 1 - name`, so for a TAP runner the signature fell through to the raw last five lines -- which carry a
 * duration and a timestamped temp path -- and the same failure got a fresh signature on every run. All 13 attempt
 * events in the field run read "attempt 1/3", seven of them the same npm failure.
 *
 * The failing names now come from the same parser done-check uses (#30), so "which tests failed" is answered one
 * way in the kit rather than two.
 */
export function failureSignature(name, out, root = null) {
  const parsed = K.resultLines(K.splitlines(out), K.resultPatterns(root)).filter((r) => !r.ok).map((r) => clip(r.name, 120));
  const matched = [...out.matchAll(FAILED_TEST)].map((m) => clip(m[1].trim(), 120));
  const names = [...new Set([...parsed, ...matched])].sort();
  if (names.length) return name + ':' + names.slice(0, 8).join('|');
  const tail = K.splitlines(normalizeRun(out)).map((l) => l.trim()).filter(Boolean).slice(-5);
  return name + ':' + clip(tail.join('|'), 400);
}

/**
 * The three-strikes counter. ADVISORY: it is a file inside the worktree, so the lane can reset it, and the thing it
 * counts — an edit attempt against the same failure — is observed only inside the lane (KIT-SPEC 10.14).
 */
function attemptsPath(lane, sid) {
  const dir = path.join(lane.root, K.SESSION_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, (sid || 's').replace(/[^A-Za-z0-9_.-]/g, '_') + '.attempts.json');
}

function readAttempts(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function bumpAttempt(lane, sid, sig) {
  const file = attemptsPath(lane, sid);
  const data = readAttempts(file);
  data[sig] = (parseInt(data[sig], 10) || 0) + 1;
  fs.writeFileSync(file, K.jsonDumps(data));
  return data[sig];
}

function resetAttempts(lane, sid) {
  const file = attemptsPath(lane, sid);
  if (K.isFile(file)) fs.writeFileSync(file, '{}');
}

/** Fill the Escalation section of progress.md so done-check accepts the stop and the human sees why. */
function writeEscalation(lane, sig, n, refs) {
  const prog = lane.progressPath;
  let body = K.isFile(prog) ? readText(prog) : `# Progress: ${lane.slug}\n\n## Escalation\n`;
  const block = `## Escalation\n\n- Attempts: ${n} of ${MAX_ATTEMPTS}\n- Failure: ${clip(sig, 300)}\n` +
    `- Tried: ${refs.length} fix attempt(s); see ${refs.slice(-3).join(', ') || 'log'}\n- Needs: a human decision: the approach, the spec, or the test is wrong\n`;
  const at = body.indexOf('## Escalation');
  body = (at >= 0 ? body.slice(0, at) : body).trimEnd() + '\n\n' + block;
  fs.mkdirSync(path.dirname(prog), { recursive: true });
  fs.writeFileSync(prog, body);
}

/** stdout of a git command ('' when git fails), like subprocess.run(...).stdout. */
function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 28 }).stdout ?? '';
}

/**
 * After a Bash command: the files THIS call changed (shell_changes.js: a snapshot before the call against one after
 * it; only regular files and symlinks) that are outside the spec's allow-list. Catches sed -i, redirects, heredocs,
 * cp, mv and interpreter writes, new untracked files included. Each entry: { rel, xy, kind, prior }.
 */
export function shellScopeViolations(lane, changed, outside = S.outsideSpec(lane)) {
  const bad = [];
  for (const c of changed) {
    const rel = c.rel;
    if (rel.startsWith('.claude/')) continue;
    if (outside(rel)) bad.push(c);
  }
  return bad;
}

const shq = (s) => (/^[A-Za-z0-9_./@%+=:,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/**
 * How to undo one out-of-scope change, judged against the lane's base commit. An untracked file that was already
 * there before the command goes back to that content: no command can do that for it, and removing it would destroy
 * work that was not the command's. Any other untracked file is removed. A tracked path the base has goes back to the
 * base's content; one the base does not have is removed from the index and the tree. A change already committed also
 * needs a commit that undoes it. `git checkout -- <path>` was the old advice for every path: it cannot remove an
 * untracked file, and restores from the index, not the base.
 */
export function undoCommand(c) {
  const p = shq(c.rel);
  if (c.untracked) return c.prior ? `put back the content ${p} had before the command (it was already there; do not delete it)` : `rm -- ${p}`;
  const then = c.committed ? ', then commit' : '';
  if (c.inBase) return `git restore --source=${c.base ? c.base.slice(0, 12) : 'HEAD'} --staged --worktree -- ${p}${then}`;
  return `git rm -f -- ${p}${then}`;
}

/**
 * The [scope] finding: what this command changed, what appeared while other calls overlapped it (which cannot be put
 * on this command alone), what earlier commands changed and is still there, and what else the lane has changed
 * outside the spec in its own changes (a commit, or a change no call recorded). One remedy list for all of them.
 */
export function scopeMessage({ mine = [], overlap = [], earlier = [], found = [] }) {
  const all = [...mine, ...overlap, ...earlier, ...found];
  if (!all.length) return null;
  const names = (xs) => xs.map((c) => c.rel).join(', ');
  const lines = [];
  if (mine.length) lines.push("[scope] this shell command changed files outside the spec's allow-list: " + names(mine));
  if (overlap.length) {
    lines.push("[scope] files outside the spec's allow-list changed while other shell commands were running alongside this one, " +
      'so they cannot be attributed to this command alone: ' + names(overlap) +
      '\nThey are outside the allow-list whichever command wrote them; if one still running meant to write them, let it finish first.');
  }
  if (earlier.length) lines.push("[scope] files outside the spec's allow-list that an earlier shell command changed are still there: " + names(earlier));
  if (found.length) lines.push("[scope] the lane's own changes (its diff from the branch it targets) include files outside the spec's allow-list: " + names(found));
  return lines.join('\n') + '\nUndo each one:\n' + all.map((c) => '  ' + undoCommand(c)).join('\n') +
    '\nor, if the spec is what is wrong, leave them and stop: record under Escalation that the spec needs amending.';
}

/**
 * Sort the lane's outstanding out-of-scope paths for the message. A run that finished first for the same call left
 * `report` (what it put on this call); otherwise: flagged by this call (as judged), by another call during this one's
 * window (overlap), by a call before it (earlier), or found by comparing with the base (no call recorded it).
 */
export function groupFlags(list, id, from, report = null) {
  const g = { mine: [], overlap: [], earlier: [], found: [] };
  const mine = new Set(report?.mine ?? []);
  const over = new Set(report?.overlap ?? []);
  for (const f of list) {
    if (mine.has(f.rel)) g.mine.push(f);
    else if (over.has(f.rel)) g.overlap.push(f);
    else if (report) g[f.call ? 'earlier' : 'found'].push(f);
    else if (id && f.call === id) g[f.how === 'overlap' ? 'overlap' : 'mine'].push(f);
    else if (id && f.call && f.at >= from) g.overlap.push(f);
    else g[f.call ? 'earlier' : 'found'].push(f);
  }
  return g;
}

/** The block for a list of findings: in build red checks are failures to fix; elsewhere only scope and weakened tests block. */
function problems(lane, parts) {
  const head = lane && !attemptsCount(lane) ? 'post-edit-check found problems. Fix them before continuing.' : 'post-edit-check found problems. Fix them before continuing; do not mark anything done.';
  return K.feedbackBlock(head + '\n\n' + parts.join('\n\n'));
}

/** Run a shell command: [exit code, stdout + stderr]. 124 on timeout. */
export function run(cmd, cwd, timeout) {
  const p = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8', timeout: Math.max(timeout * 1000, 1), killSignal: 'SIGKILL', maxBuffer: 1 << 28 });
  if (p.error?.code === 'ETIMEDOUT') return [124, `timed out after ${timeout}s`];
  const out = (p.stdout ?? '') + (p.stderr ? '\n' + p.stderr : '');
  return [p.status ?? -(os.constants.signals[p.signal] ?? 1), out.replace(/\r\n?/g, '\n').trim()];
}

export function weakenedTests(cwd) {
  const names = git(['diff', '--name-only', 'HEAD'], cwd).split(/\s+/).filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd).split(/\s+/).filter(Boolean);
  const problems = [];
  for (const n of names.filter((f) => TEST_FILE.test(f))) {
    const lines = K.splitlines(git(['diff', '-U0', 'HEAD', '--', n], cwd));
    const removed = lines.filter((l) => REMOVED_ASSERT.test(l) && !l.startsWith('---'));
    const skips = lines.filter((l) => ADDED_SKIP.test(l) && !l.startsWith('+++'));
    if (removed.length) problems.push(`${n}: ${removed.length} assertion line(s) removed`);
    if (skips.length) problems.push(`${n}: test skip/only added`);
  }
  for (const n of untracked.filter((f) => TEST_FILE.test(f))) {
    let body;
    try {
      body = readText(path.join(cwd, n));
    } catch {
      continue;
    }
    // no multiline flag, as in the original: only the first line of a new file is inspected
    if (ADDED_SKIP.test('+' + body.replaceAll('\n', '\n+'))) problems.push(`${n}: new test file contains skip/only`);
  }
  return problems;
}

/** Red results count as fix attempts only in the build stage (lane.json stage). */
export function attemptsCount(lane) {
  return String(lane?.data?.stage ?? 'build') === 'build';
}

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const cwd = text(d.cwd) || '.';
  const ti0 = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  const fp0 = text(ti0.file_path) || text(ti0.notebook_path);
  const lane = K.laneFor(cwd, fp0 ? (path.isAbsolute(fp0) ? fp0 : path.join(cwd, fp0)) : null);
  const root = lane ? lane.root : K.projectRoot(cwd);
  const kit = K.loadKitJson(root) ?? {};
  if (!lane && !kit.always_check) return 0;
  const seconds = Math.trunc(Number(kit.timeouts?.check ?? 180));
  const timeout = Number.isFinite(seconds) ? seconds : 180;
  const rel = fp0 ? K.relTo(root, path.isAbsolute(fp0) ? fp0 : path.join(cwd, fp0)) : null;
  const events = lane ? lane.eventsPath : path.join(root, '.claude', 'session', 'events.jsonl');

  // What this Bash call changed is measured before any check runs, so a file the checks themselves write (coverage,
  // build info) is never blamed on the command, and on every Bash call, not only those SHELL_WRITES recognises: an
  // interpreter or a formatter writes without a redirect. Out-of-scope changes are flagged and reported on every later
  // run until they are undone. After the run, the lane's state is recorded as the baseline for a later call that has
  // no before-snapshot, rewritten only when it changed (shell_changes.js).
  let scope = null;
  let after = null;
  let checksMayWrite = true;
  if (lane && d.tool_name === 'Bash') {
    checksMayWrite = SHELL_WRITES.test(text(ti0.command));
    try {
      const r = S.assess(lane, d);
      after = r.after;
      if (r.via !== 'duplicate' && r.changed.length) {
        const bad = shellScopeViolations(lane, r.changed);
        S.flag(lane, d, bad, r.overlap ? 'overlap' : 'this');
        if (bad.length) {
          K.appendEvent(events, { event: 'blocked', tool: 'Bash', result: 'blocked', summary: (r.overlap ? 'shell edit outside spec (overlapping calls): ' : 'shell edit outside spec: ') + bad.slice(0, 5).map((c) => c.rel).join(', ') });
        }
      }
      const still = S.reconcile(lane, { d, snap: after });
      scope = groupFlags(still, text(d.tool_use_id), r.from, r.report ?? null);
      S.release(lane, d, r, { mine: scope.mine.map((c) => c.rel), overlap: scope.overlap.map((c) => c.rel) });
    } catch (e) {
      K.appendEvent(events, { event: 'scope_unchecked', tool: 'Bash', result: 'fail', summary: `shell scope check could not run: ${clip(String(e?.message ?? e), 200)}` });
    }
  }
  try {
    return checkCall({ d, lane, root, kit, timeout, rel, events, scope });
  } finally {
    if (lane) {
      try {
        // a run with no checks leaves the worktree as `after` found it; otherwise look again, past what the checks wrote
        const end = after && !checksMayWrite ? after : S.snapshot(lane.root, after ?? S.readLast(lane.root));
        if (end) S.writeLast(lane.root, end);
        if (end && after && end !== after) S.recordChecksWrote(lane.root, after, end);
      } catch {
        // the next call falls back to the session start; nothing to block on
      }
    }
  }
}

function checkCall({ d, lane, root, kit, timeout, rel, events, scope }) {
  const cmds = kit.commands ?? {};
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  if (d.tool_name === 'Bash' && !SHELL_WRITES.test(text(ti.command))) {
    // A command that does not look like a write runs no checks; what it changed was still measured in main().
    const msg = scope ? scopeMessage(scope) : null;
    return msg ? problems(lane, [msg]) : 0;
  }

  const log = lane ? lane.logPath : path.join(root, '.claude', 'session', 'checks.log');
  const failures = [];
  const sid = text(d.session_id) || 's';

  // Writing up the work is not working on the code. An edit to one of the lane's own artifacts -- its progress
  // file, its review report, its event log -- used to run the project's whole suite and, because the suite was red
  // at the time, record an `attempt` against the three-strikes counter: in the field run three full `npm test`
  // runs started that way, each counted as a failed attempt to fix something nobody had touched. The counter is
  // for edits to the code under test, so these return before any step runs. A Bash call is not covered: it has no
  // single path to judge, and shell writes are exactly what the scope check below exists to catch.
  if (lane && rel && d.tool_name !== 'Bash' && K.globMatch(rel, K.laneArtifacts(lane.work, lane.slug, lane.root))) {
    return 0;
  }
  const redSigs = []; // [signature, log ref] for failing test/typecheck steps this call
  let testGreen = false;

  const step = (name, cmd) => {
    if (typeof cmd !== 'string' || !cmd.trim()) return;
    if (/^none\b/i.test(cmd.trim())) return; // "none: <reason>" turns a check off on purpose; it is not a command (field test #39)
    if (cmd.includes('{file}')) {
      if (!rel) return;
      cmd = cmd.replaceAll('{file}', () => rel);
    }
    const [code, out] = run(cmd, root, timeout);
    const line = K.appendLog(log, `${name}: ${cmd} -> exit ${code}`, out);
    const passed = PASS_COUNT.exec(out);
    const failed = FAIL_COUNT.exec(out);
    const summary = passed || failed ? `${failed ? failed[1] : 0} failed, ${passed ? passed[1] : 0} passed` : `exit ${code}`;
    K.appendEvent(events, { event: name, tool: 'hook', command: cmd, result: code === 0 ? 'ok' : 'fail', summary, ref: `${path.basename(log)}#${line}`, path: rel });
    if (code !== 0) {
      failures.push(`[${name}] ${cmd} -> exit ${code} (log ${path.basename(log)}#${line})\n${K.splitlines(out).slice(-40).join('\n')}`);
      if (name === 'test' || name === 'typecheck') redSigs.push([failureSignature(name, out, root), `${path.basename(log)}#${line}`]);
    } else if (name === 'test') {
      testGreen = true;
    }
  };

  step('typecheck', cmds.typecheck);
  step('lint', cmds.lint);
  step('test', rel && cmds.test_affected ? cmds.test_affected : cmds.test);

  const weak = weakenedTests(root);
  if (weak.length) {
    K.appendEvent(events, { event: 'test_weakened', tool: 'hook', result: 'fail', summary: weak.join('; ') });
    failures.push('[tests weakened] ' + weak.join('; ') + '\nRemoving assertions or skipping tests is not a fix. Restore them, or record why in progress.md under Uncertainties and let the reviewer decide.');
  }

  // Shell edits outside the spec are invisible to the pre-edit hook; they were measured in main(). An Edit or Write
  // run reports the ones still there, so they are not forgotten while the agent works on through the editor.
  if (lane && !scope && d.tool_name !== 'Bash') {
    const still = S.reconcile(lane, { d });
    if (still.length) scope = groupFlags(still, null, 0);
  }
  const scopeMsg = scope ? scopeMessage(scope) : null;
  if (scopeMsg) failures.push(scopeMsg);

  // Attempt counter: the same failure red N times in a row is an escalation, not a fourth try. Only in build: while
  // reproducing, planning or writing tests, red is the expected result, not a failed fix (field test #36).
  if (lane && attemptsCount(lane)) {
    if (testGreen && !redSigs.length) resetAttempts(lane, sid);
    for (const [sig, ref] of redSigs) {
      const n = bumpAttempt(lane, sid, sig);
      K.appendEvent(events, { event: 'attempt', tool: 'hook', result: 'fail', summary: `attempt ${n}/${MAX_ATTEMPTS}: ${clip(sig, 120)}`, ref });
      if (n >= MAX_ATTEMPTS) {
        writeEscalation(lane, sig, n, [ref]);
        K.appendEvent(events, { event: 'escalation', tool: 'hook', result: 'fail', summary: `${n} attempts on the same failure; escalation written` });
        return K.feedbackBlock(`post-edit-check: this failure has now failed ${n} times in a row:\n${clip(sig, 300)}\n\n` +
          'The Escalation section of progress.md has been written for you. Do not try again. ' +
          'Make sure Current step describes where things stand, then end the turn; a human decides next.');
      }
    }
  }

  if (failures.length) {
    // Outside build, a red typecheck or test is the expected state (reproducing a defect, writing red tests): record it,
    // do not tell the agent to fix it. Scope violations and weakened tests still block in every stage (field test #40).
    if (lane && !attemptsCount(lane)) {
      const blocking = failures.filter((f) => f.startsWith('[scope]') || f.startsWith('[tests weakened]'));
      if (!blocking.length) return 0;
      return problems(lane, blocking);
    }
    return problems(lane, failures);
  }
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main();
