#!/usr/bin/env node
// Materialize the fixture projects used by the planted-fault suite and the Phase 2 check.
// Usage: node planted-faults/make_fixtures.js [OUT_DIR]   (default: planted-faults/fixtures, git-ignored)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, realResolve } from '../kit/scripts/kitlib.js';
import * as F from '../kit/scripts/tests/fixtures.js';

const HERE = path.dirname(realResolve(fileURLToPath(import.meta.url)));

/** Python's str(Path(p)): no empty or "." components, no trailing slash. */
function pyPath(p) {
  const parts = p.split('/').filter((c) => c !== '' && c !== '.');
  const joined = parts.join('/');
  return p.startsWith('/') ? `/${joined}` : joined || '.';
}

export function main(argv) {
  const out = argv.length > 0 ? pyPath(argv[0]) : path.join(HERE, 'fixtures');
  if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
  F.nodeApi(path.join(out, 'node-api'));
  F.pythonService(path.join(out, 'python-service'));
  process.stdout.write(`fixtures written to ${out}: node-api, python-service\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
