import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, runScript } from './helpers.js';
import { git } from './fixtures.js';
import { GOOD_RESEARCH, write } from './testdata.js';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('good research passes', (t) => {
  const repo = makeRepo(t);
  const p = write(repo, 'docs/research/payment-charge.md', GOOD_RESEARCH);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 0, r.stderr);
});

test('false citation line range fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll('[verified: src/payment.ts:3-5]', '[verified: src/payment.ts:40-42]');
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('citation-out-of-range'));
});

test('citation to missing file fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll('src/payment.ts:3-5', 'src/nope.ts:1-2');
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('citation-missing-file'));
});

test('snippet mismatch fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll('`return this.db.charge(userId)`', '`return stripe.charge(userId)`');
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('citation-snippet-mismatch'));
});

test('untagged finding fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll(
    '- F4. Therefore refunds and charges share the db dependency [inferred: from F1]',
    '- F4. Refunds go through Stripe directly',
  );
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('untagged-claim'));
});

test('hedge word fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll(
    '- F4. Therefore refunds and charges share the db dependency [inferred: from F1]',
    '- F4. Refunds probably share the db dependency [inferred: from F1]',
  );
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('hedge-word'));
});

test('unknown in findings not allowed', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll(
    '- F4. Therefore refunds and charges share the db dependency [inferred: from F1]',
    '- F4. Db.charge is transactional [unknown]',
  );
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('tag-not-allowed'));
});

test('unknown without method fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll(
    '[unknown] Resolve by: read src/db.ts and the migration for the charges table',
    '[unknown]',
  );
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('unknown-no-method'));
});

test('cmd tag without output block fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll(
    '  ```\n  $ git grep -n "charge(" src/\n  src/routes.ts:3:s.charge(\'u1\');\n  ```\n',
    '',
  );
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('cmd-without-output'));
});

test('docs tag latest version fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll('@ 2024-06-20]', '@ latest]');
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('docs-version'));
});

test('unfilled template fails', (t) => {
  const repo = makeRepo(t);
  const tmpl = fs.readFileSync(path.join(KIT, 'templates', 'research.md'), 'utf8');
  const p = write(repo, 'docs/research/x.md', tmpl);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('template-placeholder'));
});

test('missing section fails', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll('## Sources\n\n- src/payment.ts\n', '');
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const r = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('missing-section'));
});

test('citation resolved at commit', (t) => {
  // With --commit, citations resolve against that commit even if the working tree changed.
  const repo = makeRepo(t);
  const head = git(['rev-parse', 'HEAD'], repo).trim();
  fs.writeFileSync(path.join(repo, 'src', 'payment.ts'), '// gutted\n');
  const p = write(repo, 'docs/research/payment-charge.md', GOOD_RESEARCH);
  const rWt = runScript('validate_docs.js', [p, '--repo', repo]);
  assert.equal(rWt.returncode, 2); // working tree no longer has those lines
  const rC = runScript('validate_docs.js', [p, '--repo', repo, '--commit', head]);
  assert.equal(rC.returncode, 0, rC.stderr);
});

test('hook mode posttooluse returns block decision', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll('[verified: src/payment.ts:3-5]', '[verified: src/payment.ts:99-100]');
  const p = write(repo, 'docs/research/payment-charge.md', bad);
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', cwd: repo, tool_name: 'Write', tool_input: { file_path: p } });
  const r = runScript('validate_docs.js', ['--hook'], { stdin: payload });
  assert.equal(r.returncode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.ok(out.reason.includes('citation-out-of-range'));
});

test('hook mode subagentstop exits 2 on changed docs', (t) => {
  const repo = makeRepo(t);
  const bad = GOOD_RESEARCH.replaceAll('[verified: src/payment.ts:3-5]', '[verified: src/payment.ts:99-100]');
  write(repo, 'docs/research/payment-charge.md', bad); // untracked => "changed"
  const payload = JSON.stringify({ hook_event_name: 'SubagentStop', cwd: repo, agent_type: 'researcher' });
  const r = runScript('validate_docs.js', ['--hook'], { stdin: payload });
  assert.equal(r.returncode, 2);
  assert.ok(r.stderr.includes('citation-out-of-range'));
});

test('hook mode ignores non doc files', (t) => {
  const repo = makeRepo(t);
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', cwd: repo, tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src', 'x.ts') } });
  const r = runScript('validate_docs.js', ['--hook'], { stdin: payload });
  assert.ok(r.returncode === 0 && r.stdout.trim() === '');
});
