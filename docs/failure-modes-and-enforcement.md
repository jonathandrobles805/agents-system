# Failure modes and how the system enforces against them

This is the control list for the agent kit. Every row answers four questions: what goes wrong, how we tell a guess from a fact, what mechanism stops it, and where it is enforced so it happens every time, not only when an agent remembers.

A rule that only lives in text is marked **text-only**. Those are the weakest and the retro process exists to push them down into process or code.

---

## 0. The core principle: a claim is true only if a tool said so

The agent's belief is never evidence. Evidence is the output of something that ran.

| Evidence level | Example | Trust |
|---|---|---|
| Tool output | test run result, `grep` output, type checker, a file read with line numbers, an API call response | Fact |
| Installed source | the actual library code in `node_modules/` or `site-packages/` at the pinned version | Fact for that version |
| Official docs for the pinned version | linked URL plus version | Strong, can drift |
| Model memory | "Stripe's API works like this" | Not evidence. Must be verified or tagged unknown |

**Every claim about code in a research file or spec carries a provenance tag:**

- `[verified: src/models/user.ts:42-58]` — file and line range, checked by script
- `[verified: cmd]` followed by the command and its output
- `[docs: url @ version]`
- `[inferred]` — reasoning from verified facts; must say from which
- `[unknown]` — goes into Open questions, never into a decision

**Enforcement:** a `validate-docs` script runs as a hook when a research file or spec is written and in CI. It fails if any finding lacks a tag, if any `[verified: path:line]` points to a file or line that does not exist, or if any decision in the spec rests on an `[inferred]` or `[unknown]` claim. The planner and reviewer agents are told to reject documents that fail it, but they do not have to remember: the script blocks first.

---

## 1. Research stage

| Failure | How we know it's a guess | Mechanism | Enforced by |
|---|---|---|---|
| Agent describes how existing code works from memory and is wrong | No `file:line` citation, or citation does not resolve | Provenance tags; citation checker resolves every path and line range and compares the quoted snippet to the file | `validate-docs` hook on write + CI |
| Agent describes a library or API from memory and it changed | No version, no docs link | Version read from the lockfile; behavior checked against installed source or docs for that version | `validate-docs` requires `@ version` on every `[docs]` tag |
| Research is stale by the time it's used | Written against an older commit | Each research file records date and `git rev-parse HEAD`. Planner refuses research from a different commit on the files it cites unless re-verified | `/plan` command checks commit hash before reading |
| Random, unfocused output | No single question | One question per agent, fixed template, hard length cap, mandatory `Confidence` and `What I could not verify` sections | Template + `validate-docs` |
| Two agents answer the same question differently | Overlapping questions | `/research` names the questions and the output files up front; one file per question; conflicts surface in the planner's "contradictions" check | `/research` command |
| Agent says "should work", "probably", "likely" as if fact | Hedge words without an `[unknown]` tag | Hedge-word lint on findings: either verify it or tag it unknown | `validate-docs` |

---

## 2. Planning stage

| Failure | How we know it's a guess | Mechanism | Enforced by |
|---|---|---|---|
| Spec built on a wrong model of the code | Files to change are listed without evidence of what calls them | **Impact analysis section**: for every symbol to be changed, the planner runs `grep`/LSP references and lists every caller with `file:line`. If a caller is missed, the type checker and tests catch it in Build | Template requires the section; `validate-docs` checks it is non-empty when any existing symbol is modified |
| Feature never ends | Done-criteria are vague ("billing works") | Each done-criterion maps to a named test that does not exist yet. Spec is invalid without the mapping | `validate-docs` |
| Hidden assumptions | Decisions rest on unstated beliefs | Mandatory `Assumptions` section. Each is either verified (becomes a tagged fact) or moved to `Open questions`. `/implement` refuses to start while `Open questions` is non-empty | `/implement` command check |
| Two features touch the same files | Not checked | Planner reads every open spec's file list; overlap → spec is refused and you are told which specs collide | `/plan` command |
| Plan violates architecture | Planner never read the invariants | Spec has an `Architecture checklist` copied from `ARCHITECTURE.md`, each item answered; import-boundary lint catches it again in Build and CI | Template + import-linter / dependency-cruiser in CI |
| Over- or under-building | No boundary | Mandatory `Non-goals` section | Template |
| New dependency slipped in | Not declared | Spec lists every new dependency with reason. Lockfile diff in CI fails if a dep appears that no spec declares | CI script |
| Destructive data changes | Migration not thought through | Spec has `Data changes` with reversibility stated; reviewer blocks irreversible migrations without your explicit sign-off | Template + reviewer checklist |
| Too many features in flight | No limit | `ROADMAP.md` has a WIP limit; `/plan` refuses to create a new spec past it | `/plan` command |

