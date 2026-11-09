#!/usr/bin/env node
// PreToolUse on Read: block reads of secrets and credential files. Exit 2 blocks.
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

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const cwd = text(d.cwd) || '.';
  const root = K.projectRoot(cwd);
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  const fp = text(ti.file_path) || text(ti.notebook_path);
  if (!fp) return 0;
  const rel = K.relTo(root, path.isAbsolute(fp) ? fp : path.join(cwd, fp));
  const extra = (K.loadKitJson(root)?.secret_patterns ?? []);
  if (isSecret(rel, Array.isArray(extra) ? extra.filter((p) => typeof p === 'string') : [])) {
    K.appendEvent(path.join(root, '.claude', 'session', 'events.jsonl'), { event: 'blocked', tool: 'Read', path: rel, result: 'blocked', summary: 'secret/credential file' });
    return K.block(`guard-read: '${rel}' matches a secret/credential pattern. Lanes never read secrets. ` +
      'If this file is required, the spec must declare it and a human must provide a redacted copy.');
  }
  return 0;
}

if (K.isMain(import.meta.url)) K.runGuard('guard-read', main);
