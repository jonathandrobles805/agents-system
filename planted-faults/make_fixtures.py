#!/usr/bin/env python3
"""Materialize the fixture projects used by the planted-fault suite and the Phase 2 check.
Usage: python3 planted-faults/make_fixtures.py [OUT_DIR]   (default: planted-faults/fixtures, git-ignored)"""
import shutil, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kit" / "scripts" / "tests"))
import fixtures as F  # noqa: E402

out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent / "fixtures")
if out.exists():
    shutil.rmtree(out)
F.node_api(out / "node-api")
F.python_service(out / "python-service")
print(f"fixtures written to {out}: node-api, python-service")
