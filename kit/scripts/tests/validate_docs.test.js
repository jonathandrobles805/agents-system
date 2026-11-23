import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, runScript } from './helpers.js';
import { git } from './fixtures.js';
import * as V from '../validate_docs.js';
import { GOOD_RESEARCH, GOOD_SPEC, GOOD_REVIEW, GOOD_LESSONS, write } from './testdata.js';

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

// ---------------------------------------------------------------------------- template placeholders, per document type
// KIT-SPEC 5.2 rules 12 and 13. Evidence: the first real-agent eval run on 516ffdd failed a retro lesson that quoted
// progress.md's `{{n}}` in backticks, and two lessons enforced by "hook and ci".

const GOOD_GOAL = '# Goal: truncate text\n\n- Slug: truncate-text\n- Date: 2026-11-22\n- Work type: feature\n- Risk: normal\n- Size: S\n\n## What we want\n\nLong titles are cut to fit.\n';

/** The rules each type's validator reports for `text`, run in process with citations left unresolved. */
function rules(kind, text) {
  const v = new V.Validator(path.sep, null, {});
  v.resolveCitations = () => {};
  v.resolveBareCitations = () => {};
  v[kind](`${kind}.md`, text.split('\n'));
  return v.v.filter((x) => x.rule === 'template-placeholder').map((x) => x.message);
}

// Each type: its good document, where a free-text line can be added, a placeholder its template writes in prose, and
// one its template writes in code (null when the template has none in code).
const TYPES = [
  ['research', GOOD_RESEARCH, '## Recommendation\n', '{{claim}}', '{{snippet}}'],
  ['spec', GOOD_SPEC, '## Approach\n', '{{why}}', '{{path}}'],
  ['review', GOOD_REVIEW, '## Verdict\n', '{{n}}', '{{file}}'],
  ['lesson', GOOD_LESSONS, '- Status: approved\n', '{{short title}}', null],
  ['goal', GOOD_GOAL, '## What we want\n', '{{human name}}', null],
];
const msg = (tok) => [`unfilled template placeholder: ${tok}`];

