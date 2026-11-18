// Structural checks on the skill files (decision 0017), plus a mechanical end-to-end run of the pipeline scripts on the Node fixture:
// bootstrap -> research index -> spec -> approve -> lane start -> hooks during build -> done-check -> review report -> CI checks -> finish.
// Agents are not run here (they need Claude Code); every script they call is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { jsonDumps, splitlines } from '../kitlib.js';
import * as F from './fixtures.js';
import { SCRIPTS, runScript, tmpPath } from './helpers.js';
import { spec as makeSpec, review as makeReview } from './testdata.js';

const KIT = path.dirname(SCRIPTS);
const SKILLS = path.join(KIT, 'skills');
// every prompt file of the kit's skills: each SKILL.md, and the /kit stage and work-type files beside it
const COMMANDS = fs.readdirSync(SKILLS, { recursive: true }).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(SKILLS, f));
const EXPECTED = new Set(['kit/SKILL.md', 'kit-status/SKILL.md', 'kit-dashboard/SKILL.md', 'kit-setup/SKILL.md',
  ...['start', 'research', 'plan', 'implement', 'review', 'sync', 'retro'].map((s) => `kit/stages/${s}.md`),
  // step 7: one work type per kind of work plus the router for an unknown kind (KIT-SPEC 10.12)
  ...['unknown', 'feature', 'fix', 'ui', 'refactor', 'docs', 'investigation', 'security', 'architecture', 'migration', 'incident', 'skill-development'].map((s) => `kit/types/${s}.md`)]);
const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(SKILLS, p).split(path.sep).join('/');

test('all skills exist with frontmatter; each SKILL.md names its folder and lists its tools', () => {
  assert.deepEqual(new Set(COMMANDS.map(rel)), EXPECTED);
  for (const p of COMMANDS) {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(read(p));
    assert.ok(m, p);
    assert.match(m[1], /^description:\s*\S/m, p);
    if (path.basename(p) === 'SKILL.md') {
      assert.match(m[1], new RegExp(`^name: ${path.basename(path.dirname(p))}$`, 'm'), p);
      assert.match(m[1], /^allowed-tools:\s*\S/m, p);
    } else {
      // only SKILL.md's frontmatter is read by Claude Code; a tool list here would only mislead
      assert.doesNotMatch(m[1], /^allowed-tools:/m, p);
    }
  }
});

test('every description and argument-hint is one double-quoted YAML string', () => {
  // unquoted, a `: ` or a leading `[` makes the line invalid YAML; Claude Code then loads the skill with no metadata
  const DQ = /^"(?:[^"\\]|\\.)*"$/;
  for (const p of COMMANDS) {
    const head = /^---\n([\s\S]*?)\n---\n/.exec(read(p))[1];
    for (const m of head.matchAll(/^(description|argument-hint):[ \t]*(.*)$/gm)) assert.match(m[2], DQ, `${rel(p)} ${m[1]}`);
  }
});

test('no kit skill strips tools from the agents it spawns', () => {
  // probe Q1b, Q2: disallowed-tools also removes the tool from subagents and stays in force after the skill
  for (const p of COMMANDS) assert.doesNotMatch(/^---\n([\s\S]*?)\n---\n/.exec(read(p))[1], /^disallowed-tools:/m, rel(p));
});

