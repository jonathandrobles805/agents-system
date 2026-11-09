#!/usr/bin/env node
// CI: a lane branch needs docs/specs/<slug>.review.md that validates, has Verdict PASS, and names the current HEAD.
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import * as V from './validate_docs.js';
import { isMain } from './kitlib.js';

const S = C.WS;
// Python's re.M: ^ after '\n' only, $ before '\n' or at the end.
const VERDICT_PASS = new RegExp(String.raw`(?<![^\n])## Verdict${S}*\n+${S}*PASS${S}*(?=\n|$)`);
const HEAD_LINE = new RegExp(String.raw`(?<![^\n])- Head:${S}*([0-9a-f]{7,40})`);

export function main(argv) {
  const ap = C.makeParser('ci_review_report.js', [{ flag: '--repo', default: '.' }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const slug = C.laneSlug(root);
  if (!slug) return C.ok('review-report: not a lane branch; skipped');
  const rep = C.joinPath(root, 'docs', 'specs', `${slug}.review.md`);
  if (!K.isFile(rep)) return C.fail(`review-report: ${C.relativeTo(rep, root)} missing; run /review`);
  if (V.main([rep, '--repo', root])) return C.fail('review-report: report does not validate');
  const text = C.readText(rep);
  if (!VERDICT_PASS.test(text)) return C.fail('review-report: Verdict is not PASS');
  const head = C.pyStrip(C.gitPy(['rev-parse', 'HEAD'], root));
  const m = HEAD_LINE.exec(text);
  if (!m) return C.fail("review-report: no '- Head: <sha>' line; the report must name the commit it reviewed");
  if (!K.reviewHeadOk(root, m[1])) {
    return C.fail(`review-report: report reviewed ${m[1]} but HEAD is ${head.slice(0, 12)}; code changed after review. Run /review again.`);
  }
  return C.ok(`review-report: PASS for ${m[1]}`);
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
