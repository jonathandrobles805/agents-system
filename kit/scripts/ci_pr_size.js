#!/usr/bin/env node
// CI (warning): flag large PRs. Big PRs mean the spec should have been split.
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import { isMain } from './kitlib.js';

const sumOf = (stat, re) => [...stat.matchAll(re)].reduce((n, m) => n + parseInt(m[1], 10), 0);

export function main(argv) {
  const ap = C.makeParser('ci_pr_size.js', [{ flag: '--repo', default: '.' }, { flag: '--base', default: 'origin/main' }, { flag: '--max-files', int: true, default: 25 }, { flag: '--max-lines', int: true, default: 800 }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const files = C.changedFiles(root, a.base);
  let stat;
  try {
    stat = C.gitPy(['diff', '--shortstat', `${a.base}...HEAD`], root);
  } catch {
    stat = '';
  }
  const ins = sumOf(stat, /(\d+) insertion/g);
  const dele = sumOf(stat, /(\d+) deletion/g);
  if (files.length > a.max_files || ins + dele > a.max_lines) {
    return C.fail(`pr-size: ${files.length} files, ${ins + dele} lines changed (limits ${a.max_files}/${a.max_lines}). Split the next spec into slices.`);
  }
  return C.ok(`pr-size: ${files.length} files, ${ins + dele} lines`);
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
