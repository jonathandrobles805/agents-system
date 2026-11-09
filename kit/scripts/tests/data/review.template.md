# Review: Refund route

- Spec: `docs/specs/refund-route.md`
- Diff: `main..{head}`
- Head: {head}
- Reviewer: reviewer (opus)
- Date: 2026-11-08T16:00:00

## Scope

- Files in diff: 2; files in spec allow-list: 2; outside allow-list: none

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| R1 | Every done-criterion has a named test | PASS | tests/routes.test.ts:2 |
| R2 | Red and green runs in log | PASS | refund-route.log#3, #12 |
| R3 | Reviewer re-ran suite | PASS | vitest run: 3 passed |
| R4 | Changed files in allow-list | PASS | git diff --name-only: routes.ts, routes.test.ts |
| R12 | High-risk behind flag | PASS | flags.ts:3 REFUND_ROUTE gates it |

## Adversarial tests added

- `tests/routes.test.ts::refund rejects empty id` — negative case

## Fail list

- none

## Verdict

{verdict}
