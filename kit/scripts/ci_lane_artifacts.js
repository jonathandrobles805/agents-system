#!/usr/bin/env node
// CI: lane artifacts live in exactly one tree and product code never does (KIT-SPEC 10.11).
//
// The tree is kit.json paths.work (default docs/specs). Fails when a lane artifact (*.progress.md, *.review.md,
// *.events.jsonl, or a spec file titled `# Spec:`) sits outside it, or when a source file sits inside it.
//
//   node ci_lane_artifacts.js --repo .
import fs from 'node:fs';
import path from 'node:path';
import * as K from './kitlib.js';
import * as C from './ci_common.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', 'coverage', '.claude']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.swift', '.sh', '.sql', '.css', '.scss', '.html', '.vue', '.svelte']);
const SPEC_TITLE = /^# Spec:/m; // research files also carry a Slug header; only specs carry this title

function* walk(root, dir = root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(root, p);
    } else if (e.isFile()) yield p;
  }
}

/** Findings for one repo. Pure. */
export function check(root) {
  const work = K.workRoot(root);
  const problems = [];
  for (const abs of walk(root)) {
    const rel = K.relTo(root, abs);
    const name = path.basename(rel);
    const inside = rel === work || rel.startsWith(work + '/');
    const isArtifactName = K.globMatch(name, K.LANE_ARTIFACT_PATTERNS);
    let isSpec = false;
    if (!inside && !isArtifactName && name.endsWith('.md') && rel.startsWith('docs/')) {
      try {
        isSpec = SPEC_TITLE.test(fs.readFileSync(abs, 'utf8').slice(0, 400));
      } catch {
        isSpec = false;
      }
    }
    if (!inside && (isArtifactName || isSpec)) problems.push(`${rel}: lane artifact outside ${work}/`);
    if (inside && CODE_EXT.has(path.extname(name))) problems.push(`${rel}: source file inside the lane artifact tree ${work}/`);
  }
  return problems;
}

export function main(argv) {
  const ap = C.makeParser('ci_lane_artifacts.js', [{ flag: '--repo', default: '.' }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const problems = check(root);
  if (problems.length) return C.fail('lane-artifacts:\n  ' + problems.join('\n  '));
  return C.ok(`lane-artifacts: all lane artifacts under ${K.workRoot(root)}/, no source inside it`);
}

if (K.isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
