// Hardening plan Step 10, "A Runs view": the facts the board shows per lane, as /api/status (kit_status.js) sends them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, commitAll, gatePass } from './fixtures.js';
import { runScript, setEnv } from './helpers.js';
import { project, review } from './testdata.js';
import { CI_COMMANDS } from '../bootstrap.js';

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
