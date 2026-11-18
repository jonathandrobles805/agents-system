# Claude Code skill probe (decision 0017, Step 0b)

Run by Jonathan Robles on his Mac, 2026-11-17 16:26 PST, with `docs/research/claude-code-skill-probe.sh` at `aeae0f4`. Claude Code 2.1.327, Darwin 24.6.0. Results below are the script's own output, pasted unedited into the session; the interpretation at the end is analysis.

Each run: `claude -p "/<skill>" --permission-mode acceptEdits --allowedTools "Skill,Agent,Read,Write,Edit"` in a fresh temporary project, except Q6: `claude -p "/kit-probe-perm" --permission-mode default` with no `--allowedTools`, so only the skill's own `allowed-tools` can approve a command.

| # | Question | Observed | Good for the kit when | Exit |
|---|---|---|---|---|
| 1a | Main session under `disallowed-tools: Edit, Write` can still write | main.txt: no | no | 0 |
| 1b | A subagent started from that skill can still write | sub.txt: no | yes | 0 |
| 2 | Write works again later in the same turn, after a restricted skill ran | after.txt: no | yes (no means the restriction leaks into the orchestrator) | 0 |
| 3 | A `disable-model-invocation: true` skill runs when started as `claude -p "/name"` | dmi.txt: yes | yes | 0 |
| 4 | A symlinked folder in `~/.claude/skills` is discovered | link.txt: yes | yes | 0 |
| 5 | `arguments: [slug]` substitutes `$slug` | arg-hello.txt: yes | yes | 0 |
| 6a | `Bash(./mark.sh p1*)` approves `./mark.sh p1 extra` | p1.txt: yes | yes | 0 |
| 6b | A command no pattern matches is refused (`./mark.sh p2`) | p2.txt: no | no | 0 |
| 6c | `cd sub && ../mark.sh p3` runs when each part has a pattern | p3.txt: yes | yes | 0 |
| 6d | A pattern with a literal `$PWD` matches the same literal command | p4.txt: no | yes | 0 |

Files in the probe project: arg-hello.txt dmi.txt link.txt p1.txt p3.txt

Not covered: Q3 typed by hand in an interactive session (checked in Step 10).

## Raw output

### q1 (exit 0)
```
Neither file was created, so the probe indicates `disallowed-tools` does reach the subagent.

1. **main.txt:** Write unavailable in main session. The Write call was denied, so `main.txt` was not created.
2. **sub.txt:** The `probe-writer` subagent never started. The harness refused it with: "Agent 'probe-writer' would be spawned with zero tools — refusing. Its tools list resolved to nothing: unrecognized [Write]." Write is the only tool that agent has, and it wasn't available to it either.
3. **Files in the project directory now:**
   - `.claude/`
   - `.git/`
   - `mark.sh`
   - `sub/`, an empty directory. There is no `sub.txt` file. The directory was already there with the same timestamp as the other entries (16:25), so this run didn't make it.
```

### q2 (exit 0)
```
1. kit-probe-restrict loaded, and I replied "restricted skill loaded" as it asked.
2. Write unavailable after restricted skill. The Write tool was still listed, but calling it to create `after.txt` returned "Permission to use Write has been denied."
3. `after.txt` does not exist; `ls` returned "No such file or directory."

So the restriction set by kit-probe-restrict was still in force after that skill had finished, when the outer skill moved on to step 2.
```

### q3 (exit 0)
```
done
```

### q4 (exit 0)
```
done
```

### q5 (exit 0)
```
I created `arg-hello.txt`, which contains the word "arg".
```

### q6 (exit 0)
```
Two of the four commands ran and two were refused.

| # | Command | Result |
|---|---------|--------|
| 1 | `./mark.sh p1 extra` | **Ran** (no output) |
| 2 | `./mark.sh p2` | **Refused** ("This command requires approval") |
| 3 | `cd sub && ../mark.sh p3` | **Ran** (no output) |
| 4 | `bash "$PWD/mark.sh" p4` | **Refused** ("This command requires approval") |

- **Approved:** the two forms that ran are `./mark.sh` with two arguments and `../mark.sh` after a `cd`. The plain `./mark.sh p2` with one argument was refused, so the skill's allowed pattern seems to need an extra argument or match a different path form.
- **Refused:** going through `bash` with an absolute `$PWD` path did not match any allowed pattern.
- **Working directory:** command 3's `cd sub` stuck, so the session is now in `project/sub`. All four calls were sent at once, so command 4 may have been checked from either directory, but it was refused before it ran either way.
```

(In q6 the model's reading of command 2 is wrong: `./mark.sh p2` was refused because no pattern names `p2`, which is what 6b tests.)

## What the kit does with this (analysis)

- **No `disallowed-tools` on any kit skill (1b, 2).** It removes the tool from subagents too, and it stays in force after the skill that set it. On `/kit` it would stop the planner, tester, implementer and reviewer from writing their files.
- **`disable-model-invocation: true` on all four skills (3).** A headless lane starts with `claude -p "/kit <slug>"` (`launch` in lane.js); that still runs.
- **Personal install by symlink works (4).**
- **`arguments` substitutes only in a SKILL.md (5 plus how skills load).** The kit's stage files are read by `/kit`, not loaded as skills, so a named argument there would not be substituted; `/kit`'s own arguments are not one slug. No kit skill uses `arguments`.
- **`allowed-tools` keeps `Bash` (6d).** Every kit script is called as `node "$HOME/.claude/kit/scripts/<script>.js" ...`. A pattern containing `"$PWD"` did not match the same literal command, so a narrow list built from the kit's own commands would leave them unapproved, and a headless lane (`--permission-mode default`) would be denied them. Not tested here: whether the cause is the `$`, the quotes, or both; and whether the same holds for `permissions.allow` in `.claude/settings.json` (the kit ships `Bash(node "$HOME/.claude/kit/scripts/*)` there).
