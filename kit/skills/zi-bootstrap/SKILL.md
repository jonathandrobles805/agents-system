---
name: zi-bootstrap
description: "Sets up the kit in a repository: detects the stack, asks what it must not guess, and writes CLAUDE.md, ROADMAP.md, ARCHITECTURE.md, DESIGN.md, LESSONS.md, docs/, hooks, CI and the sync script. Use once per repository, and with --upgrade after updating the kit."
argument-hint: "[--upgrade] [--protect]"
allowed-tools: Bash, Read, Write, AskUserQuestion
disable-model-invocation: true
---

Bootstrap this repository with agent-kit. Arguments: $ARGUMENTS

## Step 1: detect, write nothing
Run and read the output:
```
node "$HOME/.claude/kit/scripts/bootstrap.js" --repo "$PWD" --detect-only --json
```
Report in two lines: stacks and frameworks found, commands detected, tools missing (with the install command proposed, not run).

If `--upgrade` is in the arguments, skip to Step 4.

## Step 2: ask the human; never guess these
For every item in `questions`, ask the human (use AskUserQuestion when available, one question per item, defaults shown):
- `roadmap`: milestones (name, target) and the first features (name, slug, milestone), in priority order.
- `wip_limit`: default 2.
- `layers`: name each layer, its directories (use the detected `dirs` as the draft), and what it may import from. Also ask for 2–5 invariants stated so a check could test them.
- `high_risk_paths`: default list shown; confirm or edit.
- `dev tools installed`: any package installed during bootstrap (for example `dependency-cruiser`) is a new dependency. Write a decision record in the project's decisions folder, `NNNN-adopt-dev-tools.md`, with a `## New dependencies` section listing each one with a reason, and commit it with the bootstrap; outside a lane, a decision record changed by the branch is where `dep-diff` reads declarations.
- `commands`: show each detected command with its `evidence` (where it was found); confirm or correct each. For every CI check under `not_configured`, ask for a command or `none: <reason>`: a check with neither fails CI, a `none` check passes with a visible warning. Never fill one in yourself. Offer to install missing tools; install only on an explicit yes.
- `credentials`: list the credential files found; confirm they stay denied to lanes, or that the human will move them.
- `drift`: if stale branches are listed, tell the human bootstrap can continue but lanes should not start until those branches are merged, synced, or deleted.

Write the answers to `/tmp/kit-answers.json` in the shape documented at the top of `bootstrap.js`. Do not invent a milestone, feature, layer, or invariant the human did not state. Leave a field out rather than fill it; it becomes a `TODO(bootstrap: ...)` marker.

## Step 3: generate
```
node "$HOME/.claude/kit/scripts/bootstrap.js" --repo "$PWD" --answers /tmp/kit-answers.json --json
```
Then:
1. Show the human the list of files written and kept.
2. `grep -rn "TODO(bootstrap" CLAUDE.md ROADMAP.md ARCHITECTURE.md DESIGN.md` and list what remains for them to fill.
3. Run the project's test command from `.claude/kit.json` once and report the result. Red here is the current state of the code being made visible; it is not caused by bootstrap.
4. Run `node "$HOME/.claude/kit/scripts/ci_guards_present.js" --repo "$PWD" --kit "$HOME/.claude/kit"` and confirm it passes.
5. Show every line of `warnings` from the result (for example: the installed kit has uncommitted changes, or its commit is not pushed, so CI pins a tag). The project's own hooks in `.claude/settings.json` and its own `CLAUDE.md` text are kept; the kit adds its hooks next to them and appends one marked block to `CLAUDE.md`.
6. If the kit repository is private, tell the human once: in the kit repository, Settings → Actions → General → Access → "Accessible from repositories owned by the user", or the kit's CI jobs cannot load the kit.

## Step 4: upgrade (only with --upgrade)
```
node "$HOME/.claude/kit/scripts/bootstrap.js" --repo "$PWD" --upgrade --json
```
Show what was backed up (`.claude/backup/<the version being replaced>/`), what was regenerated, and that human-owned files were left alone except the version stamp. The upgrade runs `guards-present` and `security-floor` itself, before and after, and reports each as `before -> after`; it restores from the backup and exits 1 when a check that passed before fails after, so there is nothing to re-run by hand.

## Step 5: branch protection (only with --protect, and only on an explicit yes)
```
node "$HOME/.claude/kit/scripts/bootstrap.js" --repo "$PWD" --protect --json
```
Report the result, including `read_back` (the protection GitHub holds after the call) and `agent_rulesets` (the two rulesets that keep the agents' GitHub App to `wt/*` and `spec/*` branches, with the owner as the only bypass). If `ok` is false because the read-back differs, show the differences and stop; do not merge anything until protection matches. If `gh` is missing or the remote is not GitHub, say so and list the required checks the human should configure by hand: tests, typecheck, lint, boundaries, kit-checks, secrets, audit.

## Step 6: commit
Create a branch `kit/bootstrap` (or `kit/upgrade-<version>`), commit the generated files with the message `agent-kit <version>: bootstrap project layer`, push, and open a PR. The human merges it; that merge is when the hooks and CI take effect for everyone.

Do not start any lane from this command.
