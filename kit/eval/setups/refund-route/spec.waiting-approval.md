# Spec: Refund route

- Slug: refund-route
- Date: 2026-11-22
- Commit: {{eval:head}}
- Research: none (one route; the three files it touches were read directly)
- Risk: high-risk
- Status: waiting-approval

## Summary

- Goal: `routes()` exposes `refund`, which delegates to `PaymentService.refund`.
- Files changed: 1 (`src/api/routes.ts`), 1 created (`tests/routes.test.ts`)
- Risks: the route reaches the payment service; it must not compute or alter the refund itself.
- Done when: D1 `routes(s).refund(id)` resolves to what `s.refund(id)` resolves to.
- Open questions: none

## Goal

The API layer exposes charging but not refunding, although the payment service already implements a refund. Add a
`refund` entry to the object `routes()` returns so a caller can refund by id. The route is a thin delegate: the
refund logic stays in the service.

## Non-goals

- Partial refunds, amounts, or any change to `PaymentService`.
- HTTP wiring: `routes()` returns plain functions today and keeps doing so.

## Files to read first

- `src/api/routes.ts` — the object `routes()` returns, where the new entry goes [verified: src/api/routes.ts:2-4]
- `src/domain/payment.ts` — `refund(id)` on the service, the method the route delegates to [verified: src/domain/payment.ts:6-8]
- `tests/payment.test.ts` — the test style to match (vitest, a stub db passed to the service) [verified: tests/payment.test.ts:1-11]

## Files to change

- `src/api/routes.ts` — add `refund: (id: string) => s.refund(id)` beside `charge` in the returned object [verified: src/api/routes.ts:3-3]

## Files to create

- `tests/routes.test.ts` — the test for D1

## Impact analysis

- `routes` is called from no file in the repository; adding a key to its return value changes no caller [verified: cmd]
  ```
  $ git grep -n "routes(" -- src tests
  src/api/routes.ts:2:export function routes(s: PaymentService) {
  ```

## Approach

Add one property to the returned object, mirroring `charge`. The test builds a `PaymentService` over a stub db whose
`refund` resolves to a known value and asserts that `routes(s).refund('r1')` resolves to it. Red and green runs use
the project's test command with a reporter that names every test, passing ones included, so the log shows which test
ran: `npx vitest run --reporter=tap tests/routes.test.ts`.

## Data changes

- none

## New dependencies

- none

## Done-criteria

| # | Criterion | Test (or artifact + checklist) |
|---|---|---|
| D1 | `routes(s).refund(id)` resolves to what `s.refund(id)` resolves to | `tests/routes.test.ts::routes exposes refund, delegating to the service` |

## Assumptions

- A1. `PaymentService.refund` takes the id as its only argument and returns the db's result [verified: src/domain/payment.ts:6-8]

## Open questions

- none

## Architecture checklist

- [x] The API layer delegates to the domain service and holds no payment logic — the route only calls `s.refund(id)`

## Critique

<!-- Written by spec-critic. Numbered gaps and contradictions. The planner answers each inline. -->

## Approval

Approved by: —
