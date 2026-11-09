#!/usr/bin/env python3
"""PreToolUse on Edit|Write for the tester agent: only test files and lane-owned docs may be written. Exit 2 blocks."""
from __future__ import annotations
import re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K

TEST_PATH = re.compile(r"(^|/)(tests?|__tests__|spec|e2e|fixtures|testdata)(/|$)|\.(test|spec)\.[a-z]+$|(^|/)test_[^/]+\.py$|_test\.(go|py|rb|rs)$|(^|/)conftest\.py$|vitest\.config|jest\.config|pytest\.ini")


def main() -> int:
    d = K.read_hook_input()
    if not d:
        return 0
    cwd = Path(d.get("cwd") or ".")
    root = K.project_root(cwd)
    fp = (d.get("tool_input") or {}).get("file_path") or (d.get("tool_input") or {}).get("notebook_path")
    if not fp:
        return 0
    rel = K.rel_to(root, (cwd / fp) if not Path(fp).is_absolute() else fp)
    lane = K.find_lane(cwd)
    if lane and K.glob_match(rel, lane.always_allowed()):
        return 0
    if TEST_PATH.search(rel):
        return 0
    return K.block(f"guard-tests-only: '{rel}' is not a test file. The tester writes tests and test helpers only; application code is the implementer's job.")


if __name__ == "__main__":
    sys.exit(main())
