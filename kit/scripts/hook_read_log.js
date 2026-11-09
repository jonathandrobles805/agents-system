#!/usr/bin/env node
// PostToolUse on Read (and Bash file reads): record which files this session has read.
// guard-edit consults this log. Exit 0 always; never blocks.
import path from 'node:path';
import * as K from './kitlib.js';

// Python's \s and \b are Unicode-aware, JS's are not, so they are spelled out.
const WS = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const B = '(?<![\\p{L}\\p{N}_])';
export const READ_CMDS = new RegExp(`${B}(cat|head|tail|less|more|bat)[${WS}]+(?:-[A-Za-z0-9]+[${WS}]+)*([^${WS}|;&><]+)`, 'gu');
export const SED_CMD = new RegExp(`${B}sed[${WS}]+-n[${WS}]+[^${WS}]+[${WS}]+([^${WS}|;&><]+)`, 'gu');

const text = (v) => (typeof v === 'string' ? v : '');

export function main() {
  const d = K.readHookInput();
  if (!d || Object.keys(d).length === 0) return 0;
  const cwd = text(d.cwd) || '.';
  const root = K.projectRoot(cwd);
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  const paths = [];
  if (d.tool_name === 'Read' || d.tool_name === 'NotebookRead') {
    const fp = text(ti.file_path) || text(ti.notebook_path);
    if (fp) paths.push(fp);
  } else if (d.tool_name === 'Bash') {
    const cmd = text(ti.command);
    for (const m of cmd.matchAll(READ_CMDS)) paths.push(m[2]);
    for (const m of cmd.matchAll(SED_CMD)) paths.push(m[1]);
  }
  for (const p of paths.map((x) => K.stripChars(x, '\'"'))) {
    if (p.startsWith('-')) continue;
    K.recordRead(root, text(d.session_id), K.relTo(root, path.isAbsolute(p) ? p : path.join(cwd, p)));
  }
  return 0;
}

if (K.isMain(import.meta.url)) process.exitCode = main();
