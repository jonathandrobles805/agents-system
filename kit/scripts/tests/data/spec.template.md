# Spec: Refund route

- Slug: refund-route
- Date: 2026-11-08
- Commit: {commit}
- Research: none
- Risk: high-risk
- Status: approved

## Summary

- Goal: expose refund over the routes module
- Files changed: 1
- Risks: payments
- Done when: refund route exists and is tested
- Open questions: none

## Goal

Add a refund entry to routes.

## Non-goals

- partial refunds

## Files to read first

- `src/domain/payment.ts` — the service [verified: src/domain/payment.ts:1-3]

## Files to change

- `src/api/routes.ts` — add refund next to charge [verified: src/api/routes.ts:3-3]

## Files to create

- `tests/routes.test.ts` — route tests

## Impact analysis

- `routes` has no external callers [verified: cmd]
  ```
  $ git grep -n "routes(" src tests
  src/api/routes.ts:2:export function routes(s: PaymentService) {
  ```

## Approach

Add a `refund` key delegating to the service.

## Data changes

- none

## New dependencies

- {deps}

## Done-criteria

| # | Criterion | Test |
|---|---|---|
| D1 | routes exposes refund | `tests/routes.test.ts::exposes refund` |

## Assumptions

- A1. routes returns a plain object [verified: src/api/routes.ts:3-3]

## Open questions

- none

## Architecture checklist

- [x] api depends on domain, never the reverse — routes imports the service only

## Critique

- C1. none → n/a

## Approval

Approved by: Jonathan Robles on 2026-11-08 at {commit}
{extra}