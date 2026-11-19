#!/usr/bin/env node
// The merge gate (issue #68). A pull request is merged only after every required CI check has reported on its
// head commit and passed. One `gh pr checks` call is not enough: right after a push GitHub has registered no checks
// yet and answers "no checks reported", which reads like green (kit-test PR #3 and #4 were merged on red CI).
//
// The required checks are the jobs of the project's own kit workflow, read from the file, so the gate, branch
// protection (bootstrap --protect) and the workflow can never name different checks. A job is
//   required   no `if:` and no `continue-on-error`: it must report on the head commit and pass;
//   optional   it has an `if:` (opt-in jobs: mutation, the Pages dashboard): it need not run, but if it ran it
//              must not fail;
//   advisory   `continue-on-error`: a failure is reported, never blocks. The mutation job is advisory only while
//              the mutation gate says warning-only (ci_mutation_gate.js); once blocking, its failure blocks.
// Any other check on the head commit (another workflow or app) must not fail either.
//
//   lane.js ci    <slug> [--pr N] [--wait]       report the state of the PR's checks
//   lane.js merge <slug> [--pr N] --by NAME      wait for the checks, then squash-merge pinned to the checked head
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as K from './kitlib.js';

export const WORKFLOW = path.join('.github', 'workflows', 'kit.yml');
const OK = new Set(['success', 'neutral', 'skipped']);

/**
 * One matrix value as the runner prints it into the check name. A quoted scalar is taken verbatim; an unquoted
 * number is a YAML number and the runner formats it as such, so `3.10` reports as `3.1` and `1.0` as `1` (the
 * setup-python gotcha); YAML booleans print as `true`/`false` and nulls as empty. Anything else is a plain string.
 */
