# Skill format decisions

Each entry: what, why, who decided, what was rejected. Never edit an old entry; add one that replaces it.

## S1. Work in a separate worktree, format only

- Date: 2026-11-25 · Decided by: the owner
- What: the rewrite happens on branch `docs/skill-format` in its own worktree, branched from `main`.
  It changes how skills are written, not what they do.
- Why: branch `lane/s2-narrow` (hardening plan Step 2) edits 22 skills and is not merged yet; the
  `agents-system-step0` worktree works on the dashboard. A separate worktree touches neither.
- Rejected: rewriting on `lane/s2-narrow` (mixes two changes); waiting for the whole hardening plan (blocks for weeks).

## S2. Skills name only commands that exist today

- Date: 2026-11-25 · Decided by: the owner, on Claude's recommendation
- What: every `kit lane …` command in a skill stays exactly as it is. Commands from later steps
  (`kit lane gate` in Step 3, `kit lane launch` in Step 8) are added by those steps into the new template.
- Why: the narrowing test (planted fault 63) checks that every kit command a skill names is allowed;
  a command that doesn't exist would break it, and Claude would try to run something that isn't there.
- Rejected: writing future commands now.

## S3. Rebase onto main after `lane/s2-narrow` merges

- Date: 2026-11-25 · Decided by: the owner
- What: once `lane/s2-narrow` is merged, this branch is rebased onto `main` and conflicts are fixed here.
- Why: that branch has 22 skill edits (commit 63231b7, `--repo .`); conflicts belong on our side, not theirs.

## S4. Each SKILL.md is written for Claude only

- Date: 2026-11-25 · Decided by: the owner (interview Q1)
- What: a skill is an instruction for the agent: short commands and rules. People learn the system from
  the README and `docs/`, not from skills.
- Why: Anthropic's guide: "Claude is already very smart"; only add what it doesn't know, and every
  paragraph must justify its token cost.
- Rejected: writing for Claude and people (needs explanation, gets longer); people first.

## S5. Low freedom: the script decides, the skill gives exact commands

- Date: 2026-11-25 · Decided by: the owner (interview Q2)
- What: each step gives the exact `kit lane` command and says: run it, relay its output, never work
  around a refusal. Claude judges only where no script exists (e.g. writing research questions), and
  then in 1–2 lines.
- Why: moving a stage, merging and approving are fragile, a mistake costs a lot ("narrow bridge" in
  Anthropic's guide); `kit lane` already enforces the rules, so the skill should not restate them.
- Rejected: mixed freedom per stage; Claude decides the steps.

## S6. Build skills one by one, each checked against Anthropic's guide

- Date: 2026-11-25 · Decided by: the owner
- What: for each skill, read the guide's relevant section, mark each step, write it, check it. `zi-run` first.
- Why: one finished, agreed example becomes the template for the other 22.

## S7. AI coding choices: one short line, shown on the dashboard

- Date: 2026-11-25 · Decided by: the owner, on Claude's recommendation
- What: the implementer, tester and debugger record each choice they make that the spec didn't settle:
  - commit: a body line `why: <reason>`, at most 72 characters;
  - progress.md: a `## Choices` section, one line each, `chose X over Y: <reason>`, at most 120 characters, at most 5 per lane (more means the spec missed something: escalate).
  - The hardening plan's Step 10 drawer shows the section.
- Why: commits say what changed, not why; progress.md records doubts (`## Uncertainties`) but not choices; the dashboard shows actions, not reasons. 72 is git's line width; one line per choice keeps it readable.
- Rejected: a separate choices file and promotion command (the full proposal; larger than needed for now).
- Not part of the skill rewrite: built as its own lane, after or within Step 10.

## S8. Factory style: numbered steps, short lines, nothing dropped

- Date: 2026-11-25 · Decided by: the owner
- What: each stage is a `### N. Stage` heading with numbered steps: the exact `kit lane` command, then what
  to do with its result. Lines at most 100 characters. `resume`, `stop` and `queue` get their own `##` sections.
  Every rule and command in today's skill stays; a test checks no `kit lane` command was lost.
- Why: the reference factory skill reads top to bottom like a checklist; our table rows run to ~1,500
  characters on one line. Short lines keep the content and stay under Anthropic's 500-line limit
  (zi-run: about 120–150 lines).
- Rejected: moving stage text into the script (instructions hidden in code); a separate reference.md (not needed at this size).

## S9. zi-work first, then one part at a time (replaces S6's order)

- Date: 2026-11-27 · Decided by: the owner
- What: the rewrite starts with `zi-work`, the entry point, and follows the path a user takes:
  zi-work, the work types, zi-start, zi-run, its stage skills, then the stand-alone skills. Each skill
  is split into its parts; each part is shown as it is, what is wrong (with the source), and the fix,
  and is changed only after the owner approves it. One commit per part; tests and planted faults pass
  on each.
- Why: the owner wants to follow the user's path and review every part, not a whole skill at once.
- Rejected: zi-run first (S6); rewriting a whole skill in one change.
