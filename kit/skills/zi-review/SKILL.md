---
name: zi-review
description: "Reviews a lane's pull request with a fresh reviewer that never saw the builder's conversation (a second one on high-risk specs), writes the review report and posts any fail list to the PR. Never merges. Use when a lane's PR is ready for review."
argument-hint: "<feature slug>"
allowed-tools: Bash, Read, Agent
arguments: [slug]
---

Review feature: `$slug`

## Step 1: locate
Worktree: `node -p 'require("./.claude/kit.json").lanes["$slug"].worktree'`. Record `HEAD=$(git -C <worktree> rev-parse HEAD)`. Read the spec's `Risk:` header.

## Step 2: reviewer
Spawn the `reviewer` agent with working directory = the worktree and exactly this input: "Review lane `$slug` at commit <HEAD>. Spec: docs/specs/$slug.md. Diff: `git diff <default branch>...HEAD`. Log: `.claude/session/$slug.log` while the worktree exists, or the committed copy `<work>/$slug.checks.txt` after it is gone. Events: docs/specs/$slug.events.jsonl. Progress: docs/specs/$slug.progress.md. Also read ARCHITECTURE.md, DESIGN.md, LESSONS.md. Write docs/specs/$slug.review.md with `- Head: <HEAD>`."

Give it nothing else: no summary of what was built, no excerpt of the implementer's output.

## Step 3: second reviewer on high-risk
If `Risk: high-risk`, spawn `reviewer` a second time with `model` overridden to a different model family when `.claude/kit.json` has `second_reviewer_model`, and this extra instruction: "Focus: security, data loss, auth, idempotency, secrets, and irreversible migrations. Write your rows as R20+ appended to the same report; do not change rows written by the first reviewer." Validate the merged report.

## Step 4: validate and route
```
node "$HOME/.claude/kit/scripts/validate_docs.js" docs/specs/$slug.review.md --repo <worktree>
```
A report that fails validation goes back to the reviewer with the violations.

Commit the review file (and the adversarial test) in the worktree and push. Then:
- Verdict FAIL: post the `## Fail list` section as a PR comment (`gh pr comment`), `lane.js roadmap-set $slug building`, `lane.js stage $slug build`, and spawn the `implementer` with only the fail list as input: "Fix exactly these items in lane `$slug`: <fail list>. Then stop." When it stops, run `/zi-review $slug` again. Count the round; after 3 FAIL rounds, set the lane to `escalated` and stop.
- Verdict PASS: `lane.js roadmap-set $slug ready-to-merge`. Tell the human the PR is ready and what CI shows, from `lane.js ci $slug` (not `gh pr checks`). This command never merges; a merge is `lane.js merge`, on the human's word.
