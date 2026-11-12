#!/usr/bin/env node
// PreToolUse on Edit|Write for the tester agent: only test files and lane-owned docs may be written. Exit 2 blocks.
import path from 'node:path';
import * as K from './kitlib.js';

export const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e|fixtures|testdata)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|rs)$|(^|\/)conftest\.py$|vitest\.config|jest\.config|pytest\.ini/;

const text = (v) => (typeof v === 'string' ? v : '');

/** Files named in the spec's Done-criteria test column (`path::name` or `path`), only once a human approved the spec. */
export function criterionTestFiles(specPath) {
  const out = new Set();
  if (!K.isFile(specPath)) return out;
  const lines = K.readLines(specPath);
  if (!lines.some((l) => /^Approved by:/.test(l))) return out;
  const dc = K.parseSections(K.stripHtmlComments(lines)).get('done-criteria');
  if (!dc) return out;
  for (const [, cells] of dc.tableRows()) {
    const m = /`([^`:\s]+\.[A-Za-z0-9]+)(?:::[^`]*)?`/.exec(cells[2] ?? '');
    if (m) out.add(m[1]);
  }
  return out;
}

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const cwd = text(d.cwd) || '.';
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  const fp = text(ti.file_path) || text(ti.notebook_path);
  if (!fp) return 0;
  const abs = path.isAbsolute(fp) ? fp : path.join(cwd, fp);
  const lane = K.laneFor(cwd, abs);
  const root = lane ? lane.root : K.projectRoot(cwd);
  const rel = K.relTo(root, abs);
  if (lane && K.globMatch(rel, lane.alwaysAllowed())) return 0;
  if (TEST_PATH.test(rel)) return 0;
  // A file the approved spec names as a criterion's test (for example a check in a verify script) is the tester's to
  // write, even when it does not look like a test file (field test #43).
  if (lane && criterionTestFiles(lane.specPath).has(rel)) return 0;
  return K.block(`guard-tests-only: '${rel}' is not a test file. The tester writes tests and test helpers only; application code is the implementer's job.`);
}

if (K.isMain(import.meta.url)) K.runGuard('guard-tests-only', main);
