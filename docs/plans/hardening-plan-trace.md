# Hardening plan: traceability

Every rule in `docs/plans/hardening-plan.md` is listed once, with the line in `docs/decisions/0016-direction-vs-reference-factory.md` (as amended on this branch) that states it, the plan step that builds it, and what proves it. A rule with no 0016 line, or a 0016 amendment with no rule here, is a defect in this pair of documents.

Line numbers refer to 0016 on branch `docs/0016-amendments-e6-e8`. "Fault" names a row of the plan's planted-fault table.

## Decisions (plan: Decisions taken)

| ID | Rule in the plan | 0016 line | Step | Proof |
|---|---|---|---|---|
| Q1a | Agents' identity is a GitHub App, used only to push lane branches and open PRs | 277, 278 (E.7 items 1–2); 197 note | 1 | Faults: App merges without approval; App pushes outside `lane/*` |
| Q1b | Every lane that pushes runs in the container, attended or not, with limited network | 281 (E.7 item 5); 198 note | 8 | Fault: the four in-lane attempts |
| Q2 | This repo follows the same rule as projects; the App opens its PRs; the most-recent-push rule stays off; GitHub Pro needed | 280 (E.7 item 4); 197 note | 1 | Step 1 done-when: you can approve and merge the App's PR on this repo |
| Q3 | Automatic spec approval dropped; every spec pauses for you | 191 (Keep: the spec-first pause) | — | No change to build |
| Q4 | License closed: personal, private use; nothing copied from the reference | 345 (Open question 1); notes at 13, 334, 341 | — | No change to build |
| Q5 | Reviewer reports start with `<reviewer>: PASS` or `FAIL`; the rest of #56 S2–S8 stays open | 263 (E.6 item 4) | 9 | Fault: report without a verdict line |

## Design decisions D1–D5 and the plan's additions

| ID | Rule in the plan | 0016 line | Step | Proof |
|---|---|---|---|---|
| D1.1 | The App works in one layer, from your machine, outside the container; not used for local work, CI, or your approval and merge | 278 (E.7 item 2) | 1 | Fault: App merges without approval |
| D1.2 | App permissions: contents and pull requests, write; installed on chosen repos | 277 (E.7 item 1) | 1 | Step 1 read-back |
| D1.3 | A ruleset lets the App push only `lane/*` | 279 (E.7 item 3) | 1 | Fault: App pushes outside `lane/*` |
| D1.4 | Protection: 1 approval, `enforce_admins`, no force push or deletion, real check names, CODEOWNERS additions | 280 (E.7 item 4); 197 (E.1 Add 4) | 1 | Faults: App merges without approval; App pushes to `main` |
| D1.5 | The approval line is written by `lane.js` from your GitHub review; no agent writes it | 295 (E.8 item 6) | 1 | Fault: agent writes the approval line |
| D1.6 | Limit: no second human, unlike Copilot | 285 (E.7 Limit) | — | Stated limit |
| D2.1 | `lane.js advance` is the only writer of the store; one table of allowed moves; the dashboard reads the store | 194 (E.1 Add 1); 206 (E.2 step 2) | 2 | Fault: illegal stage move |
| D2.2 | Rounds and wall time replace tool-call budgets; a round is build, gate, review; a FAIL ends it | 199 (E.1 Add 6); 297 (E.8 item 8) | 2 | Fault: round past the limit |
| D2.3 | Lanes may not run the state-changing scripts (E.4) | 226 (E.4); 296 (E.8 item 7) | 2 | Fault: lane agent runs `advance`, `gate` or a merge |
| D2.4 | #63 first: a `kit` launcher on `PATH`; every rule proven to match by a probe or a planted fault | 296 (E.8 item 7) | 2 | Fault: permission rule that doesn't match |
| D3 | Lane start fails closed, records the base commit, `local_only` for repos without a remote; test fixtures updated | 293 (E.8 item 4) | 2 | Fault: lane start with no `origin` or a failed fetch |
| D4.1 | The gate fails on protected-file changes (#56 S1.3) | 290 (E.8 item 1) | 3 | Fault: lane edits `kit.json` or a `package.json` script |
| D4.2 | The gate runs contained, with a time limit and stdin closed (#56 S1.4) | 291 (E.8 item 2) | 3 | Fault: a check that hangs |
| D4.3 | Risk re-check against the actual diff | 292 (E.8 item 3) | 3 | Fault: glob hides a high-risk path |
| D5 | Specialist reviewers, rulebooks, routing from the diff, our own names, targets #33, #34, #49 | 244–270 (E.6) | 9 | Faults: the four reviewer faults |
| A5 | Required checks use the real job names | 294 (E.8 item 5) | 1 | Fault: required name no job reports |
| A8 | One watched real run right after the gate | 298 (E.8 item 9) | 4 | Issues filed from the run |

## Steps (plan: The plan, in order)

| ID | Rule in the plan | 0016 line | Step | Proof |
|---|---|---|---|---|
| S0 | Finish the skills move (0017, PR #62) and merge this PR | 233–242 (E.5); 0017 | 0 | Canary run; headless `/zi-run` start |
| S1 | Judge: test project on GitHub, App, protection, real check names, read-back | 205 (E.2 step 1); 277–280; 294 | 1 | Step 1 faults |
| S2 | Spine: `advance`, store, rounds, E.4, #63, #57–#59, fail-closed start | 206; 194; 199; 226; 242; 293; 296; 297 | 2 | Step 2 faults |
| S3 | Gate from the base `kit.json`, tied to the commit, no reviewer on FAIL, re-run after sync; done-check reads the verdict; D4 checks | 195; 207; 290–292 | 3 | Step 3 faults |
| S4 | One watched real run | 298 | 4 | Issues filed |
| S5 | CI reads scope from base, recomputes the red run, demotes the review report; #56 CI scripts fetch the base | 196; 208; 299 | 5 | Step 5 faults |
| S6 | Planted faults first; KIT-SPEC rows 39–45 | 209; 299 | 6 | Fault table re-pointed |
| S7 | Delete E.1's list; keep the guard hooks | 189; 191; 210; 127–140 (C.2) | 7 | Each deletion with its fault passing |
| S8 | Container for every pushing lane; probes P4 and P2-full; covers #55 | 198; 211; 230; 281 | 8 | Fault: the four in-lane attempts |
| S9 | Specialist reviewers built after E.6 is merged | 244–270; 268 | 9 | Reviewer faults |
| S10 | Dashboard: Runs view, drawer with `## Summary`, live strip with `agent_id`, work-root events, lane list from the store | 173–179 (D.3); 170–171 (D.2 items 6–7); 212 | 10 | Display only |
| S11 | Two field runs re-prove the system | 341 (Consequences) | 11 | Both runs finish clean |

## Known limits (plan: Known limits, cost and speed)

| ID | Rule in the plan | 0016 line | Step | Proof |
|---|---|---|---|---|
| K1 | No second human | 285 | — | Stated limit |
| K2 | #46 persists as a guardrail | 114 (C.1) | — | Stated limit |
| K3 | #33, #34, #49 persist; reviewers reduce them | 101, 102, 117 (C.1); 248 (E.6 Why) | 9 | Reviewer faults |
| K4 | Open questions 2 and 3 stay open; 4 no longer matters | 346, 347; 281 (E.7 item 5) | 7, 5 | Checked in those steps |
| K5 | #56 S2 and S4–S8 stay undecided | 263 (E.6 item 4) | — | Stated limit |
