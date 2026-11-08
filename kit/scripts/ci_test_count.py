#!/usr/bin/env python3
"""CI: the number of test cases must not drop versus the base branch unless the spec says 'Test count may drop:' with a reason."""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K, ci_common as C  # noqa: E402

TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|spec)(/|$)|\.(test|spec)\.[a-z]+$|(^|/)test_[^/]+\.py$|_test\.(go|py|rb|rs)$")
CASE = re.compile(r"^\s*(it|test|describe\.each|it\.each|test\.each)\s*\(|^\s*def test_|^\s*func Test[A-Z]|^\s*#\[test\]|^\s*@Test\b", re.M)


def count_at(root: Path, ref: str | None) -> int:
    if ref:
        files = K.git(["ls-tree", "-r", "--name-only", ref], root).split()
    else:
        files = K.git(["ls-files"], root).split()
    n = 0
    for f in files:
        if not TEST_FILE.search(f):
            continue
        lines = K.file_lines_at(root, f, ref)
        if lines:
            n += len(CASE.findall("\n".join(lines)))
    return n


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default="."); ap.add_argument("--base", default="origin/main")
    a = ap.parse_args(argv); root = Path(a.repo).resolve()
    try:
        base_n = count_at(root, a.base)
    except Exception as e:  # noqa: BLE001
        return C.ok(f"test-count: cannot read base {a.base} ({e}); skipped")
    head_n = count_at(root, None)
    if head_n < base_n:
        slug = C.lane_slug(root)
        spec = root / "docs" / "specs" / f"{slug}.md" if slug else None
        if spec and spec.is_file() and re.search(r"Test count may drop:\s*\S", spec.read_text()):
            return C.ok(f"test-count: {base_n} -> {head_n}, drop declared in spec")
        return C.fail(f"test-count: tests dropped from {base_n} to {head_n}. Deleting tests is not a fix. If intentional, add 'Test count may drop: <reason>' to the spec and re-approve.")
    return C.ok(f"test-count: {base_n} -> {head_n}")


if __name__ == "__main__":
    sys.exit(main())
