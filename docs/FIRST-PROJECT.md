# Running the kit on your first real project

This is the step where the agents run for real for the first time. Everything before this was proven with scripts; this run proves the researcher, planner, implementer, and reviewer under the hooks. Plan for two short sessions with you present: one to bootstrap and approve a spec, one to merge and run the retro.

## 0. Prerequisites (10 minutes, once per machine)

```
git clone https://github.com/jonathandrobles805/agents-system ~/agents-system
~/agents-system/install.sh
(cd ~/agents-system && npm test)                             # 124 tests
node ~/agents-system/planted-faults/run.js               # 19/19
```
Requirements: Claude Code, git, Node 20+, `gh` logged in. In Claude Code, `/agents` should list the six kit agents and `/help` the nine commands.

## 1. Pick the project and freeze the drift (you, 20 minutes)

Choose a repo that is small enough to finish one feature in a day. In it:
- List open branches and worktrees. Merge what is mergeable, delete what is dead, note what must be synced. Lanes should not start on top of two-week-old divergence.
- Make sure `main` is green, or know why it is red.

## 2. Bootstrap (together, 15 minutes)

In the repo, in Claude Code: `/kit-setup`.
It will detect the stack and ask you five things it refuses to guess: milestones and the first features, the WIP limit (start with 1), the architecture layers and invariants, the high-risk paths, and whether the detected commands are right. Answer; it generates the project layer and opens a PR. Merge it. From that merge, the hooks and CI are live for every session in the repo.

Then `/kit-dashboard`. You should see every feature queued and nothing in flight.

## 3. First feature, start to finish

Pick the smallest real feature on the roadmap: one that changes two or three files and has obvious tests.

1. `/kit research <slug>` — watch the dashboard: researchers appear as subagent events; files land in `docs/research/`. Read one. Every finding has a tag and a line number you can check.
2. `/kit plan <slug>` — the planner writes the spec, the critic adds items, the planner answers them. It opens a `spec/<slug>` PR. Read the Summary and the Files to change. Fix anything wrong in the PR itself. Set `Status: approved`, fill the approval line, merge.
3. `/kit implement <slug>` — a worktree appears under `../<repo>-lanes/<slug>`. On the dashboard, the lane sits on Build; events stream: reads, a blocked edit if it strays, red test runs, green runs. Do not help it. If it escalates, read the Escalation section; that is the system telling you what it needs.
4. `/kit review <slug>` runs automatically after the implementer stops green. The lane moves to Review. If the verdict is FAIL, the fail list goes to the PR and the implementer fixes exactly those items. When PASS and CI is green, the lane moves to "You merge".
5. Merge the PR. `/kit retro <slug>`. Accept, edit, or drop each proposed lesson. Anything accepted becomes a check or is listed as debt.

## 4. What to look at afterwards

- `LESSONS.md`: did the retro propose a real check, or only text?
- `docs/specs/<slug>.events.jsonl`: how many `blocked` events? Each one is a mistake that did not reach the code.
- `.claude/session/`: the read logs and counters the hooks used.
- The dashboard's Health tiles: text-only debt, CLAUDE.md size, bootstrap TODOs still open.

## 5. Known rough edges to expect

- The first `/kit-setup` on a stack with unusual tooling will mis-detect a command; correct it when asked.
- A hook that runs the full test suite after every edit is slow on large projects; set `commands.test_affected` in `.claude/kit.json`.
- `/kit review` on `high-risk` runs a second reviewer only if `.claude/kit.json` has `second_reviewer_model`.
- Two unknowns from `docs/research/claude-code-features.md` get answered here: SubagentStop input fields (U1) and Stop-hook behavior headless (U2). Note what you see.

## 6. Second project

Repeat on a repo with a different stack. Whatever breaks is a kit issue, fixed in the kit and pushed to both projects with `/kit-setup --upgrade`.
