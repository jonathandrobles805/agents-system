# Hybrid Factory Adoption Blueprint

> **Status:** DRAFT — planning only; no implementation code authorized by this document.
> **Target:** `jonathandrobles805/agents-system`
> **Reference:** [Software Factory Claude Code v2](https://github.com/zazencodes/zazencodes-season-3/tree/main/src/software-factory-claude-code-v2)

## 0. Verified current state (audited against `main`)

The following describes the repository as it exists now; it is not the target design:

- `kit/commands/` contains **23 command definitions** and `kit/agents/` contains **8 agent definitions**. The tracked repository contains **0 skill definitions**. `/new-skill` is a command and `skill-development.json` is a workflow for creating future skills; neither is itself a skill. Some operating-model text discusses skills conceptually, but there are no reusable skill packages in the current tree.
- The current user-facing path is `/start` → `/run`, not `/factory`. `/start` agrees the goal, writes the goal and roadmap entry, creates and merges a documentation-only goal PR after that agreement, then asks whether to run, queue, or stop. `/run` is the current pipeline orchestrator. There is no `kit/commands/factory.md` on `main`.
- The feature profile currently includes a `research` stage. `lane.js next-step` moves to `plan` when it finds a current indexed research row matching the feature slug/question/keywords; otherwise it returns `research`. `/research` checks each question for reuse, re-verification, or new research, and the planner can spawn researchers for up to three unresolved questions. The initial feature-stage shortcut is coarser than a per-question evidence-gap assessment; tightening that is a planned improvement, not existing behavior.
- `lane.js` creates one worktree and `.claude/lane.json` per lane. `nextStep()` derives the next stage from repository artifacts and Git, but `setStage()` currently writes a requested stage without validating a legal transition graph. `lane.js start()` falls back to the local base when fetching `origin/<base>` fails, and also uses the local base when no `origin` remote exists.
- The tester already writes criterion-linked tests before implementation, asserts observable behavior, adds negative/boundary cases, and is told not to mock the thing under test. The stop hook checks that red/green log references exist and have the expected exit codes; it does **not** independently prove that a red run failed because the expected behavior assertion failed rather than because of a broken test or environment.
- `hook_post_edit_check.js` skips a check whose command is absent. The generated CI template fails when a required command is missing, while an explicit `none: <reason>` is an intentional, visible opt-out. These are different enforcement layers.
- GitHub currently reports the repository's `main` branch as **unprotected**. `bootstrap.js protectBranch()` also sets `enforce_admins: false`. Its required-context list includes names such as `scope-diff`, `test-count`, and `validate-docs`, which are steps inside the `kit-checks` job, not independent workflow jobs. The context list must be corrected and verified against actual GitHub check-run names.
- The referenced Factory v2 has four reviewer agents: `reviewer-code`, `reviewer-security`, `reviewer-ui`, and `reviewer-ux`. Its route script selects reviewer/model combinations from configured risk and surface values. It has no architecture reviewer. The unversioned Factory folder's README points readers to v2 as the newer implementation; no v3 directory exists in the repository's current `main` tree.

## 1. Objective

Make `/factory` the primary autonomous execution entry point. Preserve the kit's human-agreed goals, approved specifications, test-first workflow, architecture controls, isolated worktrees, and human-controlled merge.

The factory runs independently inside the approved scope. It reports to the human only for a defined decision, blocked work, failed enforcement, or final merge. It must never approve its own scope changes, bypass a required check, or merge its own work.

**Do not copy Factory v2 wholesale.** Adapt its orchestration, durable job progression, four-lens review model, risk/surface routing, and deterministic gates to the existing kit. Its research model and human approval points differ from this kit and must not replace them. Do not introduce a second runtime state system or a skills layer that does not exist in this repository.

## 2. Target operating model

### Commands and responsibilities

| Entry point | Responsibility after adoption |
|---|---|
| `/start` | Agree the goal with the human; write the goal and roadmap entry; create and merge the documentation-only goal PR after agreement; then ask whether to run, queue, or stop. No research or product coding. |
| `/new-feature` | Feature-specific entry point: follows `/start`, classifies the work, then hands the agreed goal to `/factory`. |
| `/research` | Standalone research request. Check the research index first; reuse current findings, reverify stale findings, and create new research only when needed. |
| `/factory [slug\|--queue]` | **New primary execution interface.** Owns the current `/run` orchestration loop: resume one approved goal or drain the queue, dispatch profile-approved agents, run scripts and gates, and park only when human action is required. It must be the sole orchestrator, not a second pipeline beside `/run`. |
| `/run` | Compatibility command during migration. Make it a thin delegate to `/factory`; do not retain a second copy of the orchestration instructions or a separate state path. |

Research must be **evidence-driven**, not repeated blindly. Preserve the current reuse/reverify/new logic, but improve the coarse feature shortcut so the controller assesses each evidence question needed for the goal/spec: reuse current evidence, re-verify evidence whose cited files changed, and dispatch a researcher only for unanswered or stale questions. The current feature profile has a research stage, but a matching index row can currently skip the whole stage; the target must not treat one loosely matching row as proof that every material question is answered. The planner may still dispatch researchers for bounded unresolved questions. `/research` remains available as a standalone command.

### Human intervention and escalation

The orchestrator continues through routine stages without asking for permission at every handoff. It pauses for:

1. Goal agreement in `/start` and specification approval before code.
2. Missing information only the human/request author can provide.
3. A scope, architecture, data-contract, or security decision outside the approved spec.
4. A blocked agent, repeated failure, exhausted retry budget, unavailable required check, or failed security control.
5. Final human merge approval and acceptance/editing of retrospective lessons.

Add a durable `needs-human`/escalation outcome with: reason, evidence, affected criterion, attempts already made, the exact decision needed, and the safe resume action. Notify through the existing notification mechanism and show it in the dashboard. Routine progress stays in logs/dashboard; do not interrupt the human with every stage transition.

Factory v2's reference escalation cases to adopt: intake needs information; builder reports BLOCKED; deterministic checks or reviews still fail after the configured rounds; approver escalates; or the final sync/gate fails. In this kit, a human remains the final merge authority—**do not adopt automatic agent-driven merging**.

## 3. State, orchestration, and isolation

- Keep one orchestrator session responsible for dispatch and resume. It does not write application code or author specs/reviews; all state-changing operations go through controller scripts. `/factory` should reuse the current `/run` orchestration logic rather than introducing a second orchestrator.
- Keep `kit/scripts/lane.js` as the mechanical controller and source of stage derivation. Add a legal transition graph and precondition checks: `nextStep()` already derives stages, but `setStage()` currently writes arbitrary stage values without validating transitions. Agents must not be able to advance stages by choosing a next step or editing controller-owned state.
- Preserve decision [0006: lane position is derived](../decisions/0006-roadmap-status-is-derived.md). Keep the current project `.claude/kit.json` lane registry and each worktree's `.claude/lane.json`; do not introduce a competing Factory-style `job.json` database. Derive displayed position from validated artifacts and Git; controller scripts alone perform state-changing operations.
- Keep one Git worktree and branch per lane. The current kit already creates `wt/<slug>` in a sibling lanes directory; parallel lanes must never share a working directory.
- **Fail closed on base acquisition.** In `lane.js start()`, refuse lane creation if `origin` is absent, `git fetch origin <base>` fails, or the fetched remote ref cannot be resolved. Remove both local-base fallbacks. Record the exact fetched base SHA separately from the lane's starting HEAD.
- A worktree is Git isolation, not a security sandbox. Retain the existing sandbox selection, high-risk container requirement, credential scan, and hook protections. Do not treat worktree separation as permission isolation.

## 4. Testing and mandatory delivery gates

Keep the existing red/green model. Add the Factory's deterministic checks model as a separate layer:

1. **Behavior-first test design:** the tester derives tests directly from each approved done-criterion—not from the implementer's proposed code or internal design. Each test states the preconditions, user/system action, and observable expected outcome. Cover the successful path and relevant negative, boundary, authorization, and failure paths. The test must exercise the real behavior being specified; it must not merely check that a function was called, that code compiles, or that an implementation-specific detail has a particular value. Choose the test level to match the criterion: unit tests for isolated rules, integration/API/contract tests for component interactions and boundaries, and end-to-end/browser tests when the criterion describes a user workflow. A multi-component or user-workflow criterion cannot be declared fully validated by unit tests alone. The tester runs the test against the pre-implementation system and records a meaningful RED result showing the named behavior assertion failed because the required behavior is absent or incorrect. A syntax error, missing import, broken test harness, unavailable dependency, or environment failure is not valid RED evidence. The current stop hook checks exit codes and log references, not the semantic reason for failure; add runner-aware validation where practical and require the reviewer to inspect the failing test/output. If the failure reason cannot be established, stop and escalate rather than accepting RED. The implementer cannot start until the criterion-to-test mapping and valid RED evidence exist.
2. **Implementation feedback:** retain post-edit hooks for fast typecheck/lint/test feedback while code is changing. After implementation, rerun the same criterion-linked tests and require GREEN evidence, then run the relevant regression suite. Do not rewrite or weaken a test simply to make the implementation pass; any test change must be justified against the approved criterion and independently reviewed.
3. **Pre-review gate:** after implementation, run the full required project checks against the exact lane HEAD. If it fails, do not start any reviewer; send the evidence to the implementer for another bounded attempt.
4. **Independent specialist review:** only after the pre-review gate passes.
5. **Pre-merge gate:** fetch and integrate the latest protected base, fail on fetch/conflict, rerun the full required checks, and confirm all review reports apply to the exact resulting HEAD. Any new code commit invalidates prior gate/review evidence.
6. **Human merge:** pause with PR, gate results, reviewer verdicts, and CI status. Never merge automatically.

Implement a deterministic gate (candidate: `kit/scripts/delivery_gate.js`) that:
- loads the required check definitions, workflow template, protected paths, and reviewer policy from the trusted base commit—not from candidate-branch files the implementer can change;
- executes those trusted check definitions against the candidate worktree inside the lane sandbox; never executes a command supplied only by the lane/agent;
- fails when a required command or runner is missing; an intentional `none: <reason>` exclusion must be human-approved and visible in the project configuration;
- checks spec scope, protected paths, weakened/skipped tests, dependency policy, architecture/security checks, and secret scanning;
- records gate phase, exact candidate commit SHA, base SHA, each check/job identifier, exit code, duration, and log path;
- refuses stale evidence whenever candidate HEAD, trusted check configuration, or base SHA changes;
- returns a structured gate result that the controller, reviewer, dashboard, and CI can all consume. Avoid maintaining a second list of required commands that can drift from `kit/ci/github.yml` and `.claude/kit.json`.

The existing CI template `kit/ci/github.yml` already fails unconfigured required CI commands, while the local `hook_post_edit_check.js` skips absent commands. Keep fast local hooks, but make the delivery gate fail closed. Fix `bootstrap.js protectBranch()` to set `enforce_admins: true` and to require **workflow job-level check contexts**, not step names. For example, `scope-diff`, `test-count`, and `validate-docs` are steps within the single `kit-checks` job; they cannot be listed as independent workflow job checks. Build the required-context list from the actual generated workflow jobs and verify the exact names GitHub reports. Require the applicable `tests`, `format`, `integration`, `typecheck`, `lint`, `boundaries`, `kit-checks`, `secrets`, and `audit` checks; treat mutation according to its existing configured blocking policy. The repository's `main` is currently unprotected, so protection must be enabled and verified before this factory can safely manage work on this repository. Require protection for factory-managed projects, prohibit force pushes/deletions, and verify the effective settings after bootstrap. Use a merge queue where the repository plan supports it; otherwise retain the strict up-to-date requirement and report that the queue is unavailable. Do not claim protection merely because a workflow file exists.

## 5. Implementer and specialist review model

### Implementer

Keep `kit/agents/implementer.md` as the build worker (Factory v2's builder equivalent). It receives the approved spec, file allow-list, red tests, architecture rules, lessons, and later gate/reviewer/human feedback. It works in its lane worktree, makes the smallest scoped change, commits criterion by criterion, and resumes in a new round from recorded failure evidence.

It does not design architecture, rewrite acceptance criteria, expand scope, weaken tests, edit kit controls, or approve its own work. Out-of-scope needs go to escalation and require an amended/re-approved spec.

### Reviewer roles and current repository structure

Factory v2's actual review model has **four** specialist agents. The kit should adopt those four distinct lenses; it should not attribute an architecture reviewer to Factory:

| Reviewer role | Provenance | Required when |
|---|---|---|
| Code (`reviewer-code`) | Factory v2 role | Every code change; correctness, simplicity, reuse, conventions, and test quality |
| Security (`reviewer-security`) | Factory v2 role | High risk or changes involving identity, authorization, secrets, payments, sensitive data, trust boundaries, or security controls |
| UI (`reviewer-ui`) | Factory v2 role | Visual/layout/style changes; inspect the running UI at supported desktop and mobile sizes |
| UX (`reviewer-ux`) | Factory v2 role | User workflows, states, copy, role-specific paths, accessibility, keyboard use, and mobile behavior |
| Architecture (`reviewer-architecture`) | **Proposed kit-specific addition; not present in Factory v2** | Only when a change materially alters component boundaries, public contracts, persistence/data ownership, infrastructure/trust boundaries, or architecture rules/models |

The Factory v2 `route` script maps risk and declared surfaces through `factory/config.json`; it does not ask a reviewer agent to choose its own reviewers. The kit should route from trusted, validated risk/surface metadata and changed paths. The planner may identify affected surfaces in the approved spec, but a script must validate those declarations against the diff and select the required set. Code is the baseline; security, UI, UX, and the optional kit-specific architecture reviewer are added only by the deterministic routing policy. Do not conflate UI and UX into one role. If browser tooling is unavailable for a UI/UX change, record the missing verification or escalate; do not report a browser review that did not occur.

Run selected reviewers in parallel and wait for every required verdict. Any CHANGES verdict returns the lane to the implementer within a configured retry limit, then escalates. Refactor the existing general `reviewer` into the code-review role (or rename it and update all references); do not keep a duplicate general reviewer alongside `reviewer-code`.

**Repository correction:** the current repository has **23 command definitions, 8 agent definitions, and 0 skill definitions**. My earlier claim of 23 existing skills was wrong: 23 is the command count. `/new-skill` and `skill-development.json` are a command and workflow for future skill development, not evidence of existing skill packages. The tracked `kit/manifest.json` registers commands, agents, hooks, scripts, CI jobs, and other components; it does not register a skill library. Do not invent skill paths, map nonexistent skills, or add `skill:*` manifest entries as part of this plan. Put reviewer responsibilities in their agent definitions and genuinely shared policy in existing docs/configuration. A reusable-skills system would require a separate explicit design and approval. Reviewer selection must be script/config-driven—not an agent's discretionary routing decision.

## 6. Repository change map

| Existing location | Planned change |
|---|---|
| `kit/commands/factory.md` | **Add.** Public `/factory` orchestrator contract, queue/resume, feedback, escalation, and human wait behavior. |
| `kit/commands/run.md` | Convert to compatibility/internal entry; remove duplicate orchestration instructions. |
| `kit/commands/start.md`, `new-feature.md`, and other profile entry commands | Update every existing `/run` handoff to `/factory`; preserve `/run` as a thin compatibility delegate. Keep goal agreement and goal-document recording separate from feature-spec approval. |
| `kit/commands/research.md` | Preserve standalone behavior; reuse/reverify/new logic; make workflow invocation conditional. |
| `kit/workflows/*.json` | Add explicit reviewer-role routing metadata for each relevant profile and surface; preserve profile-specific safety and human-signoff stages. Do not force unrelated work types through feature-only stages. |
| `kit/scripts/lane.js`, `kit/scripts/reviewer_route.js` | Enforce legal transitions, queue/resume preconditions, retry/escalation limits, base-fetch fail-closed behavior, exact base/HEAD evidence, and deterministic reviewer selection from validated risk/surface metadata. |
| `kit/scripts/delivery_gate.js` + tests | **Add.** Deterministic pre-review and pre-merge gate using trusted base-commit check definitions, structured evidence, and stale-evidence rejection; share its check registry with CI to avoid drift. |
| `kit/agents/implementer.md`, `tester.md` | Preserve test-first and bounded implementation; add resumable build rounds and structured handoff evidence. |
| `kit/agents/reviewer.md` (refactor/rename to code reviewer), new `reviewer-security.md`, `reviewer-ui.md`, `reviewer-ux.md`, and proposed `reviewer-architecture.md` | Implement the four Factory-aligned review lenses. The architecture reviewer is an explicitly optional, kit-specific addition—not a Factory role. Keep agent outputs independent, structured, and tied to the reviewed HEAD. |
| `kit/manifest.json`, `kit/templates/review.md`, `kit/scripts/validate_docs.js`, `kit/scripts/ci_review_report.js` | Register the actual commands/agents/scripts and define/validate per-role reports plus one aggregate PASS tied to the exact HEAD. Do not add a nonexistent skills component type. |
| `kit/ci/github.yml`, `kit/scripts/bootstrap.js` | Generate job-level required contexts correctly, enable admin enforcement, configure branch protection, use merge queue where available, and verify effective protection/check contexts. |
| `kit/scripts/kit_status.js`, `kit/dashboard/model.js`, `kit/dashboard/server.js`, `kit/dashboard/index.html` | Show current stage, each required reviewer status, aggregate verdict, gate status/commit, escalation reason/action, retries, and human queue. |
| `kit/scripts/tests/`, `kit/eval/`, `planted-faults/` | Add unit, integration, real-agent evaluation, and planted-fault cases for valid/invalid red evidence, transitions, gate bypass, trusted-config tampering, check-context mapping, worktree isolation, reviewer routing, and escalation. |
| `docs/KIT-SPEC.md`, `docs/OPERATING-MODEL.md`, `docs/decisions/` | Amend the approved kit contract first (it currently describes one reviewer and a different command layout); explicitly distinguish the 0 implemented skill packages from the planned skill-development concept; update the operating model and record material decisions before implementation. Human approval of the spec amendment is a prerequisite to code. |

## 7. Delivery sequence and acceptance

- [ ] **Phase 0 — Approve this blueprint and amend the contract.** Reconcile this plan with `docs/KIT-SPEC.md` (the approved contract), `docs/OPERATING-MODEL.md`, the 23 commands, 8 agents, workflow profiles, hooks, CI, and dashboard. Record 0 existing skill definitions. Verify the exact GitHub check-run names and branch-protection state; fix the required-context/admin-enforcement design before implementation. No application code changes.
- [ ] **Phase 1 — Factory controller.** Move the existing `/run` orchestration contract to `/factory`, make `/run` a thin delegate, update profile entry-point handoffs, and add queue/resume, legal transitions, escalation records, and fail-closed worktree creation. Prove interrupted jobs resume without duplicate work.
- [ ] **Phase 2 — Test and delivery gates.** Preserve and strengthen behavior-based red/green evidence; add pre-review and pre-merge gates using trusted check definitions; correct the GitHub job-context mapping and admin enforcement. Prove invalid red evidence, a failing/missing required check, or stale commit evidence prevents review/merge.
- [ ] **Phase 3 — Reviewer routing.** Implement the four Factory-aligned agents (code, security, UI, UX) and the optional kit-specific architecture reviewer; route from trusted risk/surface data; require every selected report to PASS on the same HEAD before human merge.
- [ ] **Phase 4 — Security and operations validation.** Run planted-fault and adversarial tests; update dashboard/notifications; pilot on a low-risk feature before enabling full queue autonomy.

**Definition of done:** a job can run and resume unattended inside its approved scope; meaningful behavior-level RED evidence exists before implementation and GREEN/regression evidence afterward; invalid test-run failures, missing checks, stale evidence, scope changes, security issues, and exhausted retries reliably park it for a human; every routed reviewer and both gates are tied to the same commit; the branch-protection contexts correspond to real passing workflow jobs, admin enforcement is on, and merge queue (or strict up-to-date fallback) is verified; and tests demonstrate attempts to bypass these controls are rejected.

Security controls are not considered proven merely because they exist or their ordinary unit tests pass. Phase 4 must demonstrate that the controls catch deliberate bypass attempts. Record any untested or unsupported protection as a limitation; do not label the factory secure until that evidence exists.
