# Design

- Updated: {{date}}
- Tokens file: `{{path}}` (source of truth; raw values in UI code fail lint)

## Tokens

| Group | Token | Value | Use |
|---|---|---|---|
| color | `{{token}}` | `{{value}}` | {{use}} |
| spacing | `{{token}}` | `{{value}}` | {{use}} |
| type | `{{token}}` | `{{value}}` | {{use}} |

## Components

| Component | Location | Variants | Notes |
|---|---|---|---|
| {{name}} | `{{path}}` | {{variants}} | {{rules}} |

## Patterns

- {{pattern}} — {{when to use, what not to do}}

## Reviewer checklist

- [ ] No raw colors, spacing, or font sizes outside the tokens file
- [ ] Existing component reused where one fits
- [ ] {{project-specific}}
