# agents-system

A versioned kit for running Claude Code agents through a fixed, enforced pipeline on any repository:
research → plan → approve → build → review → merge → retro.

Start here:
- `docs/KIT-SPEC.md` — the contract for what gets built (awaiting approval)
- `docs/implementation-plan.md` — phases and the check that closes each
- `docs/failure-modes-and-enforcement.md` — what each gate stops and how
- `docs/research/claude-code-features.md` — verified Claude Code features with citations
- `docs/decisions/` — why things are the way they are

## Install (per machine)

```
git clone https://github.com/jonathandrobles805/agents-system ~/agents-system
~/agents-system/install.sh          # symlinks agents, commands, and kit/ into ~/.claude
```

Requires Node 20 or newer (the kit has no npm dependencies), git, and `gh` for GitHub features.

After pulling a new kit version, run `./install.sh` again. It warns about any project that was set up by an older version and needs `node ~/.claude/kit/scripts/bootstrap.js --repo <project> --upgrade` (or `--upgrade --all`).

## Run the kit's own checks

```
npm test
```

## Bootstrap a project

In the project, inside Claude Code: `/bootstrap`. It detects the stack, asks the questions it must not guess (roadmap, WIP limit, layers, high-risk paths, commands), and generates `CLAUDE.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `DESIGN.md`, `LESSONS.md`, `docs/`, `.claude/settings.json` (hooks), `.claude/kit.json`, `scripts/sync.sh`, and the CI workflow. Without Claude: `node ~/.claude/kit/scripts/bootstrap.js --repo . --detect-only`.

## The pipeline

`/start` (we agree the goal) → `/run <slug>`. From there the system researches, plans, asks you to approve, writes tests (tester), builds (implementer), reviews (reviewer), waits for your merge, runs the retro, and picks the next feature. The next stage is always decided by `lane.js next-step` from files and git. The stage commands (`/research`, `/plan`, `/implement`, `/review`, `/retro`) still exist for running one stage by hand. `/status` and `/dashboard` show where everything is.

## Proof

```
node planted-faults/run.js
```
Plants the 19 faults from the spec (unread edit, out-of-spec edit, deleted assertion, boundary violation, missed caller, false citation, open question, undeclared dependency, committed secret, oversize CLAUDE.md, removed hook, premature done, overlapping specs, evidence-free review, secret read, budget, merge conflict, broken kit, vulnerable dependency) and shows each caught by the gate that owns it. Runs in kit CI.

## Dashboard

`/dashboard` (or `node ~/.claude/kit/dashboard/server.js --all`) opens a live page: every feature's position on the pipeline, what needs you, each lane's criteria, drift, review state, the hook event stream, and a button that opens Claude in a lane's worktree. Every value comes from files and git; the page never shows an agent's claim.

Status: Phases 1–4 and 6 complete. Next: `docs/FIRST-PROJECT.md`.
