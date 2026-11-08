#!/usr/bin/env python3
"""validate-docs: reject research files, specs, review reports, and lessons that make
untagged or unresolvable claims. See docs/KIT-SPEC.md section 5.

Usage:
  validate_docs.py PATH [PATH...] [--repo ROOT] [--commit HASH] [--json]
  validate_docs.py --changed [--repo ROOT]        validate every changed doc (git status)
  validate_docs.py --hook                          read Claude Code hook JSON on stdin

Exit codes: 0 = all valid, 2 = violations (blocks in PreToolUse/SubagentStop; feeds back in PostToolUse), 1 = usage error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kitlib as K  # noqa: E402

REQUIRED = {
    "research": ["findings", "what i could not verify", "confidence", "recommendation", "sources"],
    "spec": [
        "summary", "goal", "non-goals", "files to read first", "files to change", "impact analysis",
        "approach", "data changes", "new dependencies", "done-criteria", "assumptions", "open questions",
        "architecture checklist", "approval",
    ],
    "review": ["scope", "checklist", "adversarial tests added", "fail list", "verdict"],
}
RESEARCH_HEADER = ["question", "slug", "date", "commit"]
SPEC_HEADER = ["slug", "date", "commit", "risk", "status"]
ENFORCED_BY = {"hook", "lint", "test", "ci", "text-only"}


def detect_type(path: Path) -> str | None:
    s = path.as_posix()
    name = path.name
    if name == "LESSONS.md":
        return "lesson"
    if "/docs/research/" in s or s.startswith("docs/research/"):
        return None if name.upper() == "INDEX.MD" else "research"
    if "/docs/specs/" in s or s.startswith("docs/specs/"):
        if name.endswith(".review.md"):
            return "review"
        if name.endswith(".progress.md") or name.endswith(".log") or name.endswith(".jsonl"):
            return None
        return "spec"
    return None


class Validator:
    def __init__(self, root: Path, commit: str | None, kit: dict):
        self.root = root
        self.commit = commit
        self.kit = kit
        self.v: list[K.Violation] = []

    # ---------- helpers ----------
    def add(self, path: Path, line: int, rule: str, msg: str) -> None:
        self.v.append(K.Violation(str(path.relative_to(self.root)) if path.is_absolute() and self.root in path.parents else str(path), line, rule, msg))

    def check_placeholders(self, path: Path, lines: list[str]) -> None:
        for i, t in enumerate(lines, start=1):
            if K.PLACEHOLDER.search(t):
                self.add(path, i, "template-placeholder", f"unfilled template placeholder: {K.PLACEHOLDER.search(t).group(0)}")

    def check_required(self, path: Path, kind: str, sections: dict[str, K.Section]) -> None:
        for s in REQUIRED[kind]:
            if s not in sections:
                self.add(path, 1, "missing-section", f"required section '## {s.title()}' not found")

    def check_header(self, path: Path, lines: list[str], names: list[str]) -> None:
        hdr = K.header_fields(lines)
        for n in names:
            if n not in hdr or not hdr[n][1]:
                self.add(path, 1, "missing-header", f"header field '{n}' missing or empty")

    def tags_of(self, text: str) -> list[str]:
        return [m.group(1) for m in K.ANY_TAG.finditer(text)]

    def check_tagged_bullets(self, path: Path, sec: K.Section | None, allowed: set[str], forbid_hedge: bool = True) -> None:
        if sec is None:
            return
        for n, t in sec.bullets():
            body = t.strip()[2:]
            if not body or body.lower() in {"none", "none.", "—", "-"}:
                continue
            tags = self.tags_of(body)
            if len(tags) == 0:
                self.add(path, n, "untagged-claim", "bullet has no provenance tag")
                continue
            if len(tags) > 1:
                self.add(path, n, "multiple-tags", f"bullet has {len(tags)} tags; use exactly one")
            for tag in tags:
                if tag not in allowed:
                    self.add(path, n, "tag-not-allowed", f"[{tag}] not allowed in '## {sec.title}' (allowed: {', '.join(sorted(allowed))})")
            if forbid_hedge and "unknown" not in tags:
                m = K.HEDGE_WORDS.search(K.ANY_TAG.sub("", body))
                if m:
                    self.add(path, n, "hedge-word", f"'{m.group(0)}' is not evidence; verify it or tag [unknown]")
            self.resolve_citations(path, n, body)

    def resolve_citations(self, path: Path, n: int, body: str) -> None:
        for m in K.TAG_VERIFIED_LINES.finditer(body):
            rel, start, end = m.group(1), int(m.group(2)), int(m.group(3) or m.group(2))
            lines = K.file_lines_at(self.root, rel, self.commit)
            if lines is None:
                self.add(path, n, "citation-missing-file", f"{rel} does not exist" + (f" at {self.commit}" if self.commit else ""))
                continue
            if start < 1 or end > len(lines) or start > end:
                self.add(path, n, "citation-out-of-range", f"{rel} has {len(lines)} lines; cited {start}-{end}")
                continue
            snippet = re.search(r"`([^`]{4,})`", body[m.end():])
            if snippet:
                cited = K.normalize(" ".join(lines[start - 1:end]))
                if K.normalize(snippet.group(1)) not in cited:
                    self.add(path, n, "citation-snippet-mismatch", f"quoted text not found in {rel}:{start}-{end}")
        if K.TAG_VERIFIED_CMD.search(body):
            pass  # presence of a fenced block is checked at section level below
        for m in K.TAG_DOCS.finditer(body):
            url, ver = m.group(1), m.group(2).strip()
            if not url.startswith("http"):
                self.add(path, n, "docs-url", f"[docs] must cite a URL, got '{url}'")
            if not ver or ver.lower() in {"latest", "current", "?"}:
                self.add(path, n, "docs-version", "[docs] must pin a version, not 'latest'")

    def check_cmd_blocks(self, path: Path, sec: K.Section | None) -> None:
        """Every [verified: cmd] bullet must be followed by a fenced block before the next bullet."""
        if sec is None:
            return
        items = sec.lines
        for idx, (n, t) in enumerate(items):
            if t.lstrip().startswith("- ") and K.TAG_VERIFIED_CMD.search(t):
                found = False
                for n2, t2 in items[idx + 1:]:
                    if t2.lstrip().startswith("- "):
                        break
                    if t2.strip().startswith("```"):
                        found = True
                        break
                if not found:
                    self.add(path, n, "cmd-without-output", "[verified: cmd] needs a fenced block with the command and its output")

    # ---------- document types ----------
    def research(self, path: Path, lines: list[str]) -> None:
        clean = K.strip_html_comments(lines)
        self.check_placeholders(path, clean)
        self.check_header(path, clean, RESEARCH_HEADER)
        sections = K.parse_sections(clean)
        self.check_required(path, "research", sections)
        self.check_tagged_bullets(path, sections.get("findings"), {"verified", "docs", "inferred"})
        self.check_cmd_blocks(path, sections.get("findings"))
        unv = sections.get("what i could not verify")
        if unv:
            for n, t in unv.bullets():
                body = t.strip()[2:]
                if body.lower() in {"none", "none."}:
                    continue
                if not K.TAG_UNKNOWN.search(body):
                    self.add(path, n, "unknown-untagged", "items here must be tagged [unknown]")
                if "resolve by:" not in body.lower():
                    self.add(path, n, "unknown-no-method", "each unknown needs 'Resolve by: <method>'")
        conf = sections.get("confidence")
        if conf and not re.search(r"\b(High|Medium|Low)\b", conf.text()):
            self.add(path, conf.start, "confidence-value", "Confidence must state High, Medium, or Low")
        fnd = sections.get("findings")
        if fnd and not fnd.bullets():
            self.add(path, fnd.start, "empty-findings", "Findings has no bullets")

    def spec(self, path: Path, lines: list[str]) -> None:
        clean = K.strip_html_comments(lines)
        self.check_placeholders(path, clean)
        self.check_header(path, clean, SPEC_HEADER)
        hdr = K.header_fields(clean)
        sections = K.parse_sections(clean)
        self.check_required(path, "spec", sections)
        # Decisions rest only on verified/docs evidence
        for name in ("files to read first", "files to change", "impact analysis", "data changes"):
            self.check_tagged_bullets(path, sections.get(name), {"verified", "docs"})
        self.check_cmd_blocks(path, sections.get("impact analysis"))
        self.check_tagged_bullets(path, sections.get("assumptions"), {"verified", "docs", "inferred"})
        # Files to change must be non-empty
        ftc = sections.get("files to change")
        if ftc and not ftc.bullets():
            self.add(path, ftc.start, "empty-allow-list", "Files to change is empty; the implementer would have nothing it may edit")
        # Done-criteria: each row needs a test or artifact+checklist
        dc = sections.get("done-criteria")
        if dc:
            rows = dc.table_rows()
            if not rows:
                self.add(path, dc.start, "no-done-criteria", "Done-criteria table has no rows")
            for n, cells in rows:
                if len(cells) < 3:
                    self.add(path, n, "done-criteria-row", "row needs: #, criterion, test")
                    continue
                test = cells[2]
                is_test = "::" in test or re.search(r"\.(test|spec)\.[a-z]+", test) or "test_" in test
                is_artifact = "artifact:" in test.lower() and "checklist" in test.lower()
                if not (is_test or is_artifact):
                    self.add(path, n, "done-criteria-no-test", "name a test (file::name) or 'artifact: <path>, checklist: <path>'")
        # Open questions must be empty
        oq = sections.get("open questions")
        if oq:
            real = [b for _, b in oq.bullets() if b.strip()[2:].strip().lower() not in {"none", "none."}]
            if real:
                self.add(path, oq.start, "open-questions", f"{len(real)} open question(s); resolve before the spec can be used")
        # Risk flag
        computed = self.compute_risk(clean, sections)
        declared = hdr.get("risk", (1, ""))[1].lower()
        if computed and declared != "high-risk":
            self.add(path, hdr.get("risk", (1, ""))[0], "risk-flag", f"spec touches high-risk paths/keywords ({computed}); header must say 'Risk: high-risk'")
        # Approval line when status requires it
        status = hdr.get("status", (1, ""))[1].lower()
        ap = sections.get("approval")
        if ap:
            m = re.search(r"Approved by:\s*(\S.*?)\s+on\s+(\d{4}-\d{2}-\d{2})\s+at\s+([0-9a-f]{7,40})", ap.text())
            if status in {"approved", "building", "in-review", "merged"} and not m:
                self.add(path, ap.start, "approval-line", "status requires 'Approved by: <name> on <YYYY-MM-DD> at <commit>'")
        # Architecture checklist answered
        ac = sections.get("architecture checklist")
        if ac:
            for n, t in ac.lines:
                if re.match(r"^\s*-\s*\[\s\]", t):
                    self.add(path, n, "checklist-unanswered", "architecture checklist item not answered (use [x] and say how)")

    def compute_risk(self, lines: list[str], sections: dict[str, K.Section]) -> str:
        paths = self.kit.get("high_risk_paths", K.DEFAULT_HIGH_RISK_PATHS)
        hits = set()
        for name in ("files to read first", "files to change", "files to create"):
            sec = sections.get(name)
            if not sec:
                continue
            for _, t in sec.bullets():
                for p in paths:
                    if p.lower() in t.lower():
                        hits.add(p)
        body = "\n".join(lines)
        for m in HIGH_RISK_KEYWORDS_SCAN.finditer(body):
            hits.add(m.group(0).lower())
        return ", ".join(sorted(hits))

    def review(self, path: Path, lines: list[str]) -> None:
        clean = K.strip_html_comments(lines)
        self.check_placeholders(path, clean)
        sections = K.parse_sections(clean)
        self.check_required(path, "review", sections)
        cl = sections.get("checklist")
        fails = []
        if cl:
            rows = cl.table_rows()
            if not rows:
                self.add(path, cl.start, "empty-checklist", "Checklist has no rows")
            for n, cells in rows:
                if len(cells) < 4:
                    self.add(path, n, "checklist-row", "row needs: #, check, result, evidence")
                    continue
                rid, result, evidence = cells[0], cells[2].upper(), cells[3]
                if result not in {"PASS", "FAIL"}:
                    self.add(path, n, "checklist-result", f"result must be PASS or FAIL, got '{cells[2]}'")
                if not evidence or evidence in {"—", "-", "n/a", "N/A"} or len(evidence) < 6:
                    self.add(path, n, "checklist-no-evidence", f"{rid} has no evidence (file:line, log line, or command output)")
                if result == "FAIL":
                    fails.append(rid)
        fl = sections.get("fail list")
        listed = set()
        if fl:
            for n, t in fl.bullets():
                body = t.strip()[2:]
                if body.lower() in {"none", "none."}:
                    continue
                m = re.match(r"(R\d+)", body)
                if m:
                    listed.add(m.group(1))
                if "rule:" not in body.lower() or "passing looks like:" not in body.lower() or not re.search(r"`[^`]+:\d+`", body):
                    self.add(path, n, "fail-entry", "fail entry needs `file:line`, 'rule:', and 'passing looks like:'")
        for rid in fails:
            if rid not in listed:
                self.add(path, cl.start if cl else 1, "fail-not-listed", f"{rid} is FAIL but has no Fail list entry")
        vd = sections.get("verdict")
        if vd:
            text = vd.text().strip().upper()
            if fails and "PASS" in text and "FAIL" not in text:
                self.add(path, vd.start, "verdict-mismatch", "Verdict says PASS but checklist has FAIL rows")
            if not fails and "FAIL" in text:
                self.add(path, vd.start, "verdict-mismatch", "Verdict says FAIL but no checklist row failed")

    def lesson(self, path: Path, lines: list[str]) -> None:
        clean = K.strip_html_comments(lines)
        self.check_placeholders(path, clean)
        # Each entry starts with '## ' and has the required bullets
        entries = K.parse_sections(clean)
        for key, sec in entries.items():
            if key in {"debt", "text-only debt"}:
                continue
            fields = {}
            for n, t in sec.bullets():
                m = re.match(r"^-\s*([A-Za-z ]+):\s*(.*)$", t.strip())
                if m:
                    fields[m.group(1).strip().lower()] = (n, m.group(2).strip())
            for req in ("what went wrong", "root cause", "rule", "enforced by", "proposed change", "status"):
                if req not in fields:
                    self.add(path, sec.start, "lesson-field", f"entry '{sec.title}' missing '{req}'")
            eb = fields.get("enforced by")
            if eb and eb[1].lower() not in ENFORCED_BY:
                self.add(path, eb[0], "lesson-enforced-by", f"must be one of {sorted(ENFORCED_BY)}")
            if eb and eb[1].lower() != "text-only":
                pc = fields.get("proposed change")
                if pc and pc[1].lower().startswith("none"):
                    self.add(path, pc[0], "lesson-no-change", "an enforced lesson must name the hook/lint/test change")
            if eb and eb[1].lower() == "text-only":
                pc = fields.get("proposed change")
                if pc and "reason" not in pc[1].lower():
                    self.add(path, pc[0], "lesson-debt-reason", "text-only lessons must state the reason they cannot be enforced yet")

    def run(self, path: Path, kind: str | None = None) -> None:
        kind = kind or detect_type(path)
        if kind is None:
            return
        if not path.is_file():
            self.add(path, 1, "missing-file", "file not found")
            return
        lines = K.read_lines(path)
        getattr(self, kind)(path, lines)


HIGH_RISK_KEYWORDS_SCAN = K.HIGH_RISK_KEYWORDS


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--repo", help="repository root (default: detect from first path or cwd)")
    ap.add_argument("--commit", help="resolve citations at this commit instead of the working tree")
    ap.add_argument("--type", choices=["research", "spec", "review", "lesson"], help="force document type")
    ap.add_argument("--changed", action="store_true", help="validate all changed docs per git status")
    ap.add_argument("--hook", action="store_true", help="read Claude Code hook JSON on stdin")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    a = ap.parse_args(argv)

    paths: list[Path] = [Path(p) for p in a.paths]
    hook_event = None
    if a.hook:
        data = K.read_hook_input()
        hook_event = data.get("hook_event_name")
        cwd = Path(data.get("cwd") or ".")
        fp = (data.get("tool_input") or {}).get("file_path")
        if fp:
            paths = [Path(fp) if Path(fp).is_absolute() else cwd / fp]
        else:
            a.changed = True
            if not a.repo:
                a.repo = str(cwd)

    root = Path(a.repo).resolve() if a.repo else K.repo_root((paths[0] if paths else Path.cwd()).resolve())
    if a.changed:
        paths = K.changed_docs(root)
    if not paths:
        if a.json:
            print(json.dumps({"ok": True, "violations": []}))
        return 0

    v = Validator(root, a.commit, K.load_kit_json(root))
    for p in paths:
        p = p if p.is_absolute() else (root / p)
        v.run(p.resolve(), a.type)

    if a.json:
        print(json.dumps({"ok": not v.v, "violations": [vars(x) for x in v.v]}, indent=2))
    else:
        for x in v.v:
            print(str(x), file=sys.stderr)
        if not v.v and not a.hook:
            print(f"validate-docs: {len(paths)} file(s) valid")
    if v.v:
        if a.hook and hook_event == "PostToolUse":
            # PostToolUse cannot block; return a decision so Claude must respond to the failures.
            print(json.dumps({"decision": "block", "reason": "validate-docs failed:\n" + "\n".join(map(str, v.v))}))
            return 0
        print(f"validate-docs: {len(v.v)} violation(s). Fix them before continuing.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
