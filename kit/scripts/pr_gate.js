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

/** The jobs of a GitHub Actions workflow, by the name GitHub reports, with their required/advisory/optional lists. */
export function workflowChecks(text) {
  const jobs = [];
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break; // the next top-level key ends the jobs block
      let m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (m) {
        jobs.push({ id: m[1], name: m[1], optional: false, advisory: false });
        continue;
      }
      const job = jobs.at(-1);
      if (!job) continue;
      m = /^ {4}name:\s*(.+?)\s*$/.exec(line);
      if (m) job.name = m[1].replace(/^(['"])(.*)\1$/, '$2');
      if (/^ {4}if:/.test(line)) job.optional = true;
      if (/^ {4}continue-on-error:/.test(line)) job.advisory = true;
    }
  }
  return {
    jobs,
    required: jobs.filter((j) => !j.optional && !j.advisory).map((j) => j.name),
    advisory: jobs.filter((j) => j.advisory).map((j) => j.name),
    optional: jobs.filter((j) => j.optional && !j.advisory).map((j) => j.name),
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
