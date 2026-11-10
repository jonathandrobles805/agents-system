# Agent kit: implementation plan

> Historical. The phases below were built and are recorded in CHANGELOG.md. The current roadmap is `docs/OPERATING-MODEL.md` §16.

What will be built, in what order, how each piece is verified, and how it lands in your projects. This is the plan the kit spec will be written from. Nothing below starts until you approve the kit spec (Phase 0).

---

## Guiding rules for building the kit itself

1. The kit is a product. It gets its own repo, spec, version, changelog, and acceptance tests.
2. Nothing is "done" because an agent says so. Each phase ends with a check you can run.
3. Every rule we add is placed at the strongest level available: code (hook, lint, test, CI) over process (gate) over text (CLAUDE.md).
4. The kit is proven by a **planted-fault repo**: a small project seeded with known mistakes. The kit passes only when every planted fault is caught at the gate that owns it.
5. Decisions are written down in `docs/decisions/` as they are made, including the alternative rejected.

---

## Phase 0: Kit spec (you approve before anything is built)

**Deliverable:** `kit/docs/KIT-SPEC.md`

Contents:
- Purpose and non-goals of the kit
- For each agent: role, inputs it is allowed to see, tools it may use, exact output file and template, what it must refuse
- For each command: trigger, preconditions it checks, steps, outputs, failure behavior
- Template schemas (research, spec, review report, lesson, progress, roadmap, decision)
- `/bootstrap` detection matrix: what it looks for and what it generates per stack
- Hook contract: which hook events, what each script checks, blocking vs warning
- CI contract: the checks, what fails the build
- Acceptance criteria and the planted-fault list
- Links to the Claude Code documentation for every feature used (subagents, commands, CLAUDE.md, hooks, settings), so each mechanism is checkable, not asserted

**Check:** you read it and add the approval line. I build nothing before that.

---

## Phase 1: Global layer

**Where:** a new git repo `agent-kit`, with an install script that symlinks or copies into `~/.claude/`.

### 1.1 Agents (`~/.claude/agents/`)

| Agent | Sees | May use | Writes | Refuses |
|---|---|---|---|---|
| `researcher` | one question, the repo, the web, installed package source | read, grep, shell (read-only), web | one `docs/research/<slug>.md` in template, every claim tagged | answering more than one question; any untagged finding; hedge words without `[unknown]` |
| `planner` | research files, `ARCHITECTURE.md`, `DESIGN.md`, `LESSONS.md`, `ROADMAP.md`, all open specs | read, grep, LSP references | `docs/specs/<feature>.md` | a spec with unresolved unknowns, file overlap with an open spec, WIP limit exceeded, done-criteria without a test name |
| `spec-critic` | the spec and research only | read | a critique appended to the spec | approving; it only lists gaps and contradictions |
| `implementer` | the approved spec, its listed files, `LESSONS.md` | read, edit, shell, tests | code, tests, `docs/specs/<feature>.progress.md` | editing files not read; editing files outside the spec; starting without the approval line; more than 3 fix attempts on one failure |
| `reviewer` | spec, diff, test log, `ARCHITECTURE.md`, `DESIGN.md`, `LESSONS.md` | read, grep, shell (run tests) | `docs/specs/<feature>.review.md` with PASS/FAIL per item and evidence | reading the implementer's conversation; a PASS without evidence |
| `retro` | merged PR, review report, progress log, `LESSONS.md` | read | a lesson entry with an `Enforced by` value and, when possible, a proposed hook/lint/test | a lesson with no enforcement proposal unless marked text-only debt |

Each agent file has: role, hard rules, the template it must fill, and a short list of forbidden behaviors. Kept short so it is not skimmed.

### 1.2 Commands (`~/.claude/commands/`)

| Command | Preconditions checked | What it does |
|---|---|---|
| `/bootstrap` | repo is git; not already bootstrapped (or `--upgrade`) | scans the repo, generates the project layer (Phase 2) |
| `/research <topic>` | project bootstrapped | reads `docs/research/INDEX.md`; reuses, re-verifies, or spawns researchers in parallel; updates INDEX |
| `/plan <feature>` | research exists for the topic; WIP limit not hit | runs planner, resolves unknowns, runs spec-critic, writes spec with one-screen summary and risk flag |
| `/implement <feature>` | approval line present; no open questions; `main` fetched | creates worktree from fresh `main`, runs `/sync`, runs implementer, opens PR when hooks are green |
| `/review <feature>` | PR exists | runs reviewer; runs second reviewer on `high-risk`; writes review report; posts fail list to the PR |
| `/sync` | in a worktree | fetch, merge `main`, run tests, report conflicts |
| `/retro <feature>` | PR merged | runs retro agent; you approve the lesson; writes `LESSONS.md`; flags global lessons for the kit |
| `/status` | — | prints `ROADMAP.md` status, open specs, worktree drift, text-only debt count |

