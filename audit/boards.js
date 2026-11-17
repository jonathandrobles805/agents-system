#!/usr/bin/env node
/**
 * Audit: every box and arrow on the four FigJam boards, checked against this repository by a command.
 *
 * Categories (assigned by the check, never by hand):
 *   PRESENT      a script, hook, template rule, or test proves it; evidence = file:line or passing test
 *   INSTRUCTION  exists only as text an agent or command is told to follow; nothing executes it
 *   PLATFORM     provided by Claude Code itself (e.g. subagent isolation), declared in our files
 *   PARTIAL      part scripted, part instruction or missing (both named)
 *   MISSING      no file, rule, or test implements it
 *
 * Usage: node audit/boards.js [--md GAPS.md] [--json]
 * Exit 0 always; the point is the report.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArgumentParser } from '../kit/scripts/args.js';
import * as K from '../kit/scripts/kitlib.js';
import * as F from '../kit/scripts/tests/fixtures.js';
import * as CLAIMS from './claims.js';

const ROOT = path.dirname(path.dirname(K.realResolve(fileURLToPath(import.meta.url))));
const KIT = path.join(ROOT, 'kit');
const S = path.join(KIT, 'scripts');
const T = path.join(KIT, 'templates');
const A = path.join(KIT, 'agents');
const C = path.join(KIT, 'commands');

const RESULTS = [];

const q = '["\']'; // a quote character: the scripts use either style
/** `"x"` in the Python patterns -> a quoted `x` in either quote style. */
const quoted = (...alts) => new RegExp(`${q}(${alts.join('|')})${q}`);

/** Python's str() of a list of strings. */
const pyList = (items) => `[${items.map((i) => `'${i}'`).join(', ')}]`;
const pyBool = (b) => (b ? 'True' : 'False');

/** Return 'relpath:lineno' for each line matching pattern (regex). */
function grep(p, pattern) {
  if (!K.isFile(p)) return [];
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const hits = [];
  K.splitlines(fs.readFileSync(p, 'utf8')).forEach((line, i) => {
    if (re.test(line)) hits.push(`${path.relative(ROOT, p).split(path.sep).join('/')}:${i + 1}`);
  });
  return hits;
}

const exists = (...rels) => rels.filter((r) => fs.existsSync(path.join(ROOT, r)));

/**
 * Run kit tests by their pytest-style ids ("test_lane.py::test_x_y"): `lane.test.js`, test name "x y".
 * -> [ok, last line of the summary]
 */
