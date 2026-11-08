import json
import re
from pathlib import Path

import fixtures as F
from conftest import run_script

KIT = Path(__file__).resolve().parents[2]

SPEC = """# Spec: Refund route

- Slug: refund-route
- Date: 2026-11-08
- Commit: {commit}
- Research: none
- Risk: high-risk
- Status: approved

## Summary

- Goal: expose refund over the routes module
- Files changed: 1
- Risks: payments
- Done when: refund route exists and is tested
- Open questions: none

## Goal

Add a refund entry to routes.

## Non-goals

- partial refunds

## Files to read first

- `src/domain/payment.ts` — the service [verified: src/domain/payment.ts:1-3]

## Files to change

- `src/api/routes.ts` — add refund next to charge [verified: src/api/routes.ts:3-3]

## Files to create

- `tests/routes.test.ts` — route tests

## Impact analysis

- `routes` has no external callers [verified: cmd]
  ```
  $ git grep -n "routes(" src tests
  src/api/routes.ts:2:export function routes(s: PaymentService) {{
  ```

## Approach

Add a `refund` key delegating to the service.

## Data changes

- none

## New dependencies

- {deps}

## Done-criteria

| # | Criterion | Test |
|---|---|---|
| D1 | routes exposes refund | `tests/routes.test.ts::exposes refund` |

## Assumptions

- A1. routes returns a plain object [verified: src/api/routes.ts:3-3]

## Open questions

- none

## Architecture checklist

- [x] api depends on domain, never the reverse — routes imports the service only

## Critique

- C1. none → n/a

## Approval

Approved by: Jonathan Robles on 2026-11-08 at {commit}
{extra}"""


def lane_repo(tmp_path: Path, deps: str = "none", extra: str = "") -> Path:
    root = F.node_api(tmp_path / "node-api")
    run_script("bootstrap.py", ["--repo", str(root)])
    commit = F.commit_all(root, "bootstrap")
    (root / "docs" / "specs" / "refund-route.md").write_text(SPEC.format(commit=commit[:7], deps=deps, extra=extra))
    F.commit_all(root, "spec")
    F.git(["checkout", "-q", "-b", "wt/refund-route"], root)
    return root


def ci(name: str, root: Path, *args: str):
    return run_script(name, ["--repo", str(root), "--base", "main", *args])


def test_scope_diff_pass_and_fail(tmp_path):
    root = lane_repo(tmp_path)
    (root / "src" / "api" / "routes.ts").write_text("import { PaymentService } from '../domain/payment';\nexport function routes(s: PaymentService) {\n  return { charge: (u: string) => s.charge(u), refund: (i: string) => s.refund(i) };\n}\n")
    (root / "tests" / "routes.test.ts").write_text("import { it, expect } from 'vitest';\nit('exposes refund', () => { expect(1).toBe(1); });\n")
    F.commit_all(root, "D1")
    r = ci("ci_scope_diff.py", root)
    assert r.returncode == 0, r.stderr
    (root / "src" / "domain" / "payment.ts").write_text("// touched\n" + (root / "src" / "domain" / "payment.ts").read_text())
    F.commit_all(root, "creep")
    r = ci("ci_scope_diff.py", root)
    assert r.returncode == 1 and "src/domain/payment.ts" in r.stderr


def test_scope_diff_skips_non_lane_branch(tmp_path):
    root = F.node_api(tmp_path / "node-api")
    F.git(["checkout", "-q", "-b", "chore/readme"], root)
    r = ci("ci_scope_diff.py", root)
    assert r.returncode == 0 and "skipped" in r.stdout


def test_test_count_drop_fails_unless_declared(tmp_path):
    root = lane_repo(tmp_path)
    t = root / "tests" / "payment.test.ts"
    t.write_text(t.read_text().replace("  it('refunds', async () => {\n    const s = new PaymentService({ charge: async () => 5, refund: async () => 1 });\n    expect(await s.refund('x')).toBe(1);\n  });\n", ""))
    F.commit_all(root, "drop a test")
    r = ci("ci_test_count.py", root)
    assert r.returncode == 1 and "dropped from 2 to 1" in r.stderr
    spec = root / "docs" / "specs" / "refund-route.md"
    spec.write_text(spec.read_text() + "\nTest count may drop: refund test moves to routes.test.ts in D1\n")
    F.commit_all(root, "declare")
    r = ci("ci_test_count.py", root)
    assert r.returncode == 0, r.stderr


def test_test_count_increase_passes(tmp_path):
    root = lane_repo(tmp_path)
    (root / "tests" / "routes.test.ts").write_text("import { it, expect } from 'vitest';\nit('exposes refund', () => { expect(1).toBe(1); });\nit('b', () => {});\n")
    F.commit_all(root, "tests")
    r = ci("ci_test_count.py", root)
    assert r.returncode == 0 and "2 -> 4" in r.stdout


def test_dep_diff_undeclared_fails_declared_passes(tmp_path):
    root = lane_repo(tmp_path, deps="none")
    pj = json.loads((root / "package.json").read_text()); pj["dependencies"]["stripe"] = "^16.0.0"; (root / "package.json").write_text(json.dumps(pj, indent=2))
    F.commit_all(root, "add stripe")
    r = ci("ci_dep_diff.py", root)
    assert r.returncode == 1 and "stripe" in r.stderr
    spec = root / "docs" / "specs" / "refund-route.md"
    spec.write_text(spec.read_text().replace("## New dependencies\n\n- none", "## New dependencies\n\n- `stripe@^16.0.0` — refund API client"))
    F.commit_all(root, "declare")
    r = ci("ci_dep_diff.py", root)
    assert r.returncode == 0, r.stderr