### 1.3 Templates (`~/.claude/templates/`)

`research.md`, `spec.md`, `review.md`, `lesson.md`, `progress.md`, `roadmap.md`, `decision.md`, `INDEX.md`. Each has required sections; `validate-docs` enforces them.

### 1.4 Scripts (`~/.claude/scripts/`)

| Script | What it does | Where it runs |
|---|---|---|
| `validate-docs` | required sections present; every claim tagged; `[verified: path:line]` resolves and snippet matches; no decision rests on `[inferred]`/`[unknown]`; hedge-word check; risk keywords set the `high-risk` flag | hook on write of docs files; CI |
| `read-log` | appends every file read to `.claude/session/reads.log` | PostToolUse on Read |
| `guard-edit` | blocks Edit/Write to a path not in `reads.log` or not in the spec's file list | PreToolUse on Edit/Write (blocking) |
| `post-edit-check` | runs typecheck, lint, affected tests; flags removed assertions or added skips; writes output to `docs/specs/<f>.log` | PostToolUse on Edit/Write |
| `scope-diff` | diff's file list vs spec allow-list | CI |
| `test-count` | test count on branch vs `main`; fails on drop without spec note | CI |
| `dep-diff` | lockfile diff vs deps declared in open specs | CI |
| `claude-md-cap` | fails if `CLAUDE.md` exceeds the size cap | CI |
| `guards-present` | verifies `.claude/settings.json` and CI config match the kit template hash | CI |

### 1.5 Phase 1 check

Each agent is run alone against a real repo:
- researcher answers one question; `validate-docs` passes; a deliberately false citation fails it
- planner refuses a spec with an unknown, and refuses one that overlaps an open spec
- implementer is blocked by `guard-edit` when it tries to edit an unread file
- reviewer fails a diff that adds a file outside the spec

---

## Phase 2: `/bootstrap` (project layer)

### What it detects

- Language(s) and framework(s) from manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, etc.)
- Test runner, type checker, linter, formatter already in use
- Folder layout and entry points
- Existing CI config and git hosting
- Existing docs, design tokens, and architecture notes to seed from
- Open branches and worktrees

### What it generates

```
repo/
  CLAUDE.md                      short: rules, project map, "read these first" links, kit version
  ROADMAP.md                     milestones, features with status, WIP limit, queue order
  ARCHITECTURE.md                layers, allowed imports between them, invariants
  DESIGN.md                      tokens, components, patterns (or a pointer to the tokens file)
  LESSONS.md                     empty, with the enforced-by column
  docs/specs/                    + README with the template
  docs/research/INDEX.md
  docs/decisions/0001-adopt-agent-kit.md
  .claude/settings.json          hooks wired to the kit scripts, in the repo so they are versioned
  .github/workflows/kit.yml      CI: tests, lint, typecheck, import boundaries, scope-diff, test-count, dep-diff, secrets, claude-md-cap, guards-present, mutation score on changed files
  scripts/sync.sh
```

Plus, where the stack supports it: an import-boundary lint config (`dependency-cruiser`, `import-linter`, or equivalent) seeded from `ARCHITECTURE.md`, a design-token lint rule, and `gitleaks` pre-commit.

It also sets GitHub branch protection on `main` through `gh`: required checks, branch must be up to date, no force push, no direct commits.

### What it asks you

`/bootstrap` fills `ROADMAP.md` and `ARCHITECTURE.md` as drafts from what it finds, then stops and asks you to confirm or correct: the milestones, the WIP limit, the layer boundaries, and anything it marked `[unknown]`. It does not guess these; they are the project's single source of truth.

### Phase 2 check

Run on two unrelated repos (different language or framework). Generated files are reviewed by hand. CI passes on `main` with no code changes. Branch protection is visible in GitHub settings.

---

## Phase 3: Commands end to end

`/research`, `/plan`, `/implement`, `/review`, `/sync`, `/status` wired together.

