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
 * cp, mv and interpreter writes, new untracked files included. Each entry: { rel, xy, kind }.
 */
export function shellScopeViolations(lane, changed) {
  const [, change, create] = K.specFileLists(lane.specPath);
  const allowed = [...change, ...create, ...lane.alwaysAllowed(), 'ROADMAP.md'];
  const bad = [];
  for (const c of changed) {
    const rel = c.rel;
    if (rel.startsWith('.claude/')) continue;
    if (!K.globMatch(rel, allowed)) bad.push(c);
  }
  return bad;
}

const shq = (s) => (/^[A-Za-z0-9_./@%+=:,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/**
 * How to undo each change: a path HEAD has is restored from HEAD (index and worktree), a path HEAD does not have is
 * removed. `git checkout -- <path>` was the old advice for every path, and it cannot undo a new untracked file.
 */
export function undoCommand(c) {
  const p = shq(c.rel);
  if (c.xy === '??') return `rm -- ${p}`;
  if ('ARC'.includes(c.xy[0])) return `git rm -f -- ${p}`;
  return `git restore --source=HEAD --staged --worktree -- ${p}`;
}

export function scopeMessage(bad) {
  return "[scope] this shell command changed files outside the spec's allow-list: " + bad.map((c) => c.rel).join(', ') +
    '\nUndo each one:\n' + bad.map((c) => '  ' + undoCommand(c)).join('\n') +
    '\nor, if the spec is what is wrong, leave them and stop: record under Escalation that the spec needs amending.';
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
  // interpreter or a formatter writes without a redirect. After the run, the lane's state is recorded again as the
  // baseline for a later call that has no before-snapshot (shell_changes.js).
  let scopeBad = [];
  let after = null;
  if (lane && d.tool_name === 'Bash') {
    try {
      const r = S.changedByCall(lane, d);
      after = r.after;
      scopeBad = shellScopeViolations(lane, r.changed);
    } catch (e) {
      K.appendEvent(events, { event: 'scope_unchecked', tool: 'Bash', result: 'fail', summary: `shell scope check could not run: ${clip(String(e?.message ?? e), 200)}` });
    }
    if (scopeBad.length) {
      K.appendEvent(events, { event: 'blocked', tool: 'Bash', result: 'blocked', summary: 'shell edit outside spec: ' + scopeBad.slice(0, 5).map((c) => c.rel).join(', ') });
    }
  }
  try {
    return checkCall({ d, lane, root, kit, timeout, rel, events, scopeBad });
  } finally {
    if (lane) {
      try {
        S.saveLast(lane, after);
      } catch {
        // the next call falls back to the session start; nothing to block on
      }
    }
  }
}

function checkCall({ d, lane, root, kit, timeout, rel, events, scopeBad }) {
  const cmds = kit.commands ?? {};
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  if (d.tool_name === 'Bash' && !SHELL_WRITES.test(text(ti.command))) {
    // A command that does not look like a write runs no checks; what it changed was still measured above.
    if (scopeBad.length) return K.feedbackBlock('post-edit-check found problems. Fix them before continuing.\n\n' + scopeMessage(scopeBad));
    return 0;
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

  // Shell edits outside the spec are invisible to the pre-edit hook; they were measured in main().
  if (scopeBad.length) failures.push(scopeMessage(scopeBad));

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
      return K.feedbackBlock('post-edit-check found problems. Fix them before continuing.\n\n' + blocking.join('\n\n'));
    }
    return K.feedbackBlock('post-edit-check found problems. Fix them before continuing; do not mark anything done.\n\n' + failures.join('\n\n'));
  }
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main();
