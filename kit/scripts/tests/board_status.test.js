// Hardening plan Step 10, "A Runs view": the facts the board shows per lane, as /api/status (kit_status.js) sends them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, commitAll, gatePass } from './fixtures.js';
import { runScript } from './helpers.js';
import { project } from './testdata.js';

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
