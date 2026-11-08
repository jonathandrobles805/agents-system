#!/usr/bin/env python3
"""CI: run validate-docs on every doc changed versus the base branch (git status is empty in CI)."""
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ci_common as C, validate_docs as V  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default="."); ap.add_argument("--base", default="origin/main")
    a = ap.parse_args(argv); root = Path(a.repo).resolve()
    docs = [f for f in C.changed_files(root, a.base) if (f.startswith("docs/") and f.endswith(".md")) or f == "LESSONS.md"]
    if not docs:
        return C.ok("validate-docs: no docs changed")
    return 1 if V.main([*docs, "--repo", str(root)]) else 0


if __name__ == "__main__":
    sys.exit(main())
