# Changelog

All notable changes to the kit. Each entry names the decision or lesson that caused it.

## [Unreleased]

### Added
- Phase 0: kit specification 0.2.0 approved (docs/KIT-SPEC.md).
- Phase 1a: kit layout, `install.sh` (idempotent, symlink or copy), 11 templates.
- Phase 1b: `validate_docs.py` enforcing provenance tags, citation resolution (working tree or `--commit`), hedge words, spec/review/lesson structure; 32 tests.
- Phase 1c: hook scripts `guard_edit`, `guard_read`, `guard_bash`, `read_log`, `event_log`, `post_edit_check`, `budget_check`, `done_check`, `config_guard`, `notify`, `session_context`; 31 tests.
- Phase 1d: agents `researcher`, `planner`, `spec-critic`, `implementer`, `reviewer`, `retro` with embedded hooks; structural tests.
- Phase 1e: project settings fragment `kit/hooks/settings.project.json`, kit CI (`.github/workflows/kit.yml`), decision 0005.
- Phase 2a: `bootstrap.py` (detect stack, frameworks, tools, CI, folder map, credential files, branch drift; generate the project layer; `--answers`, `--dry-run`, `--detect-only`, `--upgrade` with backup, `--protect` via gh), stack definitions for Node, Python, Go, Rust.
- Phase 2b: project CI template `kit/ci/github.yml` and CI scripts `ci_scope_diff`, `ci_test_count`, `ci_dep_diff`, `ci_claude_md_cap`, `ci_guards_present`, `ci_changed_docs`, `ci_review_report`, `ci_pr_size`; review template gains a `Head:` line so CI can tie a report to a commit.
- Phase 2c: `/bootstrap` command, fixture generator `planted-faults/make_fixtures.py` (node-api, python-service).

### Notes
- Project CI checks out the kit at `ref: main` until the first tagged release; `/bootstrap --upgrade` will switch projects to tags from 1.0.

### Fixed (caught by tests before commit)
- `guard_edit`: always-allowed lane files masked an empty spec allow-list.
- `guard_read`: `.env.example*` was treated as a secret.
- `guard_bash`: `rm -rf ../sibling` escaped the project check when the project lived under `/tmp`.
- Kit's own research file failed `validate_docs` (numbered lines, missing slug/commit/Sources, a hedge word); fixed to the standard agents are held to.
