#!/usr/bin/env node
// SessionStart (compact|resume): re-inject the lane's spec summary, progress, and LESSONS debt so a compacted
// or resumed session does not lose the rules. Prints plain text to stdout (added to Claude's context). Exit 0.
import path from 'node:path';
import * as K from './kitlib.js';

function section(file, title, maxLines = 40) {
  if (!K.isFile(file)) return '';
  const sec = K.parseSections(K.stripHtmlComments(K.readLines(file))).get(title.toLowerCase());
  if (!sec) return '';
  return `## ${title}\n` + sec.lines.slice(0, maxLines).map(([, t]) => t).join('\n').trim();
}

export function main() {
  const d = K.readHookInput();
  const cwd = (typeof d?.cwd === 'string' && d.cwd) || '.';
  // one resolver for every lane-scoped hook (#29); this only injects context, so it never blocks
  const lane = K.laneForHook(d).lane;
  const root = lane ? lane.root : K.repoRoot(cwd);
  const out = [];
  const debt = section(path.join(root, 'LESSONS.md'), 'Debt', 20);
  if (debt) out.push('# Kit context restored after compaction/resume\n\n# Rules not yet enforced by a check (from LESSONS.md)\n' + debt);
  if (lane) {
    out.push(`# Active lane: ${lane.slug}\nSpec: ${K.relTo(root, lane.specPath)}\n`);
    out.push(section(lane.specPath, 'Summary'));
    out.push(section(lane.specPath, 'Files to change'));
    out.push(section(lane.specPath, 'Done-criteria'));
    out.push(section(lane.progressPath, 'Current step'));
    out.push(section(lane.progressPath, 'Escalation', 12));
    out.push("Reminder: edits are limited to the spec's files; every file must be read in this session before editing; tests before code; stop only when every criterion has a red and a green run or Escalation is filled.");
  }
  const text = out.filter(Boolean).join('\n\n');
  if (text) console.log(text);
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main();
