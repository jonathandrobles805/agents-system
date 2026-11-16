#!/usr/bin/env node
// CI: run validate-docs on every doc changed versus the base branch (git status is empty in CI).
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import * as V from './validate_docs.js';
import { isMain } from './kitlib.js';

export function main(argv) {
  const ap = C.makeParser('ci_changed_docs.js', [{ flag: '--repo', default: '.' }, { flag: '--base', default: 'origin/main' }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  // Without the base there is no list of changed docs, and an empty list would pass. Fetch it or fail.
  const why = C.ensureBase(root, a.base);
  if (why) return C.fail(`validate-docs: ${why}. The check compares this branch with its base; it cannot pass without one.`);
  const docs = C.changedFiles(root, a.base)
    .filter((f) => (f.startsWith('docs/') && f.endsWith('.md')) || f === 'LESSONS.md')
    .filter((f) => K.isFile(C.joinPath(root, f))); // a doc the branch deleted is not a doc to validate
  if (!docs.length) return C.ok('validate-docs: no docs changed');
  return V.main([...docs, '--repo', root]) ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
