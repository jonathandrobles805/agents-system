# Goal: {{feature}}

- Slug: {{slug}}
- Date: {{date}}
- Agreed by: {{human name}} and Claude on {{date}}
- Status: {{agreed|running|done}}
- Work type: {{feature|fix|ui|refactor|docs|investigation|security|architecture|migration|incident}}
- Risk: {{normal|high}}
- Size: {{S|M|L}}
- Domain: {{comma-separated domain skills, e.g. api, db}}

<!-- Work type selects the workflow profile (kit/workflows/<type>.json); the controller refuses an unknown one.
     Size: S = one domain, no interface/schema/data change, no new dependency; M = two domains or one such change; L = more.
     Size changes research width and whether the critic runs; it never removes a stage risk adds. Risk high adds threat model,
     second reviewer and security sign-off, and requires the container sandbox. /work fills these provisionally. -->

## What we want

{{two to five sentences, in the human's words, of the end state}}

## Who it is for

- {{user or system that benefits, and how they will notice}}

## Done looks like

<!-- Observable outcomes. These become the spec's done-criteria. -->

- G1. {{observable outcome}}
- G2. {{observable outcome}}

## Not in this goal

- {{explicitly excluded}}

## Constraints

- {{must use X / must not change Y / performance / compatibility / deadline}}

## Open points settled during discussion

- {{question that came up}} → {{what we decided}}
