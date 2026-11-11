# 0010 Cost and tokens come from Claude Code's OpenTelemetry export only; the kit never estimates

Date: 2026-11-10

## Context
The kit shows cost per lane on the dashboard and uses a monthly cap. The events log the hooks write knows tool calls and durations but not tokens or prices; a number derived from it would be a guess with a dollar sign. Claude Code exports its own usage over OpenTelemetry: a `claude_code.api_request` event per model call with `cost_usd`, token counts, model and duration, and a `claude_code.cost.usage` metric. Anthropic documents that figure as approximate and meant for trends, not billing.

## Decision
1. The only source of a cost or token figure anywhere in the kit is the OpenTelemetry export, received by `kit/telemetry/collector.js` and read by `kit/scripts/metrics.js`. KIT-SPEC §9.4.
2. The lane launcher turns the exporter on for every lane session and tags records with `kit.project`, `kit.lane`, `kit.stage` through `OTEL_RESOURCE_ATTRIBUTES`, so attribution needs no inference.
3. A lane with no telemetry records shows `null` and `source: telemetry-missing`. Nothing fills the gap: not the events log, not a tokens-per-call average, not a model price table.
4. The figure is shown as Claude Code's figure, with its caveat, and is never adjusted or presented as an invoice. Budgets stay in hours and tool calls, which hooks can count exactly; the cost cap reads the telemetry figure.

## Alternatives rejected
- Estimating from the events log with a price table: a guess that looks like a fact; the dashboard's credibility rests on every number tracing to a source.
- Reading the account's billing API: not available per lane, lags by hours, and needs a credential a lane must never hold.
- Leaving cost out: the cap and the eval harness need it.

## Consequences
- Planted faults 28 (exporter off → flagged, not estimated) and 29 (shown figure equals the exporter's, to the cent).
- The collector writes under `$CLAUDE_HOME/kit-telemetry/`, outside every worktree; a lane cannot edit its own cost.
- The sandbox allowlist gains the collector's localhost endpoint.
