#!/usr/bin/env node
// CI: every file changed on a lane branch must be in the spec's Files to change / Files to create (or lane-owned docs).
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import { isMain } from './kitlib.js';

export function main(argv) {
  const ap = C.makeParser('ci_scope_diff.js', [{ flag: '--repo', default: '.' }, { flag: '--base', default: 'origin/main' }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const slug = C.laneSlug(root);
  if (!slug) return C.ok('scope-diff: not a lane branch (wt/<slug>); skipped');
  const work = K.workRoot(root);
  const spec = C.joinPath(root, work, `${slug}.md`);
  if (!K.isFile(spec)) return C.fail(`scope-diff: lane branch for '${slug}' but ${C.relativeTo(spec, root)} does not exist`);
  const [, change, create] = K.specFileLists(spec);
  const allowed = [...change, ...create, `${work}/${slug}.progress.md`, `${work}/${slug}.review.md`, `${work}/${slug}.log`, `${work}/${slug}.events.jsonl`, `${K.decisionsRoot(root)}/*.md`, 'ROADMAP.md'];
  const extras = C.changedFiles(root, a.base).filter((f) => !K.globMatch(f, allowed));
  if (extras.length) {
    return C.fail('scope-diff: files changed outside the spec allow-list:\n  ' + extras.join('\n  ') + `\nAllowed: ${[...change, ...create].join(', ')}\nAmend the spec and re-approve, or revert these files.`);
  }
  return C.ok(`scope-diff: ${C.changedFiles(root, a.base).length} changed file(s), all within spec '${slug}'`);
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
