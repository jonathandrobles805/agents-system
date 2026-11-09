#!/usr/bin/env node
// CI: the number of test cases must not drop versus the base branch unless the spec says 'Test count may drop:' with a reason.
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import { isMain } from './kitlib.js';

const S = C.WS;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|rs)$/;
// Python's re.M ^ (after '\n' only) and \b (Unicode-aware) spelled out; the text is a "\n".join of split lines.
const CASE = new RegExp(
  String.raw`^${S}*(it|test|describe\.each|it\.each|test\.each)${S}*\(|^${S}*def test_|^${S}*func Test[A-Z]|^${S}*#\[test\]|^${S}*@Test(?![\p{L}\p{N}_])`,
  'gmu',
);

export function countAt(root, ref) {
  const files = C.pySplit(ref ? C.gitPy(['ls-tree', '-r', '--name-only', ref], root) : C.gitPy(['ls-files'], root));
  let n = 0;
  for (const f of files) {
    if (!TEST_FILE.test(f)) continue;
    const lines = C.fileLinesAt(root, f, ref);
    if (lines && lines.length) n += [...lines.join('\n').matchAll(CASE)].length;
  }
  return n;
}

export function main(argv) {
  const ap = C.makeParser('ci_test_count.js', [{ flag: '--repo', default: '.' }, { flag: '--base', default: 'origin/main' }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  let baseN;
  try {
    baseN = countAt(root, a.base);
  } catch (e) {
    return C.ok(`test-count: cannot read base ${a.base} (${e.pyMessage ?? e.message}); skipped`);
  }
  const headN = countAt(root, null);
  if (headN < baseN) {
    const slug = C.laneSlug(root);
    const spec = slug ? C.joinPath(root, 'docs', 'specs', `${slug}.md`) : null;
    if (spec && K.isFile(spec) && new RegExp(String.raw`Test count may drop:${S}*${C.NWS}`).test(C.readText(spec))) {
      return C.ok(`test-count: ${baseN} -> ${headN}, drop declared in spec`);
    }
    return C.fail(`test-count: tests dropped from ${baseN} to ${headN}. Deleting tests is not a fix. If intentional, add 'Test count may drop: <reason>' to the spec and re-approve.`);
  }
  return C.ok(`test-count: ${baseN} -> ${headN}`);
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
