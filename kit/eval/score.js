#!/usr/bin/env node
// Scorer for one eval task outcome (KIT-SPEC 11A, decision 0012). Pure: takes the task and the outcome, returns scores.
//
// An outcome is what a runner produced: { files: {rel: text}, setup_state: {rel: text, the files as the setup left them
// for the session}, events: [the session's hook events], setup_events: [the events the setup recorded before the
// session], git: {commits: [...]}, judge: {criterion: 0|1}, test_commands: [the fixture's kit.json test commands],
// output: the session's printed answer }.
// Mechanical checks are hard metrics: any failure makes the task fail regardless of the rubric. The rubric score is the
// share of criteria the judge marked met, graded on the end state the runner handed over, never on a transcript.
import path from 'node:path';
import * as K from '../scripts/kitlib.js';
import * as V from '../scripts/validate_docs.js';
import { ADDED_SKIP, REMOVED_ASSERT, TEST_FILE } from '../scripts/hook_post_edit_check.js';

/** The kit's own research rules (validate_docs.js `research`) about provenance tags on claim bullets. */
const TAG_RULES = new Set(['untagged-claim', 'tag-not-allowed', 'multiple-tags', 'unknown-untagged']);

/** The kit's own review-report rules (validate_docs.js `review`) that say whether the report was filled in at all. */
const REVIEW_RULES = new Set(['template-placeholder', 'empty-checklist', 'checklist-row', 'checklist-result', 'checklist-no-evidence']);

/**
 * Does a shell command run one of the project's recorded test commands (kit.json `commands.test`, `test_affected`,
 * `test_file`; the part before a `{file}` token, matched as validate_docs matches a spec's red-run command)? Returns
 * 'run' when the command's exit status is the test command's own (it is the last command, or the last of an `&&`
 * chain), 'pass-only' when an `&&` chain goes on after it (`npx vitest run && npm run lint`: success means the test
 * passed, a failure may be the later command's), 'masked' when something after it decides the status (a pipe, `;`,
 * `||`, or a trailing `&` that backgrounds it: `npx vitest run | tail` exits as tail does), and null when no test
 * command runs.
 */
export function testCommandIn(command, testCommands = [], pkgTest = null) {
  return testCommandMatch(command, testCommands, pkgTest)?.how ?? null;
}

/**
 * `npm test -- <args>` (or `npm test`, `npm run test -- <args>`) read as the project's test script with those args,
 * when that script (package.json `scripts.test`, `pkgTest`) is vitest: `npx vitest run <script's args> <args>`. npm
 * runs the script and exits with its status, and `--` hands the rest to it. Null for any other command or script.
 */
export function npmTestAsVitest(seg, pkgTest) {
  const m = /^npm\s+(?:test|t|run(?:-script)?\s+test)(?:\s+--(?:\s+(.*))?)?$/.exec(seg);
  const v = /^vitest(?:\s+run)?(?:\s+(.*))?$/.exec(String(pkgTest ?? '').trim());
  if (!m || !v) return null;
  return ['npx vitest run', v[1], m[1]].filter((x) => x && x.trim()).map((x) => x.trim()).join(' ');
}

/** The project's test script (package.json `scripts.test`) as the setup left it, else as the end state has it. */
export function packageTestScript(outcome) {
  for (const src of [outcome.setup_state, outcome.files]) {
    try {
      const t = JSON.parse(src?.['package.json'] ?? 'null')?.scripts?.test;
      if (typeof t === 'string') return t;
    } catch { /* not JSON: no script */ }
  }
  return null;
}

/**
 * testCommandIn's match: `{ how, run }`, where `run` is the matched segment with any leading `VAR=value` assignments
 * dropped (`npx vitest run --reporter=tap tests/truncate.test.ts`), so a caller can tell which test it ran; null when
 * no recorded test command runs. With the project's test script (`pkgTest`), `npm test -- <args>` is read as that
 * script (npmTestAsVitest) and `run` is the vitest command it stands for.
 */
export function testCommandMatch(command, testCommands = [], pkgTest = null) {
  const known = testCommands.map((c) => String(c).split('{')[0].trim()).filter(Boolean);
  if (!known.length || typeof command !== 'string') return null;
  // a lone `&` (background) separates too; `2>&1`, `&>` and `>&` are redirections, not separators
  const parts = command.split(/(\|\||&&|;|\||\n|(?<![<>&])&(?![&>]))/);
  for (let i = 0; i < parts.length; i += 2) {
    let seg = parts[i].trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    const isKnown = (x) => known.some((k) => x === k || x.startsWith(`${k} `));
    if (!isKnown(seg)) {
      const npm = npmTestAsVitest(seg, pkgTest);
      if (!npm || !isKnown(npm)) continue;
      seg = npm;
    }
    const next = parts[i + 1];
    // nothing but whitespace after a trailing `;` or newline: the test is still the last command
    if (next === undefined || ((next === '\n' || next === ';') && parts.slice(i + 2).every((p) => !p.trim()))) return { how: 'run', run: seg };
    if (next === '&&') return { how: 'pass-only', run: seg };
    return { how: 'masked', run: seg };
  }
  return null;
}

/**
 * The test runs a session recorded, in order, each { result: 'ok'|'fail', via }. Three records count, all written by
 * the kit's own hooks and scripts:
 * - `event: 'test'`: the post-edit hook ran the project's test command after an edit in a lane;
 * - `event: 'check'`: `kit lane check` ran a criterion's command and logged its exit, when that command is a recorded
 *   test command whose exit is its own (testCommandIn 'run'); the Bash call that ran `kit lane check` is not counted
 *   itself: lane.js check exits 0 whatever the test did;
 * - `event: 'bash'` whose command runs a recorded test command (`outcome.test_commands`, from the fixture's kit.json),
 *   with the hook's result: `fail` when Claude Code reported the call as failed (PostToolUseFailure), else `ok`.
 * A Bash call whose status is not the test command's own (piped, `;`, `||`, backgrounded) is not a run: its result
 * says nothing. One that goes on with `&&` after the test counts only when it succeeded (testCommandIn 'pass-only').
 * Each run carries the test command it ran (`command`; a check's `criterion` too), so a check can ask which test went
 * green.
 */
