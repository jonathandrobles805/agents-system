from pathlib import Path

from conftest import run_script

GOOD_RESEARCH = """# Research: How does PaymentService charge?

- Question: How does PaymentService charge?
- Slug: payment-charge
- Date: 2026-11-08
- Commit: abc1234

## Findings

- F1. `PaymentService.charge` delegates to the db layer [verified: src/payment.ts:3-5] `return this.db.charge(userId)`
- F2. `charge` is called from the routes module [verified: cmd]
  ```
  $ git grep -n "charge(" src/
  src/routes.ts:3:s.charge('u1');
  ```
- F3. Stripe idempotency keys are required for safe retries [docs: https://stripe.com/docs/api/idempotent_requests @ 2024-06-20]
- F4. Therefore refunds and charges share the db dependency [inferred: from F1]

## What I could not verify

- U1. Whether `Db.charge` is transactional [unknown] Resolve by: read src/db.ts and the migration for the charges table

## Confidence

High — all findings cite lines read today.

## Recommendation

Extend `PaymentService` rather than adding a new class.

## Sources

- src/payment.ts
"""


def write(repo: Path, rel: str, text: str) -> Path:
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


def test_good_research_passes(repo):
    p = write(repo, "docs/research/payment-charge.md", GOOD_RESEARCH)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 0, r.stderr


def test_false_citation_line_range_fails(repo):
    bad = GOOD_RESEARCH.replace("[verified: src/payment.ts:3-5]", "[verified: src/payment.ts:40-42]")
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "citation-out-of-range" in r.stderr


def test_citation_to_missing_file_fails(repo):
    bad = GOOD_RESEARCH.replace("src/payment.ts:3-5", "src/nope.ts:1-2")
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "citation-missing-file" in r.stderr


def test_snippet_mismatch_fails(repo):
    bad = GOOD_RESEARCH.replace("`return this.db.charge(userId)`", "`return stripe.charge(userId)`")
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "citation-snippet-mismatch" in r.stderr


def test_untagged_finding_fails(repo):
    bad = GOOD_RESEARCH.replace(
        "- F4. Therefore refunds and charges share the db dependency [inferred: from F1]",
        "- F4. Refunds go through Stripe directly",
    )
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "untagged-claim" in r.stderr


def test_hedge_word_fails(repo):
    bad = GOOD_RESEARCH.replace(
        "- F4. Therefore refunds and charges share the db dependency [inferred: from F1]",
        "- F4. Refunds probably share the db dependency [inferred: from F1]",
    )
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "hedge-word" in r.stderr


def test_unknown_in_findings_not_allowed(repo):
    bad = GOOD_RESEARCH.replace(
        "- F4. Therefore refunds and charges share the db dependency [inferred: from F1]",
        "- F4. Db.charge is transactional [unknown]",
    )
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "tag-not-allowed" in r.stderr


def test_unknown_without_method_fails(repo):
    bad = GOOD_RESEARCH.replace(
        "[unknown] Resolve by: read src/db.ts and the migration for the charges table",
        "[unknown]",
    )
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "unknown-no-method" in r.stderr


def test_cmd_tag_without_output_block_fails(repo):
    bad = GOOD_RESEARCH.replace(
        "  ```\n  $ git grep -n \"charge(\" src/\n  src/routes.ts:3:s.charge('u1');\n  ```\n", ""
    )
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "cmd-without-output" in r.stderr


def test_docs_tag_latest_version_fails(repo):
    bad = GOOD_RESEARCH.replace("@ 2024-06-20]", "@ latest]")
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "docs-version" in r.stderr


def test_unfilled_template_fails(repo):
    tmpl = (Path(__file__).resolve().parents[2] / "templates" / "research.md").read_text()
    p = write(repo, "docs/research/x.md", tmpl)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "template-placeholder" in r.stderr


def test_missing_section_fails(repo):
    bad = GOOD_RESEARCH.replace("## Sources\n\n- src/payment.ts\n", "")
    p = write(repo, "docs/research/payment-charge.md", bad)
    r = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r.returncode == 2
    assert "missing-section" in r.stderr


def test_citation_resolved_at_commit(repo):
    """With --commit, citations resolve against that commit even if the working tree changed."""
    import subprocess
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip()
    (repo / "src" / "payment.ts").write_text("// gutted\n")
    p = write(repo, "docs/research/payment-charge.md", GOOD_RESEARCH)
    r_wt = run_script("validate_docs.py", [str(p), "--repo", str(repo)])
    assert r_wt.returncode == 2  # working tree no longer has those lines
    r_c = run_script("validate_docs.py", [str(p), "--repo", str(repo), "--commit", head])
    assert r_c.returncode == 0, r_c.stderr


def test_hook_mode_posttooluse_returns_block_decision(repo):
    import json
    bad = GOOD_RESEARCH.replace("[verified: src/payment.ts:3-5]", "[verified: src/payment.ts:99-100]")
    p = write(repo, "docs/research/payment-charge.md", bad)
    payload = json.dumps({"hook_event_name": "PostToolUse", "cwd": str(repo), "tool_name": "Write", "tool_input": {"file_path": str(p)}})
    r = run_script("validate_docs.py", ["--hook"], stdin=payload)
    assert r.returncode == 0
    out = json.loads(r.stdout)
    assert out["decision"] == "block"
    assert "citation-out-of-range" in out["reason"]


def test_hook_mode_subagentstop_exits_2_on_changed_docs(repo):
    import json
    bad = GOOD_RESEARCH.replace("[verified: src/payment.ts:3-5]", "[verified: src/payment.ts:99-100]")
    write(repo, "docs/research/payment-charge.md", bad)  # untracked => "changed"
    payload = json.dumps({"hook_event_name": "SubagentStop", "cwd": str(repo), "agent_type": "researcher"})
    r = run_script("validate_docs.py", ["--hook"], stdin=payload)
    assert r.returncode == 2
    assert "citation-out-of-range" in r.stderr


def test_hook_mode_ignores_non_doc_files(repo):
    import json
    payload = json.dumps({"hook_event_name": "PostToolUse", "cwd": str(repo), "tool_name": "Write", "tool_input": {"file_path": str(repo / "src" / "x.ts")}})
    r = run_script("validate_docs.py", ["--hook"], stdin=payload)
    assert r.returncode == 0 and r.stdout.strip() == ""
