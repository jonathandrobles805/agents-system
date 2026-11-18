# 0017 Commands become four `kit` skills

Date: 2026-11-17 · Amended: 2026-11-17 (simpler names: `/kit`, `/kit-setup`, `types/`; owner, in chat) · Status: accepted · Depends on: 0016 E.5 · Evidence: plan `commands-to-skills` (independent review 2026-11-17), issues #56–#59

## Context

The kit ships 23 slash commands as `kit/commands/*.md`, linked by `install.sh` into `~/.claude/commands/` [verified: install.sh:32-33]. Claude Code now treats commands as a legacy form of skills: a skill is a folder with a `SKILL.md`, may carry supporting files, and has frontmatter that commands do not use well (`disable-model-invocation`, `disallowed-tools`, `arguments`) [docs: code.claude.com/docs/en/skills]. 0016 E.5 decides that the orchestration commands become one orchestrator skill. This decision fixes names, install, folder and the mapping.

Facts this rests on, checked on Claude Code 2.1.326 and its docs on 2026-11-17:
- `/plan`, `/review` (alias of the bundled `/code-review`) and `/status` are built-in commands, and `/run` is a bundled skill [docs: code.claude.com/docs/en/commands]. A local skill replaces a bundled skill of the same name [docs: skills, "Resolve skills that share a name"]; reports disagree on built-ins, and a plugin skill named `status` was reported to intercept `/status` [anthropics/claude-code#43754].
- Personal skills (`~/.claude/skills`) override project skills (`.claude/skills`) of the same name [docs: skills].
- Plugin-shipped agents ignore `hooks` and `permissionMode` [docs: code.claude.com/docs/en/plugins-reference]. All 8 kit agents use them, and every hook and command calls `$HOME/.claude/kit/scripts`.
- `kit/skills/` is already watched by kit CI's eval trigger [verified: .github/workflows/kit.yml:78 at e8f1115], and `kit/skills/workflows/<kind>` is read by the eval harness [verified: kit/eval/harness.js:58].

## Decision

1. **Four skills, plain names that start with `kit`.** `/kit` (the orchestrator), `/kit-status`, `/kit-dashboard`, `/kit-setup`. The rule (`kit`, or `kit-` plus a plain word) is fixed for every future kit skill, so no kit skill can take the name of a Claude Code built-in or bundled skill, now or after an update.
2. **Only a human or the launcher starts them.** Every kit skill sets `disable-model-invocation: true`. The headless launcher starts lanes with `/kit <slug>` [lane.js:691 today sends `/run <slug>`].
3. **Install: personal, one copy.** `install.sh` links `kit/skills/<name>/` into `~/.claude/skills/<name>/`, removes the kit's old files from `~/.claude/commands/` (links and `--copy` copies, kit files only), and prints the name map. Projects get no copy of these skills. A plugin is not used while plugin agents cannot carry hooks.
4. **Folder.** `kit/skills/<name>/`. The subfolders `kit/skills/domains/` and `kit/skills/workflows/` stay reserved for the domain and workflow skills of OPERATING-MODEL §3, and `install.sh` skips them.
5. **Inside `/kit`.** `SKILL.md` holds today's `/run` loop: ask `lane.js next-step`, act on the stage, repeat. Each stage's steps move to `stages/<stage>.md` (from today's `/start`, `/research`, `/plan`, `/implement`, `/review`, `/sync`, `/retro` and the stage rows of `/run`), and each work type's notes to `types/<type>.md` (from the 11 work-type commands and `/work`). The skill reads only the file the next step names. An argument that names an existing goal resumes it; a stage name runs that one stage (as the old stage commands did); anything else starts the goal conversation. Behaviour does not change; only where the text lives and what it is called.
6. **OPERATING-MODEL §3 skill rules** (copied per project, hashed by `guards-present`, rejected by CI without a planted fault, an eval set or a `criteria` section) apply to domain and workflow skills. The four orchestration skills are exempt: they are covered by the kit's own tests, the architecture map and the planted faults that already exercise the stages.
7. **The hybrid-factory blueprint** (branch `docs/hybrid-factory-adoption-blueprint`, draft) is superseded by 0016 and this decision and is not merged. It forbade a skills layer [blueprint L26, L111].

### Name map

| Old | New |
|---|---|
| `/run <slug>` | `/kit <slug>` |
| `/start <what you want>` | `/kit <what you want>` |
| `/work <symptom>` | `/kit <symptom>` (no work type: the controller routes it, as `/work` does today) |
| `/new-feature`, `/fix`, `/ui`, `/refactor`, `/docs`, `/investigate`, `/security`, `/architecture`, `/migrate`, `/incident`, `/new-skill` | `/kit <work type> <what you want>` |
| `/research`, `/plan`, `/implement`, `/review`, `/sync`, `/retro` | `/kit research`, `/kit plan <slug>`, … : one stage by hand, as before (`/kit <slug>` runs them all); `/retro --incident` is `/kit retro --incident` |
| `/status` | `/kit-status` |
| `/dashboard` | `/kit-dashboard` |
| `/bootstrap [--upgrade]` | `/kit-setup [--upgrade]` |

Short names in KIT-SPEC and OPERATING-MODEL (`/bootstrap`, `/status`, a stage name) refer to the skills above.

## Consequences

Easier: one copy of each stage's steps; no kit name can shadow or be shadowed by Claude Code; frontmatter can restrict tools per skill; skill edits trigger the eval job (its smoke set tests the agents, not yet the skills).

Harder: everyone re-runs `install.sh` once and learns four names; every reference to an old name must change in the same release (launcher prompt, script messages, the `command` field of the 11 workflow profiles, README, FIRST-PROJECT, tests); projects run `bootstrap.js --upgrade --all` so their CI messages use the new names. Version 0.3.0.

Not yet known, settled by a probe before the frontmatter is relied on (`docs/research/claude-code-skill-probe.md`): whether `disallowed-tools` reaches subagents and whether it outlasts the skill; whether a skill with `disable-model-invocation: true` runs when typed and when launched with `claude -p` [anthropics/claude-code#26251 reports a refusal]; whether a symlinked skill folder is found; whether `$slug` substitutes.

## Approval

Approved by: Jonathan Robles (via chat) on 2026-11-17 at b7ed48a