---

## 3. Approval stage (you)

| Failure | Mechanism | Enforced by |
|---|---|---|
| You rubber-stamp because the spec is long | Spec has a one-screen summary at the top: goal, files changed, risks, open questions, done-criteria. Details below | Template |
| You miss the risky part | Spec has a `Risks` section ranked; anything touching auth, payments, data deletion, or public APIs is flagged `high-risk` automatically by a keyword and path check | `validate-docs` |
| Approval is ambiguous | Approval is a line in the spec: `Approved by <you> on <date> at commit <hash>`. `/implement` refuses without it | `/implement` command |

---

## 4. Build stage

| Failure | How we know it's a guess | Mechanism | Enforced by |
|---|---|---|---|
| Edits a file it never read | No Read event for that path in this session | A hook logs every file read; a pre-edit hook blocks any Edit/Write to a path not in the log | PreToolUse hook (blocking) |
| Edits a file outside the spec | Path not in spec's file list | Pre-edit hook warns; reviewer rejects; CI compares the diff's file list to the spec's allow-list and fails on extras | Hook + reviewer + CI script |
| Breaks surrounding code | Nothing ran | Post-edit hook runs type check, lint, and tests for the affected files after every edit. The agent sees red before its next action. CI runs the full suite | PostToolUse hook + CI |
| Takes the easy path: new helper with duplicated logic instead of extending the existing one | Spec named the extension point | Spec's `Files to change` names where the logic goes; reviewer checks; duplicate-code lint (`jscpd` or equivalent) in CI | Reviewer checklist + CI |
| Changes a function and misses callers | Impact list in spec; type checker; tests | Spec impact list + typecheck hook + CI | Hook + CI |
| Weakens or deletes tests to go green | Assertion count drops, test skipped | Post-edit hook flags any removed `expect`/`assert`/test case and any added `skip`/`only`. CI compares test count against `main` and fails if it drops without a spec note | Hook + CI script |
| Tests pass trivially (they never could fail) | No red run recorded | **Red-then-green evidence**: tests are written first and run; the hook records the failing run to `docs/specs/<f>.log`. Reviewer requires a red run before the green one for every done-criterion | Hook log + reviewer checklist |
| Agent claims "all tests pass" without running them | Claim with no log | Agents' summaries are never trusted. The hook writes real test output to the log file; reviewer reads the log, not the summary | Hook + reviewer rule |
| Loops forever on a failing test | No limit | Retry limit (3 fix attempts per failure). Then stop, write the state, and escalate to you with the fail list | `/implement` command |
| Loses context mid-feature and starts over or drifts | Long session | Implementer writes `docs/specs/<f>.progress.md` after each done-criterion: what is done, what is next, what is uncertain. A fresh session resumes from it | Implementer agent rules + `/implement` resume mode |
| Branch drifts from `main` | Days without sync | `/sync` runs at the start of every `/implement` session and daily; GitHub branch protection requires the branch to be up to date before merge | Command + branch protection |
| Commits secrets | Not scanned | Pre-commit secret scan (`gitleaks` or equivalent); CI again | Pre-commit hook + CI |
| Hardcoded colors, spacing, strings outside the design system | No lint | Tokens in code; lint rule against raw values in UI files | Lint in hook + CI |
| Finishes early and says done | Checklist not complete | Done-criteria checklist in the progress file: every item needs the test name and a pointer to the green run in the log | Reviewer checklist |

---

## 5. Review stage

| Failure | Mechanism | Enforced by |
|---|---|---|
| Reviewer is anchored by the builder's reasoning | Reviewer is a separate agent with fresh context. It receives only: spec, diff, test log, `ARCHITECTURE.md`, `DESIGN.md`, `LESSONS.md`. Never the builder's conversation | Reviewer agent definition (tool and input restrictions) |
| Reviewer skims and says "looks good" | Mandatory checklist output: each item `PASS`/`FAIL` with evidence (`file:line` or log line). Output is validated like a research file | Template + `validate-docs` |
| Reviewer trusts the builder's test claims | Reviewer re-runs the test suite itself and compares to the log | Reviewer agent rules |
| Same model, same blind spot | Partial mitigation only: reviewer runs independent checks (tests, lints, grep for callers) rather than re-reading reasoning. For `high-risk` specs, a second reviewer with a different checklist (security, data) runs too | `/review` command on `high-risk` flag |
| Scope creep passes | Reviewer compares changed files to spec allow-list; any extra is `FAIL` unless the spec was amended and re-approved | Reviewer checklist + CI script |
| Architecture boundary crossed | Import-boundary lint fails in CI regardless of what the reviewer thinks | CI |
| Fail list is vague | Each `FAIL` must name the file, the line, the rule violated, and what passing looks like. Builder receives only this list | Template |

