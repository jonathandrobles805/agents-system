# Parity register: kit/dashboard/index.html → React

Original: `kit/dashboard/index.html` at 9b47008 (741 lines; since the rebase below, at f9e039c, 744 lines), with `model.js` (191) and `server.js` (592). Approved by Jonathan Robles in chat on 2026-11-23 with decisions #73–#79 and corrections 80a–80c. Decision file: `docs/decisions/0019-dashboard-in-react-single-file-build.md`.

Verify by: **shot** = Playwright screenshot diff at 375/768/1024/1440/1920 × 900; **DOM** = normalised outerHTML diff (rules in 80b); **style** = computed-style diff; **test** = interaction test whose expected values come from the original.
Status: PENDING until evidence is pasted in the Evidence section.

## A. Document, head, assets
1. lang, charset, viewport meta, `<title>` — :1-6 — DOM
2. No assets, `<link>`, CDN or @font-face; font families are names with system fallback — :11-12 — DOM; style font-family
3. One inline `<style>`, original cascade order — :7-181 — style on every group in B
4. One inline module script; runtime `import('./model.js')`, failure sets `S.V=null` — :218, :711 — DOM; test #64
5. Pre-JS markup: top bar showing STATIC, `#arch` and `#worktrees` hidden, "Loading status…" — :184-216 — see 80a
6. server.js serves only `/`, `/index.html`, `/model.js`; others 404 JSON — server.js:441-453, :498 — test
7. Pages job copies only `index.html` (+ status.json) — kit/ci/github.yml:214 — test #64 (static, model absent)
8. "index html is self contained" test (no `<script src>`, no `<link>`, required literal strings incl. `import('./model.js')`) — kit/scripts/tests/dashboard.test.js:177-187 — `npm test`, unedited

## B. CSS
9. `:root` vars incl. Worktrees aliases — :8-20 — style
10. html/body height 100%, body overflow hidden; `#arch`/`#worktrees` `calc(100% - 48px)` — :22-23, :49, :148 — style heights; shot
11. Only breakpoint `max-width:1500px` (232/1fr/340 → 200/1fr/300) — :113 — style at 1440 and 1920
12. No keyframes/transition/animation/prefers-reduced-motion — grep — style transition-duration 0s
13. Hover: button, `.node rect.box`, `.ac`, `.li`, `.row` — :25, :79, :94, :122, :161 — shot per hover
14. `:focus-visible` on button, [tabindex], select, input — :27 — shot per kind
15. `button:disabled` — :26 — shot ("Opening…")
16. Structural selectors `.kv>span:nth-child(odd)`, `.row:last-child`, `.side h3:first-child` (never matches) — :141, :160, :51 — DOM; style
17. Descendant `.feed div`, `.big div`, `.hist div` — :115, :135, :142 — style
18. `[hidden]{display:none!important}` + hidden on projectSel/#arch/#worktrees — :180 — DOM
19. `[aria-selected=true]`, `[aria-current=true]`, `[aria-pressed=true]` — :41, :54, :133, :145 — style per state
20. SVG node tones, edges, bands — :69-89 — shot (System view)
21. Inline style strings and computed positions (Dependencies) — :198, :425-449, :594, :636-647 — DOM

## C. Screens and components
22. Top bar — :184-194, :303-313 — shot; DOM
23. Architecture 3 columns — :196-214 — shot
24. View buttons `01`–`05` — :316 — DOM
25. Legend 5 rows — :201-205 — DOM
26. Project card live / "Needs the live server." — :320-324 — shot both modes
27. SVG node: 4 shapes, tag text/dot, `<title>` tooltip — :328-353 — DOM
28. System view — :356-380 — shot; DOM
29. Agents view — :382-402 — shot
30. Pipeline view — :404-419 — shot
31. Dependencies view, with and without selection, group open — :421-451 — shot
32. Activity view (feed, drift, violations, IN STEP/NONE) — :453-471 — shot
33. Inspector empty — :476-485 — shot
34. Inspector selected + 4 tabs + "Open on GitHub ↗" — :486-527 — shot per tab
35. History states loading/unavailable/list/empty — :518-522, :529-535 — test
36. Worktrees "no status.json" — :571 — shot (static, no file)
37. Worktrees all-projects index — :577-587 — shot (2 projects)
38. Worktrees project page — :589-624 — shot
39. Worktrees lane detail — :626-655 — shot

