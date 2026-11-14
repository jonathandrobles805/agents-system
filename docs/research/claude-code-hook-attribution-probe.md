# Research: what a hook can tell about who made a tool call

- Question: Do PreToolUse/PostToolUse hook inputs let a hook tell a subagent's tool call from the main session's, and do they share a session_id?
- Slug: claude-code-hook-attribution-probe
- Date: 2026-11-14
- Commit: b3d4f54
- Requested by: issue #50 (main session attributed to the single active lane); extends claude-code-features F7

## Method

A read-only probe hook (`node /tmp/kit-probe/probe.js`) was registered for PreToolUse, PostToolUse (matcher `*`), SubagentStart and SubagentStop in a bootstrapped test project's local settings file, with no lane open. It appended one JSON line per call: hook_event_name, session_id, agent_id, agent_type, agent_name, cwd, tool_name, the sorted top-level key names, and the key names (never values) of tool_input. A fresh session (49d89d0e) ran one Bash and one Read in the main session, then the same from one general-purpose subagent and one researcher subagent. Lines from the orchestrating session (eedd92c0), which also picked the hooks up, are kept as recorded. `claude-code-hook-attribution-probe.payloads.jsonl` is the unedited log (34 lines).

## Findings

- F1. The main session's Bash call carries no `agent_id` or `agent_type` key (both null). [verified: docs/research/claude-code-hook-attribution-probe.payloads.jsonl:3]
- F2. A researcher subagent's Bash call carries `agent_id` and `agent_type: "researcher"`. [verified: docs/research/claude-code-hook-attribution-probe.payloads.jsonl:13]
- F3. A general-purpose subagent's Bash call carries `agent_id` and `agent_type: "general-purpose"`, with the same session_id (49d89d0e) and the same cwd (the main checkout) as the main session's call in F1. [verified: docs/research/claude-code-hook-attribution-probe.payloads.jsonl:16]
- F4. On tool events no key is present only for the main session: the main session's key list (F1) is the subagent's (F3) minus `agent_id` and `agent_type`. [verified: docs/research/claude-code-hook-attribution-probe.payloads.jsonl:20]
- F5. A researcher's Read reports the same keys as a general-purpose subagent's Read; only the `agent_type` value differs. [verified: docs/research/claude-code-hook-attribution-probe.payloads.jsonl:14]
- F6. `agent_name` is never present as a key in any of the 34 payloads (the probe writes null as its own default). [verified: cmd]
  ```
  $ jq -s '[.[] | select(.top_level_keys | index("agent_name"))] | length' docs/research/claude-code-hook-attribution-probe.payloads.jsonl
  0
  $ jq -s 'length' docs/research/claude-code-hook-attribution-probe.payloads.jsonl
  34
  ```
- F7. Eight SubagentStop events carry `agent_type: ""` and agent_ids that never appear in a SubagentStart (lines 1, 2, 19, 28, 29, 32, 33, 34). [verified: docs/research/claude-code-hook-attribution-probe.payloads.jsonl:19]

## What I could not verify

- U1. What the agents behind the empty-`agent_type` SubagentStop events are. [unknown] Resolve by: log SubagentStart for every agent in a longer session and match agent_ids, or read the Claude Code hooks reference for internal agents.
- U2. Whether F1-F5 hold on other Claude Code versions. [unknown] Resolve by: rerun the probe after an upgrade.

## Recommendation

A lane hook can attribute a tool call by `agent_id`/`agent_type`, not by cwd or session_id: no `agent_id` means the main session, which must never fall back to the single active lane; an `agent_type` naming a lane role (tester, implementer, reviewer, debugger) is a lane subagent; an empty `agent_type` is not a lane role. [inferred]

## Sources

- `docs/research/claude-code-hook-attribution-probe.payloads.jsonl` (this probe's raw log) [verified: docs/research/claude-code-hook-attribution-probe.payloads.jsonl:1]
- `docs/research/claude-code-features.md` F7 (hook stdin fields) [verified: docs/research/claude-code-features.md:17]

## Confidence

High for F1-F6 on this machine and Claude Code version: each is a direct observation in the log.
