# Research: how Claude Code 2.1.327 treats the skill frontmatter the kit relies on

- Question: For the kit's four skills (decision 0017), does disallowed-tools reach subagents and outlast its skill, does disable-model-invocation still allow a headless start, are symlinked personal skills found, does arguments substitute, and which Bash commands do allowed-tools patterns approve?
- Slug: claude-code-skill-probe
- Date: 2026-11-17
- Commit: aeae0f4
- Requested by: commands → skills plan, Step 0b (PR #62); decision 0017

## Method

`docs/research/claude-code-skill-probe.sh` (at `aeae0f4`) builds a throwaway project with six probe skills and one probe agent, runs each skill headless with `claude -p`, and records which marker files the run left behind. Jonathan Robles ran it on his Mac on 2026-11-17 (Claude Code 2.1.327, Darwin 24.6.0) and pasted the output unedited; it is kept verbatim in `docs/research/claude-code-skill-probe.output.txt`. Runs 1–5 use `--permission-mode acceptEdits --allowedTools "Skill,Agent,Read,Write,Edit"`; run 6 uses `--permission-mode default` and no `--allowedTools`, so only the skill's own `allowed-tools` can approve a command.

## Findings

- F1. Under `disallowed-tools: Edit, Write`, the main session could not write (`main.txt` absent). [verified: docs/research/claude-code-skill-probe.output.txt:9-9] `main.txt: no`
- F2. A subagent started from that skill could not write either: Claude Code refused to start the Write-only agent at all. [verified: docs/research/claude-code-skill-probe.output.txt:31-31] `would be spawned with zero tools`
- F3. After a skill with `disallowed-tools: Edit, Write` finished, Write stayed denied later in the same turn. [verified: docs/research/claude-code-skill-probe.output.txt:45-45] `still in force after that skill had finished`
- F4. A skill with `disable-model-invocation: true` ran when started as `claude -p "/name"`. [verified: docs/research/claude-code-skill-probe.output.txt:12-12] `dmi.txt: yes`
- F5. A skill folder reached through a symlink in `~/.claude/skills` was found and ran. [verified: docs/research/claude-code-skill-probe.output.txt:13-13] `link.txt: yes`
- F6. `arguments: [slug]` substituted `$slug` in a SKILL.md (`/kit-probe-args hello` wrote `arg-hello.txt`). [verified: docs/research/claude-code-skill-probe.output.txt:14-14] `arg-hello.txt: yes`
- F7. `Bash(./mark.sh p1*)` in `allowed-tools` approved `./mark.sh p1 extra`; a command no pattern named was refused. [verified: docs/research/claude-code-skill-probe.output.txt:15-16] `p1.txt: yes`
- F8. `cd sub && ../mark.sh p3` ran when `Bash(cd *)` and `Bash(../mark.sh p3*)` were both allowed. [verified: docs/research/claude-code-skill-probe.output.txt:17-17] `p3.txt: yes`
- F9. `Bash(bash "$PWD/mark.sh" p4*)` did not approve `bash "$PWD/mark.sh" p4`; it was refused as needing approval. [verified: docs/research/claude-code-skill-probe.output.txt:72-72] `**Refused** ("This command requires approval")`

## What I could not verify

- U1. Whether F9 is caused by the `$`, by the quotes, or by both. [unknown] Resolve by: one probe skill per variant (`$` without quotes, quotes without `$`).
- U2. Whether `permissions.allow` in `.claude/settings.json` matches like skill `allowed-tools` (the kit ships `Bash(node "$HOME/.claude/kit/scripts/*)` there). [unknown] Resolve by: the same probe with the pattern in a project settings file instead of the skill (#63).
- U3. Whether a skill with `disable-model-invocation: true` starts when typed in an interactive session (a refusal was reported for the VS Code extension, anthropics/claude-code#26251). [unknown] Resolve by: typing `/kit-probe-dmi` in the probe project, or the first real run (plan Step 10).
- U4. Whether these results hold on other Claude Code versions. [unknown] Resolve by: re-running the script after a Claude Code upgrade.

## Confidence

High for 2.1.327 on macOS: every finding is a marker file the run left or an error Claude Code printed, from one unedited run.

## Recommendation

No kit skill uses `disallowed-tools` (F2, F3): on `/kit` it would stop the planner, tester, implementer and reviewer from writing. All four skills set `disable-model-invocation: true` (F4); lanes still launch headless. The personal install by symlink works (F5). No kit skill uses `arguments` (F6 holds only in a SKILL.md; the stage files are read by `/kit`, and `/kit` takes more than a slug). The skills keep `Bash` in `allowed-tools` (F9): every kit script is called as `node "$HOME/.claude/kit/scripts/…"`, so a narrow list would leave the kit's own commands unapproved in headless lanes; narrowing waits for #63.

## Sources

- docs/research/claude-code-skill-probe.sh
- docs/research/claude-code-skill-probe.output.txt
- https://github.com/anthropics/claude-code/issues/26251
