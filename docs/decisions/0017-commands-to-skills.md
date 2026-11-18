# 0017 Commands become 23 skills, each named `zi-` plus its old name

Date: 2026-11-17 · Amended: 2026-11-17, twice by the owner in chat: first `/kit`, `/kit-setup`, `types/`; then one skill per job with the `zi-` prefix (this text) · Status: accepted · Depends on: 0016 E.5 (as amended) · Evidence: plan `commands-to-skills` (independent review 2026-11-17), issues #56–#59, #63

## Context

The kit ships 23 slash commands as `kit/commands/*.md`, linked by `install.sh` into `~/.claude/commands/` [verified: install.sh:32-33]. Claude Code now treats commands as a legacy form of skills: a skill is a folder with a `SKILL.md`, may carry supporting files, and has frontmatter that commands do not use well (`disable-model-invocation`, `disallowed-tools`, `arguments`) [docs: code.claude.com/docs/en/skills]. 0016 E.5 decides that the orchestration commands become one orchestrator skill. This decision fixes names, install, folder and the mapping.

Facts this rests on, checked on Claude Code 2.1.326 and its docs on 2026-11-17:
- `/plan`, `/review` (alias of the bundled `/code-review`) and `/status` are built-in commands, and `/run` is a bundled skill [docs: code.claude.com/docs/en/commands]. A local skill replaces a bundled skill of the same name [docs: skills, "Resolve skills that share a name"]; reports disagree on built-ins, and a plugin skill named `status` was reported to intercept `/status` [anthropics/claude-code#43754].
- Personal skills (`~/.claude/skills`) override project skills (`.claude/skills`) of the same name [docs: skills].
- Plugin-shipped agents ignore `hooks` and `permissionMode` [docs: code.claude.com/docs/en/plugins-reference]. All 8 kit agents use them, and every hook and command calls `$HOME/.claude/kit/scripts`.
- `kit/skills/` is already watched by kit CI's eval trigger [verified: .github/workflows/kit.yml:78 at e8f1115], and `kit/skills/workflows/<kind>` is read by the eval harness [verified: kit/eval/harness.js:58].

## Decision

1. **One skill per job, 23 skills.** Each old command becomes its own skill, a folder `kit/skills/zi-<old name>/` with one `SKILL.md`. The owner chose this over one orchestrator skill (the earlier text of this decision): each job is visible and specific in the `/` menu, as Anthropic's guidance asks of a skill's name and description.
2. **Names: `zi-` plus the old name.** `zi` is the kit's prefix. It keeps every old name recognisable and keeps every kit skill clear of Claude Code's own names: `/plan`, `/review` and `/status` are built-in commands and `/run` is a bundled skill, which a skill of the same name replaces. Every future kit skill is `zi-` plus a plain name (lowercase letters, numbers, hyphens).
3. **Who starts them.** `disable-model-invocation: true` on every skill that no other kit skill hands work to (`zi-bootstrap`, `zi-implement`, `zi-sync`, `zi-dashboard`); only the human starts those. The others stay invocable by Claude, because one skill hands work to the next (`/zi-start` then `/zi-run`, `/zi-work` then the work type, `/zi-run` then a stage). A test checks the split against the text of the skills. The headless launcher starts lanes with `claude -p "/zi-run <slug>"`.
4. **Install: personal, one copy.** `install.sh` links `kit/skills/<name>/` into `~/.claude/skills/<name>/`, removes the kit's old files from `~/.claude/commands/` (links and `--copy` copies, kit files only), and prints the name map. Projects get no copy of these skills. A plugin is not used while plugin agents cannot carry hooks.
5. **Folder.** `kit/skills/zi-<name>/`. The subfolders `kit/skills/domains/` and `kit/skills/workflows/` stay reserved for the domain and workflow skills of OPERATING-MODEL §3, and `install.sh` skips them.
6. **Behaviour does not change.** Each skill keeps its command's text; only its name and the names it refers to change.
7. **OPERATING-MODEL §3 skill rules** (copied per project, hashed by `guards-present`, rejected by CI without a planted fault, an eval set or a `criteria` section) apply to domain and workflow skills. The 23 `zi-` skills are exempt: they are covered by the kit's own tests, the architecture map and the planted faults that already exercise the stages.
8. **The hybrid-factory blueprint** (branch `docs/hybrid-factory-adoption-blueprint`, draft) is superseded by 0016 and this decision and is not merged. It forbade a skills layer [blueprint L26, L111].

### Name map

Every command keeps its name with `zi-` in front: `/start` → `/zi-start`, `/run` → `/zi-run`, `/research` → `/zi-research`, `/plan` → `/zi-plan`, `/implement` → `/zi-implement`, `/review` → `/zi-review`, `/sync` → `/zi-sync`, `/retro` → `/zi-retro`, `/work` → `/zi-work`, `/new-feature` → `/zi-new-feature`, `/fix` → `/zi-fix`, `/ui` → `/zi-ui`, `/refactor` → `/zi-refactor`, `/docs` → `/zi-docs`, `/investigate` → `/zi-investigate`, `/security` → `/zi-security`, `/architecture` → `/zi-architecture`, `/migrate` → `/zi-migrate`, `/incident` → `/zi-incident`, `/new-skill` → `/zi-new-skill`, `/status` → `/zi-status`, `/dashboard` → `/zi-dashboard`, `/bootstrap` → `/zi-bootstrap`.

Short names in KIT-SPEC and OPERATING-MODEL (`/bootstrap`, `/status`, `/plan`) refer to the `zi-` skills.

## Consequences

Easier: each job is its own skill with its own description and tool list; no kit name can shadow or be shadowed by Claude Code; skill edits trigger the eval job (its smoke set tests the agents, not yet the skills).

Harder: everyone re-runs `install.sh` once and types `zi-` in front of each command; every reference to an old name changes in the same release (launcher prompt, script messages, the `command` field of the 11 workflow profiles, README, FIRST-PROJECT, tests); projects run `bootstrap.js --upgrade --all` so their CI messages use the new names. The text the 11 work-type skills share is still copied in each; moving it to one shared file is a separate step. Version 0.3.0.

Settled by the probe (`docs/research/claude-code-skill-probe.md`, Claude Code 2.1.327): `disallowed-tools` also strips the tool from subagents and outlasts the skill, so no kit skill uses it; a skill with `disable-model-invocation: true` runs when launched as `claude -p "/name"`; a symlinked skill folder is found; an `allowed-tools` pattern containing `"$PWD"` does not match, so the skills keep `Bash` (#63). Still to check by hand in the first real run: a skill with the flag starts when typed in an interactive session [anthropics/claude-code#26251 reports a refusal in the VS Code extension].

## Approval

Approved by: Jonathan Robles (via chat) on 2026-11-17 at b7ed48a; amended by him in chat on 2026-11-17 (names `zi-` plus the old name, one skill per job)
