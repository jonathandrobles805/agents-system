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

/** Stable id for 'the same failure': the failing test names when parseable, else the last meaningful lines. */
export function failureSignature(name, out) {
  const names = [...new Set([...out.matchAll(FAILED_TEST)].map((m) => clip(m[1].trim(), 120)))].sort();
  if (names.length) return name + ':' + names.slice(0, 8).join('|');
  const tail = K.splitlines(out).map((l) => l.trim()).filter(Boolean).slice(-5);
  return name + ':' + clip(tail.join('|'), 400);
}

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

/** After a Bash command: any modified or new file outside the spec allow-list (catches sed -i, redirects, cp, mv). */
function shellScopeViolations(lane) {
  const [, change, create] = K.specFileLists(lane.specPath);
  const allowed = [...change, ...create, ...lane.alwaysAllowed(), 'ROADMAP.md'];
  const bad = [];
  for (const line of K.splitlines(git(['status', '--porcelain', '--untracked-files=all'], lane.root))) {
    let rel = line.slice(3).trim();
    if (rel.includes(' -> ')) rel = rel.split(' -> ').slice(1).join(' -> ');
    if (rel.startsWith('.claude/')) continue;
    if (!K.globMatch(rel, allowed)) bad.push(rel);
  }
  return bad;
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
  const cmds = kit.commands ?? {};
  const seconds = Math.trunc(Number(kit.timeouts?.check ?? 180));
  const timeout = Number.isFinite(seconds) ? seconds : 180;
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  const fp = text(ti.file_path) || text(ti.notebook_path);
  const rel = fp ? K.relTo(root, path.isAbsolute(fp) ? fp : path.join(cwd, fp)) : null;
  if (d.tool_name === 'Bash' && !SHELL_WRITES.test(text(ti.command))) return 0; // read-only shell command; nothing to check

  const log = lane ? lane.logPath : path.join(root, '.claude', 'session', 'checks.log');
  const events = lane ? lane.eventsPath : path.join(root, '.claude', 'session', 'events.jsonl');
  const failures = [];
  const sid = text(d.session_id) || 's';
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
      if (name === 'test' || name === 'typecheck') redSigs.push([failureSignature(name, out), `${path.basename(log)}#${line}`]);
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

  // Shell edits outside the spec (sed -i, >, cp, mv) are invisible to the pre-edit hook; catch them here.
  if (lane && d.tool_name === 'Bash') {
    const extras = shellScopeViolations(lane);
    if (extras.length) {
      K.appendEvent(events, { event: 'blocked', tool: 'Bash', result: 'blocked', summary: 'shell edit outside spec: ' + extras.slice(0, 5).join(', ') });
      failures.push("[scope] files changed outside the spec's allow-list via shell: " + extras.join(', ') +
        '\nRevert them (git checkout -- <file>) or stop and record under Escalation that the spec needs amending.');
    }
  }

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
