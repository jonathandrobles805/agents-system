# Universal AI Engineering System
## Operating Model, Version 4.1

Status: adopted. Repository state at adoption: `fbe9d5b` (JavaScript port, PR #10; fail-closed guards, PR #11; architecture canvas and manifest, PR #12; 183 tests; 19/19 planted faults; `npm run architecture:check` clean). Version history lives in `CHANGELOG.md` and `docs/decisions/`; this document states the current rules only. Sources for the patterns adopted: Anthropic, *Building effective agents* (2024), *Multi-agent research system* (2025), *Effective context engineering* (2025), *Harness design for long-running application development* (2026), Claude Code documentation (sandboxing, skills, subagents).

# 1. Principle

AI agents perform bounded reasoning and engineering work. Deterministic software governs routing, permissions, transitions and enforcement. Humans hold authority over the decisions that matter. A feature is complete when it is architecturally appropriate, secure, maintainable, testable, independently verified and operable, not when it works.

# 2. Layers and authority

| Layer | Holds | Does |
|---|---|---|
| 1 Human | Authority | Objectives and priorities; approves architecture, specs, recovery roadmaps; resolves escalations; authorizes high-risk and destructive operations; signs off security at `risk=high`; merges; approves changes to rules, permissions, skills |
| 2 AI interface | The conversation | `/work` and the per-kind commands (built on `/start` + `/run`): understands the objective, asks for missing requirements, writes the work record, explains the selected route, presents findings, blockers and approvals. Not an execution authority |
| 3 Controller `lane.js` | Routing and enforcement | JavaScript with checked types, Node 20+, no build step. Validates work records; reads `work_type / domain / risk / size`; selects the profile from the version-controlled table; names the agent allowed per stage; enforces worktree and file ownership, budgets, retries, pause and stop; records evidence; derives state from files, git, CI and telemetry. Agents recommend classifications; the controller validates. No agent redefines the lifecycle |
| 4 Agents, skills, tools | Bounded work | Agents work from structured assignments and return defined outputs; skills carry procedures; tools give controlled access. None grants itself authority |
| 5 Enforcement | Verification | Sandbox, scope, permissions, architecture and design lint, tests, CI, security, evidence validation, independent review, audit log, stop and recovery. Never depends on an agent's claim |

## 2.1 Controller topology
The controller has two sides. **Host side** (`lane.js` run by the human's session or a schedule, outside any sandbox): creates the worktree, provisions the lane database (§8), starts the lane as a headless Claude Code session inside the sandbox, holds the only copies of host-level secrets (second-family key, database-branch API key, signing keys), spawns the second reviewer in its own sandbox, records the sandbox runtime, enforces `max_concurrent_lanes`, runs `lane stop` / `lane resume`. **In-lane side** (the same script, called by hooks and `next-step` inside the sandbox): derives state, validates transitions, enforces budgets, writes evidence and the work record; cannot read host secrets. The human's interactive session is Layer 2 only: commands, inbox, approvals, `/teach`. Implementation never runs in it; a lane cannot inherit its permissions, and it reads lane output only through files the controller validates.

# 3. Agents, skills, tools

**Agents.** Core: researcher, planner, critic, tester, implementer, reviewer, retro. Specialists: **debugger** (read-only: reproduces, localizes, bisects where a good commit exists, writes the failing test; never fixes), **skill-smith** (drafts a skill package on a kit branch; never installs). No department-manager agents; departments are profiles and skill collections. A new agent requires a demonstrated capability gap needing different permissions or inputs; a domain alone is a skill.

**Delegation.** Depth is fixed: human → controller → agent → (researcher). Only the planner delegates, only to researchers; researchers cannot delegate; every other assignment is made by the controller. Width is a number per profile and size, validated by the controller, capped by `max_researchers` in the floor:

| Profile and size | Researchers |
|---|---|
| any profile with a research stage, size S | exactly 1 |
| `/new-feature`, `/architecture`, `/migrate`, `/security`, `/new-skill`, `/investigate`, size M | up to 3 |
| the same, size L | up to 6 |
| `/onboard` discovery, `/investigate` size L | up to 8 |
| hard maximum (`floor.json: max_researchers`) | 8; a project may lower it, never raise it |

`max_concurrent_lanes` in `kit.json` (default 3); further lane requests queue. Agents never message each other; handoff is agent → file → controller → next agent.

**Skills.** Two kinds: **domain** (wallet, ui, database…) and **workflow** (how a kind of work is done here: what it forgets, what done looks like, what the reviewer checks). Source: `kit/skills/domains/<name>/`, `kit/skills/workflows/<kind>/`, each `SKILL.md` + `references/` + optional `scripts/`. Every agent in a lane loads the workflow skill for the lane's kind plus the domain skills for its domains, and reads the section for its own station; no single agent holds all of it. Every workflow skill has a `criteria` section (the gradable statements the reviewer scores; the implementer reads the same section) and calibration examples (one passing, one failing case per criterion) in `references/`. Deployment: `/bootstrap` copies the needed skills into the project's `.claude/skills/`, pinned to the kit version, hashed by `guards-present`; Claude Code discovers skills there and nowhere else. Planted faults live in `planted-faults/`, eval tasks in `kit/eval/`; a skill never contains its own answers. CI rejects a skill without a fault, an eval set, or (workflow) a `criteria` section. New skills go through `/new-skill` (§4).

**Tools.** Every kit tool and MCP server an agent can call has a description that is itself under test: the eval set (§14) includes tool-selection tasks, and a tool that agents misuse in eval is fixed before the agent prompt is. Tool descriptions receive the same review as agent instructions; a tool change touching agents' choices runs the smoke set.

**Context.** Agents load context just-in-time from file paths named in the assignment (`CLAUDE.md`, the spec, `model.yaml`, `system.yaml`, `docs/context/`, the skills for the lane), not as a dump. Every stage is resumable from the work record alone: on context pressure, provider failure or `lane resume`, the controller restarts the agent from files, never from a transcript; the restarted agent's first act is reading the progress file. Agents keep structured notes in the work record as they go, so a restart loses nothing a file does not hold.

**Project entry point.** `/bootstrap` writes a short `CLAUDE.md` in the project root that points at `architecture/model.yaml`, `design/system.yaml`, `docs/context/`, the rules and the deployed skills, and states the lane conventions. It is regenerated on `/bootstrap --upgrade`; hand edits go in a marked block that upgrades preserve. Every lane session reads it first.

# 4. Workflows

Routing is a version-controlled table, `kit/workflows/<kind>.json`, keyed by `work_type`; `domain` selects domain skills; `risk` adds stages; `size` sets effort. Each profile lists stages, allowed agents per stage, prerequisites, artifacts, validations, approvals, budgets, failure and escalation conditions. The controller refuses a goal with no profile and refuses to spawn an agent the stage does not list. Each profile ships with its command, workflow skill, planted fault and eval tasks.

| Work type | Command | Required process |
|---|---|---|
| investigation | `/investigate` | inspect → research → report |
| documentation | `/docs` | inspect → edit → validate content, links, examples |
| fix | `/fix` | reproduce (debugger) → tests → implement → verify → review |
| feature | `/new-feature` | understand → research → plan → critique → **approve** → tests → implement → verify → review → **merge** → retro |
| ui | `/ui` | inspect → design evaluation → implement → visual and accessibility verification → review |
| refactor | `/refactor` | dependency analysis → plan (one caller per criterion) → tests → implement incrementally → verify |
| security | `/security` | assess → contain → investigate → remediate → verify → **security sign-off** |
| architecture | `/architecture` | research → propose → critique → **human approval** → implement → verify |
| migration | `/migrate` | impact analysis → plan → **approval** → backup → execute → verify → restore validation |
| incident | `/incident` | triage → contain → diagnose → recover → verify → retrospective |
| skill-development | `/new-skill` (also opened by the controller on a retro gap) | gap → research → draft (skill-smith) → review → eval → **approval** → release |

`skill-development` changes the system itself, so it is as visible as any other kind: command, profile, workflow skill, fault, eval tasks, inbox row, audit line; it never completes without the human approval row.

**Router.** `/work <objective>` asks at most one question if the words are ambiguous, otherwise routes provisionally to `fix`; the debugger's evidence settles the kind (one reproducible cause stays `fix`; boot failure or a non-running suite becomes `incident`; a design fault becomes `refactor` with a spec). The user never classifies.

**Risk.** `risk=high` adds to any profile: threat model (required by validation), second reviewer on a different model family (§10), human security sign-off separate from merge, feature flag default-off, canary, verified rollback runbook, container sandbox (§11). `risk=high` is refused while the sandbox is `degraded`, and refused outright until roadmap step 10 closes; it is never downgraded.

**Size.** `size` ∈ {S, M, L} scales effort; it never removes a stage `risk` added. Exactly two things are size-gated: research **width** and whether the **critic** runs. Everything else the profile lists runs at every size. `/ui` at L takes the feature shape (adds research, plan, critique, approval); `/fix` and `/docs` do not grow at L. A whole-product redesign is a design-model amendment: `/architecture` with the `ui` domain, then several `/ui` lanes.

Size is derived twice and may only rise. *Provisional*, at `/start`, from the goal's scope declaration (domains; interface, schema or data change expected; new dependency expected); a goal without one is M. *Confirmed*, from the first artifact that states real scope (spec; debugger report in `/fix`; inspection in `/ui`, `/docs`; research report in `/investigate`). A rise re-opens what the lower size skipped before approval. The human may force size up, never below the derived minimum.

| Signal in declared scope / first scope artifact | Size at least |
|---|---|
| one domain, no interface/schema/data change, no new dependency, no `[unknown]` | S |
| two domains, or one interface/schema/data change, or a new dependency | M |
| three or more domains, or interface/schema/data change with a new dependency, or `[unknown]` left after research | L |

| | S | M | L |
|---|---|---|---|
| researchers in a research stage | 1 | up to 3 | up to 6 (8 for `/onboard`, `/investigate`) |
| critic | skipped | runs | runs |
| review cycles | 1 | 3 | 3 |

File count is not a size signal; a one-line change across thirty-three declared files is one domain, S. File count is a tripwire: an edit outside the declared scope is blocked by the hook, escalates, and the lane is re-sized from the new scope.

**State** is derived from files, never asserted:

| State | Evidence |
|---|---|
| draft | goal file, no spec |
| validated | spec, validation passed, no approval line |
| approved | approval line |
| executing | worktree, progress file, no review |
| testing | red runs recorded, green incomplete |
| reviewing | review report for HEAD, CI pending |
| accepted | review all PASS, CI green, merged |
| blocked | escalation section, or budget exceeded |
| stopped | stop flag |
| rejected | roadmap row set by human |

A lane also carries a sandbox state, `contained` (with its runtime) or `degraded`, derived at start; not a lifecycle state.

# 5. Onboarding (`/onboard`, built on `/bootstrap`)

1. **Discovery, read-only.** Structure, languages, dependencies, entry points, flows, APIs, schemas, infrastructure, deployment, tests, docs, git history, existing rules and CI. Baseline audit: secrets in history, dependency vulnerabilities, coverage, mutation. Deliverable: `docs/MAP.json`, `MAP.md`.
2. **Product understanding.** Purpose, users, requirements, workflows, constraints; unverified assumptions become questions to the human. Deliverable: `docs/goals/PROJECT.md`, agreed.
3. **Engineering assessment.** Every finding: evidence, location, severity, reasoning, confidence, action, tagged verified / inferred / unknown. Recommendations are advisory; an inferred finding never decides a spec.
4. **Research and expertise.** Missing knowledge researched; missing skills via `/new-skill`.
5. **Architecture and design models.** Draft `architecture/model.yaml` from the observed map and `design/system.yaml` from the observed stylesheet and components; the critic challenges; the human approves. Drift between declared and observed becomes CI with a known-debt allowlist that may only shrink.
6. **Configuration.** Rules, decisions, deployed skills, agent permissions, test standards, security floor, CI, `db.lane_adapter`, DR runbook, `CLAUDE.md`. Existing CI checks kept and made required. Ratchets, not cliffs: floors equal today's number and only rise.

**Adopt, never duplicate.** `/bootstrap` and `/onboard` are idempotent: a file or folder that exists is adopted, never overwritten or recreated. If the project already has a convention the kit also needs (ADRs in `docs/adr/`, an existing `ARCHITECTURE.md`, a design-tokens file), `MAP.json` records it and `kit.json paths.*` maps the kit's artifacts onto it; no second copy is created. Planted fault: bootstrap on a repo that already has a decisions folder creates no second one and writes new decisions into the existing one.

**Greenfield.** A project with no code has nothing to observe, so its first lane is `/architecture`: the planner proposes `model.yaml` and `system.yaml` from `docs/goals/PROJECT.md`, starting from the kit's default shape (§7); the critic challenges; the human approves. No feature lane opens before that approval.

# 6. Recovery (`/recover`)

Verified gap list → prioritized by severity, dependency, risk, business impact → roadmap → **human approval** → lanes. Safety-net lanes first: suite green in CI, characterization tests on hot paths, secrets rotated. Each task carries objective, scope, dependencies, components, acceptance criteria, risk, tests, rollback. The controller blocks scope expansion.

# 7. Architecture and design governance

**Architecture.** `architecture/model.yaml` is the source of truth; `ARCHITECTURE.md` points at it. Before implementing, an agent reads map and model, identifies callers and the extension point, checks overlapping work and conventions. No framework, abstraction, dependency or pattern for convenience. A change is an amendment requiring approval. Enforcement: boundaries lint reads `model.yaml`; drift check compares it to `MAP.json`.

`model.yaml` declares, per component: the paths it owns, its public entry point, the components it may import, the third-party libraries it may use, its invariants, and its owner. The lint fails an import that reaches past another component's entry point, an edge the model does not allow, and a library used outside the components allowed to use it (a crypto library imported under `admin/` fails even with no internal import crossing).

**Default shape** (the kit's starting `model.yaml`; a project may adopt a simpler one through `/architecture` with a stated reason): domain-first, layer second. Top level is business capability (`wallet/`, `payments/`, `accounts/`, `admin/`), each owning its own UI, API and data code; cross-cutting code (auth, crypto primitives, design system, logging) lives in `platform/`, the only component every domain may import; domains import each other only through declared contracts; `platform` never imports a domain; every component has an owner. An existing repo keeps its observed shape; moving toward the default happens only through approved `/architecture` amendments executed as `/refactor` lanes. The kit never reorganizes a codebase on its own.

**Design.** `design/system.yaml` is governed the same way: tokens, components with variants and states, layout, motion, accessibility (WCAG 2.1 AA minimum), and the grading criteria for `ui` review. `DESIGN.md` points at it. Loaded by the `ui` domain skill before the spec. Enforcement: design lint rejects hardcoded values that have a token and components outside the declared set; drift compares declared tokens and components to the stylesheet and component directory, allowlist shrinks only. Change only via `/architecture` with the `ui` domain. An external design tool (Figma or similar) is recorded as a source with its exported tokens; it is never the model. A project without a design gets the kit's default system.

# 8. Isolated execution

One worktree and branch per lane. Before start: git status, existing worktrees, open PRs touching the same files, file ownership, shared services, ports. Each lane gets its own ports and a throwaway database of the project's own kind, by the adapter in `kit.json db.lane_adapter`:

| Adapter | When | Lane gets |
|---|---|---|
| `local` | Postgres, MySQL, Mongo, SQLite | local instance in the sandbox, migrations applied, fixtures seeded, destroyed at close |
| `emulator` | platforms with an official emulator (Supabase CLI, Firebase, DynamoDB Local, Azurite) | the emulator per lane, no cloud call |
| `branch` | providers with branching (Neon, PlanetScale, Supabase) | a branch from staging, credential scoped to the branch and expiring with the lane; the provider API key stays on the host side |
| `none` | nothing above applies | unit tests with the data layer mocked; integration tests only in CI against a staging copy; work record carries `db: shared-staging` |

Production credentials never enter a lane. Read-only work runs concurrently; conflicting edits are refused by the planner's overlap check. No agent works on protected `main`.

**Lane artifacts** live in one place, created by the controller at `/start` and never anywhere else: `docs/work/<lane>/` with `goal.md`, `research/` (one file per researcher), `spec.md`, `progress.md`, `evidence/`, `review.md`, `escalations.md`; threat models in `docs/threat-models/<lane>.md`. Each file is written only by the controller or by the agent whose stage owns it. A validator refuses a lane artifact outside this tree and refuses product code inside it. The root is configurable through `kit.json paths.work` so an existing convention can be adopted (§5), but there is exactly one root. On merge, `spec.md`, `review.md` and the evidence index are kept; research and progress are archived under `docs/work/_archive/<lane>/` by the controller.

# 9. Evidence

Runtime changes: reproduce or establish pre-change behavior → define expected behavior → write the test → show it fails for the expected reason → implement → run again → regression → preserve results. Documentation: validate content, links, examples. UI: screenshots and accessibility checks. Performance: measurements. Evidence records commit, environment, commands, output, results. Agent-asserted evidence (annotations, recordings) is a review aid, never a gate.

# 10. Independent review

Two evaluations, both must PASS; functional cannot compensate for engineering. **Functional:** requirements, acceptance criteria, outputs, edge cases, regression, integration. **Engineering:** architecture and design compliance, security, maintainability, code quality, reliability, performance, scalability appropriate to the project, testability, dependency choices, documentation, scope.

The reviewer inspects changes and evidence, never the implementer's conversation, and grades against the workflow skill's `criteria`, returning a per-criterion verdict each cycle. Cycles: 1 at S, 3 at M and L, then escalation. Tests are never weakened and limits never raised to reach PASS.

**The reviewer operates the product.** For any lane with the `ui` domain or a spec declaring user-visible change, the reviewer runs the application in the lane's sandbox (Playwright or the project's equivalent), exercises the changed surfaces and states, and records its own screenshots and accessibility results; those are the gate, the implementer's are an aid. For other lanes the reviewer re-runs the suite and any smoke script the spec names; the implementer's recorded run is evidence it saw green, the reviewer's run is the gate.

**Second reviewer at `risk=high`.** A different model family, named as `second_family` in `floor.json` (a project may substitute another family, never the primary). Spawned by the host side in its own sandbox, read-only on diff, evidence and spec, with the security checklist. Repeated provider errors pause the lane with an escalation; no fallback to the primary family; the sign-off row stays empty until the human records `second-family: waived` with a reason (an audit line) or the reviewer completes. The human security sign-off line in the review report is distinct from the merge.

# 11. Security

1. **Sandbox (hard layer).** Each lane runs inside an OS-enforced boundary: only its worktree and a scratch directory writable; credential locations unreadable (`~/.ssh`, `~/.aws`, `~/.config/gh`, the project's `.env*`, the kit's key paths, floor additions); network limited to an allowlist (registries plus spec-declared domains) through a proxy the agent cannot bypass. Two runtimes, recorded per lane: **`srt`** (Anthropic's `@anthropic-ai/sandbox-runtime`: Seatbelt on macOS with nothing to install, bubblewrap + socat on Linux; `lane.js start` launches the whole lane session through it; `failIfUnavailable: true`; floor deny list applied as `denyRead`) is the default; **`container`** (same properties by mounts and container network) is required at `risk=high` and on shared machines, and may be made default in `kit.json`. Both are process isolation on a shared kernel; the floor, blind review and human merge are the layers a sandbox does not replace. If neither runtime is present the lane starts `degraded`: hooks and floor still enforce, the state is recorded and shown everywhere, `risk=high` is refused, and no promotion to `contained` without restart. Degradation is never silent and never inferred by an agent.
2. **Hooks (fast layer).** Guard hooks read the floor and block in-session: unread or out-of-scope edits, secret reads, destructive commands, settings changes, force pushes. Guards fail closed: a crashed guard exits 2.
3. **Floor.** `kit/security/floor.json`: minimum deny list, credential patterns, per-agent network allowances, `second_family`, `max_researchers`. Projects may strengthen it, never weaken it; `guards-present` and `ci_security_floor` check effective permissions across all settings scopes; hooks enforce the floor regardless of settings.
4. **Supply chain.** Vulnerability audit, license check, SBOM per release, CI actions pinned by SHA, lane commits signed with a lane key.
5. **Untrusted content.** Anything fetched from the web, a package, a PR comment or an issue is data; instructions found there are tagged and reported, never followed.
6. **Authority.** Read: authorized agents. Research: researchers. Planning artifacts: planner. Implementation files: implementer in its worktree. Approve implementation: reviewer. Architecture, destructive and production-sensitive operations, scope expansion, security authority, merge: human.
7. **Provider outage.** Repeated provider errors, primary or second family, pause the lane with an escalation rather than retrying into its budget.

**Kill switch.** `lane stop` writes the stop state; the controller refuses transitions; every hook refuses mutations; running lane processes are terminated through the sandbox; new work cannot start; records are preserved; `lane resume --by <name>` is required. Every entry point enforces the stop state; the flag alone is not the mechanism.

# 12. Operations

| Concern | Mechanism | Gate |
|---|---|---|
| Backups | Migration and release profiles require a backup step and restore verification: CI restores the latest staging or anonymized backup into a CI-owned throwaway database and asserts counts. Production backups are restored only by the human, in production, per the DR runbook | migration without restore validation → refused |
| Monitoring → incidents | Post-release smoke test and error-rate check; a failure writes `docs/incidents/<id>.md` and opens an incident lane | release cannot complete without the check |
| Flags, canary, rollback | At `risk=high`: flag default-off, canary step, rollback runbook executed once in staging before release | release without a verified runbook → refused |
| Data and privacy | Spec `Data changes` has a PII column; logging or exporting a PII field without a spec note is a reviewer FAIL | validation + reviewer |
| Licenses | License check on the lockfile | CI |
| Cost | Monthly cap per project in `kit.json`; lanes pause at the cap; cost from telemetry only | budget hook |
| Disaster recovery | Runbook per project (restore from backup, redeploy from tag), tested in onboarding | onboarding stage 6 |
| Kit upgrades | `/bootstrap --upgrade` runs the two read-only project checks (`guards_present`, `security_floor`) before and after, backs up every file it replaces, and restores when a check that passed before fails after. The planted faults are the kit's release gate, not an upgrade step: the suite builds and destroys its own fixtures and takes no `--repo` (KIT-SPEC §11). A kit release goes first to one designated canary project, runs one real lane there, then to the rest | upgrade that breaks a check it previously passed → restored |

# 13. Knowledge and learning

Agents communicate through structured work records and approved files, never shared conversations. Every assignment has objective, inputs, scope, permissions, dependencies, output, acceptance criteria, budget, owner. Knowledge is files: `CLAUDE.md`, `docs/goals/`, `architecture/model.yaml`, `design/system.yaml`, `docs/MAP.*`, `docs/context/` (data sources, systems, glossary, owners, tagged `[human]`), rules, decisions, research, specs, skills and versions, evidence, reviews, escalations, git and CI state.

**The system is forbidden to guess.** When neither code nor research can answer, the researcher writes `[unknown]` with "resolve by: ask human"; it appears in the inbox; the human answers once with `/teach`; the controller writes it to `docs/context/`; it is never asked again. Conflicting findings go to the inbox, never silently reconciled.

**Learning.** Retro analyzes failed executions, CI failures, review findings, the human's review comments and approve-notes, repeated problems, rework, workflow inefficiencies, skill deficiencies and successful practices, and proposes changes to skills, agent instructions, tool descriptions, workflows, rules, checks and documentation. Every lesson names its enforcement (hook, lint, test, CI) or is listed as text-only debt; a text-only lesson that recurs is promoted to an enforcement proposal. Improvements are reviewed, evaluated (§14) and versioned. The system cannot weaken security rules, grant itself privileges or modify its own authority.

# 14. Evaluation (release gate)

`kit/eval/`: harness, metrics, benchmark tasks per role, per workflow kind and per tool, baselines per kit version. Tasks are files, starting near thirty (planted-fault repo plus one real project), growing without redesign. Each task carries its **rubric**; an LLM judge grades the end state against it, and a sampled set of transcripts per full run is read by the human, so the judge is itself checked.

- **Smoke set**, on every kit PR touching agents, skills, templates, tool descriptions or the workflow table: one task per core role plus one per workflow kind whose files the PR touches, N=1. A failed task or a hard-metric violation (security, architecture, fabricated evidence, skipped red run) blocks the PR. Catches breakage, not drift.
- **Full set**, nightly (weekly when the cost cap would be reached, recorded in the audit log): all tasks, N=3. A regression is a mean drop beyond the baseline's variance and **blocks the release**; a kit version is not tagged until the full set has run on its final commit.

Measured: task completion, defect escape rate, reopened tasks, architecture and design violations, security violations, test reliability, review effectiveness (FAILs found by reviewer vs. CI vs. human), tool-selection accuracy, rework and retries, execution time, tool calls, cost, workflow failures, human escalations. Telemetry is OpenTelemetry export; `.events.jsonl` is the hook-level log; cost is never estimated from it; the eval's own cost counts toward the project cap.

# 15. Dashboard and commands

**Dashboard.** Stage 1, read-only: overview, work, workflows, agents, skills, architecture and design drift, quality, security (sandbox state per lane), CI/CD, approvals inbox ordered by cost of delay, recovery roadmap, knowledge, performance and cost from telemetry, audit. Stage 2: reprioritize, pause, resume, kill switch, each with confirmation and an audit line. Approve and merge stay human actions outside the page. Every number traces to a file, telemetry or a command. The hierarchy shown is a responsibility map, not a chain of AI managers.

**Commands.** Per kind: `/new-feature`, `/fix`, `/refactor`, `/migrate`, `/incident`, `/ui`, `/security`, `/docs`, `/architecture`, `/investigate`, `/new-skill`. Router: `/work`. Project: `/onboard`, `/recover`, `/teach`, `/status`, `/dashboard`, `/agents`, `/skills`. Stage access: `/research`, `/plan`, `/implement`, `/test`, `/debug`, `/review`, `/retro`, `/eval`. Direct invocation never bypasses the controller. Automatic: investigation, research, assignment, planning, critique, authorized implementation, testing, review, CI. Human: architecture and design changes, production-sensitive and destructive operations, scope expansion, recovery roadmap, security authority and sign-off at high risk, final merge, lessons, new skills.

# 16. Roadmap

Each step: KIT-SPEC amendment → decision file → planted fault → code → kit CI green (script tests, planted faults, eval) → release. A step starts when the previous step's check passes.

| # | Step | Closed by |
|---|---|---|
| 0 | Housekeeping: VERSION 0.2.0, changelog, decision 0007, adopt this document; tag `v0.2.0` after merge via `release.sh`. Python-emulation helpers stay until each has a tested native replacement (decision 0007). **In progress** | kit CI green at tag |
| 1 | Port kit scripts to JavaScript. **Done** (PR #10, #11) | 19/19 faults; 135 tests; Node-only install |
| 2 | Hard floor: host-side launcher, lanes as headless sessions under `srt` (container optional, `degraded` fallback), floor as `denyRead` and allowlist, runtime guards, effective-permission check, branch protection, per-lane ports, `db.lane_adapter` set by `/bootstrap`, provider-outage pause, generated `CLAUDE.md`, idempotent bootstrap, lane artifact tree and validator, resumable stages from the work record | undeclared domain → refused in `srt` and container; `.env` read → blocked by hook and sandbox; loosened deny list → CI fail; no runtime → `degraded`; credential-pattern value readable → refused; agent restarted mid-stage resumes from files; bootstrap on a repo with an existing decisions folder creates no second one; research file outside `docs/work/<lane>/research/` → refused |
| 3 | Telemetry: OpenTelemetry export and collector; cost from it only | dashboard cost equals exporter; exporter off → flagged |
| 4 | CI stages 1–3, merge queue, owner approval on CI files | planted faults 2, 3, 5, 8, 9 caught |
| 5 | One real feature on HYA or Basic, no new code | merged with two human actions; lessons written |
| 6 | Eval harness as release gate: rubric per task, LLM judge, human transcript sample, tool-selection tasks, smoke per PR, full nightly, baseline committed | prompt edit skipping the red run blocks the PR (smoke); seeded quality drop blocks the tag (full); misleading tool description → tool-selection task fails |
| 7 | Workflow table, per-kind commands, workflow skills with `criteria`, `debugger.md`, work records with scope declaration, state mapping, provisional/confirmed `size`, width caps, kill switch | unknown work_type refused; unlisted agent refused; stop blocks live mutations; `/work` routes a symptom; two-domain goal as S refused; fourth researcher at M refused; undeclared-file edit re-sizes; confirmed size above provisional reaching approval without critic refused; skill without `criteria` → CI fail |
| **MVS** | **Minimum viable safety.** Steps 0–7 closed: complete for daily use at `risk ≤ medium`. Work may stop here indefinitely; steps 8–16 extend reach and are not preconditions for safe use | tag `1.0.0-mvs`; KIT-SPEC acceptance for `risk ≤ medium` on one real repo |
| 8 | Skill-smith, domain skills with deployment, manifest, schema, `/teach` and context, `/new-skill`, driving review | skill without fault → CI fail; `/bootstrap --upgrade` installs; eval unchanged or better; `/new-skill` release without approval row → refused; `ui` review without reviewer screenshots → refused |
| 9 | Architecture and design models with the kit default shapes (domain-first `model.yaml`, default design system), per-component entry points, allowed libraries and owners, code map, drift with allowlists | undeclared cross-boundary import → CI fail; import past a component's entry point → CI fail; crypto library under `admin/` → CI fail; hardcoded value with existing token → CI fail; undeclared component → CI fail |
| 10 | Security stage at high risk: threat model, second family, sign-off, container requirement, SBOM, pinned actions, signed commits, injected-instruction fault | high-risk spec without threat model → refused at any size; second family unavailable and unwaived → merge blocked; second family resolving to primary → refused; `risk=high` on `srt` → refused |
| 11 | Operations (§12) including canary project for kit upgrades | migration without restore validation → refused; release without runbook → refused; kit release skipping the canary project → refused |
| 12 | `/onboard` and `/recover`, greenfield rule | messy repo: no code change before roadmap approval; drift at zero after onboarding; empty repo: feature lane refused until `/architecture` approval |
| 13 | CI stages 4–7: e2e, performance budgets, security scanning and fuzzing on signing code, mutation gate | per-stage planted faults |
| 14 | Dashboard stage 1, then 2 | every number traces; audit line per action |
| 15 | Learning loop, nightly consolidation, upgrade lanes, skill gap end to end | recurring text-only lesson promoted; one skill produced via `/new-skill` from a retro gap |
| 16 | Second stack and acceptance | KIT-SPEC §10 criteria on two unrelated repos |

# 17. How we know nothing breaks

1. Nothing is built before it is specified: KIT-SPEC amendment and decision file first; the code PR cites them.
2. Every gate ships with the fault that proves it; a release where any fault is no longer caught is blocked.
3. Every script has tests; kit CI runs them on Node 20 and 22.
4. Every agent, skill or tool change is measured by the eval against a committed baseline; a regression blocks the release.
5. Projects upgrade with a safety net and a canary project.
6. Guards fail closed.
7. Lanes cannot reach what they must not; an absent sandbox is declared, never pretended.
8. One real feature (step 5) and one messy repo (step 12) are mandatory checkpoints: tests prove the scripts, real runs prove the system.
9. The MVS line is a complete system, not a partial one.
10. Effort and safety are separate dials: `size` can make a lane cheaper, only `risk` can make it less guarded, and `risk` is never lowered by `size`; width has a ceiling, depth has no dial.
11. The judge uses the product, against criteria the builder also saw.
12. A stage restarted from files produces the same result as one that never stopped.

# 18. Non-negotiable constraints

1. No autonomous AI management hierarchy. 2. No dynamically invented workflows. 3. No delegation beyond planner → researcher; width capped by §3 and the floor, depth never deeper. 4. No implementation without explicit scope. 5. No unauthorized architecture or design changes. 6. No self-approval. 7. No fabricated evidence. 8. No bypassing CI, sandbox or enforcement. 9. No privilege escalation. 10. No uncontrolled retries or spend. 11. No work on protected `main`. 12. No completion claim without independently verifiable results. 13. No kit release that lowers the eval baseline. 14. No cost figure that is not from telemetry.

# 19. Operating principle

One engineering system. Specialized intelligence. Deterministic execution. Independent verification. Human authority. Operable software. The system must not become more complicated because it can support more agents; its success is software that works, is professionally engineered, preserves approved architecture and design, can be operated and recovered, and can be maintained safely over time.

# Appendix A. Completeness

| Area | Where | Status |
|---|---|---|
| Understand before change; purpose; assessment | §5 | covered |
| Architecture and design declared vs observed, drift | §5.5, §7 | covered |
| Routing, state, per-kind commands, workflow skills, router | §4 | covered |
| Risk and size as separate dials | §4 | covered |
| Agents; depth fixed, width capped; concurrent lanes | §3 | covered |
| Skills: source, deployment, isolation, criteria, creation | §3, §4 | covered |
| Tool design under test | §3, §14 | covered |
| Context: just-in-time loading, notes, resumable stages | §3 | covered |
| Project entry point `CLAUDE.md` | §3, §5.6 | covered |
| Controller topology, where secrets live | §2.1 | covered |
| Human knowledge channel | §13 | covered |
| Isolation: git, ports, DB adapters; lane artifact tree | §8 | covered |
| Adopt existing conventions, never duplicate; greenfield | §5 | covered |
| Default domain-first shape, entry points, allowed libraries, owners | §7 | covered |
| Sandbox runtimes, degraded mode, floor, fail-closed guards | §11 | covered |
| Evidence; independent review; reviewer operates the product | §9, §10 | covered |
| Second reviewer: provider, credentials, outage, waiver | §10 | covered |
| Supply chain, untrusted content, kill switch, provider outage | §11 | covered |
| Backups and PII, monitoring, flags/canary/rollback, licenses, cost, DR | §12 | covered |
| Kit upgrade safety net and canary project | §12 | covered |
| Learning with enforcement | §13 | covered |
| Eval as release gate; rubric judge; human sampling; cost and cadence | §14 | covered |
| Dashboard from derived state | §15 | covered |
| Named stopping point (MVS) | §16 | covered |
| Multi-user roles beyond one owner | — | **not covered**; revisit if a team joins |
| On-call and SLOs for the product | — | **not covered**; incident workflow is the substitute |
