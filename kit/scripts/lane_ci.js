#!/usr/bin/env node
// CI state of a lane's PR for the dashboard (hardening plan Step 10, Runs view): 'pass' | 'fail' | 'pending' | 'unknown'.
//
// Read with the kit's own GitHub access, unchanged: pr_gate.js projectChecks (the required checks from the project's
// workflow), prInfo (the PR head), checkRuns and evaluate, the same answer lane.js ci gives. Those calls wait on gh, so
// they run in a child process (`lane_ci.js --probe <root> <pr>`) and never on the request path: ciState answers from a
// cache at once. With refresh on (the dashboard server), an entry older than TTL_MS starts one child, and onChange runs
// when its answer lands. Without refresh (kit_status.js on the command line) nothing is read and the state is
// 'unknown'. KIT_STATUS_NO_GH, a missing workflow, any gh error or a timeout: 'unknown'.
//   node lane_ci.js --probe <root> <pr>     prints {"state": ..., "head": ...}
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as G from './pr_gate.js';
import * as K from './kitlib.js';

export const TTL_MS = 30_000;
const STATE = { green: 'pass', red: 'fail', pending: 'pending' };
const SELF = fileURLToPath(import.meta.url);

/** `${root}\0${pr}` → { state, head, at, inflight } */
const cache = new Map();
let refresh = null;

/** The dashboard server: read stale entries in the background; onChange() when an answer changes. */
export function enableRefresh(onChange, { timeoutMs = 60_000 } = {}) {
  refresh = { onChange, timeoutMs };
}

/** Stop reading and forget what was read (tests). */
export function disableRefresh() {
  refresh = null;
  cache.clear();
}

/** The PR's CI state now, from the cache; never waits. `head` is the PR head the state is for (null when unknown). */
export function ciState(root, pr) {
  if (process.env.KIT_STATUS_NO_GH !== undefined) return { state: 'unknown' };
  const key = `${root}\0${pr}`;
  const c = cache.get(key);
  if (refresh && !c?.inflight && (!c || Date.now() - c.at >= TTL_MS)) start(key, root, pr, c);
  return { state: c?.state ?? 'unknown', head: c?.head ?? null };
}

function start(key, root, pr, prev) {
  const { onChange, timeoutMs } = refresh;
  cache.set(key, { state: prev?.state ?? 'unknown', head: prev?.head ?? null, at: prev?.at ?? 0, inflight: true });
  let out = '';
  let child;
  const land = (r) => {
    const state = r && typeof r.state === 'string' ? r.state : 'unknown';
    const head = r && typeof r.head === 'string' ? r.head : null;
    cache.set(key, { state, head, at: Date.now(), inflight: false });
    if (refresh && (state !== prev?.state || head !== prev?.head)) onChange();
  };
  try {
    child = spawn(process.execPath, [SELF, '--probe', root, String(pr)], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    land(null);
    return;
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', () => {});
  child.on('close', (code) => {
    clearTimeout(timer);
    let r = null;
    try {
      if (code === 0) r = JSON.parse(out);
    } catch {
      r = null;
    }
    land(r);
  });
}

/** One read, synchronous: what the child prints. Any error is 'unknown'. */
export function probe(root, pr) {
  try {
    const checks = G.projectChecks(root);
    if (!checks || checks.errors.length) return { state: 'unknown', head: null };
    const info = G.prInfo(root, pr);
    const res = G.evaluate(G.checkRuns(root, info.headRefOid), checks);
    return { state: STATE[res.state] ?? 'unknown', head: info.headRefOid };
  } catch {
    return { state: 'unknown', head: null };
  }
}

if (K.isMain(import.meta.url)) {
  const [flag, root, pr] = process.argv.slice(2);
  if (flag !== '--probe' || !root || !pr) {
    process.stderr.write('usage: lane_ci.js --probe <root> <pr>\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(JSON.stringify(probe(root, pr)) + '\n');
  }
}