def test_dep_diff_python(tmp_path):
    root = F.python_service(tmp_path / "py")
    F.git(["checkout", "-q", "-b", "wt/x"], root)
    pp = root / "pyproject.toml"
    pp.write_text(pp.read_text().replace('dependencies = ["fastapi>=0.110", "pydantic>=2"]', 'dependencies = ["fastapi>=0.110", "pydantic>=2", "stripe>=9"]'))
    F.commit_all(root, "dep")
    r = ci("ci_dep_diff.py", root)
    assert r.returncode == 1 and "stripe" in r.stderr


def test_claude_md_cap(tmp_path):
    root = F.node_api(tmp_path / "node-api")
    run_script("bootstrap.py", ["--repo", str(root)])
    assert run_script("ci_claude_md_cap.py", ["--repo", str(root)]).returncode == 0
    (root / "CLAUDE.md").write_text("x" * 5000)
    r = run_script("ci_claude_md_cap.py", ["--repo", str(root)])
    assert r.returncode == 1 and "5000 bytes" in r.stderr


def test_guards_present_detects_tampering(tmp_path):
    root = F.node_api(tmp_path / "node-api")
    run_script("bootstrap.py", ["--repo", str(root)])
    ok = run_script("ci_guards_present.py", ["--repo", str(root), "--kit", str(KIT)])
    assert ok.returncode == 0, ok.stderr
    s = json.loads((root / ".claude" / "settings.json").read_text())
    s["hooks"].pop("Stop")
    (root / ".claude" / "settings.json").write_text(json.dumps(s))
    r = run_script("ci_guards_present.py", ["--repo", str(root), "--kit", str(KIT)])
    assert r.returncode == 1 and "Stop" in r.stderr and "changed since bootstrap" in r.stderr
    s["hooks"] = json.loads((KIT / "hooks" / "settings.project.json").read_text())["hooks"]; s["disableAllHooks"] = True
    (root / ".claude" / "settings.json").write_text(json.dumps(s))
    r = run_script("ci_guards_present.py", ["--repo", str(root), "--kit", str(KIT)])
    assert r.returncode == 1 and "disableAllHooks" in r.stderr


REVIEW = """# Review: Refund route

- Spec: `docs/specs/refund-route.md`
- Diff: `main..{head}`
- Head: {head}
- Reviewer: reviewer (opus)
- Date: 2026-11-08T16:00:00

## Scope

- Files in diff: 2; files in spec allow-list: 2; outside allow-list: none

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| R1 | Every done-criterion has a named test | PASS | tests/routes.test.ts:2 |
| R2 | Red and green runs in log | PASS | refund-route.log#3, #12 |
| R3 | Reviewer re-ran suite | PASS | vitest run: 3 passed |
| R4 | Changed files in allow-list | PASS | git diff --name-only: routes.ts, routes.test.ts |

## Adversarial tests added

- `tests/routes.test.ts::refund rejects empty id` — negative case

## Fail list

- none

## Verdict

{verdict}
"""


def test_review_report_check(tmp_path):
    root = lane_repo(tmp_path)
    (root / "tests" / "routes.test.ts").write_text("import { it, expect } from 'vitest';\nit('exposes refund', () => { expect(1).toBe(1); });\n")
    head = F.commit_all(root, "D1")
    r = run_script("ci_review_report.py", ["--repo", str(root)])
    assert r.returncode == 1 and "missing" in r.stderr
    rep = root / "docs" / "specs" / "refund-route.review.md"
    rep.write_text(REVIEW.format(head=head[:10], verdict="PASS"))
    F.commit_all(root, "review")  # report commit is HEAD, reviewed commit is HEAD~1: accepted
    r = run_script("ci_review_report.py", ["--repo", str(root)])
    assert r.returncode == 0, r.stderr
    (root / "src" / "api" / "routes.ts").write_text("// changed after review\n" + (root / "src" / "api" / "routes.ts").read_text())
    F.commit_all(root, "sneaky change")
    r = run_script("ci_review_report.py", ["--repo", str(root)])
    assert r.returncode == 1 and "code changed after review" in r.stderr
    rep.write_text(REVIEW.format(head=head[:10], verdict="FAIL"))
    r = run_script("ci_review_report.py", ["--repo", str(root)])
    assert r.returncode == 1


def test_pr_size_warning(tmp_path):
    root = lane_repo(tmp_path)
    for i in range(30):
        (root / "src" / f"f{i}.ts").write_text("export const x = 1;\n")
    F.commit_all(root, "big")
    r = ci("ci_pr_size.py", root)
    assert r.returncode == 1 and "30 files" in r.stderr


def test_changed_docs_validates_in_ci_mode(tmp_path):
    root = lane_repo(tmp_path)
    (root / "docs" / "research" / "bad.md").write_text("# Research: x\n\n- Question: x\n- Slug: bad\n- Date: 2026-11-08\n- Commit: abc\n\n## Findings\n\n- F1. it probably works\n\n## What I could not verify\n\n- none\n\n## Confidence\n\nLow\n\n## Recommendation\n\nnone\n\n## Sources\n\n- none\n")
    F.commit_all(root, "bad research")
    r = ci("ci_changed_docs.py", root)
    assert r.returncode == 1 and "untagged-claim" in r.stderr
