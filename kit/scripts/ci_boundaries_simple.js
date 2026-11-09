#!/usr/bin/env node
// Fallback import-boundary check driven by ARCHITECTURE.md when a project has no dependency-cruiser / import-linter.
//
// Reads the Layers table:  | layer | `dir1`, `dir2` | may import from |
// A file in layer A may import only from A itself and the layers named in its "May import from" cell
// ("nothing in the app" = only its own layer). Imports outside all layers (third-party) are ignored.
// Supports JS/TS (import ... from '...', require('...')), Python (import x / from x import), Go (import "mod/..."), Rust (use crate::...).
//
//   ci_boundaries_simple.js --repo R [--arch ARCHITECTURE.md]
// Exit 1 on violations.
import fs from 'node:fs';
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import { isMain } from './kitlib.js';

const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs']);
// Python's \s and \w are Unicode-aware and Python's ^ (re.M) only follows '\n'; spelled out here.
const S = C.WS;
const W = String.raw`\p{L}\p{N}_`;
const JS_IMPORT = new RegExp(String.raw`(?:import${S}+(?:[^'"]*?${S}+from${S}+)?|require\()${S}*['"]([^'"]+)['"]`, 'g');
const PY_IMPORT = new RegExp(String.raw`(?<![^\n])${S}*(?:from${S}+([${W}.]+)${S}+import|import${S}+([${W}.]+))`, 'gu');
const GO_IMPORT = new RegExp(String.raw`"([${W}./-]+)"`, 'gu');
const RS_USE = new RegExp(String.raw`(?<![^\n])${S}*use${S}+crate::([${W}:]+)`, 'gu');

const NO_LAYER = new Set(['nothing in the app', 'nothing', 'none', '—', '-']);

export function layers(arch) {
  if (!K.isFile(arch)) return [];
  const sec = K.parseSections(K.stripHtmlComments(K.readLines(arch))).get('layers');
  const out = [];
  if (sec) {
    for (const [, cells] of sec.tableRows()) {
      if (cells.length >= 3 && !cells[0].startsWith('TODO')) {
        const dirs = cells[1].split(',').map((d) => K.stripChars(C.pyStrip(d), '`')).filter((d) => d !== '');
        const allowed = cells[2].split(/[,/]| and /).map(C.pyStrip).filter((a) => a !== '');
        out.push({ name: cells[0], dirs, allowed: new Set(allowed.filter((a) => !NO_LAYER.has(a.toLowerCase()))) });
      }
    }
  }
  return out;
}

export function layerOf(rel, ls) {
  let best = null;
  let blen = -1;
  for (const l of ls) {
    for (let d of l.dirs) {
      d = C.rstripChars(d, '/');
      if ((rel === d || rel.startsWith(d + '/')) && C.pyLen(d) > blen) {
        best = l.name;
        blen = C.pyLen(d);
      }
    }
  }
  return best;
}

function norm(p) {
  const parts = [];
  for (const part of p.split('/')) {
    if (part === '..') {
      if (parts.length) parts.pop();
    } else if (part !== '' && part !== '.') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** The repo-relative path the import points at (directory or file, without extension), or null for third-party. */
export function resolveImport(srcRel, spec, root) {
  const exists = (rel) => fs.existsSync(C.joinPath(root, rel));
  if (spec.startsWith('.')) {
    const joined = C.joinPath(C.pyParent(srcRel), spec);
    return !spec.startsWith('..') ? C.lstripChars(joined.replaceAll('/./', '/'), './') : norm(joined);
  }
  if (['src/', 'app/', 'lib/', 'internal/', 'pkg/', 'cmd/'].some((p) => spec.startsWith(p))) return spec;
  if (spec.startsWith('@/')) return 'src/' + spec.slice(2);
  // python dotted path relative to repo root
  if (spec.includes('.') && !spec.includes('/')) {
    const cand = spec.replaceAll('.', '/');
    if (exists(cand) || exists(cand + '.py') || K.isDir(C.joinPath(root, cand.split('/')[0]))) return cand;
  }
  if (exists(spec) || exists(spec + '.py')) return spec;
  return null;
}

export function importsIn(p) {
  const text = C.readText(p);
  const ext = C.pySuffix(p);
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) return [...text.matchAll(JS_IMPORT)].map((m) => m[1]);
  if (ext === '.py') return [...text.matchAll(PY_IMPORT)].map((m) => m[1] ?? m[2]);
  if (ext === '.go') return [...text.matchAll(GO_IMPORT)].map((m) => m[1]);
  if (ext === '.rs') return [...text.matchAll(RS_USE)].map((m) => 'src/' + m[1].replaceAll('::', '/'));
  return [];
}

export function main(argv) {
  const ap = C.makeParser('ci_boundaries_simple.js', [{ flag: '--repo', default: '.' }, { flag: '--arch', default: 'ARCHITECTURE.md' }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  const ls = layers(C.joinPath(root, a.arch));
  if (!ls.length) return C.ok('boundaries: no Layers table in ARCHITECTURE.md; nothing to check (fill it in, or configure a boundaries lint)');
  const violations = [];
  for (const f of C.pySplit(C.gitPy(['ls-files'], root))) {
    const p = C.joinPath(root, f);
    if (!SRC_EXT.has(C.pySuffix(f)) || !K.isFile(p)) continue;
    const srcLayer = layerOf(f, ls);
    if (!srcLayer) continue;
    const allowed = new Set([...ls.find((l) => l.name === srcLayer).allowed, srcLayer]);
    for (const spec of importsIn(p)) {
      const target = resolveImport(f, spec, root);
      if (!target) continue;
      const tgtLayer = layerOf(target, ls);
      if (tgtLayer && !allowed.has(tgtLayer)) {
        violations.push(`${f}: imports '${spec}' (${tgtLayer}); layer '${srcLayer}' may import only ${C.pyListRepr(C.sortedStrings(allowed))}`);
      }
    }
  }
  if (violations.length) return C.fail('boundaries: architecture violations:\n  ' + violations.join('\n  '));
  return C.ok(`boundaries: ok across ${ls.length} layer(s)`);
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
