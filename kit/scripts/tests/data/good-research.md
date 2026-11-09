# Research: How does PaymentService charge?

- Question: How does PaymentService charge?
- Slug: payment-charge
- Date: 2026-11-08
- Commit: abc1234

## Findings

- F1. `PaymentService.charge` delegates to the db layer [verified: src/payment.ts:3-5] `return this.db.charge(userId)`
- F2. `charge` is called from the routes module [verified: cmd]
  ```
  $ git grep -n "charge(" src/
  src/routes.ts:3:s.charge('u1');
  ```
- F3. Stripe idempotency keys are required for safe retries [docs: https://stripe.com/docs/api/idempotent_requests @ 2024-06-20]
- F4. Therefore refunds and charges share the db dependency [inferred: from F1]

## What I could not verify

- U1. Whether `Db.charge` is transactional [unknown] Resolve by: read src/db.ts and the migration for the charges table

## Confidence

High — all findings cite lines read today.

## Recommendation

Extend `PaymentService` rather than adding a new class.

## Sources

- src/payment.ts
