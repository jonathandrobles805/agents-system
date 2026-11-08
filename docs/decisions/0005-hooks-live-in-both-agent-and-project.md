# 0005 Guard hooks live in both the agent frontmatter and the project settings

Date: 2026-11-08

## Context
Claude Code applies hooks declared in a subagent's frontmatter only while that subagent runs, and hooks in `.claude/settings.json` to every session in the repo (docs/research/claude-code-features.md F2, F11). A lane is normally run by the implementer subagent, but a human can also open Claude directly in a worktree, for example from the dashboard's "open Claude here" button.

## Decision
Every guard hook is declared twice: in the implementer/researcher/planner/reviewer frontmatter (travels with the agent into any repo) and in the project's `.claude/settings.json` fragment installed by `/bootstrap` (applies to any session in the repo). Duplicate hooks for the same event run in parallel; the most restrictive decision wins, so doubling is safe.

## Alternatives rejected
- Agent frontmatter only: a human session in the worktree would run unguarded.
- Project settings only: an agent invoked in a repo that was never bootstrapped would run unguarded.

## Consequences
Two places to update when a hook changes; `install.sh` and `/bootstrap --upgrade` both come from the same kit version, and the kit CI checks the settings fragment references real scripts.
