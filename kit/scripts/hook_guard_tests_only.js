#!/usr/bin/env node
// PreToolUse on Edit|Write for the tester agent: only test files and lane-owned docs may be written. Exit 2 blocks.
import path from 'node:path';
import * as K from './kitlib.js';

export const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e|fixtures|testdata)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|rs)$|(^|\/)conftest\.py$|vitest\.config|jest\.config|pytest\.ini/;

const text = (v) => (typeof v === 'string' ? v : '');

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const cwd = text(d.cwd) || '.';
  const root = K.projectRoot(cwd);
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  const fp = text(ti.file_path) || text(ti.notebook_path);
  if (!fp) return 0;
  const rel = K.relTo(root, path.isAbsolute(fp) ? fp : path.join(cwd, fp));
  const lane = K.findLane(cwd);
  if (lane && K.globMatch(rel, lane.alwaysAllowed())) return 0;
  if (TEST_PATH.test(rel)) return 0;
  return K.block(`guard-tests-only: '${rel}' is not a test file. The tester writes tests and test helpers only; application code is the implementer's job.`);
}

if (K.isMain(import.meta.url)) K.runGuard('guard-tests-only', main);
