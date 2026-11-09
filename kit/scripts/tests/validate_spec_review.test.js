import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runScript } from './helpers.js';
import { GOOD_SPEC, GOOD_REVIEW, GOOD_LESSONS, write } from './testdata.js';

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

test('good spec passes', (t) => {
  const repo = makeRepo(t);
  const p = write(repo, 'docs/specs/refund-endpoint.md', GOOD_SPEC);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 0, r.stderr);
});

test('open question fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_SPEC.replaceAll('## Open questions\n\n- none', '## Open questions\n\n- Does refund need auth?');
  const p = write(repo, 'docs/specs/refund-endpoint.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('open-questions'));
});

test('inferred in files to change fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_SPEC.replaceAll(
    "- `src/routes.ts` — add the refund route after the charge call [verified: src/routes.ts:3-3] `s.charge('u1')`",
    '- `src/routes.ts` — add the refund route [inferred: from A1]',
  );
  const p = write(repo, 'docs/specs/refund-endpoint.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('tag-not-allowed'));
});

test('done criteria without test fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_SPEC.replaceAll('| `src/__tests__/refund.test.ts::returns 200` |', '| works |');
  const p = write(repo, 'docs/specs/refund-endpoint.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('done-criteria-no-test'));
});

test('artifact done criteria allowed', (t) => {
  const repo = makeRepo(t);
  const ok = GOOD_SPEC.replaceAll(
    '| `src/__tests__/refund.test.ts::returns 200` |',
    '| artifact: docs/design/refund-flow.png, checklist: DESIGN.md#reviewer-checklist |',
  );
  const p = write(repo, 'docs/specs/refund-endpoint.md', ok);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 0, r.stderr);
});

test('risk flag required when touching payments', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_SPEC.replaceAll('- Risk: high-risk', '- Risk: low');
  const p = write(repo, 'docs/specs/refund-endpoint.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('risk-flag'));
});

test('approved status requires approval line', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_SPEC.replaceAll('- Status: draft', '- Status: approved');
  let p = write(repo, 'docs/specs/refund-endpoint.md', bad);
  let r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('approval-line'));
  const good = bad.replaceAll('Approved by: — on — at —', 'Approved by: Jonathan Robles on 2026-11-08 at abc1234');
  p = write(repo, 'docs/specs/refund-endpoint.md', good);
  r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 0, r.stderr);
});

test('unanswered architecture checklist fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_SPEC.replaceAll('- [x] Routes depend on services', '- [ ] Routes depend on services');
  const p = write(repo, 'docs/specs/refund-endpoint.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('checklist-unanswered'));
});

test('empty allow list fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_SPEC.replaceAll(
    "- `src/routes.ts` — add the refund route after the charge call [verified: src/routes.ts:3-3] `s.charge('u1')`\n",
    '',
  );
  const p = write(repo, 'docs/specs/refund-endpoint.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('empty-allow-list'));
});

// ---------------------------------------------------------------------------
// Review reports
// ---------------------------------------------------------------------------

test('good review passes', (t) => {
  const repo = makeRepo(t);
  const p = write(repo, 'docs/specs/refund-endpoint.review.md', GOOD_REVIEW);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 0, r.stderr);
});

test('pass without evidence fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_REVIEW.replaceAll('| PASS | depcruise: 0 violations |', '| PASS | ok |');
  const p = write(repo, 'docs/specs/refund-endpoint.review.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('checklist-no-evidence'));
});

test('fail row needs fail list entry and verdict', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_REVIEW.replaceAll('| R4 | Changed files in allow-list | PASS |', '| R4 | Changed files in allow-list | FAIL |');
  let p = write(repo, 'docs/specs/refund-endpoint.review.md', bad);
  let r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('fail-not-listed') && r.stderr.includes('verdict-mismatch'));
  const fixed = bad
    .replaceAll(
      '## Fail list\n\n- none',
      '## Fail list\n\n- R4 `src/orders/refund.ts:1` — rule: file not in spec allow-list — passing looks like: remove the file or amend the spec and re-approve',
    )
    .replaceAll('## Verdict\n\nPASS', '## Verdict\n\nFAIL');
  p = write(repo, 'docs/specs/refund-endpoint.review.md', fixed);
  r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 0, r.stderr);
});

test('fail entry missing fields fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_REVIEW
    .replaceAll('| R4 | Changed files in allow-list | PASS |', '| R4 | Changed files in allow-list | FAIL |')
    .replaceAll('## Fail list\n\n- none', '## Fail list\n\n- R4 scope creep, remove it')
    .replaceAll('## Verdict\n\nPASS', '## Verdict\n\nFAIL');
  const p = write(repo, 'docs/specs/refund-endpoint.review.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('fail-entry'));
});

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

test('good lessons pass', (t) => {
  const repo = makeRepo(t);
  const p = write(repo, 'LESSONS.md', GOOD_LESSONS);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 0, r.stderr);
});

test('enforced lesson without change fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_LESSONS.replaceAll(
    '- Proposed change: kit/templates/tests/webhook-idempotency.test.ts added to spec template for any handler under src/webhooks',
    '- Proposed change: none',
  );
  const p = write(repo, 'LESSONS.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('lesson-no-change'));
});

test('text only lesson needs reason', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_LESSONS
    .replaceAll('- Enforced by: test', '- Enforced by: text-only')
    .replaceAll(
      '- Proposed change: kit/templates/tests/webhook-idempotency.test.ts added to spec template for any handler under src/webhooks',
      '- Proposed change: none',
    );
  const p = write(repo, 'LESSONS.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.ok(r.returncode === 2 && r.stderr.includes('lesson-debt-reason'));
});
