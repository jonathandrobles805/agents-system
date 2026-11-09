from conftest import run_script
from test_validate_docs import write

GOOD_SPEC = """# Spec: Refund endpoint

- Slug: refund-endpoint
- Date: 2026-11-08
- Commit: abc1234
- Research: payment-charge
- Risk: high-risk
- Status: draft

## Summary

- Goal: add a POST /refunds route that calls PaymentService.refund
- Files changed: 2 (src/routes.ts, src/payment.ts)
- Risks: touches payments
- Done when: refund route returns 200 and calls refund once
- Open questions: none

## Goal

Expose refunds over HTTP using the existing service.

## Non-goals

- Partial refunds

## Files to read first

- `src/payment.ts` — the service we extend [verified: src/payment.ts:1-9]
- `src/routes.ts` — where routes are registered [verified: src/routes.ts:1-3]

## Files to change

- `src/routes.ts` — add the refund route after the charge call [verified: src/routes.ts:3-3] `s.charge('u1')`

## Files to create

- `src/__tests__/refund.test.ts` — route tests

## Impact analysis

- `PaymentService.refund` has no callers today [verified: cmd]
  ```
  $ git grep -n "refund(" src/
  src/payment.ts:6:  async refund(id: string) {
  ```

## Approach

Register the route; delegate to the existing method; return its result.

## Data changes

- none

## New dependencies

- none

## Done-criteria

| # | Criterion | Test |
|---|---|---|
| D1 | POST /refunds with a valid id returns 200 | `src/__tests__/refund.test.ts::returns 200` |
| D2 | refund is called exactly once | `src/__tests__/refund.test.ts::calls refund once` |

## Assumptions

- A1. Routes are plain function calls on a shared service instance [verified: src/routes.ts:2-3]

## Open questions

- none

## Architecture checklist

- [x] Routes depend on services, never the reverse — the route imports the service only

## Critique

- C1. No negative test for an unknown id → added D3 in a follow-up spec (non-goal here)

## Approval

Approved by: — on — at —
"""


def test_good_spec_passes(repo):
    p = write(repo, "docs/specs/refund-endpoint.md", GOOD_SPEC)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 0, r.stderr


