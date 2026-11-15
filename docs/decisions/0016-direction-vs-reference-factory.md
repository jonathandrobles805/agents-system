# 0016 Direction: the kit against a working reference factory

Date: 2026-11-15 · Status: proposed · Supersedes in part, if accepted: 0015 §1–§4 (see E.4)

## Context

The kit has produced 21 lesson issues in two field runs (#29–#38 from `hello-endpoint`, #39–#49 from `http-robustness`) and four more while 0015 was written (#50–#53) [issue #29–#53, titles and bodies read 2026-11-15]. A cold review of 0015 (summarised in B.3) found that every gate the kit runs locally can be switched off by the agent it gates. This decision compares the kit with a small working system that does the same job, the ZazenCodes "software factory for Claude Code" v2 (and v1), and decides the kit's direction.

**Pins.** Ours: branch `fix/enforcement-layer-repair` at `4ae5520`; no code has changed since `5f6cd62`, so line numbers below hold for both. Theirs: `github.com/zazencodes/zazencodes-season-3` at `94f7ae7` (2026-11-12), folder `src/software-factory-claude-code-v2/` unless a path starts with `v1/` (`src/software-factory-claude-code/`). It was cloned outside this repository.

**Tags.** `[verified: file:line]` was read in this repository at the pin. `[read: path:line]` was read in the reference at its pin. `[issue #N]` is the issue's text on GitHub. `[observed: …]` names a run or a terminal output and where it is recorded. `[cmd]` is a command run for this document, with its result next to it. `[unverified]` has not been checked. Sentences that recommend or judge are analysis and carry no tag.

**License.** The reference is GPLv3 [read: LICENSE:1-2; README.md:163-168]. This document copies no code and no prompt text from it; it describes structure and behaviour in our own words. This repository has no LICENSE file [cmd: `ls` at the repo root lists none]. Whether adopting the reference's *structure* (a transition table, one writer of job state, `VERDICT:`-style first lines, a `## Summary` at the top of each step file) raises any obligation, and what license the kit itself should carry: **needs a human / legal check.** Until then nobody copies text or code from the reference into the kit, and nobody opens its files while writing the kit's replacement code (clean-room practice) [unverified that this is required; that is part of the legal question].

---

## A. Side by side

| | Reference v2 | Ours |
|---|---|---|
| **Pipeline stages** | 11 stored stages: `intake, needs-info, spec, build, gate, review, approve, merging, needs-human, merged, rejected` [read: DESIGN.md:43-45]. A round is build → gate → review [read: .claude/skills/factory/SKILL.md:35-37]. | 11 named stages in `STAGES` [verified: kit/scripts/lane.js:802], mapped per work type through 11 workflow profiles [verified: kit/workflows/ listing; lane.js:966-992]. The position the dashboard shows is *derived* from ROADMAP, spec, progress, review and git [verified: kit/scripts/kit_status.js:189-211; lane.js:1031-1053]. A second, *stored* `stage` in `lane.json` drives budgets and done-check [verified: kitlib.js:430; hook_budget_check.js:59]. |
| **Who writes state; how illegal moves are refused** | One script writes `job.json` [read: factory/bin/job:1-7]. A `TRANSITIONS` table lists legal moves [read: factory/bin/job:41-51]; each move checks the files that justify it (build.md says READY, tree clean, branch pushed, `checks.md` was written for the current commit, every review present) [read: factory/bin/job:420-475]. A per-job file lock serialises writers [read: factory/bin/job:105-116]. Nothing *technically* stops an agent from writing `job.json`: the builder has Bash and no guard hooks [read: .claude/agents/builder.md:4-11]; only its prompt forbids it [read: .claude/agents/builder.md:24-26]. | `lane.js stage <slug> <stage>` writes any stage string with no transition check and no stage-name check, and resets `started` [verified: lane.js:717-729, 1247]. The kit grants every lane `Bash(node "$HOME/.claude/kit/scripts/*)` [verified: kit/hooks/settings.project.json:8], so a lane can call it (#53). Lane records also live in tracked `kit.json` [verified: lane.js:660-663] (#43). The derived position (above) is the stronger half: it is computed, not written. |
| **Where checks run; can a branch edit them** | `gate` runs the *main checkout's* `checks.sh` inside the job's worktree [read: factory/bin/gate:9-12, 55-58] and fails a branch that modifies or deletes a protected path [read: factory/bin/gate:41-52; factory/config.json:20-23]. It runs before review and again after syncing with the base before merge [read: factory/bin/job:611-619]. A branch *can* still change what `checks.sh` runs: its commands are the project's own (`npm test` and similar) run in the worktree [read: factory/checks.sh:4-14], and `package.json` and test config are not protected by default [read: INSTALL.md:73-78]. The code reviewer is the stated defence [read: .claude/agents/reviewer-code.md:51-52]. | In the lane: `post-edit-check` runs tests after edits and writes the evidence log, `done-check` reads that log at Stop [verified: kit/hooks/settings.project.json:24, 37-40]. Both are produced inside the lane and are advisory [verified: docs/KIT-SPEC.md:500-549]. `lane.js check` runs host-side but runs whatever command its caller passes [verified: lane.js:436-449]. In CI: tests, scope-diff, review-report and others [verified: docs/KIT-SPEC.md:265]. CI reads the branch's own spec for scope-diff [verified: kit/scripts/ci_scope_diff.js:14-19] and the branch's own review report for review-report [verified: kit/scripts/ci_review_report.js:19-29]; CODEOWNERS covers `.github/workflows/`, `.claude/`, `CLAUDE.md`, `ARCHITECTURE.md`, not `docs/specs/` or `package.json` [verified: docs/KIT-SPEC.md:274]. So a branch can widen its own scope list and write its own PASS, and CI accepts both. |
| **Merge path** | APPROVE → `job merge`: merge the base into the branch, gate again, push, `gh pr merge` [read: factory/bin/job:595-630]. No human looks at an APPROVEd PR [read: .claude/agents/approver.md:13-15]. ESCALATE → PR marked ready, issue labelled `factory:needs-human` [read: factory/bin/job:490-498]. v1 merged locally with `git merge` and v2 changed that because it broke on a busy main checkout [read: DESIGN.md:99-103; v1/.claude/skills/factory/SKILL.md:166-175]. | A human merges the PR; commands are told never to merge [verified: kit/commands/run.md:28; kit/commands/review.md:28]. Branch protection from `--protect`: required checks, strict, `required_approving_review_count: 0`, `enforce_admins: false` [verified: kit/scripts/bootstrap.js:1395-1398]; merge queue best effort [verified: bootstrap.js:1406-1410]. Then `lane.js merged` [verified: lane.js:1275]. "The human merges" is an instruction, not a rule GitHub enforces: an all-green PR can be merged by anyone holding the owner's login (B.2). |
| **Where the human approves** | Only escalations; approval *is* merging the PR on GitHub [read: README.md:62-64]. Feedback goes back to the builder as a file [read: factory/bin/job:633-642]. | Two pauses in `/run`: approve the spec, merge the PR [verified: kit/commands/run.md:23, 28]. Plus CODEOWNERS paths [verified: docs/KIT-SPEC.md:274] and `lane.js resume-all --by <name>` for the kill switch [verified: docs/KIT-SPEC.md:498]. |
| **Resume after a crash** | `/factory run` reads `factory/jobs/` and resumes each job at its stage; only missing reviews are re-run [read: .claude/skills/factory/SKILL.md:176-183]. | `lane.js next-step` derives the next stage from files and git [verified: lane.js:899-931]; `lane.js resume` prints it [verified: lane.js:707-715]. Equal in kind; ours derives more, theirs stores less. |
| **Parallel jobs** | `concurrency` (default 3), enforced by the script, not the orchestrator [read: factory/config.json:2; factory/bin/job:137-140, 583-590]. One worktree per job under `.worktrees/` [read: factory/bin/job:538]. One orchestrator session for all jobs [read: DESIGN.md:55-60]. | A concurrency limit from `kit.json` `max_concurrent_lanes` (default 2) [verified: lane.js:334-338, 1056-1058]; one worktree per lane in `<repo>-lanes/` [verified: lane.js:541-543]. Hooks could not tell lanes apart with 2+ open (#50, 0015) [verified: hook_guard_bash.js:140-150]. |
| **Cost and time** | Per job, from Claude Code's subagent transcripts, priced from a table in config [read: factory/bin/job:261-299; factory/config.json:25-30]. The reference itself says the transcript format is undocumented and may break [read: DESIGN.md:117-125]. Time = started→ended [read: factory/bin/job:662-666]. Both on the board and in the run summary [read: factory/dashboard.html:388; factory/bin/job:669-679]. | From OpenTelemetry via the kit's collector [verified: docs/KIT-SPEC.md:321-329]. Only `lane.js launch` turns telemetry on [verified: kit/scripts/sandbox.js:124-135; lane.js:695-702], so attended lanes (subagents in the owner's session) have none. Cost is computed only when `telemetry.show_cost` is set, default off [verified: kit_status.js:47-49, 220], and the dashboard never renders it [cmd: `grep -ci cost kit/dashboard/index.html` → 0]. |
| **Reviewer routing** | Intake rates risk and surfaces; a script maps them to reviewers and models from config [read: factory/bin/route:35-43; factory/config.json:11-19]. | Workflow profile per work type names the one agent per stage [verified: lane.js:966-992]; second reviewer on another model family at high risk [verified: docs/OPERATING-MODEL.md:160]. |
| **Where enforcement lives** | Scripts (`job`, `gate`) plus GitHub (PR, branch protection *if the owner sets it*) [read: DESIGN.md:99-103]. One hook: the builder's Stop runs the checks as a nudge, "the gate is still what decides" [read: DESIGN.md:93-94; .claude/agents/builder.md:6-10]. | 12 hook scripts, 1,081 lines [cmd: `cat kit/scripts/hook_*.js \| wc -l` → 1081], wired on PreToolUse, PostToolUse, SubagentStart/Stop, Stop, ConfigChange, SessionStart [verified: kit/hooks/settings.project.json:16-60]; CI scripts; GitHub protection [verified: bootstrap.js:1395-1410]. The design statement is that enforcement "never depends on an agent's claim" [verified: docs/OPERATING-MODEL.md:18]. |
| **Size** | 2,562 lines in all: three scripts, checks, config, dashboard, skill, eight agents [cmd: `wc -l` over those files → 2562]. | Scripts 8,893; tests 6,217; agents and commands 1,146; dashboard 1,524; planted faults and eval 909 [cmd: `wc -l` per group]. Not comparable in scope: the kit also generates CI, bootstraps projects, runs an architecture map, an eval harness and sandbox launchers. |
| **How it tests itself** | No test files [cmd: `find . -iname '*test*'` in the v2 folder → none]. An install-time check that `checks.sh` passes on main and the scripts run [read: INSTALL.md:141-153]; example jobs from one real run [read: README.md:129-142]. | `node --test` over the kit's scripts [verified: package.json:10]; 45 planted faults [cmd: distinct `record(N` in planted-faults/run.js → 45; README still says 19, verified: README.md:44]; eval harness [verified: package.json:16]; architecture snapshot check [verified: package.json:15]. |

---

## B. Threat models

### B.1 What the reference defends

**Stated.** Untrusted issue text: only labelled issues run, labels need triage or write access, issue text reaches agents as quoted data, the agent that reads it first has no shell [read: DESIGN.md:127-137; factory/bin/job:193-218; .claude/agents/intake.md:4]. Blast radius: agents push only `factory/*` branches, only the merge command merges, nothing deploys [read: DESIGN.md:134-135]. Cost: at most `max_rounds` rounds per job [read: DESIGN.md:136-137].

**Implied.** The agents are honest but fallible. The design removes the places where a fallible agent's *claim* would be trusted: the gate runs the checks instead of reading a "tests pass" line, a verdict is bound to the commit it was computed on [read: factory/bin/job:441-446], reviewers never run on a failing build, the branch is re-gated after syncing with the base.

**What its same-user gate really stops.** It stops the accidental and the lazy: a builder that says it passed when it did not, a branch commit that edits the checks, a stale branch merged without re-testing, the orchestrator skipping a step. It does **not** stop an agent that tries: the builder has Bash and no guard [read: .claude/agents/builder.md:4-11], so it can edit the main checkout's `checks.sh`, `config.json`, `job.json` or a round's `checks.md` directly on disk; a branch can change the project commands `checks.sh` runs [read: factory/checks.sh:4-14]; and every agent runs as the operator, whose `gh` login is what `job merge` uses [read: factory/bin/job:621-624], so any agent can merge [unverified that subagents see the same `gh` login; they run as the same user in the same session, so it is expected]. The LLM approver also merges with no human [read: .claude/agents/approver.md:13-15]. The reference does not claim otherwise; its goal is throughput with honest agents, not containment.

### B.2 What ours must defend

Attacker: any lane agent (subagent or headless session) and anything it launches. Assets and the three layers, as of the pin:

| Asset | Wall (sandbox / separate user / container) | Judge (GitHub PR, CI recomputing, protection, CODEOWNERS, token without admin) | Guardrails (local hooks) | Protected today? |
|---|---|---|---|---|
| `main` | None in the default runtime: `none` launches plain `claude -p` [verified: sandbox.js:147] | Required checks, but 0 approvals and `enforce_admins: false` [verified: bootstrap.js:1397-1398]. The owner's `gh` token sits in the macOS Keychain with `repo` and `workflow` scope, and `git push` uses `osxkeychain` [observed: owner's terminal, this session, 2026-11-15]. The test project pushes to a folder, not GitHub [observed: same, `origin /Users/…/kit-test-remote.git`] | Bash rules on force-push and push to main [verified: hook_guard_bash.js:23-24] | **No.** Anything running as the owner can merge or turn protection off; the test project has no judge at all. |
| Kit code (`~/.claude/kit/scripts/*.js`) | None under `none`; outside `allowWrite` under `srt` [verified: sandbox.js:102] (untested) | `guards-present` hashes the kit scripts at `--kit`, which in CI is the CI action's own copy, never the developer's [verified: ci_guards_present.js:70-75; bootstrap.js:1166, 1307] | The `.claude/` write rule [verified: hook_guard_bash.js:31] misses `cd ~/.claude/kit/scripts && echo … > hook_guard_bash.js` [cmd: the rule's regex returned `false` on that command, B.3] | **No.** A lane can switch its own guards off. |
| Settings (`.claude/settings.json`) | As above | CODEOWNERS covers `.claude/` [verified: KIT-SPEC.md:274]; `guards-present` compares the repo copy [verified: ci_guards_present.js:30-56] | Edit deny [verified: settings.project.json:12; kitlib.js:432]; Bash bypass as #51 | At merge, yes for the committed copy. Locally, no. |
| Gate state (`lane.json`, counters) | None | Not read by CI | Edit deny; Bash and `lane.js stage` bypass [issue #51, #53] | **No.** |
| Evidence (check log, events, review report) | None | `review-report` trusts the branch's file [verified: ci_review_report.js:19-29]; CI re-runs tests [verified: KIT-SPEC.md:265] | Written by hooks inside the lane [verified: docs/KIT-SPEC.md:507-512] | Tests: yes (CI re-runs). Everything else: advisory. |
| Owner's credentials | `srt` denies `~/.ssh`, `~/.config/gh` and others [verified: sandbox.js:62-68], not the Keychain; the container mounts only the worktree and scratch [verified: sandbox.js:141-146] (untested) | n/a | Read guard on secret paths [verified: kit/scripts/hook_guard_read.js:21-26] | **No** under `none`: the Keychain hands `gh` its token without a prompt to anything running as the owner [observed: owner's terminal; Keychain behaviour itself unverified by test]. |

The kit's own documents claim more: "Never depends on an agent's claim" [verified: docs/OPERATING-MODEL.md:18], "Lanes cannot reach what they must not" [verified: docs/OPERATING-MODEL.md:243], and on the dashboard "nothing on it is an agent's claim" [verified: kit/commands/dashboard.md:14; README.md:54], which §10.14 already narrows to "the dashboard reports the files" [verified: docs/KIT-SPEC.md:545-547].

### B.3 The cold review of 0015, recorded here

The review was given to the owner in a session on 2026-11-15 and is not committed anywhere else; its main findings, re-checked for this document:

1. **The hook scripts are themselves writable by the lane under `none`.** `cd "$HOME/.claude/kit/scripts" && echo … > hook_guard_bash.js` does not match the bash guard's `.claude/` rule, while the direct form does [cmd: the regex from hook_guard_bash.js:31, run in Node: `false`, `false` for the `cd` and `node -e` forms; `true` for `echo bad > $HOME/.claude/kit/scripts/hook_guard_bash.js`]. Edit and Write to paths outside the project are blocked [verified: hook_guard_edit.js:46], so Bash is the way in. Every option in 0015 assumes the hook code runs as written.
2. **The mitigation the spec cites does not apply.** KIT-SPEC says a modified kit script "fails CI" [verified: docs/KIT-SPEC.md:423]; CI checks its own pinned kit copy, not the one that ran [verified: ci_guards_present.js:70-75; bootstrap.js:1166, 1307].
3. **0015 §1c's ask rule breaks documented modes.** The host side may be "run by the human's session or a schedule" [verified: docs/OPERATING-MODEL.md:21; docs/KIT-SPEC.md:443]; 0015 says an ask-rule call is denied when nobody is there to answer, citing its probe (whose log shows only that the call never ran, item 5) and the permission-modes documentation [unverified here]; either way a scheduled stage change does not happen. `/run --queue` makes one stage call per stage per lane [verified: kit/commands/run.md:25-27, 34].
4. **A PreToolUse hook can return `ask`.** 0015 marks this unverified; Claude Code's documentation lists `allow`, `deny`, `ask`, `defer` for PreToolUse [unverified here: read from code.claude.com/docs/en/agent-sdk/hooks in that session, not re-read today].
5. Smaller citation issues in 0015: the §10.14 "attempt and revert" is recorded in commit `f8380d8`'s message, not in KIT-SPEC [cmd: `git show f8380d8`, commit message]; "denied in 7 s" is not visible in the cited log lines, which show a 0.3 s gap and no later event [verified: docs/research/claude-code-hook-probe-2.payloads.jsonl:63-64]; probe-2 also shows a subagent running in `dontAsk` under a `default` parent, against 0015's "a subagent's calls carry the parent's mode" [verified: docs/research/claude-code-hook-probe-2.payloads.jsonl:82-105].

---

## C. Each difference judged

| Difference | Verdict | Why |
|---|---|---|
| One writer of job state with a transition table that checks justifying files | **Theirs better** | Our `lane.js stage` accepts anything [verified: lane.js:717-729]. Their table makes an illegal move a refusal with a reason. |
| Stage *derived* from files and git | **Ours better** | Their stored stage can drift from GitHub; they repair one case (a hand-merged PR) on every queue read [read: factory/bin/job:552-555]. Ours computes position from git ancestry [verified: kit_status.js:189-204]. Keep derivation for display; use a transition-checked store for what the orchestrator may do next. |
| Gate script runs the main checkout's checks and binds the verdict to a commit | **Theirs better** | Our host-side runner takes the command from its caller [verified: lane.js:436-449]; our in-lane log is advisory by our own spec [verified: KIT-SPEC.md:500-549]. |
| Gate before merge, after syncing with base | **Theirs better** | We rely on strict up-to-date checks in GitHub [verified: bootstrap.js:1397] and a best-effort merge queue [verified: bootstrap.js:1406-1410], which also covers this when it is enabled; their version works without a GitHub plan feature. |
| Test-first red runs, done-criteria table | **Different goal** | We want proof a test fails for the right reason before the code exists; they do not try. Our implementation of it caused #30, #31, #39, #47, #48. Keep the goal, move the proof to CI (E.2). |
| Tool-call and hour budgets per stage | **Ours aims higher, theirs works** | Their bound is `max_rounds` [read: factory/config.json:3], counted by the script that owns the state. Ours is counted inside the lane, can be reset by the lane, and does not stop a call [verified: hook_budget_check.js:47-84; kitlib.js:763-767] (#41, #53, 0015 §1b). |
| Human merges every PR | **Different goal** | They auto-merge what the approver approves [read: .claude/agents/approver.md:13-15]. We keep the human merge (constraint "No self-approval" [verified: docs/OPERATING-MODEL.md:252]) and should make GitHub enforce it (E.2). |
| Intake decides worth and scope once, on an expensive model | **Theirs better, small** | Our `/start` agrees a goal with the human; their intake can reject or rescope before any spec work [read: .claude/agents/intake.md:28-48]. Optional addition. |
| Reviewer routing by risk and surface from a config table | **Equal** | Both are tables, not prompts [read: factory/bin/route:35-43] [verified: lane.js:966-992]. |
| Cost per job from transcripts | **Theirs visible, ours more robust** | Theirs is shown everywhere but depends on an undocumented format [read: DESIGN.md:124-125]; ours uses OpenTelemetry but only for launched lanes and is never rendered (A). |
| `## Summary` at the top of every step file | **Theirs better** | Only our spec template has one [cmd: `grep -c '^## Summary'` over kit/templates → spec.md 1, all others 0]. |
| Hooks as the main enforcement | **Theirs better for our threat model too** | Local hooks can be switched off by the lane (B.3). A gate that lives where the lane cannot write (GitHub) is the only one that holds; hooks are for speed. |
| Architecture map, bootstrap, generated CI, eval, planted faults | **Ours, out of scope** | The reference has none of these. They are not the source of the field-run bugs listed below and are not changed by this decision. |

### C.1 Issues #29–#53 under a spine-plus-PR model

"Gone" means the mechanism that has the bug would not exist. "Gone, goal kept" means the goal moves somewhere else (E.2) and must be re-tested there.

| # | Title (short) [issue #N] | Under spine + PR |
|---|---|---|
| 29 | Hooks find the lane from cwd; subagent lanes unguarded | Gone: no hook attributes budget or evidence to a lane |
| 30 | Done-check accepts any failing exit as a red run | Gone, goal kept: CI checks new tests fail on base |
| 31 | Spec named a red-run command the hook does not run | Gone, goal kept: same |
| 32 | Three-strikes counter cannot fire; counted tester failures | Gone: rounds counted by the state writer |
| 33 | Line citations in review evidence not checked | Persists: review quality; `validate_docs` can still check it in CI |
| 34 | Spec prescribed a parser that throws; no bad-input criterion | Persists: spec quality |
| 35 | Evidence did not survive the merge; wrong log path | Gone: evidence is CI's run on the PR |
| 36 | ROADMAP status went to the worktree | Gone: state store in the main checkout |
| 37 | A file just written counts as unread | Gone if the read-log hook goes (E.1) |
| 38 | Editing lane artifacts re-runs the suite, counts attempts | Gone: no post-edit attempt counter |
| 39 | Done-check reads one test and one log ref per row | Gone, goal kept |
| 40 | Bash test run not logged; redirect detection reads quotes | Mostly gone: no logging hook; the quoted-text half stays while the bash guard keeps its `.claude/` rule |
| 41 | Budgets vs lifetime count; stage change undoes a raise | Gone: no in-lane budget |
| 42 | Hooks append a second Escalation; template passes | Gone: one writer per file |
| 43 | Lane state in tracked `kit.json` | Gone: gitignored store |
| 44 | `lane.js merged` leaves the spec approved | Gone: merged is read from the PR |
| 45 | Evidence gate runs after the merge it protects | Gone: the gate runs before merge, CI is required |
| 46 | `rm -rf` parsing crosses separators | Persists while the bash guard keeps its `rm -rf` rule |
| 47 | Spec linter and done-check disagree on artifact rows | Gone with done-check |
| 48 | Red-run lint reads a backticked heading as a command | Gone with the red-run lint |
| 49 | Regex replaced a library parser; no differential run | Persists: spec and review quality |
| 50 | Main session attributed to the single active lane | Gone: no attribution hooks |
| 51 | Lane rewrites `lane.json` through Bash | Changes: the store is still writable under `none`, but nothing the judge uses is read from it |
| 52 | Tests depend on the machine | Persists: kit test hygiene |
| 53 | Lane zeroes its budget with `lane.js stage` | Gone: no budget, and no ungated stage writer |

18 of 25 go away, 5 persist, 1 changes character, 1 is partly removed. The persisting ones are about spec and review quality and the kit's own tests: the work the agents are for. The ones that go are about the kit checking itself inside the lane.

### C.2 Hooks: which become unnecessary, which still matter

| Hook [verified: kit/hooks/settings.project.json] | Lines [cmd: wc -l] | Verdict |
|---|---|---|
| `hook_done_check` (Stop/SubagentStop) | 106 | Replace with a gate-verdict nudge, like the reference's one hook |
| `hook_post_edit_check` (PostToolUse) | 274 | Shrink to fast feedback (run lint/tests, print, no log, no attempts) or drop |
| `hook_budget_check` (PostToolUse) | 86 | Drop; rounds and wall time move to the state writer |
| `hook_read_log` + read-before-edit in `hook_guard_edit` | 45 + part of 94 | Drop if Claude Code already refuses an Edit of an unread file [unverified on 2.1.325]; otherwise keep as a guardrail |
| `hook_event_log` | 66 | Keep, for the dashboard only, and add `agent_id` (tool events carry no agent) [verified: docs/research/claude-code-hook-probe-2.p7-lane-events.jsonl:1-15] |
| `hook_guard_bash` | 175 | Keep destructive-command and secret rules; drop rules about lane state |
| `hook_guard_edit` (scope, kit config, approved spec) | 94 | Keep as guardrail; CI recomputes scope from the base copy of the spec |
| `hook_guard_read` | 58 | Keep; the wall does the real work |
| `hook_guard_tests_only` | 44 | Keep (tester writes only tests) |
| `hook_config_guard` | 26 | Keep |
| `hook_notify`, `hook_session_context` | 70, 37 | Keep |
| `validate_docs --hook` | (in 741) | Keep; CI runs the same check |

Removing done-check, post-edit evidence, budget and read-log takes about 511 lines of hooks plus their tests and planted faults; it also removes `laneForHook`'s reason to exist beyond guardrails [verified: kitlib.js:889-901].

---

## D. Dashboard

### D.1 What each shows today

| | Reference (`factory/dashboard.html`) | Ours (`kit/dashboard/index.html`) |
|---|---|---|
| Stage columns | 7 columns, one per group of stages, "Needs human" its own column [read: factory/dashboard.html:287-295] | 6 pipeline boxes with lane markers; "You approve", "You merge" styled as human steps [verified: kit/dashboard/index.html:559-566, 589-595] |
| Job cards | One card per job: issue, PR, risk, round, cost, time [read: factory/dashboard.html:377-405] | One row per lane: position, commits behind, criteria green, blocked count, high-risk [verified: kit/dashboard/index.html:600-606] |
| Per-round chips | Gate chip and one chip per routed reviewer, per round [read: factory/dashboard.html:345-359] | One review verdict, valid or not, matches HEAD or stale [verified: kit/dashboard/index.html:630] |
| Cost and time | On every card and in the header total [read: factory/dashboard.html:388, 432-433] | Neither [cmd: `grep -ci cost` → 0; `grep -ci 'elapsed\|budget\|hours'` → 0] |
| Click to read files | Drawer lists every `.md` of the job, ordered by step [read: factory/dashboard.html:466-492, 503-555] | No file reader; a button opens Claude in the worktree [verified: kit/dashboard/index.html:638, 662-664] |
| Summary first | Each file's `## Summary` shown in a box above the rest [read: factory/dashboard.html:591-618] | n/a |
| Needs human | Its own column, highlighted [read: factory/dashboard.html:293, 379] | "Needs you" card [verified: kit/dashboard/index.html:596-598, 615] |
| Live | Polls `jobs/` every 2 s [read: factory/dashboard.html:286, 678] | Server-Sent Events from a file watcher [verified: kit/dashboard/server.js:477-497; index.html:722-731] |
| Events | None | Last 40 hook events of the selected lane [verified: index.html:633, 652-653] |
| Extra | — | Architecture Canvas, multi-project index, health [verified: index.html:187-188, 577-586, 617-623] |

### D.2 What is missing to watch a run live

1. **Who is acting now.** Tool events carry no agent [verified: docs/research/claude-code-hook-probe-2.p7-lane-events.jsonl:1-15]; a subagent's start and stop do [verified: docs/research/claude-code-hook-probe-2.p7-lane-events.jsonl:6, 9, 13].
2. **Rounds.** Only the latest review is shown; earlier rounds, gate results and reviewer chips are not.
3. **Cost and time.** Computed for launched lanes only and never drawn (A).
4. **The files themselves**, with a summary first; only `spec.md` has a `## Summary` today (C).
5. **A gate verdict per commit**, so "green" means "green for this SHA".
6. **Correct event source.** The server reads `docs/specs/<slug>.events.jsonl` [verified: server.js:465] and watches `docs/specs/` [verified: server.js:108, 118], while lanes write to `<work root>/<slug>.events.jsonl` [verified: kitlib.js:490-491]; a project with another `paths.work` sees no events.
7. **Lane list from the store**, not from tracked `kit.json` [verified: server.js:112-121] (#43).

### D.3 Design (our own code)

- A **Runs** view beside Worktrees. Columns are the spine's stages (E.2) grouped as: Spec, Build, Gate, Review, Needs you, Merge (you), Done. Needs you is red and sorts first.
- One **card per lane**: slug, PR link, risk, round N of max, last gate verdict and SHA, reviewer chips for each round, CI state, elapsed time, cost (or "no telemetry" for attended lanes, stated, not blank).
- A **drawer** on click: every file the lane wrote, in pipeline order, each opened at its `## Summary`. Add `## Summary` (3–5 bullets) to the progress, review, gate and escalation templates; `validate_docs` requires it.
- A **live strip** per card: the agent now running (from SubagentStart/Stop with `agent_id`) and its last tool call.
- Data: the state store for stage and rounds, gate files for verdicts, GitHub for PR and CI, telemetry for cost. Keep SSE; fix the work-root path.

---

## E. Recommendation

**Move to a spine-plus-PR model, keep what the reference lacks, and stop enforcing inside the lane.** The kit's goals stay (spec first, test first, human approval, independent review, sandbox); where each goal is *enforced* moves out of the lane.

### E.1 Delete, keep, add

**Delete (after their replacements pass the planted faults that cover them):** `hook_done_check` as evidence gate; `hook_post_edit_check`'s log and attempts counter; `hook_budget_check`; `hook_read_log` (if the built-in read check holds); the red-run lint in `validate_docs`; `lane.js stage` as a free writer; lane records in `kit.json`; tier 3 of `laneForHook`; the parts of `lane.json` that hold stage, started and budgets.

**Keep:** derived position (`kit_status`), workflow profiles and routing, goals and specs, the spec-first pause, the human merge, guard hooks as guardrails (C.2), CI generation, `guards-present` for the committed settings, the architecture map, eval, planted faults, bootstrap, the sandbox launcher.

**Add:**
1. **State store and transition table.** `lane.js advance <slug> <stage>` is the only writer of a gitignored store in the main checkout; legal moves in one table; each move checks its justifying files and the commit it applies to. A refusal names the reason.
2. **Gate.** `lane.js gate <slug>` runs the project commands from the *base branch's* `kit.json`, in the worktree, and writes a verdict bound to the HEAD SHA. The orchestrator runs it; reviewers start only on PASS; it runs again after syncing with the base before the PR is marked ready.
3. **Judge recomputes.** CI reads the spec and its scope list from the base branch, not the PR [verified that today it reads the PR's: ci_scope_diff.js:14-19]; CI checks that new or changed tests fail against the base code and pass against the head (the red run, recomputed) [unverified that this works for every stack the kit supports]; the review report stays as a record but stops being a required check.
4. **GitHub enforces the human.** Lanes push and open PRs as a separate bot identity with write but no admin; `required_approving_review_count: 1`, `enforce_admins: true`; CODEOWNERS adds `docs/specs/`, `.claude/kit.json`, `package.json` and test config. The owner approves; the bot cannot.
5. **Wall for unattended lanes.** The container runtime (only the worktree and scratch mounted [verified: sandbox.js:141-146]), no owner credentials inside, the push done host-side. Done when four attempts from inside a lane fail: edit a guard, read the `gh` token, push to `main`, merge without approval.
6. **Rounds and wall time** in the store replace tool-call budgets; the orchestrator stops resuming an agent past the limit.

### E.2 Migration order (never weaker than today)

| Step | Adds | Removes | Why it is not weaker |
|---|---|---|---|
| 1. Judge | Test project on GitHub; bot identity; protection with 1 approval and `enforce_admins`; CODEOWNERS additions | — | Only adds. |
| 2. Spine | `advance`, transition table, store; dashboard reads it | `lane.js stage` becomes a call to `advance` | Same callers, now refused when illegal. Old hooks still run. |
| 3. Gate | `lane.js gate` bound to SHA; done-check reads the gate's verdict instead of the log | — | done-check still blocks; its input is now computed, not claimed. |
| 4. CI recompute | Scope from base; red run recomputed; review report demoted | — | CI only gets stricter. |
| 5. Faults first | Rewrite the planted faults for #30-class, budget and evidence cases to target the new gates | — | Coverage is moved before anything is deleted. |
| 6. Delete | — | E.1 deletions | Each deletion lands only with its fault passing against the replacement. |
| 7. Wall | Container runtime for `launch`; the four attempts as planted faults | — | Only adds. |
| 8. Dashboard | D.3 | Old Worktrees view, once Runs shows the same facts | Display only. |

Between steps 1 and 6 the in-lane hooks and the new gates both run. Feedback inside a session gets slower when hooks go (an agent learns at the gate, not at the edit); that is a speed cost, not a safety cost, because the hooks were never the security (B.2).

### E.3 Simplify or keep fixing

**Keep fixing.** Two field runs produced 21 lesson issues [issue #29–#49], and the seven commits that fixed the first batch each name one issue and add tests; none touched the planted faults [cmd: `git log --stat c6b962a^..b3d4f54`]. The owner's estimate is about ten new bugs per field run [unverified: owner's figure, consistent with 10 and 11 in the two runs]. Of the 25 issues, 18 sit in the in-lane machinery (C.1), so fixing them grows the part that B.2 shows does not hold against a determined lane anyway. Cost: open-ended, rising with each field run, and the result is still advisory under `none`.

**Simplify.** One migration of eight steps. About 511 hook lines and the matching tests and lint rules go; about one script (`advance` + `gate`, by the reference's size a few hundred lines [read: factory/bin/job:367-506; factory/bin/gate:1-121]) and CI changes come in. What is lost: in-session feedback on red runs and budgets, and the per-call budget stop 0015 §1b wanted. What is gained: the bugs in C.1 stop recurring, and every gate the merge depends on runs where the lane cannot write. Cost: one bounded piece of work plus re-running two field tests; risk concentrated in steps 3–6, which E.2 orders so coverage moves before code is removed.

**Simplifying beats fixing** on this evidence: the recurring bugs are in the mechanism being removed, and the mechanism being kept (the judge) is the one that holds.

### E.4 How decision 0015 changes

- **§1 options A–E:** A, B, C and D are no longer needed: nothing the judge uses is read from lane-writable state. Keep E's first half (stop granting lane agents the mutating `lane.js` subcommands) as a guardrail.
- **§1b:** dropped with tool-call budgets; the bound is rounds and wall time, enforced by the orchestrator not resuming an agent.
- **§1c:** the ask rule is dropped as the mechanism for "a person decided". The human decides at GitHub, as a separate identity from the agents. Stage moves are `advance` calls, legal or refused, with no prompt; this also clears the scheduled and `--queue` conflict in B.3.
- **§2–§4 (binding by `agent_id`, `KIT_LANE`):** needed only to label events on the dashboard; drop it from budget and evidence.
- **§7 probes:** P4 (can a hook write outside `allowWrite` under `srt`) stays relevant to the wall; P2-full (launch, stdin) stays relevant to unattended lanes; P5, P6, P7 are no longer needed.
- If 0016 is accepted, mark 0015 "superseded in part by 0016" and keep it for its probe results.

---

## F. How the owner can watch a run today

**Command**, from the project root:

```
node ~/.claude/kit/dashboard/server.js --repo ~/Desktop/kit-test-project
```

or `/dashboard` inside Claude Code [verified: kit/commands/dashboard.md:7-10]. It serves http://127.0.0.1:8765/ and opens it unless `--no-open` is given [verified: kit/dashboard/server.js:5, 566]. Click **Worktrees** [verified: kit/dashboard/index.html:188].

**What you will see:**
- each lane as a marker on Research → Plan → You approve → Build → Review + CI → You merge, placed by files and git [verified: index.html:559-566, 613];
- "Needs you": lanes waiting on approval, on merge, or escalated [verified: index.html:596-598];
- per lane: criteria green and red, review verdict and whether it matches HEAD, escalation, the last check, commits behind base [verified: index.html:628-651];
- the last 40 hook events for a lane you click, updating live [verified: index.html:633, 722-731].

**What you will not see:** cost or elapsed time; which agent made each call; earlier review rounds; the content of any file; anything from a lane whose project sets a work root other than `docs/specs/` (D.2 item 6). The positions and counts come from files the lane itself writes, so they show what the lane recorded, not what was proven (B.2).

**In a terminal, alongside:**
- `node ~/.claude/kit/scripts/lane.js next-step <slug> --repo ~/Desktop/kit-test-project` prints the stage the controller will act on and why [verified: lane.js:1249-1251].
- `tail -f ~/Desktop/kit-test-project-lanes/<slug>/docs/specs/<slug>.events.jsonl` follows every hook event [verified: lane.js:541-543; kitlib.js:490-491] [observed: the worktree path in docs/research/claude-code-hook-probe-2.p7-lane-events.jsonl:1].
- `node ~/.claude/kit/scripts/metrics.js lane <slug>` prints cost and tokens, only for a lane started with `lane.js launch` [verified: kit/scripts/metrics.js:9; sandbox.js:124-135]. A lane run by `/run` as subagents in your own session has no telemetry, so it prints nothing useful.
- The `/run` session itself prints each stage it moves to; that is the orchestrator's account, not a check.

---

## Alternatives rejected

- **Keep the kit's design and fix the field-run issues one by one** (E.3): rejected on cost and because the fixed mechanism remains switch-off-able by the lane.
- **Adopt the reference as-is**: rejected. It auto-merges on an LLM's approval, has no spec-approval pause, no test-first proof, no sandbox and no tests of its own (A), and it is GPLv3 (license question open).
- **Make local hooks tamper-proof** (signing, shadow copies, read-only files under the same user): rejected; the same user can undo any of them (B.3); KIT-SPEC already records signing as a non-fix [verified: docs/KIT-SPEC.md:539-541].

## Consequences

Easier: one place moves state and refuses illegal moves; the merge depends only on things the lane cannot write; most field-run bug classes stop recurring; the dashboard can show rounds, cost and files.

Harder: a migration across eight steps; two field runs to re-prove the system; a bot identity and GitHub settings the owner must create; slower in-session feedback; the red-run check becomes a CI job whose feasibility per stack is unverified. The license question must be answered before any implementation that resembles the reference.

## Open questions

1. License and clean-room practice for work informed by a GPLv3 reference, and the kit's own license: **needs a human / legal check.**
2. Does Claude Code 2.1.325 refuse an Edit of an unread file by itself [unverified]?
3. Can CI recompute "the new tests fail on base" for Node, Python, Go and Rust projects without per-stack code [unverified]?
4. Does the macOS Keychain release the `gh` token to a process inside `srt` [unverified]? The container avoids the question.
