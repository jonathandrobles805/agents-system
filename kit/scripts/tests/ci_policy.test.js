// Decision 0018: CI cost is cut only where no check is lost. These tests hold the kit's own workflows to it, so a later
// edit that brings back a paid trigger, drops a supported Node version or cancels runs on main fails here.
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

test('0018: the real-agent evals start only by hand, never on push or a schedule', () => {
  const weekly = read('.github', 'workflows', 'kit-eval-weekly.yml');
  assert.doesNotMatch(onBlock(weekly).replace(/#.*$/gm, ''), /\bschedule:|\bpush:|\bpull_request:/, 'the full set has no automatic trigger');
  assert.match(onBlock(weekly), /workflow_dispatch:/);
  const kit = read('.github', 'workflows', 'kit.yml');
  assert.match(onBlock(kit), /workflow_dispatch:/);
  const main = job(kit, 'eval-smoke-main');
  assert.ok(main, 'eval-smoke-main exists');
  const cond = /^    if: (.*)$/m.exec(main)?.[1] ?? '';
  assert.match(cond, /github\.event_name == 'workflow_dispatch'/, cond);
  assert.match(cond, /refs\/heads\/main/, cond);
  assert.doesNotMatch(cond, /'push'|'schedule'|'pull_request'/, cond);
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
