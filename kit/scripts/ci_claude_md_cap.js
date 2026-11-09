#!/usr/bin/env node
// CI: CLAUDE.md must stay under the cap in .claude/kit.json (default 4000 bytes). A long CLAUDE.md is skimmed; move rules into checks.
import fs from 'node:fs';
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import { isMain } from './kitlib.js';

export function main(argv) {
  const ap = C.makeParser('ci_claude_md_cap.js', [{ flag: '--repo', default: '.' }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const cap = C.pyInt(C.dictGet(K.loadKitJson(root), 'claude_md_cap_bytes', 4000));
  const p = C.joinPath(root, 'CLAUDE.md');
  if (!K.isFile(p)) return C.fail('claude-md-cap: CLAUDE.md missing');
  const n = fs.readFileSync(p).length;
  if (n > cap) {
    return C.fail(`claude-md-cap: CLAUDE.md is ${n} bytes, cap ${cap}. Move enforced rules out (they are in hooks) or raise the cap in .claude/kit.json with a decision record.`);
  }
  return C.ok(`claude-md-cap: ${n}/${cap} bytes`);
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
