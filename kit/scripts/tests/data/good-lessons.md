# Lessons

## Debt

- none

## 2026-11-08 — refund-endpoint — webhook handlers were not idempotent

- What went wrong: the first implementation processed a retried webhook twice.
- Root cause: nothing checked for an idempotency key.
- Rule: every webhook handler must be idempotent on the provider event id.
- Enforced by: test
- Proposed change: kit/templates/tests/webhook-idempotency.test.ts added to spec template for any handler under src/webhooks
- Status: approved