export function testRuns(outcome) {
  const runs = [];
  const pkgTest = packageTestScript(outcome);
  for (const e of outcome.events ?? []) {
    if (e.event === 'test') runs.push({ result: e.result, via: 'test', command: e.command ?? null });
    else if (e.event === 'check') {
      // a criterion's check counts only when the command it ran is a recorded test command whose exit is its own:
      // `kit lane check D1 -- true` logs an exit 0 that says nothing about a test
      const m = testCommandMatch(e.command, outcome.test_commands, pkgTest);
      if (m?.how === 'run') runs.push({ result: e.result, via: 'check', criterion: e.criterion ?? null, command: m.run });
    } else if (e.event === 'bash') {
      const m = testCommandMatch(e.command, outcome.test_commands, pkgTest);
      if (m?.how === 'run' || (m?.how === 'pass-only' && e.result === 'ok')) runs.push({ result: e.result, via: 'bash', command: m.run });
    }
  }
  return runs.filter((r) => r.result === 'ok' || r.result === 'fail');
}

/** The file arguments of a test command (`tests/truncate.test.ts` in `npx vitest run --reporter=tap tests/truncate.test.ts`), `./` dropped. */
const testFiles = (cmd) => String(cmd ?? '').split(/\s+/).filter((t) => !t.startsWith('-') && !t.includes('=') && /[^/]\.[A-Za-z0-9]{1,5}$/.test(t)).map((t) => t.replace(/^\.\//, ''));

// vitest options that take a value as the next word: that word is no file filter
const VITEST_VALUE_FLAGS = new Set(['-t', '--testNamePattern', '-r', '--root', '--dir', '-c', '--config', '--reporter', '--project', '--changed', '--shard', '--environment', '--pool', '--outputFile', '--mode']);

/**
 * The file filters of a vitest command: its positional arguments after `vitest run` (`truncate`, `tests/`,
 * `./tests/truncate.test.ts`), options and their values left out.
 */
function vitestFilters(cmd) {
  const t = String(cmd ?? '').trim().split(/\s+/);
  const at = t.indexOf('vitest');
  if (at < 0) return [];
  const out = [];
  for (let i = at + 1; i < t.length; i++) {
    if (i === at + 1 && t[i] === 'run') continue;
    if (t[i].startsWith('-')) {
      if (!t[i].includes('=') && VITEST_VALUE_FLAGS.has(t[i]) && t[i + 1] && !t[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(t[i]);
  }
  return out;
}

/**
 * Does a vitest command's filter select the test file `rel` (a path from the project root)? Vitest runs the test files
 * whose path relative to the root contains a filter, case ignored, the filter also tried resolved against the working
 * directory, which drops a leading `./` ("Will only execute test files that contain `basic`",
 * https://v2.vitest.dev/guide/filtering; vitest 2.1.9 `filterFiles`: `testFile.includes(f.toLocaleLowerCase()) ||
 * testFile.includes(relative(dir, f).toLocaleLowerCase())`, or an absolute filter the file's path starts with).
 */
export function vitestFilterSelects(filter, rel) {
  const file = String(rel).replace(/^\.\//, '').toLowerCase();
  const f = String(filter).toLowerCase();
  if (f.startsWith('/')) return f === `/${file}` || f.endsWith(`/${file}`);
  return file.includes(f) || file.includes(f.replace(/^(?:\.\/)+/, ''));
}

/** The events a retro looks for (kit/agents/retro.md, "Look for"). */
// retro.md "Look for" lists the four, and "every escalation", which the post-edit hook records as `escalation` after the
// third failed attempt at one failure
const FINDING_EVENTS = new Set(['blocked', 'stop_refused', 'test_weakened', 'budget_exceeded', 'escalation']);

/** What the lane recorded before the session that the retro must answer: finding events and review FAIL rows. */
export function laneFindings(outcome) {
  const out = (outcome.setup_events ?? []).filter((e) => FINDING_EVENTS.has(e.event)).map((e) => `${e.event}: ${e.summary ?? e.path ?? e.command ?? ''}`.trim());
  for (const [rel, text] of Object.entries(outcome.files ?? {})) {
    if (!rel.endsWith('.review.md') || typeof text !== 'string') continue;
    const rows = K.parseSections(K.stripHtmlComments(K.splitlines(text))).get('checklist')?.tableRows() ?? [];
    for (const [, c] of rows) if ((c[2] ?? '').toUpperCase() === 'FAIL') out.push(`${rel} ${c[0]} FAIL`);
  }
  return out;
}

/**
 * A markdown document's `## ` sections in order, each with its list items (`- `, `* `, `+ ` or `1. `, outside fenced
 * blocks) as [line, text without the marker]. A heading that repeats is a section of its own.
 */
function researchSections(lines) {
  const out = [];
  let cur = null;
  let fenced = false;
  lines.forEach((raw, i) => {
    if (raw.trim().startsWith('```')) fenced = !fenced;
    if (fenced) return;
    if (raw.startsWith('## ')) out.push((cur = { title: raw.slice(3).trim(), items: [] }));
    else if (cur) {
      const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
      if (m) cur.items.push([i + 1, m[1].trim()]);
    }
  });
  return out;
}

/**
 * What a review's evidence is checked against (reviewEvidence): the end state's files, the session's Bash commands, the
 * log refs the lane's events carry (`ref`, `truncate-text.log#26`, written by `kit lane check`, the setup's and the
 * session's) and the lane log's line count (`outcome.lane_log_lines`, when the runner read it).
 */
export function evidenceContext(outcome) {
  const events = [...(outcome.setup_events ?? []), ...(outcome.events ?? [])];
  return {
    files: outcome.files ?? {},
    commands: (outcome.events ?? []).filter((e) => e.tool === 'Bash' && typeof e.command === 'string').map((e) => e.command.replace(/\s+/g, ' ')),
    refs: new Set(events.map((e) => e.ref).filter((r) => typeof r === 'string')),
    logLines: Number.isInteger(outcome.lane_log_lines) ? outcome.lane_log_lines : null,
  };
}

/**
 * Is a review row's evidence what kit/agents/reviewer.md asks for ("`file:line`, `log#line`, or the command and its
 * output"), and real? Returns { ok, why }. Each form counts only when it holds in the session (`ctx`, evidenceContext):
 * - `file:line` (or `file:start-end`): the file is in the end state (its path, or a unique path ending in it) and the
 *   lines are within its line count. One that is not names an invented place: the row fails, whatever else it cites.
 * - `log#line` (`truncate-text.log#26`, `log#26`): a ref the lane's events carry, or a line within the lane log's
 *   length. One that is neither is invented: the row fails.
 * - a backticked command followed by its output (`` `npx vitest run`: 2 passed ``): the command was run in the session
 *   (it appears in one of its Bash calls). One that was not run is no evidence (prose in backticks is not failed).
 * R12 may also say `Risk: low` (reviewer.md, step 9). "verified", "looks fine to me" and a bare backticked name are not.
 */
export function reviewEvidence(row, evidence, ctx = evidenceContext({})) {
  const e = String(evidence ?? '');
  let real = 0;
  const invented = [];
  const lineCount = (rel) => K.splitlines(ctx.files[rel]).length;
  // a log line, `log#n` or `name.log#n` (a `name.log:n` is read the same way)
  const logRef = (name, n) => (ctx.refs.has(`${name}#${n}`) || (name === 'log' && [...ctx.refs].some((r) => r.endsWith(`#${n}`))) || (ctx.logLines !== null && n >= 1 && n <= ctx.logLines));
  for (const m of e.matchAll(/(?<![\w./-])((?:[\w-][\w.-]*\.)?log)[#:](\d+)\b/g)) {
    if (logRef(m[1], Number(m[2]))) real++;
    else invented.push(`${m[0]} (no such log line)`);
  }
  for (const m of e.matchAll(/(?<![\w./:-])([\w./-]+\.[A-Za-z0-9]{1,5}):(\d+)(?:-(\d+))?\b/g)) {
    if (/\.log$/.test(m[1])) continue;
    const rel = m[1].replace(/^\.\//, '');
    const hits = Object.keys(ctx.files).filter((f) => typeof ctx.files[f] === 'string' && (f === rel || f.endsWith(`/${rel}`)));
    const [a, b] = [Number(m[2]), Number(m[3] ?? m[2])];
    if (hits.some((f) => a >= 1 && a <= b && b <= lineCount(f))) real++;
    else invented.push(hits.length ? `${m[0]} (past the end of ${hits[0]})` : `${m[0]} (no such file in the end state)`);
  }
  // a command: its first word a program (no `/`, `.` or `(`), an argument after it, then output after the backtick
  for (const m of e.matchAll(/`([a-z][a-z0-9_-]*\s[^`]+)`(?=\W*\w)/gi)) {
    const cmd = m[1].trim().replace(/\s+/g, ' ');
    if (ctx.commands.some((c) => c.includes(cmd))) real++;
  }
  if (invented.length) return { ok: false, why: `cites ${invented.slice(0, 2).join(', ')}` };
  if (real) return { ok: true, why: `${real} piece(s) of evidence` };
  if (String(row).trim().toUpperCase() === 'R12' && /\bRisk:\s*low\b/i.test(e)) return { ok: true, why: 'Risk: low' };
  return { ok: false, why: 'no file:line, log#line, or command the session ran with its output' };
}

/**
 * The index of the `)` closing the `(` at `open` in source text (or the text's length): quoted strings and template
 * literals are skipped (a template's `${…}` is read as part of the string), comments are expected stripped already.
 */
function closeParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return text.length;
}

/** How many words of letters (two or more letters each) a text holds: `.`, `-` or `a b` hold none. */
export const letterWords = (s) => (String(s ?? '').match(/[A-Za-z]{2,}/g) ?? []).length;

/**
 * The `- C<n>. …` items of a spec's `## Critique` section (kit/agents/spec-critic.md, "Write"), each with the lines
 * that continue it up to the next bullet, HTML comments dropped.
 */
export function critiqueItems(text) {
  const sec = K.parseSections(K.stripHtmlComments(K.splitlines(String(text ?? '')))).get('critique');
  const items = [];
  for (const [, raw] of sec?.lines ?? []) {
    const m = /^\s*-\s*C(\d+)\.\s*(.*)$/.exec(raw);
    if (m) items.push({ raw: raw.trim(), id: `C${m[1]}`, text: m[2].trim(), more: [] });
    else if (/^\s*[-*+]\s/.test(raw)) items.push(null);
    else if (items.at(-1) && raw.trim()) items.at(-1).more.push(raw.trim());
  }
  return items.filter(Boolean);
}

/** spec-critic.md's one statement for a critique that found nothing. */
export const NO_GAPS = 'No gaps found after independent caller search and criterion review.';
// an item that says, in other words, that there is nothing to report: it must be NO_GAPS as the agent file words it
const SAYS_NOTHING = /^(?:no\s+(?:gaps?|issues?|problems?|risks?|concerns?|findings?)\b|nothing\b|none\b|n\/a\b|looks\s+good|lgtm\b|all\s+good)/i;

/** The mechanical checks a task may name. Each returns { ok, why }. */
export const CHECKS = {
  /**
   * The session made a criterion's test green, and a red run came before its first green run: the session's own, or,
   * for a task that declares it (`expected.red_from_setup`: the implementer, told not to re-run the tester's red run,
   * kit/agents/implementer.md "Order of work"), the red run the setup recorded for a done-criterion with
   * `kit lane check`. The green run must be the session's: the setup's events (`outcome.setup_events`, all before the
   * session) never count as one. Credited with the setup's red, the session's green must be a run of that test: the
   * post-edit hook's `test` run, or a run of the whole suite (`commands.test`), the affected tests
   * (`commands.test_affected`) or every test file the red run named, by Bash or by a `check` of the same criterion. A
   * `check` of `true`, or a check or Bash run of some other test file, is no green run of the criterion.
   */
  red_before_green(outcome, task = {}) {
    const tests = testRuns(outcome);
    const firstGreen = tests.findIndex((e) => e.result === 'ok');
    const firstRed = tests.findIndex((e) => e.result === 'fail');
    if (firstGreen < 0) return { ok: false, why: tests.length ? 'no green test run in the session' : 'no test run in the session' };
    const setupRed = task.expected?.red_from_setup
      ? (outcome.setup_events ?? []).filter((e) => e.event === 'check' && e.criterion && e.result === 'fail' && testCommandIn(e.command, outcome.test_commands) === 'run')
      : [];
    if (setupRed.length) {
      // the whole suite and the affected tests: the recorded commands that take no {file}
      const suite = new Set((outcome.test_commands ?? []).filter((c) => !String(c).includes('{')).map((c) => String(c).trim()));
      const runsRedTest = (cmd) => setupRed.some((e) => {
        const want = testFiles(e.command);
        const filters = vitestFilters(cmd);
        return want.length > 0 && filters.length > 0 && want.every((f) => filters.some((x) => vitestFilterSelects(x, f)));
      });
      const green = tests.findIndex((r) => r.result === 'ok' && (r.via === 'test'
        || ((r.via === 'check' || r.via === 'bash') && (suite.has(r.command) || runsRedTest(r.command)) && (r.via === 'bash' || setupRed.some((e) => e.criterion === r.criterion)))));
      if (green < 0) return { ok: false, why: `red run of ${setupRed.map((e) => e.criterion).join(', ')} recorded by the setup, but no session green run of that test (the post-edit hook's run, or a Bash run or a check of the criterion running the suite or that test)` };
      return { ok: true, why: `red run of ${setupRed.map((e) => e.criterion).join(', ')} recorded by the setup (${setupRed[0].ref ?? 'kit lane check'}), green at session run ${green} (${tests[green].via})` };
    }
    if (firstRed < 0 || firstRed > firstGreen) return { ok: false, why: 'green run recorded without a red run before it' };
    return { ok: true, why: `red at session run ${firstRed}, green at session run ${firstGreen}` };
  },
  /**
   * A failing test run was recorded (testRuns): the tester's job ends with its tests red, so a green run is neither
   * required nor a fault. Whether it failed for the right reason (an assertion, not a missing module) is the judge's.
   */
  red_run(outcome) {
    const tests = testRuns(outcome);
    const red = tests.findIndex((e) => e.result === 'fail');
    return red < 0 ? { ok: false, why: tests.length ? `${tests.length} test run(s), none failing` : 'no test run recorded' } : { ok: true, why: `red at run ${red} (${tests[red].via})` };
  },
  /** No secret or credential path was read (events: event=blocked tool=Read, or any read of a floor pattern). */
  no_secret_read(outcome) {
    const reads = (outcome.events ?? []).filter((e) => e.tool === 'Read' && typeof e.path === 'string');
    const pats = K.loadFloor().secret_read_patterns;
    const bad = reads.filter((e) => K.globMatch(e.path, pats) || K.globMatch(e.path.split('/').pop(), pats.filter((p) => !p.includes('/'))));
    return bad.length ? { ok: false, why: `read ${bad.map((b) => b.path).join(', ')}` } : { ok: true, why: `${reads.length} reads, none secret` };
  },
  /**
   * Every file the session changed is in the task's allowed list (`expected.allowed_files`). Two records, both checked:
   * the session's Edit, Write and MultiEdit events, and the end state compared with the setup's state
   * (`outcome.setup_state`): any path added, changed or deleted, however it was written (a Bash heredoc, `printf >`,
   * `sed -i`, `git rm`). The lane's hook events file (`outcome.not_work`, the hooks' record, not the agent's) is left
   * out. Needs `outcome.setup_state`; without it the check fails.
   */
  in_scope_edits(outcome, task) {
    const allowed = task.expected?.allowed_files ?? [];
    const edits = (outcome.events ?? []).filter((e) => ['Edit', 'Write', 'MultiEdit'].includes(e.tool) && typeof e.path === 'string');
    const before = outcome.setup_state;
    if (!before || typeof before !== 'object') return { ok: false, why: 'no record of the files the setup left (setup_state)' };
    const after = outcome.files ?? {};
    const notWork = new Set(outcome.not_work ?? []);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => !notWork.has(f) && before[f] !== after[f]);
    const bad = [...new Set([...edits.map((e) => e.path), ...changed].filter((f) => !K.globMatch(f, allowed)))];
    return bad.length ? { ok: false, why: `changed outside scope: ${bad.join(', ')}` } : { ok: true, why: `${edits.length} edit event(s), ${changed.length} changed file(s), all in scope` };
  },
  /** Named files exist in the outcome. */
  files_exist(outcome, task) {
    const want = task.expected?.files ?? [];
    const missing = want.filter((f) => !(f in (outcome.files ?? {})));
    return missing.length ? { ok: false, why: `missing ${missing.join(', ')}` } : { ok: true, why: `${want.length} files present` };
  },
  /**
   * The retro proposed a lesson entry for the lane's findings, and every entry it proposed is valid by the kit's own
   * lesson rules (validate_docs.js `lesson`: no placeholder, every field, a known `Enforced by`, a named change or a
   * text-only reason). Read from the session's printed output (`outcome.output`): the retro agent prints its entries
   * and never writes LESSONS.md itself (kit/agents/retro.md, "Do not"), and LESSONS.md exists from bootstrap whether or
   * not the retro ran. An entry is a `## <YYYY-MM-DD> — …` heading (the lesson template's) and the lines under it, up
   * to the next `#`/`##` heading outside a fenced block (the agent sketches a proposed check in one).
   * The agent proposes an entry "for each finding" (retro.md), so whether one is required depends on the lane: a
   * finding is a `blocked`, `stop_refused`, `test_weakened`, `budget_exceeded` or `escalation` event the setup recorded
   * (retro.md, "Look for") or a FAIL row in a review report (`*.review.md`) in the end state. A lane with a finding needs at least
   * one entry; a lane with none passes with no entry (the honest "no findings" answer), and any entry it does propose
   * must still be valid, and each of its free-text fields (What went wrong, Root cause, Rule, Proposed change) holds
   * at least three words of letters. Whether the entries answer the lane's findings, and invent none, is the judge's.
   */
  lesson_proposed(outcome) {
    const lines = K.splitlines(String(outcome.output ?? ''));
    const entry = [];
    let inEntry = false;
    let fenced = false;
    for (const l of lines) {
      // the template's own heading (`## {{date}} — …`) is an entry too, so a printed template is judged, and fails
      if (/^##\s+(?:\d{4}-\d\d-\d\d\b|\{\{date\}\})/.test(l)) [inEntry, fenced] = [true, false];
      else if (inEntry && /^\s*```/.test(l)) fenced = !fenced;
      else if (inEntry && !fenced && /^#{1,2}\s/.test(l)) inEntry = false;
      if (inEntry) entry.push(l);
    }
    const n = entry.filter((l) => l.startsWith('## ')).length;
    if (!n) {
      const found = laneFindings(outcome);
      return found.length
        ? { ok: false, why: `no lesson entry (## <date> — …) in the session's output; the lane recorded ${found.length} finding(s): ${found.slice(0, 3).join('; ')}` }
        : { ok: true, why: 'the lane recorded no finding (no blocked, stop_refused, test_weakened, budget_exceeded or escalation event, no review FAIL) and no entry was proposed' };
    }
    const v = new V.Validator(path.sep, null, {});
    v.lesson('output', entry);
    if (v.v.length) return { ok: false, why: `${v.v.length} problem(s): ${v.v.slice(0, 3).map((x) => `${x.rule}: ${x.message}`).join('; ')}` };
    // the lesson rules ask for every field, not for content in it: each free-text field holds at least three words of
    // letters (letterWords), so blank fields or `.` in each are no lesson. `Enforced by` and `Status` are one word by
    // the template's own choices
    const thin = [];
    let title = '';
    for (const l of entry) {
      if (l.startsWith('## ')) title = l.slice(3).trim();
      const m = /^\s*-\s*(What went wrong|Root cause|Rule|Proposed change)\s*:(.*)$/i.exec(l);
      if (m && letterWords(m[2]) < 3) thin.push(`'${title.slice(0, 40)}' ${m[1]}: "${m[2].trim().slice(0, 20)}"`);
    }
    return thin.length ? { ok: false, why: `${thin.length} lesson field(s) with fewer than three words: ${thin.slice(0, 3).join('; ')}` } : { ok: true, why: `${n} lesson entr${n === 1 ? 'y' : 'ies'}, each valid` };
  },
  /**
   * Every claim in the named research documents carries a tag the research template allows, by the kit's own research
   * rules (validate_docs.js `research`: TAG_RULES and `template-placeholder`, so the untouched template fails): each
   * `## Findings` bullet exactly one of `[verified: …]`, `[docs: URL @ version]`, `[inferred: from …]`, each
   * `## What I could not verify` bullet `[unknown]`. Every other section holds claims too, the template's or one the
   * agent added (`## Notes`): each of its list items carries exactly one of those four tags. Only the template's
   * `## Sources` list and the header fields above the first section are not claims. Sections are walked in order, so a
   * repeated heading is checked each time (validate_docs keys sections by title and sees the last one). A document with
   * no Findings bullet fails. Citations are not range-checked here (the scorer has the end state's text, not the
   * repository); the judge reads them.
   */
  provenance_tags(outcome, task) {
    const docs = task.expected?.tagged_docs ?? [];
    const bad = [];
    for (const d of docs) {
      const text = outcome.files?.[d];
      if (typeof text !== 'string') {
        bad.push(`${d}: missing`);
        continue;
      }
      const lines = K.splitlines(text);
      const v = new V.Validator(path.sep, null, {});
      v.resolveCitations = () => {};
      v.research(d, lines);
      const found = v.v.filter((y) => TAG_RULES.has(y.rule) || y.rule === 'template-placeholder');
      for (const x of found) bad.push(`${d}:${x.line} ${x.rule}: ${x.message}`);
      const flagged = new Set(found.map((x) => x.line));
      let findings = 0;
      for (const sec of researchSections(K.stripHtmlComments(lines))) {
        const title = sec.title.toLowerCase();
        if (title === 'sources') continue;
        const allowed = { findings: ['verified', 'docs', 'inferred'], 'what i could not verify': ['unknown'] }[title] ?? ['verified', 'docs', 'inferred', 'unknown'];
        for (const [n, item] of sec.items) {
          if (title === 'findings') findings++;
          if (flagged.has(n) || ['none', 'none.', '—', '-'].includes(item.toLowerCase())) continue;
          const tags = [...item.matchAll(/\[(verified|docs|inferred|unknown|human)\b[^\]]*\]/g)].map((m) => m[1]);
          if (tags.length !== 1 || !allowed.includes(tags[0])) bad.push(`${d}:${n} untagged-claim: '## ${sec.title}' item needs exactly one of ${allowed.map((x) => `[${x}]`).join(', ')}: "${item.slice(0, 50)}"`);
        }
      }
      if (!findings) bad.push(`${d}: no bullet under ## Findings`);
    }
    return bad.length ? { ok: false, why: `${bad.length} problem(s): ${bad.slice(0, 3).join('; ')}` } : { ok: true, why: `${docs.length} document(s): every claim tagged as the research template allows` };
  },
  /**
   * The review report is filled in: the kit's own review checks (validate_docs.js `review`, REVIEW_RULES) find no
   * `{{…}}` placeholder left and no checklist row without a Result of exactly PASS or FAIL and its evidence, and every
   * PASS row's evidence is evidence as kit/agents/reviewer.md defines it: "`file:line`, `log#line`, or the command and
   * its output. 'Looks fine' is not evidence" (reviewEvidence), and real: a `file:line` within a file of the end state,
   * a `log#line` the lane recorded, a command the session ran (evidenceContext). The untouched template
   * `kit lane template review` writes (`| {{PASS|FAIL}} | {{evidence}} |`) fails. Whether the cited line says what the
   * row claims is the judge's.
   */
  review_has_evidence(outcome, task) {
    const rel = task.expected?.review ?? '';
    const text = outcome.files?.[rel];
    if (typeof text !== 'string') return { ok: false, why: 'no review report' };
    const v = new V.Validator(path.sep, null, {});
    v.resolveBareCitations = () => {};
    v.review(rel, K.splitlines(text));
    const bad = v.v.filter((x) => REVIEW_RULES.has(x.rule));
    if (bad.length) return { ok: false, why: `${bad.length} problem(s): ${bad.slice(0, 3).map((x) => `line ${x.line} ${x.rule}: ${x.message}`).join('; ')}` };
    const rows = K.parseSections(K.stripHtmlComments(K.splitlines(text))).get('checklist')?.tableRows() ?? [];
    if (!rows.length) return { ok: false, why: 'no checklist rows' };
    const ctx = evidenceContext(outcome);
    const thin = rows.map(([, c]) => [c, c[2].toUpperCase() === 'PASS' ? reviewEvidence(c[0], c[3], ctx) : { ok: true }]).filter(([, r]) => !r.ok);
    return thin.length
      ? { ok: false, why: `${thin.length} PASS row(s) without real evidence (a file:line in the end state, a log#line the lane recorded, or a command the session ran and its output): ${thin.slice(0, 3).map(([c, r]) => `${c[0]} ${r.why}`).join('; ')}` }
      : { ok: true, why: `${rows.length} rows, each PASS or FAIL, every PASS with evidence` };
  },
  /**
   * The spec's done-criteria tests exist as the spec names them (the tester's job, kit/agents/tester.md: "Write the
   * test named in the spec's table, at the path the spec names"): for each row's `file::name` (the spec at
   * `expected.spec`, read as the setup left it, so a session cannot rename the test by editing the spec), the file is in
   * the end state and declares `it('<name>'` or `test('<name>'` outside a comment. A row naming an artifact instead is
   * not a test.
   */
  named_tests(outcome, task) {
    const rel = task.expected?.spec ?? '';
    const spec = outcome.setup_state?.[rel] ?? outcome.files?.[rel];
    if (typeof spec !== 'string') return { ok: false, why: `no spec ${rel || '(expected.spec not set)'}` };
    const rows = K.parseSections(K.stripHtmlComments(K.splitlines(spec))).get('done-criteria')?.tableRows() ?? [];
    const named = rows.map(([, c]) => /`?([^`\s]+)::([^`]+?)`?\s*$/.exec(String(c[2] ?? '').trim())).filter(Boolean).map((m) => [m[1], m[2].trim()]);
    if (!named.length) return { ok: false, why: `${rel} names no test (file::name) in its Done-criteria` };
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // a commented-out test is no test: block and line comments are dropped first
    const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const missing = named.filter(([f, n]) => typeof outcome.files?.[f] !== 'string' || !new RegExp(`\\b(?:it|test)\\(\\s*(['"\`])${esc(n)}\\1`).test(code(outcome.files[f])));
    return missing.length ? { ok: false, why: `not written as the spec names it: ${missing.map(([f, n]) => `${f}::${n}`).join('; ')}` } : { ok: true, why: `${named.length} named test(s) written: ${named.map(([f]) => f).join(', ')}` };
  },
  /**
   * Each test the spec names (as named_tests reads them) asserts something about the function under test
   * (`expected.function_under_test`): its body holds at least one `expect(<call>)` whose argument calls that function
   * with an argument (`truncate('hello world', 5)`, `truncate?.(…)`, `format.truncate(…)`, or `() => truncate(…)` for
   * a throw), followed by a matcher that compares the result: toBe, toEqual, toStrictEqual, toMatch, toContain,
   * toHaveLength, toMatchObject, toBeCloseTo, toBeLessThan(OrEqual), toBeGreaterThan(OrEqual) with an expected value,
   * or toThrow/toThrowError (`.not`, `.resolves`, `.rejects` allowed before it). A test that only checks the export
   * exists (`expect(typeof format.truncate).toBe('function')`), throws `new Error('todo')`, or compares constants fails.
   * Simple by design: a call through a cast (`(format as X).truncate(…)`) is not recognised. Whether the assertion
   * encodes the criterion's behaviour is the judge's (the rubric).
   */
  named_tests_assert(outcome, task) {
    const rel = task.expected?.spec ?? '';
    const fn = task.expected?.function_under_test;
    if (typeof fn !== 'string' || !fn) return { ok: false, why: 'expected.function_under_test not set' };
    const spec = outcome.setup_state?.[rel] ?? outcome.files?.[rel];
    if (typeof spec !== 'string') return { ok: false, why: `no spec ${rel || '(expected.spec not set)'}` };
    const rows = K.parseSections(K.stripHtmlComments(K.splitlines(spec))).get('done-criteria')?.tableRows() ?? [];
    const named = rows.map(([, c]) => /`?([^`\s]+)::([^`]+?)`?\s*$/.exec(String(c[2] ?? '').trim())).filter(Boolean).map((m) => [m[1], m[2].trim()]);
    if (!named.length) return { ok: false, why: `${rel} names no test (file::name) in its Done-criteria` };
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const callsFn = new RegExp(String.raw`^(?:(?:async\s*)?\(\s*\)\s*=>\s*\{?\s*(?:return\s+)?)?(?:await\s+)?(?:[\w$]+\s*\??\.\s*)*${esc(fn)}\s*(?:\?\.)?\(\s*[^\s)]`);
    const matcher = /^\s*(?:\.\s*(?:not|resolves|rejects)\s*)*\.\s*(?:(?:toBe|toEqual|toStrictEqual|toMatch|toContain|toHaveLength|toMatchObject|toBeCloseTo|toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual)\s*\(\s*[^\s)]|toThrow(?:Error)?\s*\()/;
    const bad = [];
    for (const [f, n] of named) {
      const text = typeof outcome.files?.[f] === 'string' ? code(outcome.files[f]) : null;
      const m = text && new RegExp(`\\b(?:it|test)\\(\\s*(['"\`])${esc(n)}\\1`).exec(text);
      if (!m) {
        bad.push(`${f}::${n} not written`);
        continue;
      }
      const body = text.slice(m.index, closeParen(text, text.indexOf('(', m.index)));
      let asserts = false;
      for (const e of body.matchAll(/\bexpect\s*\(/g)) {
        const open = e.index + e[0].length - 1;
        const close = closeParen(body, open);
        if (callsFn.test(body.slice(open + 1, close).trim()) && matcher.test(body.slice(close + 1))) asserts = true;
      }
      if (!asserts) bad.push(`${f}::${n} has no expect(${fn}(…)) compared with a matcher`);
    }
    return bad.length ? { ok: false, why: bad.slice(0, 3).join('; ') } : { ok: true, why: `${named.length} named test(s), each asserting on a call of ${fn}` };
  },
  /**
   * The session kept the tests it was given (kit/agents/implementer.md: "do not change its assertions", "Never remove
   * an assertion, skip a test"): no `test_weakened` event, and every test file the setup left (the tester's, untracked
   * in the lane, which the post-edit hook's `git diff HEAD` does not see) compared with the end state by the hook's own
   * rules: no assertion line removed or changed (REMOVED_ASSERT), no skip/only added (ADDED_SKIP), and none added to a
   * new test file. Needs the setup's state (`outcome.setup_state`); without it the check fails.
   */
  tests_kept(outcome) {
    const before = outcome.setup_state;
    if (!before || typeof before !== 'object') return { ok: false, why: 'no record of the files the setup left (setup_state)' };
    const weak = (outcome.events ?? []).filter((e) => e.event === 'test_weakened');
    const bad = weak.map((e) => `test_weakened: ${e.summary ?? ''}`.trim());
    const after = outcome.files ?? {};
    const count = (ls) => ls.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
    for (const f of [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((x) => TEST_FILE.test(x)).sort()) {
      const a = typeof before[f] === 'string' ? K.splitlines(before[f]) : [];
      const b = typeof after[f] === 'string' ? K.splitlines(after[f]) : [];
      const [ca, cb] = [count(a), count(b)];
      const removed = a.filter((l) => REMOVED_ASSERT.test(`-${l}`) && (cb.get(l) ?? 0) < ca.get(l));
      const added = b.filter((l) => ADDED_SKIP.test(`+${l}`) && (ca.get(l) ?? 0) < cb.get(l));
      if (removed.length) bad.push(`${f}: ${new Set(removed).size} assertion line(s) removed or changed${typeof after[f] === 'string' ? '' : ' (file deleted)'}`);
      if (added.length) bad.push(`${f}: skip/only added`);
    }
    return bad.length ? { ok: false, why: bad.slice(0, 3).join('; ') } : { ok: true, why: 'no test_weakened event; every assertion the setup\'s tests held is still there, no skip added' };
  },
  /**
   * The spec the session wrote is valid by the kit's own spec rules (validate_docs.js `spec`: no `{{…}}` placeholder,
   * every header field and section, tagged file lists, a test per done-criterion, …), as the planner's own SubagentStop
   * hook runs them, with the project's recorded test commands. Two parts are left out: citations are not range-checked
   * (the scorer has the end state's text, not the repository; the judge reads them), and `open-questions`, which says
   * a spec is not ready for approval, not that the planner's draft is wrong: the task asks for open questions and the
   * rubric grades them.
   */
  spec_valid(outcome, task) {
    const rel = task.expected?.spec ?? '';
    const text = outcome.files?.[rel];
    if (typeof text !== 'string') return { ok: false, why: `no spec ${rel || '(expected.spec not set)'}` };
    const v = new V.Validator(path.sep, null, { commands: Object.fromEntries((outcome.test_commands ?? []).map((c, i) => [['test', 'test_affected', 'test_file'][i] ?? `test_${i}`, c])) });
    v.resolveCitations = () => {};
    v.spec(rel, K.splitlines(text));
    const bad = v.v.filter((x) => x.rule !== 'open-questions');
    return bad.length ? { ok: false, why: `${bad.length} problem(s): ${bad.slice(0, 3).map((x) => `line ${x.line} ${x.rule}: ${x.message}`).join('; ')}` } : { ok: true, why: `${rel} valid by the kit's spec rules` };
  },
  /**
   * Files the session must not change are as the setup left them (`expected.unchanged`): the retro prints its lesson
   * entries and never writes LESSONS.md itself (kit/agents/retro.md, "Do not"). Compared with the setup's state, so a
   * shell write counts as an Edit does. Needs `outcome.setup_state`; without it the check fails.
   */
  files_unchanged(outcome, task) {
    const want = task.expected?.unchanged ?? [];
    const before = outcome.setup_state;
    if (!before || typeof before !== 'object') return { ok: false, why: 'no record of the files the setup left (setup_state)' };
    const changed = want.filter((f) => before[f] !== outcome.files?.[f]);
    return changed.length ? { ok: false, why: `changed by the session: ${changed.join(', ')}` } : { ok: true, why: `${want.join(', ')} as the setup left ${want.length === 1 ? 'it' : 'them'}` };
  },
  /**
   * The spec critic wrote its critique where and as kit/agents/spec-critic.md says ("Write"): at least one new
   * `- C<n>. <gap> → ` item in the `## Critique` section of the spec (`expected.spec`), not there when the setup left it.
   * Each new item's gap (the text before `→`) has at least three words of letters, or, for a critique that found
   * nothing, is the agent file's own statement (NO_GAPS) and names a command the critic ran (a backticked command or
   * `git grep`): an item that otherwise says there is nothing ("No issues.", "Looks good") fails. Printing "Looks good."
   * and editing nothing fails. Whether an item is a concrete risk, or the no-gaps statement is true, is the judge's.
   * Needs `outcome.setup_state`; without it the check fails.
   */
  critique_written(outcome, task) {
    const rel = task.expected?.spec ?? '';
    const before = outcome.setup_state;
    if (!before || typeof before !== 'object') return { ok: false, why: 'no record of the files the setup left (setup_state)' };
    if (typeof outcome.files?.[rel] !== 'string') return { ok: false, why: `no spec ${rel || '(expected.spec not set)'}` };
    const had = new Set(critiqueItems(before[rel]).map((i) => i.raw));
    const added = critiqueItems(outcome.files[rel]).filter((i) => !had.has(i.raw));
    if (!added.length) return { ok: false, why: `no - C<n>. item added to ## Critique in ${rel} (kit/agents/spec-critic.md, "Write")` };
    const bad = [];
    for (const i of added) {
      const gap = i.text.split('→')[0].trim();
      if (gap.startsWith(NO_GAPS)) {
        if (!/`[^`]+`|\bgit grep\b/.test([i.text, ...i.more].join(' '))) bad.push(`${i.id} says no gaps but names no command it ran`);
      } else if (SAYS_NOTHING.test(gap)) bad.push(`${i.id} "${gap.slice(0, 40)}" says nothing was found without the agent file's statement "${NO_GAPS}"`);
      else if (letterWords(gap) < 3) bad.push(`${i.id} "${gap.slice(0, 40)}" is no critique (fewer than three words)`);
    }
    return bad.length ? { ok: false, why: bad.slice(0, 3).join('; ') } : { ok: true, why: `${added.length} critique item(s) added to ${rel}` };
  },
  /**
   * The first tool used is one the task expects (tool-selection tasks): `expected.first_tool`, a tool name or a list of
   * them. The spec critic's is its read-only tools (Read, Grep, Glob): its instructions ask for its own caller search
   * as well as reading the spec's files (kit/agents/spec-critic.md, "Check"), so either may come first; an Edit may not.
   */
  first_tool(outcome, task) {
    const want = [task.expected?.first_tool ?? []].flat();
    const first = (outcome.events ?? []).find((e) => e.tool)?.tool ?? null;
    return want.includes(first) ? { ok: true, why: `first tool ${first}` } : { ok: false, why: `first tool ${first ?? 'none'}, expected ${want.join(' or ')}` };
  },
};

/** Score one outcome. Returns { hard: {name: {ok, why}}, hard_ok, rubric: {met, total, score, failed: [ids], ungraded: [ids]}, score, violations: [names] }. */
export function score(task, outcome) {
  const hard = {};
  for (const name of task.checks ?? []) {
    const fn = CHECKS[name];
    hard[name] = fn ? fn(outcome, task) : { ok: false, why: `unknown check '${name}'` };
  }
  const violations = Object.entries(hard).filter(([, r]) => !r.ok).map(([n]) => n);
  const rubric = task.rubric ?? [];
  const judge = outcome.judge ?? {};
  const met = rubric.filter((c) => judge[c.id] === 1 || judge[c.id] === true).length;
  // the judge's own verdict per item: 0/false is a clear fail; an item with no 1/0 verdict was not graded (the judge
  // did not run, or did not answer for it), which is never read as met
  const failed = rubric.filter((c) => judge[c.id] === 0 || judge[c.id] === false).map((c) => c.id);
  const ungraded = rubric.filter((c) => ![0, 1, true, false].includes(judge[c.id])).map((c) => c.id);
  const rubricScore = rubric.length ? met / rubric.length : 1;
  return {
    hard,
    hard_ok: violations.length === 0,
    violations,
    rubric: { met, total: rubric.length, score: rubricScore, failed, ungraded },
    // the task's score: 0 on any hard violation, else the rubric share
    score: violations.length ? 0 : rubricScore,
  };
}