def test_open_question_fails(repo):
    bad = GOOD_SPEC.replace("## Open questions\n\n- none", "## Open questions\n\n- Does refund need auth?")
    p = write(repo, "docs/specs/refund-endpoint.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "open-questions" in r.stderr


def test_inferred_in_files_to_change_fails(repo):
    bad = GOOD_SPEC.replace(
        "- `src/routes.ts` — add the refund route after the charge call [verified: src/routes.ts:3-3] `s.charge('u1')`",
        "- `src/routes.ts` — add the refund route [inferred: from A1]",
    )
    p = write(repo, "docs/specs/refund-endpoint.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "tag-not-allowed" in r.stderr


def test_done_criteria_without_test_fails(repo):
    bad = GOOD_SPEC.replace("| `src/__tests__/refund.test.ts::returns 200` |", "| works |")
    p = write(repo, "docs/specs/refund-endpoint.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "done-criteria-no-test" in r.stderr


def test_artifact_done_criteria_allowed(repo):
    ok = GOOD_SPEC.replace(
        "| `src/__tests__/refund.test.ts::returns 200` |",
        "| artifact: docs/design/refund-flow.png, checklist: DESIGN.md#reviewer-checklist |",
    )
    p = write(repo, "docs/specs/refund-endpoint.md", ok)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 0, r.stderr


def test_risk_flag_required_when_touching_payments(repo):
    bad = GOOD_SPEC.replace("- Risk: high-risk", "- Risk: low")
    p = write(repo, "docs/specs/refund-endpoint.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "risk-flag" in r.stderr


def test_approved_status_requires_approval_line(repo):
    bad = GOOD_SPEC.replace("- Status: draft", "- Status: approved")
    p = write(repo, "docs/specs/refund-endpoint.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "approval-line" in r.stderr
    good = bad.replace("Approved by: — on — at —", "Approved by: Jonathan Robles on 2026-11-08 at abc1234")
    p = write(repo, "docs/specs/refund-endpoint.md", good)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 0, r.stderr


def test_unanswered_architecture_checklist_fails(repo):
    bad = GOOD_SPEC.replace("- [x] Routes depend on services", "- [ ] Routes depend on services")
    p = write(repo, "docs/specs/refund-endpoint.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "checklist-unanswered" in r.stderr


def test_empty_allow_list_fails(repo):
    bad = GOOD_SPEC.replace(
        "- `src/routes.ts` — add the refund route after the charge call [verified: src/routes.ts:3-3] `s.charge('u1')`\n", ""
    )
    p = write(repo, "docs/specs/refund-endpoint.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "empty-allow-list" in r.stderr


GOOD_REVIEW = """# Review: Refund endpoint

- Spec: `docs/specs/refund-endpoint.md`
- Diff: `main..wt/refund-endpoint`
- Reviewer: reviewer (sonnet)
- Date: 2026-11-08T15:00:00

## Scope

- Files in diff: 2; files in spec allow-list: 2; outside allow-list: none

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| R1 | Every done-criterion has a named test | PASS | refund.test.ts:4 and :12 |
| R2 | Red and green runs in log | PASS | refund-endpoint.log#14 (2 failed), #41 (2 passed) |
| R3 | Reviewer re-ran suite | PASS | `vitest run` 14 passed, matches log#41 |
| R4 | Changed files in allow-list | PASS | git diff --name-only: routes.ts, refund.test.ts |
| R5 | No assertion removed | PASS | diff adds 6 expect(), removes 0 |
| R6 | Import boundaries | PASS | depcruise: 0 violations |
| R7 | Design tokens | PASS | no UI files changed |
| R8 | Dependencies declared | PASS | lockfile unchanged |
| R9 | Data changes | PASS | none in spec, none in diff |
| R10 | progress.md complete | PASS | D1, D2 green refs present |
| R11 | Adversarial test | PASS | refund.test.ts:20 unknown id returns 404 |
| R12 | High-risk behind flag | PASS | flags.ts:12 REFUNDS_V2 gates the route |

## Adversarial tests added

- `src/__tests__/refund.test.ts::unknown id returns 404` — probes the missing negative case from the critique

## Fail list

- none

## Verdict

PASS
"""


def test_good_review_passes(repo):
    p = write(repo, "docs/specs/refund-endpoint.review.md", GOOD_REVIEW)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 0, r.stderr


def test_pass_without_evidence_fails(repo):
    bad = GOOD_REVIEW.replace("| PASS | depcruise: 0 violations |", "| PASS | ok |")
    p = write(repo, "docs/specs/refund-endpoint.review.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "checklist-no-evidence" in r.stderr


def test_fail_row_needs_fail_list_entry_and_verdict(repo):
    bad = GOOD_REVIEW.replace("| R4 | Changed files in allow-list | PASS |", "| R4 | Changed files in allow-list | FAIL |")
    p = write(repo, "docs/specs/refund-endpoint.review.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "fail-not-listed" in r.stderr and "verdict-mismatch" in r.stderr
    fixed = bad.replace("## Fail list\n\n- none", "## Fail list\n\n- R4 `src/orders/refund.ts:1` — rule: file not in spec allow-list — passing looks like: remove the file or amend the spec and re-approve").replace("## Verdict\n\nPASS", "## Verdict\n\nFAIL")
    p = write(repo, "docs/specs/refund-endpoint.review.md", fixed)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 0, r.stderr


def test_fail_entry_missing_fields_fails(repo):
    bad = GOOD_REVIEW.replace("| R4 | Changed files in allow-list | PASS |", "| R4 | Changed files in allow-list | FAIL |") \
        .replace("## Fail list\n\n- none", "## Fail list\n\n- R4 scope creep, remove it").replace("## Verdict\n\nPASS", "## Verdict\n\nFAIL")
    p = write(repo, "docs/specs/refund-endpoint.review.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "fail-entry" in r.stderr


GOOD_LESSONS = """# Lessons

## Debt

- none

## 2026-11-08 — refund-endpoint — webhook handlers were not idempotent

- What went wrong: the first implementation processed a retried webhook twice.
- Root cause: nothing checked for an idempotency key.
- Rule: every webhook handler must be idempotent on the provider event id.
- Enforced by: test
- Proposed change: kit/templates/tests/webhook-idempotency.test.ts added to spec template for any handler under src/webhooks
- Status: approved
"""


def test_good_lessons_pass(repo):
    p = write(repo, "LESSONS.md", GOOD_LESSONS)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 0, r.stderr


def test_enforced_lesson_without_change_fails(repo):
    bad = GOOD_LESSONS.replace("- Proposed change: kit/templates/tests/webhook-idempotency.test.ts added to spec template for any handler under src/webhooks", "- Proposed change: none")
    p = write(repo, "LESSONS.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "lesson-no-change" in r.stderr


def test_text_only_lesson_needs_reason(repo):
    bad = GOOD_LESSONS.replace("- Enforced by: test", "- Enforced by: text-only").replace(
        "- Proposed change: kit/templates/tests/webhook-idempotency.test.ts added to spec template for any handler under src/webhooks", "- Proposed change: none")
    p = write(repo, "LESSONS.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2 and "lesson-debt-reason" in r.stderr
