// Documents and project builders shared by several test files.
// (In the Python suite these lived inside test files and were imported across them.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonDumps } from '../kitlib.js';
import { nodeApi, commitAll } from './fixtures.js';
import { runScript, tmpPath } from './helpers.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const load = (name) => fs.readFileSync(path.join(DATA, name), 'utf8');

export const GOOD_RESEARCH = load('good-research.md');
export const GOOD_SPEC = load('good-spec.md');
export const GOOD_REVIEW = load('good-review.md');
export const GOOD_LESSONS = load('good-lessons.md');
const SPEC_TEMPLATE = load('spec.template.md');
const REVIEW_TEMPLATE = load('review.template.md');

const fill = (tpl, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), tpl);

/** The approved "Refund route" spec (Python: SPEC.format(commit=..., deps=..., extra=...)). */
export const spec = ({ commit, deps = 'none', extra = '' }) => fill(SPEC_TEMPLATE, { commit, deps, extra });

/** The review report (Python: REVIEW.format(head=..., verdict=...)). */
export const review = ({ head, verdict }) => fill(REVIEW_TEMPLATE, { head, verdict });

/** Write `text` to `rel` under `repo`, creating parent directories. Returns the full path. */
export function write(repo, rel, text) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

/** A bootstrapped node project with a queued roadmap and an approved (or not) "refund-route" spec. */
export function project(t, { status = 'approved', approved = true, wipLimit = 2, dir } = {}) {
  const root = nodeApi(path.join(dir ?? tmpPath(t), 'node-api'));
  runScript('bootstrap.js', ['--repo', root]);
  const kj = path.join(root, '.claude', 'kit.json');
  const d = JSON.parse(fs.readFileSync(kj, 'utf8'));
  d.wip_limit = wipLimit;
  fs.writeFileSync(kj, jsonDumps(d));
  const rm = path.join(root, 'ROADMAP.md');
  fs.writeFileSync(
    rm,
    fs.readFileSync(rm, 'utf8').replaceAll(
      '| TODO(bootstrap: ROADMAP.md — feature) | TODO(bootstrap: ROADMAP.md — slug) | M1 | queued | — | — | — |',
      '| Refund route | refund-route | M1 | queued | — | — | — |\n| Other | other | M1 | queued | — | — | — |',
    ),
  );
  const commit = commitAll(root, 'bootstrap');
  let text = spec({ commit: commit.slice(0, 7) }).replaceAll('- Status: approved', `- Status: ${status}`);
  if (!approved) text = text.replaceAll(`Approved by: Jonathan Robles on 2026-11-08 at ${commit.slice(0, 7)}`, 'Approved by: — on — at —');
  write(root, 'docs/specs/refund-route.md', text);
  commitAll(root, 'spec');
  return { root, commit };
}

/** Rewrite a bootstrapped project's hook commands the way the Python-era kit wrote them (python3 ... .py). */
export function toPythonEraKit(root) {
  for (const rel of ['.claude/settings.json', '.claude/kit.json']) {
    const p = path.join(root, rel);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/node (\\?"\$HOME\/\.claude\/kit\/(?:scripts|dashboard)\/[A-Za-z_]+)\.js/g, 'python3 $1.py'));
  }
}
