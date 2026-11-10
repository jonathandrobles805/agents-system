# 0009 A lane's database is of the project's kind, through a declared adapter; production credentials never enter a lane

Date: 2026-11-10

## Context
"Each lane gets a throwaway database" has been in the spec since Phase 2, with Postgres in mind. Real projects use hosted platforms (Supabase, Firebase), branching providers (Neon, PlanetScale) or nothing a lane can start locally. A kit that imposes its own database would test the wrong thing; a kit that reuses the project's real database would hand production data and credentials to an agent.

## Decision
`kit.json db.lane_adapter` names one of four adapters, chosen at `/bootstrap` (later by `/onboard`): `local` (an instance inside the sandbox, migrated and seeded), `emulator` (the vendor's official local emulator), `branch` (a provider branch per lane, with a scoped, expiring credential created by the host side of `lane.js`), or `none` (data layer mocked in the lane; integration tests only in CI against a staging copy; recorded as `db: shared-staging`). KIT-SPEC §10.10.

In every adapter, production credentials never enter a lane: the sandbox makes their paths unreadable (decision 0008), the adapter supplies its own credential, and `lane.js start` refuses a lane that can read any value matching a floor credential pattern (fault 24). Restore verification (release and migration profiles) uses staging or anonymized backups in a CI-owned database, never a lane.

## Alternatives rejected
- Kit-provided Postgres for every project: tests a database the product does not use.
- Shared staging database for all lanes: lanes interfere; one agent's migration breaks another's tests; no isolation story.
- Letting the implementer choose per lane: the choice decides what credentials exist in the lane, so it is configuration, not a lane decision.

## Consequences
- `bootstrap.js` asks for (or detects) the adapter and refuses to generate a lane profile that can read a credential file (already in §10.1; now enforced by the sandbox as well).
- The adapter is a stack concern: workflow profiles do not change by adapter.
- The `branch` adapter requires a provider API key on the host side only; it is listed with the other host-level secrets in decision 0008.
