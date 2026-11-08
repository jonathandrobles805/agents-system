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

### Fixed (caught by tests before commit)
- `guard_edit`: always-allowed lane files masked an empty spec allow-list.
- `guard_read`: `.env.example*` was treated as a secret.
- `guard_bash`: `rm -rf ../sibling` escaped the project check when the project lived under `/tmp`.
- Kit's own research file failed `validate_docs` (numbered lines, missing slug/commit/Sources, a hedge word); fixed to the standard agents are held to.
