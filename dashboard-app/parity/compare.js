#!/usr/bin/env node
// Diff a capture against the baseline. Reports real numbers and exits 1 on any difference.
//
//   node parity/compare.js [CAPTURE_DIR] [BASELINE_DIR]
//     defaults: parity/results/react/capture   parity/baseline
//
// png        pixelmatch with threshold 0 (any channel difference counts); differing pixels and a diff image
// dom.txt    exact line comparison of the normalised DOM (rules in helpers.js normalizedDom)
// text.txt   exact comparison of innerText
// styles.json every computed property of every probe, plus its bounding rect
// log.txt    the request list (method, path, status) and console; ports are not in it
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CAP = path.resolve(process.argv[2] ?? path.join(HERE, 'results', 'react', 'capture'));
const BASE = path.resolve(process.argv[3] ?? path.join(HERE, 'baseline'));
const DIFF = path.join(path.dirname(CAP), 'diff');
fs.rmSync(DIFF, { recursive: true, force: true });
fs.mkdirSync(DIFF, { recursive: true });

const rows = [];
let bad = 0;
const missing = [];

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  let n = 0, first = null;
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) { n++; if (first === null) first = { line: i + 1, base: A[i], got: B[i] }; }
  }
  return { n, first };
}

for (const f of fs.readdirSync(BASE).sort()) {
  const b = path.join(BASE, f), c = path.join(CAP, f);
  if (!fs.existsSync(c)) { missing.push(f); bad++; continue; }
  if (f.endsWith('.png')) {
    const A = PNG.sync.read(fs.readFileSync(b)), B = PNG.sync.read(fs.readFileSync(c));
    if (A.width !== B.width || A.height !== B.height) { rows.push([f, `size ${A.width}x${A.height} vs ${B.width}x${B.height}`]); bad++; continue; }
    const out = new PNG({ width: A.width, height: A.height });
    const px = pixelmatch(A.data, B.data, out.data, A.width, A.height, { threshold: 0, includeAA: true });
    if (px) { fs.writeFileSync(path.join(DIFF, f), PNG.sync.write(out)); rows.push([f, `${px} px (${(100 * px / (A.width * A.height)).toFixed(4)}%)`]); bad++; }
    else rows.push([f, '0 px']);
  } else if (f.endsWith('.styles.json')) {
    const A = JSON.parse(fs.readFileSync(b, 'utf8')), B = JSON.parse(fs.readFileSync(c, 'utf8'));
    let n = 0; const ex = [];
    for (const sel of Object.keys(A)) {
      if (!B[sel]) { n++; ex.push(`${sel}: missing`); continue; }
      for (const k of Object.keys(A[sel])) if (A[sel][k] !== B[sel][k]) { n++; if (ex.length < 3) ex.push(`${sel} ${k}: ${A[sel][k]} → ${B[sel][k]}`); }
    }
    rows.push([f, n ? `${n} props differ: ${ex.join('; ')}` : '0 props']);
    if (n) bad++;
  } else if (f.endsWith('.dom.txt')) {
    // A real line diff (diff -U0), after two stated, symmetric steps (applied to both files):
    //  - the <div id="root" style="display: contents;"> wrapper is removed and its subtree dedented (decision #76;
    //    its presence and display:contents are asserted separately by the computed-style probe '#root');
    //  - <script> elements and the length line of <script>/<style> are removed (the build inlines a bundle and moves
    //    scripts to <head>; the CSS text itself is checked byte for byte by parity/check-build.js).
    const prep = (t) => {
      const out = [];
      let rootIndent = -1;
      const lines = t.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let l = lines[i];
        const ind = l.length - l.trimStart().length;
        if (rootIndent >= 0 && l.trim() && ind <= rootIndent) rootIndent = -1;
        if (l.trim() === '<div id="root" style="display: contents;">') { rootIndent = ind; continue; }
        if (rootIndent >= 0) l = l.slice(2);
        if (/^\s*<script\b/.test(l) || /^\s*#\d+ chars$/.test(l)) continue;
        out.push(l);
      }
      return out.join('\n') + '\n';
    };
    const ta = path.join(DIFF, f + '.base'), tb = path.join(DIFF, f + '.got');
    fs.writeFileSync(ta, prep(fs.readFileSync(b, 'utf8')));
    fs.writeFileSync(tb, prep(fs.readFileSync(c, 'utf8')));
    const r = spawnSync('diff', ['-U0', ta, tb], { encoding: 'utf8' });
    const changed = r.stdout.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    if (changed.length) { fs.writeFileSync(path.join(DIFF, f + '.diff'), r.stdout); rows.push([f, `${changed.length} lines differ; first: ${changed.slice(0, 2).join(' | ').slice(0, 300)}`]); bad++; }
    else { rows.push([f, '0 lines']); fs.rmSync(ta); fs.rmSync(tb); }
  } else {
    // log.txt: the request part is compared as a sorted list. Concurrent fetches (/api/status, /api/architecture)
    // finish in either order on the same build, so their order is not a property of the page. Console part: exact.
    const norm = (s) => {
      if (!f.endsWith('.log.txt')) return s;
      const at = s.indexOf('-- console');
      return s.slice(0, at).split('\n').filter(Boolean).sort().join('\n') + '\n' + s.slice(at);
    };
    const d = lineDiff(norm(fs.readFileSync(b, 'utf8')), norm(fs.readFileSync(c, 'utf8')));
    rows.push([f, d.n ? `${d.n} lines differ; first at ${d.first.line}: ${JSON.stringify(d.first.base)} → ${JSON.stringify(d.first.got)}` : '0 lines']);
    if (d.n) bad++;
  }
}
const kinds = {};
for (const [f, r] of rows) {
  const k = f.replace(/^.*@\d+\./, '');
  kinds[k] ??= { files: 0, differing: 0 };
  kinds[k].files++;
  if (!/^0 (px|props|lines)$/.test(r)) kinds[k].differing++;
}
const report = { capture: CAP, baseline: BASE, files: rows.length + missing.length, missing, by_kind: kinds, differing: rows.filter(([, r]) => !/^0 (px|props|lines)$/.test(r)) };
fs.writeFileSync(path.join(path.dirname(CAP), 'compare.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({ ...report, differing: report.differing.slice(0, 40) }, null, 1));
process.exitCode = bad ? 1 : 0;
