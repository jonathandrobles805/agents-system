# 0018 The dashboard page is written in React and shipped as one committed, self-contained index.html

Date: 2026-11-23 · Status: accepted (amended 2026-11-23: items 7 and 9, from the build) · Depends on: 0007 (JavaScript with checked types) · Evidence: parity register `dashboard-app/PARITY.md` items #6–#8 and #73–#76, read from `kit/dashboard/index.html`, `kit/dashboard/server.js` and `kit/scripts/tests/dashboard.test.js` at 9b47008

## Context

`kit/dashboard/index.html` is 741 hand-written lines: an inline `<style>` and one inline module script that builds every screen from template strings and `innerHTML` [verified: kit/dashboard/index.html:7-181, :218-738]. Step 14 of the implementation plan grows this page into the full dashboard; string templates do not scale to that. The owner chose React.

Three things depend on the page being one self-contained file:
- `server.js` serves only `/`, `/index.html` and `/model.js`; every other path is a 404 [verified: kit/dashboard/server.js:441-453, :498].
- The project CI's Pages job copies only `index.html` next to `status.json` [verified: kit/ci/github.yml:214].
- The kit test "index html is self contained" forbids `<script src>`, `<link>`, CSS imports, remote media and CDNs, and requires the literal `import('./model.js')` [verified: kit/scripts/tests/dashboard.test.js:177-187].

The kit has no `dependencies` and installs with Node alone [verified: package.json].

## Decision

1. **Source.** The page's source is a React + TypeScript app in `dashboard-app/` at the repository root, outside `kit/`, so `install.sh` never copies it and the architecture map never scans it.
2. **Build.** Vite builds it with `vite-plugin-singlefile` into one `index.html` with every script and style inline. Vite cannot inline a build by itself; this plugin is the only option that leaves `server.js`, the CI job and the existing test untouched.
3. **Dev-only.** React, Vite, TypeScript, `vite-plugin-singlefile` and Playwright are dev dependencies of `dashboard-app/` only. The kit itself keeps no dependencies.
4. **Committed output.** The built `kit/dashboard/index.html` is committed. Installing and running the kit still needs only Node.
5. **Drift check.** A check rebuilds the page from source and diffs it byte for byte against the committed `kit/dashboard/index.html`; any difference fails. Without it, the source and the committed build drift apart unnoticed.
6. **`model.js` stays a runtime import.** The page keeps `import('./model.js')` at runtime, so Pages and `file://` keep falling back to "needs the live server" when the model cannot load. The literal string must survive minification; a check proves it.
7. **The original CSS ships verbatim**: the `<style>` block stays in `dashboard-app/index.html` exactly as in the original, so lines 1-181 of the built page are byte-identical to the original's (checked by `parity/check-build.js`). Importing it through Vite instead made the single-file plugin write `<style rel="stylesheet" crossorigin>`. The mount node is `<div id="root" style="display:contents">` holding the original's static markup, so the first paint is the same and `#arch` and `#worktrees` keep sizing against `body`.
8. **One deliberate difference.** React keeps keyboard focus across a re-render caused by a stream event; the original lost it. Logged in the register and asserted by a test.
9. **The model import is a classic script** in `index.html`, `<script vite-ignore>window.__kitModel = import('./model.js').catch(() => null);</script>`. Vite leaves it untouched, so the literal survives; a module-script import would be bundled or rewritten with double quotes by the minifier.

## Consequences

Easier: the dashboard grows by components instead of string templates; types catch shape errors in the status and manifest data.

Harder: a page change needs `npm ci` and a build in `dashboard-app/`, and the committed `index.html` is generated code that no one edits by hand; the drift check enforces it. Parity with the original is proven by the Playwright harness in `dashboard-app/parity/` before the original is replaced.

## Approval

Approved by: Jonathan Robles (via chat) on 2026-11-23 at 9b47008
