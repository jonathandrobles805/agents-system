#!/usr/bin/env python3
"""CI (warning): flag large PRs. Big PRs mean the spec should have been split."""
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K, ci_common as C  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default="."); ap.add_argument("--base", default="origin/main")
    ap.add_argument("--max-files", type=int, default=25); ap.add_argument("--max-lines", type=int, default=800)
    a = ap.parse_args(argv); root = Path(a.repo).resolve()
    files = C.changed_files(root, a.base)
    try:
        stat = K.git(["diff", "--shortstat", f"{a.base}...HEAD"], root)
    except Exception:
        stat = ""
    import re
    ins = sum(int(x) for x in re.findall(r"(\d+) insertion", stat)); dele = sum(int(x) for x in re.findall(r"(\d+) deletion", stat))
    if len(files) > a.max_files or ins + dele > a.max_lines:
        return C.fail(f"pr-size: {len(files)} files, {ins + dele} lines changed (limits {a.max_files}/{a.max_lines}). Split the next spec into slices.")
    return C.ok(f"pr-size: {len(files)} files, {ins + dele} lines")


if __name__ == "__main__":
    sys.exit(main())
