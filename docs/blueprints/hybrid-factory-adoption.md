# Hybrid Factory Adoption Blueprint

> **Status:** DRAFT — planning only; no implementation code authorized by this document.
> **Target:** `jonathandrobles805/agents-system`
> **Reference:** [Software Factory Claude Code v2](https://github.com/zazencodes/zazencodes-season-3/tree/main/src/software-factory-claude-code-v2)

## 1. Objective

Make `/factory` the primary autonomous execution entry point. Preserve the kit's human-agreed goals, approved specifications, test-first workflow, architecture controls, isolated worktrees, and human-controlled merge.

The factory runs independently inside the approved scope. It reports to the human only for a defined decision, blocked work, failed enforcement, or final merge. It must never approve its own scope changes, bypass a required check, or merge its own work.

**Do not copy Factory v2 wholesale.** Adapt its orchestration, durable job progression, risk-based reviewer routing, and deterministic gates to the existing kit. Do not introduce a second runtime state system or a skills layer that does not exist in this repository.

## 2. Target operating model

### Commands and responsibilities

| Entry point | Responsibility after adoption |
|---|---|
| `/start` | Human discussion to agree on the outcome, boundaries, constraints, risk, and roadmap entry. No research or coding. |
| `/new-feature` | Feature-specific wrapper around `/start`; starts or queues the approved feature workflow. |
| `/research` | Standalone research request. Check the research index first; reuse current findings, reverify stale findings, and create new research only when needed. |
| `/factory [slug\|--queue]` | **Primary execution interface.** Resume or drain approved work, dispatch agents, run scripts and gates, and park only when human action is required. |
| `/run` | Retain as a compatibility/internal runner during migration. It must not become a second orchestrator or maintain separate state. |

Research becomes **conditional**, not a mandatory stage for every feature. The planner identifies evidence gaps that materially affect the specification. The controller checks the index; only missing or stale evidence triggers the researcher. An explicit `/research` request remains available at any time.

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

- Keep one orchestrator session responsible for dispatch and resume. It does not write application code, specs, reviews, or state.
- Keep `kit/scripts/lane.js` as the controller and transition authority. Add a legal transition graph and precondition checks; agents cannot advance stages by editing files or choosing the next step.
- Preserve decision [0006: lane position is derived](../decisions/0006-roadmap-status-is-derived.md). Do not introduce a competing Factory-style `job.json` database. Derive displayed position from validated artifacts and Git; let controller scripts own state-changing operations.
- Keep one Git worktree and branch per lane. The current kit already creates `wt/<slug>` in a sibling lanes directory; parallel lanes must never share a working directory.
- **Fail closed on base acquisition.** In `lane.js start()`, a failed `git fetch origin <base>` must refuse lane creation. Remove the fallback to the local base branch. Record the exact base commit used.
- A worktree is Git isolation, not a security sandbox. Retain the existing sandbox selection, high-risk container requirement, credential scan, and hook protections. Do not treat worktree separation as permission isolation.

## 4. Testing and mandatory delivery gates

Keep the existing red/green model. Add the Factory's deterministic checks model as a separate layer:

1. **Behavior-first test design:** the tester derives tests directly from each approved done-criterion—not from the implementer's proposed code or internal design. Each test states the preconditions, user/system action, and observable expected outcome. Cover the successful path and relevant negative, boundary, and failure paths. The test must exercise the real behavior being specified; it must not merely check that a function was called, that code compiles, or that an implementation-specific detail has a particular value. Choose the test level to match the criterion: unit tests for isolated rules, integration/API/contract tests for component interactions and boundaries, and end-to-end/browser tests when the criterion describes a user workflow. A criterion spanning multiple components cannot be considered fully validated by unit tests alone. The tester runs the test against the pre-implementation system and records a meaningful RED result showing the required behavior is absent or incorrect. A failure caused by a broken test, test harness, dependency, or environment is not valid RED evidence. The implementer cannot start until the criterion-to-test mapping and valid RED evidence exist.
2. **Implementation feedback:** retain post-edit hooks for fast typecheck/lint/test feedback while code is changing. After implementation, rerun the same criterion-linked tests and require GREEN evidence, then run the relevant regression suite. Do not rewrite or weaken a test simply to make the implementation pass; any test change must be justified against the approved criterion and independently reviewed.
3. **Pre-review gate:** after implementation, run the full required project checks against the exact lane HEAD. If it fails, do not start any reviewer; send the evidence to the implementer for another bounded attempt.
4. **Independent specialist review:** only after the pre-review gate passes.
5. **Pre-merge gate:** fetch and integrate the latest protected base, fail on fetch/conflict, rerun the full required checks, and confirm all review reports apply to the exact resulting HEAD. Any new code commit invalidates prior gate/review evidence.
6. **Human merge:** pause with PR, gate results, reviewer verdicts, and CI status. Never merge automatically.

Implement a deterministic gate script (candidate: `kit/scripts/delivery_gate.js`) that:
- runs required checks from trusted project configuration, not commands supplied by the lane;
- fails when a required command or runner is missing; an intentional exclusion needs a documented reason and explicit approval;
- checks spec scope, protected paths, weakened/skipped tests, dependency policy, architecture/security checks, and secret scanning;
- records phase, exact commit SHA, base SHA, commands/check IDs, exit codes, durations, and log paths;
- refuses stale evidence when HEAD or base changes.

The existing CI template `kit/ci/github.yml` already fails unconfigured required CI commands, while the local `hook_post_edit_check.js` currently skips missing commands. Keep fast local hooks, but make the new delivery gate fail closed. Make branch protection and required checks mandatory for factory-managed projects; verify the actual GitHub settings rather than assuming bootstrap succeeded. Disable admin bypass and force pushes. Do not rely on the existence of a workflow alone.

## 5. Implementer and specialist review model

### Implementer

Keep `kit/agents/implementer.md` as the build worker (Factory v2's builder equivalent). It receives the approved spec, file allow-list, red tests, architecture rules, lessons, and later gate/reviewer/human feedback. It works in its lane worktree, makes the smallest scoped change, commits criterion by criterion, and resumes in a new round from recorded failure evidence.

It does not design architecture, rewrite acceptance criteria, expand scope, weaken tests, edit kit controls, or approve its own work. Out-of-scope needs go to escalation and require an amended/re-approved spec.

### Reviewer roles and current repository structure

Adopt four review responsibilities, routed deterministically from risk and changed surfaces:

| Reviewer role | Required when |
|---|---|
| Code | Every code change |
| Security | High risk or changes involving identity, authorization, secrets, payments, sensitive data, trust boundaries, or security controls |
| Architecture | Changes to boundaries, APIs/contracts, persistence, infrastructure, or architecture rules |
| UX/UI | User-facing changes; browser-based checks are required when a browser test runtime is configured for that project |

Run the selected reviewers in parallel; wait for every required verdict. Any CHANGES verdict returns the lane to the implementer. Retry only within a configured limit, then escalate. Preserve the general reviewer as a code-review fallback/coordinator only if its responsibilities are explicit; do not run duplicate overlapping reviews.

**Repository correction:** the current `agents-system` repository contains command definitions, agent definitions, workflow JSON, scripts, and CI configuration. It does not contain the 23 skill definitions previously referenced; that was my incorrect description. The tracked `kit/manifest.json` registers commands and agents, not a skill library. Therefore, there is no skill inventory to perform and nothing to map as existing skills. Do not invent skill paths, create duplicate skill files, or add `skill:*` manifest entries as part of this plan. Put each reviewer's accountable responsibilities in its agent definition and keep genuinely shared policy in the repository's existing documentation/configuration. A separate reusable-skills system would require its own explicit design and approval. Reviewer selection must be script/config-driven—not an agent's discretionary routing decision.

## 6. Repository change map

| Existing location | Planned change |
|---|---|
| `kit/commands/factory.md` | **Add.** Public `/factory` orchestrator contract, queue/resume, feedback, escalation, and human wait behavior. |
| `kit/commands/run.md` | Convert to compatibility/internal entry; remove duplicate orchestration instructions. |
| `kit/commands/start.md`, `new-feature.md` | Keep human goal/scope agreement; clarify handoff to `/factory`. |
| `kit/commands/research.md` | Preserve standalone behavior; reuse/reverify/new logic; make workflow invocation conditional. |
| `kit/workflows/*.json` | Add common gate/review stages and risk/surface routing without bypassing any profile's existing safety stages. |
| `kit/scripts/lane.js` | Enforce legal transitions, retry/escalation limits, queue/resume preconditions, base-fetch fail-closed behavior, and exact commit evidence. |
| `kit/scripts/delivery_gate.js` + tests | **Add.** Deterministic pre-review and pre-merge gate with immutable trusted checks and stale-evidence rejection. |
| `kit/agents/implementer.md`, `tester.md` | Preserve test-first and bounded implementation; add resumable build rounds and structured handoff evidence. |
| `kit/agents/reviewer.md` + specialist agent files | Add code, security, architecture, and UX/UI reviewer roles; keep agent outputs structured and evidence-based. |
| `kit/manifest.json` | Register new/changed commands and agents using the manifest's existing component model; do not add a nonexistent skills component type. |
| `kit/ci/github.yml`, `kit/scripts/bootstrap.js` | Require the generated checks and verify protected-branch settings; no silent optional protection for factory mode. |
| `kit/scripts/kit_status.js`, `kit/dashboard/server.js`, `kit/dashboard/index.html` | Show current stage, gate status/commit, reviewer statuses, escalation reason/action, retries, and human queue. |
| `kit/scripts/tests/`, `kit/eval/` | Add unit, integration, planted-fault, and adversarial tests for transitions, gate bypass, worktree isolation, routing, and escalation. |
| `docs/OPERATING-MODEL.md`, `docs/decisions/` | Update the approved operating model and record material architecture decisions before implementation. |

## 7. Delivery sequence and acceptance

- [ ] **Phase 0 — Approve this blueprint.** Inventory the actual commands, agent definitions, workflow profiles, hooks, CI checks, and dashboard data. Record explicitly that the current repository has no tracked skill definitions; do not create a skills layer during this phase. No code changes.
- [ ] **Phase 1 — Factory controller.** Add `/factory`, queue/resume, legal transitions, escalation records, and fail-closed worktree creation. Prove interrupted jobs resume without duplicate work.
- [ ] **Phase 2 — Test and delivery gates.** Preserve red/green tests; add pre-review and pre-merge gates; enforce required GitHub checks and protection. Prove a failing or missing required check prevents review/merge.
- [ ] **Phase 3 — Reviewer routing.** Define the four reviewer agents' responsibilities and required evidence in their agent definitions; route from trusted risk/surface data; require all selected verdicts before human merge.
- [ ] **Phase 4 — Security and operations validation.** Run planted-fault and adversarial tests; update dashboard/notifications; pilot on a low-risk feature before enabling full queue autonomy.

**Definition of done:** a job can run and resume unattended inside its approved scope; missing evidence, failed checks, scope changes, security issues, and exhausted retries reliably park it for a human; all required reviewers and both gates are tied to the same commit; GitHub prevents an unqualified merge; and tests demonstrate that attempts to bypass these controls are rejected.

Security controls are not considered proven merely because they exist or their ordinary unit tests pass. Phase 4 must demonstrate that the controls catch deliberate bypass attempts. Record any untested or unsupported protection as a limitation; do not label the factory secure until that evidence exists.
