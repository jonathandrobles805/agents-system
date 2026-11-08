# Research: {{question}}

- Question: {{question}}
- Slug: {{slug}}
- Date: {{date}}
- Commit: {{commit}}
- Requested by: {{requested_by}}

## Findings

<!-- One bullet per claim. Every bullet ends with exactly one tag:
     [verified: path:START-END]   lines you read in this session; add a short quoted snippet in backticks
     [verified: cmd]              followed by a fenced block with the command and its output
     [docs: URL @ version]        official documentation at the pinned version from the lockfile
     [inferred: from F1,F2]       reasoning from tagged findings, listing their ids
     Hedge words (should, probably, likely, I think, assume) are not allowed here. -->

- F1. {{claim}} [verified: {{path}}:{{start}}-{{end}}] `{{snippet}}`

## What I could not verify

<!-- Each item is tagged [unknown] and names how to resolve it. Nothing here may be used as a basis for a decision. -->

- U1. {{item}} [unknown] Resolve by: {{method}}

## Confidence

{{High|Medium|Low}} — {{one sentence why}}

## Recommendation

{{what the planner should do with this, in terms of tagged findings}}

## Sources

- {{url or path}}