## D. Behaviour
40. Hash routes; bad view → system; `go()` re-renders on same hash — :287-294 — test
41. hashchange listener and selection rule — :295-300 — test (back/forward)
42. Startup order — :710-737 — test per mode
43. Static mode status.json; arch "needs the live server" — :251, :541-546 — test
44. loadStatus keeps current project — :249-256 — test
45. seedEvents 60/lane, sort, 200 — :267-280 — test
46. SSE status/architecture/event/onerror/onopen — :722-736 — test with real file changes
47. Running = event within 2 min of browser clock — model.js:21, :284 — test, frozen clock
48. Main click delegation (view/node/itab/group/blast) — :679-692 — test
49. Second click handler data-tab, order — :703-706 — test
50. Enter/Space on [data-node] only — :693-695 — test
51. Search keeps focus and caret — :696-698 — test
52. kindSel filter — :700 — test
53. projectSel change, two renders — :701 — test
54. Refresh — :707 — test
55. Worktrees clicks: project, back, lane (stopPropagation), Close — :657-661 — test
56. Open Claude button states — :662-666 — test
57. selectLane render, fetch, render — :669-676 — test
58. Each click and key reaches its handler once (Refresh once; worktrees rebound per render) — :707, :574 — test (behaviour; was listener count, replaced at the f9e039c rebase)
59. Text formatting esc/clip/time slices/— — :221-222, :456, :632 — DOM text
60. aria-selected as "true"/"false"; absent before first render — :304-305 — DOM
61. ARIA roles/labels/tabindex — throughout — axe both builds
62. No storage, timers, observers, scroll/resize listeners — grep — grep build + listener count
63. Duplicate project name gets ` · <root>` — :310 — test
64. Model unavailable → S.V null → arch message — :711, :541 — test

## E. Traps
65. Whitespace between inline elements — :580-584, :597, :601-606, :647 — DOM text; shot
66. `<table>` without `<tbody>` (parser inserts it) — :646-651 — DOM; console
67. `<a><button>` nesting — :526, :638 — DOM; console
68. innerHTML re-render drops focus — :549, :573 — see #78
69. StrictMode double effects — — EventSource and listener count = 1
70. SVG attributes — :349-352, :379 — DOM
71. `#root` wrapper vs height chain — — see #76
72. `<title>` with newlines in `<g>` — :351 — DOM

## F. Decisions (2026-11-23)
73. **Single file via `vite-plugin-singlefile`** (dev dependency). Vite cannot inline by itself; only option leaving server.js, the CI job and the test untouched.
74. **Dev-only deps, built index.html committed.** Decision 0019. Drift check: rebuild from source, byte-diff against committed `kit/dashboard/index.html`, fail on any difference.
75. **Runtime `import('./model.js')` kept.** Prove the literal survives minification; test #8 unedited.
76. **`<div id="root" style="display:contents">`.** Prove with computed style that `#arch` and `#worktrees` heights equal the original's.
77. **Data: planted-faults fixture repos through the real `lane.js`.** Record the kit commit and the fixture build. Both builds run against the same data, served by the same `server.js`.
78. **Keep focus (the one intentional deviation).** Logged below; a test asserts focus survives a stream event.
79. **Shots 900 px high at all five widths, plus scrolled captures** (`.vp`, `.insp`, `#worktrees`). Deterministic: frozen clock, caret hidden, network idle before each capture.