test('no allowed-tools pattern relies on a $variable or quotes, which Claude Code does not match', () => {
  // probe Q6d: a pattern containing "$PWD" did not approve the same literal command, so such a pattern only looks safe
  for (const p of COMMANDS) {
    const tools = /^allowed-tools:(.*)$/m.exec(read(p))?.[1] ?? '';
    assert.doesNotMatch(tools, /\$|"/, rel(p));
  }
});

test('every description says when to use it first', () => {
  // Claude and the / menu show the description; the use case comes first (Anthropic's guidance for skills)
  for (const p of COMMANDS) {
    const d = /^description: "(.*)"$/m.exec(read(p))?.[1] ?? '';
    assert.match(d, /^Use when /, rel(p));
  }
});

test('every work type writes the same four goal fields the goal template has', () => {
  // field test: /work's goal block lacked Domain:, which the other ten had (decision 0016 E.5)
  for (const p of COMMANDS.filter((x) => rel(x).startsWith('kit/types/'))) {
    for (const f of ['- Work type:', '- Risk:', '- Size:', '- Domain:']) assert.ok(read(p).includes(f), `${rel(p)} ${f}`);
  }
});

test('the installed prompts cite nothing that is not installed with them', () => {
  // KIT-SPEC, OPERATING-MODEL and the decisions live in the kit repo's docs/, which install.sh does not place
  for (const p of COMMANDS) assert.doesNotMatch(read(p), /KIT-SPEC|OPERATING-MODEL|[Ss]ince step \d/, rel(p));
});

test('/kit names every stage and work type it can be given, and each has its file', () => {
  const text = read(path.join(SKILLS, 'kit', 'SKILL.md'));
  for (const f of EXPECTED) {
    const m = /^kit\/(stages|types)\/(.+)\.md$/.exec(f);
    if (m && m[2] !== 'unknown') assert.ok(text.includes(`\`${m[2]}\``), `SKILL.md names ${m[1]} ${m[2]}`);
  }
  assert.ok(text.includes('types/unknown.md'));
});

test('commands reference real scripts and subcommands', () => {
  const laneSubs = new Set(['precheck', 'start', 'stage', 'wip', 'unknowns', 'merged', 'incident', 'next-step', 'next', 'goal-set', 'roadmap-set', 'index', 'finish', 'launch', 'resume', 'stop', 'resume-all', 'profiles', 'agent-for', 'scope']);
  for (const p of COMMANDS) {
    const text = read(p);
    for (const m of text.matchAll(/kit\/scripts\/([a-z_]+\.js)/g)) {
      assert.ok(fs.statSync(path.join(SCRIPTS, m[1]), { throwIfNoEntry: false })?.isFile(), `${path.basename(p)}: ${m[1]}`);
    }
    for (const m of text.matchAll(/lane\.js"? (\w[\w-]*)/g)) {
      assert.ok(laneSubs.has(m[1]), `${path.basename(p)}: ${m[1]}`);
    }
  }
});

test('commands never merge or approve for the human', () => {
  for (const p of COMMANDS) {
    assert.ok(!read(p).toLowerCase().includes('gh pr merge'), path.basename(p));
  }
  assert.ok(read(path.join(SKILLS, 'kit', 'stages', 'plan.md')).toLowerCase().includes('nothing is built before that'));
  assert.ok(read(path.join(SKILLS, 'kit', 'stages', 'review.md')).toLowerCase().includes('this command never merges'));
});

const hook = (name, payload) => runScript(name, [], { stdin: jsonDumps(payload) });
const lines = (p) => splitlines(read(p));

test('pipeline mechanics end to end', (t) => {
  // --- bootstrap + roadmap
  const root = F.nodeApi(path.join(tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  const rm = path.join(root, 'ROADMAP.md');
  fs.writeFileSync(rm, read(rm).replaceAll('| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |', '| Refund route | refund-route | M1 | queued | — | — | — |'));
  // the fixture has no node_modules; give the lane a fake test command that reads a marker file so we can flip red/green
  const kj = path.join(root, '.claude', 'kit.json');
  const kit = JSON.parse(read(kj));
  // TAP, because that is what a real runner prints and what done-check reads since #30: an exit code alone says
  // only that a process ended, so the fake runner has to report per-test results like the real one does
  kit.commands = { test: `sh -c 'if [ -f ${root}/.green ]; then echo "TAP version 13"; echo "ok 1 - exposes refund"; echo "1..1"; else echo "TAP version 13"; echo "not ok 1 - exposes refund"; echo "1..1"; exit 1; fi'` };
  fs.writeFileSync(kj, jsonDumps(kit));
  const commit = F.commitAll(root, 'bootstrap');
  const short = commit.slice(0, 7);

  // --- research registered in the index
  let r = runScript('lane.js', ['index', 'add', 'How does routes() expose the service?', '--repo', root, '--slug', 'routes-shape', '--keywords', 'routes service export', '--files', 'src/api/routes.ts', '--commit', short]);
  assert.equal(r.returncode, 0);
  assert.equal(JSON.parse(runScript('lane.js', ['index', 'lookup', 'how does routes expose the service', '--repo', root, '--json']).stdout).decision, 'reuse');

  // --- spec waiting approval: implement must refuse
  const specPath = path.join(root, 'docs', 'specs', 'refund-route.md');
  fs.writeFileSync(specPath, makeSpec({ commit: short }).replaceAll('- Status: approved', '- Status: waiting-approval').replaceAll(`Approved by: Jonathan Robles on 2026-11-08 at ${short}`, 'Approved by: — on — at —'));
  assert.equal(runScript('validate_docs.js', [specPath, '--repo', root]).returncode, 0);
  runScript('lane.js', ['roadmap-set', 'refund-route', 'waiting-approval', '--repo', root]);
  F.commitAll(root, 'spec');
  assert.equal(runScript('lane.js', ['start', 'refund-route', '--repo', root]).returncode, 2);

  // --- human approves
  fs.writeFileSync(specPath, makeSpec({ commit: short }));
  F.commitAll(root, 'approve');
  const out = JSON.parse(runScript('lane.js', ['start', 'refund-route', '--repo', root]).stdout);
  const wt = out.worktree;
  const base = { session_id: 'lane-session', cwd: wt };

  // --- implementer behaviour under hooks
  // edit before reading: blocked
  r = hook('hook_guard_edit.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/api/routes.ts' } });
  assert.equal(r.returncode, 2);
  // read spec files, then a file outside the spec: blocked
  for (const f of ['docs/specs/refund-route.md', 'src/domain/payment.ts', 'src/api/routes.ts']) {
    hook('hook_read_log.js', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: f } });
  }
  r = hook('hook_guard_edit.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/domain/payment.ts' } });
  assert.ok(r.returncode === 2 && r.stderr.includes('not in the spec'));
  // secret read: blocked
  assert.equal(hook('hook_guard_read.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '.env' } }).returncode, 2);
  // allowed edit: write the test (Files to create) and the route (Files to change, read above)
  assert.equal(hook('hook_guard_edit.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'tests/routes.test.ts' } }).returncode, 0);
  fs.writeFileSync(path.join(wt, 'tests', 'routes.test.ts'), "import { it, expect } from 'vitest';\nit('exposes refund', () => { expect(1).toBe(1); });\n");
  // post-edit check: red (marker absent) -> block decision + log + event
  r = hook('hook_post_edit_check.js', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'tests/routes.test.ts' } });
  assert.equal(JSON.parse(r.stdout).decision, 'block');
  const log = path.join(wt, '.claude/session/refund-route.log');
  const events = path.join(wt, 'docs/specs/refund-route.events.jsonl');
  assert.ok(read(log).includes('not ok 1 - exposes refund'));
  const redLine = lines(log).findIndex((l) => l.startsWith('=== ')) + 1;
  // stop now: refused (no green run)
  const prog = path.join(wt, 'docs/specs/refund-route.progress.md');
  fs.writeFileSync(prog, read(prog).replaceAll('| D1 | routes exposes refund | `tests/routes.test.ts::exposes refund` | — | — |', `| D1 | routes exposes refund | \`tests/routes.test.ts::exposes refund\` | refund-route.log#${redLine} | — |`));
  r = hook('hook_done_check.js', { ...base, hook_event_name: 'Stop', stop_hook_active: false });
  assert.ok(JSON.parse(r.stdout).decision === 'block' && JSON.parse(r.stdout).reason.includes('D1'));
  // implement, go green
  assert.equal(hook('hook_guard_edit.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/api/routes.ts' } }).returncode, 0);
  fs.writeFileSync(path.join(wt, 'src', 'api', 'routes.ts'), "import { PaymentService } from '../domain/payment';\nexport function routes(s: PaymentService) {\n  return { charge: (u: string) => s.charge(u), refund: (i: string) => s.refund(i) };\n}\n");
  fs.writeFileSync(path.join(root, '.green'), '1');
  r = hook('hook_post_edit_check.js', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/api/routes.ts' } });
  assert.equal(r.stdout.trim(), '');
  const headers = lines(log).map((l, i) => [i + 1, l]).filter(([, l]) => l.startsWith('=== ')).map(([i]) => i);
  const greenLine = headers[headers.length - 1];
  fs.writeFileSync(prog, read(prog).replaceAll(`| refund-route.log#${redLine} | — |`, `| refund-route.log#${redLine} | refund-route.log#${greenLine} |`));
  // commit inside the lane (guard-bash allows a normal commit)
  assert.equal(hook('hook_guard_bash.js', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "git add -A && git commit -m 'refund-route: D1'" } }).returncode, 0);
  F.commitAll(wt, 'refund-route: D1 routes exposes refund');
  // stop: accepted
  r = hook('hook_done_check.js', { ...base, hook_event_name: 'Stop', stop_hook_active: false });
  assert.ok(r.returncode === 0 && r.stdout.trim() === '');
  const kinds = lines(events).map((l) => JSON.parse(l).event);
  assert.ok(kinds.includes('blocked') && kinds.includes('test') && kinds.includes('stop_refused') && kinds[kinds.length - 1] === 'stop');

  // --- CI checks on the lane branch (scope, test count, deps, docs)
  for (const script of ['ci_scope_diff.js', 'ci_test_count.js', 'ci_dep_diff.js', 'ci_changed_docs.js']) {
    r = runScript(script, ['--repo', wt, '--base', 'main']);
    assert.equal(r.returncode, 0, `${script}: ${r.stderr}`);
  }
  // review report missing -> CI fails; status says in-review? no: building (no report yet)
  assert.equal(runScript('ci_review_report.js', ['--repo', wt]).returncode, 1);
  const head = F.git(['rev-parse', 'HEAD'], wt).trim();
  const reviewPath = path.join(wt, 'docs/specs/refund-route.review.md');
  fs.writeFileSync(reviewPath, makeReview({ head: head.slice(0, 10), verdict: 'PASS' }));
  assert.equal(runScript('validate_docs.js', [reviewPath, '--repo', wt]).returncode, 0);
  F.commitAll(wt, 'review: PASS');
  assert.equal(runScript('ci_review_report.js', ['--repo', wt]).returncode, 0);
  const st = JSON.parse(spawnSync(process.execPath, [path.join(SCRIPTS, 'kit_status.js'), '--repo', root, '--json'], { encoding: 'utf8', env: { KIT_STATUS_NO_GH: '1', PATH: '/usr/bin:/bin:/usr/local/bin' } }).stdout);
  const lane = st.lanes.find((l) => l.slug === 'refund-route');
  assert.ok(lane.position === 'ready-to-merge' && lane.progress.green === 1 && lane.events.blocked >= 2);

  // --- merge (fast-forward main to the lane) and finish
  F.git(['merge', '-q', '--no-ff', 'wt/refund-route', '-m', 'merge refund-route'], root);
  assert.equal(runScript('lane.js', ['finish', 'refund-route', '--repo', root]).returncode, 0);
  assert.ok(!fs.existsSync(wt) && read(rm).includes('| refund-route | M1 | merged |'));
});
