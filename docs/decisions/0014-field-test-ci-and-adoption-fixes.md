# 0014 Field test fixes: CI that cannot fake green, kit via its own action, adopt without dropping

Date: 2026-11-11 · Status: accepted · Evidence: hya-sandbox PR #1 (bootstrap on a copy of HYA)

## Context
The first real bootstrap left CI red in 7 of 10 jobs, none for the project's code: the kit repository is private, so the cross-repo checkout failed; jobs ran project commands without installing dependencies; an unquoted fallback broke bash; `gitleaks-action` needed write scopes; the audit had no way to record known, accepted advisories. Two jobs were green only because they ran `echo`. Bootstrap also replaced the project's own hooks, skipped the kit block in an existing `CLAUDE.md`, reverted confirmed commands on `--upgrade`, and proposed a boundaries command aimed at a folder and config that did not exist.

## Decision
1. A CI command is a command, `none: <reason>` (visible warning), or missing (error, exit 1). Nothing passes by echoing.
2. Setup and install run before every project command; commands are block scalars.
3. The kit reaches CI through a root composite action pinned to the installed kit's commit (else the version tag); private repos grant access once in the kit repo's Actions settings. No PAT, no public repo, no vendored copy.
4. Workflow token is `contents: read`; gitleaks runs as a pinned, checksum-verified binary.
5. npm audit is a ratchet with human, expiring acceptances.
6. Bootstrap merges hooks (kit entries replaced, project entries kept); guards-present checks the kit's entries are present and unchanged, not that nothing else exists. An existing `CLAUDE.md` gets the marked kit block appended once. Commands: detected < kit.json < answers; an older kit default is migrated. Detected commands are checked against the files they name and carry their evidence.

## Alternatives rejected
- Make the kit public: exposes the kit; the owner's call, not needed.
- A PAT secret per project: expires, one more secret to leak.
- Vendor the kit into every project: ~600 KB of foreign JS that the project's own linters, formatters and structure checks would trip over (HYA's root allow-list already did on five files).
- Keep `echo` placeholders: a green check that checks nothing is the failure this kit exists to prevent.

## Consequences
After `/bootstrap --upgrade`, a project with unanswered commands sees red jobs that say exactly what to set. The kit repo needs one Actions access setting. Planted faults 39–44.
