// Hardening plan Step 10, "A Runs view": the facts the board shows per lane, as /api/status (kit_status.js) sends them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, commitAll, gatePass } from './fixtures.js';
import { runScript, setEnv } from './helpers.js';
import { project, review } from './testdata.js';
import { CI_COMMANDS } from '../bootstrap.js';
import * as CI from '../lane_ci.js';
import * as KS from '../kit_status.js';

process.env.KIT_STATUS_NO_GH = '1'; // no test here reads GitHub unless it says so (3c)
const ENV = { ...process.env, KIT_STATUS_NO_GH: '1' };
const SLUG = 'refund-route';

function status(root) {
  const r = runScript('kit_status.js', ['--repo', root, '--json'], { env: ENV });
  assert.equal(r.returncode, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const laneOf = (root) => status(root).lanes.find((l) => l.slug === SLUG);
const storeFile = (root) => path.join(root, '.claude', 'session', 'lanes', `${SLUG}.json`);
const readStore = (root) => JSON.parse(fs.readFileSync(storeFile(root), 'utf8'));
const writeStore = (root, rec) => fs.writeFileSync(storeFile(root), JSON.stringify(rec, null, 2) + '\n');

/** A started lane: its worktree and HEAD. */
function started(t) {
  const { root } = project(t);
  const wt = JSON.parse(runScript('lane.js', ['start', SLUG, '--repo', root]).stdout).worktree;
  return { root, wt, head: git(['rev-parse', 'HEAD'], wt).trim() };
}

// 3a (G1): the gate's verdict for the lane's HEAD, from lane.js gateState, as a store record says it
test('3a: each lane carries its gate: none, pass, fail and stale, from the store record and the lane HEAD', (t) => {
  const { root, wt, head } = started(t);

  assert.deepEqual(laneOf(root).gate, { state: 'none', verdict: null, commit: null, at: null });

  gatePass(root, SLUG);
  const at = readStore(root).gate.at;
  assert.deepEqual(laneOf(root).gate, { state: 'pass', verdict: 'PASS', commit: head, at });

  const rec = readStore(root);
  writeStore(root, { ...rec, gate: { ...rec.gate, verdict: 'FAIL', failed: ['test'] } });
  assert.deepEqual(laneOf(root).gate, { state: 'fail', verdict: 'FAIL', commit: head, at });

  // a commit after the verdict: the verdict is for another commit
  fs.writeFileSync(path.join(wt, 'src', 'later.ts'), 'export const later = 1;\n');
  commitAll(wt, 'later');
  assert.deepEqual(laneOf(root).gate, { state: 'stale', verdict: 'FAIL', commit: head, at });
});

test('3a: a lane with no worktree has gate state none', (t) => {
  const { root } = project(t);
  assert.deepEqual(laneOf(root).gate, { state: 'none', verdict: null, commit: null, at: null });
});

// ---------------------------------------------------------------------------------------------------- 3b
// 3b (G2): lane.js gate keeps every verdict, with the round it ran in, beside the latest one (store field gate_history,
// additive); /api/status gives one entry per round with its gates, and the review verdict for the current round only.

/** A started lane whose checks are all `test ! -e FAIL`, so a committed FAIL file makes the gate fail. */
function gateLane(t) {
  setEnv(t, 'KIT_SANDBOX_RUNTIME', 'none');
  setEnv(t, 'KIT_STATUS_NO_GH', '1');
  const { root } = project(t);
  const kj = path.join(root, '.claude', 'kit.json');
  const kit = JSON.parse(fs.readFileSync(kj, 'utf8'));
  const commands = { ...kit.commands };
  delete commands.lint_all;
  for (const n of CI_COMMANDS) commands[n] = 'test ! -e FAIL';
  // the fixture spec is high-risk; with no runtime here the lane needs the owner's waiver (as gate.test.js does)
  const sandbox = { ...(kit.sandbox ?? {}), high_risk_waiver: { by: 'test', reason: 'the board tests run without a sandbox runtime' } };
  fs.writeFileSync(kj, JSON.stringify({ ...kit, sandbox, commands }, null, 2));
  commitAll(root, 'kit.json: the checks the gate runs');
  const st = runScript('lane.js', ['start', SLUG, '--repo', root]);
  assert.equal(st.returncode, 0, st.stderr);
  return { root, wt: JSON.parse(st.stdout).worktree };
}
const gate = (root) => runScript('lane.js', ['gate', SLUG, '--repo', root]);
const roundsOf = (root) => laneOf(root).rounds_detail.map((r) => ({ round: r.round, gates: r.gates.map((g) => g.verdict) }));

test('3b: two gate runs in one round are both kept, in that round; the gate field is the latest, unchanged', (t) => {
  const { root, wt } = gateLane(t);
  assert.equal(gate(root).returncode, 0);
  assert.equal(gate(root).returncode, 0);
  const rec = readStore(root);
  const head = git(['rev-parse', 'HEAD'], wt).trim();
  assert.equal(rec.gate_history.length, 2);
  for (const h of rec.gate_history) assert.deepEqual(Object.keys(h).sort(), ['at', 'commit', 'round', 'verdict']);
  assert.deepEqual(rec.gate_history.map((h) => [h.round, h.verdict, h.commit]), [[1, 'PASS', head], [1, 'PASS', head]]);
  assert.equal(rec.gate.verdict, 'PASS');
  assert.equal(rec.gate.at, rec.gate_history[1].at);
  assert.ok(Array.isArray(rec.gate.checks) && rec.gate.report, 'the gate record keeps all its fields');
  assert.deepEqual(roundsOf(root), [{ round: 1, gates: ['PASS', 'PASS'] }]);
});

test('3b: a FAIL round then a PASS round: each verdict in its own round; the review verdict on the current round only', (t) => {
  const { root, wt } = gateLane(t);
  fs.writeFileSync(path.join(wt, 'FAIL'), 'x\n');
  commitAll(wt, 'a failing change');
  assert.equal(gate(root).returncode, 1);
  assert.equal(readStore(root).failed_rounds, 1, 'a gate FAIL ends round 1 (D2), unchanged');
  fs.rmSync(path.join(wt, 'FAIL'));
  commitAll(wt, 'fixed');
  assert.equal(gate(root).returncode, 0);
  assert.deepEqual(readStore(root).gate_history.map((h) => [h.round, h.verdict]), [[1, 'FAIL'], [2, 'PASS']]);
  assert.deepEqual(roundsOf(root), [{ round: 1, gates: ['FAIL'] }, { round: 2, gates: ['PASS'] }]);
  const head = git(['rev-parse', 'HEAD'], wt).trim();
  fs.writeFileSync(path.join(wt, 'docs', 'specs', `${SLUG}.review.md`), review({ head: head.slice(0, 7), verdict: 'PASS' }));
  const rd = laneOf(root).rounds_detail;
  assert.equal(rd[0].review, null, 'an earlier round has no review verdict here');
  assert.deepEqual(rd[1].review, { verdict: laneOf(root).review.verdict, head_matches: laneOf(root).review.head_matches });
});

test('3b: an old store record without gate_history still reads: its rounds have no gates', (t) => {
  const { root } = started(t);
  gatePass(root, SLUG); // a record as a gate before this change wrote it: gate, no gate_history
  assert.equal(readStore(root).gate_history, undefined);
  assert.deepEqual(roundsOf(root), [{ round: 1, gates: [] }]);
  assert.equal(laneOf(root).gate.state, 'pass');
});

// ---------------------------------------------------------------------------------------------------- 3c
// 3c (G5): the CI state of a lane's PR, from the kit's own GitHub reading (pr_gate.js), never on the request path:
// ciState answers from a cache at once; with refresh on (the dashboard server) a stale entry starts one background
// read, cached per PR head for 30 s; KIT_STATUS_NO_GH and any error give 'unknown'.
const CHECKS = ['tests', 'format', 'integration', 'typecheck', 'lint', 'boundaries', 'kit-checks', 'secrets', 'audit', 'mutation-gate'];
const PR_URL = 'https://github.com/o/proj/pull/4';

/** A bootstrapped project (its workflow names the required checks) with a started lane whose ROADMAP row has a PR. */
function prLane(t) {
  const { root } = started(t);
  runScript('bootstrap.js', ['--repo', root]);
  const rm = path.join(root, 'ROADMAP.md');
  const text = fs.readFileSync(rm, 'utf8');
  const row = text.split('\n').find((l) => l.includes(`| ${SLUG} |`));
  fs.writeFileSync(rm, text.replace(row, row.replace(/\| [^|]* \|$/, `| ${PR_URL} |`)));
  return root;
}

/** A fake gh on PATH: `pr view` gives the head, check-runs gives `runs`; `fail` makes every call exit 1. Logs calls. */
function fakeGh(t, { runs = [], fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fake-gh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const j = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, j + '\\n');
if (${fail}) { process.stderr.write('gh: HTTP 502'); process.exit(1); }
if (j.startsWith('pr view')) { process.stdout.write(JSON.stringify({ number: 4, url: ${JSON.stringify(PR_URL)}, state: 'OPEN', isDraft: false, headRefOid: '${'a'.repeat(40)}', headRefName: 'wt/${SLUG}', baseRefName: 'main', title: 't' })); process.exit(0); }
if (j.includes('/check-runs')) { process.stdout.write(${JSON.stringify(runs.map((r) => JSON.stringify(r)).join('\n'))} + '\\n'); process.exit(0); }
process.exit(9);
`, { mode: 0o755 });
  setEnv(t, 'PATH', `${dir}${path.delimiter}${process.env.PATH}`);
  return { calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}
const runsAll = (conclusion, status = 'completed') => CHECKS.map((name, i) => ({ id: 100 + i, name, status, conclusion: status === 'completed' ? conclusion : null }));

/** Turn the server's refresh on and wait for the next answer to land. */
async function refreshed(root, t) {
  let done;
  const landed = new Promise((r) => { done = r; });
  CI.enableRefresh(done);
  t.after(() => CI.disableRefresh());
  const t0 = Date.now();
  const first = CI.ciState(root, PR_URL);
  assert.ok(Date.now() - t0 < 200, 'ciState answers at once, without waiting on GitHub');
  assert.equal(first.state, 'unknown', 'nothing cached yet');
  await landed;
  return CI.ciState(root, PR_URL).state;
}

test('3c: KIT_STATUS_NO_GH: a lane with a PR has ci unknown; a lane without one has no ci; gh is never called', (t) => {
  const g = fakeGh(t, { runs: runsAll('success') });
  const root = prLane(t);
  const s = status(root);
  assert.deepEqual(s.lanes.find((l) => l.slug === SLUG).ci, { state: 'unknown' });
  assert.equal(s.lanes.find((l) => l.slug === 'other').ci, null);
  assert.deepEqual(g.calls(), []);
});

test('3c: a stubbed GitHub reply: pass, fail, pending; the answer is cached per PR head for 30 s', async (t) => {
  delete process.env.KIT_STATUS_NO_GH;
  t.after(() => { process.env.KIT_STATUS_NO_GH = '1'; });
  const root = prLane(t);
  let g = fakeGh(t, { runs: runsAll('success') });
  assert.equal(await refreshed(root, t), 'pass');
  const n = g.calls().length;
  assert.equal(CI.ciState(root, PR_URL).state, 'pass');
  assert.equal(CI.ciState(root, PR_URL).head, 'a'.repeat(40));
  assert.equal(g.calls().length, n, 'a second read within 30 s does not call gh');
  // the lane as /api/status sends it, from the same cache
  assert.deepEqual(KS.projectStatus(root).lanes.find((l) => l.slug === SLUG).ci, { state: 'pass' });
  CI.disableRefresh();
  g = fakeGh(t, { runs: runsAll('failure') });
  assert.equal(await refreshed(root, t), 'fail');
  CI.disableRefresh();
  g = fakeGh(t, { runs: runsAll(null, 'in_progress') });
  assert.equal(await refreshed(root, t), 'pending');
});

test('3c: any error reading GitHub gives unknown', async (t) => {
  delete process.env.KIT_STATUS_NO_GH;
  t.after(() => { process.env.KIT_STATUS_NO_GH = '1'; });
  const root = prLane(t);
  fakeGh(t, { fail: true });
  assert.equal(await refreshed(root, t), 'unknown');
});