## G. Corrections (2026-11-23)
80a. **Pre-JS paint.** The original paints the top bar (STATIC) before JS. The React build keeps that static shell in `index.html` so the first paint is the same. Verify: screenshot with JS disabled, and one at first paint, both builds.
80b. **DOM normalisation rules** are stated in `parity/normalize.js` and in the Evidence section, with one deliberately broken element that the check catches.
80c. **No favicon.** The original links none; `/favicon.ico` gets the server's 404 JSON. The React build must not add one. Verify: request log of both builds.

## H. Known limits
81. 375 and 768 show the same squeezed 3-column grid (no mobile breakpoint): parity, not a bug.
82. Headless Chromium only (Chrome for Testing 153). Safari and Firefox unverified.

## Intentional deviations
- D1 (#78): keyboard focus survives a re-render caused by a stream event. The original loses it.

## Evidence

### Step 2: baseline (2026-11-23)

**Data (#77).** `parity/build-fixtures.js` at kit 9b47008. It runs `planted-faults/make_fixtures.js`, bootstraps both projects with `bootstrap.js`, starts lanes with `lane.js start`, writes events through `hook_event_log.js` and `hook_guard_edit.js` fed hook JSON, and writes `status.json` with `kit_status.js`. Hand edits are the ones a human makes, done the way the kit's own tests do: ROADMAP rows, approval lines, a progress escalation, a review report, goal files. Positions: refund-route building (7 events, 1 blocked edit), export-csv escalated, audit-log in-review, rate-limits waiting-approval, other queued; python-service: billing-export waiting-approval, health-check queued. Record: `parity/baseline/FIXTURE.json`. Server: `kit/dashboard/server.js` from a detached checkout of 9b47008 (`.data/kit-original`); the React run uses a second checkout of the same commit with only `index.html` replaced.

**Capture.** `parity/capture.spec.js`. 31 states (21 screens across 5 scenarios; 3 scrolled; 10 hover/focus/disabled at 1440 and 1920; JS disabled; first paint in live and Pages modes). Each state gives a PNG, the normalised DOM, the rendered text, the computed styles of 66 probes, and the request and console log. That's 155 PNGs and 761 files in `parity/baseline/`.

**Determinism.** Two captures of the original with no change between them:
- First try: 0 DOM/text/style differences, but 25 PNGs differed by 11–167 px each, with a largest channel delta of 1–3 on anti-aliased edges. Root cause: GPU and partial raster. Fixed with Chrome flags in `playwright.config.js`.
- Also 5 first-paint logs differed. Root cause: which responses had landed while the first data request was held is a race. Fixed by recording only requests for first paint, and comparing the request list as a sorted list.
- After both fixes, over 761 files: png 0/155, dom 0/155, text 0/155, styles 0/140, log 0/155 differing.

**#76 numbers to match.** `#arch` is 852px tall at rect 0,48 for every width. Columns are 200/940/300 at 1440 and 232/1348/340 at 1920. `#worktrees` is 852px.

**80b normalisation.** The rules are in `helpers.js normalizedDom`. `parity/normalize-proof.spec.js` passes 8/8:
- Ignored, as stated: attribute order, class token order and spacing, style spacing, whitespace-only text.
- Caught: a removed `role`, an `aria-selected` value, an extra class, a style value, one text character, and a wrapper div.
- Caught by rendered text but not the DOM, as stated: a space removed between two inline spans.

**Interaction tests.** `parity/interactions.spec.js` passes 25/25 on the original, on its own fixture copy (`.data-int`). #78 fails on the original as declared (deviation D1).

Console on the original is not clean: every load logs Chrome's error for the `/favicon.ico` 404. The static copies also log 404s for `/api/status` and `model.js`, and the Open Claude button gets a 500. The tests allow exactly those messages and nothing else. There are 0 warnings.

**a11y.** The original's axe violations are recorded in `parity/a11y-original.json`. For example, arch-system has label-content-name-mismatch ×41, landmark-one-main, page-has-heading-one, and region.

**Kit tests.** `dashboard.test.js` and `dashboard_model.test.js` pass 15/15, unchanged.

**Not covered yet.** `onopen` after a reconnect (the server can't come back on the same port), `file://` mode, Safari and Firefox, and Lighthouse (axe only so far).

### Rebase to 0ae872a (2026-11-23)
`main` moved to 0ae872a (lane store; `server.js` now also watches it). `index.html` itself is unchanged. The branch was moved onto it, both fixture sets were rebuilt, and the baseline was recaptured: two captures still give 0 differences in 761 files. Interaction expectations were re-observed on the original at 0ae872a, each marked in the test:
- 140 components (was 138);
- "15 of 27 test files" and "2 of 22 core scripts";
- 20 matches for "lane" (was 19);
- `a11y-original.json` label-content-name-mismatch 42 (was 41).

### Step 3: conversion, one section at a time (2026-11-23)
Each step: build, put the build next to the original (`install-react.js`), capture all 155 states, compare with the baseline, run the 25 interaction tests. Real numbers per step (png / text / styles / logs differing; DOM differing):

| Step | Section to JSX | png | text | styles | log | dom | interaction tests |
|---|---|---|---|---|---|---|---|
| 1 | shell + top bar (rest bridged) | 0/155 | 0/155 | 0/140 | 0/155 | 135 (E1, E2) | 23/25: #51 bridge bug, fixed in the same step; #58 (L1) |
| 2 | Worktrees | 0 | 0 | 0 | 0 | 135 (E2) | 24/25 (L1) |
| 3 | side: view list, project card | 0 | 0 | 0 | 0 | 135 (E2) | 24/25 (L1) |
| 4 | inspector | 0 | 0 | 0 | 0 | 135 (E2) | 24/25 (L1) |
| 5 | System view | 0 | 0 | 0 | 0 | 135 (E2) | 24/25 (L1) |
| 6 | Agents view | 0 | 0 | 0 | 0 | 135 (E2) | 24/25 (L1) |
| 7 | Pipeline view | 0 | 0 | 0 | 0 | 135 (E2) | 24/25 (L1) |
| 8 | Activity view | 0 | 0 | 0 | 0 | 135 (E2) | 24/25 (L1) |
| 9 | Dependencies view | 0 | 0 | 0 | 0 | 135 (E2) | 24/25 (L1) |
| 10 | bridge deleted (no innerHTML, no querySelector, no delegation) | 0 | 0 | 0 | 0 | 135 (E2) | 24/25 (L1) |

**DOM comparison** is a real line diff (`diff -U0`). Two symmetric steps are applied first, both stated in compare.js:
- the `#root` wrapper is unwrapped (#76);
- `<script>` elements are dropped (the build moves the bundle into `<head>`).

**Explained differences:**
- **E1, fixed in step 1.** `<style crossorigin rel="stylesheet">`. Root cause: `vite-plugin-singlefile` copies the `<link>` attributes onto the `<style>` it inlines. Fix: the original `<style>` block stays in `index.html`, so lines 1-181 of the build are byte-identical to the original's.
- **E2, remains: 135 files, all the same 1–2 lines.** The current `<option>` of `#projectSel` has no `selected=""` attribute. Root cause: the original rewrites the options with a `selected` attribute; React sets the select's `value` property and warns if `selected` is set on an `<option>`. The selected value (`:value` in the normalised DOM), the pixels and the text are identical. The 20 files without a project picker (one project, static modes) show 0 DOM differences.

**L1: decision needed.** Test #58 asserts the original's exact listener list: `window:hashchange`, five `document` listeners, and `#refresh:click`. React attaches its own listeners to the root instead (142 on `#root`, plus `window:test` and `document:selectionchange`), so this exact list cannot hold for any React build. What the test protects does hold, measured on both builds after load and after visiting all five views and pressing Refresh:

| | Original | React |
|---|---|---|
| EventSource | 1 | 1 |
| Timers | 0 | 0 |
| Storage / observers | 0 / 0 | 0 / 0 |
| Listeners at load | 7 | 146 |
| Listeners after the views and Refresh | 7 | 148 |

The +2 are React's own listeners on the newly mounted `#q` input and `#kindSel` select.

**Register items with evidence**
- **#75:** `check-build.js` PASS: the literal `import('./model.js')` is in the build. It's a classic script marked `vite-ignore`. Kit test "index html is self contained" passes unedited.
- **#76:** `#arch` and `#worktrees` heights and rects are among the 0/140 differing computed styles. The React build's `#root` probe computes `display: contents`.
- **80a:** `nojs` and `firstpaint-*` captures: 0 px, 0 text, 0 DOM differences beyond E2. The shell lives in `index.html`, and React's first render is the same markup.
- **80c:** request logs 0/155 differing. The build has no icon link (`check-build.js`).
- **D1 / #78:** passes on React for real (focus stays on the component through a stream event).
- **#74:** `check-build.js` drift check PASS. A fresh build is byte-identical to `kit/dashboard/index.html` (278,303 bytes).

**Kit, with the React page in place:**
- `npm test`: 489 tests, 488 pass, 0 fail, 1 skipped.
- `npm run architecture:check`: 0 errors and 1 warning, the warning shown on the original too (`permission_probe.js` unreferenced).
- `npm run planted-faults`: 55/55 caught.
- App: `tsc` clean, `eslint --max-warnings 0` clean.

**Console:** 0 warnings on both builds. Errors are exactly the original's own (the favicon 404, and in static mode the `model.js` and `/api/status` 404s). The interaction tests fail on any other message.

**a11y:** axe #61 passes, so no violation id or count beyond the original's.

### Rebase to f9e039c (2026-11-25)
`main` moved 16 commits, to f9e039c. One of them changed the original page: d105a59 (#126) adds a rounds pill to each lane row ("round N of M", or "parked · round N of M"), two metrics on the lane page (round, wall time) and a "Parked" table row. `server.js` changed too (#122 Host/Origin checks, #128 live feed `source`). The branch was rebased; `kit/dashboard/index.html` was taken from main as the original and the React build was regenerated from source afterwards.

**Original.** `build-fixtures.js` used to take the original from the repository's `HEAD`. With the React build committed, `HEAD`'s page is the React build, so it now takes the parent of the commit that added `dashboard-app/` (the rebased base, f9e039c), or `PARITY_KIT_COMMIT`. It refuses to build if `kit/` in the working tree differs from that commit outside `index.html`, so the data and the server always come from the same kit. `fixture.json` records `kit_commit: f9e039c…`.

**Harness changes, each the same for both builds.**
- **Approvals.** Since #117 `lane.js start` needs an approval recorded by `kit lane merge --pr`, which needs GitHub. The fixtures have no remote, so they record it with the kit's own tests' stand-in (`kit/scripts/tests/fixtures.js approveSpec`, which calls `lane.js recordSpecApproval`).
- **Rounds fixture (#126).** A third project, `rounds-api` (the planted-faults node-api repository in its own directory), served alone by a new scenario `rounds`. Both lanes are moved only by `lane.js advance` and `lane.js gate`: `search-index` goes to review and back once (round 2 of 3); `webhooks` fails three rounds and `advance` parks it. The red and green runs are cited the way `lane.test.js atReview` does. Its kit.json records each gate check as `none: parity fixture, no dependencies installed`, since the fixture has no installed dependencies. node-api and python-service are as before, so no existing interaction value moved because of the fixture.
- **Captures.** Three new states, each at five widths: `rounds-wt` (the lane list with both pills), `rounds-lane` (round 2 / 3 and wall time) and `rounds-parked` (round 3 / 3 · parked, and the Parked row). The original's screenshots show all three.
- **Server clock.** The server computes wall time from its own clock (`storeClock`), so two builds captured minutes apart would differ in that text. `parity/server-clock.js`, preloaded into `server.js` by `serve.js`, starts the server's clock at the browser's frozen `NOW`; it then runs at the normal rate.
- **Browser.** `PARITY_CHROME` names the Chrome binary (default `/usr/bin/google-chrome`, unchanged). This rebase ran on macOS with Google Chrome 158, for the original and the React build alike.

**Expected values re-observed on the original at f9e039c.** Each one was read from the original page, never from React; each is marked in the test.

| Test | Old | New | Caused by |
|---|---|---|---|
| #48 groups of `script:lane` | 22 of 23 skills (zi-architecture +21) | 23 of 23 (+22) | skill and agent changes in 1d87456..f9e039c; the committed architecture edges do not pin it to one commit |
| #48 | 15 of 27 test files (app_token.test.js +14) | 19 of 33 (+18) | six new test files: ci_policy (1add785, #120), lane_merged (511b9a0, #119), dashboard_security (f867bd7, #122), dashboard_live_feed (1ab5686, #128), gate (76d5b3c, #130), event_log_agent (f9e039c, #129); four of them test lane.js |
| #48 | 5 of 8 agents (implementer +4) | 6 of 8 (+5) | as the skills row |
| #48 agent chips in Dependencies | 5 | 6 | the same agent group |
| #51 components | 140 | 146 | the six test files above; the eval-smoke CI job moved to kit-eval-main.yml (#120), net 0 |
| #51 matches for "lane" | 20 | 21 | test:lane_merged (#119) |

#61 (axe) needed no change: the original at f9e039c gives the same violations as `a11y-original.json`. (A first fixture put the rounds lanes in node-api; that run showed `scrollable-region-focusable` on the original, which is why the lanes moved to their own project.)

**#41 was a race, not a regression.** Line 128 read `#vtitle` straight after the click, but the original draws the view in its `hashchange` handler (index.html:295), which runs as a task of its own after the click returns. On the original at f9e039c, unchanged, it failed 1 run in 10. The test now waits with `quiet(page, w)` after the click, as its other steps do; the assertion is unchanged, and the wait is the same for both builds.

**#58 replaced (L1 resolved).** The old test asserted the original's exact listener list. React listens on its root (146 listeners), so no React build can have that list. What the list protected was that each click and key reaches its handler once, after load and after re-renders. The new test does the action behind each of the original's seven listeners (hashchange, the delegated click, keydown, input, change, the data-tab click, Refresh) and asserts its result and the requests it makes. A handler bound twice would fetch twice. It runs after load, then again after visiting every view and pressing Refresh. The EventSource, timer, storage and observer counts (#62, #69) are unchanged. Expected values were observed on the original: 21 "lane" matches, and Refresh makes 7 requests (status, architecture, and the five node-api lanes' events).

**Results, React build against the new baseline (`npm run parity:all`).**
- Captures: 40 tests, 170 states (155 + 15 rounds).
- compare: png 0/170, text 0/170, styles 0/155, log 0/170 differing; dom 150/170.
- Every DOM difference is the same pair of lines, E2: `<option selected="" value=…>` in the original and `<option value=…>` in React, inside `#projectSel`. Correction to E2 above: the original keeps `#projectSel` in the DOM, hidden, even with one project, so single-project and static captures carry it too. The 20 files without it are `empty-wt`, `nojs` and both first paints.
- Interactions on React: 25/25 pass, the new #58 included.
- `check-build.js`: all 5 PASS. A fresh build is byte-identical to `kit/dashboard/index.html` (279,111 bytes), and lines 1-181 are identical to the original at f9e039c.

**Kit, with the React page in place.** Measured on this branch and on main (f9e039c) on the same Mac, at the same time:
- `npm test`: 559 tests, 556 pass, 2 fail, 1 skipped on both. The same 2 fail on main ("real srt: a lane commits in its linked worktree…", "real shell writes outside the spec are still caught…"; known to fail on this Mac and pass in CI).
- `node planted-faults/run.js`: 65/65 caught on both.
- `npm run architecture:check`: 0 errors and 1 warning on both (`permission_probe.js` unreferenced). The manifest did not change.
- App: `tsc` clean, `eslint --max-warnings 0` clean.

### Board tab (hardening plan Step 10), 2026-11-28
The page gains a third tab, **Board**, and its drawer. The reference is now `main`'s React page at dfe4680 (`PARITY_KIT_COMMIT=dfe4680`): since #115 the original is no longer the commit before `dashboard-app/` was added. The baseline was recaptured from it (836 files).

**Harness.**
- Playwright ignores the `.data*` folders: since #115 the kit checkouts in them contain `dashboard-app/parity`, and their spec files ran too.
- `serve.js` has a `work` target (this checkout's own server and built page) and two scenarios, `rounds` and `board`. The Board needs routes and status fields that the fixed kit commit does not have, so its tests run on the checkout's own server, not on the parity targets.
- `build-fixtures.js` adds `board-api`, built with the kit's own scripts. Its lanes cover:
  - an agent running (hook events with `agent_id`, a start and no stop);
  - a gate PASS;
  - a stale gate (a commit after the PASS);
  - a FAIL round then a PASS round (`lane.js gate` on a committed FAIL file, then without it);
  - a parked lane;
  - a lane that needs the owner (an unapproved spec);
  - cost hidden;
  - lanes with no events.
- Built with `PARITY_KIT_COMMIT=HEAD node parity/build-fixtures.js parity/.data-board`.

**Board tests.**
- `parity/board.spec.js` (9) covers columns, agents and models, the banner, cards, the header, keyboard, and the drawer (grouping, Summary first, no raw HTML, Escape and the scrim).
- `parity/board-cases.spec.js` (6) covers each fixture case, axe, and screenshots at 1600 and 900 px (`parity/screens/`).
- axe:
  - The Board shows only the page's own `page-has-heading-one` (every screen has it; `a11y-original.json`).
  - The drawer shows none.
  - Two violations axe found were fixed: a card's `aria-label` did not contain its visible text (label-content-name-mismatch ×6), and `role="dialog"` was on an `<aside>` (aria-allowed-role).

**Parity of the existing views (`npm run parity:all`, React build against the dfe4680 baseline).**
- Captures: 40 tests. Interactions: 25/25 pass.

| Kind | Differing | Cause |
|---|---|---|
| dom | 170/170 | the new tab button (`#tab-board`), and the drawer's second `<style>` element in `<head>` |
| text | 170/170 | the button's word "Board" |
| png | 170/170 | the top bar (y < 48) in 169 files; `insp-history@375` below it too |
| styles | 30/155 | the rects of the top-bar items right of the tabs (`#projectSel`, `.livepill`, `.dot`, `#refresh`), moved by the button |
| log | 1/170 | `focus-node@1440`, a baseline flake (below) |

- **`insp-history@375`:** at 375 px the top bar is wider than the window (known limit #81), so the button changes how far the page is scrolled sideways to show the inspector. Its layout, text and DOM are otherwise identical.
- **`focus-node@1440`, a flake in the baseline, not a change:** the baseline was captured over 19 minutes, and during this state the browser logged `ERR_NETWORK_IO_SUSPENDED` and showed RECONNECTING. The React capture shows LIVE. The same state's `.livepill` width is the 31st style difference above.
- **A regression the first run caught:** the Board's chip class was named `.chip`, the same as the Agents view's, which changed those chips' height (19 → 15 px) and width. It is now `.bchip`. No other class the Board adds exists in the page.
- **check-build:** all 5 PASS. Lines 1-181 are identical to the reference at dfe4680: the Board's CSS is a second `<style>` after that block.

### Still unverified
- **Lighthouse:** only axe has run.
- **Browsers:** Safari and Firefox not run (Chromium only).
- **`file://` mode.**
- **`onopen` after a real reconnect.**
- **A timing difference between the store and React** (the window is milliseconds; not observed in any test). The original wrote each section during its render call. Here, the snapshot is taken at that moment and React draws it a moment later. If a state change that redraws nothing lands between the two, React draws the snapshot, which matches the original. A second snapshot of the same section taken before React draws would skip the first frame; nothing reads that frame.
