// Step 7 (KIT-SPEC 10.12, 10.13): the workflow table is the only source of stages and agents; the goal carries
// work type, risk and size; next-step maps the derived position onto the profile; /zi-work routes provisionally and the
// debugger's evidence re-routes; the kill switch stops every transition and mutation until a named human lifts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../lane.js';
import * as K from '../kitlib.js';
import * as F from './fixtures.js';
import { runScript, tmpPath } from './helpers.js';
import { project } from './testdata.js';

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const GOAL = (slug) => `# Goal: ${slug}\n\n- Slug: ${slug}\n- Date: 2026-11-11\n- Agreed by: Jonathan and Claude on 2026-11-11\n- Status: agreed\n\n## What we want\n\nA refund route.\n\n## Done looks like\n\n- G1. routes exposes refund\n`;
const ensureGoal = (root, slug) => {
  const p = path.join(root, 'docs', 'goals', `${slug}.md`);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, GOAL(slug));
  }
};
const setGoal = (root, slug, field, value) => {
  ensureGoal(root, slug);
  L.setGoalField(root, slug, field, value);
};
const next = (root, slug) => {
  const r = runScript('lane.js', ['next-step', slug, '--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const hook = (name, payload) => runScript(name, [], { stdin: JSON.stringify(payload) });

test('the workflow table: eleven profiles, every stage names at most one agent, humans pause where the spec says', () => {
  const ps = L.loadProfiles();
  assert.deepEqual(Object.keys(ps).sort(), ['architecture', 'docs', 'feature', 'fix', 'incident', 'investigation', 'migration', 'refactor', 'security', 'skill-development', 'ui']);
  for (const [wt, p] of Object.entries(ps)) {
    assert.ok(p.stages[0] === 'start' && p.stages.at(-1) === 'done', `${wt} starts at start and ends at done`);
    for (const [stage, agent] of Object.entries(p.agents ?? {})) {
      assert.ok(p.stages.includes(stage), `${wt}: agent for unknown stage ${stage}`);
      assert.ok(['researcher', 'planner', 'spec-critic', 'tester', 'implementer', 'reviewer', 'retro', 'debugger', 'skill-smith'].includes(agent), `${wt}/${stage}: ${agent}`);
    }
    for (const h of p.human ?? []) assert.ok(p.stages.includes(h), `${wt}: human pause ${h} not a stage`);
  }
  assert.ok(ps.feature.human.includes('approve') && ps.feature.human.includes('wait-merge'));
  assert.equal(ps.fix.agents.reproduce, 'debugger');
  assert.equal(ps.security.force_risk, 'high');
  assert.equal(ps.migration.force_risk, 'high');
  assert.deepEqual(ps.fix.reroute, { 'boot-failure': 'incident', 'design-fault': 'refactor' });
});

test('allowedAgent: the one agent for a stage; unknown type and unlisted stage are refused', () => {
  assert.deepEqual(L.allowedAgent('feature', 'build'), { ok: true, agent: 'implementer', human: false });
  assert.deepEqual(L.allowedAgent('feature', 'approve'), { ok: true, agent: null, human: true });
  assert.equal(L.allowedAgent('fix', 'research').ok, false);
  assert.ok(L.allowedAgent('fix', 'research').why.includes("not in the fix profile"));
  assert.deepEqual(L.allowedAgent('fix', 'plan'), { ok: true, agent: 'planner', human: false });
  assert.equal(L.allowedAgent('deployment', 'build').ok, false);
  assert.ok(L.allowedAgent('deployment', 'build').why.includes("unknown work_type 'deployment'"));
  const r = runScript('lane.js', ['agent-for', 'ui', 'research']);
  assert.equal(r.returncode, 2);
  const ok = runScript('lane.js', ['agent-for', 'ui', 'verify-ui']);
  assert.equal(JSON.parse(ok.stdout).agent, 'reviewer');
});

test('goal fields: defaults keep today\'s behaviour; a goal without the fields is a normal M feature', (t) => {
  const { root } = project(t);
  ensureGoal(root, 'refund-route');
  const f = L.goalFields(root, 'refund-route');
  assert.deepEqual([f.work_type, f.risk, f.size, f.provisional], ['feature', 'normal', 'M', false]);
  const step = next(root, 'refund-route');
  assert.equal(step.work_type, 'feature');
  assert.equal(step.size, 'M');
  assert.ok(step.stage);
});

test('unknown work_type: next-step refuses, lane start refuses, validate-docs flags it (fault: unknown type)', (t) => {
  const { root } = project(t);
  setGoal(root, 'refund-route', 'Work type', 'deployment');
  const step = next(root, 'refund-route');
  assert.equal(step.stage, 'refused');
  assert.ok(step.reason.includes("unknown work_type 'deployment'"));
  const r = runScript('lane.js', ['start', 'refund-route', '--repo', root]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes("unknown work_type 'deployment'"));
  const v = runScript('validate_docs.js', [path.join(root, 'docs', 'goals', 'refund-route.md'), '--repo', root]);
  assert.equal(v.returncode, 2); // validate-docs exits 2 on violations
  assert.ok(v.stderr.includes('goal-work-type'));
});

test('fix lane end to end from the goal alone: lane → reproduce → plan → approve → scope → test (fault 45: the fix lane dead-ends at reproduce)', (t) => {
  const { root } = project(t);
  setGoal(root, 'refund-route', 'Work type', 'fix');
  const specRel = path.join('docs', 'specs', 'refund-route.md');
  const approvedSpec = read(root, specRel);
  fs.rmSync(path.join(root, specRel));
  F.commitAll(root, 'a fix goal has no spec yet');
  let step = next(root, 'refund-route');
  assert.equal(step.stage, 'lane', JSON.stringify(step));
  const r = runScript('lane.js', ['start', 'refund-route', '--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  const wt = JSON.parse(r.stdout).worktree;
  assert.equal(JSON.parse(read(wt, '.claude', 'lane.json')).stage, 'reproduce');
  const prog = path.join(wt, 'docs', 'specs', 'refund-route.progress.md');
  assert.ok(read(prog).includes('## Reproduction'));
  step = next(root, 'refund-route');
  assert.equal(step.stage, 'reproduce');
  assert.equal(step.agent, 'debugger');
  // the debugger's only write: the reproduction and the cause line, in the lane's progress file (allowed by the lane)
  assert.ok(new K.Lane(wt, { feature: 'refund-route' }).alwaysAllowed().includes('docs/specs/refund-route.progress.md'));
  fs.writeFileSync(prog, read(prog).replace('## Current step', '- `npx vitest run` fails on routes.test.ts [verified]\n\ncause: single defect in src/api/routes.ts\n\n## Current step'));
  step = next(root, 'refund-route');
  assert.equal(step.stage, 'plan', JSON.stringify(step));
  assert.equal(step.agent, 'planner');
  const draft = approvedSpec.replace(/^- Status: .*$/m, '- Status: waiting-approval').replace(/^.*Approved by:.*$/m, '');
  fs.writeFileSync(path.join(wt, specRel), draft);
  step = next(root, 'refund-route');
  assert.equal(step.stage, 'approve');
  assert.equal(step.needs_human, true);
  // scope refuses until the human approved
  assert.equal(runScript('lane.js', ['scope', 'refund-route', '--repo', root]).returncode, 2);
  fs.writeFileSync(path.join(wt, specRel), approvedSpec);
  step = next(root, 'refund-route');
  assert.equal(step.stage, 'scope', JSON.stringify(step));
  const sc = runScript('lane.js', ['scope', 'refund-route', '--repo', root]);
  assert.equal(sc.returncode, 0, sc.stderr);
  assert.ok(JSON.parse(sc.stdout).criteria_added > 0);
  assert.equal(runScript('lane.js', ['scope', 'refund-route', '--repo', root]).returncode, 0, 'idempotent');
  assert.equal(JSON.parse(sc.stdout).criteria_added, (read(prog).match(/\| — \| — \|$/gm) ?? []).length);
  step = next(root, 'refund-route');
  assert.equal(step.stage, 'test', JSON.stringify(step));
  assert.equal(step.agent, 'tester');
});

test('security and migration force risk high; a high-risk lane needs the container runtime', (t) => {
  const { root } = project(t);
  setGoal(root, 'refund-route', 'Work type', 'migration');
  assert.equal(L.goalFields(root, 'refund-route').risk, 'high');
  const r = runScript('lane.js', ['start', 'refund-route', '--repo', root], { env: { ...process.env, KIT_SANDBOX_RUNTIME: 'srt' } });
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('requires the container sandbox runtime'));
});

test('/zi-work: provisional fix; the debugger\'s cause line confirms or re-routes, recorded as an event (fault: /zi-work routes a symptom)', (t) => {
  const { root } = project(t);
  setGoal(root, 'refund-route', 'Work type', 'fix (provisional)');
  assert.equal(L.goalFields(root, 'refund-route').provisional, true);
  const out = JSON.parse(runScript('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  const prog = path.join(out.worktree, 'docs', 'specs', 'refund-route.progress.md');
  // a single defect: stays fix, provisional dropped
  fs.appendFileSync(prog, '\n## Reproduction\n\n- `npx vitest run` fails on routes.test.ts [verified]\n\ncause: single defect in src/api/routes.ts\n');
  let step = next(root, 'refund-route');
  assert.equal(step.work_type, 'fix');
  assert.equal(step.rerouted, undefined);
  assert.equal(L.goalFields(root, 'refund-route').provisional, false);
  assert.ok(read(root, 'docs', 'goals', 'refund-route.md').includes('- Work type: fix\n'));
  // a boot failure: rerouted to incident
  setGoal(root, 'refund-route', 'Work type', 'fix (provisional)');
  fs.writeFileSync(prog, read(prog).replace('cause: single defect in src/api/routes.ts', 'cause: boot failure'));
  step = next(root, 'refund-route');
  assert.deepEqual(step.rerouted, { from: 'fix', to: 'incident', cause: 'boot failure' });
  assert.equal(step.work_type, 'incident');
  assert.ok(read(root, 'docs', 'goals', 'refund-route.md').includes('- Work type: incident\n'));
  assert.ok(read(out.worktree, '.claude', 'session', 'events.jsonl').includes('"event": "reroute"'));
  // a design fault from a provisional fix: refactor
  setGoal(root, 'refund-route', 'Work type', 'fix (provisional)');
  fs.writeFileSync(prog, read(prog).replace('cause: boot failure', 'cause: design fault across 4 callers'));
  step = next(root, 'refund-route');
  assert.equal(step.work_type, 'refactor');
});

test('kill switch: stop blocks next-step, lane start and every mutation hook in a live lane; resume-all needs a name (fault: stop blocks live mutations)', (t) => {
  const { root } = project(t);
  const out = JSON.parse(runScript('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  const wt = out.worktree;
  const edit = () => hook('hook_guard_edit.js', { hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: wt, tool_input: { file_path: path.join(wt, 'docs', 'specs', 'refund-route.progress.md'), content: 'x' } });
  const bash = () => hook('hook_guard_bash.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: wt, tool_input: { command: 'echo hi' } });
  hook('hook_read_log.js', { hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: wt, tool_input: { file_path: path.join(wt, 'docs', 'specs', 'refund-route.progress.md') } });
  assert.equal(edit().returncode, 0);
  assert.equal(bash().returncode, 0);
  const s = runScript('lane.js', ['stop', '--repo', root, '--by', 'Jonathan', '--reason', 'drill']);
  assert.equal(s.returncode, 0, s.stderr);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'STOP')));
  assert.ok(fs.existsSync(path.join(wt, '.claude', 'session', 'STOP')));
  assert.equal(next(root, 'refund-route').stage, 'stopped');
  assert.equal(edit().returncode, 2);
  assert.ok(edit().stderr.includes('kill switch'));
  assert.equal(bash().returncode, 2);
  assert.equal(runScript('lane.js', ['start', 'other', '--repo', root]).returncode, 2);
  assert.ok(read(wt, '.claude', 'session', 'events.jsonl').includes('"event": "stop"'));
  // lifting needs a name
  assert.equal(runScript('lane.js', ['resume-all', '--repo', root]).returncode, 2);
  assert.equal(runScript('lane.js', ['resume-all', '--repo', root, '--by', 'Jonathan']).returncode, 0);
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'STOP')));
  assert.equal(edit().returncode, 0);
  assert.notEqual(next(root, 'refund-route').stage, 'stopped');
});

test('profiles and the goal template are consistent with the skills and agents that exist', () => {
  const kit = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  // each profile names the skill that starts it, and that skill exists (decision 0017)
  const skills = fs.readdirSync(path.join(kit, 'skills')).map((f) => '/' + f);
  for (const p of Object.values(L.loadProfiles())) assert.ok(skills.includes(p.command), `skill ${p.command} exists for ${p.work_type}`);
  assert.ok(skills.includes('/zi-work'));
  const agents = fs.readdirSync(path.join(kit, 'agents')).map((f) => f.replace(/\.md$/, ''));
  assert.ok(agents.includes('debugger'));
  const tmpl = read(kit, 'templates', 'goal.md');
  for (const f of ['- Work type:', '- Risk:', '- Size:', '- Domain:']) assert.ok(tmpl.includes(f), f);
});

test('field test #36–#38: a fix lane driven from the main checkout — reads and edits land in the lane, red is not an attempt before build, next-step agrees from either checkout', (t) => {
  const { root } = project(t);
  setGoal(root, 'refund-route', 'Work type', 'fix');
  fs.rmSync(path.join(root, 'docs', 'specs', 'refund-route.md'));
  F.commitAll(root, 'a fix goal has no spec yet');
  const r = runScript('lane.js', ['start', 'refund-route', '--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  const wt = JSON.parse(r.stdout).worktree;
  const prog = path.join(wt, 'docs', 'specs', 'refund-route.progress.md');
  const sid = 'debugger-session';
  // #37: the debugger runs as a subagent whose cwd is the main checkout; it reads then writes the lane's progress file
  const call = (name, payload) => runScript(name, [], { stdin: JSON.stringify({ session_id: sid, cwd: root, ...payload }) });
  assert.equal(call('hook_read_log.js', { tool_name: 'Read', tool_input: { file_path: prog } }).returncode, 0);
  const w = { tool_name: 'Write', tool_input: { file_path: prog, content: 'x' } };
  const ge = call('hook_guard_edit.js', w);
  assert.equal(ge.returncode, 0, ge.stderr);
  assert.equal(call('hook_guard_tests_only.js', w).returncode, 0);
  // and still cannot write application code in the lane
  assert.equal(call('hook_guard_edit.js', { tool_name: 'Write', tool_input: { file_path: path.join(wt, 'src', 'api', 'routes.ts'), content: 'x' } }).returncode, 2);
  // #36: a red check while reproducing is expected; four in a row do not escalate
  const kj = path.join(wt, '.claude', 'kit.json');
  const k = JSON.parse(read(kj));
  k.commands = { ...(k.commands ?? {}), typecheck: 'node -e "process.exit(1)"', test: 'node -e "process.exit(0)"', lint: 'none: no linter adopted' };
  delete k.commands.test_affected;
  fs.writeFileSync(kj, JSON.stringify(k, null, 2));
  // the checks run on edits to the code under test, not on the lane's write-up: since #38 an edit to the progress
  // file returns before any step, so the attempt counter is exercised where it actually counts
  const wTest = { tool_name: 'Write', tool_input: { file_path: path.join(wt, 'tests', 'payment.test.ts'), content: 'x' } };
  for (let i = 0; i < 4; i++) {
    const pe = call('hook_post_edit_check.js', wTest);
    // #40: red while reproducing is recorded, not fed back as "fix it"; #39: "none: <reason>" is never run as a command
    assert.equal(pe.returncode, 0, pe.stdout + pe.stderr);
    assert.ok(!pe.stdout.includes('"block"'), pe.stdout);
  }
  assert.ok(!read(path.join(wt, '.claude', 'session', 'refund-route.log')).includes('none: no linter'), 'none: is not run');
  assert.ok(!/Attempts: \d+ of 3/.test(read(prog)) || read(prog).includes('{{n}}'), 'no escalation written while reproducing');
  // in build, the same red result is counted and escalates on the third
  const lj = path.join(wt, '.claude', 'lane.json');
  fs.writeFileSync(lj, JSON.stringify({ ...JSON.parse(read(lj)), stage: 'build' }, null, 2));
  for (let i = 0; i < 3; i++) call('hook_post_edit_check.js', wTest);
  assert.ok(/Attempts: 3 of 3/.test(read(prog)), read(prog).slice(-400));
  // #38: next-step gives the same answer from the worktree as from the main checkout
  const fromWt = JSON.parse(runScript('lane.js', ['next-step', 'refund-route', '--repo', wt]).stdout);
  const fromRoot = JSON.parse(runScript('lane.js', ['next-step', 'refund-route', '--repo', root]).stdout);
  assert.equal(fromWt.stage, fromRoot.stage, JSON.stringify({ fromWt, fromRoot }));
  assert.notEqual(fromWt.stage, 'retro');
});

test('field test #47: a fix lane re-routed to refactor by the debugger plans, gets approved and scoped before any test or build', (t) => {
  const { root } = project(t);
  setGoal(root, 'refund-route', 'Work type', 'fix');
  const specRel = path.join('docs', 'specs', 'refund-route.md');
  const approvedSpec = read(root, specRel);
  fs.rmSync(path.join(root, specRel));
  F.commitAll(root, 'a fix goal has no spec yet');
  const r = runScript('lane.js', ['start', 'refund-route', '--repo', root]);
  assert.equal(r.returncode, 0, r.stderr);
  const wt = JSON.parse(r.stdout).worktree;
  const prog = path.join(wt, 'docs', 'specs', 'refund-route.progress.md');
  fs.writeFileSync(prog, read(prog).replace('## Current step', '- evidence [verified]\n\ncause: design fault across 8 callers\n\n## Current step'));
  let step = next(root, 'refund-route');
  assert.equal(step.work_type, 'refactor', JSON.stringify(step));
  assert.ok(step.rerouted);
  assert.equal(step.stage, 'plan', JSON.stringify(step));
  assert.equal(step.agent, 'planner');
  fs.writeFileSync(path.join(wt, specRel), approvedSpec.replace(/^- Status: .*$/m, '- Status: waiting-approval').replace(/^.*Approved by:.*$/m, ''));
  step = next(root, 'refund-route');
  assert.equal(step.stage, 'approve');
  fs.writeFileSync(path.join(wt, specRel), approvedSpec);
  step = next(root, 'refund-route');
  assert.equal(step.stage, 'scope', JSON.stringify(step));
  assert.equal(runScript('lane.js', ['scope', 'refund-route', '--repo', root]).returncode, 0);
  step = next(root, 'refund-route');
  assert.equal(step.stage, 'test', JSON.stringify(step));
  assert.equal(step.agent, 'tester');
});
