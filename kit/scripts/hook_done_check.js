#!/usr/bin/env node
// Stop hook inside a lane: refuse to end the turn while done-criteria lack a green run and no escalation is written.
// Allows the stop when: every done-criterion row in progress.md has a green run ref that exists in the log,
// or the Escalation section is filled in, or stop_hook_active is set (we already asked once).
import path from 'node:path';
import * as K from './kitlib.js';

export const ATTEMPTS = /^- Attempts:\s*(\S.*)$/m;
export const FAILURE = /^- Failure:\s*(\S.*)$/m;

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0 || d.stop_hook_active) return 0;
  // A subagent stopping is the lane's worker finishing, and it reports the main repo as cwd, so it needs tier 3.
  // The top-level Stop is the orchestrator, which is not the worker: gating it on the lane's criteria would leave
  // nobody able to end a turn and report to the human, so it keeps to the tiers that prove where the session is.
  const ev = typeof d.hook_event_name === 'string' ? d.hook_event_name : '';
  const r = K.laneForHook(d);
  if (ev === 'SubagentStop' && r.via === 'ambiguous') {
    return K.feedbackBlock(`done-check: ${r.slugs.length} lanes are open (${r.slugs.join(', ')}) and this subagent reports no worktree, so its evidence cannot be checked. Run the subagent with its worktree as cwd, or finish the other lanes first.`);
  }
  const lane = r.via === 'single-active' && ev !== 'SubagentStop' ? null : r.lane;
  const stage = lane ? lane.data.stage ?? 'build' : null;
  if (!lane || !['build', 'test'].includes(stage)) return 0;
  const prog = lane.progressPath;
  if (!K.isFile(prog)) {
    return K.feedbackBlock(`done-check: ${K.relTo(lane.root, prog)} does not exist. Create it from the progress template, fill the done-criteria table from the spec, then stop.`);
  }
  const sections = K.parseSections(K.stripHtmlComments(K.readLines(prog)));
  const esc = sections.get('escalation');
  if (esc) {
    const t = esc.text();
    const attempts = ATTEMPTS.exec(t);
    const failure = FAILURE.exec(t);
    if (attempts && failure && !t.includes('{{') && !['', '—', '-'].includes(failure[1].trim())) {
      K.appendEvent(lane.eventsPath, { event: 'stop', tool: 'hook', result: 'ok', summary: 'stopped with escalation' });
      return 0;
    }
  }
  const rows = sections.get('done-criteria')?.tableRows() ?? [];
  if (!rows.length) return K.feedbackBlock('done-check: progress.md has no done-criteria rows. Copy them from the spec before stopping.');
  const logName = path.basename(lane.logPath);
  const logLines = K.isFile(lane.logPath) ? K.readLines(lane.logPath) : [];
  const missing = [];
  for (const [n, cells] of rows) {
    if (cells.length < 5) {
      missing.push(`line ${n}: row needs #, criterion, test, red run, green run`);
      continue;
    }
    const [rid, , , red, green] = cells;
    // A P-criterion is preserved behaviour (must stay green): it has no honest red run (field test #42).
    const keep = /^P\d+$/.test(rid.trim());
    const checks = stage === 'test' ? (keep ? [] : [['red', red]]) : keep ? [['green', green]] : [['red', red], ['green', green]];
    for (const [label, ref] of checks) {
      const m = /#(\d+)/.exec(ref);
      if (!m) {
        missing.push(`${rid}: no ${label} run reference (expected ${logName}#<line>)`);
        continue;
      }
      const at = Number(m[1]);
      if (at > logLines.length) {
        missing.push(`${rid}: ${label} run ref ${ref} points past the end of ${logName} (${logLines.length} lines)`);
        continue;
      }
      // The reference must point at a logged run whose exit code says what the cell claims: red failed, green passed.
      const ex = /-> exit (-?\d+)\s*$/.exec(logLines[at - 1] ?? '');
      if (!ex) missing.push(`${rid}: ${label} run ref ${ref} is not a logged run (=== … -> exit N); log it with post-edit-check or lane.js check`);
      else if (label === 'red' && Number(ex[1]) === 0) missing.push(`${rid}: red run ref ${ref} passed (exit 0); a red run must fail`);
      else if (label === 'green' && Number(ex[1]) !== 0) missing.push(`${rid}: green run ref ${ref} failed (exit ${ex[1]}); a green run must pass`);
    }
  }
  if (missing.length) {
    K.appendEvent(lane.eventsPath, { event: 'stop_refused', tool: 'hook', result: 'fail', summary: `${missing.length} criteria incomplete` });
    const need = stage === 'test' ? 'a red run (tests written and failing)' : 'a red run and a green run in the log';
    return K.feedbackBlock('done-check: not done.\n- ' + missing.join('\n- ') + `\nEither finish the criteria (each needs ${need}) or fill in the Escalation section, then stop.`);
  }
  K.appendEvent(lane.eventsPath, { event: 'stop', tool: 'hook', result: 'ok', summary: 'all done-criteria green' });
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main();
