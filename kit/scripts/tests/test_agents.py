"""Structural checks on the agent definitions: frontmatter, line cap, and that every hook command points at a real kit script."""
import re
from pathlib import Path

KIT = Path(__file__).resolve().parents[2]
AGENTS = sorted((KIT / "agents").glob("*.md"))
EXPECTED = {"researcher", "planner", "spec-critic", "tester", "implementer", "reviewer", "retro"}


def frontmatter(text: str) -> str:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    assert m, "missing frontmatter"
    return m.group(1)


def test_all_six_agents_exist():
    assert {p.stem for p in AGENTS} == EXPECTED


def test_frontmatter_fields_and_line_cap():
    for p in AGENTS:
        text = p.read_text()
        fm = frontmatter(text)
        assert re.search(rf"^name:\s*{re.escape(p.stem)}\s*$", fm, re.M), p
        assert re.search(r"^description:\s*\S", fm, re.M), p
        assert re.search(r"^tools:\s*\S", fm, re.M), p
        assert re.search(r"^model:\s*\S", fm, re.M), p
        assert len(text.splitlines()) <= 120, (p, len(text.splitlines()))


def test_hook_commands_reference_existing_scripts():
    for p in AGENTS:
        fm = frontmatter(p.read_text())
        for m in re.finditer(r'command:\s*python3\s+"\$HOME/\.claude/kit/scripts/([a-z_]+\.py)"', fm):
            assert (KIT / "scripts" / m.group(1)).is_file(), (p.name, m.group(1))
        # every 'command:' line must match the pattern above (no stray shell)
        for line in fm.splitlines():
            if line.strip().startswith("command:"):
                assert "$HOME/.claude/kit/scripts/" in line, (p.name, line)


def test_read_only_agents_cannot_edit_source():
    for name in ("researcher", "planner", "reviewer", "retro", "spec-critic"):
        fm = frontmatter((KIT / "agents" / f"{name}.md").read_text())
        tools = re.search(r"^tools:\s*(.+)$", fm, re.M).group(1)
        assert "MultiEdit" not in tools, name
        if name in ("researcher", "planner", "reviewer", "retro"):
            assert "Edit" not in tools.replace("MultiEdit", ""), name


def test_implementer_has_all_guard_hooks():
    fm = frontmatter((KIT / "agents" / "implementer.md").read_text())
    for script in ("hook_guard_edit.py", "hook_guard_read.py", "hook_guard_bash.py", "hook_read_log.py",
                   "hook_post_edit_check.py", "hook_event_log.py", "hook_budget_check.py", "hook_done_check.py"):
        assert script in fm, script


def test_writing_agents_validate_on_stop():
    for name in ("researcher", "planner", "reviewer"):
        fm = frontmatter((KIT / "agents" / f"{name}.md").read_text())
        assert "SubagentStop" in fm and "validate_docs.py" in fm, name


def test_tester_cannot_write_app_code():
    fm = frontmatter((KIT / "agents" / "tester.md").read_text())
    assert "hook_guard_tests_only.py" in fm and "hook_guard_edit.py" in fm and "hook_post_edit_check.py" in fm
