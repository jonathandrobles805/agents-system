#!/usr/bin/env node
// Stop hook inside a lane: refuse to end the turn while done-criteria lack a green run and no escalation is written,
// or while the lane's own changes include a file outside the spec (shell_changes.js reconcile).
// Allows the stop when: every done-criterion row in progress.md has a green run ref that exists in the log,
// or the Escalation section is filled in, or stop_hook_active is set (we already asked once).
import * as K from './kitlib.js';
import * as S from './shell_changes.js';

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
      K.appendEvent(lane.eventLogPath, { event: 'stop', tool: 'hook', result: 'ok', summary: 'stopped with escalation' });
      return 0;
    }
  }
  // A file outside the spec that the lane changed (by a shell command, or in a commit) and nobody undid is part of the
  // lane's diff: not done while it is there.
  // After the escalation check on purpose: leaving them and recording that the spec needs amending is the other way out
  // post-edit-check offers.
  const flagged = S.reconcile(lane, { d }); // from git, on the lane's own diff; flagged.json is only a cache
  if (flagged.noBase) {
    K.appendEvent(lane.eventLogPath, { event: 'stop_refused', tool: 'hook', result: 'fail', summary: 'no base to judge the lane\'s changes against' });
    return K.feedbackBlock(`done-check: the lane's changes cannot be checked against the spec: ${flagged.noBase}. ` +
      'Record the commit the lane started from as base_commit in .claude/lane.json (kit lane start writes it), or fetch the base branch, then stop.');
  }
  if (flagged.length) {
    K.appendEvent(lane.eventLogPath, { event: 'stop_refused', tool: 'hook', result: 'fail', summary: 'out-of-spec shell changes still there: ' + flagged.slice(0, 5).map((f) => f.rel).join(', ') });
    return K.feedbackBlock(`done-check: files outside the spec's allow-list that the lane changed (its own diff from the branch it targets) are still changed: ${flagged.map((f) => f.rel).join(', ')}. ` +
      'Undo them as post-edit-check said, or record under Escalation that the spec needs amending, then stop.');
  }
  const rows = sections.get('done-criteria')?.tableRows() ?? [];
  if (!rows.length) return K.feedbackBlock('done-check: progress.md has no done-criteria rows. Copy them from the spec before stopping.');
  const logLines = K.isFile(lane.logPath) ? K.readLines(lane.logPath) : [];
  const missing = [];
  for (const [n, cells] of rows) {
    if (cells.length < 5) {
      missing.push(`line ${n}: row needs #, criterion, test, red run, green run`);
      continue;
    }
    // A P-criterion is preserved behaviour (must stay green): it has no honest red run (field test #42).
    const keep = /^P\d+$/.test(cells[0].trim());
    const labels = stage === 'test' ? (keep ? [] : ['red']) : keep ? ['green'] : ['red', 'green'];
    for (const label of labels) {
      const why = K.runRefProblem(lane, logLines, cells, label);
      if (why) missing.push(why);
    }
  }
  if (missing.length) {
    K.appendEvent(lane.eventLogPath, { event: 'stop_refused', tool: 'hook', result: 'fail', summary: `${missing.length} criteria incomplete` });
    const need = stage === 'test' ? 'a red run (tests written and failing)' : 'a red run and a green run in the log';
    return K.feedbackBlock('done-check: not done.\n- ' + missing.join('\n- ') + `\nEither finish the criteria (each needs ${need}) or fill in the Escalation section, then stop.`);
  }
  K.appendEvent(lane.eventLogPath, { event: 'stop', tool: 'hook', result: 'ok', summary: 'all done-criteria green' });
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main();
