# Changelog

All notable changes to the kit. Each entry names the decision or lesson that caused it.

## [Unreleased]

### Added
- KIT-SPEC §10.9–10.11 and planted faults 20–27: the step 2 amendment (sandbox with `srt` default and container at high risk, `degraded` state, security floor, host-side/in-lane controller, lane database adapters, lane artifact tree, idempotent bootstrap, resumable stages). Spec only; the code lands in the step 2 PR after `v0.2.0`.
- Decisions 0008 (sandbox is the hard boundary) and 0009 (lane database adapter).
- Step 2c, adopt and configure: `bootstrap` detects the project's database from dependencies and config (Supabase/Firebase/DynamoDB → `emulator`; Neon/PlanetScale → `branch`; Postgres/MySQL/MongoDB/SQLite, Prisma provider or compose image → `local`; nothing → `none`, and a question is asked) and records `kit.json db.lane_adapter`; an existing ADR convention (`docs/adr`, `adr`, `doc/adr`, …) is adopted with its own numbering and recorded as `kit.json paths.decisions`, so no second decisions folder is created and a re-run writes nothing new; `kit.json paths.work` names the lane artifact root (today `docs/specs`). `CLAUDE.md` gains a kit block between `<!-- kit:begin -->` / `<!-- kit:end -->` that `--upgrade` regenerates from `kit.json` while leaving the human's text byte for byte; a `CLAUDE.md` without markers keeps the old behaviour (version stamp only). Planted fault 26 (25/25); 5 tests (204 total).
- Step 2b, the sandbox: `kit/scripts/sandbox.js` detects the runtime (`srt` on PATH or in the kit, else a working docker/podman, else none; `KIT_SANDBOX_RUNTIME` overrides), builds a lane's configuration from the floor and the spec's optional `## Network` section (writes: worktree + scratch; `denyRead`: floor credential paths; `allowedDomains`: floor defaults + spec + per-agent; `failIfUnavailable`), scans the worktree for credential-looking content (line-based; `kit:allow-secret` marks a reviewed fixture), and forms the host-side launch command. `lane.js start` records `sandbox: {runtime, state}` and `risk` in `lane.json`, writes `.claude/session/sandbox.json`, logs a `sandbox` event, runs the lane `degraded` (loudly) when no runtime exists, refuses a high-risk lane without the container runtime unless `kit.json sandbox.high_risk_waiver {by, reason}` is set (recorded on the lane and as a `waiver` event), and refuses a lane that could read credential-looking content, removing the worktree it just created. New `lane.js launch <slug> [--exec]` (host side) prints or runs the sandboxed headless-session command and refuses a runtime change mid-lane. `max_concurrent_lanes` is the spec's name for `wip_limit`. `kit_status` reports each lane's sandbox state. Planted faults 20, 23, 24 (24/24); 10 tests (199 total).
- Step 2a, the security floor: `kit/security/floor.json` (deny list, secret path patterns, credential content patterns, network allowances, `second_family`, `max_researchers`). `guard-read` and `guard-bash` read it directly, so a loosened `settings.json` removes nothing; projects add through `kit.json secret_patterns`. `bootstrap` writes the floor's deny list into every project. New `ci_security_floor.js` reads every settings scope (managed, user, project, project-local) and fails on a missing floor entry, an allow that grants a floor-denied rule, `disableAllHooks`, or a `floor` key in `kit.json`; wired into the project CI template after `guards-present`. Planted faults 21 and 22; 6 tests (189 total).

## [0.2.0] - 2026-11-10

### Added
- `docs/OPERATING-MODEL.md` (Version 4.1): the operating model the kit is built toward; roadmap in its §16, step 0 is this release. Supersedes the phase table in `docs/implementation-plan.md` as the current plan.
- Decision 0007: the kit stays plain JavaScript with JSDoc types checked file by file; Node is the only runtime; the Python-emulation helpers remain until each has a tested native replacement.

### Changed
- `VERSION` 0.1.0 → 0.2.0, matching the approved KIT-SPEC version; `kit/architecture.json` regenerated for the new version (no other change).

### Fixed
- `bootstrap.test.js` pinned the literal `agent-kit 0.1.0`; it now reads `VERSION`, so a version bump cannot fail the suite by itself.

