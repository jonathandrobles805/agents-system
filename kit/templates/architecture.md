# Architecture

- Updated: {{date}}

## Layers

<!-- Top depends on bottom, never the reverse. Enforced by the import-boundary lint. -->

| Layer | Directories | May import from |
|---|---|---|
| {{ui}} | `{{dirs}}` | {{application}} |
| {{application}} | `{{dirs}}` | {{domain}} |
| {{domain}} | `{{dirs}}` | nothing in the app |
| {{infrastructure}} | `{{dirs}}` | {{domain}} |

## Invariants

<!-- Copied into every spec's Architecture checklist. -->

- [ ] {{invariant, stated so it can be checked}}

## High-risk paths

<!-- Any spec touching these is flagged high-risk and gets a second reviewer. -->

- `{{path}}`

## Rollout and rollback

- Feature flags: {{library or mechanism}}
- Canary: {{how}}
- Rollback: `{{command}}`
