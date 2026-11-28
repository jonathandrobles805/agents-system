// Step 2 (2a): every event line records which agent did it. Payload shapes are the ones Claude Code 2.1.332 sent
// on test M2: SubagentStart, the subagent's own tool calls and SubagentStop carry agent_id and agent_type; the
// main session's tool calls carry neither.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, runScript, tmpPath } from './helpers.js';

const SID = 'sess-1';
const AID = 'adc2dbe04ab24ea83';
const ATYPE = 'general-purpose';

const run = (d) => runScript('hook_event_log.js', [], { stdin: JSON.stringify(d) });
const sessionEvents = (repo) =>
  fs.readFileSync(path.join(repo, '.claude', 'session', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const sub = { agent_id: AID, agent_type: ATYPE };

test('event lines carry agent_id and agent_type when the payload has them, and omit them when it does not', (t) => {
  const repo = makeRepo(t);
  run({ hook_event_name: 'SubagentStart', session_id: SID, cwd: repo, ...sub });
  run({ hook_event_name: 'PostToolUse', session_id: SID, cwd: repo, tool_name: 'Read', tool_input: { file_path: 'src/payment.ts' }, tool_response: 'ok', ...sub });
  run({ hook_event_name: 'SubagentStop', session_id: SID, cwd: repo, ...sub });
  run({ hook_event_name: 'PostToolUse', session_id: SID, cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok' });
  const [start, read, stop, main] = sessionEvents(repo);

  assert.equal(start.event, 'subagent_start');
  assert.equal(start.agent_id, AID);
  assert.equal(start.agent_type, ATYPE);
  assert.equal(start.agent, ATYPE, 'the existing agent field is kept');

  assert.equal(read.event, 'read');
  assert.equal(read.agent_id, AID);
  assert.equal(read.agent_type, ATYPE);

  assert.equal(stop.event, 'subagent_stop');
  assert.equal(stop.agent_id, AID);
  assert.equal(stop.agent_type, ATYPE);
  assert.equal(stop.agent, ATYPE, 'the existing agent field is kept');

  assert.equal(main.event, 'bash');
  assert.ok(!('agent_id' in main), JSON.stringify(main));
  assert.ok(!('agent_type' in main), JSON.stringify(main));
  assert.ok(!('agent' in main), JSON.stringify(main));
});

test('an event with two lanes open (lane_ambiguous) still carries agent_id', (t) => {
  const repo = makeRepo(t);
  const lanes = {};
  for (const slug of ['lane-a', 'lane-b']) {
    const wt = path.join(tmpPath(t), slug);
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude', 'lane.json'), JSON.stringify({ feature: slug, spec: `docs/specs/${slug}.md`, stage: 'build' }));
    lanes[slug] = { worktree: wt };
  }
  fs.writeFileSync(path.join(repo, '.claude', 'kit.json'), JSON.stringify({ lanes }));
  run({ hook_event_name: 'PostToolUse', session_id: SID, cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok', ...sub });
  const [e] = sessionEvents(repo);
  assert.deepEqual(e.lane_ambiguous, ['lane-a', 'lane-b']);
  assert.equal(e.lane, null);
  assert.equal(e.agent_id, AID);
  assert.equal(e.agent_type, ATYPE);
});
