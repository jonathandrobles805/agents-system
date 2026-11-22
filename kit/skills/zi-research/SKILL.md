---
name: zi-research
description: "Answers the questions a feature or topic needs before planning, one researcher per question, reusing or re-checking research that already exists. Writes only research files. Use before /zi-plan, or on a topic of its own."
argument-hint: "<topic or feature slug> [question 1; question 2; ...]"
allowed-tools: Bash, Read, Agent
---

Research for: $ARGUMENTS

## Step 1: questions
If the arguments contain `;`-separated questions, use them. Otherwise derive 2–4 concrete questions that a planner would need answered before writing a spec for this topic: how the relevant existing code works (name the module), how any external API or library behaves at the pinned version, what calls what, what tests exist. Each question must be answerable with evidence; no "is it a good idea" questions.

## Step 2: check the index before spawning anything
For each question:
```
kit lane index lookup "<question>" --repo "$PWD" --json
```
- `reuse`: do not research again. Note the slug.
- `reverify`: spawn a `researcher` with the instruction "re-verify only the citations in docs/research/<slug>.md that touch <stale files>; keep every other finding; write the same file; bump the Commit".
- `new`: spawn a `researcher` with the question, a slug (kebab-case, ≤ 40 chars), the current commit (`git rev-parse --short HEAD`), and the output path `docs/research/<slug>.md`.

Spawn all researchers in parallel in one turn. Do not answer the questions yourself.

## Step 3: register
When each researcher finishes, add its row:
```
kit lane index add "<question>" --repo "$PWD" --slug <slug> --keywords "<5-8 words>" --files "<files cited, comma-separated>" --commit <short sha>
```
Then run `kit validate_docs docs/research/<slug>.md --repo "$PWD"` for each new file. A file that fails goes back to its researcher with the violation list; it is not registered until it passes.

## Step 4: report
List: reused, re-verified, new, and every `[unknown]` across the new files with its resolution method. Set the feature's ROADMAP status: `kit lane roadmap-set <slug> researching --repo "$PWD"` if a slug was given. Do not write a spec.
