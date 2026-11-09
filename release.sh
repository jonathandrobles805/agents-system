#!/usr/bin/env bash
# Release the kit: run every check, tag the version, push. Projects pick it up with `bootstrap.py --upgrade --all`.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="$(cat VERSION)"
python3 -m pytest -q kit/scripts/tests
python3 planted-faults/run.py
python3 audit/boards.py > /dev/null
grep -q "## \[$VERSION\]" CHANGELOG.md || { echo "CHANGELOG.md has no section for $VERSION" >&2; exit 1; }
git tag -a "v$VERSION" -m "agent-kit $VERSION"
git push origin "v$VERSION"
echo "released v$VERSION; run: python3 ~/.claude/kit/scripts/bootstrap.py --upgrade --all"
