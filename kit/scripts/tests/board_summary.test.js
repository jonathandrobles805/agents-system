// Hardening plan Step 10, the drawer: "add `## Summary` to the progress, review ... templates, and make validate_docs
// require it" (3e, G4). Files created from now on need it; existing files are a stated exception, so no old lane fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpPath } from './helpers.js';
import * as V from '../validate_docs.js';

const TEMPLATES = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'templates');
const GOOD_REVIEW = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'data', 'good-review.md'), 'utf8');

/** The summary violations validate_docs reports for `text` written as docs/specs/<name>. */
function summaryViolations(t, name, text) {
  const root = tmpPath(t);
  const p = path.join(root, 'docs', 'specs', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  const v = new V.Validator(root, null, {});
  v.run(p);
  return v.v.filter((x) => x.rule === 'missing-summary');
}
const withSummary = (text) => text.replace(/\n## /, '\n## Summary\n\nThe change and what it means.\n\n## ');
const dated = (text, field, date) => text.replace(new RegExp(`^- ${field}: .*$`, 'm'), `- ${field}: ${date}`);
const PROGRESS = '# Progress: x\n\n- Spec: `docs/specs/x.md`\n- Started: 2026-11-27T09:00:00\n\n## Done-criteria\n\n| # | Criterion | Test | Red run | Green run |\n|---|---|---|---|---|\n';

test('3e: the progress and review templates have a Summary section, right after the header', () => {
  for (const name of ['progress.md', 'review.md']) {
    const text = fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
    const first = /\n## ([^\n]+)/.exec(text);
    assert.equal(first?.[1], 'Summary', `${name}: the first section is ${first?.[1]}`);
  }
});

test('3e: a review dated from the cutover needs ## Summary; with one it passes that rule', (t) => {
  const review = dated(GOOD_REVIEW, 'Date', '2026-11-27T10:00:00');
  const v = summaryViolations(t, 'x.review.md', review);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /## Summary/);
  assert.deepEqual(summaryViolations(t, 'x.review.md', withSummary(review)), []);
});

test('3e: a progress file dated from the cutover needs ## Summary; with one it passes', (t) => {
  assert.equal(summaryViolations(t, 'x.progress.md', PROGRESS).length, 1);
  assert.deepEqual(summaryViolations(t, 'x.progress.md', withSummary(PROGRESS)), []);
});

test('3e: the stated exception: files dated before the cutover need no Summary, so old lanes do not fail', (t) => {
  assert.deepEqual(summaryViolations(t, 'x.review.md', dated(GOOD_REVIEW, 'Date', '2026-11-26T23:59:59')), []);
  assert.deepEqual(summaryViolations(t, 'x.progress.md', dated(PROGRESS, 'Started', '2026-11-08T10:00:00')), []);
  // a progress file is checked for its Summary only: nothing else about it is validated, as before
  const v = new V.Validator(tmpPath(t), null, {});
  const p = path.join(v.root, 'docs', 'specs', 'old.progress.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, dated(PROGRESS, 'Started', '2026-11-08T10:00:00') + '{{unfilled}}\n');
  v.run(p);
  assert.deepEqual(v.v, []);
});
