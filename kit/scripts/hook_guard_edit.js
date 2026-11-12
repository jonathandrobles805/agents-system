#!/usr/bin/env node
// PreToolUse on Edit|Write|MultiEdit|NotebookEdit.
//
// Blocks (exit 2):
//   - editing an existing file that this session has not read
//   - in a lane: editing a file outside the spec's 'Files to change' + 'Files to create' lists
//   - always: .claude/settings*, .claude/lane.json, .claude/kit.json, .claude/hooks/*, .github/workflows/*
//   - in a lane: editing the spec itself (changes need re-approval) or any other spec
// Outside a lane only the read-before-edit and always-blocked rules apply.
import fs from 'node:fs';
import path from 'node:path';
import * as K from './kitlib.js';

const text = (v) => (typeof v === 'string' ? v : '');

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const cwd = text(d.cwd) || '.';
  const root = K.projectRoot(cwd);
  // kill switch (KIT-SPEC 10.13): a STOP flag in the lane's session or the project refuses every mutation
  if (K.isFile(path.join(cwd, '.claude', 'session', 'STOP')) || K.isFile(path.join(root, '.claude', 'STOP'))) {
    process.stderr.write(`guard-edit: the kill switch is set; no mutations until lane.js resume-all --by <name>\n`);
    return 2;
  }
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  const fp = text(ti.file_path) || text(ti.notebook_path);
  if (!fp) return 0;
  const absPath = path.isAbsolute(fp) ? fp : path.join(cwd, fp);
  const rel = K.relTo(root, absPath);
  const lane = K.findLane(cwd);
  const events = lane ? lane.eventsPath : path.join(root, '.claude', 'session', 'events.jsonl');

  const deny = (reason) => {
    K.appendEvent(events, { event: 'blocked', tool: d.tool_name ?? null, path: rel, result: 'blocked', summary: reason.split('\n')[0] });
    return K.block(reason);
  };

  if (rel.startsWith('/') || rel.startsWith('..')) return deny(`guard-edit: '${rel}' is outside the project root.`);

  if (K.globMatch(rel, K.ALWAYS_BLOCKED_EDIT)) {
    return deny(`guard-edit: '${rel}' is kit configuration. Agents never edit it; change it through /bootstrap or by hand.`);
  }

  const exists = fs.existsSync(absPath);

  if (lane) {
    const [, change, create] = K.specFileLists(lane.specPath);
    const allowed = [...change, ...create, ...lane.alwaysAllowed()];
    const specRel = K.relTo(root, lane.specPath);
    // fix/incident lanes open before their spec exists (KIT-SPEC 10.12): until a human approves it, the lane's own spec
    // may be written (the planner, after the debugger's reproduction); once the approval line is there it is frozen.
    const specApproved = K.isFile(lane.specPath) && /Approved by:/.test(fs.readFileSync(lane.specPath, 'utf8'));
    if (rel === specRel || (rel.startsWith(K.workRoot(root) + '/') && rel.endsWith('.md') && !rel.endsWith('.progress.md') && !rel.includes('.review.'))) {
      if (rel === specRel && !specApproved) return exists && !K.wasRead(root, text(d.session_id), rel) ? deny(`guard-edit: '${rel}' has not been read in this session. Read the file first, then edit it.`) : 0;
      if (rel === specRel) {
        return deny(`guard-edit: '${rel}' is the approved spec. Changing it requires re-approval; write the needed change in progress.md under Escalation.`);
      }
      return deny(`guard-edit: '${rel}' is another feature's spec. Lanes edit only their own files.`);
    }
    // KIT-SPEC 10.11: lane artifacts live in one tree; one written anywhere else is refused (planted fault 27)
    const work = K.workRoot(root);
    if (K.globMatch(path.basename(rel), K.LANE_ARTIFACT_PATTERNS) && !rel.startsWith(work + '/')) {
      return deny(`guard-edit: '${rel}' is a lane artifact outside '${work}/'. Lane files live only under ${work}/ (kit.json paths.work).`);
    }
    if (!(change.length + create.length)) {
      // no spec yet (or no files in it): only the lane's own artifacts (progress, log, events) and decision records
      if (K.globMatch(rel, lane.alwaysAllowed())) return exists && !K.wasRead(root, text(d.session_id), rel) ? deny(`guard-edit: '${rel}' has not been read in this session. Read the file first, then edit it.`) : 0;
      return deny(`guard-edit: lane '${lane.slug}' has no 'Files to change' list in ${specRel}; nothing but the lane's progress file may be edited until the spec names its files.`);
    }
    if (!K.globMatch(rel, allowed)) {
      return deny(
        `guard-edit: '${rel}' is not in the spec's Files to change / Files to create.\n` +
        `Allowed: ${allowed.join(', ')}\n` +
        'If this file must change, stop and record it under Escalation in progress.md; the spec needs amending and re-approval.',
      );
    }
  }

  if (exists && !K.wasRead(root, text(d.session_id), rel)) {
    return deny(`guard-edit: '${rel}' has not been read in this session. Read the file first, then edit it.`);
  }

  return 0;
}

if (K.isMain(import.meta.url)) K.runGuard('guard-edit', main);
