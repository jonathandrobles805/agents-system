# Research: Claude Code features the kit depends on

- Question: Which Claude Code mechanisms exist to enforce the kit's rules, and what exactly can each one do?
- Date: 2026-11-08
- Repo commit: 8ab5374 (initial)
- Sources: official Claude Code documentation (code.claude.com/docs). Third-party pages were read but are not cited.

## Findings

1. Hooks are shell commands Claude Code runs at lifecycle events; they give deterministic control, not model judgment. `[docs: https://code.claude.com/docs/en/hooks-guide]`
2. Hook configuration lives in `~/.claude/settings.json` (user), `.claude/settings.json` (project, committable), `.claude/settings.local.json` (gitignored), plugin `hooks/hooks.json`, skill frontmatter, and subagent frontmatter (active while that subagent runs). `[docs: https://code.claude.com/docs/en/hooks-guide#configure-hook-location]`
3. `PreToolUse` fires before a tool call and can block it: exit code 2 blocks and stderr is shown to Claude. Exit 0 means no objection. Exit 1 does not block. `[docs: https://code.claude.com/docs/en/hooks-guide]`
4. `PostToolUse` fires after a tool call succeeds. It cannot un-run the tool. A top-level `{"decision":"block","reason":...}` feeds the reason back to Claude so it must respond. `[docs: https://code.claude.com/docs/en/hooks-guide]`
5. `PreToolUse` can also return JSON `hookSpecificOutput.permissionDecision` of `allow`, `deny`, `ask`, with a reason fed back to Claude on `deny`. When several hooks match, the most restrictive answer wins. `[docs: https://code.claude.com/docs/en/hooks-guide]`
6. Matchers filter tool events by tool name (`Edit|Write`, `Bash`, `mcp__.*`). An `if` field accepts permission-rule syntax such as `Edit(*.ts)` or `Bash(git *)` for finer filtering on tool events. `[docs: https://code.claude.com/docs/en/hooks-guide#filter-hooks-with-matchers]`
7. Hooks receive JSON on stdin with `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input` (and `tool_response` on PostToolUse). `[docs: https://code.claude.com/docs/en/hooks-guide]`
8. Other events available: `SessionStart` (matchers `startup|resume|clear|compact`; stdout is added to Claude's context), `Stop` (when Claude finishes responding; `decision: block` makes it keep working), `SubagentStop` (matcher is the agent type), `WorktreeCreate`, `WorktreeRemove`, `FileChanged`, `PostToolUseFailure`, `ConfigChange` (can block changes to settings). `[docs: https://code.claude.com/docs/en/hooks-guide]`
9. Claude can also change files through `Bash`; a hook that must see every change should also match `Bash` and inspect `git status --porcelain`, or use a `Stop` hook that scans the working tree once per turn. `[docs: https://code.claude.com/docs/en/hooks-guide]`
10. `disableAllHooks: true` in a settings file disables hooks; project settings can override user settings. `[docs: https://code.claude.com/docs/en/hooks-guide]`
11. Subagents are Markdown files with YAML frontmatter in `.claude/agents/` (project) or `~/.claude/agents/` (user). Frontmatter supports `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, and `hooks`. Each runs in its own isolated context. `[docs: https://code.claude.com/docs/en/sub-agents]`
12. Custom slash commands are Markdown files in `.claude/commands/` (project) or `~/.claude/commands/` (user), with optional frontmatter including `description`, `argument-hint`, `allowed-tools`, `disallowed-tools`, `model`. `[docs: https://code.claude.com/docs/en/slash-commands]`
13. `CLAUDE.md` is read at session start as project memory. `[docs: https://code.claude.com/docs/en/memory]`

## What I could not verify

- Exact field names in the `SubagentStop` and `WorktreeCreate` input schemas. `[unknown]` Resolution: read the hooks reference page sections for those events during Phase 1 before writing the scripts.
- Whether `Stop` hook `decision: block` applies when the session runs headless with `-p`. `[unknown]` Resolution: test in Phase 1 planted-fault run.

## Confidence

High on findings 1–13 (all from official docs read today). The two unknowns do not affect the kit design; they affect two scripts and are scheduled for verification before those scripts are written.

## Recommendation

Use `PreToolUse` for every rule that must block (unread file, out-of-spec file, secret, destructive command). Use `PostToolUse` for feedback that cannot block (test runs, lint, test-count). Use `Stop` to refuse "done" until progress and logs are updated. Use `SubagentStop` to validate the reviewer and researcher output files. Put the implementer's guard hooks in its subagent frontmatter so they travel with the agent, and also in `.claude/settings.json` so they apply if someone runs Claude in the worktree directly. Add a `ConfigChange` hook that blocks edits to `.claude/settings.json` during a lane.