function matrixValue(v) {
  const q = /^(['"])(.*)\1$/.exec(v);
  if (q) return q[2];
  if (/^(true|True|TRUE)$/.test(v)) return 'true';
  if (/^(false|False|FALSE)$/.test(v)) return 'false';
  if (/^(null|Null|NULL|~)$/.test(v)) return '';
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v) ? String(Number(v)) : v;
}

/**
 * The jobs of a GitHub Actions workflow, by the name GitHub reports, with their required/advisory/optional lists.
 * A job with a `strategy.matrix` reports one check per matrix value, with `${{ matrix.<axis> }}` in its name
 * replaced by the value (this repo: `script unit tests (node 20)`, `(node 22)`), so a matrix job expands to one
 * entry per value. Before this, the unexpanded name was required, which no run ever reports: `lane.js merge` on
 * this repo waited until its timeout and protection built from it would have blocked every PR (0016 E.11).
 * A matrix this parser cannot expand (an `include`/`exclude`, an expression, more than one axis in the name, or an
 * axis the name does not use) is a parse error, not a guess: the caller must refuse, since a wrong required list
 * blocks every PR or waits forever.
 */
export function workflowChecks(text) {
  const jobs = [];
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start >= 0) {
    let inMatrix = false;
    let inStrategy = false;
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break; // the next top-level key ends the jobs block
      let m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (m) {
        jobs.push({ id: m[1], name: m[1], optional: false, advisory: false, matrix: null });
        inMatrix = false;
        inStrategy = false;
        continue;
      }
      const job = jobs.at(-1);
      if (!job) continue;
      m = /^ {4}name:\s*(.+?)\s*$/.exec(line);
      if (m) job.name = m[1].replace(/^(['"])(.*)\1$/, '$2');
      if (/^ {4}if:/.test(line)) job.optional = true;
      if (/^ {4}continue-on-error:/.test(line)) job.advisory = true;
      // strategy.matrix: axes are the 8-space keys under the 6-space `matrix:` key, itself under the job's `strategy:`.
      if (/^ {4}strategy:\s*$/.test(line)) { inStrategy = true; continue; }
      // `strategy: { matrix: … }` or `strategy: # comment` hides the matrix from this parser: refuse, never require the bare name.
      if (/^ {4}strategy:\s*\S/.test(line)) { job.matrix = { axes: {}, unsupported: ['strategy (inline mapping or trailing comment)'] }; continue; }
      if (inStrategy && /^ {4}[^\s#]/.test(line)) inStrategy = false;
      if (inStrategy && /^ {6}matrix:\s*$/.test(line)) { inMatrix = true; job.matrix = { axes: {}, unsupported: [] }; continue; }
      if (inStrategy && /^ {6}matrix:\s*\S/.test(line)) { job.matrix = { axes: {}, unsupported: ['matrix (inline mapping)'] }; continue; }
      if (inStrategy && /^ {5,}matrix:/.test(line) && !/^ {6}matrix:/.test(line)) { job.matrix = { axes: {}, unsupported: ['matrix (non-standard indentation)'] }; continue; }
      if (inMatrix) {
        if (/^ {6}[^\s#]/.test(line) || /^ {4}[^\s#]/.test(line)) inMatrix = false;
        else {
          m = /^ {8}([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
          if (!m && /^ {8}[^\s#]/.test(line)) job.matrix.unsupported.push('an unparsed matrix line');
          if (m) {
            const [, axis, raw] = m;
            if (axis === 'include' || axis === 'exclude' || raw === '' || !/^\[.*\]$/.test(raw) || raw.includes('${{')) job.matrix.unsupported.push(axis);
            else {
              const pieces = raw.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean);
              // A quoted value holding a comma would be split in two: refuse rather than require two wrong names.
              if (!pieces.length) job.matrix.unsupported.push(`${axis} (empty list)`);
              else if (pieces.some((x) => (/^['"]/.test(x) || /['"]$/.test(x)) && !/^(['"]).+\1$/.test(x))) job.matrix.unsupported.push(`${axis} (a quoted value contains a comma)`);
              else if (pieces.some((x) => /^[\[{]/.test(x) || /^0[xob]/i.test(x) || /^[.+-]?\.(inf|nan)$/i.test(x))) job.matrix.unsupported.push(`${axis} (a value is a collection or a non-decimal number)`);
              else if (pieces.some((x) => /\\|''|""|: |:$/.test(x))) job.matrix.unsupported.push(`${axis} (a value with an escape or a key: value pair)`);
              else job.matrix.axes[axis] = pieces.map(matrixValue);
            }
          }
        }
      }
    }
  }
  const expanded = [];
  const errors = [];
  for (const job of jobs) {
    const refs = [...job.name.matchAll(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g)].map((x) => x[1]);
    if (!job.matrix) {
      if (refs.length) errors.push(`${job.id}: name uses ${refs.map((r) => `matrix.${r}`).join(', ')} but the job has no strategy.matrix`);
      expanded.push({ id: job.id, name: job.name, optional: job.optional, advisory: job.advisory });
      continue;
    }
    const axes = Object.keys(job.matrix.axes);
    if (job.matrix.unsupported.length) { errors.push(`${job.id}: matrix key(s) ${job.matrix.unsupported.join(', ')} cannot be expanded (only a plain list per axis is supported)`); continue; }
    if (!axes.length) { errors.push(`${job.id}: strategy.matrix has no axis`); continue; }
    if (axes.length > 1) { errors.push(`${job.id}: a matrix with more than one axis (${axes.join(', ')}) is not supported`); continue; }
    const [axis] = axes;
    if (refs.some((r) => r !== axis)) { errors.push(`${job.id}: name uses matrix.${refs.find((r) => r !== axis)}, which is not an axis of the matrix (${axis})`); continue; }
    if (!refs.length) { errors.push(`${job.id}: a matrix job whose name does not use matrix.${axis} reports one check per value under a name this parser cannot predict`); continue; }
    const names = job.matrix.axes[axis].map((value) => [value, job.name.replace(/\$\{\{\s*matrix\.[A-Za-z0-9_-]+\s*\}\}/g, () => value)]);
    if (names.some(([, n]) => n.includes('${{'))) { errors.push(`${job.id}: name still contains an expression after matrix expansion`); continue; }
    for (const [value, name] of names) expanded.push({ id: job.id, name, optional: job.optional, advisory: job.advisory, matrixValue: value });
  }
  return {
    jobs: expanded,
    errors,
    required: expanded.filter((j) => !j.optional && !j.advisory).map((j) => j.name),
    advisory: expanded.filter((j) => j.advisory).map((j) => j.name),
    optional: expanded.filter((j) => j.optional && !j.advisory).map((j) => j.name),
  };
}

/**
 * The checks of the project's kit workflow, or null when the project has none. `mutationBlocking` (from the
 * mutation gate's own rule) turns the mutation job from advisory into must-not-fail.
 */
export function projectChecks(root, { mutationBlocking = false } = {}) {
  const p = path.join(root, WORKFLOW);
  if (!K.isFile(p)) return null;
  const c = workflowChecks(fs.readFileSync(p, 'utf8'));
  if (mutationBlocking) {
    const mutation = new Set(c.jobs.filter((j) => j.id === 'mutation').map((j) => j.name));
    c.advisory = c.advisory.filter((n) => !mutation.has(n));
  }
  return c;
}

/**
 * Judge the check runs reported on one commit. The latest run per name counts (a re-run replaces a failure).
 * Returns { state: 'green' | 'pending' | 'red', missing, pending, failed, advisory }: red wins over pending, so a
 * failure is reported at once instead of after the slowest job.
 */
export function evaluate(runs, { required = [], advisory = [] } = {}) {
  const latest = new Map();
  for (const r of runs) {
    const prev = latest.get(r.name);
    if (!prev || Number(r.id) > Number(prev.id)) latest.set(r.name, r);
  }
  const adv = new Set(advisory);
  const res = { missing: [], pending: [], failed: [], advisory: [] };
  for (const name of required) if (!latest.has(name)) res.missing.push(name);
  for (const [name, r] of latest) {
    const done = r.status === 'completed';
    const isRequired = required.includes(name);
    if (adv.has(name)) {
      if (done && !OK.has(r.conclusion)) res.advisory.push(`${name}: ${r.conclusion}`);
      continue;
    }
    if (!done) res.pending.push(name);
    else if (!OK.has(r.conclusion) || (isRequired && r.conclusion === 'skipped')) res.failed.push(`${name}: ${r.conclusion}`);
  }
  res.state = res.failed.length ? 'red' : res.missing.length || res.pending.length ? 'pending' : 'green';
  return res;
}

/** Run gh in the project; JSON out, or a thrown Error naming the command and gh's own message. */
export function gh(root, args) {
  const r = spawnSync('gh', args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? 'gh is not installed' : `gh ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw Object.assign(new Error(`gh ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`), { stderr: r.stderr });
  return r.stdout;
}

export function prInfo(root, pr) {
  return JSON.parse(gh(root, ['pr', 'view', String(pr), '--json', 'number,url,state,isDraft,headRefOid,headRefName,baseRefName,title']));
}

export function checkRuns(root, sha) {
  const out = gh(root, ['api', '--paginate', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs[] | {id, name, status, conclusion}']);
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** 'on', 'off' (GitHub has no protection for the branch) or 'unknown' (the token may not read it). */
export function protection(root, branch) {
  try {
    gh(root, ['api', `repos/{owner}/{repo}/branches/${branch}/protection`, '--jq', '.url']);
    return 'on';
  } catch (e) {
    return /\b404\b|Branch not protected/i.test(String(e.stderr ?? e.message)) ? 'off' : 'unknown';
  }
}

const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);

/** One line per problem, for the human. */
export function describe(res) {
  const lines = [];
  if (res.failed.length) lines.push(`failed: ${res.failed.join(', ')}`);
  if (res.missing.length) lines.push(`not reported yet: ${res.missing.join(', ')}`);
  if (res.pending.length) lines.push(`still running: ${res.pending.join(', ')}`);
  if (res.advisory.length) lines.push(`advisory (does not block): ${res.advisory.join(', ')}`);
  return lines;
}

/**
 * Poll the PR head's checks until they are green or red, or the time runs out. The head is re-read on every poll:
 * a push while waiting starts the judgement again on the new commit.
 */
export function waitForChecks(root, pr, checks, { timeoutMin = 30, pollSeconds = Number(process.env.KIT_PR_GATE_POLL_SECONDS || 15), log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMin * 60000;
  let info;
  let res;
  for (;;) {
    info = prInfo(root, pr);
    res = evaluate(checkRuns(root, info.headRefOid), checks);
    if (res.state !== 'pending' || Date.now() >= deadline) break;
    log(`waiting on ${info.headRefOid.slice(0, 7)}: ${describe(res).join('; ')}`);
    sleep(pollSeconds);
  }
  return { info, res, timedOut: res.state === 'pending' };
}

/** The PR to act on: --pr, else the PR cell of the slug's ROADMAP row. */
export function resolvePr(prArg, roadmapPr) {
  const v = String(prArg ?? roadmapPr ?? '').trim();
  const m = /(?:\/pull\/|^#?)(\d+)\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}

/** lane.js ci: report (or with wait, wait for) the checks. Exit 0 green, 1 red or timed out, 3 pending. */
export function ciCommand(root, pr, { wait = false, timeoutMin = 30, mutationBlocking = false, out = process.stdout } = {}) {
  const checks = projectChecks(root, { mutationBlocking });
  if (!checks) return refuse(out, [`no ${WORKFLOW}: run /zi-bootstrap first`]);
  if (checks.errors.length) return refuse(out, [`${WORKFLOW}: cannot tell which checks GitHub reports`, ...checks.errors]);
  const r = wait
    ? waitForChecks(root, pr, checks, { timeoutMin, log: (l) => out.write(l + '\n') })
    : (() => { const info = prInfo(root, pr); return { info, res: evaluate(checkRuns(root, info.headRefOid), checks), timedOut: false }; })();
  const { info, res } = r;
  out.write(`PR #${info.number} head ${info.headRefOid.slice(0, 7)}: CI ${res.state}${r.timedOut ? ` after ${timeoutMin} min` : ''}\n`);
  for (const l of describe(res)) out.write(`  ${l}\n`);
  if (res.state === 'green') return 0;
  return res.state === 'red' || r.timedOut ? 1 : 3;
}

/**
 * lane.js merge: the only way the kit merges. Refuses a closed or draft PR, waits for the checks, refuses red or
 * timed-out CI, and squash-merges with --match-head-commit so a push after the checks were read cannot slip in.
 */
export function mergeCommand(root, pr, { by, timeoutMin = 30, mutationBlocking = false, out = process.stdout } = {}) {
  if (!by || !String(by).trim()) return refuse(out, ['--by <name> is required: the human who decided to merge']);
  const checks = projectChecks(root, { mutationBlocking });
  if (!checks) return refuse(out, [`no ${WORKFLOW}: run /zi-bootstrap first`]);
  if (checks.errors.length) return refuse(out, [`${WORKFLOW}: cannot tell which checks GitHub reports; not merging`, ...checks.errors]);
  const first = prInfo(root, pr);
  if (first.state !== 'OPEN') return refuse(out, [`PR #${first.number} is ${first.state.toLowerCase()}, not open`]);
  if (first.isDraft) return refuse(out, [`PR #${first.number} is a draft; mark it ready first`]);
  const { info, res, timedOut } = waitForChecks(root, pr, checks, { timeoutMin, log: (l) => out.write(l + '\n') });
  if (res.state !== 'green') {
    return refuse(out, [`PR #${info.number} not merged: CI ${timedOut ? `still pending after ${timeoutMin} min` : 'red'} on ${info.headRefOid.slice(0, 7)}`, ...describe(res)]);
  }
  const body = `Merged by lane.js merge for ${by} after every required check passed on ${info.headRefOid}.`;
  gh(root, ['pr', 'merge', String(info.number), '--squash', '--match-head-commit', info.headRefOid, '--body', body]);
  out.write(`PR #${info.number} merged (squash) at head ${info.headRefOid.slice(0, 7)}, all required checks green.\n`);
  for (const l of describe(res)) out.write(`  ${l}\n`);
  const prot = protection(root, info.baseRefName);
  if (prot !== 'on') {
    out.write(`warning: branch protection on ${info.baseRefName} is ${prot}. A merge from the GitHub page is not blocked on red CI; ` +
      'run /zi-bootstrap --protect (private repositories need a GitHub plan that offers branch protection).\n');
  }
  return 0;
}

function refuse(out, msgs) {
  for (const m of msgs) process.stderr.write(`lane: ${m}\n`);
  return 2;
}
