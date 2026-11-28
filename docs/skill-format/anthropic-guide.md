# What Anthropic's docs say, and what it means for us

Read part by part. Each part: the rules, then how our skills compare.

## Part 1. Agent Skills overview

Source: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview (read 2026-11-25)

| Rule | Ours | Status |
|---|---|---|
| Loads in 3 levels: name + description always (~100 tokens each); SKILL.md body when triggered; extra files only when opened | 23 descriptions always loaded | OK |
| SKILL.md body under 5k tokens (~20k characters) | largest: zi-run, 9.6k characters (~2.5k tokens) | OK |
| Description says what it does and when to use it | all do | OK |
| `name`: lowercase, digits, hyphens; ≤64 characters; no `claude` or `anthropic` | `zi-*` | OK |
| Scripts: only their output enters context, never their code | `kit lane` | OK |
| Template sections: `# Title`, `## Instructions`, `## Examples` | no examples anywhere | Missing |
| Claude Code skills live in `.claude/skills/` (project) or `~/.claude/skills/` (personal) | installed from `kit/skills` | OK |

## Part 2. Skill authoring best practices

Source: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices (read 2026-11-25)

| Rule | Ours | Status |
|---|---|---|
| Concise: "Claude is already very smart"; every line must earn its tokens | table rows up to ~1,500 characters | Fix (S8) |
| Low freedom for fragile steps: exact command + "do not modify the command" | commands exact, buried in paragraphs | Fix (S5, S8) |
| Body under 500 lines; split into files one level deep only | ≤60 lines, no extra files | OK |
| Workflows as numbered steps, with a checklist Claude can copy and tick | one table | Fix (S8) |
| Feedback loop: run check → fix → repeat; "only proceed when it passes" | in prose ("run next-step again") | Fix: make it a step |
| One word per concept | zi-run mixes "feature" (5) and "lane" (58) | Fix: pick one per meaning |
| Default + one escape hatch, not a list of options | mostly OK | Check each skill |
| Concrete examples (input → output) | none | Missing |
| No time-sensitive text | to check per skill | Check |
| "Run X" vs "see X" made explicit | mostly "run" | OK |
| Description: third person, what + when, key terms | yes | OK |
| Name: gerund preferred, `zi-run` style acceptable | `zi-` + verb | OK (rename not worth the break) |
| Evaluations first: ≥3 per skill, baseline without skill, test on Haiku, Sonnet, Opus | evals exist per agent (`kit/eval/benchmarks`, 7 agents), none per skill | Missing |
| Iterate: one Claude writes the skill, a fresh one uses it, watch where it goes wrong | not done | Add to the process |
