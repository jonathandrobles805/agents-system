#!/usr/bin/env node
// CI: any dependency added versus the base branch must be declared under the spec's '## New dependencies'.
import * as K from './kitlib.js';
import * as C from './ci_common.js';
import { isMain } from './kitlib.js';

const S = C.WS;
const NS = C.NWS;
const PYPROJECT_QUOTED = new RegExp(String.raw`"([A-Za-z][A-Za-z0-9_.\-]*)(?:\[[^\]]*\])?${S}*(?:[>=<~!;,@ ][^"]*)?"`, 'g');
const PYPROJECT_TABLE = new RegExp(String.raw`^${S}*([A-Za-z][A-Za-z0-9_.\-]*)${S}*=${S}*(?:"\^|\{)`, 'gm');
const REQ_LINE = new RegExp(String.raw`^${S}*([A-Za-z][A-Za-z0-9_.\-]+)`);
const GO_REQ = new RegExp(String.raw`^${S}*[a-z0-9.\-]+\.[a-z]+/${NS}+${S}+v`);
const CARGO_DEP = new RegExp(String.raw`^${S}*([A-Za-z0-9_\-]+)${S}*=`);
const SPEC_DEP = new RegExp(String.raw`^${S}*-${S}*` + '`?' + String.raw`([@A-Za-z0-9_./\-]+)`);

function getAttr(d, key) {
  // Python: d.get(key); AttributeError when d is not a dict
  if (!C.isPlainObject(d)) throw new Error(`'${C.pyTypeName(d)}' object has no attribute 'get'`);
  return C.dictGet(d, key, null);
}

export function depsAt(root, ref) {
  const names = new Set();
  const pj = C.fileLinesAt(root, 'package.json', ref);
  if (pj && pj.length) {
    let d;
    let parsed = true;
    try {
      d = JSON.parse(pj.join('\n'));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      parsed = false;
    }
    if (parsed) {
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const v = getAttr(d, k);
        const section = C.truthy(v) ? v : {};
        if (!C.isPlainObject(section)) throw new Error(`'${C.pyTypeName(section)}' object has no attribute 'keys'`);
        for (const key of Object.keys(section)) names.add(key);
      }
    }
  }
  const pp = C.fileLinesAt(root, 'pyproject.toml', ref);
  if (pp && pp.length) {
    const txt = pp.join('\n');
    for (const m of txt.matchAll(PYPROJECT_QUOTED)) names.add(m[1].toLowerCase());
    for (const m of txt.matchAll(PYPROJECT_TABLE)) names.add(m[1].toLowerCase());
  }
  for (const f of ['requirements.txt', 'requirements-dev.txt', 'Pipfile']) {
    const lines = C.fileLinesAt(root, f, ref);
    if (lines && lines.length) {
      for (const l of lines) {
        const m = REQ_LINE.exec(l);
        if (m && !['#', '-', '['].some((c) => C.pyStrip(l).startsWith(c))) names.add(m[1].toLowerCase());
      }
    }
  }
  const gm = C.fileLinesAt(root, 'go.mod', ref);
  if (gm && gm.length) {
    for (const l of gm) if (GO_REQ.test(l)) names.add(C.pySplit(l)[0]);
  }
  const ct = C.fileLinesAt(root, 'Cargo.toml', ref);
  if (ct && ct.length) {
    let inDeps = false;
    for (const l of ct) {
      if (l.startsWith('[')) {
        inDeps = l.includes('dependencies');
      } else if (inDeps) {
        const m = CARGO_DEP.exec(l);
        if (m) names.add(m[1].toLowerCase());
      }
    }
  }
  return names;
}

export function declared(spec) {
  if (!K.isFile(spec)) return new Set();
  const sec = K.parseSections(K.stripHtmlComments(K.readLines(spec))).get('new dependencies');
  const out = new Set();
  if (sec) {
    for (const [, t] of sec.bullets()) {
      const m = SPEC_DEP.exec(t);
      if (m && m[1].toLowerCase() !== 'none') {
        out.add(!m[1].startsWith('@') ? m[1].toLowerCase().split('@')[0] : '@' + m[1].slice(1).split('@')[0]);
      }
    }
  }
  return out;
}

export function main(argv) {
  const ap = C.makeParser('ci_dep_diff.js', [{ flag: '--repo', default: '.' }, { flag: '--base', default: 'origin/main' }]);
  const a = C.parseArgs(ap, argv);
  const root = K.realResolve(a.repo);
  let base;
  try {
    base = depsAt(root, a.base);
  } catch (e) {
    return C.ok(`dep-diff: cannot read base (${e.pyMessage ?? e.message}); skipped`);
  }
  const baseLower = new Set([...base].map((d) => d.toLowerCase()));
  const added = new Set([...depsAt(root, null)].map((d) => d.toLowerCase()).filter((d) => !baseLower.has(d)));
  if (!added.size) return C.ok('dep-diff: no new dependencies');
  const slug = C.laneSlug(root);
  const decl = slug ? declared(C.joinPath(root, 'docs', 'specs', `${slug}.md`)) : new Set();
  const undeclared = C.sortedStrings([...added].filter((d) => !decl.has(d)));
  if (undeclared.length) {
    return C.fail(`dep-diff: dependencies added but not declared in the spec's New dependencies: ${undeclared.join(', ')}`);
  }
  return C.ok(`dep-diff: ${added.size} new dependenc${added.size === 1 ? 'y' : 'ies'}, all declared`);
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
