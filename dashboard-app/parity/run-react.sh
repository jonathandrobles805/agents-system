#!/usr/bin/env bash
# Build, install next to the original, capture, compare against the baseline, and run the interaction tests.
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc && npx eslint --max-warnings 0 . && npx vite build >/dev/null
node parity/install-react.js parity/.data parity/.data-int >/dev/null
rm -rf parity/results/react
PARITY_TARGET=react npx playwright test --config parity/playwright.config.js parity/capture.spec.js 2>&1 | tail -1
node parity/compare.js > parity/results/react/compare.out.json || true
node -e 'const j=require("./parity/results/react/compare.json");console.log("compare", JSON.stringify(j.by_kind), "missing", j.missing.filter(f=>f!=="FIXTURE.json").length)'
PARITY_DATA=parity/.data-int PARITY_TARGET=react npx playwright test --config parity/playwright.config.js parity/interactions.spec.js 2>&1 | grep -E "✘|passed|failed" || true
