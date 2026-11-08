# 0004 PreToolUse blocks, PostToolUse feeds back, Stop checks completion

Date: 2026-11-08

## Context
Per the Claude Code hooks documentation, PreToolUse exit 2 blocks a tool call; PostToolUse cannot un-run a tool but can return a block decision that Claude must respond to; Stop can refuse to end a turn. See docs/research/claude-code-features.md.

## Decision
- Anything that must never happen (unread edit, out-of-spec edit, secret, destructive command, settings change) is a PreToolUse hook.
- Anything that is feedback on work already done (tests, lint, typecheck, assertion diff) is a PostToolUse hook that writes to the log and blocks the next step on failure.
- "Done" is checked by a Stop hook against progress.md and the log, not by the agent's statement.
- Output documents are validated on SubagentStop so the writing agent must fix them before it ends.

## Alternatives rejected
- Asking agents to run checks themselves: optional by nature.
- Only CI: too late; the agent has already built on the mistake.

## Consequences
Hook scripts must be fast (seconds) and must write everything to files so the dashboard can show it.
