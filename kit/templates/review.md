# Review: {{feature}}

- Spec: `docs/specs/{{slug}}.md`
- Diff: `{{base}}..{{head}}`
- Head: {{head sha}}
- Reviewer: {{agent name and model}}
- Date: {{timestamp}}

## Scope

- Files in diff: {{n}}; files in spec allow-list: {{n}}; outside allow-list: {{list or none}}

## Checklist

<!-- Every row is PASS or FAIL with evidence (file:line, log line, or command output). A row with no evidence is invalid. -->

| # | Check | Result | Evidence |
|---|---|---|---|
| R1 | Every done-criterion has a named test | {{PASS|FAIL}} | {{evidence}} |
| R2 | Every test has a red run and a green run in the log | {{PASS|FAIL}} | {{evidence}} |
| R3 | Reviewer re-ran the suite; result matches the log | {{PASS|FAIL}} | {{evidence}} |
| R4 | Every changed file is in the spec allow-list | {{PASS|FAIL}} | {{evidence}} |
| R5 | No assertion removed, no test skipped, without a spec note | {{PASS|FAIL}} | {{evidence}} |
| R6 | Import boundaries respected | {{PASS|FAIL}} | {{evidence}} |
| R7 | Design tokens respected, no raw values | {{PASS|FAIL}} | {{evidence}} |
| R8 | New dependencies all declared in spec | {{PASS|FAIL}} | {{evidence}} |
| R9 | Data changes reversible or signed off | {{PASS|FAIL}} | {{evidence}} |
| R10 | progress.md complete and consistent with log | {{PASS|FAIL}} | {{evidence}} |
| R11 | Adversarial test written from the spec passes | {{PASS|FAIL}} | {{evidence}} |

## Adversarial tests added

- `{{test file}}::{{test name}}` — {{what it probes}}

## Fail list

<!-- One entry per FAIL. All four fields required. The implementer receives only this section. -->

- {{R#}} `{{file}}:{{line}}` — rule: {{which rule}} — passing looks like: {{concrete description}}

## Verdict

{{PASS | FAIL}}