### Added
- Architecture Canvas on the dashboard: five views (System, Agents, Pipeline, Dependencies, Activity) over a map derived from the kit's files, with per-project overlays (hooks installed vs kit, lane stages, running agents) and a blast-radius view. Backend: `kit/scripts/arch_manifest.js`, `kit/scripts/arch_live.js`, `GET /api/architecture`, `GET /api/history`; frontend model `kit/dashboard/model.js`. The page has no external loads.
- `kit/manifest.json` (declared purpose of every command, agent, hook, check, script and CI job) and `kit/architecture.json` (committed snapshot of the derived map). Kit CI runs `npm run architecture:check`; `undeclared`, `declared-missing`, `dangling-reference`, `dangling-import`, `agent-name-mismatch`, `stage-mismatch`, `invalid-settings`, `invalid-declaration` and `unguarded-tool` fail the build.
- `npm run architecture`, `architecture:update`, `architecture:check`.
- Tests for `args.js`, `hook_notify.js` and `hook_session_context.js`, which had none (183 tests in total).

### Fixed
- The `retro` agent (Bash and Read tools) and the `spec-critic` agent (Read tool) had no PreToolUse guard of their own, against decision 0005. Found by the new `unguarded-tool` check; both now carry `hook_guard_read.js` (and `hook_guard_bash.js` for `retro`).
- Blocking hooks (`hook_guard_edit`, `hook_guard_read`, `hook_guard_bash`, `hook_guard_tests_only`, `hook_config_guard`) now run through `runGuard`: if one crashes (for example the event log cannot be written) it exits 2 and blocks, instead of exiting 1, which Claude Code treats as "carry on".
- Projects set up by an older kit version keep hooks that point at scripts that no longer exist, so their guards silently do nothing. `ci_guards_present` now names those scripts and says to run `/bootstrap --upgrade`; `install.sh` warns about every registered project in that state (`check_projects.js`). `bootstrap.js --upgrade` migrates such a project (tested).
- `lane.json` or `kit.json` containing `null`, a list or a scalar is treated as empty instead of crashing; an absolute `spec` path in `lane.json` is honoured.
- The test suite no longer writes into the developer's real `~/.claude/kit-projects.json` (each test process gets its own `CLAUDE_HOME`).

### Changed
- The whole kit is now JavaScript (Node 20+, ES modules, no npm dependencies): `kitlib`, `validate_docs`, `lane`, `kit_status`, `bootstrap`, the 12 `hook_*` scripts, the 11 `ci_*` checks, `kit/dashboard/server.js`, `planted-faults/run.js`, `audit/boards.js`, and the test suite (`node:test`, `npm test`). Every script keeps its file name (with `.js`), command-line flags, exit codes, output text and the bytes it writes; each was checked against the Python original on the same inputs before the Python was removed. Entries below that mention `.py` files describe the kit as it was when they were written.
- Hook commands in agents and in the project settings fragment, the kit CI template, `install.sh` (checks for Node 20+), `release.sh`, and the docs now call `node ... .js`.
- Python remains a supported target-project stack (detection, `stacks/python.json`, boundaries and dependency checks); only the kit's own implementation language changed.
- Removed the committed `__pycache__` files.

