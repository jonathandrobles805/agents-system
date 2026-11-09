#!/usr/bin/env bash
# Release the kit: run every check, tag the version, push. Projects pick it up with `bootstrap.js --upgrade --all`.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="$(cat VERSION)"
npm test --silent
node planted-faults/run.js
node audit/boards.js > /dev/null
grep -q "## \[$VERSION\]" CHANGELOG.md || { echo "CHANGELOG.md has no section for $VERSION" >&2; exit 1; }
git tag -a "v$VERSION" -m "agent-kit $VERSION"
git push origin "v$VERSION"
echo "released v$VERSION; run: node ~/.claude/kit/scripts/bootstrap.js --upgrade --all"