---

## 6. Merge stage

| Failure | Mechanism | Enforced by |
|---|---|---|
| Merging red or out of date | Branch protection: required status checks, branch must be up to date with `main`, no force push, no direct commits to `main` | GitHub settings, set by `/bootstrap` |
| Reviewer pass is faked or skipped | Reviewer writes its report to `docs/specs/<f>.review.md`; CI check requires a report with all `PASS` for the current diff hash | CI script |
| `ROADMAP.md` goes stale | `/merge` flips the status and commits it; CI fails if a merged spec is not marked done | Command + CI |
| Big PRs come back | PR size check: warn over N files or N lines; the spec should have been split into slices | CI script (warning) |

---

## 7. Learning and system integrity

| Failure | Mechanism | Enforced by |
|---|---|---|
| Same mistake twice | `/retro` writes each lesson with an `Enforced by` column: hook / lint / test / CI / **text-only**. Text-only lessons are listed at the top of `LESSONS.md` as debt until they are turned into a check | `/retro` template |
| `CLAUDE.md` bloats until it's ignored | Hard size cap checked in CI. When a rule becomes enforced by code, its text is removed from `CLAUDE.md` and only the pointer stays | CI script |
| Hooks or CI get disabled quietly | Hook config lives in the repo (`.claude/settings.json`), not in personal settings. CI verifies the config file is present and unchanged from the kit's template hash | CI script |
| Kit drifts across projects | `/bootstrap` stamps the kit version into the project. `/bootstrap --upgrade` diffs and applies changes. A kit changelog records every change | Kit repo + version stamp |
| A rule exists but nobody knows why | Every rule and every structural decision has a file in `docs/decisions/` with context and the alternative rejected | `/retro` and `/plan` templates |
| The kit itself was built by guessing | The kit has its own spec, acceptance tests, and a **planted-fault test**: a repo seeded with known mistakes (an unread-file edit, a scope-creep file, a weakened test, a boundary violation, a missing caller). The kit is not done until every planted fault is caught at the gate that owns it | Kit acceptance suite |

---

## 8. How you know I am not guessing right now

1. Every mechanism above is one of three things: a Claude Code feature (subagents, slash commands, `CLAUDE.md`, pre- and post-tool hooks), a git/GitHub feature (worktrees, branch protection, required checks), or a small script we write (`validate-docs`, citation checker, allow-list diff, test-count compare). The kit spec will link the documentation for each Claude Code feature, and the scripts are code you can read.
2. The planted-fault test in section 7 is the proof. I don't ask you to believe the gates work; the kit ships with a repo full of deliberate mistakes and a run that shows each one being caught. If a fault gets through, the kit is not done.
3. Nothing here asks the agent to be careful. Carefulness is a trait and traits fail under long context. Everything here either blocks the action, or makes the mistake visible as a failed check.

---

## 9. What this does not prevent

Say this plainly so no one is surprised.

- **Logic that is wrong but passes its tests.** If the spec's tests are incomplete, wrong code can pass. Mitigation: done-criteria written before code, reviewer checks test coverage against the spec's goal, and retro adds the missing test case next time. Not eliminated.
- **A spec that is wrong and you approved it.** The gates enforce the spec; they cannot know the spec is wrong. Mitigation: research with citations, impact analysis, and the one-screen summary so you read it. Not eliminated.
- **Shared blind spots between builder and reviewer.** Both are the same kind of model. Mitigation: independent mechanical checks, second reviewer on high-risk. Reduced, not eliminated.
- **External systems behaving differently than their docs.** Mitigation: integration tests against sandboxes where they exist. Not eliminated.
- **You skipping the approval gate under time pressure.** The system can't stop that. It can only make the gate take minutes instead of hours.

Everything else in this list is caught by a check that runs every time, whether or not the agent remembers, and whether or not you are watching.
