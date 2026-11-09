# Spec: Refund endpoint

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
