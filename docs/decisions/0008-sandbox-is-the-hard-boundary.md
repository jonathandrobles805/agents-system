# 0008 The sandbox is the hard boundary; hooks are the fast layer; `srt` by default, a container at high risk

Date: 2026-11-10

## Context
Until now the only boundary around a lane was the hook layer (decision 0004) plus the permission profile in `.claude/settings.json` (KIT-SPEC §10.1). Hooks ask Claude Code's tools to stop; they cannot stop a shell command that is already running, a child process, or an MCP server, and a loosened `settings.json` weakens them. Anthropic's own guidance and Claude Code's sandboxing docs say the same: a sandbox needs both filesystem and network isolation, enforced by the operating system, or a prompt-injected agent can exfiltrate keys. Anthropic ships `@anthropic-ai/sandbox-runtime` (`srt`), which does this with Seatbelt on macOS and bubblewrap on Linux without a container; the kit's owner works on macOS.

## Decision
1. Every lane runs inside an OS-enforced boundary: worktree-only writes, credential paths unreadable, network allowlist through a proxy. KIT-SPEC §10.9.
2. Two runtimes are accepted and recorded per lane. `srt` is the default (no install on macOS; `failIfUnavailable: true`). A container is the stricter option, required at `risk=high` and on shared machines, and selectable as a project default.
3. When neither runtime is available the lane runs `degraded`: hooks and the floor still enforce, the state is recorded and shown, `risk=high` is refused. Silent fallback is forbidden.
4. The security floor (`kit/security/floor.json`) is the minimum every project enforces. Projects may strengthen it, never weaken it; `ci_security_floor` fails on loosening and the guard hooks read the floor directly.
5. `lane.js` is split into a host side (launcher, holds host-level secrets, spawns the second reviewer, enforces concurrency) and an in-lane side (state, transitions, budgets, evidence). Lanes are headless Claude Code sessions started by the host side. The owner's interactive session never runs implementation.

## Alternatives rejected
- Hooks only: cannot contain child processes or MCP servers; defeated by editing settings.
- Container only: adds Docker as a prerequisite on every developer machine; `degraded` would be the common case on a laptop.
- Virtual machine per lane: strongest, but out of proportion for a single-owner kit; left as a future option for shared infrastructure.

## Consequences
- Planted faults 20–24 (KIT-SPEC §10). Fault 23 proves degradation is reported; fault 24 proves a lane cannot see production credentials.
- `lane.js start` gains the launcher role; `kit.json` gains `sandbox.runtime` and `max_concurrent_lanes`.
- Apple has deprecated `sandbox-exec`, which Seatbelt profiles use; it works today and Claude Code relies on it. The container path exists so the kit does not depend on it.
- `srt` does not sandbox MCP servers started outside the lane process; the launcher starts everything the lane uses inside the boundary.
