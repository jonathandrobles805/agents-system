#!/usr/bin/env python3
"""CI: decide whether the mutation-score job is blocking. Blocking once the project has merged
`mutation_blocking_after_features` features (count of ROADMAP rows with status merged). Prints `blocking=true|false`."""
from __future__ import annotations
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K, lane as L  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--repo", default=".")
    a = ap.parse_args(argv); root = Path(a.repo).resolve()
    kit = K.load_kit_json(root)
    after = int(kit.get("mutation_blocking_after_features", 2))
    merged = sum(1 for r in L.roadmap_rows(root) if r["status"] == "merged")
    blocking = merged >= after
    print(f"blocking={'true' if blocking else 'false'}")
    print(f"# merged features: {merged}, blocking after: {after}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