**Check:** one small real feature in each of the two repos goes from `ROADMAP.md` to merged PR with no manual steps except your approval and your merge. Review report, progress file, and log are all present and consistent.

---

## Phase 4: Planted-fault test

A small repo seeded with these mistakes, each in its own branch:

1. implementer edits a file it never read → `guard-edit` must block
2. a file outside the spec is changed → `scope-diff` and reviewer must fail
3. an assertion is deleted to make a test pass → `post-edit-check` and `test-count` must fail
4. an import crosses an architecture boundary → import-boundary lint must fail
5. a function is changed and a caller is missed → typecheck or tests must fail
6. a research file cites a line that does not exist → `validate-docs` must fail
7. a spec is written with an unresolved unknown → `/implement` must refuse
8. an undeclared dependency is added → `dep-diff` must fail
9. a secret is committed → secret scan must block
10. `CLAUDE.md` grows past the cap → CI must fail
11. a hook is removed from `.claude/settings.json` → `guards-present` must fail

**Check:** every fault is caught at the gate that owns it. Any miss means the kit is not done.

---

## Phase 5: `/retro` and the learning loop

- `/retro` runs after each merge, proposes a lesson with an enforcement level and, when possible, the actual hook/lint/test change
- Text-only lessons are listed at the top of `LESSONS.md` as debt
- Lessons flagged global go to the kit repo as issues; a kit version bump plus `/bootstrap --upgrade` pushes them to all projects
- `claude-md-cap` keeps `CLAUDE.md` short by forcing enforced rules out of the text

**Check:** run a retro on one of the Phase 3 features; the proposed check is added and the planted-fault test still passes.

---

## Phase 6: Production safety net (per project, where applicable)

Feature flag library wired, canary rollout documented in `ARCHITECTURE.md`, error monitoring and alerting, a tested rollback command. The reviewer checklist requires `high-risk` features to ship behind a flag.

---

## Rolling this into your existing projects

For each project, in order:

1. **Freeze the drift first.** List every open branch and worktree. For each: merge what is mergeable, sync the rest with `main`, delete what is dead. Nothing is bootstrapped on top of two-week-old divergence.
2. Run `/bootstrap`. Answer its questions about milestones, WIP limit, and boundaries. This is where the plan in your head becomes `ROADMAP.md`.
3. Let CI run on `main`. Fix anything red before any feature work; that red is the current state of the code being made visible.
4. Pick the next item in `ROADMAP.md` and run the pipeline once with you watching. Adjust the spec template to the project if needed.
5. From then on, the daily loop is: `/status` → approve any waiting spec → merge any green PR → `/retro` → repeat. Everything between those points runs without you.

Worktrees are kept, one per feature, created by `/implement` from fresh `main`, synced by `/sync`, deleted on merge.

---

## What a day looks like once this is running

- Morning: `/status`. Two specs are waiting for approval; one PR is green. Ten minutes: read both specs, fix a line in one, approve both, merge the PR, run `/retro` on it.
- The kit starts research and planning on the next roadmap items while two implementers build.
- Afternoon: one lane escalated after three failed attempts. You read the fail list and the progress file, give one instruction, and it resumes.
- Evening: `/status` shows one more green PR. Merge, retro, done.

Your time goes to specs and merges. Agents never edit a file they haven't read, never change a file not in the spec, never claim a passing test without a log, and never merge without a fresh reviewer and green CI.

---

## What I need from you to start Phase 0

1. Languages, frameworks, test runners, and CI across your current projects
2. Whether the kit lives in its own GitHub repo (recommended)
3. One repo to use for Phase 1 and 2 checks, and a second, different one for the second `/bootstrap` run
4. Your WIP limit (recommended: 2)

---

## Certainty

Certain: every mechanism above is a Claude Code feature, a git/GitHub feature, or a small script we write and can read. The agents will follow the structure because hooks, scripts, CI, and branch protection enforce it; nothing relies on an agent choosing to be careful. The planted-fault test shows it, rather than asking you to trust it.

Not certain, and not claimed by anyone: zero wrong code inside a lane. Code that is wrong but passes incomplete tests, a wrong spec you approved, and shared model blind spots are reduced by mutation scores, the spec critic, a second reviewer, and the safety net, and are caught fast when they get through. That is the standard enterprise systems hold to, and it is the one this kit is built to.
