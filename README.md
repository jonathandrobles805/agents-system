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

## Run the kit's own checks

```
python3 -m pytest -q kit/scripts/tests
```

## Bootstrap a project

In the project, inside Claude Code: `/bootstrap`. It detects the stack, asks the questions it must not guess (roadmap, WIP limit, layers, high-risk paths, commands), and generates `CLAUDE.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `DESIGN.md`, `LESSONS.md`, `docs/`, `.claude/settings.json` (hooks), `.claude/kit.json`, `scripts/sync.sh`, and the CI workflow. Without Claude: `python3 ~/.claude/kit/scripts/bootstrap.py --repo . --detect-only`.

## The pipeline

`/research <slug>` → `/plan <slug>` → you approve the spec → `/implement <slug>` (own worktree, hooks on) → `/review <slug>` → you merge → `/retro <slug>`. `/status` shows where everything is, derived from files and git, never from an agent's summary.

## Proof

```
python3 planted-faults/run.py
```
Plants the 19 faults from the spec (unread edit, out-of-spec edit, deleted assertion, boundary violation, missed caller, false citation, open question, undeclared dependency, committed secret, oversize CLAUDE.md, removed hook, premature done, overlapping specs, evidence-free review, secret read, budget, merge conflict, broken kit, vulnerable dependency) and shows each caught by the gate that owns it. Runs in kit CI.

Status: Phases 1–4 complete. Next: first real project, then the dashboard.