### Added
- Phase 0: kit specification 0.2.0 approved (docs/KIT-SPEC.md).
- Phase 1a: kit layout, `install.sh` (idempotent, symlink or copy), 11 templates.
- Phase 1b: `validate_docs.py` enforcing provenance tags, citation resolution (working tree or `--commit`), hedge words, spec/review/lesson structure; 32 tests.
- Phase 1c: hook scripts `guard_edit`, `guard_read`, `guard_bash`, `read_log`, `event_log`, `post_edit_check`, `budget_check`, `done_check`, `config_guard`, `notify`, `session_context`; 31 tests.
- Phase 1d: agents `researcher`, `planner`, `spec-critic`, `implementer`, `reviewer`, `retro` with embedded hooks; structural tests.
- Phase 1e: project settings fragment `kit/hooks/settings.project.json`, kit CI (`.github/workflows/kit.yml`), decision 0005.
- Phase 2a: `bootstrap.py` (detect stack, frameworks, tools, CI, folder map, credential files, branch drift; generate the project layer; `--answers`, `--dry-run`, `--detect-only`, `--upgrade` with backup, `--protect` via gh), stack definitions for Node, Python, Go, Rust.
- Phase 2b: project CI template `kit/ci/github.yml` and CI scripts `ci_scope_diff`, `ci_test_count`, `ci_dep_diff`, `ci_claude_md_cap`, `ci_guards_present`, `ci_changed_docs`, `ci_review_report`, `ci_pr_size`; review template gains a `Head:` line so CI can tie a report to a commit.
- Phase 2c: `/bootstrap` command, fixture generator `planted-faults/make_fixtures.py` (node-api, python-service).
- Phase 3a: `lane.py` (precheck, start, stage, wip, roadmap-set, research index lookup/add, finish): worktrees at `../<repo>-lanes/<slug>` on `wt/<slug>`, lane.json, progress skeleton from the spec.
- Phase 3b: `kit_status.py`: derived lane positions, needs-you list, drift, events summary, debt, research staleness; `--all` across projects.
- Phase 3c: commands `/research`, `/plan`, `/implement`, `/review`, `/sync`, `/retro`, `/status`; mechanical end-to-end pipeline test; decision 0006.
- Phase 4: `planted-faults/run.py`: all 19 faults from KIT-SPEC section 10 planted and caught (17 mechanically, 2 via project tool / kit CI); runs in kit CI on every change.
- Phase 6: dashboard. `kit/dashboard/index.html` (self-contained, static via `status.json` or live) and `kit/dashboard/server.py` (stdlib: status recompute on file change, SSE push, per-lane event stream, "open Claude in this worktree" for localhost). `/dashboard` command. Optional GitHub Pages publish job in the project CI template (repository variable `KIT_DASHBOARD_PAGES=true`).
- Bootstrap registers each project in `~/.claude/kit-projects.json` for `/status --all` and the dashboard. Notification config moves to `~/.claude/kit-notify.json`.
- `ci_boundaries_simple.py`: ARCHITECTURE.md-driven import-boundary fallback for projects without dependency-cruiser / import-linter; bootstrap wires it in when no boundaries tool is found.
- `sync.sh` falls back to the local base branch when the repo has no origin.
- `kitlib.review_head_ok`: a review is current when it names HEAD, or HEAD's parent when HEAD only touched the report, lane-owned docs, and tests.

### Closed against the board audit (audit/boards.py, audit/GAPS.md)
- `lane.py unknowns`: the 1–3 / over-3 unknown rule is a script (exit 3 resolve, exit 2 research insufficient), wired into `/plan` and the planner.
- `hook_post_edit_check`: counts the same failure per session and writes the Escalation itself at 3; checks shell edits (`sed -i`, `>`) against the spec allow-list after every Bash call.
- `kit_status`: `merged` derived from git using the lane's recorded start commit; `lane.py merged` verifies in git before marking ROADMAP; `/retro` calls it.
- `ci_mutation_gate.py`: mutation job becomes blocking after `mutation_blocking_after_features` merged features.
- `second_reviewer_model` always written to kit.json; `bootstrap --upgrade --all`; `release.sh`.
- Reviewer row R12 (high-risk change behind a feature flag) required by `validate-docs`.
- `tester` agent with `hook_guard_tests_only`; `/implement` runs it before the implementer; `done-check` has a `test` stage (red runs required).
- Incident intake: `lane.py incident`, `kit/templates/incident.md`, `/retro --incident`.

### Orchestration
- `lane.py next-step <slug>`: the next stage (start, research, plan, approve, lane, test, build, review, wait-merge, retro, escalated, done) decided from files and git; `lane.py next`: next queued feature with an agreed goal under the WIP limit; `lane.py goal-set`.
- `/start`: discussion until the goal is agreed, `docs/goals/<slug>.md`, roadmap row, hand-off. `/run <slug>` loops on `next-step` and stops only at the two human pauses (approve, merge), at an escalation, or at done. `/run --queue` drains the roadmap, lanes in parallel.
- `kit/templates/goal.md`.

### Notes
- Project CI checks out the kit at `ref: main` until the first tagged release; `/bootstrap --upgrade` will switch projects to tags from 1.0.

### Fixed (caught by tests before commit)
- `guard_edit`: always-allowed lane files masked an empty spec allow-list.
- `guard_read`: `.env.example*` was treated as a secret.
- `guard_bash`: `rm -rf ../sibling` escaped the project check when the project lived under `/tmp`.
- Kit's own research file failed `validate_docs` (numbered lines, missing slug/commit/Sources, a hedge word); fixed to the standard agents are held to.
