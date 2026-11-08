#!/usr/bin/env python3
"""CI: every file changed on a lane branch must be in the spec's Files to change / Files to create (or lane-owned docs)."""
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K, ci_common as C  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default="."); ap.add_argument("--base", default="origin/main")
    a = ap.parse_args(argv); root = Path(a.repo).resolve()
    slug = C.lane_slug(root)
    if not slug:
        return C.ok("scope-diff: not a lane branch (wt/<slug>); skipped")
    spec = root / "docs" / "specs" / f"{slug}.md"
    if not spec.is_file():
        return C.fail(f"scope-diff: lane branch for '{slug}' but {spec.relative_to(root)} does not exist")
    _, change, create = K.spec_file_lists(spec)
    allowed = change + create + [f"docs/specs/{slug}.progress.md", f"docs/specs/{slug}.review.md", f"docs/specs/{slug}.log", f"docs/specs/{slug}.events.jsonl", "docs/decisions/*.md", "ROADMAP.md"]
    extras = [f for f in C.changed_files(root, a.base) if not K.glob_match(f, allowed)]
    if extras:
        return C.fail("scope-diff: files changed outside the spec allow-list:\n  " + "\n  ".join(extras) + f"\nAllowed: {', '.join(change + create)}\nAmend the spec and re-approve, or revert these files.")
    return C.ok(f"scope-diff: {len(C.changed_files(root, a.base))} changed file(s), all within spec '{slug}'")


if __name__ == "__main__":
    sys.exit(main())
