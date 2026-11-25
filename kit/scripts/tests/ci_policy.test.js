// Decision 0018: CI cost is cut only where no check is lost. These tests hold the kit's own workflows to it, so a later
// edit that brings back a paid trigger, starts the agent eval on merges that cannot change it, drops a supported Node version or cancels runs on main fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as G from '../pr_gate.js';

const REPO = process.cwd();
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
/** The `on:` block of a workflow, up to the next top-level key. */
const onBlock = (yml) => /^on:\n((?:[ \t#].*\n|\n)*)/m.exec(yml)?.[1] ?? '';
/** One job's block, from its key to the next job at the same indent. */
const job = (yml, id) => new RegExp(`^  ${id}:\\n((?:    .*\\n|\\n)*)`, 'm').exec(yml)?.[1] ?? '';
const minNode = () => Number(/>=\s*(\d+)/.exec(JSON.parse(read('package.json')).engines.node)[1]);

test('0018: the real-agent smoke set starts on main only when a push changes what it measures, or by hand', () => {
  const main = read('.github', 'workflows', 'kit-eval-main.yml');
  const on = onBlock(main).replace(/#.*$/gm, '');
  assert.match(on, /push:\n\s+branches: \[main\]\n\s+paths:/, 'push to main, path-filtered');
  for (const p of ['kit/agents/**', 'kit/skills/**', 'kit/templates/**', 'kit/workflows/**', 'kit/eval/**', '!kit/eval/results/**', '!kit/eval/fixtures/**']) assert.ok(on.includes(`'${p}'`), p);
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /\bschedule:|\bpull_request:/, 'no schedule; never on a pull request (its credentials are main-only)');
  const job = /^  eval-smoke-main:\n((?:    .*\n|\n)*)/m.exec(main)?.[1] ?? '';
  assert.match(job, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(job, /^    environment: main$/m);
  // the gated set is the same one kit.yml's PR notice names
  const kit = read('.github', 'workflows', 'kit.yml');
  assert.match(kit, /\^kit\/\(agents\|skills\|templates\|workflows\|eval\)\//);
  assert.doesNotMatch(kit, /^  eval-smoke-main:/m, 'one copy of the job');
  assert.doesNotMatch(onBlock(kit), /workflow_dispatch/, 'kit.yml runs on its own triggers only');
});

test('0018: the full set (n=3) starts only by hand', () => {
  const weekly = read('.github', 'workflows', 'kit-eval-weekly.yml');
  assert.doesNotMatch(onBlock(weekly).replace(/#.*$/gm, ''), /\bschedule:|\bpush:|\bpull_request:/);
  assert.match(onBlock(weekly), /workflow_dispatch:/);
});

test('0018: the unit tests run on every supported Node major, none below the minimum, and the minimum is stated alike', () => {
  const min = minNode();
  assert.ok(min >= 22, 'Node 20 is past its end of life');
  const kit = G.workflowChecks(read('.github', 'workflows', 'kit.yml'));
  const nodes = kit.required.map((n) => /^script unit tests \(node (\d+)\)$/.exec(n)?.[1]).filter(Boolean).map(Number);
  assert.ok(nodes.includes(min), `the matrix tests the minimum, Node ${min}`);
  assert.ok(nodes.every((v) => v >= min), `no value below the minimum: ${nodes}`);
  assert.match(read('README.md'), new RegExp(`Node ${min} or newer`));
  assert.match(read('install.sh'), new RegExp(`NODE_MAJOR < ${min}\\b`));
});

test('0018: a newer push cancels an older pull-request run; runs on main are never cancelled', () => {
  const kit = read('.github', 'workflows', 'kit.yml');
  const c = /^concurrency:\n((?:  .*\n)+)/m.exec(kit)?.[1] ?? '';
  assert.match(c, /group: .*github\.event\.pull_request\.number \|\| github\.ref/);
  assert.match(c, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});
