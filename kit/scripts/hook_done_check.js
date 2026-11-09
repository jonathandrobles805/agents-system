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
  const lane = K.findLane((typeof d.cwd === 'string' && d.cwd) || '.');
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
    for (const [label, ref] of stage === 'test' ? [['red', red]] : [['red', red], ['green', green]]) {
      const m = /#(\d+)/.exec(ref);
      if (!m) missing.push(`${rid}: no ${label} run reference (expected ${logName}#<line>)`);
      else if (Number(m[1]) > logLines.length) missing.push(`${rid}: ${label} run ref ${ref} points past the end of ${logName} (${logLines.length} lines)`);
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
