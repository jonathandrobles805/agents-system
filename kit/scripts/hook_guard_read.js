#!/usr/bin/env node
// PreToolUse on the tools that read files: block reads of secrets and credential files. Exit 2 blocks.
//
// Each tool names its target in a different field: `file_path` for Read, `notebook_path` for NotebookRead, and
// `path` for Grep and Glob [docs: https://code.claude.com/docs/en/permissions.md @ 2026-11-13]. Two more fields
// select files rather than naming one: Glob's `pattern` and Grep's `glob` are path globs, and a search filtered to
// `*.pem` is a read of every .pem it finds. Grep's `pattern` is a content regex, not a path, and is not checked:
// matching on what a lane searches FOR would be a word list, and the one that mattered would always be missing.
//
// What this closes: a search aimed AT a secret, by any of those fields. What it does not: a Grep over a directory
// that happens to contain one, which can still print a matching line. Claude Code applies `Read` deny rules to the
// directory a Grep or Glob resolves to on a best-effort basis (same docs), and the floor's deny list is what covers
// that case; this hook is the part that holds when the settings file does not.
import path from 'node:path';
import * as K from './kitlib.js';

const TEMPLATE_EXCEPTIONS = ['.env.example*', '.env.sample*', '.env.template*', '*.env.example', '*.env.sample'];

const text = (v) => (typeof v === 'string' ? v : '');

export function isSecret(rel, extra) {
  const name = path.basename(rel);
  if (K.globMatch(name, TEMPLATE_EXCEPTIONS)) return false;
  const pats = [...K.SECRET_READ_PATTERNS, ...extra];
  return K.globMatch(rel, pats) || K.globMatch(name, pats.filter((p) => !p.includes('/')));
}

/** Every field of this call that names or selects files, as repo-relative strings. */
export function readTargets(tool, ti, cwd, root) {
  const rel = (v) => K.relTo(root, path.isAbsolute(v) ? v : path.join(cwd, v));
  const out = [];
  for (const v of [text(ti.file_path), text(ti.notebook_path), text(ti.path)]) if (v) out.push(rel(v));
  // a path glob selects files the same way a path names one; a leading **/ or absolute form is kept as written
  for (const v of [tool === 'Glob' ? text(ti.pattern) : '', text(ti.glob)]) if (v) out.push(v.startsWith('/') ? rel(v) : v);
  return out;
}

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const cwd = text(d.cwd) || '.';
  const root = K.projectRoot(cwd);
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  const tool = text(d.tool_name);
  const targets = readTargets(tool, ti, cwd, root);
  if (!targets.length) return 0;
  // Patterns come from the kit, the floor and the project's additions; a loosened settings.json cannot remove any (KIT-SPEC 10.9).
  const extra = K.effectiveSecretPatterns(root).filter((p) => !K.SECRET_READ_PATTERNS.includes(p));
  for (const rel of targets) {
    if (!isSecret(rel, extra)) continue;
    K.appendEvent(path.join(root, '.claude', 'session', 'events.jsonl'), { event: 'blocked', tool: tool || 'Read', path: rel, result: 'blocked', summary: 'secret/credential file' });
    return K.block(`guard-read: '${rel}' matches a secret/credential pattern. Lanes never read secrets. ` +
      'If this file is required, the spec must declare it and a human must provide a redacted copy.');
  }
  return 0;
}

if (K.isMain(import.meta.url)) K.runGuard('guard-read', main);
