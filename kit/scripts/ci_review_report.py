#!/usr/bin/env python3
"""CI: a lane branch needs docs/specs/<slug>.review.md that validates, has Verdict PASS, and names the current HEAD."""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K, ci_common as C, validate_docs as V  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default=".")
    a = ap.parse_args(argv); root = Path(a.repo).resolve()
    slug = C.lane_slug(root)
    if not slug:
        return C.ok("review-report: not a lane branch; skipped")
    rep = root / "docs" / "specs" / f"{slug}.review.md"
    if not rep.is_file():
        return C.fail(f"review-report: {rep.relative_to(root)} missing; run /review")
    if V.main([str(rep), "--repo", str(root)]):
        return C.fail("review-report: report does not validate")
    text = rep.read_text()
    if not re.search(r"^## Verdict\s*\n+\s*PASS\s*$", text, re.M):
        return C.fail("review-report: Verdict is not PASS")
    head = K.git(["rev-parse", "HEAD"], root).strip()
    m = re.search(r"^- Head:\s*([0-9a-f]{7,40})", text, re.M)
    if not m:
        return C.fail("review-report: no '- Head: <sha>' line; the report must name the commit it reviewed")
    if not K.review_head_ok(root, m.group(1)):
        return C.fail(f"review-report: report reviewed {m.group(1)} but HEAD is {head[:12]}; code changed after review. Run /review again.")
    return C.ok(f"review-report: PASS for {m.group(1)}")


if __name__ == "__main__":
    sys.exit(main())