function pytest(...ids) {
  const files = [];
  const names = [];
  for (const id of ids) {
    const [file, name] = id.split('::');
    const jsFile = `${file.replace(/^test_/, '').replace(/\.py$/, '')}.test.js`;
    if (!files.includes(jsFile)) files.push(jsFile);
    names.push(name.replace(/^test_/, '').replaceAll('_', ' '));
  }
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^(?:${escaped.join('|')})$`, ...files.map((f) => path.join(S, 'tests', f))], {
    cwd: S,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = r.stdout ?? '';
  const count = (label) => Number((out.match(new RegExp(`^# ${label} (\\d+)$`, 'm')) ?? [])[1] ?? 0);
  const passed = count('pass');
  const failed = count('fail');
  const secs = (Number((out.match(/^# duration_ms ([\d.]+)$/m) ?? [])[1] ?? 0) / 1000).toFixed(2);
  const last = out.trim() ? `${failed ? `${failed} failed, ` : ''}${passed} passed in ${secs}s` : (r.stderr ?? '').trim().slice(-200);
  return [r.status === 0 && failed === 0 && passed === ids.length, last];
}

function rec(board, box, status, evidence, gap = '') {
  RESULTS.push({ board, box, status, evidence, gap });
}

function presentIf(board, box, hits, gapIfMissing, minHits = 1) {
  if (hits.length >= minHits) rec(board, box, 'PRESENT', hits.slice(0, 4).join('; '));
  else rec(board, box, 'MISSING', 'no match', gapIfMissing);
}

function instruction(board, box, hits, gap) {
  if (hits.length) rec(board, box, 'INSTRUCTION', hits.slice(0, 3).join('; '), gap);
  else rec(board, box, 'MISSING', 'no match', gap);
}

const readText = (p) => fs.readFileSync(p, 'utf8');
const first = (hits, d = '') => (hits.length ? hits[0] : d);

// ----------------------------------------------------------------------------------------------- board 1

function board1() {
  const b = 1;
  const agents = exists(...['researcher', 'planner', 'spec-critic', 'implementer', 'reviewer'].map((n) => `kit/agents/${n}.md`));
  rec(b, 'Agents: researcher, planner, spec critic, implementer, reviewer', agents.length === 5 ? 'PRESENT' : 'MISSING', agents.join(', '));
  const cmds = exists(...['bootstrap', 'research', 'plan', 'implement', 'review', 'sync', 'retro'].map((n) => `kit/commands/${n}.md`));
  rec(b, 'Commands: /bootstrap /research /plan /implement /review /sync /retro', cmds.length === 7 ? 'PRESENT' : 'MISSING', cmds.join(', '));
  const tm = exists(...['research', 'spec', 'review', 'lesson', 'roadmap'].map((n) => `kit/templates/${n}.md`));
  rec(b, 'Templates: research, spec, review report, lesson, roadmap', tm.length === 5 ? 'PRESENT' : 'MISSING', tm.join(', '));
  const sc = [...grep(path.join(S, 'validate_docs.js'), quoted('citation-(?:missing-file|out-of-range|snippet-mismatch)')), ...exists('kit/scripts/ci_scope_diff.js', 'kit/scripts/ci_test_count.js')];
  rec(b, 'Scripts: validate-docs, citation checker, allow-list diff, test-count compare', sc.length >= 5 ? 'PRESENT' : 'PARTIAL', sc.join('; '));
  rec(b, 'Kit repo with version and changelog', JSON.stringify(exists('VERSION', 'CHANGELOG.md')) === JSON.stringify(['VERSION', 'CHANGELOG.md']) ? 'PRESENT' : 'MISSING', 'VERSION, CHANGELOG.md, git remote origin');
  presentIf(b, '/bootstrap scans the repo', [...grep(path.join(S, 'bootstrap.js'), /^(export )?(async )?function detect\(/), ...grep(path.join(C, 'bootstrap.md'), /--detect-only/)], 'no detection');
  // arrows kit -> bootstrap: bootstrap reads kit templates/stacks/hooks
  presentIf(b, "Arrows: agents/kit repo → /bootstrap (bootstrap uses the kit's templates, stacks, hooks)", grep(path.join(S, 'bootstrap.js'), new RegExp(`KIT_DIR, ${q}(templates|stacks|hooks|ci)${q}`)), 'bootstrap does not read the kit');
  // Generates: actually run bootstrap on a fixture
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  try {
    const root = F.nodeApi(path.join(tmp, 'node-api'));
    const run = spawnSync(process.execPath, [path.join(S, 'bootstrap.js'), '--repo', root], {
      encoding: 'utf8',
      env: { CLAUDE_HOME: path.join(tmp, 'home'), PATH: '/usr/bin:/bin:/usr/local/bin' },
    });
    const returncode = run.status ?? -1;
    const gen = ['CLAUDE.md', 'ROADMAP.md', 'ARCHITECTURE.md', 'DESIGN.md', 'LESSONS.md', 'docs/research/INDEX.md', 'docs/specs/README.md', 'docs/decisions/0001-adopt-agent-kit.md', '.claude/settings.json', '.github/workflows/kit.yml'].filter((p) => K.isFile(path.join(root, p)));
    rec(b, "Arrow 'Generates': CLAUDE.md, ROADMAP.md, hooks (bootstrap run on a fixture)", gen.length === 10 && returncode === 0 ? 'PRESENT' : 'PARTIAL', `bootstrap exit ${returncode}; generated ${gen.length}/10: ` + gen.join(', '));
    rec(b, 'CLAUDE.md short rules and map', K.isFile(path.join(root, 'CLAUDE.md')) && readText(path.join(root, 'CLAUDE.md')).includes('Project map') ? 'PRESENT' : 'MISSING', "generated CLAUDE.md contains '## Project map' and rules");
    const rd = (p) => (K.isFile(path.join(root, p)) ? readText(path.join(root, p)) : '');
    const rm = rd('ROADMAP.md');
    rec(b, 'ROADMAP.md plan, queue, WIP limit', ['## Milestones', '## Queue', 'WIP limit'].every((k) => rm.includes(k)) ? 'PRESENT' : 'MISSING', 'generated ROADMAP.md has Milestones, Queue, WIP limit');
    const ar = rd('ARCHITECTURE.md');
    rec(b, 'ARCHITECTURE.md invariants', ar.includes('## Invariants') && ar.includes('## Layers') ? 'PRESENT' : 'MISSING', 'generated ARCHITECTURE.md has Layers and Invariants; ci_boundaries_simple.js enforces Layers');
    const de = rd('DESIGN.md');
    rec(b, 'DESIGN.md tokens and patterns', de.includes('## Tokens') && de.includes('## Patterns') ? 'PRESENT' : 'MISSING', 'generated DESIGN.md has Tokens and Patterns');
    const le = rd('LESSONS.md');
    const lessonRule = grep(path.join(S, 'validate_docs.js'), quoted('lesson-enforced-by'));
    rec(b, 'LESSONS.md with enforced-by column', le.includes('## Debt') && lessonRule.length ? 'PRESENT' : 'MISSING', 'generated LESSONS.md + validate_docs lesson-enforced-by rule: ' + lessonRule.join('; '));
    rec(b, 'docs/ specs, research + INDEX, decisions', ['docs/specs', 'docs/research/INDEX.md', 'docs/decisions'].every((p) => fs.existsSync(path.join(root, p))) ? 'PRESENT' : 'MISSING', 'generated docs/specs, docs/research/INDEX.md, docs/decisions');
    const st = K.isFile(path.join(root, '.claude', 'settings.json')) ? JSON.parse(readText(path.join(root, '.claude', 'settings.json'))) : {};
    const hooksOk = 'hooks' in st && 'PreToolUse' in st.hooks;
    const ciOk = K.isFile(path.join(root, '.github', 'workflows', 'kit.yml'));
    const bp = grep(path.join(S, 'bootstrap.js'), /function protectBranch/);
    rec(b, 'Hooks, CI, branch protection in repo', hooksOk && ciOk && bp.length ? 'PRESENT' : 'PARTIAL', `settings.json hooks=${pyBool(hooksOk)}; CI workflow=${pyBool(ciOk)}; ${first(bp, 'no protect_branch')} (applied only with --protect)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // Arrows ROADMAP -> worktrees ('Next items'), automatic
  const [okQ, lastQ] = pytest('test_lane.py::test_next_in_queue_respects_goal_and_wip', 'test_lane.py::test_next_step_walks_the_pipeline_from_facts');
  const loop = [...grep(path.join(C, 'run.md'), /lane\.js" next-step/), ...grep(path.join(C, 'run.md'), /lane\.js" next --repo/)];
  rec(b, "Arrow 'Next items': ROADMAP → worktrees automatically", okQ && loop.length >= 2 ? 'PRESENT' : 'MISSING', `lane.js next / next-step decide from files+git; /run loops on them ${loop.slice(0, 2).join('; ')}; tests: ${lastQ}`, okQ ? '' : 'no orchestrator');
  presentIf(
    b,
    'Parallel worktrees, one team per feature (Feature A/B/C)',
    [
      ...grep(path.join(S, 'lane.js'), new RegExp(`${q}worktree${q}, ${q}add${q}`)),
      ...grep(path.join(S, 'lane.js'), /file overlap with active spec/),
      ...grep(path.join(S, 'lane.js'), /WIP limit reached/),
    ],
    'no worktree creation / overlap / WIP',
  );
  const prCreate = grep(path.join(C, 'run.md'), /gh pr create/);
  const waitMerge = grep(path.join(S, 'lane.js'), new RegExp(`${q}?stage${q}?: ${q}wait-merge${q}`));
  rec(b, "Arrow: worktree → 'Small PR merged to main' (PR opened by the pipeline, merged by the human)", prCreate.length && waitMerge.length ? 'PRESENT' : 'INSTRUCTION', [...prCreate, ...waitMerge].join('; '), '');
  rec(b, 'Small PR merged to main (human merges; direct push blocked)', 'PRESENT', [...grep(path.join(S, 'hook_guard_bash.js'), /direct push to main/).slice(0, 1), ...grep(path.join(S, 'bootstrap.js'), new RegExp(`${q}?strict${q}?: true`)).slice(0, 1)].join('; '));
  const retroRow = grep(path.join(C, 'run.md'), /\| `retro` \|/);
  const retroStage = grep(path.join(S, 'lane.js'), new RegExp(`${q}?stage${q}?: [^,}]*${q}retro${q}`));
  rec(b, 'Arrow: merge → /retro (automatic)', retroRow.length && retroStage.length ? 'PRESENT' : 'MISSING', [...retroStage, ...retroRow].join('; '), '');
  presentIf(b, '/retro turns mistake into rule or check (command + agent + lesson rules)', [...exists('kit/commands/retro.md', 'kit/agents/retro.md'), ...grep(path.join(S, 'validate_docs.js'), quoted('lesson-no-change'))], 'no retro');
  instruction(b, "Arrow 'Project lesson' → LESSONS.md", grep(path.join(C, 'retro.md'), /Append the entry to `LESSONS.md`/), 'writing is a command instruction; format is script-validated');
  instruction(b, "Arrow 'Global lesson promoted' → kit repo", grep(path.join(C, 'retro.md'), /gh issue create --repo/), 'opening the kit issue is a command instruction');
  const fl = grep(path.join(T, 'architecture.md'), /Feature flags|Canary|Rollback/);
  const r12 = [...grep(path.join(T, 'review.md'), /^\| R12/), ...grep(path.join(S, 'validate_docs.js'), quoted('checklist-missing-r12'))];
  rec(b, 'Feature flag, canary, monitoring, rollback', 'PARTIAL', `template: ${fl.join('; ')}; reviewer R12 required by validator: ${r12.join('; ')}`, 'flag gate is scripted (R12); canary/monitoring/rollback remain the project\'s checklist, no kit tooling');
  const [okI, lastI] = pytest('test_lane.py::test_incident_record');
  const inc = [...grep(path.join(C, 'retro.md'), /--incident/), ...grep(path.join(A, 'retro.md'), /[Ii]ncident/), ...grep(path.join(S, 'lane.js'), /function recordIncident/)];
  rec(b, "Arrow 'Incident becomes lesson'", okI && inc.length >= 3 ? 'PRESENT' : 'MISSING', `${inc.join('; ')}; test: ${lastI}`, okI ? '' : 'no incident intake');
}

// ----------------------------------------------------------------------------------------------- board 2

function board2() {
  const b = 2;
  const stageResearch = grep(path.join(S, 'lane.js'), new RegExp(`${q}?stage${q}?: ${q}research${q}`));
  const researchRow = grep(path.join(C, 'run.md'), /\| `research` \|/);
  rec(b, 'Next item in ROADMAP.md → research starts', stageResearch.length && researchRow.length ? 'PRESENT' : 'MISSING', [...stageResearch, ...researchRow].join('; '), '');
  let [ok, last] = pytest('test_lane.py::test_index_lookup_reuse_stale_new');
  rec(b, 'Question in research INDEX? → reuse / re-verify (files changed) / new', ok ? 'PRESENT' : 'MISSING', `lane.js index lookup; test: ${last}`);
  instruction(b, 'Spawn researchers, one question each', [...grep(path.join(C, 'research.md'), /Spawn all researchers in parallel/), ...grep(path.join(A, 'researcher.md'), /ONE question/)], 'spawning is command/agent text (Claude Code Agent tool)');
  [ok, last] = pytest('test_validate_docs.py::test_untagged_finding_fails', 'test_validate_docs.py::test_hedge_word_fails', 'test_validate_docs.py::test_false_citation_line_range_fails');
  rec(b, 'docs/research/*.md every claim tagged; validate-docs rejects untagged, unresolved, hedge words', ok ? 'PRESENT' : 'MISSING', `validate_docs rules untagged-claim, hedge-word, citation-*; tests: ${last}`);
  const hook = [...grep(path.join(A, 'researcher.md'), /SubagentStop/), ...grep(path.join(S, 'validate_docs.js'), /SubagentStop/)];
  rec(b, "Arrow 'No' → back to researcher until it passes", hook.length >= 2 ? 'PRESENT' : 'PARTIAL', hook.join('; '), 'relies on Claude Code honoring SubagentStop exit 2 (documented; U2 untested headless)');
  const req = [
    ...grep(path.join(S, 'validate_docs.js'), new RegExp(`${q}files to read first${q}, ${q}files to change${q}, ${q}impact analysis${q}`)),
    ...grep(path.join(S, 'validate_docs.js'), quoted('done-criteria-no-test')),
    ...grep(path.join(S, 'validate_docs.js'), quoted('non-goals')),
  ];
  rec(b, 'Planner: files to read, impact analysis, assumptions, non-goals, tests per done-criterion', req.length >= 2 ? 'PRESENT' : 'PARTIAL', req.slice(0, 3).join('; '));
  const oq = grep(path.join(S, 'validate_docs.js'), quoted('open-questions'));
  const [okU, lastU] = pytest('test_lane.py::test_unknowns_budget');
  const wired = [...grep(path.join(C, 'plan.md'), /lane\.js" unknowns/), ...grep(path.join(A, 'planner.md'), /lane\.js" unknowns/)];
  if (okU && wired.length) {
    rec(b, 'Unknowns left? None / 1–3 → verification task / over 3 → back to research', 'PRESENT', `lane.js unknowns (exit 0/3/2); test: ${lastU}; wired: ${wired.join('; ')}; final spec must have none: ${first(oq)}`);
  } else {
    rec(b, 'Unknowns left? None / 1–3 → verification task / over 3 → back to research', 'PARTIAL', `'None' enforced: ${first(oq, 'no')}; counting script test: ${lastU}; wired: ${wired.length ? pyList(wired) : 'no'}`, 'no script counts [unknown] tags');
  }
  presentIf(b, 'Verification task or spike per unknown (exit 3 → one researcher per item, method required)', [...grep(path.join(S, 'lane.js'), new RegExp(`${q}?resolve${q}?: \``)), ...grep(path.join(C, 'plan.md'), /exit 3 \(`resolve`\)/)], 'no resolve path');
  presentIf(b, 'More than 3 unknowns: back to research (exit 2)', [...grep(path.join(S, 'lane.js'), new RegExp(`${q}?research${q}?: \``)), ...grep(path.join(C, 'plan.md'), /exit 2 \(`research`\)/)], 'no research-insufficient path');
  [ok, last] = pytest('test_lane.py::test_precheck_refuses_overlap_and_wip');
  rec(b, 'File overlap or WIP limit hit? → Spec refused, you are told why', ok ? 'PRESENT' : 'MISSING', `lane.js precheck; test: ${last}`);
  presentIf(b, 'Spec critic agent checks gaps and contradictions', [...exists('kit/agents/spec-critic.md'), ...grep(path.join(C, 'plan.md'), /spec-critic/)], 'no critic');
  [ok, last] = pytest('test_validate_spec_review.py::test_risk_flag_required_when_touching_payments');
  const summ = grep(path.join(S, 'validate_docs.js'), new RegExp(`${q}summary${q}, ${q}goal${q}, ${q}non-goals${q}`));
  rec(b, 'docs/specs/f.md one-screen summary, risk flag', ok && summ.length ? 'PRESENT' : 'PARTIAL', `Summary required ${first(summ, 'no')}; risk test: ${last}`);
  const notes = grep(path.join(C, 'run.md'), /\*Changes\*: give the human's text to the planner/);
  rec(b, "You approve? 'No, with notes' → back to planner", notes.length ? 'PRESENT' : 'MISSING', notes.join('; ') || 'no routing of notes to the planner', notes.length ? '' : 'needs /run pause 1');
  [ok, last] = pytest('test_validate_spec_review.py::test_approved_status_requires_approval_line', 'test_lane.py::test_precheck_refuses_unapproved');
  rec(b, 'Approval line: name, date, commit hash (required before build)', ok ? 'PRESENT' : 'MISSING', `validate_docs approval-line + lane precheck; tests: ${last}`);
  const stageLane = grep(path.join(S, 'lane.js'), new RegExp(`${q}?stage${q}?: ${q}lane${q}`));
  const laneRow = grep(path.join(C, 'run.md'), /\| `lane` \|/);
  rec(b, 'Arrow → To build stage (automatic)', stageLane.length && laneRow.length ? 'PRESENT' : 'MISSING', [...stageLane, ...laneRow].join('; '), '');
}

// ----------------------------------------------------------------------------------------------- board 3

function board3() {
  const b = 3;
  let [ok, last] = pytest('test_lane.py::test_start_creates_worktree_lane_and_progress');
  const sync = [...grep(path.join(S, 'bootstrap.js'), /git fetch origin/), ...grep(path.join(C, 'implement.md'), /bash scripts\/sync\.sh/)];
  rec(b, 'Approved spec → worktree from fresh main, /sync runs', ok && sync.length ? 'PRESENT' : 'PARTIAL', `lane.js start fetches base and adds worktree; test: ${last}; sync.sh generated ${first(sync, 'no')}; invoked by implement.md (instruction)`);
  [ok, last] = pytest('test_hooks.py::test_edit_unread_file_blocked', 'test_hooks.py::test_edit_after_read_allowed', 'test_hooks.py::test_lane_blocks_file_outside_spec');
  rec(b, 'Read spec files, read log recorded; pre-edit hook blocks unread or out-of-spec file', ok ? 'PRESENT' : 'MISSING', `hook_read_log + hook_guard_edit; tests: ${last}`);
  const [okT, lastT] = pytest('test_hooks.py::test_guard_tests_only', 'test_hooks.py::test_done_check_in_test_stage_needs_red_only', 'test_agents.py::test_tester_cannot_write_app_code');
  const wiredT = grep(path.join(C, 'implement.md'), /Spawn the `tester` agent/);
  rec(b, 'Write tests from done-criteria, run red, logged (before code)', okT && wiredT.length ? 'PRESENT' : 'PARTIAL', `tester agent + hook_guard_tests_only (tests only) + done-check test stage (red required); /implement runs tester first ${first(wiredT)}; tests: ${lastT}`, okT && wiredT.length ? '' : 'tester not wired');
  [ok, last] = pytest('test_hooks.py::test_post_edit_check_runs_commands_and_blocks_on_failure', 'test_hooks.py::test_post_edit_check_detects_weakened_tests', 'test_hooks.py::test_shell_edit_outside_spec_is_caught_post_edit');
  rec(b, 'Post-edit hook: typecheck, lint, tests, test-count(weakened), scope', ok ? 'PRESENT' : 'PARTIAL', `typecheck/lint/tests/weakened/shell-scope: ${last}; ${grep(path.join(S, 'hook_post_edit_check.js'), /function shellScopeViolations/).join('; ')}`, ok ? '' : 'post-edit scope not proven');
  [ok, last] = pytest('test_hooks.py::test_done_check_allows_when_all_green', 'test_hooks.py::test_done_check_refuses_incomplete_criteria');
  rec(b, 'Green → progress.md updated, green run logged (Stop refused otherwise)', ok ? 'PRESENT' : 'MISSING', `hook_done_check; tests: ${last}; progress.md content itself is written by the agent`);
  const [okA, lastA] = pytest('test_hooks.py::test_attempt_counter_escalates_after_three_same_failures', 'test_hooks.py::test_attempt_counter_resets_on_green_and_tracks_distinct_failures');
  if (okA) {
    rec(b, 'Red → Attempts under 3? → Yes: implement again / No: stop, escalate', 'PRESENT', `hook_post_edit_check counts the same failure per session, writes Escalation at ${grep(path.join(S, 'hook_post_edit_check.js'), /^(export )?const MAX_ATTEMPTS/).join('; ')}; tests: ${lastA}`);
  } else {
    rec(b, 'Red → Attempts under 3? → Yes: implement again / No: stop, escalate', 'PARTIAL', `tests: ${lastA}`, 'attempt counter not proven');
  }
  [ok, last] = pytest('test_hooks.py::test_done_check_allows_with_escalation', 'test_hooks.py::test_budget_check_blocks_after_limit_and_writes_escalation');
  rec(b, 'Stop, write progress.md, escalate to you with fail list', ok ? 'PRESENT' : 'PARTIAL', `done-check accepts escalation; budget-check writes one; tests: ${last}; attempt-based escalation text is written by the agent`);
  const tools = grep(path.join(A, 'reviewer.md'), /^tools:/);
  rec(b, 'Reviewer, fresh context: spec, diff, log only', 'PLATFORM', `subagent isolation is Claude Code's; inputs restricted by review.md + ${first(tools)}; never given builder conversation: ${grep(path.join(C, 'review.md'), /Give it nothing else/).join('; ')}`);
  instruction(b, 'Reviewer re-runs tests, writes adversarial tests from spec', grep(path.join(A, 'reviewer.md'), /Run the full test suite yourself|adversarial test/), 'reviewer instruction; validate_docs requires R3/R11 rows with evidence');
  [ok, last] = pytest('test_validate_spec_review.py::test_pass_without_evidence_fails', 'test_validate_spec_review.py::test_fail_row_needs_fail_list_entry_and_verdict');
  rec(b, 'Checklist PASS or FAIL with file:line evidence', ok ? 'PRESENT' : 'MISSING', `validate_docs checklist-no-evidence, fail-not-listed, verdict-mismatch; tests: ${last}`);
  const cfg = grep(path.join(S, 'bootstrap.js'), /second_reviewer_model/);
  const [okS, lastS] = pytest('test_ci_scripts.py::test_bootstrap_writes_second_reviewer_key_and_upgrade_all');
  rec(b, 'High-risk flag? → Second reviewer, different model', cfg.length && okS ? 'PRESENT' : 'PARTIAL', `review.md: ${grep(path.join(C, 'review.md'), /second_reviewer_model/).join('; ')}; kit.json key written by bootstrap: ${first(cfg, 'no')}; test: ${lastS}`, cfg.length ? '' : 'key never written');
  [ok, last] = pytest('test_validate_spec_review.py::test_fail_entry_missing_fields_fails');
  rec(b, 'Fail list: file, line, rule, what passing looks like', ok ? 'PRESENT' : 'MISSING', `validate_docs fail-entry; test: ${last}`);
  instruction(b, 'All PASS? No → fail list → implementer → review again (3 rounds)', grep(path.join(C, 'review.md'), /Fix exactly these items|after 3 FAIL rounds/), 'loop is review.md instruction');
  const ci = grep(path.join(KIT, 'ci', 'github.yml'), /ci_scope_diff|ci_test_count|ci_dep_diff|ci_review_report|gitleaks|boundaries:|tests:/);
  const [okG, lastG] = pytest('test_ci_scripts.py::test_mutation_gate_flips_after_two_merged');
  rec(b, 'CI: full suite, import boundaries, allow-list diff, test count, mutation score, secrets, dependency diff, review report present', okG && ci.length >= 7 ? 'PRESENT' : 'PARTIAL', `jobs: ${ci.length} matches in kit/ci/github.yml; mutation gate ${grep(path.join(S, 'ci_mutation_gate.js'), /function main/).join('; ')}; test: ${lastG}`, okG ? '' : 'mutation never blocking');
  const bp = [...grep(path.join(S, 'bootstrap.js'), new RegExp(`${q}?strict${q}?: true`)), ...grep(path.join(S, 'bootstrap.js'), quoted('review-report'))];
  rec(b, 'Branch protection: up to date, checks green, review report present', bp.length >= 2 ? 'PRESENT' : 'PARTIAL', bp.join('; ') + ' (applied only with --protect)');
  rec(b, 'You merge (never the pipeline)', 'PRESENT', [...grep(path.join(C, 'review.md'), /never merges/), ...grep(path.join(S, 'hook_guard_bash.js'), /direct push to main/)].join('; '));
  const [okM, lastM] = pytest('test_kit_status.py::test_merged_is_derived_from_git_even_if_roadmap_not_updated');
  const gitm = [...grep(path.join(S, 'kit_status.js'), /merge-base/), ...grep(path.join(S, 'lane.js'), new RegExp(`addParser\\(${q}merged${q}\\)`)), ...grep(path.join(C, 'retro.md'), /lane\.js" merged/)];
  rec(b, "ROADMAP.md marked done (at merge); dashboard knows 'merged' from git", okM && gitm.length >= 3 ? 'PRESENT' : 'PARTIAL', `${gitm.join('; ')}; test: ${lastM}`, okM ? '' : 'merged not derived from git');
}

// ----------------------------------------------------------------------------------------------- board 4

function board4() {
  const b = 4;
  const tags = grep(path.join(S, 'kitlib.js'), /^(export )?const TAG_(VERIFIED_LINES|VERIFIED_CMD|DOCS|INFERRED|UNKNOWN)/);
  rec(b, 'Provenance tag on every claim: verified, docs, inferred, unknown', tags.length === 5 ? 'PRESENT' : 'MISSING', tags.join('; '));
  let [ok, last] = pytest('test_validate_docs.py::test_citation_to_missing_file_fails', 'test_validate_docs.py::test_snippet_mismatch_fails', 'test_validate_docs.py::test_cmd_tag_without_output_block_fails');
  rec(b, 'Tool output: tests, grep, typecheck, file read with lines (citations resolve)', ok ? 'PRESENT' : 'MISSING', `citation checker + cmd block rule; tests: ${last}`);
  const inst = grep(path.join(A, 'researcher.md'), /installed source/);
  const chk = grep(path.join(S, 'validate_docs.js'), /node_modules|site-packages|installed/);
  rec(b, 'Installed library source at pinned version', inst.length && !chk.length ? 'INSTRUCTION' : chk.length ? 'PRESENT' : 'MISSING', `researcher.md ${first(inst)}; validator check: ${chk.length ? pyList(chk) : 'none'}`, 'no script verifies a library claim came from the installed package');
  [ok, last] = pytest('test_validate_docs.py::test_docs_tag_latest_version_fails');
  rec(b, 'Official docs at pinned version', ok ? 'PRESENT' : 'MISSING', `docs-version rule; test: ${last}`);
  [ok, last] = pytest('test_validate_docs.py::test_hedge_word_fails');
  rec(b, 'Model memory → not evidence', ok ? 'PRESENT' : 'MISSING', `hedge-word rule; untagged-claim rule; test: ${last}`);
  [ok, last] = pytest('test_validate_docs.py::test_unknown_in_findings_not_allowed', 'test_validate_docs.py::test_unknown_without_method_fails', 'test_validate_spec_review.py::test_inferred_in_files_to_change_fails');
  rec(b, 'Unknown becomes a verification task, never a decision', ok ? 'PRESENT' : 'MISSING', `tag-not-allowed, unknown-no-method, decisions need verified/docs; tests: ${last}`);
  rec(b, 'validate-docs script rejects untagged or unresolvable claims', 'PRESENT', grep(path.join(S, 'validate_docs.js'), quoted('untagged-claim', 'citation-missing-file')).join('; '));
  presentIf(b, '/retro: what went wrong (command + agent)', exists('kit/commands/retro.md', 'kit/agents/retro.md'), 'no retro', 2);
  [ok, last] = pytest('test_validate_spec_review.py::test_good_lessons_pass', 'test_validate_spec_review.py::test_enforced_lesson_without_change_fails', 'test_validate_spec_review.py::test_text_only_lesson_needs_reason');
  rec(b, 'LESSONS.md entry with enforced-by column', ok ? 'PRESENT' : 'MISSING', `lesson rules; tests: ${last}`);
  const debtW = grep(path.join(C, 'retro.md'), /## Debt/);
  const debtC = grep(path.join(S, 'kit_status.js'), /function textOnlyDebt/);
  rec(b, 'Text-only lesson? Yes → listed as debt until it becomes a check', 'PARTIAL', `writing to Debt: retro.md ${first(debtW, 'no')} (instruction); counting: ${first(debtC, 'no')} (script)`, 'listing is an instruction; nothing enforces that debt shrinks');
  instruction(b, 'No → new hook, lint rule or test (applied)', grep(path.join(C, 'retro.md'), /Apply the proposed change/), 'applying the change is a command instruction; kit-level changes become issues');
  const cap = exists('kit/scripts/ci_claude_md_cap.js');
  const rm = grep(path.join(C, 'retro.md'), /remove it from `CLAUDE\.md`/);
  rec(b, 'CLAUDE.md size cap: enforced rules removed from text', 'PARTIAL', `cap: ${first(cap, 'none')} (script, CI); removal: ${first(rm, 'none')} (instruction)`, 'removal of enforced rules from CLAUDE.md is an instruction');
  const up = grep(path.join(S, 'bootstrap.js'), /--upgrade/);
  const allp = [...grep(path.join(S, 'bootstrap.js'), quoted('--all')), ...exists('release.sh')];
  rec(b, 'Applies to every project → kit version bump, /bootstrap --upgrade all projects', allp.length >= 2 ? 'PRESENT' : 'PARTIAL', `per-repo: ${first(up, 'none')}; --upgrade --all: ${first(allp, 'none')}; release.sh tags the version: ${pyBool(allp.includes('release.sh'))}`, allp.length >= 2 ? '' : 'no all-projects upgrade');
  rec(b, 'Enforcement layers: Text → Process → Code, pushed down', 'PARTIAL', `layers exist (CLAUDE.md, gates, hooks/CI); debt counted ${first(debtC)}`, 'nothing enforces that a text rule is pushed down over time');
  const fl = grep(path.join(T, 'architecture.md'), /Feature flags|Canary|Rollback/);
  const rv = [...grep(path.join(T, 'review.md'), /^\| R12/), ...grep(path.join(S, 'validate_docs.js'), quoted('checklist-missing-r12'))];
  rec(b, 'Feature flag → canary slice → error monitoring → one-command rollback', 'PARTIAL', `flag gate R12 scripted: ${rv.join('; ')}; template: ${fl.join('; ')}`, 'canary, monitoring, rollback stay the project\'s checklist (no kit tooling, by design)');
  const [okI, lastI] = pytest('test_lane.py::test_incident_record');
  const inc = [...grep(path.join(C, 'retro.md'), /--incident/), ...grep(path.join(A, 'retro.md'), /[Ii]ncident/), ...grep(path.join(S, 'lane.js'), /function recordIncident/), ...exists('kit/templates/incident.md')];
  rec(b, 'Incident becomes lesson', okI && inc.length >= 4 ? 'PRESENT' : 'MISSING', `${inc.join('; ')}; test: ${lastI}`, okI ? '' : 'no path from an incident into /retro');
}

export function main(argv) {
  const ap = new ArgumentParser({ prog: 'boards.js', description: 'options:\n  -h, --help  show this help message and exit\n  --md MD\n  --json' });
  ap.usage = () => 'usage: boards.js [-h] [--md MD] [--json]';
  ap.addArgument('--md');
  ap.addArgument('--json', { action: 'store_true' });
  const a = ap.parseArgs(argv);
  const headSha = (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim();
  RESULTS.length = 0;
  board1();
  board2();
  board3();
  board4();
  if (a.json) {
    process.stdout.write(K.jsonDumps(RESULTS, { indent: 2 }) + '\n');
  } else {
    for (const bno of [1, 2, 3, 4]) {
      process.stdout.write(`\n=== Board ${bno} ===\n`);
      for (const r of RESULTS) {
        if (r.board === bno) process.stdout.write(`[${r.status.padEnd(11)}] ${r.box}\n             evidence: ${r.evidence}` + (r.gap ? `\n             gap: ${r.gap}` : '') + '\n');
      }
    }
    const tot = ['PRESENT', 'PLATFORM', 'INSTRUCTION', 'PARTIAL', 'MISSING'].map((s) => `'${s}': ${RESULTS.filter((r) => r.status === s).length}`).join(', ');
    process.stdout.write(`\nchecked at ${headSha}: ${RESULTS.length} boxes/arrows → {${tot}}\n`);
  }
  // The boards audit grades the diagrams; the claim grader grades the spec's own normative sentences. Both answer
  // "does the text match the code", so they report together and `node audit/boards.js` fails on either.
  const graded = CLAIMS.grade(CLAIMS.specText());
  const falsified = graded.filter((g) => g.verdict === 'FALSIFIED');
  if (!a.json) {
    process.stdout.write('\n=== KIT-SPEC claims ===\n');
    for (const g of falsified) process.stdout.write(`[FALSIFIED  ] §${g.section} (line ${g.line}, by ${g.by})\n             claim: ${g.text.slice(0, 140)}\n             evidence: ${g.evidence.slice(0, 180)}\n`);
    const ct = ['FALSIFIED', 'UNSUPPORTED', 'SUPPORTED', 'UNGRADED'].map((v) => `'${v}': ${graded.filter((g) => g.verdict === v).length}`).join(', ');
    process.stdout.write(`\n${graded.length} normative sentences → {${ct}}\n`);
  }
  if (falsified.length) return 1;
  if (a.md) {
    const lines = [
      `# Board audit against \`${headSha}\``,
      '',
      'Generated by `node audit/boards.js --md`. Every line below comes from a command, not from memory.',
      '',
      'Legend: PRESENT = script/hook/test proves it · PLATFORM = Claude Code feature, declared here · INSTRUCTION = agent/command text only · PARTIAL = part scripted · MISSING = nothing implements it',
      '',
    ];
    for (const [bno, title] of [[1, 'System overview'], [2, 'Research → Plan → Approve'], [3, 'Build → Review → Merge'], [4, 'Truth model, learning loop, safety net']]) {
      lines.push(`## Board ${bno}: ${title}`, '');
      for (const r of RESULTS) {
        if (r.board !== bno) continue;
        const box = r.status === 'PRESENT' || r.status === 'PLATFORM' ? '[x]' : '[ ]';
        lines.push(`- ${box} **${r.status}** — ${r.box}  `);
        lines.push(`  evidence: \`${r.evidence}\`  `);
        if (r.gap) lines.push(`  gap: ${r.gap}  `);
      }
      lines.push('');
    }
    const gaps = RESULTS.filter((r) => ['INSTRUCTION', 'PARTIAL', 'MISSING'].includes(r.status));
    lines.push('## Open items (everything not PRESENT/PLATFORM)', '');
    for (const r of gaps) lines.push(`- [ ] (board ${r.board}, ${r.status}) ${r.box}: ${r.gap || r.evidence}`);
    fs.writeFileSync(a.md, lines.join('\n') + '\n');
  }
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