for (const [kind, good, at, prose, code] of TYPES) {
  const add = (line) => {
    assert.ok(good.includes(at), `${kind}: anchor ${at}`);
    return good.replace(at, `${at}\n${line}\n`);
  };
  test(`${kind}: a placeholder quoted in code is unfilled only when the template itself writes it in code`, () => {
    assert.deepEqual(rules(kind, good), []);
    assert.deepEqual(rules(kind, add('progress.md still had `{{what fails}}` and ``{{tried}}`` in it.')), [], "another file's");
    assert.deepEqual(rules(kind, add('```\nAttempts: {{what fails}}\n```')), [], 'in a fenced block');
    assert.deepEqual(rules(kind, add('~~~~\n{{what fails}}\n~~~~')), [], 'in a tilde fence');
    assert.deepEqual(rules(kind, add(`progress.md still had \`${prose}\` in it.`)), [], 'one its template writes in prose, quoted');
  });
  test(`${kind}: a placeholder left unfilled is caught`, () => {
    assert.deepEqual(rules(kind, add('progress.md still had {{what fails}} in it.')), msg('{{what fails}}'), 'a stray one in prose');
    assert.deepEqual(rules(kind, add(`the value is ${prose} here`)), msg(prose), 'its own, in prose');
    const upper = prose.replace(/\{\{(.)/, (_, c) => `{{ ${c.toUpperCase()}`);
    assert.deepEqual(rules(kind, add(`the value is ${upper} here`)), msg(upper), 'its own, cased and spaced differently');
    assert.deepEqual(rules(kind, add(`the value is {${prose}} here`)), msg(`{${prose}}`), 'its own, in three braces');
    assert.deepEqual(rules(kind, add('an `unclosed {{x}} backtick')), msg('{{x}}'), 'an unclosed backtick is no code span');
    assert.deepEqual(rules(kind, add('```\n{{x}}')).length, 0, 'an unclosed fence runs to the end, as Markdown reads it');
    if (code) {
      assert.deepEqual(rules(kind, add(`the value is \`${code}\` here`)), msg(code), 'its own code placeholder, in backticks');
      assert.deepEqual(rules(kind, add(`\`\`\`\n${code}\n\`\`\``)), msg(code), 'its own code placeholder, in a fenced block');
      const odd = `{{{ ${code.slice(2, -2).toUpperCase()} }}}`;
      assert.deepEqual(rules(kind, add(`the value is \`${odd}\` here`)), msg(odd), 'its own code placeholder, cased, spaced and in three braces');
    }
  });
  test(`${kind}: the kit's own template, untouched, fails on every line that holds a placeholder`, () => {
    const tmpl = fs.readFileSync(path.join(KIT, 'templates', `${V.TEMPLATE_OF[kind]}.md`), 'utf8').split('\n');
    const want = tmpl.map((t, i) => (/\{\{[^}]*\}\}/.test(t) ? i + 1 : 0)).filter(Boolean);
    assert.ok(want.length > 0);
    assert.deepEqual(V.unfilledPlaceholders(kind, tmpl).map((x) => x.line), want);
  });
}

test('the research template\'s own "`{{snippet}}`" is caught inside its backticks, in any case', () => {
  assert.deepEqual(V.unfilledPlaceholders('research', ['- F1. claim [verified: a.ts:1-2] `{{snippet}}`']), [{ line: 1, token: '{{snippet}}' }]);
  assert.deepEqual(V.unfilledPlaceholders('research', ['- F1. claim `{{Snippet}}`']), [{ line: 1, token: '{{Snippet}}' }]);
});

// The reviewer's first write of its report in the 516ffdd eval run, row R10, verbatim: it quotes progress.md's `{{n}}`
// (a token review.md writes in prose) and `{{what fails}}` in backticks. Both are quotes, not unfilled placeholders.
const REVIEW_R10_516 = "| R10 | progress.md complete and consistent with log | FAIL | docs/specs/truncate-text.progress.md:17 says Current step `reading the spec's files`, but the log shows D1 already green (truncate-text.log#21) and the work committed (caac6fa). progress.md:7 `Last update: 2026-11-23T18:16:52` is the same as Started (line 6) and earlier than the red run at log#1 (18:17:02). progress.md:25-28 still has template placeholders (`{{n}}`, `{{what fails}}`). The Red/Green refs on line 13 (log#1, log#21) do match the log. The committed copy of the lane log, `docs/specs/truncate-text.checks.txt`, is missing from the diff, so those refs point only to the gitignored `.claude/session/truncate-text.log`. [verified: docs/specs/truncate-text.progress.md:6-28] |";

test('the 516ffdd reviewer row quoting progress.md placeholders is no unfilled placeholder', () => {
  assert.deepEqual(V.unfilledPlaceholders('review', [REVIEW_R10_516]), []);
  assert.deepEqual(rules('review', GOOD_REVIEW.replace(/^\| R10 \|.*$/m, REVIEW_R10_516)), []);
  assert.deepEqual(rules('review', GOOD_REVIEW.replace(/^\| R10 \|.*$/m, REVIEW_R10_516.replace('`{{n}}`', '{{n}}'))), msg('{{n}}'), 'unquoted, it is caught');
});

test('a type with no template counts every {{…}} as unfilled, code or not (fails closed)', () => {
  assert.equal(V.templatePlaceholders('nonsense'), null);
  assert.deepEqual(V.unfilledPlaceholders('nonsense', ['`{{a}}`', '```', '{{b}}', '```']).map((x) => x.token), ['{{a}}', '{{b}}']);
});

test('codeRanges: inline spans by matching backtick runs, fences by character and length', () => {
  assert.deepEqual(V.codeRanges(['a `b` c ``d`e`` f']), [[[2, 5], [8, 15]]]);
  assert.deepEqual(V.codeRanges(['````', '```', 'x', '````', 'y']).map((r) => r.length), [1, 1, 1, 1, 0], 'a shorter fence does not close a longer one');
  assert.deepEqual(V.codeRanges(['```a` b', 'c']).map((r) => r.length), [0, 0], 'a backtick after the opening run makes it no fence');
});

test('the validator CLI on a lesson quoting placeholders and naming two enforcers', (t) => {
  const repo = makeRepo(t);
  const text = GOOD_LESSONS
    .replace('- What went wrong: the first implementation', '- What went wrong: `progress.md` kept `{{n}}`/`{{what fails}}`; the first implementation')
    .replace('- Enforced by: test', '- Enforced by: hook (stop/post-edit runner) and ci');
  const r = runScript('validate_docs.js', [write(repo, 'LESSONS.md', text), '--repo', repo]);
  assert.equal(r.returncode, 0, r.stderr);
  const bad = runScript('validate_docs.js', [write(repo, 'LESSONS.md', text.replace('`{{n}}`', '{{n}}')), '--repo', repo]);
  assert.equal(bad.returncode, 2);
  assert.match(bad.stderr, /template-placeholder: unfilled template placeholder: \{\{n\}\}/);
});

// ---------------------------------------------------------------------------- Enforced by

test('Enforced by: one or more of ci, hook, lint, test, each with an optional short note', () => {
  const ok = {
    hook: ['hook'], 'Test': ['test'], 'hook and ci': ['hook', 'ci'], 'hook (stop/post-edit runner) and ci': ['hook', 'ci'],
    'hook, lint and ci': ['hook', 'lint', 'ci'], 'hook, lint, and ci': ['hook', 'lint', 'ci'], 'lint + test': ['lint', 'test'],
    'hook/ci': ['hook', 'ci'], 'lint (eslint rule) / ci (kit.yml)': ['lint', 'ci'], 'text-only': ['text-only'],
    'text-only (needs a model to judge)': ['text-only'],
  };
  for (const [v, names] of Object.entries(ok)) assert.deepEqual(V.parseEnforcedBy(v), { names, error: null }, v);
});

test('Enforced by: text-only stands alone; unknown, repeated, dangling or bare-space values fail', () => {
  for (const v of ['text-only and ci', 'ci + text-only', 'hook/text-only']) assert.match(V.parseEnforcedBy(v).error, /'text-only' stands alone/, v);
  for (const v of ['a reminder', '', 'hook ci', 'hook and', 'ci/cd', 'test-only', 'hook or ci', 'and hook', '`hook`']) assert.match(V.parseEnforcedBy(v).error, /must be one or more of/, v);
  assert.match(V.parseEnforcedBy('hook and Hook').error, /'hook' is named twice/);
  assert.match(V.parseEnforcedBy('hook ()').error, /note after 'hook' is empty/);
  assert.match(V.parseEnforcedBy(`hook (${'x'.repeat(V.ENFORCER_NOTE_MAX + 1)})`).error, /longer than 80/);
  assert.equal(V.parseEnforcedBy(`hook (${'x'.repeat(V.ENFORCER_NOTE_MAX)})`).error, null);
});

test('a lesson: several enforcers need a named change; text-only combined is refused and still needs its reason', () => {
  const lesson = (eb, pc) => GOOD_LESSONS.replace('- Enforced by: test', `- Enforced by: ${eb}`)
    .replace(/- Proposed change: .*/, `- Proposed change: ${pc}`);
  const all = (text) => { const v = new V.Validator(path.sep, null, {}); v.lesson('LESSONS.md', text.split('\n')); return v.v.map((x) => x.rule); };
  assert.deepEqual(all(lesson('hook and ci', 'kit/scripts/hook_x.js blocks it')), []);
  assert.deepEqual(all(lesson('hook and ci', 'none')), ['lesson-no-change']);
  assert.deepEqual(all(lesson('text-only', 'none (text-only, reason: needs judgement)')), []);
  assert.deepEqual(all(lesson('text-only and ci', 'none')), ['lesson-enforced-by', 'lesson-debt-reason']);
  assert.deepEqual(all(lesson('a reminder', 'kit/x.js')), ['lesson-enforced-by']);
});
